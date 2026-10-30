// Clone8 Studio: the audio instruments, served by ElevenLabs behind ELEVENLABS_API_KEY. Voice over from text, voice
// change on a clip (same words, another voice), dubbing into another language, voice isolation, sound effects, music
// and transcripts. Each is one row in src/data/eleven-catalog.json and runs through the same `instrument` job as the
// video models; this module is the client and the runner. Sound comes back as MP3, transcripts as .txt and .srt,
// and anything applied to a clip is muxed back onto the untouched picture with ffmpeg.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response as ExpressResponse } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { RecastError, makePoster, probeSeconds } from "./studio-recast.js";
import type { Instrument, InstrumentDeps } from "./studio-instruments.js";

export const ELEVEN_BASE = "https://api.elevenlabs.io";
export const TTS_MODELS: Record<string, string> = { natural: "eleven_multilingual_v2", expressive: "eleven_v3", fast: "eleven_flash_v2_5" };
export type Voice = { id: string; name: string; labels: Record<string, string>; preview_url: string | null; category: string; description: string | null };
type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id?: string | null; options: any; credits_reserved: number; progress: any; attempts: number };

export const elevenEnabled = (env: Record<string, string | undefined> = process.env) => !!env.ELEVENLABS_API_KEY;

async function eleven(deps: InstrumentDeps, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const key = (deps.env ?? process.env).ELEVENLABS_API_KEY;
  if (!key) throw new RecastError("audio_not_configured");
  const headers: Record<string, string> = { "xi-api-key": key, ...((init.headers as Record<string, string>) ?? {}) };
  const r = await (deps.fetch ?? fetch)(`${ELEVEN_BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
  if (r.status === 401 || r.status === 403) throw new RecastError("audio_auth", `the audio service refused the key (${r.status})`);
  if (r.status === 402) throw new RecastError("audio_balance", "the audio service's balance is exhausted");
  if (r.status === 429 || r.status >= 500) throw new RecastError("audio_unavailable", `audio service ${r.status}`, true);
  return r;
}
const rejected = async (r: Response) => new RecastError("audio_rejected", `audio service ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);

// ---------------------------------------------------------------------------------------------------
// Voices: the library a person can audition from. Cached for ten minutes; previews are public MP3 links.
// ---------------------------------------------------------------------------------------------------
let voiceCache: { at: number; list: Voice[] } | null = null;
export async function listVoices(deps: InstrumentDeps): Promise<Voice[]> {
  const now = deps.now ?? Date.now;
  if (voiceCache && now() - voiceCache.at < 10 * 60_000) return voiceCache.list;
  const r = await eleven(deps, "/v2/voices?page_size=100&include_total_count=false", { method: "GET" });
  if (!r.ok) throw await rejected(r);
  const body: any = await r.json();
  const list: Voice[] = (Array.isArray(body?.voices) ? body.voices : []).map((v: any) => ({ id: String(v.voice_id), name: String(v.name ?? "Voice"), labels: Object.fromEntries(Object.entries(v.labels ?? {}).map(([k, x]) => [k, String(x)])), preview_url: typeof v.preview_url === "string" ? v.preview_url : null, category: String(v.category ?? ""), description: typeof v.description === "string" ? v.description : null }));
  voiceCache = { at: now(), list };
  return list;
}
export const resetVoiceCache = () => { voiceCache = null; };
/** The voices that best fit a description ("warm older British man", "energetic young woman"), by label words. */
const SYNONYMS: Record<string, string[]> = { man: ["male"], men: ["male"], guy: ["male"], masculine: ["male"], woman: ["female"], women: ["female"], lady: ["female"], girl: ["female", "young"], feminine: ["female"], boy: ["male", "young"], older: ["old", "middle_aged"], elderly: ["old"], mature: ["middle_aged", "old"], senior: ["old"], youthful: ["young"], teen: ["young"], english: ["british"], uk: ["british"], us: ["american"], usa: ["american"], aussie: ["australian"], calm: ["soothing", "relaxed"], soft: ["gentle", "soothing"], upbeat: ["energetic", "cheerful"], lively: ["energetic"], serious: ["authoritative", "confident"], deep: ["deep", "resonant"] };
export function matchVoices(voices: Voice[], description: string, count = 4): Voice[] {
  const words = new Set(description.toLowerCase().split(/[^a-z_]+/).filter((w) => w.length > 1).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]));
  // a named gender or accent is a filter first and a score second: nobody asks for "a British man" and wants a woman
  const wanted = (xs: string[]) => xs.filter((x) => words.has(x));
  const genders = wanted(["male", "female"]), accents = wanted(["british", "american", "australian", "irish", "indian", "african", "canadian", "scottish", "swedish", "italian", "spanish", "french", "german"]);
  const has = (v: Voice, k: string, x: string) => String(v.labels[k] ?? "").toLowerCase().replace(/[^a-z]/g, "") === x;
  const score = (v: Voice) => {
    const hay = new Set(`${v.name} ${Object.values(v.labels).join(" ")} ${v.description ?? ""}`.toLowerCase().split(/[^a-z_]+/));
    let n = 0; for (const w of words) if (hay.has(w)) n++;
    if (genders.length && genders.some((g) => has(v, "gender", g))) n += 3;
    if (accents.length && accents.some((a) => has(v, "accent", a))) n += 2;
    return n + (v.preview_url ? 0.5 : 0);
  };
  let pool = voices;
  if (genders.length) { const same = pool.filter((v) => genders.some((g) => has(v, "gender", g))); if (same.length >= count) pool = same; }
  if (accents.length) { const same = pool.filter((v) => accents.some((a) => has(v, "accent", a))); if (same.length >= count) pool = same; }
  return [...pool].sort((a, b) => score(b) - score(a)).slice(0, count);
}

