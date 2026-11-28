// The daily tracker, step 1 (owner, Nov 28 2026): every night the server writes each Pacific day's numbers to
// studio_daily_metrics, so progress can be read day by day, week by week, without anyone's computer being on (the daily
// written read ran on a Mac and missed days). Read-only everywhere except its own table.
//
// Rows per day (cut, value):
//   - the sign-up funnel of the people who signed up that day, for: all; valued (US, CA, GB, AU, NZ, IE, Western and
//     Northern Europe: the countries that buy) yes/no; geo (US | west | south | other); role; heard; first_tool; ab
//     (the walk-through test's group, from its launch). Funnel: signups, opened_tool, saw_plans, checkout, declined,
//     paid, paid_15m, paid_day0, back_next_day. A cohort keeps maturing (someone pays the next day), so the last
//     RECOMPUTE_DAYS days are written again every night.
//   - on ("all", ""), the day's activity as well: new subscriptions and their dollars, renewals, plan changes, top-ups,
//     cancels (reasons, hours since paying), runs and failures by tool, credits charged, what the day cost us by
//     supplier, and (for yesterday only) how many people pay now.
// Our own accounts are left out (isInternalEmail). Switch: STUDIO_DAILY_METRICS=off.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isInternalEmail } from "./studio-admin-auth.js";
import { ptDay, ptDayBounds } from "./proxy-reconcile.js";
import { loadTests, refreshTests, testCuts, type TestRow } from "./tests-registry.js";

type Env = Record<string, string | undefined>;
export const VALUED = new Set(["US", "CA", "GB", "AU", "NZ", "IE", "DE", "FR", "NL", "BE", "LU", "AT", "CH", "SE", "NO", "DK", "FI", "IS", "ES", "PT", "IT"]);
const SOUTH = new Set(["IN", "PK", "BD", "NP", "LK", "PH", "ID", "KE", "NG", "GH", "UZ", "EG", "TZ", "UG", "ET"]);
const NOT_A_TOOL = new Set(["home", "onboarding", "pricing", "account", "library", "chat", "admin"]);
export const SIM_LAUNCH = "2026-11-24T06:35:00Z";
export const TRACKER_START = "2026-11-12";
export const RECOMPUTE_DAYS = 7;

export type Person = { user_id: string; created_at: string; country: string | null; role: string | null; heard: string | null };
export type Ev = { user_id: string | null; kind: string; name: string; created_at: string; props?: any };
export type DayInput = {
  day: string; people: Person[]; events: Ev[]; /** the registry's tests (tests-registry.ts): each adds its groups as cuts */ tests?: TestRow[]; /** first subscription payment per person (their ledger grant) */ paidAt: Map<string, string>;
  activity?: { invoices: Array<{ reason: string; cents: number }>; dayEvents: Ev[]; jobs: Array<{ tool: string; status: string; credits_charged: number | null; error_code: string | null }>;
    costs: Array<{ provider: string; usd: number }>; payersNow?: { paying: number; set_to_cancel: number; comped: number } | null };
};
export type Row = { day: string; cut: string; value: string; metrics: Record<string, any> };

/** Active plans split three ways: paying and renewing, paid but set to cancel, and comped (no subscription behind it). */
export function payingNow(active: Array<{ stripe_subscription_id?: string | null; cancel_at_period_end?: boolean | null; billing_source?: string | null }>): { paying: number; set_to_cancel: number; comped: number } {
  const real = active.filter((c) => !!c.stripe_subscription_id || c.billing_source === "apple");
  return { paying: real.filter((c) => !c.cancel_at_period_end).length, set_to_cancel: real.filter((c) => !!c.cancel_at_period_end).length, comped: active.length - real.length };
}
export const geoOf = (c: string | null) => (c === "US" ? "US" : c && VALUED.has(c) ? "west" : c && SOUTH.has(c) ? "south" : "other");
const abOf = (p: Person) => (Date.parse(p.created_at) < Date.parse(SIM_LAUNCH) ? null : parseInt(p.user_id.slice(-1), 16) % 2 === 1 ? "walk-through" : "control");
const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = Math.round(((o[k] ?? 0) + n) * 1e6) / 1e6; };

