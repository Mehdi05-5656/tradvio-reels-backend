// Clone8 Studio: Split screen, the job. One library video of the person's + one loop from the gameplay library ->
// one 720x1280 video: their clip framed in its half, the loop in the other, their words on the seam, their sound.
//
// How a run makes one:
//   1. The person's clip is brought to the working size (720 on the short side, 30 fps) through the server's cutter.
//   2. The loop is fetched from the library (the bucket), and a stretch as long as the clip is picked inside it.
//   3. Captions (when on): the clip's words, from the Captions tool's saved words or heard now (ElevenLabs, kept for
//      next time), laid out by the Captions engine with the block on the seam.
//   4. One ffmpeg pass through the cutter (src/studio-splitscreen.ts), then the poster, the upload and the charge.
//
// The page frames the halves before the job (POST /api/studio/splitscreen/frame gives the auto-sizer's layout, the
// person adjusts it); the job renders exactly the layout it is given.
//
// Off until STUDIO_SPLITSCREEN_ENABLED=true; until STUDIO_SPLITSCREEN_OPEN=true only the owner's account can use it.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ClipsError, ffmpeg, type ClipsDeps } from "./studio-clips.js";
import { assFilter, captionAss, cleanSettings, docWords, readWords, wordsFor } from "./studio-caption-video.js";
import type { CapWord } from "./caption-engine.js";
import { cutGate, roomForAnother } from "./studio-capacity.js";
import { recordEvent } from "./studio-events.js";
import { makePoster, probeDimensions, probeSeconds, probeStream } from "./studio-recast.js";
import { keyStills, prepareSource } from "./studio-stunts.js";
import { autoClipBox, autoSeam, cleanLayout, gameWindow, halves, readSubjects, settleSubject, splitArgs, splitscreenEnabled, splitscreenOpen, SPLIT_LIMITS, SPLIT_OUT, type Layout, type Subject } from "./studio-splitscreen.js";
import { KINDS, LIBRARY, LIBRARY_BUCKET, loopById, loopKey, pickLoop, posterKey, type Kind, type Loop } from "./studio-splitscreen-library.js";
import type { LibraryHelpers } from "./studio-library.js";

type Env = Record<string, string | undefined>;
export class SplitError extends ClipsError {}

// ---------------------------------------------------------------------------------------------------
// Price: one credit per 5 seconds, 5 at least (Captions' price: the words are the paid part, the render is server
// time). To be checked against the measured cost of the first live runs (docs/split-screen/PLAN.md, phase 3).
// ---------------------------------------------------------------------------------------------------
export const SPLIT_PRICE = { seconds_per_credit: 5, min_credits: 5 } as const;
export const splitCredits = (seconds: number) => Math.max(SPLIT_PRICE.min_credits, Math.ceil(Math.max(0, seconds) / SPLIT_PRICE.seconds_per_credit));
const round2 = (n: number) => Math.round(n * 100) / 100;
const KIND_IDS = KINDS.map((k) => k.id);

export type SplitQuote = { tool: "splitscreen"; credits: number; options: Record<string, any>; summary: string };
export function quoteSplit(env: Env, asset: { id: string; kind: string; probe: any; name: string } | null, raw: any, who: { owner?: boolean } = {}, library: Loop[] = LIBRARY): SplitQuote {
  if (!splitscreenEnabled(env)) throw new SplitError("splitscreen_off", "Split screen is not switched on yet", 503);
  if (!splitscreenOpen(env) && !who.owner) throw new SplitError("splitscreen_off", "Split screen is not open yet", 403);
  if (!asset || asset.kind !== "video") throw new SplitError("video_not_found", "Pick a video of yours", 404);
  const seconds = Number(asset.probe?.duration);
  if (!(seconds > 0)) throw new SplitError("asset_not_inspected", "The video is still being checked", 409);
  if (seconds < SPLIT_LIMITS.min_seconds) throw new SplitError("splitscreen_too_short", `The video needs to be at least ${SPLIT_LIMITS.min_seconds} seconds`);
  if (seconds > SPLIT_LIMITS.max_seconds) throw new SplitError("splitscreen_too_long", `Split screen takes videos up to ${SPLIT_LIMITS.max_seconds / 60} minutes; trim this one or make a clip from it first`);
  const o = raw && typeof raw === "object" ? raw : {};
  const kind = KIND_IDS.includes(o.kind) ? (o.kind as Kind) : null;
  const loop = o.loop_id ? library.find((l) => l.id === o.loop_id) ?? null : pickLoop(kind, `${asset.id}:${Date.now()}`, library);
  if (!loop) throw new SplitError("splitscreen_no_loop", o.loop_id ? "That gameplay is no longer in the library" : "Pick a gameplay");
  const layout = cleanLayout(o.layout);
  const style = typeof o.caption_style === "string" ? o.caption_style.slice(0, 40) : "bold_pop";
  return { tool: "splitscreen", credits: splitCredits(seconds),
    options: { loop_id: loop.id, layout, caption_style: style, seconds: round2(seconds), name: String(asset.name ?? "").slice(0, 120) },
    summary: `Split screen · ${loop.name} · ${Math.round(seconds)} s` };
}

