// The long path's plan, with no I/O: which renderer a clip goes to, in which pieces, where the joins fall, and what it
// costs us. Shared by the quote (what a person is charged) and the runner (what is sent), so the two cannot disagree.
import { higgsfieldCostPerSecond, higgsfieldListPerSecond, seedanceEditCostPerSecond, seedanceListPerSecond } from "./studio-pricing.js";

/** What one Genjutsu request accepts: the full model trims sources to 30 s, Light 15 s; both want one continuous shot.
 *  Longer or multi-shot Light jobs go to the long path (Seedance video edit, pieces of up to PIECE_SECONDS). */
export const MAX_SECONDS = { full: 30, light: 15 } as const;

export const PIECE_SECONDS = 30;

export const MIN_SECONDS = 4;

/** The pieces a long clip is rendered in: at most PIECE_SECONDS each, ending on a camera change when one falls in the
 *  last stretch of a piece, never shorter than MIN_SECONDS (a short tail is folded into the piece before it). */
export function planPieces(window: number, cuts: number[], pieceMax = PIECE_SECONDS, min = MIN_SECONDS): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  const total = Math.round(window * 100) / 100;
  while (start < total - 0.05) {
    let end = Math.min(total, Math.round((start + pieceMax) * 100) / 100);
    if (end < total) {
      // prefer ending on a cut, as late as possible, as long as this piece and the remainder both stay renderable
      const candidates = cuts.filter((c) => c > start + min && c <= end && total - c >= min).sort((a, b) => b - a);
      if (candidates.length) end = Math.round(candidates[0] * 100) / 100;
      else if (total - end < min) end = Math.round((total - min) * 100) / 100;
    }
    out.push({ start, end });
    start = end;
  }
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < min) { const tail = out.pop()!; out[out.length - 1].end = tail.end; }
  return out;
}

/** A join inside one shot (not on a camera change) overlaps the next piece by this much and fades across it. */
export const JOIN_OVERLAP = 0.5;
/** How far a join inside a shot may move to find a calmer moment. */
const CALM_SEARCH = 2;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Joins that fall on a camera change stay hard cuts (the clip already cuts there). Every other join moves to the
 *  calmest moment within CALM_SEARCH seconds (the least picture change, so a small jump has least to show), and the
 *  piece after it starts JOIN_OVERLAP earlier so the two can be faded into each other. */
export function refineJoins<T extends { start: number; end: number }>(pieces: T[], cuts: number[], motion: Array<[number, number]>, max: number, overlap = JOIN_OVERLAP, search = CALM_SEARCH): Array<T & { blend: number }> {
  const out = pieces.map((p) => ({ ...p, blend: 0 }));
  const atCut = (t: number) => cuts.some((c) => Math.abs(c - t) <= 0.15);
  const calm = (t: number) => { const near = motion.filter(([x]) => Math.abs(x - t) <= 0.25); return near.length ? near.reduce((n, [, v]) => n + v, 0) / near.length : Infinity; };
  for (let i = 1; i < out.length; i++) {
    const b = out[i].start;
    if (atCut(b)) continue;
    const prevStart = out[i - 1].start, nextEnd = out[i].end;
    const fits = (t: number) => t - prevStart >= MIN_SECONDS && t - prevStart <= max && nextEnd - (t - overlap) <= max && nextEnd - t >= MIN_SECONDS && !atCut(t);
    let best = b, score = motion.length ? calm(b) : 0;
    if (motion.length) for (let t = b - search; t <= b + search + 1e-9; t += 0.1) { const c = r2(t); if (!fits(c)) continue; const sc = calm(c); if (sc < score - 1e-9) { best = c; score = sc; } }
    out[i - 1].end = r2(best); out[i].start = r2(best - overlap); out[i].blend = overlap;
  }
  return out;
}

/** The still that keeps one character alike from piece to piece (the "anchor"): `off`; `longest`, a frame of the longest
 *  piece's own render, which every other piece waits for (how it worked until Nov 2 2026); `short`, the default since,
 *  a frame of a short render, so every piece is sent at once and the job takes about as long as its longest piece. */
export type AnchorMode = "off" | "longest" | "short";
export function anchorMode(env?: Record<string, string | undefined>): AnchorMode {
  const v = String(env?.STUDIO_RECAST_ANCHOR ?? process.env.STUDIO_RECAST_ANCHOR ?? "short").trim().toLowerCase();
  return v === "off" || v === "longest" ? v : "short";
}
/** A dedicated anchor render is this long (Light's floor), cut from the middle of the longest piece. */
export const ANCHOR_SECONDS = MIN_SECONDS;
/** A piece this short (and not under the floor) is the anchor itself: its render is both the still and part of the video. */
const ANCHOR_PIECE_MAX = ANCHOR_SECONDS + 1.5;
export type AnchorPlan = { piece: number } | { piece: null; start: number; end: number };
/** Which render the anchor still comes from: one of the pieces (by index) or a dedicated window of the source. */
export function planAnchor(pieces: Array<{ start: number; end: number }>, mode: AnchorMode): AnchorPlan | null {
  if (mode === "off" || pieces.length < 2) return null;
  const len = (p: { start: number; end: number }) => p.end - p.start;
  const longest = pieces.reduce((bi, p, i, all) => (len(p) > len(all[bi]) ? i : bi), 0);
  if (mode === "longest") return { piece: longest };
  let best = -1;
  for (const [i, p] of pieces.entries()) if (len(p) >= MIN_SECONDS - 1e-6 && len(p) <= ANCHOR_PIECE_MAX + 1e-6 && (best < 0 || len(p) < len(pieces[best]))) best = i;
  if (best >= 0) return { piece: best };
  const L = pieces[longest], mid = (L.start + L.end) / 2;
  const start = r2(Math.max(L.start, Math.min(L.end - ANCHOR_SECONDS, mid - ANCHOR_SECONDS / 2)));
  return { piece: null, start, end: r2(start + ANCHOR_SECONDS) };
}
/** The longest Light piece sent (STUDIO_LIGHT_PIECE_SECONDS, 6 to 15; 15 unless set): a job takes about as long as its
 *  longest piece renders (about a minute a second), so shorter pieces finish sooner, with more joins to fade over. */
