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
