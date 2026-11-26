// Clone8 Studio: Live Clips, phase 1 (docs/live-clips/PLAN.md). A past broadcast on Twitch or Kick in, the moments
// its audience reacted to out as ready vertical clips, through the Clips engine.
//
// A past-stream run IS a Clips job (tool "clips") whose options carry `stream`: it rides the Clips loop, its capacity,
// its collection and its run page unchanged; studio-clips.ts hands such a job to runStreamClipsJob below. What is new:
//  - the source: a Twitch or Kick link (src/live-sources.ts) instead of YouTube; no proxy;
//  - the reading: the CHAT REPLAY first. Experiment 1 (research/experiment-1.md) showed the audience's verdict on a
//    busy chat is in what people write, not how much: bursts of all-caps, laughter, hype words, "gg"/"yes" waves and
//    emotes against each signal's own last ten minutes; the raw rate carries small chats. Only the candidates' windows
//    are then fetched and heard (2.5 minutes each), which makes a stream 8-18x cheaper to read than a YouTube video;
//  - the choosing: one verify call per candidate (Sonnet 5.5 by default) that PLACES the cut inside the window (the
//    chat often reacts before the payoff lands) and keeps the moment only when it stands alone;
//  - the cut: each kept moment's stretch is fetched from the recording and goes through cutClip as any clip does, with
//    no mark on the clip (the owner dropped the burned-in credit on Nov 18 2026; the source link stays on the collection).
// Prices: reading by the hour of stream (LIVE_RATES) and Clips' per-clip price; settled on what was made.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeLocal, annotateLines, claudeJson, clipsCharge, cutClip, ffmpeg, lengthOf, linesFromWords, loudnessExcess, loudnessTrack, loudPeaks, perClipUsd, captionsPerClip, CLIP_LENGTHS, CLIP_LIMITS, ClipsError, chooseWithClaude, finalizeMoments, windows, type ClipFormat, type ClipLength, type ClipsDeps, type ClipsPrice, type CutCtx, type Line, type Moment, type RawMoment, type SourceInput } from "./studio-clips.js";
import { transcribeWords } from "./studio-eleven.js";
import { hearAudio, sttProvider } from "./studio-stt.js";
import { creditValueFloor, type PlanLike } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import { studioFail } from "./studio-fail.js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { gatherStretch } from "./hls-stretch.js";
import { cutLines, qualityOf } from "./studio-quality.js";
import { type ChatReadReport, hlsVariants, kickGames, kickBroadcastSource, kickBroadcasts, kickChannel, kickChatProbe, kickChatReplay, kickTopStreams, kickSiteLive, twitchGameId, TWITCH_GAME, LiveSourceError, nicheOf, NICHES, parseStreamLink, pickRungs, twitchBroadcastById, twitchBroadcasts, twitchChatReplay, twitchTopStreams, twitchUser, twitchVodPlaylists, twitchLiveNow, isRecordingOf, twitchSearch, twitchFollowers, type Broadcast, type ChatMsg, type LiveDeps, type LiveStream, type Platform, mutedRanges } from "./live-sources.js";

// ---------------------------------------------------------------------------------------------------
// Switches, limits, prices
// ---------------------------------------------------------------------------------------------------
/** The tool exists (STUDIO_LIVE_CLIPS_ENABLED) with the keys it needs; STUDIO_LIVE_CLIPS_OPEN opens it to customers,
 *  else the owner's account alone (the usual owner-first gate). */
export const liveClipsEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.STUDIO_LIVE_CLIPS_ENABLED === "true" && !!env.ANTHROPIC_API_KEY && !!env.ELEVENLABS_API_KEY && !!env.TWITCH_CLIENT_ID && !!env.TWITCH_CLIENT_SECRET;
export const liveClipsOpen = (env: Record<string, string | undefined> = process.env) => liveClipsEnabled(env) && env.STUDIO_LIVE_CLIPS_OPEN === "true";
/** Clipping a stream while it is still on (Nov 21 2026): the recording Twitch keeps writing, read for its newest part.
 *  Off: only the owner sees it; everyone else clips a live stream's recording as before (the whole stream so far). */
export const liveNowOpen = (env: Record<string, string | undefined> = process.env) => env.STUDIO_LIVE_NOW === "true";

/** The part of a broadcast a run reads. A live stream's default is its latest hour: the newest moments are the ones
 *  nobody has posted yet (the competitor's reel of Nov 20 2026 sells exactly that). "since" picks up where a run on the
 *  same stream stopped, so clips keep pace with the stream. */
export type PartScope = "latest_30" | "latest_60" | "latest_120" | "since" | "range" | "all";
export type Part = { from: number; to: number; scope: PartScope };
export const PART_SCOPES: Record<Exclude<PartScope, "since" | "range" | "all">, number> = { latest_30: 1800, latest_60: 3600, latest_120: 7200 };
export function partOf(opt: { scope?: unknown; since?: unknown; from?: unknown; to?: unknown }, seconds: number, live: boolean): Part | null {
  const raw = String(opt?.scope ?? "");
  const scope: PartScope = raw === "latest_30" || raw === "latest_60" || raw === "latest_120" || raw === "since" || raw === "range" || raw === "all" ? raw : live ? "latest_60" : "all";
  const to = Math.max(0, Math.floor(seconds));
  if (scope === "all") return null;
  // any stretch of a broadcast, picked on its timeline (the Clips hub, Nov 21 2026): at least ten minutes, inside it
  if (scope === "range") {
    const a = Math.floor(Number(opt?.from)), z = Math.min(to, Math.floor(Number(opt?.to)));
    if (!Number.isFinite(a) || !Number.isFinite(z) || a < 0 || z <= a) throw new ClipsError("part_invalid", "Pick a stretch of the stream to read", 400);
    if (z - a < LIVE_LIMITS.min_seconds) throw new ClipsError("part_too_short", "Pick at least 10 minutes of the stream", 400);
    return a === 0 && z >= to ? null : { from: a, to: z, scope };
  }
  if (scope === "since") {
    const since = Math.floor(Number(opt?.since));
    if (!Number.isFinite(since) || since < 0 || since >= to) throw new ClipsError("part_nothing_new", "Nothing new has been streamed since that run yet", 400);
    if (to - since < LIVE_LIMITS.min_seconds) throw new ClipsError("part_too_short", `Only ${Math.max(1, Math.round((to - since) / 60))} min of new stream since that run; come back once there are 10`, 400);
    return { from: since, to, scope };
  }
  const span = PART_SCOPES[scope];
  return to <= span ? null : { from: to - span, to, scope };
}
const partWords = (p: Part | null, seconds: number, channel: string, live: boolean): string => {
  const who = `${channel}${live ? " (live)" : ""}`;
  if (!p) return `${Math.round((seconds / 3600) * 10) / 10} h of ${who}${live ? " so far" : ""}`;
  const min = Math.round((p.to - p.from) / 60);
  if (p.scope === "since") return `${min} new min of ${who}`;
  if (p.scope === "range") return `${min >= 60 ? `${Math.round((min / 60) * 10) / 10} h` : `${min} min`} of ${who}, from ${Math.floor(p.from / 3600)}:${String(Math.floor((p.from % 3600) / 60)).padStart(2, "0")}`;
  return `the latest ${min >= 60 && min % 60 === 0 ? `${min / 60 === 1 ? "hour" : `${min / 60} hours`}` : `${min} min`} of ${who}`;
};
/** A broadcast of any length the platform still keeps (Twitch keeps up to 48 hours): the reading is by windows, so
 *  length only adds chat pages; the model checks are capped by verify_max whatever the length. */
export const LIVE_LIMITS = { min_seconds: 600, max_seconds: 48 * 3600, max_clips: 50, min_chat_per_minute: 15, verify_per_clip: 4, verify_extra: 8, verify_max: 60 };
/** Prices (RESEARCH.md 6.5, revised with experiment 1): reading a past stream by the hour (the chat, and about four
 *  candidate windows an hour heard and checked), at least the minimum; and each clip, which carries the two or three
 *  extra windows it took to find it (experiment 1: a third to a half of the checked windows become clips), so a stream
 *  clip is 10 credits where a Clips clip is 5. */
export const LIVE_RATES = { per_hour: 15, min: 30, /** the reading is charged for the first hours only: our cost of reading does not grow past this (the checks are capped) */ hours_cap: 8, per_clip: { short: 10, standard: 10, long: 12, minute: 12 } as Record<ClipLength, number>,
  /** a stream still on: the reading is at least this much per clip asked for. The checks grow with the clips asked
   *  (about $0.10 each, measured on the 16 stream runs to Nov 21 2026) while only clips made are charged, and a live
   *  part is short, so its 30-credit reading alone did not cover a run that found 2 of 10 (owner's yes, Nov 21 2026) */
  live_per_asked: 4 };
/** What it costs us, at list (6.4): the chat (calls), each candidate's window heard (2.5 min of Scribe at $0.20/h) and
 *  verified (Sonnet 5.5 with six stills), the worker's time; four windows an hour in the reading, two more per clip. */
export const LIVE_COST = { chat_usd_per_hour: 0.002, worker_usd_per_hour: 0.006, listen_usd_per_candidate: 0.0083, verify_usd_per_candidate: 0.02, candidates_per_hour: 4, extra_candidates_per_clip: 2 };
export const LIVE_SAFETY_MARGIN = { analysis: 0.35, clip: 0.5 };
const credits = (usd: number, floor: number, margin: number) => Math.ceil(usd / ((1 - margin) * floor) - 1e-9);
const windowUsd = () => LIVE_COST.listen_usd_per_candidate + LIVE_COST.verify_usd_per_candidate;
export function streamAnalysisUsd(seconds: number): number {
  const hours = seconds / 3600;
  return hours * (LIVE_COST.chat_usd_per_hour + LIVE_COST.worker_usd_per_hour + LIVE_COST.candidates_per_hour * windowUsd());
}
export const streamClipUsd = (length: ClipLength, env: Record<string, string | undefined>) => perClipUsd(length, env, false) + LIVE_COST.extra_candidates_per_clip * windowUsd();
export function streamPrice(plans: PlanLike[], p: { seconds: number; length: ClipLength; count?: number; env: Record<string, string | undefined>; /** a stream still on, read in its newest part */ live?: boolean }): ClipsPrice {
  const floor = plans.length ? creditValueFloor(plans) : 0.016;
  const hours = Math.min(p.seconds / 3600, LIVE_RATES.hours_cap);
  return {
    analysis: Math.max(LIVE_RATES.min, Math.ceil(hours * LIVE_RATES.per_hour), credits(streamAnalysisUsd(hours * 3600), floor, LIVE_SAFETY_MARGIN.analysis), p.live && p.count ? p.count * LIVE_RATES.live_per_asked : 0),
    per_clip: Math.max(LIVE_RATES.per_clip[p.length], credits(streamClipUsd(p.length, p.env), floor, LIVE_SAFETY_MARGIN.clip)),
    lite: 0,
  };
}
/** About how many clips a stream holds and the most a run tries for: a strong moment every 15-20 minutes on a busy
 *  stream; never more than one per two minutes of stream. */
export const likelyStreamClips = (seconds: number) => Math.max(1, Math.min(LIVE_LIMITS.max_clips, Math.round(seconds / 1000)));
export const streamCountCap = (seconds: number) => Math.max(1, Math.min(LIVE_LIMITS.max_clips, Math.floor(seconds / 120)));
export type Strictness = "best" | "balanced" | "more";
/** The bar the checklist score must clear. The checklist (phase B) grades the same moments 15-25 points under the old
 *  single score (Nov 19 2026, the same 35-hour stream: 72 -> 60, 62 -> 42, 72 -> 33), so the bars sit lower than they did. */
// "Only the best" clears the same bar as "Balanced" (owner, Nov 20 2026): the stricter bar of 65 left runs far short
// (a customer asked twice for 10 and got 2, with 13 moments at 55-64 each time); the choice stays in the app.
export const VERIFY_BAR: Record<Strictness, number> = { best: 55, balanced: 55, more: 45 };
const strictnessOf = (v: unknown): Strictness => (v === "best" || v === "more" ? v : "balanced");
export type Framing = "auto" | "stacked" | "person";
const framingOf = (v: unknown): Framing => (v === "stacked" || v === "person" ? v : "auto");

// ---------------------------------------------------------------------------------------------------
// The streamer registry (RESEARCH.md section 3): who may be clipped how. Phase 1: a data file plus an environment
// block list; the opt-out page and the stored table come with the posting phase.
// ---------------------------------------------------------------------------------------------------
export type Permission = "campaign" | "unknown" | "blocked";
import registry from "./data/live-streamers.json" with { type: "json" };
import { youtubeFeed } from "./youtube-feed.js";
export function streamerPermission(platform: Platform, login: string, env: Record<string, string | undefined> = process.env): Permission {
  const key = `${platform}:${login.toLowerCase()}`;
  const blocked = new Set([...(registry.block ?? []), ...String(env.STUDIO_LIVE_BLOCK ?? "").split(/[\s,]+/).filter(Boolean)].map((x: string) => x.toLowerCase()));
  if (blocked.has(key) || blocked.has(login.toLowerCase())) return "blocked";
  const allowed = new Set((registry.campaign ?? []).map((x: string) => x.toLowerCase()));
  return allowed.has(key) || allowed.has(login.toLowerCase()) ? "campaign" : "unknown";
}

// ---------------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------------
export type StreamSource = { platform: Platform; url: string; asset_id: null; title: string | null; channel: string | null; login: string; channel_id: string; vod_id: string; seconds: number; started_at: string; thumbnail_url: string | null; permission: Permission; /** clipped while it was on, and which part */ live?: boolean; part?: Part };
export type StreamQuote = { tool: "clips"; credits: number; options: Record<string, any>; summary: string };
/** A minute's memory for what many people ask Twitch the same way (search, channels, broadcasts): Helix allows ~800 calls
 *  a minute for the whole app, and a timeline drag or a busy hub must not spend it (audit, Nov 21 2026). */
