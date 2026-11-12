// Split screen: the layout model, shared byte-for-byte by the backend (tradvio-reels-backend/src/splitscreen-layout.ts)
// and the Studio page's editor (tradvio-reels-v2/src/lib/splitscreen-layout.ts), so what the editor shows is what
// renders. No imports, no Node or browser APIs: pure numbers. Change both copies together (a test compares them).

/** The output: 720x1280 at 30 fps, the size Clips and Stunts deliver (the web service's cutter is shared). */
export const SPLIT_OUT = { w: 720, h: 1280, fps: 30 } as const;
export const SPLIT_LIMITS = { min_seconds: 2, max_seconds: 180, seam_min: 0.3, seam_max: 0.7, zoom_max: 4 } as const;
/** Where the seam bar snaps in the editor (share of the frame the top half takes). */
export const SEAM_SNAPS = [0.4, 0.5, 0.6, 0.7] as const;

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
/** A half's framing: zoom 1 = the largest crop of the source that fills the half; cx, cy = the crop's centre, as a
 *  share of the source's width and height. */
export type Box = { zoom: number; cx: number; cy: number };
/** "split": clip and gameplay stacked. "full": gameplay fills the frame and the clip is heard only (stories, voice). */
export type Mode = "split" | "full";
export type Layout = { mode: Mode; seam: number; swap: boolean; clip: Box; game: Box; captions: boolean };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const CENTRE: Box = { zoom: 1, cx: 0.5, cy: 0.5 };

export function cleanBox(raw: any, d: Box = CENTRE): Box {
  return { zoom: clamp(num(raw?.zoom, d.zoom), 1, SPLIT_LIMITS.zoom_max), cx: clamp(num(raw?.cx, d.cx), 0, 1), cy: clamp(num(raw?.cy, d.cy), 0, 1) };
}
/** Whatever the page sends, made safe: the seam inside 30..70 %, zoom 1..4, centres inside the picture. */
export function cleanLayout(raw: any, d: Partial<Layout> = {}): Layout {
  const base: Layout = { mode: "split", seam: 0.5, swap: false, clip: CENTRE, game: CENTRE, captions: true, ...d };
  return {
    mode: raw?.mode === "full" ? "full" : raw?.mode === "split" ? "split" : base.mode,
    seam: clamp(num(raw?.seam, base.seam), SPLIT_LIMITS.seam_min, SPLIT_LIMITS.seam_max),
    swap: typeof raw?.swap === "boolean" ? raw.swap : base.swap,
    clip: cleanBox(raw?.clip, base.clip),
    game: cleanBox(raw?.game, base.game),
    captions: typeof raw?.captions === "boolean" ? raw.captions : base.captions,
  };
}

/** Where each half sits in the output frame. The top half takes `seam` of the height; with `swap` the gameplay is on
 *  top. Heights are even (x264 needs it) and always add up to the frame. */
export function halves(l: Pick<Layout, "mode" | "seam" | "swap">, out: Size = SPLIT_OUT): { clip: Rect | null; game: Rect; seamY: number } {
  if (l.mode === "full") return { clip: null, game: { x: 0, y: 0, w: out.w, h: out.h }, seamY: 0.5 };
  const top = even(out.h * clamp(l.seam, SPLIT_LIMITS.seam_min, SPLIT_LIMITS.seam_max)), bottom = out.h - top;
  const upper: Rect = { x: 0, y: 0, w: out.w, h: top }, lower: Rect = { x: 0, y: top, w: out.w, h: bottom };
  return l.swap ? { clip: lower, game: upper, seamY: top / out.h } : { clip: upper, game: lower, seamY: top / out.h };
}

/** The part of the source that shows in a half of size `slot`, for a framing `b`. Zoom 1 is the largest crop with
 *  the half's shape (the picture covers the half, nothing letterboxed); zoom 2 shows half as much. The crop never
 *  leaves the picture: a centre too near an edge slides the crop inward. */
