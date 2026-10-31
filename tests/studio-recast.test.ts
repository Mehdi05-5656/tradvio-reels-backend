import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { higgsfieldAuth, submitRecast, pollRecast, runRecastJob, muxAudio, probeSeconds, makePoster, prescaleSource, probeDimensions, probeStream, inputScaleFilter, INPUT_MIN_PIXELS, sceneCuts, openingShot, planPieces, chooseEngine, shotPieces, planLongPath, refineJoins, JOIN_OVERLAP, ANCHOR_PROMPT, LONG_ENDPOINT, concatVideos, castPrompt, MODELS, MAX_SECONDS, HF_BASE, endpointFor, SWAP_DEFAULT_PROMPT, isTransientFailure, retryCeilingUsd } from "../src/studio-recast.js";
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
const deps = (fetchFn: any, over: any = {}) => ({ fetch: fetchFn, env: ENV, log: () => undefined, sleep: async () => undefined, prescale: async (_s: string, t: string, max?: number) => { (globalThis as any).__lastPrescaleMax = max; await (await import("node:fs/promises")).writeFile(t, "scaled"); }, mux: async (_r: string, _s: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "muxed"); }, probeSeconds: async () => 19.4, poster: async (_v: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "jpg"); }, motion: async () => [], frame: async (_v: string, t: string) => { await (await import("node:fs/promises")).writeFile(t, "still"); }, ...over });

