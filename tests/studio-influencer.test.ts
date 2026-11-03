import test from "node:test";
import assert from "node:assert/strict";
import { INFLUENCER_TRAITS, cleanTraits, influencerPrompt, influencerName } from "../src/studio-influencer.js";
import { characterPrompt } from "../src/studio-characters.js";
import { quote } from "../src/studio.js";

test("traits outside the vocabulary are dropped; the prompt reads as one full-body studio portrait", () => {
  assert.deepEqual(cleanTraits({ type: "bold", gender: "man", build: "muscular", hairstyle: "mullet", hair_color: "neon", skin: "tan", junk: "x", age: "adult" }), { type: "bold", gender: "man", build: "muscular", hairstyle: "mullet", skin: "tan", age: "adult" });
  assert.deepEqual(cleanTraits(null), {}); assert.deepEqual(cleanTraits("bold"), {});
  const p = influencerPrompt({ type: "bold", gender: "man", build: "muscular", hairstyle: "mullet", hair_color: "blonde", style: "streetwear", ethnicity: "Black", age: "adult", skin: "deep" }, "gold chain");
  assert.equal(p.mode, "human");
  assert.equal(p.prompt, "Photorealistic full-body studio portrait of a adult Black man, muscular build, mullet blonde hair, deep skin, dressed in streetwear clothing, a striking look with one feature pushed past believable, played straight, gold chain, fully clothed, standing facing the camera in a deadpan editorial fashion-campaign portrait, full body visible from head to shoes, plain white seamless studio backdrop, direct on-camera flash, hyper-detailed skin and fabric, sharp focus, no text");
  const a = influencerPrompt({ type: "cat", style: "business", hairstyle: "mohawk" });
  assert.equal(a.mode, "animal"); assert.match(a.prompt, /^Photorealistic full-body studio portrait of a cat character with a real cat head on a human body standing upright like a person, with mohawk, dressed in business clothing, a living animal photographed, never a costume, mask, puppet or suit, fully clothed, standing facing/);
  assert.match(influencerPrompt({}, "").prompt, /^Photorealistic full-body studio portrait of a person, fully clothed, standing facing the camera in a deadpan editorial/);
  assert.equal(influencerName({ type: "bold", build: "muscular", gender: "man", hairstyle: "mullet" }), "bold muscular man mullet");
  assert.equal(influencerName({ type: "cat" }), "cat"); assert.equal(influencerName({}), "person");
  for (const k of Object.keys(INFLUENCER_TRAITS)) assert.ok((INFLUENCER_TRAITS as any)[k].length >= 3, `${k} has choices`);
});

test("the character quote takes traits: the prompt is composed server side and the job carries the traits and a name", () => {
  const costs: any = { character_image: 10, credit_floor: 0.01, light_margin: 0.5, blueprint_copy: 1, blueprint_plus_copy: 2, recast_second: 1, recast_light_second: 1 };
  const q = quote("character", { traits: { type: "extreme", gender: "woman", hair_color: "pink", prompt: "ignored here" }, prompt: "with a tiny hat", count: 4 }, null, costs);
  assert.equal(q.credits, 40); assert.equal(q.options.kind, "influencer"); assert.equal(q.options.mode, "human"); assert.equal(q.options.count, 4);
  assert.deepEqual(q.options.traits, { type: "extreme", gender: "woman", hair_color: "pink" }); assert.equal(q.options.name, "extreme woman");
  assert.match(q.options.prompt, /^Photorealistic full-body studio portrait of a woman, pink hair, a caricature made real: exaggerated features and surreal proportions, completely deadpan, with a tiny hat, fully clothed, standing/);
  assert.equal(characterPrompt(q.options), q.options.prompt, "the runner sends the composed prompt as it is");
  assert.throws(() => quote("character", { traits: { type: "nope" } }, null, costs), (e: any) => e.code === "traits_required");
  // with the person's photo as the job's asset: one portrait from the image-edit model, the identity from the photo
  const ph = quote("character", { traits: { type: "bold", build: "ultra muscular", features: ["broad shoulders", "gold chain", "nope"] }, count: 4 }, { id: "a1", kind: "image" } as any, costs);
  assert.equal(ph.options.count, 1); assert.equal(ph.credits, 10); assert.equal(ph.options.photo_asset_id, "a1"); assert.deepEqual(ph.options.traits.features, ["broad shoulders", "gold chain"]);
  assert.match(ph.options.prompt, /^Photorealistic full-body studio portrait of the person in the reference image, with exactly their face and identity, ultra muscular build, a striking look with one feature pushed past believable, played straight, broad shoulders, gold chain, fully clothed, standing/);
  assert.equal(quote("character", { traits: {} }, { id: "a1", kind: "image" } as any, costs).options.count, 1, "a photo alone is enough");
  assert.equal(quote("character", { traits: { type: "bold" }, count: 4 }, { id: "v1", kind: "video" } as any, costs).options.photo_asset_id, undefined, "a video is not a photo");
  assert.match(characterPrompt({ mode: "human", prompt: "a woman in a red coat" }), /^Photorealistic portrait of a woman in a red coat, facing the camera/, "a described character is framed as before");
});
