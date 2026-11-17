// Local proof: the edit plan a blueprint_versions job carries, written by the same code the server runs (buildPlan),
// from a transcript and a kept read (hooks.json + focus.json from scripts/blueprints-read-proof.ts).
// npx esbuild scripts/blueprints-plan.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/bp-plan.mjs
// node .test-build/bp-plan.mjs <words.json> <read-dir> <duration> <hook ids, comma> <looks, comma> <keywords, comma> <out plan.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../src/studio-blueprints-routes.js";
import type { LookId } from "../src/studio-blueprints.js";
import type { CapWord } from "../src/caption-engine.js";

const [wordsFile, readDir, dur, hookIds, looks, keywords, out] = process.argv.slice(2);
const keys = new Set(keywords.split(",").map((k) => k.toLowerCase()));
const raw = JSON.parse(readFileSync(wordsFile, "utf8"));
const words: CapWord[] = raw.flatMap((s: any) => s.words.map((w: any) => ({ text: w.w, start: w.s, end: w.e, key: keys.has(w.w.toLowerCase().replace(/[^a-z0-9']/g, "")) })));
const hooks = JSON.parse(readFileSync(join(readDir, "hooks.json"), "utf8")).filter((h: any) => hookIds.split(",").includes(h.id));
const focus = JSON.parse(readFileSync(join(readDir, "focus.json"), "utf8"));
const plan = buildPlan("33333333-3333-4333-8333-333333333333", Number(dur), words, focus, hooks, looks.split(",") as LookId[]);
writeFileSync(out, JSON.stringify(plan));
console.log(`${plan.versions.length} versions, ${Math.round(JSON.stringify(plan).length / 1024)} KB`);
