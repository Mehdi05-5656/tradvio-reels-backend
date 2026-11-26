// Clone8 Studio: Hooks (docs/model-features/PRODUCT_ADS_PLAN.md, phase 2, owner Nov 26 2026). An AI character presents
// a product in the first seconds of an ad, lip-synced to that character's own voice.
//
// The leaders' pattern, in two paid steps the person controls:
//   1. a picture first: the character with the product in the format's setting (Seedream 5.0 Pro edit, ~7 credits); the
//      person approves it before any video money is spent;
//   2. then the video: Claude writes hook lines, the person ticks the ones they want, each line is spoken in the
//      character's ElevenLabs voice and the approved picture is animated in sync with it:
//        Best: Seedance 2.5 reference-to-video, picture + voice (lips matched every word, +0.2-0.4 s; UGC lab Nov 18)
//        Standard: Wan 2.7 image-to-video with the voice as driving audio (cheaper; to be measured)
// Every hook is an ordinary instrument job: priced on the button, booked in the ledger, the recipe on the server.
//
// Script rule (FTC fake-testimonial rule): an AI character presents a product; it never claims to be a customer
// ("I've used this for three weeks"), never states results, prices it wasn't given, or health claims.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { claudeJson } from "./studio-clips.js";
import { textToSpeech } from "./studio-eleven.js";
import { recordCost } from "./studio-costs.js";
import { CAST, castById, castFor, publicCast } from "./studio-cast.js";
import { normalFacts, storeImage, ProductError } from "./studio-products.js";
import { CATEGORY_LABEL } from "./studio-product-looks.js";
import { command } from "./video-render.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Deps = { env?: Record<string, string | undefined>; log?: (line: string) => void; fetch?: typeof fetch };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩{}<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export class HookError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

// ---------------------------------------------------------------------------------------------------
// Formats: named after the TikTok formats people search for; each sets the picture and how the lines are written
// ---------------------------------------------------------------------------------------------------
export type HookFormat = { id: string; title: string; line: string; scene: string; script: string; shop_safe: boolean };
export const HOOK_FORMATS: HookFormat[] = [
  { id: "talking", title: "Talking to camera", line: "Straight to the lens, like a creator's selfie video.", shop_safe: true,
    scene: "holds the phone at arm's length and talks to the camera; the product from the second picture stands on the surface beside them, label toward the camera",
    script: "A direct line to the viewer that names the problem or the moment the product is for." },
  { id: "holding", title: "Holding it up", line: "The product up beside their face, label to camera.", shop_safe: true,
    scene: "holds the product from the second picture up beside their face with one hand, label facing the camera and fingers clear of the logo, talking to the camera",
    script: "A line that points at the product in their hand: what it is and why it's worth a look." },
  { id: "stop", title: "Stop scrolling", line: "A lean-in that grabs the first second.", shop_safe: true,
    scene: "leans in close to the camera with a wide-eyed, urgent expression; the product from the second picture is held just below their chin, label toward the camera",
    script: "Opens with a pattern break that makes someone stop ('Wait, don't scroll…', 'Okay, this is the thing…') and ends on curiosity." },
  { id: "problem", title: "Problem, then the fix", line: "Names the annoyance, then shows what solves it.", shop_safe: true,
    scene: "has a slightly frustrated, knowing expression and holds the product from the second picture toward the camera as the answer, label facing the camera",
    script: "First half names a common, relatable annoyance; second half presents this product as the fix, without promising results." },
  { id: "honest", title: "Honest take", line: "A calm, straight presenter review.", shop_safe: true,
    scene: "sits relaxed and talks to the camera like a calm reviewer, the product from the second picture in their hand, label toward the camera",
    script: "A presenter's honest framing ('Here's what this actually is', 'Three things to know about…'); never pretends to be a customer." },
  { id: "pov", title: "POV", line: "\"POV: you finally found…\" in a real moment.", shop_safe: true,
    scene: "is caught in a real everyday moment that suits the product, glancing at the camera with a knowing smile, the product from the second picture in hand, label visible",
    script: "A 'POV:' line that drops the viewer into the moment the product is for." },
];
const formatById = new Map(HOOK_FORMATS.map((f) => [f.id, f]));
export const hookFormatById = (id: unknown) => (typeof id === "string" ? formatById.get(id) ?? null : null);

