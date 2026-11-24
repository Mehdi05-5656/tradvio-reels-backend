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
/** Uploads a board or draft still holds (the tray, saved drafts, every project's board): never deleted. */
export async function heldOnBoards(sb: SupabaseClient, u: string): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (payload: any) => { for (const r of Array.isArray(payload?.rows) ? payload.rows : []) { const id = r?.pick?.asset_id; if (typeof id === "string") out.add(id); } };
  const [d, p] = await Promise.all([
    sb.from("studio_post_drafts").select("payload").eq("user_id", u).limit(200),
    sb.from("studio_post_projects").select("tray").eq("user_id", u).limit(100),
  ]);
  if (d.error) throw d.error; // unsure what boards hold: delete nothing for this person
  for (const x of (d.data ?? []) as any[]) add(x.payload);
  if (!p.error) for (const x of (p.data ?? []) as any[]) add(x.tray);
  return out;
}
// where the last sweep got to (per server): posts are read in time order from there, so a busy day never starves it
let cursor = 0;
export const resetCursor = () => { cursor = 0; };

/** Whether the person has delete-after-posting on (on unless they turned it off). */
export async function deleteAfterPost(sb: SupabaseClient, u: string): Promise<boolean> {
  const r = await sb.from("studio_social_prefs").select("delete_after_post").eq("user_id", u).maybeSingle();
  if (r.error) return false; // the column not there yet: never delete
  return (r.data as any)?.delete_after_post !== false;
}

