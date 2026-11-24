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

export type LiveDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (l: string) => void; /** tests: kick.com answers and waits without the network or the clock */ kickCurl?: (path: string) => Promise<{ code: number | null; so: string; se: string }>; sleep?: (ms: number) => Promise<void>;
  /** tests: Twitch's chat replay through the proxy without the network */ twitchProxyCurl?: (body: string) => Promise<{ code: number | null; so: string; se: string }> };
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
export async function twitchTopStreams(deps: LiveDeps, first = 100, o: { language?: string; gameId?: string; /** pages of `first` (Helix's cursor), for more than 100 */ pages?: number } = {}): Promise<LiveStream[]> {
  const rows: any[] = []; let cursor = "";
  for (let page = 0; page < Math.max(1, Math.min(5, o.pages ?? 1)); page++) {
    const b = await helix(deps, `streams?type=live&first=${Math.min(100, first)}${o.language ? `&language=${encodeURIComponent(o.language)}` : ""}${o.gameId ? `&game_id=${encodeURIComponent(o.gameId)}` : ""}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
    rows.push(...(Array.isArray(b?.data) ? b.data : []));
    cursor = b?.pagination?.cursor ?? ""; if (!cursor) break;
  }
  return rows.map((s: any) => ({ platform: "twitch" as const, login: String(s.user_login ?? ""), channel: String(s.user_name ?? s.user_login ?? ""), channel_id: String(s.user_id ?? ""), title: String(s.title ?? "").slice(0, 160), category: s.game_name ? String(s.game_name) : null, viewers: Number(s.viewer_count) || 0, started_at: s.started_at ?? null, language: s.language ?? null, thumbnail_url: twitchThumb(s.thumbnail_url), url: `https://www.twitch.tv/${s.user_login}` }));
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
/** How the Twitch chat reader checks itself (Nov 23 2026: from the server, Twitch began ending chat stretches early and
 *  answering empty pages, so three runs of a channel with ~200 messages a minute read as "5 messages a minute" and failed
 *  as too quiet; the same code from another address read everything). A stretch Twitch says is over is asked again by
 *  time; a read that comes out thin is read once more through the residential proxy (STUDIO_YT_PROXY) and the fuller
 *  read is kept. A quiet chat is small, so the proxy costs little when the chat really is quiet. */
export const TWITCH_CHAT = { thin_per_minute: 60, reseeks: 300, page_tries: 6, empty_tries: 7, in_flight: 2, empty_wait_ms: 400 };
/** Twitch slows a reader down by answering pages EMPTY (status 200, no messages), not with a 429. Measured from one
 *  address, Nov 23 2026: 1 request at a time 7.4 pages a second and none empty, 2 at a time 13.9 and none empty, 4 at a
 *  time 20 % empty, 8 at a time half empty. So every chat read on this server shares TWITCH_CHAT.in_flight requests at
 *  once (all runs together), and an empty page inside the stream is asked again after a short, growing wait. */
let twitchActive = 0; const twitchWaiting: Array<() => void> = [];
async function twitchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (twitchActive >= TWITCH_CHAT.in_flight) await new Promise<void>((ok) => twitchWaiting.push(ok));
  twitchActive++;
  try { return await fn(); }
  finally { twitchActive--; twitchWaiting.shift()?.(); }
}
export const twitchChatStats = { pages: 0, empty: 0 };
export type ChatReadReport = { via: "direct" | "proxy"; pages: number; reseeks: number; found_after_end: number; empty_answers: number; direct_messages: number | null; odd: string | null };

/** One page of Twitch's chat replay: straight from this server, or through the proxy (curl -x). Null when Twitch did not answer. */
async function twitchPage(deps: LiveDeps, body: string, proxy: string | null, signal?: AbortSignal): Promise<{ status: number; json: any } | null> {
  if (!proxy) {
    const r = await f(deps)("https://gql.twitch.tv/gql", { method: "POST", headers: { "Client-ID": GQL_CLIENT, "content-type": "application/json" }, body, signal: signal ?? AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r) return null;
    return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
  }
  const r = deps.twitchProxyCurl ? await deps.twitchProxyCurl(body) : await run("curl", ["-sS", "-m", "30", "-x", proxy, "-w", "\n%{http_code}", "-H", `Client-ID: ${GQL_CLIENT}`, "-H", "content-type: application/json", "--data-binary", body, "https://gql.twitch.tv/gql"], 40_000);
  const lines = r.so.trim().split("\n"); const status = Number(lines.pop());
  if (!status) return null;
  try { return { status, json: JSON.parse(lines.join("\n")) }; } catch { return { status, json: null }; }
}

/** `seconds` is where the read ends; `o.from` where it starts (default 0): a run on a part of a stream reads only that
 *  part's chat (and a little around it), not the whole stream's. */
export async function twitchChatReplay(deps: LiveDeps, videoId: string, seconds: number, o: { from?: number; slices?: number; onProgress?: (share: number) => void; signal?: AbortSignal; report?: (r: ChatReadReport) => void; proxy?: "never" | "when_thin" } = {}): Promise<ChatMsg[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const direct = await readTwitch(deps, videoId, seconds, o, null);
  const minutes = Math.max(1, (seconds - Math.max(0, o.from ?? 0)) / 60);
  const proxy = e(deps).STUDIO_YT_PROXY || null;
  if (direct.msgs.length / minutes >= TWITCH_CHAT.thin_per_minute || !proxy || o.proxy === "never" || o.signal?.aborted) {
    o.report?.({ ...direct.report, via: "direct", direct_messages: null });
    return direct.msgs;
  }
  // thin: a quiet chat, or Twitch cutting this server short. Read it again from elsewhere and keep the fuller read.
  log(`[twitch-chat] thin read of ${videoId} (${direct.msgs.length} messages over ${Math.round(minutes)} min${direct.report.odd ? `; ${direct.report.odd}` : ""}): reading it again through the proxy`);
  try {
    const again = await readTwitch(deps, videoId, seconds, o, proxy);
    const better = again.msgs.length > direct.msgs.length;
    log(`[twitch-chat] proxy read of ${videoId}: ${again.msgs.length} messages (direct ${direct.msgs.length}); keeping the ${better ? "proxy" : "direct"} read`);
    o.report?.({ ...(better ? again.report : direct.report), via: better ? "proxy" : "direct", direct_messages: direct.msgs.length });
    return better ? again.msgs : direct.msgs;
  } catch (err: any) {
    log(`[twitch-chat] proxy read of ${videoId} failed: ${String(err?.message ?? err).slice(0, 160)}`);
    o.report?.({ ...direct.report, via: "direct", direct_messages: null });
    return direct.msgs;
  }
}

async function readTwitch(deps: LiveDeps, videoId: string, seconds: number, o: { from?: number; slices?: number; onProgress?: (share: number) => void; signal?: AbortSignal }, proxy: string | null): Promise<{ msgs: ChatMsg[]; report: ChatReadReport }> {
  const base = Math.max(0, Math.min(seconds, Math.floor(o.from ?? 0)));
  const slices = Math.max(1, Math.min(12, o.slices ?? Math.ceil((seconds - base) / 1800)));
  const span = (seconds - base) / slices;
  const out: ChatMsg[][] = Array.from({ length: slices }, () => []);
  const done = new Array(slices).fill(0);
  const report: ChatReadReport = { via: proxy ? "proxy" : "direct", pages: 0, reseeks: 0, found_after_end: 0, empty_answers: 0, direct_messages: null, odd: null };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const page = async (vars: Record<string, any>) => {
    const body = JSON.stringify([{ operationName: "VideoCommentsByOffsetOrCursor", variables: { videoID: videoId, ...vars }, extensions: { persistedQuery: { version: 1, sha256Hash: GQL_HASH } } }]);
    // the end of the recording really is empty; anywhere before it, an empty page is Twitch asking us to slow down
    const nearEnd = Number.isFinite(Number(vars.contentOffsetSeconds)) && Number(vars.contentOffsetSeconds) >= seconds - 30;
    let empties = 0;
    for (let attempt = 0; ; attempt++) {
      const r = await twitchSlot(() => twitchPage(deps, body, proxy, o.signal));
      report.pages++; twitchChatStats.pages++;
      const comments = r?.json?.[0]?.data?.video?.comments;
      if (comments && !(comments.edges ?? []).length && !nearEnd && empties < TWITCH_CHAT.empty_tries - 1 && !o.signal?.aborted) {
        empties++; report.empty_answers++; twitchChatStats.empty++;
        await sleep(TWITCH_CHAT.empty_wait_ms * 2 ** (empties - 1)); // 0.4, 0.8, 1.6, 3.2, 6.4, 12.8 s
        continue;
      }
      if (comments) return comments;
      // what Twitch sent instead, once per read, for the log (the first sign of a change on their side)
      if (!report.odd) report.odd = `answer ${r?.status ?? "none"}: ${JSON.stringify(r?.json?.[0]?.errors ?? r?.json ?? null).slice(0, 200)}`;
      if (attempt >= TWITCH_CHAT.page_tries - 1 || o.signal?.aborted) throw new LiveSourceError("chat_unreadable", `Twitch's chat replay could not be read (${r?.status ?? "no answer"})`, 502, true);
      await (deps.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms))))(1000 * (attempt + 1));
    }
  };
  await Promise.all(out.map(async (bucket, k) => {
    const from = base + Math.floor(k * span), to = k === slices - 1 ? seconds + 1 : base + Math.floor((k + 1) * span);
    let cursor: string | null = null; let seek: number | null = from; let last = from; let reseeks = 0;
    const kept = new Set<string>();
    /** Keeps this page's messages inside the stretch (once each); "end" when the page reaches past the stretch. */
    const take = (edges: any[]): "end" | "more" => {
      for (const ed of edges) {
        const node = ed.node; const t = Number(node?.contentOffsetSeconds);
        if (!Number.isFinite(t)) continue;
        if (t >= to) return "end";
        if (t < from) continue;
        const frags = Array.isArray(node.message?.fragments) ? node.message.fragments : [];
        const m: ChatMsg = { t: Math.floor(t), u: String(node.commenter?.id ?? node.commenter?.login ?? ""), c: frags.map((x: any) => String(x?.text ?? "")).join("").slice(0, 200), e: frags.filter((x: any) => x?.emote).length };
        const key = String(node.id ?? `${t}|${m.u}|${m.c}`);
        cursor = ed.cursor ?? cursor;
        if (kept.has(key)) continue;
        kept.add(key); bucket.push(m); last = Math.max(last, t);
      }
      return "more";
    };
    for (let n = 0; n < 20000; n++) {
      const bySeek = seek != null;
      const c = await page(bySeek ? { contentOffsetSeconds: seek } : { cursor });
      seek = null;
      const edges: any[] = c.edges ?? [];
      const had = bucket.length;
      const end = take(edges);
      if (bySeek && n > 0) report.found_after_end += bucket.length - had;
      done[k] = Math.min(1, (last - from) / Math.max(1, to - from)); o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices);
      if (end === "end") break;
      if (c.pageInfo?.hasNextPage && cursor && bucket.length > had) continue;
      // Twitch says this stretch is over, or the page held nothing new. Asked by time and nothing new: it is over.
      // Otherwise ask again by time from the last message: an answer that holds more means Twitch had cut it short.
      if (bySeek && bucket.length === had) break;
      if (reseeks >= TWITCH_CHAT.reseeks) break;
      reseeks++; report.reseeks++;
      seek = Math.floor(last); cursor = null;
    }
    done[k] = 1; o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices);
  }));
  return { msgs: out.flat().sort((a, b) => a.t - b.t), report };
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
// Every call to kick.com goes through one pace (Nov 22 2026: the first Kick run in production read its chat with eight
// readers at once, ~65 calls a second from one server; Kick answered 429 after 4 s and the run failed). One call starts
// at a time with KICK_PACE.gap_ms between starts; a 429 pauses every Kick call for a cool-down that doubles each time
// (up to KICK_PACE.max_cool_ms) and widens the gap, which narrows back as calls succeed.
export const KICK_PACE = { gap_ms: 250, max_gap_ms: 2000, cool_ms: 2000, max_cool_ms: 30_000, tries: 4 };
let kickGap = KICK_PACE.gap_ms, kickCool = 0, kickNextAt = 0, kickQueue: Promise<void> = Promise.resolve();
export const resetKickPace = () => { kickGap = KICK_PACE.gap_ms; kickCool = 0; kickNextAt = 0; kickQueue = Promise.resolve(); };
function kickTurn(deps: LiveDeps): Promise<void> {
  const wait = (ms: number) => (deps.sleep ? deps.sleep(ms) : new Promise<void>((ok) => setTimeout(ok, ms)));
  const turn = kickQueue.then(async () => { const now = Date.now(); if (kickNextAt > now) await wait(kickNextAt - now); kickNextAt = Date.now() + kickGap; });
  kickQueue = turn.catch(() => undefined);
  return turn;
}
function kickBusy() { kickCool = Math.min(KICK_PACE.max_cool_ms, Math.max(KICK_PACE.cool_ms, kickCool * 2)); kickGap = Math.min(KICK_PACE.max_gap_ms, kickGap * 2); kickNextAt = Math.max(kickNextAt, Date.now() + kickCool); }
function kickFine() { kickCool = 0; kickGap = Math.max(KICK_PACE.gap_ms, Math.round(kickGap * 0.9)); }
/** Counts for the checks and the logs: calls made, 429s met. */
export const kickStats = { calls: 0, busy: 0 };
/** One call to kick.com, in turn (the pace above); a 429 is waited out and tried again here, up to KICK_PACE.tries times,
 *  so every caller (a lookup, a list, the chat reader) rides out Kick slowing us down. */
