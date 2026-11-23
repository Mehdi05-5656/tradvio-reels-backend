// The YouTube proxy (IPRoyal residential), squared with IPRoyal's own count once a day (owner, Nov 22 2026: "every
// cost to the cent"). Each Clips run books what it downloaded (the file's size, studio-clips.ts, event youtube_proxy);
// IPRoyal bills every byte through the proxy: retries, YouTube's pages, tries that failed. On Nov 17-22 2026 IPRoyal's
// chart ran about 10-15 % above what the runs booked. This loop reads IPRoyal's data-usage report for one Pacific day
// and books the difference as one cost row (provider youtube_proxy, product iproyal_reconcile), so the cost ledger
// matches the bill. The runs' own rows are left as they are (per-run margins in clips-watch stay per run).
//
// Off unless IPROYAL_API_TOKEN is set (IPRoyal dashboard: Settings, API). IPROYAL_USER_HASH is optional: without it the
// hash is read from IPRoyal's /me. Read-only: it only GETs from IPRoyal. Dollars use STUDIO_YT_PROXY_USD_PER_GB, the
// rate the prices use, so set that to what the auto top-up really charges per GB.
// Docs: https://docs.iproyal.com/proxies/residential/api/reports and .../api/user
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanCost } from "./studio-costs.js";
import { recordEvent } from "./studio-events.js";
import { ownerAlert } from "./vendor-alerts.js";
import { proxyUsdPerGb } from "./studio-clips.js";
import type { MailDeps } from "./studio-mail.js";

type Env = Record<string, string | undefined>;
const API = "https://resi-api.iproyal.com/v1";
const TZ = "America/Los_Angeles";
const HOUR = 3600_000;
/** IPRoyal says its numbers can take up to 24 hours to settle: a day is squared two days later. */
export const SETTLE_DAYS = 2;
/** The owner is told when IPRoyal counts this much more than the runs booked (and at least ALERT_MIN_MB more):
 *  something other than Clips is using the proxy (staging, a leaked address) or the booking broke. */
export const ALERT_RATIO = 1.5, ALERT_MIN_MB = 500;

/** IPRoyal's report (CSV: date,hostname,port,data,measurement unit,requests count; a last ",,total:,N,,M" row) as
 *  megabytes and requests. The total row is used when present, otherwise the rows are added up. */
export function parseUsageCsv(csv: string): { mb: number; requests: number; rows: number } {
  const lines = String(csv ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !/^date,/i.test(lines[0])) throw new Error("not an IPRoyal usage report");
  const toMb = (v: number, unit: string) => { const u = unit.trim().toUpperCase(); return u === "GB" ? v * 1000 : u === "KB" ? v / 1000 : u === "B" ? v / 1e6 : v; };
  let mb = 0, requests = 0, rows = 0, total: { mb: number; requests: number } | null = null, unit = "MB";
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c[2] === "total:") { total = { mb: toMb(Number(c[3]) || 0, c[4] || unit), requests: Number(c[5]) || 0 }; continue; }
    if (c.length < 6) continue;
    unit = c[4] || unit; mb += toMb(Number(c[3]) || 0, unit); requests += Number(c[5]) || 0; rows++;
  }
  return total ? { mb: r3(total.mb), requests: total.requests, rows } : { mb: r3(mb), requests, rows };
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A Pacific day as [start, end) instants (daylight saving handled: midnight there, whatever the offset). */
export function ptDayBounds(day: string): { from: string; to: string } {
  const at = (d: string) => { const guess = Date.parse(`${d}T08:00:00Z`); // midnight PST; PDT is an hour earlier
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(guess)));
    return new Date(guess - h * HOUR).toISOString(); };
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
  return { from: at(day), to: at(next) };
}
/** The Pacific date `days` before `now`. */
export function ptDay(now: number, days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now - days * 24 * HOUR));
}
const ptHour = (now: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));

/** What IPRoyal counted beyond what the runs booked, in MB and dollars (never negative: a day IPRoyal counts less is
 *  booked at $0 with both numbers kept, so the row still says what happened). */
export function reconcileGap(o: { reportedMb: number; bookedMb: number; usdPerGb: number }) {
  const gap = Math.max(0, o.reportedMb - o.bookedMb);
  return { gap_mb: r3(gap), usd: Math.round((gap / 1000) * o.usdPerGb * 1e6) / 1e6, ratio: o.bookedMb > 0 ? Math.round((o.reportedMb / o.bookedMb) * 1000) / 1000 : null };
}