// ---------------------------------------------------------------------------------------------------
// The calls. Each returns bytes (or text), nothing is stored here.
// ---------------------------------------------------------------------------------------------------
export async function textToSpeech(deps: InstrumentDeps, p: { voice_id: string; text: string; model?: string }): Promise<Buffer> {
  const r = await eleven(deps, `/v1/text-to-speech/${encodeURIComponent(p.voice_id)}?output_format=mp3_44100_128`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: p.text, model_id: TTS_MODELS[p.model ?? "natural"] ?? TTS_MODELS.natural }) });
  if (!r.ok) throw await rejected(r);
  return Buffer.from(await r.arrayBuffer());
}
export async function voiceChange(deps: InstrumentDeps, p: { voice_id: string; audio: Buffer; remove_background_noise?: boolean }): Promise<Buffer> {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(p.audio)], { type: "audio/wav" }), "source.wav");
  form.set("model_id", "eleven_multilingual_sts_v2");
  form.set("remove_background_noise", p.remove_background_noise ? "true" : "false");
  // the documented path changed name in 2026; the older one still answers, so both are tried
  let r = await eleven(deps, `/v1/speech-to-speech/${encodeURIComponent(p.voice_id)}?output_format=mp3_44100_128`, { method: "POST", body: form, timeoutMs: 300_000 });
  if (r.status === 404) r = await eleven(deps, `/v1/voice-changer/${encodeURIComponent(p.voice_id)}?output_format=mp3_44100_128`, { method: "POST", body: form, timeoutMs: 300_000 });
  if (!r.ok) throw await rejected(r);
  return Buffer.from(await r.arrayBuffer());
}
export async function isolateVoice(deps: InstrumentDeps, audio: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "source.wav");
  const r = await eleven(deps, "/v1/audio-isolation", { method: "POST", body: form, timeoutMs: 300_000 });
  if (!r.ok) throw await rejected(r);
  return Buffer.from(await r.arrayBuffer());
}
export async function soundEffect(deps: InstrumentDeps, p: { text: string; duration_seconds?: number | null; loop?: boolean }): Promise<Buffer> {
  const body: Record<string, any> = { text: p.text };
  if (p.duration_seconds) body.duration_seconds = p.duration_seconds;
  if (p.loop) body.loop = true;
  const r = await eleven(deps, "/v1/sound-generation?output_format=mp3_44100_128", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw await rejected(r);
  return Buffer.from(await r.arrayBuffer());
}
export async function composeMusic(deps: InstrumentDeps, p: { prompt: string; length_seconds: number }): Promise<Buffer> {
  const r = await eleven(deps, "/v1/music?output_format=mp3_44100_128", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: p.prompt, music_length_ms: Math.round(p.length_seconds * 1000), model_id: "music_v1" }), timeoutMs: 300_000 });
  if (!r.ok) throw await rejected(r);
  return Buffer.from(await r.arrayBuffer());
}
export async function transcribe(deps: InstrumentDeps, p: { audio: Buffer; language?: string | null; diarize?: boolean }): Promise<{ text: string; srt: string | null; language: string | null }> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(p.audio)], { type: "audio/wav" }), "source.wav");
  form.set("model_id", "scribe_v1");
  form.set("diarize", p.diarize === false ? "false" : "true");
  form.set("tag_audio_events", "false");
  form.set("additional_formats", JSON.stringify([{ format: "srt" }]));
  if (p.language) form.set("language_code", p.language);
  const r = await eleven(deps, "/v1/speech-to-text", { method: "POST", body: form, timeoutMs: 300_000 });
  if (!r.ok) throw await rejected(r);
  const body: any = await r.json();
  const srt = (Array.isArray(body?.additional_formats) ? body.additional_formats : []).find((f: any) => f?.requested_format === "srt" || f?.file_extension === "srt")?.content ?? null;
  return { text: String(body?.text ?? ""), srt: typeof srt === "string" ? srt : null, language: body?.language_code ?? null };
}
export async function dubVideo(deps: InstrumentDeps, p: { video: Buffer; target_language: string; num_speakers?: number; sleep?: (ms: number) => Promise<void>; onPoll?: (status: string) => Promise<void> }): Promise<Buffer> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(p.video)], { type: "video/mp4" }), "source.mp4");
  form.set("target_lang", p.target_language);
  form.set("num_speakers", String(p.num_speakers ?? 0));
  form.set("watermark", "false");
  const r = await eleven(deps, "/v1/dubbing", { method: "POST", body: form, timeoutMs: 300_000 });
  if (!r.ok) throw await rejected(r);
  const made: any = await r.json();
  const id = String(made?.dubbing_id ?? "");
  if (!id) throw new RecastError("audio_rejected", "no dubbing id in the reply");
  const sleep = p.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 40 * 60_000) throw new RecastError("recast_timeout");
    const s = await eleven(deps, `/v1/dubbing/${encodeURIComponent(id)}`, { method: "GET" });
    if (!s.ok) throw await rejected(s);
    const st: any = await s.json();
    const status = String(st?.status ?? "").toLowerCase();
    await p.onPoll?.(status);
    if (status === "dubbed") break;
    if (status === "failed") throw new RecastError("audio_rejected", `dubbing failed: ${String(st?.error ?? "").slice(0, 160)}`);
    await sleep(10_000);
  }
  const dl = await eleven(deps, `/v1/dubbing/${encodeURIComponent(id)}/audio/${encodeURIComponent(p.target_language)}`, { method: "GET", timeoutMs: 300_000 });
  if (!dl.ok) throw await rejected(dl);
  return Buffer.from(await dl.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------------
// ffmpeg: the speech out of a clip, and a new track back onto the untouched picture.
// ---------------------------------------------------------------------------------------------------
export async function extractAudio(video: string, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", target], undefined, 240_000);
}
export async function replaceAudio(video: string, audio: string, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", target], undefined, 240_000);
}

export type ElevenDeps = InstrumentDeps & { extractAudio?: typeof extractAudio; replaceAudio?: typeof replaceAudio; poster?: (video: string, target: string) => Promise<void>; probeSeconds?: (path: string) => Promise<number> };

/** The job runner for every audio instrument. Shares the lease, progress and completion rules of the video runner. */
export async function runElevenJob(sb: SupabaseClient, deps: ElevenDeps, job: Job, inst: Instrument): Promise<string> {
  const log = deps.log ?? (() => undefined);
  const renew = async (progress: Record<string, any>) => {
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
    if (r.error) throw r.error;
    if (r.data !== true) throw new RecastError("lease_lost");
    job.progress = { ...(job.progress ?? {}), ...progress };
  };
  const fail = async (code: string, retry: boolean) => {
    try { const r = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry }); if (r.error) throw r.error; }
    catch { return "failure_unconfirmed"; }
    return retry && job.attempts < 3 ? "requeued" : "failed";
  };
  let dir: string | null = null;
  try {
    const o = job.options ?? {}, params = o.params ?? {};
    await renew({ done: 0, total: 1, note: "Preparing" });
    dir = await mkdtemp(join(tmpdir(), "studio-audio-"));
    const base = `${job.user_id}/${job.id}/${job.lease_token}/1`;
    const outputs: any[] = [];
    // the clip, when the instrument works on one
    let video: string | null = null, seconds = 0;
    const videoId = o.inputs?.video_url;
    if (videoId) {
      const a = await sb.from("studio_assets").select("id,object_key,status,probe").eq("user_id", job.user_id).eq("id", videoId).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.status !== "ready") throw new RecastError("source_missing");
      const dl = await sb.storage.from("studio-uploads").download(a.data.object_key);
      if (dl.error || !dl.data) throw dl.error ?? new RecastError("source_missing");
      video = join(dir, "in.mp4"); await writeFile(video, Buffer.from(await dl.data.arrayBuffer()));
      seconds = Number(a.data.probe?.duration) || (await (deps.probeSeconds ?? probeSeconds)(video).catch(() => 0));
    }
    const storeAudio = async (bytes: Buffer, note: string) => {
      const up = await sb.storage.from("studio-outputs").upload(`${base}.mp3`, bytes, { contentType: "audio/mpeg", upsert: false });
      if (up.error) throw up.error;
      outputs.push({ index: 1, key: `${base}.mp3`, kind: "audio", bytes: bytes.length, duration: null, tool: "instrument", endpoint: inst.id, note });
    };
    const storeVideo = async (file: string) => {
      const bytes = await readFile(file), still = join(dir!, "out.jpg");
      let posterOk = true; try { await (deps.poster ?? makePoster)(file, still); } catch { posterOk = false; }
      const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, bytes, { contentType: "video/mp4", upsert: false });
      if (up.error) throw up.error;
      if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (p.error) posterOk = false; }
      const dur = await (deps.probeSeconds ?? probeSeconds)(file).catch(() => seconds);
      outputs.push({ index: 1, key: `${base}.mp4`, poster_key: posterOk ? `${base}.jpg` : undefined, kind: "video", bytes: bytes.length, duration: Math.round(dur * 1000) / 1000, tool: "instrument", endpoint: inst.id, audio: "replaced" });
    };
    const speech = async () => { const wav = join(dir!, "speech.wav"); await (deps.extractAudio ?? extractAudio)(video!, wav); return readFile(wav); };
    const onto = async (audio: Buffer) => { const a = join(dir!, "new.mp3"), out = join(dir!, "out.mp4"); await writeFile(a, audio); await (deps.replaceAudio ?? replaceAudio)(video!, a, out); await storeVideo(out); };

    switch (inst.id) {
      case "audio/text-to-speech": { await renew({ note: "Speaking your text" }); await storeAudio(await textToSpeech(deps, { voice_id: params.voice_id, text: String(params.text ?? ""), model: params.model }), "voice over"); break; }
      case "audio/sound-effects": { await renew({ note: "Making the sound" }); await storeAudio(await soundEffect(deps, { text: String(params.text ?? ""), duration_seconds: params.duration_seconds ?? null, loop: !!params.loop }), "sound effect"); break; }
      case "audio/music": { await renew({ note: "Composing" }); await storeAudio(await composeMusic(deps, { prompt: String(params.prompt ?? ""), length_seconds: Number(params.length_seconds ?? 30) }), "music"); break; }
      case "audio/voice-change": { if (!video) throw new RecastError("source_missing"); await renew({ note: "Listening to the clip" }); const wav = await speech(); await renew({ note: "Speaking it in the new voice" }); const changed = await voiceChange(deps, { voice_id: params.voice_id, audio: wav, remove_background_noise: !!params.remove_background_noise }); await renew({ note: "Putting the voice back on the picture" }); await onto(changed); break; }
      case "audio/voice-isolator": { if (!video) throw new RecastError("source_missing"); await renew({ note: "Listening to the clip" }); const wav = await speech(); await renew({ note: "Cleaning the voice" }); const clean = await isolateVoice(deps, wav); await renew({ note: "Putting the voice back on the picture" }); await onto(clean); break; }
      case "audio/dubbing": { if (!video) throw new RecastError("source_missing"); await renew({ note: "Sending the clip for dubbing" }); const dubbed = await dubVideo(deps, { video: await readFile(video), target_language: String(params.target_language), num_speakers: Number(params.num_speakers ?? 0), sleep: deps.sleep, onPoll: async (s) => { await renew({ note: s === "dubbing" ? "Dubbing" : `Dubbing (${s})` }); } }); const out = join(dir, "dubbed.mp4"); await writeFile(out, dubbed); await storeVideo(out); break; }
      case "audio/transcribe": {
        if (!video) throw new RecastError("source_missing");
        await renew({ note: "Listening to the clip" }); const wav = await speech();
        await renew({ note: "Writing it down" });
        const t = await transcribe(deps, { audio: wav, language: params.language || null, diarize: params.diarize !== false });
        const txt = Buffer.from(t.text, "utf8");
        const u1 = await sb.storage.from("studio-outputs").upload(`${base}.txt`, txt, { contentType: "text/plain", upsert: false });
        if (u1.error) throw u1.error;
        outputs.push({ index: 1, key: `${base}.txt`, kind: "text", bytes: txt.length, tool: "instrument", endpoint: inst.id, preview: t.text.slice(0, 400), language: t.language });
        if (t.srt) { const srt = Buffer.from(t.srt, "utf8"); const u2 = await sb.storage.from("studio-outputs").upload(`${base}.srt`, srt, { contentType: "text/plain", upsert: false }); if (!u2.error) outputs.push({ index: 2, key: `${base}.srt`, kind: "text", bytes: srt.length, tool: "instrument", endpoint: inst.id, preview: "subtitles" }); }
        break;
      }
      default: throw new RecastError("instrument_unknown");
    }
    const charged = Math.min(job.credits_reserved, Math.max(1, Number(job.credits_reserved)));
    try {
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
      if (done.error) throw done.error;
    } catch { return "completion_unconfirmed"; }
    log(`[audio] done ${JSON.stringify({ job: job.id, endpoint: inst.id, outputs: outputs.length, charged })}`);
    return "done";
  } catch (e: any) {
    if (e instanceof RecastError && e.code === "lease_lost") return "lease_lost";
    const code = e instanceof RecastError ? e.code : "worker_error";
    const retry = e instanceof RecastError ? e.retry : true;
    log(`[audio] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    return fail(code, retry);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Voices for the picker and the chat's voice card. */
export function registerVoices(app: Express, deps: InstrumentDeps = {}): void {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  app.get("/api/studio/voices", async (req, res: ExpressResponse) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!elevenEnabled(deps.env ?? process.env)) return res.json({ voices: [], enabled: false });
      const all = await listVoices(deps);
      const q = String(req.query.q ?? "").trim();
      const voices = q ? matchVoices(all, q, 12) : all;
      res.json({ voices: voices.map((v) => ({ id: v.id, name: v.name, labels: v.labels, preview_url: v.preview_url, description: v.description })), enabled: true });
    } catch (e: any) {
      const code = e instanceof RecastError ? e.code : "voices_failed";
      res.status(code === "audio_unavailable" ? 503 : 502).json({ error: code, detail: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
