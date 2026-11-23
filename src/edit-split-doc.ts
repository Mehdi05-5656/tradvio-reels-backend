// Clone8 Studio: the rules of a Split screen edit file (editor thread, Nov 23 2026). Pure and import-free, so the
// editor's routes can check a save without loading the Split screen tool (edit-more.ts makes and renders the files).
import type { EditDoc } from "./studio-projects.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const SPLIT_STYLES = ["bold_pop", "pill", "one_word"];

// the same rules as the tool (splitscreen-layout.ts cleanLayout), without importing the tool's module at load time
export function cleanSplitLayout(raw: any): NonNullable<EditDoc["split"]>["layout"] {
  const n = (v: unknown, d: number, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const box = (b: any) => ({ zoom: r3(n(b?.zoom, 1, 1, 4)), cx: r3(n(b?.cx, 0.5, 0, 1)), cy: r3(n(b?.cy, 0.5, 0, 1)) });
  return { mode: raw?.mode === "full" ? "full" : "split", seam: r3(n(raw?.seam, 0.5, 0.3, 0.7)), swap: raw?.swap === true, clip: box(raw?.clip), game: box(raw?.game), captions: raw?.captions !== false };
}

/** What a person may change in a Split screen file: the framing, the gameplay (one in the library), the caption look. */
export function cleanSplit(ai: EditDoc, next: any, known: (id: string) => boolean): NonNullable<EditDoc["split"]> {
  const a = ai.split!;
  const loop = typeof next?.loop_id === "string" && known(next.loop_id) ? next.loop_id : a.loop_id;
  return { loop_id: loop, layout: next?.layout ? cleanSplitLayout(next.layout) : a.layout, caption_style: SPLIT_STYLES.includes(next?.caption_style) ? next.caption_style : a.caption_style, seed: a.seed };
}