/** The day's rows, from what was read. Pure. */
export function computeDay(inp: DayInput): Row[] {
  const byUser = new Map<string, Ev[]>();
  for (const e of inp.events) if (e.user_id) { const l = byUser.get(e.user_id) ?? []; l.push(e); byUser.set(e.user_id, l); }
  const facts = inp.people.map((p) => {
    const evs = (byUser.get(p.user_id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const t0 = Date.parse(p.created_at), paid = inp.paidAt.get(p.user_id) ?? null, paidMs = paid ? Date.parse(paid) - t0 : null;
    const tools = evs.filter((e) => e.kind === "page" && !NOT_A_TOOL.has(e.name));
    return { p, first_tool: tools[0]?.name ?? "none", opened_tool: tools.length > 0, saw_plans: evs.some((e) => e.kind === "page" && e.name === "pricing"),
      checkout: evs.some((e) => e.kind === "checkout" && e.name === "plan"), declined: evs.some((e) => e.kind === "checkout" && e.name === "payment_declined"),
      paid: !!paid, paid_15m: paidMs !== null && paidMs <= 15 * 60_000, paid_day0: paidMs !== null && paidMs <= 24 * 3600_000,
      back_next_day: evs.some((e) => e.kind === "page" && Date.parse(e.created_at) > t0 + 24 * 3600_000) };
  });
  const groups = new Map<string, typeof facts>();
  const put = (cut: string, value: string | null, f: (typeof facts)[number]) => { if (value == null) return; const k = `${cut}\u0000${value}`; const l = groups.get(k) ?? []; l.push(f); groups.set(k, l); };
  for (const f of facts) {
    put("all", "", f); put("valued", VALUED.has(f.p.country ?? "") ? "yes" : "no", f); put("geo", geoOf(f.p.country), f);
    put("role", f.p.role ?? "?", f); put("heard", f.p.heard ?? "?", f); put("first_tool", f.first_tool, f); put("ab", abOf(f.p), f);
    // the cuts that matter most, inside the countries that buy
    for (const [cut, value] of testCuts(inp.tests ?? [], f.p, { valued: VALUED.has(f.p.country ?? ""), role: f.p.role ?? "?", first_tool: f.first_tool })) put(cut, value, f);
    if (VALUED.has(f.p.country ?? "")) { put("valued_role", f.p.role ?? "?", f); put("valued_first_tool", f.first_tool, f); put("valued_ab", abOf(f.p), f); put("valued_heard", f.p.heard ?? "?", f); }
  }
  const rows: Row[] = [];
  const n = (l: typeof facts, k: "opened_tool" | "saw_plans" | "checkout" | "declined" | "paid" | "paid_15m" | "paid_day0" | "back_next_day") => l.filter((f) => f[k]).length;
  for (const [k, l] of groups) {
    const [cut, value] = k.split("\u0000");
    rows.push({ day: inp.day, cut, value, metrics: { signups: l.length, opened_tool: n(l, "opened_tool"), saw_plans: n(l, "saw_plans"), checkout: n(l, "checkout"), declined: n(l, "declined"),
      paid: n(l, "paid"), paid_15m: n(l, "paid_15m"), paid_day0: n(l, "paid_day0"), back_next_day: n(l, "back_next_day") } });
  }
  if (!rows.some((r) => r.cut === "all")) rows.push({ day: inp.day, cut: "all", value: "", metrics: { signups: 0, opened_tool: 0, saw_plans: 0, checkout: 0, declined: 0, paid: 0, paid_15m: 0, paid_day0: 0, back_next_day: 0 } });
  const a = inp.activity;
  if (a) {
    const m = rows.find((r) => r.cut === "all")!.metrics;
    const inv = (reason: string) => a.invoices.filter((i) => i.reason === reason);
    const usd = (l: Array<{ cents: number }>) => Math.round(l.reduce((s, i) => s + i.cents, 0)) / 100;
    m.new_subs = inv("subscription_create").length; m.new_subs_usd = usd(inv("subscription_create"));
    m.renewals = inv("subscription_cycle").length; m.renewals_usd = usd(inv("subscription_cycle"));
    m.plan_changes = inv("subscription_update").length; m.plan_changes_usd = usd(inv("subscription_update"));
    const ev = (name: string) => a.dayEvents.filter((e) => e.name === name);
    m.topups = ev("topup").length; m.topup_credits = ev("topup").reduce((s, e) => s + (Number(e.props?.credits) || 0), 0);
    m.checkouts_opened = ev("plan").length; m.declines = ev("payment_declined").length;
    const cancels = ev("plan_cancel");
    m.cancels = cancels.length;
    m.cancel_hours_after_paying = cancels.map((e) => { const s = Date.parse(e.props?.started ?? ""); return Number.isFinite(s) ? Math.round((Date.parse(e.created_at) - s) / 3600_000) : null; }).filter((x) => x !== null);
    const reasons: Record<string, number> = {}; for (const e of ev("plan_cancel_reason")) bump(reasons, String(e.props?.feedback ?? "none"));
    m.cancel_reasons = reasons; m.cancels_undone = ev("plan_cancel_undone").length;
    const runs: Record<string, number> = {}, failed: Record<string, number> = {}, why: Record<string, number> = {};
    for (const j of a.jobs) { bump(runs, j.tool); if (j.status === "failed") { bump(failed, j.tool); bump(why, `${j.tool}:${j.error_code ?? "unknown"}`); } }
    m.runs = runs; m.runs_failed = failed; m.failure_reasons = why; m.credits_charged = a.jobs.reduce((s, j) => s + (Number(j.credits_charged) || 0), 0);
    const cost: Record<string, number> = {}; for (const c of a.costs) bump(cost, c.provider, Number(c.usd) || 0);
    m.cost_usd = Math.round(Object.values(cost).reduce((s, x) => s + x, 0) * 100) / 100;
    m.cost_by_supplier = Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    if (a.payersNow != null) { m.payers_now = a.payersNow.paying; m.payers_set_to_cancel = a.payersNow.set_to_cancel; m.comped_plans = a.payersNow.comped; }
  }
  return rows;
}

async function all<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, page = 1000, max = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += page) { const r = await make(from, from + page - 1); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < page) break; }
  return out;
}

