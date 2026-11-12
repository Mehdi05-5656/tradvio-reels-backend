import { test } from "node:test";
import assert from "node:assert/strict";
import { MotivationError, motivationCostUsd, motivationCredits, motivationEnabled, motivationOpen, parseMotivationOptions, quoteMotivation } from "../src/studio-motivation.ts";
import { MARGIN_TARGET, studioCosts } from "../src/studio-pricing.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const ON = { STUDIO_MOTIVATION_ENABLED: "true", STUDIO_MOTIVATION_OPEN: "true" };
const OWNER_ONLY = { STUDIO_MOTIVATION_ENABLED: "true" };
const TOPIC = { topic: "why consistency beats talent" };
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("a topic is required and bounded; the length snaps to 30, 45, 60 or 90 seconds", () => {
  assert.throws(() => parseMotivationOptions({ topic: "hi" }), MotivationError);
  assert.throws(() => parseMotivationOptions({ topic: "x".repeat(700) }), MotivationError);
  const o = parseMotivationOptions({ topic: "  why   consistency beats talent " });
  assert.equal(o.topic, "why consistency beats talent"); assert.equal(o.seconds, 45); assert.equal(o.script, "");
  assert.equal(parseMotivationOptions({ ...TOPIC, seconds: 50 }).seconds, 45);
  assert.equal(parseMotivationOptions({ ...TOPIC, seconds: 5 }).seconds, 30);
  assert.equal(parseMotivationOptions({ ...TOPIC, seconds: 500 }).seconds, 90);
});

test("the person's own script: bounded in words, and its length sets the film's length", () => {
  assert.throws(() => parseMotivationOptions({ script: words(20) }), (e: any) => e instanceof MotivationError && e.code === "motivation_script");
  assert.throws(() => parseMotivationOptions({ script: words(400) }), (e: any) => e instanceof MotivationError && e.code === "motivation_script");
  const o = parseMotivationOptions({ script: `  ${words(155)}  `, topic: "ignored", seconds: 30 });
  assert.equal(o.seconds, 50); assert.equal(o.topic, ""); assert.equal(o.script.split(" ").length, 155);
});

test("off by default; switched on but not open only the owner's account gets a quote", () => {
  assert.equal(motivationEnabled({}), false); assert.equal(motivationOpen({ STUDIO_MOTIVATION_OPEN: "true" }), false);
  assert.throws(() => quoteMotivation({}, PLANS, TOPIC, { owner: true }), (e: any) => e instanceof MotivationError && e.status === 403);
  assert.throws(() => quoteMotivation(OWNER_ONLY, PLANS, TOPIC), (e: any) => e instanceof MotivationError && e.status === 403);
  assert.equal(quoteMotivation(OWNER_ONLY, PLANS, TOPIC, { owner: true }).tool, "kage_motion");
  assert.equal(quoteMotivation(ON, PLANS, TOPIC).tool, "kage_motion");
});

test("the job goes to the Kage Motion queue with options.motivation, and carries its cost", () => {
  const q = quoteMotivation(ON, PLANS, { ...TOPIC, seconds: 60 });
  assert.deepEqual(q.options.motivation, { topic: "why consistency beats talent", seconds: 60 });
  assert.equal(q.options.style, "motivation"); assert.equal(q.options.aspect, "16:9"); assert.equal(q.options.cost_usd, 0.51);
  assert.match(q.summary, /60 s, script written for you/);
  const own = quoteMotivation(ON, PLANS, { script: words(155) });
  assert.deepEqual(Object.keys(own.options.motivation), ["script"]); assert.match(own.summary, /About 50 s, your script/);
});

test("priced from the cost at the house margin; a longer film costs more; the cost can be set from the environment", () => {
  assert.equal(motivationCostUsd({}, 30), 0.33); assert.equal(motivationCostUsd({}, 90), 0.69);
  assert.equal(motivationCostUsd({ MOTIVATION_COST_USD_BASE: "0.3", MOTIVATION_COST_USD_PER_SECOND: "0.01" }, 60), 0.9);
  const floor = studioCosts({}, PLANS).credit_floor;
  for (const s of [30, 45, 60, 90]) {
    const credits = motivationCredits({}, PLANS, s);
    assert.ok(1 - motivationCostUsd({}, s) / (credits * floor) >= MARGIN_TARGET - 1e-9, `${s} s keeps the margin on the cheapest credits`);
  }
  assert.ok(motivationCredits({}, PLANS, 90) > motivationCredits({}, PLANS, 30));
});
