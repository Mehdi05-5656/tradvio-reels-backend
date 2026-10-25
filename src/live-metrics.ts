// Hourly public post metrics from ScrapeCreators. Publer only refreshes insights once a day,
// so these rows give the dashboard near-live views, likes and comments (plus TikTok shares and
// saves). Read-only toward social platforms; never touches publishing state or Publer's budget.
import type { SupabaseClient } from "@supabase/supabase-js";

// Cadence, overridable from the environment so credits can be tuned without a deploy:
//   LIVE_INTERVAL_MIN   minutes between single-page pulls per account (default 55 → about hourly)
//   LIVE_DEEP_HOURS     hours between full 7-day refreshes (default 6)
//   LIVE_LONG_TAIL_HOURS hours between long-tail passes that re-read up to LIVE_LONG_TAIL_DAYS of posts (default 24)
//   LIVE_LONG_TAIL_DAYS  how far back the long-tail pass reads (default 90). Publer stops at 30 days; this keeps older videos moving.
// Cost: about one credit per page; Instagram pages hold ~12 posts, TikTok ~30.
const envNum = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const LIVE_INTERVAL_MS = 55 * 60_000;     // documented default; see liveInterval()
export const DEEP_INTERVAL_MS = 6 * 3600_000;
export const LIVE_WINDOW_DAYS = 7;
export const liveInterval = () => envNum("LIVE_INTERVAL_MIN", 55) * 60_000;
export const deepInterval = () => envNum("LIVE_DEEP_HOURS", 6) * 3600_000;
export const longTailInterval = () => envNum("LIVE_LONG_TAIL_HOURS", 24) * 3600_000;
export const longTailDays = () => envNum("LIVE_LONG_TAIL_DAYS", 90);
const RETRY_AFTER_ERROR_MS = 15 * 60_000;
const DEDUPE_MS = 6 * 3600_000;                  // unchanged numbers are re-saved at most every 6h
const MAX_DEEP_PAGES = 6;
const MAX_LONG_PAGES = 15;
const BASE = "https://api.scrapecreators.com";

export interface LivePost {
  platform_post_id: string;
  post_link: string;
  posted_at: string | null;
  caption: string | null;
  video_views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  pinned: boolean;
}

const n = (v: any) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (sec: any) => (Number.isFinite(Number(sec)) && Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);

export function parseInstagram(resp: any): { posts: LivePost[]; next: string | null } {
  const posts: LivePost[] = [];
  for (const it of resp?.items ?? []) {
    const code = typeof it?.code === "string" && /^[A-Za-z0-9_-]{5,64}$/.test(it.code) ? it.code : null;
    if (!code) continue;
    const reel = it.product_type === "clips" || it.media_type === 2;
    posts.push({
      platform_post_id: code,
      post_link: `https://www.instagram.com/${reel ? "reel" : "p"}/${code}/`,
      posted_at: iso(it.taken_at),
      caption: typeof it.caption === "object" && it.caption ? it.caption.text ?? null : it.caption ?? null,
      video_views: n(it.ig_play_count ?? it.play_count ?? it.view_count),
      likes: it.like_and_view_counts_disabled ? null : n(it.like_count),
      comments: n(it.comment_count),
      shares: n(it.reshare_count),
      saves: n(it.save_count),
      pinned: Array.isArray(it.timeline_pinned_user_ids) && it.timeline_pinned_user_ids.length > 0,
    });
  }
  return { posts, next: resp?.more_available && resp?.next_max_id ? String(resp.next_max_id) : null };
}

export function parseTikTok(resp: any, username: string): { posts: LivePost[]; next: string | null } {
  const posts: LivePost[] = [];
  for (const a of resp?.aweme_list ?? []) {
    const id = typeof a?.aweme_id === "string" && /^\d{5,30}$/.test(a.aweme_id) ? a.aweme_id : null;
    if (!id) continue;
    const s = a.statistics ?? {};
    posts.push({
      platform_post_id: id,
      post_link: `https://www.tiktok.com/@${username}/video/${id}`,
      posted_at: iso(a.create_time),
      caption: a.desc ?? null,
      video_views: n(s.play_count),
      likes: n(s.digg_count),
      comments: n(s.comment_count),
      shares: n(s.share_count),
      saves: n(s.collect_count),
      pinned: Number(a.is_top) === 1,
    });
  }
  return { posts, next: resp?.has_more && resp?.max_cursor ? String(resp.max_cursor) : null };
}

