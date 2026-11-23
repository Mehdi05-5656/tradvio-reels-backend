// Clone8 Studio: projects (the editor thread, phase 1; docs/editor/PLAN.md at the workspace root).
//
// Every clip the cutter makes gets a project: an edit file that, with the kept piece of recording, says exactly how the
// clip was made (where it starts and ends, how the picture is laid out, the captions and the sound), so it can be edited
// and re-rendered later and so every change a person makes can be learned from. The AI's proposal (ai_doc) is never
// changed; the current state (doc) carries a revision number.
//
// Phase 1 only writes: the project row and the kept recording, at cut time, behind STUDIO_EDITOR_ENABLED. Nothing here
// may fail or slow a clip noticeably: every step is caught, and the kept recording is a stream copy (no re-encode).
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ffmpeg, inputArgs, probeLocal, type CutCtx, type Moment, type Seg, type SourceInput } from "./studio-clips.js";

/** The version of the rules that make first cuts: bump when the cutter's choices change, so learning data can be grouped. */
export const AUTO_EDIT = "ae-2026.11.1";
export const SETTINGS = ["desktop_cam", "desktop_nocam", "irl", "talking_head", "podcast", "reaction", "screen_share", "produced", "other"] as const;
export type Setting = (typeof SETTINGS)[number];
export type Box = { x: number; y: number; w: number; h: number };

export type EditDoc = {
  v: 1;
  engine: string;
  kind: "clip" | "split";
  /** a Split screen video (edit-more.ts): the gameplay, the framing of both halves, the caption look; the trim, the
   *  captions' on/off and the sound come from the rest of the file. Only on kind "split". */
  split?: { loop_id: string; layout: { mode: "split" | "full"; seam: number; swap: boolean; clip: { zoom: number; cx: number; cy: number }; game: { zoom: number; cx: number; cy: number }; captions: boolean };
    caption_style: string; seed: string };
  made_by: { tool: "clips" | "live_clips" | "captions" | "splitscreen"; auto_edit: string; job_id: string; rank: number };
  /** the kept recording; times in this file are seconds inside it (or inside the clip itself when none was kept) */
  source: { key: string | null; seconds: number; width: number; height: number; fps: number | null;
    /** where the kept piece sits in the original video or stream, in seconds from its start */ origin_at: number;
    origin: Record<string, unknown> | null; expires: string | null;
    /** where `key` lives: the editor's own kept recordings (studio-outputs, the default), or a library video read in
     *  place (studio-uploads: the original a Captions or Split screen video was made from; edit-more.ts) */ bucket?: "studio-outputs" | "studio-uploads" };
  setting: { label: Setting | null; by: "ai" | "user"; sure: number | null };
  trim: { in: number; out: number; keep: Array<[number, number]> | null };
  canvas: { w: number; h: number; fps: number | null; format: "vertical" | "original";
    /** "original" at exactly w x h (a Captions video keeps its own size, up to 1080x1920) instead of the cutter's 1280 cap */ keep?: boolean };
  layout: { type: "stacked" | "content" | "follow" | "fit" | "original"; divider: number | null;
    panes: Array<{ role: "cam" | "content"; from: Box }>;
    /** the moving crop of a followed person: clip-relative seconds, x as a fraction of the width (studio-clips.ts Seg) */ path: Seg[] };
  captions: { on: boolean; style: Record<string, unknown> | null; keywords: boolean; fillers: boolean; censor: boolean; words: string | null; keys: number[]; fixes: unknown[] };
  extras: { title: string | null; punch_in: number | null; pause_trim: boolean; bottom_loop: unknown | null };
  sound: { level: number; limiter: boolean; muted: Array<{ from: number; to: number; why: string; locked: boolean }>;
    /** swear words in the sound: left as said, silenced, or bleeped (the editor's smart tool; edit-smart.ts) */ bleep?: "off" | "mute" | "tone";
    /** the sound as it was, without the loudness pass (a Captions video never had one) until the person sets a level */ raw?: boolean };
  meta: { title: string; hook: string | null; hook_line: string | null; score: number | null };
};

/** What Live Clips saw when it chose the layout (studio-live-clips.ts passes it on the cut's `edit`). */
export type LiveSeen = { layout?: "stacked" | "content" | "follow"; cam?: Box | null; content?: Box | null; irl?: boolean; tiny?: boolean; cam_h?: number | null };

