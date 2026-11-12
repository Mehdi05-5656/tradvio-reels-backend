import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { toolsEnabled } from "../src/studio.js";
import { resetCutGate } from "../src/studio-capacity.js";
import { autoLayout, quoteSplit, runSplitJob, splitCredits, SplitError } from "../src/studio-splitscreen-job.js";
import type { Loop } from "../src/studio-splitscreen-library.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", J = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ON = { STUDIO_SPLITSCREEN_ENABLED: "true" }, OPEN = { ...ON, STUDIO_SPLITSCREEN_OPEN: "true" };
const LIB: Loop[] = [
  { id: "subway-official", kind: "game", name: "Subway Surfers", seconds: 185, size: { w: 720, h: 1280 }, safe: { x: 0, y: 0.08, w: 1, h: 0.84 }, box: { zoom: 1, cx: 0.5, cy: 0.55 } },
  { id: "bounce-sims-a", kind: "sim", name: "Bouncing balls", seconds: 180, size: { w: 1280, h: 720 }, safe: { x: 0, y: 0, w: 1, h: 1 }, box: { zoom: 1, cx: 0.5, cy: 0.5 } },
];
const asset = (duration = 30) => ({ id: A, kind: "video", name: "podcast.mp4", probe: { duration, width: 1080, height: 1920 } });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e instanceof SplitError ? e.code : `other:${e?.message}`; } return "no error"; };

test("switches: off by default; owner-only until the open switch; the tool list says open only when both are on", () => {
  assert.equal((toolsEnabled({}) as any).splitscreen, false);
  assert.equal((toolsEnabled(ON) as any).splitscreen, false);
  assert.equal((toolsEnabled(OPEN) as any).splitscreen, true);
  assert.equal(code(() => quoteSplit({}, asset(), { loop_id: "subway-official" }, { owner: true }, LIB)), "splitscreen_off");
  assert.equal(code(() => quoteSplit(ON, asset(), { loop_id: "subway-official" }, {}, LIB)), "splitscreen_off");
  assert.equal(code(() => quoteSplit(ON, asset(), { loop_id: "subway-official" }, { owner: true }, LIB)), "no error");
});

test("quote: one credit per 5 s, 5 at least; the loop asked for, or one of the asked kind; the layout made safe", () => {
  assert.equal(splitCredits(3), 5); assert.equal(splitCredits(31), 7); assert.equal(splitCredits(180), 36);
  const q = quoteSplit(OPEN, asset(31), { loop_id: "subway-official", layout: { seam: 0.9, swap: true } }, {}, LIB);
  assert.equal(q.credits, 7);
  assert.equal(q.options.loop_id, "subway-official");
  assert.equal(q.options.layout.seam, 0.7);
  assert.equal(q.options.layout.swap, true);
  assert.equal(quoteSplit(OPEN, asset(), { kind: "sim" }, {}, LIB).options.loop_id, "bounce-sims-a");
  assert.equal(code(() => quoteSplit(OPEN, asset(), { loop_id: "gone" }, {}, LIB)), "splitscreen_no_loop");
  assert.equal(code(() => quoteSplit(OPEN, asset(1), {}, {}, LIB)), "splitscreen_too_short");
  assert.equal(code(() => quoteSplit(OPEN, asset(240), {}, {}, LIB)), "splitscreen_too_long");
  assert.equal(code(() => quoteSplit(OPEN, null, {}, {}, LIB)), "video_not_found");
});

test("autoLayout: the clip's face framed, the loop's own action box, captions on", () => {
  const l = autoLayout({ w: 1080, h: 1920 }, { kind: "face", x: 0.45, y: 0.3, h: 0.3 }, LIB[0]);
  assert.equal(l.seam, 0.45);
  assert.equal(l.clip.cx, 0.45);
  assert.deepEqual(l.game, LIB[0].box);
  assert.equal(l.captions, true);
  assert.deepEqual(autoLayout({ w: 1080, h: 1920 }, null, null).game, { zoom: 1, cx: 0.5, cy: 0.5 });
});

