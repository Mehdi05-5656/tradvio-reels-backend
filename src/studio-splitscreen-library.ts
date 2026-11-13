// Clone8 Studio: Split screen, the gameplay library. Each loop is a 3-minute stretch of real gameplay or satisfying
// footage, made silent, 30 fps, its short side at 720, stored once in the bucket and read by every split-screen job.
//
// `safe` is the part of the picture a crop may use (channel names, level counters, watermarks and menus sit outside
// it); `box` is the auto-sizer's framing of the action inside that part. Both are shares of the picture (0..1).
import { CENTRE, cropInside, type Box, type Rect, type Size } from "./splitscreen-layout.js";
import { CATALOG } from "./studio-splitscreen-catalog.js";

/** The categories, in the order the page shows them (the owner's ask, Nov 12 2026: a category per game or kind,
 *  at least 18 loops in each). */
export type Kind = "subway" | "minecraft" | "gta" | "fortnite" | "beamng" | "balls" | "bounce" | "marble" | "press" | "soap" | "slime" | "sand";
export const KINDS: Array<{ id: Kind; label: string }> = [
  { id: "subway", label: "Subway Surfers" },
  { id: "minecraft", label: "Minecraft parkour" },
  { id: "gta", label: "GTA car jumps" },
  { id: "fortnite", label: "Fortnite" },
  { id: "beamng", label: "BeamNG crashes" },
  { id: "balls", label: "Rolling ball games" },
  { id: "bounce", label: "Bouncing balls" },
  { id: "marble", label: "Marble runs" },
  { id: "press", label: "Hydraulic press" },
  { id: "soap", label: "Soap cutting" },
  { id: "slime", label: "Slime" },
  { id: "sand", label: "Kinetic sand" },
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
const FIRST: Loop[] = [
  L("subway-official", "subway", "Subway Surfers", 720, 1278, FULL, B(0.62), 185),
  L("subway-orbital", "subway", "Subway Surfers · Rio", 720, 1280, R(0, 0.14, 1, 0.86), B(0.64)),
  L("minecraft-parkour-a", "minecraft", "Minecraft parkour", 1280, 720),
  L("minecraft-parkour-b", "minecraft", "Minecraft parkour · colours", 1280, 720),
  L("gta-megaramp", "gta", "GTA mega ramp", 1280, 720, FULL, B(0.58)),
  L("gta-carjumps-a", "gta", "GTA car jumps", 1280, 720, FULL, B(0.6)),
  L("gta-carjumps-b", "gta", "GTA car jumps · sky ramp", 1280, 720, FULL, B(0.6)),
  L("fortnite-a", "fortnite", "Fortnite · snow", 1280, 720, R(0.18, 0.1, 0.6, 0.75), B(0.56)),
  L("fortnite-b", "fortnite", "Fortnite", 1280, 720, R(0.2, 0.14, 0.58, 0.72), B(0.58)),
  L("beamng-ramps", "beamng", "BeamNG car jumps", 1280, 720, R(0.04, 0.08, 0.68, 0.9), B(0.6)),
  L("going-balls", "balls", "Going Balls", 1280, 720, R(0, 0.15, 1, 0.85), B(0.62)),
  L("sky-rolling-ball", "balls", "Sky Rolling Ball", 720, 1280, R(0.1, 0.18, 0.8, 0.82), B(0.6)),
  L("bounce-sims-a", "bounce", "Bouncing ball sims", 1280, 720, R(0.24, 0, 0.52, 1)),
  L("marble-race", "marble", "Marble race", 1280, 720, R(0.12, 0.1, 0.86, 0.9)),
  L("marble-loop", "marble", "Marble run", 1280, 720),
  L("hydraulic-press", "press", "Hydraulic press", 1280, 720, FULL, B(0.45)),
  L("soap-cutting", "soap", "Soap cutting", 1278, 720, R(0.23, 0, 0.54, 1)),
  L("slime", "slime", "Slime", 1280, 720),
];

/** The library: the first 18 (live since Nov 12 13:58 PT) and the category library (studio-splitscreen-catalog.ts,
 *  made by scripts/splitscreen-catalog.mjs from the cleaned loops and each source's safe area). */
export const LIBRARY: Loop[] = [...FIRST, ...CATALOG.map((c) => L(c.id, c.kind as Kind, c.name, c.w, c.h, c.safe ?? FULL, B(c.cy ?? 0.5), c.seconds))];

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
