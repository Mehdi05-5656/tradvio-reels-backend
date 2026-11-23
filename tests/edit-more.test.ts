import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { captionDoc, cloneable, ensureProjectFor, keptForEdits, recordCaptionProject } from "../src/edit-more.js";
import { cleanDoc, renderProject, makePreview } from "../src/studio-editor.js";
import { layoutGraph, soundFilter } from "../src/edit-render.js";
import { clipDoc, type EditDoc } from "../src/studio-projects.js";

const U = "11111111-1111-4111-8111-111111111111", ORIG = "22222222-2222-4222-8222-222222222222", COPY = "33333333-3333-4333-8333-333333333333", JOB = "44444444-4444-4444-8444-444444444444";
const style = { id: "bold_pop", y: 0.7 };
const settings = { style, keywords: true, fillers: true, censor: false };
const original = { id: ORIG, object_key: `${U}/${ORIG}.mp4`, probe: { duration: 12.5, width: 1080, height: 1920, title: "My video" } };
const ON = { STUDIO_EDITOR_ENABLED: "true" };
const clipProject = (): EditDoc => clipDoc({ tool: "clips", jobId: "j", m: { rank: 2, start: 100, end: 130, title: "t", hook: "h", score: 80 }, info: { w: 1920, h: 1080, fps: 30 }, dur: 30,
  format: "vertical", frame: { w: 720, h: 1280 }, segs: [{ start: 0, end: 30, mode: "crop", x0: 0.4, x1: 0.6 }], seen: null, trim: null, captions: null, burned: false, keys: [], assetId: ORIG,
  limiter: false, kept: { key: `${U}/edit/p0/source.mp4`, seconds: 60, before: 15, expires: "2026-12-23T00:00:00.000Z" }, origin: null });

test("a captioned upload: the whole picture at the Captions video's own size, read from the original in place, sound as it was", () => {
  const d = captionDoc({ copyId: COPY, jobId: JOB, original, frame: { w: 1080, h: 1920 }, settings, keys: [1], base: null });
  assert.equal(d.made_by.tool, "captions");
  assert.deepEqual([d.source.key, d.source.bucket, d.source.seconds], [`${U}/${ORIG}.mp4`, "studio-uploads", 12.5]);
  assert.deepEqual(d.trim, { in: 0, out: 12.5, keep: null });
  assert.deepEqual(d.canvas, { w: 1080, h: 1920, fps: null, format: "original", keep: true });
  assert.equal(d.layout.type, "original");
  assert.equal(d.captions.on, true); assert.deepEqual(d.captions.style, style); assert.equal(d.captions.words, `captions/${COPY}.json`);
  assert.equal(d.sound.raw, true);
  // the frame the render draws is the Captions video's (1080x1920), not the cutter's 1280 cap
  const g = layoutGraph(d, { w: 1080, h: 1920, fps: 30 });
  assert.deepEqual([g.w, g.h], [1080, 1920]);
  assert.match(g.graph, /^\[0:v\]scale=1080:1920,setsar=1,format=yuv420p\[v\]$/);
  assert.doesNotMatch(soundFilter(d, 12.5), /loudnorm|alimiter/);
});

test("a captioned Clips clip: its project copied (kept recording, trim, framing), captions on in the chosen style", () => {
  const base = clipProject();
  const p = { doc: base, source_key: base.source.key!, source_expires_at: base.source.expires, rev: 1, rendered_rev: 1, render_state: null };
  assert.ok(cloneable(p));
  const d = captionDoc({ copyId: COPY, jobId: JOB, original, frame: { w: 720, h: 1280 }, settings, keys: [], base: p });
  assert.deepEqual(d.source, { ...base.source, bucket: "studio-outputs" });
  assert.deepEqual([d.trim, d.layout, d.canvas], [base.trim, base.layout, base.canvas]);
  assert.equal(d.made_by.tool, "captions");
  assert.equal(d.captions.on, true); assert.deepEqual(d.captions.style, style);
  assert.ok(!d.sound.raw, "a clip's loudness pass stays");
});

