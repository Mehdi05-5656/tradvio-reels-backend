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
export class LinkError extends Error { constructor(public code: "link_blocked" | "link_no_media" | "link_too_large" | "link_too_long" | "link_fetch_failed" | "link_stopped", message: string) { super(message); } }

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

/** The direct stream addresses of a YouTube video (1080p or less; VP9 preferred, it is about a third smaller than H.264
 *  at the same quality), without downloading anything. ffmpeg then reads only the stretches it cuts. The addresses are
 *  tied to the IP that asked (forced IPv4, the same proxy) and last about six hours. */
export type YouTubeStreams = { video: string; audio: string | null; width: number; height: number; fps: number | null; seconds: number | null; proxy: string | null };
export function streamArgs(url: string, o: { proxy?: string | null; cookies?: string | null; node?: string | null }): string[] {
  return [
    "--no-playlist", "--no-warnings", "--quiet", "--no-cache-dir", "--force-ipv4", "--socket-timeout", "30",
    ...(o.node === null ? [] : ["--no-js-runtimes", "--js-runtimes", `node:${o.node ?? process.execPath}`]),
    ...(o.proxy ? ["--proxy", o.proxy] : []),
    ...(o.cookies ? ["--cookies", o.cookies] : []),
    "-f", "bv*[height<=1080][vcodec^=vp09]+ba/bv*[height<=1080][vcodec^=avc1]+ba/b[height<=1080]",
    "--print", "dims:%(width)s|%(height)s|%(fps)s|%(duration)s",
    "--print", "urls",
    url,
  ];
}
export function parseStreams(stdout: string, proxy: string | null): YouTubeStreams {
  const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const dims = lines.find((l) => l.startsWith("dims:"))?.slice(5).split("|") ?? [];
  const urls = lines.filter((l) => /^https?:\/\//.test(l));
  if (!urls.length) throw new LinkError("link_no_media", "No video stream was found at that link");
  const n = (v: string | undefined) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  return { video: urls[0], audio: urls[1] ?? null, width: n(dims[0]) ?? 0, height: n(dims[1]) ?? 0, fps: n(dims[2]), seconds: n(dims[3]), proxy };
}
export async function youtubeStreams(url: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<YouTubeStreams> {
  const bin = await ensureYtDlp(o);
  const env = o.env ?? process.env;
  const proxy = env.STUDIO_YT_PROXY || null;
  const args = streamArgs(url, { proxy, cookies: await cookiesFile(env) });
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, o.timeoutMs ?? 120_000);
    child.stdout.on("data", (b) => { stdout += b.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on("data", (b) => { stderr += b.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (killed) reject(new LinkError("link_fetch_failed", "YouTube took too long to answer")); else resolve({ code, stdout, stderr }); });
  });
  if (out.code !== 0) throw classifyYtDlpError(out.stderr || out.stdout);
  return parseStreams(out.stdout, proxy);
}

/** yt-dlp run with our usual settings (proxy, cookies, Node for YouTube's challenges); its complaint becomes a LinkError. */
async function runYtDlp(args: string[], o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
  const bin = await ensureYtDlp(o);
  const env = o.env ?? process.env;
  const cookies = await cookiesFile(env);
  const full = [
    // not --quiet: when ffmpeg fails inside yt-dlp, its own words are the only clue, and --quiet swallows them
    "--no-playlist", "--no-warnings", "--no-progress", "--force-ipv4", "--socket-timeout", "30", "--retries", "3",
    "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`,
    ...(env.STUDIO_YT_PROXY ? ["--proxy", env.STUDIO_YT_PROXY] : []),
    ...(cookies ? ["--cookies", cookies] : []),
    ...args,
  ];
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, full, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false, stopped = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, o.timeoutMs ?? 8 * 60_000);
    // the run that asked for it is gone (its lease went to another attempt): stop paying for the download now
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    if (o.signal?.aborted) stop(); else o.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => { stdout += b.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on("data", (b) => { stderr += b.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); o.signal?.removeEventListener("abort", stop); if (stopped) reject(new LinkError("link_stopped", "The download was stopped")); else if (killed) reject(new LinkError("link_fetch_failed", "YouTube took too long to send the video")); else resolve({ code, stdout, stderr }); });
  });
  if (out.code !== 0) {
    const said = redactProxy(`${out.stderr}\n${out.stdout}`).split("\n").filter((l) => l.trim() && !/^\[(download|youtube|info|hlsnative)\]/.test(l)).slice(-12).join(" | ");
    console.log(`[youtube] yt-dlp failed: ${said.slice(-900)}`);
    throw classifyYtDlpError(out.stderr || out.stdout);
  }
  return out.stdout;
}
/** Any proxy address with a password in a line of text, the password blanked. */
export const redactProxy = (text: string) => text.replace(/(\w+:\/\/)[^\s:@/]+:[^\s@/]+@/g, "$1***:***@");
/** What the server's ffmpeg is and whether it opens https addresses (Clips reads signed upload links and YouTube through it). */
export async function ffmpegReport(): Promise<string> {
  const run = (args: string[]) => new Promise<string>((resolve) => { const c = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] }); let o = ""; c.stdout.on("data", (b) => { o += b; }); c.stderr.on("data", (b) => { o += b; }); c.on("error", () => resolve("missing")); c.on("close", () => resolve(o)); });
  const version = (await run(["-hide_banner", "-version"])).split("\n")[0]?.slice(0, 120) ?? "?";
  const protocols = await run(["-hide_banner", "-protocols"]);
  const has = (p: string) => new RegExp(`^\\s*${p}\\s*$`, "m").test(protocols.split("Output:")[0] ?? "");
  // Captions render through libass (the "ass" filter); without it every captions job would fail at the render
  const filters = await run(["-hide_banner", "-filters"]);
  const ass = /^\s*\S+\s+ass\s/m.test(filters);
  return `${version}; https ${has("https") ? "yes" : "NO"}, tls ${has("tls") ? "yes" : "NO"}, httpproxy ${has("httpproxy") ? "yes" : "NO"}, libass ${ass ? "yes" : "NO (captions cannot render)"}`;
}
/** One stretch of a YouTube video, cut exactly (keyframes forced at the cuts) to an H.264 + AAC MP4 at up to 1080 lines.
 *  yt-dlp fetches it itself: YouTube refuses its stream addresses when another program asks for them (seen Oct 31 2026:
 *  every external ffmpeg read got 403 while yt-dlp's own section download worked from the same address). */
