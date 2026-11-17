// Local proof of the Blueprints v2 read step: Claude writes the hooks from the words, Split's face reader gives the
// framing track. Needs ANTHROPIC_API_KEY in the environment (never printed). Paid: about $0.05-0.10 a video.
// npx esbuild scripts/blueprints-read-proof.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/bp-read.mjs
// node .test-build/bp-read.mjs <video> <words.json (faster-whisper segments)> <n hooks> <out-dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { focusTrack, writeHooks } from "../src/studio-blueprints-read.js";
import { readSubjects } from "../src/studio-splitscreen.js";
import type { CapWord } from "../src/caption-engine.js";

const [video, wordsFile, nArg, outDir] = process.argv.slice(2);
mkdirSync(join(outDir, "stills"), { recursive: true });
const raw = JSON.parse(readFileSync(wordsFile, "utf8"));
const words: CapWord[] = raw.flatMap((s: any) => s.words.map((w: any) => ({ text: w.w, start: w.s, end: w.e })));
const logs: string[] = [];
const deps = { env: process.env, log: (l: string) => { logs.push(l); } };

// a still a second, 360 wide, as the Split reader gets them (at most 40)
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString());
const step = Math.max(1, dur / 40);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `fps=1/${step},scale=360:-2`, "-q:v", "5", join(outDir, "stills", "%03d.jpg")]);
const frames = readdirSync(join(outDir, "stills")).sort().map((f, i) => ({ t: Math.round((i * step + step / 2) * 100) / 100, jpg: readFileSync(join(outDir, "stills", f)) }));

const t0 = Date.now();
const [hooks, reads] = await Promise.all([
  writeHooks(deps, words, { n: Number(nArg) }),
  readSubjects(deps, frames),
]);
const ms = Date.now() - t0;
writeFileSync(join(outDir, "hooks.json"), JSON.stringify(hooks, null, 1));
writeFileSync(join(outDir, "reads.json"), JSON.stringify(reads, null, 1));
writeFileSync(join(outDir, "focus.json"), JSON.stringify(focusTrack(reads), null, 1));
writeFileSync(join(outDir, "cost-lines.txt"), logs.filter((l) => l.includes("[cost]")).join("\n") + "\n");
console.log(JSON.stringify({ ms, hooks: hooks.length, frames: frames.length, faces: reads.filter((r) => r.kind === "face").length }));
for (const h of hooks) console.log(`${h.id} ${h.start}-${h.end} ${h.title}`);
console.log(logs.filter((l) => l.includes("[cost]")).join("\n"));
