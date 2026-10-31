// Clone8 Studio: who is in the clip. Three frames are pulled from a video, the middle one is shown to the model, which
// names each person it sees with a face box; each face is cropped and stored, and the list lives on the asset
// (probe.people) so the chat card and the Swap page can both ask "who gets swapped?" and pass the answer to the
// renderer as plain words in the prompt. Nothing here is a real identity: labels are clothing and position only.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./video-render.js";
import { probeSeconds } from "./studio-recast.js";
import { claude, AssistantError, type AssistantDeps } from "./studio-assistant.js";
import { StudioError } from "./studio.js";

export type Person = { index: number; label: string; box: { x: number; y: number; w: number; h: number }; speaking?: boolean; key?: string | null; url?: string | null };
export type PeopleDeps = AssistantDeps & { frame?: (video: string, at: number, target: string) => Promise<void>; crop?: (image: string, box: { x: number; y: number; w: number; h: number }, target: string) => Promise<void> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT = "You look at one frame of a short video. List every distinct person whose face is visible. Reply with JSON only: {\"people\":[{\"label\":\"...\",\"box\":{\"x\":0.1,\"y\":0.2,\"w\":0.15,\"h\":0.2},\"speaking\":true}]} where label is five words at most about clothing and position (never a name, never a guess at who they are), box is the face in fractions of the image width and height, and speaking is true if they seem to be talking to the camera. Up to six people, left to right. If nobody is visible, {\"people\":[]}.";

export async function extractFrame(video: string, at: number, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", String(Math.max(0, at)), "-i", video, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", target], undefined, 60_000);
}
export async function cropFace(image: string, box: { x: number; y: number; w: number; h: number }, target: string) {
  // the box grows by half on each side so hair and chin stay in; ffmpeg clamps nothing, so the crop is clamped here in fractions
  const pad = 0.5;
  const x0 = Math.max(0, box.x - box.w * pad), y0 = Math.max(0, box.y - box.h * pad);
  const x1 = Math.min(1, box.x + box.w * (1 + pad)), y1 = Math.min(1, box.y + box.h * (1 + pad));
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", image, "-vf", `crop=iw*${(x1 - x0).toFixed(4)}:ih*${(y1 - y0).toFixed(4)}:iw*${x0.toFixed(4)}:ih*${y0.toFixed(4)},scale=240:-2`, "-q:v", "3", target], undefined, 60_000);
}

/** The model's answer as a clean list, or nothing. */
export function parsePeople(text: string): Omit<Person, "index">[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: any; try { parsed = JSON.parse(m[0]); } catch { return []; }
  const list = Array.isArray(parsed?.people) ? parsed.people : [];
  const out: Omit<Person, "index">[] = [];
  for (const p of list.slice(0, 6)) {
    const b = p?.box ?? {};
    const box = { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) };
    if (![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || box.w <= 0.01 || box.h <= 0.01) continue;
    out.push({ label: String(p?.label ?? "person").replace(/\s+/g, " ").trim().slice(0, 60) || "person", box, speaking: !!p?.speaking });
  }
  return out;
}

/** Finds the people in a video asset; cached on the asset unless refresh is asked. Returns the list with signed crops. */
export async function detectPeople(sb: SupabaseClient, deps: PeopleDeps, u: string, assetId: string, opts: { refresh?: boolean } = {}): Promise<Person[]> {
  const a = await sb.from("studio_assets").select("id,kind,object_key,probe,status").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready") throw new AssistantError("asset_not_ready", "That file is not ready", 404);
  if (a.data.kind !== "video") throw new AssistantError("asset_required", "People are found in videos");
  let people: Person[] | null = Array.isArray(a.data.probe?.people) && !opts.refresh ? a.data.probe.people : null;
  if (!people) {
    const dl = await sb.storage.from("studio-uploads").download(a.data.object_key);
    if (dl.error || !dl.data) throw dl.error ?? new AssistantError("asset_not_ready", "The file could not be read", 404);
    const dir = await mkdtemp(join(tmpdir(), "studio-people-"));
    try {
      const file = join(dir, "v.mp4"); await writeFile(file, Buffer.from(await dl.data.arrayBuffer()));
      const seconds = Number(a.data.probe?.duration) || (await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 10));
      const frame = join(dir, "f.jpg");
      // a frame inside the stretch the renderers use (Light: the first 15 s), not the clip's middle: a 44 s podcast clip
      // is judged by its opening, which is what gets swapped
      await (deps.frame ?? extractFrame)(file, Math.min(seconds * 0.5, 6), frame);
      const jpg = await readFile(frame);
      const reply = await claude({ ...deps, signal: undefined, feature: "people" }, { system: PROMPT, max_tokens: 500, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } }, { type: "text", text: "Who is in this frame?" }] }] });
      const text = (Array.isArray(reply?.content) ? reply.content : []).filter((b: any) => b.type === "text").map((b: any) => String(b.text)).join("\n");
      const found = parsePeople(text);
      people = [];
      for (const [i, p] of found.entries()) {
        const target = join(dir, `p${i + 1}.jpg`);
        let key: string | null = null;
        try {
          await (deps.crop ?? cropFace)(frame, p.box, target);
          key = `${u}/assets/${assetId}/people/${i + 1}.jpg`;
          const up = await sb.storage.from("studio-outputs").upload(key, await readFile(target), { contentType: "image/jpeg", upsert: true });
          if (up.error) key = null;
        } catch { key = null; }
        people.push({ index: i + 1, ...p, key });
      }
      const w = await sb.from("studio_assets").update({ probe: { ...(a.data.probe ?? {}), people, people_at: new Date().toISOString() } }).eq("id", assetId).eq("user_id", u);
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
