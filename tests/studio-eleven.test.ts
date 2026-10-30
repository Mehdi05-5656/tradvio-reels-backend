import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { allInstruments, instrumentsEnabled, instrumentById, validateParams, tableUnits, tableUsd, unitLabel, quoteInstrument, publicInstrument, runInstrumentJob } from "../src/studio-instruments.js";
import { ELEVEN_BASE, elevenEnabled, matchVoices, listVoices, resetVoiceCache, registerVoices, type Voice } from "../src/studio-eleven.js";
import { PLANS } from "../src/studio.js";
import { buildSystemPrompt } from "../src/studio-knowledge.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", VOICE = "JBFqnCBsd6RMkjVDRZzb";
const ENV = { HIGGSFIELD_API_KEY: "id:secret", ELEVENLABS_API_KEY: "xi-test", STUDIO_INSTRUMENTS_ENABLED: "true" };
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const res = (status: number, body: any, type = "application/json") => ({ ok: status < 300, status, headers: new Headers({ "content-type": type }), text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) });

test("the audio catalog is merged into the instruments, priced from its own table, and only offered with the ElevenLabs key", () => {
  const audio = allInstruments().filter((m) => m.provider === "elevenlabs");
  assert.deepEqual(audio.map((m) => m.id).sort(), ["audio/dubbing", "audio/music", "audio/sound-effects", "audio/text-to-speech", "audio/transcribe", "audio/voice-change", "audio/voice-isolator"]);
  for (const m of audio) { assert.ok(m.pricing && m.pricing.usd > 0, `${m.id} has a price`); assert.ok(["text_to_audio", "audio_edit", "transcribe"].includes(m.kind)); }
  assert.ok(!instrumentsEnabled({ HIGGSFIELD_API_KEY: "k", STUDIO_INSTRUMENTS_ENABLED: "true" }).some((m) => m.provider === "elevenlabs"), "no audio without the key");
  assert.ok(!instrumentsEnabled({ ELEVENLABS_API_KEY: "k", STUDIO_INSTRUMENTS_ENABLED: "true" }).some((m) => m.provider !== "elevenlabs"), "no video models without the platform key");
  assert.equal(instrumentsEnabled({ ELEVENLABS_API_KEY: "k", STUDIO_INSTRUMENTS_ENABLED: "true" }).length, 7);
  assert.equal(elevenEnabled({}), false); assert.equal(elevenEnabled({ ELEVENLABS_API_KEY: "k" }), true);
});

test("audio units: characters in thousands, minutes of the source or the asked length, one sound, hours for transcripts", () => {
  const tts = instrumentById("audio/text-to-speech", ENV)!, vc = instrumentById("audio/voice-change", ENV)!, sfx = instrumentById("audio/sound-effects", ENV)!, music = instrumentById("audio/music", ENV)!, stt = instrumentById("audio/transcribe", ENV)!, dub = instrumentById("audio/dubbing", ENV)!;
  assert.equal(tableUnits(tts, { text: "x".repeat(2500) }, null), 2.5); assert.equal(tableUsd(tts, { text: "x".repeat(2500) }, null), 0.2);
  assert.equal(tableUnits(tts, { text: "hi" }, null), 0.1, "a floor so tiny texts are not free");
  assert.equal(tableUnits(vc, { voice_id: VOICE }, 90), 1.5); assert.equal(tableUsd(vc, {}, 90), 0.18);
  assert.equal(tableUsd(dub, {}, 60), 0.5);
  assert.equal(tableUnits(sfx, { text: "door slam" }, null), 1); assert.equal(tableUsd(sfx, {}, null), 0.1);
  assert.equal(tableUnits(music, { prompt: "lofi", length_seconds: 120 }, null), 2); assert.equal(tableUsd(music, { prompt: "lofi", length_seconds: 120 }, null), 0.3);
  assert.equal(tableUnits(music, { prompt: "lofi" }, null), 0.5, "defaults to thirty seconds");
  assert.equal(tableUnits(stt, {}, 1800), 0.5); assert.equal(tableUsd(stt, {}, 1800), 0.11);
  assert.equal(unitLabel(tts), "1,000 characters"); assert.equal(unitLabel(vc), "a minute"); assert.equal(unitLabel(sfx), "a sound"); assert.equal(unitLabel(stt), "an hour");
  assert.deepEqual(validateParams(tts, { text: "Hello", voice_id: VOICE, model: "expressive" }), { text: "Hello", voice_id: VOICE, model: "expressive" });
  assert.throws(() => validateParams(dub, { target_language: "klingon" }), (e: any) => e.code === "param_invalid");
  assert.throws(() => validateParams(tts, { text: "Hello" }), (e: any) => e.code === "param_required");
});

