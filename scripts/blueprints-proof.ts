// Local proof for Blueprints v2: write one EDL per hook x look from a transcript, for the worker to render.
// npx esbuild scripts/blueprints-proof.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/bp-proof.mjs
// node .test-build/bp-proof.mjs <words.json> <duration> <plan.json> <out-dir>
//   words.json: faster-whisper segments [{words:[{w,s,e}]}] or a flat [{text,start,end}]
//   plan.json:  { hooks: Hook[], looks: LookId[], keywords: string[], focus?: {cx,cy}, game?: {key,start} }
// Hooks are written by hand here; in the product the read step (Claude on the words) writes them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookById, planVersion, type Hook } from "../src/studio-blueprints.js";
import type { CapWord } from "../src/caption-engine.js";

const [wordsFile, durArg, planFile, outDir] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(wordsFile, "utf8"));
const flat: Array<{ text: string; start: number; end: number }> = Array.isArray(raw) && raw[0]?.words
  ? raw.flatMap((s: any) => s.words.map((w: any) => ({ text: w.w, start: w.s, end: w.e })))
  : raw;
const plan = JSON.parse(readFileSync(planFile, "utf8")) as { hooks: Hook[]; looks: string[]; keywords: string[]; focus?: { cx: number; cy: number }; game?: { key: string; start: number } };
const keys = new Set(plan.keywords.map((k) => k.toLowerCase()));
const words: CapWord[] = flat.map((w) => ({ text: w.text, start: w.start, end: w.end, key: keys.has(w.text.toLowerCase().replace(/[^a-z0-9']/g, "")) }));
mkdirSync(outDir, { recursive: true });
const made: string[] = [];
for (const hook of plan.hooks) for (const id of plan.looks) {
  const look = lookById(id);
  if (!look) throw new Error(`unknown look ${id}`);
  const edl = planVersion({ words, duration: Number(durArg), hook, look, focus: plan.focus, game: plan.game });
  writeFileSync(join(outDir, `${edl.version}.json`), JSON.stringify(edl, null, 1));
  made.push(`${edl.version} ${edl.duration.toFixed(2)}s segs=${edl.segments.length} sfx=${edl.sfx.length}`);
}
console.log(made.join("\n"));
