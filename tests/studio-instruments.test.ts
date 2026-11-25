import test from "node:test";
import assert from "node:assert/strict";
import { allInstruments, apiPath, instrumentsEnabled, instrumentById, validateParams, validateInputs, buildBody, tableUnits, tableUsd, listPrice, instrumentCredits, quoteInstrument, outputUrls, publicInstrument, runInstrumentJob, KIND_LABEL, FIRST_CLASS, InstrumentError } from "../src/studio-instruments.js";
import { PLANS } from "../src/studio.js";
import { HF_BASE } from "../src/studio-recast.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", IMG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENV = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true" };

test("the catalog is loaded, the first-class Genjutsu endpoints are not offered twice, and every entry has a kind and a schema", () => {
  const all = allInstruments();
  assert.ok(all.length >= 75, `expected the platform catalog, got ${all.length}`);
  for (const id of FIRST_CLASS) assert.ok(!all.some((m) => m.id === id || apiPath(m) === id), `${id} should stay a first-class tool`);
  for (const m of all) {
    assert.ok(KIND_LABEL[m.kind], `${m.id} has an unknown kind ${m.kind}`);
    assert.ok(m.schema?.properties, `${m.id} has no schema`);
    assert.ok(["video", "image", "audio", "text"].includes(m.output));
  }
  assert.ok(all.some((m) => m.id === "bytedance/seedance-2.5/text-to-video"));
  const soul = all.find((m) => m.id === "clone8/soul/v2/standard");
  assert.ok(soul, "vendor-named ids carry a clone8/ alias");
  assert.equal(apiPath(soul!), "higgsfield-ai/soul/v2/standard", "calls still go to the vendor's path");
});