const brief = new Map<string, { at: number; v: Promise<any> }>();
export function briefly<T>(key: string, ms: number, make: () => Promise<T>): Promise<T> {
  const now = Date.now(), had = brief.get(key);
  if (had && now - had.at < ms) return had.v;
  const v = make(); brief.set(key, { at: now, v });
  v.catch(() => { if (brief.get(key)?.v === v) brief.delete(key); });
  if (brief.size > 2000) for (const [k, x] of brief) if (now - x.at > ms) brief.delete(k);
  return v;
}
export const resetBrief = () => brief.clear();
/** The broadcast behind a link: Twitch by id (official), Kick by uuid (the site's listing of its channel). */
export function resolveBroadcast(deps: LiveDeps, url: string): Promise<Broadcast> {
  return briefly(`b:${url}`, 45_000, () => resolveBroadcastNow(deps, url));
}
async function resolveBroadcastNow(deps: LiveDeps, url: string): Promise<Broadcast> {
  const link = parseStreamLink(url);
  if (!link) throw new ClipsError("unsupported_link", "Live Clips takes a Twitch or Kick link to a past broadcast");
  if (link.kind !== "vod") throw new ClipsError("pick_broadcast", "That is a channel: pick one of its past broadcasts", 400);
  if (link.platform === "twitch") {
    const b = await twitchBroadcastById(deps, link.id!);
    if (!b) throw new ClipsError("link_no_media", "No past broadcast is at that link (Twitch keeps them 7 to 60 days)", 404);
    const now = b.channel_id ? await twitchLiveNow(deps, b.channel_id).catch(() => null) : null;
    return isRecordingOf(b, now) ? { ...b, live: true, thumbnail_url: now!.thumbnail_url ?? b.thumbnail_url } : b;
  }
  const src = await kickBroadcastSource(deps, link.id!);
  const slug = link.login ?? ""; if (!slug) throw new ClipsError("pick_broadcast", "Use the broadcast's link from the channel's page (kick.com/<channel>/videos/…)", 400);
  const ch = await kickChannel(deps, slug);
  const list = await kickBroadcasts(deps, slug, ch);
  const b = list.find((x) => x.id === link.id);
  if (!b) throw new ClipsError("link_no_media", "That broadcast is no longer listed on the channel (Kick keeps replays 7 to 30 days)", 404);
  return { ...b, started_at: src.started_at || b.started_at };
}
export async function quoteStreamClips(deps: ClipsDeps & LiveDeps, plans: PlanLike[], options: any, o: { owner?: boolean } = {}): Promise<StreamQuote> {
  const env = deps.env ?? process.env;
  if (!liveClipsEnabled(env)) throw new ClipsError("tool_not_open", "Live Clips is not switched on yet", 503);
  if (!liveClipsOpen(env) && !o.owner) throw new ClipsError("tool_not_open", "Live Clips is not open yet", 503);
  const opt = options && typeof options === "object" ? options : {};
  const b = await resolveBroadcast(deps, String(opt.url ?? ""));
  const permission = streamerPermission(b.platform, b.login, env);
  if (permission === "blocked") throw new ClipsError("streamer_blocked", `${b.channel} has asked not to be clipped on Clone8`, 403);
  // a stream still on: its newest part, for Creator and up (the job route checks the plan) once STUDIO_LIVE_NOW is on
  const live = !!b.live && (liveNowOpen(env) || !!o.owner);
  // a stream still on is read in parts only where Live is open to this person (Creator and up, in the job route); else it
  // is the whole stream so far, as before (a hand-made "range" must not reach its newest part around the plan)
  const part = b.live && !live ? null : partOf(opt, b.seconds, live);
  const span = part ? part.to - part.from : b.seconds;
  if (b.seconds < LIVE_LIMITS.min_seconds) throw new ClipsError("clip_source_too_short", b.live ? "This stream started under 10 minutes ago; come back once there is more of it" : "That broadcast is under 10 minutes");
  if (b.seconds > LIVE_LIMITS.max_seconds) throw new ClipsError("clip_source_too_long", `That broadcast is ${Math.round(b.seconds / 3600)} hours; Live Clips reads up to 48 hours of a stream`);
  const length = lengthOf(opt.length), format: ClipFormat = opt.format === "original" ? "original" : "vertical";
  const likely = likelyStreamClips(span), cap = streamCountCap(span);
  const asked = Math.round(Number(opt.count));
  const count = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, cap) : Math.min(likely, 10);
  const price = streamPrice(plans, { seconds: span, length, count, env, live });
  // captions are the person's choice (the owner, Nov 19 2026: not on by default), priced as on the Clips page; a clip made
  // without them keeps its words, so the Captions page can add them afterwards
  const captions = opt.captions && typeof opt.captions === "object" ? (await import("./studio-caption-video.js")).cleanSettings(opt.captions) : null;
  if (captions) price.per_clip += captionsPerClip(env);
  const source: StreamSource = { platform: b.platform, url: b.url, asset_id: null, title: b.title || null, channel: b.channel || null, login: b.login, channel_id: b.channel_id, vod_id: b.id, seconds: b.seconds, started_at: b.started_at, thumbnail_url: b.thumbnail_url, permission, ...(live ? { live: true, part: part ?? { from: 0, to: b.seconds, scope: "all" as const } } : {}) };
  const minutes = Math.ceil(span / 60), hours = Math.round((span / 3600) * 10) / 10;
  const what = part ? `${hours}-hour stretch` : `${hours}-hour stream`;
  const kept = await chatKept(deps, b, part);
  const countWarning = Number.isFinite(asked) && asked > cap ? `A ${what} fits at most ${cap} clips, so we'll aim for ${cap}. You're only charged for the clips we make.`
    : count > likely ? `A ${what} usually holds about ${likely} strong ${likely === 1 ? "clip" : "clips"}. We'll make as many as the chat really reacted to, up to ${count}; you're only charged for the clips we make.` : null;
  // no chat kept for the part (Nov 25 2026): heard whole instead when it is short enough, else how to pick one that is
  const noChat = kept === 0 ? (listenOnly(0, 0, part, b.seconds, env)
    ? `${noChatWords(b, part ? "this part of the stream" : "this stream", (deps as any).now?.() ?? Date.now())}, so we'll find its moments by listening to every word instead of following the chat.`
    : `${noChatWords(b, part ? "this part of the stream" : "this stream", (deps as any).now?.() ?? Date.now())}. Pick a part of up to ${listenHours(env)} hours and we'll find its moments by listening to it.`) : null;
  const warning = [noChat, countWarning].filter(Boolean).join(" ") || null;
  // how long, from the Nov 18 2026 live runs (a 7.8 h stream: chat in 15 s, 34 checks in 666 s, 5 cuts in 157 s; the
  // old formula promised 42 min for that 14-min run): the chat, then each candidate heard and checked, then the cuts
  const cands = Math.min(LIVE_LIMITS.verify_max, count * LIVE_LIMITS.verify_per_clip + LIVE_LIMITS.verify_extra);
  // Kick's chat replay is read 25 messages a call at Kick's pace (~2 calls a second): a 3.4 h stream took 84 s (Nov 22
  // 2026); a busier chat takes longer; Twitch's comes in a few big pages
  const eta_seconds = Math.round(45 + (b.platform === "kick" ? b.seconds / 120 : b.seconds * 0.004) + cands * 22 + count * 35 + ((deps.env ?? process.env).STUDIO_LIVE_HYBRID !== "off" && span >= HYBRID.min_heard_s ? (part ? 60 + span * 0.03 : 240) : 0));
  return {
    tool: "clips", credits: clipsCharge(price, count),
    options: { platform: b.platform, url: b.url, stream: { platform: b.platform, vod_id: b.id, login: b.login, channel_id: b.channel_id, started_at: b.started_at, permission, strictness: strictnessOf(opt.strictness), framing: framingOf(opt.framing), ...(live ? { live: true } : {}) }, ...(part ? { part } : {}),
      format, length, count, likely, cap, max_clips: count, seconds: b.seconds, minutes, source, youtube_direct: true, price, warning, ...(kept !== null ? { chat_kept: kept > 0 } : {}), language: "original", captions, eta_seconds, ahead: 0, quality: qualityOf(opt.quality) },
    summary: `${part || live ? partWords(part, b.seconds, b.channel, live) : `${hours} h of ${b.channel}`} · up to ${count} ${count === 1 ? "clip" : "clips"}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// The detector: the chat's content against its own baseline (RESEARCH.md 4.1-4.2, measured in experiment 1)
// ---------------------------------------------------------------------------------------------------
const LAUGH = /\b(LUL\w*|KEKW|OMEGALUL|LMAO+|LMFAO|HAHA+|LOL+|KEK|XD)\b|😂|💀|🤣/i;
const HYPE = /\b(W|POG\w*|LETS ?GO+|GG|HOLY|NO WAY|WTF|OMG|INSANE|CRAZY|NAH|BRUH|WHAT|CLUTCH|SHEESH)\b|🔥|😱|\?\?\?+|!!!+/i;
const CAPS = /^[^a-z]{6,}$/;
const SHOCK = /\b(monkaS|WutFace|O_O|NOOO+|AYO+|PAUSE|JESUS|OH NO+)\b|😳|😨|🫢/i;
const ASK = /\bclip/i;
/** Per 10-second bin (phase A of research/viral-signals.md, Nov 18 2026): the counts, and the people and the shape
 *  behind them. `reactors` = distinct users who reacted (caps, laughter, hype, shock, an emote, a clip ask): a wave of
 *  people, not a loud few. `len` = mean message length; `alike` = the share of messages that repeat the bin's most
 *  common one; during a highlight messages get shorter and more alike. `topShare` = the busiest user's share of the
 *  bin; `sameUsers` = how many different users sent the most common message (a chant from many, or one spammer). */
export type ChatSignals = { bins: number; rate: number[]; distinct: number[]; laugh: number[]; hype: number[]; shock: number[]; same: number[]; caps: number[]; emote: number[]; asks: number[]; reactors: number[]; len: number[]; alike: number[]; topShare: number[]; sameUsers: number[]; perMinute: number };
export function chatSignals(msgs: ChatMsg[], seconds: number): ChatSignals {
  const bins = Math.max(1, Math.ceil(seconds / 10) + 1);
  const by: ChatMsg[][] = Array.from({ length: bins }, () => []);
  for (const m of msgs) { const b = Math.floor(m.t / 10); if (b >= 0 && b < bins) by[b].push(m); }
  const z = () => new Array(bins).fill(0);
  const s: ChatSignals = { bins, rate: z(), distinct: z(), laugh: z(), hype: z(), shock: z(), same: z(), caps: z(), emote: z(), asks: z(), reactors: z(), len: z(), alike: z(), topShare: z(), sameUsers: z(), perMinute: msgs.length / Math.max(1, seconds / 60) };
  for (let b = 0; b < bins; b++) {
    const w = by[b]; s.rate[b] = w.length; if (!w.length) continue;
    const users = new Map<string, number>(); const same = new Map<string, Set<string>>(); const reactors = new Set<string>(); let chars = 0;
    for (const m of w) {
      const t = m.c.trim(); let reacted = false;
      if (LAUGH.test(t)) { s.laugh[b]++; reacted = true; }
      if (HYPE.test(t)) { s.hype[b]++; reacted = true; }
      if (SHOCK.test(t)) { s.shock[b]++; reacted = true; }
      if (CAPS.test(t)) { s.caps[b]++; reacted = true; }
      if (m.e > 0) { s.emote[b]++; reacted = true; }
      if (ASK.test(t)) reacted = true;
      if (reacted) reactors.add(m.u);
      users.set(m.u, (users.get(m.u) ?? 0) + 1);
      const k = t.toLowerCase(); if (!same.has(k)) same.set(k, new Set()); same.get(k)!.add(m.u);
      chars += Math.min(t.length, 200);
    }
    s.distinct[b] = users.size; s.reactors[b] = reactors.size; s.len[b] = chars / w.length;
    let top = 0, topUsers = 0; for (const [k, u] of same) { const c = w.filter((m) => m.c.trim().toLowerCase() === k).length; if (c > top) { top = c; topUsers = u.size; } }
    s.same[b] = top; s.sameUsers[b] = topUsers; s.alike[b] = top / w.length;
    s.topShare[b] = Math.max(...users.values()) / w.length;
    s.asks[b] = new Set(w.filter((m) => ASK.test(m.c)).map((m) => m.u)).size;
  }
  return s;
}
/** Robust z of each bin against the previous ten minutes (60 bins; at least 12): (x − median) / MAD. */
export function robustZ(x: number[], back = 60, least = 12): number[] {
  const out = new Array(x.length).fill(0);
  for (let b = least; b < x.length; b++) {
    const hist = x.slice(Math.max(0, b - back), b).slice().sort((a, c) => a - c);
    const med = hist[Math.floor(hist.length / 2)];
    const dev = hist.map((v) => Math.abs(v - med)).sort((a, c) => a - c)[Math.floor(hist.length / 2)] || 1;
    out[b] = (x[b] - med) / dev;
  }
  return out;
}
export type Candidate = { rank: number; onset: number; peak: number; last: number; t_event: number; score: number; zs: Record<string, number>; asks: number; sample: string[];
  /** "words" when Clips' picker found it in a read hour (HYBRID), else the chat's; `cut` is the picker's proposed cut (absolute seconds), on a chat candidate too when the picker marked the same minute */
  source?: "chat" | "words"; cut?: { start: number; end: number }; title?: string };
/** How much chat is read around a part of a stream: before it, the chat's usual pace (a burst is a burst against it);
 *  after it, room for the end-of-broadcast skip only at the real end. */
export const CHAT_AROUND = { before_s: 900, after_s: 300 };
export const CANDIDATE = { combined: 6, single: 3, rate_only: 3, asks: 3, merge_s: 90, min_messages: 8,
  /** a burst stays open while the combined signal holds this much (hysteresis); off: it chained neighbouring moments into one on the Nov 18 chats */ sustain: Infinity,
  /** a moment is at most this long; a longer wave of chat is several moments (a saturated chat merged whole stretches into one candidate) */ max_span_s: 180,
  /** weights of the people and shape terms beside the content burst */ w_reactors: 0.5, w_shape: 0.5, w_shock: 0.5,
  /** the checking order spreads over the stream: first one candidate from each ten minutes, then up to three, then the rest (one long hype stretch used to fill the whole checked set) */ diversity_window_s: 600, tiers: [1, 3] as readonly number[],
  /** the first and last stretch of a broadcast are greetings and raid-outs, never clips */ skip_start_s: 180, skip_end_s: 120,
  /** spam, and the bin cannot open or extend a candidate: one user over this share of a bin, or the bin's chant coming from fewer than `chant_users` people while it is over `chant_share` of the bin (a lone spammer's z against a quiet chat runs to 90; no weight tames it) */ spam_user_share: 0.3, chant_users: 3, chant_share: 0.4 };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The moments the chat points at, strongest first: bins where the combined burst is high (content and shape, and the
 *  people behind it), or one content signal alone, or the rate alone on a small chat, or people asking for a clip;
 *  a burst extends while it sustains, and bursts within 90 s are one. */
export function chatCandidates(s: ChatSignals, msgs: ChatMsg[], o: Partial<typeof CANDIDATE> & { /** relax the bars step by step until this many candidates come out (a saturated chat hides its bursts) */ atLeast?: number } = {}): Candidate[] {
  const C = { ...CANDIDATE, ...o };
  const seconds = (s.bins - 1) * 10;
  const Z = { caps: robustZ(s.caps), laugh: robustZ(s.laugh), hype: robustZ(s.hype), shock: robustZ(s.shock), same: robustZ(s.same), emote: robustZ(s.emote), rate: robustZ(s.rate), distinct: robustZ(s.distinct),
    reactors: robustZ(s.reactors), short: robustZ(s.len.map((x) => -x)), alike: robustZ(s.alike) };
  const out: Candidate[] = []; let cur: Candidate | null = null;
  for (let b = 0; b < s.bins; b++) {
    const t = b * 10;
    if (s.rate[b] < C.min_messages || t < C.skip_start_s || t > seconds - C.skip_end_s) continue;
    const content = Z.caps[b] + Z.laugh[b] + Z.hype[b] + Z.same[b] + Z.emote[b] + C.w_shock * Z.shock[b];
    const shape = clamp(Z.short[b], -2, 3) + clamp(Z.alike[b], -2, 3);
    if (s.topShare[b] > C.spam_user_share || (s.sameUsers[b] < C.chant_users && s.alike[b] > C.chant_share)) continue;
    const combined = content + C.w_reactors * clamp(Z.reactors[b], -2, 6) + 0.5 * Z.distinct[b] + C.w_shape * shape;
    const single = Math.max(Z.caps[b], Z.laugh[b], Z.hype[b]);
    const rateBurst = Z.rate[b] >= C.rate_only && Z.distinct[b] >= 2 && s.rate[b] >= 2.5 * Math.max(1, s.rate[Math.max(0, b - 30)]);
    const ok = combined >= C.combined || single >= C.single || rateBurst || s.asks[b] >= C.asks;
    const holds = !!cur && t - cur.last <= C.merge_s && combined >= C.sustain;
    if (!ok && !holds) continue;
    const score = combined + (s.asks[b] >= C.asks ? 6 : 0);
    const zs = Object.fromEntries(Object.entries(Z).map(([k, v]) => [k, Math.round(v[b] * 10) / 10]));
    if (cur && t - cur.last <= C.merge_s && t - cur.onset <= C.max_span_s) {
      cur.last = t;
      if (score > cur.score) { cur.score = score; cur.peak = t; cur.zs = zs; cur.asks = s.asks[b]; }
    } else if (ok) { cur = { rank: 0, onset: t, peak: t, last: t, t_event: Math.max(0, t - 8), score, zs, asks: s.asks[b], sample: [] }; out.push(cur); }
  }
  for (const c of out) {
    const w = msgs.filter((m) => m.t >= c.peak && m.t < c.peak + 10);
    // (the loudest first: all-caps, then laughter and hype, then the rest)
    const rank = (m: ChatMsg) => (CAPS.test(m.c.trim()) ? 0 : LAUGH.test(m.c) || HYPE.test(m.c) ? 1 : 2);
    c.sample = w.map((m, i) => ({ m, i })).sort((x, y) => rank(x.m) - rank(y.m) || x.i - y.i).slice(0, 8).map(({ m }) => m.c.slice(0, 40));
  }
  if (o.atLeast && out.length < o.atLeast && C.combined > CANDIDATE.combined * 0.5) return chatCandidates(s, msgs, { ...o, combined: C.combined * 0.8, single: C.single * 0.85, sustain: C.sustain * 0.8 });
  out.sort((a, b) => b.score - a.score);
  // the order the run checks them in: strongest first, but no ten minutes of the stream gets more than `per_window`
  // places before every other part has had its turn; the deferred ones follow, still strongest first
  const ordered: Candidate[] = []; const taken = new Set<Candidate>(); const seen = new Map<number, number>();
  for (const cap of [...C.tiers, Infinity]) for (const c of out) {
    if (taken.has(c)) continue;
    const w = Math.floor(c.peak / C.diversity_window_s); const k = seen.get(w) ?? 0;
    if (k < cap) { seen.set(w, k + 1); taken.add(c); ordered.push(c); }
  }
  return ordered.map((c, k) => ({ ...c, rank: k + 1, score: Math.round(c.score * 10) / 10 }));
}

// ---------------------------------------------------------------------------------------------------
// Hearing a candidate and placing its cut (4.3-4.4): the window is 45 s before the chat's onset to 105 s after
// ---------------------------------------------------------------------------------------------------
export const WINDOW = { lead: 45, length: 150 };
/** The model's cut at the edge of what was heard: when its end lands within `near` seconds of the window's end, `more`
 *  seconds are heard and the cut closes on the first thought that ends in them. A clip ended on "You know about" on
 *  Nov 19 2026: the moment the model chose was 100 s after the chat's mark and ran into the window's edge. */
export const EDGE = { near: 3, more: 30 };
/** A line that ends a sentence (a cut may end on it); the lines also break at pauses, which is not the same thing. */
const SENTENCE_END_RE = /[.!?\u2026]["')\]]*$/;
/** Where the checks go: once an hour of the stream has given `after` verdicts and no keep, its other candidates wait
 *  behind everyone else's (checked only if budget is left). The Nov 19 2026 run spent a third of its checks on two
 *  hours of Fortnite the verifier turned down one by one, while every keep came from the IRL hours. */
export const COLD = { bucket_s: 3600, after: 2 };
/** The hybrid (research/baseline-clips-picker.md, Nov 19 2026): the hours where the chat reacted most are heard whole and
 *  read by Clips' own picker, so the talk that stands alone without a burst is found too, and a chat moment the picker
 *  also marked gets its cut from the words. At most `hours` hours, each at least `min_heard_s` long and not muted; the
 *  picker's model is Haiku unless STUDIO_LIVE_PICK_MODEL says otherwise (an hour: Opus $0.29, Sonnet $0.16, Haiku
 *  $0.014; on hour 2 of the Nov 19 2026 stream the verifier kept 2 of Haiku's 6 moments and 3 of Sonnet's 6, one of
 *  Haiku's being the Home Depot moment Sonnet missed). The hours' sound goes through the door studio-stt.ts chooses;
 *  the windows are always Scribe's (the verdict and the cut need the exact words). Checks that fall inside a read hour take their words from it (no
 *  fetch, no second transcription). Off with STUDIO_LIVE_HYBRID=off. */
export const HYBRID = { hours: 2, min_heard_s: 600, wanted_per_window: 5, near_s: 90, pick_model: "claude-haiku-5-5", /** a window around a cut the picker proposed, when the words are free */ max_span_s: 240 };
/** How many hours a run reads: HYBRID.hours, or STUDIO_LIVE_HYBRID_HOURS (the first run of Nov 19 2026 read three for $1.47
 *  a run against $2.40 at the floor, 39 %; two is about $1.15, 52 %). */
export function hybridHours(env: Record<string, string | undefined> = process.env): number { const n = Number(env.STUDIO_LIVE_HYBRID_HOURS); return Number.isFinite(n) && n > 0 ? Math.min(6, Math.round(n)) : HYBRID.hours; }
/** A moment turned down because posting it would be taken down or get the account restricted (the checker's hard fail
 *  or its reason): explicit sexual content, slurs, drugs, self-harm, real violence. */
export const UNSAFE = /sexual|explicit|nudity|nude|porn|slur|homophob|racis|drug|self-harm|suicide|real violence|gore/i;
/** Owner, Nov 22 2026: when a stream's moments were turned down for this, say so, and why it protects them. */
export function unsafeNote(unsafe: number, checked: number): string {
  if (!(unsafe >= 2 || (unsafe >= 1 && unsafe === checked)) || unsafe < checked * 0.2) return "";
  return ` ${unsafe === checked ? (unsafe === 1 ? "It was" : `All ${unsafe} were`) : `${unsafe} of the moments we passed on were`} explicit content or slurs. We leave those out on purpose: TikTok, Instagram and YouTube take posts like that down and can restrict or ban the account that posts them.`;
}
export const VERIFY_SYSTEM = `You are the best short-form video editor alive, checking ONE candidate moment from a live stream before it is cut into a 20-55 second vertical clip for TikTok, Reels and Shorts. The moment was found by the stream's own chat reacting (the burst is marked on the transcript) and by the sound. You see the transcript of the window with its signals, and stills from it. Decide whether this is a clip a stranger would stop for, and where exactly it should start and end.

Keep it only if ALL hold: it stands alone (no context needed from earlier in the stream, no "as I said"); it has a payoff (a laugh, a shock, a win, a fail, a reveal, a line that lands) and the clip ends right after it; it is not a sponsor read, an ad break, a "be right back" screen, music only, or the streamer reading a chat message that needs the chat to be seen; it is not just the game's cutscene with the streamer silent unless the picture itself is the payoff.

The proposed cut is only a first guess from the chat's timing. YOUR job is to find the best clip inside the whole window: if the payoff comes later than the proposed end (the chat often reacts before the moment finishes), move end_line to the line where the payoff lands plus the reaction it earns. Open on the hook: start_line is the first line a stranger needs, as late as possible. A line that only exists because the stream was running (a transaction, a greeting, "okay so", waiting, small talk, the streamer reading chat) is never the first line; setup lines stay only when the payoff makes no sense without them, and then the fewest. A clip that opens on the stake or the turn itself and lets the reaction run beats one that opens ten seconds before it. End right after the reaction the payoff earns; never trail into the next topic. The clip must be 20 to 55 seconds and start where a thought starts. Judge the moment with YOUR boundaries, not the proposed ones.

Language: judge every clip for viewers who speak the stream's language. A stream in French, Arabic, Spanish or any other language is never marked down for not being in English, and a mix is normal: many streamers (an American streamer with an Arab, Latino or other background, say) drop words or lines of another language into their talk. A little mixing is never a reason to lower a grade or turn a moment down; "a stranger" below means a stranger who follows the stream's main language.\n\nGrade six things, each 0-10, strictly (10 is the best clip of the month, 5 is ordinary, 2 is weak):
- hook: does the first line or the first picture of YOUR cut already show the stakes or the reaction, with no greeting, no dead air, no warm-up?
- standalone: would a stranger who never saw this stream understand it with no context? 8+ means fully; under 6 means it needs the stream.
- payoff: is there a clear turn (a fail, a win, a reveal, a punchline, a shock) that lands in the second half, best in the last ten seconds (where the clips that win on TikTok put it), with the reaction after it inside the clip and nothing after the reaction?
- reaction: how strong is the visible or audible reaction (a laugh, a scream, a silence, a chat explosion)?
- quotable: is there one line a stranger would repeat, that works as the caption?
- length: does the cut fit 20 to 45 seconds with nothing to trim? (over 50 needs two beats)
hard_fail: empty, or one short reason when the clip must never go out whatever the grades: a song is the whole point of the moment with nothing worth hearing over it (a DJ set, singing along, a music break; game radio or background music under the streamer's talk is NOT a hard fail); a slur, doxxing or a real person humiliated; it needs the previous five minutes (when "the five minutes before the window" are given, read them first: the clip fails for context only if a stranger needs something from there that no line inside the window carries); it starts mid-sentence with no way to start earlier; a sponsor read, an ad break, a "be right back" screen; explicit sexual content, drug use, self-harm or real violence as the point of the clip (the platforms suppress these; swearing and crude banter are fine). When such a line is only the tail of an otherwise good moment, end the clip before it instead of failing it.
Also give score 0-100 as your overall feeling. start_line is the first line of the clip and end_line the last, using the line numbers exactly as given. title under 60 characters in the stream's language, no hashtags; hook: the first spoken line, under 100 characters; hook_line: the words to put on screen for the first two seconds, 3 to 6 words, a stake or a tease, never "insane moment", in the stream's language; caption: one sentence a stranger could post the clip with, under 110 characters, no hashtags; why under 15 words; why_not under 15 words when it should not be kept (empty otherwise); tags: 1 to 3 lowercase topic words.`;
/** The checklist's weights (research/viral-signals.md 4d): hook 25, standalone 20, payoff 20, reaction 15, quotable 10, length 5. */
export const CHECKLIST = { hook: 0.25, standalone: 0.2, payoff: 0.2, reaction: 0.15, quotable: 0.1, length: 0.05 } as const;
export type Grades = Record<keyof typeof CHECKLIST, number>;
/** The checklist as one 0-100 score; a verdict without grades (older seams) falls back to the model's own score. */
export function checklistScore(v: { score: number; grades?: Grades | null }): number {
  if (!v.grades) return Math.max(0, Math.min(100, Math.round(v.score)));
  let total = 0; for (const k of Object.keys(CHECKLIST) as Array<keyof typeof CHECKLIST>) total += CHECKLIST[k] * Math.max(0, Math.min(10, Number(v.grades[k]) || 0)) * 10;
  return Math.round(total);
}
export const VERIFY_SCHEMA = { type: "object", additionalProperties: false, required: ["keep", "score", "standalone", "grades", "hard_fail", "start_line", "end_line", "title", "hook", "hook_line", "caption", "why", "why_not", "tags"],
  properties: { keep: { type: "boolean" }, score: { type: "integer" }, standalone: { type: "boolean" },
    grades: { type: "object", additionalProperties: false, required: ["hook", "standalone", "payoff", "reaction", "quotable", "length"], properties: { hook: { type: "integer" }, standalone: { type: "integer" }, payoff: { type: "integer" }, reaction: { type: "integer" }, quotable: { type: "integer" }, length: { type: "integer" } } },
    hard_fail: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" }, title: { type: "string" }, hook: { type: "string" }, hook_line: { type: "string" }, caption: { type: "string" }, why: { type: "string" }, why_not: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export type Heard = { words: Array<{ text: string; start: number; end: number; speaker: string | null }>; events: Array<{ text: string; start: number; end: number }>; lines: Line[]; excess: number[] | null; language: string | null };
/** The first guess at the cut on the lines: a thought that opens 5-20 s before the event (it was 8-25 s until Nov 19
 *  2026, and the clips opened on checkout chatter); a thought that closes once the chat has started falling (or 12 s
 *  past its peak), carried past a laugh. 20-55 s. The verifier moves both ends; this is only its starting point. */
export function firstCut(lines: Line[], eventRel: number, peakRel: number, chatAt: (rel: number) => number, base: number, events: Heard["events"]): { s: number; e: number } {
  if (!lines.length) return { s: 0, e: 0 };
  const opens = (k: number) => k === 0 || !!lines[k].opens, closes = (k: number) => k === lines.length - 1 || !!lines[k].closes;
  let s = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 5 && lines[k].start >= eventRel - 20) { s = k; break; }
  if (s < 0) for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 5) { s = k; break; }
  if (s < 0) s = 0;
  let fall = peakRel + 12; for (let t = peakRel + 3; t < peakRel + 40; t++) if (chatAt(t) < 1.5 * Math.max(base, 1)) { fall = Math.min(fall, t); break; }
  let e = -1; for (let k = 0; k < lines.length; k++) if (lines[k].end >= fall && closes(k)) { e = k; break; }
  if (e < 0) e = lines.length - 1;
  if (e < s) e = s;
  const span = () => lines[e].end - lines[s].start;
  while (span() < 20 && e < lines.length - 1) { e++; while (e < lines.length - 1 && !closes(e)) e++; }
  while (span() > 55 && e > s) { e--; while (e > s && !closes(e)) e--; }
  while (span() > 55 && s < e) { s++; while (s < e && !opens(s)) s++; }
  void events;
  return { s, e };
}
type Verdict = { keep: boolean; score: number; standalone: boolean; grades?: Grades | null; hard_fail?: string; start_line: number; end_line: number; title: string; hook: string; hook_line?: string; caption?: string; why: string; why_not: string; tags: string[] };

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number; created_at?: string; signal?: AbortSignal };
export type StreamDeps = ClipsDeps & LiveDeps & {
  /** for tests: the chat replay, the playlists, the hearing of one window, the verify call, the cutter */
  chat?: (b: Broadcast, onProgress: (share: number) => void) => Promise<ChatMsg[]>;
  playlists?: (b: Broadcast) => Promise<{ audio: string; video: string }>;
  hear?: (audioFile: string, dir: string, seconds?: number) => Promise<Heard>;
  /** for tests: an hour heard whole (HYBRID), and Clips' picker on a window of its lines */
  hearHour?: (audioFile: string, seconds: number) => Promise<{ words: Heard["words"]; events: Heard["events"]; language: string | null }>;
  pick?: (lines: Line[]) => Promise<RawMoment[]>;
  /** for tests: a kept clip heard again (Scribe, for its speakers) when the cheap door heard the windows */
  hearClip?: (audioFile: string, seconds: number) => Promise<{ words: Heard["words"]; events: Heard["events"]; language: string | null }>;
  verify?: (input: { lines: Line[]; stills: Array<{ t: number; jpg: Buffer }>; head: string; body: string }) => Promise<Verdict>;
  /** for tests: the head-to-head order of the kept moments (indexes into the list, best first) */
  rerank?: (moments: Moment[]) => Promise<number[] | null>;
  stills?: (video: string, times: number[], dir: string, tag: string) => Promise<Array<{ t: number; jpg: Buffer }>>;
  fetchWindow?: (url: string, start: number, seconds: number, target: string) => Promise<void>;
  fetchStretch?: (url: string, start: number, seconds: number, target: string) => Promise<void>;
  cut?: (ctx: CutCtx, m: Moment) => Promise<{ asset_id: string; bytes: number; seconds: number }>;
  /** for tests: whether ffmpeg has drawtext, without asking it */ drawtext?: boolean;
  /** for tests: the platform's muted stretches of the recording (seconds), in place of reading the playlist */ muted?: Array<[number, number]>;
  facecam?: (jpg: Buffer) => Promise<Layout | FacecamBox | null>;
};
async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const next = { ...progress };
  if (next.stage && next.stage !== job.progress?.stage) next.stage_at = new Date().toISOString();
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...next } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new ClipsError("lease_lost", "lease lost");
  job.progress = { ...(job.progress ?? {}), ...next };
}
/** A stretch of an HLS recording to a local file: sound only (mono 16 kHz, for hearing) or a copy of the rung's
 *  picture and sound (for cutting; timestamps start at 0, so the caller keeps the offset). */
export async function fetchSound(url: string, start: number, seconds: number, target: string): Promise<void> {
  const sound = ["-t", String(seconds), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", target];
  if (await fromSegments(url, start, seconds, `${target}.src.ts`, (src, offset) => ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", offset.toFixed(3), "-i", src, ...sound], { timeoutMs: 4 * 60_000 }))) return;
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, start)), "-i", url, ...sound], { timeoutMs: 4 * 60_000 });
}
/** A stretch read from the segments that cover it (hls-stretch.ts: a long stream's timestamps wrap at 26.5 hours and a
 *  playlist seek past that point never lands); `run` gets the local file and how far into it the stretch begins. False
 *  when the playlist is not plain MPEG-TS: the caller reads the playlist the old way. */
async function fromSegments(url: string, start: number, seconds: number, src: string, run: (src: string, offset: number) => Promise<unknown>): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  try {
    const got = await gatherStretch(url, start, seconds, src);
    if (!got) return false;
    await run(src, got.offset);
    return true;
  } finally { await rm(src, { force: true }).catch(() => undefined); }
}
export type HourRead = { hour: number; start: number; seconds: number; words: Heard["words"]; events: Heard["events"]; /** the door that heard it: a window reuses the words only when it was Scribe (exact words for the verdict and the cut) */ door: "scribe" | "groq"; /** the language heard (ISO 639-3, as the hearing gives it) */ language?: string | null };

/** The run's language, settled from everything heard so far, weighted by words (an hour heard whole outweighs a window).
 *  Nov 23 2026: the moment checker was told to write "in the stream's language" without being told which, guessed it from
 *  each short window, and wrote French titles for an English stream (zackrawrr, a window with some French in it). */
export function runLanguage(votes: Map<string, number>): string | null {
  let best: string | null = null, n = 0;
  for (const [k, v] of votes) if (v > n) { best = k; n = v; }
  return best;
}
export const voteLanguage = (votes: Map<string, number>, lang: string | null | undefined, words: number) => {
  const k = String(lang ?? "").trim().toLowerCase();
  if (k && words > 0) votes.set(k, (votes.get(k) ?? 0) + words);
};
const LANGUAGE_NAMES: Record<string, string> = { eng: "English", en: "English", fra: "French", fr: "French", spa: "Spanish", es: "Spanish", por: "Portuguese", pt: "Portuguese", deu: "German", ger: "German", de: "German", ita: "Italian", it: "Italian", ara: "Arabic", ar: "Arabic", tur: "Turkish", tr: "Turkish", rus: "Russian", ru: "Russian", pol: "Polish", pl: "Polish", nld: "Dutch", dut: "Dutch", nl: "Dutch", jpn: "Japanese", ja: "Japanese", kor: "Korean", ko: "Korean", hin: "Hindi", hi: "Hindi", zho: "Chinese", chi: "Chinese", cmn: "Chinese", zh: "Chinese", swe: "Swedish", sv: "Swedish", ukr: "Ukrainian", uk: "Ukrainian", ind: "Indonesian", id: "Indonesian", tha: "Thai", th: "Thai", vie: "Vietnamese", vi: "Vietnamese", fil: "Filipino", tgl: "Tagalog" };
export const languageName = (code: string | null) => (code ? LANGUAGE_NAMES[code] ?? code : null);
/** The line the moment checker gets about the language (empty when nothing has been heard yet). */
export function languageLine(code: string | null): string {
  const name = languageName(code);
  return name ? ` The stream is in ${name}: write the title, hook_line and caption in ${name}, even when a line of this window is in another language.` : "";
}
/** The hours to read whole: the strongest by the chat's candidates (their scores summed), not muted, in stream order. */
/** A quiet chat (owner, Nov 22 2026: a 3.4 h Kick stream at 18 messages a minute gave 15 chat moments and 8 more from the
 *  2 hours heard; 2 of the 23 passed, for 10 asked, and 1.4 h was never heard): when the chat is quiet or its moments are
 *  too few for the clips asked, every hour is heard (up to `max_hours`), not only the hours the chat reacted to. Hearing
 *  an hour costs ~$0.05 (Groq + Haiku's picker). Off with STUDIO_LIVE_QUIET=off. */
export const QUIET = { per_minute: 60, cands_per_clip: 3, max_hours: 6 };
export const isQuiet = (perMinute: number, candidates: number, asked: number) => perMinute < QUIET.per_minute || candidates < asked * QUIET.cands_per_clip;
/** The most a run hears whole: the hybrid's hours, or the quiet chat's when that rule is on. */
export function listenHours(env: Record<string, string | undefined> = process.env): number { return env.STUDIO_LIVE_QUIET !== "off" ? Math.max(hybridHours(env), QUIET.max_hours) : hybridHours(env); }
/** A chat under the floor that the run need not stop for (Nov 25 2026): the stretch it would hear whole instead, or null.
 *  A part of up to listenHours() is heard whole whatever its chat; a whole stream that short only when the platform kept
 *  no chat at all for it (under a message a minute), so a stream with a thin chat still says so as before. */
export function listenOnly(perMinute: number, messages: number, part: { from: number; to: number } | null, seconds: number, env: Record<string, string | undefined> = process.env): { from: number; to: number } | null {
  if (perMinute >= LIVE_LIMITS.min_chat_per_minute || env.STUDIO_LIVE_HYBRID === "off") return null;
  const from = part ? part.from : 0, to = part ? part.to : seconds, span = to - from;
  if (span < HYBRID.min_heard_s || span > listenHours(env) * 3600 + 60) return null;
  if (!part && perMinute >= 1 && messages > 0) return null;
  return { from, to };
}
export const platformName = (p: string) => (p === "kick" ? "Kick" : "Twitch");
/** Kick fills in a past stream's chat replay hours after it ends, newest part first (Nov 25 2026: a 13-hour stream that
 *  ended 01:38 PT had no chat before hour 10 until ~03:50 PT, then all of it). So "no chat" on a stream that ended
 *  within KICK_CHAT_LAG_H is "not there yet", not "none". */
export const KICK_CHAT_LAG_H = 12;
export function noChatWords(b: { platform: string; seconds: number; started_at?: string }, where: string, now = Date.now()): string {
  const P = platformName(b.platform), ended = Date.parse(b.started_at ?? "") + b.seconds * 1000;
  const recent = b.platform === "kick" && Number.isFinite(ended) && now - ended < KICK_CHAT_LAG_H * 3600_000;
  return recent ? `${P} has not made the chat for ${where} available yet (it can take a few hours after a stream ends)` : `${P} has no chat saved for ${where}`;
}
const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
/** What a run refused for its chat tells the person: why, where the chat is when only part of the stream kept one, and
 *  what will work (a part short enough to hear whole). */
export function quietChatWords(b: { platform: string; seconds: number; started_at?: string }, part: { from: number; to: number } | null, chat: Array<{ t: number }>, perMinute: number, env: Record<string, string | undefined> = process.env, now = Date.now()): string {
  const P = platformName(b.platform), where = part ? "that part of the stream" : "this stream", H = listenHours(env);
  const pick = env.STUDIO_LIVE_HYBRID !== "off" ? `. Pick a part of up to ${H} hours and we'll find its moments by listening to it instead` : "";
  if (perMinute < 1) {
    const first = chat.length ? chat[0].t : null, last = chat.length ? chat[chat.length - 1].t : null;
    const kept = !part && first !== null && last !== null && last - first >= 600 ? ` (its chat runs only from ${hm(first)} to ${hm(last)} into the stream so far)` : "";
    return `${noChatWords(b, part || !kept ? where : "most of this stream", now)}${kept}, and Live Clips follows the chat to find moments in a stretch this long${pick}`;
  }
  return `This stream's chat was too quiet to read (${Math.round(perMinute)} messages a minute); Live Clips needs a chat that reacts${pick}`;
}
/** Whether the platform kept chat for the part about to be quoted (Kick only; a call or two, remembered 10 minutes; null when
 *  unknown). A stretch with none is said before anyone pays, not after the run has read it. */
export async function chatKept(deps: LiveDeps, b: Broadcast, part: { from: number; to: number } | null): Promise<number | null> {
  if (b.platform !== "kick" || b.live || !b.channel_id || !b.started_at) return null;
  const from = part ? part.from : 0, to = part ? part.to : b.seconds;
  const probe = briefly(`kc:${b.id}:${from}:${to}`, 10 * 60_000, () => kickChatProbe(deps, b.channel_id, b.started_at, from, to));
  const late = new Promise<null>((ok) => { const t = setTimeout(() => ok(null), 4000); (t as any).unref?.(); });
  return Promise.race([probe, late]).catch(() => null);
}
export function hoursToRead(cands: Array<Pick<Candidate, "t_event" | "score">>, seconds: number, mutedShare: (a: number, b: number) => number, max = HYBRID.hours, everyHour = false): number[] {
  const score = new Map<number, number>();
  // every hour is a choice when the chat is quiet; the ones it reacted to still come first
  if (everyHour) for (let h = 0; h * 3600 < seconds; h++) score.set(h, 0);
  for (const c of cands) { const h = Math.floor(c.t_event / 3600); score.set(h, (score.get(h) ?? 0) + c.score); }
  return [...score.entries()].filter(([h]) => Math.min(3600, seconds - h * 3600) >= HYBRID.min_heard_s && mutedShare(h * 3600, Math.min(seconds, (h + 1) * 3600)) <= 0.4)
    .sort((a, b) => b[1] - a[1]).slice(0, max).map(([h]) => h).sort((a, b) => a - b);
}
/** One hour heard whole and read by Clips' picker: its words (seconds from the hour's start) and the moments (absolute). */
async function readHour(deps: StreamDeps, b: Broadcast, audioUrl: string, hour: number, dir: string, u: string, length: ClipLength, stretch?: { start: number; seconds: number }): Promise<{ read: HourRead; moments: Moment[] } | null> {
  // a clock hour, or a stretch of up to an hour (a live stream's newest part)
  const start = stretch ? Math.max(0, Math.floor(stretch.start)) : hour * 3600, seconds = stretch ? Math.min(3600, stretch.seconds, b.seconds - start) : Math.min(3600, b.seconds - start), file = join(dir, `h${hour}.mp3`);
  const env = deps.env ?? process.env;
  try {
    await (deps.fetchWindow ?? fetchSound)(audioUrl, start, seconds, file);
    const got = deps.fetchWindow ? seconds : (await probeLocal(file).catch(() => ({ seconds: 0 }))).seconds || 0;
    if (got < HYBRID.min_heard_s) return null;
    const heard = await (deps.hearHour ?? (async (f: string, sec: number) => hearAudio({ env, fetch: deps.fetch }, { audio: await readFile(f), seconds: sec, use: "live_clips_hour", userId: u })))(file, got);
    const lines = linesFromWords(heard.words);
    const pickDeps: ClipsDeps = { ...deps, env: { ...env, STUDIO_CLIPS_MODEL: env.STUDIO_LIVE_PICK_MODEL || HYBRID.pick_model } };
    const raw: RawMoment[] = [];
    for (const w of windows(lines)) raw.push(...await (deps.pick ?? ((ls: Line[]) => chooseWithClaude(pickDeps, { lines: ls, meta: { title: b.title || null, channel: b.channel || null, description: "", chapters: [], replay: [] } as any, length, wanted: HYBRID.wanted_per_window }, u)))(w));
    const moments = finalizeMoments(raw, lines, heard.words, length, 12, CLIP_LIMITS.min_score, heard.events).map((m) => ({ ...m, start: round2(m.start + start), end: round2(m.end + start) }));
    return { read: { hour, start, seconds: got, words: heard.words, events: heard.events, door: sttProvider(env), language: heard.language ?? null }, moments };
  } catch (err: any) { (deps.log ?? console.log)(`[live] hour ${hour} not read: ${String(err?.message ?? err).slice(0, 160)}`); return null; }
  finally { await rm(file, { force: true }).catch(() => undefined); }
}
/** A window's hearing taken from an hour read whole: its words and events shifted to the window's start. */
function heardFromRead(read: HourRead, start: number, span: number): Heard {
  const d = read.start - start;
  const words = read.words.filter((w) => w.end + d > 0 && w.start + d < span).map((w) => ({ ...w, start: round2(w.start + d), end: round2(w.end + d) }));
  const events = read.events.filter((e) => e.end + d > 0 && e.start + d < span).map((e) => ({ ...e, start: round2(e.start + d), end: round2(e.end + d) }));
  return { words, events, lines: annotateLines(linesFromWords(words), events, null), excess: null, language: null };
}
export async function fetchStretchCopy(url: string, start: number, seconds: number, target: string): Promise<void> {
  const copy = ["-t", String(seconds), "-c", "copy", "-movflags", "+faststart", target];
  if (await fromSegments(url, start, seconds, `${target}.src.ts`, (src, offset) => ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", offset.toFixed(3), "-i", src, ...copy], { timeoutMs: 6 * 60_000 }))) return;
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, start)), "-i", url, ...copy], { timeoutMs: 6 * 60_000 });
}
export async function stillsFrom(video: string, times: number[], dir: string, tag: string): Promise<Array<{ t: number; jpg: Buffer }>> {
  const out: Array<{ t: number; jpg: Buffer }> = [];
  for (const t of times) {
    const f = join(dir, `${tag}_${Math.round(t)}.jpg`);
    const still = ["-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "5", f];
    try {
      // the one segment holding the moment (a long stream's playlist cannot be seeked past 26.5 hours: hls-stretch.ts)
      if (!await fromSegments(video, t, 0.5, `${f}.src.ts`, (src, offset) => ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", offset.toFixed(3), "-i", src, ...still], { timeoutMs: 60_000 })))
        await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, t)), "-i", video, ...still], { timeoutMs: 90_000 });
      out.push({ t, jpg: await readFile(f) }); await rm(f, { force: true }).catch(() => undefined);
    }
    catch { /* a missing still is not a failed candidate */ }
  }
  return out;
}
async function hearWindow(deps: StreamDeps, audioFile: string, dir: string, userId: string, seconds = WINDOW.length): Promise<Heard> {
  const env = deps.env ?? process.env;
  const buf = await readFile(audioFile);
  // (the cost ledger: the door is priced by the hour of audio heard; the window is WINDOW.length seconds)
  const r = await hearAudio({ env, fetch: deps.fetch }, { audio: buf, seconds, use: "live_clips", userId, provider: "scribe" });
  const rms = await loudnessTrack(audioFile, dir).catch(() => [] as number[]);
  const excess = rms.length ? loudnessExcess(rms) : null;
  const lines = annotateLines(linesFromWords(r.words), r.events, excess);
  return { words: r.words, events: r.events, lines, excess, language: r.language };
}
async function verifyWithClaude(deps: StreamDeps, input: { lines: Line[]; stills: Array<{ t: number; jpg: Buffer }>; head: string; body: string }, userId: string): Promise<Verdict> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    // the system prompt and the schema are the same for every check of a run: cached, they cost a twentieth (a check's
    // input is about 2,200 tokens of them and 2,400 of its own; measured Nov 19 2026: $0.0114 -> $0.0076 a check)
    model: env.STUDIO_LIVE_VERIFY_MODEL || "claude-sonnet-5-5", max_tokens: 2000, system: [{ type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: env.STUDIO_LIVE_VERIFY_EFFORT || "medium", format: { type: "json_schema", schema: VERIFY_SCHEMA } },
    messages: [{ role: "user", content: [
      ...input.stills.flatMap((f) => [{ type: "text", text: `Still at ${Math.round(f.t)} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
      { type: "text", text: `${input.head}\n\nTranscript (Lnn [m:ss] speaker: words; sounds in brackets; ⟪+dB⟫ = louder than usual; the chat's reaction marked where it begins and peaks):\n${input.body || "(no speech heard in this window)"}` },
    ] }],
  }, "live_clips_verify", userId);
  const g = out?.grades && typeof out.grades === "object" ? out.grades : null;
  const grades: Grades | null = g ? { hook: Number(g.hook) || 0, standalone: Number(g.standalone) || 0, payoff: Number(g.payoff) || 0, reaction: Number(g.reaction) || 0, quotable: Number(g.quotable) || 0, length: Number(g.length) || 0 } : null;
  return { keep: !!out?.keep, score: Number(out?.score) || 0, standalone: !!out?.standalone, grades, hard_fail: String(out?.hard_fail ?? "").trim(), start_line: Number(out?.start_line), end_line: Number(out?.end_line), title: String(out?.title ?? ""), hook: String(out?.hook ?? ""), hook_line: String(out?.hook_line ?? ""), caption: String(out?.caption ?? ""), why: String(out?.why ?? ""), why_not: String(out?.why_not ?? ""), tags: Array.isArray(out?.tags) ? out.tags.map((x: any) => String(x)) : [] };
}
// ---------------------------------------------------------------------------------------------------
// Stacked framing (RESEARCH.md 4.5): the facecam on top, the game under it. Clips' own framing labels a game with a
// small facecam "screen" and shows the whole picture on a blurred fill, which leaves the streamer a thumbnail
// (the first live run, Nov 18 2026). One look at a still finds the facecam box; the graph stacks the two.
// ---------------------------------------------------------------------------------------------------
export type FacecamBox = { x: number; y: number; w: number; h: number };
/** What one still says about the picture: the camera box (null when there is none worth stacking) and the content
 *  box, the thing being watched (the game viewport, the chess board, the page), null when it is the whole frame. */
export type Layout = { cam: FacecamBox | null; content: FacecamBox | null };
const BOX = { type: "object", additionalProperties: false, required: ["present", "x", "y", "w", "h"], properties: { present: { type: "boolean" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } };
export const FACECAM_SCHEMA = { type: "object", additionalProperties: false, required: ["cam", "content"], properties: { cam: BOX, content: BOX } };
export const FACECAM_PROMPT = `This is a frame from a live stream. Give two boxes, each as fractions of the frame: x and y are the top-left corner (0-1 from the left and from the top), w and h the width and height (0-1).
1. cam: the webcam box (the streamer's camera feed, a rectangle showing a person, usually in a corner over the game or the screen). Be exact about its edges, including any border. If the whole frame is the person (no game or screen), or there is no camera box, answer present false with zeros.
2. content: the thing being watched, excluding the webcam box, chat panels, alert bars, overlays and empty borders: the game's viewport, a chess board with its clocks, a browser page or a video player. On a desktop or a browser with a chat column or other panels beside it, the content is the window, page or player being looked at, even when it is most of the frame: give that box. Only if the content truly fills the frame edge to edge, answer present false with zeros.`;
/** The layout of a still, by Haiku: the facecam box (null when none, or not a box worth stacking) and the content box. */
export async function findLayout(deps: ClipsDeps, jpg: Buffer, userId?: string): Promise<Layout> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    // Sonnet, not Haiku: on the Lacy run (Nov 19 2026) Haiku answered "no camera, no content" on a desktop frame with a
    // camera 27 % wide, and two of five clips came out as the whole desktop letterboxed; the call is 1,200 tokens, so Sonnet
    // is a quarter of a cent a clip
    model: env.STUDIO_LIVE_LAYOUT_MODEL || "claude-sonnet-5-5", max_tokens: 400,
    output_config: { effort: "low", format: { type: "json_schema", schema: FACECAM_SCHEMA } },
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } }, { type: "text", text: FACECAM_PROMPT }] }],
  }, "live_clips_facecam", userId);
  const cam = cleanFacecam(out?.cam);
  return { cam, content: excludeCam(cleanContent(out?.content), cam) };
}
/** The content box: at least a third of the frame each way, inside it; else the whole frame (null). */
/** The content box with the camera box cut out of it when they overlap (the model is asked to exclude it and does not
 *  always: the camera then showed twice, in its panel and in the game's corner). The larger of the two rectangles
 *  that avoid the camera, below it or beside it; the content as given when neither keeps a third of the frame. */
