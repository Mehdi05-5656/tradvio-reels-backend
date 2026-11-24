// Projects on the Post page (owner, Nov 23 2026; docs/publishing/PROJECTS_PLAN.md).
//
// A project is a name and a colour, the accounts (and posting groups) it posts to, its own board (the composer's
// state, like the tray) and a Library folder its videos are filed into. Posts sent from a project carry its id, so its
// Up next and Posted show only its own. "All" stays the person's general tray and every post.
//
// Filing videos into the folder uses the Library's own routes (move an upload; copy a made video in once), so this
// file only keeps projects, their boards and their counts.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_PROJECTS = 50;
const COLORS = ["teal", "violet", "amber", "rose", "sky", "lime", "orange", "fuchsia", "slate"];
const UUID = /^[0-9a-f-]{36}$/i;
const FIELDS = "id,name,color,account_ids,group_ids,collection_id,position,video_count,created_at,updated_at";

export class ProjectError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** A name as kept: trimmed, one line, 1 to 60 characters. */
export function cleanName(raw: unknown): string {
  const n = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!n) throw new ProjectError("name_needed", "Give the project a name");
  return n;
}
const cleanColor = (raw: unknown) => (COLORS.includes(String(raw)) ? String(raw) : "teal");
const cleanIds = (raw: unknown, max = 30) => [...new Set((Array.isArray(raw) ? raw : []).map((x) => String(x ?? "").slice(0, 80)).filter(Boolean))].slice(0, max);
const cleanGroups = (raw: unknown) => cleanIds(raw, 20).filter((x) => UUID.test(x));

/** The person's linked account ids and group ids (a project only keeps ones that are theirs). */
async function owned(sb: SupabaseClient, u: string): Promise<{ accounts: Set<string>; groups: Set<string> }> {
  const [p, g] = await Promise.all([
    sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle(),
    sb.from("studio_social_groups").select("id").eq("user_id", u),
  ]);
  return { accounts: new Set(((p.data?.accounts ?? []) as any[]).map((a) => String(a?.id ?? "")).filter(Boolean)), groups: new Set(((g.data ?? []) as any[]).map((x) => String(x.id))) };
}

