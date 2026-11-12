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

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const B = (cy: number, cx = 0.5, zoom = 1): Box => ({ zoom, cx, cy });
/** The library (Nov 12 2026): 3-minute stretches, silent, 30 fps, the short side at 720. Safe areas and action boxes
 *  were set from a 6-frame contact sheet of each loop (splitscreen-library/sheets): HUDs, counters, channel names
 *  and pillarbox bars sit outside the safe area. Left out for now: kinetic sand (a creator's watermark in the middle
 *  of the picture) and the second bouncing-sims stretch (a "subscribe" overlay). Sources: docs/split-screen/PLAN.md. */
export const LIBRARY: Loop[] = [
  L("subway-official", "game", "Subway Surfers", 720, 1278, FULL, B(0.62), 185),
  L("subway-orbital", "game", "Subway Surfers · Rio", 720, 1280, R(0, 0.14, 1, 0.86), B(0.64)),
  L("minecraft-parkour-a", "game", "Minecraft parkour", 1280, 720),
  L("minecraft-parkour-b", "game", "Minecraft parkour · colours", 1280, 720),
  L("gta-megaramp", "game", "GTA mega ramp", 1280, 720, FULL, B(0.58)),
  L("gta-carjumps-a", "game", "GTA car jumps", 1280, 720, FULL, B(0.6)),
  L("gta-carjumps-b", "game", "GTA car jumps · sky ramp", 1280, 720, FULL, B(0.6)),
  L("fortnite-a", "game", "Fortnite · snow", 1280, 720, R(0.18, 0.1, 0.6, 0.75), B(0.56)),
  L("fortnite-b", "game", "Fortnite", 1280, 720, R(0.2, 0.14, 0.58, 0.72), B(0.58)),
  L("beamng-ramps", "game", "BeamNG car jumps", 1280, 720, R(0.04, 0.08, 0.68, 0.9), B(0.6)),
  L("going-balls", "ball", "Going Balls", 1280, 720, R(0, 0.15, 1, 0.85), B(0.62)),
  L("sky-rolling-ball", "ball", "Sky Rolling Ball", 720, 1280, R(0.1, 0.18, 0.8, 0.82), B(0.6)),
  L("bounce-sims-a", "sim", "Bouncing ball sims", 1280, 720, R(0.24, 0, 0.52, 1)),
  L("marble-race", "marble", "Marble race", 1280, 720, R(0.12, 0.1, 0.86, 0.9)),
  L("marble-loop", "marble", "Marble run", 1280, 720),
  L("hydraulic-press", "asmr", "Hydraulic press", 1280, 720, FULL, B(0.45)),
  L("soap-cutting", "asmr", "Soap cutting", 1278, 720, R(0.23, 0, 0.54, 1)),
  L("slime", "asmr", "Slime", 1280, 720),
];

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
