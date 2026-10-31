// Clone8 Studio: changing plans when a subscription already exists. Upgrades happen from the plan page: the person is
// sent straight to Stripe's own confirm page for that exact change (the prorated amount, the card, 3-D Secure), and the
// same subscription moves to the new plan. A subscription that also carries extra social accounts cannot go through that
// page (Stripe confirms one item only), so the prorated amount is previewed here and charged to the card on file.
// Downgrades and cancelling go through the billing portal, configured here so a lower plan starts at the next renewal.
//
// Credits follow the money: an upgrade adds the new plan's credits for the time left, less the old plan's unused share,
// the same way Stripe prorates the price (not a whole new period's credits on top of the old one).
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANS, planById, planForPrice, priceIdFor, seatPriceId, type Interval } from "./studio.js";

export const PLAN_RANK: Record<string, number> = { starter: 1, creator: 2, studio: 3 };
export type ChangeKind = "same" | "upgrade" | "downgrade";

/** A higher plan is an upgrade whatever the interval; on the same plan, monthly to yearly is (a longer commitment), the
 *  reverse is a downgrade that waits for the renewal. */
export function changeKind(from: { plan: string; interval: Interval }, to: { plan: string; interval: Interval }): ChangeKind {
  const a = PLAN_RANK[from.plan] ?? 0, b = PLAN_RANK[to.plan] ?? 0;
  if (b > a) return "upgrade";
  if (b < a) return "downgrade";
  if (from.interval === to.interval) return "same";
  return to.interval === "year" ? "upgrade" : "downgrade";
}

const SECONDS: Record<Interval, number> = { month: 30.44 * 86400, year: 365.25 * 86400 };
const lineOf = (l: any) => { const p = l?.pricing?.price_details?.price ?? l?.price?.id ?? l?.plan?.id ?? null; return typeof p === "string" ? p : p?.id ?? null; };

/** Credits an upgrade invoice buys: the new plan's period credits for the share of the period charged, less the old
 *  plan's for the share credited back. Null when the invoice has no credit-back line (then it is not an upgrade). */
export function upgradeCredits(inv: any, env: Record<string, string | undefined> = process.env): number | null {
  const lines = ((inv?.lines?.data ?? []) as any[]);
  const share = (l: any, interval: Interval) => { const s = Number(l?.period?.start), e = Number(l?.period?.end); return s > 0 && e > s ? Math.min(1, (e - s) / SECONDS[interval]) : 1; };
  let add = 0, back = 0, sawBack = false;
  for (const l of lines) {
    const m = planForPrice(lineOf(l), env); if (!m) continue;
    const period = m.plan.credits * (m.interval === "year" ? 12 : 1);
    if (Number(l?.amount ?? 0) < 0) { sawBack = true; back += period * share(l, m.interval); }
    else if (Number(l?.amount ?? 0) > 0) add += period * share(l, m.interval);
  }
  if (!sawBack) return null;
  return Math.max(0, Math.round(add - back));
}

/** The billing portal Clone8 uses: plan switching between the three plans (lower plans and shorter intervals wait for
 *  the renewal), cancelling at the end of the period, cards and invoices. Found by its metadata, made once if missing. */
let portalConfig: string | null | undefined;
export async function ensurePortalConfig(stripe: any, env: Record<string, string | undefined>, log: (s: string) => void = console.log): Promise<string | null> {
  if (portalConfig !== undefined) return portalConfig;
  try {
    const list = await stripe.billingPortal.configurations.list({ limit: 50, active: true });
    const found = (list?.data ?? []).find((c: any) => c?.metadata?.clone8 === "plans-v1");
    if (found) return (portalConfig = found.id);
    const byProduct = new Map<string, string[]>();
    for (const p of PLANS) for (const i of ["month", "year"] as Interval[]) {
      const id = priceIdFor(p.id, i, env); if (!id) continue;
      const price = await stripe.prices.retrieve(id);
      const product = typeof price.product === "string" ? price.product : price.product?.id;
      byProduct.set(product, [...(byProduct.get(product) ?? []), id]);
    }
    const made = await stripe.billingPortal.configurations.create({
      business_profile: { headline: "Clone8: your plan, cards and invoices" },
      features: {
        customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none", cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] } },
        subscription_update: {
          enabled: true, default_allowed_updates: ["price"], proration_behavior: "always_invoice",
          products: [...byProduct.entries()].map(([product, prices]) => ({ product, prices })),
          schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] },
        },
      },
      metadata: { clone8: "plans-v1" },
    });
    log(`[studio] billing portal configuration made ${made.id}`);
    return (portalConfig = made.id);
  } catch (e: any) {
    // the default portal still opens (cards, invoices, cancel), just without plan switching
    console.error(`[studio] ALERT billing portal configuration: ${String(e?.message ?? e).slice(0, 200)}`);
    portalConfig = undefined;
    return null;
  }
}

