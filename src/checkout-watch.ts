// How each Stripe checkout ended, and why a card was declined (Nov 26 2026: 16 people started checkout and 1 paid; Stripe
// only sends us completed checkouts, so an abandoned or declined one left no trace). Read-only: once an hour the server
// lists Stripe's checkout sessions and failed charges of the last two days (on start, the last 14) and writes one
// studio_events row per finished session and per declined charge, with the person when Stripe names them:
//   kind "checkout", name "checkout_outcome": { ref, status: complete | expired, payment_status, plan, interval,
//     amount, currency, country }  (country: what the person typed at checkout, when they got that far)
//   kind "checkout", name "payment_declined": { ref, code, decline, reason, outcome, network, risk, card_country, brand,
//     funding, wallet, three_ds, amount, currency }  (Stripe's own words: decline_code, outcome.reason, ...)
// Written once per ref (session or charge id). Switch: STUDIO_CHECKOUT_WATCH=off.
import type { SupabaseClient } from "@supabase/supabase-js";

type Env = Record<string, string | undefined>;
type Deps = { env?: Env; fetch?: typeof fetch; now?: () => number; log?: (l: string) => void };
export type WatchRow = { user_id: string | null; kind: "checkout"; name: "checkout_outcome" | "payment_declined"; props: Record<string, any>; created_at: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const at = (s: unknown) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : new Date().toISOString());
const short = (v: unknown, n = 120) => (v == null ? null : String(v).slice(0, n));

/** One row per finished session (complete or expired; an open one is still in play) and per failed charge. */
export function watchRows(sessions: any[], charges: any[], userOfCustomer: (c: string | null) => string | null): WatchRow[] {
  const out: WatchRow[] = [];
  for (const s of sessions) {
    if (!s?.id || (s.status !== "complete" && s.status !== "expired")) continue;
    const meta = s.metadata ?? {};
    const hinted = [meta.user_id, s.client_reference_id].find((x) => typeof x === "string" && UUID.test(x)) as string | undefined;
    const cust = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
    out.push({ user_id: hinted ?? userOfCustomer(cust), kind: "checkout", name: "checkout_outcome", created_at: at(s.created), props: {
      ref: s.id, status: s.status, payment_status: s.payment_status ?? null, mode: s.mode ?? null, plan: meta.plan_id ?? null, interval: meta.interval ?? null,
      amount: Number.isFinite(Number(s.amount_total)) ? Number(s.amount_total) / 100 : null, currency: s.currency ?? null,
      country: s.customer_details?.address?.country ?? null, ended_at: s.status === "expired" ? at(s.expires_at) : null } });
  }
  for (const c of charges) {
    if (!c?.id || c.status !== "failed") continue;
    const card = c.payment_method_details?.card ?? {};
    const cust = typeof c.customer === "string" ? c.customer : c.customer?.id ?? null;
    out.push({ user_id: userOfCustomer(cust), kind: "checkout", name: "payment_declined", created_at: at(c.created), props: {
      ref: c.id, code: c.failure_code ?? null, decline: c.outcome?.reason ?? null, reason: short(c.failure_message), outcome: c.outcome?.type ?? null,
      network: c.outcome?.network_status ?? null, risk: c.outcome?.risk_level ?? null, card_country: card.country ?? null, brand: card.brand ?? null,
      funding: card.funding ?? null, wallet: card.wallet?.type ?? null, three_ds: card.three_d_secure?.result ?? null,
      amount: Number(c.amount) / 100, currency: c.currency ?? null } });
  }
  return out;
}

/** Every object of a Stripe list created in [from, now), newest first, through its pages. Read only. */
async function stripeList(env: Env, f: typeof fetch, path: string, fromSec: number, extra: Record<string, string> = {}): Promise<any[]> {
  const key = env.STRIPE_SECRET_KEY; if (!key) return [];
  const out: any[] = []; let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const q = new URLSearchParams({ limit: "100", "created[gte]": String(fromSec), ...extra });
    if (after) q.set("starting_after", after);
    const r = await f(`https://api.stripe.com/v1/${path}?${q}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`stripe ${path} ${r.status}`);
    const j: any = await r.json(); const data = Array.isArray(j?.data) ? j.data : [];
    out.push(...data);
    if (!j?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/** Reads the last `days` of sessions and failed charges and writes the rows not written yet. */
export async function watchCheckouts(sb: SupabaseClient, days: number, deps: Deps = {}): Promise<{ sessions: number; declines: number; written: number }> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  const from = Math.floor(now() / 1000) - Math.round(days * 86400);
  const [sessions, charges] = await Promise.all([stripeList(env, f, "checkout/sessions", from), stripeList(env, f, "charges", from)]);
  const failed = charges.filter((c) => c?.status === "failed");
  const customers = [...new Set(failed.map((c) => (typeof c.customer === "string" ? c.customer : c.customer?.id)).concat(sessions.map((s) => (typeof s.customer === "string" ? s.customer : s.customer?.id))).filter(Boolean))] as string[];
  const map = new Map<string, string>();
  for (let i = 0; i < customers.length; i += 200) {
    const c = await sb.from("studio_customers").select("user_id,stripe_customer_id").in("stripe_customer_id", customers.slice(i, i + 200));
    if (c.error) throw c.error;
    for (const x of (c.data ?? []) as any[]) map.set(x.stripe_customer_id, x.user_id);
  }
  const rows = watchRows(sessions, failed, (c) => (c ? map.get(c) ?? null : null));
  if (!rows.length) return { sessions: sessions.length, declines: failed.length, written: 0 };
  // written once per ref: the refs already recorded in the window are skipped
  const had = await sb.from("studio_events").select("props").eq("kind", "checkout").in("name", ["checkout_outcome", "payment_declined"]).gte("created_at", new Date((from - 86400) * 1000).toISOString()).limit(20_000);
  if (had.error) throw had.error;
  const seen = new Set(((had.data ?? []) as any[]).map((x) => x.props?.ref).filter(Boolean));
  const fresh = rows.filter((r) => !seen.has(r.props.ref));
  for (let i = 0; i < fresh.length; i += 500) { const ins = await sb.from("studio_events").insert(fresh.slice(i, i + 500)); if (ins.error) throw ins.error; }
  return { sessions: sessions.length, declines: failed.length, written: fresh.length };
}

export const CHECKOUT_WATCH = { every_ms: 3600_000, days: 2, backfill_days: 14, first_after_ms: 120_000 };
export function startCheckoutWatch(sbFn: () => SupabaseClient, deps: Deps = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  if (env.STUDIO_CHECKOUT_WATCH === "off" || !env.STRIPE_SECRET_KEY) return null;
  let first = true, busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { const r = await watchCheckouts(sbFn(), first ? CHECKOUT_WATCH.backfill_days : CHECKOUT_WATCH.days, deps); first = false; if (r.written) log(`[checkout-watch] ${JSON.stringify(r)}`); }
    catch (e: any) { log(`[checkout-watch] failed: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { busy = false; }
  };
  const t = setInterval(run, CHECKOUT_WATCH.every_ms); t.unref?.();
  setTimeout(run, CHECKOUT_WATCH.first_after_ms).unref?.();
  return t;
}