test("nothing that names the vendor reaches a person or the assistant: ids, makers, summaries, notes, doc links", () => {
  for (const m of allInstruments()) {
    const shown = JSON.stringify({ id: m.id, title: m.title, family: m.family, provider: m.provider, summary: m.summary, notes: m.notes, docs: m.docs });
    assert.ok(!/higgsfiel|llms\.txt|documentation index|https?:\/\//i.test(shown), `${m.id} leaks: ${shown.slice(0, 200)}`);
  }
});

test("instruments are closed without the flag, open with it, and narrowed by allow and hidden lists", () => {
  assert.equal(instrumentsEnabled({ HIGGSFIELD_API_KEY: "k" }).length, 0);
  assert.equal(instrumentsEnabled({ STUDIO_INSTRUMENTS_ENABLED: "true" }).length, 0, "no key, no instruments");
  assert.ok(instrumentsEnabled(ENV).length >= 75);
  assert.deepEqual(instrumentsEnabled({ ...ENV, STUDIO_INSTRUMENTS_ALLOW: "z-image/turbo, ideogram/v4.0" }).map((m) => m.id).sort(), ["ideogram/v4.0", "z-image/turbo"]);
  assert.ok(!instrumentsEnabled({ ...ENV, STUDIO_INSTRUMENTS_HIDDEN: "z-image/turbo" }).some((m) => m.id === "z-image/turbo"));
  assert.equal(instrumentById("nope", ENV), null);
});

test("parameters are checked against the model's schema: enums, ranges, whole numbers, unknown names, required fields", () => {
  const seedance = instrumentById("bytedance/seedance-2.5/text-to-video", ENV)!;
  const ok = validateParams(seedance, { prompt: "a cat on a skateboard", duration: "8", resolution: "720p", generate_audio: "false" });
  assert.deepEqual(ok, { prompt: "a cat on a skateboard", duration: 8, resolution: "720p", generate_audio: false });
  assert.throws(() => validateParams(seedance, { prompt: "x", resolution: "8k" }), (e: any) => e instanceof InstrumentError && e.code === "param_invalid");
  assert.throws(() => validateParams(seedance, { prompt: "x", duration: 99 }), (e: any) => e.code === "param_invalid");
  assert.throws(() => validateParams(seedance, { prompt: "x", duration: 4.5 }), (e: any) => e.code === "param_invalid");
  assert.throws(() => validateParams(seedance, { prompt: "x", nonsense: 1 }), (e: any) => e.code === "param_unknown");
  assert.throws(() => validateParams(seedance, {}), (e: any) => e.code === "param_required");
  // media fields are never parameters, even when sent
  const i2v = instrumentById("bytedance/seedance-2.5/image-to-video", ENV)!;
  assert.deepEqual(validateParams(i2v, { prompt: "pan left", image_url: "https://evil.example/x.jpg" }), { prompt: "pan left" });
});

test("media inputs name library assets by id, single or list, and required media is enforced", () => {
  const i2v = instrumentById("bytedance/seedance-2.5/image-to-video", ENV)!;
  assert.deepEqual(validateInputs(i2v, { image_url: IMG }), { image_url: IMG });
  assert.throws(() => validateInputs(i2v, { image_url: "https://x/y.jpg" }), (e: any) => e.code === "input_invalid");
  assert.throws(() => validateInputs(i2v, {}), (e: any) => e.code === "input_required");
  const ref = instrumentById("bytedance/seedance-2.5/reference-to-video", ENV)!;
  assert.deepEqual(validateInputs(ref, { image_urls: [IMG], video_urls: [VID] }), { image_urls: [IMG], video_urls: [VID] });
  assert.throws(() => validateInputs(ref, { image_urls: new Array(31).fill(IMG) }), (e: any) => e.code === "input_invalid");
  // audio references are hidden until the library keeps audio
  assert.deepEqual(validateInputs(ref, { audio_urls: [IMG] }), {});
  assert.throws(() => validateInputs(ref, { bogus: IMG }), (e: any) => e.code === "input_unknown");
  assert.deepEqual(buildBody({ prompt: "p" }, { image_urls: [IMG], video_url: VID }, (id) => `https://signed/${id}`), { prompt: "p", image_urls: [`https://signed/${IMG}`], video_url: `https://signed/${VID}` });
});

test("the list-price table knows the published families and prices in seconds or images; credits clear the margin", () => {
  assert.equal(listPrice("bytedance/seedance-2.5/text-to-video")!.by_resolution!["720p"], 0.463, "Seedance 2.5 by output size; 720p is its default");
  assert.equal(listPrice("bytedance/seedance-2.5/video-edit")!.by_resolution!["720p"], 0.463, "video edit at its 720p list price (our Oct 30 bills match), not the $0.206 'from' price");
  assert.deepEqual(listPrice("lightricks/ltx-2.5/text-to-video/pro"), { per: "second", usd: 0.12 });
  assert.equal(listPrice("kling-video/o3/video-edit")!.by_mode!.std, 0.14, "Kling edit is priced by mode (provisional, Nov 2 2026)");
  const klingEdit = allInstruments().find((m) => apiPath(m) === "kling-video/o3/video-edit")!;
  assert.equal(tableUsd(klingEdit, { mode: "std" }, 14.9), 0.14 * 15, "a 14.9 s source bills as 15 s at the std rate");
  assert.equal(tableUsd(klingEdit, { mode: "pro" }, 9.9), 0.18 * 10, "pro mode has its own rate");
  assert.equal(tableUsd(klingEdit, {}, 9.9), 0.18 * 10, "no mode given: the schema default (pro)");
  assert.deepEqual(listPrice("recraft/v4.1/utility/text-to-image"), { per: "image", usd: 0.035 });
  assert.equal(listPrice("pixverse/v6/text-to-video"), null);
  const seedance = instrumentById("bytedance/seedance-2.5/text-to-video", ENV)!, soul = instrumentById("higgsfield-ai/soul/v2/standard", ENV)!;
  assert.equal(tableUnits(seedance, { duration: 8 }, null), 8);
  assert.equal(tableUnits(seedance, {}, null), 5, "the schema default");
  assert.equal(tableUnits(instrumentById("bytedance/seedance-2.5/video-edit", ENV)!, {}, 6.02), 7, "a source's seconds, rounded up with the tenth added");
  assert.equal(tableUnits(soul, { batch_size: 3 }, null), 3);
  assert.equal(Math.round(tableUsd(seedance, { duration: 10 }, null)! * 1000) / 1000, 4.63, "720p by default");
  assert.equal(Math.round(tableUsd(seedance, { duration: 10, resolution: "480p" }, null)! * 1000) / 1000, 1.45, "480p is the page's price");
  const credits = instrumentCredits(2.06, PLANS, {});
  // margin rule: cost at most half of what the credits earn at the cheapest plan's credit value
  const floor = Math.min(...PLANS.flatMap((p) => [(p.monthly_usd * 0.971 - 0.3) / p.credits, (p.annual_usd_per_month * 0.971 - 0.3) / p.credits]));
  assert.ok(credits * floor * 0.5 >= 2.06 - 1e-9, `${credits} credits do not clear the margin`);
  assert.equal(instrumentCredits(0.0001, PLANS, {}), 1);
});

test("a quote prices through the estimate endpoint, falls back to the table, and refuses what it cannot price", async () => {
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === `${HF_BASE}/estimate/bytedance/seedance-2.5/image-to-video`) return { ok: true, status: 200, text: async () => JSON.stringify({ usd: "1.50" }) };
    if (url.startsWith(`${HF_BASE}/estimate/`)) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "no estimate" }) };
    throw new Error(`unexpected ${url}`);
  };
  const assets = async (ids: string[]) => new Map(ids.map((id) => [id, id === IMG ? { url: `https://signed/${id}.jpg`, kind: "image", seconds: null } : { url: `https://signed/${id}.mp4`, kind: "video", seconds: 6 }]));
  const q = await quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "bytedance/seedance-2.5/image-to-video", params: { prompt: "zoom", duration: 6 }, inputs: { image_url: IMG } }, assets);
  assert.equal(q.tool, "instrument"); assert.equal(q.options.priced_by, "estimate"); assert.equal(q.options.usd, 2.778, "an estimate under the list table (it may carry our discount) is raised to list"); assert.equal(q.options.units, 6);
  assert.equal(calls[0].body.image_url, `https://signed/${IMG}.jpg`, "the estimate is asked with the real signed inputs");
  assert.ok(q.credits >= 1); assert.match(q.summary, /6 s · \d+/);
  // table fallback
  const t = await quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "bytedance/seedance-2.5/text-to-video", params: { prompt: "a dog", duration: 4 } }, assets);
  assert.equal(t.options.priced_by, "table"); assert.equal(t.options.usd, 1.852);
  // an image model's summary speaks in images
  const s = await quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "higgsfield-ai/soul/v2/standard", params: { prompt: "portrait", batch_size: 4 } }, assets);
  assert.match(s.summary, /^4 images · /);
  // nothing to price
  await assert.rejects(quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "pixverse/v6/text-to-video", params: { prompt: "x" } }, assets), (e: any) => e.code === "price_unavailable");
  // wrong media kind
  await assert.rejects(quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "bytedance/seedance-2.5/image-to-video", params: { prompt: "x" }, inputs: { image_url: VID } }, assets), (e: any) => e.code === "input_kind");
  // unknown model
  await assert.rejects(quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "nope", params: {} }, assets), (e: any) => e.code === "instrument_unknown");
});