/** Every STRIPE_PRICE_* setting looked up in the Stripe account the key belongs to: names of the ones that are not there
 *  (a sandbox id left behind is the usual cause). */
export async function missingPrices(stripe: any, env: Record<string, string | undefined>): Promise<string[]> {
  const names = Object.keys(env).filter((k) => /^STRIPE_PRICE_[A-Z0-9_]+$/.test(k) && env[k]);
  const bad: string[] = [];
  for (const k of names) { try { const p = await stripe.prices.retrieve(env[k]!); if (!p || p.active === false) bad.push(k); } catch { bad.push(k); } }
  return bad;
}
export const isNoSuchPrice = (e: any) => /no such price/i.test(String(e?.message ?? e)) || (e?.code === "resource_missing" && /price/i.test(String(e?.param ?? e?.message ?? "")));

type Deps = { sbFn: () => SupabaseClient; stripe: () => any; env: Record<string, string | undefined>; dashboard: () => string; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => void; log: (s: string) => void };

export function registerPlanChange(app: Express, d: Deps): void {
  const load = async (u: string) => {
    const c = await d.sbFn().from("studio_customers").select("plan_id,billing_interval,status,stripe_customer_id,stripe_subscription_id").eq("user_id", u).maybeSingle();
    if (c.error) throw c.error;
    return c.data as any;
  };
  /** The change asked for, checked against the subscription as Stripe has it. */
  const prepare = async (req: Request, res: Response) => {
    const u = d.requireUser(req, res); if (!u) return null;
    const plan = planById(req.body?.plan), interval: Interval = req.body?.interval === "year" ? "year" : "month";
    if (!plan) { res.status(400).json({ error: "unknown_plan" }); return null; }
    const c = await load(u);
    if (!c?.stripe_subscription_id || !["active", "trialing", "past_due"].includes(c.status)) { res.status(409).json({ error: "no_subscription", detail: "Pick a plan first" }); return null; }
    const price = priceIdFor(plan.id, interval, d.env);
    if (!price) { res.status(503).json({ error: "billing_unavailable", detail: "That plan is not configured in Stripe yet" }); return null; }
    const st = d.stripe();
    const sub = await st.subscriptions.retrieve(c.stripe_subscription_id);
    const items: any[] = sub?.items?.data ?? [];
    const planItem = items.find((it) => planForPrice(it?.price?.id ?? it?.plan?.id, d.env));
    const from = planForPrice(planItem?.price?.id ?? planItem?.plan?.id, d.env);
    if (!planItem || !from) { res.status(409).json({ error: "subscription_unreadable", detail: "Your subscription could not be read; change it in Billing" }); return null; }
    const kind = changeKind({ plan: from.plan.id, interval: from.interval }, { plan: plan.id, interval });
    if (kind === "same") { res.status(409).json({ error: "same_plan", detail: "That is your plan already" }); return null; }
    // extra social accounts follow the plan's interval (Stripe needs one interval per subscription)
    const seatItems = items.filter((it) => it !== planItem).map((it) => (interval !== from.interval && seatPriceId(interval, d.env) ? { id: it.id, price: seatPriceId(interval, d.env)!, quantity: it.quantity } : { id: it.id }));
    return { u, c, st, sub, plan, interval, price, planItem, from, kind, seatItems };
  };
  const confirmUrl = (p: NonNullable<Awaited<ReturnType<typeof prepare>>>, configuration: string | null) => p.st.billingPortal.sessions.create({
    customer: p.c.stripe_customer_id, return_url: `${d.dashboard()}/#studio/pricing`, ...(configuration ? { configuration } : {}),
    flow_data: { type: "subscription_update_confirm", subscription_update_confirm: { subscription: p.sub.id, items: [{ id: p.planItem.id, price: p.price, quantity: 1 }] }, after_completion: { type: "redirect", redirect: { return_url: `${d.dashboard()}/#studio/account?plan=changed` } } },
  });

  // From the plan page: an upgrade (or a downgrade) of an existing subscription.
  app.post("/api/studio/billing/change", async (req, res) => {
    try {
      const p = await prepare(req, res); if (!p) return;
      const configuration = await ensurePortalConfig(p.st, d.env, d.log);
      if (p.kind === "upgrade" && !p.seatItems.length) {
        // Stripe's own confirm page for exactly this change: the prorated amount, the card, 3-D Secure, then back here
        const s = await confirmUrl(p, configuration);
        d.log(`[studio] plan change ${JSON.stringify({ user: p.u, from: `${p.from.plan.id}/${p.from.interval}`, to: `${p.plan.id}/${p.interval}`, via: "stripe_confirm" })}`);
        return res.json({ kind: p.kind, url: s.url });
      }
      if (p.kind === "upgrade") {
        // extra social accounts on the subscription: the prorated amount is shown here and charged on Confirm
        const preview = await p.st.invoices.createPreview({ customer: p.c.stripe_customer_id, subscription: p.sub.id, subscription_details: { items: [{ id: p.planItem.id, price: p.price, quantity: 1 }, ...p.seatItems], proration_behavior: "always_invoice" } });
        return res.json({ kind: p.kind, confirm: { amount_due: Number(preview?.amount_due ?? 0) / 100, currency: String(preview?.currency ?? "usd"), plan: p.plan.id, interval: p.interval } });
      }
      // a downgrade: the billing portal's confirm page; with Clone8's portal settings it starts at the next renewal
      const s = configuration ? await confirmUrl(p, configuration).catch(() => null) : null;
      const url = s?.url ?? (await p.st.billingPortal.sessions.create({ customer: p.c.stripe_customer_id, return_url: `${d.dashboard()}/#studio/account` })).url;
      d.log(`[studio] plan change ${JSON.stringify({ user: p.u, from: `${p.from.plan.id}/${p.from.interval}`, to: `${p.plan.id}/${p.interval}`, via: s ? "portal_confirm" : "portal" })}`);
      res.json({ kind: p.kind, url, at_renewal: true });
    } catch (e: any) {
      if (isNoSuchPrice(e)) { console.error(`[studio] ALERT ${String(e?.message ?? e)}`); return res.status(503).json({ error: "billing_misconfigured", detail: "That plan is not set up in billing yet. We have been alerted." }); }
      d.fail(res, e);
    }
  });
  // The confirm step for a subscription with extra social accounts: the change is made and the difference charged now.
  app.post("/api/studio/billing/change/confirm", async (req, res) => {
    try {
      const p = await prepare(req, res); if (!p) return;
      if (p.kind !== "upgrade") return res.status(409).json({ error: "use_portal", detail: "Lower plans are changed in Billing" });
      const updated = await p.st.subscriptions.update(p.sub.id, { items: [{ id: p.planItem.id, price: p.price, quantity: 1 }, ...p.seatItems], proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete", metadata: { ...(p.sub.metadata ?? {}), plan_id: p.plan.id } });
      d.log(`[studio] plan change ${JSON.stringify({ user: p.u, from: `${p.from.plan.id}/${p.from.interval}`, to: `${p.plan.id}/${p.interval}`, via: "direct", status: updated?.status })}`);
      res.json({ kind: p.kind, status: updated?.status ?? null });
    } catch (e: any) {
      if (e?.type === "StripeCardError" || e?.code === "card_declined" || /payment/i.test(String(e?.message ?? ""))) return res.status(402).json({ error: "payment_failed", detail: "The card on file was declined; update it in Billing and try again" });
      d.fail(res, e);
    }
  });
}
