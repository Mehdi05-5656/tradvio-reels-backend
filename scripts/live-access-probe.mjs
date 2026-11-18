// Live Clips, phase 1a: what a Render address can reach on Twitch and Kick (read-only, nothing stored, nothing
// published). Run once as a Render cron job on branch feat/live-clips, then read its log. Every line is JSON.
// Tests: Twitch anonymous chat (IRC), Twitch live playlist through yt-dlp (same door as the Clips YouTube path), a
// 20 s pull of that playlist with ffmpeg, Kick's official public API (no token: expect 401, which still proves
// reachability), Kick's web lookup (Cloudflare: expect 403 without a browser fingerprint), and a 20 s pull of a Kick
// playlist handed in through KICK_PLAYLIST (a public playback address fetched elsewhere; a JWT that expires on its own).
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, writeFile, access } from "node:fs/promises";
import { arch, platform } from "node:os";
// the same standalone yt-dlp build studio-youtube.ts fetches (no Python needed), kept in the temp folder
async function ensureYtDlp() {
  const dir = join(tmpdir(), "clone8-bin"), bin = join(dir, "yt-dlp");
  try { await access(bin); return bin; } catch { /* fetch it */ }
  const asset = platform() === "darwin" ? "yt-dlp_macos" : arch() === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`yt-dlp fetch ${r.status}`);
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(bin, Buffer.from(await r.arrayBuffer())); await chmod(bin, 0o755);
  return bin;
}

const out = (o) => console.log(JSON.stringify({ probe: true, ...o }));
const CHANNELS = (process.env.PROBE_TWITCH_CHANNELS || "caseoh_,zackrawrr,kaicenat,xqc,jynxzi,clix").split(",");
const run = (bin, args, ms = 60_000) => new Promise((resolve) => {
  const c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let so = "", se = ""; const t = setTimeout(() => c.kill("SIGKILL"), ms);
  c.stdout.on("data", (b) => { so += b; }); c.stderr.on("data", (b) => { se += b; });
  c.on("error", (e) => { clearTimeout(t); resolve({ code: -1, so, se: String(e) }); });
  c.on("close", (code) => { clearTimeout(t); resolve({ code, so, se }); });
});
const redact = (s) => String(s).replace(/(token|sig|nauth|nauthsig)=[^&\s]+/gi, "$1=***").slice(0, 400);

// 1. Twitch anonymous chat for 15 s
await new Promise((done) => {
  const counts = Object.fromEntries(CHANNELS.map((c) => [c, 0])); let joined = false, buf = "", err = null;
  const s = net.connect(6667, "irc.chat.twitch.tv");
  s.on("connect", () => { s.write("NICK justinfan31337\r\nCAP REQ :twitch.tv/tags\r\n"); for (const c of CHANNELS) s.write(`JOIN #${c}\r\n`); });
  s.on("error", (e) => { err = String(e); });
  s.on("data", (d) => { buf += d; const lines = buf.split("\r\n"); buf = lines.pop(); for (const l of lines) { if (l.startsWith("PING")) s.write("PONG :tmi.twitch.tv\r\n"); if (/ JOIN #/.test(l)) joined = true; const m = l.match(/ PRIVMSG #(\w+) :/); if (m && m[1] in counts) counts[m[1]]++; } });
  setTimeout(() => { out({ test: "twitch_irc", joined, seconds: 15, messages: counts, error: err }); s.destroy(); done(); }, 15_000);
});

// 2. Twitch live playlist through yt-dlp (no proxy), first channel that is live
let bin = null;
try { bin = await ensureYtDlp(); } catch (e) { out({ test: "yt_dlp", error: String(e).slice(0, 200) }); }
let playlist = null;
if (bin) for (const ch of CHANNELS) {
  const r = await run(bin, ["-q", "--no-warnings", "--no-cache-dir", "--socket-timeout", "20", "--force-ipv4", "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`, "-g", "-f", "480p/720p60/720p30/best", `https://www.twitch.tv/${ch}`], 60_000);
  const url = r.so.split("\n").find((l) => /^https?:\/\//.test(l)) || null;
  out({ test: "twitch_playlist", channel: ch, ok: !!url, host: url ? new URL(url).host : null, stderr: url ? null : redact(r.se) });
  if (url) { playlist = url; break; }
}
// 3. 20 s of that playlist with ffmpeg, copy only (how much came in, how fast)
async function pull(name, url) {
  if (!url) return out({ test: name, skipped: "no playlist" });
  const dir = await mkdtemp(join(tmpdir(), "probe-")); const file = join(dir, "pull.ts"); const t0 = Date.now();
  const r = await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-i", url, "-t", "20", "-c", "copy", "-f", "mpegts", file], 90_000);
  const bytes = await stat(file).then((s) => s.size).catch(() => 0);
  out({ test: name, code: r.code, bytes, seconds: Math.round((Date.now() - t0) / 100) / 10, kbps: bytes ? Math.round((bytes * 8) / 20 / 1000) : 0, stderr: r.code === 0 ? null : redact(r.se) });
  await rm(dir, { recursive: true, force: true });
}
await pull("twitch_pull_20s", playlist);

// 4. Kick official API without a token (401 = reachable), and the Cloudflare-fronted web lookup (403 expected)
const probeFetch = async (name, url, headers = {}) => {
  const t0 = Date.now();
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }); const body = await r.text().catch(() => ""); out({ test: name, status: r.status, ms: Date.now() - t0, server: r.headers.get("server"), cf: r.headers.get("cf-mitigated") || r.headers.get("cf-ray") ? "cloudflare" : null, body_head: body.replace(/\s+/g, " ").slice(0, 120) }); }
  catch (e) { out({ test: name, error: String(e).slice(0, 160) }); }
};
await probeFetch("kick_public_api", "https://api.kick.com/public/v1/categories?q=gta");
await probeFetch("kick_web_lookup", "https://kick.com/api/v2/channels/xqc", { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", Accept: "application/json" });
// 4b. the same Kick web lookup through curl (Node's own TLS is refused by Cloudflare even from a home address; curl's
// fingerprint passed from the Mac on Nov 18 2026)
let kickPlaylist = process.env.KICK_PLAYLIST || null;
{ const r = await run("curl", ["-sS", "-m", "20", "-w", "\n%{http_code}", "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36", "-H", "Accept: application/json", "https://kick.com/api/v2/channels/xqc"], 30_000);
  const lines = r.so.trim().split("\n"); const status = lines.pop(); const body = lines.join("\n");
  let live = null; try { const j = JSON.parse(body); live = !!j.livestream; if (j.playback_url) kickPlaylist = j.playback_url; } catch { /* not json */ }
  out({ test: "kick_web_lookup_curl", code: r.code, status, live, got_playlist: !!kickPlaylist, body_head: live == null ? body.replace(/\s+/g, " ").slice(0, 120) : null }); }
// 5. Kick IVS playlist handed in (the bytes come from Amazon IVS, not from kick.com)
await pull("kick_pull_20s", kickPlaylist);
out({ test: "done" });