/** The voices a person can give their own character (the Cast's are fixed). */
export const HOOK_VOICES: Array<{ id: string; name: string; gender: "woman" | "man" | "neutral"; style: string }> = [
  ...new Map(CAST.map((c) => [c.voice.id, { id: c.voice.id, name: c.voice.name, gender: c.gender, style: c.line.split(".")[0] }])).values(),
];
const voiceIds = new Set(HOOK_VOICES.map((v) => v.id));

// ---------------------------------------------------------------------------------------------------
// Recipes (never sent to the page)
// ---------------------------------------------------------------------------------------------------
const STILL_KEEP = "The person keeps the exact face, hair, skin and build from the first picture. The product keeps its exact shape, colours, logo and label from the second picture; every letter stays sharp and unchanged; never invent text. No captions, no watermark, no other text.";
export function hookStillRecipe(formatId: string, setting: string) {
  const f = hookFormatById(formatId);
  if (!f) throw new HookError("hook_format_unknown", "Pick a format");
  return { resolution: "2k", aspect_ratio: "9:16", prompt: `A vertical phone-camera selfie frame, filmed on a phone's front camera at arm's length, in ${clean(setting, 120) || "a bright everyday room"}. The person from the first picture ${f.scene}. Natural light, real skin texture, casual and believable like a TikTok creator's video. ${STILL_KEEP}` };
}
export type HookTier = "standard" | "best";
export const HOOK_ENGINE: Record<HookTier, string> = { best: "bytedance/seedance-2.5/reference-to-video", standard: "wan/v2.7/image-to-video" };
/** Seconds of video a line needs: about 2.6 spoken words a second, a beat either side; inside each engine's range. */
export function hookSeconds(line: string, tier: HookTier): number {
  const words = clean(line, 400).split(" ").filter(Boolean).length;
  const s = Math.ceil(words / 2.6 + 1);
  return tier === "best" ? Math.min(30, Math.max(4, s)) : Math.min(15, Math.max(3, s));
}
const VIDEO_SAY = "talks straight into the lens and says the words in the voice recording, lips and mouth exactly in sync with every word, casual and convincing like a TikTok creator, small natural head movements, slight handheld shake. The product stays exactly as it is, label readable. No text, no captions, no music.";
/** The video request a hook makes (the voice joins at run time, made from the line in the character's voice). */
export function withHookRecipe(hook: any, params: Record<string, any>): Record<string, any> {
  const tier: HookTier = hook?.tier === "best" ? "best" : "standard";
  const seconds = hookSeconds(String(hook?.line ?? ""), tier);
  if (tier === "best") return { prompt: `Generate a new video. A vertical handheld selfie video filmed on a phone's front camera, in the setting of <<<image_1>>>. The person from <<<image_1>>> ${VIDEO_SAY.replace("the voice recording", "<<<audio_1>>>")}`, duration: seconds, resolution: "720p", aspect_ratio: "9:16", generate_audio: true };
  return { prompt: `A vertical handheld selfie video. The person ${VIDEO_SAY}`, duration: seconds, resolution: "720p", ...(params?.seed ? { seed: params.seed } : {}) };
}

// ---------------------------------------------------------------------------------------------------
// Writing the lines (Claude, our cost)
// ---------------------------------------------------------------------------------------------------
const WRITE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["hooks"],
  properties: { hooks: { type: "array", items: { type: "object", additionalProperties: false, required: ["line", "angle"], properties: {
    line: { type: "string", description: "The words the character says: 6 to 14 words (3-6 seconds spoken), plain spoken English, one or two short sentences." },
    angle: { type: "string", description: "2-4 words naming the angle, e.g. 'curiosity gap', 'relatable problem'." },
  } } } },
};
const WRITE_SYSTEM = [
  "You write the first 3-6 seconds of short vertical video ads: the hook a presenter says to camera. Each hook must make someone stop scrolling.",
  "Rules you never break:",
  "- The presenter is a presenter, not a customer. Never 'I've been using this', 'it changed my life', 'my skin cleared', or any first-hand result or testimonial.",
  "- No claims about results, health, weight, money or speed; no prices or discounts unless they are given; no 'best', 'number one' or comparisons with named brands.",
  "- Say only what the product facts support. Plain spoken words someone would really say; no hashtags, no emojis, no stage directions.",
  "- Every hook different: vary the angle (curiosity, relatable moment, contrarian, specific detail, question, mini story).",
].join("\n");
export async function writeHooks(deps: Deps, input: { facts: ReturnType<typeof normalFacts>; presenter: string; format: string; count: number; notes?: string }, userId?: string): Promise<Array<{ line: string; angle: string }>> {
  const env = deps.env ?? process.env;
  const f = hookFormatById(input.format);
  if (!f) throw new HookError("hook_format_unknown", "Pick a format");
  const n = Math.max(1, Math.min(8, Math.round(input.count) || 5));
  const out = await claudeJson({ env, log: deps.log, fetch: deps.fetch } as any, {
    model: env.STUDIO_PRODUCTS_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: WRITE_SYSTEM,
    output_config: { format: { type: "json_schema", schema: WRITE_SCHEMA } },
    messages: [{ role: "user", content: [
      `Product: ${input.facts.name} (${CATEGORY_LABEL[input.facts.category]}).${input.facts.line ? ` ${input.facts.line}` : ""}${input.facts.label_text ? ` Words on it: ${input.facts.label_text}.` : ""}${input.facts.price ? ` Price: ${input.facts.price}.` : ""}`,
      `Presenter: ${clean(input.presenter, 120)}`,
      `Format: ${f.title}. ${f.script}`,
      input.notes ? `The person's notes: ${clean(input.notes, 300)}` : null,
      `Write ${n} hooks.`,
    ].filter(Boolean).join("\n") }],
  }, "hook_write", userId);
  return (Array.isArray(out?.hooks) ? out.hooks : []).map((h: any) => ({ line: clean(h?.line, 200), angle: clean(h?.angle, 40) })).filter((h: any) => h.line.split(" ").length >= 3).slice(0, n);
}

