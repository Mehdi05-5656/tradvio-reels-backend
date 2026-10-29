// Studio health, for the operator: one read of the job and webhook tables, turned into Pipeline-page cards and alerts.
// The same counts feed both, so a card that says "needs attention" and an alert that fires agree.
import type { JobCard, Health } from "./ops-pipeline.js";

export type ToolHealth = { queued: number; running: number; stale_running: number; oldest_queued_at: string | null; latest_finished_at: string | null; done_24h: number; failed_24h: number; total: number };
export type StudioHealthCounts = {
  tools: Record<string, ToolHealth>;
  webhook: { total: number; latest_received_at: string | null; unprocessed_old: number; errors_24h: number };
};

export const STUDIO_TOOLS: Record<string, { label: string; cadence: string; queue_warn_min: number; queue_down_min: number }> = {
  blueprint: { label: "Studio: Blueprint worker", cadence: "Render background worker, polls every 5 s", queue_warn_min: 10, queue_down_min: 30 },
  recast: { label: "Studio: Recast runner", cadence: "in the web service, every 15 s, up to 3 at once, 15–25 min a render", queue_warn_min: 10, queue_down_min: 30 },
};
export const WEBHOOK_LAG_MIN = 10;

const minutesAgo = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 60_000 : null);
const ago = (iso: string | null, now: Date) => {
  const m = minutesAgo(iso, now); if (m === null) return "never";
  const r = Math.round(m); return r < 1 ? "just now" : r < 60 ? `${r} min ago` : r < 48 * 60 ? `${Math.round(r / 60)} h ago` : `${Math.round(r / 1440)} days ago`;
};

/** Reads studio_jobs and studio_stripe_events. Null when the tables are missing or unreadable: the Studio is then simply not shown. */
export async function collectStudioHealth(sb: any, now = new Date()): Promise<StudioHealthCounts | null> {
  try {
    const h24 = new Date(now.getTime() - 24 * 3600_000).toISOString(), lag = new Date(now.getTime() - WEBHOOK_LAG_MIN * 60_000).toISOString();
    const [open, finished, total, evTotal, evLatest, evOld, evErr] = await Promise.all([
      sb.from("studio_jobs").select("tool,status,created_at,lease_until").in("status", ["queued", "running"]).limit(1000),
      sb.from("studio_jobs").select("tool,status,finished_at").in("status", ["done", "failed"]).gte("finished_at", h24).limit(5000),
      sb.from("studio_jobs").select("tool").limit(5000),
      sb.from("studio_stripe_events").select("id", { count: "exact", head: true }),
      sb.from("studio_stripe_events").select("received_at").order("received_at", { ascending: false }).limit(1),
      sb.from("studio_stripe_events").select("id", { count: "exact", head: true }).is("processed_at", null).lt("received_at", lag),
      sb.from("studio_stripe_events").select("id", { count: "exact", head: true }).not("error", "is", null).gte("received_at", h24),
    ]);
    for (const r of [open, finished, total, evTotal, evLatest, evOld, evErr]) if (r.error) return null;
    const tools: Record<string, ToolHealth> = {};
    const tool = (t: string) => (tools[t] ??= { queued: 0, running: 0, stale_running: 0, oldest_queued_at: null, latest_finished_at: null, done_24h: 0, failed_24h: 0, total: 0 });
    for (const t of Object.keys(STUDIO_TOOLS)) tool(t);
    for (const j of total.data ?? []) tool(j.tool).total++;
    for (const j of open.data ?? []) {
      const t = tool(j.tool);
      if (j.status === "queued") { t.queued++; if (!t.oldest_queued_at || j.created_at < t.oldest_queued_at) t.oldest_queued_at = j.created_at; }
      else { t.running++; if (j.lease_until && Date.parse(j.lease_until) < now.getTime()) t.stale_running++; }
    }
    for (const j of finished.data ?? []) {
      const t = tool(j.tool);
      if (j.status === "done") t.done_24h++; else t.failed_24h++;
      if (j.finished_at && (!t.latest_finished_at || j.finished_at > t.latest_finished_at)) t.latest_finished_at = j.finished_at;
    }
    return { tools, webhook: { total: Number(evTotal.count ?? 0), latest_received_at: evLatest.data?.[0]?.received_at ?? null, unprocessed_old: Number(evOld.count ?? 0), errors_24h: Number(evErr.count ?? 0) } };
  } catch { return null; }
}

/** The share of finished jobs that failed, when enough finished to mean something. */
export function failureRate(t: ToolHealth, minFinished = 3): number | null {
  const n = t.done_24h + t.failed_24h;
  return n >= minFinished ? t.failed_24h / n : null;
}