export function excludeCam(content: FacecamBox | null, cam: FacecamBox | null): FacecamBox | null {
  if (!content || !cam) return content;
  const ox = Math.min(content.x + content.w, cam.x + cam.w) - Math.max(content.x, cam.x), oy = Math.min(content.y + content.h, cam.y + cam.h) - Math.max(content.y, cam.y);
  if (ox <= 0.01 || oy <= 0.01) return content;
  const options: FacecamBox[] = [];
  // the camera at the top or the bottom: the content below or above it; at the left or the right: beside it
  if (cam.y <= content.y + 0.02) options.push({ x: content.x, y: cam.y + cam.h, w: content.w, h: content.y + content.h - (cam.y + cam.h) });
  if (cam.y + cam.h >= content.y + content.h - 0.02) options.push({ x: content.x, y: content.y, w: content.w, h: cam.y - content.y });
  if (cam.x <= content.x + 0.02) options.push({ x: cam.x + cam.w, y: content.y, w: content.x + content.w - (cam.x + cam.w), h: content.h });
  if (cam.x + cam.w >= content.x + content.w - 0.02) options.push({ x: content.x, y: content.y, w: cam.x - content.x, h: content.h });
  const best = options.filter((b) => b.w >= 0.33 && b.h >= 0.33).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!best) return content;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { x: r(best.x), y: r(best.y), w: r(best.w), h: r(best.h) };
}
export function cleanContent(out: any): FacecamBox | null {
  if (!out?.present) return null;
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const b = { x: n(out.x), y: n(out.y), w: n(out.w), h: n(out.h) };
  if ([b.x, b.y, b.w, b.h].some((v) => !Number.isFinite(v))) return null;
  if (b.w < 0.33 || b.h < 0.33 || b.x < 0 || b.y < 0 || b.x + b.w > 1.02 || b.y + b.h > 1.02) return null;
  if (b.w > 0.95 && b.h > 0.95) return null;
  return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.w, 1 - Math.max(0, b.x)), h: Math.min(b.h, 1 - Math.max(0, b.y)) };
}
export function cleanFacecam(out: any): FacecamBox | null {
  if (!out?.present) return null;
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const b = { x: n(out.x), y: n(out.y), w: n(out.w), h: n(out.h) };
  if ([b.x, b.y, b.w, b.h].some((v) => !Number.isFinite(v))) return null;
  // a corner camera: between a tenth and six tenths of the width, at most seven tenths of the height, inside the frame
  if (b.w < 0.05 || b.w > 0.6 || b.h < 0.05 || b.h > 0.7 || b.x < 0 || b.y < 0 || b.x + b.w > 1.02 || b.y + b.h > 1.02) return null;
  return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.w, 1 - Math.max(0, b.x)), h: Math.min(b.h, 1 - Math.max(0, b.y)) };
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** The format (research/MOMENTS_AND_FORMAT_PLAN.md §3): 1080x1920 out; the camera panel 450-640 lines (a third of
 *  the frame at most: a near-square camera box took half the frame on the first run, Nov 19 2026; the TikTok study of
 *  Nov 19 measured 31-34 % on the accounts that win with this format, so the panel is 600-640 lines); a camera box over
 *  15 % of the frame is the person themselves, so the clip is framed on them instead of stacked; captions, when
 *  chosen, just under the divider (or at 58 % on a full-frame clip), at most 68 % of the width, inside the box all
 *  three apps leave visible. No text on the picture, no pauses cut, no punch-in: the owner wants the clip as it was
 *  streamed; edits like those belong to the editor that comes later. */