type Deps = MailDeps & { fetch?: typeof fetch; now?: () => number };
async function iproyal(path: string, env: Env, f: typeof fetch): Promise<Response> {
  const r = await f(`${API}${path}`, { headers: { Authorization: `Bearer ${env.IPROYAL_API_TOKEN}`, Accept: "*/*" } });
  if (!r.ok) throw new Error(`IPRoyal ${path.split("?")[0]} answered ${r.status}`);
  return r;
}
/** The residential user's hash: IPROYAL_USER_HASH, or IPRoyal's /me (the docs show it at /me; /residential/me tried too). */
export async function userHash(env: Env, f: typeof fetch): Promise<string> {
  if (env.IPROYAL_USER_HASH) return env.IPROYAL_USER_HASH;
  let last: unknown = null;
  for (const p of ["/me", "/residential/me"]) {
    try { const j: any = await (await iproyal(p, env, f)).json(); if (j?.residential_user_hash) return String(j.residential_user_hash); } catch (e) { last = e; }
  }
  throw new Error(`IPRoyal did not give the user hash (${String((last as any)?.message ?? "no hash in /me")})`);
}
/** IPRoyal's count for one Pacific day. */
export async function reportedUsage(day: string, env: Env, f: typeof fetch) {
  const hash = await userHash(env, f);
  const q = new URLSearchParams({ hash, date_from: day, date_to: day, measurement_unit: "MB", rounding_decimal: "3", time_zone: TZ });
  return parseUsageCsv(await (await iproyal(`/residential/data-usage-report?${q}`, env, f)).text());
}
/** What the runs booked through the proxy on one Pacific day (studio_events youtube_proxy). */
export async function bookedUsage(sb: SupabaseClient, day: string): Promise<{ mb: number; usd: number; rows: number }> {
  const { from, to } = ptDayBounds(day);
  const r = await sb.from("studio_events").select("usd,props").eq("kind", "vendor").eq("name", "youtube_proxy").gte("created_at", from).lt("created_at", to).limit(20000);
  if (r.error) throw r.error;
  let bytes = 0, usd = 0;
  for (const e of r.data ?? []) { bytes += Number((e as any).props?.bytes) || 0; usd += Number((e as any).usd) || 0; }
  return { mb: r3(bytes / 1e6), usd: Math.round(usd * 1e6) / 1e6, rows: (r.data ?? []).length };
}

/** Square one Pacific day: one cost row (ref iproyal:<day>, written once) and one event with both counts. */
export async function reconcileDay(sb: SupabaseClient, day: string, deps: Deps = {}): Promise<{ day: string; skipped?: string; reported_mb?: number; booked_mb?: number; gap_mb?: number; usd?: number; ratio?: number | null }> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, log = deps.log ?? ((l: string) => console.log(l));
  if (!env.IPROYAL_API_TOKEN) return { day, skipped: "no IPROYAL_API_TOKEN" };
  const ref = `iproyal:${day}`;
  const had = await sb.from("studio_costs").select("id").eq("ref", ref).limit(1);
  if (had.error) throw had.error;
  if ((had.data ?? []).length) return { day, skipped: "already squared" };
  const [rep, booked] = await Promise.all([reportedUsage(day, env, f), bookedUsage(sb, day)]);
  const usdPerGb = proxyUsdPerGb({ ...env, STUDIO_YT_PROXY: env.STUDIO_YT_PROXY ?? "set" });
  const g = reconcileGap({ reportedMb: rep.mb, bookedMb: booked.mb, usdPerGb });
  const { from } = ptDayBounds(day);
  const row = cleanCost({ spent_at: new Date(Date.parse(from) + 12 * HOUR).toISOString(), provider: "youtube_proxy", product: "iproyal_reconcile", source: "daily_reconcile",
    units: { reported_mb: rep.mb, booked_mb: booked.mb, gap_mb: g.gap_mb, requests: rep.requests, usd_per_gb: usdPerGb }, usd: g.usd, basis: "metered", ref, writer: "proxy-reconcile",
    note: `IPRoyal counted ${rep.mb} MB on ${day} (PT); the runs booked ${booked.mb} MB. The difference (retries, YouTube's pages, failed tries, anything else on the proxy) at $${usdPerGb}/GB.` });
  const ins = await sb.from("studio_costs").insert(row);
  if (ins.error) throw ins.error;
  recordEvent({ kind: "feature", name: "proxy_reconcile", props: { day, reported_mb: rep.mb, booked_mb: booked.mb, gap_mb: g.gap_mb, usd: g.usd, ratio: g.ratio, requests: rep.requests } });
  log(`[proxy-reconcile] ${JSON.stringify({ day, reported_mb: rep.mb, booked_mb: booked.mb, gap_mb: g.gap_mb, usd: g.usd, ratio: g.ratio })}`);
  if (g.gap_mb >= ALERT_MIN_MB && (g.ratio == null || g.ratio >= ALERT_RATIO)) {
    await ownerAlert(`proxy_reconcile_${day}`, `YouTube proxy: IPRoyal counted ${Math.round(rep.mb)} MB on ${day}, the Clips runs booked ${Math.round(booked.mb)} MB`,
      `IPRoyal's data-usage report for ${day} (Pacific) is ${Math.round(g.gap_mb)} MB (about $${g.usd.toFixed(2)}) above what the Clips runs recorded.\n\n`
      + `Usual gap: about 10-15 %. A bigger one means something else is using the proxy (the staging service, a test script, a leaked address) or a run stopped booking its downloads.\n`
      + `Check IPRoyal's report by hostname, and STUDIO_YT_PROXY on the Render services.`, 24 * HOUR, { ...deps, env, log });
  }
  return { day, reported_mb: rep.mb, booked_mb: booked.mb, gap_mb: g.gap_mb, usd: g.usd, ratio: g.ratio };
}

/** Once a day after 08:00 PT: square the day SETTLE_DAYS back. Checked every hour; written once (ref) across restarts. */
export function startProxyReconcile(sbFn: () => SupabaseClient, deps: Deps & { everyMs?: number } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = deps.now ?? Date.now;
  if (!env.IPROYAL_API_TOKEN) return null;
  let done = "";
  const tick = async () => {
    const t = now();
    if (ptHour(t) < 8) return;
    const day = ptDay(t, SETTLE_DAYS);
    if (done === day) return;
    await reconcileDay(sbFn(), day, { ...deps, env, log });
    done = day;
  };
  const run = () => { void tick().catch((e) => log(`[proxy-reconcile] ${String(e?.message ?? e).slice(0, 200)}`)); };
  const timer = setInterval(run, deps.everyMs ?? HOUR);
  timer.unref?.();
  setTimeout(run, 60_000).unref?.();
  return timer;
}