export function editorOn(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.STUDIO_EDITOR_ENABLED ?? ""));
}
/** The editor itself, for everyone with a plan: STUDIO_EDITOR_OPEN. Until then only the owner's account opens it
 *  (projects are still recorded for every clip while STUDIO_EDITOR_ENABLED is on). */
export function editorOpen(env: Record<string, string | undefined> = process.env): boolean {
  return editorOn(env) && /^(1|true|yes|on)$/i.test(String(env.STUDIO_EDITOR_OPEN ?? ""));
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const okBox = (b: any): Box | null => (b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) ? { x: r3(+b.x), y: r3(+b.y), w: r3(+b.w), h: r3(+b.h) } : null);

/** The setting a clip was made in, as far as the cut's own choices tell (the "smart know" look replaces this in phase 2). */
export function settingOf(tool: "clips" | "live_clips", seen: LiveSeen | null, segs: Seg[], dur: number): { label: Setting | null; sure: number | null } {
  if (tool === "live_clips" && seen) {
    if (seen.irl) return { label: "irl", sure: 0.8 };
    if (seen.layout === "stacked") return { label: "desktop_cam", sure: 0.8 };
    if (seen.layout === "content") return { label: "desktop_nocam", sure: 0.65 };
    return { label: "irl", sure: 0.5 };
  }
  // a produced video changes shot often: more than one framing change every 8 seconds
  const changes = segs.length - 1;
  if (dur > 0 && changes >= 2 && changes / dur > 1 / 8) return { label: "produced", sure: 0.5 };
  return { label: null, sure: null };
}

/** The edit file for a clip as the cutter just made it. Pure: every value is handed in. */
export function clipDoc(p: {
  tool: "clips" | "live_clips"; jobId: string; m: Pick<Moment, "rank" | "start" | "end" | "title" | "hook" | "score"> & { hook_line?: string | null };
  info: { w: number; h: number; fps: number | null }; dur: number; format: "vertical" | "original"; frame: { w: number; h: number };
  segs: Seg[]; seen: LiveSeen | null; trim: Array<[number, number]> | null; captions: any | null; burned: boolean; keys: number[]; assetId: string;
  limiter: boolean; kept: { key: string; seconds: number; before: number; expires: string | null } | null; origin: Record<string, unknown> | null;
}): EditDoc {
  const before = p.kept ? p.kept.before : 0;
  const seen = p.seen;
  const cam = okBox(seen?.cam), content = okBox(seen?.content);
  let layout: EditDoc["layout"];
  if (p.format !== "vertical") layout = { type: "original", divider: null, panes: [], path: [] };
  else if (seen?.layout === "stacked" && cam) layout = { type: "stacked", divider: seen.cam_h ? r3(seen.cam_h / 1920) : null, panes: [{ role: "cam", from: cam }, ...(content ? [{ role: "content" as const, from: content }] : [])], path: [] };
  else if (seen?.layout === "content" && content) layout = { type: "content", divider: null, panes: [{ role: "content", from: content }], path: [] };
  else if (p.segs.length && p.segs.every((s) => s.mode === "fit")) layout = { type: "fit", divider: null, panes: [], path: p.segs.map((s) => ({ ...s })) };
  else layout = { type: "follow", divider: null, panes: [], path: p.segs.map((s) => ({ ...s })) };
  const st = settingOf(p.tool, seen, p.segs, p.dur);
  const c = p.burned && p.captions ? p.captions : null;
  return {
    v: 1, engine: "2026.11.0", kind: "clip",
    made_by: { tool: p.tool, auto_edit: AUTO_EDIT, job_id: p.jobId, rank: p.m.rank },
    source: { key: p.kept?.key ?? null, seconds: r3(p.kept ? p.kept.seconds : p.dur), width: p.info.w, height: p.info.h, fps: p.info.fps,
      origin_at: r3(p.m.start - before), origin: p.origin, expires: p.kept?.expires ?? null },
    setting: { label: st.label, by: "ai", sure: st.sure },
    trim: { in: r3(before), out: r3(before + p.dur), keep: p.trim && p.trim.length ? p.trim.map(([a, b]) => [r3(a), r3(b)] as [number, number]) : null },
    canvas: { w: p.frame.w, h: p.frame.h, fps: p.info.fps, format: p.format },
    layout,
    captions: { on: !!c, style: c?.style ?? null, keywords: c ? c.keywords !== false : true, fillers: c ? c.fillers !== false : true, censor: c ? c.censor === true : false,
      words: `captions/${p.assetId}.json`, keys: [...p.keys], fixes: [] },
    extras: { title: null, punch_in: null, pause_trim: !!(p.trim && p.trim.length), bottom_loop: null },
    sound: { level: -14, limiter: p.limiter, muted: [] },
    meta: { title: p.m.title, hook: p.m.hook ?? null, hook_line: p.m.hook_line ?? null, score: Number.isFinite(Number(p.m.score)) ? Number(p.m.score) : null },
  };
}

