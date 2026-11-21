import test from "node:test";
import assert from "node:assert/strict";
import { cutLines, hdAllowed, qualityOf } from "../src/studio-quality.js";
import { PLANS } from "../src/studio.js";

test("clips are cut at 720 unless HD is chosen; HD is Creator and up, the owner pass or the owner", () => {
  assert.equal(qualityOf(undefined), "720"); assert.equal(qualityOf("1080"), "1080"); assert.equal(qualityOf(1080), "1080"); assert.equal(qualityOf("4k"), "720");
  assert.equal(cutLines("720", {}), 720); assert.equal(cutLines("1080", {}), 1080); assert.equal(cutLines("1080", { STUDIO_CLIPS_HD: "off" }), 720);
  assert.equal(hdAllowed({ plan_id: "starter" }), false); assert.equal(hdAllowed(null), false);
  assert.equal(hdAllowed({ plan_id: "creator" }), true); assert.equal(hdAllowed({ plan_id: "studio" }), true);
  assert.equal(hdAllowed({ plan_id: "starter", owner_pass: true }), true); assert.equal(hdAllowed({ plan_id: "starter" }, true), true);
});

test("the plans say which ones cut clips in HD, the same way the rule does", () => {
  for (const p of PLANS) assert.equal(p.hd_clips, hdAllowed({ plan_id: p.id }), p.id);
});
