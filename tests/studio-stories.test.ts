import { test } from "node:test";
import assert from "node:assert/strict";
import { StoryError, parseStoryOptions, quoteStory, storyCostUsd, storyCredits } from "../src/studio-stories.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const ON = { STUDIO_STORIES_ENABLED: "true" };

test("topic is required and bounded; seconds clamp; unknown format is auto", () => {
  assert.throws(() => parseStoryOptions({ topic: "hi" }), StoryError);
  assert.throws(() => parseStoryOptions({ topic: "x".repeat(700) }), StoryError);
  const o = parseStoryOptions({ topic: "  building a   bridge  " });
  assert.deepEqual(o, { topic: "building a bridge", seconds: 45, format: "auto" });
  assert.equal(parseStoryOptions({ topic: "building a bridge", seconds: 5 }).seconds, 20);
  assert.equal(parseStoryOptions({ topic: "building a bridge", seconds: 400 }).seconds, 90);
  assert.equal(parseStoryOptions({ topic: "building a bridge", format: "escalation" }).format, "escalation");
  assert.equal(parseStoryOptions({ topic: "building a bridge", format: "musical" }).format, "auto");
});

test("off unless switched on; the quote is a kage_motion job carrying options.story", () => {
  assert.throws(() => quoteStory({}, PLANS, { topic: "building a bridge" }), (e: any) => e instanceof StoryError && e.status === 403);
  const q = quoteStory(ON, PLANS, { topic: "building a bridge", seconds: 30, format: "buildup" });
  assert.equal(q.tool, "kage_motion");
  assert.deepEqual(q.options.story, { topic: "building a bridge", seconds: 30, format: "buildup" });
  assert.equal(q.options.aspect, "9:16"); assert.equal(q.options.style, "story");
  assert.ok(q.credits >= 1); assert.match(q.summary, /30 s 3D build-up story/);
  assert.equal(quoteStory(ON, PLANS, { topic: "building a bridge" }).options.story.format, undefined, "auto leaves the format to the writer");
});

test("cost scales with length and can be set from measured runs", () => {
  assert.equal(storyCostUsd({}, 45), 1.5);
  assert.equal(storyCostUsd({}, 90), 3);
  assert.equal(storyCostUsd({}, 20), 0.9, "short films never price under 60 % of the 45 s cost");
  assert.equal(storyCostUsd({ STUDIO_STORY_COST_USD: "1" }, 45), 1);
  assert.ok(storyCredits({}, PLANS, 90) > storyCredits({}, PLANS, 45));
});