/** The channel or video a clip came from, from its collection's source: what channel layouts are shared by. */
export function sourceRefOf(source: any): string | null {
  if (!source || typeof source !== "object") return null;
  const platform = String(source.platform ?? "").toLowerCase();
  if ((platform === "twitch" || platform === "kick") && (source.channel_id || source.login)) return `${platform}:${String(source.channel_id || source.login).toLowerCase().slice(0, 100)}`;
  const url = String(source.url ?? "");
  const yt = url.match(/(?:youtu\.be\/|[?&]v=|\/(?:live|shorts|embed)\/)([A-Za-z0-9_-]{11})/);
  if (yt) return `youtube:${yt[1]}`;
  return null;
}

/** How much of the recording to keep on each side of a clip (seconds), and the most bytes worth keeping. */
export const KEEP = { pad: 15, max_bytes: 300 * 1024 * 1024, days: 30 };

/** The ffmpeg arguments that copy a clip's stretch of the source with spare seconds on each side, with no re-encode.
 *  Null when copying would cost money (a source read through the paid proxy). The copy is an MP4 whose edit list starts
 *  it exactly at the asked time, whatever keyframe the copy had to begin from. */
export function keepArgs(src: SourceInput, start: number, seconds: number, pad: number, out: string): { args: string[]; before: number } | null {
  if (src.proxy) return null;
  const floor = src.offset ?? 0;
  const before = Math.max(0, Math.min(pad, start - floor));
  return { before, args: ["-v", "error", "-nostdin", "-y", ...inputArgs(src, start - before, seconds + before + pad), "-c", "copy", "-movflags", "+faststart", "-f", "mp4", out] };
}

const collectionSources = new Map<string, Promise<any>>();
function collectionSource(sb: SupabaseClient, id: string): Promise<any> {
  let p = collectionSources.get(id);
  if (!p) {
    p = Promise.resolve(sb.from("studio_collections").select("source").eq("id", id).maybeSingle()).then((r: any) => r?.data?.source ?? null).catch(() => null);
    collectionSources.set(id, p);
    if (collectionSources.size > 200) collectionSources.delete(collectionSources.keys().next().value as string);
  }
  return p;
}
/** Only the fields worth keeping from a collection's source (no thumbnails or tokens). */
function originOf(source: any): Record<string, unknown> | null {
  if (!source || typeof source !== "object") return null;
  const keep = ["platform", "url", "vod_id", "channel_id", "login", "channel", "title", "seconds"];
  const o: Record<string, unknown> = {};
  for (const k of keep) if (source[k] != null) o[k] = source[k];
  return Object.keys(o).length ? o : null;
}

