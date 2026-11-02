// Clone8 Studio: Captions. Animated captions burned into a video (or a whole Clips run), in styles made with the
// shared caption engine (caption-engine.ts): every word timed, laid out from the font's real widths, rendered by libass
// with the bundled fonts. The page previews the same engine on a canvas, so what is set there is what comes out.
//
//   1. Words: speech to text with a time for every word (cached per video; a clip made by Clips already has its words),
//      and the words that carry each line marked by a small model, for the accent colour.
//   2. A job renders each video: the person's words (edited or as heard) -> ASS -> ffmpeg -> a new library video.
//   3. Price: 1 credit per 5 seconds of video, at least 5 a video (owner's call, Nov 1 2026). In Clips, captions add 3
//      credits a clip (the words are already heard there). Charged per video made; the rest goes back.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import opentype from "opentype.js";
import { buildAss, cleanStyle, FONTS, layoutCaptions, prepareWords, type CapWord, type CaptionStyle, type FontInfo, type Frame } from "./caption-engine.js";
import { claudeJson, ClipsError, defaultExtractAudio, ffmpeg, inputArgs, busy, type ClipsDeps, type SourceInput } from "./studio-clips.js";
import { capacity, cutGate, roomForAnother } from "./studio-capacity.js";
import { transcribeWords } from "./studio-eleven.js";
import { checkUpload } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import type { LibraryHelpers } from "./studio-library.js";

export const CAPTION_LIMITS = { max_seconds: 900, max_items: 50, max_words: 6000, words_per_day: 40, seconds_per_credit: 5, min_credits: 5, clips_per_clip: 3 };
export const captionsEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_CAPTIONS_ENABLED !== "false" && !!env.ELEVENLABS_API_KEY;
/** Credits for one video: a credit per 5 seconds, at least 5. */
export const captionCredits = (seconds: number) => Math.max(CAPTION_LIMITS.min_credits, Math.ceil(Math.max(0, seconds) / CAPTION_LIMITS.seconds_per_credit));

// ---------------------------------------------------------------------------------------------------
// Fonts on the server: the bundled files, measured with opentype (the same widths libass sets)
// ---------------------------------------------------------------------------------------------------
export const fontsDir = (env: Record<string, string | undefined> = process.env) => env.STUDIO_CAPTION_FONTS || resolve(process.cwd(), "assets/caption-fonts");
const loaded = new Map<string, any>();
export function serverMeasure(env: Record<string, string | undefined> = process.env) {
  return (text: string, f: FontInfo, em: number): number => {
    let font = loaded.get(f.file);
    if (!font) { font = opentype.loadSync(join(fontsDir(env), f.file)); loaded.set(f.file, font); }
    return font.getAdvanceWidth(text, em);
  };
}
/** A path inside an ffmpeg filter argument: backslashes, colons and quotes escaped. */
export const filterPath = (p: string) => p.replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
/** The ass filter for a file, with the bundled fonts (and nothing from the system). */
export const assFilter = (file: string, env: Record<string, string | undefined> = process.env) => `ass=${filterPath(file)}:fontsdir=${filterPath(fontsDir(env))}`;

export type CaptionSettings = { style: CaptionStyle; keywords: boolean; fillers: boolean; censor: boolean };
export function cleanSettings(raw: any): CaptionSettings {
  const r = raw && typeof raw === "object" ? raw : {};
  return { style: cleanStyle(r.style ?? { id: r.style_id }), keywords: r.keywords !== false, fillers: r.fillers !== false, censor: r.censor === true };
}
/** The ASS for a set of words on a frame (sizes and positions in that frame's pixels). */
export function captionAss(words: CapWord[], s: CaptionSettings, fr: Frame, env: Record<string, string | undefined> = process.env): string {
  const shown = prepareWords(words, { fillers: s.fillers, censor: s.censor });
  return buildAss(layoutCaptions(shown, s.style, fr, serverMeasure(env)), s.style, fr, s.keywords);
}

// ---------------------------------------------------------------------------------------------------
// Words: heard once per video and kept (a Clips clip brings its own)
// ---------------------------------------------------------------------------------------------------
export type WordsDoc = { v: 1; words: Array<[string, number, number, string | null]>; keys: number[]; language: string | null; duration: number | null; at: string };
export const wordsKey = (u: string, assetId: string) => `${u}/captions/${assetId}.json`;
export const docWords = (d: WordsDoc): CapWord[] => d.words.map(([text, start, end, speaker], i) => ({ text, start, end, speaker, key: d.keys.includes(i) }));
export async function readWords(sb: SupabaseClient, u: string, assetId: string): Promise<WordsDoc | null> {
  const r = await sb.storage.from("studio-outputs").download(wordsKey(u, assetId));
  if (r.error || !r.data) return null;
  try { const d = JSON.parse(Buffer.from(await r.data.arrayBuffer()).toString("utf8")); return d?.v === 1 && Array.isArray(d.words) ? d : null; } catch { return null; }
}
export async function saveWords(sb: SupabaseClient, u: string, assetId: string, doc: Omit<WordsDoc, "v" | "at">): Promise<void> {
  const body: WordsDoc = { v: 1, at: new Date().toISOString(), ...doc };
  await sb.storage.from("studio-outputs").upload(wordsKey(u, assetId), Buffer.from(JSON.stringify(body)), { contentType: "application/json", upsert: true });
}
const KEY_SCHEMA = { type: "object", additionalProperties: false, required: ["keys"], properties: { keys: { type: "array", items: { type: "integer" } } } };
/** The words that carry each line (names, numbers, the verb or noun that is the point), about one in six, marked by a
 *  small model for the accent colour. Never filler or small words. */
export async function markKeywords(deps: ClipsDeps, words: Array<{ text: string }>, userId?: string): Promise<number[]> {
  const keys: number[] = [];
  for (let from = 0; from < words.length; from += 700) {
    const part = words.slice(from, from + 700);
    const listed = part.map((w, i) => `${from + i}:${w.text}`).join(" ");
    const out = await claudeJson(deps, {
      model: (deps.env ?? process.env).STUDIO_CAPTION_KEY_MODEL || "claude-haiku-5-5", max_tokens: 3000, thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: KEY_SCHEMA } },
      messages: [{ role: "user", content: `These are a video's spoken words, numbered. Pick the words a caption should emphasise in an accent colour: the names, numbers and the one noun or verb that carries each phrase's point. About one word in six; never filler, articles, pronouns or small words; never two neighbours. Return their numbers.\n\n${listed}` }],
    }, "captions_keys", userId).catch(() => ({ keys: [] }));
    for (const k of Array.isArray(out?.keys) ? out.keys : []) if (Number.isInteger(k) && k >= from && k < from + part.length) keys.push(k);
  }
  return [...new Set(keys)].sort((a, b) => a - b);
}
const FIX_SCHEMA = { type: "object", additionalProperties: false, required: ["words"], properties: { words: { type: "array", items: { type: "string" } } } };
/** The words as they should read: spelling, names, numbers, capitalisation and punctuation fixed from context by a
 *  small model; the same number of words back, in order, so every timing stays. A word it would not change is
 *  returned as it was. Nothing is dropped or added. */
