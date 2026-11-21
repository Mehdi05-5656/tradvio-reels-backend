// Clone8 Studio, Live Clips: how the server reads Twitch and Kick (docs/live-clips/RESEARCH.md section 2).
//
// Twitch: the official Helix API with an app token (listings, a channel's past broadcasts, top live streams) and the
// web player's two doors for the bytes nothing official gives: the VOD playlist through yt-dlp, and the chat replay
// through the same query TwitchDownloaderCLI sends. Kick: the official public API with an app token for the live
// listing, and the site's own JSON (channel, past broadcasts, a broadcast's playlist, the chat replay) read with curl,
// because Cloudflare refuses Node's own TLS handshake while curl's passes (probe of Nov 18 2026, from Render too).
// Neither needs the residential proxy from Render. Nothing here stores media: playlists are addresses, chat is counted
// and dropped by the caller.
import { spawn } from "node:child_process";
import { ensureYtDlp } from "./studio-youtube.js";

export type LiveDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (l: string) => void };
export class LiveSourceError extends Error { constructor(public code: string, message: string, public status = 400, public retry = false) { super(message); } }
/** One chat message, reduced: seconds into the broadcast, who (an id), the text, how many emotes it carried. */
export type ChatMsg = { t: number; u: string; c: string; e: number };
export type Platform = "twitch" | "kick";
export type Broadcast = { platform: Platform; id: string; url: string; title: string; channel: string; login: string; channel_id: string; seconds: number; started_at: string; views: number | null; thumbnail_url: string | null;
  /** the recording of the stream that is on right now (Twitch keeps writing it; its length is the stream so far) */ live?: boolean };
export type LiveStream = { platform: Platform; login: string; channel: string; channel_id: string; title: string; category: string | null; viewers: number; started_at: string | null; language: string | null; thumbnail_url: string | null; url: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const f = (deps: LiveDeps) => deps.fetch ?? fetch;
const e = (deps: LiveDeps) => deps.env ?? process.env;
/** yt-dlp's choice of Twitch rung for cutting: the biggest at or under `h` lines, 60 fps first. */
export const twitchCutFormat = (h: number) => (h >= 1080 ? "1080p60/1080p30/1080p/720p60/720p30/720p/480p/best" : "720p60/720p30/720p/480p/best");

// ---------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------
export type StreamLink = { platform: Platform; kind: "channel" | "vod"; login: string | null; id: string | null; url: string };
/** A Twitch or Kick link: a channel (twitch.tv/name, kick.com/name) or a past broadcast (twitch.tv/videos/123,
 *  kick.com/name/videos/<uuid>). Anything else is null. */
export function parseStreamLink(raw: unknown): StreamLink | null {
  let u: URL; try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "twitch.tv") {
    if (parts[0] === "videos" && /^\d{6,12}$/.test(parts[1] ?? "")) return { platform: "twitch", kind: "vod", login: null, id: parts[1], url: `https://www.twitch.tv/videos/${parts[1]}` };
    if (parts.length >= 3 && parts[1] === "video" && /^\d{6,12}$/.test(parts[2])) return { platform: "twitch", kind: "vod", login: parts[0].toLowerCase(), id: parts[2], url: `https://www.twitch.tv/videos/${parts[2]}` };
    if (parts.length === 1 && /^[a-z0-9_]{3,25}$/i.test(parts[0]) && !["directory", "videos", "p", "settings", "downloads"].includes(parts[0].toLowerCase())) return { platform: "twitch", kind: "channel", login: parts[0].toLowerCase(), id: null, url: `https://www.twitch.tv/${parts[0].toLowerCase()}` };
    return null;
  }
  if (host === "kick.com") {
    if (parts.length === 1 && /^[a-z0-9_-]{2,40}$/i.test(parts[0]) && !["browse", "categories", "following", "drops", "settings", "video", "videos"].includes(parts[0].toLowerCase())) return { platform: "kick", kind: "channel", login: parts[0].toLowerCase(), id: null, url: `https://kick.com/${parts[0].toLowerCase()}` };
    if (parts.length === 3 && parts[1] === "videos" && /^[0-9a-f-]{36}$/i.test(parts[2])) return { platform: "kick", kind: "vod", login: parts[0].toLowerCase(), id: parts[2].toLowerCase(), url: `https://kick.com/${parts[0].toLowerCase()}/videos/${parts[2].toLowerCase()}` };
    if (parts.length === 2 && parts[0] === "video" && /^[0-9a-f-]{36}$/i.test(parts[1])) return { platform: "kick", kind: "vod", login: null, id: parts[1].toLowerCase(), url: `https://kick.com/video/${parts[1].toLowerCase()}` };
    return null;
  }
  return null;
}
export const isStreamLink = (raw: unknown) => parseStreamLink(raw) != null;

