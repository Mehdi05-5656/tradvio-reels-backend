// A finished video, brought into the library so the other tools can take it.
// Every tool that takes a video in (Captions, Clips, Blueprint, Swap, Recast, Styles, Trends, Chat) reads a library
// file; what Stories, Films, Kage, Blueprint, Swap and the instruments MAKE is a job output, which until now could be
// watched, downloaded or posted and nothing else. This one route is the bridge: POST /api/studio/jobs/:id/asset
// {key} copies that output into the person's library (once: the file's id is written back on the output, so asking
// again returns the same file) and answers with the library file, ready to hand to any tool.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { promoteOutput } from "./studio-assistant.js";
import { jobLabel, withPosterUrls } from "./studio.js";
import { hasPlanAccess } from "./studio-limits.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The copy is read into memory on its way across: a file larger than this is refused instead of risking the server. */
export const MAX_COPY_BYTES = 600 * 1024 * 1024;
export type OutputAssetDeps = { env?: Record<string, string | undefined>; log?: (s: string) => void; promote?: typeof promoteOutput };
/** One copy at a time per output: a second press waits for the first. */
const copying = new Map<string, Promise<string>>();

/** What the library file is called: the film's own title when it has one. */
export function outputAssetLabel(job: any): string {
  const o = job?.options ?? {}, p = job?.progress ?? {};
  const title = [p.title, o.story?.title, o.longform?.title, o.title, o.story?.topic, o.topic, o.longform?.prompt].find((x) => typeof x === "string" && x.trim());
  return String(title ?? jobLabel(job)).replace(/\s+/g, " ").trim().slice(0, 50) || "Video";
}

export function registerOutputAsset(app: Express, sbFn: () => SupabaseClient, deps: OutputAssetDeps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  app.post("/api/studio/jobs/:id/asset", async (req: Request, res: Response) => {
    const u = req.auth && "user_id" in req.auth ? req.auth.user_id : null;
    if (!u) return res.status(401).json({ error: "unauthorized" });
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    if (!UUID_RE.test(req.params.id) || !key || key.length > 400) return res.status(404).json({ error: "output_not_found" });
    try {
      const sb = sbFn();
      const j = await sb.from("studio_jobs").select("id,tool,status,options,progress,outputs").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (j.error) throw j.error;
      const job = j.data as any;
      const out = job?.status === "done" ? ((job.outputs ?? []) as any[]).find((o) => o?.key === key) : null;
      if (!out) return res.status(404).json({ error: "output_not_found" });
      const kind = out.kind ?? (/\.(jpe?g|png|webp)$/i.test(key) ? "image" : /\.(mp4|mov|webm)$/i.test(key) ? "video" : "other");
      if (kind !== "video" && kind !== "image") return res.status(422).json({ error: "output_not_usable", detail: "Only videos and pictures go into the other tools" });
      const answer = async (id: string) => { const a = await sb.from("studio_assets").select("*").eq("id", id).eq("user_id", u).maybeSingle(); return a.data?.status === "ready" ? (await withPosterUrls(sb, [a.data]))[0] : null; };
      // already in the library (this output was brought over before, or the tool put it there itself)
      if (out.asset_id && UUID_RE.test(String(out.asset_id))) { const have = await answer(String(out.asset_id)); if (have) return res.json({ asset: have, copied: false }); }
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!hasPlanAccess(c.data)) return res.status(402).json({ error: "subscription_required", detail: "Using a video in another tool comes with a plan" });
      if (Number(out.bytes) > MAX_COPY_BYTES) return res.status(413).json({ error: "output_too_large", detail: "This file is too large to move between tools here. Download it and upload it to the tool instead." });
      const lock = `${u}:${job.id}:${key}`;
      let run = copying.get(lock);
      if (!run) {
        run = (async () => {
          const id = await (deps.promote ?? promoteOutput)(sb, { env, log } as any, u, { ...job, outputs: [out] }, outputAssetLabel(job));
          // remember it on the output, so the next ask (and the dashboard) finds the same file
          const cur = await sb.from("studio_jobs").select("outputs").eq("id", job.id).eq("user_id", u).maybeSingle();
          const outs = ((cur.data?.outputs ?? job.outputs) as any[]).map((o) => (o?.key === key ? { ...o, asset_id: id } : o));
          const w = await sb.from("studio_jobs").update({ outputs: outs }).eq("id", job.id).eq("user_id", u);
          if (w.error) log(`[output-asset] could not note ${id} on ${job.id}: ${w.error.message}`);
          return id;
        })().finally(() => copying.delete(lock));
        copying.set(lock, run);
      }
      const asset = await answer(await run);
      if (!asset) throw new Error("copy_not_ready");
      res.json({ asset, copied: true });
    } catch (e: any) {
      log(`[output-asset] ${req.params.id}: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "output_copy_failed", detail: "That video could not be brought into your library just now. Try again in a moment." });
    }
  });
}
