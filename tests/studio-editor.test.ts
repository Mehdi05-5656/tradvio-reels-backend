import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanDoc, makePreview, renderProject, shiftWords, EditorError } from "../src/studio-editor.js";
import { layoutGraph } from "../src/edit-render.js";
import { clipDoc, type EditDoc } from "../src/studio-projects.js";

const m = { rank: 1, start: 100, end: 130, title: "t", hook: "h", score: 80 };
const cam = { x: 0.02, y: 0.62, w: 0.22, h: 0.36 }, content = { x: 0.26, y: 0, w: 0.6, h: 1 };
const live = (): EditDoc => clipDoc({ tool: "live_clips", jobId: "j", m, info: { w: 1920, h: 1080, fps: 30 }, dur: 30, format: "vertical", frame: { w: 1080, h: 1920 }, segs: [],
  seen: { layout: "stacked", cam, content, irl: false, tiny: false, cam_h: 620 }, trim: null, captions: null, burned: false, keys: [], assetId: "a", limiter: true,
  kept: { key: "u/edit/p/source.mp4", seconds: 60, before: 15, expires: null }, origin: null });

test("a saved file: what a person may change is taken, what describes the recording stays the AI's", () => {
  const ai = live();
  const next: any = JSON.parse(JSON.stringify(ai));
  next.trim = { in: 12, out: 44 }; next.layout.panes[0].from = { x: 0, y: 0.5, w: 0.3, h: 0.5 }; next.layout.divider = 0.4;
  next.source = { key: "someone-else/file.mp4", seconds: 999 }; next.made_by = { tool: "x" }; next.setting = { label: "irl" };
  next.sound = { level: -40, muted: [{ from: 1, to: 2, why: "mine" }] };
  const d = cleanDoc(ai, next);
  assert.deepEqual(d.trim, { in: 12, out: 44, keep: null });
  assert.deepEqual(d.layout.panes[0].from, { x: 0, y: 0.5, w: 0.3, h: 0.5 });
  assert.equal(d.layout.divider, 0.4);
  assert.deepEqual(d.source, ai.source);
  assert.deepEqual(d.made_by, ai.made_by);
  assert.deepEqual(d.setting, { label: "irl", by: "user", sure: 1 });
  assert.equal(d.sound.level, -24);
  assert.equal(d.sound.limiter, true);
  assert.deepEqual(d.sound.muted, [{ from: 1, to: 2, why: "mine", locked: false }]);
});

test("a saved file that cannot render is refused", () => {
  const ai = live();
  assert.throws(() => cleanDoc(ai, { ...ai, trim: { in: 10, out: 10.5 } }), (e: any) => e instanceof EditorError && e.code === "bad_trim");
  assert.throws(() => cleanDoc(ai, { ...ai, layout: { type: "stacked", panes: [] } }), (e: any) => e.code === "bad_layout");
  assert.throws(() => cleanDoc(ai, null), (e: any) => e.code === "bad_doc");
  // locked muted ranges (music the platform muted) cannot be removed
  const lockedAi = { ...ai, sound: { ...ai.sound, muted: [{ from: 20, to: 25, why: "music", locked: true }] } };
  assert.deepEqual(cleanDoc(lockedAi, { ...lockedAi, sound: { muted: [] } }).sound.muted, [{ from: 20, to: 25, why: "music", locked: true }]);
});

test("words move with the start: 3 s earlier start, the words 3 s later; fixed words used; outside words dropped", () => {
  const ai = live();
  const doc = { ...ai, trim: { in: 12, out: 20, keep: null }, captions: { ...ai.captions, fixes: [{ i: 1, text: "Fixed" }] } } as EditDoc;
  const w = shiftWords([["a", 0, 0.4, null], ["b", 1, 1.4, null], ["c", 6, 6.5, null]], ai, doc, [0]);
  assert.deepEqual(w.map((x) => [x.text, x.start, x.key]), [["a", 3, true], ["Fixed", 4, false]]);
});

