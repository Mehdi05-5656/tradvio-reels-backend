// Content performance (owner's thread, Nov 18 2026): the organic accounts that post for Clone8, their videos, hourly
// public-metric snapshots, and which videos brought sign-ups and paying users. Owner-only, read by the admin panel's
// Content tab (routes in studio-content-perf-routes.ts; tables in migrations/20261125000000_studio_content_perf.sql).
//
// The owner's rule: counting starts at our first snapshot. Each video keeps its first reading as a baseline and every
// number is latest minus baseline; an account carries tracking_since; a video posted before that is "pre-tracking",
// still read (it costs nothing extra, the page comes in one call) but left out of totals unless asked for.
//
// Collect: one public-data page per account (the newest ~12 Instagram or ~30 TikTok videos) through ScrapeCreators,
// hourly while the account has a video under 48 hours old, every 4 hours otherwise; followers once a day. The parsers
// are the ones studio-performance.ts already uses for people's own accounts. Every call is booked in the ledger.
//
// Compute: pure arithmetic over the rows (summarize()), tested without a database: gains per video and per day from the
// snapshots, sign-ups and payers from studio_customers with the account they named at sign-up (stated), the account in
// a link's utm_source (link), and the cost figures the owner enters.
import type { SupabaseClient } from "@supabase/supabase-js";
import { OVERHEAD } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import { noteScrapeCreators } from "./vendor-alerts.js";
import { parseInstagramPosts, parseTikTokPosts, parseYouTubeShorts, type PerfPost } from "./studio-performance.js";

export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];
/** What a video can market. Shown in this order; "none" is a video that sells nothing (a creator's own content). */
export const FEATURES: Array<[string, string]> = [["stories", "Build Stories"], ["town", "In This Town"], ["clips", "Clips"], ["reshoot", "Reshoot"], ["motivation", "Motivation"], ["signature", "Signature"], ["films", "Films"], ["kage", "Kage"], ["captions", "Captions"], ["blueprint", "Blueprint"], ["influencer", "AI Influencer"], ["other", "Other Clone8"], ["none", "Not Clone8"]];
export const FEATURE_IDS = new Set(FEATURES.map((f) => f[0]));

export const HOUR = 3600_000, DAY = 86400_000;
/** Hourly while a video is under this old; every 4 hours otherwise. Followers once a day. */
export const FRESH_MS = 48 * HOUR, HOT_INTERVAL_MS = HOUR, QUIET_INTERVAL_MS = 4 * HOUR, PROFILE_INTERVAL_MS = 20 * HOUR;
/** Every video the account ever posted is read on the first pull and once a day after (the deep read, up to DEEP_PAGES
 *  pages); the hourly pulls read the newest HOT_PAGES pages, where the moving videos are. The owner's rule (Nov 18 2026):
 *  every video is tracked from day one, old ones included; only the views they had before our first reading are unused. */
export const DEEP_INTERVAL_MS = 24 * HOUR, DEEP_PAGES = 25, HOT_PAGES = 2;
const SC = "https://api.scrapecreators.com";
const COUNTS = ["views", "likes", "comments", "shares", "saves"] as const;
type Counts = Record<(typeof COUNTS)[number], number | null>;

export type Deps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void; now?: () => number };
export type AccountRow = {
  id: string; platform: Platform; handle: string; url: string | null; display_name: string | null; owner_kind: "ours" | "creator";
  cost_usd_per_video: number | null; cost_usd_per_month: number | null; default_feature: string | null; enabled: boolean;
  tracking_since: string | null; followers: number | null; avatar_key: string | null; latest_posted_at: string | null;
  last_pulled_at: string | null; last_profile_at: string | null; last_deep_at?: string | null; last_status: string | null; last_error: string | null;
  /** count the views a video already had at our first reading (an account that only ever posted for Clone8): those views
   *  sit on the day the video was posted; off, a video counts from its first reading only (the default) */
  count_history?: boolean | null;
};
export type VideoRow = {
  id: string; account_id: string; platform: string; platform_post_id: string; url: string; caption: string | null; posted_at: string | null; duration_s: number | null;
  thumb_key: string | null; first_seen_at: string; pre_tracking: boolean;
  base_views: number | null; base_likes: number | null; base_comments: number | null; base_shares: number | null; base_saves: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; latest_at: string | null;
  tags: Record<string, any>; tag_source: string | null; cost_usd: number | null; variant_of: string | null; hidden: boolean;
};
export type SnapshotRow = { video_id: string; captured_at: string } & Counts;
export type AccountSnapshotRow = { account_id: string; day: string; followers: number | null };
/** A sign-up as the summary needs it (studio_customers joined with the user's email on the way in). */
export type SignupRow = { user_id: string; created_at: string; heard: string | null; heard_account: string | null; heard_video: string | null; utm_source: string | null; country: string | null; paid: boolean; paid_at: string | null; net_usd: number; internal: boolean };

const num = (v: any) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const counts = (p: PerfPost): Counts => ({ views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves });
const sameCounts = (a: Partial<Counts>, b: Counts) => COUNTS.every((k) => num(a[k]) === b[k]);

