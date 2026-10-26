// Storage stewardship: archive-then-remove for rendered variants whose post is done, plus the storage report.
//
// A rendered variant is the original plus a recorded recipe, so the file itself is reproducible. What is not
// reproducible is what the file looked like as posted: the archive keeps the hook frame and a 4-frame strip as small
// JPEGs, a technical probe (codecs, bitrate, loudness), and verifies the file hash against the stored one before
// anything is deleted. Every removal is a ledger row. Nothing is deleted when the archive step fails.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";
import { command } from "./video-render.js";

const BUCKET = "managed-variants";
export const PURGE_VERSION = "archive-v1";

export type PurgeCandidate = { variant_id: string; queue_id: string | null; account_id: string; org_id: string | null; source_sha256: string; object_key: string; bytes: number | null; file_sha256: string | null; posted_at: string | null; published_at: string | null };
export type PurgeResult = { enabled: boolean; checked: number; purged: number; freed_bytes: number; archived_bytes: number; failed: { variant_id: string; error: string }[]; dry_run: boolean; reason?: string };

/** "I: -14.2 LUFS … LRA: 6.1 LU … Peak: -0.9 dBFS" from ffmpeg's ebur128 summary. */
export function parseLoudness(stderr: string): { integrated_lufs: number | null; range_lu: number | null; true_peak_dbfs: number | null } {
  const tail = stderr.slice(-4000);
  const num = (re: RegExp) => { const m = tail.match(re); return m ? Number(m[1]) : null; };
  return { integrated_lufs: num(/I:\s*(-?[\d.]+)\s*LUFS/), range_lu: num(/LRA:\s*(-?[\d.]+)\s*LU/), true_peak_dbfs: num(/Peak:\s*(-?[\d.]+)\s*dBFS/) };
}

/** Compact technical summary from ffprobe JSON. */
export function summarizeProbe(p: any): Record<string, any> {
  const v = (p?.streams ?? []).find((s: any) => s.codec_type === "video") ?? {};
  const a = (p?.streams ?? []).find((s: any) => s.codec_type === "audio") ?? {};
  const fps = (() => { const [n, d] = String(v.avg_frame_rate ?? v.r_frame_rate ?? "0/1").split("/").map(Number); return d ? Math.round((n / d) * 100) / 100 : null; })();
  return { duration: Number(p?.format?.duration) || null, bitrate: Number(p?.format?.bit_rate) || null, size: Number(p?.format?.size) || null,
    video_codec: v.codec_name ?? null, width: v.width ?? null, height: v.height ?? null, fps, pix_fmt: v.pix_fmt ?? null,
    audio_codec: a.codec_name ?? null, sample_rate: Number(a.sample_rate) || null, channels: a.channels ?? null, audio_bitrate: Number(a.bit_rate) || null };
}

async function ffmpegAvailable(): Promise<boolean> {
  try { await command("ffmpeg", ["-version"], undefined, 10000); await command("ffprobe", ["-version"], undefined, 10000); return true; } catch { return false; }
}

async function download(sb: SupabaseClient, key: string): Promise<Buffer | null> {
  const signed = await sb.storage.from(BUCKET).createSignedUrl(key, 600);
  if (signed.error || !signed.data?.signedUrl) return null;
  const r = await fetch(signed.data.signedUrl);
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 134217728) throw new Error("file_too_large");
  return buf;
}

