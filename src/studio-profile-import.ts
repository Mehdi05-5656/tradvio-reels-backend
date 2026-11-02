// Clone8 Studio: Import from an account. Paste a public TikTok or Instagram profile link; the posts are listed with their
// numbers (views, likes, date, length) one page at a time from ScrapeCreators, and the person picks which to bring in.
// The picked posts go through the ordinary Import job as links, so the price per link, the refunds and the collection
// are the same as for pasted links. Listing is free to the person (we pay about a fifth of a cent a page), capped per day.
// The person confirms they own, manage or have permission for the account before an import starts (dashboard).
import type { SupabaseClient } from "@supabase/supabase-js";
import { ClipsError } from "./studio-clips.js";
import { recordEvent } from "./studio-events.js";
import { OVERHEAD } from "./studio-pricing.js";

export type ProfilePlatform = "tiktok" | "instagram";
export type ProfileRef = { platform: ProfilePlatform; handle: string; url: string };
export type ProfilePost = {
  id: string; url: string; caption: string | null; posted_at: string | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null;
  seconds: number | null; thumbnail_url: string | null; pinned: boolean;
};
export type ProfilePage = { profile: ProfileRef; posts: ProfilePost[]; next: string | null };
export const PROFILE_LIMITS = { pages_per_day: 120, max_cursor: 200 };
const SC = "https://api.scrapecreators.com";

/** A TikTok or Instagram profile link (or @handle on either host) to its platform and handle; a post link is refused. */
export function profileRef(raw: string): ProfileRef {
  const s = String(raw ?? "").trim();
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new ClipsError("profile_link_invalid", "Paste a TikTok or Instagram profile link", 400); }
  const h = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (h === "tiktok.com" || h.endsWith(".tiktok.com")) {
    const first = parts[0] ?? "";
    if (!first.startsWith("@")) throw new ClipsError("profile_link_invalid", "Paste the profile link (tiktok.com/@name)", 400);
    if (parts.length > 1) throw new ClipsError("profile_link_invalid", "That is a post; paste the profile link (tiktok.com/@name)", 400);
    const handle = first.slice(1).toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(handle)) throw new ClipsError("profile_link_invalid", "That TikTok name does not look right", 400);
    return { platform: "tiktok", handle, url: `https://www.tiktok.com/@${handle}` };
  }
  if (h === "instagram.com" || h.endsWith(".instagram.com")) {
    const first = (parts[0] ?? "").replace(/^@/, "").toLowerCase();
    if (!first || ["p", "reel", "reels", "tv", "explore", "stories", "accounts"].includes(first)) throw new ClipsError("profile_link_invalid", "That is a post; paste the profile link (instagram.com/name)", 400);
    if (parts.length > 1 && !["reels", "tagged"].includes(parts[1])) throw new ClipsError("profile_link_invalid", "Paste the profile link (instagram.com/name)", 400);
    if (!/^[a-z0-9._]{1,30}$/.test(first)) throw new ClipsError("profile_link_invalid", "That Instagram name does not look right", 400);
    return { platform: "instagram", handle: first, url: `https://www.instagram.com/${first}/` };
  }
  throw new ClipsError("profile_link_invalid", "Paste a TikTok or Instagram profile link", 400);
}

