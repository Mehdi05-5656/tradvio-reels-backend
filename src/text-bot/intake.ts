// Files sent in the chat (owner, Nov 26 2026: "I sent five videos and it said it can't take files"). A video or a
// picture texted to Clone8 goes into the person's library exactly as an upload from the website would: the same
// route (POST /api/studio/assets/upload-url, so plan limits and "same file again" apply), the same bucket, then
// /complete. The bot then has them numbered, in the order sent, to post, schedule, caption or clip.
//
// Where the bytes come from:
//   iMessage: each attachment is a link Sendblue gives us (media_url), fetched as is;
//   Telegram: the file's id, turned into a download by getFile. Telegram lets a bot download files up to 20 MB only:
//             a bigger one is named back to the person with what to do instead.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Api } from "./routes.js";

export type InFile = { url?: string; file_id?: string; name?: string; mime?: string; size?: number };
export type Took = { asset_id: string; name: string; kind: "video" | "image" };
export type Intake = { got: Took[]; failed: Array<{ name: string; why: string }> };

const VIDEO = /\.(mp4|mov|m4v)$/i, IMAGE = /\.(jpe?g|png)$/i;
const EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v", "image/jpeg": "jpg", "image/png": "png" };
/** Telegram's own ceiling for a bot's downloads. */
export const TELEGRAM_MAX = 20 * 1024 * 1024;
/** What we take in one go from a chat: the file is held in the server's memory while it is stored, so a long video
 *  belongs in the website's uploader. */
export const CHAT_MAX = 300 * 1024 * 1024;

/** A file name the library accepts: its own if it has a known ending, else one made from its type. */
export function nameFor(f: InFile, n: number, stamp: string): string | null {
  const raw = String(f.name ?? (f.url ? decodeURIComponent(f.url.split("?")[0].split("/").pop() ?? "") : "")).replace(/[^\w .()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (VIDEO.test(raw) || IMAGE.test(raw)) return raw;
  const ext = f.mime ? EXT[f.mime.toLowerCase()] : null;
  return ext ? `Texted ${stamp} #${n}.${ext}` : null;
}
const typeOf = (name: string) => (/\.mov$/i.test(name) ? "video/quicktime" : VIDEO.test(name) ? "video/mp4" : /\.png$/i.test(name) ? "image/png" : "image/jpeg");

/** A file's address is fetched only when it is an https name on the public internet: no bare IP addresses, no
 *  localhost or internal names. Redirects are followed by hand (three at most), each one checked the same way. */
export function safeUrl(raw: string): boolean {
  let u: URL; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false; // an IP address (v4 or v6)
  if (h === "localhost" || !h.includes(".") || /\.(local|internal|localhost|lan|home|corp|intranet)$/.test(h) || h === "metadata.google.internal") return false;
  return true;
}
async function getSafe(f: typeof fetch, url: string, signal: AbortSignal): Promise<Response | null> {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!safeUrl(at)) return null;
    const r = await f(at, { redirect: "manual", signal });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { at = new URL(r.headers.get("location")!, at).toString(); continue; }
    return r;
  }
  return null;
}
/** The body, read as it comes, given up past `max` bytes (a missing or false length can't make it hold more). */
async function readCapped(r: Response, max: number): Promise<Buffer | "too_big" | null> {
  if (!r.body) return null;
  const reader = r.body.getReader(), parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); return "too_big"; }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
export const MAX_FILES = 20;

