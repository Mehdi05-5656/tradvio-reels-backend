// Local proof of Blueprints v3 phase 1 (docs/blueprints/PLAN_V3.md): the look read on six stills, the suggested
// purpose, then the openings written for each purpose asked, with their angles. The server's own functions, real
// calls. Needs ANTHROPIC_API_KEY in the environment (never printed). Paid: about $0.01-0.02 a purpose a video.
// npx esbuild scripts/blueprints-purpose-proof.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/bp-purpose.mjs
// node .test-build/bp-purpose.mjs <video> <words.json (faster-whisper segments)> <role|-> <purposes comma> <out.json>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHooks } from "../src/studio-blueprints-read.js";
import { defaultLooks, readLook, suggestPurpose, type Purpose } from "../src/studio-blueprints-purpose.js";
import { lineOf } from "../src/studio-blueprints-routes.js";
import type { CapWord } from "../src/caption-engine.js";

const [video, wordsFile, role, purposesArg, out] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(wordsFile, "utf8"));
const words: CapWord[] = raw.flatMap((s: any) => s.words.map((w: any) => ({ text: w.w, start: w.s, end: w.e, key: false })));
const costs: string[] = [];
const deps = { env: process.env, log: (l: string) => { if (l.includes("[cost]")) costs.push(l); } };

const dir = mkdtempSync(join(tmpdir(), "bp-purpose-"));
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString());
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `fps=6/${dur},scale=360:-2`, "-frames:v", "6", "-q:v", "5", join(dir, "%02d.jpg")]);
const frames = readdirSync(dir).sort().map((f, i) => ({ t: (i + 0.5) * dur / 6, jpg: readFileSync(join(dir, f)) }));

const look = await readLook(deps, frames);
const suggested = suggestPurpose({ probe: {}, role: role === "-" ? null : role, look });
const sets: Record<string, any> = {};
for (const p of purposesArg.split(",") as Purpose[]) {
  const t0 = Date.now();
  const hooks = await writeHooks(deps, words, { n: 5, purpose: p });
  sets[p] = { ms: Date.now() - t0, looks: defaultLooks(p, look), hooks: hooks.map((h) => ({ angle: h.angle, title: h.title, at: `${h.start}-${h.end}`, line: lineOf(words, h.start ?? 0, h.end ?? 0) })) };
}
const doc = { video: video.split("/").pop(), seconds: Math.round(dur * 10) / 10, role, look, suggested, sets, costs };
writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(JSON.stringify({ video: doc.video, format: look?.format, captions: look?.captions, suggested, sets: Object.fromEntries(Object.entries(sets).map(([k, v]: any) => [k, v.hooks.map((h: any) => `${h.angle}: ${h.title}`)])) }, null, 1));