/** One sweep: uploads whose posts all went out in the last few days, deleted for the people who have it on. */
export async function sweepPosted(sb: SupabaseClient, log: (s: string) => void = (s) => console.log(s), now = Date.now(), env: Record<string, string | undefined> = process.env): Promise<number> {
  // switched on with the date it starts from (STUDIO_DELETE_AFTER_POST_FROM, ISO): posts that went out before it are never
  // looked at, so nothing already posted disappears the day this is switched on; unset = off
  const from = Date.parse(env.STUDIO_DELETE_AFTER_POST_FROM ?? "");
  if (!Number.isFinite(from)) return 0;
  const since = new Date(Math.max(from, now - 3 * 86400_000, cursor)).toISOString();
  const done = await sb.from("studio_social_posts").select("user_id,asset_id,updated_at").eq("status", "posted").not("asset_id", "is", null).gte("updated_at", since).order("updated_at", { ascending: true }).limit(500);
  if (done.error) { log(`[cleanup] read failed: ${done.error.message}`); return 0; }
  const rowsRead = (done.data ?? []) as any[];
  // next time from the last one read (the same instant again: a post updated in the same millisecond is not lost)
  if (rowsRead.length) cursor = Date.parse(rowsRead[rowsRead.length - 1].updated_at) || cursor;
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
      const held = await heldOnBoards(sb, u);
      const busy = new Set([...((waiting.data ?? []) as any[]).map((x) => x.asset_id), ...held]);
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

/** Every file in the person's library with what it is used for, so they can free space by hand (owner, Nov 23 2026):
 *  posted (every post of it went out), waiting (a post still to go out or failed: deleting it would break that post),
 *  on a board (the tray, a draft or a project board holds it), in a Clips set. */
export async function storageFiles(sb: SupabaseClient, u: string, posters: (sb: SupabaseClient, rows: any[]) => Promise<any[]> = async (_s, rows) => rows.map((r) => ({ ...r, poster_url: null }))) {
  const a = await sb.from("studio_assets").select("id,kind,name,bytes,probe,created_at,collection_id").eq("user_id", u).neq("status", "deleted").order("bytes", { ascending: false }).limit(5000);
  if (a.error) throw a.error;
  const rows = (a.data ?? []) as any[];
  const ids = rows.map((x) => x.id);
  const posts: any[] = [];
  for (let k = 0; k < ids.length; k += 500) {
    const r = await sb.from("studio_social_posts").select("asset_id,status,updated_at").eq("user_id", u).in("asset_id", ids.slice(k, k + 500)).limit(5000);
    if (r.error) throw r.error;
    posts.push(...((r.data ?? []) as any[]));
  }
  const cols = [...new Set(rows.map((x) => x.collection_id).filter(Boolean))];
  const kinds = new Map<string, { kind: string; name: string; project: boolean }>();
  if (cols.length) { const c = await sb.from("studio_collections").select("id,kind,name,source").eq("user_id", u).in("id", cols); for (const x of (c.data ?? []) as any[]) kinds.set(x.id, { kind: x.kind, name: x.name, project: !!x.source?.project }); }
  const held = await heldOnBoards(sb, u).catch(() => null);
  const withPosters = await posters(sb, rows);
  return withPosters.map((x: any) => {
    const mine = posts.filter((p) => p.asset_id === x.id);
    const waiting = mine.some((p) => KEEP_FOR.includes(p.status));
    const posted = mine.some((p) => p.status === "posted");
    const col = x.collection_id ? kinds.get(x.collection_id) : undefined;
    return { id: x.id, kind: x.kind, name: x.name, bytes: Number(x.bytes) || 0, created_at: x.created_at, poster_url: x.poster_url ?? null,
      seconds: Number(x.probe?.duration) > 0 ? Math.round(Number(x.probe.duration)) : null,
      posted, waiting, on_board: held ? held.has(x.id) : true, clip_set: col?.kind === "clips", folder: col ? col.name : null, project: !!col?.project,
      last_posted: posted ? mine.filter((p) => p.status === "posted").map((p) => p.updated_at).sort().at(-1) ?? null : null };
  });
}

/** Each file's poster, signed for 15 minutes. */
async function signPosters(sb: SupabaseClient, rows: any[]) {
  const keys = rows.map((a) => a.probe?.poster_key).filter(Boolean);
  if (!keys.length) return rows.map((a) => ({ ...a, poster_url: null }));
  const urls = new Map<string, string>();
  for (let k = 0; k < keys.length; k += 500) { const r = await sb.storage.from("studio-outputs").createSignedUrls(keys.slice(k, k + 500), 900); for (const x of (r.data ?? []) as any[]) if (x.path) urls.set(x.path, x.signedUrl); }
  return rows.map((a) => ({ ...a, poster_url: a.probe?.poster_key ? urls.get(a.probe.poster_key) ?? null : null }));
}

/** The setting, read and changed from the Post page. */
export function registerPostCleanup(app: Express, sbFn: () => SupabaseClient) {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => { console.error("[cleanup]", String(e?.message ?? e)); res.status(500).json({ error: "failed", detail: "Something went wrong on our side; try again in a moment" }); };
  app.get("/api/studio/storage/files", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { res.json({ files: await storageFiles(sbFn(), u, signPosters) }); } catch (e) { fail(res, e); }
  });
  // Delete files to free space. A file a post still waits on (scheduled, queued, sending, failed) is never deleted
  // here: that post would fail. Everything else goes (the Library's own delete: running jobs and editor files kept).
  app.post("/api/studio/storage/delete", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 2000) as string[];
      if (!ids.length) return res.json({ deleted: [], skipped: [], freed: 0 });
      const sb = sbFn();
      const waiting = new Set<string>();
      for (let k = 0; k < ids.length; k += 500) {
        const r = await sb.from("studio_social_posts").select("asset_id").eq("user_id", u).in("asset_id", ids.slice(k, k + 500)).in("status", KEEP_FOR);
        if (r.error) throw r.error;
        for (const x of (r.data ?? []) as any[]) waiting.add(x.asset_id);
      }
      const go = ids.filter((id) => !waiting.has(id));
      const sizes = new Map<string, number>();
      for (let k = 0; k < go.length; k += 500) { const r = await sb.from("studio_assets").select("id,bytes").eq("user_id", u).in("id", go.slice(k, k + 500)); for (const x of (r.data ?? []) as any[]) sizes.set(x.id, Number(x.bytes) || 0); }
      const deleted: string[] = [], skipped: Array<{ id: string; reason: string }> = [...[...waiting].map((id) => ({ id, reason: "a post still waits on it" }))];
      for (let k = 0; k < go.length; k += 500) { const r = await deleteAssets(sb, u, go.slice(k, k + 500), null); deleted.push(...r.deleted); skipped.push(...r.skipped); }
      res.json({ deleted, skipped, freed: deleted.reduce((n, id) => n + (sizes.get(id) ?? 0), 0) });
    } catch (e) { fail(res, e); }
  });
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