export function registerPostProjects(app: Express, sbFn: () => SupabaseClient, deps: { log?: (s: string) => void } = {}) {
  const log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof ProjectError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist|column .* does not exist/i.test(msg)) return res.status(503).json({ error: "projects_unavailable", detail: "Projects are not switched on yet" });
    console.error("[post-projects]", msg);
    res.status(500).json({ error: "projects_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  const mine = async (sb: SupabaseClient, u: string, id: string, fields = FIELDS) => {
    if (!UUID.test(id)) throw new ProjectError("project_not_found", "No such project", 404);
    const r = await sb.from("studio_post_projects").select(fields).eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new ProjectError("project_not_found", "No such project", 404);
    return r.data as any;
  };

  // Every project, with how many videos wait on its board and how many of its posts are up next / out.
  app.get("/api/studio/post-projects", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_post_projects").select(FIELDS).eq("user_id", u).order("position", { ascending: true }).order("created_at", { ascending: true }).limit(MAX_PROJECTS);
      if (r.error) throw r.error;
      const rows = (r.data ?? []) as any[];
      const posts = rows.length ? await sb.from("studio_social_posts").select("project_id,status").eq("user_id", u).in("project_id", rows.map((x) => x.id)).limit(5000) : { data: [] as any[] };
      const count = (id: string, st: string[]) => ((posts.data ?? []) as any[]).filter((p) => p.project_id === id && st.includes(p.status)).length;
      res.json({ projects: rows.map(({ tray: _t, ...x }) => ({ ...x, videos: Number(x.video_count) || 0, up_next: count(x.id, ["scheduled", "queued", "sending"]), posted: count(x.id, ["posted", "partial"]) })) });
    } catch (e) { fail(res, e); }
  });

  // A new project: its folder in the Library is made with it. `from_tray` moves the board as it is into it.
  app.post("/api/studio/post-projects", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), b = req.body ?? {};
      const name = cleanName(b.name);
      const n = await sb.from("studio_post_projects").select("id", { count: "exact", head: true }).eq("user_id", u);
      if ((n.count ?? 0) >= MAX_PROJECTS) throw new ProjectError("too_many_projects", `Up to ${MAX_PROJECTS} projects`, 409);
      const own = await owned(sb, u);
      const accounts = cleanIds(b.account_ids).filter((x) => own.accounts.has(x)), groups = cleanGroups(b.group_ids).filter((x) => own.groups.has(x));
      const folder = await sb.from("studio_collections").insert({ user_id: u, name, kind: "folder", status: "ready", source: { project: true } }).select("id").single();
      if (folder.error) throw folder.error;
      let tray: any = {};
      if (b.from_tray === true) {
        // the board as the page has it (sent with the request), else as last saved
        if (b.tray && typeof b.tray === "object" && JSON.stringify(b.tray).length <= 500_000) tray = b.tray;
        else { const t = await sb.from("studio_post_drafts").select("id,payload").eq("user_id", u).eq("kind", "tray").maybeSingle(); if (t.data?.payload) tray = t.data.payload; }
        // it posts to the project's accounts, never to whatever All had picked
        tray = { ...tray, nets: accounts, gids: groups, dist: "all" };
      }
      const videos = Array.isArray(tray?.rows) ? tray.rows.length : 0;
      const ins = await sb.from("studio_post_projects").insert({ user_id: u, name, color: cleanColor(b.color), account_ids: accounts, group_ids: groups, collection_id: folder.data.id, tray, video_count: videos, position: Number(n.count ?? 0) }).select(FIELDS).single();
      if (ins.error) { await sb.from("studio_collections").delete().eq("id", folder.data.id).eq("user_id", u); throw ins.error; }
      // the board moved into the project: the general one starts empty (accounts and settings kept)
      if (b.from_tray === true && tray?.rows?.length) await sb.from("studio_post_drafts").update({ payload: { ...tray, rows: [] }, updated_at: new Date().toISOString() }).eq("user_id", u).eq("kind", "tray");
      res.status(201).json({ project: { ...ins.data, videos, up_next: 0, posted: 0 } });
    } catch (e) { fail(res, e); }
  });

  // One project with its board.
  app.get("/api/studio/post-projects/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { const p = await mine(sbFn(), u, req.params.id, `${FIELDS},tray`); res.json({ project: p }); } catch (e) { fail(res, e); }
  });

  // Rename (the folder too), colour, accounts, order.
  app.patch("/api/studio/post-projects/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), b = req.body ?? {};
      const cur = await mine(sb, u, req.params.id);
      const patch: any = { updated_at: new Date().toISOString() };
      if ("name" in b) patch.name = cleanName(b.name);
      if ("color" in b) patch.color = cleanColor(b.color);
      if ("position" in b && Number.isInteger(b.position)) patch.position = Math.max(0, Math.min(1000, b.position));
      if ("account_ids" in b || "group_ids" in b) {
        const own = await owned(sb, u);
        if ("account_ids" in b) patch.account_ids = cleanIds(b.account_ids).filter((x) => own.accounts.has(x));
        if ("group_ids" in b) patch.group_ids = cleanGroups(b.group_ids).filter((x) => own.groups.has(x));
      }
      const upd = await sb.from("studio_post_projects").update(patch).eq("id", cur.id).eq("user_id", u).select(FIELDS).single();
      if (upd.error) throw upd.error;
      if (patch.name && cur.collection_id) await sb.from("studio_collections").update({ name: patch.name, updated_at: patch.updated_at }).eq("id", cur.collection_id).eq("user_id", u);
      res.json({ project: upd.data });
    } catch (e) { fail(res, e); }
  });

  // Delete a project. Its posts stay (out of any project), and so does its folder with its videos, unless
  // `folder=1`: then the folder goes and its videos stay in the Library, loose.
  app.delete("/api/studio/post-projects/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const cur = await mine(sb, u, req.params.id);
      const del = await sb.from("studio_post_projects").delete().eq("id", cur.id).eq("user_id", u);
      if (del.error) throw del.error;
      if (req.query.folder !== "1" && cur.collection_id) await sb.from("studio_collections").update({ source: { project: false, was_project: cur.name }, updated_at: new Date().toISOString() }).eq("id", cur.collection_id).eq("user_id", u);
      if (req.query.folder === "1" && cur.collection_id) {
        await sb.from("studio_assets").update({ collection_id: null, updated_at: new Date().toISOString() }).eq("user_id", u).eq("collection_id", cur.collection_id);
        await sb.from("studio_collections").delete().eq("id", cur.collection_id).eq("user_id", u);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // The project's board, saved as the person works (like the tray).
  app.put("/api/studio/post-projects/:id/tray", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const cur = await mine(sb, u, req.params.id, "id");
      const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
      if (JSON.stringify(payload).length > 500_000) throw new ProjectError("board_too_large", "That board is too large to keep; post or remove some videos", 413);
      const upd = await sb.from("studio_post_projects").update({ tray: payload, video_count: Array.isArray(payload.rows) ? payload.rows.length : 0, updated_at: new Date().toISOString() }).eq("id", cur.id).eq("user_id", u).select("id,updated_at").single();
      if (upd.error) throw upd.error;
      res.json({ ok: true, updated_at: upd.data.updated_at });
    } catch (e) { fail(res, e); }
  });
  void log;
}

/** A post's project, when one is named: only the person's own (anything else is dropped, never an error). */
export async function projectFor(sb: SupabaseClient, u: string, raw: unknown): Promise<string | null> {
  const id = String(raw ?? "");
  if (!UUID.test(id)) return null;
  const r = await sb.from("studio_post_projects").select("id").eq("id", id).eq("user_id", u).maybeSingle();
  return r.error || !r.data ? null : String(r.data.id);
}
