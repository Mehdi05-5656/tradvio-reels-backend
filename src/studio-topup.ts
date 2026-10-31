// Clone8 Studio: top-ups. Any amount from $5, on top of the plan: a one-off Stripe Checkout payment that also saves
// the card, so auto top-up can charge it later ("when my balance drops below X credits, add $Y"). Bought credits carry
// over at renewal (studio_grant only expires what is left of the plan's own credits).
//
// Prices: a credit costs less on a bigger plan, and more at once earns a bonus. Every rate clears the plans' credit
// value floor after Stripe's fee (tests enforce it), so a top-up never sells a credit under what the tools are priced on.
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditValueFloor, netPerCredit, type PlanLike } from "./studio-pricing.js";

export const TOPUP_MIN_USD = 5, TOPUP_MAX_USD = 1000;
export const AUTO_MIN_USD = 5, AUTO_MAX_USD = 500;
/** USD a credit costs in a top-up, by plan. */
export const TOPUP_RATE_USD: Record<string, number> = { starter: 0.04, creator: 0.035, studio: 0.03 };
/** Extra credits for a bigger top-up, as a share of the base credits. */
export const TOPUP_BONUS: Array<{ from_usd: number; bonus: number }> = [{ from_usd: 100, bonus: 0.15 }, { from_usd: 50, bonus: 0.1 }, { from_usd: 25, bonus: 0.05 }];
/** Auto top-up guards: one charge at a time, at most this many a day. */
export const AUTO_COOLDOWN_MS = 10 * 60_000, AUTO_MAX_PER_DAY = 5;

export const topupRate = (planId: string | null | undefined) => TOPUP_RATE_USD[planId ?? ""] ?? TOPUP_RATE_USD.starter;
export const topupBonus = (usd: number) => TOPUP_BONUS.find((b) => usd >= b.from_usd)?.bonus ?? 0;
/** Credits a top-up of `usd` buys on this plan. */
export function topupCredits(usd: number, planId: string | null | undefined): number {
  const base = Math.floor(usd / topupRate(planId) + 1e-9);
  return Math.floor(base * (1 + topupBonus(usd)) + 1e-9);
}
/** Whether every top-up rate (with its biggest bonus, at the smallest charge) earns at least the credit floor. */
export function topupsClearFloor(plans: PlanLike[]): boolean {
  const floor = creditValueFloor(plans);
  return Object.keys(TOPUP_RATE_USD).every((plan) => [TOPUP_MIN_USD, 25, 50, 100, TOPUP_MAX_USD].every((usd) => netPerCredit(usd, topupCredits(usd, plan)) >= floor));
}
/** A starting point for auto top-up from the last 30 days: keep about two days of use as the line, and add about three
 *  days of use each time (the nearest friendly amount, $10 at least), so a charge is modest and rarely needed twice a day. */
