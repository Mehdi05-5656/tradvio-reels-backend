// Clone8 Studio: the editor for videos the clip cutter did not make (editor thread, Nov 23 2026;
// docs/editor/PLAN_SPLIT_CAPTIONS.md at the workspace root).
//
// A Captions video is made from an original that stays in the library, so its project keeps no recording of its own:
// it reads the original in place (source.bucket "studio-uploads"). When the original is a Clips clip with a project,
// the captioned video's project is a copy of that one (the same kept recording, trim and layout), so the whole clip
// editor works on it. Otherwise it is the whole picture at the Captions video's own size, captions on.
//
// Projects are written when the video is made (a hook in runCaptionsJob) and, for videos made before, the first time
// one is opened (ensureProjectFor). Every step is caught: nothing here can fail a run. Off unless STUDIO_EDITOR_ENABLED.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTO_EDIT, editorOn, type EditDoc } from "./studio-projects.js";
import type { CapWord } from "./caption-engine.js";
import { cleanSplitLayout, SPLIT_STYLES } from "./edit-split-doc.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
// static on purpose: a dynamic import of the tools' modules reorders the bundle's start-up and breaks the Clips classes
import { ffmpeg, probeLocal } from "./studio-clips.js";
import { splitArgs } from "./studio-splitscreen.js";
import { LIBRARY_BUCKET, loopById, loopKey } from "./studio-splitscreen-library.js";
import { cleanLayout, gameWindow, halves, SPLIT_OUT } from "./splitscreen-layout.js";
export { cleanSplit, cleanSplitLayout, SPLIT_STYLES } from "./edit-split-doc.js";

type Env = Record<string, string | undefined>;
type Deps = { env?: Env; log?: (l: string) => void };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** How long a deleted original is kept for the projects that read it (the same 30 days as a kept recording). */
export const ORIGINAL_KEEP_DAYS = 30;

export type CaptionSettingsLike = { style: Record<string, unknown>; keywords: boolean; fillers: boolean; censor: boolean };
type Original = { id: string; object_key: string; probe: any };
type BaseProject = { doc: EditDoc; source_key: string | null; source_expires_at: string | null; rev: number; rendered_rev: number; render_state: string | null };

/** A project of the original that a captioned copy can start from: its recording kept and not cleared, the library clip
 *  rendered from its current file, and no cut-out pauses (their words are in the cut clip's time, not the recording's). */
export function cloneable(p: BaseProject | null, now = Date.now()): p is BaseProject & { source_key: string } {
  if (!p?.source_key || !p.doc) return false;
  if (p.source_expires_at && new Date(p.source_expires_at).getTime() < now) return false;
  if (p.rendered_rev !== p.rev || p.render_state === "failed" || p.render_state === "queued" || p.render_state === "rendering") return false;
  return !p.doc.trim.keep && !p.doc.extras.pause_trim;
}

/** The edit file of a Captions video. Pure. */
export function captionDoc(p: { copyId: string; jobId: string; original: Original; frame: { w: number; h: number }; settings: CaptionSettingsLike; keys: number[];
  base: (BaseProject & { source_key: string }) | null }): EditDoc {
  const captions: EditDoc["captions"] = { on: true, style: p.settings.style, keywords: p.settings.keywords, fillers: p.settings.fillers, censor: p.settings.censor,
    words: `captions/${p.copyId}.json`, keys: [...p.keys], fixes: [] };
  const made_by: EditDoc["made_by"] = { tool: "captions", auto_edit: AUTO_EDIT, job_id: p.jobId, rank: 0 };
  if (p.base) {
    const b = p.base.doc;
    return { ...b, made_by, source: { ...b.source, bucket: b.source.bucket ?? "studio-outputs" }, captions, sound: { ...b.sound } };
  }
  const pr = p.original.probe ?? {};
  const seconds = r3(Number(pr.duration) || 0);
  return {
    v: 1, engine: "2026.11.0", kind: "clip", made_by,
    source: { key: p.original.object_key, seconds, width: Number(pr.width) || p.frame.w, height: Number(pr.height) || p.frame.h, fps: null,
      origin_at: 0, origin: null, expires: null, bucket: "studio-uploads" },
    setting: { label: null, by: "ai", sure: null },
    trim: { in: 0, out: seconds, keep: null },
    canvas: { w: p.frame.w, h: p.frame.h, fps: null, format: "original", keep: true },
    layout: { type: "original", divider: null, panes: [], path: [] },
    captions,
    extras: { title: null, punch_in: null, pause_trim: false, bottom_loop: null },
    sound: { level: -14, limiter: false, muted: [], raw: true },
    meta: { title: String(pr.title ?? "").slice(0, 200), hook: pr.hook ?? null, hook_line: null, score: Number.isFinite(Number(pr.score)) ? Number(pr.score) : null },
  };
}

