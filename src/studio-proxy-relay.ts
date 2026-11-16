// A local relay in front of the YouTube proxy, for ffmpeg (Nov 15 2026).
//
// ffmpeg uses a proxy only when its address starts with "http://" (libavformat/http.c: `av_strstart(proxy_path,
// "http://", NULL)`, in 5.1 on Render and in today's ffmpeg alike). Ours is an https:// proxy, so every ffmpeg read
// that yt-dlp starts (its --download-sections stretches) went straight to YouTube from Render's own address and was
// refused with 403: on Oct 31 2026 and again on the first live lean Clips run, Nov 15 2026. yt-dlp's own downloader
// (whole videos, the sound) speaks https proxies and was never affected.
//
// The relay listens on 127.0.0.1 only and answers CONNECT for YouTube's hosts on port 443, each tunnel going on through
// the real proxy (TLS to it for https://, with its login). ffmpeg sees a plain http:// proxy; YouTube sees the proxy's
// address, as for every other request. The tunnels carry TLS end to end (ffmpeg <-> YouTube): the relay never sees
// the content. This is the exact path the real-proxy tests used (scripts/clips-count-proxy.mjs), 4 runs of 4.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/** YouTube's hosts only: the relay is never a general proxy, even on the loopback. */
export const RELAY_HOSTS = /(^|\.)(googlevideo\.com|youtube\.com|youtu\.be|ytimg\.com|ggpht\.com|google\.com|googleapis\.com|gstatic\.com|youtube-nocookie\.com)$/i;

/** Opens a tunnel to host:port through the upstream proxy; resolves with the socket once the proxy says 200. */
export function tunnel(up: URL, target: string, timeoutMs = 30_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const port = Number(up.port) || (up.protocol === "https:" ? 443 : 80);
    const s: net.Socket = up.protocol === "https:" ? tls.connect({ host: up.hostname, port, servername: up.hostname }) : net.connect(port, up.hostname);
    const timer = setTimeout(() => { s.destroy(); reject(new Error("proxy connect timed out")); }, timeoutMs);
    const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString("base64")}\r\n` : "";
    s.once(up.protocol === "https:" ? "secureConnect" : "connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
    let head = Buffer.alloc(0);
    const onData = (b: Buffer) => {
      head = Buffer.concat([head, b]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 16_384) { s.destroy(); clearTimeout(timer); reject(new Error("bad proxy answer")); } return; }
      s.off("data", onData); clearTimeout(timer);
      const status = Number(head.toString("latin1").split(" ")[1]);
      if (status !== 200) { s.destroy(); return reject(new Error(`proxy answered ${status}`)); }
      const rest = head.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
    s.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** A different sticky session of the same proxy login: the session id in the username or password (IPRoyal
 *  `_session-XXXX`, Bright Data/Oxylabs style `-session-XXXX` / `sessid-XXXX`) swapped for a new random one, so the
 *  proxy hands out a different home connection. Unchanged when the address has no session id (a rotating login).
 *  Why (Nov 15 2026, first live lean run): the session Render was pinned to went bad mid-run (the proxy answered 504
 *  to every tunnel, then YouTube asked that address for a bot check, then a tunnel went silent); the same login with
 *  a fresh session worked at once. A retry that reuses the bad session fails the same way. */
export function freshProxySession(proxy: string | null | undefined): string | null {
  if (!proxy) return null;
  let u: URL; try { u = new URL(proxy); } catch { return proxy; }
  const re = /((?:^|[-_])(?:session|sessid)[-_])([A-Za-z0-9]+)/i;
  const swap = (part: string) => { const raw = decodeURIComponent(part); const m = raw.match(re); if (!m) return null;
    const id = Array.from({ length: Math.max(8, Math.min(16, m[2].length)) }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    return raw.replace(re, `$1${id}`); };
  const pw = swap(u.password), un = pw == null ? swap(u.username) : null;
  if (pw == null && un == null) return proxy;
  if (pw != null) u.password = encodeURIComponent(pw); else u.username = encodeURIComponent(un!);
  return u.toString().replace(/\/$/, "");
}

/** A tunnel that carries nothing either way for this long is closed (a peer that went silent; ffmpeg has its own
 *  30 s limit, this is the backstop for anything else that reads through the relay). */
export const TUNNEL_IDLE_MS = 90_000;
/** Relays kept listening at once: one per proxy session in use (each retry may ask for a fresh one). */
const MAX_RELAYS = 6;
const relays = new Map<string, { url: Promise<string>; server: http.Server }>();
const stats = { tunnels: 0, refused: 0, failed: 0, idle: 0, bytes_in: 0, hosts: new Set<string>() };
/** What the relays have carried since the server started (YouTube's bytes in, through the paid proxy). */
export const relayStats = () => ({ tunnels: stats.tunnels, refused: stats.refused, failed: stats.failed, idle: stats.idle, bytes_in: stats.bytes_in, hosts: [...stats.hosts], relays: relays.size });

/** The proxy address to hand ffmpeg: the upstream itself when it is already http://, else a local relay for that exact
 *  upstream (started once per upstream, on a free port on 127.0.0.1). Null without a proxy. */
export async function ffmpegProxy(upstream: string | null | undefined, log: (l: string) => void = (l) => console.log(l)): Promise<string | null> {
  if (!upstream) return null;
  const up = new URL(upstream);
  if (up.protocol === "http:") return upstream;
  if (up.protocol !== "https:") return upstream; // (socks5 and others: ffmpeg cannot use them either way; left as they were)
  const have = relays.get(upstream);
  if (have) return have.url;
  // the oldest relay stops taking new tunnels (the ones it carries go on to their end)
  while (relays.size >= MAX_RELAYS) { const [k, r] = relays.entries().next().value!; r.server.close(); relays.delete(k); }
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = String(req.url ?? "");
    const [host, portStr] = target.split(":");
    if (!host || portStr !== "443" || !RELAY_HOSTS.test(host)) { stats.refused++; client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    client.on("error", () => undefined);
    tunnel(up, target).then((remote) => {
      stats.tunnels++; stats.hosts.add(host.replace(/^[^.]+\.(?=googlevideo\.com$)/, "*."));
      let idle: ReturnType<typeof setTimeout> | null = null;
      const close = () => { if (idle) clearTimeout(idle); idle = null; remote.destroy(); client.destroy(); };
      const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { stats.idle++; log(`[relay] ${host}: nothing for ${TUNNEL_IDLE_MS / 1000} s, closed`); close(); }, TUNNEL_IDLE_MS); idle.unref?.(); };
      touch();
      remote.on("data", (b: Buffer) => { stats.bytes_in += b.length; touch(); });
      client.on("data", touch);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) remote.write(head);
      remote.on("error", close); client.on("error", close);
      remote.on("close", close); client.on("close", close);
      remote.pipe(client); client.pipe(remote);
    }, (e) => { stats.failed++; log(`[relay] ${host}: ${String(e?.message ?? e).slice(0, 120)}`); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  });
  server.on("clientError", (_e, sock) => sock.destroy());
  const url = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const a = server.address() as net.AddressInfo; resolve(`http://127.0.0.1:${a.port}`); });
  });
  server.unref(); // (never keeps the process alive on its own)
  relays.set(upstream, { url, server });
  url.catch(() => { relays.delete(upstream); });
  return url;
}
/** For tests. */
export function closeRelay() { for (const r of relays.values()) r.server.close(); relays.clear(); }