/** Our own accounts' ids (read once per run). */
export async function internalIds(sb: SupabaseClient, env: Env): Promise<Set<string>> {
  const out = new Set<string>(); const admin = (sb as any).auth?.admin;
  if (admin?.listUsers) for (let page = 1; page <= 50; page++) {
    const r = await admin.listUsers({ page, perPage: 1000 }); const list = (r?.data?.users ?? []) as any[];
    for (const u of list) if (isInternalEmail(u.email, env)) out.add(u.id);
    if (list.length < 1000) break;
  }
  return out;
}

export async function loadDay(sb: SupabaseClient, day: string, internal: Set<string>, o: { latest?: boolean } = {}): Promise<DayInput> {
  const { from, to } = ptDayBounds(day);
  const cust = await all<any>((a, b) => sb.from("studio_customers").select("user_id,created_at,country,onboarding,owner_pass").gte("created_at", from).lt("created_at", to).order("created_at").range(a, b));
  const people: Person[] = cust.filter((c) => !internal.has(c.user_id) && !c.owner_pass).map((c) => ({ user_id: c.user_id, created_at: c.created_at, country: c.country ?? null, role: c.onboarding?.role ?? null, heard: c.onboarding?.heard ?? null }));
  const ids = people.map((p) => p.user_id); const events: Ev[] = []; const paidAt = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    events.push(...await all<Ev>((a, b) => sb.from("studio_events").select("user_id,kind,name,created_at").in("user_id", chunk).in("kind", ["page", "checkout"]).order("created_at").range(a, b)));
    const led = await all<any>((a, b) => sb.from("studio_credit_ledger").select("user_id,created_at,note").in("user_id", chunk).eq("reason", "grant").ilike("note", "%subscription_create%").order("created_at").range(a, b));
    for (const l of led) if (!paidAt.has(l.user_id)) paidAt.set(l.user_id, l.created_at);
  }
  const keep = (u: string | null) => !u || !internal.has(u);
  const [inv, dayEvents, jobs, costs] = await Promise.all([
    all<any>((a, b) => sb.from("studio_stripe_events").select("payload").eq("type", "invoice.paid").gte("received_at", from).lt("received_at", to).range(a, b)),
    all<Ev>((a, b) => sb.from("studio_events").select("user_id,kind,name,created_at,props").in("name", ["plan", "topup", "payment_declined", "plan_cancel", "plan_cancel_reason", "plan_cancel_undone"]).gte("created_at", from).lt("created_at", to).order("created_at").range(a, b)),
    all<any>((a, b) => sb.from("studio_jobs").select("user_id,tool,status,credits_charged,error_code").gte("created_at", from).lt("created_at", to).range(a, b)),
    all<any>((a, b) => sb.from("studio_costs").select("user_id,provider,usd").gte("spent_at", from).lt("spent_at", to).range(a, b)),
  ]);
  // who pays now (owner, Nov 28 2026: the number that matches Stripe leaves out plans set to cancel): a real Stripe or
  // Apple subscription that will renew; apart from those set to cancel (paid, ending) and comped plans (no subscription)
  let payersNow: { paying: number; set_to_cancel: number; comped: number } | null = null;
  if (o.latest) {
    const pay = await all<any>((a, b) => sb.from("studio_customers").select("user_id,owner_pass,stripe_subscription_id,cancel_at_period_end,billing_source").in("status", ["active", "trialing"]).not("plan_id", "is", null).range(a, b));
    payersNow = payingNow(pay.filter((c) => !internal.has(c.user_id) && !c.owner_pass));
  }
  return { day, people, events, paidAt, activity: {
    invoices: inv.map((s) => ({ reason: String(s.payload?.data?.object?.billing_reason ?? ""), cents: Number(s.payload?.data?.object?.amount_paid) || 0 })),
    dayEvents: dayEvents.filter((e) => keep(e.user_id)), jobs: jobs.filter((j) => keep(j.user_id)), costs, payersNow } };
}

