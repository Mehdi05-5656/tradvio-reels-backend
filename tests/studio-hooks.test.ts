import test from "node:test";
import assert from "node:assert/strict";
import { CAST, castById, castFor, castPortraitPrompt, publicCast } from "../src/studio-cast.js";
import { HOOK_ENGINE, HOOK_FORMATS, HOOK_VOICES, hookSeconds, hookStillRecipe, withHookRecipe, addHookVoice, HookError } from "../src/studio-hooks.js";
import { instrumentById, validateParams, validateInputs } from "../src/studio-instruments.js";

const ENV = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true" };
const IMG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("the cast: unique ids and names, every member has a real voice and a niche, nobody under 20", () => {
  const ids = new Set<string>(), names = new Set<string>();
  for (const c of CAST) {
    assert.ok(!ids.has(c.id) && !names.has(c.name), `${c.id} twice`); ids.add(c.id); names.add(c.name);
    assert.match(c.voice.id, /^[A-Za-z0-9]{20}$/, `${c.id}: voice id`);
    assert.ok(c.niches.length > 0);
    assert.match(castPortraitPrompt(c), /adult/);
  }
  assert.ok(CAST.length >= 24);
  // presenters for tech and apps (where the same voice twice would be most noticed in a set of hooks) all sound different
  for (const n of ["tech", "app"]) { const v = CAST.filter((c) => c.niches.includes(n)).map((c) => c.voice.id); assert.equal(new Set(v).size, v.length, `${n}: two presenters share a voice`); }
});

test("characters without a picture are drafts for admins only; the page never gets the look recipe", () => {
  assert.equal(castFor().length, CAST.filter((c) => c.image).length);
  assert.equal(castFor({ admin: true }).length, CAST.length);
  for (const c of CAST) { const p: any = publicCast(c); assert.equal(p.look, undefined); assert.equal(typeof p.voice, "string"); assert.ok(!JSON.stringify(p).includes(c.voice.id)); }
  assert.equal(castById("maya")?.name, "Maya");
});

test("the picture step: every format's recipe passes the image model, character first and product second", () => {
  const inst = instrumentById("bytedance/seedream/v5.0/pro/edit", ENV, { preview: true })!;
  for (const f of HOOK_FORMATS) {
    const r = hookStillRecipe(f.id, "a bright kitchen");
    assert.doesNotThrow(() => validateParams(inst, r), f.id);
    assert.match(r.prompt, /first picture[\s\S]*second picture/);
    assert.match(r.prompt, /never invent text/);
    assert.equal(r.aspect_ratio, "9:16");
  }
  assert.throws(() => hookStillRecipe("nope", ""), (e: any) => e instanceof HookError);
});

test("the video step: both tiers pass their models, the length follows the line", () => {
  const line = "Wait, don't scroll, this little can is the reason my afternoons got easier to get through.";
  for (const tier of ["best", "standard"] as const) {
    const inst = instrumentById(HOOK_ENGINE[tier], ENV, { preview: true })!;
    const params = withHookRecipe({ line, tier }, {});
    assert.doesNotThrow(() => validateParams(inst, params), tier);
    assert.doesNotThrow(() => validateInputs(inst, tier === "best" ? { image_urls: [IMG] } : { image_url: IMG }), tier);
    assert.match(params.prompt, /No text, no captions, no music/);
  }
  assert.match(withHookRecipe({ line, tier: "best" }, {}).prompt, /<<<image_1>>>[\s\S]*<<<audio_1>>>/);
  assert.equal(hookSeconds("one two three", "best"), 4, "Seedance needs at least 4 s");
  assert.equal(hookSeconds("one two three", "standard"), 3);
  assert.ok(hookSeconds(line, "best") >= 7 && hookSeconds(line, "best") <= 9);
  assert.equal(hookSeconds("word ".repeat(80), "standard"), 15, "Wan stops at 15 s");
});

test("at run time the voice joins the request: Seedance takes a list, Wan one url; the cost is booked", async () => {
  const uploads: string[] = [];
  const sb: any = { storage: { from: () => ({ upload: async (k: string) => { uploads.push(k); return { error: null }; }, createSignedUrl: async () => ({ data: { signedUrl: "https://signed/voice.mp3" }, error: null }) }) } };
  const voice = HOOK_VOICES[0].id;
  const best: any = {}, std: any = {};
  await addHookVoice(sb, { env: {}, tts: async () => Buffer.from("mp3") }, { id: "j1", user_id: "u1", options: { hook: { line: "Okay this is the thing", tier: "best", voice } } }, best);
  await addHookVoice(sb, { env: {}, tts: async () => Buffer.from("mp3") }, { id: "j2", user_id: "u1", options: { hook: { line: "Okay this is the thing", tier: "standard", voice } } }, std);
  assert.deepEqual(best.audio_urls, ["https://signed/voice.mp3"]); assert.equal(std.audio_url, "https://signed/voice.mp3");
  assert.deepEqual(uploads, ["u1/j1/work/voice.mp3", "u1/j2/work/voice.mp3"]);
  await assert.rejects(addHookVoice(sb, { env: {}, tts: async () => Buffer.from("") }, { id: "j3", user_id: "u1", options: { hook: { line: "x y z", voice: "not-a-voice" } } }, {}), (e: any) => e instanceof HookError);
});

