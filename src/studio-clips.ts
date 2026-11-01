// Clone8 Studio: Clips. A long video in (a YouTube link up to 3 hours, or an upload up to 4 GB), the moments that stand
// out, each a ready library video framed on whoever is talking.
//
// How a run finds and cuts them:
//  - The whole video is read once (YouTube through yt-dlp and our proxy; uploads through a signed address). Its sound
//    goes to speech-to-text with a time and a speaker for every word, and the sounds that are not speech (laughter,
//    applause, cheering). The loudness of every second is measured too, so shouting, hype and crowd reactions show.
//  - Claude Opus reads the transcript with those signals (and YouTube's chapters and "most replayed" peaks) and picks the
//    moments a stranger would stop scrolling for, as many as the person asked for at most, and only strong ones.
//  - Each cut starts where a thought starts and ends where one ends, after the payoff and any laugh or applause it
//    earned, never as the speaker carries on. The length is a goal: a great moment runs a little shorter or longer.
//    The "1 min+" length is the exception: TikTok pays only for videos over a minute, so those never run under 61 s.
//  - Framing: a still every second goes to a vision model (Haiku; STUDIO_CLIPS_FRAME_MODEL) with the words and speakers; it says who is
//    talking and where their face is. The crop follows them (a pan as they walk, a cut when another person speaks) and
//    shows the whole picture (on a blurred fill) when nobody is there to frame: slides, a game, a wide room.
//  - Price: reading the video (by its length) plus a price per clip, reserved for the clips asked for. A run is charged
//    for the clips it makes; what it does not make goes back. About 2-2.5x OpusClip per video (CLIP_RATES), with
//    safety nets so a vendor price change can never sell a run at a loss.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditValueFloor, logClaudeCost, OVERHEAD, type PlanLike } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import { transcribeWords, type AudioEvent, type TimedWord } from "./studio-eleven.js";
import { youtubeAudio, youtubeDownload, youtubeId, LinkError } from "./studio-youtube.js";
import { checkUpload } from "./studio-limits.js";

// ---------------------------------------------------------------------------------------------------
// Rules and prices
// ---------------------------------------------------------------------------------------------------
/** Clip lengths in seconds. `low`-`high` is the goal the chooser aims for; `min`-`max` is never crossed. "minute" is
 *  for TikTok's Creator Rewards (videos over one minute only): never under 61 s, as close to it as the moment allows. */
export const CLIP_LENGTHS = {
  short: { min: 12, low: 15, target: 22, high: 30, max: 40, label: "Short" },
  standard: { min: 18, low: 24, target: 32, high: 45, max: 55, label: "About 30 s" },
  long: { min: 40, low: 45, target: 60, high: 90, max: 100, label: "Long" },
  minute: { min: 61, low: 61, target: 64, high: 70, max: 78, label: "1 min+" },
} as const;
export type ClipLength = keyof typeof CLIP_LENGTHS;
export type ClipFormat = "vertical" | "original";
export const CLIP_LIMITS = { min_source: 120, max_source: 3 * 3600, max_clips: 50, min_score: 60 };
/** A video only Clips takes: over 10 minutes or 512 MB. Every other tool reads its source whole. */
export const LONG_SOURCE = { seconds: 600, bytes: 536_870_912 };
export const isLongSource = (a: { bytes?: number | null; probe?: any } | null | undefined): boolean =>
  !!a && (Number(a.bytes) > LONG_SOURCE.bytes || Number(a.probe?.duration) > LONG_SOURCE.seconds || a.probe?.long_source === true);

/** What a run costs us, at list prices (the vendors' discounts stay our margin). */
export const CLIP_COST = {
  transcribe_usd_per_hour: 0.22,          // ElevenLabs scribe_v1 with word times, speakers and sound events
  choose_usd_per_hour: 0.5,               // Claude Opus over the transcript and its signals, high effort; kept wide
  render_usd_per_clip: 0.004,             // web-service CPU and the stored file
  lookup_usd: 2 * OVERHEAD.scrapecreators_usd_per_call,
  // the whole video comes through the proxy once (the smallest 1080p version): a TED talk measured 96 kB/s in H.264 and
  // 105 kB/s in VP9 on Render (Oct 31 2026), kept at 105; 720p for videos over an hour, about 55%
  full_bytes_per_second: 105_000, full_bytes_per_second_long: 60_000, long_after_seconds: 3600,
  clip_bytes_per_second: 200_000,         // a short 1080p video with sound (imports): measured 133-166 kB/s, kept with margin
};
export const FRAME_MODEL = "claude-haiku-5-5";
/** Framing, per second of clip: one still a second plus the words to the framing model (~250 tokens a still). */
export function frameUsdPerSecond(env: Record<string, string | undefined> = process.env): number {
  const m = String(env.STUDIO_CLIPS_FRAME_MODEL || FRAME_MODEL);
  return m.includes("opus") ? 0.0018 : m.includes("sonnet") ? 0.0009 : 0.0001;
}
/** The price (owner's decision, Oct 31 2026: about 2-2.5x OpusClip per video, which bills $0.10 a minute of video):
 *  reading the video by the minute, and each clip. Safety nets: never under 35% margin on reading and 50% on a clip at
 *  the cheapest credit we sell, whatever the vendors charge. */
export const CLIP_RATES = { youtube_per_minute: 5, upload_per_minute: 2, lite_per_minute: 1, analysis_min: 10, lite_min: 5,
  per_clip: { short: 5, standard: 5, long: 8, minute: 8 } as Record<ClipLength, number> };
export const CLIPS_SAFETY_MARGIN = { analysis: 0.35, clip: 0.5 };
/** What the proxy charges per GB (0 without one: then YouTube refuses us and nothing is read through it). */
export const proxyUsdPerGb = (env: Record<string, string | undefined>) => (env.STUDIO_YT_PROXY ? (Number(env.STUDIO_YT_PROXY_USD_PER_GB) > 0 ? Number(env.STUDIO_YT_PROXY_USD_PER_GB) : 3) : 0);
/** About how many strong clips of a length a video holds: one per 70 s of video, or per two clips' worth for long ones. */
export function likelyClips(seconds: number, length: ClipLength): number {
  return Math.max(1, Math.min(CLIP_LIMITS.max_clips, Math.round(seconds / Math.max(70, CLIP_LENGTHS[length].target * 2.2))));
}
/** The most clips a run will try for: one per clip-length of video (they never overlap), at most 50. */
export function countCap(seconds: number, length: ClipLength): number {
  return Math.max(1, Math.min(CLIP_LIMITS.max_clips, Math.floor(seconds / CLIP_LENGTHS[length].target)));
}
/** Reading the video, in dollars: the download through the proxy (YouTube), speech-to-text, the choosing. */
export function analysisUsd(p: { seconds: number; platform: "youtube" | "upload"; download: boolean; transcribe: boolean; choose: boolean; env: Record<string, string | undefined> }): number {
  const hours = p.seconds / 3600;
  let usd = 0;
  if (p.choose) usd += hours * CLIP_COST.choose_usd_per_hour;
  if (p.transcribe) usd += hours * CLIP_COST.transcribe_usd_per_hour;
  if (p.platform === "youtube") usd += CLIP_COST.lookup_usd + (p.download ? (p.seconds * (p.seconds > CLIP_COST.long_after_seconds ? CLIP_COST.full_bytes_per_second_long : CLIP_COST.full_bytes_per_second) / 1e9) * proxyUsdPerGb(p.env) : 0);
  return usd;
}
/** One clip, in dollars: framing at its goal's upper end, rendering and storing. */
export const perClipUsd = (length: ClipLength, env: Record<string, string | undefined> = process.env) => frameUsdPerSecond(env) * CLIP_LENGTHS[length].high + CLIP_COST.render_usd_per_clip;
const credits = (usd: number, floor: number, margin: number) => Math.ceil(usd / ((1 - margin) * floor) - 1e-9);
/** A run's price: `analysis` once (reading the video), `per_clip` for each clip made; `lite` is reading without the
 *  download (YouTube refused our servers: the moments are chosen from YouTube's captions and the file is asked for). */
export type ClipsPrice = { analysis: number; per_clip: number; lite: number };
export function clipsPrice(plans: PlanLike[], p: { seconds: number; platform: "youtube" | "upload"; length: ClipLength; env: Record<string, string | undefined>; download?: boolean }): ClipsPrice {
  const floor = creditValueFloor(plans), minutes = Math.max(1, Math.ceil(p.seconds / 60));
  const download = p.platform === "youtube" && p.download !== false;
  const transcribe = p.platform === "upload" || !!p.env.ELEVENLABS_API_KEY;
  const usd = analysisUsd({ seconds: p.seconds, platform: p.platform, download, transcribe: transcribe && (p.platform === "upload" || download), choose: true, env: p.env });
  const lite = analysisUsd({ seconds: p.seconds, platform: p.platform, download: false, transcribe: false, choose: true, env: p.env });
  const rate = p.platform === "youtube" && download ? CLIP_RATES.youtube_per_minute : p.platform === "youtube" ? CLIP_RATES.lite_per_minute : CLIP_RATES.upload_per_minute;
  return {
    analysis: Math.max(minutes * rate, credits(usd, floor, CLIPS_SAFETY_MARGIN.analysis), CLIP_RATES.analysis_min),
    per_clip: Math.max(CLIP_RATES.per_clip[p.length], credits(perClipUsd(p.length, p.env), floor, CLIPS_SAFETY_MARGIN.clip)),
    lite: Math.max(minutes * CLIP_RATES.lite_per_minute, credits(lite, floor, CLIPS_SAFETY_MARGIN.analysis), CLIP_RATES.lite_min),
  };
}
/** What a run is charged: reading once (unless it only cuts moments chosen earlier) and each clip made. */
export const clipsCharge = (price: ClipsPrice, made: number, o: { analysis?: boolean } = {}) => (o.analysis === false ? 0 : price.analysis) + price.per_clip * Math.max(0, made);

// ---------------------------------------------------------------------------------------------------
// How long a run takes: learned from the runs before it, so the page can say "ready in about 12 minutes"
// ---------------------------------------------------------------------------------------------------
/** Seconds per stage, as rates: fetching and listening scale with the video's length; choosing has a fixed part plus a
 *  part per second of video; cutting has a fixed part per clip plus a part per second of clip (framing, rendering). */