export const FORMAT = { w: 1080, h: 1920, cam: { min: 600, max: 640 }, irl_cam_share: 0.15, caption: { gap: 0.05, irl_y: 0.58, max_width: 0.68 } };
export type StackedLayout = { graph: string; w: number; h: number; camH: number };
/** A camera narrower than this (of the frame's width) is too small to become a panel: scaled to the frame it is mush
 *  (the Lacy run of Nov 19 2026: a camera 5 % wide on a desktop stream). */
export const TINY_CAM_W = 0.1;
/** The 1080x1920 graph for a desktop stream with no camera worth a panel: the content box (the page, the player, the
 *  card being looked at) scaled to the full width and centred over a blurred fill of itself, instead of the whole
 *  desktop letterboxed into the middle third (two of the five Lacy clips, Nov 19 2026: the trivia card and the tweet
 *  unreadable on a phone). A content box taller than 9:16 is cropped to the frame instead. */
export function contentLayout(info: { w: number; h: number; fps: number | null }, content: FacecamBox): StackedLayout {
  const W = FORMAT.w, H = FORMAT.h;
  const cw = even(content.w * info.w), ch = even(content.h * info.h), cx = even(content.x * info.w), cy = even(content.y * info.h);
  const fps = info.fps && info.fps > 30.5 ? ",fps=30" : "";
  const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
  const graph = ch / Math.max(1, cw) >= H / W
    ? `[0:v]${crop},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1${fps},format=yuv420p[v]`
    : `[0:v]split=2[a][b];[a]${crop},scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=10:2,scale=${W}:${H},eq=brightness=-0.08[bg];[b]${crop},scale=${W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${fps},format=yuv420p[v]`;
  return { graph, w: W, h: H, camH: 0 };
}
/** The 1080x1920 graph: the facecam box scaled to the full width on top (its own shape, 450-640 lines, cropped from a
 *  third of the way down so a face is never cut at the forehead), the content box (or the whole picture) scaled to
 *  the rest and cropped to its middle, frame rate capped at 30. */
