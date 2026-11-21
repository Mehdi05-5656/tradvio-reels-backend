// Clone8 Studio: the editor's routes and its render worker (editor thread, phase 2; docs/editor/PLAN.md §15).
//
//   GET  /api/studio/projects/by-asset/:assetId   a clip's project (made by the cutter, studio-projects.ts)
//   GET  /api/studio/projects/:id                 the same by id
//   PUT  /api/studio/projects/:id                 save an edited file {rev, doc, ops?, device?, surface?, session?}:
//                                                 refused with 409 and the current state when rev is not the latest
//   POST /api/studio/projects/:id/render          make the clip again from the edited file (free; fair-use cap)
//
// Paying plans only (and the owner pass); off unless STUDIO_EDITOR_ENABLED. The render reuses the cutter's builders
// (edit-render.ts) on the kept recording, and replaces the clip in the library rather than adding one.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg, probeLocal } from "./studio-clips.js";
import { cutGate } from "./studio-capacity.js";
import { recordEvent } from "./studio-events.js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { renderArgs } from "./edit-render.js";
import { pausePlan, swearRanges } from "./edit-smart.js";
import { trimRemap } from "./studio-clips.js";
import { editorOn, SETTINGS, type Box, type EditDoc } from "./studio-projects.js";

export type EditorDeps = { env?: Record<string, string | undefined>; log?: (l: string) => void; run?: (args: string[]) => Promise<unknown> };
export class EditorError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** Renders a project may have per UTC day before it waits for tomorrow (each costs us about a tenth of a cent). */
export const RENDERS_PER_DAY = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = /^[a-z_]+(\.[a-z_]+)*$/;
const num = (v: unknown, lo: number, hi: number): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function cleanBox(b: any): Box | null {
  if (!b || typeof b !== "object") return null;
  const x = num(b.x, 0, 1), y = num(b.y, 0, 1), w = num(b.w, 0.02, 1), h = num(b.h, 0.02, 1);
  if (x == null || y == null || w == null || h == null) return null;
  return { x: r3(x), y: r3(y), w: r3(Math.min(w, 1 - x)), h: r3(Math.min(h, 1 - y)) };
}

/** A person's edited file, checked against the AI's: what the person may change is taken from `next`, everything that
 *  describes the recording and how the clip was made stays as the AI wrote it. Throws on a file that cannot render. */
export function cleanDoc(ai: EditDoc, next: any): EditDoc {
  if (!next || typeof next !== "object") throw new EditorError("bad_doc", "The edit file is missing");
  const len = ai.source.seconds;
  const tin = num(next.trim?.in, 0, len), tout = num(next.trim?.out, 0, len);
  if (tin == null || tout == null || tout - tin < 1) throw new EditorError("bad_trim", "A clip has to be at least a second long");
  if (tout - tin > 600) throw new EditorError("bad_trim", "A clip can be ten minutes at most");
  const types = ["stacked", "content", "follow", "fit", "original"] as const;
  const type = types.includes(next.layout?.type) ? next.layout.type : ai.layout.type;
  const panes = Array.isArray(next.layout?.panes) ? next.layout.panes.slice(0, 4).map((p: any) => ({ role: p?.role === "cam" ? "cam" : "content", from: cleanBox(p?.from) }))
    .filter((p: any) => p.from) as EditDoc["layout"]["panes"] : ai.layout.panes;
  if (type === "stacked" && !panes.some((p) => p.role === "cam")) throw new EditorError("bad_layout", "Stacked needs a face-cam box");
  if (type === "content" && !panes.some((p) => p.role === "content")) throw new EditorError("bad_layout", "This layout needs a box around the content");
  const path = Array.isArray(next.layout?.path) ? next.layout.path.slice(0, 400).map((s: any) => ({ start: num(s?.start, 0, 600) ?? 0, end: num(s?.end, 0, 600) ?? 0,
    mode: s?.mode === "fit" ? "fit" as const : "crop" as const, x0: num(s?.x0, 0, 1) ?? 0.5, x1: num(s?.x1, 0, 1) ?? 0.5 })).filter((s: any) => s.end > s.start) : ai.layout.path;
  const label = SETTINGS.includes(next.setting?.label) ? next.setting.label : ai.setting.label;
  const locked = ai.sound.muted.filter((m) => m.locked);
  const own = Array.isArray(next.sound?.muted) ? next.sound.muted.filter((m: any) => !m?.locked).slice(0, 50).map((m: any) => ({ from: num(m?.from, 0, len) ?? 0, to: num(m?.to, 0, len) ?? 0, why: String(m?.why ?? "user").slice(0, 20), locked: false })).filter((m: any) => m.to > m.from) : [];
  const style = next.captions?.style && typeof next.captions.style === "object" ? next.captions.style : ai.captions.style;
  return {
    ...ai,
    setting: { label, by: label !== ai.setting.label ? "user" : ai.setting.by, sure: label !== ai.setting.label ? 1 : ai.setting.sure },
    trim: { in: r3(tin), out: r3(tout), keep: null },
    layout: { type, divider: num(next.layout?.divider, 0.15, 0.6), panes, path },
    captions: { ...ai.captions, on: next.captions?.on === true, style, keywords: next.captions?.keywords !== false, fillers: next.captions?.fillers !== false, censor: next.captions?.censor === true,
      fixes: Array.isArray(next.captions?.fixes) ? next.captions.fixes.slice(0, 500) : [] },
    extras: { title: typeof next.extras?.title === "string" ? next.extras.title.slice(0, 120) : null, punch_in: num(next.extras?.punch_in, 0, 600), pause_trim: next.extras?.pause_trim === true, bottom_loop: next.extras?.bottom_loop ?? null },
    sound: { level: num(next.sound?.level, -24, -8) ?? ai.sound.level, limiter: ai.sound.limiter, muted: [...locked, ...own], bleep: ["mute", "tone"].includes(next.sound?.bleep) ? next.sound.bleep : "off" },
  };
}

