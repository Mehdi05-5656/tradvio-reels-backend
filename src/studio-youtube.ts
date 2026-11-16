// Clone8 Studio: YouTube videos and Shorts as sources. The metadata service has no file download for YouTube, so the
// file itself comes through yt-dlp: a standalone build fetched once onto the instance (no Python needed), kept in the
// temp directory, and run with a size and length cap. YouTube sometimes refuses cloud addresses ("confirm you're not a
// bot"); that becomes a plain failure the person can act on (upload the file), never a hang or a retry storm.
import { spawn } from "node:child_process";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegProxy, freshProxySession } from "./studio-proxy-relay.js";

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

/** Kills a yt-dlp started in its own process group, and everything it started (ffmpeg); the process alone if that fails. */
export function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }) {
  try { if (child.pid) { process.kill(-child.pid, "SIGKILL"); return; } } catch { /* already gone, or no group */ }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
}
/** yt-dlp runs in their own process groups, so they no longer end with the server: every one still running is killed
 *  when the server exits (a deploy, after the graceful stop has handed the jobs back). */
const liveGroups = new Set<{ pid?: number; kill: (s?: NodeJS.Signals) => boolean }>();
let exitHook = false;
function track(child: ReturnType<typeof spawn>) {
  liveGroups.add(child); child.once("close", () => liveGroups.delete(child));
  if (!exitHook) { exitHook = true; process.once("exit", () => { for (const c of liveGroups) killTree(c); }); }
  return child;
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
  const args = [...ytDlpArgs(url, target, { ...o, proxy: youtubeProxy(env).proxy, cookies: await cookiesFile(env) }), "--print", "after_move:title"];
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = track(spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, o.timeoutMs ?? 600_000);
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
  const proxy = youtubeProxy(env).proxy;
  const args = streamArgs(url, { proxy, cookies: await cookiesFile(env) });
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = track(spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, o.timeoutMs ?? 120_000);
    child.stdout.on("data", (b) => { stdout += b.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on("data", (b) => { stderr += b.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (killed) reject(new LinkError("link_fetch_failed", "YouTube took too long to answer")); else resolve({ code, stdout, stderr }); });
  });
  if (out.code !== 0) throw classifyYtDlpError(out.stderr || out.stdout);
  return parseStreams(out.stdout, proxy);
}

/** The proxy session this server uses for YouTube: STUDIO_YT_PROXY as set, until a call fails and its retry works on a
 *  fresh session (freshProxySession); from then on every call uses that one, so the rest of a run (and the next runs)
 *  do not each lose a try on the session that went bad. A restart goes back to the one set. */
let pinned: { base: string; proxy: string } | null = null;
export function youtubeProxy(env: Record<string, string | undefined>, fresh = false): { proxy: string | null; fresh: boolean } {
  const base = env.STUDIO_YT_PROXY || null;
  if (!base) return { proxy: null, fresh: false };
  if (fresh) return { proxy: freshProxySession(base), fresh: true };
  return { proxy: pinned && pinned.base === base ? pinned.proxy : base, fresh: false };
}
/** A fresh session worked: keep it. */
export function pinYoutubeProxy(env: Record<string, string | undefined>, proxy: string | null) {
  const base = env.STUDIO_YT_PROXY || null;
  if (!base || !proxy || proxy === base) return;
  if (!pinned || pinned.proxy !== proxy) console.log("[youtube] the proxy session was replaced (a fresh one worked after a failure)");
  pinned = { base, proxy };
}
/** For tests. */
export function resetYoutubeProxy() { pinned = null; }