export function cropRect(src: Size, slot: Size, b: Box): Rect {
  const aspect = slot.w / slot.h;
  let w = src.w, h = src.w / aspect;
  if (h > src.h) { h = src.h; w = src.h * aspect; }
  const z = clamp(b.zoom, 1, SPLIT_LIMITS.zoom_max);
  w = Math.min(src.w, even(w / z)); h = Math.min(src.h, even(h / z));
  const x = clamp(Math.round(b.cx * src.w - w / 2), 0, src.w - w), y = clamp(Math.round(b.cy * src.h - h / 2), 0, src.h - h);
  return { x: x - (x % 2), y: y - (y % 2), w, h };
}

/** The same crop, kept inside `safe` (shares of the picture): the framing works as if that area were the whole picture,
 *  so no zoom or drag can bring what lies outside it (a gameplay loop's watermark, a level counter) into view. */
export function cropInside(src: Size, safe: Rect | null | undefined, slot: Size, b: Box): Rect {
  if (!safe) return cropRect(src, slot, b);
  const ev = (n: number) => Math.round(n / 2) * 2;
  const s = { x: ev(safe.x * src.w), y: ev(safe.y * src.h), w: ev(safe.w * src.w), h: ev(safe.h * src.h) };
  const c = cropRect({ w: Math.min(s.w, src.w - s.x), h: Math.min(s.h, src.h - s.y) }, slot, b);
  return { x: s.x + c.x, y: s.y + c.y, w: c.w, h: c.h };
}

/** Where the person's subject is in their clip, from the vision read: the centre of the face (or of the main subject
 *  when there is no face) and its height, as shares of the picture. */
export type Subject = { x: number; y: number; h?: number; kind?: "face" | "subject" | "screen" | "none" };

/** The auto-sizer for the clip's half. A face sits in the middle across and a little above the middle down
 *  (headroom, and the seam captions stay off the chin); a close face is left as it is, a small one is zoomed until it
 *  fills about a third of the half's height, never past 2.2x (beyond that a phone clip turns to mush at 720 wide).
 *  A screen recording or a clip with nobody in it keeps the whole width (zoom 1, centred). */
export function autoClipBox(src: Size, slot: Size, s: Subject | null): Box {
  if (!s || s.kind === "screen" || s.kind === "none") return { ...CENTRE };
  const base = cropRect(src, slot, CENTRE);
  let zoom = 1;
  if (s.h && s.h > 0 && s.kind !== "subject") zoom = clamp((base.h * 0.34) / (s.h * src.h), 1, 2.2);
  const crop = cropRect(src, slot, { zoom, cx: 0.5, cy: 0.5 });
  // the face at 44 % of the half's height: move the crop's centre down from the face by 6 % of the crop
  let cy = s.y + (0.06 * crop.h) / src.h;
  // never cut the top of the head (or of the subject): its top stays at least 10 % of the crop below the crop's top.
  // A person standing on a car was read as a tall subject and centred, which cut their head off (first live video)
  if (s.h && s.h > 0) { const top = (s.y - s.h / 2) * src.h; cy = Math.min(cy, (top - 0.1 * crop.h + crop.h / 2) / src.h); }
  return { zoom: Math.round(zoom * 100) / 100, cx: clamp(s.x, 0, 1), cy: clamp(cy, 0, 1) };
}

/** The seam the auto-sizer picks: half and half, unless the clip is a close talking head in a vertical video (its
 *  detail is in the middle, so it can give 5 % to the gameplay) or a wide screen recording (it needs the room). */
export function autoSeam(src: Size, s: Subject | null): number {
  if (s?.kind === "screen") return 0.6;
  if (s?.kind === "face" && src.h > src.w && (s.h ?? 0) >= 0.28) return 0.45;
  return 0.5;
}

/** Which stretch of a gameplay loop runs under this clip. A loop longer than the clip starts at a point picked from the
 *  seed (the same job always gets the same start, two jobs rarely share one), leaving the loop's first and last
 *  seconds out (menus, fades). A loop shorter than the clip repeats. */
export function gameWindow(gameSeconds: number, clipSeconds: number, seed: string): { start: number; loop: boolean } {
  if (!(gameSeconds > 0)) return { start: 0, loop: true };
  const margin = Math.min(3, gameSeconds * 0.05);
  const room = gameSeconds - 2 * margin - clipSeconds;
  if (room <= 0) return { start: 0, loop: gameSeconds < clipSeconds };
  let h = 2166136261; for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return { start: Math.round((margin + (h / 0xffffffff) * room) * 100) / 100, loop: false };
}
