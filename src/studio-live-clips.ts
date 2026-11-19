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
import { annotateLines, claudeJson, clipsCharge, cutClip, ffmpeg, lengthOf, linesFromWords, loudnessExcess, loudnessTrack, loudPeaks, perClipUsd, captionsPerClip, CLIP_LENGTHS, ClipsError, type ClipFormat, type ClipLength, type ClipsDeps, type ClipsPrice, type CutCtx, type Line, type Moment, type SourceInput } from "./studio-clips.js";
import { transcribeWords } from "./studio-eleven.js";
import { creditValueFloor, type PlanLike } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import { studioFail } from "./studio-fail.js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { hlsVariants, kickBroadcastSource, kickBroadcasts, kickChannel, kickChatReplay, kickTopStreams, LiveSourceError, nicheOf, NICHES, parseStreamLink, pickRungs, twitchBroadcastById, twitchBroadcasts, twitchChatReplay, twitchTopStreams, twitchUser, twitchVodPlaylists, type Broadcast, type ChatMsg, type LiveDeps, type LiveStream, type Platform } from "./live-sources.js";

// ---------------------------------------------------------------------------------------------------
// Switches, limits, prices
// ---------------------------------------------------------------------------------------------------
/** The tool exists (STUDIO_LIVE_CLIPS_ENABLED) with the keys it needs; STUDIO_LIVE_CLIPS_OPEN opens it to customers,
 *  else the owner's account alone (the usual owner-first gate). */
export const liveClipsEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.STUDIO_LIVE_CLIPS_ENABLED === "true" && !!env.ANTHROPIC_API_KEY && !!env.ELEVENLABS_API_KEY && !!env.TWITCH_CLIENT_ID && !!env.TWITCH_CLIENT_SECRET;
export const liveClipsOpen = (env: Record<string, string | undefined> = process.env) => liveClipsEnabled(env) && env.STUDIO_LIVE_CLIPS_OPEN === "true";
/** A broadcast of any length the platform still keeps (Twitch keeps up to 48 hours): the reading is by windows, so
 *  length only adds chat pages; the model checks are capped by verify_max whatever the length. */
export const LIVE_LIMITS = { min_seconds: 600, max_seconds: 48 * 3600, max_clips: 50, min_chat_per_minute: 15, verify_per_clip: 3, verify_extra: 4, verify_max: 60 };
/** Prices (RESEARCH.md 6.5, revised with experiment 1): reading a past stream by the hour (the chat, and about four
 *  candidate windows an hour heard and checked), at least the minimum; and each clip, which carries the two or three
 *  extra windows it took to find it (experiment 1: a third to a half of the checked windows become clips), so a stream
 *  clip is 10 credits where a Clips clip is 5. */
export const LIVE_RATES = { per_hour: 15, min: 30, /** the reading is charged for the first hours only: our cost of reading does not grow past this (the checks are capped) */ hours_cap: 8, per_clip: { short: 10, standard: 10, long: 12, minute: 12 } as Record<ClipLength, number> };
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
export function streamPrice(plans: PlanLike[], p: { seconds: number; length: ClipLength; count?: number; env: Record<string, string | undefined> }): ClipsPrice {
  const floor = plans.length ? creditValueFloor(plans) : 0.016;
  const hours = Math.min(p.seconds / 3600, LIVE_RATES.hours_cap);
  return {
    analysis: Math.max(LIVE_RATES.min, Math.ceil(hours * LIVE_RATES.per_hour), credits(streamAnalysisUsd(hours * 3600), floor, LIVE_SAFETY_MARGIN.analysis)),
    per_clip: Math.max(LIVE_RATES.per_clip[p.length], credits(streamClipUsd(p.length, p.env), floor, LIVE_SAFETY_MARGIN.clip)),
    lite: 0,
  };
}
/** About how many clips a stream holds and the most a run tries for: a strong moment every 15-20 minutes on a busy
 *  stream; never more than one per two minutes of stream. */
export const likelyStreamClips = (seconds: number) => Math.max(1, Math.min(LIVE_LIMITS.max_clips, Math.round(seconds / 1000)));
export const streamCountCap = (seconds: number) => Math.max(1, Math.min(LIVE_LIMITS.max_clips, Math.floor(seconds / 120)));
export type Strictness = "best" | "balanced" | "more";
export const VERIFY_BAR: Record<Strictness, number> = { best: 70, balanced: 60, more: 50 };
const strictnessOf = (v: unknown): Strictness => (v === "best" || v === "more" ? v : "balanced");
export type Framing = "auto" | "stacked" | "person";
const framingOf = (v: unknown): Framing => (v === "stacked" || v === "person" ? v : "auto");

// ---------------------------------------------------------------------------------------------------
// The streamer registry (RESEARCH.md section 3): who may be clipped how. Phase 1: a data file plus an environment
// block list; the opt-out page and the stored table come with the posting phase.
// ---------------------------------------------------------------------------------------------------
export type Permission = "campaign" | "unknown" | "blocked";
import registry from "./data/live-streamers.json" with { type: "json" };
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
export type StreamSource = { platform: Platform; url: string; asset_id: null; title: string | null; channel: string | null; login: string; channel_id: string; vod_id: string; seconds: number; started_at: string; thumbnail_url: string | null; permission: Permission };
export type StreamQuote = { tool: "clips"; credits: number; options: Record<string, any>; summary: string };
/** The broadcast behind a link: Twitch by id (official), Kick by uuid (the site's listing of its channel). */
export async function resolveBroadcast(deps: LiveDeps, url: string): Promise<Broadcast> {
  const link = parseStreamLink(url);
  if (!link) throw new ClipsError("unsupported_link", "Live Clips takes a Twitch or Kick link to a past broadcast");
  if (link.kind !== "vod") throw new ClipsError("pick_broadcast", "That is a channel: pick one of its past broadcasts", 400);
  if (link.platform === "twitch") {
    const b = await twitchBroadcastById(deps, link.id!);
    if (!b) throw new ClipsError("link_no_media", "No past broadcast is at that link (Twitch keeps them 7 to 60 days)", 404);
    return b;
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
  if (b.seconds < LIVE_LIMITS.min_seconds) throw new ClipsError("clip_source_too_short", "That broadcast is under 10 minutes");
  if (b.seconds > LIVE_LIMITS.max_seconds) throw new ClipsError("clip_source_too_long", `That broadcast is ${Math.round(b.seconds / 3600)} hours; Live Clips reads up to 48 hours of a stream`);
  const length = lengthOf(opt.length), format: ClipFormat = opt.format === "original" ? "original" : "vertical";
  const likely = likelyStreamClips(b.seconds), cap = streamCountCap(b.seconds);
  const asked = Math.round(Number(opt.count));
  const count = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, cap) : Math.min(likely, 10);
  const price = streamPrice(plans, { seconds: b.seconds, length, count, env });
  const captions = opt.captions && typeof opt.captions === "object" ? (await import("./studio-caption-video.js")).cleanSettings(opt.captions) : null;
  if (captions) price.per_clip += captionsPerClip(env);
  const source: StreamSource = { platform: b.platform, url: b.url, asset_id: null, title: b.title || null, channel: b.channel || null, login: b.login, channel_id: b.channel_id, vod_id: b.id, seconds: b.seconds, started_at: b.started_at, thumbnail_url: b.thumbnail_url, permission };
  const minutes = Math.ceil(b.seconds / 60), hours = Math.round((b.seconds / 3600) * 10) / 10;
  const warning = Number.isFinite(asked) && asked > cap ? `A ${hours}-hour stream fits at most ${cap} clips, so we'll aim for ${cap}. You're only charged for the clips we make.`
    : count > likely ? `A ${hours}-hour stream usually holds about ${likely} strong ${likely === 1 ? "clip" : "clips"}. We'll make as many as the chat really reacted to, up to ${count}; you're only charged for the clips we make.` : null;
  // how long, from the Nov 18 2026 live runs (a 7.8 h stream: chat in 15 s, 34 checks in 666 s, 5 cuts in 157 s; the
  // old formula promised 42 min for that 14-min run): the chat, then each candidate heard and checked, then the cuts
  const cands = Math.min(LIVE_LIMITS.verify_max, count * LIVE_LIMITS.verify_per_clip + LIVE_LIMITS.verify_extra);
  const eta_seconds = Math.round(45 + b.seconds * 0.004 + cands * 22 + count * 35);
  return {
    tool: "clips", credits: clipsCharge(price, count),
    options: { platform: b.platform, url: b.url, stream: { platform: b.platform, vod_id: b.id, login: b.login, channel_id: b.channel_id, started_at: b.started_at, permission, strictness: strictnessOf(opt.strictness), framing: framingOf(opt.framing) },
      format, length, count, likely, cap, max_clips: count, seconds: b.seconds, minutes, source, youtube_direct: true, price, warning, language: "original", captions, eta_seconds, ahead: 0 },
    summary: `${hours} h of ${b.channel} · up to ${count} ${count === 1 ? "clip" : "clips"}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// The detector: the chat's content against its own baseline (RESEARCH.md 4.1-4.2, measured in experiment 1)
// ---------------------------------------------------------------------------------------------------
const LAUGH = /\b(LUL\w*|KEKW|OMEGALUL|LMAO+|LMFAO|HAHA+|LOL+|KEK|XD)\b|😂|💀|🤣/i;
const HYPE = /\b(W|POG\w*|LETS ?GO+|GG|HOLY|NO WAY|WTF|OMG|INSANE|CRAZY|NAH|BRUH|WHAT|CLUTCH|SHEESH)\b|🔥|😱|\?\?\?+|!!!+/i;
const CAPS = /^[^a-z]{6,}$/;
const ASK = /\bclip/i;
export type ChatSignals = { bins: number; rate: number[]; distinct: number[]; laugh: number[]; hype: number[]; same: number[]; caps: number[]; emote: number[]; asks: number[]; perMinute: number };
/** Per-10-second counts of each signal over the whole broadcast. */
export function chatSignals(msgs: ChatMsg[], seconds: number): ChatSignals {
  const bins = Math.max(1, Math.ceil(seconds / 10) + 1);
  const by: ChatMsg[][] = Array.from({ length: bins }, () => []);
  for (const m of msgs) { const b = Math.floor(m.t / 10); if (b >= 0 && b < bins) by[b].push(m); }
  const z = () => new Array(bins).fill(0);
  const s: ChatSignals = { bins, rate: z(), distinct: z(), laugh: z(), hype: z(), same: z(), caps: z(), emote: z(), asks: z(), perMinute: msgs.length / Math.max(1, seconds / 60) };
  for (let b = 0; b < bins; b++) {
    const w = by[b]; s.rate[b] = w.length; if (!w.length) continue;
    s.distinct[b] = new Set(w.map((m) => m.u)).size;
    const same = new Map<string, number>();
    for (const m of w) {
      const t = m.c.trim();
      if (LAUGH.test(t)) s.laugh[b]++;
      if (HYPE.test(t)) s.hype[b]++;
      if (CAPS.test(t)) s.caps[b]++;
      if (m.e > 0) s.emote[b]++;
      const k = t.toLowerCase(); same.set(k, (same.get(k) ?? 0) + 1);
    }
    s.same[b] = Math.max(...same.values());
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
export type Candidate = { rank: number; onset: number; peak: number; last: number; t_event: number; score: number; zs: Record<string, number>; asks: number; sample: string[] };
export const CANDIDATE = { combined: 6, single: 3, rate_only: 3, asks: 3, merge_s: 90, min_messages: 8 };
/** The moments the chat points at, strongest first: bins where the combined content burst is high (or one content
 *  signal alone, or the rate alone on a small chat, or people asking for a clip), merged within 90 s. */
export function chatCandidates(s: ChatSignals, msgs: ChatMsg[]): Candidate[] {
  const Z = { caps: robustZ(s.caps), laugh: robustZ(s.laugh), hype: robustZ(s.hype), same: robustZ(s.same), emote: robustZ(s.emote), rate: robustZ(s.rate), distinct: robustZ(s.distinct) };
  const out: Candidate[] = []; let cur: Candidate | null = null;
  for (let b = 0; b < s.bins; b++) {
    if (s.rate[b] < CANDIDATE.min_messages) continue;
    const content = Z.caps[b] + Z.laugh[b] + Z.hype[b] + Z.same[b] + Z.emote[b];
    const combined = content + 0.5 * (Z.rate[b] + Z.distinct[b]);
    const single = Math.max(Z.caps[b], Z.laugh[b], Z.hype[b]);
    const rateBurst = Z.rate[b] >= CANDIDATE.rate_only && Z.distinct[b] >= 2 && s.rate[b] >= 2.5 * Math.max(1, s.rate[Math.max(0, b - 30)]);
    const ok = combined >= CANDIDATE.combined || single >= CANDIDATE.single || rateBurst || s.asks[b] >= CANDIDATE.asks;
    if (!ok) continue;
    const score = combined + (s.asks[b] >= CANDIDATE.asks ? 6 : 0);
    const zs = Object.fromEntries(Object.entries(Z).map(([k, v]) => [k, Math.round(v[b] * 10) / 10]));
    const t = b * 10;
    if (cur && t - cur.last <= CANDIDATE.merge_s) {
      cur.last = t;
      if (score > cur.score) { cur.score = score; cur.peak = t; cur.zs = zs; cur.asks = s.asks[b]; }
    } else { cur = { rank: 0, onset: t, peak: t, last: t, t_event: Math.max(0, t - 8), score, zs, asks: s.asks[b], sample: [] }; out.push(cur); }
  }
  for (const c of out) {
    const w = msgs.filter((m) => m.t >= c.peak && m.t < c.peak + 10);
    // (the loudest first: all-caps, then laughter and hype, then the rest)
    const rank = (m: ChatMsg) => (CAPS.test(m.c.trim()) ? 0 : LAUGH.test(m.c) || HYPE.test(m.c) ? 1 : 2);
    c.sample = w.map((m, i) => ({ m, i })).sort((x, y) => rank(x.m) - rank(y.m) || x.i - y.i).slice(0, 8).map(({ m }) => m.c.slice(0, 40));
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((c, k) => ({ ...c, rank: k + 1, score: Math.round(c.score * 10) / 10 }));
}

// ---------------------------------------------------------------------------------------------------
// Hearing a candidate and placing its cut (4.3-4.4): the window is 45 s before the chat's onset to 105 s after
// ---------------------------------------------------------------------------------------------------
export const WINDOW = { lead: 45, length: 150 };
export const VERIFY_SYSTEM = `You are the best short-form video editor alive, checking ONE candidate moment from a live stream before it is cut into a 20-55 second vertical clip for TikTok, Reels and Shorts. The moment was found by the stream's own chat reacting (the burst is marked on the transcript) and by the sound. You see the transcript of the window with its signals, and stills from it. Decide whether this is a clip a stranger would stop for, and where exactly it should start and end.

Keep it only if ALL hold: it stands alone (no context needed from earlier in the stream, no "as I said"); it has a payoff (a laugh, a shock, a win, a fail, a reveal, a line that lands) and the clip ends right after it; it is not a sponsor read, an ad break, a "be right back" screen, music only, or the streamer reading a chat message that needs the chat to be seen; it is not just the game's cutscene with the streamer silent unless the picture itself is the payoff.

The proposed cut is only a first guess from the chat's timing. YOUR job is to find the best clip inside the whole window: if the payoff comes later than the proposed end (the chat often reacts before the moment finishes), move end_line to the line where the payoff lands plus the reaction it earns; if the setup starts earlier, move start_line back. The clip must be 20 to 55 seconds and start where a thought starts. Judge the moment with YOUR boundaries, not the proposed ones. Score 0-100 for how likely it holds a stranger (hook 30, payoff 25, energy or reaction 20, standalone 15, novelty 10). Be strict: 90+ exceptional, 75 strong, 60 usable. start_line is the first line of the clip and end_line the last, using the line numbers exactly as given. title under 60 characters in the stream's language, no hashtags; hook: the first spoken line, under 100 characters; why under 15 words; why_not under 15 words when it should not be kept (empty otherwise); tags: 1 to 3 lowercase topic words.`;
export const VERIFY_SCHEMA = { type: "object", additionalProperties: false, required: ["keep", "score", "standalone", "start_line", "end_line", "title", "hook", "why", "why_not", "tags"],
  properties: { keep: { type: "boolean" }, score: { type: "integer" }, standalone: { type: "boolean" }, start_line: { type: "integer" }, end_line: { type: "integer" }, title: { type: "string" }, hook: { type: "string" }, why: { type: "string" }, why_not: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export type Heard = { words: Array<{ text: string; start: number; end: number; speaker: string | null }>; events: Array<{ text: string; start: number; end: number }>; lines: Line[]; excess: number[] | null; language: string | null };
/** The first guess at the cut on the lines: a thought that opens 8-25 s before the event; a thought that closes once
 *  the chat has started falling (or 12 s past its peak), carried past a laugh. 20-55 s. */
export function firstCut(lines: Line[], eventRel: number, peakRel: number, chatAt: (rel: number) => number, base: number, events: Heard["events"]): { s: number; e: number } {
  if (!lines.length) return { s: 0, e: 0 };
  const opens = (k: number) => k === 0 || !!lines[k].opens, closes = (k: number) => k === lines.length - 1 || !!lines[k].closes;
  let s = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 8 && lines[k].start >= eventRel - 25) { s = k; break; }
  if (s < 0) for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 8) { s = k; break; }
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
type Verdict = { keep: boolean; score: number; standalone: boolean; start_line: number; end_line: number; title: string; hook: string; why: string; why_not: string; tags: string[] };

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number; created_at?: string; signal?: AbortSignal };
export type StreamDeps = ClipsDeps & LiveDeps & {
  /** for tests: the chat replay, the playlists, the hearing of one window, the verify call, the cutter */
  chat?: (b: Broadcast, onProgress: (share: number) => void) => Promise<ChatMsg[]>;
  playlists?: (b: Broadcast) => Promise<{ audio: string; video: string }>;
  hear?: (audioFile: string, dir: string) => Promise<Heard>;
  verify?: (input: { lines: Line[]; stills: Array<{ t: number; jpg: Buffer }>; head: string; body: string }) => Promise<Verdict>;
  stills?: (video: string, times: number[], dir: string, tag: string) => Promise<Array<{ t: number; jpg: Buffer }>>;
  fetchWindow?: (url: string, start: number, seconds: number, target: string) => Promise<void>;
  fetchStretch?: (url: string, start: number, seconds: number, target: string) => Promise<void>;
  cut?: (ctx: CutCtx, m: Moment) => Promise<{ asset_id: string; bytes: number; seconds: number }>;
  /** for tests: whether ffmpeg has drawtext, without asking it */ drawtext?: boolean;
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
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, start)), "-i", url, "-t", String(seconds), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", target], { timeoutMs: 4 * 60_000 });
}
export async function fetchStretchCopy(url: string, start: number, seconds: number, target: string): Promise<void> {
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, start)), "-i", url, "-t", String(seconds), "-c", "copy", "-movflags", "+faststart", target], { timeoutMs: 6 * 60_000 });
}
async function stillsFrom(video: string, times: number[], dir: string, tag: string): Promise<Array<{ t: number; jpg: Buffer }>> {
  const out: Array<{ t: number; jpg: Buffer }> = [];
  for (const t of times) {
    const f = join(dir, `${tag}_${Math.round(t)}.jpg`);
    try { await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(Math.max(0, t)), "-i", video, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "5", f], { timeoutMs: 90_000 }); out.push({ t, jpg: await readFile(f) }); await rm(f, { force: true }).catch(() => undefined); }
    catch { /* a missing still is not a failed candidate */ }
  }
  return out;
}
async function hearWindow(deps: StreamDeps, audioFile: string, dir: string, userId: string): Promise<Heard> {
  const env = deps.env ?? process.env;
  const buf = await readFile(audioFile);
  const r = await transcribeWords({ env, fetch: deps.fetch } as any, { audio: buf, events: true });
  // (the cost ledger: Scribe is priced by the hour of audio; the window is WINDOW.length seconds)
  recordEvent({ user_id: userId, kind: "vendor", name: "elevenlabs_scribe", usd: (WINDOW.length / 3600) * 0.2, props: { use: "live_clips", seconds: WINDOW.length } });
  const rms = await loudnessTrack(audioFile, dir).catch(() => [] as number[]);
  const excess = rms.length ? loudnessExcess(rms) : null;
  const lines = annotateLines(linesFromWords(r.words), r.events, excess);
  return { words: r.words, events: r.events, lines, excess, language: r.language };
}
async function verifyWithClaude(deps: StreamDeps, input: { lines: Line[]; stills: Array<{ t: number; jpg: Buffer }>; head: string; body: string }, userId: string): Promise<Verdict> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_LIVE_VERIFY_MODEL || "claude-sonnet-5-5", max_tokens: 2000, system: VERIFY_SYSTEM,
    output_config: { effort: env.STUDIO_LIVE_VERIFY_EFFORT || "medium", format: { type: "json_schema", schema: VERIFY_SCHEMA } },
    messages: [{ role: "user", content: [
      ...input.stills.flatMap((f) => [{ type: "text", text: `Still at ${Math.round(f.t)} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
      { type: "text", text: `${input.head}\n\nTranscript (Lnn [m:ss] speaker: words; sounds in brackets; ⟪+dB⟫ = louder than usual; the chat's reaction marked where it begins and peaks):\n${input.body || "(no speech heard in this window)"}` },
    ] }],
  }, "live_clips_verify", userId);
  return { keep: !!out?.keep, score: Number(out?.score) || 0, standalone: !!out?.standalone, start_line: Number(out?.start_line), end_line: Number(out?.end_line), title: String(out?.title ?? ""), hook: String(out?.hook ?? ""), why: String(out?.why ?? ""), why_not: String(out?.why_not ?? ""), tags: Array.isArray(out?.tags) ? out.tags.map((x: any) => String(x)) : [] };
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
2. content: the thing being watched, excluding the webcam box, chat panels, alert bars, overlays and empty borders: the game's viewport, a chess board with its clocks, a browser page or a video player. If the content fills the frame, answer present false with zeros.`;
/** The layout of a still, by Haiku: the facecam box (null when none, or not a box worth stacking) and the content box. */
export async function findLayout(deps: ClipsDeps, jpg: Buffer, userId?: string): Promise<Layout> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_CLIPS_FRAME_MODEL || "claude-haiku-5-5", max_tokens: 400,
    output_config: { effort: "low", format: { type: "json_schema", schema: FACECAM_SCHEMA } },
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } }, { type: "text", text: FACECAM_PROMPT }] }],
  }, "live_clips_facecam", userId);
  return { cam: cleanFacecam(out?.cam), content: cleanContent(out?.content) };
}
/** The content box: at least a third of the frame each way, inside it; else the whole frame (null). */
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
  if (b.w < 0.1 || b.w > 0.6 || b.h < 0.1 || b.h > 0.7 || b.x < 0 || b.y < 0 || b.x + b.w > 1.02 || b.y + b.h > 1.02) return null;
  return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.w, 1 - Math.max(0, b.x)), h: Math.min(b.h, 1 - Math.max(0, b.y)) };
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** The 720x1280 graph: the facecam box scaled to the full width on top (its own shape, 300-600 lines, cropped from a
 *  third of the way down so a face is never cut at the forehead), the content box (or the whole picture) scaled to
 *  the rest and cropped to its middle, frame rate capped at 30. */
