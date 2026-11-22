// Clone8 Studio: keeping the posting service's bill to people who use it (owner, Nov 21 2026).
//
// The posting service (Ayrshare) bills one "profile" per person who presses "Connect your socials", whatever they
// link and whether they link anything at all. Its bill is the month's highest daily count of profiles. So:
//   - a profile with no linked network is removed a couple of hours after the last "Connect" press (STUDIO_SOCIAL_UNLINKED_HOURS);
//   - a profile whose person has not posted, scheduled, opened their stats or relinked for 14 days is removed
//     (STUDIO_SOCIAL_IDLE_DAYS); never while a post is scheduled or on its way, never for an account in the creator program;
//   - a profile whose person no longer has a plan is removed (the plan-end hook usually did it already).
// Removing a profile unlinks the networks at the service; the person's post history stays, and "Connect your
// socials" makes a fresh profile at any time. Every removal is an event (studio_events, kind "feature") and the
// person sees why on the Publish page (studio_social_prefs.cleared_at / cleared_reason).
//
// Once a day the service's bill is written to the cost ledger (studio_costs), one row per profile with its share of
// the day, so the Money tab shows what posting costs and for whom. Switch: STUDIO_SOCIAL_CLEANUP=on (default) | dry | off.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSocialProvider, providerNamed, type SocialDeps, type SocialProvider } from "./social-provider.js";
import { hasPlanAccess } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import { recordCost } from "./studio-costs.js";

// ---------------------------------------------------------------------------------------------------
// What the service costs (ayrshare.com/pricing, read Nov 21 2026; the account page agrees for Launch)
// ---------------------------------------------------------------------------------------------------
/** Launch: a flat $299 a month for up to 10 profiles (no way past 10 on it). Business: a base for the first 30, then
 *  a price per profile that falls with the count, up to 300 (beyond that only Enterprise, a custom price). */
export const AYRSHARE_PRICES = {
  checked: "2026-11-21",
  launch: { usd_month: 299, max_profiles: 10 },
  business: {
    included: 30, max_profiles: 300,
    month: { base: 599, tiers: [[100, 8.99], [500, 3.49], [Infinity, 2.49]] as Array<[number, number]> },
    year: { base: 499, tiers: [[100, 7.99], [500, 2.99], [Infinity, 1.99]] as Array<[number, number]> },
  },
} as const;
/** The Launch trial ended on this day; before it nothing was billed. */
export const AYRSHARE_BILLING_FROM = "2026-11-24";

export type AyrshareBill = { plan: "launch" | "business"; interval: "month" | "year"; profiles: number; usd_month: number; per_profile_usd: number; next_profile_usd: number };
/** The monthly bill for a number of profiles. plan "auto" takes Launch up to 10 and Business above. `next_profile_usd`
 *  is what one more profile adds to the month (the 11th forces Business: +$300). */
export function ayrshareBill(profiles: number, o: { plan?: "launch" | "business" | "auto"; interval?: "month" | "year" } = {}): AyrshareBill {
  const n = Math.max(0, Math.floor(profiles)), interval = o.interval === "year" ? "year" : "month";
  const usd = (k: number, plan: "launch" | "business") => {
    if (plan === "launch" && k <= AYRSHARE_PRICES.launch.max_profiles) return AYRSHARE_PRICES.launch.usd_month;
    const b = AYRSHARE_PRICES.business[interval];
    let total: number = b.base, from: number = AYRSHARE_PRICES.business.included;
    for (const [upTo, rate] of b.tiers) { if (k > from) total += (Math.min(k, upTo) - from) * rate; from = upTo; }
    return Math.round(total * 100) / 100;
  };
  // Launch cannot hold more than 10, so past 10 it is Business whatever the setting says
  const planFor = (k: number): "launch" | "business" => (o.plan === "business" || k > AYRSHARE_PRICES.launch.max_profiles ? "business" : "launch");
  const plan = planFor(n), now = usd(n, plan), next = usd(n + 1, planFor(n + 1));
  return { plan, interval, profiles: n, usd_month: now, per_profile_usd: n ? Math.round((now / n) * 100) / 100 : now, next_profile_usd: Math.round((next - now) * 100) / 100 };
}

/** Zernio (zernio.com/pricing, read Nov 21 2026): per linked network account per month, graduated, prorated daily:
 *  the first 2 free, $6 each to 10, $3 each to 100, $1 each after (enterprise discounts from 2,000). */
