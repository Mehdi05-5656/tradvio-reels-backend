import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { higgsfieldAuth, submitRecast, pollRecast, runRecastJob, muxAudio, probeSeconds, makePoster, prescaleSource, probeDimensions, MODELS, MAX_SECONDS, HF_BASE } from "../src/studio-recast.js";
import { quote } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ASSET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", PHOTO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENV = { HIGGSFIELD_API_KEY: "id123:secret456", DASHBOARD_URL: "https://app.clone8.io" };

/** A scripted Higgsfield: records calls, answers submit, then each poll from a queue of statuses. */
function fakeHiggsfield(polls: any[], opts: { submitStatus?: number; presetOk?: boolean; videoBytes?: Buffer } = {}) {
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const res = (status: number, body: any, raw = false) => ({ ok: status >= 200 && status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: opts.presetOk !== false, status: opts.presetOk === false ? 404 : 200 };
    if (url.startsWith(`${HF_BASE}/higgsfield/`)) return opts.submitStatus && opts.submitStatus !== 200 ? res(opts.submitStatus, { error: "nope" }) : res(200, { status: "queued", request_id: "req_1", status_url: `${HF_BASE}/requests/req_1/status`, cancel_url: "x" });
    if (url.startsWith(`${HF_BASE}/requests/`)) { const next = polls.shift() ?? { status: "completed", video: { url: "https://cdn.example/out.mp4" } }; return typeof next === "number" ? res(next, { error: "busy" }) : res(200, next); }
    if (url === "https://cdn.example/out.mp4") return res(200, opts.videoBytes ?? Buffer.from("video-bytes"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchFn, calls };
}

function fakeSb(job: any, opts: { renew?: boolean; completeError?: any; failError?: any; assets?: any[] } = {}) {
  const calls: any[] = [], uploads: any[] = [];
  const assets = opts.assets ?? [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 20 }, name: "talk.mp4" }, { id: PHOTO, user_id: ANN, kind: "image", status: "ready", object_key: `${ANN}/${PHOTO}.jpg` }];
  const sb: any = {
    calls, uploads,
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "studio_renew") return { data: opts.renew !== false, error: null };
      if (name === "studio_complete") return opts.completeError ? { data: null, error: opts.completeError } : { data: { ...job, status: "done" }, error: null };
      if (name === "studio_fail") return opts.failError ? { data: null, error: opts.failError } : { data: { ...job, status: "failed" }, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => { const f: any = {}; const q: any = { select: () => q, eq: (k: string, v: any) => { f[k] = v; return q; }, maybeSingle: async () => ({ data: (table === "studio_assets" ? assets : []).find((a) => Object.entries(f).every(([k, v]) => a[k] === v)) ?? null, error: null }) }; return q; },
    storage: { from: (bucket: string) => ({
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://signed/${bucket}/${key}` }, error: null }),
      download: async (key: string) => ({ data: { arrayBuffer: async () => Buffer.from(`source:${key}`) }, error: null }),
      upload: async (key: string, body: Buffer, o: any) => { uploads.push({ bucket, key, bytes: body.length, type: o.contentType }); return { data: { path: key }, error: null }; },
    }) },
  };
  return sb;
}

const job = (over: any = {}) => ({ id: JOB, user_id: ANN, lease_token: TOKEN, asset_id: ASSET, options: { model: "full", seconds: 20, character: "noah", character_asset_id: null }, credits_reserved: 240, progress: {}, attempts: 1, ...over });
const deps = (fetchFn: any, over: any = {}) => ({ fetch: fetchFn, env: ENV, log: () => undefined, sleep: async () => undefined, prescale: async (_s: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "scaled"); }, mux: async (_r: string, _s: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "muxed"); }, probeSeconds: async () => 19.4, poster: async (_v: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "jpg"); }, ...over });

test("auth header follows the key shape; quotes stop at Higgsfield's limits", () => {
  assert.equal(higgsfieldAuth("id:secret"), "Key id:secret");
  assert.equal(higgsfieldAuth(" hf_token "), "Bearer hf_token");
  assert.equal(MODELS.full, "higgsfield/genjutsu/motion-transfer/v1.0");
  assert.deepEqual(MAX_SECONDS, { full: 30, light: 15 });
  assert.equal(quote("recast", { character: "noah" }, { kind: "video", probe: { duration: 95 } }).options.seconds, 30, "full is priced on the 30 s Higgsfield renders");
  assert.equal(quote("recast", { character: "noah", model: "light" }, { kind: "video", probe: { duration: 95 } }).options.seconds, 15);
});