test("a Best hook's own voice is laid where the rendered speech is: the lag is found from loudness", async () => {
  const { bestLag, envelope } = await import("../src/studio-hooks.js");
  // a voice with three bursts, and a clip carrying the same bursts 360 ms later plus a little noise
  const voice = Array.from({ length: 300 }, (_, i) => (i % 100 < 30 ? 1000 : 50));
  const clip = [...Array(36).fill(60), ...voice.map((v, i) => v * 0.8 + (i % 7) * 10), ...Array(40).fill(60)];
  const m = bestLag(clip, voice);
  assert.equal(m.lag, 36); assert.ok(m.r > 0.9);
  const pcm = Buffer.alloc(16000 * 2); for (let i = 0; i < 8000; i++) pcm.writeInt16LE(i < 4000 ? 8000 : 0, i * 2);
  const env = envelope(pcm); assert.equal(env.length, 100); assert.ok(env[0] > 7000 && env[30] === 0);
});

test("a translated hook: the length follows the language's script, the prompt names the language, English stays as it was", async () => {
  const { spokenUnits, languageName, HOOK_LANGUAGES } = await import("../src/studio-hooks.js");
  assert.equal(languageName("es"), "Spanish"); assert.equal(languageName("xx"), null);
  assert.ok(HOOK_LANGUAGES.length >= 12 && HOOK_LANGUAGES.some((l) => l.id === "ja"));
  // Japanese has no spaces: counted by characters, not as one "word"
  const ja = "このエナジードリンク、砂糖ゼロなんです。知ってました？";
  assert.ok(spokenUnits(ja, "ja") > 8, "a Japanese line is not one word long");
  assert.ok(hookSeconds(ja, "standard", "ja") >= 5);
  assert.equal(spokenUnits("uno dos tres", "es"), 3);
  const es = withHookRecipe({ line: "Todo el mundo cree que las bebidas energéticas necesitan azúcar.", tier: "best", language: "es" }, {});
  assert.match(es.prompt, /says the Spanish words in <<<audio_1>>>/);
  assert.match(withHookRecipe({ line: "Everyone thinks energy drinks need sugar.", tier: "standard" }, {}).prompt, /says the words in the voice recording/);
});

test("Best hook re-paced by the engine: its speech is turned into the character's voice, timing and picture kept", async (t) => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { t.skip("no ffmpeg"); return; }
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { restoreHookVoice } = await import("../src/studio-hooks.js");
  const dir = await mkdtemp(join(tmpdir(), "hook-test-"));
  const clip = join(dir, "clip.mp4"), voice = join(dir, "voice.mp3"), swap = join(dir, "swap.mp3");
  // the clip speaks in three bursts with pauses; our recording is one unbroken stretch (the live case: r 0.25)
  const burst = (a: number, b: number) => `between(t,${a},${b})`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x112:d=6:r=10", "-f", "lavfi", "-i", `aevalsrc='sin(2*PI*220*t)*(${burst(0.6, 3)}+${burst(3.5, 4.5)}+${burst(4.8, 5.1)})':s=16000:d=6`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*200*t)*(0.5+0.5*sin(2*PI*7*t))':s=16000:d=3.4", "-c:a", "libmp3lame", voice]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*880*t)':s=44100:d=6", "-c:a", "libmp3lame", swap]);
  const voiceBytes = await readFile(voice), before = await readFile(clip);
  const sb: any = { storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array(voiceBytes)]), error: null }) }) } };
  const logs: string[] = []; let sent: { voice_id: string; bytes: number } | null = null;
  const jessica = HOOK_VOICES[0].id;
  const r = await restoreHookVoice(sb, { log: (l) => logs.push(l), voiceChange: async (_d: any, p: any) => { sent = { voice_id: p.voice_id, bytes: p.audio.length }; return readFile(swap); } }, { id: "j1", user_id: "u1", options: { hook: { tier: "best", voice: jessica, line: "x" } } }, clip);
  assert.ok(r && r.changed, JSON.stringify(r)); assert.ok(r!.r < 0.35);
  assert.equal(sent!.voice_id, jessica); assert.ok(sent!.bytes > 100_000, "the clip's own speech is what gets changed");
  assert.ok(logs.some((l) => l.startsWith("[hooks] voice changed to the character's")));
  const after = await readFile(clip); assert.notDeepEqual(after, before);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]).toString());
  assert.ok(Math.abs(dur - 6) < 0.2, `length kept: ${dur}`);
  await writeFile(join(dir, "done"), "");
});