test("a moved divider: the camera panel takes that share; the frame stays 1080x1920", () => {
  const d = live();
  const same = layoutGraph(d, { w: 1920, h: 1080, fps: 30 }).graph;
  d.layout.divider = 0.4;
  const g = layoutGraph(d, { w: 1920, h: 1080, fps: 30 }).graph;
  assert.notEqual(g, same);
  assert.match(g, /scale=1080:768:/);
  assert.match(g, /scale=1080:1152:/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
function fakeSb(files: Record<string, Buffer>, project: any, asset: any) {
  const state: any = { project: { ...project }, asset: { ...asset }, uploads: {} as Record<string, number>, bodies: {} as Record<string, any>, removed: [] as string[] };
  const table = (name: string) => {
    const row = () => (name === "studio_projects" ? state.project : state.asset);
    const q: any = {
      select: () => q, eq: () => q, in: () => q, lt: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: row(), error: null }),
      update: (patch: any) => { Object.assign(row(), patch); return { eq: () => ({ eq: async () => ({ error: null }), then: (f: any) => Promise.resolve({ error: null }).then(f) }) }; },
    };
    return q;
  };
  const sb: any = {
    from: table,
    storage: { from: () => ({
      download: async (k: string) => (files[k] ? { data: new Blob([files[k]]), error: null } : { data: null, error: { message: "missing" } }),
      upload: async (k: string, b: Buffer) => { state.uploads[k] = b.length; if (k.endsWith('.json')) state.bodies[k] = JSON.parse(String(b)); return { error: null }; },
      remove: async (k: string[]) => { state.removed.push(...k); return { error: null }; },
    }) },
  };
  return { sb, state };
}

test("a re-render from the kept recording replaces the clip in the library", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "editor-r-"));
  try {
    const src = join(dir, "s.mp4");
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=12", "-f", "lavfi", "-i", "sine=f=440:d=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    assert.equal(g.status, 0, String(g.stderr));
    const ai = clipDoc({ tool: "live_clips", jobId: "j", m: { ...m, start: 10, end: 14 }, info: { w: 320, h: 180, fps: 30 }, dur: 4, format: "vertical", frame: { w: 1080, h: 1920 }, segs: [],
      seen: { layout: "stacked", cam: { x: 0, y: 0.5, w: 0.3, h: 0.5 }, content: null, irl: false, tiny: false, cam_h: 620 }, trim: null, captions: null, burned: false, keys: [], assetId: "a1", limiter: true,
      kept: { key: "u1/edit/p1/source.mp4", seconds: 12, before: 4, expires: null }, origin: null });
    const doc = cleanDoc(ai, { ...ai, trim: { in: 2, out: 8 }, layout: { ...ai.layout, divider: 0.45 } });
    // the clip's words, relative to the AI's clip (which starts 4 s into the kept recording)
    const words = { v: 1, words: [["hello", 0.5, 0.9, null], ["there", 1.0, 1.4, null], ["friend", 3.5, 3.9, null]], keys: [], language: "en", duration: 4, at: "x" };
    const { sb, state } = fakeSb({ "u1/edit/p1/source.mp4": await readFile(src), "u1/captions/a1.json": Buffer.from(JSON.stringify(words)) },
      { id: "p1", user_id: "u1", asset_id: "a1", ai_doc: ai, doc, rev: 3, source_key: "u1/edit/p1/source.mp4", render_state: "queued" },
      { object_key: "u1/a1.mp4", probe: { title: "t", poster_key: "u1/assets/a1.jpg", clip: { start: 10, end: 14, rank: 1, job_id: "j" } } });
    const logs: string[] = [];
    const ok = await renderProject(sb, "p1", { env: { STUDIO_EDITOR_ENABLED: "true" }, log: (l) => logs.push(l) });
    assert.equal(ok, true, logs.join("\n"));
    assert.equal(ok, true, state.project.render_error);
    assert.equal(state.project.render_state, "done");
    assert.equal(state.project.rendered_rev, 3);
    assert.equal(state.asset.object_key, "u1/a1-r3.mp4");
    assert.ok(state.uploads["u1/a1-r3.mp4"] > 1000);
    assert.ok(state.uploads["u1/assets/a1-r3.jpg"] > 100); // a new poster per save, never a cached old one
    assert.equal(state.asset.probe.poster_key, "u1/assets/a1-r3.jpg");
    assert.deepEqual([state.asset.probe.clip.start, state.asset.probe.clip.end], [8, 14]); // where the edited clip now sits in the source: origin_at 6 + trim 2..8
    assert.deepEqual(state.removed, ["u1/a1.mp4"]);
    assert.ok(Math.abs(state.asset.probe.duration - 6) < 0.25, `duration ${state.asset.probe.duration}`);
    assert.deepEqual([state.asset.probe.width, state.asset.probe.height], [1080, 1920]);
    assert.equal(state.asset.probe.edited.rev, 3);
    // the AI cut's words kept beside the project; the library clip's word file now matches the edited clip (2 s earlier start)
    assert.deepEqual(state.bodies["u1/edit/p1/words.json"].words, words.words);
    assert.deepEqual(state.bodies["u1/captions/a1.json"].words.map((w: any) => [w[0], w[1]]), [["hello", 2.5], ["there", 3], ["friend", 5.5]]);
    // and the browser preview of the kept recording
    state.project.preview_state = "none";
    assert.equal(await makePreview(sb, "p1", { env: {}, log: () => undefined }), true);
    assert.equal(state.project.preview_state, "ready");
    assert.equal(state.project.preview_key, "u1/edit/p1/preview.mp4");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("no kept recording: the render fails cleanly and says why", async () => {
  const { sb, state } = fakeSb({}, { id: "p2", user_id: "u1", asset_id: "a1", ai_doc: live(), doc: live(), rev: 1, source_key: null }, { object_key: "k" });
  assert.equal(await renderProject(sb, "p2", { env: {}, log: () => undefined }), false);
  assert.equal(state.project.render_state, "failed");
  assert.match(state.project.render_error, /kept recording/i);
});