test("a clip project is copied only when it matches the library clip and its words are in the recording's time", () => {
  const base = clipProject();
  const p = (x: any) => ({ doc: base, source_key: "k", source_expires_at: null, rev: 1, rendered_rev: 1, render_state: null, ...x });
  assert.ok(cloneable(p({})));
  assert.ok(!cloneable(p({ source_key: null })), "no kept recording");
  assert.ok(!cloneable(p({ source_expires_at: "2020-01-01T00:00:00Z" })), "recording cleared");
  assert.ok(!cloneable(p({ rev: 3, rendered_rev: 2 })), "saved but not rendered: the library clip is older than the file");
  assert.ok(!cloneable(p({ render_state: "failed" })));
  assert.ok(!cloneable(p({ doc: { ...base, extras: { ...base.extras, pause_trim: true } } })), "cut pauses: words in the cut clip's time");
  assert.ok(!cloneable(p({ doc: { ...base, trim: { ...base.trim, keep: [[0, 3]] } } })));
  assert.ok(!cloneable(null));
});

test("the sound stays as it was until the person sets a level; the frame and the source can't be changed by a save", () => {
  const ai = captionDoc({ copyId: COPY, jobId: JOB, original, frame: { w: 1080, h: 1920 }, settings, keys: [], base: null });
  const same = cleanDoc(ai, { ...ai, trim: { in: 1, out: 9 } });
  assert.equal(same.sound.raw, true);
  assert.deepEqual(same.canvas, ai.canvas); assert.deepEqual(same.source, ai.source);
  assert.ok(!cleanDoc(ai, { ...ai, sound: { level: -10 } }).sound.raw, "a level set: the loudness pass is used");
});

// ---------------------------------------------------------------------------------------------------
// A small fake of the database and storage: rows per table, files per bucket
// ---------------------------------------------------------------------------------------------------
function fake(rows: Record<string, any[]>, files: Record<string, Buffer> = {}, paths: Record<string, string> = {}) {
  const log = { uploads: {} as Record<string, number>, bodies: {} as Record<string, any>, removed: [] as string[], downloads: [] as string[], inserts: [] as any[] };
  const from = (name: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null, insert: any = null;
    const list = () => (rows[name] ??= []);
    const hit = () => list().filter((r) => filters.every((f) => f(r)));
    const q: any = {
      select: () => q, order: () => q, limit: () => q, lt: () => q,
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
      neq: (k: string, v: any) => { filters.push((r) => r[k] !== v); return q; },
      is: (k: string, v: any) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      in: (k: string, v: any[]) => { filters.push((r) => v.includes(r[k])); return q; },
      update: (p: any) => { patch = p; return q; },
      insert: (r: any) => { insert = r; return q; },
      maybeSingle: async () => ({ data: hit()[0] ?? null, error: null }),
      then: (f: any, g: any) => {
        let out: any;
        if (insert) {
          if (name === "studio_projects" && list().some((r) => r.asset_id === insert.asset_id)) out = { error: { code: "23505", message: "duplicate" } };
          else { list().push({ ...insert }); log.inserts.push({ table: name, ...insert }); out = { error: null }; }
        } else if (patch) { for (const r of hit()) Object.assign(r, patch); out = { error: null }; }
        else out = { data: hit(), error: null };
        return Promise.resolve(out).then(f, g);
      },
    };
    return q;
  };
  const sb: any = {
    from,
    storage: { from: (bucket: string) => ({
      download: async (k: string) => { log.downloads.push(`${bucket}:${k}`); const b = files[`${bucket}:${k}`]; return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "missing" } }; },
      upload: async (k: string, b: Buffer) => { log.uploads[`${bucket}:${k}`] = b.length; files[`${bucket}:${k}`] = b; if (k.endsWith(".json")) log.bodies[k] = JSON.parse(String(b)); return { error: null }; },
      remove: async (k: string[]) => { log.removed.push(...k.map((x) => `${bucket}:${x}`)); return { error: null }; },
      // a "link" to a stored file: the test's local path for it
      createSignedUrl: async (k: string) => (paths[`${bucket}:${k}`] ? { data: { signedUrl: paths[`${bucket}:${k}`] }, error: null } : { data: null, error: { message: "missing" } }),
    }) },
  };
  return { sb, log, rows };
}
const heard = { v: 1, words: [["hello", 0.5, 0.9, null], ["world", 1.0, 1.4, null]], keys: [1], language: "en", duration: 12.5, at: "x" };