test("auth header follows the key shape; quotes stop at Higgsfield's limits", () => {
  assert.equal(higgsfieldAuth("id:secret"), "Key id:secret");
  assert.equal(higgsfieldAuth(" hf_token "), "Bearer hf_token");
  assert.equal(MODELS.full, "higgsfield/genjutsu/motion-transfer/v1.0");
  assert.deepEqual(MAX_SECONDS, { full: 30, light: 15 });
  assert.equal(quote("recast", { character: "noah" }, { kind: "video", probe: { duration: 95 } }).options.seconds, 30, "full is priced on the 30 s Higgsfield renders");
  assert.equal(quote("recast", { character: "noah", model: "light" }, { kind: "video", probe: { duration: 95 } }).options.seconds, 96, "light takes the whole clip, in pieces (95.0 s bills 96 at the platform's rounding)");
  assert.equal(quote("recast", { character: "noah", model: "light" }, { kind: "video", probe: { duration: 300 } }).options.seconds, 120, "light caps at 2 minutes");
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
  assert.equal((globalThis as any).__lastPrescaleMax, 30, "the scaled copy is cut to what the model uses, so the bill matches the quote");
  assert.deepEqual(sb.uploads.map((u: any) => [u.bucket, u.key, u.type]), [["studio-outputs", `${ANN}/${JOB}/${TOKEN}/input-720p.mp4`, "video/mp4"], ["studio-outputs", `${ANN}/${JOB}/${TOKEN}/1.mp4`, "video/mp4"], ["studio-outputs", `${ANN}/${JOB}/${TOKEN}/1.jpg`, "image/jpeg"]]);
  assert.equal(sb.calls.find((c: any) => c.name === "studio_complete").args.p_outputs[0].input_key, `${ANN}/${JOB}/${TOKEN}/input-720p.mp4`);
  const done = sb.calls.find((c: any) => c.name === "studio_complete").args;
  assert.equal(done.p_credits_charged, 240, "a 20 s source bills 21 at Higgsfield; the charge is capped at the reservation");
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
  assert.equal(await runRecastJob(sb, deps(h.fetchFn, { mux: async () => { mux.push(1); }, probeSeconds: async () => 15.9, sceneCuts: async () => [] }), job({ options: { model: "light", seconds: 15, max_seconds: 15, character: null, character_asset_id: PHOTO }, credits_reserved: 45 })), "done");
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
  // a bare "failed" on the first claim (attempts 1) is tried once more; on the second claim (attempts 2) it fails for good
  const first = fakeHiggsfield([{ status: "failed" }]);
  const sbFirst = fakeSb(job());
  assert.equal(await runRecastJob(sbFirst, deps(first.fetchFn), job()), "requeued");
  assert.deepEqual([sbFirst.calls.at(-1).args.p_reason, sbFirst.calls.at(-1).args.p_retry], ["recast_failed", true]);
  assert.equal(sbFirst.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress.request_id, null, "the next claim submits afresh");
  for (const [status, code] of [["failed", "recast_failed"], ["nsfw", "recast_nsfw"]] as const) {
    const h = fakeHiggsfield([{ status }]);
    const sb = fakeSb(job({ attempts: 2 }));
    assert.equal(await runRecastJob(sb, deps(h.fetchFn), job({ attempts: 2 })), "failed");
    assert.deepEqual([sb.calls.at(-1).args.p_reason, sb.calls.at(-1).args.p_retry], [code, false]);
  }
  const broke = fakeHiggsfield([{ status: "failed", error: "Your credit balance is too low to complete this request. Please top up your balance and try again." }]);
  const sbb = fakeSb(job());
  assert.equal(await runRecastJob(sbb, deps(broke.fetchFn), job()), "failed");
  assert.deepEqual([sbb.calls.at(-1).args.p_reason, sbb.calls.at(-1).args.p_retry], ["recast_balance", false], "our empty platform balance is not blamed on the customer's video");
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
    for (const [size, want] of [["1080x1920", [720, 1280]], ["1920x1080", [1280, 720]], ["540x960", [540, 960]], ["360x640", [640, 1138]]] as const) {
      const src = join(dir, `src-${size}.mp4`), out = join(dir, `out-${size}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
      await prescaleSource(src, out, size === "540x960" ? 0.5 : undefined);
      const d = await probeDimensions(out);
      if (size === "540x960") assert.ok((await probeSeconds(out)) < 0.8, "the copy is cut to the cap");
      assert.deepEqual([d.width, d.height], want, size);
      const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out]).toString().trim().split("\n").sort();
      assert.deepEqual(streams, ["audio", "video"]);
      const st = await probeStream(out); assert.ok(st.width * st.height >= INPUT_MIN_PIXELS, `${size}: ${st.width}x${st.height} meets the renderer floor`); assert.ok(st.fps && st.fps <= 30.01 && !st.vfr, `${size}: constant rate ${st.fps}`);
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

test("the suite picks the right Genjutsu endpoint and body per tool", async () => {
  assert.equal(endpointFor("swap", "full"), "higgsfield/genjutsu/object-swap/v1.0");
  assert.equal(endpointFor("swap", "light"), "higgsfield/genjutsu-light/object-swap/v1.0");
  assert.equal(endpointFor("trend", "light"), "higgsfield/genjutsu-light/motion-transfer/v1.0");
  assert.equal(endpointFor("restyle", "light"), "higgsfield/genjutsu/restyle/v1.0", "restyle has no light model");
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ request_id: "r1", status: "queued" }), { status: 200 }); };
  await submitRecast({ fetch: fetchFn, env: { HIGGSFIELD_API_KEY: "id:secret" } }, { tool: "swap", model: "full", videoUrl: "https://v/1.mp4", imageUrls: ["https://i/cat.jpg"], prompt: SWAP_DEFAULT_PROMPT, idempotencyKey: "job-1", resolution: "720p" });
  await submitRecast({ fetch: fetchFn, env: { HIGGSFIELD_API_KEY: "id:secret" } }, { tool: "restyle", model: "full", videoUrl: "https://v/1.mp4", imageUrls: [], presetId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "job-2", resolution: "720p" });
  assert.match(calls[0].url, /object-swap\/v1\.0$/); assert.deepEqual(Object.keys(calls[0].body).sort(), ["image_urls", "prompt", "resolution", "video_url"]);
  assert.match(calls[1].url, /restyle\/v1\.0$/); assert.deepEqual(calls[1].body, { video_url: "https://v/1.mp4", preset_id: "11111111-1111-4111-8111-111111111111", resolution: "720p" }, "restyle sends the style id and no empty image list");
});


test("the input scale filter: down to 720p, up to the renderer pixel floor, never past 720 on the short side", () => {
  assert.match(inputScaleFilter(1080, 1920), /min\(1280,iw\)/);
  assert.match(inputScaleFilter(540, 960), /min\(1280,iw\)/, "540x960 is 518k pixels, above the floor: left alone");
  assert.equal(inputScaleFilter(360, 640), "scale=640:-2");
  assert.equal(inputScaleFilter(640, 360), "scale=-2:640");
  assert.equal(inputScaleFilter(480, 852), "scale=640:-2", "a 480p phone rendition is scaled up");
  assert.match(inputScaleFilter(720, 1280), /min\(1280,iw\)/, "720p stays as it is");
  assert.match(inputScaleFilter(0, 0), /min\(1280,iw\)/, "unknown size: the plain downscale");
});


test("a refused Full clip with a shot change is retried on its opening shot only: the cut is found, kept on the job, used for the cut and the bill", async () => {
  // first claim: refused; the shot changes at 6.9, 7.37 and 9.7 s inside the 20 s window, so the retry is set up on the first 6.9 s
  const first = fakeHiggsfield([{ status: "failed" }]);
  const sbFirst = fakeSb(job());
  const seen: any[] = [];
  const out1 = await runRecastJob(sbFirst, deps(first.fetchFn, { sceneCuts: async (_p: string, within: number) => { seen.push(within); return [6.9, 7.37, 9.7]; } }), job({ options: { model: "full", seconds: 20, character: "noah", character_asset_id: null }, credits_reserved: 1440 }));
  assert.equal(out1, "requeued"); assert.deepEqual(seen, [30], "Full's window is 30 s whatever the quote said");
  const renewed = sbFirst.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress;
  assert.equal(renewed.cut_at, 6.9); assert.match(renewed.note, /opening shot only \(6\.9 s\)/); assert.equal(renewed.request_id, null);
  // second claim: the cut travels in progress, the copy is cut there, and the charge follows the cut, not the 15 s window
  const second = fakeHiggsfield([{ status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sbSecond = fakeSb(job());
  const out2 = await runRecastJob(sbSecond, deps(second.fetchFn, { probeSeconds: async () => 6.9 }), job({ attempts: 2, progress: { cut_at: 6.9 }, options: { model: "full", seconds: 20, character: "noah", character_asset_id: null }, credits_reserved: 1440 }));
  assert.equal(out2, "done");
  assert.equal((globalThis as any).__lastPrescaleMax, 6.9, "the copy sent is cut at the shot change");
  const done = sbSecond.calls.find((c: any) => c.name === "studio_complete").args;
  assert.ok(done.p_credits_charged % 7 === 0 && done.p_credits_charged < 1440, `7 billed seconds at the Full rate, under the 20 s reservation: ${done.p_credits_charged}`);
  assert.equal(done.p_outputs[0].cut_at, 6.9); assert.match(done.p_outputs[0].note, /first shot change \(6\.9 s\)/);
  // no cut inside the window, or a cut too early to leave 4 s: the plain retry
  const h3 = fakeHiggsfield([{ status: "failed" }]); const sb3 = fakeSb(job());
  assert.equal(await runRecastJob(sb3, deps(h3.fetchFn, { sceneCuts: async () => [2.1] }), job({ options: { model: "full", seconds: 20, character: "noah", character_asset_id: null } })), "requeued");
  const r3 = sb3.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress; assert.equal(r3.cut_at, null); assert.equal(r3.note, "The renderer gave up once; trying again");
  assert.equal(openingShot([2.1, 6.9]), 6.9); assert.equal(openingShot([]), null); assert.equal(openingShot([3.9]), null); assert.equal(openingShot([12.26]), 12.2);
});

test("real ffmpeg: a hard cut between two different pictures is found, a steady picture reports none", { skip: !hasFfmpeg() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "recast-cuts-"));
  try {
    const a = join(dir, "a.mp4"), b = join(dir, "b.mp4"), both = join(dir, "both.mp4"), list = join(dir, "list.txt");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", a]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "smptebars=size=320x240:rate=25", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", b]);
    await writeFile(list, `file '${a}'\nfile '${b}'\n`);
    execFileSync("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", both]);
    const cuts = await sceneCuts(both, 6);
    assert.equal(cuts.length, 1); assert.ok(Math.abs(cuts[0] - 3) < 0.1, `cut near 3 s, got ${cuts[0]}`);
    assert.deepEqual(await sceneCuts(a, 3), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("pieces: at most 30 s each, ending on a camera change when one falls late in a piece, never shorter than 4 s", () => {
  assert.deepEqual(planPieces(12, []), [{ start: 0, end: 12 }]);
  assert.deepEqual(planPieces(43.5, [6.9, 7.37, 9.7, 22.1]), [{ start: 0, end: 22.1 }, { start: 22.1, end: 43.5 }], "the podcast clip: two pieces, split at the last cut before 30 s");
  assert.deepEqual(planPieces(60, []), [{ start: 0, end: 30 }, { start: 30, end: 60 }]);
  assert.deepEqual(planPieces(62, []), [{ start: 0, end: 30 }, { start: 30, end: 58 }, { start: 58, end: 62 }], "a short tail keeps at least 4 s");
  assert.deepEqual(planPieces(31, []), [{ start: 0, end: 27 }, { start: 27, end: 31 }]);
  assert.deepEqual(planPieces(40, [2, 38.5]), [{ start: 0, end: 30 }, { start: 30, end: 40 }], "cuts too early or too close to the end are not used");
  for (const p of planPieces(120, [29, 59.5, 90])) assert.ok(p.end - p.start <= 30.001 && p.end - p.start >= 3.999, JSON.stringify(p));
  assert.equal(chooseEngine("swap", "light", 12, []), "genjutsu"); assert.equal(chooseEngine("swap", "light", 15, [6.9]), "seedance"); assert.equal(chooseEngine("swap", "light", 44, []), "seedance");
  assert.equal(chooseEngine("swap", "full", 44, [6.9]), "genjutsu", "Full stays on Genjutsu"); assert.equal(chooseEngine("restyle", "light", 44, []), "genjutsu");
  assert.equal(chooseEngine("recast", "light", 10, [0.2]), "genjutsu", "a cut in the first half second is the clip starting, not a shot change");
});

test("the long path by cost: a 44 s multi-shot Light swap renders shot by shot on Light (about $10.20, not about $21 on Seedance), short shots padded and cut back", async () => {
  const calls: any[] = [];
  const LIGHT = `${HF_BASE}/${endpointFor("swap", "light")}`;
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (url === LIGHT || url === `${HF_BASE}/${LONG_ENDPOINT}`) { const n = calls.filter((c) => c.method === "POST").length; return res(200, { status: "queued", request_id: `piece_${n}` }); }
    const m = url.match(/\/requests\/(piece_\d+)\/status$/); if (m) return res(200, { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
    if (url.startsWith("https://cdn.example/piece_")) return res(200, Buffer.from("video"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const prescales: any[] = [], joined: any[] = [], muxed: any[] = [], padded: number[] = [], trimmed: number[] = [];
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 43.5 }, name: "podcast.mp4" }] });
  const d = deps(fetchFn, {
    sceneCuts: async () => [6.9, 7.37, 9.7, 22.1],
    prescale: async (_s: string, t: string, max?: number, start?: number) => { prescales.push([start ?? 0, max]); await wf(t, "piece"); },
    pad: async (_s: string, t: string, secs: number) => { padded.push(secs); await wf(t, "padded"); },
    trim: async (_s: string, t: string, secs: number) => { trimmed.push(secs); await wf(t, "trimmed"); },
    join: async (files: string[], blends: number[], t: string) => { joined.push([files.length, blends]); await wf(t, "joined"); },
    mux: async (r: string, s: string, t: string) => { muxed.push([r.split("/").pop(), s.split("/").pop()]); await wf(t, "final"); },
    probeSeconds: async () => 43.4,
  });
  const out = await runRecastJob(sb, d, job({ tool: "swap", options: { model: "light", seconds: 44, character: "noah", character_asset_id: null }, credits_reserved: 44 * 22 }));
  assert.equal(out, "done");
  assert.deepEqual(prescales, [[9.7, 12.4], [0, 6.9], [6.9, 0.47], [7.37, 2.33], [22.1, 10.7], [32.3, 11.2]], "the longest shot renders first (the character reference); one piece a shot; the 21.4 s shot split in two, the second half starting 0.5 s early to fade over");
  assert.deepEqual(padded, [4, 4], "the two shots under 4 s are held to 4 s"); assert.deepEqual(trimmed, [0.47, 2.33], "and cut back after");
  const submits = calls.filter((c) => c.method === "POST");
  assert.ok(submits.every((c) => c.url === LIGHT), "every piece goes to Light");
  assert.match(submits[0].body.prompt, /Replace the person/); assert.equal(submits[0].body.resolution, "720p");
  assert.equal(submits[0].headers["idempotency-key"], `${JOB}:1:4`, "the anchor piece is the fourth shot"); assert.equal(submits[1].headers["idempotency-key"], `${JOB}:1:1`);
  assert.equal(submits[0].body.image_urls.length, 1, "the anchor piece has only the character");
  for (const sub of submits.slice(1)) { assert.equal(sub.body.image_urls.length, 2); assert.match(sub.body.image_urls[1], /anchor\.jpg/); assert.ok(sub.body.prompt.endsWith(ANCHOR_PROMPT)); }
  assert.deepEqual(joined, [[6, [0, 0, 0, 0, 0, 0.5]]], "hard cuts at the camera changes, one fade inside the long shot"); assert.deepEqual(muxed, [["joined.mp4", "original.mp4"]], "the person's own sound goes back on the joined picture");
  const done = sb.calls.find((c: any) => c.name === "studio_complete").args;
  assert.equal(done.p_outputs[0].piece_engine, "light"); assert.equal(done.p_outputs[0].pieces, 6); assert.equal(done.p_outputs[0].audio, "muxed_from_source");
  // settled on what the plan cost us ($10.20: 51 billed Light seconds) at the premium margin, which is above 44 s x the
  // per-second price and under the 968 reserved
  assert.equal(done.p_credits_charged, 793, "the long path is charged on its real plan");
  const plan = planLongPath(43.5, [6.9, 7.37, 9.7, 22.1], {});
  assert.equal(plan.engine, "light"); assert.equal(plan.usd, 10.2, "51 billed seconds: the fade overlap adds one"); assert.ok(plan.other_usd > 20 && plan.other_usd < 21.5);
  assert.equal(planLongPath(43.5, [6.9, 7.37, 9.7, 22.1], { HIGGSFIELD_DISCOUNT: "0.15" }).usd, 8.67, "the account's Genjutsu discount lowers Light, not Seedance");
});

test("the long path by cost: many very short shots stay on Seedance, in up to 30 s pieces", async () => {
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (url === `${HF_BASE}/${LONG_ENDPOINT}`) { const n = calls.filter((c) => c.url === url).length; return res(200, { status: "queued", request_id: `piece_${n}` }); }
    const m = url.match(/\/requests\/(piece_\d+)\/status$/); if (m) return res(200, { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
    if (url.startsWith("https://cdn.example/piece_")) return res(200, Buffer.from("video"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const cuts = Array.from({ length: 39 }, (_, i) => i + 1); // a cut every second: 40 one-second shots
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 40 }, name: "fast.mp4" }] });
  const out = await runRecastJob(sb, deps(fetchFn, { sceneCuts: async () => cuts, prescale: async (_s: string, t: string) => { await wf(t, "piece"); }, concat: async (_f: string[], t: string) => { await wf(t, "j"); }, mux: async (_r: string, _s: string, t: string) => { await wf(t, "f"); }, probeSeconds: async () => 40 }), job({ options: { model: "light", seconds: 40, character: "noah", character_asset_id: null }, credits_reserved: 40 * 22 }));
  assert.equal(out, "done");
  const submits = calls.filter((c) => c.method === "POST");
  assert.ok(submits.length === 2 && submits.every((c) => c.url === `${HF_BASE}/${LONG_ENDPOINT}`), "two Seedance pieces");
  assert.equal(submits[0].body.generate_audio, false); assert.equal(submits[0].body.resolution, "720p");
  assert.equal(sb.calls.find((c: any) => c.name === "studio_complete").args.p_outputs[0].piece_engine, "seedance");
});

test("the long path: shots, costs and the Seedance-only retry", () => {
  assert.deepEqual(shotPieces(12, []), [{ start: 0, end: 12 }]);
  assert.deepEqual(shotPieces(31, []), [{ start: 0, end: 10.33 }, { start: 10.33, end: 20.67 }, { start: 20.67, end: 31 }], "a long shot in even parts, leaving room for the fade-in overlap");
  assert.equal(shotPieces(29, []).length, 2); assert.equal(shotPieces(29.5, []).length, 3, "two 14.75 s halves plus a 0.5 s overlap would pass Light's 15 s");
  assert.deepEqual(shotPieces(10, [0.2, 5, 9.8]), [{ start: 0, end: 5 }, { start: 5, end: 10 }], "cuts at the very start or end are not shots");
  assert.equal(planLongPath(44, [], {}).engine, "light");
  assert.equal(planLongPath(44, [], {}, true).engine, "seedance", "after Light refused the clip, Seedance only");
  assert.equal(planLongPath(60, Array.from({ length: 14 }, (_, i) => (i + 1) * 4), {}).engine, "seedance", "more pieces than the platform runs together");
  const cheapSeed = planLongPath(20, [5, 10, 15], { HIGGSFIELD_SEEDANCE_DISCOUNT: "0.9" });
  assert.equal(cheapSeed.engine, "seedance", "the cheaper one wins when the discounts change");
});

test("a Light clip refused by Genjutsu is not moved to the dearer renderer on its own: refunded, with the high-capacity route offered at its price", async () => {
  const h = fakeHiggsfield([{ status: "failed" }]);
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 15 }, name: "clip.mp4" }] });
  const out = await runRecastJob(sb, deps(h.fetchFn, { sceneCuts: async () => [] }), job({ options: { model: "light", seconds: 15, max_seconds: 15, character: "noah", character_asset_id: null }, credits_reserved: 240 }));
  assert.equal(out, "failed");
  assert.equal(sb.calls.find((c: any) => c.name === "studio_fail").args.p_reason, "light_refused");
  const offer = sb.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress.offer;
  assert.equal(offer.engine, "seedance"); assert.ok(offer.credits > 240, "the dearer route costs more, and says so");
  assert.ok(!h.calls.some((c: any) => c.url.includes("seedance")), "nothing was sent to the dearer renderer");
});


test("real ffmpeg: a piece is cut from the middle of a clip, and two rendered pieces join into one track of the summed length", { skip: !hasFfmpeg() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "recast-join-"));
  try {
    const src = join(dir, "src.mp4"), piece = join(dir, "piece.mp4"), a = join(dir, "a.mp4"), b = join(dir, "b.mp4"), out = join(dir, "out.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
    await prescaleSource(src, piece, 2.5, 3);
    const d = await probeSeconds(piece); assert.ok(Math.abs(d - 2.5) < 0.15, `a 2.5 s piece from second 3, got ${d}`);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=24", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", a]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "smptebars=size=720x1280:rate=30", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", b]);
    await concatVideos([a, b], out);
    const total = await probeSeconds(out); assert.ok(Math.abs(total - 5) < 0.2, `2 s + 3 s joins to ${total}`);
    const st = await probeStream(out); assert.deepEqual([st.width, st.height, st.hasAudio], [720, 1280, false], "one picture track, 720 wide, sound added later");
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("cast: each person's character goes to the renderer in left-to-right order with words saying who plays whom", async () => {
  const PHOTO2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const h = fakeHiggsfield([{ status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 8 }, name: "trio.mp4" }, { id: PHOTO, user_id: ANN, kind: "image", status: "ready", object_key: `${ANN}/${PHOTO}.jpg` }, { id: PHOTO2, user_id: ANN, kind: "image", status: "ready", object_key: `${ANN}/${PHOTO2}.jpg` }] });
  const cast = [{ character: null, character_asset_id: PHOTO2, label: "left, blue top" }, { character: "noah", character_asset_id: null, label: "middle" }, { character: null, character_asset_id: PHOTO, label: "right, cap" }];
  const out = await runRecastJob(sb, deps(h.fetchFn, { sceneCuts: async () => [] }), job({ tool: "recast", options: { model: "light", seconds: 8, character: null, character_asset_id: PHOTO2, cast }, credits_reserved: 8 * 22 }));
  assert.equal(out, "done");
  const submit = h.calls.find((c) => c.method === "POST");
  assert.deepEqual(submit.body.image_urls, [`https://signed/studio-uploads/${ANN}/${PHOTO2}.jpg`, "https://app.clone8.io/presets/noah.jpg", `https://signed/studio-uploads/${ANN}/${PHOTO}.jpg`], "one reference per person, in order");
  assert.match(submit.body.prompt, /reference image 1 is the first person from the left \(left, blue top\); reference image 2 is the second person from the left \(middle\); reference image 3 is the third person from the left \(right, cap\)/);
  assert.equal(sb.calls.find((c: any) => c.name === "studio_complete").args.p_outputs[0].cast, 3);
  assert.equal(castPrompt([{ label: "x" }]), "", "one person needs no words");
});

test("a trend the person brought is rendered from their clip, not the catalog, and long ones take the long path", async () => {
  const h = fakeHiggsfield([{ status: "completed", video: { url: "https://cdn.example/out.mp4" } }]);
  const sb = fakeSb(job());
  const out = await runRecastJob(sb, deps(h.fetchFn, { sceneCuts: async () => [] }), job({ tool: "trend", options: { model: "light", seconds: 15, max_seconds: 15, trend_id: null, trend_name: "Car 24", character: "noah", character_asset_id: null } }));
  assert.equal(out, "done");
  assert.ok(!h.calls.some((c) => c.method === "HEAD" && /\/trends\//.test(c.url)), "no catalog clip is looked up");
  assert.equal(h.calls.find((c) => c.method === "POST").url, `${HF_BASE}/${MODELS.light}`, "a short single-shot brought trend stays on Genjutsu");
  assert.equal(chooseEngine("trend", "light", 40, []), "seedance");
});

test("the long path stops paying for the other pieces when one is refused", async () => {
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const res = (status: number, body: any) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (init.method === "POST" && (url === `${HF_BASE}/${LONG_ENDPOINT}` || /genjutsu-light\//.test(url))) { const n = calls.filter((c) => c.method === "POST").length; return res(200, { status: "queued", request_id: `piece_${n}` }); }
    if (/\/requests\/piece_[34]\/status$/.test(url)) return res(200, { status: "in_progress" });
    if (/\/requests\/piece_[34]\/cancel$/.test(url)) return res(200, { status: "cancelled" });
    if (url.endsWith("/requests/piece_1/status")) return res(200, { status: "in_progress" });
    if (url.endsWith("/requests/piece_2/status")) return res(200, { status: "failed", error: "Generation failed" });
    if (url.endsWith("/requests/piece_1/cancel")) return res(200, { status: "cancelled" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 50 }, name: "long.mp4" }] });
  const out = await runRecastJob(sb, deps(fetchFn, { env: { ...ENV, STUDIO_RECAST_ANCHOR: "off" }, sceneCuts: async () => [], prescale: async (_s: string, t: string) => { await wf(t, "piece"); } }), job({ attempts: 2, options: { model: "light", seconds: 50, character: "noah", character_asset_id: null }, credits_reserved: 50 * 22 }));
  assert.equal(out, "failed");
  assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/requests/piece_1/cancel")), "the piece still rendering is cancelled");
  assert.equal(sb.calls.at(-1).args.p_reason, "light_refused", "a refused Light piece offers the high-capacity route");
});

test("a long-path job that stopped half way through sending sends only the pieces still missing", async () => {
  const calls: any[] = [];
  const LIGHT = `${HF_BASE}/${endpointFor("swap", "light")}`;
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (url === LIGHT) return res(200, { status: "queued", request_id: "piece_new" });
    const m = url.match(/\/requests\/(piece_\w+)\/status$/); if (m) return res(200, { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
    if (url.startsWith("https://cdn.example/")) return res(200, Buffer.from("video"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 30 }, name: "two.mp4" }] });
  const half = { engine: "seedance", piece_engine: "light", submitted_at: new Date().toISOString(), pieces: [{ start: 0, end: 15, request_id: "piece_old", input_key: "k1", engine: "light" }, { start: 15, end: 30, request_id: null, input_key: null, engine: "light" }] };
  const out = await runRecastJob(sb, deps(fetchFn, { env: { ...ENV, STUDIO_RECAST_ANCHOR: "off" }, sceneCuts: async () => [15], prescale: async (_s: string, t: string) => { await wf(t, "piece"); }, join: async (f: string[], _b: number[], t: string) => { assert.equal(f.length, 2); await wf(t, "j"); }, concat: async (f: string[], t: string) => { assert.equal(f.length, 2); await wf(t, "j"); }, mux: async (_r: string, _s: string, t: string) => { await wf(t, "f"); }, probeSeconds: async () => 30 }), job({ tool: "swap", attempts: 2, progress: half, options: { model: "light", seconds: 30, character: "noah", character_asset_id: null }, credits_reserved: 30 * 22 }));
  assert.equal(out, "done");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "only the missing piece is sent; the first is not paid for twice");
});

test("joins inside a shot move to the calmest moment nearby and overlap for a fade; joins on camera changes stay hard cuts", () => {
  // a 30 s single shot split in three; the picture is busy around 10 s and 20 s and still at 9 s and 21.5 s
  const motion: Array<[number, number]> = Array.from({ length: 301 }, (_, i) => { const t = i / 10; return [t, Math.abs(t - 9) < 0.3 || Math.abs(t - 21.5) < 0.3 ? 0.001 : 0.2]; });
  const out = refineJoins([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }], [], motion, 15);
  assert.deepEqual(out.map((p) => [p.start, p.end, p.blend]), [[0, 9], [8.5, 21.5], [21, 30]].map(([a, b], i) => [a, b, i ? JOIN_OVERLAP : 0]));
  for (const p of out) assert.ok(p.end - p.start <= 15 && p.end - p.start >= 4, JSON.stringify(p));
  const cut = refineJoins([{ start: 0, end: 7 }, { start: 7, end: 14 }], [7], motion, 15);
  assert.deepEqual(cut.map((p) => [p.start, p.end, p.blend]), [[0, 7, 0], [7, 14, 0]], "a join on a camera change is left alone");
  const flat = refineJoins([{ start: 0, end: 10 }, { start: 10, end: 20 }], [], [], 15);
  assert.deepEqual(flat.map((p) => [p.start, p.end, p.blend]), [[0, 10, 0], [9.5, 20, JOIN_OVERLAP]], "without motion data the join stays, still faded");
});