/** Called by cutClip once a clip is stored: keeps its stretch of the recording and writes its project. Never throws. */
export async function recordClipProject(p: {
  ctx: CutCtx & { edit?: LiveSeen | null }; m: Moment; assetId: string; info: { w: number; h: number; fps: number | null; seconds: number };
  segs: Seg[]; frame: { w: number; h: number }; burned: boolean; keys: number[];
}): Promise<string | null> {
  const { ctx, m } = p;
  const env = ctx.deps.env ?? process.env;
  if (!editorOn(env)) return null;
  const log = ctx.deps.log ?? ((l: string) => console.log(l));
  const tool: "clips" | "live_clips" = ctx.edit ? "live_clips" : "clips";
  const id = randomUUID();
  const dur = p.info.seconds || m.end - m.start;
  let kept: { key: string; seconds: number; before: number; expires: string | null; bytes: number } | null = null;
  const file = join(ctx.dir, `keep${m.rank}.mp4`);
  try {
    const pad = Number(env.STUDIO_EDITOR_PAD_S ?? KEEP.pad);
    const plan = keepArgs(ctx.src, m.start, dur, Number.isFinite(pad) ? Math.max(0, Math.min(60, pad)) : KEEP.pad, file);
    if (plan) {
      await ffmpeg(plan.args, { timeoutMs: 120_000 });
      const bytes = (await stat(file)).size;
      const got = await probeLocal(file);
      if (bytes > 0 && bytes <= KEEP.max_bytes && got.seconds >= dur * 0.9) {
        const key = `${ctx.u}/edit/${id}/source.mp4`;
        const up = await ctx.sb.storage.from("studio-outputs").upload(key, await readFile(file), { contentType: "video/mp4", upsert: false });
        if (up.error) throw up.error;
        const days = Number(env.STUDIO_EDITOR_KEEP_DAYS ?? KEEP.days);
        kept = { key, bytes, seconds: got.seconds, before: plan.before, expires: Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null };
      }
    }
  } catch (e: any) {
    log(`[editor] recording not kept for clip ${m.rank} of ${ctx.jobId}: ${String(e?.message ?? e).slice(0, 160)}`);
    kept = null;
  } finally { await rm(file, { force: true }).catch(() => undefined); }
  try {
    const source = await collectionSource(ctx.sb, ctx.collectionId);
    const doc = clipDoc({ tool, jobId: ctx.jobId, m, info: p.info, dur, format: ctx.format, frame: p.frame, segs: p.segs, seen: ctx.edit ?? null, trim: ctx.trim ?? null,
      captions: ctx.captions ?? null, burned: p.burned, keys: p.keys, assetId: p.assetId, limiter: !!ctx.limiter, kept, origin: originOf(source) });
    const ins = await ctx.sb.from("studio_projects").insert({
      id, user_id: ctx.u, asset_id: p.assetId, job_id: ctx.jobId, collection_id: ctx.collectionId, tool, auto_edit: AUTO_EDIT,
      setting: doc.setting.label, setting_by: "ai", setting_sure: doc.setting.sure, source_ref: sourceRefOf(source),
      ai_doc: doc, doc, rev: 1, rendered_rev: 1, source_key: kept?.key ?? null, source_bytes: kept?.bytes ?? null, source_expires_at: kept?.expires ?? null,
    });
    if (ins.error) throw ins.error;
    return id;
  } catch (e: any) {
    log(`[editor] project not written for clip ${m.rank} of ${ctx.jobId}: ${String(e?.message ?? e).slice(0, 160)}`);
    if (kept) await ctx.sb.storage.from("studio-outputs").remove([kept.key]).catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// How far a person's version is from the AI's: the learning label, per part
// ---------------------------------------------------------------------------------------------------
const iou = (a: Box, b: Box) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 1;
};
export type DocDistance = { changed: boolean; start_s: number; end_s: number; layout_changed: boolean; cam_iou: number | null; content_iou: number | null;
  divider: number | null; captions_on_changed: boolean; caption_style_changed: boolean; caption_y: number | null; words_fixed: number; setting_changed: boolean };
export function docDistance(ai: EditDoc, now: EditDoc): DocDistance {
  const pane = (d: EditDoc, role: "cam" | "content") => d.layout.panes.find((x) => x.role === role)?.from ?? null;
  const box = (role: "cam" | "content") => { const a = pane(ai, role), b = pane(now, role); return a && b ? r3(iou(a, b)) : a || b ? 0 : null; };
  const y = (d: EditDoc) => Number((d.captions.style as any)?.y);
  const d: DocDistance = {
    changed: false,
    start_s: r3(now.trim.in - ai.trim.in), end_s: r3(now.trim.out - ai.trim.out),
    layout_changed: ai.layout.type !== now.layout.type,
    cam_iou: box("cam"), content_iou: box("content"),
    divider: ai.layout.divider != null && now.layout.divider != null ? r3(now.layout.divider - ai.layout.divider) : null,
    captions_on_changed: ai.captions.on !== now.captions.on,
    caption_style_changed: String((ai.captions.style as any)?.id ?? "") !== String((now.captions.style as any)?.id ?? ""),
    caption_y: Number.isFinite(y(ai)) && Number.isFinite(y(now)) ? r3(y(now) - y(ai)) : null,
    words_fixed: now.captions.fixes.length,
    setting_changed: ai.setting.label !== now.setting.label,
  };
  d.changed = d.start_s !== 0 || d.end_s !== 0 || d.layout_changed || (d.cam_iou != null && d.cam_iou < 0.98) || (d.content_iou != null && d.content_iou < 0.98)
    || (d.divider != null && d.divider !== 0) || d.captions_on_changed || d.caption_style_changed || (d.caption_y != null && d.caption_y !== 0) || d.words_fixed > 0 || d.setting_changed;
  return d;
}
