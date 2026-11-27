import test from "node:test";
import assert from "node:assert/strict";
import { AD_LIMITS, AdError, adSeconds, cleanAdRequest, endCardAss, partArgs } from "../src/studio-ads.js";

const P = "11111111-1111-4111-8111-111111111111";
const J = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;

test("the ad opens with its one hook, keeps the person's order after it, drops repeats and caps the pieces", () => {
  const r = cleanAdRequest({ product: P, parts: [{ job: J(1), kind: "clip" }, { job: J(2), kind: "hook" }, { job: J(1), kind: "clip" }, { job: J(3), kind: "shot" }, { job: "nope", kind: "clip" }], end: { line: " SURGE.  Zero sugar. ", offer: "20% off {today}" }, music: true });
  assert.deepEqual(r.parts.map((p) => p.kind), ["hook", "clip", "shot"]);
  assert.equal(r.end?.line, "SURGE. Zero sugar."); assert.equal(r.end?.offer, "20% off today");
  assert.equal(r.music, true);
  assert.throws(() => cleanAdRequest({ product: P, parts: [{ job: J(1), kind: "hook" }, { job: J(2), kind: "hook" }] }), (e: any) => e instanceof AdError && e.code === "ad_one_hook");
  assert.throws(() => cleanAdRequest({ product: P, parts: [{ job: J(3), kind: "shot" }] }), (e: any) => e.code === "ad_needs_video");
  assert.throws(() => cleanAdRequest({ product: "x", parts: [] }), (e: any) => e.code === "ad_input_required");
  const many = cleanAdRequest({ product: P, parts: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ job: J(n), kind: "clip" })) });
  assert.equal(many.parts.length, AD_LIMITS.parts);
  assert.equal(cleanAdRequest({ product: P, parts: [{ job: J(1), kind: "clip" }], end: null }).end, null);
  // the AI-generated line is the person's choice, kept only when they made one
  assert.equal(cleanAdRequest({ product: P, parts: [{ job: J(1), kind: "clip" }], disclose: false }).disclose, false);
  assert.equal(cleanAdRequest({ product: P, parts: [{ job: J(1), kind: "clip" }] }).disclose, undefined);
});

test("its length: clips as they are, shots at their fixed beat, plus the end card", () => {
  assert.equal(adSeconds([{ kind: "hook", seconds: 6 }, { kind: "clip", seconds: 5 }, { kind: "shot", seconds: 99 }], true), 6 + 5 + AD_LIMITS.shot_seconds + AD_LIMITS.end_seconds);
  assert.equal(adSeconds([{ kind: "clip", seconds: 5 }], false), 5);
});

test("every piece lands on the 9:16 frame (fill or blurred fit); a still gets a slow push and silent sound", () => {
  const v = partArgs("in.mp4", "out.mp4", { still: false, seconds: 5, audio: true }).join(" ");
  assert.match(v, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur/);
  assert.match(v, /overlay=\(W-w\)\/2:\(H-h\)\/2/); assert.match(v, /-map 0:a:0/);
  const s = partArgs("in.jpg", "out.mp4", { still: true, seconds: 2.2, audio: false }).join(" ");
  assert.match(s, /-loop 1 -t 2\.20 -i in\.jpg/); assert.match(s, /zoompan/); assert.match(s, /anullsrc/); assert.match(s, /-map 1:a:0/);
});

test("the end card says only the person's words, in our caption fonts, with no override tricks", () => {
  const a = endCardAss("SURGE {\\pos(0,0)} zero", "20% off", 2.5);
  assert.match(a, /PlayResX: 1080/); assert.match(a, /Montserrat Black/);
  assert.match(a, /,Line,,0,0,0,,\{\\fad\(250,0\)\}SURGE pos\(0,0\) zero/);
  assert.match(a, /,Offer,.*20% off/);
  assert.ok(!/Dialogue.*Offer/.test(endCardAss("Only a line", null, 2.5)));
});

test("end card: the product sits in the upper box and the words in the band under it; the slow push is centred", async () => {
  const { endCardArgs, END_CARD } = await import("../src/studio-ads.js");
  const a = endCardArgs("p.jpg", "card.mp4", 2.5).join(" ");
  assert.match(a, /overlay=\(W-w\)\/2:170\+\(1140-h\)\/2/);
  assert.match(a, /x='iw\/2-\(iw\/zoom\/2\)':y='ih\/2-\(ih\/zoom\/2\)'/);
  assert.match(a, /colorchannelmixer=rr=0.5:gg=0.5:bb=0.5/);
  // the line (two rows at most: 40 characters) starts below the picture even at the push's full 1.06
  const ass = endCardAss("Forty characters of end line, both rows!", "Free shipping today", 2.5);
  const lineMargin = Number(/Style: Line,[^\n]*,(\d+),1\n/.exec(ass)![1]), size = Number(/Style: Line,[^,]+,(\d+)/.exec(ass)![1]);
  const pictureBottom = 960 + (END_CARD.top + END_CARD.height - 960) * 1.06, lineTop = 1920 - lineMargin - 2 * size * 1.2;
  assert.ok(lineTop > pictureBottom + 40, `${lineTop} vs ${pictureBottom}`);
});