export function recommendAuto(spent30d: number, planId: string | null | undefined): { below: number; usd: number } {
  const perDay = Math.max(0, spent30d) / 30;
  const below = Math.max(100, Math.ceil((perDay * 2) / 50) * 50);
  const target = perDay * 3 * topupRate(planId);
  const usd = [10, 20, 25, 50, 100, 200].reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), 10);
  return { below: Math.min(below, 20_000), usd };
}
export const cleanUsd = (v: unknown, min: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

/** What the account page and the top-up dialog need. */
export function topupInfo(c: any, spent30d: number) {
  const plan = c?.plan_id ?? null;
  return {
    min_usd: TOPUP_MIN_USD, max_usd: TOPUP_MAX_USD, rate_usd: topupRate(plan), bonuses: TOPUP_BONUS,
    presets: [5, 10, 25, 50, 100].map((usd) => ({ usd, credits: topupCredits(usd, plan) })),
    auto: { enabled: !!c?.auto_topup_enabled, below: Number(c?.auto_topup_below ?? 200), usd: Number(c?.auto_topup_usd ?? 20), last_at: c?.auto_topup_last_at ?? null, error: c?.auto_topup_error ?? null, min_usd: AUTO_MIN_USD, max_usd: AUTO_MAX_USD },
    recommended: recommendAuto(spent30d, plan),
  };
}

export type StripeTopUp = {
  paymentIntents?: { create: (p: any, o?: any) => Promise<any> };
  paymentMethods?: { list: (p: any) => Promise<{ data: any[] }> };
  customers?: { retrieve: (id: string) => Promise<any> };
};
/** The card a customer saved (their default for invoices, else the first card on file). */
export async function savedCard(stripe: StripeTopUp, customer: string | null | undefined): Promise<string | null> {
  if (!customer || !stripe.customers || !stripe.paymentMethods) return null;
  const c = await stripe.customers.retrieve(customer).catch(() => null);
  const def = c?.invoice_settings?.default_payment_method;
  if (def) return typeof def === "string" ? def : def.id ?? null;
  const pm = await stripe.paymentMethods.list({ customer, type: "card", limit: 1 }).catch(() => ({ data: [] as any[] }));
  return pm.data?.[0]?.id ?? null;
}

/** Charge the saved card for an auto top-up and add the credits. Guarded: plan active, setting on, not more than once
 *  in AUTO_COOLDOWN_MS nor AUTO_MAX_PER_DAY times a day. A declined or authentication-required card turns auto top-up
 *  off with the reason saved, so it never retries a failing card. */
export async function chargeAutoTopUp(sb: SupabaseClient, stripe: StripeTopUp, u: string, log: (l: string) => void, why: string): Promise<{ ok: boolean; credits?: number; reason?: string }> {
  const c = await sb.from("studio_customers").select("plan_id,status,stripe_customer_id,auto_topup_enabled,auto_topup_usd,auto_topup_last_at").eq("user_id", u).maybeSingle();
  if (c.error || !c.data) return { ok: false, reason: "no_customer" };
  const d: any = c.data;
  if (!d.auto_topup_enabled) return { ok: false, reason: "off" };
  if (!["active", "trialing"].includes(d.status)) return { ok: false, reason: "no_plan" };
  if (d.auto_topup_last_at && Date.now() - Date.parse(d.auto_topup_last_at) < AUTO_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  const day = await sb.from("studio_credit_ledger").select("id").eq("user_id", u).eq("reason", "grant").like("note", "Auto top-up%").gte("created_at", new Date(Date.now() - 86400_000).toISOString());
  if ((day.data ?? []).length >= AUTO_MAX_PER_DAY) return { ok: false, reason: "daily_limit" };
  if (!stripe.paymentIntents) return { ok: false, reason: "billing_unavailable" };
  const usd = cleanUsd(d.auto_topup_usd, AUTO_MIN_USD, AUTO_MAX_USD) ?? 20, credits = topupCredits(usd, d.plan_id);
  // claim the slot first, so two triggers at once cannot both charge
  const stamp = new Date().toISOString();
  const claim = d.auto_topup_last_at
    ? await sb.from("studio_customers").update({ auto_topup_last_at: stamp }).eq("user_id", u).eq("auto_topup_last_at", d.auto_topup_last_at).select("user_id")
    : await sb.from("studio_customers").update({ auto_topup_last_at: stamp }).eq("user_id", u).is("auto_topup_last_at", null).select("user_id");
  if (claim.error || !(claim.data ?? []).length) return { ok: false, reason: "busy" };
  try {
    const pm = await savedCard(stripe, d.stripe_customer_id);
    if (!pm) throw Object.assign(new Error("no saved card"), { stop: "Add a card with one top-up first" });
    const pi = await stripe.paymentIntents.create({
      amount: usd * 100, currency: "usd", customer: d.stripe_customer_id, payment_method: pm, off_session: true, confirm: true,
      description: `Clone8 auto top-up: ${credits} credits`, metadata: { user_id: u, topup: "auto", credits: String(credits), usd: String(usd) },
    }, { idempotencyKey: `auto-topup:${u}:${stamp}` });
    if (pi?.status !== "succeeded") throw Object.assign(new Error(`payment ${pi?.status}`), { stop: "The card needs your confirmation; top up by hand once" });
    const g = await sb.rpc("studio_grant", { p_user: u, p_credits: credits, p_ref: String(pi.id), p_expire_previous: false, p_note: `Auto top-up $${usd}` });
    if (g.error) throw g.error;
    await sb.from("studio_customers").update({ auto_topup_error: null }).eq("user_id", u);
    log(`[topup] auto ${JSON.stringify({ user: u, usd, credits, why, payment: pi.id })}`);
    return { ok: true, credits };
  } catch (e: any) {
    const stop = e?.stop ?? (e?.type === "StripeCardError" || /card|authentication|declined/i.test(String(e?.code ?? e?.message ?? "")) ? "The card was declined; update it in Billing and turn auto top-up back on" : null);
    await sb.from("studio_customers").update({ ...(stop ? { auto_topup_enabled: false } : {}), auto_topup_error: stop ?? "The last auto top-up did not go through; it will try again later" }).eq("user_id", u);
    log(`[topup] ALERT auto top-up failed ${JSON.stringify({ user: u, why, stop: !!stop, detail: String(e?.message ?? e).slice(0, 160) })}`);
    return { ok: false, reason: stop ? "card_failed" : "failed" };
  }
}

/** After a spend: top up when auto top-up is on and the free balance fell below the person's line. */
export async function maybeAutoTopUp(sb: SupabaseClient, stripe: StripeTopUp | null, u: string, log: (l: string) => void, why: string) {
  if (!stripe) return { ok: false, reason: "billing_unavailable" };
  const c = await sb.from("studio_customers").select("auto_topup_enabled,auto_topup_below").eq("user_id", u).maybeSingle();
  if (c.error || !c.data?.auto_topup_enabled) return { ok: false, reason: "off" };
  const bal = await sb.rpc("studio_balance", { p_user: u });
  if (bal.error || Number(bal.data ?? 0) >= Number(c.data.auto_topup_below ?? 0)) return { ok: false, reason: "above" };
  return chargeAutoTopUp(sb, stripe, u, log, why);
}

/** Every few minutes: anyone with auto top-up on whose balance fell under their line (a chat run spends too). */
export function startAutoTopUpLoop(sbFn: () => SupabaseClient, stripe: () => StripeTopUp | null, log: (l: string) => void, everyMs = 3 * 60_000): void {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const st = stripe(); if (!st) return;
      const sb = sbFn();
      const r = await sb.from("studio_customers").select("user_id").eq("auto_topup_enabled", true).in("status", ["active", "trialing"]).limit(500);
      for (const row of (r.data ?? []) as any[]) await maybeAutoTopUp(sb, st, row.user_id, log, "balance check").catch(() => undefined);
    } catch (e: any) { log(`[topup] loop ${String(e?.message ?? e).slice(0, 120)}`); }
    finally { busy = false; }
  }, everyMs).unref?.();
}
