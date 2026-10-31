// Captions written from the video itself: a handful of frames (what is on screen) and the speech (what is said), read
// by Claude, which answers in a fixed JSON shape: the caption, a few hashtags and, when YouTube is in the mix, a title.
// Used by the Publish page and the chat's publish card; the person can always write their own instead.
// Raw HTTP to the Messages API like the assistant (studio-assistant.ts), so tests can swap fetch.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { probeSeconds } from "./studio-recast.js";
import { extractAudio, transcribe } from "./studio-eleven.js";
import { SocialError } from "./social-provider.js";

export const CAPTION_MODEL = "claude-opus-5-5";
const FRAMES = 5, PER_HOUR = 30;
const NAMES: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube Shorts", facebook: "Facebook", twitter: "X", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky" };

export type CaptionDraft = { caption: string; hashtags: string[]; youtube_title: string | null; heard_speech: boolean };
export type CaptionDeps = {
  env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void;
  /** test seams: frames (base64 JPEGs) and the speech of a local video file */
  frames?: (video: string) => Promise<string[]>; speech?: (video: string) => Promise<string | null>;
};

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["caption", "hashtags", "youtube_title"],
  properties: {
    caption: { type: "string", description: "The post text, without the hashtags" },
    hashtags: { type: "array", items: { type: "string" }, description: "3 to 6 hashtags, each starting with #" },
    youtube_title: { anyOf: [{ type: "string" }, { type: "null" }], description: "A YouTube title of at most 80 characters, or null when YouTube is not a target" },
  },
};

const SYSTEM = `You write captions for short-form videos that a creator is about to post. You are shown frames from the video, in order, and what is said in it.
Write like a person posting their own video, not like a brand or an announcer:
- The first line is the hook: specific to this video, under 90 characters, no clickbait the video does not deliver.
- Then at most one or two short lines if they add something. Plain words. No emoji walls (one or two at most, only if they fit). No quotation marks around the caption.
- Use the language that is spoken in the video; English when nobody speaks.
- Never invent facts, names, prices or claims that the frames or the speech do not show. Never mention how the video was made, AI, editing tools or any company behind them.
- Hashtags: 3 to 6, specific to the content and the niche, lowercase unless a proper noun, no spaces, no banned or spammy tags (#fyp is allowed at most once).
- When YouTube is a target, also give a title of at most 80 characters; otherwise youtube_title is null.
Follow the creator's note when there is one.`;

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
      const text = String(t.text ?? "").trim();
      return text ? text.slice(0, 4000) : null;
    } catch { return null; } // a silent clip, or no audio track: the frames still carry it
    finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  };
}

/** Draft a caption for one of the person's outputs. Throws SocialError for anything the person should read. */
export async function draftCaption(sb: SupabaseClient, u: string, req: { job_id: string; output_key: string; platforms: string[]; note?: string | null }, deps: CaptionDeps = {}): Promise<CaptionDraft> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new SocialError("captions_off", "Caption writing is not switched on", 503);
  const j = await sb.from("studio_jobs").select("id,status,outputs").eq("id", req.job_id).eq("user_id", u).maybeSingle();
  if (j.error) throw j.error;
  const out = j.data?.status === "done" ? ((j.data.outputs ?? []) as any[]).find((o) => o.key === req.output_key) : null;
  if (!out) throw new SocialError("video_not_found", "That video is gone", 404);
  if (out.kind && out.kind !== "video") throw new SocialError("not_a_video", "Captions are written for videos");
  if (!allowCaption(u)) throw new SocialError("caption_rate_limited", "That is a lot of captions for one hour; write this one by hand or try again soon", 429);

  const s = await sb.storage.from("studio-outputs").createSignedUrl(out.key, 600);
  if (s.error || !s.data?.signedUrl) throw new SocialError("video_unavailable", "That video could not be read", 502);
  const dir = await mkdtemp(join(tmpdir(), "c8-caption-"));
  try {
    const file = join(dir, "v.mp4");
    const dl = await f(s.data.signedUrl, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!dl?.ok) throw new SocialError("video_unavailable", "That video could not be read", 502);
    if (Number(dl.headers.get("content-length") ?? 0) > 500_000_000) throw new SocialError("video_too_large", "That video is too large to write a caption from", 413);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > 500_000_000) throw new SocialError("video_too_large", "That video is too large to write a caption from", 413);
    await writeFile(file, buf);
    const [frames, speech] = await Promise.all([(deps.frames ?? videoFrames)(file), (deps.speech ?? speechOf(env, f))(file)]);
    if (!frames.length) throw new SocialError("video_unreadable", "No frames could be read from that video", 422);
    const targets = req.platforms.map((p) => NAMES[p] ?? p).join(", ") || "TikTok, Instagram Reels";
    const text = [`Posting to: ${targets}.`, speech ? `What is said in the video:\n"""${speech}"""` : "Nobody speaks in this video (or the sound is music only).", req.note ? `The creator's note: ${String(req.note).slice(0, 300)}` : ""].filter(Boolean).join("\n\n");
    const r = await f("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({
        model: env.STUDIO_CAPTION_MODEL || CAPTION_MODEL, max_tokens: 4000, system: SYSTEM, fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: [...frames.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })), { type: "text", text }] }],
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => { throw new SocialError("captions_unavailable", "The caption writer did not answer; write it by hand or try again", 503); });
    if (!r.ok) { (deps.log ?? console.log)(`[captions] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); throw new SocialError("captions_unavailable", "The caption writer did not answer; write it by hand or try again", 503); }
    const body: any = await r.json();
    if (body?.stop_reason === "refusal") throw new SocialError("caption_refused", "No caption could be written for that video; write it by hand", 422);
    const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new SocialError("captions_unavailable", "The caption came back unreadable; try again", 502); }
    const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map((h: any) => `#${String(h).replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h: string) => h.length > 1).slice(0, 6);
    const title = req.platforms.includes("youtube") && parsed.youtube_title ? Array.from(String(parsed.youtube_title)).slice(0, 100).join("") : null;
    return { caption: String(parsed.caption ?? "").trim().slice(0, 2000), hashtags, youtube_title: title, heard_speech: !!speech };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