test("outputs are read from a video or an images reply; the public shape lists fields, media and a price hint", () => {
  assert.deepEqual(outputUrls({ status: "completed", video: { url: "https://cdn/x.mp4" } }), { videos: ["https://cdn/x.mp4"], images: [] });
  assert.deepEqual(outputUrls({ images: [{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }] }), { videos: [], images: ["https://cdn/a.png", "https://cdn/b.png"] });
  const p = publicInstrument(instrumentById("bytedance/seedance-2.5/reference-to-video", ENV)!, ENV, PLANS);
  assert.equal(p.kind_label, "Video from references");
  assert.ok(p.fields.some((f) => f.name === "duration" && f.minimum === 4 && f.maximum === 30));
  assert.ok(!p.fields.some((f) => f.name === "image_urls"), "media are not form fields");
  assert.ok(p.media.some((m) => m.name === "image_urls" && m.kind === "image" && m.multiple));
  assert.ok(!p.media.some((m) => m.name === "audio_urls"), "audio stays hidden for now");
  assert.deepEqual(p.price_hint?.per, "second");
});

test("a job runs end to end: inputs signed, request submitted with an idempotency key, polled, the image stored and the reservation charged", async () => {
  const calls: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const res = (status: number, body: any, raw = false) => ({ ok: status < 300, status, headers: new Headers({ "content-type": raw ? "image/png" : "application/json" }), text: async () => (raw ? body : JSON.stringify(body)), arrayBuffer: async () => body });
    if (url === `${HF_BASE}/alibaba/qwen-image-3/edit`) return res(200, { status: "queued", request_id: "req_9" });
    if (url === `${HF_BASE}/requests/req_9/status`) return res(200, { status: "completed", images: [{ url: "https://cdn/out.png" }] });
    if (url === "https://cdn/out.png") return res(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), true);
    throw new Error(`unexpected ${url}`);
  };
  const rpc: any[] = [], uploads: any[] = [];
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [{ id: IMG, object_key: `${ANN}/${IMG}.jpg`, kind: "image", status: "ready" }], error: null }) }) }) }),
    storage: { from: (bucket: string) => ({
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://signed/${bucket}/${key}` }, error: null }),
      upload: async (key: string, bytes: Buffer, o: any) => { uploads.push({ bucket, key, bytes: bytes.length, type: o.contentType }); return { data: { path: key }, error: null }; },
    }) },
  };
  const job = { id: JOB, user_id: ANN, tool: "instrument", lease_token: TOKEN, attempts: 1, credits_reserved: 14, progress: {}, options: { endpoint: "alibaba/qwen-image-3/edit", params: { prompt: "make it night" }, inputs: { image_urls: [IMG] }, usd: 0.04, priced_by: "table", units: 1, output: "image" } };
  const out = await runInstrumentJob(sb, { fetch: fetchFn, env: ENV, sleep: async () => undefined, toJpeg: async (b) => Buffer.concat([Buffer.from("jpg:"), b]) }, job as any);
  assert.equal(out, "done");
  const submit = calls.find((c) => c.url === `${HF_BASE}/alibaba/qwen-image-3/edit`);
  assert.equal(submit.headers["idempotency-key"], JOB);
  assert.deepEqual(submit.body, { prompt: "make it night", image_urls: [`https://signed/studio-uploads/${ANN}/${IMG}.jpg`] });
  assert.equal(uploads.length, 1); assert.equal(uploads[0].bucket, "studio-outputs"); assert.equal(uploads[0].type, "image/jpeg"); assert.match(uploads[0].key, new RegExp(`^${ANN}/${JOB}/${TOKEN}/1\\.jpg$`));
  const done = rpc.find((r) => r.name === "studio_complete");
  assert.equal(done.args.p_credits_charged, 14);
  assert.equal(done.args.p_outputs[0].kind, "image"); assert.equal(done.args.p_outputs[0].endpoint, "alibaba/qwen-image-3/edit");
});