export async function fixWords(deps: ClipsDeps, words: Array<{ text: string }>, language: string | null, userId?: string): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < words.length; from += 400) {
    const part = words.slice(from, from + 400);
    const listed = part.map((w, i) => `${i}\t${w.text}`).join("\n");
    const r = await claudeJson(deps, {
      model: (deps.env ?? process.env).STUDIO_CAPTION_KEY_MODEL || "claude-haiku-5-5", max_tokens: 6000, thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: FIX_SCHEMA } },
      messages: [{ role: "user", content: `These are a video's spoken words from speech-to-text, one per line as "index<TAB>word"${language ? ` (language: ${language})` : ""}. Return the same words, in the same order and the same count (${part.length}), with only these fixed where the context makes it clear: misheard words, names and brands, numbers, capitalisation, and the punctuation that belongs on a word (a comma, a full stop, a question mark). Keep contractions and slang as spoken. Never merge, split, drop or add words; never translate. If a word is fine, return it unchanged.\n\n${listed}` }],
    }, "captions_fix", userId);
    const fixed: unknown[] = Array.isArray(r?.words) ? r.words : [];
    for (let i = 0; i < part.length; i++) { const t = typeof fixed[i] === "string" ? String(fixed[i]).replace(/\s+/g, " ").trim().slice(0, 40) : ""; out.push(t || part[i].text); }
  }
  return out;
}
async function signedVideo(sb: SupabaseClient, u: string, assetId: string): Promise<{ src: SourceInput; asset: any }> {
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe,collection_id").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new ClipsError("video_not_found", "That video is not in your library", 404);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 3 * 3600);
  if (s.error || !s.data?.signedUrl) throw new ClipsError("source_missing", "The video could not be read", 502, true);
  return { src: { video: s.data.signedUrl, audio: null, proxy: null, width: Number(a.data.probe?.width) || 0, height: Number(a.data.probe?.height) || 0, fps: null }, asset: a.data };
}
/** The words of one library video: kept ones, or heard now (and kept). */
export async function wordsFor(sb: SupabaseClient, deps: ClipsDeps, u: string, assetId: string): Promise<WordsDoc> {
  const kept = await readWords(sb, u, assetId);
  if (kept) return kept;
  const env = deps.env ?? process.env;
  const { src, asset } = await signedVideo(sb, u, assetId);
  const seconds = Number(asset.probe?.duration) || 0;
  if (seconds > CAPTION_LIMITS.max_seconds) throw new ClipsError("captions_too_long", `Captions take videos up to ${CAPTION_LIMITS.max_seconds / 60} minutes; make clips from this one first`);
  const dir = await mkdtemp(join(tmpdir(), "studio-capw-"));
  try {
    const mp3 = join(dir, "sound.mp3");
    await defaultExtractAudio(src, mp3);
    const heard = await transcribeWords({ env, fetch: deps.fetch }, { audio: await readFile(mp3) });
    const words = heard.words.map((w) => [w.text, round2(w.start), round2(w.end), w.speaker] as [string, number, number, string | null]);
    const keys = words.length ? await markKeywords(deps, heard.words, u) : [];
    const doc = { words, keys, language: heard.language, duration: seconds || null };
    await saveWords(sb, u, assetId, doc);
    return { v: 1, at: new Date().toISOString(), ...doc };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Words sent back by the page (edited): clean, in order, inside the video. */
export function cleanWords(raw: unknown, seconds: number): CapWord[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CapWord[] = [];
  for (const w of raw.slice(0, CAPTION_LIMITS.max_words)) {
    const text = String((w as any)?.text ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
    const start = Number((w as any)?.start), end = Number((w as any)?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || (seconds && start > seconds + 1)) continue;
    out.push({ text, start: round2(start), end: round2(Math.min(end, seconds ? seconds + 1 : end)), speaker: (w as any)?.speaker ? String((w as any).speaker).slice(0, 20) : null, key: !!(w as any)?.key, brk: !!(w as any)?.brk });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------------------------------
export type CaptionsQuote = { tool: "captions"; credits: number; options: Record<string, any>; summary: string };
export async function quoteCaptions(sb: SupabaseClient, u: string, env: Record<string, string | undefined>, options: any): Promise<CaptionsQuote> {
  if (!captionsEnabled(env)) throw new ClipsError("captions_unavailable", "Captions are not switched on yet", 503);
  const o = options && typeof options === "object" ? options : {};
  const ids = [...new Set((Array.isArray(o.items) ? o.items : []).map((x: any) => String(x?.asset_id ?? "")).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))] as string[];
  if (!ids.length) throw new ClipsError("captions_no_video", "Pick a video to caption");
  if (ids.length > CAPTION_LIMITS.max_items) throw new ClipsError("captions_too_many", `Up to ${CAPTION_LIMITS.max_items} videos at a time`);
  const a = await sb.from("studio_assets").select("id,kind,name,status,probe,collection_id").eq("user_id", u).in("id", ids);
  if (a.error) throw a.error;
  const by = new Map(((a.data ?? []) as any[]).map((x) => [x.id, x]));
  const items = ids.map((id) => {
    const x = by.get(id);
    if (!x || x.status !== "ready" || x.kind !== "video") throw new ClipsError("video_not_found", "One of those videos is not in your library", 404);
    const seconds = Number(x.probe?.duration);
    if (!(seconds > 0)) throw new ClipsError("asset_not_inspected", "A video is still being checked", 409);
    if (seconds > CAPTION_LIMITS.max_seconds) throw new ClipsError("captions_too_long", `"${x.name}" is over ${CAPTION_LIMITS.max_seconds / 60} minutes; make clips from it first`);
    return { asset_id: id, name: String(x.name ?? ""), seconds: Math.round(seconds * 10) / 10, credits: captionCredits(seconds), collection_id: x.collection_id ?? null };
  });
  const settings = cleanSettings(o);
  // the person's edited words for a video ride along (checked against its length)
  const edits: Record<string, CapWord[]> = {};
  for (const it of Array.isArray(o.items) ? o.items : []) { const w = cleanWords(it?.words, by.get(String(it?.asset_id))?.probe?.duration ?? 0); if (w && w.length) edits[String(it.asset_id)] = w; }
  const credits = items.reduce((s, x) => s + x.credits, 0);
  const seconds = items.reduce((s, x) => s + x.seconds, 0);
  return { tool: "captions", credits, options: { items: items.map((x) => ({ ...x, words: edits[x.asset_id] ?? null })), ...settings, seconds: Math.round(seconds) },
    summary: items.length === 1 ? `${Math.round(seconds)} s video` : `${items.length} videos · ${Math.round(seconds)} s` };
}

// ---------------------------------------------------------------------------------------------------
// The run: each video captioned and stored as a new library video
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** The output size: the source's, brought down to fit 1080x1920 (or 1920x1080). */
export function outputFrame(w: number, h: number): Frame {
  if (!(w > 0 && h > 0)) return { w: 1080, h: 1920 };
  const s = Math.min(1, (w >= h ? 1920 : 1080) / w, (w >= h ? 1080 : 1920) / h);
  return { w: even(w * s), h: even(h * s) };
}
export async function runCaptionsJob(sb: SupabaseClient, deps: ClipsDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id;
  const settings = cleanSettings(o);
  const items: any[] = Array.isArray(o.items) ? o.items : [];
  const made: Array<{ asset_id: string; source: string; credits: number }> = Array.isArray(job.progress?.made) ? job.progress.made : [];
  const renew = async (p: Record<string, any>) => {
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...p } });
    if (r.error) throw r.error;
    if (r.data !== true) throw new ClipsError("lease_lost", "lease lost");
    job.progress = { ...(job.progress ?? {}), ...p };
  };
  let dir: string | null = null;
  const failed: string[] = [];
  try {
    dir = await mkdtemp(join(tmpdir(), "studio-cap-"));
    // a batch lands together in a folder of its own; one video goes next to its source
    let folder: string | null = job.progress?.folder ?? null;
    if (items.length > 1 && !folder) {
      const first = await sb.from("studio_collections").select("name").eq("id", items[0]?.collection_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle();
      const name = `${String(first.data?.name ?? items[0]?.name ?? "Videos").replace(/\.[a-z0-9]{2,4}$/i, "").slice(0, 80)} · captions`;
      const c = await sb.from("studio_collections").insert({ user_id: u, name, kind: "folder", status: "ready", source: { platform: "captions" } }).select("id").single();
      if (!c.error) folder = c.data.id;
    }
    await renew({ stage: "captioning", done: made.length, total: items.length, folder, message: items.length > 1 ? `Captioning ${made.length + 1} of ${items.length}` : "Captioning", stage_at: new Date().toISOString() });
    for (const it of items) {
      if (made.some((m) => m.source === it.asset_id)) continue;
      const t0 = Date.now();
      try {
        const { src, asset } = await signedVideo(sb, u, it.asset_id);
        const words = Array.isArray(it.words) && it.words.length ? (it.words as CapWord[]) : docWords(await wordsFor(sb, deps, u, it.asset_id));
        if (!words.length) throw new ClipsError("captions_no_speech", "Nobody speaks in this video");
        const fr = outputFrame(Number(asset.probe?.width) || src.width, Number(asset.probe?.height) || src.height);
        const ass = join(dir, `${it.asset_id}.ass`), out = join(dir, `${it.asset_id}.mp4`), still = join(dir, `${it.asset_id}.jpg`);
        await writeFile(ass, captionAss(words, settings, fr, env));
        // through the server's cutter, shared with Clips: one render per CPU at a time
        let waited = false;
        await cutGate(env).run(async () => { if (waited) await renew({ message: items.length > 1 ? `Captioning ${made.length + 1} of ${items.length}` : 'Captioning' }); return ffmpeg(["-v", "error", "-nostdin", "-y", "-threads", "2", ...inputArgs(src, null, null), "-filter_threads", "1", "-vf", `scale=${fr.w}:${fr.h},setsar=1,${assFilter(ass, env)},format=yuv420p`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-rc-lookahead", "20", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", out], { timeoutMs: 20 * 60_000 }); }, () => { waited = true; return renew({ message: items.length > 1 ? `Video ${made.length + 1} of ${items.length} · next in line for the cutter` : 'Next in line for the cutter' }).then(() => undefined); });
        const seconds = Number(asset.probe?.duration) || 0;
        await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", Math.min(1, seconds / 3 || 0).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", still], { timeoutMs: 60_000 });
        const bytes = (await stat(out)).size;
        const limit = await checkUpload(sb, u, bytes);
        if (limit) throw new ClipsError(limit.code, limit.message, limit.status);
        const id = randomUUID(), key = `${u}/${id}.mp4`, posterKey = `${u}/assets/${id}.jpg`;
        const up = await sb.storage.from("studio-uploads").upload(key, await readFile(out), { contentType: "video/mp4", upsert: false });
        if (up.error) throw new ClipsError("captions_store_failed", String(up.error.message ?? up.error), 502, true);
        const pu = await sb.storage.from("studio-outputs").upload(posterKey, await readFile(still), { contentType: "image/jpeg", upsert: true });
        const p = asset.probe ?? {};
        const name = `${String(asset.name ?? "Video").replace(/\.[a-z0-9]{2,4}$/i, "").slice(0, 100)} (captions).mp4`;
        const ins = await sb.from("studio_assets").insert({
          id, user_id: u, kind: "video", name, object_key: key, bytes, status: "ready", collection_id: items.length > 1 ? folder : asset.collection_id ?? null,
          probe: { duration: p.duration, width: fr.w, height: fr.h, poster_key: pu.error ? undefined : posterKey, cuts: p.cuts ?? [], cuts_at: p.cuts_at, title: p.title, hook: p.hook, score: p.score, tags: p.tags, transcript: p.transcript,
            captions: { style: settings.style.id, from: it.asset_id, job_id: job.id } },
        });
        if (ins.error) { await sb.storage.from("studio-uploads").remove([key]).catch(() => undefined); throw ins.error; }
        // the captioned copy has the same words: kept, so it can be captioned again without listening again
        const doc = await readWords(sb, u, it.asset_id); if (doc) await saveWords(sb, u, id, doc).catch(() => undefined);
        made.push({ asset_id: id, source: it.asset_id, credits: Number(it.credits) || captionCredits(seconds) });
        log(`[captions] made ${JSON.stringify({ job: job.id, seconds: Math.round(seconds), render_s: Math.round((Date.now() - t0) / 1000), words: words.length, style: settings.style.id })}`);
        await renew({ done: made.length, made, message: made.length < items.length ? `Captioning ${made.length + 1} of ${items.length}` : "Finishing" });
      } catch (e: any) {
        if (e instanceof ClipsError && (e.code === "lease_lost" || e.code === "storage_full" || e.code === "too_many_files")) throw e;
        failed.push(it.asset_id);
        log(`[captions] ${it.asset_id} of ${job.id} skipped: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    if (!made.length) throw new ClipsError("captions_failed", "None of the videos could be captioned", 502, false);
    const charged = Math.min(job.credits_reserved, made.reduce((s, m) => s + m.credits, 0));
    await renew({ stage: "done", outcome: failed.length ? "partial" : "done", made_count: made.length, charged }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
    if (done.error) throw done.error;
    recordEvent({ user_id: u, kind: "feature", name: "captions_done", props: { job: job.id, videos: made.length, failed: failed.length, style: settings.style.id, credits: charged } });
    return "done";
  } catch (e: any) {
    const code = e instanceof ClipsError ? e.code : "captions_failed";
    if (code === "lease_lost") return code;
    const retry = e instanceof ClipsError ? e.retry : true;
    log(`[captions] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    if (made.length && (!retry || (job.attempts ?? 1) >= 3)) {
      const charged = Math.min(job.credits_reserved, made.reduce((s, m) => s + m.credits, 0));
      await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
      return "partial";
    }
    const f = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry });
    if (f.error) log(`[captions] could not record the failure of ${job.id}: ${f.error.message}`);
    return code;
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** Several captions runs at once (capacity().captionsRuns): hearing the words happens elsewhere, and each render goes
 *  through the server's cutter, shared with Clips. So a captions job waits for one clip at most, never a whole run. */
export function startCaptionsLoop(sbFn: () => SupabaseClient, deps: ClipsDeps = {}, intervalMs = 8_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!captionsEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `captions-${randomUUID()}`;
  const active = new Set<string>();
  let claiming = false;
  const tick = async () => {
    if (claiming) return;
    claiming = true;
    try {
      const sb = sbFn();
      // one new run per tick at most: the next tick's memory reading then includes the run just started
      if (active.size < capacity(env).captionsRuns) {
        const room = await (deps.room ?? roomForAnother)(env);
        if (!room.ok) return;
        const r = await sb.rpc("studio_claim", { p_tool: "captions", p_worker: worker });
        if (r.error) throw r.error;
        const job = r.data as Job | null;
        if (!job || !job.id) return;
        active.add(job.id); busy.captions = true;
        const keep = setInterval(() => { void sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }); }, 4 * 60_000);
        runCaptionsJob(sb, { ...deps, log }, job).then((s) => log(`[captions] ${s} ${job.id}`)).catch((e) => log(`[captions] crashed ${job.id} ${e?.message ?? e}`))
          .finally(() => { clearInterval(keep); active.delete(job.id); busy.captions = active.size > 0; });
      }
    } catch (e: any) { log(`[captions] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { claiming = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 23_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
export function registerCaptions(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log">, deps: ClipsDeps = {}): void {
  // The words of a video, for the editor: heard once (about 3 seconds a minute), then kept. Needs a plan; 40 a day.
  app.post("/api/studio/captions/words", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      if (!captionsEnabled(h.env)) throw new ClipsError("captions_unavailable", "Captions are not switched on yet", 503);
      const assetId = String(req.body?.asset_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new ClipsError("video_not_found", "Pick a video", 404);
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass))) throw new ClipsError("subscription_required", "Captions come with a plan", 409);
      let doc = await readWords(sb, u, assetId);
      if (!doc) {
        const since = new Date(Date.now() - 86400_000).toISOString();
        const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "captions_words").gte("created_at", since);
        if ((n.count ?? 0) >= CAPTION_LIMITS.words_per_day) throw new ClipsError("captions_rate_limited", "That is a lot of new videos for one day; try again tomorrow", 429);
        doc = await wordsFor(h.sbFn(), { ...deps, env: h.env, log: h.log }, u, assetId);
        recordEvent({ user_id: u, kind: "feature", name: "captions_words", props: { asset: assetId, words: doc.words.length, seconds: doc.duration } });
      }
      res.json({ words: docWords(doc), language: doc.language, duration: doc.duration });
    } catch (e) { h.fail(res, e); }
  });
  // "Fix with AI": the words sent back corrected, same count and order (the page keeps every timing). Needs a plan; 60 a day.
  app.post("/api/studio/captions/fix", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      if (!captionsEnabled(h.env) || !h.env.ANTHROPIC_API_KEY) throw new ClipsError("captions_unavailable", "Captions are not switched on yet", 503);
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass))) throw new ClipsError("subscription_required", "Captions come with a plan", 409);
      const words = (Array.isArray(req.body?.words) ? req.body.words : []).slice(0, CAPTION_LIMITS.max_words).map((w: any) => ({ text: String(w?.text ?? w ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) })).filter((w: any) => w.text);
      if (!words.length) throw new ClipsError("captions_no_speech", "Nothing to fix");
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "captions_fix").gte("created_at", since);
      if ((n.count ?? 0) >= 60) throw new ClipsError("captions_rate_limited", "That is a lot of fixes for one day; try again tomorrow", 429);
      const fixed = await fixWords({ ...deps, env: h.env, log: h.log }, words, typeof req.body?.language === "string" ? req.body.language.slice(0, 8) : null, u);
      recordEvent({ user_id: u, kind: "feature", name: "captions_fix", props: { words: words.length, changed: fixed.filter((t, i) => t !== words[i].text).length } });
      res.json({ words: fixed });
    } catch (e) { h.fail(res, e); }
  });
}
