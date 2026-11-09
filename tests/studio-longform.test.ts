import { test } from "node:test";
import assert from "node:assert/strict";
import { LongformError, longformCostUsd, longformCredits, parseLongformOptions, quoteLongform } from "../src/studio-longform.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const ON = { STUDIO_LONGFORM_ENABLED: "true" };

test("prompt required and bounded; length snaps to 2, 5 or 10 minutes; mode defaults to auto", () => {
  assert.throws(() => parseLongformOptions({ prompt: "hi" }), LongformError);
  assert.throws(() => parseLongformOptions({ prompt: "x".repeat(700) }), LongformError);
  const o = parseLongformOptions({ prompt: "  the Gardner   museum heist  " });
  assert.equal(o.prompt, "the Gardner museum heist"); assert.equal(o.minutes, 10); assert.equal(o.mode, "auto");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", minutes: 4 }).minutes, 5);
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", minutes: 1 }).minutes, 2);
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", mode: "musical" }).mode, "auto");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", mode: "fiction" }).mode, "fiction");
});

test("off unless switched on; the quote carries the options and a cost by length", () => {
  assert.throws(() => quoteLongform({}, PLANS, { prompt: "the Gardner museum heist" }), (e: any) => e instanceof LongformError && e.status === 403);
  const q = quoteLongform(ON, PLANS, { prompt: "the Gardner museum heist", minutes: 10, mode: "true" });
  assert.equal(q.tool, "longform"); assert.equal(q.options.longform.minutes, 10); assert.equal(q.options.longform.mode, "true");
  assert.match(q.summary, /10-minute narrated film/); assert.match(q.summary, /a true story/);
  const short = quoteLongform(ON, PLANS, { prompt: "the Gardner museum heist", minutes: 2 });
  assert.ok(q.credits > short.credits, "a longer film costs more");
});

test("cost: a fixed part plus a per-minute part, overridable once measured", () => {
  assert.equal(longformCostUsd({}, 10), 9);
  assert.equal(longformCostUsd({}, 2), 3);
  assert.equal(longformCostUsd({ LONGFORM_COST_USD_BASE: "1", LONGFORM_COST_USD_PER_MINUTE: "0.5" }, 10), 6);
  assert.ok(longformCredits({}, PLANS, 10) >= 1);
});