// ---------------------------------------------------------------------------------------------------
// Quotes: the picture step and the video step (called from quoteFor)
// ---------------------------------------------------------------------------------------------------
async function ownedImage(sb: SupabaseClient, u: string, id: unknown, what: string) {
  const s = String(id ?? "");
  if (!UUID_RE.test(s)) throw new HookError("hook_input_required", `Add ${what} first`);
  const a = await sb.from("studio_assets").select("id,kind,status,probe,name").eq("id", s).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.kind !== "image" || a.data.status !== "ready") throw new HookError("hook_input_required", `${what[0].toUpperCase()}${what.slice(1)} is not in your library`, 404);
  return a.data;
}
export async function hookQuoteRequest(sb: SupabaseClient, u: string, options: any, o: { admin: boolean }) {
  if (!o.admin) throw new HookError("hook_unknown", "Hooks are not open yet", 404);
  const product = await ownedImage(sb, u, options?.product, "your product");
  if (!product.probe?.product) throw new HookError("product_not_found", "That product is not in your library", 404);
  const facts = normalFacts(product.probe.product);
  if (options?.hook_still != null) {
    const f = hookFormatById(options.hook_still);
    if (!f) throw new HookError("hook_format_unknown", "Pick a format");
    const character = await ownedImage(sb, u, options?.character, "a character");
    const cast = castById(character.probe?.cast_id);
    const setting = clean(options?.setting, 120) || cast?.setting || "a bright everyday room";
    return { req: { endpoint: "bytedance/seedream/v5.0/pro/edit", params: hookStillRecipe(f.id, setting), inputs: { image_urls: [character.id, product.id] } },
      keep: { params: { setting }, hook_still: f.id, look_title: `${f.title} picture`, product: product.id, character: character.id, ...(cast ? { cast: cast.id } : {}) }, facts };
  }
  const h = options?.hook ?? {};
  const line = clean(h.line, 200);
  if (line.split(" ").filter(Boolean).length < 3) throw new HookError("hook_line_required", "Write the line they say");
  const tier: HookTier = h.tier === "best" ? "best" : "standard";
  const still = await ownedImage(sb, u, h.still, "the approved picture");
  const cast = castById(h.cast ?? still.probe?.cast_id);
  const voice = String(h.voice ?? cast?.voice.id ?? "");
  if (!voiceIds.has(voice)) throw new HookError("hook_voice_required", "Pick a voice");
  const hook = { line, tier, voice, still: still.id, ...(cast ? { cast: cast.id } : {}) };
  const inputs = tier === "best" ? { image_urls: [still.id] } : { image_url: still.id };
  return { req: { endpoint: HOOK_ENGINE[tier], params: withHookRecipe(hook, {}), inputs },
    keep: { params: {}, hook, look_title: `Hook · ${tier === "best" ? "Best" : "Standard"}`, product: product.id, ...(cast ? { cast: cast.id } : {}) }, facts };
}

