// Local proof: render one split-screen video from two local files (needs an ffmpeg with libass, e.g. ffmpeg-full).
// npx esbuild scripts/splitscreen-proof.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/split-proof.mjs
// node .test-build/split-proof.mjs <clip.mp4> <gameplay.mp4> <out.mp4> [seam] [swap]
// The subject and the words are stand-ins until the vision read and the transcript are wired in.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { autoClipBox, autoSeam, cleanLayout, gameWindow, halves, splitArgs, SPLIT_OUT } from "../src/studio-splitscreen.js";
import { captionAss, assFilter, cleanSettings } from "../src/studio-caption-video.js";
const [clip, game, out, seamArg, swapArg] = process.argv.slice(2);
const probe = (f: string) => { const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).toString().trim().split(",").map(Number); const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()); return { w, h, d }; };
const c = probe(clip), g = probe(game);
const subject = { kind: "face" as const, x: 0.5, y: 0.38, h: 0.18 }; // stand-in for the vision read
const seam = seamArg ? Number(seamArg) : autoSeam(c, subject);
const slot = halves({ mode: "split", seam, swap: swapArg === "swap" }).clip!;
const layout = cleanLayout({ seam, swap: swapArg === "swap", clip: autoClipBox(c, slot, subject) });
const h = halves(layout);
const words = "THIS IS WHERE YOUR OWN WORDS LAND RIGHT ON THE SEAM EVERY TIME".split(" ").map((t, i) => ({ text: t, start: 0.4 + i * 0.6, end: 0.95 + i * 0.6 }));
const s = cleanSettings({ style: "bold_pop" });
s.style = { ...s.style, y: h.seamY };
const ass = out.replace(/\.mp4$/, ".ass");
writeFileSync(ass, captionAss(words, s, SPLIT_OUT));
const win = gameWindow(g.d, c.d, out);
const args = splitArgs({ clip: { file: clip, size: c, seconds: c.d, hasAudio: true }, game: { file: game, size: g, ...win }, layout, ass, assFilter: assFilter(ass, { STUDIO_CAPTION_FONTS: process.cwd() + "/assets/caption-fonts" }), target: out });
const t0 = Date.now(); execFileSync("ffmpeg", args, { stdio: "inherit" });
console.log(JSON.stringify({ out, seam, layout, win, seconds: c.d, render_s: (Date.now() - t0) / 1000 }));