function fakeSb() {
  const rpc: any[] = [], uploads: any[] = [];
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: A, kind: "video", name: "podcast.mp4", object_key: `${U}/x.mp4`, status: "ready", probe: { duration: 31, width: 1080, height: 1920 } }, error: null }) }; return q; },
    storage: { from: (bucket: string) => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x.mp4" }, error: null }), download: async () => ({ data: null, error: { message: "none" } }), upload: async (key: string, body: Buffer, o: any) => { uploads.push({ bucket, key, bytes: body.length, type: o?.contentType }); return { error: null }; } }) },
  };
  return { sb, rpc, uploads };
}
const jobOf = (options: any) => ({ id: J, user_id: U, lease_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", asset_id: A, credits_reserved: 7, attempts: 1, progress: {}, options });

test("a run: the loop's safe area and a stretch inside it, captions on the seam, the clip's sound, charged by length", async () => {
  resetCutGate();
  const { sb, rpc, uploads } = fakeSb();
  let args: string[] = [];
  const out = await runSplitJob(sb, {
    env: {}, log: () => undefined,
    prepare: async (_u, t) => writeFile(t, "clip"), fetchLoop: async (_l, t) => writeFile(t, "loop"),
    words: async () => [{ text: "hello", start: 0.2, end: 0.6 }, { text: "there", start: 0.7, end: 1.1 }],
    render: async (a) => { args = a; await writeFile(a[a.length - 1], "video"); }, poster: async (_v, t) => writeFile(t, "jpg"),
  }, jobOf({ loop_id: "subway-official", layout: { seam: 0.5 }, caption_style: "bold_pop", seconds: 31 }), LIB);
  assert.equal(out, "done");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[1:v\]crop=720:640:0:\d+,scale=720:640/, "the loop is cropped inside its safe area");
  const y = Number(graph.match(/\[1:v\]crop=720:640:0:(\d+)/)![1]);
  assert.ok(y >= 102 && y + 640 <= 1178, `crop rows ${y}..${y + 640} stay inside 102..1178`);
  assert.match(graph, /ass=.*words\.ass/);
  assert.ok(args.includes("-ss"), "a stretch inside the long loop");
  assert.equal(args[args.indexOf("-ss") + 3], "https://signed.example/x.mp4", "read straight from the library, not downloaded whole");
  assert.ok(args.includes("-reconnect"));
  assert.deepEqual(args.slice(args.indexOf("[v]") + 1, args.indexOf("[v]") + 3), ["-map", "0:a:0"]);
  const done = rpc.find((r) => r.name === "studio_complete")!;
  assert.equal(done.args.p_credits_charged, 7);
  assert.deepEqual([done.args.p_outputs[0].tool, done.args.p_outputs[0].loop, done.args.p_outputs[0].captioned], ["splitscreen", "subway-official", true]);
  assert.deepEqual(uploads.map((u) => u.type), ["video/mp4", "image/jpeg"]);
});

test("a run with captions off, or with nobody speaking, makes the video without words; a missing loop fails without a charge", async () => {
  resetCutGate();
  for (const opt of [{ layout: { captions: false } }, { layout: {} }]) {
    const { sb } = fakeSb();
    let graph = "";
    const out = await runSplitJob(sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "c"), fetchLoop: async (_l, t) => writeFile(t, "l"), words: async () => [],
      render: async (a) => { graph = a[a.indexOf("-filter_complex") + 1]; await writeFile(a[a.length - 1], "v"); }, poster: async (_v, t) => writeFile(t, "j") }, jobOf({ loop_id: "bounce-sims-a", seconds: 12, ...opt }), LIB);
    assert.equal(out, "done");
    assert.doesNotMatch(graph, /ass=/);
  }
  const { sb, rpc } = fakeSb();
  const out = await runSplitJob(sb, { env: {}, log: () => undefined }, jobOf({ loop_id: "gone", seconds: 12 }), LIB);
  assert.equal(out, "splitscreen_no_loop");
  assert.ok(rpc.some((r) => r.name === "studio_fail") && !rpc.some((r) => r.name === "studio_complete"));
});

test("a loop shorter than the clip is fetched whole and repeated", async () => {
  resetCutGate();
  const { sb } = fakeSb();
  let args: string[] = [], fetched = 0;
  const short: Loop[] = [{ ...LIB[1], id: "short", seconds: 8 }];
  const out = await runSplitJob(sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "c"), fetchLoop: async (_l, t) => { fetched++; await writeFile(t, "l"); }, words: async () => [],
    render: async (a) => { args = a; await writeFile(a[a.length - 1], "v"); }, poster: async (_v, t) => writeFile(t, "j") }, jobOf({ loop_id: "short", seconds: 20 }), short);
  assert.equal(out, "done");
  assert.equal(fetched, 1);
  assert.deepEqual(args.slice(args.indexOf("-stream_loop"), args.indexOf("-stream_loop") + 2), ["-stream_loop", "-1"]);
  assert.match(args[args.indexOf("-stream_loop") + 3], /game\.mp4$/);
});