test("a Captions run writes the copy's project: the original read in place, the edited words kept beside it, the copy marked editable", async () => {
  const { sb, log, rows } = fake({ studio_assets: [{ ...original, user_id: U, status: "ready" }, { id: COPY, user_id: U, status: "ready", probe: { captions: { from: ORIG, job_id: JOB } } }] },
    { [`studio-outputs:${U}/captions/${ORIG}.json`]: Buffer.from(JSON.stringify(heard)) });
  const edited = [{ text: "Hello", start: 0.5, end: 0.9, speaker: null, key: false }, { text: "World!", start: 1, end: 1.4, speaker: null, key: true }];
  const id = await recordCaptionProject(sb, { env: ON, log: () => undefined }, { u: U, copyId: COPY, originalId: ORIG, jobId: JOB, words: edited, settings, frame: { w: 1080, h: 1920 } });
  assert.ok(id);
  const p = rows.studio_projects[0];
  assert.deepEqual([p.tool, p.asset_id, p.source_key, p.source_expires_at], ["captions", COPY, `${U}/${ORIG}.mp4`, null]);
  assert.equal(p.doc.source.bucket, "studio-uploads");
  assert.deepEqual(log.bodies[`${U}/edit/${id}/words.json`].words, [["Hello", 0.5, 0.9, null], ["World!", 1, 1.4, null]], "the words the person captioned with");
  assert.deepEqual(p.doc.captions.keys, [1]);
  assert.equal(rows.studio_assets[1].probe.editable, true);
  assert.equal(rows.studio_assets[1].probe.captions.from, ORIG, "the rest of the copy's probe untouched");
  // off: nothing written
  const off = fake({ studio_assets: [{ ...original, user_id: U, status: "ready" }] });
  assert.equal(await recordCaptionProject(off.sb, { env: {}, log: () => undefined }, { u: U, copyId: COPY, originalId: ORIG, jobId: JOB, words: null, settings, frame: { w: 1080, h: 1920 } }), null);
  assert.equal(off.rows.studio_projects, undefined);
});

test("a captioned Clips clip's project shares the clip's kept recording (same key, same expiry)", async () => {
  const base = clipProject();
  const { sb, rows } = fake({
    studio_assets: [{ ...original, user_id: U, status: "ready" }, { id: COPY, user_id: U, status: "ready", probe: {} }],
    studio_projects: [{ id: "p0", user_id: U, asset_id: ORIG, doc: base, source_key: base.source.key, source_expires_at: base.source.expires, rev: 1, rendered_rev: 1, render_state: null }],
  }, { [`studio-outputs:${U}/captions/${ORIG}.json`]: Buffer.from(JSON.stringify(heard)) });
  const id = await recordCaptionProject(sb, { env: ON, log: () => undefined }, { u: U, copyId: COPY, originalId: ORIG, jobId: JOB, words: null, settings, frame: { w: 720, h: 1280 } });
  const p = rows.studio_projects.find((r: any) => r.id === id);
  assert.deepEqual([p.source_key, p.source_expires_at, p.doc.source.bucket, p.doc.layout.type], [base.source.key, base.source.expires, "studio-outputs", "follow"]);
});

test("a Captions video made before: its project is made from its run the first time it opens", async () => {
  const words = [{ text: "edited", start: 0.2, end: 0.6, speaker: null, key: false }];
  const { sb, rows } = fake({
    studio_assets: [{ ...original, user_id: U, status: "ready" }, { id: COPY, user_id: U, status: "ready", probe: { width: 1080, height: 1920, captions: { from: ORIG, job_id: JOB } } }],
    studio_jobs: [{ id: JOB, user_id: U, tool: "captions", options: { items: [{ asset_id: ORIG, words }], style: "bold_pop", keywords: true } }],
  });
  assert.equal(await ensureProjectFor(sb, { env: ON, log: () => undefined }, U, COPY), true);
  assert.equal(rows.studio_projects[0].asset_id, COPY);
  assert.equal(rows.studio_projects[0].doc.captions.on, true);
  // someone else's video, or one with no run, makes nothing
  assert.equal(await ensureProjectFor(sb, { env: ON, log: () => undefined }, "99999999-9999-4999-8999-999999999999", COPY), false);
  const none = fake({ studio_assets: [{ id: COPY, user_id: U, status: "ready", probe: {} }] });
  assert.equal(await ensureProjectFor(none.sb, { env: ON }, U, COPY), false);
});

