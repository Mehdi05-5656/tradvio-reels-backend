// Clone8 Studio: the grouped library and bulk imports.
// A collection groups library files: a Clips run, an import, or a folder the person made. Files without one are loose
// uploads. Imports bring many short videos in at once: files and zips go straight from the browser to storage (the zip
// is opened in the browser, never uploaded whole); links (pasted, or read from a spreadsheet or a public Google Sheet)
// are fetched here by a background job, priced per link and refunded per link that fails.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditValueFloor, creditsForCost, MARGIN_TARGET, OVERHEAD, type PlanLike } from "./studio-pricing.js";
import { checkUpload } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import { ClipsError, CLIP_COST, lengthOf, proxyUsdPerGb, quoteCut } from "./studio-clips.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_IMPORT_LINKS = 500;
/** Longest YouTube video an import takes; longer ones belong in Clips. */
export const IMPORT_YT_MAX_SECONDS = 180;
export const DIRECT_MAX_BYTES = 536_870_912;

// ---------------------------------------------------------------------------------------------------
// Links: what each one is, and what it costs to bring in
// ---------------------------------------------------------------------------------------------------
export type LinkKind = "tiktok" | "instagram" | "youtube" | "file";
/** A pasted or spreadsheet link, tidied, with its kind; null when we cannot bring it in. */
export function classifyImportLink(raw: string): { url: string; kind: LinkKind } | { url: string; reason: string } {
  const s = String(raw ?? "").trim().replace(/[)\].,;'"]+$/, "");
  let u: URL;
  try { u = new URL(s); } catch { return { url: s.slice(0, 300), reason: "not a link" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { url: s.slice(0, 300), reason: "not a web link" };
  const h = u.hostname.toLowerCase();
  if (/(^|\.)tiktok\.com$/.test(h)) return /\/video\/\d+|\/photo\/\d+|^vm\.|^vt\./.test(u.pathname + " " + h) || /^(vm|vt)\./.test(h) ? { url: u.toString(), kind: "tiktok" } : { url: u.toString(), reason: "a TikTok profile, not a video" };
  if (/(^|\.)instagram\.com$/.test(h)) return /\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/.test(u.pathname) ? { url: u.toString(), kind: "instagram" } : { url: u.toString(), reason: "an Instagram profile, not a post" };
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return /\/shorts\/|[?&]v=|youtu\.be\//.test(u.toString()) ? { url: u.toString(), kind: "youtube" } : { url: u.toString(), reason: "a YouTube channel or playlist, not a video" };
  if (u.protocol !== "https:") return { url: u.toString(), reason: "files are fetched over https only" };
  if (/(^|\.)dropbox\.com$/.test(h)) { u.searchParams.set("dl", "1"); return { url: u.toString(), kind: "file" }; }
  const drive = u.toString().match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([A-Za-z0-9_-]{10,})/);
  if (drive) return { url: `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t`, kind: "file" };
  if (/\.(mp4|mov|m4v)$/i.test(u.pathname)) return { url: u.toString(), kind: "file" };
  return { url: u.toString(), reason: "not a TikTok, Instagram, YouTube or video file link" };
}
/** Every http(s) link in a block of text (a CSV cell, a pasted list), in order, without repeats. */
export function linksInText(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/https?:\/\/[^\s"'<>,;|\\]+/gi)) { const u = m[0].replace(/[)\].]+$/, ""); if (!out.includes(u)) out.push(u); }
  return out;
}
/** What one link costs us at list price: ScrapeCreators' download (10 calls' worth) for TikTok and Instagram; the listing
 *  and the bytes through the proxy for YouTube (up to 3 minutes); next to nothing for a file. */
export function linkCostUsd(kind: LinkKind, env: Record<string, string | undefined>, seconds = IMPORT_YT_MAX_SECONDS): number {
  if (kind === "tiktok" || kind === "instagram") return 11 * OVERHEAD.scrapecreators_usd_per_call;
  if (kind === "youtube") return OVERHEAD.scrapecreators_usd_per_call + (seconds * CLIP_COST.clip_bytes_per_second / 1e9) * proxyUsdPerGb(env) + 0.002;
  return 0.002;
}
export const linkCredits = (kind: LinkKind, env: Record<string, string | undefined>, plans: PlanLike[], seconds?: number) => creditsForCost(linkCostUsd(kind, env, seconds), creditValueFloor(plans), MARGIN_TARGET);
export const importEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_IMPORT_ENABLED !== "false" && !!env.SCRAPECREATORS_API_KEY;
export type ImportQuote = { tool: "import"; credits: number; options: Record<string, any>; summary: string };
export function quoteImport(env: Record<string, string | undefined>, plans: PlanLike[], options: any): ImportQuote {
  const o = options && typeof options === "object" ? options : {};
  const raw: string[] = (Array.isArray(o.links) ? o.links : []).map((x: unknown) => String(x ?? "")).filter(Boolean);
  const links: Array<{ url: string; kind: LinkKind }> = [], rejected: Array<{ url: string; reason: string }> = [];
  for (const r of raw) {
    const c = classifyImportLink(r);
    if ("reason" in c) { rejected.push(c); continue; }
    if (links.some((l) => l.url === c.url)) continue;
    if (links.length >= MAX_IMPORT_LINKS) { rejected.push({ url: c.url, reason: `over ${MAX_IMPORT_LINKS} links` }); continue; }
    links.push(c);
  }
  if (!links.length) throw new ClipsError("no_links", rejected.length ? "None of those links can be brought in" : "Add at least one link");
  const counts = { tiktok: 0, instagram: 0, youtube: 0, file: 0 } as Record<LinkKind, number>;
  let credits = 0;
  for (const l of links) { counts[l.kind]++; credits += linkCredits(l.kind, env, plans); }
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 100) : null;
  const collection_id = UUID_RE.test(String(o.collection_id ?? "")) ? String(o.collection_id) : null;
  return { tool: "import", credits, options: { links, rejected: rejected.slice(0, 200), counts, name, collection_id }, summary: `${links.length} ${links.length === 1 ? "link" : "links"}` };
}

// ---------------------------------------------------------------------------------------------------
// Files from the open web, safely: https only, no private addresses (checked at every redirect), a video, size-capped
// ---------------------------------------------------------------------------------------------------
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return privateAddress(s.slice(7));
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("ff");
}
export async function safeTarget(url: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new ClipsError("link_unsafe", "Only https links are fetched");
  if (u.username || u.password) throw new ClipsError("link_unsafe", "Links with passwords are not fetched");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addrs.length) throw new ClipsError("link_fetch_failed", "That address does not exist", 400);
  if (addrs.some(privateAddress)) throw new ClipsError("link_unsafe", "That address is not on the public internet");
  return u;
}
/** Downloads a video file to `target`; returns its size. MP4/MOV only (checked by its first bytes, not its name). */
export async function fetchDirectVideo(url: string, target: string, o: { fetch?: typeof fetch; maxBytes?: number; resolve?: (h: string) => Promise<string[]> } = {}): Promise<number> {
  const f = o.fetch ?? fetch, max = o.maxBytes ?? DIRECT_MAX_BYTES;
  let next = url, r: globalThis.Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const u = await safeTarget(next, o.resolve);
    r = await f(u.toString(), { redirect: "manual", signal: AbortSignal.timeout(300_000), headers: { "user-agent": "Mozilla/5.0 (compatible; Clone8Studio/1.0)" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { next = new URL(r.headers.get("location")!, u).toString(); continue; }
    break;
  }
  if (!r || r.status >= 300) throw new ClipsError("link_fetch_failed", `The file could not be downloaded (${r?.status ?? "no answer"})`, 400);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > max) throw new ClipsError("link_too_large", "That file is over 512 MB");
  const type = String(r.headers.get("content-type") ?? "").toLowerCase();
  if (/text\/html|application\/json/.test(type)) throw new ClipsError("link_no_media", "That link opens a page, not a file (is it shared publicly?)");
  if (!r.body) throw new ClipsError("link_no_media", "The file was empty");
  let seen = 0;
  const capped = Readable.fromWeb(r.body as any).on("data", (b: Buffer) => { seen += b.length; if (seen > max) capped.destroy(new ClipsError("link_too_large", "That file is over 512 MB")); });
  await pipeline(capped, createWriteStream(target));
  const head = (await readFile(target)).subarray(0, 16);
  if (head.subarray(4, 8).toString("latin1") !== "ftyp") throw new ClipsError("link_no_media", "That file is not an MP4 or MOV video");
  return (await stat(target)).size;
}

// ---------------------------------------------------------------------------------------------------
// Google Sheets shared as "anyone with the link": read as CSV
// ---------------------------------------------------------------------------------------------------
export function sheetCsvUrl(raw: string): string | null {
  const m = String(raw ?? "").match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (!m) return null;
  const gid = String(raw).match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}
export async function readSheet(raw: string, f: typeof fetch = fetch): Promise<{ links: string[]; title: string | null }> {
  const csv = sheetCsvUrl(raw);
  if (!csv) throw new ClipsError("sheet_unreadable", "That is not a Google Sheets link");
  const r = await f(csv, { redirect: "follow", signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!r) throw new ClipsError("sheet_unreadable", "Google Sheets did not answer; try again", 502);
  const type = String(r.headers.get("content-type") ?? "");
  if (r.status === 401 || r.status === 403 || /text\/html/.test(type)) throw new ClipsError("sheet_private", "That sheet is private. Share it as \"Anyone with the link can view\", or upload it as a file");
  if (!r.ok) throw new ClipsError("sheet_unreadable", `The sheet could not be read (${r.status})`, 502);
  const text = (await r.text()).slice(0, 5_000_000);
  const links = linksInText(text);
  if (!links.length) throw new ClipsError("no_links", "No links were found in that sheet");
  const title = String(r.headers.get("content-disposition") ?? "").match(/filename="?([^";]+)/)?.[1]?.replace(/\.csv$/i, "").replace(/ - .*$/, "") ?? null;
  return { links, title };
}