export async function youtubeSection(url: string, start: number, end: number, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<void> {
  await runYtDlp([
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--download-sections", `*${start.toFixed(2)}-${end.toFixed(2)}`, "--force-keyframes-at-cuts",
    "--downloader-args", "ffmpeg_o:-c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p -c:a aac -b:a 192k -ac 2",
    "--merge-output-format", "mp4", "-o", target, url,
  ], { ...o, timeoutMs: 8 * 60_000 });
  try { await access(target); } catch { throw new LinkError("link_fetch_failed", "The stretch of the video could not be fetched"); }
}
/** The format list for a whole-video download: at most `h` lines and 30 fps (a 1080p60 vlog came down at 338 kB/s and
 *  cut twice as slowly, Nov 1 2026), never AV1 (slow to decode here), with the ~70 kb/s Opus sound when there is one.
 *  `language`: a dubbed track to prefer (YouTube's auto-dubs), else the video's own original track (see downloadSort). */
export const downloadFormat = (h: number, language?: string | null) => {
  const lang = language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ? language : null;
  const audio = lang ? `ba[language^=${lang}][acodec=opus]/ba[language^=${lang}]/ba[acodec=opus][abr<=100]/ba` : "ba[acodec=opus][abr<=100]/ba";
  return `bv*[height<=${h}][fps<=30][vcodec!^=av01]+${audio}/bv*[height<=${h}][vcodec!^=av01]+${audio}/b[height<=${h}]/b`;
};
/** How yt-dlp ranks what matches: the original audio track first (lang = YouTube's own default track, never an
 *  auto-dub: a German dub was picked once), then the size wanted, then the smaller file. */
export const downloadSort = (h: number) => `lang,res:${h},fps:30,+size,+br`;
/** The whole video, downloaded by yt-dlp's own downloader (no ffmpeg reading YouTube: through the proxy on Render every
 *  ffmpeg read of a YouTube address got 403, Oct 31 2026); at most `maxHeight` lines (1080, or 720 for long videos). */
export async function youtubeDownload(url: string, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; maxHeight?: number; language?: string | null; signal?: AbortSignal } = {}): Promise<void> {
  const h = o.maxHeight ?? 1080;
  await runYtDlp([
    "-f", downloadFormat(h, o.language), "-S", downloadSort(h),
    "--merge-output-format", "mp4", "--concurrent-fragments", "4", "-o", target, url,
  ], { ...o, timeoutMs: 40 * 60_000 });
  try { await access(target); } catch { throw new LinkError("link_fetch_failed", "The video could not be downloaded"); }
}
/** The sound of a YouTube video (for speech-to-text when it has no captions), fetched by yt-dlp. */
export async function youtubeAudio(url: string, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<void> {
  await runYtDlp(["-f", "ba[abr<=96]/ba/b", "-o", target, url], { ...o, timeoutMs: 20 * 60_000 });
  try { await access(target); } catch { throw new LinkError("link_fetch_failed", "The sound of the video could not be fetched"); }
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