// ---------------------------------------------------------------------------------------------------
// At run time: the line in the character's voice, joined to the request (called by the instrument runner)
// ---------------------------------------------------------------------------------------------------
export async function addHookVoice(sb: SupabaseClient, deps: Deps & { tts?: typeof textToSpeech }, job: any, body: Record<string, any>): Promise<void> {
  const env = deps.env ?? process.env, h = job.options?.hook ?? {};
  if (!voiceIds.has(String(h.voice))) throw new HookError("hook_voice_required", "No voice for this hook");
  const line = clean(h.line, 200);
  const mp3 = await (deps.tts ?? textToSpeech)({ env, log: deps.log, fetch: deps.fetch } as any, { voice_id: String(h.voice), text: line, model: "expressive" });
  const key = `${job.user_id}/${job.id}/work/voice.mp3`;
  const up = await sb.storage.from("studio-outputs").upload(key, mp3, { contentType: "audio/mpeg", upsert: true });
  if (up.error) throw up.error;
  const s = await sb.storage.from("studio-outputs").createSignedUrl(key, 7200);
  if (s.error || !s.data) throw s.error ?? new HookError("hook_voice_failed", "The voice could not be stored");
  if (h.tier === "best") body.audio_urls = [s.data.signedUrl]; else body.audio_url = s.data.signedUrl;
  // ElevenLabs bills about one credit a character on our plan ($99 for 600k credits): estimated, not metered
  recordCost({ job_id: job.id, user_id: job.user_id ?? null, tool: "instrument", provider: "elevenlabs", product: "text-to-speech", source: "hook_voice", units: { characters: line.length }, usd: Math.round(line.length * 0.000165 * 10000) / 10000, basis: "estimated", note: "1 credit/character at the Pro plan rate" });
}