export function lightPieceMax(env?: Record<string, string | undefined>): number {
  const n = Number(env?.STUDIO_LIGHT_PIECE_SECONDS ?? process.env.STUDIO_LIGHT_PIECE_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_SECONDS.light, Math.max(MIN_SECONDS + 2, n)) : MAX_SECONDS.light;
}

/** The shots of a clip as Light pieces: one per shot (Light takes one continuous shot, at most 15 s), a long shot split
 *  evenly, a shot under 4 s marked for padding (its last frame is held, and the result cut back to the shot). */
export function shotPieces(window: number, cuts: number[], max: number = MAX_SECONDS.light - JOIN_OVERLAP): Array<{ start: number; end: number }> {
  const total = Math.round(window * 100) / 100;
  const bounds = [0, ...[...new Set(cuts.map((c) => Math.round(c * 100) / 100))].filter((c) => c >= 0.5 && c <= total - 0.5).sort((a, b) => a - b), total];
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1], n = Math.max(1, Math.ceil((b - a) / max - 1e-9));
    for (let k = 0; k < n; k++) out.push({ start: Math.round((a + ((b - a) * k) / n) * 100) / 100, end: Math.round((a + ((b - a) * (k + 1)) / n) * 100) / 100 });
  }
  return out;
}
/** Seconds a request is billed for: its input, rounded up, never under the renderer's 4 s floor. */
const billedSecondsOf = (p: { start: number; end: number }) => Math.ceil(Math.max(MIN_SECONDS, p.end - p.start) - 1e-6);
/** Most Light pieces one job sends at once (the platform runs 10 at a time on a funded account). */
export const MAX_SHOT_PIECES = 12;
/** The long path's plan, by what it costs us: every shot on Genjutsu Light, or the clip in up to 30 s Seedance pieces.
 *  Light is about $0.20 a second and Seedance 2.5 about $0.48, so Light wins unless the clip is many very short shots
 *  (each padded to 4 s) or more pieces than the platform runs together. `seedanceOnly` after Light refused the clip. */
export function planLongPath(window: number, cuts: number[], env?: Record<string, string | undefined>, seedanceOnly = false, motion: Array<[number, number]> = []) {
  // joins inside a shot get a calmer spot and an overlap to fade over (so pieces are planned that much shorter)
  const seed = refineJoins(planPieces(window, cuts, PIECE_SECONDS - JOIN_OVERLAP), cuts, motion, PIECE_SECONDS);
  const lightMax = lightPieceMax(env);
  const light = refineJoins(shotPieces(window, cuts, lightMax - JOIN_OVERLAP), cuts, motion, lightMax);
  // a dedicated anchor render (when no piece is short enough to serve) is a few seconds more on the route's own renderer
  const mode = anchorMode(env);
  const anchorOf = (pieces: Array<{ start: number; end: number }>, cost: number, list: number) => { const a = planAnchor(pieces, mode); const extra = a && a.piece == null ? ANCHOR_SECONDS : 0; return { anchor: a, usd: extra * cost, list: extra * list }; };
  const seedAnchor = anchorOf(seed, seedanceEditCostPerSecond(env), seedanceListPerSecond()), lightAnchor = anchorOf(light, higgsfieldCostPerSecond("light", env), higgsfieldListPerSecond("light"));
  const seedUsd = seed.reduce((n, p) => n + Math.ceil(p.end - p.start - 1e-6), 0) * seedanceEditCostPerSecond(env) + seedAnchor.usd;
  const lightUsd = light.reduce((n, p) => n + billedSecondsOf(p), 0) * higgsfieldCostPerSecond("light", env) + lightAnchor.usd;
  const useLight = !seedanceOnly && light.length <= MAX_SHOT_PIECES && lightUsd <= seedUsd;
  // list_usd: the same plan at list prices, which is what a person is charged on (a discount is our margin)
  const listUsd = useLight ? light.reduce((n, p) => n + billedSecondsOf(p), 0) * higgsfieldListPerSecond("light") + lightAnchor.list : seed.reduce((n, p) => n + Math.ceil(p.end - p.start - 1e-6), 0) * seedanceListPerSecond() + seedAnchor.list;
  const chosen = useLight ? lightAnchor : seedAnchor;
  return { engine: (useLight ? "light" : "seedance") as "light" | "seedance", pieces: useLight ? light : seed, usd: Math.round((useLight ? lightUsd : seedUsd) * 1000) / 1000, other_usd: Math.round((useLight ? seedUsd : lightUsd) * 1000) / 1000, list_usd: Math.round(listUsd * 1000) / 1000, anchor: chosen.anchor, anchor_usd: Math.round(chosen.usd * 1000) / 1000 };
}