test("the character reference: off by setting, and never with several people", async () => {
  const LIGHT = `${HF_BASE}/${endpointFor("swap", "light")}`;
  const run = async (env: any, cast: any) => {
    const calls: any[] = [];
    const fetchFn: any = async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
      const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
      if (init.method === "HEAD") return { ok: true, status: 200 };
      if (url === LIGHT) { const n = calls.filter((c) => c.method === "POST").length; return res(200, { status: "queued", request_id: `piece_${n}` }); }
      const m = url.match(/\/requests\/(piece_\d+)\/status$/); if (m) return res(200, { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
      if (url.startsWith("https://cdn.example/")) return res(200, Buffer.from("video"), true);
      if (/presets|signed/.test(url)) return res(200, {});
      throw new Error(`unexpected fetch ${url}`);
    };
    const { writeFile: wf } = await import("node:fs/promises");
    const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 24 }, name: "two.mp4" }, { id: PHOTO, user_id: ANN, kind: "image", status: "ready", object_key: `${ANN}/${PHOTO}.jpg` }] });
    const out = await runRecastJob(sb, deps(fetchFn, { env: { ...ENV, ...env }, sceneCuts: async () => [12], prescale: async (_s: string, t: string) => { await wf(t, "p"); }, concat: async (_f: string[], t: string) => { await wf(t, "j"); }, probeSeconds: async () => 24 }), job({ tool: "swap", options: { model: "light", seconds: 24, character: "noah", character_asset_id: null, ...(cast ? { cast } : {}) }, credits_reserved: 24 * 22 }));
    assert.equal(out, "done");
    return calls.filter((c) => c.method === "POST").map((c) => c.body.image_urls.length);
  };
  assert.deepEqual(await run({}, null), [1, 2], "on by default: the second piece gets the still");
  assert.deepEqual(await run({ STUDIO_RECAST_ANCHOR: "off" }, null), [1, 1]);
  assert.deepEqual(await run({}, [{ character: "noah", character_asset_id: null }, { character: null, character_asset_id: PHOTO }]), [2, 2], "two people: no extra still");
});


