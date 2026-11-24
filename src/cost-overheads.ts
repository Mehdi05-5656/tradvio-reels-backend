// What the cost ledger missed because no single run spends it (audit Nov 24 2026, docs/costs/AUDIT_2026-11-24.md):
//   1. Stripe's fees, to the cent, from Stripe's own balance transactions: the processing fee on every payment (with
//      the person it came from) and Stripe's own charges (Billing, Radar). One row per transaction, ref stripe:<txn id>.
//   2. Fixed monthly bills, one row per bill per Pacific day (ref fixed:<bill>:<day>), at the bill's monthly amount
//      spread over the days of the year. A bill that runs already book part of (a worker's time, the ElevenLabs plan's
//      credits) books only what the day's runs did not: the day's share minus what was booked against it that day,
//      never below zero. So the ledger's total follows the bills, and nothing is counted twice.
// Bills: DEFAULT_FIXED_BILLS (Render's list prices for the services we run, the ElevenLabs plan the owner named), and
// STUDIO_FIXED_BILLS on the web service to add bills or replace one with its invoice amount (JSON list of
// { "id", "provider", "product", "usd_month", "basis": "invoice" | "list" | "estimated" }; usd_month 0 removes one).
// Runs once a day after 08:00 PT for the day before; written once per ref across restarts; backfills a few days.
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanCost, type CostBasis, type CostRow } from "./studio-costs.js";
import { ptDay, ptDayBounds } from "./proxy-reconcile.js";

type Env = Record<string, string | undefined>;
const HOUR = 3600_000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A monthly bill. `minus`: cost rows that already book part of it (that provider, optionally that writer). */
export type FixedBill = { id: string; provider: string; product: string; usd_month: number; basis: CostBasis; minus?: { providers: string[]; writer?: string }; note?: string };
/** Render's list prices for the plans the services run on (checked against Render's service list, Nov 24 2026), and
 *  the ElevenLabs plan the owner gave (Nov 11 2026: Pro, $99 a month). Other bills (Vercel, Supabase, PostHog, Resend,
 *  the domain) wait for their amounts in STUDIO_FIXED_BILLS. Cron jobs bill by the minute and are left out. */
export const DEFAULT_FIXED_BILLS: FixedBill[] = [
  { id: "render-backend", provider: "render", product: "web service tradvio-reels-backend (Pro 2 CPU / 4 GB)", usd_month: 85, basis: "list" },
  { id: "render-blueprint", provider: "render", product: "worker clone8-studio-blueprint (Standard)", usd_month: 25, basis: "list" },
  { id: "render-kage", provider: "render", product: "worker kage-motion (Pro Plus 4 CPU / 8 GB), time no job used", usd_month: 175, basis: "list", minus: { providers: ["render"], writer: "kage-motion" } },
  { id: "render-films", provider: "render", product: "worker clone8-longform (Pro Plus 4 CPU / 8 GB), time no job used", usd_month: 175, basis: "list", minus: { providers: ["render"], writer: "clone8-longform-worker" } },
  { id: "elevenlabs-plan", provider: "elevenlabs", product: "plan (Pro), credits no job used", usd_month: 99, basis: "invoice", minus: { providers: ["elevenlabs", "elevenlabs_scribe"] } },
];

/** The bills in force: the defaults, with STUDIO_FIXED_BILLS adding or replacing by id (usd_month 0 removes one). */
export function fixedBills(env: Env = process.env): FixedBill[] {
  const byId = new Map(DEFAULT_FIXED_BILLS.map((b) => [b.id, b]));
  let extra: any[] = [];
  try { const v = JSON.parse(env.STUDIO_FIXED_BILLS || "[]"); if (Array.isArray(v)) extra = v; } catch { extra = []; }
  for (const x of extra) {
    const id = String(x?.id ?? "").trim(); if (!id) continue;
    const usd = Number(x.usd_month);
    if (!(usd > 0)) { byId.delete(id); continue; }
    const had = byId.get(id);
    const basis: CostBasis = ["invoice", "list", "estimated", "metered"].includes(x.basis) ? x.basis : "invoice";
    byId.set(id, { id, provider: String(x.provider ?? had?.provider ?? id), product: String(x.product ?? had?.product ?? id), usd_month: usd, basis, minus: had?.minus, note: x.note ? String(x.note) : had?.note });
  }
  return [...byId.values()];
}

/** One Pacific day's row per bill: the day's share (12 months over 365 days) less what runs booked against it. */
export function fixedBillRows(day: string, bills: FixedBill[], bookedFor: (b: FixedBill) => number): CostRow[] {
  const at = ptDayBounds(day).from;
  return bills.map((b) => {
    const share = (b.usd_month * 12) / 365, booked = b.minus ? Math.max(0, bookedFor(b)) : 0;
    return { spent_at: at, provider: b.provider, product: b.product, source: "fixed monthly bill", units: { usd_month: b.usd_month, day_share_usd: r6(share), booked_by_runs_usd: r6(booked) },
      usd: r6(Math.max(0, share - booked)), basis: b.basis, writer: "cost-overheads", ref: `fixed:${b.id}:${day}`,
      note: b.minus ? "the day's share of the monthly bill, less what that day's runs booked against it" : "the day's share of the monthly bill" };
  });
}