test("submit sends the documented body and idempotency key; poll reads the video url", async () => {
  const h = fakeHiggsfield([{ status: "in_progress" }]);
  const sub = await submitRecast(deps(h.fetchFn), { model: "full", videoUrl: "https://v", imageUrls: ["https://i"], idempotencyKey: JOB, resolution: "720p" });
  assert.equal(sub.request_id, "req_1");
  assert.equal(h.calls[0].url, `${HF_BASE}/${MODELS.full}`);
  assert.deepEqual(h.calls[0].body, { video_url: "https://v", image_urls: ["https://i"], resolution: "720p" });
  assert.equal(h.calls[0].headers.authorization, "Key id123:secret456");
  assert.equal(h.calls[0].headers["idempotency-key"], JOB);
  assert.equal(h.calls[0].body.resolution, "720p");
  assert.deepEqual(await pollRecast(deps(h.fetchFn), "req_1").then((r) => [r.status, r.videoUrl]), ["in_progress", null]);
  assert.deepEqual(await pollRecast(deps(h.fetchFn), "req_1").then((r) => [r.status, r.videoUrl]), ["completed", "https://cdn.example/out.mp4"]);
});

test("a full recast: submit, wait, fetch, mux the sound back, store, charge the seconds rendered", async () => {
  const h = fakeHiggsfield([{ status: "queued" }, { status: "in_progress" }, { status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sb = fakeSb(job());
  const mux: any[] = [];
  assert.equal(await runRecastJob(sb, deps(h.fetchFn, { mux: async (r: string, s: string, t: string) => { mux.push([r, s]); await (await import("node:fs/promises")).writeFile(t, "muxed"); } }), job()), "done");
  const submit = h.calls.find((c) => c.method === "POST");
  assert.equal(submit.body.video_url, `https://signed/studio-outputs/${ANN}/${JOB}/${TOKEN}/input-720p.mp4`, "the 720p copy is what Higgsfield sees");
  assert.deepEqual(submit.body.image_urls, ["https://app.clone8.io/presets/noah.jpg"]);
  assert.equal(h.calls.filter((c) => c.url.endsWith("/status")).length, 3);
  assert.equal(mux.length, 1, "the full model gets its sound back");
  assert.deepEqual(sb.uploads.map((u: any) => [u.bucket, u.key, u.type]), [["studio-outputs", `${ANN}/${JOB}/${TOKEN}/input-720p.mp4`, "video/mp4"], ["studio-outputs", `${ANN}/${JOB}/${TOKEN}/1.mp4`, "video/mp4"], ["studio-outputs", `${ANN}/${JOB}/${TOKEN}/1.jpg`, "image/jpeg"]]);
  assert.equal(sb.calls.find((c: any) => c.name === "studio_complete").args.p_outputs[0].input_key, `${ANN}/${JOB}/${TOKEN}/input-720p.mp4`);
  const done = sb.calls.find((c: any) => c.name === "studio_complete").args;
  assert.equal(done.p_credits_charged, Math.min(240, 20 * 85), "19.4 s rounds up to 20 s at the full rate, capped at the reservation");
  assert.equal(done.p_outputs[0].audio, "muxed_from_source");
  assert.equal(done.p_outputs[0].request_id, "req_1");
  const notes = sb.calls.filter((c: any) => c.name === "studio_renew").map((c: any) => c.args.p_progress.note);
  assert.ok(notes.includes("Preparing your video") && notes.includes("Sending your video to the renderer") && notes.includes("Rendering your recast") && notes.includes("Putting your sound back"), notes.join(" | "));
  assert.equal(sb.calls.find((c: any) => c.name === "studio_renew" && c.args.p_progress.request_id).args.p_progress.request_id, "req_1", "the request id is written down for a restart");
});

test("light keeps its own audio, a photo is signed, and the charge never exceeds the reservation", async () => {
  const h = fakeHiggsfield([]);
  const sb = fakeSb(job({ options: { model: "light", seconds: 15, character: null, character_asset_id: PHOTO }, credits_reserved: 45 }));
  const mux: any[] = [];
  assert.equal(await runRecastJob(sb, deps(h.fetchFn, { mux: async () => { mux.push(1); }, probeSeconds: async () => 15.9 }), job({ options: { model: "light", seconds: 15, character: null, character_asset_id: PHOTO }, credits_reserved: 45 })), "done");
  assert.equal(mux.length, 0);
  assert.equal(h.calls.find((c) => c.method === "POST").url, `${HF_BASE}/${MODELS.light}`);
  assert.deepEqual(h.calls.find((c) => c.method === "POST").body.image_urls, [`https://signed/studio-uploads/${ANN}/${PHOTO}.jpg`]);
  assert.equal(sb.calls.find((c: any) => c.name === "studio_complete").args.p_credits_charged, 45, "16 s at the Light rate would exceed the 45 reserved");
});

test("a restart resumes polling instead of submitting again", async () => {
  const h = fakeHiggsfield([{ status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sb = fakeSb(job());
  assert.equal(await runRecastJob(sb, deps(h.fetchFn), job({ progress: { request_id: "req_1", submitted_at: new Date().toISOString() }, attempts: 2 })), "done");
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
});

test("failures: Higgsfield failed/nsfw refund for good, a 429 while polling is retried, a bad key is not", async () => {
  for (const [status, code] of [["failed", "recast_failed"], ["nsfw", "recast_nsfw"]] as const) {
    const h = fakeHiggsfield([{ status }]);
    const sb = fakeSb(job());
    assert.equal(await runRecastJob(sb, deps(h.fetchFn), job()), "failed");
    assert.deepEqual([sb.calls.at(-1).args.p_reason, sb.calls.at(-1).args.p_retry], [code, false]);
  }
  const h = fakeHiggsfield([429, { status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sb = fakeSb(job());
  assert.equal(await runRecastJob(sb, deps(h.fetchFn), job()), "done", "a transient 429 is waited out");
  const bad = fakeHiggsfield([], { submitStatus: 401 });
  const sb2 = fakeSb(job());
  assert.equal(await runRecastJob(sb2, deps(bad.fetchFn), job()), "failed");
  assert.deepEqual([sb2.calls.at(-1).args.p_reason, sb2.calls.at(-1).args.p_retry], ["recast_auth", false]);
  const h3 = fakeHiggsfield([], { submitStatus: 503 });
  const sb3 = fakeSb(job());
  assert.equal(await runRecastJob(sb3, deps(h3.fetchFn), job()), "requeued", "a 503 on submit goes back to the queue");
  assert.equal(sb3.calls.at(-1).args.p_retry, true);
});

test("an unpublished preset, a short source and a lost lease each stop cleanly", async () => {
  const h = fakeHiggsfield([], { presetOk: false });
  let sb = fakeSb(job());
  assert.equal(await runRecastJob(sb, deps(h.fetchFn), job()), "failed");
  assert.equal(sb.calls.at(-1).args.p_reason, "character_unavailable");
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent to Higgsfield");
  sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: "k", probe: { duration: 2.5 } }] });
  assert.equal(await runRecastJob(sb, deps(fakeHiggsfield([]).fetchFn), job()), "failed");
  assert.equal(sb.calls.at(-1).args.p_reason, "source_too_short_recast");
  sb = fakeSb(job(), { renew: false });
  assert.equal(await runRecastJob(sb, deps(fakeHiggsfield([]).fetchFn), job()), "lease_lost");
  assert.equal(sb.calls.filter((c: any) => c.name === "studio_fail").length, 0, "a lost lease never refunds: someone else owns the job now");
});

test("an uncertain completion is reported, never turned into a refund", async () => {
  const sb = fakeSb(job(), { completeError: new Error("socket hang up") });
  assert.equal(await runRecastJob(sb, deps(fakeHiggsfield([]).fetchFn), job()), "completion_unconfirmed");
  assert.equal(sb.calls.filter((c: any) => c.name === "studio_fail").length, 0);
  const sb2 = fakeSb(job(), { failError: new Error("down") });
  assert.equal(await runRecastJob(sb2, deps(fakeHiggsfield([{ status: "failed" }]).fetchFn), job()), "failure_unconfirmed");
});

test("real ffmpeg: a 1080×1920 source is scaled to 720×1280 and a landscape one to 1280×720, sound kept", { skip: !hasFfmpeg() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "recast-scale-"));
  try {
    for (const [size, want] of [["1080x1920", [720, 1280]], ["1920x1080", [1280, 720]], ["540x960", [540, 960]]] as const) {
      const src = join(dir, `src-${size}.mp4`), out = join(dir, `out-${size}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
      await prescaleSource(src, out);
      const d = await probeDimensions(out);
      assert.deepEqual([d.width, d.height], want, size);
      const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out]).toString().trim().split("\n").sort();
      assert.deepEqual(streams, ["audio", "video"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: the source audio is muxed onto a silent output, probed and postered", { skip: !hasFfmpeg() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "recast-mux-"));
  try {
    const source = join(dir, "source.mp4"), silent = join(dir, "silent.mp4"), out = join(dir, "out.mp4"), still = join(dir, "out.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", source]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30", "-t", "2.5", "-pix_fmt", "yuv420p", "-c:v", "libx264", silent]);
    await muxAudio(silent, source, out);
    const seconds = await probeSeconds(out);
    assert.ok(seconds > 2.3 && seconds < 2.7, `output keeps its own length (${seconds})`);
    const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out]).toString().trim().split("\n").sort();
    assert.deepEqual(streams, ["audio", "video"]);
    await makePoster(out, still);
    assert.ok((await stat(still)).size > 500);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function hasFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }
