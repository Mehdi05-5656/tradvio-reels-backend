// Captions written from the video itself: a handful of frames (what is on screen) and the speech (what is said), read
// by Claude, which answers in a fixed JSON shape: the caption, a few hashtags and, when YouTube is in the mix, a title.
// Used by the Publish page and the chat's publish card; the person can always write their own instead.
// Raw HTTP to the Messages API like the assistant (studio-assistant.ts), so tests can swap fetch.
import { recordScribe } from "./studio-stt.js";
import { logClaudeCost } from "./studio-pricing.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { probeSeconds } from "./studio-recast.js";
import { extractAudio, transcribe } from "./studio-eleven.js";
import { SocialError } from "./social-provider.js";
import { testWinners } from "./studio-caption-tests.js";

export const CAPTION_MODEL = "claude-opus-5-5";
/** Writing from a saved note (no frames): text only, so a smaller model does it (Nov 23 2026). */
export const CAPTION_TEXT_MODEL = "claude-sonnet-5-5";
const FRAMES = 5, PER_HOUR = 300; // "Write all" on a batch of uploads, then re-writes from the saved notes

/** A video the person can post: one of their uploads, or one output of a finished job. */
export type VideoRef = { asset_id?: string; job_id?: string; output_key?: string };
/** The key a video's note is kept under: "a:<asset id>" or "j:<job id>:<output key>". */
export const videoKey = (r: VideoRef) => (r.asset_id ? `a:${r.asset_id}` : `j:${r.job_id ?? ""}:${r.output_key ?? ""}`);
/** What is in a video, written once by the model that watched it (frames + speech) and kept (studio_video_notes), so
 *  every later caption, variant or per-account version is written from it without watching again (owner, Nov 23 2026). */
export type VideoNote = { summary: string; moments: string[]; on_screen_text: string[]; speech: string | null; tone: string; people: string; searched: string[] };
/** How a caption is asked for. "auto": from the saved note when there is one, else watch (paid); "never": only from the
 *  note or the creator's line (free; refused when neither is there); "always": watch again. */
export type WatchMode = "auto" | "never" | "always";
export type DraftRequest = VideoRef & {
  platforms: string[]; note?: string | null; variants?: number; watch?: WatchMode;
  /** the creator's own line to work into every version (e.g. 'Comment "clone8" and I'll send you the link') */
  line?: string | null;
  /** the line word for word (true) or said fresh each time, its keyword kept exactly (false) */
  keep_words?: boolean;
  /** captions already given to other posts of the batch: open differently */
  avoid?: string[];
  /** a different version for each of these accounts (2+ on one network) */
  accounts?: Array<{ id: string; platform: string; handle?: string | null }>;
  /** false: write from the creator's line alone, never from the video (no note needed, nothing watched) */
  use_video?: boolean;
};
const NAMES: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube Shorts", facebook: "Facebook", twitter: "X", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky" };

/** A drafted caption. `versions` are per network (TikTok short, Instagram fuller); `keywords` are the searched words
 *  it opens with and where they come from in the video; `reasons` are short "why this caption" lines; `voice_from` is
 *  how many of the person's own best posts set the voice; `tags` carries what their own posts say about each hashtag. */
