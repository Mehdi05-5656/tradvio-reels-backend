import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AUTO_EDIT, clipDoc, docDistance, editorOn, keepArgs, recordClipProject, settingOf, sourceRefOf, type EditDoc } from "../src/studio-projects.js";

const m = { rank: 2, start: 100, end: 138, title: "He said what", hook: "the bet", score: 82, hook_line: null };
const info = { w: 1920, h: 1080, fps: 30 };
const kept = { key: "u/edit/p/source.mp4", seconds: 68, before: 15, expires: "2026-12-20T00:00:00.000Z" };

test("editor switch: off unless STUDIO_EDITOR_ENABLED is set to a yes", () => {
  assert.equal(editorOn({}), false);
  assert.equal(editorOn({ STUDIO_EDITOR_ENABLED: "false" }), false);
  assert.equal(editorOn({ STUDIO_EDITOR_ENABLED: "true" }), true);
  assert.equal(editorOn({ STUDIO_EDITOR_ENABLED: "1" }), true);
});

test("a Clips clip: the crop path kept, times inside the kept recording, captions as burned", () => {
  const segs = [{ start: 0, end: 20, mode: "crop" as const, x0: 0.4, x1: 0.4 }, { start: 20, end: 38, mode: "crop" as const, x0: 0.4, x1: 0.62 }];
  const captions = { style: { id: "bold_pop", y: 0.7 }, keywords: true, fillers: true, censor: false };
  const d = clipDoc({ tool: "clips", jobId: "j", m, info, dur: 38, format: "vertical", frame: { w: 720, h: 1280 }, segs, seen: null, trim: null,
    captions, burned: true, keys: [3, 9], assetId: "a1", limiter: false, kept, origin: { platform: "youtube", url: "https://youtu.be/abcdefghijk" } });
  assert.equal(d.v, 1);
  assert.equal(d.made_by.auto_edit, AUTO_EDIT);
  assert.equal(d.layout.type, "follow");
  assert.deepEqual(d.layout.path, segs);
  assert.deepEqual(d.trim, { in: 15, out: 53, keep: null });
  assert.equal(d.source.origin_at, 85);
  assert.equal(d.source.key, kept.key);
  assert.equal(d.captions.on, true);
  assert.equal((d.captions.style as any).id, "bold_pop");
  assert.deepEqual(d.captions.keys, [3, 9]);
  assert.equal(d.captions.words, "captions/a1.json");
  assert.equal(d.setting.label, null);
});

test("no kept recording: times are the clip's own", () => {
  const d = clipDoc({ tool: "clips", jobId: "j", m, info, dur: 38, format: "vertical", frame: { w: 720, h: 1280 }, segs: [{ start: 0, end: 38, mode: "fit", x0: 0.5, x1: 0.5 }],
    seen: null, trim: null, captions: null, burned: false, keys: [], assetId: "a1", limiter: false, kept: null, origin: null });
  assert.deepEqual(d.trim, { in: 0, out: 38, keep: null });
  assert.equal(d.source.key, null);
  assert.equal(d.source.origin_at, 100);
  assert.equal(d.layout.type, "fit");
  assert.equal(d.captions.on, false);
});

test("a stream clip, stacked: both boxes, the divider, the setting", () => {
  const seen = { layout: "stacked" as const, cam: { x: 0.02, y: 0.62, w: 0.22, h: 0.36 }, content: { x: 0.26, y: 0, w: 0.6, h: 1 }, irl: false, tiny: false, cam_h: 620 };
  const d = clipDoc({ tool: "live_clips", jobId: "j", m, info, dur: 38, format: "vertical", frame: { w: 1080, h: 1920 }, segs: [], seen, trim: null, captions: null,
    burned: false, keys: [], assetId: "a2", limiter: true, kept: { ...kept, before: 2 }, origin: null });
  assert.equal(d.layout.type, "stacked");
  assert.equal(d.layout.divider, 0.323);
  assert.deepEqual(d.layout.panes.map((p) => p.role), ["cam", "content"]);
  assert.deepEqual(d.setting, { label: "desktop_cam", by: "ai", sure: 0.8 });
  assert.equal(d.sound.limiter, true);
  assert.equal(d.trim.in, 2);
});

test("settings read from the cut's own choices", () => {
  assert.equal(settingOf("live_clips", { layout: "follow", irl: true }, [], 30).label, "irl");
  assert.equal(settingOf("live_clips", { layout: "content", irl: false }, [], 30).label, "desktop_nocam");
  const many = Array.from({ length: 6 }, (_, k) => ({ start: k * 5, end: k * 5 + 5, mode: "crop" as const, x0: 0.5, x1: 0.5 }));
  assert.equal(settingOf("clips", null, many, 30).label, "produced");
  assert.equal(settingOf("clips", null, many.slice(0, 2), 30).label, null);
});

test("where a clip came from: the channel or video that layouts are shared by", () => {
  assert.equal(sourceRefOf({ platform: "twitch", channel_id: "12345", login: "x" }), "twitch:12345");
  assert.equal(sourceRefOf({ platform: "kick", login: "SomeOne" }), "kick:someone");
  assert.equal(sourceRefOf({ platform: "youtube", url: "https://www.youtube.com/watch?v=_XbDOwFfUWg&t=3" }), "youtube:_XbDOwFfUWg");
  assert.equal(sourceRefOf({ url: "https://youtu.be/K3sEP945U3w?is=x" }), "youtube:K3sEP945U3w");
  assert.equal(sourceRefOf({ url: "https://www.youtube.com/live/KliV-V6SSF0?si=x" }), "youtube:KliV-V6SSF0");
  assert.equal(sourceRefOf({ asset_id: "x" }), null);
  assert.equal(sourceRefOf(null), null);
});