test("deleting an original that a project reads: its file is kept and the project's source runs out in 30 days", async () => {
  const { sb, rows } = fake({ studio_projects: [{ id: "p1", user_id: U, source_key: `${U}/${ORIG}.mp4`, source_expires_at: null }, { id: "p2", user_id: U, source_key: "other", source_expires_at: null }] });
  const kept = await keptForEdits(sb, U, [`${U}/${ORIG}.mp4`, `${U}/x.mp4`]);
  assert.deepEqual([...kept], [`${U}/${ORIG}.mp4`]);
  const days = (new Date(rows.studio_projects[0].source_expires_at).getTime() - Date.now()) / 86400_000;
  assert.ok(days > 29.9 && days < 30.1, String(days));
  assert.equal(rows.studio_projects[1].source_expires_at, null);
  assert.equal((await keptForEdits(sb, U, [])).size, 0);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("a Captions video made again from its original in the library: the right bucket, its own size, its link to the original kept", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "edit-more-"));
  try {
    const src = join(dir, "o.mp4");
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    assert.equal(g.status, 0, String(g.stderr));
    const orig = { ...original, probe: { duration: 6, width: 360, height: 640 } };
    const ai = captionDoc({ copyId: COPY, jobId: JOB, original: orig, frame: { w: 360, h: 640 }, settings, keys: [], base: null });
    // this Mac's ffmpeg has no libass: the real render runs with captions off, the captions case is checked by its arguments below
    const doc = cleanDoc(ai, { ...ai, trim: { in: 1, out: 5 }, captions: { ...ai.captions, on: false } });
    const { sb, log, rows } = fake({
      studio_projects: [{ id: "p1", user_id: U, asset_id: COPY, ai_doc: ai, doc, rev: 2, source_key: orig.object_key, render_state: "queued", preview_state: "none" }],
      studio_assets: [{ id: COPY, object_key: `${U}/${COPY}.mp4`, probe: { captions: { from: ORIG, job_id: JOB, style: "bold_pop" }, editable: true } }],
    }, { [`studio-uploads:${orig.object_key}`]: await readFile(src) });
    const logs: string[] = [];
    assert.equal(await renderProject(sb, "p1", { env: ON, log: (l) => logs.push(l) }), true, logs.join("\n"));
    assert.ok(log.downloads.includes(`studio-uploads:${orig.object_key}`), "read from the library in place");
    const a = rows.studio_assets[0];
    assert.deepEqual([a.probe.width, a.probe.height], [360, 640]);
    assert.ok(Math.abs(a.probe.duration - 4) < 0.25, String(a.probe.duration));
    assert.equal(a.probe.editable, true);
    assert.deepEqual(log.removed, [`studio-uploads:${U}/${COPY}.mp4`], "the old captioned file goes, never the original");
    // captions on: the original is captioned at its own size
    rows.studio_projects[0].doc = cleanDoc(ai, { ...ai, trim: { in: 1, out: 5 } });
    rows.studio_projects[0].rev = 3;
    let args: string[] = [];
    await renderProject(sb, "p1", { env: ON, log: () => undefined, run: async (x) => { if (!args.length) args = x; throw new Error("stop"); } });
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.match(graph ?? "", /scale=360:640,setsar=1,format=yuv420p/);
    // and the editor's preview of the original, beside the project
    assert.equal(await makePreview(sb, "p1", { env: {}, log: () => undefined }), true);
    assert.equal(rows.studio_projects[0].preview_key, `${U}/edit/p1/preview.mp4`);
    assert.ok(log.uploads[`studio-outputs:${U}/edit/p1/preview.mp4`] > 1000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------
// Split screen
// ---------------------------------------------------------------------------------------------------
import { splitDoc, recordSplitProject, ensureSplitProject } from "../src/edit-more.js";
import { gameWindow } from "../src/splitscreen-layout.js";
const SJOB = "55555555-5555-4555-8555-555555555555";
const splitOptions = { loop_id: "subway-01", layout: { mode: "split", seam: 0.45, swap: false, clip: { zoom: 1.2, cx: 0.5, cy: 0.4 }, game: { zoom: 1, cx: 0.5, cy: 0.5 }, captions: true }, caption_style: "pill", seconds: 6, name: "My video" };

test("a Split screen run's edit file: the original read in place, the run's framing, gameplay and caption look", () => {
  const d = splitDoc({ jobId: SJOB, original, options: splitOptions });
  assert.equal(d.kind, "split"); assert.equal(d.made_by.tool, "splitscreen");
  assert.deepEqual([d.source.key, d.source.bucket, d.trim.in, d.trim.out], [original.object_key, "studio-uploads", 0, 12.5]);
  assert.deepEqual(d.split, { loop_id: "subway-01", layout: splitOptions.layout, caption_style: "pill", seed: SJOB });
  assert.equal(d.captions.on, true);
  assert.deepEqual([d.canvas.w, d.canvas.h], [720, 1280]);
});

test("a saved Split screen file: framing, gameplay and caption look change; an unknown gameplay, the source and the seed don't", () => {
  const ai = splitDoc({ jobId: SJOB, original, options: splitOptions });
  const d = cleanDoc(ai, { ...ai, trim: { in: 2, out: 8 }, split: { loop_id: "subway-02", layout: { ...splitOptions.layout, seam: 0.6, swap: true, captions: false }, caption_style: "one_word", seed: "mine" }, source: { key: "x" } });
  assert.deepEqual(d.trim, { in: 2, out: 8, keep: null });
  assert.deepEqual([d.split!.loop_id, d.split!.layout.seam, d.split!.layout.swap, d.split!.caption_style, d.split!.seed], ["subway-02", 0.6, true, "one_word", SJOB]);
  assert.equal(d.captions.on, false, "captions follow the split's own switch");
  assert.deepEqual(d.source, ai.source);
  assert.equal(cleanDoc(ai, { ...ai, split: { ...ai.split, loop_id: "not-a-loop" } }).split!.loop_id, "subway-01");
  assert.equal(cleanDoc(ai, { ...ai, split: { ...ai.split, layout: { ...ai.split!.layout, seam: 0.95 } } }).split!.layout.seam, 0.7, "the seam stays inside the tool's limits");
});

test("a Split screen run writes its project by the run (no library row), once; an older run gets one when first opened", async () => {
  const { sb, rows } = fake({ studio_assets: [{ ...original, user_id: U, status: "ready" }], studio_jobs: [{ id: SJOB, user_id: U, tool: "splitscreen", status: "done", asset_id: ORIG, options: splitOptions }] },
    { [`studio-outputs:${U}/captions/${ORIG}.json`]: Buffer.from(JSON.stringify(heard)) });
  const id = await recordSplitProject(sb, { env: ON, log: () => undefined }, { u: U, jobId: SJOB, originalId: ORIG, options: splitOptions });
  assert.ok(id);
  assert.deepEqual([rows.studio_projects[0].asset_id, rows.studio_projects[0].job_id, rows.studio_projects[0].tool], [null, SJOB, "splitscreen"]);
  assert.equal(await recordSplitProject(sb, { env: ON, log: () => undefined }, { u: U, jobId: SJOB, originalId: ORIG, options: splitOptions }), id, "a second call finds the same");
  assert.equal(rows.studio_projects.length, 1);
  const older = fake({ studio_assets: [{ ...original, user_id: U, status: "ready" }], studio_jobs: [{ id: SJOB, user_id: U, tool: "splitscreen", status: "done", asset_id: ORIG, options: splitOptions }] });
  assert.equal(await ensureSplitProject(older.sb, { env: ON }, U, SJOB), true);
  assert.equal(await ensureSplitProject(older.sb, { env: ON }, "99999999-9999-4999-8999-999999999999", SJOB), false, "someone else's run");
});

test("a Split screen video made again: the tool's own render, trimmed, in place of the run's output; untouched, the same gameplay stretch", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "edit-split-"));
  try {
    const clip = join(dir, "o.mp4"), game = join(dir, "g.mp4");
    let g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    assert.equal(g.status, 0, String(g.stderr));
    g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=5:d=120", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", game]);
    assert.equal(g.status, 0, String(g.stderr));
    const orig = { ...original, probe: { duration: 6, width: 360, height: 640 } };
    const ai = splitDoc({ jobId: SJOB, original: orig, options: { ...splitOptions, layout: { ...splitOptions.layout, captions: false } } });
    const doc = cleanDoc(ai, { ...ai, trim: { in: 1, out: 5 }, split: { ...ai.split, layout: { ...ai.split!.layout, seam: 0.6 } } });
    const { sb, log, rows } = fake({
      studio_projects: [{ id: "p1", user_id: U, asset_id: null, job_id: SJOB, ai_doc: ai, doc, rev: 2, source_key: orig.object_key, render_state: "queued" }],
      studio_jobs: [{ id: SJOB, user_id: U, tool: "splitscreen", outputs: [{ index: 1, key: `${U}/${SJOB}/t/1.mp4`, kind: "video", tool: "splitscreen", loop: "subway-01" }] }],
    }, {}, { [`studio-uploads:${orig.object_key}`]: clip, ["studio-outputs:splitscreen/library/subway-01.mp4"]: game });
    const args: string[][] = [];
    const run = async (a: string[]) => { args.push(a); const r = spawnSync("ffmpeg", a); if (r.status !== 0) throw new Error(String(r.stderr)); };
    const logs: string[] = [];
    assert.equal(await renderProject(sb, "p1", { env: ON, log: (l) => logs.push(l), run }), true, logs.join("\n"));
    const render = () => args.find((x) => x.includes("-filter_complex"))!;
    const a = render();
    const clipIn = a.findIndex((x) => x.endsWith("clip.mp4"));
    assert.deepEqual(a.slice(clipIn - 3, clipIn), ["-ss", "1.000", "-i"], "the clip read from the edited start");
    // the working copy made exactly as the tool makes it (the same arguments as studio-stunts.ts defaultPrepare)
    const stunts = await readFile("src/studio-stunts.ts", "utf8"); // the tests run from the repository's root
    const vf = args[0][args[0].indexOf("-vf") + 1];
    assert.ok(stunts.includes(`"-vf", "${vf}"`) && stunts.includes(`"-crf", "17", "-g", "15"`), "prepare matches the tool's");
    assert.equal(a[a.indexOf("-t") + 1], "4.00");
    const out = rows.studio_jobs[0].outputs[0];
    assert.match(out.key, new RegExp(`^${U}/${SJOB}/edit-[0-9a-f-]{36}\\.mp4$`));
    assert.ok(log.uploads[`studio-outputs:${out.key}`] > 1000);
    assert.ok(Math.abs(out.duration - 4) < 0.2, String(out.duration));
    assert.equal(out.edited.rev, 2); assert.equal(out.loop, "subway-01");
    assert.equal(rows.studio_projects[0].render_state, "done");
    assert.equal(log.removed.length, 0, "the old output is left for any scheduled post");
    // untouched: the run's own gameplay stretch (gameWindow with the run's id and the working copy's length)
    rows.studio_projects[0].doc = ai; rows.studio_projects[0].rev = 3; args.length = 0;
    assert.equal(await renderProject(sb, "p1", { env: ON, log: () => undefined, run }), true);
    const b = render(), want = gameWindow(120, 6, SJOB).start.toFixed(2);
    const clipAt = b.findIndex((x) => x.endsWith("clip.mp4"));
    assert.notEqual(b[clipAt - 2], "-ss", "untouched: read from the start");
    assert.equal(b[b.indexOf(game) - 1], "-i"); assert.equal(b[b.indexOf(game) - 2], want, "the same stretch of gameplay as the run");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