export async function kickWeb(deps: LiveDeps, path: string): Promise<any> {
  for (let k = 1; ; k++) {
    try { return await kickOnce(deps, path); }
    catch (e: any) { if (e?.code !== "kick_busy" || k >= KICK_PACE.tries) throw e; }
  }
}
async function kickOnce(deps: LiveDeps, path: string): Promise<any> {
  await kickTurn(deps); kickStats.calls++;
  const r = deps.kickCurl ? await deps.kickCurl(path) : await run("curl", ["-sS", "-m", "25", "-w", "\n%{http_code}", "-A", UA, "-H", "Accept: application/json", "-H", "Accept-Language: en-US,en;q=0.9", `https://kick.com/${path.replace(/^\//, "")}`], 40_000);
  const lines = r.so.trim().split("\n"); const status = Number(lines.pop()); const body = lines.join("\n");
  if (r.code !== 0 && !status) throw new LiveSourceError("kick_down", "Kick did not answer", 502, true);
  if (status === 429) { kickBusy(); kickStats.busy++; throw new LiveSourceError("kick_busy", "Kick is asking us to slow down; try again in a few minutes", 503, true); }
  if (status === 404) throw new LiveSourceError("kick_not_found", "Nothing is at that Kick link", 404);
  if (status === 403) throw new LiveSourceError("kick_blocked", "Kick refused our servers for the moment; try again in a minute", 503, true);
  if (status !== 200) throw new LiveSourceError("kick_error", `Kick answered ${status}`, 502, status >= 500);
  kickFine();
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
  return list.filter((v) => v?.video?.uuid && Number(v.duration) > 0).map((v) => ({ platform: "kick" as const, id: String(v.video.uuid), url: `https://kick.com/${c.slug}/videos/${v.video.uuid}`, title: String(v.session_title ?? "").slice(0, 160), channel: c.channel, login: c.slug, /* Kick's chat replay is asked by the channel's id, not its chat room's (the room's id answers an empty list: every Kick run read no chat until Nov 22 2026) */ channel_id: c.id, seconds: Math.round(Number(v.duration) / 1000), started_at: new Date(kickStart(String(v.start_time))).toISOString(), views: Number.isFinite(Number(v.views)) ? Number(v.views) : null, thumbnail_url: v.thumbnail?.src ?? v.thumbnail ?? null }));
}
/** One past broadcast by its uuid: the master playlist of its recording and when it started. */
export async function kickBroadcastSource(deps: LiveDeps, uuid: string): Promise<{ master: string; started_at: string; livestream_id: string | null }> {
  const b = await kickWeb(deps, `api/v1/video/${encodeURIComponent(uuid)}`);
  if (!b?.source) throw new LiveSourceError("vod_unreadable", "That broadcast's recording is not available", 404);
  const started = b?.livestream?.start_time ?? b?.livestream?.created_at ?? b?.created_at ?? null;
  return { master: String(b.source), started_at: started ? new Date(kickStart(String(started))).toISOString() : "", livestream_id: b?.livestream?.id != null ? String(b.livestream.id) : b?.live_stream_id != null ? String(b.live_stream_id) : null };
}
/** The chat replay of a Kick broadcast, walked forward on `start_time` (about 12-25 messages a page), in parallel slices. */
export const KICK_CHAT_RETRIES = 6;
/** Kick's chat replay, read by its cursor (Nov 22 2026): `messages?cursor=<microseconds>` answers the 25 messages before
 *  that moment, newest first, and the cursor of the oldest; paging back from the end of a stretch to its start reads every
 *  message once, 25 a call, and a quiet stretch costs one call for minutes of chat. (Reading by `start_time` answered at
 *  most ~5 s of chat a call, empty or not: about ten times the calls, at Kick's ~2 calls a second.) The stream is read in
 *  up to 3 stretches at once; every call takes its turn in kickWeb's pace. */