/** The account a post link belongs to, when the link carries it (TikTok does; Instagram post links do not). */
export function profileOfPost(url: string): { platform: ProfilePlatform; handle: string } | null {
  const m = String(url).match(/tiktok\.com\/@([A-Za-z0-9._]{1,30})\/video\//i);
  return m ? { platform: "tiktok", handle: m[1].toLowerCase() } : null;
}
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => { const x = Number(v); return Number.isFinite(x) && x > 0 ? new Date((x < 1e12 ? x * 1000 : x)).toISOString() : null; };
const firstUrl = (...cands: unknown[]): string | null => { for (const c of cands) { if (typeof c === "string" && /^https?:\/\//.test(c)) return c; if (Array.isArray(c) && typeof c[0] === "string" && /^https?:\/\//.test(c[0])) return c[0]; } return null; };

/** ScrapeCreators' TikTok profile page (`aweme_list`) to posts; photo posts are left out (Import takes videos). */
export function tiktokPosts(resp: any, handle: string): { posts: ProfilePost[]; next: string | null } {
  const posts: ProfilePost[] = [];
  for (const a of resp?.aweme_list ?? []) {
    const id = typeof a?.aweme_id === "string" && /^\d{5,30}$/.test(a.aweme_id) ? a.aweme_id : null;
    if (!id || a.image_post_info) continue;
    const s = a.statistics ?? {}, v = a.video ?? {};
    const ms = n(v.duration);
    posts.push({
      id, url: `https://www.tiktok.com/@${handle}/video/${id}`, caption: typeof a.desc === "string" ? a.desc.slice(0, 500) : null, posted_at: iso(a.create_time),
      views: n(s.play_count), likes: n(s.digg_count), comments: n(s.comment_count), shares: n(s.share_count),
      seconds: ms == null ? null : Math.round((ms > 1000 ? ms / 1000 : ms) * 10) / 10,
      thumbnail_url: firstUrl(v.cover?.url_list, v.origin_cover?.url_list, v.dynamic_cover?.url_list, a.cover), pinned: Number(a.is_top) === 1,
    });
  }
  return { posts, next: resp?.has_more && resp?.max_cursor ? String(resp.max_cursor) : null };
}
/** ScrapeCreators' Instagram posts page (`items`) to posts; pictures and carousels are left out (Import takes videos). */
export function instagramPosts(resp: any): { posts: ProfilePost[]; next: string | null } {
  const posts: ProfilePost[] = [];
  for (const it of resp?.items ?? []) {
    const code = typeof it?.code === "string" && /^[A-Za-z0-9_-]{5,64}$/.test(it.code) ? it.code : null;
    if (!code) continue;
    const video = it.media_type === 2 || it.product_type === "clips" || it.product_type === "igtv" || !!it.video_duration;
    if (!video) continue;
    const reel = it.product_type === "clips" || it.media_type === 2;
    posts.push({
      id: code, url: `https://www.instagram.com/${reel ? "reel" : "p"}/${code}/`,
      caption: typeof it.caption === "object" && it.caption ? (typeof it.caption.text === "string" ? it.caption.text.slice(0, 500) : null) : typeof it.caption === "string" ? it.caption.slice(0, 500) : null,
      posted_at: iso(it.taken_at), views: n(it.ig_play_count ?? it.play_count ?? it.view_count), likes: it.like_and_view_counts_disabled ? null : n(it.like_count),
      comments: n(it.comment_count), shares: n(it.reshare_count), seconds: n(it.video_duration) == null ? null : Math.round(Number(it.video_duration) * 10) / 10,
      thumbnail_url: firstUrl(it.thumbnail_url, it.image_versions2?.candidates?.map((c: any) => c?.url), it.display_url), pinned: Array.isArray(it.timeline_pinned_user_ids) && it.timeline_pinned_user_ids.length > 0,
    });
  }
  return { posts, next: resp?.more_available && resp?.next_max_id ? String(resp.next_max_id) : null };
}

export type ProfileDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (l: string) => void };
/** One page of a profile's posts. Counted per person per day (PROFILE_LIMITS.pages_per_day) and as a vendor cost. */
export async function listProfilePage(sb: SupabaseClient, deps: ProfileDeps, u: string, p: { url: unknown; cursor?: unknown }): Promise<ProfilePage> {
  const env = deps.env ?? process.env;
  const key = env.SCRAPECREATORS_API_KEY;
  if (!key) throw new ClipsError("import_unavailable", "Importing from an account is not switched on", 503);
  const profile = profileRef(String(p.url ?? ""));
  const cursor = typeof p.cursor === "string" && p.cursor && /^[A-Za-z0-9_=.:-]{1,200}$/.test(p.cursor) ? p.cursor : null;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const used = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "profile_list").gte("created_at", since);
  if ((used.count ?? 0) >= PROFILE_LIMITS.pages_per_day) throw new ClipsError("profile_rate_limited", "That is a lot of account pages for one day; try again tomorrow", 429);
  const h = encodeURIComponent(profile.handle);
  const path = profile.platform === "instagram"
    ? `/v2/instagram/user/posts?handle=${h}${cursor ? `&next_max_id=${encodeURIComponent(cursor)}` : ""}`
    : `/v3/tiktok/profile/videos?handle=${h}${cursor ? `&max_cursor=${encodeURIComponent(cursor)}` : ""}`;
  const r = await (deps.fetch ?? fetch)(`${SC}${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  recordEvent({ user_id: u, kind: "vendor", name: "scrapecreators", usd: OVERHEAD.scrapecreators_usd_per_call, props: { path: path.split("?")[0], status: r.status, use: "profile_import" } });
  recordEvent({ user_id: u, kind: "feature", name: "profile_list", props: { platform: profile.platform, handle: profile.handle, page: cursor ? "more" : "first" } });
  if (r.status === 402) throw new ClipsError("import_unavailable", "The account reader is out of credit; try again later", 503);
  if (r.status === 404) throw new ClipsError("profile_not_found", "No public account with that name", 404);
  if (!r.ok) throw new ClipsError("profile_fetch_failed", `The account could not be read right now (${r.status})`, 502, true);
  const body: any = await r.json().catch(() => null);
  if (!body || body.success === false) throw new ClipsError("profile_fetch_failed", "The account could not be read right now", 502, true);
  const page = profile.platform === "instagram" ? instagramPosts(body) : tiktokPosts(body, profile.handle);
  if (!page.posts.length && !cursor && !page.next) {
    const priv = body?.is_private || body?.user?.is_private || body?.data?.user?.is_private;
    throw new ClipsError(priv ? "profile_private" : "profile_empty", priv ? "That account is private" : "No videos were found on that account", 404);
  }
  deps.log?.(`[import] profile ${JSON.stringify({ user: u, platform: profile.platform, handle: profile.handle, posts: page.posts.length, more: !!page.next })}`);
  return { profile, posts: page.posts, next: page.next };
}