/** Archive one file: probe, loudness, poster, strip. Returns the archive keys and sizes, or throws. */
export async function archiveFile(sb: SupabaseClient, variantId: string, file: Buffer, dir: string): Promise<{ probe: Record<string, any>; poster_key: string; strip_key: string; archive_bytes: number }> {
  const src = join(dir, "v.mp4");
  await writeFile(src, file);
  const probeRaw = await command("ffprobe", ["-v", "error", "-i", src, "-show_streams", "-show_format", "-of", "json"], undefined, 30000);
  const probe = summarizeProbe(JSON.parse(probeRaw.toString()));
  let loudness: Record<string, number | null> = { integrated_lufs: null, range_lu: null, true_peak_dbfs: null };
  try { const out = await command("ffmpeg", ["-nostats", "-i", src, "-af", "ebur128=peak=true", "-f", "null", "-"], undefined, 120000); loudness = parseLoudness(out.toString()); } catch { /* loudness is optional */ }
  const duration = Number(probe.duration) || 0;
  const poster = join(dir, "poster.jpg");
  await command("ffmpeg", ["-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", "scale=360:640:force_original_aspect_ratio=decrease", "-q:v", "4", poster], undefined, 30000);
  const frames: string[] = [];
  for (const f of [0.1, 0.35, 0.6, 0.85]) {
    const at = Math.max(0, Math.min(duration * f, Math.max(duration - 0.2, 0)));
    const out = join(dir, `f${frames.length}.jpg`);
    await command("ffmpeg", ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=180:320:force_original_aspect_ratio=decrease,pad=180:320:(ow-iw)/2:(oh-ih)/2", "-q:v", "6", out], undefined, 30000);
    frames.push(out);
  }
  const strip = join(dir, "strip.jpg");
  await command("ffmpeg", ["-v", "error", "-y", ...frames.flatMap((f) => ["-i", f]), "-filter_complex", "[0][1][2][3]hstack=inputs=4", "-q:v", "6", strip], undefined, 30000);
  const posterBuf = await readFile(poster), stripBuf = await readFile(strip);
  const poster_key = `archive/${variantId}/poster.jpg`, strip_key = `archive/${variantId}/strip.jpg`;
  for (const [key, buf] of [[poster_key, posterBuf], [strip_key, stripBuf]] as const) {
    const up = await sb.storage.from(BUCKET).upload(key, buf, { contentType: "image/jpeg", upsert: true });
    if (up.error) throw new Error(`archive_upload_failed: ${up.error.message}`);
  }
  return { probe: { ...probe, loudness }, poster_key, strip_key, archive_bytes: posterBuf.length + stripBuf.length };
}

/** One pass: archive and remove up to `limit` eligible files. Disabled unless library_control.purge_enabled. */
export async function purgeTick(sb: SupabaseClient, opts: { limit?: number; dryRun?: boolean; log?: (s: string) => void } = {}): Promise<PurgeResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200)), dryRun = !!opts.dryRun, log = opts.log ?? ((s) => console.log(s));
  const out: PurgeResult = { enabled: false, checked: 0, purged: 0, freed_bytes: 0, archived_bytes: 0, failed: [], dry_run: dryRun };
  const control = await sb.from("library_control").select("purge_enabled,purge_grace_days").maybeSingle();
  if (control.error) throw control.error;
  out.enabled = !!control.data?.purge_enabled;
  if (!out.enabled && !dryRun) { out.reason = "purge_disabled"; return out; }
  const cands = await sb.rpc("library_purge_candidates", { p_limit: limit });
  if (cands.error) throw cands.error;
  const list = (cands.data ?? []) as PurgeCandidate[];
  out.checked = list.length;
  if (dryRun || list.length === 0) return out;
  if (!(await ffmpegAvailable())) { out.reason = "ffmpeg_missing"; return out; }
  for (const c of list) {
    const dir = await mkdtemp(join(tmpdir(), "archive-"));
    try {
      const file = await download(sb, c.object_key);
      let entry: Record<string, any> = { org_id: c.org_id, object_key: c.object_key, posted_at: c.posted_at, published_at: c.published_at, features_present: true };
      if (!file) {
        // Already gone from storage: record it so the row stops being a candidate; nothing to archive.
        entry = { ...entry, bytes_freed: 0, sha_verified: false, outcome: "object_missing" };
      } else {
        const sha = createHash("sha256").update(file).digest("hex");
        const verified = !c.file_sha256 || sha === c.file_sha256;
        if (!verified) throw new Error("hash_mismatch");
        const arch = await archiveFile(sb, c.variant_id, file, dir);
        entry = { ...entry, bytes_freed: file.length, file_sha256: sha, sha_verified: true, ...arch, outcome: "purged" };
      }
      const mark = await sb.rpc("library_mark_purged", { p_variant: c.variant_id, p_entry: entry });
      if (mark.error) throw mark.error;
      if (file) {
        const del = await sb.storage.from(BUCKET).remove([c.object_key]);
        if (del.error) throw new Error(`delete_failed: ${del.error.message}`);
        out.purged += 1; out.freed_bytes += file.length; out.archived_bytes += Number(entry.archive_bytes ?? 0);
      }
    } catch (e: any) {
      out.failed.push({ variant_id: c.variant_id, error: String(e?.message ?? e).slice(0, 160) });
      log(`[archive] ${c.variant_id} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  log(`[archive] purged ${out.purged} of ${out.checked}, freed ${(out.freed_bytes / 1048576).toFixed(1)} MB, archived ${(out.archived_bytes / 1024).toFixed(0)} KB, failed ${out.failed.length}`);
  return out;
}

export async function storageReport(sb: SupabaseClient) {
  const [usage, recent, legacy] = await Promise.all([
    sb.rpc("library_storage_usage"),
    sb.from("library_purges").select("variant_id,account_id,org_id,source_sha256,bytes_freed,archive_bytes,sha_verified,outcome,purged_at").order("purged_at", { ascending: false }).limit(20),
    sb.rpc("library_unreferenced_legacy"),
  ]);
  for (const r of [usage, recent, legacy]) if (r.error) throw r.error;
  const u = Array.isArray(usage.data) ? usage.data[0] : usage.data;
  const n = (k: string) => Number(u?.[k] ?? 0);
  const perDay = n("added_7d_bytes") / 7;
  const headroom = n("max_output_bytes") - n("stored_bytes");
  return {
    usage: u ?? null,
    projection: { added_per_day_bytes: Math.round(perDay), days_to_cap: perDay > 0 ? Math.floor(headroom / perDay) : null, reclaimable_now_bytes: n("posted_unpurged_bytes") },
    recent_purges: recent.data ?? [],
    unreferenced_legacy: legacy.data ?? [],
  };
}

export function registerLibraryArchive(app: Express, sbFn: () => SupabaseClient): void {
  app.get("/api/ops/storage", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try { res.json(await storageReport(sbFn())); } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/does not exist/i.test(msg)) return res.status(503).json({ error: "storage_unavailable", detail: "The storage migration has not been applied" });
      res.status(500).json({ error: "storage_failed", detail: msg.slice(0, 200) });
    }
  });
  app.post("/api/ops/storage/purge", async (req: Request, res: Response) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator_required" });
    try {
      const r = await purgeTick(sbFn(), { limit: Number(req.body?.limit) || 20, dryRun: req.body?.dry_run !== false });
      console.log("[archive] manual pass", JSON.stringify({ by: (req.auth as any)?.user_id, ...r, failed: r.failed.length }));
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: "purge_failed", detail: String(e?.message ?? e).slice(0, 200) }); }
  });
  app.patch("/api/ops/storage/settings", async (req: Request, res: Response) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator_required" });
    const patch: Record<string, any> = {};
    if ("purge_enabled" in (req.body ?? {})) { if (typeof req.body.purge_enabled !== "boolean") return res.status(400).json({ error: "invalid_purge_enabled" }); patch.purge_enabled = req.body.purge_enabled; }
    for (const [k, lo, hi] of [["purge_grace_days", 3, 365], ["render_buffer_days", 3, 365]] as const) {
      if (!(k in (req.body ?? {}))) continue;
      const v = Number(req.body[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) return res.status(400).json({ error: `invalid_${k}` });
      patch[k] = v;
    }
    if ("max_output_gib" in (req.body ?? {})) {
      const g = Number(req.body.max_output_gib);
      if (!Number.isFinite(g) || g < 1 || g > 100) return res.status(400).json({ error: "invalid_max_output_gib" });
      patch.max_output_bytes = Math.round(g * 1073741824);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_update" });
    try {
      const sb = sbFn();
      const r = await sb.from("library_control").update(patch).eq("singleton", true).select("enabled,max_active,max_daily_claims,max_output_bytes,purge_enabled,purge_grace_days,render_buffer_days").single();
      if (r.error) throw r.error;
      console.log("[archive] settings", JSON.stringify({ by: (req.auth as any)?.user_id, patch }));
      res.json({ control: r.data });
    } catch (e: any) { res.status(500).json({ error: "settings_failed", detail: String(e?.message ?? e).slice(0, 200) }); }
  });
}
