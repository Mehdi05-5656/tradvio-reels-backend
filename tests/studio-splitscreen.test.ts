import test from "node:test";
import assert from "node:assert/strict";
import { autoClipBox, autoSeam, cleanLayout, cropRect, gameWindow, halves, splitArgs, splitGraph, splitscreenEnabled, splitscreenOpen, SPLIT_OUT } from "../src/studio-splitscreen.js";

test("switches: off by default; the open switch cannot switch it on by itself", () => {
  assert.equal(splitscreenEnabled({}), false);
  assert.equal(splitscreenEnabled({ STUDIO_SPLITSCREEN_ENABLED: "true" }), true);
  assert.equal(splitscreenOpen({ STUDIO_SPLITSCREEN_ENABLED: "true" }), false);
  assert.equal(splitscreenOpen({ STUDIO_SPLITSCREEN_OPEN: "true" }), false);
  assert.equal(splitscreenOpen({ STUDIO_SPLITSCREEN_ENABLED: "true", STUDIO_SPLITSCREEN_OPEN: "true" }), true);
});

test("cleanLayout: whatever the page sends is made safe", () => {
  const l = cleanLayout({ mode: "weird", seam: 0.95, swap: "yes", clip: { zoom: 9, cx: -1, cy: 2 }, game: { zoom: 0.2 }, captions: false });
  assert.deepEqual(l, { mode: "split", seam: 0.7, swap: false, clip: { zoom: 4, cx: 0, cy: 1 }, game: { zoom: 1, cx: 0.5, cy: 0.5 }, captions: false });
  assert.equal(cleanLayout({ seam: "0.1" }).seam, 0.3);
  assert.equal(cleanLayout({ mode: "full" }).mode, "full");
  assert.equal(cleanLayout(null, { seam: 0.45 }).seam, 0.45, "the auto-sizer's defaults hold when the page sends nothing");
});

test("halves: the clip on top by default, swapped on request, heights even and adding up to the frame", () => {
  const h = halves({ mode: "split", seam: 0.5, swap: false });
  assert.deepEqual(h.clip, { x: 0, y: 0, w: 720, h: 640 });
  assert.deepEqual(h.game, { x: 0, y: 640, w: 720, h: 640 });
  assert.equal(h.seamY, 0.5);
  const s = halves({ mode: "split", seam: 0.43, swap: true });
  assert.equal(s.game.y, 0);
  assert.equal(s.clip!.y, s.game.h);
  assert.equal(s.clip!.h + s.game.h, SPLIT_OUT.h);
  assert.ok(s.clip!.h % 2 === 0 && s.game.h % 2 === 0);
  const f = halves({ mode: "full", seam: 0.5, swap: false });
  assert.equal(f.clip, null);
  assert.deepEqual(f.game, { x: 0, y: 0, w: 720, h: 1280 });
});

test("cropRect: zoom 1 covers the half with its shape; zoom narrows it; it never leaves the picture", () => {
  const slot = { w: 720, h: 640 };
  // a vertical phone clip into a wide half: full width, a band of the height
  const v = cropRect({ w: 1080, h: 1920 }, slot, { zoom: 1, cx: 0.5, cy: 0.5 });
  assert.equal(v.w, 1080); assert.equal(v.h, 960); assert.equal(v.x, 0); assert.equal(v.y, 480);
  // a landscape clip: full height, a band of the width
  const l = cropRect({ w: 1920, h: 1080 }, slot, { zoom: 1, cx: 0.5, cy: 0.5 });
  assert.equal(l.h, 1080); assert.equal(l.w, 1216); assert.equal(l.x, 352);
  // zoom 2 shows half as much
  const z = cropRect({ w: 1080, h: 1920 }, slot, { zoom: 2, cx: 0.5, cy: 0.5 });
  assert.equal(z.w, 540); assert.equal(z.h, 480);
  // a centre at the very edge slides the crop inward
  const e = cropRect({ w: 1080, h: 1920 }, slot, { zoom: 1, cx: 0.5, cy: 0 });
  assert.equal(e.y, 0);
  const e2 = cropRect({ w: 1080, h: 1920 }, slot, { zoom: 1.5, cx: 1, cy: 1 });
  assert.equal(e2.x + e2.w <= 1080, true); assert.equal(e2.y + e2.h <= 1920, true);
  for (const r of [v, l, z, e, e2]) for (const k of ["x", "y", "w", "h"] as const) assert.equal(r[k] % 2, 0, `${k} even`);
});