export const normCaption = (s: any) =>
  String(s ?? "").toLowerCase().replace(/#[\p{L}0-9_]+/gu, " ").replace(/[^\p{L}\p{N}]+/gu, "");

export function igCode(link: any): string | null {
  const m = typeof link === "string" ? link.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/) : null;
  return m ? m[1] : null;
}
export function ttVideoId(link: any): string | null {
  const m = typeof link === "string" ? link.match(/tiktok\.com\/@[^/?#]+\/video\/(\d+)/) : null;
  return m ? m[1] : null;
}

/**
 * Map platform post id -> our Publer post id. Instagram matches exactly on the permalink.
 * TikTok logs usually have no permalink, so we require the same caption (first 30 letters/digits)
 * and a publish time within 45 minutes, and only accept a single unambiguous candidate.
 */
export function matchToLogs(provider: string, posts: LivePost[], logs: any[]): Map<string, string> {
  const out = new Map<string, string>();
  const claimed = new Set<string>();
  for (const p of posts) {
    const exact = logs.find((l) => l.publer_post_id &&
      (provider === "instagram" ? igCode(l.publer_post_link) === p.platform_post_id : ttVideoId(l.publer_post_link) === p.platform_post_id));
    if (exact) { out.set(p.platform_post_id, exact.publer_post_id); claimed.add(exact.publer_post_id); }
  }
  if (provider !== "tiktok") return out;
  const candidates = new Map<string, any[]>();
  for (const p of posts) {
    if (out.has(p.platform_post_id) || !p.posted_at) continue;
    const pc = normCaption(p.caption).slice(0, 30);
    if (pc.length < 8) continue;
    const list = logs.filter((l) => {
      if (!l.publer_post_id || claimed.has(l.publer_post_id) || ttVideoId(l.publer_post_link)) return false;
      const lc = normCaption(l.caption_used).slice(0, 30);
      const at = Date.parse(l.updated_at ?? l.attempted_at);
      return lc.length >= 8 && (pc.startsWith(lc) || lc.startsWith(pc)) && Number.isFinite(at) &&
        Math.abs(Date.parse(p.posted_at!) - at) <= 45 * 60_000;
    });
    candidates.set(p.platform_post_id, list);
  }
  // A log may only be claimed by one video, and a video by one log.
  const logUse = new Map<string, number>();
  for (const list of candidates.values()) for (const l of list) logUse.set(l.publer_post_id, (logUse.get(l.publer_post_id) ?? 0) + 1);
  for (const [id, list] of candidates) {
    if (list.length === 1 && logUse.get(list[0].publer_post_id) === 1) out.set(id, list[0].publer_post_id);
  }
  return out;
}

export class CreditsExhausted extends Error {}

export interface CollectOptions {
  apiKey?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const sameMetrics = (a: any, b: LivePost) =>
  ["video_views", "likes", "comments", "shares", "saves"].every((k) => n(a?.[k]) === (b as any)[k]);

async function scGet(path: string, key: string, f: typeof fetch) {
  const r = await f(`${BASE}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(45_000) });
  if (r.status === 402) throw new CreditsExhausted("scrapecreators_credits_exhausted");
  if (!r.ok) throw new Error(`scrapecreators_http_${r.status}`);
  const body: any = await r.json();
  if (body && body.success === false) throw new Error("scrapecreators_unsuccessful");
  return body;
}

export async function collectLiveMetrics(sb: SupabaseClient, opts: CollectOptions = {}) {
  const apiKey = opts.apiKey ?? process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) return { status: "disabled" as const };
  const now = opts.now ?? new Date();
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { data: accounts, error } = await sb.from("live_metric_accounts").select("*").eq("enabled", true);
  if (error) throw new Error("live_accounts_unavailable");
  const due = (accounts ?? [])
    .filter((a: any) => !a.last_pulled_at || now.getTime() - Date.parse(a.last_pulled_at) >= liveInterval())
    .sort((a: any, b: any) => (Date.parse(a.last_pulled_at ?? 0) || 0) - (Date.parse(b.last_pulled_at ?? 0) || 0));
  const recentCutoff = now.getTime() - LIVE_WINDOW_DAYS * 86400_000;
  const result = { status: "ok" as "ok" | "credits_exhausted", accounts: 0, requests: 0, snapshots: 0, matched: 0, long_tail: 0, errors: [] as string[] };

  for (const acct of due) {
    const deep = !acct.last_deep_pulled_at || now.getTime() - Date.parse(acct.last_deep_pulled_at) >= deepInterval();
    // Long tail: once a day re-read older posts (beyond the 7-day window) so videos Publer has stopped
    // refreshing keep their views moving. Its last run is the newest reading we hold for an older post.
    let longTail = false;
    try {
      const prev = await sb.from("live_post_metrics").select("captured_at").eq("phone_slot", acct.phone_slot)
        .lt("posted_at", new Date(recentCutoff).toISOString()).order("captured_at", { ascending: false }).limit(1);
      // Accounts with no older posts yet fall back to the deep-pull time, so they do not re-run the long tail every hour.
      const last = (prev.data?.[0]?.captured_at ? Date.parse(prev.data[0].captured_at) : 0) || (Date.parse(acct.last_deep_pulled_at ?? "") || 0);
      longTail = now.getTime() - last >= longTailInterval();
    } catch { longTail = false; }
    const cutoff = longTail ? now.getTime() - longTailDays() * 86400_000 : recentCutoff;
    const cutoffDay = new Date(cutoff - 86400_000).toISOString().slice(0, 10);
    const maxPages = longTail ? MAX_LONG_PAGES : deep ? MAX_DEEP_PAGES : 1;
    try {
      const posts: LivePost[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const u = encodeURIComponent(acct.username);
        const path = acct.provider === "instagram"
          ? `/v2/instagram/user/posts?handle=${u}${cursor ? `&next_max_id=${encodeURIComponent(cursor)}` : ""}`
          : `/v3/tiktok/profile/videos?handle=${u}${cursor ? `&max_cursor=${encodeURIComponent(cursor)}` : ""}`;
        if (result.requests) await sleep(300);
        const body = await scGet(path, apiKey, f);
        result.requests++;
        const parsed = acct.provider === "instagram" ? parseInstagram(body) : parseTikTok(body, acct.username);
        posts.push(...parsed.posts);
        const regular = parsed.posts.filter((p) => !p.pinned && p.posted_at);
        const oldest = regular.length ? Math.min(...regular.map((p) => Date.parse(p.posted_at!))) : -Infinity;
        cursor = parsed.next;
        if (!cursor || oldest < cutoff) break;
      }
      const recent = [...new Map(posts.filter((p) => p.posted_at && Date.parse(p.posted_at) >= cutoff)
        .map((p) => [p.platform_post_id, p])).values()];

      const { data: logs, error: logErr } = await sb.from("publer_publish_log")
        .select("publer_post_id,publer_post_link,caption_used,updated_at,attempted_at")
        .eq("phone_slot", acct.phone_slot).eq("status", "published").gte("slot_local_date", cutoffDay);
      if (logErr) throw new Error("publish_log_unavailable");
      const mapping = matchToLogs(acct.provider, recent, logs ?? []);

      const { data: prior, error: priorErr } = await sb.from("live_post_metrics")
        .select("platform_post_id,captured_at,video_views,likes,comments,shares,saves")
        .eq("phone_slot", acct.phone_slot).gte("captured_at", new Date(now.getTime() - DEDUPE_MS).toISOString())
        .order("captured_at", { ascending: false });
      if (priorErr) throw new Error("live_history_unavailable");
      const latest = new Map<string, any>();
      for (const r of prior ?? []) if (!latest.has(r.platform_post_id)) latest.set(r.platform_post_id, r);

      const rows = recent.filter((p) => !(latest.has(p.platform_post_id) && sameMetrics(latest.get(p.platform_post_id), p)))
        .map((p) => ({
          phone_slot: acct.phone_slot, provider: acct.provider, platform_post_id: p.platform_post_id,
          post_link: p.post_link, publer_post_id: mapping.get(p.platform_post_id) ?? null, posted_at: p.posted_at,
          captured_at: now.toISOString(), video_views: p.video_views, likes: p.likes, comments: p.comments,
          shares: p.shares, saves: p.saves, caption: p.caption ? String(p.caption).slice(0, 2000) : null,
        }));
      if (rows.length) {
        const ins = await sb.from("live_post_metrics").insert(rows);
        if (ins.error) throw new Error("live_insert_failed");
      }
      result.snapshots += rows.length;
      result.matched += mapping.size;
      result.accounts++;
      if (longTail) result.long_tail++;
      await sb.from("live_metric_accounts").update({
        last_pulled_at: now.toISOString(), ...(deep || longTail ? { last_deep_pulled_at: now.toISOString() } : {}),
        last_status: `ok: ${recent.length} public posts in ${longTail ? longTailDays() : LIVE_WINDOW_DAYS} days, ${mapping.size} matched`,
        last_error: null, updated_at: now.toISOString(),
      }).eq("phone_slot", acct.phone_slot);
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 200);
      result.errors.push(`${acct.phone_slot}: ${msg}`);
      // Try again in about 15 minutes instead of an hour.
      await sb.from("live_metric_accounts").update({
        last_pulled_at: new Date(now.getTime() - liveInterval() + RETRY_AFTER_ERROR_MS).toISOString(),
        last_status: "error", last_error: msg, updated_at: now.toISOString(),
      }).eq("phone_slot", acct.phone_slot);
      if (e instanceof CreditsExhausted) { result.status = "credits_exhausted"; break; }
    }
  }
  return result;
}