test("a failed render refunds through studio_fail and a provider refusal is named", async () => {
  const fetchFn: any = async (url: string, init: any = {}) => {
    const res = (status: number, body: any) => ({ ok: status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) });
    if (url === `${HF_BASE}/z-image/turbo`) return res(200, { status: "queued", request_id: "req_2" });
    if (url === `${HF_BASE}/requests/req_2/status`) return res(200, { status: "failed", error: "model error" });
    throw new Error(`unexpected ${url}`);
  };
  const rpc: any[] = [];
  const sb: any = { rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : null, error: null }; }, from: () => ({}), storage: { from: () => ({}) } };
  const job = { id: JOB, user_id: ANN, tool: "instrument", lease_token: TOKEN, attempts: 1, credits_reserved: 3, progress: {}, options: { endpoint: "z-image/turbo", params: { prompt: "x" }, inputs: {}, output: "image" } };
  const out = await runInstrumentJob(sb, { fetch: fetchFn, env: ENV, sleep: async () => undefined }, job as any);
  assert.equal(out, "failed");
  const f = rpc.find((r) => r.name === "studio_fail");
  assert.equal(f.args.p_reason, "recast_failed"); assert.equal(f.args.p_retry, false);
});

test("instrument loop: 4 at once every 15 s unless STUDIO_INSTRUMENT_PARALLEL raises it (then every 5 s), capped at 16", async () => {
  const { instrumentLoopSettings } = await import("../src/studio-instruments.js");
  assert.deepEqual(instrumentLoopSettings({}), { parallel: 4, tickMs: 15_000 });
  assert.deepEqual(instrumentLoopSettings({ STUDIO_INSTRUMENT_PARALLEL: "10" }), { parallel: 10, tickMs: 5_000 });
  assert.deepEqual(instrumentLoopSettings({ STUDIO_INSTRUMENT_PARALLEL: "4" }), { parallel: 4, tickMs: 15_000 });
  assert.deepEqual(instrumentLoopSettings({ STUDIO_INSTRUMENT_PARALLEL: "99" }), { parallel: 16, tickMs: 5_000 });
  assert.deepEqual(instrumentLoopSettings({ STUDIO_INSTRUMENT_PARALLEL: "abc" }), { parallel: 4, tickMs: 15_000 });
  assert.deepEqual(instrumentLoopSettings({ STUDIO_INSTRUMENT_PARALLEL: "0" }), { parallel: 4, tickMs: 15_000 });
});