test("autoClipBox: a face sits centred across and a little above the middle; a small face is zoomed, never past 2.2x", () => {
  const src = { w: 1080, h: 1920 }, slot = { w: 720, h: 640 };
  const close = autoClipBox(src, slot, { kind: "face", x: 0.4, y: 0.35, h: 0.3 });
  assert.equal(close.cx, 0.4);
  assert.ok(close.zoom >= 1);
  const crop = cropRect(src, slot, close);
  const faceInCrop = (0.35 * 1920 - crop.y) / crop.h;
  assert.ok(faceInCrop > 0.38 && faceInCrop < 0.5, `face at ${faceInCrop.toFixed(2)} of the half`);
  const tiny = autoClipBox(src, slot, { kind: "face", x: 0.5, y: 0.5, h: 0.02 });
  assert.equal(tiny.zoom, 2.2);
  assert.deepEqual(autoClipBox(src, slot, { kind: "screen", x: 0.2, y: 0.2 }), { zoom: 1, cx: 0.5, cy: 0.5 });
  assert.deepEqual(autoClipBox(src, slot, null), { zoom: 1, cx: 0.5, cy: 0.5 });
});

test("autoSeam: half and half unless the clip asks for more or less", () => {
  assert.equal(autoSeam({ w: 1080, h: 1920 }, null), 0.5);
  assert.equal(autoSeam({ w: 1080, h: 1920 }, { kind: "face", x: 0.5, y: 0.4, h: 0.32 }), 0.45);
  assert.equal(autoSeam({ w: 1920, h: 1080 }, { kind: "screen", x: 0.5, y: 0.5 }), 0.6);
});

test("gameWindow: a long loop starts somewhere inside its middle, the same for the same job; a short one repeats", () => {
  const a = gameWindow(180, 30, "job-1"), b = gameWindow(180, 30, "job-1"), c = gameWindow(180, 30, "job-2");
  assert.deepEqual(a, b);
  assert.notEqual(a.start, c.start);
  for (const w of [a, c]) { assert.equal(w.loop, false); assert.ok(w.start >= 3 && w.start + 30 <= 177, `start ${w.start}`); }
  assert.deepEqual(gameWindow(20, 45, "x"), { start: 0, loop: true });
  assert.deepEqual(gameWindow(31, 30, "x"), { start: 0, loop: false });
});

test("splitGraph and splitArgs: crop, scale, stack in the right order, captions last; the clip's sound or silence", () => {
  const layout = cleanLayout({ seam: 0.5 });
  const base = { clip: { file: "c.mp4", size: { w: 1080, h: 1920 }, seconds: 12.5, hasAudio: true }, game: { file: "g.mp4", size: { w: 1080, h: 1920 }, start: 40, loop: false }, layout, ass: null, target: "o.mp4" };
  const g = splitGraph(base);
  assert.match(g, /\[1:v\]crop=1080:960:0:480,scale=720:640:flags=lanczos,setsar=1,fps=30\[g\]/);
  assert.match(g, /\[c\]\[g\]vstack=inputs=2\[s\]/);
  assert.match(g, /\[s\]format=yuv420p\[v\]$/);
  assert.match(splitGraph({ ...base, layout: { ...layout, swap: true } }), /\[g\]\[c\]vstack/);
  assert.match(splitGraph({ ...base, ass: "x.ass", assFilter: "ass=x.ass" }), /\[s\]ass=x\.ass,format=yuv420p\[v\]/);
  const full = splitGraph({ ...base, layout: cleanLayout({ mode: "full" }) });
  assert.doesNotMatch(full, /vstack|\[0:v\]/);
  assert.match(full, /scale=720:1280/);
  const args = splitArgs(base);
  assert.deepEqual(args.slice(args.indexOf("-ss") - 0, args.indexOf("-ss") + 4), ["-ss", "40.00", "-i", "g.mp4"]);
  assert.ok(!args.includes("-stream_loop"));
  assert.deepEqual(args.slice(args.indexOf("[v]") + 1, args.indexOf("[v]") + 3), ["-map", "0:a:0"]);
  assert.equal(args[args.indexOf("-t", args.indexOf("[v]")) + 1], "12.50");
  const quiet = splitArgs({ ...base, clip: { ...base.clip, hasAudio: false }, game: { ...base.game, start: 0, loop: true } });
  assert.ok(quiet.includes("anullsrc=r=44100:cl=stereo"));
  assert.deepEqual(quiet.slice(quiet.indexOf("[v]") + 1, quiet.indexOf("[v]") + 3), ["-map", "2:a:0"]);
  assert.deepEqual(quiet.slice(quiet.indexOf("-stream_loop"), quiet.indexOf("-stream_loop") + 4), ["-stream_loop", "-1", "-i", "g.mp4"]);
});