export function stackedFilter(info: { w: number; h: number; fps: number | null }, cam: FacecamBox, content: FacecamBox | null = null): string {
  const cw = even(cam.w * info.w), ch = even(cam.h * info.h), cx = even(cam.x * info.w), cy = even(cam.y * info.h);
  const camH = even(Math.max(300, Math.min(600, 720 * ch / Math.max(1, cw))));
  const gameH = 1280 - camH;
  const fps = info.fps && info.fps > 30.5 ? ",fps=30" : "";
  const focus = content ? `crop=${even(content.w * info.w)}:${even(content.h * info.h)}:${even(content.x * info.w)}:${even(content.y * info.h)},` : "";
  return `[0:v]split=2[c][g];[c]crop=${cw}:${ch}:${cx}:${cy},scale=720:${camH}:force_original_aspect_ratio=increase,crop=720:${camH}:0:(ih-${camH})*0.3[cam];[g]${focus}scale=720:${gameH}:force_original_aspect_ratio=increase,crop=720:${gameH}[game];[cam][game]vstack,setsar=1${fps},format=yuv420p[v]`;
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
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function runStreamClipsJob(sb: SupabaseClient, deps: StreamDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id, st = o.stream ?? {};
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
    const b: Broadcast = { platform: st.platform, id: String(st.vod_id), url: String(o.url), title: String(o.source?.title ?? ""), channel: String(o.source?.channel ?? st.login ?? ""), login: String(st.login ?? ""), channel_id: String(st.channel_id ?? ""), seconds: Number(o.seconds) || 0, started_at: String(st.started_at ?? ""), views: null, thumbnail_url: null };
    // A. the chat replay, reduced to signals; the broadcast's playlists
    await renew(sb, job, { collection_id: collectionId, stage: "reading", done: 0, total: 0, message: "Reading the chat replay" });
    const tChat = Date.now(); let lastSaid = 0;
    const chat = await (deps.chat ?? ((x, onProgress) => b.platform === "twitch" ? twitchChatReplay(deps, x.id, x.seconds, { onProgress, signal: job.signal }) : kickChatReplay(deps, x.channel_id, x.started_at, x.seconds, { onProgress, signal: job.signal })))(b, (share) => {
      if (Date.now() - lastSaid > 15_000) { lastSaid = Date.now(); void renew(sb, job, { message: `Reading the chat replay · ${Math.round(share * 100)} %` }).catch(() => undefined); }
    });
    timing.chat_s = Math.round((Date.now() - tChat) / 1000); timing.chat_messages = chat.length;
    const signals = chatSignals(chat, b.seconds);
    if (signals.perMinute < LIVE_LIMITS.min_chat_per_minute) throw new ClipsError("chat_too_quiet", `This stream's chat was too quiet to read (${Math.round(signals.perMinute)} messages a minute); Live Clips needs a chat that reacts`, 422);
    const cands = chatCandidates(signals, chat);
    const want = Math.min(LIVE_LIMITS.verify_max, count * LIVE_LIMITS.verify_per_clip + LIVE_LIMITS.verify_extra, cands.length);
    log(`[live] chat ${JSON.stringify({ job: job.id, platform: b.platform, messages: chat.length, per_minute: Math.round(signals.perMinute), candidates: cands.length, checking: want, top: cands.slice(0, 5).map((c) => [c.t_event, c.score]) })}`);
    if (!cands.length) throw new ClipsError("clips_none_found", "The chat never lit up: no moment in this stream stands out enough to clip", 422);
    const pl = await (deps.playlists ?? (async (x) => x.platform === "twitch" ? twitchVodPlaylists(deps, x.id) : pickRungs(await hlsVariants(deps, (await kickBroadcastSource(deps, x.id)).master))))(b);
    // B. each candidate's window heard, then checked by the model, until `count` are kept
    await renew(sb, job, { stage: "transcribing", message: `Listening to the ${want} moments the chat pointed at` });
    const chatAt = (abs: number) => { const bin = Math.floor(abs / 10); return bin >= 0 && bin < signals.bins ? signals.rate[bin] : 0; };
    const baseAt = (abs: number) => { const bin = Math.floor(abs / 10); const h = signals.rate.slice(Math.max(0, bin - 60), Math.max(1, bin)).slice().sort((a, c) => a - c); return h.length ? h[Math.floor(h.length / 2)] : 0; };
    const kept: Moment[] = []; let checked = 0, heardOk = 0; const tListen = Date.now(); let claudeCalls = 0;
    const hear = deps.hear ?? ((f, d) => hearWindow(deps, f, d, u));
    const verify = deps.verify ?? ((input) => verifyWithClaude(deps, input, u));
    const stills = deps.stills ?? stillsFrom;
    const windowOf = deps.fetchWindow ?? fetchSound;
    for (const c of cands.slice(0, want)) {
      if (kept.length >= count) break;
      if (job.signal?.aborted) throw new ClipsError("lease_lost", "lease lost");
      checked++;
      const start = Math.max(0, c.onset - WINDOW.lead), span = Math.min(WINDOW.length, b.seconds - start);
      if (span < 30) continue;
      await renew(sb, job, { stage: checked === 1 ? "transcribing" : "choosing", message: `Checking moment ${checked} of ${want} · ${kept.length} kept`, done: kept.length, total: count });
      const audio = join(dir, `w${c.rank}.mp3`);
      let heard: Heard;
      try { await windowOf(pl.audio, start, span, audio); heard = await hear(audio, dir); heardOk++; }
      catch (err: any) { log(`[live] window ${c.rank} of ${job.id} not heard: ${String(err?.message ?? err).slice(0, 160)}`); continue; }
      finally { await rm(audio, { force: true }).catch(() => undefined); }
      const lines = heard.lines;
      const onsetRel = c.onset - start, peakRel = c.peak - start, eventRel = c.t_event - start, base = baseAt(start);
      const cut = firstCut(lines, eventRel, peakRel, (rel) => chatAt(start + rel), base, heard.events);
      const mark = (l: Line) => {
        const tags: string[] = [];
        if (l.start <= onsetRel && l.end > onsetRel - 1) tags.push(`chat burst begins: ×${(chatAt(c.onset + 5) / Math.max(base, 1)).toFixed(1)} the usual rate`);
        if (l.start <= peakRel && l.end > peakRel - 1) tags.push(`chat peak (${signals.rate[Math.floor(c.peak / 10)]} messages in 10 s, e.g. ${c.sample.slice(0, 5).map((x) => JSON.stringify(x)).join(", ")})`);
        return tags.length ? `${l.text} [${tags.join("; ")}]` : l.text;
      };
      const body = lines.map((l) => `L${l.i} [${mmss(l.start)}]${l.speaker ? ` ${l.speaker}:` : ""} ${mark(l)}${(l.events ?? []).map((x) => ` [${x}]`).join("")}${(l.loud ?? 0) >= 5 ? ` ⟪+${l.loud} dB⟫` : ""}`).join("\n");
      const peaks = heard.excess ? loudPeaks(heard.excess, 5) : [];
      const head = `Stream: ${b.channel} on ${b.platform === "twitch" ? "Twitch" : "Kick"}${b.title ? `, titled "${b.title.slice(0, 80)}"` : ""}. Window: ${mmss(start)} to ${mmss(start + span)} into the stream; times below are seconds from the window's start. The chat's usual pace here is ${base} messages per 10 s. The proposed cut is L${lines[cut.s]?.i ?? 0} to L${lines[cut.e]?.i ?? 0} (${mmss(lines[cut.s]?.start ?? 0)}-${mmss(lines[cut.e]?.end ?? 0)}). Loudest stretches: ${peaks.map((p) => `${mmss(p.start)} (+${p.db} dB)`).join(", ") || "none"}. Clip length goal: ${len.low}-${len.high} s, never under ${len.min} or over ${len.max}.`;
      const times = [...new Set([lines[cut.s]?.start ?? 0, eventRel, peakRel, (lines[cut.s]?.start ?? 0 + (lines[cut.e]?.end ?? span)) / 2, lines[cut.e]?.end ?? span, Math.min(span - 1, peakRel + 20)].map((t) => Math.round(Math.max(0, Math.min(span - 1, t)))))].sort((a, c) => a - c).slice(0, 6);
      const frames = await stills(pl.video, times.map((t) => start + t), dir, `s${c.rank}`);
      let v: Verdict;
      try { v = await verify({ lines, stills: frames, head, body }); claudeCalls++; }
      catch (err: any) { log(`[live] verify ${c.rank} of ${job.id} failed: ${String(err?.message ?? err).slice(0, 160)}`); continue; }
      const byI = new Map(lines.map((l) => [l.i, l]));
      const ls = byI.get(v.start_line), le = byI.get(v.end_line);
      const relStart = ls ? ls.start : lines[cut.s]?.start ?? 0, relEnd = le ? le.end : lines[cut.e]?.end ?? 0;
      let a = relStart, z = relEnd;
      for (const ev of heard.events) if (/laugh|applause|cheer/i.test(ev.text) && ev.start >= z - 0.6 && ev.start <= z + 1.5) z = Math.max(z, Math.min(ev.end + 0.35, a + len.max));
      // the model's cut under the length's floor grows to the next closing thoughts (then earlier opening ones),
      // never past the ceiling: a 16 s clip of a 30 s moment was kept on Nov 18 2026 before this
      const closesAfter = (t: number) => lines.find((l) => l.start >= t - 0.05 && l.closes && l.end - a <= len.max);
      for (let guard = 0; z - a < len.min && guard < 6; guard++) { const n = closesAfter(z + 0.05); if (!n) break; z = n.end; }
      for (let guard = 0; z - a < len.min && guard < 6; guard++) { const prev = [...lines].reverse().find((l) => l.end <= a + 0.05 && l.opens && z - l.start <= len.max); if (!prev) break; a = prev.start; }
      const d = z - a;
      const keep = v.keep && v.standalone && v.score >= bar && d >= len.min && d <= len.max + 3;
      log(`[live] moment ${JSON.stringify({ job: job.id, rank: c.rank, t: c.t_event, score: v.score, keep, cut: [round2(start + a), round2(start + z)], title: v.title.slice(0, 60), why_not: keep ? undefined : v.why_not.slice(0, 80) || (d < len.min - 3 ? "too short" : d > len.max + 3 ? "too long" : "under the bar") })}`);
      if (!keep) continue;
      const absStart = round2(start + a), absEnd = round2(start + z);
      if (kept.some((k) => Math.min(k.end, absEnd) - Math.max(k.start, absStart) > 0.25 * Math.min(k.end - k.start, absEnd - absStart))) continue;
      const inside = heard.words.filter((w) => w.end > a && w.start < z);
      kept.push({ rank: kept.length + 1, start: absStart, end: absEnd, title: clean(v.title, 80) || `Moment ${kept.length + 1}`, hook: clean(v.hook, 140), why: clean(v.why, 120), score: Math.min(100, Math.round(v.score)), tags: v.tags.map((x) => clean(x, 24).toLowerCase()).filter(Boolean).slice(0, 3), transcript: inside.map((w) => w.text).join(" ").slice(0, 2000),
        speech: inside.length ? speechOf(inside.map((w) => ({ ...w, start: w.start + start, end: w.end + start }))) : undefined,
        words: inside.map((w) => [w.text, round2(w.start + start), round2(w.end + start), w.speaker ?? null] as [string, number, number, string | null]) });
    }
    timing.listen_s = Math.round((Date.now() - tListen) / 1000); timing.checked = checked; timing.heard = heardOk; timing.verify_calls = claudeCalls;
    if (!kept.length) throw new ClipsError("clips_none_found", checked ? `The chat lit up ${checked} times, but none of those moments stands alone as a clip` : "No moment in this stream stands out enough to be a clip", 422);
    kept.sort((x, y) => y.score - x.score || x.start - y.start); kept.forEach((m, k) => { m.rank = k + 1; });
    // C. the cuts: each moment's stretch fetched from the recording, then the Clips cutter
    const todo = kept.filter((m) => !made.some((x) => x.rank === m.rank));
    await renew(sb, job, { collection_id: collectionId, stage: "cutting", done: made.length, total: kept.length, message: `Cutting clip ${Math.min(made.length + 1, kept.length)} of ${kept.length}`, made });
    const tCut = Date.now(); const cutTimes: Array<[number, number]> = [];
    // no burned-in credit (the owner, Nov 18 2026: nobody in the market marks the streamer on the clip); the source
    // link and channel stay on the collection, and attributionFilter stays for anyone who wants it back
    const ctxBase: CutCtx = { sb, deps, u, dir, src: { video: "", audio: null, proxy: null, width: 0, height: 0, fps: null }, format, collectionId, sourceTitle: b.title || null, jobId: job.id, length, captions: o.captions ? (await import("./studio-caption-video.js")).cleanSettings(o.captions) : null, overlay: null };
    const stretchOf = deps.fetchStretch ?? fetchStretchCopy;
    const skipped: number[] = [];
    // the layout is looked at once per clip, on a still from its own stretch: the first live runs (Nov 18 2026) looked
    // once per run and three Rainbow Six clips wore the chess scene's camera box, a slice of the game where the face was
    const asLayout = (r: Layout | FacecamBox | null): Layout => (r && "cam" in r ? r : { cam: r as FacecamBox | null, content: null });
    for (const m of todo) {
      if (job.signal?.aborted) throw new ClipsError("lease_lost", "lease lost");
      const from = Math.max(0, m.start - 2), file = join(dir, `st${m.rank}.mp4`);
      const tc = Date.now();
      try {
        await stretchOf(pl.video, from, m.end + 2 - from, file);
        const src: SourceInput = { video: file, audio: null, proxy: null, width: 0, height: 0, fps: null, offset: from };
        // framing: "person" = Clips' own; "stacked" or "auto" = the facecam on top when one is found on the stretch
        let layout: CutCtx["layout"] = null;
        if (format === "vertical" && framingOf(st.framing) !== "person") {
          const still = (await stills(file, [Math.max(0.5, (m.start - from) + (m.end - m.start) / 2)], dir, `fc${m.rank}`))[0];
          const lay = still ? asLayout(await (deps.facecam ?? ((jpg) => findLayout(deps, jpg, u)))(still.jpg).catch(() => null)) : { cam: null, content: null };
          log(`[live] layout ${JSON.stringify({ job: job.id, rank: m.rank, cam: lay.cam, content: lay.content })}`);
          if (lay.cam) { const { cam, content } = lay; layout = (info) => stackedFilter(info, cam, content); }
        }
        const r = await (deps.cut ?? cutClip)({ ...ctxBase, src, layout }, m);
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
      : made.length < asked ? `The chat pointed at ${checked} moments and ${word(made.length)} stood alone as clips, of the ${asked} you asked for. You were charged for ${word(made.length)}; the rest went back.` : null;
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
let discovery: { at: number; streams: Array<LiveStream & { niche: string; permission: Permission }> } | null = null;
export async function discoverStreams(deps: LiveDeps, env: Record<string, string | undefined>): Promise<Array<LiveStream & { niche: string; permission: Permission }>> {
  if (discovery && Date.now() - discovery.at < 120_000) return discovery.streams;
  const [tw, kk] = await Promise.all([twitchTopStreams(deps, 100).catch(() => [] as LiveStream[]), kickTopStreams(deps, 100).catch(() => [] as LiveStream[])]);
  const streams = [...tw, ...kk].map((s) => ({ ...s, niche: nicheOf(s.category), permission: streamerPermission(s.platform, s.login, env) })).filter((s) => s.permission !== "blocked").sort((a, b) => b.viewers - a.viewers);
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
  app.get("/api/studio/live/streams", async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const streams = await discoverStreams(deps, env);
      const niche = typeof req.query.niche === "string" && NICHES.some((n) => n.id === req.query.niche) ? req.query.niche : null;
      const platform = req.query.platform === "twitch" || req.query.platform === "kick" ? req.query.platform : null;
      res.json({ niches: NICHES.map((n) => ({ id: n.id, label: n.label, live: streams.filter((s) => s.niche === n.id).length })), streams: streams.filter((s) => (!niche || s.niche === niche) && (!platform || s.platform === platform)).slice(0, 60), fresh_at: new Date(discovery?.at ?? Date.now()).toISOString(), open: liveClipsOpen(env) });
    } catch (err) { fail(res, err); }
  });
  app.get("/api/studio/live/lookup", async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const link = parseStreamLink(req.query.url);
      if (!link) throw new ClipsError("unsupported_link", "Paste a Twitch or Kick link: a channel, or one of its past broadcasts");
      if (link.kind === "vod") { const b = await resolveBroadcast(deps, link.url); return res.json({ platform: b.platform, channel: { login: b.login, channel: b.channel, channel_id: b.channel_id, url: b.platform === "twitch" ? `https://www.twitch.tv/${b.login}` : `https://kick.com/${b.login}`, permission: streamerPermission(b.platform, b.login, env) }, broadcasts: [b] }); }
      if (link.platform === "twitch") {
        const user = await twitchUser(deps, link.login!);
        if (!user) throw new ClipsError("link_no_media", "No Twitch channel has that name", 404);
        const permission = streamerPermission("twitch", user.login, env);
        if (permission === "blocked") throw new ClipsError("streamer_blocked", `${user.display_name} has asked not to be clipped on Clone8`, 403);
        const list = await twitchBroadcasts(deps, user.id, 20);
        return res.json({ platform: "twitch", channel: { login: user.login, channel: user.display_name, channel_id: user.id, url: `https://www.twitch.tv/${user.login}`, profile_image_url: user.profile_image_url, permission }, broadcasts: list.filter((b) => b.seconds >= LIVE_LIMITS.min_seconds) });
      }
      const ch = await kickChannel(deps, link.login!);
      const permission = streamerPermission("kick", ch.slug, env);
      if (permission === "blocked") throw new ClipsError("streamer_blocked", `${ch.channel} has asked not to be clipped on Clone8`, 403);
      const list = await kickBroadcasts(deps, ch.slug, ch);
      return res.json({ platform: "kick", channel: { login: ch.slug, channel: ch.channel, channel_id: ch.chat_id, url: `https://kick.com/${ch.slug}`, profile_image_url: ch.profile_image_url, permission, live: ch.live, viewers: ch.viewers, title: ch.title, category: ch.category }, broadcasts: list.filter((b) => b.seconds >= LIVE_LIMITS.min_seconds).slice(0, 20) });
    } catch (err) { fail(res, err); }
  });
}
