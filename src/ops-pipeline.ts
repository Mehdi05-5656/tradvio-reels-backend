// Operator pipeline view: one read-only snapshot of every stage and every background job.
// Sources → Rendered → Queued → Scheduled → Published → Measured, plus job heartbeats.
// Admin-only through the global /api gate (customers only reach the allowlist in account-access.ts).
import type { Express, Request, Response } from "express";
import { isAdmin } from "./auth.js";
import { ptNow, ptDateTimeToUtc } from "./publer-schedule.js";

export type Health = "ok" | "warn" | "down" | "off";
export type JobCard = { id: string; label: string; cadence: string; health: Health; last_at: string | null; note: string; details?: Record<string, number | string | null> };
export type Stage = { id: string; label: string; count: number; detail: Record<string, number>; note?: string };
export type PipelineSnapshot = { generated_at: string; day: string; stages: Stage[]; jobs: JobCard[]; accounts: { total: number; enabled: number; paused: number } };

export type RawCounts = {
  sources: number;
  variants: Record<string, number>;           // state -> count
  queue: Record<string, number>;              // `${status}|${bucket}` -> count
  logs_today: Record<string, number>;         // outcome per posting window today: published | failed | pending (a retried window counts once)
  stale_pending: number;                      // pending windows older than 24 h that were never resolved (data debris, not in-flight)
  logs_7d_published: number;
  logs_total_published: number;
  held_pending: number;                       // pending submissions between 45 min and 24 h old: outcome unknown, never resend
  last_attempt_at: string | null;
  analytics_latest: string | null;
  analytics_snapshots_24h: number;
  analytics_pulls_24h: number;
  measured_7d: number;                        // distinct posts with a snapshot in 7d
  live_latest: string | null;
  live_accounts: { ok: number; failed: number; never: number };
  features_latest: string | null;
  features_rows: number;
  captions_latest: string | null;
  library_control: { enabled: boolean; max_active: number; max_daily_claims: number } | null;
  upload: { phase: string; updated_at: string | null; expires_at: string | null } | null;
  rate: { blocked_until: string | null; last_block_reason: string | null } | null;
  slots: { total: number; enabled: number; paused: number };
};