// ---------------------------------------------------------------------------------------------------
// Reading an account (public data; one page of videos, the profile once a day)
// ---------------------------------------------------------------------------------------------------
async function scGet(deps: Deps, path: string): Promise<any> {
  const key = (deps.env ?? process.env).SCRAPECREATORS_API_KEY;
  if (!key) throw new Error("content_unconfigured");
  const r = await (deps.fetch ?? fetch)(`${SC}${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  recordEvent({ kind: "vendor", name: "scrapecreators", usd: OVERHEAD.scrapecreators_usd_per_call, props: { path: path.split("?")[0], status: r.status, use: "content" } });
  const body: any = r.ok ? await r.json().catch(() => null) : null;
  try { noteScrapeCreators(r.status, body, { env: deps.env, fetch: deps.fetch, now: deps.now, where: `content ${path.split("?")[0]}` }); } catch { /* alerts never fail a pull */ }
  if (r.status === 404) throw new Error("account_not_found");
  if (!r.ok) throw new Error(`content_http_${r.status}`);
  if (body?.success === false) throw new Error("content_unsuccessful");
  return body;
}

/** The newest page of an account's videos. */
export async function readVideos(deps: Deps, platform: Platform, handle: string, pages = 1): Promise<PerfPost[]> {
  const h = encodeURIComponent(handle.replace(/^@/, ""));
  const posts: PerfPost[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    if (platform === "tiktok") {
      const r = await scGet(deps, `/v3/tiktok/profile/videos?handle=${h}${cursor ? `&max_cursor=${encodeURIComponent(cursor)}` : ""}`);
      posts.push(...parseTikTokPosts(r, handle.replace(/^@/, "")));
      cursor = r?.has_more && r?.max_cursor ? String(r.max_cursor) : null;
    } else if (platform === "instagram") {
      const r = await scGet(deps, `/v1/instagram/user/reels?handle=${h}${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ""}`);
      posts.push(...parseInstagramPosts(r));
      cursor = r?.paging_info?.more_available && r?.paging_info?.max_id ? String(r.paging_info.max_id) : r?.more_available && r?.next_max_id ? String(r.next_max_id) : null;
    } else {
      const r = await scGet(deps, `/v1/youtube/channel/shorts?handle=${h}&sort=newest${cursor ? `&continuationToken=${encodeURIComponent(cursor)}` : ""}`);
      posts.push(...parseYouTubeShorts(r));
      cursor = r?.continuationToken ? String(r.continuationToken) : null;
    }
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return posts;
}
/** Followers, the display name and the avatar. A failure here never fails the pull: the videos matter more. */
export async function readProfile(deps: Deps, platform: Platform, handle: string): Promise<{ followers: number | null; display_name: string | null; avatar_url: string | null } | null> {
  const h = encodeURIComponent(handle.replace(/^@/, ""));
  try {
    if (platform === "tiktok") { const p = await scGet(deps, `/v1/tiktok/profile?handle=${h}`); return { followers: num(p?.stats?.followerCount ?? p?.statsV2?.followerCount ?? p?.user?.followerCount), display_name: p?.user?.nickname ?? null, avatar_url: p?.user?.avatarMedium ?? p?.user?.avatarThumb ?? null }; }
    if (platform === "instagram") { const p = await scGet(deps, `/v1/instagram/profile?handle=${h}`); const u = p?.data?.user ?? p?.user ?? p; return { followers: num(u?.edge_followed_by?.count ?? u?.follower_count), display_name: u?.full_name ?? null, avatar_url: u?.profile_pic_url_hd ?? u?.profile_pic_url ?? null }; }
    const p = await scGet(deps, `/v1/youtube/channel?handle=${h}`); return { followers: num(p?.subscriberCount), display_name: p?.title ?? null, avatar_url: p?.avatar?.image?.sources?.at?.(-1)?.url ?? null };
  } catch { return null; }
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** A picture kept in our storage (platform image links expire): https only, an image, 5 MB at most. */
async function keepImage(sb: SupabaseClient, f: typeof fetch, url: string, key: string): Promise<string | null> {
  try {
    if (typeof url !== "string" || new URL(url).protocol !== "https:") return null;
    const r = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = String(r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5_000_000) return null;
    const up = await sb.storage.from("studio-outputs").upload(key, buf, { contentType: type, upsert: true });
    return up.error ? null : key;
  } catch { return null; }
}
const safe = (s: string) => s.replace(/[^\w.-]/g, "_").slice(0, 80);

// ---------------------------------------------------------------------------------------------------
// The cadence
// ---------------------------------------------------------------------------------------------------
/** Whether an account is due: never pulled, or an hour (a fresh video) / four hours (quiet) since the last pull. */
export function isDue(a: Pick<AccountRow, "enabled" | "last_pulled_at" | "latest_posted_at">, now: number): boolean {
  if (!a.enabled) return false;
  if (!a.last_pulled_at) return true;
  const hot = a.latest_posted_at ? now - Date.parse(a.latest_posted_at) < FRESH_MS : false;
  return now - Date.parse(a.last_pulled_at) >= (hot ? HOT_INTERVAL_MS : QUIET_INTERVAL_MS);
}

export type PullResult = { accounts: number; videos_new: number; snapshots: number; errors: string[] };

/** Pull every due account (or the ones named), write new videos, changed readings and the daily follower row. */
export async function pullContent(sb: SupabaseClient, deps: Deps = {}, opts: { force?: boolean; accountIds?: string[] } = {}): Promise<PullResult> {
  const now = deps.now?.() ?? Date.now(), f = deps.fetch ?? fetch, log = deps.log ?? ((s: string) => console.log(s));
  const out: PullResult = { accounts: 0, videos_new: 0, snapshots: 0, errors: [] };
  const q = await sb.from("content_accounts").select("*").eq("enabled", true);
  if (q.error) throw q.error;
  const due = ((q.data ?? []) as AccountRow[]).filter((a) => (opts.accountIds ? opts.accountIds.includes(a.id) : true) && (opts.force || isDue(a, now)));
  for (const a of due) {
    try {
      const deep = !a.last_deep_at || now - Date.parse(a.last_deep_at) >= DEEP_INTERVAL_MS;
      const posts = await readVideos(deps, a.platform, a.handle, deep ? DEEP_PAGES : HOT_PAGES);
      const tracking = a.tracking_since ?? new Date(now).toISOString();
      const have = await sb.from("content_videos").select("id,platform_post_id,views,likes,comments,shares,saves,thumb_key").eq("account_id", a.id);
      if (have.error) throw have.error;
      const byId = new Map(((have.data ?? []) as any[]).map((v) => [v.platform_post_id, v]));
      const uniq = [...new Map(posts.map((p) => [p.platform_post_id, p])).values()];
      let latestPosted = a.latest_posted_at ? Date.parse(a.latest_posted_at) : 0;
      for (const p of uniq) {
        if (p.published_at) latestPosted = Math.max(latestPosted, Date.parse(p.published_at));
        const c = counts(p), seen = byId.get(p.platform_post_id);
        if (!seen) {
          const thumb_key = p.thumb_url ? await keepImage(sb, f, p.thumb_url, `content/${a.platform}/${safe(p.platform_post_id)}.jpg`) : null;
          const pre = !!p.published_at && Date.parse(p.published_at) < Date.parse(tracking);
          const row = {
            account_id: a.id, platform: a.platform, platform_post_id: p.platform_post_id, url: p.url, caption: p.caption?.slice(0, 2200) ?? null, posted_at: p.published_at, duration_s: p.duration_s, thumb_key,
            first_seen_at: new Date(now).toISOString(), pre_tracking: pre, base_views: c.views, base_likes: c.likes, base_comments: c.comments, base_shares: c.shares, base_saves: c.saves,
            ...c, latest_at: new Date(now).toISOString(), tags: a.default_feature ? { feature: a.default_feature } : {}, tag_source: a.default_feature ? "account" : null, updated_at: new Date(now).toISOString(),
          };
          const ins = await sb.from("content_videos").insert(row).select("id").single();
          if (ins.error) throw ins.error;
          const snap = await sb.from("content_snapshots").insert({ video_id: ins.data.id, captured_at: new Date(now).toISOString(), ...c });
          if (snap.error) throw snap.error;
          out.videos_new++; out.snapshots++;
        } else if (!sameCounts(seen, c)) {
          const snap = await sb.from("content_snapshots").insert({ video_id: seen.id, captured_at: new Date(now).toISOString(), ...c });
          if (snap.error) throw snap.error;
          const up = await sb.from("content_videos").update({ ...c, latest_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }).eq("id", seen.id);
          if (up.error) throw up.error;
          out.snapshots++;
        }
      }
      // the profile once a day: followers, the name and the avatar; the daily account row even when the profile call failed
      const patch: Record<string, any> = { tracking_since: tracking, last_pulled_at: new Date(now).toISOString(), last_status: `ok: ${uniq.length} videos read${deep ? " (every page)" : ""}`, last_error: null, ...(deep ? { last_deep_at: new Date(now).toISOString() } : {}), latest_posted_at: latestPosted ? new Date(latestPosted).toISOString() : a.latest_posted_at, updated_at: new Date(now).toISOString() };
      let followers = a.followers;
      if (!a.last_profile_at || now - Date.parse(a.last_profile_at) >= PROFILE_INTERVAL_MS) {
        const prof = await readProfile(deps, a.platform, a.handle);
        if (prof) {
          followers = prof.followers ?? followers;
          patch.followers = followers; patch.last_profile_at = new Date(now).toISOString();
          if (prof.display_name) patch.display_name = String(prof.display_name).slice(0, 120);
          if (prof.avatar_url) { const k = await keepImage(sb, f, prof.avatar_url, `content/avatars/${a.platform}-${safe(a.handle)}.jpg`); if (k) patch.avatar_key = k; }
        }
        const day = new Date(now).toISOString().slice(0, 10);
        await sb.from("content_account_snapshots").upsert({ account_id: a.id, day, followers, videos: byId.size + uniq.filter((p) => !byId.has(p.platform_post_id)).length, captured_at: new Date(now).toISOString() }, { onConflict: "account_id,day" });
      }
      const up = await sb.from("content_accounts").update(patch).eq("id", a.id);
      if (up.error) throw up.error;
      out.accounts++;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 160);
      out.errors.push(`${a.platform}:${a.handle}: ${msg}`);
      log(`[content] ${a.platform} @${a.handle} ${msg}`);
      // read again in about 15 minutes instead of an hour (the live stats do the same)
      await sb.from("content_accounts").update({ last_pulled_at: new Date(now - HOT_INTERVAL_MS + 15 * 60_000).toISOString(), last_status: "error", last_error: msg, updated_at: new Date(now).toISOString() }).eq("id", a.id);
      if (/content_unconfigured|content_http_402|content_http_401/.test(msg)) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Summarize: the page's numbers, from rows (pure)
// ---------------------------------------------------------------------------------------------------
export type Range = { days: number | null; since: number; until: number; tz_offset_min: number };
export type Gain = { views: number; likes: number; comments: number; shares: number; saves: number; revised: boolean };
export type VideoOut = {
  id: string; account_id: string; platform: string; handle: string; url: string; caption: string | null; posted_at: string | null; duration_s: number | null; thumb_key: string | null; thumb_url?: string | null;
  first_seen_at: string; pre_tracking: boolean; hidden: boolean; feature: string | null; tag_source: string | null; tags: Record<string, any>;
  gain: Gain; total_gain: Gain; latest: Counts; velocity_1h: number; velocity_6h: number; velocity_24h: number; engagement: number | null;
  signups_stated: number; signups_link: number; paid: number; net_usd: number; cost_usd: number | null; cpm_usd: number | null;
};
export type AccountOut = {
  id: string; platform: string; handle: string; display_name: string | null; url: string | null; owner_kind: string; enabled: boolean; avatar_key: string | null; avatar_url?: string | null;
  tracking_since: string | null; last_pulled_at: string | null; last_status: string | null; last_error: string | null; followers: number | null; followers_delta: number | null;
  cost_usd_per_video: number | null; cost_usd_per_month: number | null; default_feature: string | null;
  videos: number; videos_pre: number; gain: Gain; median_views: number | null; best_video_id: string | null; engagement: number | null;
  /** what one of this account's videos gains in a typical day (median over videos tracked 12 h or more, since their first reading); null under 3 such videos */
  usual_daily: number | null;
  /** the views its videos had before tracking count (on the day each was posted) */
  count_history: boolean;
  signups_stated: number; signups_link: number; paid: number; net_usd: number; conversion: number | null; cost_usd: number | null; cpm_usd: number | null; cost_per_signup: number | null; cost_per_paid: number | null;
};
export type Summary = {
  range: { days: number | null; since: string; until: string; tracking_since: string | null };
  kpis: {
    views: number; views_prev: number | null; videos: number; videos_prev: number | null; signups: number; signups_prev: number | null;
    signups_stated: number; signups_link: number; signups_unknown: number; paid: number; paid_prev: number | null; paid_attributed: number;
    conversion: number | null; conversion_attributed: number | null; net_usd: number; engagement: number | null;
    cost_usd: number | null; cpm_usd: number | null; cost_per_signup: number | null; cost_per_paid: number | null;
    /** followers across the accounts now, and the change over the range (from the daily account rows) */
    followers: number | null; followers_delta: number | null;
    /** what reading the accounts cost in the range (ScrapeCreators calls booked with use=content) */
    pull_calls?: number; pull_usd?: number;
  };
  daily: Array<{ day: string; views: number; signups: number; signups_stated: number; paid: number; by_account: Record<string, number> }>;
  now: VideoOut[];
  accounts: AccountOut[];
  videos: VideoOut[];
  stated: Array<{ at: string; handle: string | null; platform: string | null; video: string | null; country: string | null; paid: boolean }>;
  by_feature: Array<{ feature: string; label: string; videos: number; views: number; signups: number; paid: number; per_1k: number | null; enough: boolean }>;
  by_hour: Array<{ hour: number; videos: number; median_views: number | null; enough: boolean }>;
  by_weekday: Array<{ day: number; label: string; videos: number; median_views: number | null; enough: boolean }>;
  by_length: Array<{ key: string; label: string; videos: number; median_views: number | null; enough: boolean }>;
  notes: string[];
};

const zeroGain = (): Gain => ({ views: 0, likes: 0, comments: 0, shares: 0, saves: 0, revised: false });
const addGain = (a: Gain, b: Gain): Gain => ({ views: a.views + b.views, likes: a.likes + b.likes, comments: a.comments + b.comments, shares: a.shares + b.shares, saves: a.saves + b.saves, revised: a.revised || b.revised });
export const median = (xs: number[]): number | null => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const rate = (n: number, d: number | null | undefined) => (d && d > 0 ? n / d : null);
const LENGTHS = [{ key: "s15", label: "Under 15 s", from: 0, to: 15 }, { key: "s30", label: "15–30 s", from: 15, to: 30 }, { key: "s60", label: "30–60 s", from: 30, to: 60 }, { key: "s180", label: "1–3 min", from: 60, to: 180 }, { key: "long", label: "Over 3 min", from: 180, to: 1e9 }];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Enough videos for a group to say anything, and enough stated sign-ups for a rate. */
export const MIN_VIDEOS = 3, MIN_SIGNUPS = 10;

/** A video's counts at an instant: the last reading at or before it, else its baseline (before the first reading: nothing). */
function readingAt(v: VideoRow, snaps: SnapshotRow[], t: number): Counts | null {
  if (Date.parse(v.first_seen_at) > t) return null;
  // snaps are sorted by captured_at (summarize sorts them once per video): the last one at or before t
  let lo = 0, hi = snaps.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Date.parse(snaps[mid].captured_at) <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best >= 0) { const b = snaps[best]; return { views: b.views, likes: b.likes, comments: b.comments, shares: b.shares, saves: b.saves }; }
  return { views: v.base_views, likes: v.base_likes, comments: v.base_comments, shares: v.base_shares, saves: v.base_saves };
}
/** A video's counts at an instant, when the account counts its history: nothing before the post, the first reading's
 *  counts from the post until that reading (those views sit on the posting day), the readings after. */
function readingAtH(v: VideoRow, snaps: SnapshotRow[], t: number, history: boolean): Counts | null {
  if (!history) return readingAt(v, snaps, t);
  const posted = v.posted_at ? Date.parse(v.posted_at) : Date.parse(v.first_seen_at);
  if (t < Math.min(posted, Date.parse(v.first_seen_at))) return { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  if (t < Date.parse(v.first_seen_at)) return { views: v.base_views, likes: v.base_likes, comments: v.base_comments, shares: v.base_shares, saves: v.base_saves };
  return readingAt(v, snaps, t);
}
/** Gains between two instants, never below zero (a platform that revises a count down is flagged, not subtracted). */
function gainBetween(v: VideoRow, snaps: SnapshotRow[], from: number, to: number, history = false): Gain {
  const a = readingAtH(v, snaps, from, history), b = readingAtH(v, snaps, to, history);
  const g = zeroGain();
  if (!b) return g;
  for (const k of COUNTS) {
    const d = (b[k] ?? 0) - (a?.[k] ?? (v as any)[`base_${k}`] ?? 0);
    if (d < 0) g.revised = true;
    (g as any)[k] = Math.max(0, d);
  }
  // a reading inside the window lower than the one before it: the platform revised the count (flagged, never subtracted)
  const inside = snaps.filter((s) => { const t = Date.parse(s.captured_at); return t > from && t <= to; });
  let prev: Counts | null = a;
  for (const s of inside) { if (prev && COUNTS.some((k) => s[k] != null && prev![k] != null && s[k]! < prev![k]!)) g.revised = true; prev = s; }
  return g;
}
const localDay = (t: number, off: number) => new Date(t + off * 60_000).toISOString().slice(0, 10);
const localHour = (t: number, off: number) => new Date(t + off * 60_000).getUTCHours();
const localWeekday = (t: number, off: number) => new Date(t + off * 60_000).getUTCDay();
const startOfLocalDay = (t: number, off: number) => { const d = new Date(t + off * 60_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() - off * 60_000; };

export function summarize(input: { accounts: AccountRow[]; videos: VideoRow[]; snapshots: SnapshotRow[]; account_snapshots: AccountSnapshotRow[]; signups: SignupRow[]; pulls?: Array<{ at: string; usd: number }>; range: Range; hide_pre?: boolean; include_internal?: boolean }): Summary {
  const { range } = input, off = range.tz_offset_min, until = range.until, since = range.since, prevSince = since - (until - since);
  const accounts = input.accounts, byAccount = new Map(accounts.map((a) => [a.id, a])), videoById = new Map(input.videos.map((v) => [v.id, v]));
  const snapsBy = new Map<string, SnapshotRow[]>();
  for (const s of input.snapshots) { const l = snapsBy.get(s.video_id) ?? []; l.push(s); snapsBy.set(s.video_id, l); }
  for (const l of snapsBy.values()) l.sort((x, y) => Date.parse(x.captured_at) - Date.parse(y.captured_at));
  // every video counts from its first reading, the ones posted before tracking too (the owner's rule); hide_pre leaves those out
  const videos = input.videos.filter((v) => byAccount.has(v.account_id) && !v.hidden && !(input.hide_pre && v.pre_tracking));
  const signups = input.signups.filter((s) => input.include_internal || !s.internal);
  const handleKey = (p: string | null | undefined, h: string | null | undefined) => `${String(p ?? "").toLowerCase()}:${String(h ?? "").toLowerCase().replace(/^@/, "")}`;
  const accountByKey = new Map(accounts.map((a) => [handleKey(a.platform, a.handle), a]));
  const accountById = (s: SignupRow): AccountRow | null => {
    if (s.heard_account && byAccount.has(s.heard_account)) return byAccount.get(s.heard_account)!;
    if (s.heard_account && s.heard_account.includes(":")) { const [p, h] = s.heard_account.split(":"); return accountByKey.get(handleKey(p, h)) ?? null; }
    return null;
  };
  const linkAccount = (s: SignupRow): AccountRow | null => {
    if (!s.utm_source) return null;
    const u = s.utm_source.toLowerCase().replace(/^@/, "");
    return accounts.find((a) => a.handle.toLowerCase() === u || `${a.platform}-${a.handle.toLowerCase()}` === u || `${a.platform}:${a.handle.toLowerCase()}` === u) ?? null;
  };
  const inRange = (t: string, from: number, to: number) => { const x = Date.parse(t); return x >= from && x < to; };
  const S = signups.filter((s) => inRange(s.created_at, since, until)), Sprev = signups.filter((s) => inRange(s.created_at, prevSince, since));

  // sign-ups by account: stated first, a link second (a person counts once)
  const statedBy = new Map<string, SignupRow[]>(), linkBy = new Map<string, SignupRow[]>();
  for (const s of S) {
    const st = accountById(s); if (st) { const l = statedBy.get(st.id) ?? []; l.push(s); statedBy.set(st.id, l); continue; }
    const lk = linkAccount(s); if (lk) { const l = linkBy.get(lk.id) ?? []; l.push(s); linkBy.set(lk.id, l); }
  }

  const videoOut = (v: VideoRow): VideoOut => {
    const snaps = snapsBy.get(v.id) ?? [];
    const a = byAccount.get(v.account_id)!, hist = !!a.count_history;
    const gain = gainBetween(v, snaps, since, until, hist), total = gainBetween(v, snaps, 0, until, hist);
    const eng = gain.likes + gain.comments + gain.shares + gain.saves;
    const cost = v.cost_usd ?? (a.cost_usd_per_video ?? null);
    return {
      id: v.id, account_id: v.account_id, platform: v.platform, handle: a.handle, url: v.url, caption: v.caption, posted_at: v.posted_at, duration_s: v.duration_s, thumb_key: v.thumb_key,
      first_seen_at: v.first_seen_at, pre_tracking: v.pre_tracking, hidden: v.hidden, feature: v.tags?.feature ?? null, tag_source: v.tag_source, tags: v.tags ?? {},
      gain, total_gain: total, latest: { views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves },
      velocity_1h: gainBetween(v, snaps, until - HOUR, until, hist).views, velocity_6h: gainBetween(v, snaps, until - 6 * HOUR, until, hist).views, velocity_24h: gainBetween(v, snaps, until - DAY, until, hist).views,
      engagement: rate(eng, gain.views), signups_stated: 0, signups_link: 0, paid: 0, net_usd: 0, cost_usd: cost, cpm_usd: cost != null && gain.views > 0 ? (cost / gain.views) * 1000 : null,
    };
  };
  const vids = videos.map(videoOut);
  const vidById = new Map(vids.map((v) => [v.id, v]));
  // a sign-up that named words about the video is matched to the video only when the words are in one caption
  const notes: string[] = [];
  for (const [aid, list] of statedBy) for (const s of list) {
    const own = vids.filter((v) => v.account_id === aid && (v.posted_at ? Date.parse(v.posted_at) <= Date.parse(s.created_at) : true));
    const words = String(s.heard_video ?? "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length >= 4);
    const hits = words.length ? own.filter((v) => { const c = String(v.caption ?? "").toLowerCase(); return words.some((w) => c.includes(w)); }) : [];
    if (hits.length === 1) { hits[0].signups_stated++; if (s.paid) { hits[0].paid++; hits[0].net_usd += s.net_usd; } }
  }

  const accountOut = (a: AccountRow): AccountOut => {
    const own = vids.filter((v) => v.account_id === a.id);
    const gain = own.reduce((g, v) => addGain(g, v.gain), zeroGain());
    const stated = statedBy.get(a.id) ?? [], link = linkBy.get(a.id) ?? [];
    const payers = [...stated, ...link].filter((s) => s.paid);
    const net = payers.reduce((s, x) => s + x.net_usd, 0);
    const posted = own.filter((v) => v.posted_at && inRange(v.posted_at, since, until));
    const monthly = a.cost_usd_per_month != null ? a.cost_usd_per_month * ((until - since) / (30 * DAY)) : null;
    const perVideo = a.cost_usd_per_video != null ? a.cost_usd_per_video * posted.length : null;
    const own_cost = own.reduce((s, v) => s + (v.cost_usd != null && v.posted_at && inRange(v.posted_at, since, until) ? Number(v.cost_usd) : 0), 0);
    const cost = monthly != null || perVideo != null || own_cost > 0 ? (monthly ?? 0) + (perVideo ?? 0) + (a.cost_usd_per_video == null ? own_cost : 0) : null;
    const fs = input.account_snapshots.filter((s) => s.account_id === a.id && s.followers != null).sort((x, y) => x.day.localeCompare(y.day));
    const last = fs.at(-1) ?? null, first = [...fs].reverse().find((s) => Date.parse(`${s.day}T00:00:00Z`) <= since) ?? fs[0] ?? null;
    const eng = gain.likes + gain.comments + gain.shares + gain.saves;
    const n = stated.length + link.length;
    const best = [...own].sort((x, y) => y.gain.views - x.gain.views)[0] ?? null;
    return {
      id: a.id, platform: a.platform, handle: a.handle, display_name: a.display_name, url: a.url, owner_kind: a.owner_kind, enabled: a.enabled, avatar_key: a.avatar_key,
      tracking_since: a.tracking_since, last_pulled_at: a.last_pulled_at, last_status: a.last_status, last_error: a.last_error,
      followers: a.followers ?? last?.followers ?? null, followers_delta: last && first && first !== last ? (last.followers ?? 0) - (first.followers ?? 0) : null,
      cost_usd_per_video: a.cost_usd_per_video, cost_usd_per_month: a.cost_usd_per_month, default_feature: a.default_feature,
      videos: own.length, videos_pre: input.videos.filter((v) => v.account_id === a.id && v.pre_tracking && !v.hidden).length, gain,
      median_views: median(own.filter((v) => Date.parse(v.first_seen_at) <= until).map((v) => v.gain.views)), best_video_id: best && best.gain.views > 0 ? best.id : null, engagement: rate(eng, gain.views),
      usual_daily: (() => { const xs = own.filter((v) => until - Date.parse(v.first_seen_at) >= 12 * HOUR).map((v) => Math.max(0, (v.latest.views ?? 0) - (videoById.get(v.id)?.base_views ?? 0)) / Math.max(0.5, (until - Date.parse(v.first_seen_at)) / DAY)); return xs.length >= 3 ? median(xs) : null; })(),
      count_history: !!a.count_history,
      signups_stated: stated.length, signups_link: link.length, paid: payers.length, net_usd: net, conversion: n >= MIN_SIGNUPS ? payers.length / n : null,
      cost_usd: cost, cpm_usd: cost != null && gain.views > 0 ? (cost / gain.views) * 1000 : null, cost_per_signup: cost != null && n > 0 ? cost / n : null, cost_per_paid: cost != null && payers.length > 0 ? cost / payers.length : null,
    };
  };
  const accs = accounts.map(accountOut);

  // the days: views gained per day (and per account), sign-ups, stated ones, payers
  const daily: Summary["daily"] = [];
  const firstDay = startOfLocalDay(since, off);
  for (let t = firstDay; t < until; t += DAY) {
    const dayEnd = Math.min(t + DAY, until);
    const by: Record<string, number> = {};
    let views = 0;
    for (const v of videos) { const g = gainBetween(v, snapsBy.get(v.id) ?? [], Math.max(t, since), dayEnd, !!byAccount.get(v.account_id)?.count_history).views; if (g) { by[v.account_id] = (by[v.account_id] ?? 0) + g; views += g; } }
    const ss = S.filter((s) => inRange(s.created_at, Math.max(t, since), dayEnd));
    daily.push({ day: localDay(t, off), views, signups: ss.length, signups_stated: ss.filter((s) => accountById(s)).length, paid: ss.filter((s) => s.paid).length, by_account: by });
  }
  // the previous period, for the deltas
  const prevViews = videos.reduce((s, v) => s + gainBetween(v, snapsBy.get(v.id) ?? [], prevSince, since, !!byAccount.get(v.account_id)?.count_history).views, 0);
  const posted = (from: number, to: number) => videos.filter((v) => v.posted_at && inRange(v.posted_at, from, to)).length;
  const stated = S.filter((s) => accountById(s)).length, link = S.filter((s) => !accountById(s) && linkAccount(s)).length;
  const paidAll = S.filter((s) => s.paid), paidAttr = S.filter((s) => s.paid && (accountById(s) || linkAccount(s)));
  const totalGain = vids.reduce((g, v) => addGain(g, v.gain), zeroGain());
  const costs = accs.map((a) => a.cost_usd).filter((c): c is number => c != null);
  const cost = costs.length ? costs.reduce((s, c) => s + c, 0) : null;
  const attributed = stated + link;
  const eng = totalGain.likes + totalGain.comments + totalGain.shares + totalGain.saves;
  const kpis: Summary["kpis"] = {
    views: totalGain.views, views_prev: prevViews, videos: posted(since, until), videos_prev: posted(prevSince, since), signups: S.length, signups_prev: Sprev.length,
    signups_stated: stated, signups_link: link, signups_unknown: S.length - attributed, paid: paidAll.length, paid_prev: Sprev.filter((s) => s.paid).length, paid_attributed: paidAttr.length,
    conversion: S.length ? paidAll.length / S.length : null, conversion_attributed: attributed >= MIN_SIGNUPS ? paidAttr.length / attributed : null,
    net_usd: paidAttr.reduce((s, x) => s + x.net_usd, 0), engagement: rate(eng, totalGain.views),
    followers: accs.some((a) => a.followers != null) ? accs.reduce((s, a) => s + (a.followers ?? 0), 0) : null,
    followers_delta: accs.some((a) => a.followers_delta != null) ? accs.reduce((s, a) => s + (a.followers_delta ?? 0), 0) : null,
    cost_usd: cost, cpm_usd: cost != null && totalGain.views > 0 ? (cost / totalGain.views) * 1000 : null, cost_per_signup: cost != null && attributed > 0 ? cost / attributed : null, cost_per_paid: cost != null && paidAttr.length > 0 ? cost / paidAttr.length : null,
    ...(input.pulls ? (() => { const xs = input.pulls.filter((p) => inRange(p.at, since, until)); return { pull_calls: xs.length, pull_usd: Math.round(xs.reduce((s, p) => s + p.usd, 0) * 1e4) / 1e4 }; })() : {}),
  };
  // what is pulling views now: the biggest gains of the last 24 hours, with their pace
  const now = [...vids].filter((v) => v.velocity_24h > 0).sort((x, y) => y.velocity_24h - x.velocity_24h).slice(0, 8);
  // groups: a feature, an hour, a weekday, a length; each needs MIN_VIDEOS before it says anything
  const postedVids = vids.filter((v) => v.posted_at && inRange(v.posted_at, since, until));
  const by_feature = FEATURES.map(([feature, label]) => {
    const xs = vids.filter((v) => (v.feature ?? "none") === feature);
    const views = xs.reduce((s, v) => s + v.gain.views, 0), su = xs.reduce((s, v) => s + v.signups_stated + v.signups_link, 0), paid = xs.reduce((s, v) => s + v.paid, 0);
    return { feature, label, videos: xs.length, views, signups: su, paid, per_1k: views > 0 && xs.length >= MIN_VIDEOS ? (su / views) * 1000 : null, enough: xs.length >= MIN_VIDEOS };
  }).filter((f) => f.videos > 0);
  const group = <K,>(keys: K[], pick: (v: VideoOut) => K | null, label: (k: K) => any) => keys.map((k) => { const xs = postedVids.filter((v) => pick(v) === k); return { ...label(k), videos: xs.length, median_views: xs.length >= MIN_VIDEOS ? median(xs.map((v) => v.gain.views)) : null, enough: xs.length >= MIN_VIDEOS }; });
  const by_hour = group(Array.from({ length: 24 }, (_, i) => i), (v) => (v.posted_at ? localHour(Date.parse(v.posted_at), off) : null), (h) => ({ hour: h }));
  const by_weekday = group([0, 1, 2, 3, 4, 5, 6], (v) => (v.posted_at ? localWeekday(Date.parse(v.posted_at), off) : null), (d) => ({ day: d, label: DAYS[d] }));
  const by_length = group(LENGTHS.map((l) => l.key), (v) => (v.duration_s == null ? null : LENGTHS.find((l) => v.duration_s! >= l.from && v.duration_s! < l.to)?.key ?? null), (k) => { const l = LENGTHS.find((x) => x.key === k)!; return { key: l.key, label: l.label }; });
  const statedList = S.filter((s) => accountById(s) || s.heard_video).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 60).map((s) => { const a = accountById(s); return { at: s.created_at, handle: a?.handle ?? null, platform: a?.platform ?? (s.heard ?? null), video: s.heard_video ?? null, country: s.country, paid: s.paid }; });
  const tracking = accounts.map((a) => a.tracking_since).filter(Boolean).sort()[0] ?? null;
  if (vids.some((v) => v.gain.revised)) notes.push("A platform revised a count downward on at least one video; the drop was not subtracted.");
  if (!accounts.some((a) => a.cost_usd_per_video != null || a.cost_usd_per_month != null)) notes.push("No account has a cost yet, so CPM and cost per sign-up are blank. Set costs under Accounts.");
  return { range: { days: range.days, since: new Date(since).toISOString(), until: new Date(until).toISOString(), tracking_since: tracking }, kpis, daily, now, accounts: accs, videos: vids.sort((x, y) => y.gain.views - x.gain.views || (y.posted_at ?? "").localeCompare(x.posted_at ?? "")), stated: statedList, by_feature, by_hour, by_weekday, by_length, notes };
}

// ---------------------------------------------------------------------------------------------------
// Loading the rows
// ---------------------------------------------------------------------------------------------------
export type Loaded = { accounts: AccountRow[]; videos: VideoRow[]; snapshots: SnapshotRow[]; account_snapshots: AccountSnapshotRow[]; signups: SignupRow[]; pulls?: Array<{ at: string; usd: number }> };

/** Everything the summary needs. Snapshots are loaded whole (small for months: only changed readings are written). */
export async function loadContent(sb: SupabaseClient, opts: { since: number; isInternal: (email: string | null | undefined) => boolean }): Promise<Loaded> {
  const [acc, vid, asnap] = await Promise.all([
    sb.from("content_accounts").select("*").order("created_at"),
    sb.from("content_videos").select("*").order("posted_at", { ascending: false }).limit(5000),
    sb.from("content_account_snapshots").select("account_id,day,followers").order("day"),
  ]);
  for (const r of [acc, vid, asnap]) if (r.error) throw r.error;
  const snaps: SnapshotRow[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const r = await sb.from("content_snapshots").select("video_id,captured_at,views,likes,comments,shares,saves").order("captured_at", { ascending: true }).range(from, from + 999);
    if (r.error) throw r.error;
    snaps.push(...((r.data ?? []) as SnapshotRow[]));
    if ((r.data ?? []).length < 1000) break;
  }
  // sign-ups: the answers at sign-up, the plan, the first paid invoice and the net cash in (Stripe fee removed)
  const cust = await sb.from("studio_customers").select("user_id,created_at,onboarding,plan_id,status,stripe_customer_id,billing_source,owner_pass,country").gte("created_at", new Date(opts.since - 60 * DAY).toISOString()).order("created_at", { ascending: false }).limit(20000);
  if (cust.error) throw cust.error;
  const emails = new Map<string, string | null>();
  const admin: any = (sb as any).auth?.admin;
  if (admin?.listUsers) for (let page = 1; page <= 20; page++) {
    const r = await admin.listUsers({ page, perPage: 1000 }).catch(() => null);
    const users = r?.data?.users ?? [];
    for (const u of users) emails.set(u.id, u.email ?? null);
    if (users.length < 1000) break;
  }
  const ids = ((cust.data ?? []) as any[]).map((c) => c.stripe_customer_id).filter(Boolean);
  const paidAt = new Map<string, string>(), net = new Map<string, number>();
  if (ids.length) {
    const ev = await sb.from("studio_stripe_events").select("type,received_at,payload").eq("type", "invoice.paid").gte("received_at", new Date(opts.since - 60 * DAY).toISOString()).order("received_at").limit(20000);
    for (const e of (ev.data ?? []) as any[]) {
      const o = e.payload?.data?.object ?? {}, c = o.customer;
      if (!c || o.livemode === false) continue;
      const paid = Number(o.amount_paid ?? 0) / 100;
      if (!(paid > 0)) continue;
      if (!paidAt.has(c)) paidAt.set(c, e.received_at);
      net.set(c, (net.get(c) ?? 0) + paid * (1 - 0.029) - 0.3);
    }
  }
  const signups: SignupRow[] = ((cust.data ?? []) as any[]).map((c) => {
    const ob = c.onboarding ?? {}, email = emails.get(c.user_id) ?? null;
    const real = !!c.stripe_customer_id && paidAt.has(c.stripe_customer_id) || (c.billing_source === "apple" && ["active", "trialing", "past_due"].includes(String(c.status)));
    return { user_id: c.user_id, created_at: c.created_at, heard: ob.heard ?? null, heard_account: ob.heard_account ?? null, heard_video: ob.heard_video ?? null, utm_source: ob.attribution?.utm_source ?? null, country: c.country ?? null,
      paid: real && !c.owner_pass, paid_at: c.stripe_customer_id ? paidAt.get(c.stripe_customer_id) ?? null : null, net_usd: c.stripe_customer_id ? net.get(c.stripe_customer_id) ?? 0 : 0, internal: !!c.owner_pass || opts.isInternal(email) };
  });
  // what this page's readings cost (every ScrapeCreators call made for it is booked in studio_events with use=content)
  const ev2 = await sb.from("studio_events").select("created_at,usd").eq("kind", "vendor").eq("name", "scrapecreators").eq("props->>use", "content").gte("created_at", new Date(opts.since).toISOString()).order("created_at", { ascending: false }).limit(50000);
  const pulls = ((ev2.data ?? []) as any[]).map((e) => ({ at: e.created_at, usd: Number(e.usd) || 0 }));
  return { accounts: (acc.data ?? []) as AccountRow[], videos: (vid.data ?? []) as VideoRow[], snapshots: snaps, account_snapshots: (asnap.data ?? []) as AccountSnapshotRow[], signups, pulls };
}

/** The range from the page's "days" and the viewer's time zone: whole local days back from now ("all" = since tracking). */
/** A custom range: whole local days from `from` to `to` (YYYY-MM-DD, inclusive), capped at now. Null when the dates make no sense. */
export function rangeBetween(from: string, to: string, tz_offset_min: number, now = Date.now()): Range | null {
  const day = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "")); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - tz_offset_min * 60_000 : NaN; };
  const a = day(from), b = day(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > 400 * DAY) return null;
  const since = a, until = Math.min(b + DAY, now);
  if (until <= since) return null;
  return { days: Math.round((b - a) / DAY) + 1, since, until, tz_offset_min };
}

export function rangeFor(days: number | null, tz_offset_min: number, now = Date.now(), trackingSince: string | null = null, earliestPost: string | null = null): Range {
  const until = now;
  if (days == null) {
    const starts = [trackingSince, earliestPost].filter(Boolean).map((x) => Date.parse(x!)).filter(Number.isFinite);
    return { days: null, since: starts.length ? startOfLocalDay(Math.min(...starts), tz_offset_min) : now - 365 * DAY, until, tz_offset_min };
  }
  return { days, since: startOfLocalDay(now, tz_offset_min) - (days - 1) * DAY, until, tz_offset_min };
}

/** Public-safe view of an account for the question after sign-up. */
export function accountForSignup(a: AccountRow): { id: string; platform: string; handle: string; display_name: string | null; avatar_key: string | null } {
  return { id: a.id, platform: a.platform, handle: a.handle, display_name: a.display_name, avatar_key: a.avatar_key };
}

/** What the owner may set on an account; anything else is dropped. */
export function sanitizeAccountInput(input: any): Partial<AccountRow> | { error: string } {
  const out: Record<string, any> = {};
  if (input?.platform != null) { if (!(PLATFORMS as readonly string[]).includes(input.platform)) return { error: "invalid_platform" }; out.platform = input.platform; }
  if (input?.handle != null) { const h = String(input.handle).trim().replace(/^@/, ""); if (!/^[A-Za-z0-9._-]{1,64}$/.test(h)) return { error: "invalid_handle" }; out.handle = h; }
  if (input?.url != null) { const u = String(input.url).trim().slice(0, 300); if (u && !/^https:\/\/(www\.)?(tiktok\.com|instagram\.com|youtube\.com)\//.test(u)) return { error: "invalid_url" }; out.url = u || null; }
  if (input?.owner_kind != null) { if (!["ours", "creator"].includes(input.owner_kind)) return { error: "invalid_owner_kind" }; out.owner_kind = input.owner_kind; }
  for (const k of ["cost_usd_per_video", "cost_usd_per_month"]) if (k in (input ?? {})) { const v = input[k]; if (v === null || v === "") out[k] = null; else { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: `invalid_${k}` }; out[k] = Math.round(n * 100) / 100; } }
  if ("default_feature" in (input ?? {})) { const f = input.default_feature; if (f === null || f === "") out.default_feature = null; else if (FEATURE_IDS.has(String(f))) out.default_feature = String(f); else return { error: "invalid_feature" }; }
  if (input?.enabled != null) out.enabled = !!input.enabled;
  if (input?.count_history != null) out.count_history = !!input.count_history;
  return out;
}
/** A handle and platform from a pasted profile link, when the owner gives a link instead of a handle. */
export function parseProfileLink(s: string): { platform: Platform; handle: string } | null {
  const m = String(s ?? "").trim().match(/^https?:\/\/(?:www\.)?(tiktok\.com\/@|instagram\.com\/|youtube\.com\/@)([A-Za-z0-9._-]{1,64})/i);
  if (!m) return null;
  const platform: Platform = /tiktok/i.test(m[1]) ? "tiktok" : /instagram/i.test(m[1]) ? "instagram" : "youtube";
  return { platform, handle: m[2] };
}

// ---------------------------------------------------------------------------------------------------
// Keeping the readings table small
// ---------------------------------------------------------------------------------------------------
export const THIN_AFTER_DAYS = 7;
/** Of the readings older than a week, keep the last one of each video on each day and drop the rest; hourly detail stays for
 *  the week the page can show it by the hour. Returns how many rows went. */
export async function thinSnapshots(sb: SupabaseClient, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - THIN_AFTER_DAYS * DAY).toISOString();
  const old: Array<{ id: number; video_id: string; captured_at: string }> = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const r = await sb.from("content_snapshots").select("id,video_id,captured_at").lt("captured_at", cutoff).order("captured_at", { ascending: true }).range(from, from + 999);
    if (r.error) throw r.error;
    old.push(...((r.data ?? []) as any[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const keep = new Map<string, number>(); // video:day -> id of the last reading that day
  for (const s of old) keep.set(`${s.video_id}:${s.captured_at.slice(0, 10)}`, s.id);
  const keepIds = new Set(keep.values());
  const drop = old.filter((s) => !keepIds.has(s.id)).map((s) => s.id);
  for (let i = 0; i < drop.length; i += 500) {
    const r = await sb.from("content_snapshots").delete().in("id", drop.slice(i, i + 500));
    if (r.error) throw r.error;
  }
  return drop.length;
}
