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