export async function writeDay(sb: SupabaseClient, day: string, internal: Set<string>, o: { latest?: boolean; tests?: TestRow[] } = {}): Promise<number> {
  const rows = computeDay({ ...(await loadDay(sb, day, internal, o)), tests: o.tests }).map((r) => ({ ...r, computed_at: new Date().toISOString() }));
  // a group that no longer exists for the day (nobody left in it) must not keep an old row
  const del = await sb.from("studio_daily_metrics").delete().eq("day", day); if (del.error) throw del.error;
  for (let i = 0; i < rows.length; i += 500) { const ins = await sb.from("studio_daily_metrics").insert(rows.slice(i, i + 500)); if (ins.error) throw ins.error; }
  return rows.length;
}

const daysBetween = (a: string, b: string) => { const out: string[] = []; for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

/** Hourly check: once after 01:00 PT each day (and once on start), writes yesterday and the RECOMPUTE_DAYS before it;
 *  the first time the table is empty, everything from TRACKER_START. */
export function startDailyMetrics(sbFn: () => SupabaseClient, deps: { env?: Env; now?: () => number; log?: (l: string) => void } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = deps.now ?? Date.now;
  if (env.STUDIO_DAILY_METRICS === "off") return null;
  let doneFor = "", busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const yesterday = ptDay(now(), 1);
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).format(new Date(now())));
      if (doneFor === yesterday || hour < 1) return;
      const sb = sbFn();
      const had = await sb.from("studio_daily_metrics").select("day").eq("cut", "all").order("day", { ascending: true }).limit(1);
      if (had.error) throw had.error; // the table is not there yet: say so and try again next hour
      const first = (had.data ?? []).length ? ptDay(now(), 1 + RECOMPUTE_DAYS) : TRACKER_START;
      const days = daysBetween(first < TRACKER_START ? TRACKER_START : first, yesterday);
      const internal = await internalIds(sb, env); let rows = 0;
      const tests = await loadTests(sb);
      for (const d of days) rows += await writeDay(sb, d, internal, { latest: d === yesterday, tests });
      const read = await refreshTests(sb, tests).catch((e: any) => { log(`[daily-metrics] tests not read: ${String(e?.message ?? e).slice(0, 160)}`); return 0; });
      doneFor = yesterday; log(`[daily-metrics] ${JSON.stringify({ days: days.length, from: days[0], to: yesterday, rows, tests: read })}`);
    } catch (e: any) { log(`[daily-metrics] failed: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { busy = false; }
  };
  const t = setInterval(run, 3600_000); t.unref?.();
  setTimeout(run, 180_000).unref?.();
  return t;
}