test("the Nov 25 2026 models are offered and priced: Kling 4.0 (+Flash, Image), Seedream 5.0 Pro, MiniMax H3 Highspeed/Lite, Clone8 Halo", () => {
  const on = instrumentsEnabled(ENV, { preview: true });
  for (const id of ["kling-video/v4.0/text-to-video", "kling-video/v4.0/video-edit", "kling-video/v4.0-flash/image-to-video", "kling-image/v4.0/edit", "bytedance/seedream/v5.0/pro/text-to-image", "minimax/h3-highspeed/text-to-video", "minimax/h3-lite/reference-to-video", "clone8/halo/text-to-video"])
    assert.ok(on.some((m) => m.id === id), `${id} should be offered`);
  const kling = instrumentById("kling-video/v4.0/text-to-video", ENV, { preview: true })!;
  assert.equal(Math.round(tableUsd(kling, { duration: 10 }, null)! * 1e4) / 1e4, 1.879, "1080p is its default");
  assert.equal(Math.round(tableUsd(kling, { duration: 10, resolution: "720p" }, null)! * 1e4) / 1e4, 1.257);
  assert.equal(Math.round(tableUsd(instrumentById("kling-video/v4.0/video-edit", ENV, { preview: true })!, { duration: 5, resolution: "720p" }, 5)! * 1e4) / 1e4, 0.772, "edits bill at the with-a-clip rate");
  assert.equal(tableUsd(instrumentById("kling-image/v4.0/text-to-image", ENV, { preview: true })!, { resolution: "8k" }, null), 0.157);
  assert.equal(tableUsd(instrumentById("bytedance/seedream/v5.0/pro/edit", ENV, { preview: true })!, {}, null), 0.108, "2k by default");
  assert.equal(Math.round(tableUsd(instrumentById("minimax/h3-lite/text-to-video", ENV, { preview: true })!, { duration: 10, resolution: "480P" }, null)! * 1e4) / 1e4, 0.25);
  assert.equal(listPrice("minimax/h3/text-to-video")!.usd, 0.13, "the older H3 keeps its own price; the new lines are not caught by its prefix");
  assert.throws(() => validateParams(kling, { prompt: "x", dynamic_range: "hdr" }), /not a setting/, "HDR is priced on top of the table, so it is not offered yet");
  // Halo: a third party's exclusive, offered under a Clone8 name; calls go to the real path, nothing shown names it
  const halo = instrumentById("clone8/halo/image-to-video", ENV, { preview: true })!;
  assert.equal(apiPath(halo), "sand/magi-2/image-to-video");
  assert.equal(halo.provider, "Clone8");
  assert.equal(tableUsd(halo, { duration: 10 }, null), 0.8);
  assert.deepEqual(halo.media_fields, { image_url: "image", end_image_url: "image" });
  const shown = JSON.stringify(publicInstrument(halo, ENV, PLANS));
  assert.ok(!/magi|sand/i.test(shown), `Halo leaks its source: ${shown.slice(0, 300)}`);
  assert.equal(instrumentById("sand/magi-2/text-to-video", ENV, { preview: true })?.id, "clone8/halo/text-to-video", "the real path still resolves (jobs and admin)");
});
