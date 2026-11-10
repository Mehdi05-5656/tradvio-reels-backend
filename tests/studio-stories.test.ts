import { test } from "node:test";
import assert from "node:assert/strict";
import { StoryError, parseStoryOptions, quoteStory, storyCostUsd, storyCredits, storyExplainerCostUsd, storyExplainerEnabled, storyExplainerOpen, storyFilmCostUsd, storyScriptCostUsd } from "../src/studio-stories.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const ON = { STUDIO_STORIES_ENABLED: "true" };
const SCENE = { version: 1, title: "t", world: { kind: "river" }, beats: [{ say: "Hello." }] };

test("topic required and bounded; 60+ is the default and carries a one-minute floor; lengths snap to the offered ones", () => {
  assert.throws(() => parseStoryOptions({ topic: "hi" }), StoryError);
  assert.throws(() => parseStoryOptions({ topic: "x".repeat(700) }), StoryError);
  const o = parseStoryOptions({ topic: "  building a   bridge  " });
  assert.equal(o.topic, "building a bridge"); assert.equal(o.seconds, 65); assert.equal(o.min_seconds, 60);
  assert.equal(o.sidekick, "Kevin"); assert.equal(o.stage, "all");
  assert.equal(parseStoryOptions({ topic: "building a bridge", seconds: 30 }).min_seconds, 0);
  assert.equal(parseStoryOptions({ topic: "building a bridge", seconds: 50 }).seconds, 45);
  assert.equal(parseStoryOptions({ topic: "building a bridge", seconds: 400 }).seconds, 90);
  assert.equal(parseStoryOptions({ topic: "building a bridge", format: "musical", world: "mars", captions: "loud" }).world, "auto");
  assert.equal(parseStoryOptions({ topic: "building a bridge", world: "cosmos", format: "scale" }).format, "scale");
  assert.equal(parseStoryOptions({ topic: "building a bridge", sidekick: "  Dave<script>  " }).sidekick, "Davescript");
});

test("off unless switched on; script and film are separate steps; a film needs a written scene", () => {
  assert.throws(() => quoteStory({}, PLANS, { topic: "building a bridge" }), (e: any) => e instanceof StoryError && e.status === 403);
  const script = quoteStory(ON, PLANS, { topic: "building a bridge", stage: "script" });
  assert.equal(script.options.story.stage, "script"); assert.match(script.summary, /script/);
  assert.throws(() => quoteStory(ON, PLANS, { topic: "building a bridge", stage: "film" }), (e: any) => e.code === "story_scene");
  const film = quoteStory(ON, PLANS, { topic: "building a bridge", stage: "film", scene: SCENE, seconds: 65 });
  assert.deepEqual(film.options.story.scene, SCENE); assert.equal(film.options.story.min_seconds, 60);
  assert.ok(film.credits > script.credits, "the film step costs more than the script");
  const all = quoteStory(ON, PLANS, { topic: "building a bridge", format: "buildup", world: "river", sidekick: "Dave" });
  assert.equal(all.tool, "kage_motion"); assert.equal(all.options.story.world, "river"); assert.equal(all.options.story.sidekick, "Dave");
  assert.match(all.summary, /60\+ s 3D build-up story/);
});

test("cost: script fixed, film by length; overridable once measured", () => {
  assert.equal(storyScriptCostUsd({}), 0.35);
  assert.equal(storyFilmCostUsd({}, 45), 1.2);
  assert.equal(storyFilmCostUsd({}, 90), 2.4);
  assert.equal(storyCostUsd({}, 45), 1.55);
  assert.equal(storyFilmCostUsd({ STUDIO_STORY_COST_USD: "1" }, 45), 1);
  assert.ok(storyCredits({}, PLANS, 90) > storyCredits({}, PLANS, 45));
});

test("the no-character film: its own switch, the owner's account until it is open, a topic and a length and nothing else", () => {
  const ask = { topic: "Want a bunker under your backyard?", kind: "explainer", seconds: 30, world: "cosmos", sidekick: "Dave", stage: "script" };
  // off: nobody, the owner included; a story with a character is untouched
  assert.throws(() => quoteStory(ON, PLANS, ask), (e: any) => e.code === "story_kind_off" && e.status === 403);
  assert.throws(() => quoteStory(ON, PLANS, ask, { owner: true }), (e: any) => e.code === "story_kind_off");
  assert.equal(quoteStory(ON, PLANS, { topic: "building a bridge" }).options.story.kind, undefined);
  // enabled but not open: the owner only
  const EN = { ...ON, STUDIO_STORY_EXPLAINER_ENABLED: "true" };
  assert.equal(storyExplainerEnabled(EN), true); assert.equal(storyExplainerOpen(EN), false);
  assert.throws(() => quoteStory(EN, PLANS, ask), (e: any) => e.code === "story_kind_off");
  const q = quoteStory(EN, PLANS, ask, { owner: true });
  assert.deepEqual(q.options.story, { topic: ask.topic, seconds: 30, kind: "explainer" });
  assert.equal(q.tool, "kage_motion"); assert.match(q.summary, /no character/); assert.ok(q.credits > 0);
  // open: everyone; OPEN alone (without ENABLED) opens nothing
  const OPEN = { ...EN, STUDIO_STORY_EXPLAINER_OPEN: "true" };
  assert.equal(quoteStory(OPEN, PLANS, ask).options.story.kind, "explainer");
  assert.equal(storyExplainerOpen({ ...ON, STUDIO_STORY_EXPLAINER_OPEN: "true" }), false);
  // lengths snap to 30 or 50 (50, the reference's length, when none is asked); the price follows the length and the env
  assert.equal(parseStoryOptions({ ...ask, seconds: 90 }).seconds, 50); assert.equal(parseStoryOptions({ ...ask, seconds: 12 }).seconds, 30); assert.equal(parseStoryOptions({ topic: ask.topic, kind: "explainer" }).seconds, 50);
  assert.equal(storyExplainerCostUsd({}, 30), 1.9); assert.equal(storyExplainerCostUsd({}, 50), 3.04); assert.equal(storyExplainerCostUsd({ STUDIO_STORY_EXPLAINER_COST_USD: "1" }, 30), 1);
  assert.throws(() => parseStoryOptions({ kind: "explainer", topic: "hi" }), StoryError);
});
