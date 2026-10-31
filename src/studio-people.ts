// Clone8 Studio: who is in the clip. Up to six stills are taken across the stretch the renderers use (one from each of
// the longest shots, so a movie scene with cuts shows every angle), and one model call names the people who matter:
// the same person across shots once, extras in the background, people seen only from behind, faces in posters or on
// screens left out. Each person's face is cut square from the full-size still where it is clearest, and the list lives
// on the asset (probe.people, version PEOPLE_VERSION) so the chat card and the tool pages both ask "who changes?" and
// pass the answer to the renderer as plain words. Nothing here is a real identity: labels are clothing and look only.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./video-render.js";
import { probeSeconds, probeDimensions } from "./studio-recast.js";
import { claude, AssistantError, type AssistantDeps } from "./studio-assistant.js";
import { StudioError } from "./studio.js";

export type Box = { x: number; y: number; w: number; h: number };
export type Person = { index: number; label: string; box: Box; frame?: number; at?: number; speaking?: boolean; key?: string | null; url?: string | null };
export type PeopleDeps = AssistantDeps & {
  frame?: (video: string, at: number, target: string) => Promise<void>;
  crop?: (image: string, box: Box, target: string) => Promise<void>;
  cuts?: (video: string, within: number) => Promise<number[]>;
  small?: (image: string, target: string) => Promise<void>;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bumped when the way people are found changes, so lists found the old way are found again on next use. */
export const PEOPLE_VERSION = 4;
/** The people stored on an asset, if they were found the current way. */
export const cachedPeople = (probe: any): Person[] | null => (Array.isArray(probe?.people) && Number(probe?.people_v) >= PEOPLE_VERSION ? probe.people : null);

export const PROMPT = `You see numbered stills from one short video (several moments, possibly different camera angles). List the PEOPLE WHO MATTER in it: the people a viewer would say are "in the video".

Rules:
- The same person seen in several stills is ONE entry. Match them by face, hair and clothing.
- Leave out: extras and passers-by in the background, anyone out of focus or tiny in the frame, people seen only from behind or only as a shoulder or hand, faces on posters, screens or photos, and reflections.
- For each person pick the still where their face is clearest: largest, sharpest, most toward the camera. Give the box of their head (top of the hair to the chin, ear to ear) in THAT still, as fractions of its width and height.
- label: two to five words a stranger could use to tell them apart, from what they wear, their hair and accessories (e.g. "denim jacket, dark hair", "beige jacket, tie", "red hoodie, glasses"). Never a name, never a guess at who they are, never ethnicity, race, skin colour, age, body or attractiveness, never a position word alone.
- speaking: true if they are the one talking in that still.
- At most six people, the most important first. If nobody qualifies, an empty list.`;
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["people"],
  properties: { people: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "still", "box", "speaking"],
    properties: { label: { type: "string" }, still: { type: "integer" }, speaking: { type: "boolean" },
      box: { type: "object", additionalProperties: false, required: ["x", "y", "w", "h"], properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } } } } } },
};

/** A still at full size (the face crops come from it). */
export async function extractFrame(video: string, at: number, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", Math.max(0, at).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", target], undefined, 60_000);
}
/** The copy the model reads: 768 px on the long side is plenty to tell people apart and keeps the call small. */
async function smallCopy(image: string, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", image, "-vf", "scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'", "-q:v", "4", target], undefined, 60_000);
}
/** A square head-and-shoulders crop around the head box (twice its size, kept inside the picture), 320 px. */
export function cropRect(box: Box, width: number, height: number): { x: number; y: number; side: number } {
  const cx = (box.x + box.w / 2) * width, cy = (box.y + box.h / 2) * height;
  const side = Math.round(Math.min(width, height, Math.max(box.w * width, box.h * height) * 2.1, Math.max(box.w * width, box.h * height) + 0.35 * Math.min(width, height)));
  const x = Math.round(Math.min(Math.max(0, cx - side / 2), width - side));
  // a little more room below the chin than above the hair: the shoulders say who it is too
  const y = Math.round(Math.min(Math.max(0, cy - side * 0.45), height - side));
  return { x, y, side: Math.max(2, side) };
}
export async function cropFace(image: string, box: Box, target: string) {
  const { width, height } = await probeDimensions(image);
  const r = cropRect(box, width, height);
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", image, "-vf", `crop=${r.side}:${r.side}:${r.x}:${r.y},scale=320:320:flags=lanczos`, "-q:v", "3", target], undefined, 60_000);
}