/** The clip's words (saved relative to the clip the cutter made) moved to the edited clip's own time. */
export function shiftWords(words: Array<[string, number, number, string | null]>, ai: EditDoc, doc: EditDoc, keys: number[] = []) {
  const shift = ai.trim.in - doc.trim.in, len = doc.trim.out - doc.trim.in;
  const fixes = new Map<number, string>();
  for (const f of doc.captions.fixes as any[]) if (f && Number.isInteger(f.i) && typeof f.text === "string") fixes.set(f.i, f.text.slice(0, 60));
  return words.map(([text, a, b, speaker], i) => ({ text: fixes.get(i) ?? text, start: r3(a + shift), end: r3(b + shift), speaker, key: keys.includes(i) }))
    .filter((w) => w.end > 0 && w.start < len && w.text.trim());
}

const today = () => new Date().toISOString().slice(0, 10);
const PUBLIC = "id,asset_id,job_id,tool,auto_edit,setting,setting_by,setting_sure,source_ref,doc,ai_doc,rev,rendered_rev,source_key,source_expires_at,preview_key,preview_state,render_state,render_error,rendered_at,created_at,updated_at";

export function registerEditor(app: Express, sbFn: () => SupabaseClient, deps: EditorDeps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.log(l));
  const userOf = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const gate = async (req: Request, res: Response): Promise<string | null> => {
    const u = userOf(req); if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    if (!editorOn(env)) { res.status(503).json({ error: "tool_not_open", detail: "The editor is not switched on yet" }); return null; }
    const sb = sbFn();
    const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
    const paying = !!c.data && (["active", "trialing"].includes(c.data.status) || !!c.data.owner_pass);
    if (!paying && !(await isStudioAdmin(req, sb, env))) { res.status(402).json({ error: "subscription_required", detail: "The editor comes with a plan" }); return null; }
    return u;
  };
  const fail = (res: Response, err: any) => {
    if (err instanceof EditorError) return res.status(err.status).json({ error: err.code, detail: err.message });
    console.error("[editor]", err); return res.status(500).json({ error: "editor_failed", detail: String(err?.message ?? err).slice(0, 200) });
  };
  const view = async (sb: SupabaseClient, p: any) => {
    let preview_url: string | null = null;
    if (p.preview_key) { const s = await sb.storage.from("studio-outputs").createSignedUrl(p.preview_key, 3600); preview_url = s.data?.signedUrl ?? null; }
    const expired = !!p.source_expires_at && new Date(p.source_expires_at).getTime() < Date.now();
    if (p.source_key && !expired && p.preview_state === "none") void makePreview(sb, p.id, deps);
    return { ...p, source_key: undefined, preview_key: undefined, source: { kept: !!p.source_key && !expired, expires_at: p.source_expires_at }, preview_url };
  };
  const load = async (sb: SupabaseClient, u: string, col: "id" | "asset_id", v: string) => {
    if (!UUID.test(v)) throw new EditorError("project_not_found", "No project for that clip", 404);
    const r = await sb.from("studio_projects").select(PUBLIC).eq(col, v).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new EditorError("project_not_found", "This clip was made before the editor and has no project", 404);
    return r.data as any;
  };

  app.get("/api/studio/projects/by-asset/:assetId", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try { const sb = sbFn(); res.json(await view(sb, await load(sb, u, "asset_id", req.params.assetId))); } catch (e) { fail(res, e); }
  });
  app.get("/api/studio/projects/:id", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try { const sb = sbFn(); res.json(await view(sb, await load(sb, u, "id", req.params.id))); } catch (e) { fail(res, e); }
  });

  app.put("/api/studio/projects/:id", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const p = await load(sb, u, "id", req.params.id);
      const body = req.body ?? {};
      if (Number(body.rev) !== p.rev) return res.status(409).json({ error: "stale_revision", detail: "This clip was changed somewhere else", project: await view(sb, p) });
      const doc = cleanDoc(p.ai_doc, body.doc);
      const device = ["web", "web_phone", "ios", "mac"].includes(body.device) ? body.device : null;
      const rev = p.rev + 1;
      const up = await sb.from("studio_projects").update({ doc, rev, setting: doc.setting.label, setting_by: doc.setting.by, setting_sure: doc.setting.sure, opened_on: device, opened_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", p.id).eq("user_id", u).eq("rev", p.rev).select(PUBLIC).maybeSingle();
      if (up.error) throw up.error;
      if (!up.data) return res.status(409).json({ error: "stale_revision", detail: "This clip was changed somewhere else", project: await view(sb, await load(sb, u, "id", p.id)) });
      await sb.from("studio_project_revs").insert({ project_id: p.id, rev, doc, device });
      if (rev > 20) await sb.from("studio_project_revs").delete().eq("project_id", p.id).lte("rev", rev - 20);
      const surface = ["card", "quick", "editor", "batch", "assistant"].includes(body.surface) ? body.surface : "editor";
      const ops = (Array.isArray(body.ops) ? body.ops : []).slice(0, 50).filter((o: any) => typeof o?.op === "string" && OPS.test(o.op) && o.op.length <= 60)
        .map((o: any) => ({ user_id: u, project_id: p.id, session: typeof body.session === "string" ? body.session.slice(0, 64) : null, device, surface, op: o.op,
          from_value: o.from ?? null, to_value: o.to ?? null, at_s: num(o.at, 0, 600), rev, ctx: { setting: doc.setting.label, tool: p.tool, auto_edit: p.auto_edit } }));
      if (ops.length) { const e = await sb.from("studio_edit_events").insert(ops); if (e.error) log(`[editor] edit events not kept for ${p.id}: ${String(e.error.message).slice(0, 120)}`); }
      res.json(await view(sb, up.data));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/projects/:id/render", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const p = await load(sb, u, "id", req.params.id);
      if (!p.source_key) throw new EditorError("no_source", "The recording for this clip was not kept, so it cannot be made again", 409);
      if (p.source_expires_at && new Date(p.source_expires_at).getTime() < Date.now()) throw new EditorError("source_expired", "The recording for this clip was cleared", 409);
      if (p.render_state === "queued" || p.render_state === "rendering") return res.status(202).json(await view(sb, p));
      const count = p.render_day === today() ? Number(p.render_count) || 0 : 0;
      const cap = Number(env.STUDIO_EDITOR_RENDERS_PER_DAY) || RENDERS_PER_DAY;
      if (count >= cap) throw new EditorError("render_cap", `This clip was saved ${cap} times today; saving opens again tomorrow`, 429);
      const up = await sb.from("studio_projects").update({ render_state: "queued", render_error: null, render_requested_at: new Date().toISOString(), render_day: today(), render_count: count + 1 })
        .eq("id", p.id).eq("user_id", u).select(PUBLIC).maybeSingle();
      if (up.error) throw up.error;
      void renderProject(sb, p.id, deps);
      res.status(202).json(await view(sb, up.data));
    } catch (e) { fail(res, e); }
  });

  // renders left queued by a restart are picked up again (once a minute, the oldest first)
  const sweep = setInterval(() => { void resumeRenders(sbFn(), deps).catch(() => undefined); }, 60_000);
  (sweep as any).unref?.();
}