/** yt-dlp run with our usual settings (proxy, cookies, Node for YouTube's challenges); its complaint becomes a LinkError. */
async function runYtDlp(args: string[], o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal; proxy?: string | null; fresh?: boolean }): Promise<string> {
  const bin = await ensureYtDlp(o);
  const env = o.env ?? process.env;
  const cookies = await cookiesFile(env);
  // a retry asks the proxy for a different home connection (freshProxySession): the one that failed may be bad
  const chosen = o.proxy !== undefined ? { proxy: o.proxy, fresh: false } : youtubeProxy(env, !!o.fresh);
  const proxy = chosen.proxy;
  const full = [
    // not --quiet: when ffmpeg fails inside yt-dlp, its own words are the only clue, and --quiet swallows them
    "--no-playlist", "--no-warnings", "--no-progress", "--force-ipv4", "--socket-timeout", "30", "--retries", "3",
    "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`,
    ...(proxy ? ["--proxy", proxy] : []),
    ...(cookies ? ["--cookies", cookies] : []),
    ...args,
  ];
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // its own process group, so a kill reaches the ffmpeg it starts too (killing yt-dlp alone left ffmpeg downloading
    // and holding the pipes: tries ran 4-20 minutes past their ceiling in the Nov 15 2026 stress test)
    const child = track(spawn(bin, full, { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    let stdout = "", stderr = "", killed = false, stopped = false, settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); o.signal?.removeEventListener("abort", stop); fn(); };
    const end = () => finish(() => stopped ? reject(new LinkError("link_stopped", "The download was stopped")) : reject(new LinkError("link_fetch_failed", "YouTube took too long to send the video")));
    // killed: settled when it closes, or 5 s later whatever is still holding on
    const kill = () => { killTree(child); setTimeout(end, 5_000).unref?.(); };
    const timer = setTimeout(() => { killed = true; kill(); }, o.timeoutMs ?? 8 * 60_000);
    // the run that asked for it is gone (its lease went to another attempt): stop paying for the download now
    const stop = () => { stopped = true; kill(); };
    if (o.signal?.aborted) stop(); else o.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => { stdout += b.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on("data", (b) => { stderr += b.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => { if (stopped || killed) end(); else finish(() => resolve({ code, stdout, stderr })); });
  });
  if (out.code !== 0) {
    const said = redactProxy(`${out.stderr}\n${out.stdout}`).split("\n").filter((l) => l.trim() && !/^\[(download|youtube|info|hlsnative)\]/.test(l)).slice(-12).join(" | ");
    console.log(`[youtube] yt-dlp failed: ${said.slice(-900)}`);
    throw classifyYtDlpError(out.stderr || out.stdout);
  }
  if (chosen.fresh) pinYoutubeProxy(env, chosen.proxy);
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
/** The sound track the whole download takes: a dubbed track when asked for, else small Opus (sorted to the original). */
export const soundFormat = (language?: string | null) => {
  const lang = language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ? language : null;
  return lang ? `ba[language^=${lang}][acodec=opus]/ba[language^=${lang}]/ba[acodec=opus][abr<=100]/ba` : "ba[acodec=opus][abr<=100]/ba";
};
export const downloadFormat = (h: number, language?: string | null) => {
  const audio = soundFormat(language);
  return `bv*[height<=${h}][fps<=30][vcodec!^=av01]+${audio}/bv*[height<=${h}][vcodec!^=av01]+${audio}/b[height<=${h}]/b`;
};
/** How yt-dlp ranks what matches: the original audio track first (lang = YouTube's own default track, never an
 *  auto-dub: a German dub was picked once), then the size wanted, then the smaller file. */
export const downloadSort = (h: number) => `lang,res:${h},fps:30,+size,+br`;
/** The whole video, downloaded by yt-dlp's own downloader (no ffmpeg reading YouTube: through the proxy on Render every
 *  ffmpeg read of a YouTube address got 403, Oct 31 2026); at most `maxHeight` lines (1080, or 720 for long videos). */
export async function youtubeDownload(url: string, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; maxHeight?: number; language?: string | null; signal?: AbortSignal; fresh?: boolean } = {}): Promise<void> {
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

/** A video's listing (title, channel, length, chapters, most-replayed heat) read by yt-dlp itself through our proxy,
 *  nothing downloaded: the stand-in when ScrapeCreators cannot answer (its credits ran out on Nov 16 2026 and every
 *  pasted link failed for 8 hours with "listing could not be read (402)"). One fresh-session retry. Only the fields
 *  Clips uses are printed (the full -J listing is hundreds of kB, past what runYtDlp keeps). */
export const INFO_FIELDS = "%(.{id,title,channel,uploader,description,duration,thumbnail,chapters,heatmap,live_status})j";
export async function youtubeInfo(url: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<Record<string, any>> {
  const once = (fresh: boolean) => runYtDlp(["--skip-download", "--ignore-no-formats-error", "--print", INFO_FIELDS, url], { ...o, fresh, timeoutMs: o.timeoutMs ?? 60_000 });
  let out: string;
  try { out = await once(false); } catch (e: any) {
    if (e instanceof LinkError && e.code === "link_no_media") throw e;
    out = await once(true);
  }
  const line = out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("{")).pop();
  try { if (line) return JSON.parse(line); } catch { /* below */ }
  throw new LinkError("link_fetch_failed", "YouTube's listing could not be read");
}

// ---------------------------------------------------------------------------------------------------
// Clips without the whole video (STUDIO_CLIPS_LEAN, Nov 15 2026): the sound alone to hear and choose the moments, then
// only the stretches that become clips. The proxy bills by the gigabyte and the whole video was ~78 % of a run's cost.
// ---------------------------------------------------------------------------------------------------
/** The sound of a YouTube video for Clips: heard for speech-to-text and laid under every clip. `target` has no
 *  extension; resolves with the file written (.webm or .m4a). */
export async function youtubeSound(url: string, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; language?: string | null; signal?: AbortSignal; fresh?: boolean } = {}): Promise<string> {
  await runYtDlp(["-f", soundFormat(o.language), "-S", "lang,+size,+br", "-o", `${target}.%(ext)s`, url], { ...o, timeoutMs: 20 * 60_000 });
  for (const ext of ["webm", "m4a", "opus", "mp4", "mp3"]) { try { await access(`${target}.${ext}`); return `${target}.${ext}`; } catch { /* next */ } }
  throw new LinkError("link_fetch_failed", "The sound of the video could not be fetched");
}
/** The picture track for stretches: the whole download's choice (at most `h` lines, 30 fps first, never AV1), or with
 *  `sharp` the most lines up to `h` at any frame rate (a 60 fps video's 1080 lines instead of its 720 at 30 fps; clips
 *  render at 30 either way). Only the stretches come down, so the bigger track costs little. */
export const stretchFormat = (h: number, sharp: boolean) => sharp
  ? `bv*[height<=${h}][vcodec!^=av01]`
  : `bv*[height<=${h}][fps<=30][vcodec!^=av01]/bv*[height<=${h}][vcodec!^=av01]`;
export const stretchSort = (h: number, sharp: boolean) => (sharp ? `res:${h},+size` : `res:${h},fps:30,+size`);
/** ffmpeg's limit on a read or write that gets nothing back (microseconds). Without it ffmpeg waits forever on a tunnel
 *  that went silent: the first live lean run sat 8 minutes on one stretch (Nov 15 2026). */
export const STRETCH_STALL_US = 30_000_000;
/** The most one stretch may take: 3 minutes, or 4 s per second of stretch for long clips (a 40 s stretch took 47-68 s
 *  through the real proxy, page read included, Nov 15 2026); then the next try, on a fresh session. */
export const STRETCH_TIMEOUT_MS = 3 * 60_000;
export const stretchTimeoutMs = (seconds: number) => Math.max(STRETCH_TIMEOUT_MS, Math.ceil(seconds) * 4_000);
/** One stretch of the picture (no sound), copied as YouTube sends it from the keyframe before `start`, with the video's
 *  own timestamps kept (-copyts): the file starts at that keyframe's time, which `t0` reports, so a cut seeks exactly.
 *  yt-dlp fetches it itself (only its download-stage addresses are accepted: the ones it prints without downloading
 *  were refused with 403, even locally, Nov 15 2026). */
export async function youtubeStretch(url: string, start: number, end: number, target: string, o: { fetch?: typeof fetch; env?: Record<string, string | undefined>; maxHeight?: number; sharp?: boolean; signal?: AbortSignal; fresh?: boolean; probe: (file: string) => Promise<number | null> }): Promise<{ file: string; t0: number }> {
  const h = o.maxHeight ?? 1080, sharp = !!o.sharp;
  // ffmpeg fetches the stretch and only uses an http:// proxy: an https:// one goes through the local relay
  // (studio-proxy-relay.ts), or YouTube sees our server's own address and refuses it (403 on Render, Nov 15 2026).
  // yt-dlp itself goes through the same relay, so the address YouTube signs its stream links for is the one ffmpeg uses.
  const env = o.env ?? process.env;
  const chosen = youtubeProxy(env, !!o.fresh);
  const proxy = await ffmpegProxy(chosen.proxy);
  // nothing left from an earlier try (a part file or another format's file) can be taken for this try's stretch
  const exts = ["webm", "mp4", "mkv"];
  await Promise.all(exts.flatMap((x) => [`${target}.${x}`, `${target}.${x}.part`]).map((f) => rm(f, { force: true })));
  const said = await runYtDlp(["-f", stretchFormat(h, sharp), "-S", stretchSort(h, sharp), "--downloader-args", `ffmpeg_i:-copyts -rw_timeout ${STRETCH_STALL_US}`,
    "--download-sections", `*${Math.max(0, start).toFixed(2)}-${end.toFixed(2)}`, "--print", "after_move:%(format_id)s %(protocol)s %(ext)s",
    "-o", `${target}.%(ext)s`, url], { ...o, proxy, timeoutMs: stretchTimeoutMs(end - Math.max(0, start)) });
  const format = said.trim().split("\n").pop()?.slice(0, 60) ?? "?";
  for (const ext of exts) {
    const file = `${target}.${ext}`;
    try { await access(file); } catch { continue; }
    const t0 = await o.probe(file);
    // (Nov 15 2026 on Render: two stretches came back starting at 2.72 s instead of ~521 and ~1081; the format is now
    //  in the message so the next one can be traced)
    if (t0 == null || !(t0 <= start + 0.05) || t0 < start - 30) throw new LinkError("link_fetch_failed", `the stretch does not start where it should (${t0} for ${start.toFixed(2)}; format ${format})`);
    if (chosen.fresh) pinYoutubeProxy(env, chosen.proxy);
    return { file, t0 };
  }
  throw new LinkError("link_fetch_failed", "The stretch of the video could not be fetched");
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
