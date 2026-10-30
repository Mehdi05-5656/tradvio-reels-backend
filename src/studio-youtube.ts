// Clone8 Studio: YouTube videos and Shorts as sources. The metadata service has no file download for YouTube, so the
// file itself comes through yt-dlp: a standalone build fetched once onto the instance (no Python needed), kept in the
// temp directory, and run with a size and length cap. YouTube sometimes refuses cloud addresses ("confirm you're not a
// bot"); that becomes a plain failure the person can act on (upload the file), never a hang or a retry storm.
import { spawn } from "node:child_process";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

export const YT_DLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
export type DownloadOpts = { maxBytes: number; maxSeconds: number; timeoutMs?: number; fetch?: typeof fetch; env?: Record<string, string | undefined> };
export class LinkError extends Error { constructor(public code: "link_blocked" | "link_no_media" | "link_too_large" | "link_too_long" | "link_fetch_failed", message: string) { super(message); } }

/** The file name of the standalone build for this machine. */
export function ytDlpAsset(os = platform(), cpu = arch()): string {
  if (os === "darwin") return "yt-dlp_macos";
  if (os === "linux") return cpu === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  return "yt-dlp";
}

let ready: Promise<string> | null = null;
/** The path of a runnable yt-dlp: YT_DLP_PATH if set, else a copy downloaded once into the temp directory. */
export function ensureYtDlp(deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (env.YT_DLP_PATH) return Promise.resolve(env.YT_DLP_PATH);
  if (!ready) ready = (async () => {
    const dir = join(tmpdir(), "clone8-bin"), bin = join(dir, "yt-dlp");
    try { await access(bin); return bin; } catch { /* not there yet */ }
    await mkdir(dir, { recursive: true });
    const r = await (deps.fetch ?? fetch)(`${YT_DLP_RELEASE}/${ytDlpAsset()}`, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new LinkError("link_fetch_failed", `the downloader could not be fetched (${r.status})`);
    const tmp = `${bin}.${process.pid}.part`;
    await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
    await chmod(tmp, 0o755);
    await rename(tmp, bin);
    return bin;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
export const resetYtDlp = () => { ready = null; };

/** What yt-dlp's complaint means for the person. */
export function classifyYtDlpError(stderr: string): LinkError {
  const s = stderr.toLowerCase();
  if (/sign in to confirm|not a bot|captcha|http error 429|too many requests/.test(s)) return new LinkError("link_blocked", "YouTube refused the download from our servers; upload the file instead");
  if (/file is larger than max-filesize|max-filesize/.test(s)) return new LinkError("link_too_large", "That video is over 512 MB");
  if (/does not pass filter|duration/.test(s) && /filter/.test(s)) return new LinkError("link_too_long", "That video is longer than the limit");
  if (/private video|video unavailable|this video is not available|removed|members-only|age-restricted|sign in to confirm your age|premieres in|is live|live event/.test(s)) return new LinkError("link_no_media", "That video cannot be fetched (private, removed, live or age-restricted)");
  if (/unsupported url|is not a valid url|no video formats found/.test(s)) return new LinkError("link_no_media", "No video was found at that link");
  return new LinkError("link_fetch_failed", `The video could not be downloaded: ${stderr.replace(/\s+/g, " ").trim().slice(-200)}`);
}

/** yt-dlp's arguments: best MP4 up to 1080p with sound, merged with ffmpeg, capped in size and length, no playlists.
 *  Node serves as the JavaScript runtime YouTube's challenges need (the official build carries the solver scripts).
 *  STUDIO_YT_PROXY (an http(s):// or socks5:// URL, ideally residential) and a cookies file are passed when given. */
export function ytDlpArgs(url: string, target: string, o: { maxBytes: number; maxSeconds: number; proxy?: string | null; cookies?: string | null; node?: string | null }): string[] {
  return [
    "--no-playlist", "--no-warnings", "--no-progress", "--no-cache-dir", "--quiet",
    "--force-ipv4", "--socket-timeout", "30", "--retries", "2",
    ...(o.node === null ? [] : ["--no-js-runtimes", "--js-runtimes", `node:${o.node ?? process.execPath}`]),
    ...(o.proxy ? ["--proxy", o.proxy] : []),
    ...(o.cookies ? ["--cookies", o.cookies] : []),
    "--max-filesize", String(o.maxBytes),
    "--match-filter", `duration <= ${Math.floor(o.maxSeconds)}`,
    "-f", "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/b[height<=1080]/b",
    "--merge-output-format", "mp4",
    "-o", target,
    url,
  ];
}

/** The cookies file for YouTube, when STUDIO_YT_COOKIES (base64 of a Netscape cookies file) is set; written once. */
async function cookiesFile(env: Record<string, string | undefined>): Promise<string | null> {
  const b64 = env.STUDIO_YT_COOKIES; if (!b64) return null;
  const dir = join(tmpdir(), "clone8-bin"), file = join(dir, "yt-cookies.txt");
  await mkdir(dir, { recursive: true });
  await writeFile(file, Buffer.from(b64, "base64"), { mode: 0o600 });
  return file;
}

/** Downloads a YouTube video or Short to `target` (an .mp4 path). Resolves with the title yt-dlp saw. */
export async function downloadYouTube(url: string, target: string, o: DownloadOpts): Promise<{ title: string | null }> {
  const bin = await ensureYtDlp(o);
  const env = o.env ?? process.env;
  const args = [...ytDlpArgs(url, target, { ...o, proxy: env.STUDIO_YT_PROXY || null, cookies: await cookiesFile(env) }), "--print", "after_move:title"];
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, o.timeoutMs ?? 600_000);
    child.stdout.on("data", (b) => { stdout += b.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on("data", (b) => { stderr += b.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (killed) reject(new LinkError("link_fetch_failed", "The download took too long")); else resolve({ code, stdout, stderr }); });
  });
  if (out.code !== 0) throw classifyYtDlpError(out.stderr || out.stdout);
  try { await access(target); } catch { throw classifyYtDlpError(out.stderr || "no file was written"); }
  const title = out.stdout.split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? null;
  return { title: title && title !== "NA" ? title : null };
}

/** The 11-character video id, for a clean name when there is no title. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url); const h = u.hostname.toLowerCase();
    if (/(^|\.)youtu\.be$/.test(h)) return u.pathname.split("/")[1]?.slice(0, 11) || null;
    const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/); if (m) return m[1];
    const v = u.searchParams.get("v"); return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
  } catch { return null; }
}
