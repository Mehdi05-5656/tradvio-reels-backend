// Small pure helpers for aggregating publer_analytics snapshots without double counting.
// A post has many snapshots; totals must use one reading per post, the newest.

export type SnapshotRow = { publer_post_id: string; phone_slot?: string; captured_at: string; [k: string]: any };

/** Newest snapshot per (slot, post). Rows may arrive in any order. */
export function latestPerPost<T extends SnapshotRow>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.phone_slot ?? ""}|${r.publer_post_id}`;
    const cur = best.get(key);
    if (!cur || Date.parse(r.captured_at) > Date.parse(cur.captured_at)) best.set(key, r);
  }
  return [...best.values()];
}

/** Sum a numeric column over the newest snapshot per post; null/undefined/non-numeric values count as absent. */
export function sumLatest(rows: SnapshotRow[], key: string): number {
  return latestPerPost(rows).reduce((n, r) => {
    const v = Number(r[key]);
    return Number.isFinite(v) ? n + v : n;
  }, 0);
}

/** Alert thresholds: analytics are pulled every 3 h per account and paused inside 2-hour posting windows, so anything under 3 h is noise. */
export const MIN_ANALYTICS_STALE_MINUTES = 180;
export const effectiveStaleMinutes = (configured: unknown) => Math.max(MIN_ANALYTICS_STALE_MINUTES, Number(configured) || 0);

/** Interaction count: likes + comments + shares + saves. Publer leaves the `engagement` column empty on every row. */
export function interactions(r: Record<string, any>): number {
  return ["likes", "comments", "shares", "saves"].reduce((n, k) => {
    const v = Number(r[k]);
    return Number.isFinite(v) ? n + v : n;
  }, 0);
}

/** Publer's engagement_rate as stored: interactions as a percentage of reach, two decimals; 0 without reach. */
export function engagementRatePct(r: Record<string, any>): number {
  const reach = Number(r.reach);
  if (!Number.isFinite(reach) || reach <= 0) return 0;
  return Math.round((100 * interactions(r)) / reach * 100) / 100;
}

/**
 * dashboard_report_snapshots returns, per post, a pre-window baseline plus the first and last capture of
 * each Pacific day inside the window. Keep the newest in-window capture per (slot, post).
 */
export function latestInWindow<T extends SnapshotRow>(rows: T[], startISO: string): T[] {
  const start = Date.parse(startISO);
  return latestPerPost(rows.filter((r) => r.publer_post_id && Date.parse(r.captured_at) >= start));
}

export type WindowRpc = (args: { p_slots: string[]; p_start: string; p_end: string }) =>
  PromiseLike<{ data: any; error: { message: string } | null }>;
const TOO_LARGE = /report_too_large/;

/**
 * One newest in-window capture per (slot, post) through dashboard_report_snapshots. The database
 * function refuses more than 50,000 rows per call; past that we split by account, then by time, and
 * merge, so long ranges over many accounts stay correct instead of failing or being silently cut.
 */
export async function fetchWindowSnapshots(rpc: WindowRpc, slots: string[], startISO: string, endISO: string, depth = 0): Promise<SnapshotRow[]> {
  const unique = [...new Set(slots.filter(Boolean))];
  const start = Date.parse(startISO), end = Date.parse(endISO);
  if (!unique.length || !(end > start)) return [];
  const r = await rpc({ p_slots: unique, p_start: startISO, p_end: endISO });
  if (!r.error) return latestInWindow((r.data ?? []) as SnapshotRow[], startISO);
  if (!TOO_LARGE.test(r.error.message) || depth >= 8) throw new Error(r.error.message);
  let parts: Promise<SnapshotRow[]>[];
  if (unique.length > 1) {
    const mid = Math.ceil(unique.length / 2);
    parts = [unique.slice(0, mid), unique.slice(mid)].map((part) => fetchWindowSnapshots(rpc, part, startISO, endISO, depth + 1));
  } else {
    const midISO = new Date(Math.floor((start + end) / 2)).toISOString();
    parts = [[startISO, midISO], [midISO, endISO]].map(([a, b]) => fetchWindowSnapshots(rpc, unique, a, b, depth + 1));
  }
  return latestPerPost((await Promise.all(parts)).flat());
}