// ---------------------------------------------------------------------------------------------------
// Collections as people see them
// ---------------------------------------------------------------------------------------------------
type Row = { id: string; user_id: string; name: string; kind: string; status: string; source: any; job_id: string | null; note: string | null; created_at: string; updated_at: string };
export async function publicCollections(sb: SupabaseClient, rows: Row[]): Promise<any[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [assets, jobs] = await Promise.all([
    sb.from("studio_assets").select("collection_id,probe,created_at").in("collection_id", ids).neq("status", "deleted").order("created_at", { ascending: true }).limit(5000),
    sb.from("studio_jobs").select("id,status,progress").in("id", rows.map((r) => r.job_id).filter(Boolean) as string[]),
  ]);
  const count = new Map<string, number>(), poster = new Map<string, string>();
  for (const a of (assets.data ?? []) as any[]) {
    count.set(a.collection_id, (count.get(a.collection_id) ?? 0) + 1);
    if (a.probe?.poster_key && (!poster.has(a.collection_id) || a.probe?.clip?.rank === 1)) poster.set(a.collection_id, a.probe.poster_key);
  }
  const keys = [...new Set(poster.values())];
  const signed = keys.length ? await sb.storage.from("studio-outputs").createSignedUrls(keys, 900) : { data: [] as any[] };
  const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
  const jobById = new Map(((jobs.data ?? []) as any[]).map((j) => [j.id, j]));
  return rows.map((r) => {
    const j = r.job_id ? jobById.get(r.job_id) : null;
    const live = j && (j.status === "queued" || j.status === "running");
    const p = j?.progress ?? {};
    // while it runs, where it is; when it waits for the file, how many moments were picked (done 0 of total)
    const progress = r.status === "needs_file" ? { stage: "done", done: 0, total: Number(p.total ?? 0), message: "Waiting for the file" } : r.status === "processing" || live ? { stage: j?.status === "queued" ? "queued" : String(p.stage ?? "reading"), done: Number(p.done ?? 0), total: Number(p.total ?? 0), message: String(p.message ?? (j?.status === "queued" ? "Waiting to start" : "Working")) } : null;
    return {
      id: r.id, name: r.name, kind: r.kind, status: r.status, note: r.note, job_id: r.job_id,
      source: { platform: r.source?.platform ?? null, url: r.source?.url ?? null, asset_id: r.source?.asset_id ?? null, title: r.source?.title ?? null, channel: r.source?.channel ?? null, seconds: r.source?.seconds ?? null, thumbnail_url: r.source?.thumbnail_url ?? null },
      asset_count: count.get(r.id) ?? 0,
      poster_url: (poster.has(r.id) ? urls.get(poster.get(r.id)!) : null) ?? r.source?.thumbnail_url ?? null,
      progress, created_at: r.created_at, updated_at: r.updated_at,
    };
  });
}
/** A collection's processing state follows its job: a job that ended without updating it (a crash) is settled here. */
export async function settleStale(sb: SupabaseClient, rows: Row[]): Promise<void> {
  const busy = rows.filter((r) => r.status === "processing" && r.job_id);
  if (!busy.length) return;
  const jobs = await sb.from("studio_jobs").select("id,status,error_code").in("id", busy.map((r) => r.job_id!));
  for (const j of (jobs.data ?? []) as any[]) {
    if (j.status !== "failed" && j.status !== "canceled" && j.status !== "done") continue;
    const r = busy.find((x) => x.job_id === j.id)!;
    const status = j.status === "done" ? "ready" : "failed";
    const note = j.status === "canceled" ? "Canceled" : j.status === "failed" ? "It could not be finished; the credits were refunded." : r.note;
    await sb.from("studio_collections").update({ status, note, updated_at: new Date().toISOString() }).eq("id", r.id).eq("status", "processing");
    r.status = status; r.note = note;
  }
}

export type LibraryHelpers = { sbFn: () => SupabaseClient; env: Record<string, string | undefined>; plans: PlanLike[]; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => any; log: (l: string) => void; withPosterUrls: (sb: SupabaseClient, assets: any[]) => Promise<any[]> };
const ASSET_FIELDS = "id,kind,name,bytes,status,probe,created_at,collection_id";
export function registerLibrary(app: Express, h: LibraryHelpers): void {
  const { sbFn, requireUser, fail } = h;
  const own = async (sb: SupabaseClient, u: string, id: string): Promise<Row> => {
    if (!UUID_RE.test(id)) throw new ClipsError("collection_not_found", "No such collection", 404);
    const r = await sb.from("studio_collections").select("*").eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new ClipsError("collection_not_found", "No such collection", 404);
    return r.data as Row;
  };

  app.get("/api/studio/collections", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      let q = sb.from("studio_collections").select("*").eq("user_id", u).order("created_at", { ascending: false }).limit(300);
      const kind = String(req.query.kind ?? "");
      if (["clips", "import", "folder"].includes(kind)) q = q.eq("kind", kind);
      const r = await q;
      if (r.error) throw r.error;
      const rows = (r.data ?? []) as Row[];
      await settleStale(sb, rows);
      res.json({ collections: await publicCollections(sb, rows) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/collections", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const name = String(req.body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!name) throw new ClipsError("name_required", "Name the folder");
      const sb = sbFn();
      const kind = req.body?.kind === "import" ? "import" : "folder";
      const platform = ["files", "zip", "sheet", "links"].includes(String(req.body?.platform)) ? String(req.body.platform) : kind === "import" ? "files" : null;
      const r = await sb.from("studio_collections").insert({ user_id: u, name, kind, status: "ready", source: { platform } }).select("*").single();
      if (r.error) throw r.error;
      res.status(201).json({ collection: (await publicCollections(sb, [r.data as Row]))[0] });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/collections/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const c = await own(sb, u, req.params.id);
      await settleStale(sb, [c]);
      const a = await sb.from("studio_assets").select(ASSET_FIELDS).eq("user_id", u).eq("collection_id", c.id).neq("status", "deleted").order("created_at", { ascending: true }).limit(1000);
      if (a.error) throw a.error;
      const assets = ((a.data ?? []) as any[]).sort((x, y) => (Number(x.probe?.clip?.rank) || 1e9) - (Number(y.probe?.clip?.rank) || 1e9) || String(x.created_at).localeCompare(String(y.created_at)));
      res.json({ collection: (await publicCollections(sb, [c]))[0], assets: await h.withPosterUrls(sb, assets) });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/studio/collections/:id", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const c = await own(sb, u, req.params.id);
      const name = String(req.body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!name) throw new ClipsError("name_required", "Give it a name");
      const r = await sb.from("studio_collections").update({ name, updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", u).select("*").single();
      if (r.error) throw r.error;
      res.json({ collection: (await publicCollections(sb, [r.data as Row]))[0] });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/collections/:id", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const c = await own(sb, u, req.params.id);
      if (c.job_id) {
        const j = await sb.from("studio_jobs").select("status").eq("id", c.job_id).maybeSingle();
        if (j.data && (j.data.status === "queued" || j.data.status === "running")) throw new ClipsError("collection_busy", "It is still being made; cancel the run first", 409);
      }
      let filesDeleted = 0;
      if (req.query.with_files === "1" || req.body?.with_files === true) filesDeleted = (await deleteAssets(sb, u, null, c.id)).deleted.length;
      else await sb.from("studio_assets").update({ collection_id: null, updated_at: new Date().toISOString() }).eq("user_id", u).eq("collection_id", c.id);
      await sb.storage.from("studio-outputs").remove([`${u}/clips/${c.id}/plan.txt`]).catch(() => undefined);
      const d = await sb.from("studio_collections").delete().eq("id", c.id).eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: c.id, files_deleted: filesDeleted });
    } catch (e) { fail(res, e); }
  });

  // Finish a YouTube clips run that YouTube refused: the person uploads the same video, the chosen moments are cut from it.
  app.post("/api/studio/collections/:id/source", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const c = await own(sb, u, req.params.id);
      if (c.kind !== "clips" || c.status !== "needs_file") throw new ClipsError("collection_not_waiting", "This collection is not waiting for a file", 409);
      const assetId = String(req.body?.asset_id ?? "");
      if (!UUID_RE.test(assetId)) throw new ClipsError("asset_required", "Upload the video first");
      const a = await sb.from("studio_assets").select("id,kind,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new ClipsError("asset_not_ready", "The upload has not finished", 409);
      const plan = await sb.storage.from("studio-outputs").download(`${u}/clips/${c.id}/plan.txt`);
      if (plan.error || !plan.data) throw new ClipsError("clips_plan_missing", "The moments chosen earlier are gone; start a new run", 409);
      const p = JSON.parse(Buffer.from(await plan.data.arrayBuffer()).toString("utf8"));
      const want = Number(c.source?.seconds) || Number(p.seconds) || 0, got = Number(a.data.probe?.duration) || 0;
      if (want && got && Math.abs(want - got) > Math.max(5, want * 0.02)) throw new ClipsError("source_mismatch", `That file is ${Math.round(got / 60)} min; the video was ${Math.round(want / 60)} min. Upload the same video`, 409);
      const moments: any[] = Array.isArray(p.moments) ? p.moments : [];
      const length = lengthOf(c.source?.length);
      const { credits, price } = quoteCut(h.plans, moments.length, want, length);
      const options = { platform: "upload", collection_id: c.id, plan_from: c.id, format: c.source?.format ?? "vertical", length, seconds: want, count: moments.length, price, via: "tool" };
      const r = await sb.rpc("studio_create_job", { p_user: u, p_tool: "clips", p_asset: assetId, p_options: options, p_credits: credits });
      if (r.error) throw r.error;
      await sb.from("studio_collections").update({ status: "processing", job_id: r.data.id, note: null, source: { ...(c.source ?? {}), asset_id: assetId }, updated_at: new Date().toISOString() }).eq("id", c.id);
      res.status(201).json({ job: r.data, quote: { tool: "clips", credits, options, summary: `${moments.length} clips` } });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/studio/assets/:id", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (typeof req.body?.name === "string") {
        const n = req.body.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
        if (!n) throw new ClipsError("name_required", "Give it a name");
        patch.name = n;
      }
      if ("collection_id" in (req.body ?? {})) patch.collection_id = await collectionFor(sb, u, req.body.collection_id);
      const r = await sb.from("studio_assets").update(patch).eq("id", req.params.id).eq("user_id", u).neq("status", "deleted").select(ASSET_FIELDS).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "asset_not_found" });
      res.json({ asset: (await h.withPosterUrls(sb, [r.data]))[0] });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/assets/move", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const ids = idsOf(req.body?.ids);
      const sb = sbFn();
      const target = await collectionFor(sb, u, req.body?.collection_id);
      const r = await sb.from("studio_assets").update({ collection_id: target, updated_at: new Date().toISOString() }).eq("user_id", u).in("id", ids).neq("status", "deleted").select("id");
      if (r.error) throw r.error;
      res.json({ moved: (r.data ?? []).length });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/assets/delete", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try { res.json(await deleteAssets(sbFn(), u, idsOf(req.body?.ids), null)); } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/imports/sheet", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try { res.json(await readSheet(String(req.body?.url ?? ""))); } catch (e) { fail(res, e); }
  });
}
/** The assistant's library search: words in a name, a clip's title, hook or transcript; optionally one collection
 *  (by id or name) and one kind. Best clips first, then newest. */
