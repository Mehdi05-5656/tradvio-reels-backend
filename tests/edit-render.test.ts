import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { layoutGraph, renderArgs, soundFilter } from "../src/edit-render.js";
import { clipDoc, type EditDoc } from "../src/studio-projects.js";
import { buildClipFilter } from "../src/studio-clips.js";
import { contentLayout, stackedLayout } from "../src/studio-live-clips.js";

const m = { rank: 1, start: 100, end: 130, title: "t", hook: "h", score: 80 };
const info = { w: 1920, h: 1080, fps: 30 };
const kept = { key: "k", seconds: 60, before: 15, expires: null };
const base = (over: Partial<Parameters<typeof clipDoc>[0]>) => clipDoc({ tool: "clips", jobId: "j", m, info, dur: 30, format: "vertical", frame: { w: 720, h: 1280 },
  segs: [{ start: 0, end: 30, mode: "crop", x0: 0.3, x1: 0.6 }], seen: null, trim: null, captions: null, burned: false, keys: [], assetId: "a", limiter: false, kept, origin: null, ...over });

test("the re-render draws the same picture the cutter drew: Clips' crop path", () => {
  const d = base({});
  assert.equal(layoutGraph(d, info).graph, buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: d.layout.path, fps: 30, out: { w: 720, h: 1280 } }));
  assert.deepEqual([layoutGraph(d, info).w, layoutGraph(d, info).h], [720, 1280]);
});

test("the re-render draws the same picture the cutter drew: Live Clips' stacked and content layouts", () => {
  const cam = { x: 0.02, y: 0.62, w: 0.22, h: 0.36 }, content = { x: 0.26, y: 0, w: 0.6, h: 1 };
  const st = base({ tool: "live_clips", frame: { w: 1080, h: 1920 }, segs: [], seen: { layout: "stacked", cam, content, irl: false, tiny: false, cam_h: stackedLayout(info, cam, content).camH } });
  assert.equal(layoutGraph(st, info).graph, stackedLayout(info, cam, content).graph);
  const ct = base({ tool: "live_clips", frame: { w: 1080, h: 1920 }, segs: [], seen: { layout: "content", cam: null, content, irl: false, tiny: true } });
  assert.equal(layoutGraph(ct, info).graph, contentLayout(info, content).graph);
});

test("a person's edit changes the render: a moved start, a moved camera box", () => {
  const cam = { x: 0.02, y: 0.62, w: 0.22, h: 0.36 };
  const d: EditDoc = base({ tool: "live_clips", frame: { w: 1080, h: 1920 }, segs: [], seen: { layout: "stacked", cam, content: null, irl: false, tiny: false } });
  const before = renderArgs(d, "/k.mp4", info, "/o.mp4");
  const e: EditDoc = JSON.parse(JSON.stringify(d));
  e.trim.in -= 3; e.layout.panes[0].from = { ...cam, y: 0.5 };
  const after = renderArgs(e, "/k.mp4", info, "/o.mp4");
  assert.equal(before.args[before.args.indexOf("-ss") + 1], "15.000");
  assert.equal(after.args[after.args.indexOf("-ss") + 1], "12.000");
  assert.equal(after.seconds, 33);
  assert.notEqual(after.args[after.args.indexOf("-filter_complex") + 1], before.args[before.args.indexOf("-filter_complex") + 1]);
});

test("the sound pass: level, limiter, soft edges, a locked muted range silenced in clip time", () => {
  const d = base({ limiter: true });
  d.sound.muted = [{ from: 20, to: 25, why: "music", locked: true }];
  const f = soundFilter(d, 30);
  assert.match(f, /^volume=enable='between\(t,5\.000,10\.000\)':volume=0,loudnorm=I=-14/);
  assert.match(f, /alimiter/);
  assert.match(f, /afade=t=out:st=29\.750/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("a real re-render from a kept recording: the right frame and length", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "edit-render-"));
  try {
    const src = join(dir, "keep.mp4"), out = join(dir, "out.mp4");
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=20", "-f", "lavfi", "-i", "sine=f=440:d=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    assert.equal(g.status, 0, String(g.stderr));
    const d = clipDoc({ tool: "clips", jobId: "j", m: { ...m, start: 10, end: 14 }, info: { w: 320, h: 180, fps: 30 }, dur: 4, format: "vertical", frame: { w: 720, h: 1280 },
      segs: [{ start: 0, end: 4, mode: "crop", x0: 0.5, x1: 0.5 }], seen: null, trim: null, captions: null, burned: false, keys: [], assetId: "a", limiter: true,
      kept: { key: "k", seconds: 20, before: 5, expires: null }, origin: null });
    const r = renderArgs(d, src, { w: 320, h: 180, fps: 30 }, out);
    const run = spawnSync("ffmpeg", r.args);
    assert.equal(run.status, 0, String(run.stderr));
    const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", out]);
    const j = JSON.parse(String(p.stdout));
    const v = j.streams.find((s: any) => s.width);
    assert.deepEqual([v.width, v.height], [720, 1280]);
    assert.ok(Math.abs(Number(j.format.duration) - 4) < 0.2, `duration ${j.format.duration}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
