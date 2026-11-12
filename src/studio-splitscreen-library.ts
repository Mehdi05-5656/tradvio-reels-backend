// Clone8 Studio: Split screen, the gameplay library. Each loop is a 3-minute stretch of real gameplay or satisfying
// footage, made silent, 30 fps, its short side at 720, stored once in the bucket and read by every split-screen job.
//
// `safe` is the part of the picture a crop may use (channel names, level counters, watermarks and menus sit outside
// it); `box` is the auto-sizer's framing of the action inside that part. Both are shares of the picture (0..1).
import { CENTRE, cropInside, type Box, type Rect, type Size } from "./splitscreen-layout.js";

export type Kind = "game" | "ball" | "sim" | "marble" | "asmr";
export const KINDS: Array<{ id: Kind; label: string }> = [
  { id: "game", label: "Gameplay" },
  { id: "ball", label: "Ball games" },
  { id: "sim", label: "Simulations" },
  { id: "marble", label: "Marble runs" },
  { id: "asmr", label: "Satisfying" },
];
export type Loop = {
  id: string; kind: Kind; name: string;
  seconds: number; size: Size;
  safe: Rect; box: Box;
};
/** Where a loop lives: the bucket and folder are fixed, the file is the loop's id. */
export const LIBRARY_BUCKET = "studio-outputs";
export const loopKey = (id: string) => `splitscreen/library/${id}.mp4`;
export const posterKey = (id: string) => `splitscreen/library/${id}.jpg`;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const L = (id: string, kind: Kind, name: string, w: number, h: number, safe: Rect = FULL, box: Box = CENTRE, seconds = 180): Loop => ({ id, kind, name, seconds, size: { w, h }, safe, box });

/** The library. Sizes are the cleaned files'; safe areas and boxes were set from a contact sheet of each loop. */
export const LIBRARY: Loop[] = [];

export const loopById = (id: unknown): Loop | null => LIBRARY.find((l) => l.id === id) ?? null;

/** "Surprise me": a loop of the asked kind (any kind when none), picked from the seed so a job keeps its pick. */
export function pickLoop(kind: Kind | null, seed: string, from: Loop[] = LIBRARY): Loop | null {
  const pool = kind ? from.filter((l) => l.kind === kind) : from;
  if (!pool.length) return null;
  let h = 2166136261; for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return pool[h % pool.length];
}

/** The crop of a loop for a half of size `slot`, kept inside the loop's safe area. In the file's pixels. */
export const loopCrop = (loop: Pick<Loop, "size" | "safe">, slot: Size, b: Box): Rect => cropInside(loop.size, loop.safe, slot, b);