export function stackedFilter(info: { w: number; h: number; fps: number | null }, cam: FacecamBox, content: FacecamBox | null = null): string {
  return stackedLayout(info, cam, content).graph;
}
export function stackedLayout(info: { w: number; h: number; fps: number | null }, cam: FacecamBox, content: FacecamBox | null = null): StackedLayout {
  const W = FORMAT.w, H = FORMAT.h;
  const cw = even(cam.w * info.w), ch = even(cam.h * info.h), cx = even(cam.x * info.w), cy = even(cam.y * info.h);
  const camH = even(Math.max(FORMAT.cam.min, Math.min(FORMAT.cam.max, W * ch / Math.max(1, cw))));
  const gameH = H - camH;
  const fps = info.fps && info.fps > 30.5 ? ",fps=30" : "";
  const focus = content ? `crop=${even(content.w * info.w)}:${even(content.h * info.h)}:${even(content.x * info.w)}:${even(content.y * info.h)},` : "";
  const graph = `[0:v]split=2[c][g];[c]crop=${cw}:${ch}:${cx}:${cy},scale=${W}:${camH}:force_original_aspect_ratio=increase,crop=${W}:${camH}:0:(ih-${camH})*0.3[cam];[g]${focus}scale=${W}:${gameH}:force_original_aspect_ratio=increase,crop=${W}:${gameH}[game];[cam][game]vstack,setsar=1${fps},format=yuv420p[v]`;
  return { graph, w: W, h: H, camH };
}
/** Whether this server's ffmpeg has the drawtext filter (Render's Debian build does; a Homebrew build may not). Read once. */
let drawtextOk: Promise<boolean> | null = null;
export function ffmpegHasDrawtext(): Promise<boolean> {
  if (!drawtextOk) drawtextOk = new Promise((resolve) => {
    const c = spawn("ffmpeg", ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
    let o = ""; c.stdout.on("data", (b) => { o += b; }); c.on("error", () => resolve(false)); c.on("close", () => resolve(/\sdrawtext\s/.test(o)));
  });
  return drawtextOk;
}
/** The streamer's name burned in (top left, a soft box): an ffmpeg drawtext filter for cutClip's `overlay`. */
export function attributionFilter(text: string, env: Record<string, string | undefined> = process.env): string {
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "%%").replace(/[\[\],;]/g, " ");
  const font = env.STUDIO_OVERLAY_FONT || (existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") ? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" : null);
  return `drawtext=${font ? `fontfile=${font}:` : ""}text='${esc(text).slice(0, 60)}':fontsize=26:fontcolor=white@0.9:box=1:boxcolor=black@0.35:boxborderw=10:x=24:y=120`;
}
const round2 = (x: number) => Math.round(x * 100) / 100;
/** How many more than asked the run keeps before the rerank picks: two when three or more were asked, else one. */
export const OVERSHOOT = (count: number) => (count >= 3 ? 2 : 1);
export const RERANK_SYSTEM = `You are the best short-form editor alive, ordering finished clip candidates from one live stream for TikTok, Reels and Shorts. For each you get its title, its on-screen hook line, its grades (hook, standalone, payoff, reaction, quotable, length, each 0-10), its length and the first words spoken. Rank them best first by how likely each is to stop a stranger scrolling and hold them to the end. Prefer variety: two clips of the same bit, back to back, are worth less than one of each. Answer with the order as a list of the given indexes, every index exactly once.`;
export const RERANK_SCHEMA = { type: "object", additionalProperties: false, required: ["order"], properties: { order: { type: "array", items: { type: "integer" } } } };
/** The head-to-head order of the kept moments by Claude: indexes into the list, best first. */
export async function rerankWithClaude(deps: ClipsDeps, moments: Moment[], userId?: string): Promise<number[] | null> {
  const env = deps.env ?? process.env;
  const list = moments.map((m, i) => `#${i}: "${m.title}" · hook line "${m.hook_line ?? ""}" · ${Math.round(m.end - m.start)} s · grades ${m.grades ? Object.entries(m.grades).map(([k, v]) => `${k} ${v}`).join(", ") : `score ${m.score}`} · opens: ${m.transcript.split(/\s+/).slice(0, 24).join(" ")}`).join("\n");
  const out = await claudeJson(deps, {
    model: env.STUDIO_LIVE_VERIFY_MODEL || "claude-sonnet-5-5", max_tokens: 300, system: RERANK_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: RERANK_SCHEMA } },
    messages: [{ role: "user", content: [{ type: "text", text: `${moments.length} candidates:\n${list}` }] }],
  }, "live_clips_rerank", userId);
  const order = Array.isArray(out?.order) ? out.order.map((x: any) => Number(x)).filter((x: number) => Number.isInteger(x) && x >= 0 && x < moments.length) : [];
  return order.length ? order : null;
}
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function runStreamClipsJob(sb: SupabaseClient, deps: StreamDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id, st = o.stream ?? {};
  // 720 lines, or 1080 when the person chose HD (Creator and up; checked when the run was started)
  const lines = cutLines(qualityOf(o.quality), deps.env ?? process.env);
  const collectionId: string = o.collection_id;
  const length = lengthOf(o.length), format: ClipFormat = o.format === "original" ? "original" : "vertical";
  const len = CLIP_LENGTHS[length];
  const setCollection = (f: Record<string, any>) => sb.from("studio_collections").update({ ...f, updated_at: new Date().toISOString() }).eq("id", collectionId).eq("user_id", u);
  const made: Array<{ rank: number; asset_id: string; seconds: number }> = Array.isArray(job.progress?.made) ? job.progress.made : [];
  const price: ClipsPrice = o.price && Number.isFinite(Number(o.price.per_clip)) ? { analysis: Number(o.price.analysis) || 0, per_clip: Number(o.price.per_clip), lite: 0 } : streamPrice(deps.plans ?? [], { seconds: Number(o.seconds) || 3600, length, count: Number(o.count) || 5, env });
  const count = Math.max(1, Math.min(LIVE_LIMITS.max_clips, Number(o.count ?? o.max_clips) || likelyStreamClips(Number(o.seconds) || 3600)));
  const bar = VERIFY_BAR[strictnessOf(st.strictness)];
  let dir: string | null = null;
  const t0 = Date.now(); const timing: Record<string, any> = { video_s: Number(o.seconds) || 0 };
  try {
    if (!collectionId) throw new ClipsError("clips_invalid", "the run has no collection");
    dir = await mkdtemp(join(tmpdir(), "studio-live-"));
    const part: Part | null = o.part && Number.isFinite(Number(o.part.from)) && Number.isFinite(Number(o.part.to)) && Number(o.part.to) > Number(o.part.from) ? { from: Number(o.part.from), to: Number(o.part.to), scope: o.part.scope } : null;
    const inPart = (t: number) => !part || (t >= part.from && t <= part.to);
    if (part) timing.part = [part.from, part.to, part.scope];
    const b: Broadcast = { platform: st.platform, id: String(st.vod_id), url: String(o.url), title: String(o.source?.title ?? ""), channel: String(o.source?.channel ?? st.login ?? ""), login: String(st.login ?? ""), channel_id: String(st.channel_id ?? ""), seconds: Number(o.seconds) || 0, started_at: String(st.started_at ?? ""), views: null, thumbnail_url: null };
    // A. the chat replay, reduced to signals; the broadcast's playlists
    await renew(sb, job, { collection_id: collectionId, stage: "reading", done: 0, total: 0, message: "Reading the chat replay" });
    const tChat = Date.now(); let lastSaid = 0;
    // how the read went (Twitch: pages, empty answers waited out, stretches asked again, the proxy), for the log
    let chatRead: ChatReadReport | null = null;
    // a part of the stream: only its chat is read, with CHAT_AROUND before it (the chat's usual pace there) and after it
    // (Nov 23 2026: a 2-hour part of a 15-hour stream read all 15 hours of chat, 7 times the reading, behind Twitch's throttle)
    const readFrom = part ? Math.max(0, part.from - CHAT_AROUND.before_s) : 0, readTo = part ? Math.min(b.seconds, part.to + CHAT_AROUND.after_s) : b.seconds;
    const chatAll = await (deps.chat ?? ((x, onProgress) => b.platform === "twitch" ? twitchChatReplay(deps, x.id, readTo, { from: readFrom, onProgress, signal: job.signal, report: (r) => { chatRead = r; } }) : kickChatReplay(deps, x.channel_id, x.started_at, readTo, { from: readFrom, onProgress, signal: job.signal })))(b, (share) => {
      if (Date.now() - lastSaid > 15_000) { lastSaid = Date.now(); void renew(sb, job, { message: `Reading the chat replay · ${Math.round(share * 100)} %` }).catch(() => undefined); }
    });
    const chat = chatAll.filter((m) => m.t >= readFrom && m.t < readTo);
    timing.chat_s = Math.round((Date.now() - tChat) / 1000); timing.chat_messages = chat.length; timing.chat_read = [readFrom, readTo];
    // the read stretch's own signals (its pace, its bursts against its own usual), and the whole stream's clock for
    // the lookups by stream time below (chatAt, baseAt)
    const near = chatSignals(chat.map((m) => ({ ...m, t: m.t - readFrom })), readTo - readFrom);
    const signals = chatSignals(chat, b.seconds); signals.perMinute = near.perMinute;
    if (signals.perMinute < LIVE_LIMITS.min_chat_per_minute && chatRead) log(`[live] quiet read ${JSON.stringify({ job: job.id, messages: chat.length, read: chatRead })}`);
    // a chat under the floor: a part (or a whole stream with no chat saved at all) the run can hear whole is clipped by
    // listening, as YouTube Clips is; only what cannot be heard whole stops here (Nov 25 2026: a new Starter customer's
    // first run, the first 2 hours of a 13-hour Kick stream whose replay holds no chat before hour 10, was refused here
    // although the hearing below needs no chat)
    const hearAll = listenOnly(signals.perMinute, chat.length, part, b.seconds, deps.env ?? process.env);
    if (signals.perMinute < LIVE_LIMITS.min_chat_per_minute && !hearAll) throw new ClipsError("chat_too_quiet", quietChatWords(b, part, chat, signals.perMinute, deps.env ?? process.env), 422);
    const noChat = !!hearAll && signals.perMinute < 1;
    if (hearAll) { timing.listen_only = true; log(`[live] listening only ${JSON.stringify({ job: job.id, platform: b.platform, messages: chat.length, per_minute: round2(signals.perMinute), heard: [hearAll.from, hearAll.to] })}`); }
    const listenPart: Part | null = part ?? (hearAll ? { from: 0, to: b.seconds, scope: "range" } : null);
    const cands = chatCandidates(near, chat.map((m) => ({ ...m, t: m.t - readFrom })))
      .map((c) => ({ ...c, onset: c.onset + readFrom, peak: c.peak + readFrom, last: c.last + readFrom, t_event: c.t_event + readFrom })).filter((c) => inPart(c.t_event));
    // the run may make this many verdicts; a window that cannot be heard (muted on the platform, unreadable) is not one
    // of them (the first 35-hour run, Nov 19 2026: 10 of its 21 checks were muted windows, and 2 clips came of 5 asked;
    // most of those were likely past the 26.5-hour timestamp wrap, not muted: see hls-stretch.ts)
    const want = Math.min(LIVE_LIMITS.verify_max, count * LIVE_LIMITS.verify_per_clip + LIVE_LIMITS.verify_extra);
    log(`[live] chat ${JSON.stringify({ job: job.id, platform: b.platform, messages: chat.length, per_minute: Math.round(signals.perMinute), read: chatRead, candidates: cands.length, checking: want, top: cands.slice(0, 5).map((c) => [c.t_event, c.score]) })}`);
    // a part is read whole below, so a quiet chat there does not end the run (the chat replay runs ~4 min behind live)
    if (!cands.length && !(listenPart && (deps.env ?? process.env).STUDIO_LIVE_HYBRID !== "off")) throw new ClipsError("clips_none_found", part ? "The chat never lit up in that part of the stream: no moment stands out enough to clip" : "The chat never lit up: no moment in this stream stands out enough to clip", 422);
    const pl = await (deps.playlists ?? (async (x) => x.platform === "twitch" ? twitchVodPlaylists(deps, x.id, lines) : pickRungs(await hlsVariants(deps, (await kickBroadcastSource(deps, x.id)).master), lines)))(b);
    // the stretches the platform muted (music it recognised): their moments cannot be heard or posted, so they are not checked
    const muted = deps.muted ?? (b.platform === "twitch" ? await mutedRanges(deps, pl.audio).catch(() => [] as Array<[number, number]>) : []);
    const mutedShare = (from: number, to: number) => muted.reduce((acc, [x, y]) => acc + Math.max(0, Math.min(to, y) - Math.max(from, x)), 0) / Math.max(1, to - from);
    if (muted.length) log(`[live] muted ${JSON.stringify({ job: job.id, stretches: muted.length, seconds: Math.round(muted.reduce((acc, [x, y]) => acc + y - x, 0)) })}`);
    // the hybrid (HYBRID): the strongest hours heard whole and read by Clips' own picker; its moments join the candidates
    // (a chat candidate within 90 s takes the picker's cut instead), the two orders interleaved, the chat's first
    const hourReads: HourRead[] = [];
    const langVotes = new Map<string, number>(); // the run's language, from all it hears (runLanguage)
    if ((deps.env ?? process.env).STUDIO_LIVE_HYBRID !== "off") {
      // a part of up to the hybrid's hours is read whole, newest first (what nobody has clipped yet); otherwise the
      // clock hours the chat reacted to most, inside the part
      const quiet = (deps.env ?? process.env).STUDIO_LIVE_QUIET !== "off" && isQuiet(signals.perMinute, cands.length, count);
      const maxHours = quiet ? Math.max(hybridHours(deps.env ?? process.env), QUIET.max_hours) : hybridHours(deps.env ?? process.env);
      const stretches: Array<{ start: number; seconds: number }> = [];
      if (listenPart && listenPart.to - listenPart.from <= maxHours * 3600 + 60) {
        for (let z = listenPart.to; z - listenPart.from >= HYBRID.min_heard_s && stretches.length < maxHours; z -= 3600) { const a = Math.max(listenPart.from, z - 3600); if (mutedShare(a, z) <= 0.4) stretches.push({ start: a, seconds: z - a }); }
        stretches.reverse();
      }
      const hours = stretches.length ? stretches.map((x) => Math.floor(x.start / 3600)) : hoursToRead(cands, b.seconds, mutedShare, maxHours, quiet);
      if (quiet) log(`[live] quiet ${JSON.stringify({ job: job.id, per_minute: Math.round(signals.perMinute), candidates: cands.length, asked: count, hearing: hours.length })}`);
      if (hours.length) {
        await renew(sb, job, { stage: "transcribing", message: stretches.length ? (part ? `Listening to the ${part.scope === "since" ? "new part" : part.scope === "range" ? "part you picked" : "latest part"} of the stream, every word` : "Listening to the whole stream, every word") : `Listening to the ${hours.length === 1 ? "hour" : `${hours.length} hours`} the chat reacted to most` });
        const tHours = Date.now();
        const reads = (await Promise.all(hours.map((h, k) => readHour(deps, b, pl.audio, h, dir!, u, length, stretches[k])))).filter((r): r is NonNullable<typeof r> => !!r);
        const picked = reads.flatMap((r) => r.moments).filter((m) => inPart(m.start)).sort((x, y) => y.score - x.score);
        hourReads.push(...reads.map((r) => r.read));
        for (const r of reads) voteLanguage(langVotes, r.read.language, r.read.words.length);
        const extra: Candidate[] = []; const pickScore = new Map<Candidate, number>();
        for (const m of picked) {
          const near = cands.find((c) => Math.abs(c.t_event - m.start) < HYBRID.near_s || (m.start < c.t_event + 60 && m.end > c.t_event - 60));
          if (near) { if (!near.cut) { near.cut = { start: m.start, end: m.end }; near.title = m.title; pickScore.set(near, m.score); } continue; }
          if (extra.some((c) => Math.abs(c.t_event - m.start) < HYBRID.near_s)) continue;
          extra.push({ rank: 0, onset: m.start + 8, peak: m.start + 15, last: m.end, t_event: m.start, score: m.score, zs: {}, asks: 0, sample: [], source: "words", cut: { start: m.start, end: m.end }, title: m.title });
        }
        // the order: the moments both readers marked first (a chat burst AND the picker: the first hybrid run of Nov 19
        // 2026 left the cashier's song, the picker's 82, at its chat rank of 60 and never checked it), then the chat's
        // and the picker's own interleaved, the chat's first
        const both = cands.filter((c) => c.cut).sort((x, y) => (pickScore.get(x) ?? 0) - (pickScore.get(y) ?? 0)).reverse();
        const rest = cands.filter((c) => !c.cut);
        const merged: Candidate[] = [...both];
        for (let k = 0; k < Math.max(rest.length, extra.length); k++) { if (k < rest.length) merged.push(rest[k]); if (k < extra.length) merged.push(extra[k]); }
        cands.splice(0, cands.length, ...merged.map((c, k) => ({ ...c, rank: k + 1 })));
        timing.hours = hours; timing.hours_read = reads.map((r) => r.read.hour); timing.hours_s = Math.round((Date.now() - tHours) / 1000); timing.hour_words = reads.reduce((a, r) => a + r.read.words.length, 0); timing.picked = picked.length; timing.words_cands = extra.length;
        log(`[live] hours ${JSON.stringify({ job: job.id, hours, read: reads.map((r) => r.read.hour), words: timing.hour_words, picked: picked.length, new: extra.length, seconds: timing.hours_s, top: picked.slice(0, 5).map((m) => [Math.round(m.start), m.score, m.title.slice(0, 40)]) })}`);
      }
    }
    if (!cands.length) throw new ClipsError("clips_none_found", "Nothing in that part of the stream stands out enough to clip yet", 422);
    // B. each candidate's window heard, then checked by the model, until `count` are kept
    await renew(sb, job, { stage: "transcribing", message: hearAll && cands.every((c) => c.source === "words") ? `Checking the ${Math.min(want, cands.length)} best moments it heard` : `Listening to the ${want} moments the chat pointed at` });
    const chatAt = (abs: number) => { const bin = Math.floor(abs / 10); return bin >= 0 && bin < signals.bins ? signals.rate[bin] : 0; };
    const baseAt = (abs: number) => { const bin = Math.floor(abs / 10); const h = signals.rate.slice(Math.max(0, bin - 60), Math.max(1, bin)).slice().sort((a, c) => a - c); return h.length ? h[Math.floor(h.length / 2)] : 0; };
    const kept: Moment[] = []; let checked = 0, heardOk = 0, unsafe = 0, checkErrors = 0; const tListen = Date.now(); let claudeCalls = 0;
    const hear = deps.hear ?? ((f, d, sec) => hearWindow(deps, f, d, u, sec));
    const verify = deps.verify ?? ((input) => verifyWithClaude(deps, input, u));
    const stills = deps.stills ?? stillsFrom;
    const windowOf = deps.fetchWindow ?? fetchSound;
    let skippedMuted = 0, unheard = 0, deferred = 0, extended = 0;
    // the order is the detector's, except that an hour gone cold (COLD) waits behind everyone else
    const queue = [...cands]; const later: Candidate[] = []; let pass = 0;
    const verdicts = new Map<number, { n: number; kept: number }>();
    const hourOf = (c: Candidate) => Math.floor(c.t_event / COLD.bucket_s);
    const isCold = (c: Candidate) => { const v = verdicts.get(hourOf(c)); return !!v && v.kept === 0 && v.n >= COLD.after; };
    while (queue.length || later.length) {
      if (!queue.length) { if (pass++) break; queue.push(...later.splice(0)); }
      const c = queue.shift()!;
      if (checked >= want || kept.length >= count + OVERSHOOT(count)) break;
      if (!pass && isCold(c)) { later.push(c); deferred++; continue; }
      if (job.signal?.aborted) throw new ClipsError("lease_lost", "lease lost");
      let start = Math.max(0, c.onset - WINDOW.lead), span = Math.min(WINDOW.length, b.seconds - start);
      // a cut the picker proposed sits inside the window when its hour was read (the words cost nothing more): the
      // first hybrid run's window of 7895-8045 s held the chat's mark and not the song at 8050-8073 s it was told about
      if (c.cut && hourReads.some((r) => c.cut!.start >= r.start && c.cut!.end <= r.start + r.seconds)) {
        start = Math.max(0, Math.min(start, c.cut.start - 30)); span = Math.min(HYBRID.max_span_s, b.seconds - start, Math.max(WINDOW.length, c.cut.end + 20 - start));
      }
      if (span < 30) continue;
      if (mutedShare(start, start + span) > 0.4) { skippedMuted++; continue; }
      await renew(sb, job, { stage: checked === 0 ? "transcribing" : "choosing", message: `Checking moment ${checked + 1} of up to ${want} · ${kept.length} kept`, done: kept.length, total: count });
      const audio = join(dir, `w${c.rank}.mp3`);
      let heard: Heard;
      // a window inside an hour Scribe heard takes its words from it; an hour the cheap door heard only gives context
      const read = hourReads.find((r) => start >= r.start && start + span <= r.start + r.seconds);
      if (read && read.door === "scribe") { heard = heardFromRead(read, start, span); if (!heard.words.length) { unheard++; continue; } heardOk++; }
      else try {
        await windowOf(pl.audio, start, span, audio);
        // a window the platform silenced (or a fetch that came back short) has nothing to hear: it is not a verdict
        const got = deps.fetchWindow ? span : (await probeLocal(audio).catch(() => ({ seconds: 0 }))).seconds || 0;
        if (got < Math.min(30, span * 0.5)) { unheard++; log(`[live] window ${c.rank} of ${job.id} at ${Math.round(start)} s is ${Math.round(got)} s of ${Math.round(span)}: muted or empty, skipped`); continue; }
        heard = await hear(audio, dir); heardOk++;
        voteLanguage(langVotes, heard.language, heard.words.length);
      } catch (err: any) { unheard++; log(`[live] window ${c.rank} of ${job.id} at ${Math.round(start)} s not heard: ${String(err?.message ?? err).slice(0, 160)}`); continue; }
      finally { await rm(audio, { force: true }).catch(() => undefined); }
      checked++;
      const lines = heard.lines;
      const onsetRel = c.onset - start, peakRel = c.peak - start, eventRel = c.t_event - start, base = baseAt(start);
      let cut = firstCut(lines, eventRel, peakRel, (rel) => chatAt(start + rel), base, heard.events);
      if (c.cut) { const rs = c.cut.start - start, re = c.cut.end - start; const s0 = lines.findIndex((l) => l.end > rs + 0.05); let e0 = -1; for (let k = 0; k < lines.length; k++) if (lines[k].start < re - 0.05) e0 = k; if (s0 >= 0 && e0 >= s0) cut = { s: s0, e: e0 }; }
      const mark = (l: Line) => {
        const tags: string[] = [];
        if (c.source === "words") return l.text;
        if (l.start <= onsetRel && l.end > onsetRel - 1) tags.push(`chat burst begins: ×${(chatAt(c.onset + 5) / Math.max(base, 1)).toFixed(1)} the usual rate`);
        if (l.start <= peakRel && l.end > peakRel - 1) tags.push(`chat peak (${signals.rate[Math.floor(c.peak / 10)]} messages in 10 s, e.g. ${c.sample.slice(0, 5).map((x) => JSON.stringify(x)).join(", ")})`);
        return tags.length ? `${l.text} [${tags.join("; ")}]` : l.text;
      };
      const body = lines.map((l) => `L${l.i} [${mmss(l.start)}]${l.speaker ? ` ${l.speaker}:` : ""} ${mark(l)}${(l.events ?? []).map((x) => ` [${x}]`).join("")}${(l.loud ?? 0) >= 5 ? ` ⟪+${l.loud} dB⟫` : ""}`).join("\n");
      // the five minutes before the window, when its hour was read: the verifier's commonest call is "it needs the previous
      // five minutes" (22 of 25 rejections on the Nov 19 2026 run), made without seeing them; now it can read them (for
      // context only; the clip cannot start there)
      const before = read && start > read.start ? heardFromRead(read, Math.max(read.start, start - 300), Math.min(300, start - read.start)).words : [];
      const context = before.length ? `\n\nThe five minutes before the window, for context only (the clip cannot start here):\n${before.map((w) => w.text).join(" ").slice(-1800)}` : "";
      const peaks = heard.excess ? loudPeaks(heard.excess, 5) : [];
      const head = `Stream: ${b.channel} on ${b.platform === "twitch" ? "Twitch" : "Kick"}${b.title ? `, titled "${b.title.slice(0, 80)}"` : ""}. Window: ${mmss(start)} to ${mmss(start + span)} into the stream; times below are seconds from the window's start. The chat's usual pace here is ${base} messages per 10 s. The proposed cut is L${lines[cut.s]?.i ?? 0} to L${lines[cut.e]?.i ?? 0} (${mmss(lines[cut.s]?.start ?? 0)}-${mmss(lines[cut.e]?.end ?? 0)}). Loudest stretches: ${peaks.map((p) => `${mmss(p.start)} (+${p.db} dB)`).join(", ") || "none"}. Clip length goal: ${len.low}-${len.high} s, never under ${len.min} or over ${len.max}.${languageLine(runLanguage(langVotes))}${noChat ? " No chat is available for this part of the stream, so there is no chat reaction to weigh: judge it by what is said and shown." : ""}${c.source === "words" ? " This moment was found in the words of the stream, not by a chat burst; the proposed cut is the picker's." : c.cut ? " The chat burst here and the picker of the words proposed this cut." : ""}`;
      const times = [...new Set([lines[cut.s]?.start ?? 0, eventRel, peakRel, (lines[cut.s]?.start ?? 0 + (lines[cut.e]?.end ?? span)) / 2, lines[cut.e]?.end ?? span, Math.min(span - 1, peakRel + 20)].map((t) => Math.round(Math.max(0, Math.min(span - 1, t)))))].sort((a, c) => a - c).slice(0, 6);
      const frames = await stills(pl.video, times.map((t) => start + t), dir, `s${c.rank}`);
      let v: Verdict;
      try { v = await verify({ lines, stills: frames, head, body: body + context }); claudeCalls++; }
      // a check that never happened is not a verdict: it does not use up the budget or count as "checked" (Nov 26 2026:
      // every check of a run failed on a broken request, and the person was told 4 moments did not stand alone)
      catch (err: any) { checked--; checkErrors++; log(`[live] verify ${c.rank} of ${job.id} failed: ${String(err?.message ?? err).slice(0, 160)}`); continue; }
      const byI = new Map(lines.map((l) => [l.i, l]));
      const ls = byI.get(v.start_line), le = byI.get(v.end_line);
      const relStart = ls ? ls.start : lines[cut.s]?.start ?? 0, relEnd = le ? le.end : lines[cut.e]?.end ?? 0;
      let a = relStart, z = relEnd;
      for (const ev of heard.events) if (/laugh|applause|cheer/i.test(ev.text) && ev.start >= z - 0.6 && ev.start <= z + 1.5) z = Math.max(z, Math.min(ev.end + 0.35, a + len.max));
      // the end at the edge of what was heard (EDGE): more is heard, and the cut closes on the first thought ending in it
      if (z > span - EDGE.near && z - a < len.max - 3 && start + span < b.seconds - 5) {
        const more = Math.min(EDGE.more, b.seconds - (start + span)), extra = join(dir, `w${c.rank}x.mp3`);
        try {
          await windowOf(pl.audio, start + span, more, extra);
          const h2 = await hear(extra, dir, more);
          const shifted = h2.words.map((w) => ({ ...w, start: w.start + span, end: w.end + span }));
          const nl = linesFromWords(shifted).map((l, k) => ({ ...l, i: lines.length + k }));
          lines.push(...nl); heard.words.push(...shifted); extended++;
          const close = nl.find((l) => l.closes && l.end - a <= len.max) ?? [...nl].reverse().find((l) => l.end - a <= len.max);
          const was = z; if (close) z = close.end;
          log(`[live] edge ${JSON.stringify({ job: job.id, rank: c.rank, heard: Math.round(more), end: [round2(start + was), round2(start + z)] })}`);
        } catch (err: any) { log(`[live] edge of ${c.rank} of ${job.id} not heard: ${String(err?.message ?? err).slice(0, 120)}`); }
        finally { await rm(extra, { force: true }).catch(() => undefined); }
      }
      // a start on a line that continues a sentence (the lines break at a pause of 0.9 s too: a clip opened on "finally has
      // a receiver" with "Mahomes" a second before it, Nov 19 2026): the sentence's start, up to three lines back
      for (let guard = 0; guard < 3; guard++) {
        const at = lines.find((l) => Math.abs(l.start - a) < 0.06); if (!at) break;
        const prev = [...lines].reverse().find((l) => l.end <= at.start + 0.05 && l.end >= at.start - 2.5);
        if (!prev || SENTENCE_END_RE.test(prev.text.trim()) || !/^[a-z]/.test(at.text.trim()) || z - prev.start > len.max) break;
        a = prev.start;
      }
      // an end on a line that pauses mid-sentence (the lines break at a pause of 0.9 s too, so "You know about" ended a
      // clip on Nov 19 2026 while "TikTok?" followed a second later): the sentence's end within 6 s, else the previous one
      { const at = lines.find((l) => Math.abs(l.end - z) < 0.06);
        if (at && !SENTENCE_END_RE.test(at.text.trim())) {
          const next = lines.find((l) => l.start >= z - 0.05 && SENTENCE_END_RE.test(l.text.trim()) && l.end - z <= 6 && l.end - a <= len.max);
          const prev = next ? null : [...lines].reverse().find((l) => l.end <= z - 0.05 && SENTENCE_END_RE.test(l.text.trim()) && l.end - a >= len.min);
          if (next) z = next.end; else if (prev) z = prev.end;
        } }
      // the model's cut under the length's floor grows to the next closing thoughts (then earlier opening ones),
      // never past the ceiling: a 16 s clip of a 30 s moment was kept on Nov 18 2026 before this
      const closesAfter = (t: number) => lines.find((l) => l.start >= t - 0.05 && l.closes && l.end - a <= len.max);
      for (let guard = 0; z - a < len.min && guard < 6; guard++) { const n = closesAfter(z + 0.05); if (!n) break; z = n.end; }
      for (let guard = 0; z - a < len.min && guard < 6; guard++) { const prev = [...lines].reverse().find((l) => l.end <= a + 0.05 && l.opens && z - l.start <= len.max); if (!prev) break; a = prev.start; }
      // a cut past the length's ceiling keeps its payoff (the end) and starts at the first thought that fits: four
      // moments scoring 66-78 were dropped as "too long" on Nov 18 2026 instead of being trimmed
      if (z - a > len.max + 3) { const floor = z - len.max; const first = lines.find((l) => l.start >= floor - 0.05 && l.start <= z - len.min); a = first ? first.start : floor; }
      const d = z - a;
      // the checklist decides (research/viral-signals.md 4d): the weighted grades against the bar, a hard fail vetoes,
      // and a stranger must understand it (standalone grade 6+, or the old boolean where a seam gives no grades)
      const score = checklistScore(v);
      const standalone = v.grades ? v.grades.standalone >= 5 : v.standalone;
      const keep = v.keep && !v.hard_fail && standalone && score >= bar && d >= len.min && d <= len.max + 3;
      if (!keep && UNSAFE.test(`${v.hard_fail ?? ""} ${v.why_not ?? ""}`)) unsafe++;
      log(`[live] moment ${JSON.stringify({ job: job.id, rank: c.rank, t: c.t_event, score, felt: v.score, grades: v.grades ?? undefined, keep, cut: [round2(start + a), round2(start + z)], title: v.title.slice(0, 60), hook_line: v.hook_line?.slice(0, 40), why_not: keep ? undefined : v.hard_fail?.slice(0, 80) || v.why_not.slice(0, 80) || (d < len.min - 3 ? "too short" : d > len.max + 3 ? "too long" : "under the bar") })}`);
      const hv = verdicts.get(hourOf(c)) ?? { n: 0, kept: 0 }; if (!c.cut && c.source !== "words") hv.n++; if (keep) hv.kept++; verdicts.set(hourOf(c), hv);
      if (!keep && !hv.kept && hv.n === COLD.after) log(`[live] cold ${JSON.stringify({ job: job.id, hour: hourOf(c), after: hv.n })}`);
      if (!keep) continue;
      const absStart = round2(start + a), absEnd = round2(start + z);
      if (kept.some((k) => Math.min(k.end, absEnd) - Math.max(k.start, absStart) > 0.25 * Math.min(k.end - k.start, absEnd - absStart))) continue;
      const inside = heard.words.filter((w) => w.end > a && w.start < z);
      kept.push({ rank: kept.length + 1, start: absStart, end: absEnd, title: clean(v.title, 80) || `Moment ${kept.length + 1}`, hook: clean(v.hook, 140), hook_line: clean(v.hook_line ?? "", 60) || undefined, caption: clean(v.caption ?? "", 120) || undefined, grades: v.grades ?? undefined, why: clean(v.why, 120), score, tags: v.tags.map((x) => clean(x, 24).toLowerCase()).filter(Boolean).slice(0, 3), transcript: inside.map((w) => w.text).join(" ").slice(0, 2000),
        speech: inside.length ? speechOf(inside.map((w) => ({ ...w, start: w.start + start, end: w.end + start }))) : undefined,
        words: inside.map((w) => [w.text, round2(w.start + start), round2(w.end + start), w.speaker ?? null] as [string, number, number, string | null]) });
    }
    timing.listen_s = Math.round((Date.now() - tListen) / 1000); timing.checked = checked; timing.heard = heardOk; timing.verify_calls = claudeCalls; timing.unheard = unheard; timing.skipped_muted = skippedMuted; timing.deferred = deferred; timing.extended = extended;
    // (no clip at all: the reason still says when it was the stream's content, as the fewer-clips note does)
    timing.check_errors = checkErrors;
    // no moment could be judged at all (every check failed on our side): say so (the person runs it again; a retry here would pay for the hearing again) and never blame the stream
    if (!kept.length && checkErrors && !checked) throw new ClipsError("clips_check_failed", "We could not check this stream's moments this time; that was on our side. Nothing was charged, so you can run it again", 502);
    if (!kept.length && hearAll && cands.every((c) => c.source === "words")) throw new ClipsError("clips_none_found", `${noChat ? `${noChatWords(b, part ? "that part of the stream" : "this stream")}, so we listened to all of it` : `The chat there was quiet, so we listened to all of it`}, but no moment stands alone as a clip.${unsafeNote(unsafe, checked)}`.replace(/\.$/, ""), 422);
    if (!kept.length) throw new ClipsError("clips_none_found", checked ? `The chat lit up ${checked === 1 ? "once" : `${checked} times`}, but none of those moments stands alone as a clip.${unsafeNote(unsafe, checked)}`.replace(/\.$/, "") : "No moment in this stream stands out enough to be a clip", 422);
    kept.sort((x, y) => y.score - x.score || x.start - y.start);
    // more kept than asked for: one head-to-head look settles the order (model grades bunch), and the extra ones go
    if (kept.length > count) {
      const order = await (deps.rerank ?? ((ms) => rerankWithClaude(deps, ms, u)))(kept).catch((err: any) => { log(`[live] rerank of ${job.id} failed: ${String(err?.message ?? err).slice(0, 160)}`); return null; });
      if (order && order.length) { const by = new Map(kept.map((m, i) => [i, m])); const picked = [...new Set(order)].map((i) => by.get(i as number)).filter((m): m is Moment => !!m); for (const m of kept) if (!picked.includes(m)) picked.push(m); kept.splice(0, kept.length, ...picked); }
      log(`[live] rerank ${JSON.stringify({ job: job.id, kept: kept.length, count, order: kept.map((m) => m.title.slice(0, 30)) })}`);
      kept.splice(count);
    }
    kept.forEach((m, k) => { m.rank = k + 1; });
    // C. the cuts: each moment's stretch fetched from the recording, then the Clips cutter
    const todo = kept.filter((m) => !made.some((x) => x.rank === m.rank));
    await renew(sb, job, { collection_id: collectionId, stage: "cutting", done: made.length, total: kept.length, message: `Cutting clip ${Math.min(made.length + 1, kept.length)} of ${kept.length}`, made });
    const tCut = Date.now(); const cutTimes: Array<[number, number]> = [];
    // no burned-in credit (the owner, Nov 18 2026: nobody in the market marks the streamer on the clip); the source
    // link and channel stay on the collection, and attributionFilter stays for anyone who wants it back
    const ctxBase: CutCtx = { sb, deps, u, dir, src: { video: "", audio: null, proxy: null, width: 0, height: 0, fps: null }, format, collectionId, sourceTitle: b.title || null, jobId: job.id, length, captions: o.captions ? (await import("./studio-caption-video.js")).cleanSettings(o.captions) : null, overlay: null,
      // 1080x1920 (the platforms' native size; a portrait IRL source keeps every line), a peak limiter (a clip peaked at
      // +1.4 dBFS on Nov 19 2026), and the framing told what an IRL clip is (the Home Depot clip held the streamer while
      // the worker whose age was the point stood half out of frame)
      tall: true, limiter: true,
      framingHint: "This is a clip of a live IRL stream. When the speaker is talking TO another person who is in the picture (asking them something, reacting to them, being answered), put x between the two faces so both stay inside the crop; follow the speaker alone only when nobody else is in the picture or the other person is far from them." };
    const stretchOf = deps.fetchStretch ?? fetchStretchCopy;
    const skipped: number[] = [];
    // the layout is looked at once per clip, on a still from its own stretch: the first live runs (Nov 18 2026) looked
    // once per run and three Rainbow Six clips wore the chess scene's camera box, a slice of the game where the face was
    const asLayout = (r: Layout | FacecamBox | null): Layout => (r && "cam" in r ? r : { cam: r as FacecamBox | null, content: null });
    // if the windows ever go through a door without speakers, a kept clip is heard again by Scribe (a few seconds of
    // sound each) so the framing can follow who is talking; today the windows are Scribe's and this never runs
    const windowDoor = "scribe" as const; const rehear = (windowDoor as string) !== "scribe";
    for (const m of todo) {
      if (job.signal?.aborted) throw new ClipsError("lease_lost", "lease lost");
      if (rehear) {
        const snd = join(dir, `rh${m.rank}.mp3`);
        try {
          const h = await (deps.hearClip ?? (async (f: string, sec: number) => { await fetchSound(pl.audio, m.start, sec, f); return hearAudio({ env: deps.env, fetch: deps.fetch }, { audio: await readFile(f), seconds: sec, use: "live_clips_clip", userId: u, provider: "scribe" }); }))(snd, m.end - m.start);
          if (h.words.length) { m.words = h.words.map((w) => [w.text, round2(w.start + m.start), round2(w.end + m.start), w.speaker ?? null] as [string, number, number, string | null]); m.transcript = h.words.map((w) => w.text).join(" ").slice(0, 2000); m.speech = speechOf(h.words.map((w) => ({ ...w, start: w.start + m.start, end: w.end + m.start }))); }
        } catch (err: any) { log(`[live] clip ${m.rank} of ${job.id} not re-heard: ${String(err?.message ?? err).slice(0, 120)}`); }
        finally { await rm(snd, { force: true }).catch(() => undefined); }
      }
      const from = Math.max(0, m.start - 2), file = join(dir, `st${m.rank}.mp4`);
      const tc = Date.now();
      try {
        await stretchOf(pl.video, from, m.end + 2 - from, file);
        const src: SourceInput = { video: file, audio: null, proxy: null, width: 0, height: 0, fps: null, offset: from };
        // framing: "person" = Clips' own; "stacked" or "auto" = the facecam on top when one is found on the stretch
        let layout: CutCtx["layout"] = null; let stackedCamH = 0; let stacked: { cam: FacecamBox; content: FacecamBox | null } | null = null; let contentOnly: FacecamBox | null = null; let seen: { cam: FacecamBox | null; content: FacecamBox | null; irl: boolean; tiny: boolean } | null = null;
        if (format === "vertical" && framingOf(st.framing) !== "person") {
          const still = (await stills(file, [Math.max(0.5, (m.start - from) + (m.end - m.start) / 2)], dir, `fc${m.rank}`))[0];
          const lay = still ? asLayout(await (deps.facecam ?? ((jpg) => findLayout(deps, jpg, u)))(still.jpg).catch(() => null)) : { cam: null, content: null };
          // a camera box over 15 % of the frame is the person themselves (an IRL stream): framed on them, never stacked
          const irl = !!lay.cam && lay.cam.w * lay.cam.h > FORMAT.irl_cam_share;
          const tiny = !!lay.cam && lay.cam.w < TINY_CAM_W;
          log(`[live] layout ${JSON.stringify({ job: job.id, rank: m.rank, cam: lay.cam, content: lay.content, irl, tiny })}`); seen = { cam: lay.cam, content: lay.content, irl, tiny };
          if (lay.cam && !irl && !tiny) stacked = lay as { cam: FacecamBox; content: FacecamBox | null };
          // no camera worth a panel (none, or a tiny one) but a content box: the content fills the frame, the desktop around it goes
          else if (!irl && lay.content) contentOnly = lay.content;
        }
        // the format: the clip as streamed; captions, when chosen, placed under the divider (or at 58 % on a full-frame clip)
        if (stacked) { const { cam, content } = stacked; layout = (info) => stackedLayout(info, cam, content); stackedCamH = stackedLayout({ w: 1920, h: 1080, fps: null }, cam, content).camH; }
        else if (contentOnly) { const content = contentOnly; layout = (info) => contentLayout(info, content); }
        const captionY = stackedCamH ? stackedCamH / FORMAT.h + FORMAT.caption.gap : FORMAT.caption.irl_y;
        const captions = ctxBase.captions ? { ...ctxBase.captions, style: { ...ctxBase.captions.style, y: captionY, maxWidth: Math.min(Number(ctxBase.captions.style?.maxWidth) || 1, FORMAT.caption.max_width) } } : null;
        const r = await (deps.cut ?? cutClip)({ ...ctxBase, src, layout, captions, edit: { layout: stacked ? "stacked" : contentOnly ? "content" : "follow", ...(seen ?? {}), cam_h: stackedCamH || null } }, m);
        made.push({ rank: m.rank, asset_id: r.asset_id, seconds: r.seconds }); cutTimes.push([Math.round(r.seconds * 10) / 10, Math.round((Date.now() - tc) / 100) / 10]);
        await renew(sb, job, { clip_at: new Date().toISOString(), done: made.length, total: kept.length, message: made.length < kept.length ? `Cutting clip ${made.length + 1} of ${kept.length}` : "Finishing", made });
      } catch (err: any) {
        if (err instanceof ClipsError && (err.code === "storage_full" || err.code === "too_many_files" || err.code === "lease_lost")) throw err;
        skipped.push(m.rank); log(`[live] clip ${m.rank} of ${job.id} skipped: ${String(err?.message ?? err).slice(0, 200)}`);
      } finally { await rm(file, { force: true }).catch(() => undefined); }
    }
    if (!made.length) throw new ClipsError("clips_cut_failed", "None of the clips could be cut.", 502, true);
    timing.cut_s = Math.round((Date.now() - tCut) / 1000); timing.clips = cutTimes.length; timing.clip_s = Math.round(cutTimes.reduce((a, c) => a + c[0], 0)); timing.cuts = cutTimes; timing.run_s = Math.round((Date.now() - t0) / 1000); timing.eta_s = Number(o.eta_seconds) || null;
    // D. settle: the reading once, each clip made; the rest goes back
    const charged = Math.min(job.credits_reserved, clipsCharge(price, made.length));
    const asked = Number(o.count ?? o.max_clips) || kept.length;
    const word = (n: number) => `${n} ${n === 1 ? "clip" : "clips"}`;
    const note = skipped.length ? `${word(made.length)} made; ${skipped.length} could not be cut. You were charged for the ${word(made.length)} made; the rest went back.`
      : made.length < asked ? `The chat pointed at ${checked} moments and ${word(made.length)} stood alone as clips, of the ${asked} you asked for.${unsafeNote(unsafe, checked)} You were charged for ${word(made.length)}; the rest went back.` : null;
    await setCollection({ status: "ready", note });
    await renew(sb, job, { stage: "done", outcome: made.length < asked ? "fewer" : "done", made_count: made.length, asked, charged }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
    if (done.error) throw done.error;
    log(`[live] timing ${JSON.stringify({ job: job.id, ...timing, cuts: undefined })}`);
    recordEvent({ user_id: u, kind: "feature", name: "clips_done", props: { job: job.id, platform: b.platform, stream: true, length, clips: made.length, asked, planned: kept.length, minutes: Math.round(b.seconds / 60), credits: charged, reserved: job.credits_reserved, timing } });
    return "done";
  } catch (err: any) {
    const code = err instanceof ClipsError ? err.code : err instanceof LiveSourceError ? err.code : "clips_failed";
    if (code === "lease_lost" || job.signal?.aborted) return "lease_lost";
    const retry = err instanceof ClipsError || err instanceof LiveSourceError ? !!err.retry : true;
    const last = !retry || (job.attempts ?? 1) >= 3;
    log(`[live] ${code} ${JSON.stringify({ job: job.id, detail: String(err?.message ?? err).slice(0, 240) })}`);
    const said = String(err?.message ?? code).replace(/[.\s]+$/, "");
    if (last) await setCollection({ status: made.length ? "ready" : "failed", note: made.length ? `${made.length} clips made before it stopped: ${said.slice(0, 160)}. You were charged for those; the rest went back.` : `${said.slice(0, 240)}.` });
    if (last && made.length) {
      const charged = Math.min(job.credits_reserved, clipsCharge(price, made.length));
      await renew(sb, job, { stage: "done", outcome: "partial", made_count: made.length, charged }).catch(() => undefined);
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
      if (done.error) log(`[live] could not settle ${job.id}: ${done.error.message}`);
      return "partial";
    }
    const failed = await studioFail(sb, { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry, p_detail: String(err?.message ?? err).slice(0, 4000) });
    if (failed.error) log(`[live] could not record the failure of ${job.id}: ${failed.error.message}`);
    return code;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
/** Words into short runs of one speaker (up to 12 words), for the framing model (as Clips does). */
function speechOf(words: Array<{ text: string; start: number; end: number; speaker: string | null }>): Moment["speech"] {
  const out: NonNullable<Moment["speech"]> = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last[2] === (w.speaker ?? null) && w.start - last[1] < 0.8 && last[3].split(" ").length < 12) { last[1] = round2(w.end); last[3] += ` ${w.text}`; }
    else out.push([round2(w.start), round2(w.end), w.speaker ?? null, w.text]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Routes: the Streams page (top live streams by niche) and a link's channel or broadcast
// ---------------------------------------------------------------------------------------------------
const OFF_TOPIC = /slots|casino|gambl|poker|betting|crypto|trading/i;
let discovery: { at: number; streams: Array<LiveStream & { niche: string; permission: Permission }> } | null = null;
export async function discoverStreams(deps: LiveDeps, env: Record<string, string | undefined>): Promise<Array<LiveStream & { niche: string; permission: Permission }>> {
  if (discovery && Date.now() - discovery.at < 120_000) return discovery.streams;
  // English streams; the top 100 of each platform, and IRL, Just Chatting and GTA VI read on their own so each fills up
  // (Nov 21 2026: the top 100 held 3 IRL and 7 Just Chatting; each category on its own has ~100); Twitch's top 300, so
  // Games fills too, and Kick's games read one by one
  const none = [] as LiveStream[];
  const gta = await twitchGameId(deps, "Grand Theft Auto VI").catch(() => null);
  const [tw, twIrl, twChat, twGta, kkApi, kkSite, kkIrl, kkChat] = await Promise.all([
    twitchTopStreams(deps, 100, { language: "en", pages: 3 }).catch(() => none), twitchTopStreams(deps, 100, { language: "en", gameId: TWITCH_GAME.irl }).catch(() => none),
    twitchTopStreams(deps, 100, { language: "en", gameId: TWITCH_GAME.chatting }).catch(() => none), gta ? twitchTopStreams(deps, 100, { language: "en", gameId: gta }).catch(() => none) : Promise.resolve(none),
    kickTopStreams(deps, 100).then((l) => l.filter((x) => !x.language || /^en/i.test(x.language))).catch(() => none),
    kickSiteLive(deps, { pages: 6 }).catch(() => none), kickSiteLive(deps, { subcategory: "irl", pages: 5 }).catch(() => none), kickSiteLive(deps, { subcategory: "just-chatting", pages: 5 }).catch(() => none),
  ]);
  // Kick: its official list (when the keys are set) and its site's, and GTA VI on its own; most of Kick is not in English,
  // so it takes more pages to fill
  const [kkGta, kkGames] = await Promise.all([kickSiteLive(deps, { subcategory: "grand-theft-auto-vi", pages: 5 }).catch(() => none), kickGames(deps).catch(() => none)]);
  const kk = [...kkApi, ...kkSite, ...kkIrl, ...kkChat, ...kkGta, ...kkGames];
  const seen = new Set<string>();
  const all = [...tw, ...twIrl, ...twChat, ...twGta, ...kk].filter((s) => { const k = `${s.platform}:${s.login}`; if (!s.login || seen.has(k)) return false; seen.add(k); return true; });
  // gambling and trading streams are not offered (Kick's front page has many; they would fill "Games")
  const streams = all.filter((s) => !OFF_TOPIC.test(s.category ?? "")).map((s) => ({ ...s, niche: nicheOf(s.category), permission: streamerPermission(s.platform, s.login, env) })).filter((s) => s.permission !== "blocked").sort((a, b) => b.viewers - a.viewers);
  discovery = { at: Date.now(), streams };
  return streams;
}
export const resetDiscovery = () => { discovery = null; };
export function registerLiveClips(app: Express, sbFn: () => SupabaseClient, deps: LiveDeps = {}) {
  const env = deps.env ?? process.env;
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const gate = async (req: Request, res: Response): Promise<string | null> => {
    const u = userId(req); if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    if (!liveClipsEnabled(env)) { res.status(503).json({ error: "tool_not_open", detail: "Live Clips is not switched on yet" }); return null; }
    if (!liveClipsOpen(env) && !(await isStudioAdmin(req, sbFn(), env))) { res.status(503).json({ error: "tool_not_open", detail: "Live Clips is not open yet" }); return null; }
    return u;
  };
  const fail = (res: Response, err: any) => {
    if (err instanceof ClipsError || err instanceof LiveSourceError) return res.status(err.status).json({ error: err.code, detail: err.message });
    console.error("[live]", err); return res.status(500).json({ error: "live_failed", detail: String(err?.message ?? err).slice(0, 200) });
  };
  // YouTube on the hub: the newest long videos of the creators clippers work from (src/youtube-feed.ts)
  app.get("/api/studio/live/youtube", async (req, res) => {
    if (!(await gate(req, res))) return;
    try { res.json(await youtubeFeed({ fetch: deps.fetch })); } catch (err) { fail(res, new ClipsError("youtube_feed_down", "YouTube's feeds did not answer; try again in a minute", 503)); }
  });
  app.get("/api/studio/live/streams", async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const streams = await discoverStreams(deps, env);
      const niche = typeof req.query.niche === "string" && NICHES.some((n) => n.id === req.query.niche) ? req.query.niche : null;
      const platform = req.query.platform === "twitch" || req.query.platform === "kick" ? req.query.platform : null;
      res.json({ niches: NICHES.map((n) => ({ id: n.id, label: n.label, live: streams.filter((s) => s.niche === n.id).length })), streams: streams.filter((s) => (!niche || s.niche === niche) && (!platform || s.platform === platform)).slice(0, 72), counts: Object.fromEntries((["twitch", "kick"] as const).map((p) => [p, Object.fromEntries(NICHES.map((n) => [n.id, streams.filter((s) => s.platform === p && s.niche === n.id).length]))])), fresh_at: new Date(discovery?.at ?? Date.now()).toISOString(), open: liveClipsOpen(env), live_mode: liveNowOpen(env) || (await isStudioAdmin(req, sbFn(), env).catch(() => false)) });
    } catch (err) { fail(res, err); }
  });
  // creators by name as someone types (Twitch's official search); blocked streamers are left out
  app.get("/api/studio/live/search", async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const q = String(req.query.q ?? "").trim().replace(/^@/, "").slice(0, 40);
      if (q.length < 2) return res.json({ creators: [] });
      const hits = await briefly(`s:${q.toLowerCase()}`, 60_000, () => twitchSearch(deps, q.toLowerCase(), 8));
      res.json({ creators: hits.filter((c) => streamerPermission("twitch", c.login, env) !== "blocked") });
    } catch (err) { fail(res, err); }
  });
  app.get("/api/studio/live/lookup", async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const link = parseStreamLink(req.query.url);
      if (!link) throw new ClipsError("unsupported_link", "Paste a Twitch or Kick link: a channel, or one of its past broadcasts");
      // live_mode: whether this person gets the live flow for a stream still on (STUDIO_LIVE_NOW, or the owner)
      const liveMode = liveNowOpen(env) || (await isStudioAdmin(req, sbFn(), env).catch(() => false));
      if (link.kind === "vod") { const b = await resolveBroadcast(deps, link.url); return res.json({ platform: b.platform, channel: { login: b.login, channel: b.channel, channel_id: b.channel_id, url: b.platform === "twitch" ? `https://www.twitch.tv/${b.login}` : `https://kick.com/${b.login}`, permission: streamerPermission(b.platform, b.login, env), live: !!b.live }, broadcasts: [b], live_mode: liveMode }); }
      if (link.platform === "twitch") {
        const user = await briefly(`u:${link.login}`, 10 * 60_000, () => twitchUser(deps, link.login!));
        if (!user) throw new ClipsError("link_no_media", "No Twitch channel has that name", 404);
        const permission = streamerPermission("twitch", user.login, env);
        if (permission === "blocked") throw new ClipsError("streamer_blocked", `${user.display_name} has asked not to be clipped on Clone8`, 403);
        const [list, now, followers] = await briefly(`c:${user.id}`, 60_000, () => Promise.all([twitchBroadcasts(deps, user.id, 100), twitchLiveNow(deps, user.id).catch(() => null), twitchFollowers(deps, user.id)]));
        // the stream on now is listed first, marked, however short it still is (the page says when it can be clipped)
        const marked = list.map((b) => (isRecordingOf(b, now) ? { ...b, live: true, thumbnail_url: now!.thumbnail_url ?? b.thumbnail_url } : b));
        return res.json({ platform: "twitch", channel: { login: user.login, channel: user.display_name, channel_id: user.id, url: `https://www.twitch.tv/${user.login}`, profile_image_url: user.profile_image_url, permission, live: !!now, viewers: now?.viewers ?? null, title: now?.title ?? null, category: now?.category ?? null, followers, past_count: marked.filter((b) => !b.live && b.seconds >= LIVE_LIMITS.min_seconds).length, past_more: list.length >= 100 },
          broadcasts: [...marked.filter((b) => b.live), ...marked.filter((b) => !b.live && b.seconds >= LIVE_LIMITS.min_seconds)].slice(0, 40), live_mode: liveMode });
      }
      const ch = await kickChannel(deps, link.login!);
      const permission = streamerPermission("kick", ch.slug, env);
      if (permission === "blocked") throw new ClipsError("streamer_blocked", `${ch.channel} has asked not to be clipped on Clone8`, 403);
      const list = await kickBroadcasts(deps, ch.slug, ch);
      return res.json({ platform: "kick", channel: { login: ch.slug, channel: ch.channel, channel_id: ch.id, url: `https://kick.com/${ch.slug}`, profile_image_url: ch.profile_image_url, permission, live: ch.live, viewers: ch.viewers, title: ch.title, category: ch.category }, broadcasts: list.filter((b) => b.seconds >= LIVE_LIMITS.min_seconds).slice(0, 20), live_mode: liveMode });
    } catch (err) { fail(res, err); }
  });
}