test("an audio quote never asks the platform for an estimate and names the unit on the card", async () => {
  let platformCalls = 0;
  const fetchFn: any = async () => { platformCalls++; throw new Error("the platform must not be asked"); };
  const q = await quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "audio/voice-change", params: { voice_id: VOICE }, inputs: { video_url: VID } }, async () => new Map([[VID, { url: "https://signed/v.mp4", kind: "video", seconds: 30 }]]));
  assert.equal(platformCalls, 0);
  assert.equal(q.options.priced_by, "table"); assert.equal(q.options.output, "video"); assert.equal(q.options.units, 0.5); assert.equal(q.options.usd, 0.06);
  assert.match(q.summary, /^0\.5 min · \d+$/);
  const t = await quoteInstrument({ fetch: fetchFn, env: ENV }, PLANS, { endpoint: "audio/text-to-speech", params: { text: "Welcome to the show", voice_id: VOICE } }, async () => new Map());
  assert.equal(t.options.output, "audio"); assert.match(t.summary, /characters · \d+$/);
  const pub = publicInstrument(instrumentById("audio/text-to-speech", ENV)!, ENV, PLANS) as any;
  assert.equal(pub.provider, "Clone8", "the vendor is never named");
  assert.equal(pub.price_hint.per, "kchars"); assert.equal(pub.price_hint.unit, "1,000 characters"); assert.ok(pub.price_hint.credits >= 1);
  assert.equal(pub.fields.find((f: any) => f.name === "voice_id").format, "voice");
  assert.equal((publicInstrument(instrumentById("audio/dubbing", ENV)!, ENV, PLANS) as any).fields.find((f: any) => f.name === "target_language").format, "language");
});

test("a voice over runs end to end: the text is spoken, stored as MP3 and completed as an audio output", async () => {
  const calls: any[] = [], uploads: any[] = [], rpc: any[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.startsWith(`${ELEVEN_BASE}/v1/text-to-speech/${VOICE}`)) { assert.equal(init.headers["xi-api-key"], "xi-test"); return res(200, MP3, "audio/mpeg"); }
    throw new Error(`unexpected ${url}`);
  };
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => ({}),
    storage: { from: (bucket: string) => ({ upload: async (key: string, bytes: Buffer, o: any) => { uploads.push({ bucket, key, bytes: bytes.length, type: o.contentType }); return { data: { path: key }, error: null }; } }) },
  };
  const job = { id: JOB, user_id: ANN, tool: "instrument", lease_token: TOKEN, attempts: 1, credits_reserved: 2, progress: {}, options: { endpoint: "audio/text-to-speech", params: { text: "Welcome", voice_id: VOICE, model: "fast" }, inputs: {}, output: "audio" } };
  assert.equal(await runInstrumentJob(sb, { fetch: fetchFn, env: ENV, sleep: async () => undefined }, job as any), "done");
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "Welcome", model_id: "eleven_flash_v2_5" });
  assert.equal(uploads.length, 1); assert.equal(uploads[0].bucket, "studio-outputs"); assert.equal(uploads[0].type, "audio/mpeg"); assert.equal(uploads[0].key, `${ANN}/${JOB}/${TOKEN}/1.mp3`);
  const done = rpc.find((r) => r.name === "studio_complete");
  assert.equal(done.args.p_credits_charged, 2);
  assert.deepEqual(done.args.p_outputs.map((o: any) => [o.kind, o.endpoint]), [["audio", "audio/text-to-speech"]]);
});

