// A local CONNECT proxy that counts the bytes it carries, for scripts/clips-lean-ab.mts: what a run pulls through the
// paid proxy. An optional cap (MB/s, per connection) mimics the paid proxy's speed on Render. With UPSTREAM_PROXY in the
// environment (http:// or https://, with a login), every tunnel goes on through that proxy (the real one), so the
// bytes counted are the bytes it bills. The address is never printed.
//   node scripts/clips-count-proxy.mjs <port> <stats.json> [MB/s per connection]
import http from "node:http"; import net from "node:net"; import tls from "node:tls"; import fs from "node:fs";
const port = Number(process.argv[2] || 18080), out = process.argv[3], cap = Number(process.argv[4] || 0) * 1e6;
const up = process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null;
let down = 0, sent = 0, conns = 0, refused = 0;
/** A socket to `target` (host:port): directly, or through the upstream proxy's own CONNECT. */
function open(target, done) {
  if (!up) { const [h, p] = target.split(":"); const s = net.connect(Number(p) || 443, h, () => done(null, s)); s.on("error", (e) => done(e)); return; }
  const pport = Number(up.port) || (up.protocol === "https:" ? 443 : 80);
  const s = up.protocol === "https:" ? tls.connect({ host: up.hostname, port: pport, servername: up.hostname }) : net.connect(pport, up.hostname);
  const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString("base64")}\r\n` : "";
  s.once(up.protocol === "https:" ? "secureConnect" : "connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
  let head = Buffer.alloc(0);
  const onData = (b) => {
    head = Buffer.concat([head, b]); const end = head.indexOf("\r\n\r\n"); if (end < 0) return;
    s.off("data", onData);
    const status = Number(head.toString("latin1").split(" ")[1]);
    if (status !== 200) { refused++; s.destroy(); return done(new Error(`upstream ${status}`)); }
    const rest = head.subarray(end + 4); down += head.length;
    done(null, s); if (rest.length) s.emit("data", rest);
  };
  s.on("data", onData); s.on("error", (e) => done(e));
}
const srv = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
srv.on("connect", (req, cs, head) => {
  conns++;
  let answered = false;
  open(req.url, (err, ss) => {
    if (answered) return; answered = true;
    if (err) { cs.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    cs.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head?.length) ss.write(head);
    ss.on("data", (b) => { down += b.length; }); cs.on("data", (b) => { sent += b.length; });
    cs.pipe(ss);
    if (!cap) ss.pipe(cs);
    else {
      // capped: hand the server's bytes on no faster than `cap` per second on this connection
      let budget = cap / 10;
      const tick = setInterval(() => { budget = cap / 10; ss.resume(); }, 100);
      ss.on("data", (b) => { cs.write(b); budget -= b.length; if (budget <= 0) ss.pause(); });
      ss.on("end", () => { clearInterval(tick); cs.end(); }); ss.on("close", () => clearInterval(tick));
    }
    ss.on("error", () => cs.destroy()); cs.on("error", () => ss.destroy());
  });
});
setInterval(() => fs.writeFileSync(out, JSON.stringify({ down, up: sent, conns, refused })), 300);
srv.listen(port, "127.0.0.1");