// ---------------------------------------------------------------------------------------------------
// Twitch, official (Helix with an app token)
// ---------------------------------------------------------------------------------------------------
let twitchToken: { token: string; until: number; key: string } | null = null;
export async function twitchAppToken(deps: LiveDeps): Promise<string> {
  const env = e(deps), id = env.TWITCH_CLIENT_ID, secret = env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new LiveSourceError("twitch_not_configured", "Twitch is not configured", 503);
  if (twitchToken && twitchToken.key === id && Date.now() < twitchToken.until) return twitchToken.token;
  const r = await f(deps)("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) throw new LiveSourceError("twitch_auth", `Twitch would not issue a token (${r?.status ?? "no answer"})`, 502, true);
  const b: any = await r.json();
  twitchToken = { token: String(b.access_token), until: Date.now() + Math.max(60, Number(b.expires_in) - 120) * 1000, key: id };
  return twitchToken.token;
}
export const resetTwitchToken = () => { twitchToken = null; };
export async function helix(deps: LiveDeps, path: string, tries = 0): Promise<any> {
  const token = await twitchAppToken(deps);
  const r = await f(deps)(`https://api.twitch.tv/helix/${path}`, { headers: { "Client-Id": String(e(deps).TWITCH_CLIENT_ID), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r) throw new LiveSourceError("twitch_down", "Twitch did not answer", 502, true);
  if (r.status === 401 && tries === 0) { twitchToken = null; return helix(deps, path, 1); }
  if (r.status === 429) throw new LiveSourceError("twitch_busy", "Twitch is rate-limiting us; try again in a minute", 503, true);
  if (!r.ok) throw new LiveSourceError("twitch_error", `Twitch answered ${r.status} for ${path.split("?")[0]}`, 502, r.status >= 500);
  return r.json();
}
const twitchDuration = (d: string): number => { const h = /(\d+)h/.exec(d), m = /(\d+)m/.exec(d), s = /(\d+)s/.exec(d); return (h ? +h[1] : 0) * 3600 + (m ? +m[1] : 0) * 60 + (s ? +s[1] : 0); };
// Twitch's "still processing" placeholder (a recording in progress, or just ended) is no picture: it does not load
const twitchThumb = (t: string | null | undefined) => (t && !/\/_404\/|404_processing/.test(String(t)) ? String(t).replace("%{width}", "640").replace("%{height}", "360").replace("{width}", "640").replace("{height}", "360") : null);
export async function twitchUser(deps: LiveDeps, login: string): Promise<{ id: string; login: string; display_name: string; profile_image_url: string | null } | null> {
  const b = await helix(deps, `users?login=${encodeURIComponent(login)}`);
  const u = b?.data?.[0]; return u ? { id: String(u.id), login: String(u.login), display_name: String(u.display_name ?? u.login), profile_image_url: u.profile_image_url ?? null } : null;
}
const twitchBroadcast = (v: any): Broadcast => ({ platform: "twitch", id: String(v.id), url: `https://www.twitch.tv/videos/${v.id}`, title: String(v.title ?? "").slice(0, 160), channel: String(v.user_name ?? v.user_login ?? ""), login: String(v.user_login ?? ""), channel_id: String(v.user_id ?? ""), seconds: twitchDuration(String(v.duration ?? "")), started_at: String(v.created_at ?? ""), views: Number.isFinite(Number(v.view_count)) ? Number(v.view_count) : null, thumbnail_url: twitchThumb(v.thumbnail_url) });
/** A channel's past broadcasts (archives), newest first. */
export async function twitchBroadcasts(deps: LiveDeps, userId: string, first = 20): Promise<Broadcast[]> {
  const b = await helix(deps, `videos?user_id=${encodeURIComponent(userId)}&type=archive&sort=time&first=${Math.min(100, first)}`);
  return (Array.isArray(b?.data) ? b.data : []).map(twitchBroadcast);
}
export async function twitchBroadcastById(deps: LiveDeps, id: string): Promise<Broadcast | null> {
  const b = await helix(deps, `videos?id=${encodeURIComponent(id)}`);
  const v = b?.data?.[0]; if (!v) return null;
  if (String(v.type ?? "archive") !== "archive") throw new LiveSourceError("not_a_broadcast", "That link is a highlight or an upload, not a past broadcast", 400);
  return twitchBroadcast(v);
}
/** Channels by name as someone types (official search): who is live, what they play, their picture. */
export type CreatorHit = { platform: "twitch"; login: string; channel: string; channel_id: string; live: boolean; category: string | null; profile_image_url: string | null; url: string };
export async function twitchSearch(deps: LiveDeps, q: string, first = 8): Promise<CreatorHit[]> {
  const b = await helix(deps, `search/channels?query=${encodeURIComponent(q)}&first=${Math.min(20, first)}`);
  return (Array.isArray(b?.data) ? b.data : []).map((c: any) => ({ platform: "twitch" as const, login: String(c.broadcaster_login ?? ""), channel: String(c.display_name ?? c.broadcaster_login ?? ""), channel_id: String(c.id ?? ""), live: !!c.is_live, category: c.game_name ? String(c.game_name) : null, profile_image_url: c.thumbnail_url ? String(c.thumbnail_url) : null, url: `https://www.twitch.tv/${c.broadcaster_login}` })).filter((c: CreatorHit) => c.login);
}
/** A Twitch channel's follower count (official; the total comes with an app token). */
export async function twitchFollowers(deps: LiveDeps, userId: string): Promise<number | null> {
  const b = await helix(deps, `channels/followers?broadcaster_id=${encodeURIComponent(userId)}&first=1`).catch(() => null);
  return Number.isFinite(Number(b?.total)) ? Number(b.total) : null;
}
/** The stream a Twitch channel has on right now, or null (official). */
export async function twitchLiveNow(deps: LiveDeps, userId: string): Promise<{ started_at: string; title: string; viewers: number; category: string | null; thumbnail_url: string | null } | null> {
  const b = await helix(deps, `streams?user_id=${encodeURIComponent(userId)}&type=live`);
  const s = b?.data?.[0]; if (!s) return null;
  // the stream's live preview (Twitch refreshes it every few minutes): the recording in progress has only a placeholder;
  // stamped by the minute so a browser does not keep an old frame
  const thumb = twitchThumb(s.thumbnail_url);
  return { started_at: String(s.started_at ?? ""), title: String(s.title ?? "").slice(0, 160), viewers: Number(s.viewer_count) || 0, category: s.game_name ? String(s.game_name) : null, thumbnail_url: thumb ? `${thumb}${thumb.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60_000)}` : null };
}
/** Whether a past-broadcast entry is the recording of the stream on now: Twitch lists it among the archives while it
 *  grows, started within a few minutes of the stream (measured Nov 21 2026: zackrawrr 1 h 51 min in, the recording
 *  6,710 s long, an open EVENT playlist level with live, the chat replay 230 s behind). */
export const isRecordingOf = (b: Pick<Broadcast, "started_at">, live: { started_at: string } | null): boolean =>
  !!live && Number.isFinite(Date.parse(b.started_at)) && Math.abs(Date.parse(b.started_at) - Date.parse(live.started_at)) < 15 * 60_000;
/** The top live streams by viewers (official), with the category name. */
export async function twitchTopStreams(deps: LiveDeps, first = 100): Promise<LiveStream[]> {
  const b = await helix(deps, `streams?type=live&first=${Math.min(100, first)}`);
  return (Array.isArray(b?.data) ? b.data : []).map((s: any) => ({ platform: "twitch" as const, login: String(s.user_login ?? ""), channel: String(s.user_name ?? s.user_login ?? ""), channel_id: String(s.user_id ?? ""), title: String(s.title ?? "").slice(0, 160), category: s.game_name ? String(s.game_name) : null, viewers: Number(s.viewer_count) || 0, started_at: s.started_at ?? null, language: s.language ?? null, thumbnail_url: twitchThumb(s.thumbnail_url), url: `https://www.twitch.tv/${s.user_login}` }));
}
/** Viewer-made clips of a broadcast, with their offsets (the ground truth of docs/live-clips/research/experiment-1.md). */
export async function twitchClipsOf(deps: LiveDeps, broadcasterId: string, videoId: string, startedAt: string, seconds: number): Promise<Array<{ id: string; views: number; offset: number; duration: number; title: string }>> {
  const end = new Date(Date.parse(startedAt) + (seconds + 3600) * 1000).toISOString();
  const out: any[] = []; let cursor = "";
  for (let page = 0; page < 20; page++) {
    const b = await helix(deps, `clips?broadcaster_id=${encodeURIComponent(broadcasterId)}&started_at=${encodeURIComponent(startedAt)}&ended_at=${encodeURIComponent(end)}&first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
    for (const c of b?.data ?? []) if (String(c.video_id) === videoId && c.vod_offset != null) out.push({ id: String(c.id), views: Number(c.view_count) || 0, offset: Number(c.vod_offset), duration: Number(c.duration) || 30, title: String(c.title ?? "").slice(0, 120) });
    cursor = b?.pagination?.cursor ?? ""; if (!cursor) break;
  }
  return out.sort((a, b) => b.views - a.views);
}

// ---------------------------------------------------------------------------------------------------
// Twitch, the web player's doors: the VOD playlist (yt-dlp) and the chat replay (the comments query)
// ---------------------------------------------------------------------------------------------------
function run(bin: string, args: string[], ms: number): Promise<{ code: number | null; so: string; se: string }> {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = ""; const t = setTimeout(() => c.kill("SIGKILL"), ms);
    c.stdout.on("data", (b) => { so += b; if (so.length > 2e6) so = so.slice(-1e6); }); c.stderr.on("data", (b) => { se += b; if (se.length > 65536) se = se.slice(-32768); });
    c.on("error", (err) => { clearTimeout(t); resolve({ code: -1, so, se: String(err) }); });
    c.on("close", (code) => { clearTimeout(t); resolve({ code, so, se }); });
  });
}
/** The HLS playlist addresses of a Twitch broadcast at two rungs: the smallest with sound (for hearing it) and up to
 *  the run's lines for cutting (720, or 1080 for HD: studio-quality.ts). 1080 measured on a 44 s moment of a 16 h
 *  broadcast (Nov 20 2026): 49 MB fetched instead of 21, the build about 8% longer, visibly sharper. yt-dlp holds the handshake; no proxy (Twitch does not refuse datacenter addresses). */
export async function twitchVodPlaylists(deps: LiveDeps, videoId: string, lines: 720 | 1080 = 720): Promise<{ audio: string; video: string }> {
  const bin = await ensureYtDlp({ fetch: deps.fetch, env: { ...e(deps), STUDIO_YT_PROXY: undefined } });
  const url = `https://www.twitch.tv/videos/${videoId}`;
  const get = async (fmt: string) => {
    const r = await run(bin, ["-q", "--no-warnings", "--no-cache-dir", "--no-playlist", "--socket-timeout", "20", "--force-ipv4", "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`, "-g", "-f", fmt, url], 90_000);
    const u = r.so.split("\n").map((s) => s.trim()).find((s) => /^https?:\/\//.test(s));
    if (!u) { if (/sub-only|subscriber|restricted|403/i.test(r.se)) throw new LiveSourceError("vod_restricted", "That broadcast is for subscribers only", 400); throw new LiveSourceError("vod_unreadable", `The broadcast could not be opened: ${r.se.replace(/\s+/g, " ").trim().slice(-160)}`, 502, true); }
    return u;
  };
  const audio = await get("160p/worst");
  const video = await get(twitchCutFormat(lines));
  return { audio, video };
}
const GQL_CLIENT = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const GQL_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
/** The chat replay of a broadcast, in parallel slices of time, reduced to ChatMsg as it arrives. `onProgress` gets the
 *  share done. Twitch's comments come about 60 a page; a 4-hour chat of 115k messages is ~2,000 pages. */
export async function twitchChatReplay(deps: LiveDeps, videoId: string, seconds: number, o: { slices?: number; onProgress?: (share: number) => void; signal?: AbortSignal } = {}): Promise<ChatMsg[]> {
  const slices = Math.max(1, Math.min(12, o.slices ?? Math.ceil(seconds / 1800)));
  const span = seconds / slices;
  const out: ChatMsg[][] = Array.from({ length: slices }, () => []);
  const done = new Array(slices).fill(0);
  const page = async (vars: Record<string, any>) => {
    for (let attempt = 0; ; attempt++) {
      const r = await f(deps)("https://gql.twitch.tv/gql", { method: "POST", headers: { "Client-ID": GQL_CLIENT, "content-type": "application/json" }, body: JSON.stringify([{ operationName: "VideoCommentsByOffsetOrCursor", variables: { videoID: videoId, ...vars }, extensions: { persistedQuery: { version: 1, sha256Hash: GQL_HASH } } }]), signal: o.signal ?? AbortSignal.timeout(30_000) }).catch(() => null);
      const b: any = r && r.ok ? await r.json().catch(() => null) : null;
      const comments = b?.[0]?.data?.video?.comments;
      if (comments) return comments;
      if (attempt >= 5 || o.signal?.aborted) throw new LiveSourceError("chat_unreadable", `Twitch's chat replay could not be read (${r?.status ?? "no answer"})`, 502, true);
      await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
    }
  };
  await Promise.all(out.map(async (bucket, k) => {
    const from = Math.floor(k * span), to = k === slices - 1 ? seconds + 1 : Math.floor((k + 1) * span);
    let cursor: string | null = null; let first = true; let last = from;
    for (let n = 0; n < 5000; n++) {
      const c = await page(first ? { contentOffsetSeconds: from } : { cursor });
      first = false;
      let stop = false;
      for (const ed of c.edges ?? []) {
        const node = ed.node; const t = Number(node?.contentOffsetSeconds);
        if (!Number.isFinite(t)) continue;
        if (t >= to) { stop = true; break; }
        if (t < from) continue;
        const frags = Array.isArray(node.message?.fragments) ? node.message.fragments : [];
        bucket.push({ t: Math.floor(t), u: String(node.commenter?.id ?? node.commenter?.login ?? ""), c: frags.map((x: any) => String(x?.text ?? "")).join("").slice(0, 200), e: frags.filter((x: any) => x?.emote).length });
        last = t; cursor = ed.cursor ?? cursor;
      }
      done[k] = Math.min(1, (last - from) / Math.max(1, to - from)); o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices);
      if (stop || !c.pageInfo?.hasNextPage || !cursor) break;
    }
  }));
  return out.flat().sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------------
// Kick, official (the public API with an app token) and the site's own JSON through curl
// ---------------------------------------------------------------------------------------------------
let kickToken: { token: string; until: number; key: string } | null = null;
export async function kickAppToken(deps: LiveDeps): Promise<string | null> {
  const env = e(deps), id = env.KICK_CLIENT_ID, secret = env.KICK_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (kickToken && kickToken.key === id && Date.now() < kickToken.until) return kickToken.token;
  const r = await f(deps)("https://id.kick.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const b: any = await r.json().catch(() => null);
  if (!b?.access_token) return null;
  kickToken = { token: String(b.access_token), until: Date.now() + Math.max(60, (Number(b.expires_in) || 3600) - 120) * 1000, key: id };
  return kickToken.token;
}
export const resetKickToken = () => { kickToken = null; };
/** The top live streams on Kick by viewers (official; empty without a Kick app). */
export async function kickTopStreams(deps: LiveDeps, limit = 100): Promise<LiveStream[]> {
  const token = await kickAppToken(deps); if (!token) return [];
  const r = await f(deps)(`https://api.kick.com/public/v1/livestreams?sort=viewer_count&limit=${Math.min(100, limit)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) return [];
  const b: any = await r.json().catch(() => null);
  return (Array.isArray(b?.data) ? b.data : []).map((s: any) => ({ platform: "kick" as const, login: String(s.slug ?? ""), channel: String(s.slug ?? ""), channel_id: String(s.broadcaster_user_id ?? s.channel_id ?? ""), title: String(s.stream_title ?? "").slice(0, 160), category: s.category?.name ? String(s.category.name) : null, viewers: Number(s.viewer_count) || 0, started_at: s.started_at ?? null, language: s.language ?? null, thumbnail_url: s.thumbnail ?? null, url: `https://kick.com/${s.slug}` }));
}
/** kick.com's own JSON through curl (its TLS fingerprint passes Cloudflare; Node's does not). */
export async function kickWeb(deps: LiveDeps, path: string): Promise<any> {
  const r = await run("curl", ["-sS", "-m", "25", "-w", "\n%{http_code}", "-A", UA, "-H", "Accept: application/json", "-H", "Accept-Language: en-US,en;q=0.9", `https://kick.com/${path.replace(/^\//, "")}`], 40_000);
  const lines = r.so.trim().split("\n"); const status = Number(lines.pop()); const body = lines.join("\n");
  if (r.code !== 0 && !status) throw new LiveSourceError("kick_down", "Kick did not answer", 502, true);
  if (status === 404) throw new LiveSourceError("kick_not_found", "Nothing is at that Kick link", 404);
  if (status === 403) throw new LiveSourceError("kick_blocked", "Kick refused our servers for the moment; try again in a minute", 503, true);
  if (status !== 200) throw new LiveSourceError("kick_error", `Kick answered ${status}`, 502, status >= 500);
  try { return JSON.parse(body); } catch { throw new LiveSourceError("kick_error", "Kick sent something that is not JSON", 502, true); }
}
export type KickChannel = { id: string; chat_id: string; slug: string; channel: string; followers: number | null; live: boolean; title: string | null; category: string | null; viewers: number | null; playback_url: string | null; profile_image_url: string | null };
export async function kickChannel(deps: LiveDeps, slug: string): Promise<KickChannel> {
  const b = await kickWeb(deps, `api/v2/channels/${encodeURIComponent(slug)}`);
  const ls = b?.livestream ?? null;
  return { id: String(b?.id ?? ""), chat_id: String(b?.chatroom?.id ?? b?.id ?? ""), slug: String(b?.slug ?? slug), channel: String(b?.user?.username ?? b?.slug ?? slug), followers: Number.isFinite(Number(b?.followers_count)) ? Number(b.followers_count) : null, live: !!ls, title: ls?.session_title ?? null, category: ls?.categories?.[0]?.name ?? null, viewers: ls ? Number(ls.viewer_count) || 0 : null, playback_url: b?.playback_url ?? null, profile_image_url: b?.user?.profile_pic ?? null };
}
const kickStart = (s: string) => (s.includes("T") ? s : s.replace(" ", "T") + "Z");
/** A channel's past broadcasts (the site's listing: a live stream in progress shows with duration 0). */
export async function kickBroadcasts(deps: LiveDeps, slug: string, ch?: KickChannel): Promise<Broadcast[]> {
  const b = await kickWeb(deps, `api/v2/channels/${encodeURIComponent(slug)}/videos`);
  const list: any[] = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : [];
  const c = ch ?? (await kickChannel(deps, slug));
  return list.filter((v) => v?.video?.uuid && Number(v.duration) > 0).map((v) => ({ platform: "kick" as const, id: String(v.video.uuid), url: `https://kick.com/${c.slug}/videos/${v.video.uuid}`, title: String(v.session_title ?? "").slice(0, 160), channel: c.channel, login: c.slug, channel_id: c.chat_id, seconds: Math.round(Number(v.duration) / 1000), started_at: new Date(kickStart(String(v.start_time))).toISOString(), views: Number.isFinite(Number(v.views)) ? Number(v.views) : null, thumbnail_url: v.thumbnail?.src ?? v.thumbnail ?? null }));
}
/** One past broadcast by its uuid: the master playlist of its recording and when it started. */
export async function kickBroadcastSource(deps: LiveDeps, uuid: string): Promise<{ master: string; started_at: string; livestream_id: string | null }> {
  const b = await kickWeb(deps, `api/v1/video/${encodeURIComponent(uuid)}`);
  if (!b?.source) throw new LiveSourceError("vod_unreadable", "That broadcast's recording is not available", 404);
  const started = b?.livestream?.start_time ?? b?.livestream?.created_at ?? b?.created_at ?? null;
  return { master: String(b.source), started_at: started ? new Date(kickStart(String(started))).toISOString() : "", livestream_id: b?.livestream?.id != null ? String(b.livestream.id) : b?.live_stream_id != null ? String(b.live_stream_id) : null };
}
/** The chat replay of a Kick broadcast, walked forward on `start_time` (about 12-25 messages a page), in parallel slices. */
export async function kickChatReplay(deps: LiveDeps, chatId: string, startedAtIso: string, seconds: number, o: { slices?: number; onProgress?: (share: number) => void; signal?: AbortSignal; maxCalls?: number } = {}): Promise<ChatMsg[]> {
  const t0 = Date.parse(startedAtIso);
  if (!Number.isFinite(t0)) throw new LiveSourceError("chat_unreadable", "The broadcast's start time is unknown", 502);
  const slices = Math.max(1, Math.min(8, o.slices ?? Math.ceil(seconds / 1800)));
  const span = seconds / slices, maxCalls = o.maxCalls ?? 6000;
  const out: ChatMsg[][] = Array.from({ length: slices }, () => []); const done = new Array(slices).fill(0); let calls = 0;
  await Promise.all(out.map(async (bucket, k) => {
    const from = Math.floor(k * span), to = k === slices - 1 ? seconds + 1 : Math.floor((k + 1) * span);
    let T = from; const seen = new Set<string>(); let stuck = 0;
    while (T < to && calls < maxCalls && !o.signal?.aborted) {
      const iso = new Date(t0 + T * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
      let d: any;
      try { d = (await kickWeb(deps, `api/v2/channels/${encodeURIComponent(chatId)}/messages?start_time=${encodeURIComponent(iso)}`))?.data; } catch (err: any) { if (err?.retry) { await new Promise((ok) => setTimeout(ok, 3000)); calls++; continue; } throw err; }
      calls++;
      let fresh = 0, last = T;
      for (const m of d?.messages ?? []) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id); fresh++;
        const t = Math.floor((Date.parse(m.created_at) - t0) / 1000);
        if (!Number.isFinite(t) || t < from || t >= to) continue;
        bucket.push({ t, u: String(m.sender?.id ?? ""), c: String(m.content ?? "").slice(0, 200), e: (String(m.content ?? "").match(/\[emote:/g) ?? []).length });
        if (t > last) last = t;
      }
      if (fresh === 0 || last <= T) { stuck++; T += stuck < 3 ? 1 : 10; } else { stuck = 0; T = last; }
      done[k] = Math.min(1, (T - from) / Math.max(1, to - from)); o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices);
      await new Promise((ok) => setTimeout(ok, 120));
    }
  }));
  return out.flat().sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------------
// HLS: the rungs of a master playlist
// ---------------------------------------------------------------------------------------------------
export type Variant = { url: string; bandwidth: number; height: number | null };
/** The variants of an HLS master playlist (absolute addresses), smallest first. A media playlist (no variants) is
 *  returned as its own single variant. */
export function parseMaster(text: string, base: string): Variant[] {
  const out: Variant[] = []; const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(l)?.[1] ?? 0); const res = /RESOLUTION=(\d+)x(\d+)/.exec(l);
    let j = i + 1; while (j < lines.length && (lines[j].startsWith("#") || !lines[j].trim())) j++;
    if (j >= lines.length) break;
    let url = lines[j].trim(); try { url = new URL(url, base).toString(); } catch { /* keep */ }
    out.push({ url, bandwidth: bw, height: res ? Number(res[2]) : null });
  }
  if (!out.length && /#EXTINF/.test(text)) return [{ url: base, bandwidth: 0, height: null }];
  return out.sort((a, b) => a.bandwidth - b.bandwidth);
}
export async function hlsVariants(deps: LiveDeps, master: string): Promise<Variant[]> {
  const r = await f(deps)(master, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) throw new LiveSourceError("vod_unreadable", `The recording's playlist could not be read (${r?.status ?? "no answer"})`, 502, true);
  return parseMaster(await r.text(), master);
}
/** The stretches of a recording whose sound the platform muted (Twitch names those segments "-muted"): seconds from
 *  the start, merged. Empty when the playlist cannot be read or names nothing muted. */
export async function mutedRanges(deps: LiveDeps, playlist: string): Promise<Array<[number, number]>> {
  const r = await f(deps)(playlist, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) return [];
  const text = await r.text().catch(() => "");
  const out: Array<[number, number]> = []; let t = 0, dur = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) { dur = Number(line.slice(8).split(",")[0]) || 0; continue; }
    if (!line || line.startsWith("#")) continue;
    if (/-muted/i.test(line)) { const last = out[out.length - 1]; if (last && Math.abs(last[1] - t) < 0.01) last[1] = t + dur; else out.push([t, t + dur]); }
    t += dur; dur = 0;
  }
  return out;
}
/** The rung to hear from (the smallest) and the rung to cut from (the biggest at or under `maxHeight` lines, else the
 *  biggest there is). */
export function pickRungs(vs: Variant[], maxHeight = 720): { audio: string; video: string } {
  if (!vs.length) throw new LiveSourceError("vod_unreadable", "The recording has no playable rung", 502);
  const audio = vs[0].url;
  const want = vs.filter((v) => (v.height ?? 0) <= maxHeight).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ?? vs[vs.length - 1];
  return { audio, video: want.url };
}

// ---------------------------------------------------------------------------------------------------
// Discovery: niches over the platforms' categories
// ---------------------------------------------------------------------------------------------------
export const NICHES: Array<{ id: string; label: string; match: RegExp }> = [
  { id: "gta", label: "GTA VI", match: /grand theft auto vi\b|\bgta ?6\b|\bgta vi\b/i },
  { id: "irl", label: "IRL", match: /^irl$|\birl\b|travel|outdoors|sports|food|pools, hot tubs/i },
  { id: "chatting", label: "Just Chatting", match: /just chatting|talk shows|podcast/i },
  { id: "shooters", label: "Shooters", match: /fortnite|call of duty|warzone|valorant|counter-strike|apex legends|battlefield|overwatch|rainbow six|pubg|escape from tarkov|marvel rivals/i },
  { id: "games", label: "Other games", match: /./ },
];
export function nicheOf(category: string | null): string {
  if (!category) return "chatting";
  for (const n of NICHES) if (n.match.test(category)) return n.id;
  return "games";
}