const running = new Set<string>();
export async function resumeRenders(sb: SupabaseClient, deps: EditorDeps = {}) {
  if (!editorOn(deps.env ?? process.env)) return;
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await sb.from("studio_projects").select("id,render_state,render_requested_at").in("render_state", ["queued", "rendering"]).lt("render_requested_at", stale).order("render_requested_at").limit(5);
  for (const p of r.data ?? []) if (!running.has(p.id)) void renderProject(sb, p.id, deps);
}

/** Make the clip again from its edited file and put it in place of the old one. Never throws; the state says how it went. */
export async function renderProject(sb: SupabaseClient, id: string, deps: EditorDeps = {}): Promise<boolean> {
  if (running.has(id)) return false;
  running.add(id);
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const run = deps.run ?? ((args: string[]) => ffmpeg(args, { timeoutMs: 8 * 60_000 }));
  let dir: string | null = null;
  try {
    return await cutGate(env).run(async () => {
      const t0 = Date.now();
      const r = await sb.from("studio_projects").select("id,user_id,asset_id,ai_doc,doc,rev,source_key").eq("id", id).maybeSingle();
      const p: any = r.data;
      if (!p?.source_key || !p.asset_id) throw new EditorError("no_source", "No kept recording");
      await sb.from("studio_projects").update({ render_state: "rendering" }).eq("id", id);
      dir = await mkdtemp(join(tmpdir(), "edit-"));
      const src = join(dir, "source.mp4"), out = join(dir, "out.mp4"), still = join(dir, "poster.jpg");
      const dl = await sb.storage.from("studio-outputs").download(p.source_key);
      if (dl.error || !dl.data) throw new EditorError("no_source", "The kept recording could not be read");
      await writeFile(src, Buffer.from(await dl.data.arrayBuffer()));
      const info = await probeLocal(src);
      const doc: EditDoc = p.doc, ai: EditDoc = p.ai_doc;
      // captions: the clip's words, moved to the edited clip's time, laid out for the frame the layout makes
      let captionFilter: string | null = null;
      const frame = renderArgs(doc, src, info, out).frame;
      const cv = await import("./studio-caption-video.js");
      const needWords = (doc.captions.on && doc.captions.style) || (doc.sound.bleep && doc.sound.bleep !== "off") || doc.extras.pause_trim;
      const wd = needWords ? await cv.readWords(sb, p.user_id, p.asset_id) : null;
      const len = doc.trim.out - doc.trim.in;
      let words = wd ? shiftWords(wd.words, ai, doc, wd.keys) : [];
      let bleeps = doc.sound.bleep && doc.sound.bleep !== "off" ? swearRanges(words, len) : [];
      // dead air: pauses cut down to a breath; the words and the bleeps move to the cut clip's time
      const keep = doc.extras.pause_trim && words.length ? pausePlan(words, len) : null;
      if (keep) {
        const { map } = trimRemap(keep);
        words = words.map((w) => ({ ...w, start: map(w.start), end: Math.max(map(w.start) + 0.05, map(w.end)) }));
        bleeps = bleeps.map(([a, b]) => [map(a), map(b)] as [number, number]).filter(([a, b]) => b > a);
      }
      if (doc.captions.on && doc.captions.style) {
        if (words.length) {
          const ass = join(dir, "c.ass");
          await writeFile(ass, cv.captionAss(words, cv.cleanSettings({ style: doc.captions.style, keywords: doc.captions.keywords, fillers: doc.captions.fillers, censor: doc.captions.censor }), frame, env));
          captionFilter = cv.assFilter(ass, env);
        }
      }
      const plan = renderArgs(doc, src, info, out, captionFilter, bleeps, keep);
      await run(plan.args);
      await run(["-v", "error", "-nostdin", "-y", "-ss", Math.min(1, plan.seconds / 3).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", still]);
      const fin = await probeLocal(out);
      const bytes = (await stat(out)).size;
      // the clip in the library is replaced: a new file under its own key, the row pointed at it, the old file removed
      const a = await sb.from("studio_assets").select("object_key,probe").eq("id", p.asset_id).maybeSingle();
      if (!a.data) throw new EditorError("clip_gone", "The clip was deleted from the library");
      const oldKey: string | null = a.data.object_key ?? null;
      const key = `${p.user_id}/${p.asset_id}-r${p.rev}.mp4`;
      const up = await sb.storage.from("studio-uploads").upload(key, await readFile(out), { contentType: "video/mp4", upsert: true });
      if (up.error) throw up.error;
      const probe = { ...(a.data.probe ?? {}), duration: r3(fin.seconds || plan.seconds), width: fin.w, height: fin.h, edited: { rev: p.rev, at: new Date().toISOString() },
        ...(doc.captions.on ? { captions: { style: (doc.captions.style as any)?.id ?? null, from: "editor", job_id: null } } : { captions: undefined }) };
      if (probe.poster_key) await sb.storage.from("studio-outputs").upload(probe.poster_key, await readFile(still), { contentType: "image/jpeg", upsert: true });
      const ua = await sb.from("studio_assets").update({ object_key: key, bytes, probe, updated_at: new Date().toISOString() }).eq("id", p.asset_id);
      if (ua.error) { await sb.storage.from("studio-uploads").remove([key]); throw ua.error; }
      if (oldKey && oldKey !== key) await sb.storage.from("studio-uploads").remove([oldKey]).catch(() => undefined);
      await sb.from("studio_projects").update({ render_state: "done", rendered_rev: p.rev, rendered_at: new Date().toISOString(), render_error: null }).eq("id", id);
      recordEvent({ user_id: p.user_id, kind: "feature", name: "editor_render", props: { project_id: id, asset_id: p.asset_id, rev: p.rev, seconds: r3(plan.seconds), ms: Date.now() - t0 } });
      return true;
    });
  } catch (e: any) {
    log(`[editor] render of ${id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    await sb.from("studio_projects").update({ render_state: "failed", render_error: String(e?.message ?? e).slice(0, 200) }).eq("id", id);
    return false;
  } finally {
    running.delete(id);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A small copy of the kept recording the browser can play and scrub (640 wide, H.264, a keyframe a second). */
const previews = new Set<string>();
export async function makePreview(sb: SupabaseClient, id: string, deps: EditorDeps = {}): Promise<boolean> {
  if (previews.has(id)) return false;
  previews.add(id);
  const run = deps.run ?? ((args: string[]) => ffmpeg(args, { timeoutMs: 4 * 60_000 }));
  let dir: string | null = null;
  try {
    const r = await sb.from("studio_projects").select("id,user_id,source_key,preview_state").eq("id", id).maybeSingle();
    const p: any = r.data;
    if (!p?.source_key || p.preview_state === "ready" || p.preview_state === "making") return false;
    await sb.from("studio_projects").update({ preview_state: "making" }).eq("id", id);
    dir = await mkdtemp(join(tmpdir(), "edit-pv-"));
    const src = join(dir, "s.mp4"), out = join(dir, "p.mp4");
    const dl = await sb.storage.from("studio-outputs").download(p.source_key);
    if (dl.error || !dl.data) throw new Error("kept recording unreadable");
    await writeFile(src, Buffer.from(await dl.data.arrayBuffer()));
    await cutGate(deps.env ?? process.env).run(() => run(["-v", "error", "-nostdin", "-y", "-threads", "2", "-i", src, "-vf", "scale='min(640,iw)':-2,fps=30", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "28", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", out]));
    const key = p.source_key.replace(/source\.mp4$/, "preview.mp4");
    const up = await sb.storage.from("studio-outputs").upload(key, await readFile(out), { contentType: "video/mp4", upsert: true });
    if (up.error) throw up.error;
    await sb.from("studio_projects").update({ preview_key: key, preview_state: "ready" }).eq("id", id);
    return true;
  } catch (e: any) {
    (deps.log ?? console.log)(`[editor] preview of ${id} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    await sb.from("studio_projects").update({ preview_state: "failed" }).eq("id", id);
    return false;
  } finally {
    previews.delete(id);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