test("retries: a renderer that timed out or was busy goes again on the same engine; only a plain refusal moves route", async () => {
  assert.equal(isTransientFailure({ status: "failed", error: "Generation took too long to complete. Please try again later." }), true);
  assert.equal(isTransientFailure({ error: "Service temporarily unavailable" }), true);
  assert.equal(isTransientFailure({ error: "Too many requests" }), true);
  assert.equal(isTransientFailure({ status: "failed" }), false, "a bare failure is the clip being refused");
  assert.equal(isTransientFailure({ error: "Generation failed" }), false);
  // the kid's swap on Oct 30: Light timed out, and the old code moved it to Seedance at 2.7x the cost
  const h = fakeHiggsfield([{ status: "failed", error: "Generation took too long to complete. Please try again later." }]);
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 4.4 }, name: "dance.mp4" }] });
  const out = await runRecastJob(sb, deps(h.fetchFn, { sceneCuts: async () => [], probeSeconds: async () => 4.4 }), job({ tool: "swap", options: { model: "light", seconds: 5, character: "noah", character_asset_id: null }, credits_reserved: 80 }));
  assert.equal(out, "requeued");
  const renewed = sb.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress;
  assert.notEqual(renewed.engine, "seedance"); assert.equal(renewed.seedance_only, undefined, "same engine, same price"); assert.match(renewed.note, /busy/);
  assert.equal(renewed.request_id, null, "a fresh request on the next attempt");
});

