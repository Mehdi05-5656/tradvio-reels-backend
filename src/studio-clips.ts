// Clone8 Studio: Clips. A long video in (a YouTube link up to 3 hours, or an upload up to 4 GB), every moment that
// stands on its own out, each a ready ~30 s library video framed for vertical feeds.
//
// Cheap by construction:
//  - YouTube: the transcript, chapters and "most replayed" heatmap come from ScrapeCreators (about $0.004 for both
//    calls); nothing is downloaded to choose. Only the chosen stretches are read, straight from YouTube's stream
//    (yt-dlp hands over the addresses, ffmpeg seeks exactly), about a fifth of the video. Our servers are refused by
//    YouTube without a proxy; the moments are still chosen and the person can upload the file to cut them.
//  - Uploads: a 32 kb/s mono copy of the sound (2 hours = 29 MB) goes to speech-to-text with word times ($0.22/hour).
//    The video itself is never downloaded whole: ffmpeg reads each stretch through a signed address.
//  - Choosing: one Claude call per 40 minutes of transcript (~$0.05/hour); framing: a few small stills per clip to a
//    small model (~$0.0005 a clip). Clips render at 720x1280: a vertical crop of 1080p is 608 px wide, so more is
//    only upscaling, and every tool downsizes to 720 anyway.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditValueFloor, creditsForCost, logClaudeCost, MARGIN_TARGET, OVERHEAD, type PlanLike } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import { transcribeWords, type TimedWord } from "./studio-eleven.js";
import { youtubeAudio, youtubeId, youtubeSection, youtubeStreams, LinkError, type YouTubeStreams } from "./studio-youtube.js";
import { checkUpload } from "./studio-limits.js";

// ---------------------------------------------------------------------------------------------------
// Rules and prices
// ---------------------------------------------------------------------------------------------------
export const CLIP_LENGTHS = {
  short: { min: 15, max: 30, target: 22, words: "15 to 30 seconds" },
  standard: { min: 22, max: 48, target: 32, words: "about 30 seconds (22 to 48)" },
  long: { min: 45, max: 90, target: 60, words: "45 to 90 seconds" },
} as const;
export type ClipLength = keyof typeof CLIP_LENGTHS;
export type ClipFormat = "vertical" | "original";
export const CLIP_LIMITS = { min_source: 120, max_source: 3 * 3600, max_clips: 60, seconds_per_clip: 75, min_score: 60, min_credits: 10 };
/** A video only Clips takes: over 10 minutes or 512 MB. Every other tool reads its source whole. */
export const LONG_SOURCE = { seconds: 600, bytes: 536_870_912 };
export const isLongSource = (a: { bytes?: number | null; probe?: any } | null | undefined): boolean =>
  !!a && (Number(a.bytes) > LONG_SOURCE.bytes || Number(a.probe?.duration) > LONG_SOURCE.seconds || a.probe?.long_source === true);

/** What a run costs us, at list prices (the vendors' discounts stay our margin). */
export const CLIP_COST = {
  transcribe_usd_per_hour: 0.22,          // ElevenLabs scribe_v1, eleven-catalog.json
  choose_usd_per_hour: 0.12,              // Claude Sonnet over the transcript, with thinking; measured ~$0.05, kept wide
  frame_usd_per_clip: 0.001,              // a small model looking at up to 8 stills
  render_usd_per_clip: 0.003,             // web-service CPU and the stored file
  lookup_usd: 2 * OVERHEAD.scrapecreators_usd_per_call,
  clip_bytes_per_second: 200_000,         // a 1080p stretch with sound read through the proxy: measured 133-166 kB/s on YouTube (Oct 31 2026), kept with margin
};
/** What the proxy charges per GB (0 without one: then YouTube refuses us and nothing is read through it). */
export const proxyUsdPerGb = (env: Record<string, string | undefined>) => (env.STUDIO_YT_PROXY ? (Number(env.STUDIO_YT_PROXY_USD_PER_GB) > 0 ? Number(env.STUDIO_YT_PROXY_USD_PER_GB) : 3) : 0);
export function maxClipsFor(seconds: number): number {
  return Math.max(3, Math.min(CLIP_LIMITS.max_clips, Math.floor(seconds / CLIP_LIMITS.seconds_per_clip)));
}
export function clipsCostUsd(p: { seconds: number; platform: "youtube" | "upload"; clips: number; clipSeconds: number; transcribe: boolean; choose: boolean; env: Record<string, string | undefined> }): number {
  const hours = p.seconds / 3600;
  let usd = p.clips * (CLIP_COST.frame_usd_per_clip + CLIP_COST.render_usd_per_clip);
  if (p.choose) usd += hours * CLIP_COST.choose_usd_per_hour;
  if (p.transcribe) usd += hours * CLIP_COST.transcribe_usd_per_hour;
  if (p.platform === "youtube") usd += (p.choose ? CLIP_COST.lookup_usd : 0) + (p.clips * (p.clipSeconds + 1) * CLIP_COST.clip_bytes_per_second / 1e9) * proxyUsdPerGb(p.env);
  return usd;
}
export const clipsCredits = (usd: number, plans: PlanLike[], floorCredits: number = CLIP_LIMITS.min_credits) => Math.max(floorCredits, creditsForCost(usd, creditValueFloor(plans), MARGIN_TARGET));

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
  words?: (audio: Buffer) => Promise<TimedWord[]>;
  streams?: (url: string) => Promise<YouTubeStreams>;
  extractAudio?: (input: SourceInput, target: string) => Promise<void>;
  choose?: (input: ChooseInput) => Promise<RawMoment[]>;
  cut?: (ctx: CutCtx, m: Moment) => Promise<CutResult>;
  section?: (url: string, start: number, end: number, target: string) => Promise<void>;
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
export type Line = { i: number; start: number; end: number; text: string; w0?: number; w1?: number };
const MAX_LINE_WORDS = 28;
/** Caption segments (YouTube) into lines: joined until a sentence ends, a pause, or about 14 words. Auto-captions
 *  overlap in time, so a segment ends where the next begins. */
export function linesFromSegments(segs: Segment[], maxWords = 14): Line[] {
  const out: Line[] = [];
  let cur: { start: number; end: number; parts: string[]; words: number } | null = null;
  const flush = () => { if (cur && cur.parts.length) out.push({ i: out.length, start: cur.start, end: cur.end, text: cur.parts.join(" ") }); cur = null; };
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], next = segs[k + 1];
    const end = next ? Math.max(s.start, Math.min(s.end || next.start, next.start)) : (s.end || s.start + 2);
    if (cur && s.start - cur.end > 1.5) flush();
    if (!cur) cur = { start: s.start, end, parts: [], words: 0 };
    cur.parts.push(s.text); cur.end = end; cur.words += s.text.split(/\s+/).length;
    // automatic captions carry no punctuation: short lines keep the cut points close to where a thought turns
    if (/[.?!…]["')\]]?$/.test(s.text) ? cur.words >= 6 : cur.words >= maxWords) flush();
  }
  flush();
  return out;
}
/** Timed words (uploads) into lines, split at a sentence's end, a pause of 0.7 s, a new speaker, or 28 words. */
export function linesFromWords(words: TimedWord[]): Line[] {
  const out: Line[] = [];
  let a = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k], next = words[k + 1];
    const n = k - a + 1;
    const end = !next || /[.?!…]["')\]]?$/.test(w.text) && n >= 4 || next.start - w.end > 0.7 || (next.speaker && w.speaker && next.speaker !== w.speaker) || n >= MAX_LINE_WORDS;
    if (end) { out.push({ i: out.length, start: words[a].start, end: w.end, text: words.slice(a, k + 1).map((x) => x.text).join(" ").replace(/\s+([,.?!…])/g, "$1"), w0: a, w1: k }); a = k + 1; }
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
// Choosing: Claude reads the transcript and returns every moment worth a clip
// ---------------------------------------------------------------------------------------------------
export type ChooseInput = { lines: Line[]; meta: { title: string | null; channel: string | null; description: string; chapters: YtMeta["chapters"]; replay: YtMeta["replay"] }; length: ClipLength; wanted: number };
export type RawMoment = { start_line: number; end_line: number; title: string; hook: string; why: string; score: number; tags: string[] };
export const CHOOSE_SYSTEM = `You are a senior short-form video editor. You find the moments in a long video (a podcast, interview, talk, stream or vlog) that work as standalone vertical clips for TikTok, Reels and Shorts.

A moment qualifies only if ALL of these hold:
- It makes sense to someone who has not seen the rest: no "as I said", "that's why", "he" or "it" pointing to something earlier, no setup that happens outside the clip.
- Its first line grabs attention within 3 seconds: a bold claim, a question, a surprising number, a strong opinion, a story's opening, a conflict. Never start on filler ("so", "um", "yeah", "and", "but"), a greeting, or mid-sentence.
- It has a payoff: an answer, a punchline, a lesson, a reveal, an emotional beat. It ends on a complete sentence, ideally right after the payoff, never mid-thought.
- It is substantive: insight, story, humor, emotion, controversy, practical advice, or a quotable line. Not small talk, ads, sponsor reads, housekeeping, intros or outros.

Score each moment 0-100 for how likely it is to hold a stranger scrolling past: hook strength 35%, payoff 30%, standalone clarity 20%, emotion or novelty 15%. Be strict: 90+ is exceptional, 75 strong, 60 usable. Do not return anything under 60.

Return every moment that qualifies, as many as genuinely do and none that don't. Moments must not overlap. Use the line numbers exactly as given (L12 is line 12); start_line is the first line of the clip and end_line the last, inclusive. Respect the length range: the time from start_line's start to end_line's end must fall inside it.

For each moment write: title (a short, specific, curiosity-driven headline under 60 characters, in the video's language, no hashtags, no clickbait lies), hook (the first spoken line, quoted or tightened, under 100 characters), why (under 15 words: why it works), tags (1 to 3 lowercase topic words).`;
export const CHOOSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["clips"],
  properties: { clips: { type: "array", items: { type: "object", additionalProperties: false, required: ["start_line", "end_line", "title", "hook", "why", "score", "tags"],
    properties: { start_line: { type: "integer" }, end_line: { type: "integer" }, title: { type: "string" }, hook: { type: "string" }, why: { type: "string" }, score: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } } } },
};
export function chooseMessage(input: ChooseInput): string {
  const len = CLIP_LENGTHS[input.length];
  const from = input.lines[0]?.start ?? 0, to = input.lines[input.lines.length - 1]?.end ?? 0;
  const chapters = input.meta.chapters.filter((c) => c.start >= from - 1 && c.start < to);
  // the heatmap's first bucket is always hot (everyone starts at 0:00); peaks are what viewers went back to
  const peaks = input.meta.replay.filter((r) => r.start > 0 && r.end > from && r.start < to && r.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 8);
  const head = [
    input.meta.title ? `Video: ${input.meta.title}${input.meta.channel ? ` (${input.meta.channel})` : ""}` : null,
    input.meta.description ? `Description: ${input.meta.description.replace(/\s+/g, " ").slice(0, 600)}` : null,
    chapters.length ? `Chapters: ${chapters.map((c) => `${mmss(c.start)} ${c.title}`).join("; ")}` : null,
    peaks.length ? `Viewers replayed these stretches most (a strong signal, not a rule): ${peaks.map((p) => `${mmss(p.start)}-${mmss(p.end)}`).join(", ")}` : null,
    `Clip length: ${len.words}. Aim for about ${len.target} seconds.`,
    `This part runs ${mmss(from)} to ${mmss(to)}. Expect roughly one strong moment every few minutes in good content; return up to ${input.wanted}.`,
  ].filter(Boolean).join("\n");
  const body = input.lines.map((l) => `L${l.i} [${mmss(l.start)}] ${l.text}`).join("\n");
  return `${head}\n\nTranscript:\n${body}`;
}
/** One structured Claude call; 429 and 5xx are retried twice with a pause. */
export async function claudeJson(deps: ClipsDeps, body: Record<string, any>, feature: string, userId?: string): Promise<any> {
  const env = deps.env ?? process.env, key = env.ANTHROPIC_API_KEY;
  if (!key) throw new ClipsError("clips_unavailable", "Choosing clips is not configured", 503);
  for (let attempt = 0; ; attempt++) {
    const r = await (deps.fetch ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(300_000),
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
    model: env.STUDIO_CLIPS_MODEL || "claude-sonnet-5-5", max_tokens: 16000, system: CHOOSE_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: CHOOSE_SCHEMA } },
    messages: [{ role: "user", content: chooseMessage(input) }],
  }, "clips_choose", userId);
  return Array.isArray(out?.clips) ? out.clips : [];
}