test("voice change: the speech is lifted off the clip, spoken in the new voice, put back on the untouched picture, and the older path is tried when the new one is missing", async () => {
  const calls: string[] = [], uploads: any[] = [], rpc: any[] = [], steps: string[] = [];
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push(url);
    if (url.startsWith(`${ELEVEN_BASE}/v1/speech-to-speech/`)) return res(404, { detail: "gone" });
    if (url.startsWith(`${ELEVEN_BASE}/v1/voice-changer/${VOICE}`)) { assert.ok(init.body instanceof FormData); assert.equal(init.body.get("model_id"), "eleven_multilingual_sts_v2"); assert.equal(init.body.get("remove_background_noise"), "true"); return res(200, MP3, "audio/mpeg"); }
    throw new Error(`unexpected ${url}`);
  };
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); if (name === "studio_renew") steps.push(args.p_progress.note); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: VID, object_key: `${ANN}/${VID}.mp4`, status: "ready", probe: { duration: 12 } }, error: null }) }) }) }) }),
    storage: { from: (bucket: string) => ({
      download: async () => ({ data: new Blob([Buffer.from("mp4bytes")]), error: null }),
      upload: async (key: string, bytes: Buffer, o: any) => { uploads.push({ bucket, key, bytes: bytes.length, type: o.contentType }); return { data: { path: key }, error: null }; },
    }) },
  };
  const { writeFile } = await import("node:fs/promises");
  const deps: any = { fetch: fetchFn, env: ENV, sleep: async () => undefined,
    extractAudio: async (_v: string, wav: string) => writeFile(wav, "RIFFwav"),
    replaceAudio: async (_v: string, _a: string, out: string) => writeFile(out, "muxed-video"),
    poster: async (_v: string, still: string) => writeFile(still, "jpg"), probeSeconds: async () => 12 };
  const job = { id: JOB, user_id: ANN, tool: "instrument", lease_token: TOKEN, attempts: 1, credits_reserved: 3, progress: {}, options: { endpoint: "audio/voice-change", params: { voice_id: VOICE, remove_background_noise: true }, inputs: { video_url: VID }, output: "video" } };
  assert.equal(await runInstrumentJob(sb, deps, job as any), "done");
  assert.deepEqual(calls.map((u) => u.replace(ELEVEN_BASE, "").split("?")[0]), [`/v1/speech-to-speech/${VOICE}`, `/v1/voice-changer/${VOICE}`]);
  assert.deepEqual(uploads.map((u) => [u.key.split("/").pop(), u.type]), ["1.mp4", "1.jpg"].map((k, i) => [k, i ? "image/jpeg" : "video/mp4"]));
  assert.ok(steps.includes("Speaking it in the new voice") && steps.includes("Putting the voice back on the picture"));
  const done = rpc.find((r) => r.name === "studio_complete");
  assert.equal(done.args.p_outputs[0].kind, "video"); assert.equal(done.args.p_outputs[0].audio, "replaced"); assert.equal(done.args.p_outputs[0].duration, 12); assert.ok(done.args.p_outputs[0].poster_key.endsWith("/1.jpg"));
});

test("a transcript stores the text and the subtitles; a refused key fails the job without a retry, and an outage requeues it", async () => {
  const uploads: any[] = [], rpc: any[] = [];
  const sbFor = (fetchFn: any) => ({
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: VID, object_key: `${ANN}/${VID}.mp4`, status: "ready", probe: { duration: 40 } }, error: null }) }) }) }) }),
    storage: { from: () => ({ download: async () => ({ data: new Blob([Buffer.from("mp4")]), error: null }), upload: async (key: string, bytes: Buffer, o: any) => { uploads.push({ key, type: o.contentType, text: bytes.toString() }); return { data: { path: key }, error: null }; } }) },
    fetchFn,
  });
  const { writeFile } = await import("node:fs/promises");
  const base: any = { env: ENV, sleep: async () => undefined, extractAudio: async (_v: string, wav: string) => writeFile(wav, "RIFF") };
  const job = () => ({ id: JOB, user_id: ANN, tool: "instrument", lease_token: TOKEN, attempts: 1, credits_reserved: 1, progress: {}, options: { endpoint: "audio/transcribe", params: { diarize: true }, inputs: { video_url: VID }, output: "text" } });
  const ok: any = async (url: string, init: any) => { assert.ok(url.startsWith(`${ELEVEN_BASE}/v1/speech-to-text`)); assert.equal(init.body.get("model_id"), "scribe_v1"); return res(200, { text: "Hello there", language_code: "en", additional_formats: [{ requested_format: "srt", content: "1\n00:00:00,000 --> 00:00:01,000\nHello there\n" }] }); };
  assert.equal(await runInstrumentJob(sbFor(ok) as any, { ...base, fetch: ok }, job() as any), "done");
  assert.deepEqual(uploads.map((u) => [u.key.split("/").pop(), u.type]), [["1.txt", "text/plain"], ["1.srt", "text/plain"]]);
  const done = rpc.find((r) => r.name === "studio_complete");
  assert.equal(done.args.p_outputs[0].kind, "text"); assert.equal(done.args.p_outputs[0].preview, "Hello there"); assert.equal(done.args.p_outputs[0].language, "en"); assert.equal(done.args.p_outputs.length, 2);

  rpc.length = 0;
  const refused: any = async () => res(401, { detail: "bad key" });
  assert.equal(await runInstrumentJob(sbFor(refused) as any, { ...base, fetch: refused }, job() as any), "failed");
  assert.equal(rpc.find((r) => r.name === "studio_fail").args.p_reason, "audio_auth"); assert.equal(rpc.find((r) => r.name === "studio_fail").args.p_retry, false);

  rpc.length = 0;
  const down: any = async () => res(503, "busy");
  assert.equal(await runInstrumentJob(sbFor(down) as any, { ...base, fetch: down }, job() as any), "requeued");
  assert.equal(rpc.find((r) => r.name === "studio_fail").args.p_reason, "audio_unavailable"); assert.equal(rpc.find((r) => r.name === "studio_fail").args.p_retry, true);

  rpc.length = 0;
  assert.equal(await runInstrumentJob(sbFor(ok) as any, { ...base, fetch: ok, env: { ...ENV, ELEVENLABS_API_KEY: undefined } }, job() as any), "failed", "no key: a plain failure, credits back");
  assert.equal(rpc.find((r) => r.name === "studio_fail").args.p_reason, "audio_not_configured");
});