test("a retry forced onto Seedance must pay for itself: the cheaper plan when it fits, a refund when nothing does", async () => {
  // 80 credits at the lowest net price a credit sells for, less the 20% minimum margin: about $1.03 to spend
  const ceiling = retryCeilingUsd(80, 0.016089);
  assert.ok(ceiling > 1 && ceiling < 1.05);
  assert.equal(retryCeilingUsd(80, null), Infinity, "no price known: no cap");
  const LIGHT = `${HF_BASE}/${endpointFor("swap", "light")}`, LONG = `${HF_BASE}/${LONG_ENDPOINT}`;
  const run = async (credits: number) => {
    const calls: any[] = [];
    const fetchFn: any = async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
      if (init.method === "HEAD") return { ok: true, status: 200 };
      if (url === LIGHT || url === LONG) return res(200, { status: "queued", request_id: "piece_1" });
      if (/\/requests\/piece_1\/status$/.test(url)) return res(200, { status: "completed", video: { url: "https://cdn.example/piece_1.mp4" } });
      if (url === "https://cdn.example/piece_1.mp4") return res(200, Buffer.from("video"), true);
      throw new Error(`unexpected fetch ${url}`);
    };
    const { writeFile: wf } = await import("node:fs/promises");
    const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 4.4 }, name: "dance.mp4" }] });
    const d = deps(fetchFn, { sceneCuts: async () => [], prescale: async (_s: string, t: string) => { await wf(t, "piece"); }, pad: async (_s: string, t: string) => { await wf(t, "p"); }, trim: async (_s: string, t: string) => { await wf(t, "t"); }, join: async (_f: string[], _b: number[], t: string) => { await wf(t, "j"); }, concat: async (_f: string[], t: string) => { await wf(t, "j"); }, mux: async (_r: string, _s: string, t: string) => { await wf(t, "f"); }, probeSeconds: async () => 4.4 });
    const out = await runRecastJob(sb, d, job({ tool: "swap", options: { model: "light", seconds: 5, character: "noah", character_asset_id: null }, credits_reserved: credits, attempts: 2, progress: { engine: "seedance", seedance_only: true } }));
    return { out, posts: calls.filter((c) => c.method === "POST").map((c) => c.url), sb };
  };
  const fits = await run(80);
  assert.equal(fits.out, "done");
  assert.ok(fits.posts.length > 0 && fits.posts.every((u) => u === LIGHT), "Seedance (about $2.30) is over budget, so the clip goes to Light (about $0.50)");
  const none = await run(5);
  assert.notEqual(none.out, "done");
  assert.equal(none.posts.length, 0, "nothing is sent when even the cheaper plan would lose money");
  assert.ok(none.sb.calls.some((c: any) => c.name === "studio_fail"), "the job fails and the reserved credits are refunded");
});


