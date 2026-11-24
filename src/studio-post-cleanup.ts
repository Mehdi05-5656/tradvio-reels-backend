// Delete after posting (owner, Nov 23 2026; docs/publishing/SCHEDULE_AI_STORAGE_PLAN.md): once an upload's posts have
// all gone out, the upload is deleted from the library, so storage does not fill with videos already posted. On by
// default; the person can turn it off (studio_social_prefs.delete_after_post = false).
//
// Kept: an upload any post still waits on or failed with (scheduled, queued, sending, failed, partial: a retry needs
// the file), a video in a Clips set, files the editor still uses (deleteAssets keeps those), anything a running job
// uses. Videos made in Clone8 are job outputs, not library files: never touched here.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteAssets } from "./studio-library.js";

const KEEP_FOR = ["scheduled", "queued", "sending", "failed", "partial"];

/** Whether the person has delete-after-posting on (on unless they turned it off). */
export async function deleteAfterPost(sb: SupabaseClient, u: string): Promise<boolean> {
  const r = await sb.from("studio_social_prefs").select("delete_after_post").eq("user_id", u).maybeSingle();
  if (r.error) return false; // the column not there yet: never delete
  return (r.data as any)?.delete_after_post !== false;
}

/** One sweep: uploads whose posts all went out in the last few days, deleted for the people who have it on. */
export async function sweepPosted(sb: SupabaseClient, log: (s: string) => void = (s) => console.log(s), now = Date.now()): Promise<number> {
  const since = new Date(now - 3 * 86400_000).toISOString();
  const done = await sb.from("studio_social_posts").select("user_id,asset_id").eq("status", "posted").not("asset_id", "is", null).gte("updated_at", since).limit(1000);
  if (done.error) { log(`[cleanup] read failed: ${done.error.message}`); return 0; }
  const byUser = new Map<string, Set<string>>();
  for (const p of (done.data ?? []) as any[]) if (p.asset_id) byUser.set(p.user_id, (byUser.get(p.user_id) ?? new Set()).add(p.asset_id));
  let gone = 0;
  for (const [u, set] of byUser) {
    try {
      if (!(await deleteAfterPost(sb, u))) continue;
      const ids = [...set];
      const [waiting, assets] = await Promise.all([
        sb.from("studio_social_posts").select("asset_id").eq("user_id", u).in("asset_id", ids).in("status", KEEP_FOR),
        sb.from("studio_assets").select("id,collection_id").eq("user_id", u).in("id", ids).neq("status", "deleted"),
      ]);
      if (waiting.error || assets.error) continue;
      const busy = new Set(((waiting.data ?? []) as any[]).map((x) => x.asset_id));
      const rows = ((assets.data ?? []) as any[]).filter((a) => !busy.has(a.id));
      if (!rows.length) continue;
      // a video in a Clips set stays (the set is something the person made, not a file brought in to post)
      const cols = [...new Set(rows.map((a) => a.collection_id).filter(Boolean))];
      const clipSets = new Set<string>();
      if (cols.length) { const c = await sb.from("studio_collections").select("id,kind").eq("user_id", u).in("id", cols); for (const x of (c.data ?? []) as any[]) if (x.kind === "clips") clipSets.add(x.id); }
      const go = rows.filter((a) => !a.collection_id || !clipSets.has(a.collection_id)).map((a) => a.id);
      if (!go.length) continue;
      const r = await deleteAssets(sb, u, go, null);
      gone += r.deleted.length;
      if (r.deleted.length) log(`[cleanup] ${u}: ${r.deleted.length} posted upload(s) deleted`);
    } catch (e: any) { log(`[cleanup] ${u}: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  return gone;
}

/** The setting, read and changed from the Post page. */
export function registerPostCleanup(app: Express, sbFn: () => SupabaseClient) {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => { console.error("[cleanup]", String(e?.message ?? e)); res.status(500).json({ error: "failed", detail: "Something went wrong on our side; try again in a moment" }); };
  app.get("/api/studio/social/prefs", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { res.json({ delete_after_post: await deleteAfterPost(sbFn(), u) }); } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/social/prefs", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (typeof req.body?.delete_after_post !== "boolean") return res.status(400).json({ error: "bad_request", detail: "delete_after_post is on or off" });
      const sb = sbFn(), now = new Date().toISOString();
      const cur = await sb.from("studio_social_prefs").select("user_id").eq("user_id", u).maybeSingle();
      const w = cur.data
        ? await sb.from("studio_social_prefs").update({ delete_after_post: req.body.delete_after_post, updated_at: now }).eq("user_id", u)
        : await sb.from("studio_social_prefs").insert({ user_id: u, delete_after_post: req.body.delete_after_post, updated_at: now });
      if (w.error) throw w.error;
      res.json({ delete_after_post: req.body.delete_after_post });
    } catch (e) { fail(res, e); }
  });
}