/** Stripe's balance transactions as cost rows: the fee on each payment (with the person), and Stripe's own charges. */
export function stripeFeeRows(txns: any[], userOf: (customer: string | null) => string | null): CostRow[] {
  const out: CostRow[] = [];
  for (const t of txns) {
    if (!t?.id) continue;
    const at = Number(t.created) > 0 ? new Date(Number(t.created) * 1000).toISOString() : undefined;
    if (t.type === "stripe_fee") { // Billing, Radar and the like: the transaction itself is the charge
      const usd = -Number(t.amount) / 100; if (!(usd > 0)) continue;
      out.push({ spent_at: at, provider: "stripe", product: String(t.description || "Stripe fee").slice(0, 120), source: "stripe fee", usd, basis: "metered", writer: "cost-overheads", ref: `stripe:${t.id}` });
      continue;
    }
    const fee = Number(t.fee) / 100; if (!(fee > 0)) continue;
    const src = t.source && typeof t.source === "object" ? t.source : null;
    const customer = src ? (typeof src.customer === "string" ? src.customer : src.customer?.id ?? null) : null;
    const kinds = (Array.isArray(t.fee_details) ? t.fee_details : []).map((f: any) => String(f?.type ?? "")).filter(Boolean);
    out.push({ spent_at: at, user_id: userOf(customer), provider: "stripe", product: kinds.length ? `${kinds.join(" + ")} on a ${t.type}` : `fee on a ${t.type}`, source: "payment fee",
      units: { amount_usd: Number(t.amount) / 100 }, usd: fee, basis: "metered", writer: "cost-overheads", ref: `stripe:${t.id}` });
  }
  return out;
}

type Deps = { env?: Env; fetch?: typeof fetch; now?: () => number; log?: (l: string) => void };

/** Every balance transaction Stripe made in [from, to), with its payment's customer. Read only. */
export async function stripeTransactions(env: Env, f: typeof fetch, from: string, to: string): Promise<any[]> {
  const key = env.STRIPE_SECRET_KEY; if (!key) return [];
  const out: any[] = []; let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100", "created[gte]": String(Math.floor(Date.parse(from) / 1000)), "created[lt]": String(Math.floor(Date.parse(to) / 1000)), "expand[]": "data.source" });
    if (after) q.set("starting_after", after);
    const r = await f(`https://api.stripe.com/v1/balance_transactions?${q}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`stripe ${r.status}`);
    const j: any = await r.json(); const data = Array.isArray(j?.data) ? j.data : [];
    out.push(...data);
    if (!j?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/** Book one Pacific day: Stripe's fees and the fixed bills. Rows already written (by ref) are not written again. */
export async function bookOverheads(sb: SupabaseClient, day: string, deps: Deps = {}): Promise<{ day: string; stripe: number; fixed: number; usd: number }> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch;
  const { from, to } = ptDayBounds(day);
  // what is already there for this day (refs), and what runs booked by provider and writer (for the bills' "minus")
  const had = await sb.from("studio_costs").select("ref,provider,writer,usd").gte("spent_at", from).lt("spent_at", to).limit(50_000);
  if (had.error) throw had.error;
  const rows = (had.data ?? []) as Array<{ ref: string | null; provider: string; writer: string; usd: number }>;
  const refs = new Set(rows.map((r) => r.ref).filter(Boolean) as string[]);
  const bookedFor = (b: FixedBill) => rows.filter((r) => b.minus!.providers.includes(r.provider) && (!b.minus!.writer || r.writer === b.minus!.writer) && r.writer !== "cost-overheads").reduce((a, r) => a + (Number(r.usd) || 0), 0);
  const fixed = fixedBillRows(day, fixedBills(env), bookedFor);
  let stripe: CostRow[] = [];
  if (env.STRIPE_SECRET_KEY) {
    const txns = await stripeTransactions(env, f, from, to);
    const customers = [...new Set(txns.map((t) => (t?.source && typeof t.source === "object" ? (typeof t.source.customer === "string" ? t.source.customer : t.source.customer?.id) : null)).filter(Boolean))] as string[];
    const map = new Map<string, string>();
    if (customers.length) { const c = await sb.from("studio_customers").select("user_id,stripe_customer_id").in("stripe_customer_id", customers); for (const x of (c.data ?? []) as any[]) map.set(x.stripe_customer_id, x.user_id); }
    stripe = stripeFeeRows(txns, (c) => (c ? map.get(c) ?? null : null));
  }
  const fresh = [...stripe, ...fixed].filter((r) => r.ref && !refs.has(r.ref)).map((r) => cleanCost(r));
  if (fresh.length) { const ins = await sb.from("studio_costs").insert(fresh); if (ins.error) throw ins.error; }
  const usd = r6(fresh.reduce((a, r) => a + r.usd, 0));
  return { day, stripe: fresh.filter((r) => r.provider === "stripe").length, fixed: fresh.filter((r) => r.writer === "cost-overheads" && r.provider !== "stripe").length, usd };
}

/** Once a day after 08:00 PT: book yesterday (and, on start, the BACKFILL days before it). Checked every hour. */
export const BACKFILL_DAYS = 14;
export function startCostOverheads(sbFn: () => SupabaseClient, deps: Deps & { everyMs?: number } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = deps.now ?? Date.now;
  if (env.STUDIO_COST_OVERHEADS === "off") return null;
  let first = true, busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).format(new Date(now())));
      const days = first ? Array.from({ length: Number(env.STUDIO_COST_OVERHEADS_BACKFILL ?? BACKFILL_DAYS) || 1 }, (_, i) => ptDay(now(), i + 1)) : hour >= 8 ? [ptDay(now(), 1)] : [];
      first = false;
      for (const day of days) { const r = await bookOverheads(sbFn(), day, deps); if (r.stripe || r.fixed) log(`[cost-overheads] ${JSON.stringify(r)}`); }
    } catch (e: any) { log(`[cost-overheads] failed: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { busy = false; }
  };
  const timer = setInterval(run, deps.everyMs ?? HOUR); timer.unref?.();
  setTimeout(run, 90_000).unref?.();
  return timer;
}
