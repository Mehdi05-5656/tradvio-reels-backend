import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { closeRelay, ffmpegProxy, RELAY_HOSTS, relayStats, tunnel } from "../src/studio-proxy-relay.js";
import { leanEnv, leanFor } from "../src/studio-clips.js";

const connect = (proxy: string, target: string) => new Promise<string>((resolve, reject) => {
  const u = new URL(proxy);
  const s = net.connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let got = ""; s.on("data", (b) => { got += b.toString(); if (got.includes("\r\n\r\n")) { s.destroy(); resolve(got.split("\r\n")[0]); } });
  s.on("error", reject); s.on("end", () => resolve(got.split("\r\n")[0]));
});

test("ffmpeg gets an http:// proxy: the upstream itself when it is http://, a loopback relay for an https:// one, nothing without one", async (t) => {
  t.after(() => closeRelay());
  assert.equal(await ffmpegProxy(null), null);
  assert.equal(await ffmpegProxy("http://u:p@proxy.example:8080"), "http://u:p@proxy.example:8080");
  const relay = await ffmpegProxy("https://u:p@127.0.0.1:9", () => {});
  assert.match(relay!, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback only");
  assert.equal(await ffmpegProxy("https://u:p@127.0.0.1:9"), relay, "started once");
  // only YouTube's hosts on 443: anything else is refused before the real proxy is ever asked
  assert.equal(await connect(relay!, "example.com:443"), "HTTP/1.1 403 Forbidden");
  assert.equal(await connect(relay!, "www.youtube.com:80"), "HTTP/1.1 403 Forbidden");
  assert.equal(await connect(relay!, "169.254.169.254:443"), "HTTP/1.1 403 Forbidden");
  // a YouTube host goes on to the upstream (unreachable here: a clean 502, never a hang)
  assert.equal(await connect(relay!, "rr2---sn-x.googlevideo.com:443"), "HTTP/1.1 502 Bad Gateway");
  const st = relayStats();
  assert.ok(st.refused >= 3 && st.failed >= 1);
  for (const h of ["rr2---sn-gjo-w43z.googlevideo.com", "www.youtube.com", "i.ytimg.com"]) assert.ok(RELAY_HOSTS.test(h), h);
  for (const h of ["evil-googlevideo.com", "googlevideo.com.evil.net", "example.com"]) assert.ok(!RELAY_HOSTS.test(h), h);
});

test("tunnel: CONNECT through the upstream with its login, the bytes after the 200 kept", async (t) => {
  // a stand-in upstream proxy (http) and a target that answers "hello"
  const target = net.createServer((s) => s.end("hello")); await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  let auth = "";
  const upstream = http.createServer(); upstream.on("connect", (req, sock) => {
    auth = String(req.headers["proxy-authorization"] ?? "");
    const [h, p] = String(req.url).split(":");
    const out = net.connect(Number(p), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); out.pipe(sock); sock.pipe(out); });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => { target.close(); upstream.close(); });
  const up = new URL(`http://user%40x:p%3Ass@127.0.0.1:${(upstream.address() as net.AddressInfo).port}`);
  const s = await tunnel(up, `127.0.0.1:${(target.address() as net.AddressInfo).port}`);
  const got = await new Promise<string>((r) => { let x = ""; s.on("data", (b) => (x += b)); s.on("end", () => r(x)); });
  assert.equal(got, "hello");
  assert.equal(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString(), "user@x:p:ss", "the login, decoded once");
});

test("STUDIO_CLIPS_LEAN: on, off, or only the accounts listed", () => {
  const a = "166ee4e7-0de9-4038-b740-f6b3b609848c", b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(leanFor({ STUDIO_CLIPS_LEAN: "on" }, b), true);
  assert.equal(leanFor({ STUDIO_CLIPS_LEAN: "off" }, a), false);
  assert.equal(leanFor({}, a), false);
  assert.equal(leanFor({ STUDIO_CLIPS_LEAN: `${a}` }, a), true);
  assert.equal(leanFor({ STUDIO_CLIPS_LEAN: `${a}, other` }, b), false, "an account not listed keeps the whole download");
  assert.equal(leanFor({ STUDIO_CLIPS_LEAN: `${a}` }, null), false);
  assert.equal(leanEnv({ STUDIO_CLIPS_LEAN: a, X: "1" }, a).STUDIO_CLIPS_LEAN, "on");
  assert.equal(leanEnv({ STUDIO_CLIPS_LEAN: a, X: "1" }, b).STUDIO_CLIPS_LEAN, "off");
  assert.equal(leanEnv({ STUDIO_CLIPS_LEAN: a, X: "1" }, b).X, "1", "the rest of the environment untouched");
});