export type ClipTiming = { fetch_per_s: number; listen_per_s: number; choose_base: number; choose_per_s: number; cut_base: number; cut_per_s: number; runs: number };
/** Before any run is measured: the Oct 31 2026 TED run (844 s: fetched in 60 s, heard and chosen in 44 s, ~75 s a clip). */
export const DEFAULT_TIMING: ClipTiming = { fetch_per_s: 0.08, listen_per_s: 0.025, choose_base: 25, choose_per_s: 0.02, cut_base: 15, cut_per_s: 1.6, runs: 0 };
const median = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
/** The timing model from recorded runs (each run's own rates, the median of each); the default fills what is missing. */
export function timingFrom(runs: Array<Record<string, any>>): ClipTiming {
  const t = runs.map((r) => r?.timing).filter((x) => x && Number(x.video_s) > 0);
  if (!t.length) return DEFAULT_TIMING;
  const pick = (vals: number[], fallback: number) => { const m = median(vals); return Number.isFinite(m) ? m : fallback; };
  const fetch = pick(t.filter((x) => x.fetch_s > 0).map((x) => x.fetch_s / x.video_s), DEFAULT_TIMING.fetch_per_s);
  const listen = pick(t.filter((x) => x.listen_s > 0).map((x) => x.listen_s / x.video_s), DEFAULT_TIMING.listen_per_s);
  // choosing: the fixed part stays at the default; the rest scales with the video
  const choose = pick(t.filter((x) => x.choose_s > 0).map((x) => Math.max(0, x.choose_s - DEFAULT_TIMING.choose_base) / x.video_s), DEFAULT_TIMING.choose_per_s);
  // cutting: per second of clip made, after each clip's fixed part
  const cut = pick(t.filter((x) => x.cut_s > 0 && x.clip_s > 0 && x.clips > 0).map((x) => Math.max(0.3, (x.cut_s - x.clips * DEFAULT_TIMING.cut_base) / x.clip_s)), DEFAULT_TIMING.cut_per_s);
  return { fetch_per_s: fetch, listen_per_s: listen, choose_base: DEFAULT_TIMING.choose_base, choose_per_s: choose, cut_base: DEFAULT_TIMING.cut_base, cut_per_s: cut, runs: t.length };
}
let timingCache: { at: number; timing: ClipTiming } | null = null;
/** The current model: the last 30 finished runs, read at most every 10 minutes. */
export async function clipsTiming(sb: SupabaseClient): Promise<ClipTiming> {
  if (timingCache && Date.now() - timingCache.at < 10 * 60_000) return timingCache.timing;
  const r = await sb.from("studio_events").select("props").eq("kind", "feature").eq("name", "clips_done").order("created_at", { ascending: false }).limit(30);
  const timing = r.error ? DEFAULT_TIMING : timingFrom(((r.data ?? []) as any[]).map((x) => x.props ?? {}));
  timingCache = { at: Date.now(), timing };
  return timing;
}
export const resetClipsTiming = () => { timingCache = null; };
type EtaJob = { options: any; progress?: any; status?: string };
/** Seconds a run still needs, from where it is (a queued run needs all of it). Each stage's own clock (`stage_at`) takes
 *  off what has already passed; a cut in progress uses the clips already made when there are some. */
export function remainingSeconds(job: EtaJob, timing: ClipTiming, now = Date.now()): number {
  const o = job.options ?? {}, p = job.progress ?? {};
  const video = Math.max(60, Number(o.seconds) || Number(o.source?.seconds) || 600);
  const length = lengthOf(o.length);
  const youtube = o.platform === "youtube" && !o.plan_from;
  const planned = Math.max(1, Number(p.total) || Number(o.count ?? o.max_clips) || likelyClips(video, length));
  const perClip = timing.cut_base + timing.cut_per_s * CLIP_LENGTHS[length].target;
  const stages: Array<[string, number]> = [
    ["reading", youtube ? timing.fetch_per_s * video : 3],
    ["transcribing", o.plan_from ? 0 : timing.listen_per_s * video + 5],
    ["choosing", o.plan_from ? 0 : timing.choose_base + timing.choose_per_s * video],
    ["cutting", planned * perClip],
  ];
  if (job.status === "queued" || !p.stage) return Math.round(stages.reduce((a, [, s]) => a + s, 0));
  const at = stages.findIndex(([name]) => name === p.stage);
  if (at < 0) return 0;
  const since = p.stage_at ? Math.max(0, (now - Date.parse(p.stage_at)) / 1000) : 0;
  let left = stages.slice(at + 1).reduce((a, [, s]) => a + s, 0);
  if (p.stage === "cutting") {
    const done = Number(p.done) || 0, total = Number(p.total) || planned;
    // measured on this run once a clip is made: the time per clip so far
    const rate = done > 0 && since > 0 ? since / done : perClip;
    left += Math.max(0, total - done) * rate - (done > 0 ? 0 : Math.min(since, perClip * 0.9));
    if (done > 0 && p.clip_at) left -= Math.min(rate * 0.9, Math.max(0, (now - Date.parse(p.clip_at)) / 1000));
  } else left += Math.max(stages[at][1] * 0.1, stages[at][1] - since);
  return Math.max(10, Math.round(left));
}
/** Every clips run waiting or working, in the order the servers take them: running first, then queued by age. */
export async function clipsQueue(sb: SupabaseClient): Promise<Array<{ id: string; status: string; created_at: string; options: any; progress: any }>> {
  const r = await sb.from("studio_jobs").select("id,status,created_at,options,progress").eq("tool", "clips").in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(200);
  if (r.error) throw r.error;
  const rows = (r.data ?? []) as any[];
  return [...rows.filter((x) => x.status === "running"), ...rows.filter((x) => x.status === "queued")];
}
/** How long until a run is done (seconds) and how many runs are ahead of it. Runs are cut one at a time per server, so
 *  a queued run waits for the ones ahead. `servers` is how many run side by side (STUDIO_CLIPS_SERVERS, default 1). */
export function etaFor(target: { id?: string | null; options: any; progress?: any; status?: string }, queue: Array<{ id: string; status: string; options: any; progress: any }>, timing: ClipTiming, servers = 1, now = Date.now()): { seconds: number; ahead: number } {
  const idx = target.id ? queue.findIndex((q) => q.id === target.id) : -1;
  const own = remainingSeconds(target, timing, now);
  if (target.status === "running") return { seconds: own, ahead: 0 };
  const before = idx >= 0 ? queue.slice(0, idx) : queue;
  // with n servers the wait is roughly the work ahead shared between them; the runs already running count first
  const wait = before.reduce((a, q) => a + remainingSeconds(q, timing, now), 0) / Math.max(1, servers);
  const ahead = Math.max(0, before.length - (servers - 1));
  return { seconds: Math.round((ahead > 0 ? wait : 0) + own), ahead };
}
export const clipsServers = (env: Record<string, string | undefined> = process.env) => Math.max(1, Math.min(10, Number(env.STUDIO_CLIPS_SERVERS) || 1));

export class ClipsError extends Error { constructor(public code: string, message: string, public status = 400, public retry = false) { super(message); } }

// ---------------------------------------------------------------------------------------------------
// YouTube through ScrapeCreators: listing, transcript, chapters, most replayed
// ---------------------------------------------------------------------------------------------------
export type YtMeta = { id: string | null; url: string; title: string | null; channel: string | null; description: string; seconds: number | null; thumbnail_url: string | null;
  chapters: Array<{ title: string; start: number }>; replay: Array<{ start: number; end: number; score: number }> };
export type Segment = { start: number; end: number; text: string };
export type ClipsDeps = {
  env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (l: string) => void; plans?: PlanLike[];
  meta?: (url: string) => Promise<YtMeta>;
  transcript?: (url: string) => Promise<Segment[] | null>;
  /** speech-to-text: the words (with speakers), and the sounds that are not speech when the service gives them */
  words?: (audio: Buffer) => Promise<TimedWord[] | { words: TimedWord[]; events: AudioEvent[] }>;
  loudness?: (audio: string, dir: string) => Promise<number[]>;
  extractAudio?: (input: SourceInput, target: string) => Promise<void>;
  choose?: (input: ChooseInput) => Promise<RawMoment[]>;
  cut?: (ctx: CutCtx, m: Moment) => Promise<CutResult>;
  frame?: (input: TrackInput) => Promise<TrackRead[]>;
  download?: (url: string, target: string, maxHeight: number) => Promise<void>;
  ytAudio?: (url: string, target: string) => Promise<void>;
};
const metaCache = new Map<string, { at: number; meta: YtMeta }>();
async function sc(deps: ClipsDeps, path: string): Promise<any> {
  const env = deps.env ?? process.env, key = env.SCRAPECREATORS_API_KEY;
  if (!key) throw new ClipsError("clips_unavailable", "Reading YouTube is not configured", 503);
  const r = await (deps.fetch ?? fetch)(`https://api.scrapecreators.com${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(90_000) }).catch(() => null);
  recordEvent({ kind: "vendor", name: "scrapecreators", usd: OVERHEAD.scrapecreators_usd_per_call, props: { path: path.split("?")[0], status: r?.status ?? 0, use: "clips" } });
  if (!r) throw new ClipsError("link_fetch_failed", "YouTube's listing could not be read; try again", 502, true);
  if (r.status === 403) throw new ClipsError("link_no_media", "That video cannot be read (age-restricted or private)", 400);
  if (r.status === 404) throw new ClipsError("link_no_media", "No video was found at that link", 400);
  if (!r.ok) throw new ClipsError("link_fetch_failed", `YouTube's listing could not be read (${r.status})`, 502, r.status >= 500 || r.status === 429);
  return r.json().catch(() => null);
}
/** Seconds from "1:02:03", "12:30" or "45". */
export const clockSeconds = (s: string): number => String(s ?? "").split(":").map(Number).reduce((a, b) => a * 60 + (Number.isFinite(b) ? b : 0), 0);
export function parseMeta(url: string, b: any): YtMeta {
  const ms = Number(b?.durationMs ?? (Number(b?.lengthSeconds) * 1000));
  const chapters = (Array.isArray(b?.chapters) ? b.chapters : []).map((c: any) => ({ title: String(c?.title ?? "").slice(0, 80), start: Number.isFinite(Number(c?.startSeconds)) ? Number(c.startSeconds) : clockSeconds(c?.timeDescription) })).filter((c: any) => c.title);
  const markers = Array.isArray(b?.most_replayed?.markers) ? b.most_replayed.markers : [];
  const replay = markers.map((m: any) => ({ start: Number(m?.startMillis) / 1000, end: (Number(m?.startMillis) + Number(m?.durationMillis)) / 1000, score: Number(m?.intensityScoreNormalized) }))
    .filter((m: any) => Number.isFinite(m.start) && Number.isFinite(m.end) && Number.isFinite(m.score));
  return {
    id: youtubeId(url), url, title: b?.title ? String(b.title).slice(0, 160) : null,
    channel: String(b?.channel?.title ?? b?.channel?.handle ?? b?.uploader ?? "").slice(0, 80) || null,
    description: String(b?.description ?? "").slice(0, 1200),
    seconds: ms > 0 ? Math.round(ms / 1000) : null,
    thumbnail_url: typeof b?.thumbnail === "string" ? b.thumbnail : null,
    chapters, replay,
  };
}
export async function youtubeMeta(deps: ClipsDeps, url: string): Promise<YtMeta> {
  const id = youtubeId(url) ?? url;
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.meta;
  const body = await sc(deps, `/v1/youtube/video?url=${encodeURIComponent(url)}&cache_max_age=1d`);
  const meta = parseMeta(url, body);
  metaCache.set(id, { at: Date.now(), meta });
  if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value as string);
  return meta;
}
export function parseTranscript(b: any): Segment[] | null {
  const t = Array.isArray(b?.transcript) ? b.transcript : null;
  if (!t || !t.length) return null;
  const segs = t.map((s: any) => ({ start: Number(s?.startMs) / 1000, end: Number(s?.endMs) / 1000, text: String(s?.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((s: Segment) => Number.isFinite(s.start) && s.text);
  return segs.length ? segs : null;
}
async function youtubeTranscript(deps: ClipsDeps, url: string): Promise<Segment[] | null> {
  return parseTranscript(await sc(deps, `/v1/youtube/video/transcript?url=${encodeURIComponent(url)}&cache_max_age=7d`));
}

// ---------------------------------------------------------------------------------------------------
// The transcript as numbered lines (a sentence or a breath each), the unit Claude picks by
// ---------------------------------------------------------------------------------------------------
/** A line of the transcript. `opens`/`closes`: whether a clip may start or end on it (a thought starts or ends there). */
export type Line = { i: number; start: number; end: number; text: string; w0?: number; w1?: number; speaker?: string | null;
  opens?: boolean; closes?: boolean; events?: string[]; loud?: number };
const MAX_LINE_WORDS = 28;
const SENTENCE_END = /[.?!…]["')\]]?$/;
/** Caption segments (YouTube) into lines: joined until a sentence ends, a pause, or about 14 words. Auto-captions
 *  overlap in time, so a segment ends where the next begins. */
export function linesFromSegments(segs: Segment[], maxWords = 14): Line[] {
  const out: Line[] = [];
  let cur: { start: number; end: number; parts: string[]; words: number } | null = null;
  const flush = (gap: number) => {
    if (cur && cur.parts.length) {
      const text = cur.parts.join(" ");
      const prev = out[out.length - 1];
      out.push({ i: out.length, start: cur.start, end: cur.end, text, opens: !prev || !!prev.closes, closes: SENTENCE_END.test(text) || gap >= 1 });
    }
    cur = null;
  };
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], next = segs[k + 1];
    const end = next ? Math.max(s.start, Math.min(s.end || next.start, next.start)) : (s.end || s.start + 2);
    if (cur && s.start - cur.end > 1.5) flush(s.start - cur.end);
    if (!cur) cur = { start: s.start, end, parts: [], words: 0 };
    cur.parts.push(s.text); cur.end = end; cur.words += s.text.split(/\s+/).length;
    // automatic captions carry no punctuation: short lines keep the cut points close to where a thought turns
    if (SENTENCE_END.test(s.text) ? cur.words >= 6 : cur.words >= maxWords) flush(next ? next.start - end : 9);
  }
  flush(9);
  return out;
}
/** Timed words (speech-to-text) into lines, split at a sentence's end, a pause of 0.7 s, a new speaker, or 28 words.
 *  A line closes a thought when it ends a sentence with a breath (0.25 s) or a new speaker after it; it opens one when
 *  the line before closed one, after a long pause, or on a new speaker. */
export function linesFromWords(words: TimedWord[]): Line[] {
  const out: Line[] = [];
  let a = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k], next = words[k + 1];
    const n = k - a + 1;
    const newSpeaker = !!(next && next.speaker && w.speaker && next.speaker !== w.speaker);
    const gap = next ? next.start - w.end : 9;
    const end = !next || SENTENCE_END.test(w.text) && n >= 4 || gap > 0.7 || newSpeaker || n >= MAX_LINE_WORDS;
    if (end) {
      const prev = out[out.length - 1];
      const prevGap = a > 0 ? words[a].start - words[a - 1].end : 9;
      const prevSpeaker = a > 0 ? words[a - 1].speaker : null;
      out.push({ i: out.length, start: words[a].start, end: w.end, text: words.slice(a, k + 1).map((x) => x.text).join(" ").replace(/\s+([,.?!…])/g, "$1"), w0: a, w1: k, speaker: w.speaker ?? null,
        opens: !prev || !!prev.closes || prevGap >= 0.9 || (!!prevSpeaker && !!words[a].speaker && prevSpeaker !== words[a].speaker),
        closes: !next || (SENTENCE_END.test(w.text) && (gap >= 0.25 || newSpeaker)) || gap >= 0.9 });
      a = k + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Signals: sounds that are not speech (laughter, applause) and loudness (shouting, hype, a crowd)
// ---------------------------------------------------------------------------------------------------
/** The loudness of every second (RMS dB), from the mono sound file: one ffmpeg pass, about a second per hour of audio. */
export async function loudnessTrack(audio: string, dir: string): Promise<number[]> {
  const out = join(dir, "loudness.txt");
  await ffmpeg(["-v", "error", "-nostdin", "-i", audio, "-af", `aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${out}`, "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
  return parseLoudness(await readFile(out, "utf8"));
}
export const parseLoudness = (text: string): number[] => [...text.matchAll(/RMS_level=(-?[0-9.]+|-inf|inf|nan)/gi)].map((m) => { const v = Number(m[1]); return Number.isFinite(v) ? Math.max(-90, v) : -90; });
/** How much louder each second is than the five minutes around it (dB, 0 for silence): mics, rooms and voices differ, so
 *  only the local jump means "something happened". */
export function loudnessExcess(rms: number[]): number[] {
  const n = rms.length, voiced = (v: number) => v > -55;
  const base: number[] = [];
  for (let c = 0; c < n; c += 10) {
    const w = rms.slice(Math.max(0, c - 150), Math.min(n, c + 150)).filter(voiced).sort((x, y) => x - y);
    base.push(w.length ? w[Math.floor(w.length / 2)] : -40);
  }
  return rms.map((v, i) => (voiced(v) ? Math.max(0, v - base[Math.min(base.length - 1, Math.round(i / 10))]) : 0));
}
/** The loudest stretches (8 s each, at least 4 dB over their surroundings), loudest first, never overlapping. */
export function loudPeaks(excess: number[], max = 40): Array<{ start: number; end: number; db: number }> {
  const span = 8, cands: Array<{ start: number; end: number; db: number }> = [];
  for (let s = 0; s + span <= excess.length; s += 2) {
    const db = excess.slice(s, s + span).reduce((a, b) => a + b, 0) / span;
    if (db >= 4) cands.push({ start: s, end: s + span, db: Math.round(db * 10) / 10 });
  }
  cands.sort((a, b) => b.db - a.db);
  const kept: typeof cands = [];
  for (const c of cands) { if (!kept.some((k) => c.start < k.end && k.start < c.end)) kept.push(c); if (kept.length >= max) break; }
  return kept;
}
/** Puts the signals on the lines: each sound event on the line it follows or overlaps, each line's loudness. */
export function annotateLines(lines: Line[], events: AudioEvent[], excess: number[] | null): Line[] {
  const out = lines.map((l) => ({ ...l, events: [] as string[] }));
  for (const e of events) {
    let k = out.findIndex((l, j) => e.start < (out[j + 1]?.start ?? Infinity));
    if (k < 0) k = out.length - 1;
    if (k >= 0 && out[k].events!.length < 3 && !out[k].events!.includes(e.text)) out[k].events!.push(e.text);
  }
  if (excess && excess.length) for (const l of out) {
    const a = Math.max(0, Math.floor(l.start)), b = Math.min(excess.length, Math.ceil(l.end));
    if (b > a) l.loud = Math.round(excess.slice(a, b).reduce((x, y) => x + y, 0) / (b - a));
  }
  return out;
}

const mmss = (s: number) => { const t = Math.max(0, Math.round(s)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
/** Windows of about 40 minutes (with 90 s of overlap so a moment on a seam is seen whole), each one Claude call. */
export function windows(lines: Line[], span = 2400, overlap = 90): Line[][] {
  if (!lines.length) return [];
  const out: Line[][] = [];
  let from = lines[0].start;
  const last = lines[lines.length - 1].end;
  while (from < last) {
    // a short last stretch (under 10 minutes) joins this window rather than costing a call of its own
    const to = last - (from + span) < 600 ? last + 1 : from + span;
    const w = lines.filter((l) => l.end > from && l.start < to);
    if (w.length) out.push(w);
    if (to >= last) break;
    from = to - overlap;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Choosing: Claude reads the transcript with its signals and returns the moments that stand out
// ---------------------------------------------------------------------------------------------------
export type ChooseInput = { lines: Line[]; meta: { title: string | null; channel: string | null; description: string; chapters: YtMeta["chapters"]; replay: YtMeta["replay"] };
  length: ClipLength; wanted: number; peaks?: Array<{ start: number; end: number; db: number }> };
export type RawMoment = { start_line: number; end_line: number; title: string; hook: string; why: string; score: number; tags: string[] };
export const CHOOSE_SYSTEM = `You are the best short-form video editor alive. From a long video (a podcast, interview, talk, stream, vlog, lecture or show) you pull the moments that make a stranger stop scrolling on TikTok, Reels and Shorts. You are bold and picky: a feed is merciless, so a clip must be a highlight, never filler.

What stands out (look for these first):
- Peaks of reaction: the audience laughs, applauds, gasps, cheers, says "ooh" (marked in the transcript like [laughter] or [applause]); a speaker who suddenly gets loud (marked like ⟪+8 dB⟫); for streams and gaming, the hype, the shouting, a win, a fail, a clutch, a rage moment.
- Stretches viewers replayed most on YouTube (listed when known).
- A bold or controversial claim, a hot take, a confession, a surprising number or fact, a strong disagreement.
- A story with a turn and a punchline, a joke that lands, an emotional or vulnerable beat, a reveal, practical advice someone would save or share.

A moment qualifies only if ALL of these hold:
- It stands alone: someone who saw nothing else understands it. No "as I said", no "he" or "it" pointing at something earlier, no setup that happens outside the clip.
- Its first line hooks within 3 seconds: a claim, a question, a number, a conflict, a story's opening. It starts where a thought starts: never on filler ("so", "um", "yeah", "and", "but"), a greeting, or mid-sentence.
- It has a payoff (an answer, a punchline, a lesson, a reveal, an emotional beat) and it ENDS RIGHT AFTER IT: on the line where the payoff lands, plus the line with the laugh or applause it earned. Never end on a line after which the same speaker keeps going with the same thought; never end mid-thought. A clip that ends naturally feels finished.
- It is substantive: not small talk, ads, sponsor reads, housekeeping, intros or outros.

Score 0-100 for how likely it is to hold a stranger: hook 30%, payoff 25%, standout energy or reaction 20%, standalone clarity 15%, novelty 10%. Be strict: 90+ is exceptional, 75 strong, 60 usable. Never return anything under 60. Fewer great clips beat more average ones: return only moments that truly stand out, up to the number asked for.

Length: the goal range is given. It is a goal, not a rule: a great moment may run a little shorter or longer to start and end naturally, but always inside the absolute range. Moments must not overlap. Use the line numbers exactly as given (L12 is line 12); start_line is the clip's first line and end_line its last, inclusive.

For each moment write: title (a specific, curiosity-driven headline under 60 characters, in the video's language, no hashtags, no lies), hook (the first spoken line, quoted or tightened, under 100 characters), why (under 15 words: why it stands out), tags (1 to 3 lowercase topic words).`;
export const CHOOSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["clips"],
  properties: { clips: { type: "array", items: { type: "object", additionalProperties: false, required: ["start_line", "end_line", "title", "hook", "why", "score", "tags"],
    properties: { start_line: { type: "integer" }, end_line: { type: "integer" }, title: { type: "string" }, hook: { type: "string" }, why: { type: "string" }, score: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } } } },
};
/** The length rule in words, for the chooser. */
export function lengthWords(length: ClipLength): string {
  const l = CLIP_LENGTHS[length];
  if (length === "minute") return `Every clip MUST run at least ${l.min} seconds: these are for TikTok's Creator Rewards, which pays only for videos over one minute. Aim for ${l.low} to ${l.high} seconds (as close to ${l.low} as the moment allows), never under ${l.min}, and at most ${l.max} only to finish the payoff. Pick moments that hold attention for a full minute: a story, an argument, a build-up and its payoff.`;
  return `Goal: ${l.low} to ${l.high} seconds (about ${l.target}). Absolute range: ${l.min} to ${l.max} seconds.`;
}
export function chooseMessage(input: ChooseInput): string {
  const from = input.lines[0]?.start ?? 0, to = input.lines[input.lines.length - 1]?.end ?? 0;
  const chapters = input.meta.chapters.filter((c) => c.start >= from - 1 && c.start < to);
  // the heatmap's first bucket is always hot (everyone starts at 0:00); peaks are what viewers went back to
  const replays = input.meta.replay.filter((r) => r.start > 0 && r.end > from && r.start < to && r.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 8);
  const loud = (input.peaks ?? []).filter((p) => p.end > from && p.start < to).slice(0, 12);
  const head = [
    input.meta.title ? `Video: ${input.meta.title}${input.meta.channel ? ` (${input.meta.channel})` : ""}` : null,
    input.meta.description ? `Description: ${input.meta.description.replace(/\s+/g, " ").slice(0, 600)}` : null,
    chapters.length ? `Chapters: ${chapters.map((c) => `${mmss(c.start)} ${c.title}`).join("; ")}` : null,
    replays.length ? `Viewers replayed these stretches most (a strong signal, not a rule): ${replays.map((p) => `${mmss(p.start)}-${mmss(p.end)}`).join(", ")}` : null,
    loud.length ? `Loudest stretches against their surroundings (shouting, cheering, big reactions; a signal, not a rule): ${loud.map((p) => `${mmss(p.start)} (+${Math.round(p.db)} dB)`).join(", ")}` : null,
    `Clip length. ${lengthWords(input.length)}`,
    `This part runs ${mmss(from)} to ${mmss(to)}. Return up to ${input.wanted} moments, only ones that truly stand out.`,
  ].filter(Boolean).join("\n");
  const body = input.lines.map((l) => `L${l.i} [${mmss(l.start)}]${l.speaker ? ` ${l.speaker}:` : ""} ${l.text}${(l.events ?? []).map((e) => ` [${e}]`).join("")}${(l.loud ?? 0) >= 5 ? ` ⟪+${l.loud} dB⟫` : ""}`).join("\n");
  return `${head}\n\nTranscript (Lnn [time] speaker: words):\n${body}`;
}
/** One structured Claude call; 429 and 5xx are retried twice with a pause. */
export async function claudeJson(deps: ClipsDeps, body: Record<string, any>, feature: string, userId?: string): Promise<any> {
  const env = deps.env ?? process.env, key = env.ANTHROPIC_API_KEY;
  if (!key) throw new ClipsError("clips_unavailable", "Choosing clips is not configured", 503);
  for (let attempt = 0; ; attempt++) {
    const r = await (deps.fetch ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(600_000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r && r.ok) {
      const out: any = await r.json();
      logClaudeCost(deps.log, feature, String(out?.model ?? body.model), out?.usage, userId);
      if (out?.stop_reason === "refusal") throw new ClipsError("clips_refused", "The video could not be read for clips", 422);
      const text = (out?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      try { return JSON.parse(text); } catch { throw new ClipsError("clips_choose_failed", "The clip list came back unreadable", 502, true); }
    }
    const status = r?.status ?? 0;
    if (attempt < 2 && (status === 0 || status === 429 || status >= 500)) { await new Promise((res) => setTimeout(res, 4000 * (attempt + 1))); continue; }
    const text = r ? await r.text().catch(() => "") : "no answer";
    throw new ClipsError("clips_choose_failed", `Claude ${status}: ${text.slice(0, 160)}`, 502, status === 0 || status === 429 || status >= 500);
  }
}
async function chooseWithClaude(deps: ClipsDeps, input: ChooseInput, userId?: string): Promise<RawMoment[]> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_CLIPS_MODEL || "claude-opus-5-5", max_tokens: 32000, system: CHOOSE_SYSTEM,
    output_config: { effort: env.STUDIO_CLIPS_EFFORT || "high", format: { type: "json_schema", schema: CHOOSE_SCHEMA } },
    messages: [{ role: "user", content: chooseMessage(input) }],
  }, "clips_choose", userId);
  return Array.isArray(out?.clips) ? out.clips : [];
}

// ---------------------------------------------------------------------------------------------------
// From Claude's picks to clean cuts: where thoughts start and end, inside the length range, no overlaps, best first
// ---------------------------------------------------------------------------------------------------
/** What was said in a clip, by whom and when (absolute seconds), for framing on the speaker. */
export type Speech = [start: number, end: number, speaker: string | null, text: string];
export type Moment = { rank: number; start: number; end: number; title: string; hook: string; why: string; score: number; tags: string[]; transcript: string; speech?: Speech[] };
export function finalizeMoments(raw: RawMoment[], lines: Line[], words: TimedWord[] | null, length: ClipLength, cap: number, minScore = CLIP_LIMITS.min_score, events: AudioEvent[] = []): Moment[] {
  const len = CLIP_LENGTHS[length];
  const L = [...lines].sort((a, b) => a.i - b.i);
  const pos = new Map(L.map((l, k) => [l.i, k]));
  // without punctuation or pauses (some captions) every line may start or end a clip
  const marked = L.some((l) => l.closes);
  const opens = (k: number) => k === 0 || !marked || !!L[k].opens;
  const closes = (k: number) => k === L.length - 1 || !marked || !!L[k].closes;
  const span = (a: number, b: number) => L[b].end - L[a].start;
  /** The cut's times: just before the first word (never into the word before) to just after the last (never into the next),
   *  and on past a laugh or applause that follows the payoff. */
  const times = (s: number, e: number) => {
    let start = L[s].start, end = L[e].end, nextStart = L[e + 1]?.start ?? Infinity;
    if (words && L[s].w0 != null && L[e].w1 != null) {
      const w0 = L[s].w0!, w1 = L[e].w1!;
      const prevEnd = w0 > 0 ? words[w0 - 1].end : 0;
      nextStart = w1 + 1 < words.length ? words[w1 + 1].start : words[w1].end + 1.5;
      start = Math.max(prevEnd + 0.03, words[w0].start - 0.15);
      end = Math.max(words[w1].end, Math.min(nextStart - 0.06, words[w1].end + 0.45));
    } else end = Math.max(end, Math.min(end + 0.25, nextStart - 0.05));
    const last = words && L[e].w1 != null ? words[L[e].w1!].end : L[e].end;
    for (const ev of events) if (ev.start >= last - 0.6 && ev.start <= last + 1.2) end = Math.max(end, Math.min(ev.end + 0.35, nextStart - 0.06, start + len.max));
    return { start: Math.max(0, start), end };
  };
  const cand: Moment[] = [];
  for (const r of raw) {
    const score = Math.round(Number(r?.score));
    if (!(score >= minScore)) continue;
    let s = pos.get(Number(r?.start_line)), e = pos.get(Number(r?.end_line));
    if (s == null || e == null) continue;
    if (e < s) [s, e] = [e, s];
    // 1. start where a thought starts: back over at most two lines
    if (!opens(s)) for (let k = s - 1; k >= Math.max(0, s - 2); k--) if (opens(k) && span(k, e) <= len.max) { s = k; break; }
    // 2. end where a thought ends: on through at most three lines (the speaker finishing), else back to one
    if (!closes(e)) {
      let f = -1;
      for (let k = e + 1; k <= Math.min(L.length - 1, e + 3); k++) if (closes(k) && span(s, k) <= len.max) { f = k; break; }
      if (f < 0) for (let k = e - 1; k > s; k--) if (closes(k) && span(s, k) >= len.min) { f = k; break; }
      if (f >= 0) e = f;
    }
    // 3. the absolute range: too short grows to the next ends of thoughts (then earlier starts); too long is cut back
    while (span(s, e) < len.min) {
      let f = -1;
      for (let k = e + 1; k < L.length && span(s, k) <= len.max; k++) if (closes(k)) { f = k; break; }
      if (f < 0) break;
      e = f;
    }
    if (span(s, e) < len.min) for (let k = s - 1; k >= 0 && span(k, e) <= len.max; k--) if (opens(k) && span(k, e) >= len.min) { s = k; break; }
    if (span(s, e) > len.max) {
      let f = -1;
      for (let k = e - 1; k > s; k--) if (closes(k) && span(s, k) <= len.max && span(s, k) >= len.min) { f = k; break; }
      if (f >= 0) e = f;
      else for (let k = s + 1; k < e; k++) if (opens(k) && span(k, e) <= len.max && span(k, e) >= len.min) { s = k; break; }
    }
    let t = times(s, e);
    // the minute rule is absolute: a clip that would land under it grows to the next end of a thought, or is dropped
    while (t.end - t.start < len.min && length === "minute") {
      let f = -1;
      for (let k = e + 1; k < L.length && span(s, k) <= len.max; k++) if (closes(k)) { f = k; break; }
      if (f < 0) break;
      e = f; t = times(s, e);
    }
    const d = t.end - t.start;
    if (length === "minute" ? d < len.min || d > len.max + 2 : d < len.min - 3 || d > len.max + 3) continue;
    const text = L.slice(s, e + 1).map((l) => l.text).join(" ");
    const speech: Speech[] = words && L[s].w0 != null && L[e].w1 != null ? speechOf(words.slice(L[s].w0!, L[e].w1! + 1)) : L.slice(s, e + 1).map((l) => [round2(l.start), round2(l.end), l.speaker ?? null, l.text.slice(0, 200)]);
    cand.push({ rank: 0, start: round2(t.start), end: round2(t.end), title: clean(r.title, 80) || clean(text, 60), hook: clean(r.hook, 140), why: clean(r.why, 120), score: Math.min(100, score), tags: (Array.isArray(r.tags) ? r.tags : []).map((x) => clean(x, 24).toLowerCase()).filter(Boolean).slice(0, 3), transcript: text.slice(0, 2000), speech });
  }
  cand.sort((a, b) => b.score - a.score || a.start - b.start);
  const kept: Moment[] = [];
  for (const m of cand) {
    const clash = kept.some((k) => Math.min(k.end, m.end) - Math.max(k.start, m.start) > 0.25 * Math.min(k.end - k.start, m.end - m.start));
    if (!clash) kept.push(m);
    if (kept.length >= cap) break;
  }
  return kept.map((m, k) => ({ ...m, rank: k + 1 }));
}
/** Words into short runs of one speaker (up to 12 words), for the framing model. */
function speechOf(words: TimedWord[]): Speech[] {
  const out: Speech[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last[2] === (w.speaker ?? null) && w.start - last[1] < 0.8 && last[3].split(" ").length < 12) { last[1] = round2(w.end); last[3] += ` ${w.text}`; }
    else out.push([round2(w.start), round2(w.end), w.speaker ?? null, w.text]);
  }
  return out;
}
const round2 = (x: number) => Math.round(x * 100) / 100;
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------------------------------------------
// Media: where the source is read from, and the commands
// ---------------------------------------------------------------------------------------------------
/** How ffmpeg reaches the source: one file (an upload's signed address) or YouTube's separate picture and sound. */
export type SourceInput = { video: string; audio: string | null; proxy: string | null; width: number; height: number; fps: number | null };
export function inputArgs(src: SourceInput, start: number | null, seconds: number | null): string[] {
  const seek = (s: number | null) => (s != null && s > 0 ? ["-ss", s.toFixed(3)] : []);
  const net = (u: string) => (/^https?:/.test(u) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"] : []);
  const proxy = src.proxy && /^https?:\/\//.test(src.proxy) ? ["-http_proxy", src.proxy] : [];
  const args = [...seek(start), ...net(src.video), ...proxy, "-i", src.video];
  if (src.audio) args.push(...seek(start), ...net(src.audio), ...proxy, "-i", src.audio);
  if (seconds != null) args.push("-t", seconds.toFixed(3));
  args.push("-map", "0:v:0", "-map", src.audio ? "1:a:0" : "0:a:0?");
  return args;
}
/** ffmpeg at a lower priority than the web server (nice 10), with the tail of its complaints kept for the log. */
export function ffmpeg(args: string[], o: { timeoutMs?: number; proxy?: string | null; bin?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = o.bin ?? "ffmpeg";
    const nice = process.platform === "linux";
    const env = { ...process.env, ...(o.proxy && /^https?:\/\//.test(o.proxy) ? { http_proxy: o.proxy, https_proxy: o.proxy } : {}) };
    const child = nice ? spawn("nice", ["-n", "10", bin, ...args], { stdio: ["ignore", "pipe", "pipe"], env }) : spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let err = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, o.timeoutMs ?? 300_000);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (b) => { err += b.toString(); if (err.length > 200_000) err = err.slice(-100_000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) reject(new ClipsError("clip_media_timeout", "the video took too long to read", 502, true));
      else if (code !== 0) reject(new ClipsError(/403|Forbidden/i.test(err) ? "clip_source_refused" : "clip_media_failed", err.replace(/\s+/g, " ").trim().slice(-300) || "ffmpeg failed", 502, true));
      else resolve(err);
    });
  });
}
async function defaultExtractAudio(src: SourceInput, target: string) {
  // the sound only, mono 16 kHz at 32 kb/s: two hours is 29 MB, plenty for speech-to-text
  const args = ["-v", "error", "-nostdin", "-y", ...(src.audio ? ["-i", src.audio] : ["-i", src.video]), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", target];
  await ffmpeg(args, { timeoutMs: 40 * 60_000, proxy: src.proxy });
}

// ---------------------------------------------------------------------------------------------------
// Framing: who is talking, where their face is, a still every second; the crop follows them
// ---------------------------------------------------------------------------------------------------
export type Layout = "person" | "screen" | "none";
export type TrackRead = { layout: Layout; x: number; speaker_visible: boolean };
export type TrackInput = { frames: Array<{ t: number; jpg: Buffer }>; speech: Speech[]; userId?: string };
export const TRACK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["frames"],
  properties: { frames: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "layout", "x", "speaker_visible"],
    properties: { n: { type: "integer" }, layout: { type: "string", enum: ["person", "screen", "none"] }, x: { type: "number" }, speaker_visible: { type: "boolean" } } } } },
};
export const TRACK_PROMPT = `You are framing a vertical 9:16 crop of a horizontal video. The crop shows about a third of the picture's width and its full height. Above are frames from one clip, a second or so apart, each with its time; below is what is said when, with speaker labels from the audio (S1, S2... are voices, not positions).

For every frame, decide what the crop shows:
- layout "person": centre on a person; x is the horizontal centre of that person's face, from 0 (left edge) to 1 (right edge). Choose the person who is SPEAKING at that frame's time. Work it out from the transcript's times and voices, mouths, gestures, and who the others look at; once you know which person a voice belongs to, keep it for the whole clip. Follow them as they move or walk across the picture: x must be where their face is in THAT frame. If the speaker is not in the frame (a cutaway to a listener or the audience), centre on the most prominent face and set speaker_visible false.
- layout "screen": slides, a screen recording, a game, a chart or text fill the frame and matter more than any face (a streamer's small facecam over gameplay counts as screen).
- layout "none": no person to centre on: an empty set, scenery, a logo, a black frame, or a crowd with no single subject.
Never centre on a wall, a background or empty space. Answer for every frame, in order, using its number.`;
export async function readTrack(deps: ClipsDeps, input: TrackInput): Promise<TrackRead[]> {
  if (!input.frames.length) return [];
  const env = deps.env ?? process.env;
  const said = input.speech.map(([a, b, who, text]) => `${a.toFixed(1)}-${b.toFixed(1)} s ${who ?? "?"}: ${text}`).join("\n").slice(0, 12_000);
  const out = await claudeJson(deps, {
    model: env.STUDIO_CLIPS_FRAME_MODEL || FRAME_MODEL, max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: TRACK_SCHEMA } },
    messages: [{ role: "user", content: [
      ...input.frames.flatMap((f, k) => [{ type: "text", text: `Frame ${k + 1} at ${f.t.toFixed(1)} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
      { type: "text", text: `${TRACK_PROMPT}\n\nWhat is said (seconds from the clip's start):\n${said || "(no speech)"}` },
    ] }],
  }, "clips_frame", input.userId);
  const list: any[] = Array.isArray(out?.frames) ? out.frames : [];
  return input.frames.map((_, k) => {
    const f = list.find((x) => Number(x?.n) === k + 1) ?? list[k];
    const layout: Layout = ["person", "screen", "none"].includes(f?.layout) ? f.layout : "none";
    const x = Number(f?.x);
    return { layout, x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5, speaker_visible: f?.speaker_visible !== false };
  });
}
/** Shots from cut times: short slivers (under 0.8 s) folded into a neighbour, at most `max` shots (the shortest merged). */
export function shotsFrom(cuts: number[], duration: number, max = 8): Array<{ start: number; end: number }> {
  const pts = [0, ...cuts.filter((c) => c > 0.05 && c < duration - 0.05).sort((a, b) => a - b), duration];
  let shots = pts.slice(0, -1).map((s, k) => ({ start: s, end: pts[k + 1] }));
  // a sliver joins the shot after it (it is usually that shot's first frames), or the one before at the end
  const merge = (k: number) => { const j = k + 1 < shots.length ? k + 1 : k - 1; const a = Math.min(k, j), b = Math.max(k, j); shots.splice(a, 2, { start: shots[a].start, end: shots[b].end }); };
  for (let k = 0; k < shots.length && shots.length > 1;) { if (shots[k].end - shots[k].start < 0.8) { merge(k); k = 0; } else k++; }
  while (shots.length > max) { let k = 0; shots.forEach((s, j) => { if (s.end - s.start < shots[k].end - shots[k].start) k = j; }); merge(k); }
  if (!shots.length) shots = [{ start: 0, end: duration }];
  return shots;
}
/** When to look: a still every second (fewer on long clips, at most ~90 in all), plus one just after every camera cut. */
export function sampleTimes(duration: number, cuts: number[], max = 90): number[] {
  const after = cuts.filter((c) => c > 0.1 && c < duration - 0.3).map((c) => c + 0.2);
  const step = Math.max(1, (duration - 0.4) / Math.max(1, max - after.length - 1));
  const regular: number[] = [];
  for (let t = 0.3; t < duration - 0.15; t += step) regular.push(t);
  const all = [...after, ...regular.filter((t) => !after.some((a) => Math.abs(a - t) < 0.4))].sort((a, b) => a - b);
  return all.slice(0, max).map(round2);
}
/** A stretch of the clip's framing: a crop whose centre moves from x0 to x1 (a fraction of the width), or the whole
 *  picture on a blurred fill. */
export type Seg = { start: number; end: number; mode: "crop" | "fit"; x0: number; x1: number };
/** The camera path from what was seen every second. Per shot: the person is followed (a held frame while they stay near
 *  the centre, a pan as they move, a cut when the crop jumps to another person: at the moment the voice changes when it
 *  does); a stretch with nobody to frame shows the whole picture; flickers under 1.5 s are smoothed away. */
export function trackPath(samples: Array<{ t: number } & TrackRead>, cuts: number[], duration: number, switches: number[] = []): Seg[] {
  if (!samples.length) return [{ start: 0, end: duration, mode: "fit", x0: 0.5, x1: 0.5 }];
  const shots = shotsFrom(cuts, duration, 60);
  const out: Seg[] = [];
  for (const shot of shots) {
    let pts = samples.filter((p) => p.t >= shot.start && p.t < shot.end).map((p) => ({ t: p.t, mode: (p.layout === "person" ? "crop" : "fit") as Seg["mode"], x: p.x }));
    if (!pts.length) {
      const near = samples.reduce((a, b) => (Math.abs(b.t - (shot.start + shot.end) / 2) < Math.abs(a.t - (shot.start + shot.end) / 2) ? b : a));
      pts = [{ t: (shot.start + shot.end) / 2, mode: near.layout === "person" ? "crop" : "fit", x: near.x }];
    }
    // a run of one mode shorter than 1.5 s between two runs of the other takes the other
    for (let k = 1; k < pts.length - 1; k++) {
      if (pts[k].mode === pts[k - 1].mode) continue;
      let j = k; while (j + 1 < pts.length && pts[j + 1].mode === pts[k].mode) j++;
      if (j + 1 < pts.length && pts[j + 1].mode === pts[k - 1].mode && pts[j + 1].t - pts[k].t < 1.5) for (let q = k; q <= j; q++) pts[q] = { ...pts[q], mode: pts[k - 1].mode, x: pts[k - 1].x };
    }
    // one odd reading (the wrong face for a second) is outvoted by its neighbours
    const xs = pts.map((p) => p.x);
    for (let k = 1; k < pts.length - 1; k++) if (pts[k - 1].mode === "crop" && pts[k].mode === "crop" && pts[k + 1].mode === "crop") pts[k].x = [xs[k - 1], xs[k], xs[k + 1]].sort((a, b) => a - b)[1];
    // hold still while the face stays near the centre; pan when it moves; cut when it jumps to someone else
    const jump: boolean[] = pts.map(() => false);
    let cam = pts[0].x;
    for (let k = 0; k < pts.length; k++) {
      if (pts[k].mode !== "crop") continue;
      const d = pts[k].x - cam;
      if (k > 0 && pts[k - 1].mode === "crop" && Math.abs(d) > 0.22) jump[k] = true;
      if (Math.abs(d) < 0.05 && k > 0 && pts[k - 1].mode === "crop") pts[k].x = cam; else cam = pts[k].x;
    }
    const hold = (a: number, b: number, p: { mode: Seg["mode"]; x: number }) => { if (b - a > 0.001) out.push({ start: a, end: b, mode: p.mode, x0: p.x, x1: p.x }); };
    hold(shot.start, pts[0].t, pts[0]);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      if (p.mode === "crop" && q.mode === "crop" && !jump[k + 1]) { out.push({ start: p.t, end: q.t, mode: "crop", x0: p.x, x1: q.x }); continue; }
      // a change of person or of mode: at the moment the voice changes, if it does between the two looks
      const sw = switches.find((t) => t > p.t + 0.05 && t < q.t - 0.05);
      const at = sw ?? (p.t + q.t) / 2;
      hold(p.t, at, p); hold(at, q.t, q);
    }
    hold(pts[pts.length - 1].t, shot.end, pts[pts.length - 1]);
  }
  // join neighbours that are one held frame, and drop the points a straight pan passes through anyway
  const merged: Seg[] = [];
  for (const g of out) {
    const m = merged[merged.length - 1];
    const lineUp = m && m.mode === g.mode && Math.abs(m.x1 - g.x0) < 1e-6 && (g.mode === "fit" || Math.abs(((m.x1 - m.x0) / (m.end - m.start)) - ((g.x1 - g.x0) / (g.end - g.start))) < 0.01);
    if (lineUp && Math.abs(m.end - g.start) < 1e-6) { m.end = g.end; m.x1 = g.x1; } else merged.push({ ...g });
  }
  return merged.map((g) => ({ ...g, start: round3(g.start), end: round3(g.end), x0: round3(g.x0), x1: round3(g.x1) }));
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** An ffmpeg expression of t that picks segment k's value, as a balanced tree of ifs (ffmpeg allows ~100 levels of nesting). */
function pick(segs: Seg[], value: (g: Seg) => string, a = 0, b = segs.length - 1): string {
  if (a === b) return value(segs[a]);
  const m = Math.floor((a + b) / 2);
  return `if(lt(t,${segs[m].end.toFixed(3)}),${pick(segs, value, a, m)},${pick(segs, value, m + 1, b)})`;
}
/** The ffmpeg filter graph for one clip, from [0:v] to [v]. Vertical: 720x1280 by a moving crop, a blurred fill, or both
 *  by stretch. Original: the source's shape, at most 1280 on the long side. Frame rate capped at 30. */
export function buildClipFilter(p: { w: number; h: number; format: ClipFormat; segs: Seg[]; fps: number | null }): string {
  const fps = p.fps && p.fps > 30.5 ? ",fps=30" : "";
  const tail = `setsar=1${fps},format=yuv420p`;
  if (p.format === "original") return p.w >= p.h ? `[0:v]scale='min(1280,iw)':-2,${tail}[v]` : `[0:v]scale=-2:'min(1280,ih)',${tail}[v]`;
  if (p.h / p.w >= 1.7) return `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,${tail}[v]`;
  const cw = Math.min(even(p.w), even(p.h * 9 / 16));
  const px = (x: number) => Math.max(0, Math.min(p.w - cw, even(x * p.w - cw / 2)));
  const segs = p.segs.length ? p.segs : [{ start: 0, end: 1e6, mode: "crop" as const, x0: 0.5, x1: 0.5 }];
  const crops = segs.filter((g) => g.mode === "crop"), fits = segs.filter((g) => g.mode === "fit");
  // a fit stretch keeps the crop where its neighbour left it (it is covered anyway)
  let last = crops.length ? px(crops[0].x0) : even((p.w - cw) / 2);
  const xs = segs.map((g) => { if (g.mode === "crop") { const a = px(g.x0), b = px(g.x1); last = b; return [a, b] as const; } return [last, last] as const; });
  const value = (g: Seg) => { const [a, b] = xs[segs.indexOf(g)]; return a === b || g.end - g.start < 0.01 ? String(a) : `${a}+${b - a}*(t-${g.start.toFixed(3)})/${(g.end - g.start).toFixed(3)}`; };
  const expr = crops.length && new Set(xs.map(([a, b]) => `${a},${b}`)).size === 1 && xs[0][0] === xs[0][1] ? String(xs[0][0]) : pick(segs, value);
  const crop = (inp: string, out: string) => `${inp}crop=${cw}:${even(p.h)}:'${expr}':0,scale=720:1280${out}`;
  const fit = (a: string, b: string, out: string) => `${a}scale=180:320:force_original_aspect_ratio=increase,crop=180:320,boxblur=8:2,scale=720:1280,eq=brightness=-0.06[bg];${b}scale=720:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${out}`;
  if (!fits.length) return `${crop("[0:v]", "")},${tail}[v]`;
  if (!crops.length) return `[0:v]split=2[a][b];${fit("[a]", "[b]", "")},${tail}[v]`;
  const when = fits.map((g) => `between(t,${g.start.toFixed(3)},${(g.end - 0.001).toFixed(3)})`).join("+");
  return `[0:v]split=3[c][a][b];${crop("[c]", "[cv]")};${fit("[a]", "[b]", "[fv]")};[cv][fv]overlay=0:0:enable='${when}',${tail}[v]`;
}

// ---------------------------------------------------------------------------------------------------
// One clip: cut the stretch exactly, find its shots, follow the speaker, render it, store it
// ---------------------------------------------------------------------------------------------------
export type CutCtx = { sb: SupabaseClient; deps: ClipsDeps; u: string; dir: string; src: SourceInput; format: ClipFormat; collectionId: string; sourceTitle: string | null; jobId: string; length?: ClipLength };
export type CutResult = { asset_id: string; bytes: number; seconds: number };
async function probeLocal(file: string): Promise<{ w: number; h: number; fps: number | null; seconds: number }> {
  const raw = await new Promise<string>((resolve, reject) => {
    const c = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file], { stdio: ["ignore", "pipe", "pipe"] });
    let o = ""; c.stdout.on("data", (b) => { o += b.toString(); }); c.on("error", reject); c.on("close", (code) => (code === 0 ? resolve(o) : reject(new ClipsError("clip_media_failed", "the stretch could not be read", 502, true))));
  });
  const j = JSON.parse(raw);
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video") ?? {};
  const [n, d] = String(v.avg_frame_rate ?? "0/1").split("/").map(Number);
  return { w: Number(v.width) || 0, h: Number(v.height) || 0, fps: d ? n / d : null, seconds: Number(j.format?.duration) || 0 };
}
async function sceneCutsLocal(file: string): Promise<number[]> {
  const err = await ffmpeg(["-v", "info", "-nostdin", "-threads", "2", "-i", file, "-an", "-filter_threads", "1", "-vf", "scale=320:-2,select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { timeoutMs: 120_000 });
  return [...err.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t > 0);
}
/** The camera path for one cut stretch: its shots, a still a second, who is talking in each, the path that follows them.
 *  Anything failing here shows the whole picture (never a crop on the wrong spot). */
async function frameClip(ctx: CutCtx, m: Moment, mezz: string, dur: number): Promise<Seg[]> {
  const log = ctx.deps.log ?? (() => undefined);
  try {
    const cuts = await sceneCutsLocal(mezz).catch(() => [] as number[]);
    const times = sampleTimes(dur, cuts);
    const frames: Array<{ t: number; jpg: Buffer }> = new Array(times.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < times.length) {
        const k = next++, f = join(ctx.dir, `f${m.rank}_${k}.jpg`);
        await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", times[k].toFixed(3), "-threads", "1", "-i", mezz, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", f], { timeoutMs: 60_000 });
        frames[k] = { t: times[k], jpg: await readFile(f) };
        await rm(f, { force: true }).catch(() => undefined);
      }
    }));
    const speech: Speech[] = (m.speech ?? []).map(([a, b, who, text]) => [round2(Math.max(0, a - m.start)), round2(Math.min(dur, b - m.start)), who, text] as Speech).filter((x) => x[1] > 0 && x[0] < dur);
    const reads = await (ctx.deps.frame ?? ((x) => readTrack(ctx.deps, x)))({ frames, speech, userId: ctx.u });
    const switches = speech.filter((x, k) => k > 0 && x[2] && speech[k - 1][2] && x[2] !== speech[k - 1][2]).map((x) => x[0]);
    return trackPath(frames.map((f, k) => ({ t: f.t, ...reads[k] })), cuts, dur, switches);
  } catch (e: any) {
    log(`[clips] framing of clip ${m.rank} fell back to the whole picture: ${String(e?.message ?? e).slice(0, 160)}`);
    return [{ start: 0, end: dur, mode: "fit", x0: 0.5, x1: 0.5 }];
  }
}
export async function cutClip(ctx: CutCtx, m: Moment): Promise<CutResult> {
  const { sb, u, dir } = ctx;
  const mezz = join(dir, `m${m.rank}.mp4`), out = join(dir, `c${m.rank}.mp4`), still = join(dir, `p${m.rank}.jpg`);
  const seconds = m.end - m.start;
  // 1. the stretch, cut exactly (decoded from just before it), kept near-lossless at up to 1080 lines
  await ffmpeg(["-v", "error", "-nostdin", "-y", ...inputArgs(ctx.src, m.start, seconds), "-vf", "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)'",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-ac", "2", mezz], { timeoutMs: 8 * 60_000, proxy: ctx.src.proxy });
  const info = await probeLocal(mezz);
  const dur = info.seconds || seconds;
  if (ctx.length === "minute" && dur < CLIP_LENGTHS.minute.min - 0.5) throw new ClipsError("clip_too_short", `the cut came out at ${dur.toFixed(1)} s, under a minute`, 502);
  // 2. framing: only needed when a wide picture becomes a tall one
  let segs: Seg[] = [{ start: 0, end: dur, mode: "crop", x0: 0.5, x1: 0.5 }];
  if (ctx.format === "vertical" && info.w / Math.max(1, info.h) > 0.75 && info.h / Math.max(1, info.w) < 1.7) segs = await frameClip(ctx, m, mezz, dur);
  // 3. the clip: framed, 720x1280 (or the original shape), loudness evened out, soft edges on the sound
  const graph = buildClipFilter({ w: info.w, h: info.h, format: ctx.format, segs, fps: info.fps });
  const af = `afade=t=in:d=0.06,afade=t=out:st=${Math.max(0, dur - 0.25).toFixed(3)}:d=0.25`;
  // threads capped: on a 1-CPU server ffmpeg would start one per core it sees on the host, each holding frames
  // (two clips at once with uncapped threads went past 2 GB and the server was killed, Oct 31 2026)
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "2", "-rc-lookahead", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart"];
  const render = (audio: string) => ffmpeg(["-v", "error", "-nostdin", "-y", "-threads", "2", "-i", mezz, "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-af", audio, ...enc, out], { timeoutMs: 8 * 60_000 });
  await render(`loudnorm=I=-14:TP=-1.5:LRA=11,${af}`).catch(() => render(af));
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", Math.min(1, dur / 3).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", still], { timeoutMs: 60_000 });
  const final = await probeLocal(out);
  if (ctx.length === "minute" && (final.seconds || dur) < CLIP_LENGTHS.minute.min - 0.5) throw new ClipsError("clip_too_short", "the clip came out under a minute", 502);
  const bytes = (await stat(out)).size;
  const limit = await checkUpload(sb, u, bytes);
  if (limit) throw new ClipsError(limit.code, limit.message, limit.status);
  // 4. stored as an ordinary library video in the run's collection
  const id = randomUUID(), key = `${u}/${id}.mp4`, posterKey = `${u}/assets/${id}.jpg`;
  const up = await sb.storage.from("studio-uploads").upload(key, await readFile(out), { contentType: "video/mp4", upsert: false });
  if (up.error) throw new ClipsError("clip_store_failed", String(up.error.message ?? up.error), 502, true);
  const pu = await sb.storage.from("studio-outputs").upload(posterKey, await readFile(still), { contentType: "image/jpeg", upsert: true });
  const cuts = segs.length > 1 ? segs.slice(1).filter((g, k) => g.mode !== segs[k].mode || Math.abs(g.x0 - segs[k].x1) > 1e-6).map((g) => round2(g.start)) : [];
  const name = `${m.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || `Clip ${m.rank}`}.mp4`;
  const ins = await sb.from("studio_assets").insert({
    id, user_id: u, kind: "video", name, object_key: key, bytes, status: "ready", collection_id: ctx.collectionId,
    probe: { duration: round2(final.seconds || dur), width: final.w, height: final.h, poster_key: pu.error ? undefined : posterKey, cuts, cuts_at: new Date().toISOString(),
      source: "clips", title: m.title, hook: m.hook, why: m.why, score: m.score, tags: m.tags, transcript: m.transcript,
      clip: { start: m.start, end: m.end, rank: m.rank, source_title: ctx.sourceTitle, job_id: ctx.jobId, length: ctx.length ?? null } },
  });
  if (ins.error) { await sb.storage.from("studio-uploads").remove([key]).catch(() => undefined); throw ins.error; }
  await rm(mezz, { force: true }).catch(() => undefined);
  return { asset_id: id, bytes, seconds: final.seconds || dur };
}

// ---------------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------------
export type ClipsQuote = { tool: "clips"; credits: number; options: Record<string, any>; summary: string };
export const clipsEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.STUDIO_CLIPS_ENABLED !== "false" && !!env.ANTHROPIC_API_KEY && (!!env.ELEVENLABS_API_KEY || !!env.SCRAPECREATORS_API_KEY);
export const lengthOf = (v: unknown): ClipLength => (v === "short" || v === "long" || v === "minute" ? v : "standard");
const formatOf = (v: unknown): ClipFormat => (v === "original" ? "original" : "vertical");
const youtubeUrl = (v: unknown): string | null => {
  try { const u = new URL(String(v ?? "").trim()); if (u.protocol !== "https:" && u.protocol !== "http:") return null; return /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname) && youtubeId(u.toString()) ? u.toString() : null; } catch { return null; }
};
const LENGTH_WORDS: Record<ClipLength, string> = { short: "short", standard: "30-second", long: "long", minute: "one-minute" };
/** Prices a run before it starts: reading the video, plus each clip asked for. The run is charged for the clips it makes. */
export async function quoteClips(deps: ClipsDeps, plans: PlanLike[], asset: { id: string; kind: string; name?: string | null; bytes?: number | null; probe?: any } | null, options: any): Promise<ClipsQuote> {
  const env = deps.env ?? process.env;
  const o = options && typeof options === "object" ? options : {};
  const length = lengthOf(o.length), format = formatOf(o.format);
  let platform: "youtube" | "upload", seconds: number, source: Record<string, any>, url: string | null = null;
  if (asset) {
    if (asset.kind !== "video") throw new ClipsError("clip_source_required", "Pick a video");
    seconds = Number(asset.probe?.duration);
    if (!(seconds > 0)) throw new ClipsError("asset_not_inspected", "The video is still being checked", 409);
    if (!env.ELEVENLABS_API_KEY) throw new ClipsError("clips_unavailable", "Clips from uploads are not switched on yet", 503);
    platform = "upload";
    source = { platform, url: null, asset_id: asset.id, title: String(asset.name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "") || null, channel: null, seconds: Math.round(seconds), thumbnail_url: null };
  } else {
    url = youtubeUrl(o.url);
    if (!url) throw new ClipsError(o.url ? "unsupported_link" : "clip_source_required", o.url ? "Clips takes YouTube links (or an uploaded video)" : "Paste a YouTube link or pick a video");
    if (/\/shorts\//.test(url)) throw new ClipsError("clip_source_too_short", "That is a Short: use it as it is");
    const meta = await (deps.meta ?? ((x) => youtubeMeta(deps, x)))(url);
    if (!meta.seconds) throw new ClipsError("link_no_media", "That video's length could not be read (a live stream or a premiere?)");
    seconds = meta.seconds; platform = "youtube";
    source = { platform, url, asset_id: null, title: meta.title, channel: meta.channel, seconds, thumbnail_url: meta.thumbnail_url };
  }
  if (seconds > CLIP_LIMITS.max_source) throw new ClipsError("clip_source_too_long", `That video is ${Math.round(seconds / 60)} minutes; Clips takes up to ${CLIP_LIMITS.max_source / 3600} hours`);
  if (seconds < CLIP_LIMITS.min_source) throw new ClipsError("clip_source_too_short", "That video is under 2 minutes: use it as it is");
  const minutes = Math.ceil(seconds / 60);
  const likely = likelyClips(seconds, length), cap = countCap(seconds, length);
  const asked = Math.round(Number(o.count));
  const count = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, cap) : Math.min(likely, 10);
  // whether our servers can read YouTube (a proxy or a signed-in cookie is set); without it the moments are still chosen
  // from YouTube's captions, then the person uploads the file to have them cut. The page says so before they start.
  const youtube_direct = platform !== "youtube" || !!env.STUDIO_YT_PROXY || !!env.STUDIO_YT_COOKIES;
  const price = clipsPrice(plans, { seconds, platform, length, env, download: youtube_direct });
  const credits = youtube_direct ? clipsCharge(price, count) : price.lite;
  const what = LENGTH_WORDS[length];
  const warning = Number.isFinite(asked) && asked > cap
    ? `A ${minutes}-minute video fits at most ${cap} ${what} clips, so we'll aim for ${cap}. You're only charged for the clips we make.`
    : count > likely
      ? `A ${minutes}-minute video usually holds about ${likely} strong ${what} ${likely === 1 ? "clip" : "clips"}. We'll make as many as it really has, up to ${count}, and you're only charged for the clips we make.`
      : null;
  return { tool: "clips", credits, options: { platform, url, format, length, count, likely, cap, max_clips: count, seconds: Math.round(seconds), minutes, source, youtube_direct, price, warning },
    summary: `${minutes} min · up to ${count} ${count === 1 ? "clip" : "clips"}` };
}
/** The re-run that cuts moments already chosen, from an uploaded copy of the same video: each clip, no reading. */
export function quoteCut(plans: PlanLike[], clips: number, seconds: number, length: ClipLength = "standard"): { credits: number; price: ClipsPrice } {
  const p = clipsPrice(plans, { seconds, platform: "upload", length, env: {} });
  const price = { analysis: 0, per_clip: p.per_clip, lite: 0 };
  return { credits: clipsCharge(price, clips), price };
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number; marks?: Record<string, number> };
const planKey = (u: string, collectionId: string) => `${u}/clips/${collectionId}/plan.txt`;
/** Saves where the run is. A new stage gets its own clock (`stage_at`, for the page's time left), and the moment it
 *  started is kept on the job (`marks`) to measure this run for the next estimates. */
async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const next = { ...progress };
  if (next.stage && next.stage !== job.progress?.stage) {
    next.stage_at = new Date().toISOString();
    (job.marks ??= {})[next.stage] ??= Date.now();
  }
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...next } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new ClipsError("lease_lost", "lease lost");
  job.progress = { ...(job.progress ?? {}), ...next };
}
async function signedSource(sb: SupabaseClient, u: string, assetId: string): Promise<SourceInput> {
  const a = await sb.from("studio_assets").select("object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready") throw new ClipsError("source_missing", "The video is no longer in the library", 409);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 6 * 3600);
  if (s.error || !s.data?.signedUrl) throw new ClipsError("source_missing", "The video could not be read", 502, true);
  return { video: s.data.signedUrl, audio: null, proxy: null, width: Number(a.data.probe?.width) || 0, height: Number(a.data.probe?.height) || 0, fps: null };
}
type Plan = { moments: Moment[]; seconds: number; transcribed: boolean; title: string | null; downloaded?: boolean };
const blockedByYouTube = (e: any) => e instanceof LinkError && (e.code === "link_blocked" || e.code === "link_fetch_failed");
/** The price a run settles on: the one quoted when it was started (kept in its options), or worked out again for a run
 *  started before prices were kept. */
function priceOf(o: any, plans: PlanLike[], env: Record<string, string | undefined>, seconds: number): ClipsPrice {
  const p = o?.price;
  if (p && Number.isFinite(Number(p.per_clip))) return { analysis: Number(p.analysis) || 0, per_clip: Number(p.per_clip), lite: Number(p.lite) || 0 };
  const fresh = clipsPrice(plans, { seconds: seconds || 600, platform: o?.platform === "youtube" ? "youtube" : "upload", length: lengthOf(o?.length), env });
  return o?.plan_from ? { ...fresh, analysis: 0, lite: 0 } : fresh;
}
export async function runClipsJob(sb: SupabaseClient, deps: ClipsDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const plans = deps.plans ?? [];
  const o = job.options ?? {}, u = job.user_id;
  const collectionId: string = o.collection_id;
  const length = lengthOf(o.length), format = formatOf(o.format);
  const setCollection = (f: Record<string, any>) => sb.from("studio_collections").update({ ...f, updated_at: new Date().toISOString() }).eq("id", collectionId).eq("user_id", u);
  let dir: string | null = null;
  let plan: Plan | null = null;
  const made: Array<{ rank: number; asset_id: string; seconds: number }> = Array.isArray(job.progress?.made) ? job.progress.made : [];
  const youtube = o.platform === "youtube" && !o.plan_from;
  let ytFile: string | null = null;
  const fetchYouTube = async (seconds: number) => {
    const file = join(dir!, "youtube.mp4");
    const began = Date.now();
    await (deps.download ?? ((x, t, h) => youtubeDownload(x, t, { env, fetch: deps.fetch, maxHeight: h })))(o.url, file, seconds > CLIP_COST.long_after_seconds ? 720 : 1080);
    ytFile = file;
    // what came through the proxy, measured: the price assumes CLIP_COST.full_bytes_per_second
    const bytes = await stat(file).then((x) => x.size).catch(() => 0);
    const usd = (bytes / 1e9) * proxyUsdPerGb(env);
    log(`[clips] fetched ${JSON.stringify({ job: job.id, mb: Math.round(bytes / 1e5) / 10, seconds: Math.round((Date.now() - began) / 1000), bytes_per_video_second: seconds ? Math.round(bytes / seconds) : null, usd: Math.round(usd * 1000) / 1000 })}`);
    if (usd > 0) recordEvent({ user_id: u, kind: "vendor", name: "youtube_proxy", usd, props: { job: job.id, bytes, seconds } });
    return file;
  };
  try {
    if (!collectionId) throw new ClipsError("clips_invalid", "the run has no collection");
    dir = await mkdtemp(join(tmpdir(), "studio-clips-"));
    // A. The plan: from an earlier attempt of this run, from the run this one finishes (plan_from), or made now.
    const fromId: string = o.plan_from ?? collectionId;
    const saved = await sb.storage.from("studio-outputs").download(planKey(u, fromId));
    if (!saved.error && saved.data) plan = JSON.parse(Buffer.from(await saved.data.arrayBuffer()).toString("utf8"));
    if (!plan) {
      if (o.plan_from) throw new ClipsError("clips_plan_missing", "The moments chosen earlier are gone; start a new run", 409);
      await renew(sb, job, { collection_id: collectionId, stage: "reading", done: 0, total: 0, message: "Reading the video" });
      let lines: Line[] = [], words: TimedWord[] | null = null, events: AudioEvent[] = [], excess: number[] | null = null, transcribed = false, blocked = false;
      let meta: ChooseInput["meta"] = { title: o.source?.title ?? null, channel: o.source?.channel ?? null, description: "", chapters: [], replay: [] };
      let seconds = Number(o.seconds) || 0;
      // the sound: its loudness every second, then (with speech-to-text on) every word, speaker and laugh
      const listen = async (src: SourceInput): Promise<boolean> => {
        await renew(sb, job, { stage: "transcribing", message: "Listening to every word" });
        const mp3 = join(dir!, "sound.mp3");
        await (deps.extractAudio ?? defaultExtractAudio)(src, mp3);
        const rms = await (deps.loudness ?? loudnessTrack)(mp3, dir!).catch((e: any) => { log(`[clips] loudness skipped ${job.id}: ${String(e?.message ?? e).slice(0, 120)}`); return [] as number[]; });
        if (rms.length) excess = loudnessExcess(rms);
        if (!deps.words && !env.ELEVENLABS_API_KEY) return false;
        const heard = await (deps.words ?? (async (audio) => { const r = await transcribeWords({ env, fetch: deps.fetch }, { audio, events: true }); return { words: r.words, events: r.events }; }))(await readFile(mp3));
        words = Array.isArray(heard) ? heard : heard.words;
        events = Array.isArray(heard) ? [] : heard.events ?? [];
        transcribed = true;
        lines = linesFromWords(words);
        return true;
      };
      if (o.platform === "youtube") {
        const m = await (deps.meta ?? ((x) => youtubeMeta(deps, x)))(o.url);
        meta = { title: m.title, channel: m.channel, description: m.description, chapters: m.chapters, replay: m.replay };
        seconds = m.seconds ?? seconds;
        // the whole video first: its sound is heard properly (every word, who says it, the laughs), and the clips are cut from it
        let heard = false;
        try {
          await renew(sb, job, { message: "Fetching the video" });
          await fetchYouTube(seconds);
          heard = await listen({ video: ytFile!, audio: null, proxy: null, width: 0, height: 0, fps: null });
        } catch (e: any) {
          if (!blockedByYouTube(e)) throw e;
          blocked = true;
          log(`[clips] YouTube refused the download of ${job.id} (${e.code}); choosing from its captions`);
        }
        if (!heard) {
          const segs = await (deps.transcript ?? ((x) => youtubeTranscript(deps, x)))(o.url);
          if (segs?.length) lines = linesFromSegments(segs);
          else if (blocked && env.ELEVENLABS_API_KEY) {
            const sound = join(dir!, "youtube-sound");
            await (deps.ytAudio ?? ((x, t) => youtubeAudio(x, t, { env, fetch: deps.fetch })))(o.url, sound);
            await listen({ video: sound, audio: null, proxy: null, width: 0, height: 0, fps: null });
          } else throw new ClipsError("clips_no_transcript", "That video has no captions to read; upload the file instead", 422);
        }
      } else {
        await listen(await signedSource(sb, u, job.asset_id!));
      }
      if (!lines.length) throw new ClipsError("clips_no_speech", "Nobody speaks in this video, so there is nothing to choose clips from", 422);
      lines = annotateLines(lines, events, excess);
      const peaks = excess ? loudPeaks(excess) : [];
      await renew(sb, job, { stage: "choosing", message: "Finding the moments that stand out" });
      const cap = Math.max(1, Math.min(Number(o.count ?? o.max_clips) || likelyClips(seconds, length), countCap(seconds || 600, length)));
      const parts = windows(lines);
      const total = Math.max(1, (lines[lines.length - 1].end - lines[0].start));
      const picks: RawMoment[] = [];
      for (let k = 0; k < parts.length; k += 3) {
        const batch = await Promise.all(parts.slice(k, k + 3).map((w) => {
          const share = (w[w.length - 1].end - w[0].start) / total;
          return (deps.choose ?? ((x) => chooseWithClaude(deps, x, u)))({ lines: w, meta, length, peaks, wanted: Math.max(3, Math.ceil(cap * share * 1.3) + 2) });
        }));
        picks.push(...batch.flat());
      }
      const moments = finalizeMoments(picks, lines, words, length, cap, CLIP_LIMITS.min_score, events);
      if (!moments.length) throw new ClipsError("clips_none_found", "No moment in this video stands out enough to be a clip", 422);
      plan = { moments, seconds, transcribed, title: meta.title ?? o.source?.title ?? null, downloaded: !blocked };
      const up = await sb.storage.from("studio-outputs").upload(planKey(u, collectionId), Buffer.from(JSON.stringify(plan)), { contentType: "text/plain", upsert: true });
      if (up.error) log(`[clips] plan not saved ${job.id}: ${up.error.message}`);
    }
    const p = plan!;
    const price = priceOf(o, plans, env, p.seconds);
    const todo = p.moments.filter((m) => !made.some((x) => x.rank === m.rank));
    // B. The source for cutting: the YouTube file (fetched above, or again on a retry), or the upload.
    let src: SourceInput;
    if (youtube) {
      try {
        if (!ytFile && todo.length) { await renew(sb, job, { message: "Fetching the video" }); await fetchYouTube(p.seconds); }
        src = { video: ytFile ?? join(dir, "youtube.mp4"), audio: null, proxy: null, width: 0, height: 0, fps: null };
      } catch (e: any) {
        if (!blockedByYouTube(e)) throw e;
        // YouTube refused our servers: keep the chosen moments, charge for choosing only, ask for the file.
        const charged = Math.min(price.lite, job.credits_reserved);
        const note = `YouTube would not let our servers download this video. We picked ${p.moments.length} ${p.moments.length === 1 ? "moment" : "moments"}; upload the same video and we will cut them (choosing is already paid).`;
        await setCollection({ status: "needs_file", note });
        await renew(sb, job, { stage: "done", outcome: "needs_file", total: p.moments.length, charged }).catch(() => undefined);
        const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
        if (done.error) throw done.error;
        log(`[clips] needs_file ${job.id} ${e.code}`);
        return "needs_file";
      }
    } else src = await signedSource(sb, u, job.asset_id!);
    await renew(sb, job, { collection_id: collectionId, stage: "cutting", done: made.length, total: p.moments.length, message: `Cutting clip ${Math.min(made.length + 1, p.moments.length)} of ${p.moments.length}`, made });
    // C. Cut: one at a time (the web service has one CPU, so two at once is no faster, and two renders at once ran it out
    //    of memory).
    const ctx: CutCtx = { sb, deps, u, dir, src, format, collectionId, sourceTitle: p.title, jobId: job.id, length };
    let full: ClipsError | null = null;
    const cutOne = async (m: Moment) => {
      for (let attempt = 0; ; attempt++) {
        try { return await (deps.cut ?? cutClip)(ctx, m); } catch (e: any) {
          if (e instanceof ClipsError && (e.code === "storage_full" || e.code === "too_many_files" || e.code === "clip_too_short")) throw e;
          if (attempt >= 1) throw e;
        }
      }
    };
    const queue = [...todo];
    const skipped: number[] = [];
    const madeNow: number[] = [];
    const worker = async () => {
      while (queue.length && !full) {
        const m = queue.shift()!;
        try {
          const r = await cutOne(m);
          made.push({ rank: m.rank, asset_id: r.asset_id, seconds: r.seconds });
          madeNow.push(r.seconds);
          await renew(sb, job, { clip_at: new Date().toISOString(), done: made.length, total: p.moments.length, message: made.length < p.moments.length ? `Cutting clip ${made.length + 1} of ${p.moments.length}` : "Finishing", made });
        } catch (e: any) {
          if (e instanceof ClipsError && (e.code === "storage_full" || e.code === "too_many_files")) { full = e; break; }
          if (e instanceof ClipsError && e.code === "lease_lost") throw e;
          skipped.push(m.rank);
          log(`[clips] clip ${m.rank} of ${job.id} skipped: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      }
    };
    await worker();
    if (!made.length) throw new ClipsError(full ? (full as ClipsError).code : "clips_cut_failed", full ? (full as ClipsError).message : "None of the clips could be cut.", full ? 409 : 502, !full);
    // D. Settle on what was made: reading once, and each clip made. What was reserved for clips not made goes back.
    const charged = Math.min(job.credits_reserved, clipsCharge(price, made.length, { analysis: !o.plan_from }));
    const asked = Number(o.count ?? o.max_clips) || p.moments.length;
    const word = (n: number) => `${n} ${n === 1 ? "clip" : "clips"}`;
    const note = full ? `${made.length} of ${p.moments.length} clips made: ${(full as ClipsError).message}. You were charged for the ${word(made.length)} made; the rest went back.`
      : skipped.length ? `${word(made.length)} made; ${skipped.length} could not be cut. You were charged for the ${word(made.length)} made; the rest went back.`
      : made.length < asked && !o.plan_from ? `This video had ${word(made.length)} strong enough to post, of the ${asked} you asked for. You were charged for ${word(made.length)}; the rest went back.`
      : null;
    await setCollection({ status: "ready", note });
    // what this attempt measured, for the next estimates (a stage it did not run is left out)
    const mk = job.marks ?? {}, end = Date.now();
    const span = (a: string, b: string | null) => (mk[a] ? Math.round(((b && mk[b] ? mk[b] : end) - mk[a]) / 1000) : 0);
    const timing = { video_s: Math.round(p.seconds), fetch_s: youtube && mk.reading && mk.transcribing ? span("reading", "transcribing") : 0, listen_s: span("transcribing", "choosing"), choose_s: span("choosing", "cutting"),
      cut_s: madeNow.length ? span("cutting", null) : 0, clips: madeNow.length, clip_s: Math.round(madeNow.reduce((a, x) => a + x, 0)) };
    await renew(sb, job, { stage: "done", outcome: made.length < asked && !o.plan_from ? "fewer" : "done", made_count: made.length, asked, charged }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
    if (done.error) throw done.error;
    recordEvent({ user_id: u, kind: "feature", name: "clips_done", props: { job: job.id, platform: o.platform, length, clips: made.length, asked, planned: p.moments.length, minutes: Math.round(p.seconds / 60), credits: charged, reserved: job.credits_reserved, timing } });
    return "done";
  } catch (e: any) {
    const code = e instanceof ClipsError ? e.code : e instanceof LinkError ? e.code : "clips_failed";
    if (code === "lease_lost") return "lease_lost";
    const retry = e instanceof ClipsError ? e.retry : !(e instanceof LinkError);
    const last = !retry || (job.attempts ?? 1) >= 3;
    log(`[clips] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 240) })}`);
    const said = String(e?.message ?? code).replace(/[.\s]+$/, "");
    if (last) await setCollection({ status: made.length ? "ready" : "failed", note: made.length ? `${made.length} clips made before it stopped: ${said.slice(0, 160)}. You were charged for those; the rest went back.` : `${said.slice(0, 240)}.` });
    // Some clips already in the library on a final failure: charge for those, refund the rest; otherwise fail (refund all).
    if (last && made.length) {
      const charged = Math.min(job.credits_reserved, clipsCharge(priceOf(o, plans, env, plan?.seconds ?? Number(o.seconds) ?? 0), made.length, { analysis: !o.plan_from }));
      await renew(sb, job, { stage: "done", outcome: "partial", made_count: made.length, charged }).catch(() => undefined);
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
      if (done.error) log(`[clips] could not settle ${job.id}: ${done.error.message}`);
      return "partial";
    }
    const failed = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry });
    if (failed.error) log(`[clips] could not record the failure of ${job.id}: ${failed.error.message}`);
    return code;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One run at a time per server: cutting is CPU work on the web service (at a lower priority than requests). */
export function startClipsLoop(sbFn: () => SupabaseClient, deps: ClipsDeps = {}, intervalMs = 10_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!clipsEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `clips-${randomUUID()}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    try {
      const sb = sbFn();
      const r = await sb.rpc("studio_claim", { p_tool: "clips", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running = true;
      // the lease is 10 minutes; a long cut keeps it alive between clips, and this keeps it alive during one long step
      const keep = setInterval(() => { void sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }); }, 4 * 60_000);
      runClipsJob(sb, { ...deps, log }, job).then((s) => log(`[clips] ${s} ${job.id}`)).catch((e) => log(`[clips] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { clearInterval(keep); running = false; });
    } catch (e: any) { log(`[clips] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 17_000);
  return t;
}
