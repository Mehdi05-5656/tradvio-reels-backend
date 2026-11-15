// Compares the clips scripts/clips-lean-ab.mts made in each arm, clip by clip (same rank = same moment):
//   - length and size; SSIM and PSNR of every frame against the whole-video clip (1.0 = identical);
//   - the sound's offset against the whole-video clip (cross-correlation, in ms: 0 = in sync);
//   - sharpness (ffmpeg blurdetect: lower is sharper);
//   - a still from each arm side by side, for looking.
//   node scripts/clips-lean-compare.mjs <out dir> <video id>
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, vid] = process.argv.slice(2);
const R = JSON.parse(readFileSync(join(dir, `${vid}-results.json`), "utf8"));
const arms = Object.fromEntries(R.results.map((r) => [r.arm, r]));
const base = arms.whole;
const ff = (args) => spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 26 }).stderr;
const ssim = (a, b) => { const e = ff(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "-"]); return { ssim: Number((e.match(/SSIM .*All:([0-9.]+)/) ?? [])[1]), psnr: Number((e.match(/PSNR .*average:([0-9.inf]+)/) ?? [])[1]) }; };
const blur = (a) => Number((ff(["-i", a, "-vf", "blurdetect=block_width=32:block_height=32", "-f", "null", "-"]).match(/blur mean: ([0-9.]+)/) ?? [])[1]);
const pcm = (a) => { const b = execFileSync("ffmpeg", ["-v", "error", "-i", a, "-t", "12", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 26 }); return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)); };
function lagMs(a, b) {
  const x = pcm(a), y = pcm(b), n = Math.min(x.length, y.length) - 1000; let best = 0, at = 0;
  for (let lag = -480; lag <= 480; lag++) { let s = 0; for (let i = 600; i < n; i += 2) { const j = i + lag; if (j >= 0 && j < y.length) s += x[i] * y[j]; } if (s > best) { best = s; at = lag; } }
  return Math.round((at / 8000) * 1000);
}
const dur = (a) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a]).toString());
const rows = [];
for (const c of base.made.sort((p, q) => p.rank - q.rank)) {
  const row = { rank: c.rank, at: `${Math.floor(c.start / 60)}:${String(Math.round(c.start % 60)).padStart(2, "0")}`, s_whole: Math.round(dur(c.file) * 100) / 100, blur_whole: Math.round(blur(c.file) * 100) / 100 };
  for (const arm of Object.keys(arms).filter((a) => a !== "whole")) {
    const d = arms[arm].made.find((x) => x.rank === c.rank); if (!d) { row[arm] = "missing"; continue; }
    const q = ssim(c.file, d.file);
    row[`s_${arm}`] = Math.round(dur(d.file) * 100) / 100; row[`ssim_${arm}`] = Math.round(q.ssim * 10000) / 10000; row[`psnr_${arm}`] = Math.round(q.psnr * 10) / 10;
    row[`audio_ms_${arm}`] = lagMs(c.file, d.file); row[`blur_${arm}`] = Math.round(blur(d.file) * 100) / 100;
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
// stills: the first three clips, a third of the way in, every arm side by side
for (const c of base.made.filter((x) => x.rank <= 3)) {
  const files = ["whole", ...Object.keys(arms).filter((a) => a !== "whole")].map((a) => arms[a].made.find((x) => x.rank === c.rank)?.file).filter(Boolean);
  const t = Math.min(10, c.seconds / 3).toFixed(2);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...files.flatMap((f) => ["-ss", t, "-i", f]), "-filter_complex", `${files.map((_, k) => `[${k}:v]`).join("")}hstack=inputs=${files.length}`, "-frames:v", "1", join(dir, `${vid}-still-${c.rank}.png`)]);
}
writeFileSync(join(dir, `${vid}-compare.json`), JSON.stringify(rows, null, 1));
