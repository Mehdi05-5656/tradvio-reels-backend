// Clone8 Studio: performance of the person's own linked accounts.
//
// Collect: their recent posts on TikTok, Instagram and YouTube Shorts with public metrics (ScrapeCreators, by the handle
// they linked), followers per account, and a daily snapshot for growth. Thumbnails are copied into our storage because
// the platforms' image links expire. Posts made in Clone8 and sent through Publish are matched, so the dashboard can
// show what Clone8 originals do next to everything else.
//
// Analyze: plain arithmetic first (analyze()): each post against the person's own median on that platform, engagement,
// share and save rates, posting times, lengths, Clone8 or not. These numbers are the evidence; the AI overview
// (studio-insights.ts) only explains them, with the research playbook behind it.
import { OVERHEAD } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSocialProvider, type ProviderPost, type SocialAccount } from "./social-provider.js";

export const PERF_PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type PerfPlatform = (typeof PERF_PLATFORMS)[number];
const SC = "https://api.scrapecreators.com";

export type PerfPost = {
  platform: PerfPlatform; platform_post_id: string; url: string; caption: string | null; published_at: string | null; duration_s: number | null;
  thumb_url: string | null; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; extra?: Record<string, any>;
};
export type PerfProfile = { followers: number | null; avatar_url: string | null };
export type PerfDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void; now?: () => number };

const num = (v: any) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const isoSec = (s: any) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

// ---------------------------------------------------------------------------------------------------
// Reading the platforms (public data, by handle)
// ---------------------------------------------------------------------------------------------------
export function parseTikTokPosts(resp: any, handle: string): PerfPost[] {
  return ((resp?.aweme_list ?? []) as any[]).filter((a) => /^\d{5,30}$/.test(String(a?.aweme_id ?? ""))).map((a) => {
    const s = a.statistics ?? {}, v = a.video ?? {};
    const d = num(v.duration);
    return {
      platform: "tiktok" as const, platform_post_id: String(a.aweme_id), url: `https://www.tiktok.com/@${handle}/video/${a.aweme_id}`,
      caption: a.desc ?? null, published_at: isoSec(a.create_time), duration_s: d == null ? null : d > 1000 ? Math.round(d / 100) / 10 : d,
      thumb_url: v.cover?.url_list?.[0] ?? v.origin_cover?.url_list?.[0] ?? v.dynamic_cover?.url_list?.[0] ?? null,
      views: num(s.play_count), likes: num(s.digg_count), comments: num(s.comment_count), shares: num(s.share_count), saves: num(s.collect_count),
    };
  });
}
export function parseInstagramPosts(resp: any): PerfPost[] {
  return ((resp?.items ?? []) as any[]).map((x) => x?.media ?? x).filter((it) => /^[A-Za-z0-9_-]{5,64}$/.test(String(it?.code ?? "")) && (it.product_type === "clips" || it.media_type === 2)).map((it) => ({
    platform: "instagram" as const, platform_post_id: String(it.code), url: `https://www.instagram.com/reel/${it.code}/`,
    caption: typeof it.caption === "object" && it.caption ? it.caption.text ?? null : it.caption ?? null, published_at: isoSec(it.taken_at),
    duration_s: num(it.video_duration), thumb_url: it.image_versions2?.candidates?.[0]?.url ?? it.thumbnail_url ?? null,
    views: num(it.ig_play_count ?? it.play_count ?? it.view_count), likes: it.like_and_view_counts_disabled ? null : num(it.like_count),
    comments: num(it.comment_count), shares: num(it.reshare_count), saves: num(it.save_count),
  }));
}
export function parseYouTubeShorts(resp: any): PerfPost[] {
  return ((resp?.shorts ?? []) as any[]).filter((s) => s?.id).map((s) => ({
    platform: "youtube" as const, platform_post_id: String(s.id), url: `https://www.youtube.com/shorts/${s.id}`, caption: s.title ?? s.description ?? null,
    published_at: s.publishDate ? new Date(s.publishDate).toISOString() : null, duration_s: num(s.lengthSeconds ?? s.durationSeconds),
    thumb_url: s.thumbnail ?? null, views: num(s.viewCountInt), likes: num(s.likeCountInt), comments: num(s.commentCountInt), shares: null, saves: null,
  }));
}

