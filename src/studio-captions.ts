// Captions written from the video itself: a handful of frames (what is on screen) and the speech (what is said), read
// by Claude, which answers in a fixed JSON shape: the caption, a few hashtags and, when YouTube is in the mix, a title.
// Used by the Publish page and the chat's publish card; the person can always write their own instead.
// Raw HTTP to the Messages API like the assistant (studio-assistant.ts), so tests can swap fetch.
import { logClaudeCost } from "./studio-pricing.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { probeSeconds } from "./studio-recast.js";
import { extractAudio, transcribe } from "./studio-eleven.js";
import { SocialError } from "./social-provider.js";
import { testWinners } from "./studio-caption-tests.js";

export const CAPTION_MODEL = "claude-opus-5-5";
const FRAMES = 5, PER_HOUR = 100; // "Write all" on a batch of uploads
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
      const text = String(t.text ?? "").trim();
      return text ? text.slice(0, 4000) : null;
    } catch { return null; } // a silent clip, or no audio track: the frames still carry it
    finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  };
}

/** Draft a caption for one of the person's outputs. Throws SocialError for anything the person should read. */
export async function draftCaption(sb: SupabaseClient, u: string, req: { job_id?: string; output_key?: string; asset_id?: string; platforms: string[]; note?: string | null; variants?: number }, deps: CaptionDeps = {}): Promise<CaptionDraft> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new SocialError("captions_off", "Caption writing is not switched on", 503);
  // a made video (a job's output) or the person's own upload
  let bucket = "studio-outputs", objectKey = "";
  if (req.asset_id) {
    const a = await sb.from("studio_assets").select("id,kind,status,object_key").eq("id", req.asset_id).eq("user_id", u).maybeSingle();
    if (a.error) throw a.error;
    if (!a.data || a.data.status !== "ready") throw new SocialError("video_not_found", "That video is gone", 404);
    if (a.data.kind !== "video") throw new SocialError("not_a_video", "Captions are written for videos");
    bucket = "studio-uploads"; objectKey = a.data.object_key;
  } else {
    const j = await sb.from("studio_jobs").select("id,status,outputs").eq("id", req.job_id ?? "").eq("user_id", u).maybeSingle();
    if (j.error) throw j.error;
    const out = j.data?.status === "done" ? ((j.data.outputs ?? []) as any[]).find((o) => o.key === req.output_key) : null;
    if (!out) throw new SocialError("video_not_found", "That video is gone", 404);
    if (out.kind && out.kind !== "video") throw new SocialError("not_a_video", "Captions are written for videos");
    objectKey = out.key;
  }
  if (!allowCaption(u)) throw new SocialError("caption_rate_limited", "That is a lot of captions for one hour; write this one by hand or try again soon", 429);

  const s = await sb.storage.from(bucket).createSignedUrl(objectKey, 600);
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
    const ctx = await captionContext(sb, u, req.platforms).catch(() => ({ voice: [] as string[], tags: [] as Array<{ tag: string; multiple: number | null; posts: number }>, questionsHelp: null as boolean | null }));
    const won = await (deps.winners ?? testWinners)(sb, u);
    const variants = Math.min(Math.max(Math.floor(Number(req.variants) || 0), 0), 3);
    const text = [
      `Posting to: ${targets}. Target network ids for versions: ${(req.platforms.length ? req.platforms : ["tiktok", "instagram"]).join(", ")}.`,
      speech ? `What is said in the video:\n"""${speech}"""` : "Nobody speaks in this video (or the sound is music only).",
      ctx.voice.length ? `The creator's best-performing captions (their voice; do not copy):\n${ctx.voice.map((v) => `- ${v.replace(/\n+/g, " / ")}`).join("\n")}` : "",
      ctx.tags.length ? `Hashtags on the creator's own posts, with the median views multiple of posts that used them (1.0 = their normal): ${ctx.tags.map((t) => `${t.tag} ${t.multiple}x (${t.posts} posts)`).join(", ")}. Prefer their strong ones when they fit this video; never use a weak one just because it is theirs.` : "",
      ctx.questionsHelp === true ? "Questions in their captions earn them more comments: one short question is fine." : ctx.questionsHelp === false ? "Questions in their captions do not earn them more comments: no question." : "",
      won.length ? `Captions that won the creator's own caption tests (same video posted as Instagram Trial Reels with different captions; the strongest evidence of what their audience responds to):\n${won.map((w) => `- "${w.caption.replace(/\n+/g, " / ")}" beat "${w.beat.replace(/\n+/g, " / ")}"${w.lead ? ` (${w.lead}x the views)` : ""}`).join("\n")}` : "",
      variants >= 2 ? `This is for a caption test: the Instagram caption plus ${variants - 1} alternative${variants > 2 ? "s" : ""} in "alternatives", each opening with a clearly different hook (a different first line and angle), same rules and keywords. The test shows which one people watch.` : "",
      req.note ? `The creator's note: ${String(req.note).slice(0, 300)}` : "",
    ].filter(Boolean).join("\n\n");
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
  logClaudeCost(deps.log, "caption", String(body?.model ?? env.STUDIO_CAPTION_MODEL ?? CAPTION_MODEL), body?.usage, u);
    if (body?.stop_reason === "refusal") throw new SocialError("caption_refused", "No caption could be written for that video; write it by hand", 422);
    const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new SocialError("captions_unavailable", "The caption came back unreadable; try again", 502); }
    const title = req.platforms.includes("youtube") && parsed.youtube_title ? Array.from(String(parsed.youtube_title)).slice(0, 100).join("") : null;
    const versions = (Array.isArray(parsed.versions) ? parsed.versions : []).filter((v: any) => v && req.platforms.includes(String(v.platform))).map((v: any) => ({ platform: String(v.platform), caption: String(v.caption ?? "").trim().slice(0, 2000), hashtags: cleanTags(v.hashtags, String(v.platform)) })).filter((v: any, i: number, a: any[]) => v.caption && a.findIndex((x) => x.platform === v.platform) === i);
    const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : []).map((k: any) => ({ word: String(k?.word ?? "").trim().slice(0, 40), from: k?.from === "shown" ? "shown" as const : "said" as const })).filter((k: any) => k.word).slice(0, 3);
    const reasons = (Array.isArray(parsed.reasons) ? parsed.reasons : []).map((r: any) => String(r).trim().slice(0, 80)).filter(Boolean).slice(0, 4);
    const tagsUsed = new Set([...cleanTags(parsed.hashtags, req.platforms[0] ?? "tiktok"), ...versions.flatMap((v: any) => v.hashtags)].map((t) => t.toLowerCase()));
    return { caption: String(parsed.caption ?? "").trim().slice(0, 2000), hashtags: cleanTags(parsed.hashtags, req.platforms.includes("instagram") && req.platforms.length === 1 ? "instagram" : req.platforms[0] ?? "tiktok"), youtube_title: title, heard_speech: !!speech,
      versions, keywords, reasons, voice_from: ctx.voice.length, tags: ctx.tags.filter((t) => tagsUsed.has(t.tag)),
      ...(variants >= 2 ? { alternatives: (Array.isArray(parsed.alternatives) ? parsed.alternatives : []).map((x: any) => String(x ?? "").trim().slice(0, 2000)).filter(Boolean).slice(0, variants - 1) } : {}) };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
