// A picture or a clip from a public link, into the person's library (POST /api/studio/assets/from-link).
//
// Why: the Clone8 connector (studio-mcp.ts) lets a chat run presets and models that need a photo or a clip, and a chat
// cannot upload a file the way the website does. Higgsfield's MCP takes media the same way. The link is fetched by us
// with the library's own guard (safeTarget: https only, no passwords, never a private or local address, checked again
// on every redirect), capped in size, and kept only when its first bytes say JPEG, PNG, WebP, MP4 or MOV.
// The upload limits of the person's plan apply as for any upload (studio-limits.ts checkUpload).
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeTarget } from "./studio-library.js";
import { checkUpload } from "./studio-limits.js";
import { toJpeg } from "./studio-characters.js";
import { makePoster, probeSeconds } from "./studio-recast.js";

export const LINK_IMAGE_MAX = 31_457_280; // 30 MB
export const LINK_VIDEO_MAX = 209_715_200; // 200 MB
export class MediaLinkError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

/** What the first bytes say the file is (never the name or the server's word). */
export function sniff(head: Buffer): { kind: "image" | "video"; ext: "jpg" | "png" | "webp" | "mp4" | "mov" } | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", ext: "jpg" };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", ext: "png" };
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", ext: "webp" };
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") return { kind: "video", ext: head.subarray(8, 10).toString("latin1") === "qt" ? "mov" : "mp4" };
  return null;
}

/** Downloads a link into memory, following at most 5 redirects, each one checked; stops past `max` bytes. */
export async function fetchLinkBytes(url: string, o: { fetch?: typeof fetch; resolve?: (h: string) => Promise<string[]>; max?: number } = {}): Promise<Buffer> {
  const f = o.fetch ?? fetch, max = o.max ?? LINK_VIDEO_MAX;
  let next = url, r: globalThis.Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const u = await safeTarget(next, o.resolve).catch((e: any) => { throw new MediaLinkError(e?.code === "link_fetch_failed" ? "link_fetch_failed" : "link_unsafe", e?.message ?? "That link cannot be fetched"); });
    r = await f(u.toString(), { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { "user-agent": "Mozilla/5.0 (compatible; Clone8Studio/1.0)" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { next = new URL(r.headers.get("location")!, u).toString(); continue; }
    break;
  }
  if (!r || r.status >= 300) throw new MediaLinkError("link_fetch_failed", `The file could not be downloaded (${r?.status ?? "no answer"})`);
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new MediaLinkError("link_too_large", "That file is too large");
  if (/text\/html|application\/json/i.test(String(r.headers.get("content-type") ?? ""))) throw new MediaLinkError("link_no_media", "That link opens a page, not a file (is it shared publicly?)");
  if (!r.body) throw new MediaLinkError("link_no_media", "The file was empty");
  const parts: Buffer[] = []; let seen = 0;
  const reader = (r.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    if (seen > max) { await reader.cancel().catch(() => undefined); throw new MediaLinkError("link_too_large", "That file is too large"); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

export type MediaLinkHelpers = { sbFn: () => SupabaseClient; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => any; posterKey: (u: string, id: string) => string; fetch?: typeof fetch };

export function registerMediaLink(app: Express, h: MediaLinkHelpers): void {
  app.post("/api/studio/assets/from-link", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    const url = String(req.body?.url ?? "").trim();
    if (!/^https:\/\//i.test(url) || url.length > 2000) return res.status(400).json({ error: "link_invalid", detail: "Give an https link to a picture or a clip" });
    let dir: string | null = null;
    try {
      const bytes = await fetchLinkBytes(url, { fetch: h.fetch });
      const k = sniff(bytes.subarray(0, 16));
      if (!k) throw new MediaLinkError("link_no_media", "That link is not a JPEG, PNG, WebP, MP4 or MOV file");
      if (k.kind === "image" && bytes.length > LINK_IMAGE_MAX) throw new MediaLinkError("link_too_large", "Pictures can be up to 30 MB");
      const sb = h.sbFn();
      const limit = await checkUpload(sb, u, bytes.length);
      if (limit) return res.status(limit.status).json({ error: limit.code, detail: limit.message });
      // WebP is kept as JPEG (the models and the library read JPEG and PNG)
      const body = k.ext === "webp" ? await toJpeg(bytes) : bytes, ext = k.ext === "webp" ? "jpg" : k.ext;
      const id = randomUUID(), key = `${u}/${id}.${ext}`;
      const fromName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(/[^\w.\- ]+/g, "").slice(0, 80);
      const name = String(req.body?.name ?? "").replace(/[^\w.\- ]+/g, "").trim().slice(0, 80) || fromName.replace(/\.[a-z0-9]+$/i, "") || (k.kind === "image" ? "Photo" : "Clip");
      const contentType = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "mov" ? "video/quicktime" : "video/mp4";
      const up = await sb.storage.from("studio-uploads").upload(key, body, { contentType, upsert: false });
      if (up.error) throw up.error;
      // the poster the library grids show: the picture itself as JPEG, or a frame of the clip
      const probe: Record<string, any> = { from_link: true };
      try {
        let poster: Buffer;
        if (k.kind === "image") poster = ext === "jpg" ? body : await toJpeg(body);
        else {
          dir = await mkdtemp(join(tmpdir(), "studio-link-"));
          const v = join(dir, `in.${ext}`), p = join(dir, "poster.jpg");
          await writeFile(v, body); await makePoster(v, p); poster = await readFile(p);
          const s = await probeSeconds(v).catch(() => 0); if (s > 0) probe.duration = Math.round(s * 100) / 100;
        }
        const pk = h.posterKey(u, id);
        const pu = await sb.storage.from("studio-outputs").upload(pk, poster, { contentType: "image/jpeg", upsert: true });
        if (!pu.error) probe.poster_key = pk;
      } catch { /* a missing poster never loses the file */ }
      const row = await sb.from("studio_assets").insert({ id, user_id: u, kind: k.kind, name: `${name}.${ext}`, object_key: key, bytes: body.length, status: "ready", probe }).select("id,kind,name").single();
      if (row.error) throw row.error;
      res.status(201).json({ asset_id: id, kind: k.kind, name: row.data.name });
    } catch (e: any) {
      if (e instanceof MediaLinkError) return res.status(e.status).json({ error: e.code, detail: e.message });
      h.fail(res, e);
    } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  });
}