export async function intake(o: { api: Api; sb: SupabaseClient; files: InFile[]; telegramToken?: string | null; fetch?: typeof fetch; now?: Date; log?: (e: string, d?: Record<string, unknown>) => void;
  /** the server's file lock: one turn moves files at a time, so memory stays bounded */ lock?: () => Promise<() => void> }): Promise<Intake> {
  const f = o.fetch ?? fetch, out: Intake = { got: [], failed: [] };
  for (const extra of o.files.slice(MAX_FILES)) out.failed.push({ name: extra.name || "a file", why: "too_many" });
  const free = o.lock ? await o.lock() : null;
  try {
  const stamp = (o.now ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  for (const [i, file] of o.files.slice(0, MAX_FILES).entries()) {
    const label = file.name || `file ${i + 1}`;
    try {
      // where the bytes are
      let url = file.url ?? null;
      if (!url && file.file_id && o.telegramToken) {
        if (file.size && file.size > TELEGRAM_MAX) { out.failed.push({ name: label, why: "telegram_too_big" }); continue; }
        const r = await f(`https://api.telegram.org/bot${o.telegramToken}/getFile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: file.file_id }), signal: AbortSignal.timeout(20_000) });
        const j: any = await r.json().catch(() => null);
        if (!j?.ok || !j.result?.file_path) { out.failed.push({ name: label, why: /too big/i.test(String(j?.description)) ? "telegram_too_big" : "unreadable" }); continue; }
        url = `https://api.telegram.org/file/bot${o.telegramToken}/${j.result.file_path}`;
        if (!file.name) file.name = String(j.result.file_path).split("/").pop();
      }
      if (!url || !safeUrl(url)) { out.failed.push({ name: label, why: "unreadable" }); continue; }
      if (/\.(heic|heif)(\?|$)/i.test(String(file.name ?? url))) { out.failed.push({ name: label, why: "heic" }); continue; }
      const name = nameFor(file, i + 1, stamp);
      if (!name) { out.failed.push({ name: label, why: "not_video_or_picture" }); continue; }
      const res = await getSafe(f, url, AbortSignal.timeout(300_000));
      if (!res || !res.ok) { out.failed.push({ name, why: "unreadable" }); continue; }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > CHAT_MAX) { await res.body?.cancel().catch(() => undefined); out.failed.push({ name, why: "too_big" }); continue; }
      const read = await readCapped(res, CHAT_MAX);
      if (read === "too_big") { out.failed.push({ name, why: "too_big" }); continue; }
      const bytes = read;
      if (!bytes || !bytes.length) { out.failed.push({ name, why: "unreadable" }); continue; }
      // the website's own upload: plan limits, the same file kept once
      const up = await o.api.call("POST", "/api/studio/assets/upload-url", { name, size: bytes.length, type: typeOf(name) });
      if (up.status !== 200) { out.failed.push({ name, why: String(up.json?.detail ?? up.json?.error ?? `http_${up.status}`).slice(0, 160) }); continue; }
      const kind = (VIDEO.test(name) ? "video" : "image") as Took["kind"];
      if (up.json?.existing) { out.got.push({ asset_id: String(up.json.asset_id), name: String(up.json.existing.name ?? name), kind }); continue; }
      const put = await o.sb.storage.from(String(up.json.bucket ?? "studio-uploads")).uploadToSignedUrl(String(up.json.path), String(up.json.token), bytes, { contentType: typeOf(name), upsert: false });
      if (put.error) { out.failed.push({ name, why: "store_failed" }); o.log?.("intake_store_failed", { detail: String(put.error.message).slice(0, 160) }); continue; }
      const done = await o.api.call("POST", `/api/studio/assets/${up.json.asset_id}/complete`, { probe: {} });
      if (done.status !== 200) { out.failed.push({ name, why: String(done.json?.error ?? `http_${done.status}`) }); continue; }
      out.got.push({ asset_id: String(up.json.asset_id), name: String(done.json?.asset?.name ?? name), kind });
    } catch (e: any) { out.failed.push({ name: label, why: /timeout|abort/i.test(String(e?.name ?? e?.message)) ? "too_slow" : "unreadable" }); }
  }
  } finally { free?.(); }
  o.log?.("intake", { got: out.got.length, failed: out.failed.map((x) => x.why) });
  return out;
}

/** What went wrong with a file, as the person is told. */
export function whyText(why: string): string {
  return why === "telegram_too_big" ? "Telegram only lets me take files up to 20 MB. Send a link, or upload it on the Library page."
    : why === "too_big" ? "it's over 300 MB; upload it on the Library page"
    : why === "not_video_or_picture" ? "only videos (MP4, MOV) and pictures (JPG, PNG) can go in the library"
    : why === "too_many" ? `only ${MAX_FILES} files can come in one go; send the rest after`
    : why === "heic" ? "iPhone HEIC photos can't go in the library yet; send it as a JPG (Settings → Camera → Formats → Most Compatible) or as a video"
    : why === "too_slow" ? "it took too long to come through; send it again or use a link"
    : why === "store_failed" || why === "unreadable" ? "it didn't come through; send it again"
    : why;
}
