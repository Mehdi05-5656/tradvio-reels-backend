// Marker study: for every moment the verifier scored on a saved chat, each chat marker at the moment as a percent
// change against its own previous-ten-minutes baseline, then how well each marker tracks the score (Spearman) and
// the mean for good (score >= 60) against the rest. Usage: node .exp-build/live-marker-study.mjs <bench folder>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatSignals } from "../src/studio-live-clips.js";
const dir = process.argv[2]; const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8"));
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const rank = (a: number[]) => { const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
const spearman = (a: number[], b: number[]) => { const ra = rank(a), rb = rank(b); const n = a.length; const ma = (n + 1) / 2; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; } return num / Math.sqrt(da * db); };
const rows: Array<Record<string, number>> = [];
for (const name of Object.keys(labels)) {
  const L = labels[name]; const msgs = readFileSync(join(dir, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const s = chatSignals(msgs, L.seconds);
  // new chatters per bin: users whose first message in the previous 10 minutes is in this bin
  const by: Map<string, number[]> = new Map(); for (const m of msgs) { const b = Math.floor(m.t / 10); if (!by.has(m.u)) by.set(m.u, []); by.get(m.u)!.push(b); }
  const fresh = new Array(s.bins).fill(0); for (const [, bs] of by) { const u = [...new Set(bs)].sort((a, b) => a - b); let last = -1e9; for (const b of u) { if (b - last > 60) fresh[b]++; last = b; } }
  const base = (arr: number[], b: number) => med(arr.slice(Math.max(0, b - 60), b));
  const pct = (arr: number[], b: number) => { const m = base(arr, b); return m > 0 ? Math.round(100 * (arr[b] - m) / m) : arr[b] > 0 ? 999 : 0; };
  const avgChatters = med(s.distinct.filter((_, i) => i > 18)), avgRate = med(s.rate.filter((_, i) => i > 18));
  console.log(`${name}: baseline median per 10 s: ${avgRate} messages, ${avgChatters} chatters, reactors ${med(s.reactors.filter((_, i) => i > 18))}, alike ${med(s.alike.filter((_, i) => i > 18)).toFixed(2)}, len ${med(s.len.filter((_, i) => i > 18)).toFixed(1)}`);
  for (const [t, sc] of Object.entries(L.moments)) {
    const t0 = Number(t); let best = Math.floor(t0 / 10), bestRate = -1;
    for (let b = Math.max(0, Math.floor(t0 / 10) - 3); b <= Math.floor(t0 / 10) + 4 && b < s.bins; b++) if (s.rate[b] > bestRate) { bestRate = s.rate[b]; best = b; }
    const b = best;
    rows.push({ stream: name === "jynxzi" ? 0 : 1, t: t0, score: Number(sc),
      "rate +%": pct(s.rate, b), "chatters +%": pct(s.distinct, b), "reactors +%": pct(s.reactors, b), "new chatters +%": pct(fresh, b),
      "reactor share": Math.round(100 * s.reactors[b] / Math.max(1, s.distinct[b])), "reactor share +pts": Math.round(100 * (s.reactors[b] / Math.max(1, s.distinct[b]) - (base(s.reactors, b) / Math.max(1, base(s.distinct, b))))),
      "alike %": Math.round(100 * s.alike[b]), "alike +pts": Math.round(100 * (s.alike[b] - base(s.alike, b))), "len -%": -pct(s.len, b),
      "caps +%": pct(s.caps, b), "laugh +%": pct(s.laugh, b), "hype +%": pct(s.hype, b), "emote +%": pct(s.emote, b), "same +%": pct(s.same, b), "asks": s.asks[b] });
  }
}
const keys = Object.keys(rows[0]).filter((k) => !["stream", "t", "score"].includes(k));
const good = rows.filter((r) => r.score >= 60), rest = rows.filter((r) => r.score < 60);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`\n${rows.length} scored moments (${good.length} good at 60+). Marker: Spearman with score | median good | median rest`);
const out = keys.map((k) => ({ k, rho: spearman(rows.map((r) => r[k]), rows.map((r) => r.score)), g: med(good.map((r) => r[k])), r: med(rest.map((r) => r[k])) })).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
for (const o of out) console.log(`  ${o.k.padEnd(20)} rho ${o.rho.toFixed(2).padStart(6)} | good ${String(o.g).padStart(5)} | rest ${String(o.r).padStart(5)}`);
console.log(`\nper stream (jynxzi then kaicenat), good vs rest medians of rate +% / chatters +% / reactors +% / new chatters +%:`);
for (const st of [0, 1]) { const g = rows.filter((r) => r.stream === st && r.score >= 60), q = rows.filter((r) => r.stream === st && r.score < 60); console.log(`  stream ${st}: good ${med(g.map((r) => r["rate +%"]))}/${med(g.map((r) => r["chatters +%"]))}/${med(g.map((r) => r["reactors +%"]))}/${med(g.map((r) => r["new chatters +%"]))}  rest ${med(q.map((r) => r["rate +%"]))}/${med(q.map((r) => r["chatters +%"]))}/${med(q.map((r) => r["reactors +%"]))}/${med(q.map((r) => r["new chatters +%"]))}`); }
void mean;
