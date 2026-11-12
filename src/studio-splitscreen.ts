// Clone8 Studio: Split screen. The person's own clip on one half of a 9:16 video, a satisfying gameplay loop on the
// other (Subway Surfers, Minecraft parkour, GTA ramps, Fortnite, ball-escape sims, marble runs, presses, sand...),
// their words as captions on the seam, and only their clip's sound.
//
// This file is the engine: the layout (where the seam sits, which half is which, what part of each picture shows),
// the auto-sizer's defaults, the gameplay window (which stretch of a long loop runs under this clip), and the one
// ffmpeg pass that makes the video. The job, the routes and the switches come next (docs/split-screen/PLAN.md).
//
// The page's editor and this file share one model of a frame: for each half, `Box` = how far in it is zoomed and where
// the crop's centre sits in the source picture (fractions 0..1). What the person sees in the editor is what renders.
//
// Off until STUDIO_SPLITSCREEN_ENABLED=true; until STUDIO_SPLITSCREEN_OPEN=true only the owner's account can use it.

type Env = Record<string, string | undefined>;

export const splitscreenEnabled = (env: Env = process.env) => env.STUDIO_SPLITSCREEN_ENABLED === "true";
export const splitscreenOpen = (env: Env = process.env) => splitscreenEnabled(env) && env.STUDIO_SPLITSCREEN_OPEN === "true";

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
  return { zoom: Math.round(zoom * 100) / 100, cx: clamp(s.x, 0, 1), cy: clamp(s.y + (0.06 * crop.h) / src.h, 0, 1) };
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

export type SplitRender = {
  clip: { file: string; size: Size; seconds: number; hasAudio: boolean };
  game: { file: string; size: Size; start: number; loop: boolean };
  layout: Layout;
  /** a captions file (.ass) already laid out for SPLIT_OUT with its block on the seam; null for none */
  ass: string | null;
  /** the ass filter string for that file (fonts dir included), from studio-caption-video's assFilter */
  assFilter?: string;
  target: string;
  out?: Size;
};

/** The filter graph: each half cropped to its framing and scaled to its slot, stacked, captions burned in on top.
 *  Input 0 is the clip, input 1 the gameplay. */
export function splitGraph(r: Pick<SplitRender, "clip" | "game" | "layout" | "ass" | "assFilter" | "out">): string {
  const out = r.out ?? SPLIT_OUT, fps = SPLIT_OUT.fps;
  const h = halves(r.layout, out);
  const part = (input: number, src: Size, slot: Rect, b: Box, label: string) => {
    const c = cropRect(src, slot, b);
    return `[${input}:v]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${slot.w}:${slot.h}:flags=lanczos,setsar=1,fps=${fps}[${label}]`;
  };
  const steps: string[] = [];
  steps.push(part(1, r.game.size, h.game, r.layout.game, "g"));
  let pic = "g";
  if (h.clip) {
    steps.push(part(0, r.clip.size, h.clip, r.layout.clip, "c"));
    steps.push(r.layout.swap ? "[g][c]vstack=inputs=2[s]" : "[c][g]vstack=inputs=2[s]");
    pic = "s";
  }
  steps.push(`[${pic}]${r.ass && r.assFilter ? `${r.assFilter},` : ""}format=yuv420p[v]`);
  return steps.join(";");
}

/** The whole ffmpeg command after `ffmpeg`. The gameplay is read from its start point and looped when short; the
 *  video lasts exactly as long as the clip; the sound is the clip's own (silence when it has none). */
export function splitArgs(r: SplitRender): string[] {
  const g = r.game;
  const gameIn = [...(g.loop ? ["-stream_loop", "-1"] : []), ...(g.start > 0 ? ["-ss", g.start.toFixed(2)] : []), "-i", g.file];
  const silence = r.clip.hasAudio ? [] : ["-f", "lavfi", "-t", r.clip.seconds.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo"];
  const audioMap = ["-map", r.clip.hasAudio ? "0:a:0" : "2:a:0"];
  return [
    "-v", "error", "-nostdin", "-y",
    "-i", r.clip.file, ...gameIn, ...silence,
    "-filter_complex", splitGraph(r), "-map", "[v]", ...audioMap,
    "-t", r.clip.seconds.toFixed(2), "-fps_mode", "cfr",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", r.target,
  ];
}