test("keeping the recording: a stream copy with spare seconds, never through the paid proxy", () => {
  const src = { video: "/tmp/v.mp4", audio: null, proxy: null, width: 0, height: 0, fps: null };
  const k = keepArgs(src, 100, 38, 15, "/tmp/k.mp4")!;
  assert.equal(k.before, 15);
  assert.ok(k.args.includes("copy"));
  assert.equal(k.args[k.args.indexOf("-ss") + 1], "85.000");
  assert.equal(k.args[k.args.indexOf("-t") + 1], "68.000");
  // a stretch that starts 2 s before the clip (Live Clips) can only give 2 s before
  const st = keepArgs({ ...src, offset: 98 }, 100, 38, 15, "/tmp/k.mp4")!;
  assert.equal(st.before, 2);
  assert.equal(st.args.includes("-ss"), false); // the stretch file already begins there
  assert.equal(keepArgs({ ...src, proxy: "http://user:pass@proxy:1" }, 100, 38, 15, "/tmp/k.mp4"), null);
});

test("distance from the AI's proposal: nothing changed, then a moved start and a moved camera box", () => {
  const seen = { layout: "stacked" as const, cam: { x: 0, y: 0.6, w: 0.25, h: 0.4 }, content: { x: 0.25, y: 0, w: 0.6, h: 1 }, irl: false, tiny: false, cam_h: 640 };
  const ai = clipDoc({ tool: "live_clips", jobId: "j", m, info, dur: 38, format: "vertical", frame: { w: 1080, h: 1920 }, segs: [], seen, trim: null, captions: null,
    burned: false, keys: [], assetId: "a", limiter: true, kept, origin: null });
  assert.equal(docDistance(ai, ai).changed, false);
  const now: EditDoc = JSON.parse(JSON.stringify(ai));
  now.trim.in -= 4;
  now.layout.panes[0].from = { x: 0, y: 0.5, w: 0.25, h: 0.4 };
  const d = docDistance(ai, now);
  assert.equal(d.changed, true);
  assert.equal(d.start_s, -4);
  assert.equal(d.end_s, 0);
  assert.ok(d.cam_iou! < 0.9 && d.cam_iou! > 0.5);
  assert.equal(d.content_iou, 1);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
function fakeSb() {
  const calls: any = { uploads: [], inserts: [], removed: [] };
  const sb: any = {
    storage: { from: () => ({ upload: async (key: string, body: Buffer) => { calls.uploads.push({ key, bytes: body.length }); return { error: null }; }, remove: async (k: string[]) => { calls.removed.push(...k); return { error: null }; } }) },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { source: { platform: "youtube", url: "https://youtu.be/abcdefghijk", thumbnail_url: "x" } }, error: null }) }) }),
      insert: async (row: any) => { calls.inserts.push({ table, row }); return { error: null }; },
    }),
  };
  return { sb, calls };
}

test("off: no recording kept and no project written", async () => {
  const { sb, calls } = fakeSb();
  const id = await recordClipProject({ ctx: { sb, deps: { env: {} }, u: "u1", dir: "/tmp", src: { video: "/nope.mp4", audio: null, proxy: null, width: 0, height: 0, fps: null },
    format: "vertical", collectionId: "c1", sourceTitle: null, jobId: "j1" } as any, m: m as any, assetId: "a1", info: { ...info, seconds: 38 }, segs: [], frame: { w: 720, h: 1280 }, burned: false, keys: [] });
  assert.equal(id, null);
  assert.equal(calls.uploads.length + calls.inserts.length, 0);
});

test("on: the stretch is kept with its spare seconds and the project written", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "projects-"));
  try {
    const video = join(dir, "src.mp4");
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x90:r=30:d=40", "-f", "lavfi", "-i", "sine=f=440:d=40", "-c:v", "libx264", "-g", "150", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
    assert.equal(g.status, 0, String(g.stderr));
    const { sb, calls } = fakeSb();
    const mm = { ...m, start: 12, end: 20 };
    const id = await recordClipProject({ ctx: { sb, deps: { env: { STUDIO_EDITOR_ENABLED: "true", STUDIO_EDITOR_PAD_S: "5" }, log: () => undefined }, u: "u1", dir,
      src: { video, audio: null, proxy: null, width: 0, height: 0, fps: null }, format: "vertical", collectionId: "c1", sourceTitle: null, jobId: "j1", limiter: false } as any,
      m: mm as any, assetId: "a1", info: { w: 160, h: 90, fps: 30, seconds: 8 }, segs: [{ start: 0, end: 8, mode: "crop", x0: 0.5, x1: 0.5 }], frame: { w: 720, h: 1280 }, burned: false, keys: [] });
    assert.ok(id);
    assert.equal(calls.uploads.length, 1);
    assert.match(calls.uploads[0].key, /^u1\/edit\/[0-9a-f-]{36}\/source\.mp4$/);
    const row = calls.inserts.find((x: any) => x.table === "studio_projects").row;
    assert.equal(row.tool, "clips");
    assert.equal(row.source_ref, "youtube:abcdefghijk");
    assert.equal(row.ai_doc.trim.in, 5);
    assert.equal(row.ai_doc.trim.out, 13);
    assert.ok(Math.abs(row.ai_doc.source.seconds - 18) < 0.3, `kept ${row.ai_doc.source.seconds} s`);
    assert.equal(row.ai_doc.source.origin.thumbnail_url, undefined);
    assert.deepEqual(row.ai_doc, row.doc);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
