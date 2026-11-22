import test from "node:test";
import assert from "node:assert/strict";
import { ANGLES, cleanVersionCaptions, defaultLooks, PURPOSE_PROMPT, suggestPurpose, versionCaptionsMessage, type LookRead } from "../src/studio-blueprints-purpose.js";
import { cleanHooks, hookMessage, HOOK_SCHEMA } from "../src/studio-blueprints-read.js";
import type { CapWord } from "../src/caption-engine.js";

const WORDS: CapWord[] = Array.from({ length: 60 }, (_, i) => ({ text: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.5, key: false }));
const look = (o: Partial<LookRead>): LookRead => ({ captions: false, format: "talking_head", people: 1, speaks_to_camera: true, facecam_over_gameplay: false, landscape_source: false, product_or_app: false, call_to_action: false, ...o });

test("purpose: where the video came from first, then the sign-up role, then what the stills show", () => {
  assert.equal(suggestPurpose({ probe: { source: "clips" }, role: "creator" }), "clip", "made by Clips beats the role");
  assert.equal(suggestPurpose({ probe: { source: "youtube", title: "x" }, role: "business" }), "clip", "imported from someone's post");
  assert.equal(suggestPurpose({ probe: {}, role: "clipper" }), "clip");
  assert.equal(suggestPurpose({ probe: {}, role: "yt_automation" }), "clip");
  assert.equal(suggestPurpose({ probe: {}, role: "personal_brand" }), "own");
  assert.equal(suggestPurpose({ probe: {}, role: "creator" }), "own");
  assert.equal(suggestPurpose({ probe: {}, role: "business" }), "brand");
  assert.equal(suggestPurpose({ probe: {}, role: "agency" }), "brand");
  // no role: the stills decide
  assert.equal(suggestPurpose({ probe: {}, role: null, look: look({ format: "stream_game", facecam_over_gameplay: true }) }), "clip");
  assert.equal(suggestPurpose({ probe: {}, role: "exploring", look: look({ format: "podcast", people: 2 }) }), "clip");
  assert.equal(suggestPurpose({ probe: {}, look: look({ format: "product" }) }), "brand");
  assert.equal(suggestPurpose({ probe: {}, look: look({ product_or_app: true, call_to_action: true }) }), "brand");
  assert.equal(suggestPurpose({ probe: {} }), "own", "nothing known: my own content");
});

test("default looks: brands never get Split or Loud pre-picked; podcasts start framed", () => {
  assert.deepEqual(defaultLooks("brand", look({ format: "stream_game" })), ["card", "clean"]);
  assert.deepEqual(defaultLooks("own"), ["clean", "editorial"]);
  assert.deepEqual(defaultLooks("clip", look({ format: "podcast" })), ["card", "loud"]);
  assert.deepEqual(defaultLooks("clip", look({ format: "stream_irl" })), ["clean", "loud"]);
});

test("openings: the purpose's instructions go first; angles are kept only when they belong to the purpose", () => {
  assert.ok(hookMessage(WORDS, 3, null, "clip").startsWith(PURPOSE_PROMPT.clip));
  assert.ok(!hookMessage(WORDS, 3).includes("THIS SET"), "no purpose: the message is as before");
  assert.ok((HOOK_SCHEMA as any).properties.hooks.items.required.includes("angle"));
  const raw = { hooks: [{ first: 23, last: 25, title: "Why *nobody* tells you", why: "", angle: "question" }, { first: 40, last: 42, title: "He thought it was AI", why: "", angle: "reaction" }] };
  const own = cleanHooks(raw, WORDS, 5, "own");
  assert.deepEqual(own.map((h) => h.angle), ["question", null]);
  assert.equal(cleanHooks(raw, WORDS, 5)[0].angle, undefined, "no purpose: no angle field");
  for (const p of ["clip", "own", "brand"] as const) {
    assert.equal(ANGLES[p].length, 5);
    for (const a of ANGLES[p]) assert.ok(PURPOSE_PROMPT[p].includes(a.id), `${p} prompt names ${a.id}`);
  }
});

test("version captions: one per version, in order, safe hashtags, a YouTube title only when YouTube is a target", () => {
  const raw = { captions: [
    { index: 2, caption: "“Second”", hashtags: ["#ok", "not a tag", "#also_ok", "#ok"], youtube_title: "T2" },
    { index: 1, caption: "First", hashtags: ["#x"], youtube_title: "T1" },
    { index: 1, caption: "Duplicate", hashtags: [], youtube_title: null },
    { index: 9, caption: "Not asked", hashtags: [], youtube_title: null },
    { index: 3, caption: "   ", hashtags: [], youtube_title: null },
  ] };
  const out = cleanVersionCaptions(raw, [1, 2, 3], false);
  assert.deepEqual(out.map((c) => [c.index, c.caption]), [[1, "First"], [2, "Second"]]);
  assert.deepEqual(out[1].hashtags, ["#ok", "#also_ok"]);
  assert.equal(out[0].youtube_title, null);
  assert.equal(cleanVersionCaptions(raw, [1, 2], true)[0].youtube_title, "T1");
  const m = versionCaptionsMessage({ purpose: "clip", words: WORDS.slice(0, 5), platforms: ["tiktok"], versions: [{ index: 1, title: "He *thought* it was AI", line: "w1 w2", angle: "reaction", look: "Clean" }] });
  assert.match(m, /third person/);
  assert.match(m, /1\. opening line: "w1 w2" · title card: "He thought it was AI" · angle: reaction · look: Clean/);
});
