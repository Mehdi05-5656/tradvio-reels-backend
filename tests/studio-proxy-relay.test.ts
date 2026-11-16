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