export type CaptionDraft = {
  caption: string; hashtags: string[]; youtube_title: string | null; heard_speech: boolean;
  versions?: Array<{ platform: string; caption: string; hashtags: string[] }>;
  keywords?: Array<{ word: string; from: "said" | "shown" }>;
  reasons?: string[]; voice_from?: number;
  tags?: Array<{ tag: string; multiple: number | null; posts: number }>;
  /** other captions for an Instagram caption test (each opens with a different hook), when asked */
  alternatives?: string[];
  /** true when this draft watched the video (paid); false when it was written from the saved note or the line */
  watched?: boolean;
  /** one version per account asked for (each different), when 2+ accounts share a network */
  by_account?: Array<{ id: string; platform: string; caption: string; hashtags: string[] }>;
  /** the comment keyword the creator's line asks for, kept in every version (for auto-reply) */
  keyword?: string | null;
};
export type CaptionDeps = {
  env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void;
  /** test seams: frames (base64 JPEGs) and the speech of a local video file */
  frames?: (video: string) => Promise<string[]>; speech?: (video: string) => Promise<string | null>;
  /** test seam: the person's caption-test winners */
  winners?: (sb: SupabaseClient, u: string) => Promise<Array<{ caption: string; beat: string; lead: number | null }>>;
};

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["caption", "hashtags", "youtube_title", "keywords", "versions", "reasons", "alternatives"],
  properties: {
    caption: { type: "string", description: "The main post text, without the hashtags (the TikTok one when TikTok is a target)" },
    hashtags: { type: "array", items: { type: "string" }, description: "3 to 5 specific hashtags, each starting with #" },
    youtube_title: { anyOf: [{ type: "string" }, { type: "null" }], description: "A YouTube title of at most 80 characters, or null when YouTube is not a target" },
    keywords: { type: "array", items: { type: "object", additionalProperties: false, required: ["word", "from"], properties: { word: { type: "string" }, from: { type: "string", enum: ["said", "shown"] } } }, description: "1 to 3 words or short phrases someone would search to find this video, taken from what is said or shown in it" },
    versions: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "caption", "hashtags"], properties: { platform: { type: "string" }, caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } } }, description: "One version per target network (only those listed), each fitted to it" },
    reasons: { type: "array", items: { type: "string" }, description: "2 to 4 very short reasons for the choices, each under 60 characters, plain words" },
    alternatives: { type: "array", items: { type: "string" }, description: "Only when a caption test is asked for: the other Instagram captions, each opening with a clearly different hook; otherwise empty" },
  },
};

const SYSTEM = `You write captions for short-form videos that a creator is about to post. You are shown frames from the video, in order, and what is said in it.
Write like a person posting their own video, not like a brand or an announcer. What the platforms and large studies show (2025-2026), which you follow:
- Search is how people find videos now (TikTok search keywords, Instagram posts indexed by Google). Pick 1 to 3 words or short phrases someone would actually search for this video, taken from what is SAID or SHOWN in it, and put the main one naturally in the first line. Never keyword-stuff.
- The first line is the hook: specific to this video, no clickbait the video does not deliver.
- TikTok: short. Aim under 100 characters before the hashtags; very short captions do best there. Instagram: can be fuller (one to three short lines) and keyword-rich, since Google indexes it. YouTube: the title carries the searched words.
- Hashtags label the topic; they are not a reach lever. Give 3 to 5 specific ones (Instagram allows at most 5), lowercase unless a proper noun, no spaces. Never #fyp, #foryou, #viral, #explore or other generic tags.
- No question to the viewer unless the creator's own posts show questions work for them (a question raises comments, not views). No emoji walls; use emoji only if the creator's own captions do.
- Use the language that is spoken in the video; English when nobody speaks.
- Never invent facts, names, prices or claims that the frames or the speech do not show. Never mention how the video was made, AI, editing tools or any company behind them.
- When YouTube is a target, give a title of at most 80 characters; otherwise youtube_title is null.
- versions: one per target network listed, each fitted to that network as above; caption and hashtags at the top level are the TikTok version when TikTok is a target, else the first network's.
- reasons: 2 to 4 short lines saying why (e.g. "Opens on 'japan kitkat', said at the start", "Short: TikTok favours under 100 characters", "Your voice: lowercase, no emoji").
When the creator's best captions are given, match their voice (length, tone, casing, emoji) without copying them. Follow the creator's note when there is one.`;

/** The person's own best posts (top by views against their own account's median, last 120 days) and what their posts
 *  say about each hashtag: the voice and the evidence a caption is written with. Empty for a new account. */