test("freshProxySession: a new sticky session id, everything else kept; a login without one is left alone", async () => {
  const { freshProxySession } = await import("../src/studio-proxy-relay.js");
  const ip = "https://user1:pw_country-us_session-abcd1234_lifetime-30m@geo.example.com:12321";
  const a = freshProxySession(ip)!, b = freshProxySession(ip)!;
  const pass = (x: string) => decodeURIComponent(new URL(x).password);
  assert.match(pass(a), /^pw_country-us_session-[a-z0-9]{8}_lifetime-30m$/);
  assert.notEqual(pass(a), "pw_country-us_session-abcd1234_lifetime-30m"); assert.notEqual(a, b, "a different one each time");
  assert.equal(new URL(a).username, "user1"); assert.equal(new URL(a).host, "geo.example.com:12321"); assert.equal(new URL(a).protocol, "https:");
  // the id in the username (Bright Data style)
  const bd = freshProxySession("http://brd-customer-x-zone-res-session-r4nd0m:secret@brd.example.com:22225")!;
  assert.match(decodeURIComponent(new URL(bd).username), /^brd-customer-x-zone-res-session-[a-z0-9]{8}$/); assert.equal(new URL(bd).password, "secret");
  // nothing to rotate: unchanged; nothing at all: null
  assert.equal(freshProxySession("https://u:plain@p.example.com:1"), "https://u:plain@p.example.com:1");
  assert.equal(freshProxySession(null), null); assert.equal(freshProxySession(""), null);
});

test("the server keeps a fresh session once it has worked; a different proxy setting ignores it", async () => {
  const { youtubeProxy, pinYoutubeProxy, resetYoutubeProxy } = await import("../src/studio-youtube.js");
  resetYoutubeProxy();
  const env = { STUDIO_YT_PROXY: "https://u:pw_session-aaaaaaaa_lifetime-30m@geo.example.com:12321" };
  assert.deepEqual(youtubeProxy(env), { proxy: env.STUDIO_YT_PROXY, fresh: false }, "as set until something fails");
  const f = youtubeProxy(env, true);
  assert.equal(f.fresh, true); assert.notEqual(f.proxy, env.STUDIO_YT_PROXY);
  pinYoutubeProxy(env, f.proxy);
  assert.equal(youtubeProxy(env).proxy, f.proxy, "the fresh one that worked is used from then on");
  assert.equal(youtubeProxy({ STUDIO_YT_PROXY: "https://u:other_session-bbbbbbbb@x.example.com:1" }).proxy, "https://u:other_session-bbbbbbbb@x.example.com:1", "a changed setting wins over the pin");
  assert.deepEqual(youtubeProxy({}), { proxy: null, fresh: false });
  resetYoutubeProxy();
});

test("one relay per proxy session: a fresh session gets its own, the first keeps serving", async (t) => {
  t.after(() => closeRelay());
  const a = await ffmpegProxy("https://u:pw_session-aaaaaaaa@127.0.0.1:9", () => {});
  const b = await ffmpegProxy("https://u:pw_session-bbbbbbbb@127.0.0.1:9", () => {});
  assert.notEqual(a, b);
  assert.equal(await ffmpegProxy("https://u:pw_session-aaaaaaaa@127.0.0.1:9"), a, "the same session, the same relay");
  for (const r of [a!, b!]) assert.equal(await connect(r, "example.com:443"), "HTTP/1.1 403 Forbidden", "both still answer");
  assert.equal(relayStats().relays, 2);
});

test("a stretch's ceiling: 3 minutes, more for long stretches", async () => {
  const { stretchTimeoutMs } = await import("../src/studio-youtube.js");
  assert.equal(stretchTimeoutMs(42), 180_000);
  assert.equal(stretchTimeoutMs(182), 728_000, "a 3-minute clip gets 4 s a second");
});

test("a yt-dlp past its ceiling is killed with the ffmpeg it started; the call ends within seconds, not when ffmpeg finishes", { skip: process.platform === "win32" }, async () => {
  const { writeFile, chmod, mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { youtubeSound } = await import("../src/studio-youtube.js");
  const dir = await mkdtemp(join(tmpdir(), "ytkill-"));
  // a stand-in yt-dlp: starts a long "ffmpeg" (a child that keeps the pipes open, as ffmpeg does), writes its pid, waits
  const fake = join(dir, "yt-dlp"), pidFile = join(dir, "child.pid");
  await writeFile(fake, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n`); await chmod(fake, 0o755);
  const began = Date.now();
  // (the sound's ceiling is 20 minutes; an abort after 1 s takes the same kill path)
  const ac = new AbortController(); setTimeout(() => ac.abort(), 1000);
  await assert.rejects(youtubeSound("https://www.youtube.com/watch?v=x", join(dir, "s"), { env: { YT_DLP_PATH: fake }, signal: ac.signal }), /stopped/);
  assert.ok(Date.now() - began < 8000, `ended in ${Date.now() - began} ms`);
  const pid = Number(await readFile(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), "the child it started is gone too");
});
