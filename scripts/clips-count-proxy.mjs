// A local CONNECT proxy that counts the bytes it carries, for scripts/clips-lean-ab.mts: what a run would pull through
// the paid proxy. An optional cap (MB/s, per connection) mimics the paid proxy's speed on Render.
//   node scripts/clips-count-proxy.mjs <port> <stats.json> [MB/s per connection]
import http from "node:http"; import net from "node:net"; import fs from "node:fs";
const port = Number(process.argv[2] || 18080), out = process.argv[3], cap = Number(process.argv[4] || 0) * 1e6;
let down = 0, up = 0, conns = 0;
const srv = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
srv.on("connect", (req, cs, head) => {
  conns++; const [h, p] = req.url.split(":");
  const ss = net.connect(Number(p) || 443, h, () => {
    cs.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head?.length) ss.write(head);
    cs.pipe(ss);
    if (!cap) { ss.pipe(cs); return; }
    // capped: hand the server's bytes on no faster than `cap` per second on this connection
    let budget = cap / 10;
    const tick = setInterval(() => { budget = cap / 10; ss.resume(); }, 100);
    ss.on("data", (b) => { cs.write(b); budget -= b.length; if (budget <= 0) ss.pause(); });
    ss.on("end", () => { clearInterval(tick); cs.end(); }); ss.on("close", () => clearInterval(tick));
  });
  ss.on("data", (b) => { down += b.length; }); cs.on("data", (b) => { up += b.length; });
  ss.on("error", () => cs.destroy()); cs.on("error", () => ss.destroy());
});
setInterval(() => fs.writeFileSync(out, JSON.stringify({ down, up, conns })), 300);
srv.listen(port, "127.0.0.1");