export async function searchLibrary(sb: SupabaseClient, u: string, p: { query?: unknown; collection?: unknown; kind?: unknown }): Promise<Array<{ row: any; view: Record<string, any> }>> {
  const words = String(p.query ?? "").replace(/[%_,()\\*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const cols = await sb.from("studio_collections").select("id,name,kind").eq("user_id", u).limit(300);
  const colRows = (cols.data ?? []) as any[];
  let colId: string | null = null;
  const want = String(p.collection ?? "").trim();
  if (want) {
    colId = colRows.find((c) => c.id === want)?.id ?? colRows.find((c) => c.name.toLowerCase() === want.toLowerCase())?.id ?? colRows.find((c) => c.name.toLowerCase().includes(want.toLowerCase()))?.id ?? null;
    if (!colId) return [];
  }
  let q = sb.from("studio_assets").select("id,kind,name,object_key,probe,status,bytes,collection_id,created_at").eq("user_id", u).eq("status", "ready").order("created_at", { ascending: false }).limit(words ? 60 : 40);
  if (colId) q = q.eq("collection_id", colId);
  if (p.kind === "video" || p.kind === "image") q = q.eq("kind", p.kind);
  // each word may match anywhere: "pricing objection" finds a clip whose transcript has both, in any order
  const terms = words.split(" ").filter((w) => w.length > 1).slice(0, 4);
  const anyField = (t: string) => ["name", "probe->>title", "probe->>hook", "probe->>transcript", "probe->>tags"].map((f) => `${f}.ilike.*${t}*`).join(",");
  if (terms.length === 1) q = q.or(anyField(terms[0]));
  else if (terms.length > 1) q = q.or(`and(${terms.map((t) => `or(${anyField(t)})`).join(",")})`);
  const r = await q;
  if (r.error) throw r.error;
  const names = new Map(colRows.map((c) => [c.id, c.name]));
  return ((r.data ?? []) as any[])
    .sort((a, b) => (Number(b.probe?.score) || 0) - (Number(a.probe?.score) || 0) || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 20)
    .map((a) => ({ row: a, view: { id: a.id, kind: a.kind, name: a.name, seconds: Number(a.probe?.duration) > 0 ? Math.round(Number(a.probe.duration)) : null, collection: a.collection_id ? names.get(a.collection_id) ?? null : null,
      ...(a.probe?.title ? { title: a.probe.title, hook: a.probe.hook ?? null, score: a.probe.score ?? null } : {}), ...(a.probe?.long_source ? { long_source: true } : {}) } }));
}
const idsOf = (v: unknown): string[] => {
  const ids = (Array.isArray(v) ? v : []).map(String).filter((x) => UUID_RE.test(x));
  if (!ids.length) throw new ClipsError("ids_required", "Pick at least one file");
  if (ids.length > 200) throw new ClipsError("too_many_ids", "At most 200 files at a time");
  return [...new Set(ids)];
};
async function collectionFor(sb: SupabaseClient, u: string, v: unknown): Promise<string | null> {
  if (v === null || v === "" || v === undefined) return null;
  const id = String(v);
  if (!UUID_RE.test(id)) throw new ClipsError("collection_not_found", "No such collection", 404);
  const c = await sb.from("studio_collections").select("id").eq("id", id).eq("user_id", u).maybeSingle();
  if (c.error) throw c.error;
  if (!c.data) throw new ClipsError("collection_not_found", "No such collection", 404);
  return c.data.id;
}
/** Deletes files (by id, or every file of a collection) that no queued or running job is reading. */
export async function deleteAssets(sb: SupabaseClient, u: string, ids: string[] | null, collectionId: string | null): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: string }> }> {
  let q = sb.from("studio_assets").select("id,object_key,probe").eq("user_id", u).neq("status", "deleted").limit(1000);
  q = ids ? q.in("id", ids) : q.eq("collection_id", collectionId!);
  const a = await q;
  if (a.error) throw a.error;
  const rows = (a.data ?? []) as any[];
  if (!rows.length) return { deleted: [], skipped: (ids ?? []).map((id) => ({ id, reason: "not found" })) };
  const busy = await sb.from("studio_jobs").select("asset_id").in("asset_id", rows.map((r) => r.id)).in("status", ["queued", "running"]);
  if (busy.error) throw busy.error;
  const inUse = new Set(((busy.data ?? []) as any[]).map((j) => j.asset_id));
  const go = rows.filter((r) => !inUse.has(r.id));
  const skipped = rows.filter((r) => inUse.has(r.id)).map((r) => ({ id: r.id, reason: "in use by a running job" }));
  for (let k = 0; k < go.length; k += 100) {
    const part = go.slice(k, k + 100);
    const rmv = await sb.storage.from("studio-uploads").remove(part.map((r) => r.object_key));
    if (rmv.error) throw rmv.error;
    const posters = part.map((r) => r.probe?.poster_key).filter(Boolean);
    if (posters.length) await sb.storage.from("studio-outputs").remove(posters).catch(() => undefined);
    const up = await sb.from("studio_assets").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("user_id", u).in("id", part.map((r) => r.id));
    if (up.error) throw up.error;
  }
  return { deleted: go.map((r) => r.id), skipped };
}