test("the long path: a piece the renderer timed out on is sent again on its own; the others keep rendering", async () => {
  const LIGHT = `${HF_BASE}/${endpointFor("swap", "light")}`;
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (url === LIGHT) { const n = calls.filter((c) => c.method === "POST").length; return res(200, { status: "queued", request_id: `piece_${n}` }); }
    if (/piece_2\/status$/.test(url)) return res(200, { status: "failed", error: "Generation took too long to complete. Please try again later." });
    if (/piece_\d+\/status$/.test(url)) return res(200, { status: "in_progress" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 20 }, name: "long.mp4" }] });
  const out = await runRecastJob(sb, deps(fetchFn, { sceneCuts: async () => [], prescale: async (_s: string, t: string) => { await wf(t, "piece"); }, env: { ...ENV, STUDIO_RECAST_ANCHOR: "off" } }), job({ tool: "swap", options: { model: "light", seconds: 20, character: "noah", character_asset_id: null }, credits_reserved: 20 * 22 }));
  assert.equal(out, "requeued", "not failed: nothing is refunded and nothing already paid for is thrown away");
  const pieces = sb.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress.pieces;
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].request_id, "piece_1", "the healthy piece keeps its request");
  assert.equal(pieces[1].request_id, null, "only the timed-out piece is sent again");
  assert.ok(!calls.some((c) => /\/cancel$/.test(c.url)), "nothing is cancelled");
});