/** Camera cuts inside the picture. A film posted as a vertical video carries black bars that never change, and they
 *  hide most of a cut from the frame-difference score; the bars are measured (cropdetect) and cut off first. */
export async function pictureCuts(video: string, within: number): Promise<number[]> {
  const found = await command("ffmpeg", ["-v", "info", "-nostdin", "-t", String(within), "-i", video, "-an", "-vf", "fps=2,cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"], undefined, 120_000).catch(() => Buffer.from(""));
  const crops = [...found.toString().matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => m.slice(1).map(Number));
  const c = crops[crops.length - 1];
  const crop = c && c[0] > 32 && c[1] > 32 ? `crop=${c[0]}:${c[1]}:${c[2]}:${c[3]},` : "";
  const raw = await command("ffmpeg", ["-v", "info", "-nostdin", "-i", video, "-t", String(within), "-an", "-vf", `${crop}scale=320:-2,select='gt(scene,0.2)',showinfo`, "-f", "null", "-"], undefined, 120_000);
  return [...raw.toString().matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t > 0 && t < within);
}
/** When to take the stills: the middle of each of the longest shots inside the window (up to six), or, with few cuts,
 *  moments spread across it. Never in the first or last quarter second (fades, black frames). */
export function stillTimes(cuts: number[], window: number, max = 6): number[] {
  const pts = [0, ...cuts.filter((c) => c > 0.25 && c < window - 0.25).sort((a, b) => a - b), window];
  const shots = pts.slice(0, -1).map((s, k) => ({ s, e: pts[k + 1] })).filter((x) => x.e - x.s >= 0.6);
  let times = shots.sort((a, b) => (b.e - b.s) - (a.e - a.s)).slice(0, max).map((x) => (x.s + x.e) / 2);
  // few shots found (or none): moments spread across the clip fill up to six, the opening one included
  if (times.length < 4) for (const f of [0.06, 0.22, 0.38, 0.54, 0.7, 0.86]) { const t = window * f; if (times.length < max && !times.some((x) => Math.abs(x - t) < 1.5)) times.push(t); }
  times = times.map((t) => Math.min(Math.max(0.25, t), Math.max(0.25, window - 0.25))).sort((a, b) => a - b);
  return times;
}

/** The model's answer as a clean list: real stills and boxes only, labels tidy and distinct, at most six, left to right
 *  by where each face sits in its still. */
export function parsePeople(input: string | any, stills = 1): Array<Omit<Person, "index">> {
  let parsed: any = input;
  if (typeof input === "string") { const m = input.match(/\{[\s\S]*\}/); if (!m) return []; try { parsed = JSON.parse(m[0]); } catch { return []; } }
  const list = Array.isArray(parsed?.people) ? parsed.people : [];
  const out: Array<Omit<Person, "index">> = [];
  for (const p of list.slice(0, 6)) {
    const b = p?.box ?? {};
    const box = { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) };
    if (![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || box.w <= 0.01 || box.h <= 0.01) continue;
    box.w = Math.min(box.w, 1 - box.x); box.h = Math.min(box.h, 1 - box.y);
    const frame = Number.isInteger(Number(p?.still)) && Number(p.still) >= 1 && Number(p.still) <= stills ? Number(p.still) : 1;
    let label = String(p?.label ?? "person").replace(/\s+/g, " ").trim().slice(0, 48) || "person";
    const same = out.filter((o) => o.label.toLowerCase().replace(/ \(\d+\)$/, "") === label.toLowerCase()).length;
    if (same) label = `${label} (${same + 1})`;
    out.push({ label, box, frame, speaking: !!p?.speaking });
  }
  return out.sort((a, b) => (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2));
}

