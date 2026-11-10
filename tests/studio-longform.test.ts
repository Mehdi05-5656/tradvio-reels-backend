import { test } from "node:test";
import assert from "node:assert/strict";
import { LongformError, longformCostUsd, longformCredits, longformOpen, parseLongformOptions, quoteLongform } from "../src/studio-longform.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const ON = { STUDIO_LONGFORM_ENABLED: "true", STUDIO_LONGFORM_OPEN: "true" };
const OWNER_ONLY = { STUDIO_LONGFORM_ENABLED: "true" };

test("prompt required and bounded; length snaps to 2, 5 or 10 minutes; mode defaults to auto", () => {
  assert.throws(() => parseLongformOptions({ prompt: "hi" }), LongformError);
  assert.throws(() => parseLongformOptions({ prompt: "x".repeat(700) }), LongformError);
  const o = parseLongformOptions({ prompt: "  the Gardner   museum heist  " });
  assert.equal(o.prompt, "the Gardner museum heist"); assert.equal(o.minutes, 10); assert.equal(o.mode, "auto");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", minutes: 4 }).minutes, 5);
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", minutes: 1 }).minutes, 2);
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", mode: "musical" }).mode, "auto");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", mode: "fiction" }).mode, "fiction");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery" }).genre, "auto");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", genre: "horror" }).genre, "horror");
  assert.equal(parseLongformOptions({ prompt: "a bank robbery", genre: "western" }).genre, "auto");
});

test("off unless switched on; the quote carries the options and a cost by length", () => {
  assert.throws(() => quoteLongform({}, PLANS, { prompt: "the Gardner museum heist" }), (e: any) => e instanceof LongformError && e.status === 403);
  const q = quoteLongform(ON, PLANS, { prompt: "the Gardner museum heist", minutes: 10, mode: "true" });
  assert.equal(q.tool, "longform"); assert.equal(q.options.longform.minutes, 10); assert.equal(q.options.longform.mode, "true");
  assert.match(q.summary, /10-minute narrated film/); assert.match(q.summary, /a true story/);
  assert.match(quoteLongform(ON, PLANS, { prompt: "the Gardner museum heist", genre: "horror" }).summary, /as horror/);
  const short = quoteLongform(ON, PLANS, { prompt: "the Gardner museum heist", minutes: 2 });
  assert.ok(q.credits > short.credits, "a longer film costs more");
});

test("cost: a fixed part plus a per-minute part, overridable once measured", () => {
  assert.equal(longformCostUsd({}, 10), 9);
  assert.equal(longformCostUsd({}, 2), 3);
  assert.equal(longformCostUsd({ LONGFORM_COST_USD_BASE: "1", LONGFORM_COST_USD_PER_MINUTE: "0.5" }, 10), 6);
  assert.ok(longformCredits({}, PLANS, 10) >= 1);
});

test("a running film's early poster is signed into progress.poster_url; done jobs and jobs without one are left alone", async () => {
  const { withProgressPosters } = await import("../src/studio.ts");
  const asked: string[][] = [];
  const sb = { storage: { from: () => ({ createSignedUrls: async (keys: string[]) => { asked.push(keys); return { data: keys.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }; } }) } };
  const jobs: any[] = [
    { id: "a", status: "running", progress: { stage: "direct", poster_key: "u/a/t/poster.jpg" } },
    { id: "b", status: "running", progress: { stage: "plan" } },
    { id: "c", status: "done", progress: { poster_key: "u/c/t/poster.jpg" }, outputs: [] },
  ];
  await withProgressPosters(sb, jobs);
  assert.deepEqual(asked, [["u/a/t/poster.jpg"]]);
  assert.equal(jobs[0].progress.poster_url, "https://signed/u/a/t/poster.jpg");
  assert.equal(jobs[1].progress.poster_url, undefined);
  assert.equal(jobs[2].progress.poster_url, undefined);
});

test("switched on but not open: customers are refused, the owner's account gets a quote", () => {
  assert.equal(longformOpen(OWNER_ONLY), false);
  assert.throws(() => quoteLongform(OWNER_ONLY, PLANS, { prompt: "the Gardner museum heist" }), (e: any) => e instanceof LongformError && e.status === 403);
  assert.equal(quoteLongform(OWNER_ONLY, PLANS, { prompt: "the Gardner museum heist" }, { owner: true }).tool, "longform");
});
