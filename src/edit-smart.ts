// The editor's free smart tools (editor thread; docs/editor/RND.md §2): each one is worked out from what the clip
// already has (its words and their times), so it costs nothing but the render. Pure, so it is tested.

type Timed = { text: string; start: number; end: number };

/** The same swear words the captions mask (caption-engine.ts SWEARS; that file is shared byte for byte with the app,
 *  so the list is repeated here rather than exported from it). */
const SWEARS = /^(f+u+c+k\w*|s+h+i+t\w*|b+i+t+c+h\w*|a+s+s+h+o+l+e\w*|c+u+n+t\w*|d+i+c+k\w*|p+u+s+s+y\w*|m+o+t+h+e+r+f+u+c+k\w*|b+u+l+l+s+h+i+t\w*)$/i;
const bare = (t: string) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
export const isSwear = (t: string) => SWEARS.test(bare(String(t ?? "")));

/** Where the sound is bleeped: each swear word with a little either side (word times run a touch late and early), the
 *  overlapping ones joined, inside the clip. */
export function swearRanges(words: Timed[], len: number, pad = 0.06): Array<[number, number]> {
  const r = words.filter((w) => isSwear(w.text)).map((w) => [Math.max(0, w.start - pad), Math.min(len, w.end + pad)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of r) { const last = out[out.length - 1]; if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}

/** An ffmpeg `enable` expression true inside any of the ranges. */
export const during = (ranges: Array<[number, number]>) => ranges.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");

/** Dead air: the stretches of a clip that stay when every pause over `gap` seconds between words is cut down to a breath
 *  (the cutter's own trimPlan, studio-clips.ts). Null when nothing is worth cutting. */
export { trimPlan as pausePlan } from "./studio-clips.js";

/** Dead space: from ffmpeg cropdetect's last few "crop=w:h:x:y" lines over the recording, the box (as fractions) that
 *  holds the picture without black bars or borders; null when the picture already fills the frame (within 2 %). */
export function deadSpaceBox(log: string, src: { w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
  const crops = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => m.slice(1).map(Number) as [number, number, number, number]).filter(([w, h]) => w > 16 && h > 16);
  if (!crops.length || !(src.w > 0 && src.h > 0)) return null;
  // the widest crop seen (a dark scene makes cropdetect shrink for a moment; the real bars never move)
  const [w, h, x, y] = crops.reduce((best, c) => (c[0] * c[1] > best[0] * best[1] ? c : best));
  if (w / src.w > 0.98 && h / src.h > 0.98) return null;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(x / src.w), y: r(y / src.h), w: r(w / src.w), h: r(h / src.h) };
}
export const deadSpaceArgs = (file: string) => ["-v", "info", "-nostdin", "-threads", "2", "-i", file, "-t", "30", "-vf", "fps=2,cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-"];