export async function captionContext(sb: SupabaseClient, u: string, platforms: string[]): Promise<{ voice: string[]; tags: Array<{ tag: string; multiple: number | null; posts: number }>; questionsHelp: boolean | null }> {
  const r = await sb.from("studio_perf_posts").select("platform,account_key,caption,views,comments,published_at").eq("user_id", u).gte("published_at", new Date(Date.now() - 120 * 86400_000).toISOString()).limit(400);
  // YouTube's numbers stay raw (its API terms), so its posts never feed a multiple
  const rows = ((r.data ?? []) as any[]).filter((x) => x.views != null && x.platform !== "youtube" && (!platforms.length || platforms.includes(x.platform)));
  if (rows.length < 6) return { voice: [], tags: [], questionsHelp: null };
  const med = new Map<string, number>();
  for (const k of new Set(rows.map((x) => `${x.platform}|${x.account_key ?? ""}`))) {
    const v = rows.filter((x) => `${x.platform}|${x.account_key ?? ""}` === k).map((x) => Number(x.views)).sort((a, b) => a - b);
    med.set(k, v[Math.floor(v.length / 2)] || 1);
  }
  const mult = (x: any) => Number(x.views) / (med.get(`${x.platform}|${x.account_key ?? ""}`) || 1);
  const ranked = rows.filter((x) => (x.caption ?? "").trim()).sort((a, b) => mult(b) - mult(a));
  const voice = ranked.slice(0, Math.max(3, Math.floor(ranked.length / 4))).slice(0, 8).map((x) => String(x.caption).slice(0, 300));
  // each hashtag: the median multiple of the posts that carried it (3 posts at least, or it says nothing)
  const by = new Map<string, number[]>();
  for (const x of rows) for (const t of new Set((String(x.caption ?? "").match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))) by.set(t, [...(by.get(t) ?? []), mult(x)]);
  const tags = [...by.entries()].filter(([, xs]) => xs.length >= 3).map(([tag, xs]) => { const s2 = [...xs].sort((a, b) => a - b); return { tag, multiple: Math.round(s2[Math.floor(s2.length / 2)] * 100) / 100, posts: xs.length }; }).sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0)).slice(0, 20);
  // do their questions earn comments? (comments per view, posts with a question vs without; 4 of each at least)
  const q = rows.filter((x) => /\?/.test(String(x.caption ?? ""))), nq = rows.filter((x) => !/\?/.test(String(x.caption ?? "")));
  const cpv = (xs: any[]) => { const v = xs.map((x) => (Number(x.comments) || 0) / Math.max(1, Number(x.views))).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? 0; };
  const questionsHelp = q.length >= 4 && nq.length >= 4 ? cpv(q) > cpv(nq) * 1.2 : null;
  return { voice, tags, questionsHelp };
}