/** Finds the people in a video asset; cached on the asset unless refresh is asked. Returns the list with signed crops. */
export async function detectPeople(sb: SupabaseClient, deps: PeopleDeps, u: string, assetId: string, opts: { refresh?: boolean } = {}): Promise<Person[]> {
  const a = await sb.from("studio_assets").select("id,kind,object_key,probe,status").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready") throw new AssistantError("asset_not_ready", "That file is not ready", 404);
  if (a.data.kind !== "video") throw new AssistantError("asset_required", "People are found in videos");
  if (Number(a.data.probe?.duration) > 600 || a.data.probe?.long_source) throw new AssistantError("long_source", "That video is long: make clips from it first, then pick a clip", 400);
  let people: Person[] | null = opts.refresh ? null : cachedPeople(a.data.probe);
  if (!people) {
    const dl = await sb.storage.from("studio-uploads").download(a.data.object_key);
    if (dl.error || !dl.data) throw dl.error ?? new AssistantError("asset_not_ready", "The file could not be read", 404);
    const dir = await mkdtemp(join(tmpdir(), "studio-people-"));
    try {
      const file = join(dir, "v.mp4"); await writeFile(file, Buffer.from(await dl.data.arrayBuffer()));
      const seconds = Number(a.data.probe?.duration) || (await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 10));
      // the stretch the renderers take (Light: up to two minutes), seen at its longest shots
      const window = Math.max(0.5, Math.min(seconds, 120));
      const cuts = await (deps.cuts ?? pictureCuts)(file, window).catch(() => [] as number[]);
      const times = stillTimes(cuts, window);
      const content: any[] = [];
      for (const [k, t] of times.entries()) {
        const full = join(dir, `s${k + 1}.jpg`), small = join(dir, `m${k + 1}.jpg`);
        await (deps.frame ?? extractFrame)(file, t, full);
        await (deps.small ?? smallCopy)(full, small).catch(async () => { await writeFile(small, await readFile(full)); });
        content.push({ type: "text", text: `Still ${k + 1} (at ${t.toFixed(1)} s):` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(small)).toString("base64") } });
      }
      content.push({ type: "text", text: "Who matters in this video?" });
      const reply = await claude({ ...deps, signal: undefined, feature: "people" }, { system: PROMPT, max_tokens: 3000, output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content }] });
      const text = (Array.isArray(reply?.content) ? reply.content : []).filter((b: any) => b.type === "text").map((b: any) => String(b.text)).join("\n");
      const found = parsePeople(text, times.length);
      people = [];
      for (const [i, p] of found.entries()) {
        const target = join(dir, `p${i + 1}.jpg`);
        let key: string | null = null;
        try {
          await (deps.crop ?? cropFace)(join(dir, `s${p.frame ?? 1}.jpg`), p.box, target);
          key = `${u}/assets/${assetId}/people/${i + 1}.jpg`;
          const up = await sb.storage.from("studio-outputs").upload(key, await readFile(target), { contentType: "image/jpeg", upsert: true });
          if (up.error) key = null;
        } catch { key = null; }
        people.push({ index: i + 1, ...p, at: Math.round((times[(p.frame ?? 1) - 1] ?? 0) * 10) / 10, key });
      }
      const w = await sb.from("studio_assets").update({ probe: { ...(a.data.probe ?? {}), people, people_v: PEOPLE_VERSION, people_at: new Date().toISOString() } }).eq("id", assetId).eq("user_id", u);
      if (w.error) throw w.error;
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  }
  const keys = people.map((p) => p.key).filter(Boolean) as string[];
  if (keys.length) {
    const signed = await sb.storage.from("studio-outputs").createSignedUrls(keys, 900);
    const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
    for (const p of people) p.url = p.key ? urls.get(p.key) ?? null : null;
  }
  return people;
}

/** The words the renderer gets when only some people change: labels in, everyone else left alone. */
export function targetsPrompt(base: string, targets: string[] | null | undefined): string {
  const list = (targets ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (!list.length) return base;
  return `${base} Replace only ${list.length === 1 ? "this person" : "these people"}: ${list.join("; ")}. Leave every other person exactly as they are.`;
}

export function registerPeople(app: Express, sbFn: () => SupabaseClient, deps: PeopleDeps = {}): void {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof AssistantError || e instanceof StudioError) return res.status(e.status).json({ error: e.code, detail: e.message });
    console.error("[people]", String(e?.message ?? e));
    res.status(500).json({ error: "people_failed", detail: String(e?.message ?? e).slice(0, 200) });
  };
  app.post("/api/studio/assets/:id/people", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new AssistantError("asset_not_ready", "No such file", 404);
      const people = await detectPeople(sbFn(), { ...deps, env: deps.env ?? process.env }, u, req.params.id, { refresh: req.query.refresh === "1" });
      res.json({ people });
    } catch (e) { fail(res, e); }
  });
}