export async function kickChatReplay(deps: LiveDeps, chatId: string, startedAtIso: string, seconds: number, o: { from?: number; slices?: number; onProgress?: (share: number) => void; signal?: AbortSignal; maxCalls?: number } = {}): Promise<ChatMsg[]> {
  const t0 = Date.parse(startedAtIso);
  if (!Number.isFinite(t0)) throw new LiveSourceError("chat_unreadable", "The broadcast's start time is unknown", 502);
  const base = Math.max(0, Math.min(seconds, Math.floor(o.from ?? 0)));
  const slices = Math.max(1, Math.min(3, o.slices ?? Math.ceil((seconds - base) / 1800)));
  const span = (seconds - base) / slices, maxCalls = o.maxCalls ?? 8000;
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const out: ChatMsg[][] = Array.from({ length: slices }, () => []); const done = new Array(slices).fill(0); let calls = 0;
  await Promise.all(out.map(async (bucket, k) => {
    const from = base + Math.floor(k * span), to = k === slices - 1 ? seconds + 1 : base + Math.floor((k + 1) * span);
    // the cursor is a moment in microseconds; it walks back from the stretch's end to its start
    let cursor = (t0 + to * 1000) * 1000; const seen = new Set<string>(); let fails = 0; let empties = 0;
    while (calls < maxCalls && !o.signal?.aborted) {
      let d: any;
      // a refusal that may pass (Kick slowing us, a 5xx, no answer) is tried again at the same point, waiting longer each
      // time (the pace in kickWeb also cools down); only after KICK_CHAT_RETRIES in a row does the run stop
      try { d = (await kickWeb(deps, `api/v2/channels/${encodeURIComponent(chatId)}/messages?cursor=${Math.round(cursor)}`))?.data; fails = 0; }
      catch (err: any) { if (err?.retry && ++fails <= KICK_CHAT_RETRIES) { await wait(Math.min(30_000, 2000 * 2 ** (fails - 1))); continue; } throw err; }
      calls++;
      const msgs: any[] = d?.messages ?? [];
      let oldest = Infinity;
      for (const m of msgs) {
        const at = Date.parse(m?.created_at); if (!Number.isFinite(at)) continue;
        if (at < oldest) oldest = at;
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const t = Math.floor((at - t0) / 1000);
        if (t < from || t >= to) continue;
        bucket.push({ t, u: String(m.sender?.id ?? ""), c: String(m.content ?? "").slice(0, 200), e: (String(m.content ?? "").match(/\[emote:/g) ?? []).length });
      }
      // the next page starts at the oldest message read (Kick's own cursor when it gives one); nothing older, or the
      // stretch's start reached: this stretch is done
      // Kick answers the messages BEFORE the cursor, so an empty page while the cursor is still inside the stream is a
      // hiccup, not the start of the chat (Twitch, Nov 23 2026, slowed readers with empty pages): wait, ask again
      if (!msgs.length && cursor / 1000 > t0 + from * 1000 && ++empties <= KICK_CHAT_RETRIES) { await wait(Math.min(30_000, 2000 * 2 ** (empties - 1))); continue; }
      if (msgs.length) empties = 0;
      const next = Number(d?.cursor) || (Number.isFinite(oldest) ? oldest * 1000 : NaN);
      if (!msgs.length || !Number.isFinite(next) || next / 1000 <= t0 + from * 1000) { done[k] = 1; o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices); break; }
      cursor = next >= cursor ? cursor - 1_000_000 : next; // never stand still
      done[k] = Math.min(1, (t0 + to * 1000 - cursor / 1000) / Math.max(1, (to - from) * 1000)); o.onProgress?.(done.reduce((a, b) => a + b, 0) / slices);
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
// The categories of "Live right now" (owner, Nov 21 2026): GTA VI while it trends, then games of every kind, IRL and Just
// Chatting; shooters and "other games" are one "Games"
export const NICHES: Array<{ id: string; label: string; match: RegExp }> = [
  { id: "gta", label: "GTA VI", match: /grand theft auto vi\b|\bgta ?6\b|\bgta vi\b/i },
  { id: "irl", label: "IRL", match: /^irl$|\birl\b|travel|outdoors|sports|food|pools, hot tubs/i },
  { id: "chatting", label: "Just Chatting", match: /just chatting|talk shows|podcast|always on/i },
  { id: "games", label: "Games", match: /./ },
];
/** Twitch's own ids for the categories read one by one (so each fills up, not only the top 100's share). */
export const TWITCH_GAME = { chatting: "509658", irl: "509672" } as const;
let gtaId: { id: string | null; at: number } | null = null;
export async function twitchGameId(deps: LiveDeps, name: string): Promise<string | null> {
  if (gtaId && Date.now() - gtaId.at < 24 * 3600_000) return gtaId.id;
  const b = await helix(deps, `games?name=${encodeURIComponent(name)}`).catch(() => null);
  gtaId = { id: b?.data?.[0]?.id ? String(b.data[0].id) : null, at: Date.now() };
  return gtaId.id;
}
/** Kick's own site listing of who is live (no key; the official API needs KICK_CLIENT_ID/SECRET): English streams, by
 *  category slug or all, a page of 24 at a time. */
export async function kickSiteLive(deps: LiveDeps, o: { subcategory?: string; pages?: number } = {}): Promise<LiveStream[]> {
  const out: LiveStream[] = [];
  for (let page = 1; page <= (o.pages ?? 2); page++) {
    const b = await kickWeb(deps, `stream/livestreams/en?page=${page}&limit=24&sort=desc${o.subcategory ? `&subcategory=${encodeURIComponent(o.subcategory)}` : ""}`).catch(() => null);
    const rows: any[] = Array.isArray(b?.data) ? b.data : [];
    for (const s of rows) {
      if (s?.language && !/^en(glish)?$/i.test(String(s.language))) continue;
      const slug = String(s?.channel?.slug ?? ""); if (!slug) continue;
      out.push({ platform: "kick", login: slug, channel: String(s?.channel?.user?.username ?? slug), channel_id: String(s?.channel?.id ?? s?.channel_id ?? ""), title: String(s?.session_title ?? "").slice(0, 160), category: s?.categories?.[0]?.name ? String(s.categories[0].name) : null, viewers: Number(s?.viewer_count ?? s?.viewers) || 0, started_at: s?.start_time ? new Date(String(s.start_time).replace(" ", "T") + "Z").toISOString() : null, language: "en", thumbnail_url: s?.thumbnail?.src ? String(s.thumbnail.src) : null, url: `https://kick.com/${slug}` });
    }
    if (!b?.next_page_url) break;
  }
  return out;
}
/** Kick's English game streams sit in each game's own list (its front page is mostly other languages); the games most
 *  streamed there in English, checked Nov 21 2026 (a slug Kick does not know answers its front page, so the category
 *  is checked too). */
export const KICK_GAMES = ["call-of-duty-warzone", "fortnite", "grand-theft-auto-v", "marvel-rivals", "arc-raiders", "escape-from-tarkov", "apex-legends", "rust", "counter-strike-2", "minecraft", "valorant", "rocket-league", "ea-sports-fc-26", "battlefield-6", "chess"];
export async function kickGames(deps: LiveDeps, slugs = KICK_GAMES, parallel = 5): Promise<LiveStream[]> {
  const out: LiveStream[][] = slugs.map(() => []); let next = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let k = next++; k < slugs.length; k = next++) {
      const first = slugs[k].split("-")[0];
      out[k] = (await kickSiteLive(deps, { subcategory: slugs[k], pages: 1 }).catch(() => [] as LiveStream[]))
        .filter((s) => s.viewers >= 5 && (s.category ?? "").toLowerCase().split(/[^a-z0-9]+/)[0] === first);
    }
  }));
  return out.flat();
}
export function nicheOf(category: string | null): string {
  if (!category) return "chatting";
  for (const n of NICHES) if (n.match.test(category)) return n.id;
  return "games";
}
