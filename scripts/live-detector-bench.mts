// Offline benchmark of the chat detector on saved chat replays with the verifier's scores as labels.
// Usage: node .exp-build/live-detector-bench.mjs <bench folder>   (jynxzi.jsonl, kaicenat.jsonl, labels.json)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatSignals, chatCandidates, LIVE_LIMITS } from "../src/studio-live-clips.js";
const dir = process.argv[2];
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8"));
for (const name of Object.keys(labels)) {
  const L = labels[name]; const msgs = readFileSync(join(dir, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const s = chatSignals(msgs, L.seconds);
  const wantN = Math.min(LIVE_LIMITS.verify_max, L.count * LIVE_LIMITS.verify_per_clip + LIVE_LIMITS.verify_extra);
  const variants: Array<[string, any]> = [["baseline-like", { w_reactors: 0, w_shape: 0, w_shock: 0, max_span_s: Infinity, spam_user_share: 1.01, chant_users: 0, tiers: [] }]];
  for (const span of [180, 120]) for (const tiers of [[1], [1, 2], [1, 3], [2], [2, 4]]) variants.push([`span${span} tiers${JSON.stringify(tiers)}`, { max_span_s: span, tiers }]);
  const good = Object.entries(L.moments).filter(([, v]) => Number(v) >= 60).map(([t]) => Number(t));
  console.log(`${name}: ${msgs.length} msgs, ${Math.round(s.perMinute)}/min, checking up to ${wantN}`);
  for (const [label, o] of variants) {
    const cands = chatCandidates(s, msgs, o); const want = Math.min(wantN, cands.length);
    const near = (t: number) => cands.findIndex((c) => Math.abs(c.t_event - t) <= 45);
    const ranks = good.map((t) => [t, near(t)] as const); const inTop = ranks.filter(([, r]) => r >= 0 && r < want).length;
    const found = ranks.filter(([, r]) => r >= 0); const meanRank = found.reduce((a, [, r]) => a + r + 1, 0) / Math.max(1, found.length);
    const maxSpan = Math.max(...cands.map((c) => c.last - c.onset));
    console.log(`  ${label.padEnd(30)} ${String(cands.length).padStart(3)} cands (longest ${maxSpan} s), good in checked ${inTop}/${good.length}, mean good rank ${meanRank.toFixed(1)}: ${ranks.map(([t, r]) => `${t}@${r < 0 ? "-" : r + 1}`).join(" ")}`);
  }
}