/** Hashtags as posted: '#' plus the tag, no spaces, never the generic reach-bait ones, at most 5 (Instagram's cap). */
const GENERIC = new Set(["#fyp", "#foryou", "#foryoupage", "#viral", "#explore", "#explorepage", "#trending", "#fypシ", "#reels", "#xyzbca"]);
export function cleanTags(raw: any, _platform: string): string[] {
  const out = (Array.isArray(raw) ? raw : []).map((h: any) => `#${String(h).replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h: string) => h.length > 1 && !GENERIC.has(h.toLowerCase()));
  return [...new Set(out)].slice(0, 5);
}

const hourly = new Map<string, number[]>();
/** Thirty drafts an hour per person: generous for real use, a wall against a loop. */
export function allowCaption(u: string, now = Date.now()): boolean {
  const recent = (hourly.get(u) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PER_HOUR) { hourly.set(u, recent); return false; }
  recent.push(now); hourly.set(u, recent); return true;
}

/** FRAMES evenly spaced JPEGs (512 px wide) from a local video, as base64. */
export async function videoFrames(video: string): Promise<string[]> {
  const seconds = await probeSeconds(video).catch(() => 0);
  const dir = await mkdtemp(join(tmpdir(), "c8-frames-"));
  try {
    const out: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      const at = seconds > 0 ? Math.max(0, seconds * (i + 0.5) / FRAMES) : i;
      const f = join(dir, `f${i}.jpg`);
      await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", f], undefined, 60_000).catch(() => undefined);
      const b = await readFile(f).catch(() => null);
      if (b && b.length) out.push(b.toString("base64"));
    }
    return out;
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** What is said in a local video, through the speech-to-text the audio instruments use; null without a key or speech. */
export function speechOf(env: Record<string, string | undefined>, fetchFn?: typeof fetch) {
  return async (video: string): Promise<string | null> => {
    if (!env.ELEVENLABS_API_KEY) return null;
    const dir = await mkdtemp(join(tmpdir(), "c8-speech-"));
    try {
      const wav = join(dir, "a.wav");
      await extractAudio(video, wav);
      const t = await transcribe({ env, fetch: fetchFn }, { audio: await readFile(wav), diarize: false });
      // the cost ledger (audit Nov 24 2026): extractAudio writes 44.1 kHz mono 16-bit wav, 88,200 bytes a second
      recordScribe({ userId: null, seconds: Math.round((await stat(wav)).size / 88_200), use: "caption_writer" });
      const text = String(t.text ?? "").trim();
      return text ? text.slice(0, 4000) : null;
    } catch { return null; } // a silent clip, or no audio track: the frames still carry it
    finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  };
}

/** Where a video lives (bucket and object key), checked to be the person's and a video. */
export async function resolveVideo(sb: SupabaseClient, u: string, ref: VideoRef): Promise<{ bucket: string; objectKey: string }> {
  if (ref.asset_id) {
    const a = await sb.from("studio_assets").select("id,kind,status,object_key").eq("id", ref.asset_id).eq("user_id", u).maybeSingle();
    if (a.error) throw a.error;
    if (!a.data || a.data.status !== "ready") throw new SocialError("video_not_found", "That video is gone", 404);
    if (a.data.kind !== "video") throw new SocialError("not_a_video", "Captions are written for videos");
    return { bucket: "studio-uploads", objectKey: a.data.object_key };
  }
  const j = await sb.from("studio_jobs").select("id,status,outputs").eq("id", ref.job_id ?? "").eq("user_id", u).maybeSingle();
  if (j.error) throw j.error;
  const out = j.data?.status === "done" ? ((j.data.outputs ?? []) as any[]).find((o) => o.key === ref.output_key) : null;
  if (!out) throw new SocialError("video_not_found", "That video is gone", 404);
  if (out.kind && out.kind !== "video") throw new SocialError("not_a_video", "Captions are written for videos");
  return { bucket: "studio-outputs", objectKey: out.key };
}

/** The saved note of a video, or null (never watched, or the table not there yet). */
export async function readNote(sb: SupabaseClient, u: string, key: string): Promise<VideoNote | null> {
  const r = await sb.from("studio_video_notes").select("note").eq("user_id", u).eq("video", key).maybeSingle();
  if (r.error || !r.data?.note) return null;
  return r.data.note as VideoNote;
}
/** Which of these videos have a saved note (one query). */
export async function notedKeys(sb: SupabaseClient, u: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await sb.from("studio_video_notes").select("video").eq("user_id", u).in("video", keys);
  return new Set(((r.data ?? []) as any[]).map((x) => String(x.video)));
}
async function saveNote(sb: SupabaseClient, u: string, key: string, note: VideoNote, model: string, log: (s: string) => void) {
  const r = await Promise.resolve(sb.from("studio_video_notes").upsert({ user_id: u, video: key, note, model, created_at: new Date().toISOString() }, { onConflict: "user_id,video" })).catch((e: any) => ({ error: e }));
  if (r.error) log(`[captions] note not saved for ${key}: ${String(r.error.message ?? r.error).slice(0, 160)}`); // the caption still stands; the next write watches again
}

const STOP = new Set(["below", "down", "here", "it", "this", "that", "and", "your", "a", "an", "the", "me", "us", "now", "for", "to", "in", "on"]);
/** The word a viewer is asked to comment (or DM / type) in the creator's line: 'Comment "clone8" and I'll send you the
 *  link' -> clone8. Null when the line asks for no word. */
export function lineKeyword(line: string | null | undefined): string | null {
  const t = String(line ?? "");
  const m = t.match(/\b(?:comment|type|reply|dm|say|write|drop)(?:\s+(?:me|us|the\s+word))?\s*[:\-]?\s*["“'‘]?([\p{L}\p{N}_-]{2,30})["”'’]?/iu);
  if (m && !STOP.has(m[1].toLowerCase())) return m[1];
  const q = t.match(/["“]([\p{L}\p{N}_-]{2,30})["”]/u);
  return q && !STOP.has(q[1].toLowerCase()) ? q[1] : null;
}
/** Every version keeps the creator's line: word for word, or at least its keyword; when the writer dropped it, the line
 *  is added on its own line at the end (never a post without the call to action the person asked for). */
export function keepLine(caption: string, line: string | null | undefined, keep: boolean, keyword: string | null, max = 2200): string {
  const l = String(line ?? "").trim();
  const c = caption.slice(0, max);
  if (!l) return c;
  // the line is added in full: the caption gives way, never the call to action
  const add = () => `${caption.trim().slice(0, Math.max(0, max - l.length - 2)).trim()}\n\n${l}`.trim();
  if (keep) return caption.includes(l) && caption.length <= max ? caption : add();
  // the comment word as a whole word ("LINK" is not kept by "link in bio" ... unless it is the word itself)
  if (keyword && !asksFor(caption, keyword)) return add();
  return c;
}
/** The caption still asks viewers for the word: it is quoted, or written in its own capitals, or comes right after
 *  comment / type / DM / reply / say / drop / write. ("link in bio" does not ask anyone to comment LINK.) */
export function asksFor(text: string, word: string): boolean {
  if (!hasWord(text, word)) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`["“'‘]${esc}["”'’]`, "iu").test(text)) return true;
  if (/\p{Lu}/u.test(word) && new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "u").test(text)) return true;
  return new RegExp(`\\b(comment|type|dm|reply|say|drop|write)\\b[^.\\n]{0,24}?(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}
/** `word` stands on its own in `text` (any case): not part of a longer word. */
export function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

const SEEN = {
  type: "object", additionalProperties: false, required: ["summary", "moments", "on_screen_text", "tone", "people", "searched"],
  description: "Notes on what is in the video, for writing more captions later without watching it again. Plain facts only.",
  properties: {
    summary: { type: "string", description: "Two or three sentences: what happens in the video, start to end" },
    moments: { type: "array", items: { type: "string" }, description: "3 to 6 short lines, in order: what is shown or happens" },
    on_screen_text: { type: "array", items: { type: "string" }, description: "Words written on screen, if any" },
    tone: { type: "string", description: "A few words: funny, calm, shocking, how-to..." },
    people: { type: "string", description: "Who is in it, as seen (e.g. 'one man talking to camera', 'no people, gameplay'); never guess names" },
    searched: { type: "array", items: { type: "string" }, description: "3 to 5 words or phrases someone would search to find it" },
  },
};
function schemaFor(o: { watch: boolean; accounts: boolean }) {
  const props: any = { ...SCHEMA.properties };
  const req = [...SCHEMA.required];
  if (o.watch) { props.seen = SEEN; req.push("seen"); }
  if (o.accounts) {
    props.by_account = { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "caption", "hashtags"], properties: { id: { type: "string" }, caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } } }, description: "One version per account listed, each clearly different from the others (first line and wording), each fitted to its account's network" };
    req.push("by_account");
  }
  return { ...SCHEMA, properties: props, required: req };
}
const noteText = (n: VideoNote) => [
  `Notes on the video (written by someone who watched it; you are not shown it):`,
  `Summary: ${n.summary}`,
  n.moments?.length ? `In order:\n${n.moments.map((m) => `- ${m}`).join("\n")}` : "",
  n.on_screen_text?.length ? `On-screen text: ${n.on_screen_text.join(" / ")}` : "",
  n.speech ? `What is said:\n"""${n.speech}"""` : "Nobody speaks in it (or the sound is music only).",
  n.tone ? `Tone: ${n.tone}` : "", n.people ? `People: ${n.people}` : "",
  n.searched?.length ? `Searched words that fit: ${n.searched.join(", ")}` : "",
].filter(Boolean).join("\n");

/** Draft a caption for one of the person's videos. Throws SocialError for anything the person should read.
 *  Watching (frames + speech, the paid step) happens only when there is no saved note or `watch` is "always"; every
 *  other draft is written from the note, or from the creator's line alone when `use_video` is false. */
export async function draftCaption(sb: SupabaseClient, u: string, req: DraftRequest, deps: CaptionDeps = {}): Promise<CaptionDraft> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, log = deps.log ?? console.log;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new SocialError("captions_off", "Caption writing is not switched on", 503);
  const where = await resolveVideo(sb, u, req);
  const key = videoKey(req), mode: WatchMode = req.watch ?? "auto";
  const line = String(req.line ?? "").trim().slice(0, 300) || null;
  const lineOnly = req.use_video === false;
  if (lineOnly && !line) throw new SocialError("line_needed", "Give the line to work in", 400);
  const saved = lineOnly || mode === "always" ? null : await readNote(sb, u, key);
  const watch = !lineOnly && (mode === "always" || (!saved && mode === "auto"));
  if (!lineOnly && !watch && !saved) throw new SocialError("watch_needed", "This video has not been watched yet; writing from it costs credits", 402);
  if (!allowCaption(u)) throw new SocialError("caption_rate_limited", "That is a lot of captions for one hour; write this one by hand or try again soon", 429);

  const platforms = req.platforms;
  const accounts = (req.accounts ?? []).filter((a) => a && a.id && platforms.includes(a.platform)).slice(0, 12);
  const keyword = lineKeyword(line);
  const targets = platforms.map((p) => NAMES[p] ?? p).join(", ") || "TikTok, Instagram Reels";
  const ctx = await captionContext(sb, u, platforms).catch(() => ({ voice: [] as string[], tags: [] as Array<{ tag: string; multiple: number | null; posts: number }>, questionsHelp: null as boolean | null }));
  const won = await (deps.winners ?? testWinners)(sb, u);
  const variants = Math.min(Math.max(Math.floor(Number(req.variants) || 0), 0), 3);
  const avoid = (req.avoid ?? []).map((x) => String(x).trim().split("\n")[0].slice(0, 160)).filter(Boolean).slice(0, 12);

  let frames: string[] = [], speech: string | null = null;
  const dir = watch ? await mkdtemp(join(tmpdir(), "c8-caption-")) : null;
  try {
    if (watch && dir) {
      const s = await sb.storage.from(where.bucket).createSignedUrl(where.objectKey, 600);
      if (s.error || !s.data?.signedUrl) throw new SocialError("video_unavailable", "That video could not be read", 502);
      const file = join(dir, "v.mp4");
      const dl = await f(s.data.signedUrl, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
      if (!dl?.ok) throw new SocialError("video_unavailable", "That video could not be read", 502);
      if (Number(dl.headers.get("content-length") ?? 0) > 500_000_000) throw new SocialError("video_too_large", "That video is too large to write a caption from", 413);
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length > 500_000_000) throw new SocialError("video_too_large", "That video is too large to write a caption from", 413);
      await writeFile(file, buf);
      [frames, speech] = await Promise.all([(deps.frames ?? videoFrames)(file), (deps.speech ?? speechOf(env, f))(file)]);
      if (!frames.length) throw new SocialError("video_unreadable", "No frames could be read from that video", 422);
    }
    const about = watch
      ? (speech ? `What is said in the video:\n"""${speech}"""` : "Nobody speaks in this video (or the sound is music only).")
      : saved ? noteText(saved)
      : "You are not shown the video and know nothing about it beyond the creator's line. Do not describe or invent what happens in it; keywords may be empty.";
    const text = [
      `Posting to: ${targets}. Target network ids for versions: ${(platforms.length ? platforms : ["tiktok", "instagram"]).join(", ")}.`,
      about,
      ctx.voice.length ? `The creator's best-performing captions (their voice; do not copy):\n${ctx.voice.map((v) => `- ${v.replace(/\n+/g, " / ")}`).join("\n")}` : "",
      ctx.tags.length ? `Hashtags on the creator's own posts, with the median views multiple of posts that used them (1.0 = their normal): ${ctx.tags.map((t) => `${t.tag} ${t.multiple}x (${t.posts} posts)`).join(", ")}. Prefer their strong ones when they fit this video; never use a weak one just because it is theirs.` : "",
      ctx.questionsHelp === true ? "Questions in their captions earn them more comments: one short question is fine." : ctx.questionsHelp === false ? "Questions in their captions do not earn them more comments: no question." : "",
      won.length ? `Captions that won the creator's own caption tests (same video posted as Instagram Trial Reels with different captions; the strongest evidence of what their audience responds to):\n${won.map((w) => `- "${w.caption.replace(/\n+/g, " / ")}" beat "${w.beat.replace(/\n+/g, " / ")}"${w.lead ? ` (${w.lead}x the views)` : ""}`).join("\n")}` : "",
      line ? (req.keep_words
        ? `The creator's line, to appear WORD FOR WORD in every version (caption, versions${accounts.length ? ", by_account" : ""}): """${line}""". Write the rest of the caption around it; put it where it reads best (usually the last line).`
        : `The creator's line, to be said in every version but in fresh words each time (no two versions alike): """${line}""".${keyword ? ` The word "${keyword}" is what viewers must type: keep it exactly as written, in quotes, in every version.` : ""} Keep its meaning and promise; never add a promise it does not make.`) : "",
      line ? "On TikTok the whole caption stays short; the line may be most of it." : "",
      avoid.length ? `Other posts in this batch already open like this; open differently and do not reuse their wording:\n${avoid.map((a) => `- ${a}`).join("\n")}` : "",
      accounts.length ? `by_account: one version for each of these accounts, each clearly different from the others (first line and wording; same facts${keyword ? ` and the same keyword "${keyword}"` : ""}), fitted to its network: ${accounts.map((a) => `${a.id} (${NAMES[a.platform] ?? a.platform}${a.handle ? `, ${a.handle}` : ""})`).join("; ")}.` : "",
      variants >= 2 ? `This is for a caption test: the Instagram caption plus ${variants - 1} alternative${variants > 2 ? "s" : ""} in "alternatives", each opening with a clearly different hook (a different first line and angle), same rules and keywords. The test shows which one people watch.` : "",
      req.note ? `The creator's note: ${String(req.note).slice(0, 300)}` : "",
      watch ? "Also fill \"seen\": plain notes on what is in the video, for writing more captions later." : "",
    ].filter(Boolean).join("\n\n");
    const model = watch ? (env.STUDIO_CAPTION_MODEL || CAPTION_MODEL) : (env.STUDIO_CAPTION_TEXT_MODEL || CAPTION_TEXT_MODEL);
    const system = watch ? SYSTEM : SYSTEM.replace("You are shown frames from the video, in order, and what is said in it.", "You are not shown the video: you are given notes on what is in it (or only the creator's line).");
    const r = await f("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({
        model, max_tokens: accounts.length ? 6000 : 4000, system, fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: schemaFor({ watch, accounts: accounts.length > 0 }) } },
        messages: [{ role: "user", content: [...frames.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })), { type: "text", text }] }],
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => { throw new SocialError("captions_unavailable", "The caption writer did not answer; write it by hand or try again", 503); });
    if (!r.ok) { log(`[captions] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); throw new SocialError("captions_unavailable", "The caption writer did not answer; write it by hand or try again", 503); }
    const body: any = await r.json();
    logClaudeCost(deps.log, watch ? "caption" : "caption_text", String(body?.model ?? model), body?.usage, u);
    if (body?.stop_reason === "refusal") throw new SocialError("caption_refused", "No caption could be written for that video; write it by hand", 422);
    const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new SocialError("captions_unavailable", "The caption came back unreadable; try again", 502); }
    if (watch && parsed.seen && typeof parsed.seen === "object") {
      const sn = parsed.seen, list = (x: any, n: number) => (Array.isArray(x) ? x : []).map((v: any) => String(v ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, n);
      await saveNote(sb, u, key, { summary: String(sn.summary ?? "").slice(0, 800), moments: list(sn.moments, 8), on_screen_text: list(sn.on_screen_text, 8), speech, tone: String(sn.tone ?? "").slice(0, 80), people: String(sn.people ?? "").slice(0, 160), searched: list(sn.searched, 6) }, model, log);
    }
    const fit = (c: string) => keepLine(c, line, !!req.keep_words, keyword, 2200);
    const title = platforms.includes("youtube") && parsed.youtube_title ? Array.from(String(parsed.youtube_title)).slice(0, 100).join("") : null;
    const versions = (Array.isArray(parsed.versions) ? parsed.versions : []).filter((v: any) => v && platforms.includes(String(v.platform))).map((v: any) => ({ platform: String(v.platform), caption: fit(String(v.caption ?? "").trim().slice(0, 2000)), hashtags: cleanTags(v.hashtags, String(v.platform)) })).filter((v: any, i: number, a: any[]) => v.caption && a.findIndex((x) => x.platform === v.platform) === i);
    const byAcct = accounts.length ? (Array.isArray(parsed.by_account) ? parsed.by_account : []).map((x: any) => { const a = accounts.find((y) => y.id === String(x?.id)); return a ? { id: a.id, platform: a.platform, caption: fit(String(x.caption ?? "").trim().slice(0, 2000)), hashtags: cleanTags(x.hashtags, a.platform) } : null; }).filter((x: any, i: number, all: any[]) => x && x.caption && all.findIndex((y) => y?.id === x.id) === i) : undefined;
    const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : []).map((k: any) => ({ word: String(k?.word ?? "").trim().slice(0, 40), from: k?.from === "shown" ? "shown" as const : "said" as const })).filter((k: any) => k.word).slice(0, 3);
    const reasons = (Array.isArray(parsed.reasons) ? parsed.reasons : []).map((r: any) => String(r).trim().slice(0, 80)).filter(Boolean).slice(0, 4);
    const tagsUsed = new Set([...cleanTags(parsed.hashtags, platforms[0] ?? "tiktok"), ...versions.flatMap((v: any) => v.hashtags)].map((t) => t.toLowerCase()));
    return { caption: fit(String(parsed.caption ?? "").trim().slice(0, 2000)), hashtags: cleanTags(parsed.hashtags, platforms.includes("instagram") && platforms.length === 1 ? "instagram" : platforms[0] ?? "tiktok"), youtube_title: title, heard_speech: watch ? !!speech : !!saved?.speech,
      versions, keywords, reasons, voice_from: ctx.voice.length, tags: ctx.tags.filter((t) => tagsUsed.has(t.tag)), watched: watch, keyword,
      ...(byAcct ? { by_account: byAcct } : {}),
      ...(variants >= 2 ? { alternatives: (Array.isArray(parsed.alternatives) ? parsed.alternatives : []).map((x: any) => fit(String(x ?? "").trim().slice(0, 2000))).filter(Boolean).slice(0, variants - 1) } : {}) };
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
