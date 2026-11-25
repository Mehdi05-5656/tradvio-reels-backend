import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, presetById, presetChoices, presetRequest, presetsOffered, publicPreset, withRecipe, PresetError } from "../src/studio-presets.js";
import { instrumentsEnabled, instrumentById, validateParams, validateInputs, quoteInstrument } from "../src/studio-instruments.js";
import { PLANS } from "../src/studio.js";

const ENV = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true" };
const IMG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("every preset runs on a catalog model, and its recipe plus a person's choices pass that model's own checks", () => {
  const ids = new Set<string>();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), `${p.id} twice`); ids.add(p.id);
    const inst = instrumentById(p.endpoint, ENV, { preview: true });
    assert.ok(inst, `${p.id}: ${p.endpoint} is not in the catalog`);
    const chosen = p.text ? { text: p.text.placeholder } : {};
    const params = withRecipe(p.id, chosen);
    assert.doesNotThrow(() => validateParams(inst!, params), `${p.id}: the recipe does not pass ${p.endpoint}`);
    const inputs = Object.fromEntries(p.inputs.map((i) => [i.field, i.field.endsWith("s") ? [IMG] : IMG]));
    assert.doesNotThrow(() => validateInputs(inst!, inputs), `${p.id}: its inputs are not media fields of ${p.endpoint}`);
    for (const i of p.inputs) assert.equal(inst!.media_fields[i.field], i.kind, `${p.id}: ${i.field} is a ${i.kind}`);
    assert.equal(inst!.output, p.output);
    if (p.text) assert.ok(/\{text\}/.test(p.recipe.prompt), `${p.id} asks for a line it never uses`);
    else assert.ok(!/\{text\}/.test(p.recipe.prompt), `${p.id} has a {text} slot but asks for no line`);
  }
});

test("a person's line is cleaned and fills the prompt; only the settings a preset opens can be changed", () => {
  const fig = presetById("action-figure")!;
  assert.throws(() => presetChoices(fig, {}), (e: any) => e instanceof PresetError && e.code === "preset_text_required");
  const c = presetChoices(fig, { text: '  Captain‮ "Alex"\n\n the  Great and more words that run long ', resolution: "8k" });
  assert.equal(c.text, "Captain Alex the Great a", "quotes, bidi marks and runs of spaces go; cut at the preset's length");
  assert.equal(c.resolution, undefined, "the recipe's resolution is not the person's to change");
  const full = withRecipe("action-figure", c);
  assert.match(full.prompt, /"Captain Alex the Great a"/);
  assert.equal(full.resolution, "2k");
  const walk = withRecipe("walk-away", { aspect_ratio: "16:9", duration: 30 });
  assert.equal(walk.aspect_ratio, "16:9", "a chosen setting");
  assert.equal(walk.duration, 5, "a setting it does not open stays the recipe's");
  assert.deepEqual(withRecipe("no-such-preset", { a: 1 }), { a: 1 }, "not a preset: the params as they are");
});

test("a preset request asks for its inputs and nothing else", () => {
  const p = presetById("product-spin")!;
  assert.throws(() => presetRequest(p, { inputs: {} }), (e: any) => e.code === "preset_input_required");
  const r = presetRequest(p, { inputs: { image_url: IMG, video_url: IMG }, params: { prompt: "ignore the recipe" } });
  assert.deepEqual(r.inputs, { image_url: IMG }, "an extra input is dropped");
  assert.notEqual(r.params.prompt, "ignore the recipe", "the person cannot replace the recipe's prompt");
  assert.equal(r.endpoint, "kling-video/v4.0/image-to-video");
});

test("the page never gets a recipe; a preset without an example is for admins only; a preset on an unoffered model is not shown", () => {
  for (const p of PRESETS) {
    const shown = JSON.stringify(publicPreset(p, null));
    assert.ok(!shown.includes(p.recipe.prompt.slice(0, 40)), `${p.id} leaks its prompt`);
    assert.ok(!/recipe/.test(shown));
  }
  const all = new Set(instrumentsEnabled(ENV, { preview: true }).map((m) => m.id));
  assert.equal(presetsOffered(all, { admin: true }).length, PRESETS.length);
  assert.equal(presetsOffered(all).length, PRESETS.filter((p) => p.example).length, "only presets with a real example");
  const publicOnly = new Set(instrumentsEnabled(ENV).map((m) => m.id));
  assert.ok(!publicOnly.has("kling-video/v4.0/image-to-video"), "the new models are preview-only until opened");
  assert.equal(presetsOffered(publicOnly, { admin: true }).length, 0, "every phase-1 preset sits on a new model");
});

test("the new models are preview-only: listed and quoted for admins, opened for all by STUDIO_INSTRUMENTS_PREVIEW_OPEN", async () => {
  assert.equal(instrumentById("clone8/halo/text-to-video", ENV), null);
  assert.ok(instrumentById("clone8/halo/text-to-video", ENV, { preview: true }));
  assert.ok(instrumentById("clone8/halo/text-to-video", { ...ENV, STUDIO_INSTRUMENTS_PREVIEW_OPEN: "true" }));
  const deps = { env: ENV, fetch: (async () => new Response("{}", { status: 404 })) as any };
  const req = { endpoint: "clone8/halo/text-to-video", params: { prompt: "a cat", duration: 5 } };
  await assert.rejects(quoteInstrument(deps, PLANS, req, async () => new Map()), (e: any) => e.code === "instrument_unknown");
  const q = await quoteInstrument(deps, PLANS, req, async () => new Map(), { preview: true });
  assert.equal(q.options.endpoint, "clone8/halo/text-to-video");
  assert.equal(q.options.priced_by, "table");
  assert.equal(q.options.usd, 0.4);
});