// ---------------------------------------------------------------------------------------------------
// The auto-sizer's starting layout for one clip (the page asks before the editor opens)
// ---------------------------------------------------------------------------------------------------
export type SplitDeps = ClipsDeps & {
  prepare?: (url: string, target: string) => Promise<void>;
  fetchLoop?: (loop: Loop, target: string) => Promise<void>;
  words?: (u: string, assetId: string) => Promise<CapWord[]>;
  subjects?: (video: string, seconds: number, dir: string, userId: string) => Promise<Subject[]>;
  render?: (args: string[]) => Promise<void>;
  poster?: (video: string, target: string) => Promise<void>;
};
async function signedClip(sb: SupabaseClient, u: string, assetId: string) {
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new SplitError("video_not_found", "That video is not in your library", 404);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 3 * 3600);
  if (s.error || !s.data?.signedUrl) throw new SplitError("source_missing", "The video could not be read", 502, true);
  return { url: s.data.signedUrl, asset: a.data as { id: string; name: string; probe: any } };
}
const frameKey = (u: string, assetId: string) => `${u}/splitscreen/${assetId}.txt`;

/** Where the face is in a library video, read once and kept (the bucket takes text/plain, not JSON). */
export async function subjectFor(sb: SupabaseClient, deps: SplitDeps, u: string, assetId: string): Promise<{ subject: Subject | null; size: { w: number; h: number }; cached: boolean }> {
  const { url, asset } = await signedClip(sb, u, assetId);
  const size = { w: Number(asset.probe?.width) || 1080, h: Number(asset.probe?.height) || 1920 };
  const kept = await sb.storage.from("studio-outputs").download(frameKey(u, assetId)).catch(() => null);
  if (kept && !kept.error && kept.data) { try { const d = JSON.parse(await kept.data.text()); if (d?.v === 1) return { subject: d.subject ?? null, size: d.size ?? size, cached: true }; } catch { /* read again */ } }
  const seconds = Number(asset.probe?.duration) || 0;
  const dir = await mkdtemp(join(tmpdir(), "studio-split-frame-"));
  try {
    const reads = deps.subjects ? await deps.subjects(url, seconds, dir, u)
      : await (async () => { const stills = (await keyStills(url, seconds, dir)).slice(0, 12); return readSubjects(deps, stills.map((s) => ({ t: s.at, jpg: s.jpeg })), u); })();
    const subject = settleSubject(reads);
    await sb.storage.from("studio-outputs").upload(frameKey(u, assetId), Buffer.from(JSON.stringify({ v: 1, subject, size, at: new Date().toISOString() })), { contentType: "text/plain", upsert: true }).catch(() => undefined);
    return { subject, size, cached: false };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
/** The auto-sizer's layout for a clip and a loop: the seam for this clip, its face framed, the loop's own action box. */
export function autoLayout(size: { w: number; h: number }, subject: Subject | null, loop: Loop | null): Layout {
  const seam = autoSeam(size, subject);
  const slot = halves({ mode: "split", seam, swap: false }).clip!;
  return cleanLayout({ mode: "split", seam, swap: false, clip: autoClipBox(size, slot, subject), game: loop?.box, captions: true });
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };
async function defaultFetchLoop(sb: SupabaseClient, loop: Loop, target: string) {
  const d = await sb.storage.from(LIBRARY_BUCKET).download(loopKey(loop.id));
  if (d.error || !d.data) throw new SplitError("splitscreen_loop_missing", "That gameplay could not be read", 502, true);
  await writeFile(target, Buffer.from(await d.data.arrayBuffer()));
}
export async function runSplitJob(sb: SupabaseClient, deps: SplitDeps, job: Job, library: Loop[] = LIBRARY): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id;
  const renew = async (p: Record<string, any>) => {
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...p } });
    if (r.error) throw r.error;
    if (r.data !== true) throw new SplitError("lease_lost", "lease lost");
    job.progress = { ...(job.progress ?? {}), ...p };
  };
  let dir: string | null = null;
  const t0 = Date.now();
  try {
    const loop = library.find((l) => l.id === o.loop_id) ?? null;
    if (!job.asset_id || !loop) throw new SplitError("splitscreen_no_loop", "Nothing to make");
    const layout = cleanLayout(o.layout);
    dir = await mkdtemp(join(tmpdir(), "studio-split-"));
    const d = dir;
    await renew({ stage: "reading", message: "Reading your video", stage_at: new Date().toISOString() });
    const { url } = await signedClip(sb, u, job.asset_id);
    const clip = join(d, "clip.mp4"), game = join(d, "game.mp4");
    await Promise.all([
      cutGate(env).run(() => (deps.prepare ?? prepareSource)(url, clip), () => renew({ message: "Next in line for the cutter" }).then(() => undefined)),
      (deps.fetchLoop ? deps.fetchLoop(loop, game) : defaultFetchLoop(sb, loop, game)),
    ]);
    const fake = !!deps.render;
    const size = fake ? { w: 720, h: 1280 } : await probeDimensions(clip).then((s) => ({ w: s.width, h: s.height }));
    const seconds = fake ? Number(o.seconds) : await probeSeconds(clip);
    const hasAudio = fake ? true : (await probeStream(clip)).hasAudio;

    let ass: string | null = null;
    if (layout.captions) {
      await renew({ stage: "words", message: "Writing the captions" });
      let words: CapWord[] = [];
      try { words = deps.words ? await deps.words(u, job.asset_id) : docWords((await readWords(sb, u, job.asset_id)) ?? await wordsFor(sb, deps, u, job.asset_id)); }
      catch (e: any) { log(`[splitscreen] no words for ${job.id}: ${String(e?.message ?? e).slice(0, 120)}`); }
      if (words.length) {
        const s = cleanSettings({ style: o.caption_style });
        const h = halves(layout);
        s.style = { ...s.style, y: layout.mode === "full" ? 0.5 : h.seamY };
        ass = join(d, "words.ass");
        await writeFile(ass, captionAss(words, s, SPLIT_OUT, env));
      }
    }

    await renew({ stage: "making", message: "Making your split screen", stage_at: new Date().toISOString() });
    const win = gameWindow(loop.seconds, seconds, job.id);
    const out = join(d, "out.mp4"), still = join(d, "out.jpg");
    const args = splitArgs({ clip: { file: clip, size, seconds, hasAudio }, game: { file: game, size: loop.size, ...win, safe: loop.safe }, layout, ass, assFilter: ass ? assFilter(ass, env) : undefined, target: out });
    await cutGate(env).run(() => (deps.render ? deps.render(args) : ffmpeg(args, { timeoutMs: 15 * 60_000 }).then(() => undefined)), () => renew({ message: "Next in line for the cutter" }).then(() => undefined));
    let posterOk = true;
    try { await (deps.poster ?? makePoster)(out, still); } catch { posterOk = false; }
    const bytes = (await stat(out)).size, base = `${u}/${job.id}/${job.lease_token}/1`;
    const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, await readFile(out), { contentType: "video/mp4", upsert: false });
    if (up.error) throw new SplitError("splitscreen_store_failed", String(up.error.message ?? up.error), 502, true);
    if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (p.error) posterOk = false; }
    const outputs = [{ index: 1, key: `${base}.mp4`, poster_key: posterOk ? `${base}.jpg` : undefined, kind: "video", bytes, duration: round2(seconds), tool: "splitscreen", loop: loop.id, captioned: !!ass }];
    const charged = Math.min(job.credits_reserved, splitCredits(seconds));
    await renew({ stage: "done", charged }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
    if (done.error) throw done.error;
    recordEvent({ user_id: u, kind: "feature", name: "splitscreen_done", props: { job: job.id, loop: loop.id, kind: loop.kind, seconds: round2(seconds), mode: layout.mode, seam: layout.seam, swap: layout.swap, captions: !!ass, credits: charged } });
    log(`[splitscreen] made ${JSON.stringify({ job: job.id, loop: loop.id, seconds: Math.round(seconds), run_s: Math.round((Date.now() - t0) / 1000), charged })}`);
    return "done";
  } catch (e: any) {
    const code = e instanceof ClipsError ? e.code : "splitscreen_failed";
    if (code === "lease_lost") return code;
    const retry = e instanceof ClipsError ? e.retry : true;
    log(`[splitscreen] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    const f = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry });
    if (f.error) log(`[splitscreen] could not record the failure of ${job.id}: ${f.error.message}`);
    return code;
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** Runs one or two at a time (STUDIO_SPLITSCREEN_PARALLEL): the cutting goes through the cutter shared with Clips,
 *  Captions and Stunts, so a second run only overlaps its reading with another's render. */
export function startSplitLoop(sbFn: () => SupabaseClient, deps: SplitDeps = {}, intervalMs = 8_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!splitscreenEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `splitscreen-${randomUUID()}`, max = Math.max(1, Math.min(2, Number(env.STUDIO_SPLITSCREEN_PARALLEL) || 2));
  const active = new Set<string>();
  let claiming = false;
  const tick = async () => {
    if (claiming || active.size >= max) return;
    claiming = true;
    try {
      const sb = sbFn();
      const room = await roomForAnother(env);
      if (!room.ok) return;
      const r = await sb.rpc("studio_claim", { p_tool: "splitscreen", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      active.add(job.id);
      const keep = setInterval(() => { sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }).then(() => undefined, () => undefined); }, 4 * 60_000);
      runSplitJob(sb, { ...deps, log }, job).then((s) => log(`[splitscreen] ${s} ${job.id}`)).catch((e) => log(`[splitscreen] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { clearInterval(keep); active.delete(job.id); });
    } catch (e: any) { log(`[splitscreen] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { claiming = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 31_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
export function registerSplit(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log"> & { isOwner: (req: any, sb: SupabaseClient) => Promise<boolean> }, deps: SplitDeps = {}, library: Loop[] = LIBRARY): void {
  const gate = async (req: any, sb: SupabaseClient) => {
    if (!splitscreenEnabled(h.env) || (!splitscreenOpen(h.env) && !(await h.isOwner(req, sb)))) throw new SplitError("splitscreen_off", "Split screen is not open yet", 403);
  };
  // The library (with short-lived links to each loop and its poster for the picker) and the price.
  app.get("/api/studio/splitscreen/config", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn(); await gate(req, sb);
      const keys = library.flatMap((l) => [loopKey(l.id), posterKey(l.id)]);
      const s = keys.length ? await sb.storage.from(LIBRARY_BUCKET).createSignedUrls(keys, 6 * 3600) : { data: [], error: null };
      const url = new Map<string, string>(((s as any).data ?? []).filter((x: any) => x?.signedUrl).map((x: any) => [x.path, x.signedUrl]));
      res.json({
        kinds: KINDS, limits: { min_seconds: SPLIT_LIMITS.min_seconds, max_seconds: SPLIT_LIMITS.max_seconds, seam_min: SPLIT_LIMITS.seam_min, seam_max: SPLIT_LIMITS.seam_max, zoom_max: SPLIT_LIMITS.zoom_max },
        price: SPLIT_PRICE, out: SPLIT_OUT,
        loops: library.map((l) => ({ id: l.id, kind: l.kind, name: l.name, seconds: l.seconds, size: l.size, safe: l.safe, box: l.box, video: url.get(loopKey(l.id)) ?? null, poster: url.get(posterKey(l.id)) ?? null })),
      });
    } catch (e) { h.fail(res, e); }
  });
  // The auto-sizer's layout for one of the person's videos (and a loop): read once per video, kept.
  app.post("/api/studio/splitscreen/frame", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn(); await gate(req, sb);
      const assetId = String(req.body?.asset_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new SplitError("video_not_found", "Pick a video", 404);
      const loop = loopById(req.body?.loop_id) ?? library.find((l) => l.id === req.body?.loop_id) ?? null;
      const { subject, size, cached } = await subjectFor(sb, { ...deps, env: h.env, log: h.log }, u, assetId);
      if (!cached) recordEvent({ user_id: u, kind: "feature", name: "splitscreen_frame", props: { asset: assetId, kind: subject?.kind ?? null } });
      res.json({ subject, size, layout: autoLayout(size, subject, loop) });
    } catch (e) { h.fail(res, e); }
  });
}