export const ZERNIO_PRICES = { checked: "2026-11-21", tiers: [[2, 0], [10, 6], [100, 3], [Infinity, 1]] as Array<[number, number]> };
export function zernioBill(accounts: number): { accounts: number; usd_month: number; per_account_usd: number; next_account_usd: number } {
  const usd = (k: number) => { let t = 0, from = 0; for (const [upTo, rate] of ZERNIO_PRICES.tiers) { if (k > from) t += (Math.min(k, upTo) - from) * rate; from = upTo; } return Math.round(t * 100) / 100; };
  const n = Math.max(0, Math.floor(accounts));
  return { accounts: n, usd_month: usd(n), per_account_usd: n ? Math.round((usd(n) / n) * 100) / 100 : 0, next_account_usd: Math.round((usd(n + 1) - usd(n)) * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------
type Env = Record<string, string | undefined>;
export const upkeepSettings = (env: Env) => ({
  mode: (["off", "dry"].includes(String(env.STUDIO_SOCIAL_CLEANUP ?? "").toLowerCase()) ? String(env.STUDIO_SOCIAL_CLEANUP).toLowerCase() : "on") as "on" | "dry" | "off",
  idleDays: Math.max(1, Number(env.STUDIO_SOCIAL_IDLE_DAYS) || 14),
  unlinkedHours: Math.max(0.5, Number(env.STUDIO_SOCIAL_UNLINKED_HOURS) || 2),
  plan: (env.AYRSHARE_PLAN === "business" ? "business" : env.AYRSHARE_PLAN === "launch" ? "launch" : "auto") as "launch" | "business" | "auto",
  interval: (env.AYRSHARE_BILLING_INTERVAL === "year" ? "year" : "month") as "month" | "year",
});

// ---------------------------------------------------------------------------------------------------
// When a profile counts as used
// ---------------------------------------------------------------------------------------------------
export type ClearReason = "never_linked" | "idle" | "no_plan" | "plan_ended" | "provider_moved";
export const CLEAR_MESSAGE: Record<ClearReason, string> = {
  never_linked: "Nothing was linked, so the connection was closed. Connect again any time.",
  idle: "Your accounts were unlinked after 14 days without posting from Clone8. Connect again any time; it takes a minute.",
  no_plan: "Your accounts were unlinked because your plan ended. Pick a plan to post again.",
  plan_ended: "Your accounts were unlinked because your plan ended. Pick a plan to post again.",
  provider_moved: "Posting moved to a new, faster connection. Link your accounts again; it takes a minute.",
};

/** Mark that the person used posting just now (posted, scheduled, canceled, relinked, drafted a caption, opened stats).
 *  Never throws: before the upkeep migration the column is missing and this is a no-op. */
export async function touchSocial(sb: SupabaseClient, u: string): Promise<void> {
  try { await sb.from("studio_social_profiles").update({ last_active_at: new Date().toISOString() }).eq("user_id", u); } catch { /* best effort */ }
}

export type ProfileFacts = { user_id: string; created_at: string; last_active_at?: string | null; perf_viewed_at?: string | null; accounts?: any[] | null };
/** The last time the person used posting: the latest of the profile's creation, the last "Connect" press or post
 *  (last_active_at), the last time they opened their stats, and their last post request. */
export function lastUse(p: ProfileFacts, lastPostAt: string | null | undefined): number {
  return Math.max(...[p.created_at, p.last_active_at, p.perf_viewed_at, lastPostAt].map((x) => (x ? Date.parse(x) : 0)).filter((x) => Number.isFinite(x)));
}
/** When an idle, linked profile is removed (null when it is kept regardless: a post on its way, or the creator program). */
export function keepUntil(p: ProfileFacts, lastPostAt: string | null | undefined, opts: { idleDays: number; held: boolean }): string | null {
  if (opts.held || !(p.accounts ?? []).length) return null;
  return new Date(lastUse(p, lastPostAt) + opts.idleDays * 86400_000).toISOString();
}

/** Why a profile should go now, or null to keep it. `linked` is the service's live answer when the cache was empty. */
export function clearReason(p: ProfileFacts, f: { hasPlan: boolean; held: boolean; lastPostAt: string | null; linked: number }, s: { idleDays: number; unlinkedHours: number }, now = Date.now()): ClearReason | null {
  if (!f.hasPlan) return "no_plan";
  if (f.held) return null;
  const since = now - lastUse(p, f.lastPostAt);
  if (!f.linked) return since > s.unlinkedHours * 3600_000 ? "never_linked" : null;
  return since > s.idleDays * 86400_000 ? "idle" : null;
}

/** Remove one person's profile at the service and here, remember why for the Publish page, and record the event. */
export async function clearProfile(sb: SupabaseClient, p: SocialProvider | null, row: { user_id: string; profile_key: string; accounts?: any[] | null; created_at?: string }, reason: ClearReason, log: (s: string) => void, extra: Record<string, any> = {}): Promise<boolean> {
  // a profile at a provider we have left (Ayrshare, cancelled Nov 21 2026) is gone with that account: its refusal does
  // not keep our row, or the row would be retried forever
  const retired = reason === "provider_moved" || extra.retired === true;
  if (p) {
    // the provider treats "already gone" as done; any other failure keeps the row so the next round tries again
    try { await p.deleteProfile(row.profile_key); }
    catch (e: any) { log(`[social] clearing ${row.user_id} failed at the service: ${String(e?.message ?? e).slice(0, 160)}${retired ? " (left provider; removed here anyway)" : ""}`); if (!retired) return false; }
  }
  const d = await sb.from("studio_social_profiles").delete().eq("user_id", row.user_id).eq("profile_key", row.profile_key);
  if (d.error) { log(`[social] clearing ${row.user_id}: ${d.error.message}`); return false; }
  const at = new Date().toISOString();
  try {
    const up = await sb.from("studio_social_prefs").upsert({ user_id: row.user_id, cleared_at: at, cleared_reason: reason, updated_at: at }, { onConflict: "user_id" });
    if (up.error && !/cleared_/.test(String(up.error.message ?? ""))) log(`[social] clear note for ${row.user_id}: ${up.error.message}`);
  } catch { /* the note is a courtesy */ }
  const networks = (row.accounts ?? []).map((a: any) => a?.platform).filter(Boolean);
  recordEvent({ user_id: row.user_id, kind: "feature", name: "social_profile_cleared", props: { reason, networks, days_kept: row.created_at ? Math.round((Date.now() - Date.parse(row.created_at)) / 86400_000) : null, ...extra } });
  log(`[social] profile cleared for ${row.user_id} (${reason}${networks.length ? `, had ${networks.join(",")}` : ""})`);
  return true;
}

// ---------------------------------------------------------------------------------------------------
// The sweep (hourly) and the daily cost rows
// ---------------------------------------------------------------------------------------------------
export type UpkeepResult = { profiles: number; cleared: Array<{ user_id: string; reason: ClearReason }>; would_clear: Array<{ user_id: string; reason: ClearReason }>; kept: number; mode: "on" | "dry" | "off" };

/** Facts the sweep and the Publish page both need, for the given people. */
export async function upkeepFacts(sb: SupabaseClient, users: string[], idleDays: number, now = Date.now()) {
  const facts = new Map<string, { hasPlan: boolean; held: boolean; lastPostAt: string | null }>();
  if (!users.length) return facts;
  const since = new Date(now - (idleDays + 1) * 86400_000).toISOString();
  const [cust, recent, open, creators] = await Promise.all([
    sb.from("studio_customers").select("user_id,status,owner_pass").in("user_id", users),
    sb.from("studio_social_posts").select("user_id,created_at").in("user_id", users).gte("created_at", since).limit(10_000),
    sb.from("studio_social_posts").select("user_id").in("user_id", users).in("status", ["scheduled", "sending"]).limit(10_000),
    sb.from("studio_creator_accounts").select("user_id").in("user_id", users).in("status", ["pending_bio", "active"]),
  ]);
  if (cust.error) throw cust.error;
  if (recent.error) throw recent.error;
  if (open.error) throw open.error;
  const c = new Map(((cust.data ?? []) as any[]).map((r) => [r.user_id, r]));
  const last = new Map<string, string>();
  for (const r of (recent.data ?? []) as any[]) if (!last.has(r.user_id) || r.created_at > last.get(r.user_id)!) last.set(r.user_id, r.created_at);
  const held = new Set<string>([...((open.data ?? []) as any[]).map((r) => r.user_id), ...(creators.error ? [] : ((creators.data ?? []) as any[]).map((r) => r.user_id))]);
  for (const u of users) facts.set(u, { hasPlan: hasPlanAccess(c.get(u) as any), held: held.has(u), lastPostAt: last.get(u) ?? null });
  return facts;
}

export async function socialUpkeep(sb: SupabaseClient, deps: SocialDeps & { provider?: SocialProvider | null; now?: number } = {}): Promise<UpkeepResult> {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s)), now = deps.now ?? Date.now();
  const s = upkeepSettings(env);
  const p = deps.provider !== undefined ? deps.provider : getSocialProvider({ ...deps, env });
  const out: UpkeepResult = { profiles: 0, cleared: [], would_clear: [], kept: 0, mode: s.mode };
  if (!p || s.mode === "off") return out;
  let r = await sb.from("studio_social_profiles").select("user_id,provider,profile_key,accounts,created_at,last_active_at,perf_viewed_at").limit(5000);
  if (r.error && /last_active_at/.test(String(r.error.message ?? ""))) r = await sb.from("studio_social_profiles").select("user_id,provider,profile_key,accounts,created_at,perf_viewed_at").limit(5000) as any;
  if (r.error) throw r.error;
  const all = (r.data ?? []) as Array<ProfileFacts & { profile_key: string; provider?: string }>;
  // profiles made with the previous provider: removed there (when its key is still set) and here; the person links again
  const foreign = all.filter((x) => x.provider && x.provider !== p.name);
  for (const row of foreign) {
    if (s.mode === "dry") { out.would_clear.push({ user_id: row.user_id, reason: "provider_moved" }); continue; }
    if (await clearProfile(sb, providerNamed(row.provider!, { env, fetch: deps.fetch, log }), row, "provider_moved", log, { from: row.provider, to: p.name })) out.cleared.push({ user_id: row.user_id, reason: "provider_moved" });
  }
  const rows = all.filter((x) => !x.provider || x.provider === p.name);
  out.profiles = all.length;
  const facts = await upkeepFacts(sb, rows.map((x) => x.user_id), s.idleDays, now);
  for (const row of rows) {
    const f = facts.get(row.user_id)!;
    let linked = (row.accounts ?? []).length;
    // the cached list can lag (a missed webhook, the page never reopened): ask the service before calling it empty
    if (!linked && f.hasPlan && !f.held) {
      try {
        const live = await p.accounts(row.profile_key);
        linked = live.length;
        if (linked) { await sb.from("studio_social_profiles").update({ accounts: live, updated_at: new Date(now).toISOString() }).eq("user_id", row.user_id); row.accounts = live; }
      } catch (e: any) { log(`[social] upkeep could not read ${row.user_id}'s accounts: ${String(e?.message ?? e).slice(0, 120)}`); out.kept++; continue; }
    }
    const reason = clearReason(row, { ...f, linked }, s, now);
    if (!reason) { out.kept++; continue; }
    if (s.mode === "dry") { out.would_clear.push({ user_id: row.user_id, reason }); log(`[social] upkeep (dry) would clear ${row.user_id} (${reason})`); continue; }
    if (await clearProfile(sb, p, row, reason, log, { idle_days: Math.round((now - lastUse(row, f.lastPostAt)) / 86400_000) })) out.cleared.push({ user_id: row.user_id, reason });
    else out.kept++;
  }
  const after = out.profiles - out.cleared.length;
  if (p.name === "ayrshare") {
    const bill = ayrshareBill(after, { plan: s.plan, interval: s.interval });
    log(`[social] upkeep ${JSON.stringify({ mode: s.mode, profiles: out.profiles, cleared: out.cleared.length, would_clear: out.would_clear.length, now: after, bill_usd_month: bill.usd_month, plan: bill.plan })}`);
    if (bill.plan === "launch" && after >= AYRSHARE_PRICES.launch.max_profiles - 1) log(`[social] ALERT ${after} of ${AYRSHARE_PRICES.launch.max_profiles} posting profiles in use; the next ones need the posting service's Business plan (+$300 a month)`);
  } else {
    const linked = rows.filter((x) => !out.cleared.some((c) => c.user_id === x.user_id)).reduce((a, x) => a + (x.accounts ?? []).length, 0);
    log(`[social] upkeep ${JSON.stringify({ provider: p.name, mode: s.mode, profiles: out.profiles, cleared: out.cleared.length, would_clear: out.would_clear.length, now: after, linked_accounts: linked, bill_usd_month: zernioBill(linked).usd_month })}`);
  }
  return out;
}

const dayStart = (ms: number) => new Date(Math.floor(ms / 86400_000) * 86400_000);
const daysInMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
/** One cost row per profile with its share of today's bill (basis "list": the published price, not the invoice). Once a
 *  UTC day; skipped before billing began. Returns the rows written. */
export async function recordSocialCosts(sb: SupabaseClient, deps: { env?: Env; now?: number; log?: (s: string) => void } = {}): Promise<number> {
  const env = deps.env ?? process.env, now = deps.now ?? Date.now(), log = deps.log ?? ((s: string) => console.log(s));
  if (env.SOCIAL_PROVIDER === "zernio") return recordZernioCosts(sb, { env, now, log });
  if (now < Date.parse(`${AYRSHARE_BILLING_FROM}T00:00:00Z`)) return 0;
  const day = dayStart(now);
  const done = await sb.from("studio_costs").select("provider", { count: "exact", head: true }).eq("provider", "ayrshare").gte("spent_at", day.toISOString());
  if (done.error) { log(`[social] cost check failed: ${done.error.message}`); return 0; }
  if ((done.count ?? 0) > 0) return 0;
  const r = await sb.from("studio_social_profiles").select("user_id").limit(5000);
  if (r.error) throw r.error;
  const users = ((r.data ?? []) as any[]).map((x) => x.user_id as string);
  const s = upkeepSettings(env), bill = ayrshareBill(users.length, { plan: s.plan, interval: s.interval });
  const today = bill.usd_month / daysInMonth(day);
  const note = `${users.length} profile(s): $${bill.usd_month}/month on ${bill.plan} (${bill.interval}); the service bills the month's highest daily count`;
  const base = { spent_at: day.toISOString(), provider: "ayrshare", product: `posting profile (${bill.plan})`, source: "social posting: daily share of the monthly bill", basis: "list" as const, note, tool: "social" };
  if (!users.length) { recordCost({ ...base, units: { profiles: 0, days: 1 }, usd: today, ref: `ayrshare:${day.toISOString().slice(0, 10)}` }); return 1; }
  for (const u of users) recordCost({ ...base, user_id: u, units: { profiles: users.length, days: 1 }, usd: today / users.length, ref: `ayrshare:${day.toISOString().slice(0, 10)}` });
  log(`[social] cost ${JSON.stringify({ day: day.toISOString().slice(0, 10), profiles: users.length, usd_today: Math.round(today * 100) / 100, plan: bill.plan })}`);
  return users.length;
}

/** Zernio's bill for today, one row per person who has linked accounts, by their share of the accounts (each account
 *  is what Zernio bills). Basis "list": the published rate; once a day. */
export async function recordZernioCosts(sb: SupabaseClient, deps: { env?: Env; now?: number; log?: (s: string) => void } = {}): Promise<number> {
  const now = deps.now ?? Date.now(), log = deps.log ?? ((s: string) => console.log(s));
  const day = dayStart(now);
  const done = await sb.from("studio_costs").select("provider", { count: "exact", head: true }).eq("provider", "zernio").gte("spent_at", day.toISOString());
  if (done.error) { log(`[social] cost check failed: ${done.error.message}`); return 0; }
  if ((done.count ?? 0) > 0) return 0;
  const r = await sb.from("studio_social_profiles").select("user_id,provider,accounts").eq("provider", "zernio").limit(5000);
  if (r.error) throw r.error;
  const rows = ((r.data ?? []) as any[]).map((x) => ({ user_id: x.user_id as string, n: Array.isArray(x.accounts) ? x.accounts.length : 0 })).filter((x) => x.n > 0);
  const total = rows.reduce((a, x) => a + x.n, 0), bill = zernioBill(total);
  if (!total || !bill.usd_month) return 0;
  const today = bill.usd_month / daysInMonth(day);
  const note = `${total} linked account(s): $${bill.usd_month}/month at Zernio's graduated rate (2 free, $6 to 10, $3 to 100, $1 after), prorated daily`;
  for (const x of rows) recordCost({ spent_at: day.toISOString(), provider: "zernio", product: "linked social account", source: "social posting: daily share of the monthly bill", user_id: x.user_id, tool: "social", units: { accounts: x.n, accounts_total: total, days: 1 }, usd: (today * x.n) / total, basis: "list", note, ref: `zernio:${day.toISOString().slice(0, 10)}` });
  log(`[social] cost ${JSON.stringify({ provider: "zernio", day: day.toISOString().slice(0, 10), accounts: total, people: rows.length, usd_today: Math.round(today * 100) / 100 })}`);
  return rows.length;
}