test("busy after every retry: refunded as renderer_busy, with the high-capacity route offered", async () => {
  const h = fakeHiggsfield([{ status: "failed", error: "Generation took too long to complete. Please try again later." }]);
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 4.4 }, name: "dance.mp4" }] });
  const out = await runRecastJob(sb, deps(h.fetchFn, { sceneCuts: async () => [], probeSeconds: async () => 4.4 }), job({ tool: "swap", attempts: 3, options: { model: "light", seconds: 5, character: "noah", character_asset_id: null }, credits_reserved: 80 }));
  assert.equal(out, "failed");
  assert.equal(sb.calls.find((c: any) => c.name === "studio_fail").args.p_reason, "renderer_busy");
  const p = sb.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress;
  assert.ok(p.offer.credits > 80); assert.ok(p.spend_usd > 0, "what the attempt cost us is on the job");
});

test("the high-capacity route, once the person picks it: priced on the quote, sent to Seedance from the start", async () => {
  const video = { kind: "video", probe: { duration: 4.4 } };
  const std = quote("swap", { model: "light", character: "noah" }, video), high = quote("swap", { model: "light", character: "noah", engine: "seedance" }, video);
  assert.equal(high.options.engine, "seedance"); assert.equal(std.options.engine, undefined);
  assert.ok(high.credits > std.credits * 1.8, `the dearer route is priced as such (${std.credits} vs ${high.credits})`);
  assert.equal(quote("swap", { model: "full", character: "noah", engine: "seedance" }, video).options.engine, undefined, "only Light has the option");
  const posts: string[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    if (init.method === "POST") posts.push(url);
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (init.method === "HEAD") return { ok: true, status: 200 };
    if (init.method === "POST") return res(200, { status: "queued", request_id: "piece_1" });
    if (/piece_1\/status$/.test(url)) return res(200, { status: "completed", video: { url: "https://cdn.example/piece_1.mp4" } });
    if (url === "https://cdn.example/piece_1.mp4") return res(200, Buffer.from("video"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const { writeFile: wf } = await import("node:fs/promises");
  const sb = fakeSb(job(), { assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${ASSET}.mp4`, probe: { duration: 4.4 }, name: "dance.mp4" }] });
  const out = await runRecastJob(sb, deps(fetchFn, { sceneCuts: async () => [], prescale: async (_s: string, t: string) => { await wf(t, "piece"); }, concat: async (_f: string[], t: string) => { await wf(t, "j"); }, join: async (_f: string[], _b: number[], t: string) => { await wf(t, "j"); }, mux: async (_r: string, _s: string, t: string) => { await wf(t, "f"); }, probeSeconds: async () => 4.4 }), job({ tool: "swap", options: high.options, credits_reserved: high.credits }));
  assert.equal(out, "done");
  assert.ok(posts.length && posts.every((u) => u === `${HF_BASE}/${LONG_ENDPOINT}`), "straight to the high-capacity renderer, no Light attempt first");
  assert.ok(sb.calls.find((c: any) => c.name === "studio_complete").args.p_credits_charged <= high.credits, "never more than the price on the button");
});