// ---------------------------------------------------------------------------------------------------
// From Claude's picks to clean cuts: on word (or line) boundaries, inside the length range, no overlaps, best first
// ---------------------------------------------------------------------------------------------------
export type Moment = { rank: number; start: number; end: number; title: string; hook: string; why: string; score: number; tags: string[]; transcript: string };
export function finalizeMoments(raw: RawMoment[], lines: Line[], words: TimedWord[] | null, length: ClipLength, cap: number, minScore = CLIP_LIMITS.min_score): Moment[] {
  const len = CLIP_LENGTHS[length];
  const ordered = [...lines].sort((a, b) => a.i - b.i);
  const pos = new Map(ordered.map((l, k) => [l.i, k]));
  const cand: Moment[] = [];
  for (const r of raw) {
    const score = Math.round(Number(r?.score));
    if (!(score >= minScore)) continue;
    let s = pos.get(Number(r?.start_line)), e = pos.get(Number(r?.end_line));
    if (s == null || e == null) continue;
    if (e < s) [s, e] = [e, s];
    const span = (a: number, b: number) => ordered[b].end - ordered[a].start;
    while (span(s, e) < len.min && e + 1 < ordered.length && span(s, e + 1) <= len.max) e++;
    while (span(s, e) > len.max && e > s) e--;
    if (span(s, e) < len.min - 2 || span(s, e) > len.max + 2) continue;
    let start = ordered[s].start, end = ordered[e].end;
    if (words && ordered[s].w0 != null && ordered[e].w1 != null) {
      const w0 = ordered[s].w0!, w1 = ordered[e].w1!;
      const prevEnd = w0 > 0 ? words[w0 - 1].end : 0, nextStart = w1 + 1 < words.length ? words[w1 + 1].start : words[w1].end + 1;
      start = Math.max(prevEnd + 0.02, words[w0].start - 0.12);
      end = Math.min(nextStart - 0.04, words[w1].end + 0.3);
    } else {
      end = end + 0.2; // captions end a beat early
    }
    start = Math.max(0, start);
    const text = ordered.slice(s, e + 1).map((l) => l.text).join(" ");
    cand.push({ rank: 0, start: round2(start), end: round2(end), title: clean(r.title, 80) || clean(text, 60), hook: clean(r.hook, 140), why: clean(r.why, 120), score: Math.min(100, score), tags: (Array.isArray(r.tags) ? r.tags : []).map((t) => clean(t, 24).toLowerCase()).filter(Boolean).slice(0, 3), transcript: text.slice(0, 2000) });
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
const round2 = (x: number) => Math.round(x * 100) / 100;
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------------------------------------------
// Media: where the source is read from, and the commands
// ---------------------------------------------------------------------------------------------------
/** How ffmpeg reaches the source: one file (an upload's signed address) or YouTube's separate picture and sound. */
export type SourceInput = { video: string; audio: string | null; proxy: string | null; width: number; height: number; fps: number | null;
  /** a YouTube page: each stretch is fetched by yt-dlp (YouTube refuses its stream addresses to any other program) */
  youtube?: string | null };
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
// Framing: where the speaker is in each shot, from one still per shot
// ---------------------------------------------------------------------------------------------------
export type Subject = "one_person" | "two_people" | "group" | "screen" | "no_person";
export type FrameRead = { subject: Subject; x: number };
export const FRAME_SCHEMA = {
  type: "object", additionalProperties: false, required: ["frames"],
  properties: { frames: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "subject", "x"],
    properties: { n: { type: "integer" }, subject: { type: "string", enum: ["one_person", "two_people", "group", "screen", "no_person"] }, x: { type: "number" } } } } },
};
const FRAME_PROMPT = `These are stills from one video, numbered from 1. For each, say what a vertical 9:16 crop should keep.
subject: one_person (one person is the clear subject, even if others are partly visible), two_people (two people side by side, both matter), group (three or more), screen (a screen recording, slides, a game, text), no_person.
x: the horizontal centre of the main person's face (for one_person) or of the most important area otherwise, as a fraction of the image width from 0 (left edge) to 1 (right edge).
Answer for every still, in order.`;
export async function readFrames(deps: ClipsDeps, frames: Buffer[], userId?: string): Promise<FrameRead[]> {
  if (!frames.length) return [];
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_CLIPS_FRAME_MODEL || "claude-haiku-5-5", max_tokens: 2000, thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: FRAME_SCHEMA } },
    messages: [{ role: "user", content: [...frames.flatMap((b, k) => [{ type: "text", text: `Still ${k + 1}:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }]), { type: "text", text: FRAME_PROMPT }] }],
  }, "clips_frame", userId);
  const list: any[] = Array.isArray(out?.frames) ? out.frames : [];
  return frames.map((_, k) => {
    const f = list.find((x) => Number(x?.n) === k + 1) ?? list[k];
    const subject: Subject = ["one_person", "two_people", "group", "screen", "no_person"].includes(f?.subject) ? f.subject : "one_person";
    const x = Number(f?.x);
    return { subject, x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5 };
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
export type ShotPlan = { start: number; end: number; mode: "crop" | "fit"; x: number };
/** One shot's treatment: one person is followed by a crop; two people, a group, a screen or nobody are shown whole on a
 *  blurred fill (cutting them would lose half the picture). Neighbouring crops that barely move are held still. */
export function planShots(shots: Array<{ start: number; end: number }>, reads: FrameRead[]): ShotPlan[] {
  const out: ShotPlan[] = shots.map((s, k) => ({ ...s, mode: (reads[k]?.subject ?? "one_person") === "one_person" ? "crop" : "fit", x: reads[k]?.x ?? 0.5 }));
  for (let k = 1; k < out.length; k++) if (out[k].mode === "crop" && out[k - 1].mode === "crop" && Math.abs(out[k].x - out[k - 1].x) < 0.06) out[k].x = out[k - 1].x;
  return out;
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** The ffmpeg filter graph for one clip, from [0:v] to [v]. Vertical: 720x1280 by crop, blurred fill, or both by shot.
 *  Original: the source's shape, at most 1280 on the long side. Frame rate capped at 30. */
export function buildClipFilter(p: { w: number; h: number; format: ClipFormat; shots: ShotPlan[]; fps: number | null }): string {
  const fps = p.fps && p.fps > 30.5 ? ",fps=30" : "";
  const tail = `setsar=1${fps},format=yuv420p`;
  if (p.format === "original") return p.w >= p.h ? `[0:v]scale='min(1280,iw)':-2,${tail}[v]` : `[0:v]scale=-2:'min(1280,ih)',${tail}[v]`;
  if (p.h / p.w >= 1.7) return `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,${tail}[v]`;
  const cw = Math.min(even(p.w), even(p.h * 9 / 16));
  const xOf = (s: ShotPlan) => Math.max(0, Math.min(p.w - cw, even(s.x * p.w - cw / 2)));
  const crops = p.shots.filter((s) => s.mode === "crop");
  const fits = p.shots.filter((s) => s.mode === "fit");
  // x for every shot (a fit shot keeps its neighbour's x: it is covered anyway), as nested ifs on the frame's time
  let lastX = crops.length ? xOf(crops[0]) : even((p.w - cw) / 2);
  const xs = p.shots.map((s) => { if (s.mode === "crop") lastX = xOf(s); return lastX; });
  let expr = String(xs[xs.length - 1]);
  for (let k = p.shots.length - 2; k >= 0; k--) expr = `if(lt(t,${p.shots[k].end.toFixed(3)}),${xs[k]},${expr})`;
  const crop = (inp: string, out: string) => `${inp}crop=${cw}:${even(p.h)}:'${expr}':0,scale=720:1280${out}`;
  const fit = (a: string, b: string, out: string) => `${a}scale=180:320:force_original_aspect_ratio=increase,crop=180:320,boxblur=8:2,scale=720:1280,eq=brightness=-0.06[bg];${b}scale=720:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${out}`;
  if (!fits.length) return `${crop("[0:v]", "")},${tail}[v]`;
  if (!crops.length) return `[0:v]split=2[a][b];${fit("[a]", "[b]", "")},${tail}[v]`;
  const when = fits.map((s) => `between(t,${s.start.toFixed(3)},${(s.end - 0.001).toFixed(3)})`).join("+");
  return `[0:v]split=3[c][a][b];${crop("[c]", "[cv]")};${fit("[a]", "[b]", "[fv]")};[cv][fv]overlay=0:0:enable='${when}',${tail}[v]`;
}

// ---------------------------------------------------------------------------------------------------
// One clip: read the stretch once (exact cut), find its shots, frame it, render it, store it
// ---------------------------------------------------------------------------------------------------
export type CutCtx = { sb: SupabaseClient; deps: ClipsDeps; u: string; dir: string; src: SourceInput; format: ClipFormat; collectionId: string; sourceTitle: string | null; jobId: string };
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
  const err = await ffmpeg(["-v", "info", "-nostdin", "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { timeoutMs: 120_000 });
  return [...err.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t > 0);
}
export async function cutClip(ctx: CutCtx, m: Moment): Promise<CutResult> {
  const { sb, u, dir } = ctx;
  const mezz = join(dir, `m${m.rank}.mp4`), out = join(dir, `c${m.rank}.mp4`), still = join(dir, `p${m.rank}.jpg`);
  const seconds = m.end - m.start;
  // 1. the stretch, cut exactly, kept near-lossless at up to 1080 lines: from YouTube through yt-dlp (keyframes forced at
  //    the cuts), from an upload by seeking the signed address before and after the decoder
  if (ctx.src.youtube) await (ctx.deps.section ?? ((u, a, b, t) => youtubeSection(u, a, b, t, { env: ctx.deps.env, fetch: ctx.deps.fetch })))(ctx.src.youtube, m.start, m.end, mezz);
  else await ffmpeg(["-v", "error", "-nostdin", "-y", ...inputArgs(ctx.src, m.start, seconds), "-vf", "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)'",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-c:a", "aac", "-b:a", "192k", "-ac", "2", mezz], { timeoutMs: 8 * 60_000, proxy: ctx.src.proxy });
  const info = await probeLocal(mezz);
  const dur = info.seconds || seconds;
  // 2. framing: one still per shot, read by a small model; only needed when a wide picture becomes a tall one
  let plan: ShotPlan[] = [{ start: 0, end: dur, mode: "crop", x: 0.5 }];
  if (ctx.format === "vertical" && info.w / Math.max(1, info.h) > 0.75) {
    const cuts = await sceneCutsLocal(mezz).catch(() => [] as number[]);
    const shots = shotsFrom(cuts, dur);
    const frames: Buffer[] = [];
    for (let k = 0; k < shots.length; k++) {
      const f = join(dir, `f${m.rank}_${k}.jpg`);
      await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", ((shots[k].start + shots[k].end) / 2).toFixed(3), "-i", mezz, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", f], { timeoutMs: 60_000 });
      frames.push(await readFile(f));
    }
    const reads = await readFrames(ctx.deps, frames, u).catch((e) => { ctx.deps.log?.(`[clips] framing fell back to centre: ${String(e?.message ?? e).slice(0, 120)}`); return shots.map(() => ({ subject: "one_person" as Subject, x: 0.5 })); });
    plan = planShots(shots, reads);
  }
  // 3. the clip: framed, 720x1280 (or the original shape), loudness evened out, soft edges on the sound
  const graph = buildClipFilter({ w: info.w, h: info.h, format: ctx.format, shots: plan, fps: info.fps });
  const af = `afade=t=in:d=0.06,afade=t=out:st=${Math.max(0, dur - 0.12).toFixed(3)}:d=0.12`;
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart"];
  const render = (audio: string) => ffmpeg(["-v", "error", "-nostdin", "-y", "-i", mezz, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-af", audio, ...enc, out], { timeoutMs: 8 * 60_000 });
  await render(`loudnorm=I=-14:TP=-1.5:LRA=11,${af}`).catch(() => render(af));
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", Math.min(1, dur / 3).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", still], { timeoutMs: 60_000 });
  const final = await probeLocal(out);
  const bytes = (await stat(out)).size;
  const limit = await checkUpload(sb, u, bytes);
  if (limit) throw new ClipsError(limit.code, limit.message, limit.status);
  // 4. stored as an ordinary library video in the run's collection
  const id = randomUUID(), key = `${u}/${id}.mp4`, posterKey = `${u}/assets/${id}.jpg`;
  const up = await sb.storage.from("studio-uploads").upload(key, await readFile(out), { contentType: "video/mp4", upsert: false });
  if (up.error) throw new ClipsError("clip_store_failed", String(up.error.message ?? up.error), 502, true);
  const pu = await sb.storage.from("studio-outputs").upload(posterKey, await readFile(still), { contentType: "image/jpeg", upsert: true });
  const cuts = plan.length > 1 ? plan.slice(1).map((s) => round2(s.start)) : [];
  const name = `${m.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || `Clip ${m.rank}`}.mp4`;
  const ins = await sb.from("studio_assets").insert({
    id, user_id: u, kind: "video", name, object_key: key, bytes, status: "ready", collection_id: ctx.collectionId,
    probe: { duration: round2(final.seconds || dur), width: final.w, height: final.h, poster_key: pu.error ? undefined : posterKey, cuts, cuts_at: new Date().toISOString(),
      source: "clips", title: m.title, hook: m.hook, why: m.why, score: m.score, tags: m.tags, transcript: m.transcript,
      clip: { start: m.start, end: m.end, rank: m.rank, source_title: ctx.sourceTitle, job_id: ctx.jobId } },
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
const lengthOf = (v: unknown): ClipLength => (v === "short" || v === "long" ? v : "standard");
const formatOf = (v: unknown): ClipFormat => (v === "original" ? "original" : "vertical");
const youtubeUrl = (v: unknown): string | null => {
  try { const u = new URL(String(v ?? "").trim()); if (u.protocol !== "https:" && u.protocol !== "http:") return null; return /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname) && youtubeId(u.toString()) ? u.toString() : null; } catch { return null; }
};
/** Prices a run before it starts: the most it can cost (every possible clip made); the run is charged for what it makes. */
export async function quoteClips(deps: ClipsDeps, plans: PlanLike[], asset: { id: string; kind: string; name?: string | null; bytes?: number | null; probe?: any } | null, options: any): Promise<ClipsQuote> {
  const env = deps.env ?? process.env;
  const o = options && typeof options === "object" ? options : {};
  const length = lengthOf(o.length), format = formatOf(o.format), len = CLIP_LENGTHS[length];
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
  const max = maxClipsFor(seconds);
  const usd = clipsCostUsd({ seconds, platform, clips: max, clipSeconds: len.max, transcribe: platform === "upload" || !!env.ELEVENLABS_API_KEY, choose: true, env });
  const credits = clipsCredits(usd, plans);
  const minutes = Math.ceil(seconds / 60);
  // whether our servers can read YouTube's stream (a proxy or a signed-in cookie is set); without it the moments are still
  // chosen, then the person uploads the file to have them cut. The page says so before they start.
  const youtube_direct = platform !== "youtube" || !!env.STUDIO_YT_PROXY || !!env.STUDIO_YT_COOKIES;
  return { tool: "clips", credits, options: { platform, url, format, length, seconds: Math.round(seconds), minutes, max_clips: max, source, youtube_direct }, summary: `${minutes} min · up to ${max} clips` };
}
/** The re-run that cuts moments already chosen, from an uploaded copy of the same video: rendering only. */
export function quoteCut(plans: PlanLike[], clips: number, seconds: number): number {
  return clipsCredits(clipsCostUsd({ seconds, platform: "upload", clips, clipSeconds: 0, transcribe: false, choose: false, env: {} }), plans, 1);
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };
const planKey = (u: string, collectionId: string) => `${u}/clips/${collectionId}/plan.txt`;
async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new ClipsError("lease_lost", "lease lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}
async function signedSource(sb: SupabaseClient, u: string, assetId: string): Promise<SourceInput> {
  const a = await sb.from("studio_assets").select("object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready") throw new ClipsError("source_missing", "The video is no longer in the library", 409);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 6 * 3600);
  if (s.error || !s.data?.signedUrl) throw new ClipsError("source_missing", "The video could not be read", 502, true);
  return { video: s.data.signedUrl, audio: null, proxy: null, width: Number(a.data.probe?.width) || 0, height: Number(a.data.probe?.height) || 0, fps: null };
}
type Plan = { moments: Moment[]; seconds: number; transcribed: boolean; title: string | null };
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
      let lines: Line[] = [], words: TimedWord[] | null = null, transcribed = false;
      let meta: ChooseInput["meta"] = { title: o.source?.title ?? null, channel: o.source?.channel ?? null, description: "", chapters: [], replay: [] };
      let seconds = Number(o.seconds) || 0;
      const transcribe = async (src: SourceInput) => {
        await renew(sb, job, { stage: "transcribing", message: "Listening to the video" });
        const mp3 = join(dir!, "sound.mp3");
        await (deps.extractAudio ?? defaultExtractAudio)(src, mp3);
        words = await (deps.words ?? (async (audio) => (await transcribeWords({ env, fetch: deps.fetch }, { audio })).words))(await readFile(mp3));
        transcribed = true;
        lines = linesFromWords(words);
      };
      if (o.platform === "youtube") {
        const m = await (deps.meta ?? ((x) => youtubeMeta(deps, x)))(o.url);
        meta = { title: m.title, channel: m.channel, description: m.description, chapters: m.chapters, replay: m.replay };
        seconds = m.seconds ?? seconds;
        const segs = await (deps.transcript ?? ((x) => youtubeTranscript(deps, x)))(o.url);
        if (segs?.length) lines = linesFromSegments(segs);
        else {
          if (!env.ELEVENLABS_API_KEY) throw new ClipsError("clips_no_transcript", "That video has no captions to read; upload the file instead", 422);
          const sound = join(dir!, "youtube-sound");
          await (deps.ytAudio ?? ((u, t) => youtubeAudio(u, t, { env, fetch: deps.fetch })))(o.url, sound);
          await transcribe({ video: sound, audio: null, proxy: null, width: 0, height: 0, fps: null });
        }
      } else {
        await transcribe(await signedSource(sb, u, job.asset_id!));
      }
      if (!lines.length) throw new ClipsError("clips_no_speech", "Nobody speaks in this video, so there is nothing to choose clips from", 422);
      await renew(sb, job, { stage: "choosing", message: "Choosing the best moments" });
      const cap = Math.min(Number(o.max_clips) || maxClipsFor(seconds), maxClipsFor(seconds));
      const parts = windows(lines);
      const per = Math.max(4, Math.ceil(cap / parts.length) + 3);
      const picks: RawMoment[] = [];
      for (let k = 0; k < parts.length; k += 3) {
        const batch = await Promise.all(parts.slice(k, k + 3).map((w) => (deps.choose ?? ((x) => chooseWithClaude(deps, x, u)))({ lines: w, meta, length, wanted: per })));
        picks.push(...batch.flat());
      }
      const moments = finalizeMoments(picks, lines, words, length, cap);
      if (!moments.length) throw new ClipsError("clips_none_found", "No moment in this video stands on its own as a clip", 422);
      plan = { moments, seconds, transcribed, title: meta.title ?? o.source?.title ?? null };
      const up = await sb.storage.from("studio-outputs").upload(planKey(u, collectionId), Buffer.from(JSON.stringify(plan)), { contentType: "text/plain", upsert: true });
      if (up.error) log(`[clips] plan not saved ${job.id}: ${up.error.message}`);
    }
    const p = plan!;
    const todo = p.moments.filter((m) => !made.some((x) => x.rank === m.rank));
    await renew(sb, job, { collection_id: collectionId, stage: "cutting", done: made.length, total: p.moments.length, message: `Cutting clip ${made.length + 1} of ${p.moments.length}`, made });
    // B. The source for cutting: the upload (this run's, or the file given to finish a YouTube run), or YouTube's stream.
    let src: SourceInput;
    if (o.platform === "youtube" && !o.plan_from) {
      try {
        const st = await (deps.streams ?? ((x) => youtubeStreams(x, { env, fetch: deps.fetch })))(o.url);
        src = { video: st.video, audio: st.audio, proxy: st.proxy, width: st.width, height: st.height, fps: st.fps, youtube: o.url };
      } catch (e: any) {
        if (e instanceof LinkError && (e.code === "link_blocked" || e.code === "link_fetch_failed")) {
          // YouTube refused our servers: keep the chosen moments, charge for choosing only, ask for the file.
          const credits = clipsCredits(clipsCostUsd({ seconds: p.seconds, platform: "youtube", clips: 0, clipSeconds: 0, transcribe: p.transcribed, choose: true, env }), plans, 1);
          const note = `YouTube would not let our servers download this video. We picked ${p.moments.length} moments; upload the same video and we will cut them (choosing is already paid).`;
          await setCollection({ status: "needs_file", note });
          const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: Math.min(credits, job.credits_reserved) });
          if (done.error) throw done.error;
          log(`[clips] needs_file ${job.id} ${e.code}`);
          return "needs_file";
        }
        throw e;
      }
    } else src = await signedSource(sb, u, job.asset_id!);
    // C. Cut: two at a time (one reads from the network while the other renders).
    const ctx: CutCtx = { sb, deps, u, dir, src, format, collectionId, sourceTitle: p.title, jobId: job.id };
    let full: ClipsError | null = null, refreshed = false;
    const cutOne = async (m: Moment) => {
      for (let attempt = 0; ; attempt++) {
        try { return await (deps.cut ?? cutClip)(ctx, m); } catch (e: any) {
          if (e instanceof ClipsError && (e.code === "storage_full" || e.code === "too_many_files")) throw e;
          if (e instanceof ClipsError && e.code === "clip_source_refused" && o.platform === "youtube" && !o.plan_from && !refreshed) {
            refreshed = true; // the stream addresses expire after a few hours: ask for fresh ones once
            const st = await (deps.streams ?? ((x) => youtubeStreams(x, { env, fetch: deps.fetch })))(o.url);
            ctx.src = { video: st.video, audio: st.audio, proxy: st.proxy, width: st.width, height: st.height, fps: st.fps, youtube: o.url };
            continue;
          }
          if (attempt >= 1) throw e;
        }
      }
    };
    const queue = [...todo];
    const skipped: number[] = [];
    const worker = async () => {
      while (queue.length && !full) {
        const m = queue.shift()!;
        try {
          const r = await cutOne(m);
          made.push({ rank: m.rank, asset_id: r.asset_id, seconds: r.seconds });
          await renew(sb, job, { done: made.length, total: p.moments.length, message: made.length < p.moments.length ? `Cutting clip ${made.length + 1} of ${p.moments.length}` : "Finishing", made });
        } catch (e: any) {
          if (e instanceof ClipsError && (e.code === "storage_full" || e.code === "too_many_files")) { full = e; break; }
          if (e instanceof ClipsError && e.code === "lease_lost") throw e;
          skipped.push(m.rank);
          log(`[clips] clip ${m.rank} of ${job.id} skipped: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (!made.length) throw new ClipsError(full ? (full as ClipsError).code : "clips_cut_failed", full ? (full as ClipsError).message : "None of the clips could be cut", full ? 409 : 502, !full);
    // D. Settle on what was made.
    const avg = made.reduce((s, x) => s + x.seconds, 0) / made.length;
    const usd = clipsCostUsd({ seconds: p.seconds, platform: o.platform === "youtube" && !o.plan_from ? "youtube" : "upload", clips: made.length, clipSeconds: avg, transcribe: !o.plan_from && p.transcribed, choose: !o.plan_from, env });
    const credits = Math.min(job.credits_reserved, clipsCredits(usd, plans, o.plan_from ? 1 : CLIP_LIMITS.min_credits));
    const note = full ? `${made.length} of ${p.moments.length} clips made: ${(full as ClipsError).message}` : skipped.length ? `${made.length} clips made; ${skipped.length} could not be cut.` : null;
    await setCollection({ status: "ready", note });
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: credits });
    if (done.error) throw done.error;
    recordEvent({ user_id: u, kind: "feature", name: "clips_done", props: { job: job.id, platform: o.platform, clips: made.length, planned: p.moments.length, minutes: Math.round(p.seconds / 60), credits } });
    return "done";
  } catch (e: any) {
    const code = e instanceof ClipsError ? e.code : e instanceof LinkError ? e.code : "clips_failed";
    if (code === "lease_lost") return "lease_lost";
    const retry = e instanceof ClipsError ? e.retry : !(e instanceof LinkError);
    const last = !retry || (job.attempts ?? 1) >= 3;
    log(`[clips] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 240) })}`);
    if (last) await setCollection({ status: made.length ? "ready" : "failed", note: made.length ? `${made.length} clips made before it stopped: ${String(e?.message ?? code).slice(0, 160)}` : String(e?.message ?? "It could not be finished").slice(0, 240) });
    // Some clips already in the library on a final failure: charge for those, refund the rest; otherwise fail (refund all).
    if (last && made.length) {
      const avg = made.reduce((s, x) => s + x.seconds, 0) / made.length;
      const credits = Math.min(job.credits_reserved, clipsCredits(clipsCostUsd({ seconds: plan?.seconds ?? 0, platform: o.platform === "youtube" ? "youtube" : "upload", clips: made.length, clipSeconds: avg, transcribe: !!plan?.transcribed, choose: !o.plan_from, env }), plans, 1));
      await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: credits });
      return "partial";
    }
    await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_error: code, p_retry: retry });
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