test("voices: the library is fetched once, matched by words in the description, and served without the vendor's name", async () => {
  resetVoiceCache();
  let fetched = 0;
  const library = { voices: [
    { voice_id: "v1", name: "George", labels: { accent: "British", gender: "male", age: "middle_aged", descriptive: "warm" }, preview_url: "https://cdn/v1.mp3", category: "premade" },
    { voice_id: "v2", name: "Sarah", labels: { accent: "American", gender: "female", age: "young", descriptive: "energetic" }, preview_url: "https://cdn/v2.mp3", category: "premade" },
    { voice_id: "v3", name: "Brian", labels: { accent: "American", gender: "male", age: "old", descriptive: "deep" }, preview_url: null, category: "premade" },
  ] };
  const fetchFn: any = async (url: string, init: any) => { fetched++; assert.equal(init.headers["xi-api-key"], "xi-test"); assert.ok(url.startsWith(`${ELEVEN_BASE}/v2/voices`)); return res(200, library); };
  let t = 1_000_000;
  const deps = { fetch: fetchFn, env: ENV, now: () => t };
  const all = await listVoices(deps); await listVoices(deps);
  assert.equal(fetched, 1, "cached"); assert.equal(all.length, 3);
  assert.deepEqual(matchVoices(all, "a warm British man", 2).map((v) => v.name), ["George", "Brian"], "men first, the British one on top");
  assert.equal(matchVoices(all, "young energetic woman", 1)[0].name, "Sarah");
  assert.deepEqual(matchVoices(all, "deep American man", 2).map((v) => v.name), ["Brian", "George"], "accent and gender outrank a sample");
  assert.ok(!matchVoices(all, "a British man", 2).some((v) => v.name === "Sarah"), "no woman for a man when two men exist");
  t += 11 * 60_000; await listVoices(deps); assert.equal(fetched, 2, "refreshed after ten minutes");

  const app = express();
  app.use((req: any, _res, next) => { req.auth = req.headers["x-user"] ? { user_id: String(req.headers["x-user"]) } : undefined; next(); });
  registerVoices(app, deps);
  const server = app.listen(0); const port = (server.address() as any).port;
  try {
    const anon = await fetch(`http://127.0.0.1:${port}/api/studio/voices`); assert.equal(anon.status, 401);
    const r = await fetch(`http://127.0.0.1:${port}/api/studio/voices?q=british`, { headers: { "x-user": ANN } });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.enabled, true); assert.equal(body.voices[0].name, "George"); assert.equal(body.voices[0].preview_url, "https://cdn/v1.mp3");
    assert.ok(!JSON.stringify(body).toLowerCase().includes("eleven"));
    const off = express(); off.use((req: any, _res, next) => { req.auth = { user_id: ANN }; next(); }); registerVoices(off, { env: {} });
    const s2 = off.listen(0); const p2 = (s2.address() as any).port;
    try { const r2: any = await (await fetch(`http://127.0.0.1:${p2}/api/studio/voices`)).json(); assert.deepEqual(r2, { voices: [], enabled: false }); } finally { s2.close(); }
  } finally { server.close(); }
});

test("the prompt names every audio setting, so the model can ask for a 10-second track or a voice id", () => {
  const prompt = buildSystemPrompt({ tools: { blueprint: true, blueprint_plus: true, recast: true, swap: true, restyle: true, trend: true, character: true, instrument: true, assistant: true }, costs: { blueprint_copy: 4, blueprint_plus_copy: 12, recast_second: 72, recast_light_second: 22, character_image: 10 }, plans: PLANS, env: ENV, styles: [], today: "2026-10-29",
    user: { plan: "creator", status: "active", balance: 100, parallel_jobs: 2, assets: [], recent_jobs: [] } });
  const music = prompt.split("\n").find((l) => l.startsWith("- audio/music"))!;
  assert.match(music, /length_seconds 10-300/);
  const tts = prompt.split("\n").find((l) => l.startsWith("- audio/text-to-speech"))!;
  assert.match(tts, /voice_id voice id from preview_voices, required/); assert.match(tts, /model natural\/expressive\/fast/);
  const dub = prompt.split("\n").find((l) => l.startsWith("- audio/dubbing"))!;
  assert.match(dub, /target_language en\/es\/fr/);
});