// ---------------------------------------------------------------------------------------------------
// After a Best hook renders: our voice back on the clip. Seedance re-voices the line (test C, Nov 26 2026: same words,
// its own voice, 0.36 s late; Wan plays ours through untouched), which would break "one character, one voice". The
// lips follow Seedance's track, so our recording is laid on at the lag where the two tracks match best.
// ---------------------------------------------------------------------------------------------------
/** Loudness every 10 ms of 16 kHz mono 16-bit PCM. */
export function envelope(pcm: Buffer): number[] {
  const hop = 160, n = Math.floor(pcm.length / 2), out: number[] = [];
  for (let i = 0; i + hop <= n; i += hop) { let s = 0; for (let k = i; k < i + hop; k++) { const v = pcm.readInt16LE(k * 2); s += v * v; } out.push(Math.sqrt(s / hop)); }
  return out;
}
/** Where `voice` sits inside `clip` (in 10 ms steps, -50..+100) and how well it matches there (Pearson r). */
export function bestLag(clip: number[], voice: number[]): { lag: number; r: number } {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mc = mean(clip), mv = mean(voice), c = clip.map((x) => x - mc), v = voice.map((x) => x - mv);
  let best = { lag: 0, r: -1 };
  for (let lag = -50; lag <= 100; lag++) {
    let sxy = 0, sx = 0, sy = 0;
    for (let i = 0; i < v.length; i++) { const j = i + lag; if (j < 0 || j >= c.length) continue; sxy += c[j] * v[i]; sx += c[j] * c[j]; sy += v[i] * v[i]; }
    const r = sx && sy ? sxy / Math.sqrt(sx * sy) : -1;
    if (r > best.r) best = { lag, r };
  }
  return best;
}
const pcmOf = (file: string) => command("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], undefined, 120_000);
/** Lays the character's own recording on a Best hook clip (in place). Never throws: on any doubt the clip keeps its sound. */
export async function restoreHookVoice(sb: SupabaseClient, deps: Deps, job: any, file: string): Promise<{ lag_ms: number; r: number } | null> {
  const log = deps.log ?? (() => undefined), h = job.options?.hook ?? {};
  if (h.tier !== "best") return null;
  const dir = await mkdtemp(join(tmpdir(), "studio-hook-"));
  try {
    const dl = await sb.storage.from("studio-outputs").download(`${job.user_id}/${job.id}/work/voice.mp3`);
    if (dl.error || !dl.data) return null;
    const voiceFile = join(dir, "voice.mp3"), out = join(dir, "out.mp4");
    await writeFile(voiceFile, Buffer.from(await dl.data.arrayBuffer()));
    const m = bestLag(envelope(await pcmOf(file)), envelope(await pcmOf(voiceFile)));
    if (m.r < 0.35) { log(`[hooks] voice kept as rendered ${JSON.stringify({ job: job.id, r: Math.round(m.r * 100) / 100 })}`); return { lag_ms: m.lag * 10, r: m.r }; }
    const ms = Math.max(0, m.lag * 10), trim = Math.max(0, -m.lag * 10) / 1000;
    await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", file, "-ss", trim.toFixed(2), "-i", voiceFile, "-filter_complex", `[1:a]adelay=${ms}|${ms},apad[a]`, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out], undefined, 120_000);
    await writeFile(file, await readFile(out));
    log(`[hooks] own voice laid on ${JSON.stringify({ job: job.id, lag_ms: m.lag * 10, r: Math.round(m.r * 100) / 100 })}`);
    return { lag_ms: m.lag * 10, r: m.r };
  } catch (e: any) { log(`[hooks] voice restore skipped ${JSON.stringify({ job: job.id, error: String(e?.message ?? e).slice(0, 160) })}`); return null; }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// Routes (owner-only while phase 2 is checked)
// ---------------------------------------------------------------------------------------------------
export function registerHooks(app: Express, sbFn: () => SupabaseClient, deps: Deps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const d: Deps = { ...deps, env, log };
  const gate = async (req: Request, res: Response): Promise<string | null> => {
    const u = req.auth && "user_id" in req.auth ? req.auth.user_id : null;
    if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    if (env.STUDIO_PRODUCTS_OPEN !== "true" && !(await isStudioAdmin(req, sbFn(), env))) { res.status(404).json({ error: "not_found" }); return null; }
    return u;
  };
  const fail = (res: Response, e: any) => {
    if (e instanceof HookError || e instanceof ProductError) return res.status(e.status).json({ error: e.code, detail: e.message });
    if (e?.code && typeof e?.status === "number") return res.status(e.status).json({ error: e.code, detail: e.message });
    log(`[hooks] error ${String(e?.message ?? e).slice(0, 300)}`);
    return res.status(500).json({ error: "server_error" });
  };

  app.get("/api/studio/cast", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const admin = await isStudioAdmin(req, sbFn(), env);
      res.json({ cast: castFor({ admin }).map(publicCast), formats: HOOK_FORMATS.map(({ id, title, line, shop_safe }) => ({ id, title, line, shop_safe })), voices: HOOK_VOICES.map(({ id, name, gender, style }) => ({ id, name, gender, style })) });
    } catch (e) { fail(res, e); }
  });

  // a Cast character into the person's library, once (so every tool takes it like their own picture)
  app.post("/api/studio/cast/:id/use", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const c = castById(req.params.id);
      if (!c) throw new HookError("cast_unknown", "No such character", 404);
      if (!c.image) throw new HookError("cast_not_ready", "This character's picture is not made yet", 409);
      const sb = sbFn();
      const have = await sb.from("studio_assets").select("id").eq("user_id", u).eq("status", "ready").eq("probe->>cast_id", c.id).limit(1);
      if (have.error) throw have.error;
      if (have.data?.length) return res.json({ asset_id: have.data[0].id, cast: c.id });
      const r = await (deps.fetch ?? fetch)(c.image, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new HookError("cast_not_ready", "This character's picture could not be read", 502);
      const id = await storeImage(sb, u, Buffer.from(await r.arrayBuffer()), `Character ${c.name}`);
      const up = await sb.from("studio_assets").update({ probe: { cast_id: c.id, character: true } }).eq("id", id).eq("user_id", u);
      if (up.error) throw up.error;
      res.status(201).json({ asset_id: id, cast: c.id });
    } catch (e) { fail(res, e); }
  });

  // hook lines for a product, a presenter and a format (no charge; the videos are priced as any run)
  app.post("/api/studio/hooks/write", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const p = String(req.body?.product ?? "");
      if (!UUID_RE.test(p)) throw new HookError("hook_input_required", "Add your product first");
      const a = await sb.from("studio_assets").select("id,probe").eq("id", p).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data?.probe?.product) throw new ProductError("product_not_found", "That product is not in your library", 404);
      const cast = castById(req.body?.cast);
      const presenter = cast ? `${cast.name}, ${cast.line}` : clean(req.body?.presenter, 120) || "a friendly everyday presenter";
      const hooks = await writeHooks(d, { facts: normalFacts(a.data.probe.product), presenter, format: String(req.body?.format ?? ""), count: Number(req.body?.count ?? 5), notes: req.body?.notes }, u);
      res.json({ hooks });
    } catch (e) { fail(res, e); }
  });
}