// ---------------------------------------------------------------------------------------------------
// The import run: each link fetched into the collection; charged per link brought in
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };
export type ImportDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (l: string) => void; plans?: PlanLike[];
  social?: (sb: SupabaseClient, u: string, url: string, collectionId: string) => Promise<{ asset_id: string; seconds: number | null }>;
  file?: (sb: SupabaseClient, u: string, url: string, collectionId: string) => Promise<{ asset_id: string }> };
async function importSocial(sb: SupabaseClient, deps: ImportDeps, u: string, url: string, collectionId: string) {
  const m = await import("./studio-assistant.js");
  const a = await m.importLink(sb, { env: deps.env, fetch: deps.fetch, log: deps.log } as any, u, url, { maxSeconds: IMPORT_YT_MAX_SECONDS, collectionId });
  return { asset_id: a.asset_id, seconds: a.seconds ?? null };
}
async function importFile(sb: SupabaseClient, deps: ImportDeps, u: string, url: string, collectionId: string) {
  const dir = await mkdtemp(join(tmpdir(), "studio-import-"));
  try {
    const file = join(dir, "v.mp4"), still = join(dir, "v.jpg");
    const bytes = await fetchDirectVideo(url, file, { fetch: deps.fetch });
    const limit = await checkUpload(sb, u, bytes);
    if (limit) throw new ClipsError(limit.code, limit.message, limit.status);
    const { probeSeconds, makePoster } = await import("./studio-recast.js");
    const seconds = await probeSeconds(file).catch(() => 0);
    const id = randomUUID(), key = `${u}/${id}.mp4`;
    const up = await sb.storage.from("studio-uploads").upload(key, await readFile(file), { contentType: "video/mp4", upsert: false });
    if (up.error) throw up.error;
    let posterKey: string | undefined;
    try { await makePoster(file, still); const p = await sb.storage.from("studio-outputs").upload(`${u}/assets/${id}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: true }); if (!p.error) posterKey = `${u}/assets/${id}.jpg`; } catch { /* no poster */ }
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.(mp4|mov|m4v)$/i, "").replace(/[^\w .()-]+/g, " ").trim().slice(0, 80) || "Imported video";
    const ins = await sb.from("studio_assets").insert({ id, user_id: u, kind: "video", name: `${base}.mp4`, object_key: key, bytes, status: "ready", collection_id: collectionId, probe: { duration: seconds || undefined, poster_key: posterKey, source_url: url, source: "file", ...(seconds > 600 || bytes > 536_870_912 ? { long_source: true } : {}) } });
    if (ins.error) throw ins.error;
    return { asset_id: id };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
export async function runImportJob(sb: SupabaseClient, deps: ImportDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), plans = deps.plans ?? [];
  const o = job.options ?? {}, u = job.user_id, collectionId: string = o.collection_id;
  const links: Array<{ url: string; kind: LinkKind }> = Array.isArray(o.links) ? o.links : [];
  const prev = job.progress ?? {};
  const done: Record<string, { ok: boolean; credits: number; reason?: string }> = prev.results && typeof prev.results === "object" ? prev.results : {};
  const save = async (extra: Record<string, any> = {}) => {
    const ok = Object.values(done).filter((d) => d.ok).length;
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), collection_id: collectionId, stage: "importing", done: Object.keys(done).length, total: links.length, message: `Brought in ${ok} of ${links.length}`, results: done, ...extra } });
    if (r.error) throw r.error;
    if (r.data !== true) throw new ClipsError("lease_lost", "lease lost");
  };
  try {
    await save();
    const queue = links.filter((l) => !done[l.url]);
    let stop: ClipsError | null = null;
    const one = async (l: { url: string; kind: LinkKind }) => {
      try {
        if (l.kind === "file") await (deps.file ?? ((a, b, c, d) => importFile(a, deps, b, c, d)))(sb, u, l.url, collectionId);
        else { const r = await (deps.social ?? ((a, b, c, d) => importSocial(a, deps, b, c, d)))(sb, u, l.url, collectionId); if (l.kind === "youtube") { done[l.url] = { ok: true, credits: linkCredits("youtube", env, plans, r.seconds ?? IMPORT_YT_MAX_SECONDS) }; return; } }
        done[l.url] = { ok: true, credits: linkCredits(l.kind, env, plans) };
      } catch (e: any) {
        const code = String(e?.code ?? "");
        if (code === "storage_full" || code === "too_many_files") { stop = new ClipsError(code, String(e.message)); return; }
        done[l.url] = { ok: false, credits: 0, reason: String(e?.message ?? "could not be fetched").slice(0, 140) };
      }
    };
    // two at a time; files (which can be large) one at a time
    const files = queue.filter((l) => l.kind === "file"), social = queue.filter((l) => l.kind !== "file");
    const lane = async (list: typeof queue) => { while (list.length && !stop) { await one(list.shift()!); await save(); } };
    await Promise.all([lane(social), lane(social), lane(files)]);
    const ok = Object.values(done).filter((d) => d.ok);
    const failed = Object.entries(done).filter(([, d]) => !d.ok);
    const credits = Math.min(job.credits_reserved, ok.reduce((s, d) => s + d.credits, 0));
    const note = [
      stop ? `Stopped early: ${(stop as ClipsError).message}` : null,
      failed.length ? `${failed.length} of ${links.length} could not be brought in (their credits were refunded): ${failed.slice(0, 5).map(([url, d]) => `${url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)} (${d.reason})`).join("; ")}${failed.length > 5 ? "…" : ""}` : null,
    ].filter(Boolean).join(" ") || null;
    await sb.from("studio_collections").update({ status: ok.length ? "ready" : "failed", note: ok.length ? note : note ?? "None of the links could be brought in", updated_at: new Date().toISOString() }).eq("id", collectionId).eq("user_id", u);
    const r = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: credits });
    if (r.error) throw r.error;
    recordEvent({ user_id: u, kind: "feature", name: "import_done", props: { job: job.id, links: links.length, ok: ok.length, credits } });
    return "done";
  } catch (e: any) {
    if (e instanceof ClipsError && e.code === "lease_lost") return "lease_lost";
    log(`[import] failed ${job.id}: ${String(e?.message ?? e).slice(0, 200)}`);
    const last = (job.attempts ?? 1) >= 3;
    if (last) await sb.from("studio_collections").update({ status: "failed", note: "The import could not be finished; the credits were refunded.", updated_at: new Date().toISOString() }).eq("id", collectionId).eq("user_id", u);
    const failed = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: "import_failed", p_retry: true });
    if (failed.error) log(`[import] could not record the failure of ${job.id}: ${failed.error.message}`);
    return "failed";
  }
}
export function startImportLoop(sbFn: () => SupabaseClient, deps: ImportDeps = {}, intervalMs = 10_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!importEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `import-${randomUUID()}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    try {
      const sb = sbFn();
      const r = await sb.rpc("studio_claim", { p_tool: "import", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running = true;
      runImportJob(sb, { ...deps, log }, job).then((s) => log(`[import] ${s} ${job.id}`)).catch((e) => log(`[import] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { running = false; });
    } catch (e: any) { log(`[import] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 19_000);
  return t;
}