async function scGet(deps: PerfDeps, path: string): Promise<any> {
  const key = (deps.env ?? process.env).SCRAPECREATORS_API_KEY;
  if (!key) throw new Error("metrics_unconfigured");
  const r = await (deps.fetch ?? fetch)(`${SC}${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  recordEvent({ kind: "vendor", name: "scrapecreators", usd: OVERHEAD.scrapecreators_usd_per_call, props: { path: path.split("?")[0], status: r.status, use: "performance" } });
  if (!r.ok) throw new Error(`metrics_http_${r.status}`);
  const b: any = await r.json();
  if (b?.success === false) throw new Error("metrics_unsuccessful");
  return b;
}

/** Up to `pages` pages of a handle's recent videos, and the account's followers. */
export async function readAccount(deps: PerfDeps, platform: PerfPlatform, handle: string, pages = 2): Promise<{ profile: PerfProfile; posts: PerfPost[] }> {
  const h = encodeURIComponent(handle.replace(/^@/, ""));
  const posts: PerfPost[] = [];
  let profile: PerfProfile = { followers: null, avatar_url: null };
  if (platform === "tiktok") {
    const p = await scGet(deps, `/v1/tiktok/profile?handle=${h}`).catch(() => null);
    profile = { followers: num(p?.stats?.followerCount ?? p?.statsV2?.followerCount ?? p?.user?.followerCount), avatar_url: p?.user?.avatarMedium ?? p?.user?.avatarThumb ?? null };
    let cursor: string | null = null;
    for (let i = 0; i < pages; i++) {
      const r = await scGet(deps, `/v3/tiktok/profile/videos?handle=${h}${cursor ? `&max_cursor=${encodeURIComponent(cursor)}` : ""}`);
      posts.push(...parseTikTokPosts(r, handle.replace(/^@/, "")));
      cursor = r?.has_more && r?.max_cursor ? String(r.max_cursor) : null;
      if (!cursor) break;
    }
  } else if (platform === "instagram") {
    const p = await scGet(deps, `/v1/instagram/profile?handle=${h}`).catch(() => null);
    profile = { followers: num(p?.data?.user?.edge_followed_by?.count), avatar_url: p?.data?.user?.profile_pic_url ?? null };
    let cursor: string | null = null;
    for (let i = 0; i < pages; i++) {
      const r = await scGet(deps, `/v1/instagram/user/reels?handle=${h}${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ""}`);
      posts.push(...parseInstagramPosts(r));
      cursor = r?.paging_info?.more_available && r?.paging_info?.max_id ? String(r.paging_info.max_id) : r?.more_available && r?.next_max_id ? String(r.next_max_id) : null;
      if (!cursor) break;
    }
  } else {
    const p = await scGet(deps, `/v1/youtube/channel?handle=${h}`).catch(() => null);
    profile = { followers: num(p?.subscriberCount), avatar_url: p?.avatar?.image?.sources?.at?.(-1)?.url ?? null };
    let token: string | null = null;
    for (let i = 0; i < pages; i++) {
      const r = await scGet(deps, `/v1/youtube/channel/shorts?handle=${h}&sort=newest${token ? `&continuationToken=${encodeURIComponent(token)}` : ""}`);
      posts.push(...parseYouTubeShorts(r));
      token = r?.continuationToken ? String(r.continuationToken) : null;
      if (!token) break;
    }
  }
  const seen = new Set<string>();
  return { profile, posts: posts.filter((x) => (seen.has(x.platform_post_id) ? false : (seen.add(x.platform_post_id), true))) };
}

/** The handle to read for a linked account: the network's own handle, never a display name. */
export function handleFor(a: SocialAccount): string | null {
  const u = String(a.username ?? "").trim().replace(/^@/, "");
  if (!u || /\s/.test(u)) return null;
  return u;
}

/** The platform post id inside a post link (for matching what was posted through Publish). */
export function postIdFromUrl(platform: string, url: string | null | undefined): string | null {
  const s = String(url ?? "");
  if (platform === "tiktok") return s.match(/\/video\/(\d{5,30})/)?.[1] ?? null;
  if (platform === "instagram") return s.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  if (platform === "youtube") return s.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,20})/)?.[1] ?? null;
  return null;
}

/** A provider post in the dashboard's shape; its network id comes from the post link so it matches public reads too. */
export function fromProvider(platform: PerfPlatform, x: ProviderPost): PerfPost | null {
  const id = postIdFromUrl(platform, x.url) ?? x.id;
  if (!id || !x.url) return null;
  return { platform, platform_post_id: id, url: x.url, caption: x.caption, published_at: x.published_at, duration_s: x.duration_s, thumb_url: x.thumb_url,
    views: x.views, likes: x.likes, comments: x.comments, shares: x.shares, saves: x.saves, extra: { ...Object.fromEntries(Object.entries(x.extra ?? {}).filter(([, v]) => v != null)), source: "provider" } };
}

// ---------------------------------------------------------------------------------------------------
// Refresh: read, store, match, snapshot
// ---------------------------------------------------------------------------------------------------
export const REFRESH_EVERY_MS = 6 * 3600_000;

const THUMB_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** One post's thumbnail kept in storage: https only, an image the overview can read, 5 MB at most. */
async function saveThumb(sb: SupabaseClient, f: typeof fetch, u: string, platform: string, postId: string, url: string): Promise<string | null> {
  try {
    if (typeof url !== "string" || new URL(url).protocol !== "https:") return null;
    const r = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok || (r.url && !r.url.startsWith("https://"))) return null;
    const type = String(r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!THUMB_TYPES.includes(type)) return null;
    if (Number(r.headers.get("content-length") ?? 0) > 5_000_000) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5_000_000) return null;
    const key = `${u}/perf/${platform}/${postId.replace(/[^\w-]/g, "_").slice(0, 80)}.jpg`;
    const up = await sb.storage.from("studio-outputs").upload(key, buf, { contentType: type, upsert: true });
    return up.error ? null : key;
  } catch { return null; } // the post shows without its picture
}

export async function refreshPerformance(sb: SupabaseClient, u: string, deps: PerfDeps = {}): Promise<{ platforms: string[]; posts: number; errors: string[] }> {
  const log = deps.log ?? ((s: string) => console.log(s)), f = deps.fetch ?? fetch;
  const now = new Date(deps.now?.() ?? Date.now());
  const prof = await sb.from("studio_social_profiles").select("accounts,profile_key").eq("user_id", u).maybeSingle();
  if (prof.error) throw prof.error;
  const accounts = ((prof.data?.accounts ?? []) as SocialAccount[]).filter((a) => (PERF_PLATFORMS as readonly string[]).includes(a.platform));
  const out = { platforms: [] as string[], posts: 0, errors: [] as string[] };
  // what was posted through Publish, by network post id
  const sp = await sb.from("studio_social_posts").select("id,job_id,results").eq("user_id", u).in("status", ["posted", "partial"]).limit(500);
  const made = new Map<string, { id: string; job_id: string | null }>();
  for (const row of (sp.data ?? []) as any[]) for (const r of row.results ?? []) { const pid = postIdFromUrl(r.platform, r.url); if (pid) made.set(`${r.platform}:${pid}`, { id: row.id, job_id: row.job_id }); }
  // the posting provider's private analytics first (reach, watch time, retention); public numbers when it has none
  const provider = prof.data?.profile_key ? getSocialProvider({ env: deps.env, fetch: deps.fetch, log }) : null;
  const stats = provider?.accountStats ? await provider.accountStats(prof.data!.profile_key, accounts.map((a) => a.platform)).catch(() => []) : [];
  for (const a of accounts) {
    const handle = handleFor(a) ?? a.platform;
    const platform = a.platform as PerfPlatform;
    try {
      let read: { profile: PerfProfile; posts: PerfPost[] } | null = null;
      if (provider?.recentPosts) {
        try {
          const pp = await provider.recentPosts(prof.data!.profile_key, platform, 60);
          const st = stats.find((x) => x.platform === platform);
          if (pp.length) read = { profile: { followers: st?.followers ?? null, avatar_url: a.image_url ?? null }, posts: pp.map((x) => fromProvider(platform, x)).filter(Boolean) as PerfPost[] };
        } catch (e: any) { log(`[performance] ${u} ${platform} provider: ${String(e?.message ?? e).slice(0, 120)}`); }
      }
      if (!read) {
        if (!handleFor(a)) throw new Error("no handle to read");
        read = await readAccount(deps, platform, handleFor(a)!);
        const st = stats.find((x) => x.platform === platform);
        if (st?.followers != null) read.profile.followers = st.followers;
      }
      const { profile, posts } = read;
      const have = await sb.from("studio_perf_posts").select("platform_post_id,thumb_key").eq("user_id", u).eq("platform", platform);
      const thumbs = new Map(((have.data ?? []) as any[]).map((x) => [x.platform_post_id, x.thumb_key]));
      // one row per post (the same post listed twice would make the upsert refuse the whole batch)
      const uniq = [...new Map(posts.map((p) => [p.platform_post_id, p])).values()].slice(0, 80);
      // thumbnails: a few at a time, images only (the overview sends them to the model; a video or HEIC file would fail it)
      const want = uniq.filter((p) => !thumbs.get(p.platform_post_id) && p.thumb_url);
      for (let i = 0; i < want.length; i += 6) {
        await Promise.all(want.slice(i, i + 6).map(async (p) => {
          const key = await saveThumb(sb, f, u, platform, p.platform_post_id, p.thumb_url!);
          if (key) thumbs.set(p.platform_post_id, key);
        }));
      }
      const rows = [];
      for (const p of uniq) {
        const thumb_key = thumbs.get(p.platform_post_id) ?? null;
        const m = made.get(`${platform}:${p.platform_post_id}`);
        rows.push({ user_id: u, platform, platform_post_id: p.platform_post_id, url: p.url, caption: p.caption?.slice(0, 2200) ?? null, published_at: p.published_at, duration_s: p.duration_s, thumb_key,
          views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, extra: p.extra ?? {}, refreshed_at: now.toISOString(), ...(m ? { social_post_id: m.id, job_id: m.job_id } : {}) });
      }
      if (rows.length) { const w = await sb.from("studio_perf_posts").upsert(rows, { onConflict: "user_id,platform,platform_post_id" }); if (w.error) throw w.error; }
      await sb.from("studio_perf_accounts").upsert({ user_id: u, platform, handle, followers: profile.followers, refreshed_at: now.toISOString(), error: null }, { onConflict: "user_id,platform" });
      const views_total = posts.reduce((s, p) => s + (p.views ?? 0), 0);
      await sb.from("studio_perf_snapshots").upsert({ user_id: u, platform, day: now.toISOString().slice(0, 10), followers: profile.followers, views_total, posts: posts.length }, { onConflict: "user_id,platform,day" });
      out.platforms.push(platform); out.posts += rows.length;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 160);
      out.errors.push(`${platform}: ${msg}`);
      await sb.from("studio_perf_accounts").upsert({ user_id: u, platform, handle, refreshed_at: now.toISOString(), error: msg }, { onConflict: "user_id,platform" });
      log(`[performance] ${u} ${platform} ${msg}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Analyze: the evidence
// ---------------------------------------------------------------------------------------------------
export type PostRow = {
  id: string; platform: string; platform_post_id: string; url: string; caption: string | null; published_at: string | null; duration_s: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; social_post_id?: string | null; job_id?: string | null; extra?: any;
};
export type PostStats = PostRow & { er: number | null; share_rate: number | null; save_rate: number | null; comment_rate: number | null; multiple: number | null; clone8: boolean;
  /** share of viewers still watching at 3 s, share of the length watched on average, shares per account reached (where reported) */
  hold_3s: number | null; watch_pct: number | null; full_watch_rate: number | null; reach: number | null; shares_per_reach: number | null };
export type Bucket = { key: string; label: string; n: number; median_multiple: number | null; median_views: number | null };
export type Analysis = {
  range_days: number; posts: PostStats[];
  kpis: { views: number; views_prev: number; posts: number; posts_prev: number; median_views: number | null; er: number | null; er_prev: number | null; shares: number; share_rate: number | null; saves: number; comments: number; likes: number };
  followers: Array<{ platform: string; now: number | null; delta: number | null }>;
  series: Array<{ day: string; views: number; posts: number }>;
  top: string[]; breakouts: string[]; low: string[];
  by_time: Bucket[]; by_weekday: Bucket[]; by_length: Bucket[];
  clone8: { n: number; median_multiple: number | null; others_median_multiple: number | null };
  facts: string[];
};

export const median = (xs: number[]): number | null => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const rate = (n: number | null | undefined, d: number | null | undefined) => (d && d > 0 && n != null ? n / d : null);
const pct = (x: number | null, digits = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(digits)}%`);
const times = (x: number | null) => (x == null ? "n/a" : `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}×`);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const TIME_BLOCKS = [{ key: "night", label: "12–6 AM", from: 0, to: 6 }, { key: "morning", label: "6–11 AM", from: 6, to: 11 }, { key: "midday", label: "11 AM–2 PM", from: 11, to: 14 }, { key: "afternoon", label: "2–6 PM", from: 14, to: 18 }, { key: "evening", label: "6–9 PM", from: 18, to: 21 }, { key: "late", label: "9 PM–12 AM", from: 21, to: 24 }];
const LENGTHS = [{ key: "s15", label: "Under 15 s", from: 0, to: 15 }, { key: "s30", label: "15–30 s", from: 15, to: 30 }, { key: "s60", label: "30–60 s", from: 30, to: 60 }, { key: "s180", label: "1–3 min", from: 60, to: 180 }, { key: "long", label: "Over 3 min", from: 180, to: 1e9 }];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local hour and weekday of a time, at a UTC offset in minutes (the person's time zone). */
function local(iso: string, offsetMin: number) { const d = new Date(Date.parse(iso) + offsetMin * 60_000); return { hour: d.getUTCHours(), day: d.getUTCDay(), date: d.toISOString().slice(0, 10) }; }

export function analyze(rows: PostRow[], snapshots: Array<{ platform: string; day: string; followers: number | null }>, opts: { range_days: number; now: number; offset_min: number; platform?: string | null }): Analysis {
  const { range_days, now, offset_min } = opts;
  const from = now - range_days * 86400_000, prevFrom = from - range_days * 86400_000;
  const scoped = rows.filter((r) => !opts.platform || r.platform === opts.platform);
  // each post against the person's own median on its platform (the last 90 days of posts, so one viral month does not skew it)
  const base = new Map<string, number | null>();
  for (const p of new Set(scoped.map((r) => r.platform))) base.set(p, median(scoped.filter((r) => r.platform === p && r.views != null && r.published_at && Date.parse(r.published_at) > now - 90 * 86400_000).map((r) => r.views!)));
  const stats: PostStats[] = scoped.map((r) => {
    const eng = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (r.saves ?? 0);
    const b = base.get(r.platform);
    const x = r.extra ?? {};
    const watch = x.avg_view_pct != null ? Number(x.avg_view_pct) / 100 : x.avg_watch_s != null && r.duration_s ? Math.min(1.5, Number(x.avg_watch_s) / Number(r.duration_s)) : null;
    const fwr = x.full_watch_rate == null ? null : Number(x.full_watch_rate) > 1.5 ? Number(x.full_watch_rate) / 100 : Number(x.full_watch_rate);
    return { ...r, er: rate(eng, r.views), share_rate: rate(r.shares, r.views), save_rate: rate(r.saves, r.views), comment_rate: rate(r.comments, r.views), multiple: b && r.views != null ? r.views / b : null, clone8: !!r.social_post_id,
      hold_3s: x.hold_3s == null ? null : Number(x.hold_3s), watch_pct: watch, full_watch_rate: fwr, reach: x.reach == null ? null : Number(x.reach), shares_per_reach: rate(r.shares, x.reach == null ? null : Number(x.reach)) };
  });
  const inRange = stats.filter((r) => r.published_at && Date.parse(r.published_at) >= from && Date.parse(r.published_at) <= now);
  const prev = stats.filter((r) => r.published_at && Date.parse(r.published_at) >= prevFrom && Date.parse(r.published_at) < from);
  const sum = (xs: PostStats[], k: keyof PostStats) => xs.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const erOf = (xs: PostStats[]) => { const v = sum(xs, "views"); return v ? (sum(xs, "likes") + sum(xs, "comments") + sum(xs, "shares") + sum(xs, "saves")) / v : null; };
  const kpis = {
    views: sum(inRange, "views"), views_prev: sum(prev, "views"), posts: inRange.length, posts_prev: prev.length,
    median_views: median(inRange.map((r) => r.views ?? NaN)), er: erOf(inRange), er_prev: erOf(prev),
    shares: sum(inRange, "shares"), share_rate: rate(sum(inRange, "shares"), sum(inRange.filter((r) => r.shares != null), "views")), saves: sum(inRange, "saves"), comments: sum(inRange, "comments"), likes: sum(inRange, "likes"),
  };
  // followers now and change over the range, from the daily snapshots
  const followers = [...new Set(snapshots.map((s) => s.platform))].filter((p) => !opts.platform || p === opts.platform).map((p) => {
    const xs = snapshots.filter((s) => s.platform === p && s.followers != null).sort((a, b) => a.day.localeCompare(b.day));
    // the change over the window: from the last snapshot before it starts (or its first day), to the latest
    const last = xs.at(-1) ?? null, first = [...xs].reverse().find((s) => Date.parse(s.day) <= from) ?? xs.find((s) => Date.parse(s.day) >= from) ?? null;
    return { platform: p, now: last?.followers ?? null, delta: last && first && first !== last ? (last.followers ?? 0) - (first.followers ?? 0) : null };
  });
  const series: Array<{ day: string; views: number; posts: number }> = [];
  for (let t = from; t <= now; t += 86400_000) series.push({ day: local(new Date(t).toISOString(), offset_min).date, views: 0, posts: 0 });
  for (const r of inRange) { const d = local(r.published_at!, offset_min).date; const s = series.find((x) => x.day === d); if (s) { s.views += r.views ?? 0; s.posts += 1; } }
  const ranked = [...inRange].filter((r) => r.multiple != null).sort((a, b) => (b.multiple! - a.multiple!) || ((b.er ?? 0) - (a.er ?? 0)));
  const bucket = (defs: Array<{ key: string; label: string }>, pick: (r: PostStats) => string | null): Bucket[] => defs.map((d) => {
    const xs = inRange.filter((r) => pick(r) === d.key);
    return { key: d.key, label: d.label, n: xs.length, median_multiple: median(xs.map((r) => r.multiple ?? NaN)), median_views: median(xs.map((r) => r.views ?? NaN)) };
  });
  const by_time = bucket(TIME_BLOCKS, (r) => { if (!r.published_at) return null; const h = local(r.published_at, offset_min).hour; return TIME_BLOCKS.find((b) => h >= b.from && h < b.to)?.key ?? null; });
  const by_weekday = bucket(DAYS.map((d, i) => ({ key: String(i), label: d })), (r) => (r.published_at ? String(local(r.published_at, offset_min).day) : null));
  const by_length = bucket(LENGTHS, (r) => (r.duration_s == null ? null : LENGTHS.find((b) => r.duration_s! >= b.from && r.duration_s! < b.to)?.key ?? null));
  const c8 = inRange.filter((r) => r.clone8), others = inRange.filter((r) => !r.clone8);
  const clone8 = { n: c8.length, median_multiple: median(c8.map((r) => r.multiple ?? NaN)), others_median_multiple: median(others.map((r) => r.multiple ?? NaN)) };

  // Facts: one line each, numbers only, for the overview and the chat. Buckets need 3 posts before they say anything.
  const facts: string[] = [];
  facts.push(`${range_days}-day window: ${kpis.posts} posts, ${fmt(kpis.views)} views (previous ${range_days} days: ${kpis.posts_prev} posts, ${fmt(kpis.views_prev)} views); median ${kpis.median_views == null ? "n/a" : fmt(kpis.median_views)} views a post; engagement ${pct(kpis.er)} (previous ${pct(kpis.er_prev)}); share rate ${pct(kpis.share_rate, 2)}.`);
  for (const fo of followers) if (fo.now != null) facts.push(`${fo.platform} followers: ${fmt(fo.now)}${fo.delta != null ? ` (${fo.delta >= 0 ? "+" : ""}${fmt(fo.delta)} in the window)` : ""}.`);
  const ok = (b: Bucket[]) => b.filter((x) => x.n >= 3 && x.median_multiple != null).sort((p, q) => q.median_multiple! - p.median_multiple!);
  const t = ok(by_time); if (t.length >= 2) facts.push(`Posting time: ${t[0].label} posts get ${times(t[0].median_multiple)} the usual views (n=${t[0].n}); ${t.at(-1)!.label} gets ${times(t.at(-1)!.median_multiple)} (n=${t.at(-1)!.n}).`);
  const w = ok(by_weekday); if (w.length >= 2) facts.push(`Weekday: ${w[0].label} posts ${times(w[0].median_multiple)} (n=${w[0].n}), ${w.at(-1)!.label} ${times(w.at(-1)!.median_multiple)} (n=${w.at(-1)!.n}).`);
  const l = ok(by_length); if (l.length >= 2) facts.push(`Length: ${l[0].label} ${times(l[0].median_multiple)} the usual views (n=${l[0].n}); ${l.at(-1)!.label} ${times(l.at(-1)!.median_multiple)} (n=${l.at(-1)!.n}).`);
  if (c8.length >= 2 && others.length >= 2) facts.push(`Made with Clone8: ${c8.length} posts at ${times(clone8.median_multiple)} the usual views, against ${times(clone8.others_median_multiple)} for the other ${others.length}.`);
  const breakouts = ranked.filter((r) => (r.multiple ?? 0) >= 3);
  if (breakouts.length) facts.push(`${breakouts.length} breakout post${breakouts.length > 1 ? "s" : ""} (3× the usual or more): ${breakouts.slice(0, 3).map((r) => `${r.platform} "${(r.caption ?? "").slice(0, 50)}" ${times(r.multiple)}`).join("; ")}.`);
  const shareTop = [...inRange].filter((r) => r.share_rate != null && (r.views ?? 0) > 0).sort((a, b) => b.share_rate! - a.share_rate!)[0];
  if (shareTop && kpis.share_rate) facts.push(`Most shared for its views: "${(shareTop.caption ?? "").slice(0, 50)}" at ${pct(shareTop.share_rate, 2)} shares per view, ${times(shareTop.share_rate / kpis.share_rate)} the account's rate.`);
  // how much of the video people watch: the strongest signal the networks name; compare their best posts with the rest
  const cmp = (k: "hold_3s" | "watch_pct" | "full_watch_rate" | "shares_per_reach", label: string) => {
    // only posts that report this number; their top quarter (at least 3) against the rest
    const withK = ranked.filter((r) => r[k] != null), topSet = withK.slice(0, Math.max(3, Math.ceil(withK.length / 4))), rest = withK.slice(topSet.length);
    const a1 = median(topSet.map((r) => r[k] as number)), a2 = median(rest.map((r) => r[k] as number));
    const n1 = topSet.length, n2 = rest.length;
    if (a1 != null && a2 != null && n1 >= 3 && n2 >= 3) facts.push(`${label}: ${pct(a1, k === "shares_per_reach" ? 2 : 0)} on their best posts (n=${n1}) against ${pct(a2, k === "shares_per_reach" ? 2 : 0)} on the rest (n=${n2}).`);
  };
  cmp("hold_3s", "Still watching at 3 seconds"); cmp("watch_pct", "Share of the video watched on average"); cmp("full_watch_rate", "Watched to the end"); cmp("shares_per_reach", "Shares per account reached");
  const fyp = median(inRange.map((r) => Number(r.extra?.fyp_share ?? NaN)));
  if (fyp != null) facts.push(`On TikTok, ${fyp > 1.5 ? fyp.toFixed(0) : (fyp * 100).toFixed(0)}% of views come from the For You feed (median per post).`);
  const subs = inRange.reduce((s2, r) => s2 + (Number(r.extra?.subscribers_gained) || 0), 0);
  if (subs > 0) facts.push(`YouTube Shorts in the window brought ${subs} new subscribers.`);
  // how often they break out against their own top tenth (posting more raises the tail, not the typical post: Buffer)
  const p90 = (() => { const v = stats.filter((r) => r.views != null).map((r) => r.views!).sort((x, y) => x - y); return v.length >= 10 ? v[Math.floor(v.length * 0.9)] : null; })();
  if (p90 != null && inRange.length >= 5) { const out = inRange.filter((r) => (r.views ?? 0) > p90).length; facts.push(`Beat their own top-10% mark (${fmt(p90)} views) on ${out} of ${inRange.length} posts in the window.`); }
  const rewatch = median(inRange.filter((r) => r.reach && r.views).map((r) => r.views! / r.reach!));
  if (rewatch != null && inRange.filter((r) => r.reach).length >= 3) facts.push(`Views per account reached: ${rewatch.toFixed(2)} (above 1 means people replay).`);
  const engaged = median(inRange.filter((r) => r.extra?.engaged_views != null && r.views).map((r) => Number(r.extra!.engaged_views) / r.views!));
  if (engaged != null) facts.push(`YouTube engaged views are ${(engaged * 100).toFixed(0)}% of views (the rest swiped away quickly).`);
  const perWeek = kpis.posts / (range_days / 7); facts.push(`Posting pace: ${perWeek.toFixed(1)} posts a week${kpis.posts_prev ? ` (previous window ${(kpis.posts_prev / (range_days / 7)).toFixed(1)})` : ""}.`);

  return { range_days, posts: stats, kpis, followers, series, top: ranked.slice(0, 8).map((r) => r.id), breakouts: breakouts.map((r) => r.id), low: ranked.slice(-3).reverse().filter((r) => (r.multiple ?? 1) < 0.7).map((r) => r.id), by_time, by_weekday, by_length, clone8, facts };
}