const wordsDoc = (words: CapWord[], language: string | null, duration: number | null) => ({
  v: 1 as const, words: words.map((w) => [w.text, r3(w.start), r3(w.end), w.speaker ?? null] as [string, number, number, string | null]),
  keys: words.map((w, i) => (w.key ? i : -1)).filter((i) => i >= 0), language, duration, at: new Date().toISOString(),
});

/** Called by runCaptionsJob once a captioned copy is stored. `words` are the person's edited words (null = as heard).
 *  Never throws; returns the project id or null. */
export async function recordCaptionProject(sb: SupabaseClient, deps: Deps, p: { u: string; copyId: string; originalId: string; jobId: string;
  words: CapWord[] | null; settings: CaptionSettingsLike; frame: { w: number; h: number } }): Promise<string | null> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  if (!editorOn(env)) return null;
  try {
    const o = await sb.from("studio_assets").select("id,object_key,probe,status").eq("id", p.originalId).eq("user_id", p.u).maybeSingle();
    if (o.error) throw o.error;
    if (!o.data || o.data.status === "deleted" || !o.data.object_key) return null;
    const bp = await sb.from("studio_projects").select("doc,source_key,source_expires_at,rev,rendered_rev,render_state").eq("asset_id", p.originalId).eq("user_id", p.u).maybeSingle();
    const base = bp.data && cloneable(bp.data as any) ? (bp.data as any) : null;
    // the words the copy was captioned with, kept beside the project (the editor opens on them)
    const cv = await import("./studio-caption-video.js");
    let words = p.words && p.words.length ? p.words : null, language: string | null = null;
    const heard = await cv.readWords(sb, p.u, p.originalId).catch(() => null);
    if (!words && heard) words = cv.docWords(heard);
    language = heard?.language ?? null;
    const id = randomUUID();
    const doc = captionDoc({ copyId: p.copyId, jobId: p.jobId, original: o.data as Original, frame: p.frame, settings: p.settings, keys: [], base });
    if (words?.length) {
      const wd = wordsDoc(words, language, doc.source.seconds || null);
      doc.captions.keys = wd.keys;
      const { projectWordsKey } = await import("./studio-editor.js");
      const up = await sb.storage.from("studio-outputs").upload(projectWordsKey(p.u, id), Buffer.from(JSON.stringify(wd)), { contentType: "text/plain", upsert: true });
      if (up.error) throw up.error;
    }
    const ins = await sb.from("studio_projects").insert({
      id, user_id: p.u, asset_id: p.copyId, job_id: p.jobId, collection_id: null, tool: "captions", auto_edit: AUTO_EDIT,
      setting: doc.setting.label, setting_by: "ai", setting_sure: doc.setting.sure, source_ref: null,
      ai_doc: doc, doc, rev: 1, rendered_rev: 1, source_key: base ? base.source_key : o.data.object_key, source_bytes: null,
      source_expires_at: base ? base.source_expires_at : null,
    });
    if (ins.error) {
      if (String(ins.error.code) === "23505") return null; // another open made it a moment ago
      throw ins.error;
    }
    // the library row says it can be edited (the app shows "Edit this clip" on it)
    const a = await sb.from("studio_assets").select("probe").eq("id", p.copyId).maybeSingle();
    if (a.data) await sb.from("studio_assets").update({ probe: { ...(a.data.probe ?? {}), editable: true } }).eq("id", p.copyId);
    return id;
  } catch (e: any) {
    log(`[editor] captions project not written for ${p.copyId}: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}

/** A video made before its tool wrote projects: its project made now from its run. True when there is one now. */
export async function ensureProjectFor(sb: SupabaseClient, deps: Deps, u: string, assetId: string): Promise<boolean> {
  try {
    if (!editorOn(deps.env ?? process.env)) return false;
    const a = await sb.from("studio_assets").select("id,probe,status").eq("id", assetId).eq("user_id", u).maybeSingle();
    if (!a.data || a.data.status === "deleted") return false;
    const c = a.data.probe?.captions;
    if (c && typeof c.from === "string" && UUID.test(c.from) && typeof c.job_id === "string" && UUID.test(c.job_id)) {
      const j = await sb.from("studio_jobs").select("id,options").eq("id", c.job_id).eq("user_id", u).eq("tool", "captions").maybeSingle();
      if (!j.data) return false;
      const o = j.data.options ?? {};
      const it = (Array.isArray(o.items) ? o.items : []).find((x: any) => x?.asset_id === c.from);
      const cv = await import("./studio-caption-video.js");
      const settings = cv.cleanSettings(o);
      const pr = a.data.probe ?? {};
      const frame = Number(pr.width) > 0 && Number(pr.height) > 0 ? { w: Number(pr.width), h: Number(pr.height) } : { w: 1080, h: 1920 };
      const words = Array.isArray(it?.words) && it.words.length ? (it.words as CapWord[]) : null;
      return !!(await recordCaptionProject(sb, deps, { u, copyId: assetId, originalId: c.from, jobId: c.job_id, words, settings, frame }));
    }
    return false;
  } catch { return false; }
}

/** Library files that an edit project reads in place: kept when their video is deleted, for ORIGINAL_KEEP_DAYS from the
 *  delete (the project's source then expires like a kept recording). Returns the keys to leave in storage. */
export async function keptForEdits(sb: SupabaseClient, u: string, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  try {
    const r = await sb.from("studio_projects").select("id,source_key,source_expires_at").eq("user_id", u).in("source_key", keys);
    if (r.error) return out;
    const until = new Date(Date.now() + ORIGINAL_KEEP_DAYS * 86400_000).toISOString();
    for (const p of (r.data ?? []) as any[]) {
      out.add(p.source_key);
      if (!p.source_expires_at) await sb.from("studio_projects").update({ source_expires_at: until }).eq("id", p.id);
    }
  } catch { /* deleting goes on as before */ }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Split screen videos
// ---------------------------------------------------------------------------------------------------
// A Split screen video is the person's video (still in the library) in one half and a gameplay loop in the other. Its
// project reads the original in place, and a save renders it again with the tool's own splitArgs, so an untouched
// save comes out as the run made it. The video is a run output (studio_jobs.outputs), not a library row: a save puts
// the new file in place of the run's output (the old file is left, since a scheduled post may point at it).

/** The edit file of a Split screen run. Pure. */
export function splitDoc(p: { jobId: string; original: Original; options: any; loops?: Array<{ id: string }> }): EditDoc {
  const pr = p.original.probe ?? {};
  const seconds = r3(Number(pr.duration) || Number(p.options?.seconds) || 0);
  const layout = cleanSplitLayout(p.options?.layout);
  const style = SPLIT_STYLES.includes(p.options?.caption_style) ? p.options.caption_style : "bold_pop";
  return {
    v: 1, engine: "2026.11.0", kind: "split",
    made_by: { tool: "splitscreen", auto_edit: AUTO_EDIT, job_id: p.jobId, rank: 0 },
    source: { key: p.original.object_key, seconds, width: Number(pr.width) || 1080, height: Number(pr.height) || 1920, fps: null, origin_at: 0, origin: null, expires: null, bucket: "studio-uploads" },
    setting: { label: null, by: "ai", sure: null },
    trim: { in: 0, out: seconds, keep: null },
    canvas: { w: 720, h: 1280, fps: 30, format: "vertical" },
    layout: { type: "fit", divider: null, panes: [], path: [] },
    captions: { on: layout.captions, style: null, keywords: true, fillers: true, censor: false, words: `captions/${p.original.id}.json`, keys: [], fixes: [] },
    extras: { title: null, punch_in: null, pause_trim: false, bottom_loop: null },
    sound: { level: -14, limiter: false, muted: [], raw: true },
    meta: { title: String(pr.title ?? p.options?.name ?? "").slice(0, 200), hook: null, hook_line: null, score: null },
    split: { loop_id: String(p.options?.loop_id ?? ""), layout, caption_style: style, seed: p.jobId },
  };
}
/** Called by runSplitJob once its video is stored (or by ensureProjectFor for runs made before). Never throws. */
export async function recordSplitProject(sb: SupabaseClient, deps: Deps, p: { u: string; jobId: string; originalId: string; options: any }): Promise<string | null> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  if (!editorOn(env)) return null;
  try {
    const have = await sb.from("studio_projects").select("id").eq("job_id", p.jobId).eq("user_id", p.u).maybeSingle();
    if (have.data) return (have.data as any).id;
    const o = await sb.from("studio_assets").select("id,object_key,probe,status").eq("id", p.originalId).eq("user_id", p.u).maybeSingle();
    if (o.error) throw o.error;
    if (!o.data || o.data.status === "deleted" || !o.data.object_key) return null;
    const id = randomUUID();
    const doc = splitDoc({ jobId: p.jobId, original: o.data as Original, options: p.options });
    const cv = await import("./studio-caption-video.js");
    const heard = await cv.readWords(sb, p.u, p.originalId).catch(() => null);
    if (heard) {
      doc.captions.keys = heard.keys ?? [];
      const { projectWordsKey } = await import("./studio-editor.js");
      await sb.storage.from("studio-outputs").upload(projectWordsKey(p.u, id), Buffer.from(JSON.stringify(heard)), { contentType: "text/plain", upsert: true });
    }
    const ins = await sb.from("studio_projects").insert({
      id, user_id: p.u, asset_id: null, job_id: p.jobId, collection_id: null, tool: "splitscreen", auto_edit: AUTO_EDIT,
      setting: null, setting_by: "ai", setting_sure: null, source_ref: null,
      ai_doc: doc, doc, rev: 1, rendered_rev: 1, source_key: o.data.object_key, source_bytes: null, source_expires_at: null,
    });
    if (ins.error) throw ins.error;
    return id;
  } catch (e: any) {
    log(`[editor] split project not written for ${p.jobId}: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}

/** A Split screen run made before projects: its project made now. True when there is one. */
export async function ensureSplitProject(sb: SupabaseClient, deps: Deps, u: string, jobId: string): Promise<boolean> {
  try {
    if (!editorOn(deps.env ?? process.env) || !UUID.test(jobId)) return false;
    const j = await sb.from("studio_jobs").select("id,asset_id,options,status").eq("id", jobId).eq("user_id", u).eq("tool", "splitscreen").maybeSingle();
    if (!j.data || j.data.status !== "done" || !j.data.asset_id) return false;
    return !!(await recordSplitProject(sb, deps, { u, jobId, originalId: j.data.asset_id, options: j.data.options ?? {} }));
  } catch { return false; }
}

export type SplitRenderDeps = Deps & { run?: (args: string[]) => Promise<unknown>;
  /** test hooks: the working copy of the original, the poster */ prepare?: (url: string, target: string) => Promise<void>; poster?: (video: string, target: string) => Promise<void> };

/** Make a Split screen video again from its edited file and put it in place of the run's output. Called by
 *  renderProject (inside the cutter's gate). Returns the new length in seconds. */
export async function renderSplit(sb: SupabaseClient, p: { id: string; user_id: string; job_id: string; ai_doc: EditDoc; doc: EditDoc; rev: number; source_key: string }, dir: string, deps: SplitRenderDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? ((args: string[]) => ffmpeg(args, { timeoutMs: 15 * 60_000 }));
  const doc = p.doc, sp = doc.split;
  if (!sp) throw new Error("not a split screen file");
  const loop = loopById(sp.loop_id);
  if (!loop) throw new Error("that gameplay is no longer in the library");
  const { bucketOf, projectWords, shiftWords } = await import("./studio-editor.js");
  // the original, at the tool's working size
  const s = await sb.storage.from(bucketOf(doc)).createSignedUrl(p.source_key, 3 * 3600);
  if (s.error || !s.data?.signedUrl) throw new Error("the original video could not be read");
  const clip = join(dir, "clip.mp4");
  await (deps.prepare ?? ((url: string, target: string) => run(prepareArgs(url, target)).then(() => undefined)))(s.data.signedUrl, clip);
  const probe = await probeLocal(clip), hasAudio = await audioIn(clip);
  // an untouched length is the working copy's own (what the run measured), so the same gameplay stretch is picked
  const whole = doc.trim.in < 0.05 && doc.trim.out >= doc.source.seconds - 0.05;
  const len = whole && probe.seconds > 0 ? probe.seconds : Math.max(0.5, doc.trim.out - doc.trim.in);
  // the gameplay: the same stretch for the same run and length (gameWindow), read whole when it has to repeat
  const win = gameWindow(loop.seconds, len, sp.seed);
  let game = join(dir, "game.mp4");
  if (win.loop) {
    const d = await sb.storage.from(LIBRARY_BUCKET).download(loopKey(loop.id));
    if (d.error || !d.data) throw new Error("that gameplay could not be read");
    await writeFile(game, Buffer.from(await d.data.arrayBuffer()));
  } else {
    const g = await sb.storage.from(LIBRARY_BUCKET).createSignedUrl(loopKey(loop.id), 3600);
    if (g.error || !g.data?.signedUrl) throw new Error("that gameplay could not be read");
    game = g.data.signedUrl;
  }
  // the words, moved to the trimmed clip's time, on the seam
  const layout = cleanLayout(sp.layout);
  let ass: string | null = null, assFilter: string | undefined;
  if (layout.captions) {
    const orig = String(doc.captions.words ?? "").match(/[0-9a-f-]{36}/i)?.[0] ?? "00000000-0000-0000-0000-000000000000";
    const wd = await projectWords(sb, p.user_id, p.id, orig).catch(() => null);
    let words = wd ? shiftWords(wd.words, p.ai_doc, doc, wd.keys) : [];
    if (!wd && UUID.test(orig)) {
      // captions turned on for a video never heard: its words now (about a third of a cent a minute, free by the
      // editor's rule), kept on the original for next time; times are the original's, as the project's are
      const cv = await import("./studio-caption-video.js");
      const heard = await cv.wordsFor(sb, { env, log: deps.log }, p.user_id, orig).catch(() => null);
      if (heard) words = shiftWords(heard.words, p.ai_doc, doc, heard.keys);
    }
    if (words.length) {
      const cv = await import("./studio-caption-video.js");
      const st = cv.cleanSettings({ style: sp.caption_style, keywords: doc.captions.keywords, fillers: doc.captions.fillers, censor: doc.captions.censor });
      st.style = { ...st.style, y: layout.mode === "full" ? 0.5 : halves(layout).seamY };
      ass = join(dir, "words.ass");
      await writeFile(ass, cv.captionAss(words, st, SPLIT_OUT, env));
      assFilter = cv.assFilter(ass, env);
    }
  }
  const out = join(dir, "out.mp4"), still = join(dir, "out.jpg");
  const args = splitArgs({ clip: { file: clip, size: { w: probe.w, h: probe.h }, seconds: len, hasAudio }, game: { file: game, size: loop.size, ...win, safe: loop.safe }, layout, ass, assFilter, target: out });
  // the trim: the clip is read from the edited start (accurate input seek)
  if (doc.trim.in > 0.01) { const k = args.indexOf(clip); args.splice(k - 1, 0, "-ss", doc.trim.in.toFixed(3)); }
  await run(args);
  await (deps.poster ?? ((v: string, t: string) => run(["-v", "error", "-nostdin", "-y", "-ss", "0.5", "-i", v, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", t]).then(() => undefined)))(out, still).catch(() => undefined);
  const bytes = (await stat(out)).size, seconds = r3((await probeLocal(out).catch(() => null))?.seconds || len);
  const base = `${p.user_id}/${p.job_id}/edit-${randomUUID()}`;
  const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, await readFile(out), { contentType: "video/mp4", upsert: false });
  if (up.error) throw up.error;
  let posterKey: string | undefined = `${base}.jpg`;
  try { const pu = await sb.storage.from("studio-outputs").upload(posterKey, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (pu.error) posterKey = undefined; } catch { posterKey = undefined; }
  // the run's output now points at the new file (the old one stays: a scheduled post may still read it)
  const j = await sb.from("studio_jobs").select("outputs").eq("id", p.job_id).eq("user_id", p.user_id).maybeSingle();
  const outs: any[] = Array.isArray((j.data as any)?.outputs) ? (j.data as any).outputs : [];
  const first = { ...(outs[0] ?? { index: 1, kind: "video", tool: "splitscreen" }), key: `${base}.mp4`, poster_key: posterKey, bytes, duration: seconds, loop: loop.id, captioned: !!ass, edited: { rev: p.rev, at: new Date().toISOString() } };
  const uj = await sb.from("studio_jobs").update({ outputs: [first, ...outs.slice(1)] }).eq("id", p.job_id).eq("user_id", p.user_id);
  if (uj.error) throw uj.error;
  return seconds;
}

/** The Split screen tool's working copy of a video (studio-stunts.ts defaultPrepare, which the run uses): 720 on the
 *  short side, 30 fps. Kept identical so an untouched save frames exactly as the run did (a test compares the two). */
export function prepareArgs(url: string, target: string): string[] {
  return ["-v", "error", "-nostdin", "-y", ...(/^https?:/.test(url) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"] : []), "-i", url, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='if(lt(iw,ih),min(720,iw),-2)':'if(lt(iw,ih),-2,min(720,ih))':force_divisible_by=2,fps=30,setsar=1,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-g", "15", "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", target];
}
/** Whether a file has a sound track. */
function audioIn(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let o = ""; c.stdout.on("data", (b) => { o += b.toString(); }); c.on("error", () => resolve(false)); c.on("close", () => resolve(o.trim().length > 0));
  });
}