const hoursAgo = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 3600_000 : Infinity);
const ago = (iso: string | null, now: Date) => {
  if (!iso) return "never";
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export function summarizePipeline(c: RawCounts, now = new Date()): PipelineSnapshot {
  const sum = (o: Record<string, number>, pred: (k: string) => boolean) => Object.entries(o).filter(([k]) => pred(k)).reduce((n, [, v]) => n + v, 0);
  const rendered = c.variants["rendered_private"] ?? 0, running = c.variants["running"] ?? 0, pendingRender = c.variants["pending"] ?? 0, blocked = sum(c.variants, (k) => /blocked|failed|error/.test(k));
  const queued = sum(c.queue, (k) => k.startsWith("pending|")), publishing = sum(c.queue, (k) => k.startsWith("publer_publishing|")), posted = sum(c.queue, (k) => k.startsWith("posted|"));
  const queueTotal = Object.values(c.queue).reduce((n, v) => n + v, 0), featureBacklog = Math.max(0, queueTotal - c.features_rows);
  const publishedToday = c.logs_today["published"] ?? 0, failedToday = c.logs_today["failed"] ?? 0, pendingToday = c.logs_today["pending"] ?? 0;
  const stages: Stage[] = [
    { id: "sources", label: "Sources", count: c.sources, detail: { originals: c.sources } },
    { id: "rendered", label: "Rendered", count: rendered, detail: { rendered, running, pending: pendingRender, blocked }, note: blocked ? `${blocked} blocked` : running ? `${running} rendering now` : undefined },
    { id: "queued", label: "Queued", count: queued, detail: { pending: queued, in_flight: publishing, posted_total: posted } },
    { id: "today", label: "Published today", count: publishedToday, detail: { published: publishedToday, failed: failedToday, awaiting_receipt: pendingToday, held: c.held_pending }, note: c.held_pending ? `${c.held_pending} held, do not resend` : failedToday ? `${failedToday} failed windows` : undefined },
    { id: "published", label: "Published, 7 days", count: c.logs_7d_published, detail: { last_7_days: c.logs_7d_published, all_time: c.logs_total_published } },
    { id: "measured", label: "Measured, 7 days", count: c.measured_7d, detail: { posts_with_readings: c.measured_7d, snapshots_24h: c.analytics_snapshots_24h } },
  ];
  const health = (h: number, warn: number, down: number): Health => (h <= warn ? "ok" : h <= down ? "warn" : "down");
  const jobs: JobCard[] = [
    { id: "publisher", label: "Publisher", cadence: "every 5 min, posts in 2-hour windows 8 AM–10 PM PT", last_at: c.last_attempt_at,
      health: c.held_pending > 0 ? "warn" : health(hoursAgo(c.last_attempt_at, now), 3, 6), note: c.held_pending ? `${c.held_pending} submissions held with an unknown outcome` : c.stale_pending ? `last attempt ${ago(c.last_attempt_at, now)}; ${c.stale_pending} old pending windows never resolved` : `last attempt ${ago(c.last_attempt_at, now)}`,
      details: { published_today: publishedToday, failed_today: failedToday } },
    { id: "analytics", label: "Platform insights", cadence: "every 15 min, each account at most every 3 h, paused in posting windows", last_at: c.analytics_latest,
      health: health(hoursAgo(c.analytics_latest, now), 4, 8), note: `latest reading ${ago(c.analytics_latest, now)}`, details: { snapshots_24h: c.analytics_snapshots_24h, account_pulls_24h: c.analytics_pulls_24h } },
    { id: "live", label: "Public metrics (hourly)", cadence: "hourly per account via ScrapeCreators", last_at: c.live_latest,
      health: c.live_accounts.ok === 0 && c.live_latest === null ? "off" : c.live_accounts.failed > 0 ? "warn" : health(hoursAgo(c.live_latest, now), 2, 6),
      note: c.live_latest === null ? "never collected: the analytics cron has no ScrapeCreators key" : `latest ${ago(c.live_latest, now)}; ${c.live_accounts.ok} accounts ok, ${c.live_accounts.failed} failing`,
      details: { accounts_ok: c.live_accounts.ok, accounts_failed: c.live_accounts.failed, accounts_never: c.live_accounts.never } },
    { id: "features", label: "Video features (Gemini + Whisper)", cadence: "hourly, up to 60 videos", last_at: c.features_latest,
      health: featureBacklog === 0 ? "ok" : health(hoursAgo(c.features_latest, now), 3, 24),
      note: featureBacklog === 0 ? `idle, all ${c.features_rows} videos processed; last write ${ago(c.features_latest, now)}` : `${featureBacklog} videos waiting; last write ${ago(c.features_latest, now)}`, details: { rows: c.features_rows, backlog: featureBacklog } },
    { id: "captions", label: "Caption suggestions (nightly)", cadence: "10:50 UTC daily", last_at: c.captions_latest,
      health: health(hoursAgo(c.captions_latest, now), 30, 72), note: hoursAgo(c.captions_latest, now) > 72 ? `no new suggestions since ${c.captions_latest?.slice(0, 10) ?? "never"}` : `latest ${ago(c.captions_latest, now)}` },
    { id: "render", label: "Library renderer", cadence: "one-off cloud jobs", last_at: null,
      health: !c.library_control ? "off" : !c.library_control.enabled ? "off" : blocked ? "warn" : "ok",
      note: !c.library_control ? "not configured" : !c.library_control.enabled ? "disabled" : `${running} running, ${pendingRender} pending, ${rendered} done`,
      details: { max_active: c.library_control?.max_active ?? 0, max_daily_claims: c.library_control?.max_daily_claims ?? 0 } },
    { id: "upload", label: "Upload coordinator", cadence: "shared lock for the workspace", last_at: c.upload?.updated_at ?? null,
      health: !c.upload ? "off" : c.upload.phase === "idle" ? "ok" : c.upload.expires_at && Date.parse(c.upload.expires_at) < now.getTime() ? "down" : "warn",
      note: !c.upload ? "no coordinator row" : c.upload.phase === "idle" ? "idle" : `${c.upload.phase} since ${ago(c.upload.updated_at, now)}${c.upload.phase === "held" ? "; publishing is frozen until released" : ""}` },
    { id: "rate", label: "Request budget", cadence: "shared across processes", last_at: null,
      health: c.rate?.blocked_until && Date.parse(c.rate.blocked_until) > now.getTime() ? "warn" : "ok",
      note: c.rate?.blocked_until && Date.parse(c.rate.blocked_until) > now.getTime() ? `blocked until ${c.rate.blocked_until} (${c.rate.last_block_reason ?? "no reason"})` : "not blocked" },
  ];
  return { generated_at: now.toISOString(), day: ptNow(now).ymd, stages, jobs, accounts: c.slots };
}

async function count(q: any): Promise<number> { const r = await q; if (r.error) throw r.error; return r.count ?? 0; }
async function groupCount(sb: any, table: string, cols: string[], filter?: (q: any) => any): Promise<Record<string, number>> {
  // Group in memory from a narrow projection; these tables are small enough (tens of thousands of rows at most).
  const out: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols.join(","));
    if (filter) q = filter(q);
    const r = await q.range(from, from + 999);
    if (r.error) throw r.error;
    for (const row of r.data ?? []) { const k = cols.map((c) => row[c] ?? "?").join("|"); out[k] = (out[k] ?? 0) + 1; }
    if ((r.data ?? []).length < 1000) break;
  }
  return out;
}
/** Today's posting windows by outcome. A window that failed and was then published counts as published, not as a failure. */
export function summarizeWindows(rows: { phone_slot: string; slot_index: number | null; status: string; slot_local_date?: string }[]): Record<string, number> {
  const rank: Record<string, number> = { published: 3, pending: 2, failed: 1 };
  const best = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.phone_slot}|${r.slot_local_date ?? ""}|${r.slot_index ?? "?"}`;
    const cur = best.get(k);
    if (!cur || (rank[r.status] ?? 0) > (rank[cur] ?? 0)) best.set(k, r.status);
  }
  const out: Record<string, number> = {};
  for (const s of best.values()) out[s] = (out[s] ?? 0) + 1;
  return out;
}
async function windowOutcomes(sb: any, dayStart: string): Promise<Record<string, number>> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("publer_publish_log").select("phone_slot,slot_index,status,slot_local_date").gte("attempted_at", dayStart).range(from, from + 999);
    if (r.error) throw r.error;
    rows.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  return summarizeWindows(rows);
}
const latest = async (sb: any, table: string, col: string, filter?: (q: any) => any): Promise<string | null> => {
  let q = sb.from(table).select(col).order(col, { ascending: false }).limit(1);
  if (filter) q = filter(q);
  const r = await q; if (r.error) throw r.error; return r.data?.[0]?.[col] ?? null;
};

export async function collectPipeline(sb: any, now = new Date()): Promise<RawCounts> {
  const day = ptNow(now).ymd, dayStart = ptDateTimeToUtc(day, "00:00").toISOString();
  const h24 = new Date(now.getTime() - 24 * 3600_000).toISOString(), d7 = new Date(now.getTime() - 7 * 86400_000).toISOString(), held = new Date(now.getTime() - 45 * 60_000).toISOString();
  const [sources, variants, queue, logsToday, logs7d, logsTotal, heldPending, stalePending, lastAttempt, analyticsLatest, snaps24h, pulls24h, liveLatest, liveAccounts, featuresLatest, featuresRows, captionsLatest, control, upload, rate, slots] = await Promise.all([
    count(sb.from("library_sources").select("sha256", { count: "exact", head: true })),
    groupCount(sb, "library_variants", ["state"]),
    groupCount(sb, "reels_manual_queue", ["status", "storage_bucket"]),
    windowOutcomes(sb, dayStart),
    count(sb.from("publer_publish_log").select("id", { count: "exact", head: true }).eq("status", "published").gte("attempted_at", d7)),
    count(sb.from("publer_publish_log").select("id", { count: "exact", head: true }).eq("status", "published")),
    count(sb.from("publer_publish_log").select("id", { count: "exact", head: true }).eq("status", "pending").lt("attempted_at", held).gte("attempted_at", h24)),
    count(sb.from("publer_publish_log").select("id", { count: "exact", head: true }).eq("status", "pending").lt("attempted_at", h24)),
    latest(sb, "publer_publish_log", "attempted_at"),
    latest(sb, "publer_analytics", "captured_at"),
    count(sb.from("publer_analytics").select("id", { count: "exact", head: true }).gte("captured_at", h24)),
    count(sb.from("publer_analytics_pulls").select("phone_slot", { count: "exact", head: true }).gte("pulled_at", h24)),
    latest(sb, "live_post_metrics", "captured_at"),
    (async () => { const r = await sb.from("live_metric_accounts").select("last_status,last_pulled_at"); if (r.error) throw r.error; const rows = r.data ?? []; return { ok: rows.filter((x: any) => String(x.last_status ?? "").startsWith("ok")).length, failed: rows.filter((x: any) => x.last_pulled_at && !String(x.last_status ?? "").startsWith("ok")).length, never: rows.filter((x: any) => !x.last_pulled_at).length }; })(),
    latest(sb, "video_content_features", "computed_at"),
    count(sb.from("video_content_features").select("id", { count: "exact", head: true })),
    latest(sb, "queue_suggestions", "created_at"),
    (async () => { const r = await sb.from("library_control").select("enabled,max_active,max_daily_claims").limit(1); if (r.error) throw r.error; return r.data?.[0] ?? null; })(),
    (async () => { const r = await sb.from("publer_workspace_upload").select("phase,updated_at,expires_at").limit(1); if (r.error) throw r.error; return r.data?.[0] ?? null; })(),
    (async () => { const r = await sb.from("publer_rate_state").select("blocked_until,last_block_reason").limit(1); if (r.error) throw r.error; return r.data?.[0] ?? null; })(),
    (async () => { const r = await sb.from("publer_slot_config").select("paused"); if (r.error) throw r.error; const rows = r.data ?? []; return { total: rows.length, enabled: rows.filter((x: any) => !x.paused).length, paused: rows.filter((x: any) => x.paused).length }; })(),
  ]);
  // Measured in 7 days: distinct posts with any snapshot. Counted from a narrow projection.
  const measured = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("publer_analytics").select("publer_post_id").gte("captured_at", d7).range(from, from + 999);
    if (r.error) throw r.error;
    for (const row of r.data ?? []) measured.add(row.publer_post_id);
    if ((r.data ?? []).length < 1000) break;
  }
  return { sources, variants, queue, logs_today: logsToday, logs_7d_published: logs7d, logs_total_published: logsTotal, held_pending: heldPending, stale_pending: stalePending, last_attempt_at: lastAttempt,
    analytics_latest: analyticsLatest, analytics_snapshots_24h: snaps24h, analytics_pulls_24h: pulls24h, measured_7d: measured.size, live_latest: liveLatest, live_accounts: liveAccounts,
    features_latest: featuresLatest, features_rows: featuresRows, captions_latest: captionsLatest, library_control: control, upload, rate, slots };
}

export function registerOpsPipeline(app: Express, sbFn: () => any) {
  app.get("/api/ops/pipeline", async (req: Request, res: Response) => {
    if (!req.auth) return res.status(401).json({ error: "unauthorized" });
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try {
      const snapshot = summarizePipeline(await collectPipeline(sbFn()));
      res.set("Cache-Control", "private, no-store").json(snapshot);
    } catch (e: any) {
      console.error("[ops/pipeline]", e?.message ?? e);
      res.status(503).json({ error: "pipeline_unavailable" });
    }
  });
}