/** Pipeline-page cards: one per tool, one for the Stripe webhook. */
export function studioJobCards(c: StudioHealthCounts, now = new Date()): JobCard[] {
  const cards: JobCard[] = Object.entries(STUDIO_TOOLS).map(([id, meta]) => {
    const t = c.tools[id] ?? { queued: 0, running: 0, stale_running: 0, oldest_queued_at: null, latest_finished_at: null, done_24h: 0, failed_24h: 0, total: 0 };
    const waited = t.queued > 0 ? minutesAgo(t.oldest_queued_at, now) ?? 0 : 0;
    const rate = failureRate(t);
    const stalled = t.running === 0 && waited >= meta.queue_down_min, slow = waited >= meta.queue_warn_min;
    const health: Health = t.total === 0 ? "off" : stalled ? "down" : slow || t.stale_running > 0 || (rate !== null && rate >= 0.3) ? "warn" : "ok";
    const parts: string[] = [];
    if (t.total === 0) parts.push("no jobs yet");
    else if (t.queued === 0 && t.running === 0) parts.push(`idle; last finished ${ago(t.latest_finished_at, now)}`);
    else parts.push(`${t.running} running, ${t.queued} queued${t.queued ? ` (oldest waiting ${Math.round(waited)} min)` : ""}`);
    if (stalled) parts.push("nothing has picked the queue up: check the worker in Render");
    else if (slow) parts.push("the queue is moving slowly");
    if (t.stale_running > 0) parts.push(`${t.stale_running} lease${t.stale_running === 1 ? "" : "s"} expired, will be reclaimed`);
    if (rate !== null && rate >= 0.3) parts.push(`${Math.round(rate * 100)}% of the last day's jobs failed`);
    else if (t.done_24h + t.failed_24h > 0) parts.push(`${t.done_24h} done, ${t.failed_24h} failed in 24 h`);
    return { id: `studio_${id}`, label: meta.label, cadence: meta.cadence, health, last_at: t.latest_finished_at, note: parts.join("; "),
      details: { queued: t.queued, running: t.running, done_24h: t.done_24h, failed_24h: t.failed_24h } };
  });
  const w = c.webhook;
  cards.push({ id: "studio_stripe", label: "Studio: Stripe webhook", cadence: "on every billing event; retried by Stripe for 3 days", last_at: w.latest_received_at,
    health: w.total === 0 ? "off" : w.unprocessed_old > 0 || w.errors_24h > 0 ? "warn" : "ok",
    note: w.total === 0 ? "no events received yet" : `last event ${ago(w.latest_received_at, now)}${w.unprocessed_old ? `; ${w.unprocessed_old} event${w.unprocessed_old === 1 ? "" : "s"} unprocessed for over ${WEBHOOK_LAG_MIN} min` : ""}${w.errors_24h ? `; ${w.errors_24h} failed in 24 h (Stripe retries them)` : ""}`,
    details: { events: w.total, unprocessed: w.unprocessed_old, errors_24h: w.errors_24h } });
  return cards;
}

export type AlertDraft = { type: string; severity: "warning" | "critical"; phone_slot: null; title: string; body: string; payload: Record<string, any>; metric_value: number; threshold_value: number };
export type StudioAlertConfig = { queue_minutes: number; failure_rate: number; min_finished: number; webhook_lag_minutes: number };
export const STUDIO_ALERT_DEFAULTS: StudioAlertConfig = { queue_minutes: 30, failure_rate: 0.3, min_finished: 5, webhook_lag_minutes: WEBHOOK_LAG_MIN };

/** Alerts worth a person's attention. Dedupe (same type and tool within 6 h) is the caller's, against reels_alerts. */
export function studioAlerts(c: StudioHealthCounts, now = new Date(), cfg: Partial<StudioAlertConfig> = {}): AlertDraft[] {
  const k = { ...STUDIO_ALERT_DEFAULTS, ...cfg }, out: AlertDraft[] = [];
  for (const [id, t] of Object.entries(c.tools)) {
    const waited = t.queued > 0 ? minutesAgo(t.oldest_queued_at, now) ?? 0 : 0;
    if (t.queued > 0 && t.running === 0 && waited >= k.queue_minutes) out.push({ type: "studio_queue_stalled", severity: "critical", phone_slot: null,
      title: `Studio ${id}: ${t.queued} job${t.queued === 1 ? "" : "s"} waiting ${Math.round(waited)} min, nothing running`,
      body: "Paying customers are waiting and nothing is picking up the queue. Check the worker's service in Render.", payload: { tool: id, queued: t.queued, oldest_queued_at: t.oldest_queued_at }, metric_value: Math.round(waited), threshold_value: k.queue_minutes });
    const rate = failureRate(t, k.min_finished);
    if (rate !== null && rate >= k.failure_rate) out.push({ type: "studio_failure_rate", severity: "warning", phone_slot: null,
      title: `Studio ${id}: ${Math.round(rate * 100)}% of jobs failed in the last day`,
      body: `${t.failed_24h} of ${t.done_24h + t.failed_24h} finished jobs failed and were refunded. Look at the error codes on the Clients page.`, payload: { tool: id, failed_24h: t.failed_24h, done_24h: t.done_24h }, metric_value: rate, threshold_value: k.failure_rate });
  }
  const w = c.webhook;
  if (w.unprocessed_old > 0 || w.errors_24h > 0) out.push({ type: "studio_webhook_lag", severity: "warning", phone_slot: null,
    title: `Stripe webhook: ${w.unprocessed_old} unprocessed, ${w.errors_24h} failed`,
    body: "Payments may not have granted credits. Stripe retries failed deliveries; check the backend logs for the event ids.", payload: { unprocessed_old: w.unprocessed_old, errors_24h: w.errors_24h }, metric_value: w.unprocessed_old + w.errors_24h, threshold_value: 0 });
  return out;
}
