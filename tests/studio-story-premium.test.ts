// The premium way of making a no-character story (options.story.engine "premium"): its switches, who may ask, its
// price and what reaches the job. The standard story's own expectations live in studio-stories.test.ts, untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { StoryError, parseStoryOptions, quoteStory, storyExplainerCostUsd, storyPremiumCostUsd, storyPremiumCredits, storyPremiumEnabled, storyPremiumMargin, storyPremiumOpen } from "../src/studio-stories.ts";
import { MARGIN_TARGET, creditValueFloor, creditsForCost } from "../src/studio-pricing.ts";
import { PLANS, registerStudio, toolsEnabled } from "../src/studio.ts";
import { clearAdminCacheForTests } from "../src/studio-admin-auth.ts";

const TEST_PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
// stories on and the no-character story open to everyone: what is live today
const LIVE = { STUDIO_STORIES_ENABLED: "true", STUDIO_KAGE_MOTION_ENABLED: "true", STUDIO_STORY_EXPLAINER_ENABLED: "true", STUDIO_STORY_EXPLAINER_OPEN: "true" };
const ENABLED = { ...LIVE, STUDIO_STORY_PREMIUM_ENABLED: "true" };
const OPEN = { ...ENABLED, STUDIO_STORY_PREMIUM_OPEN: "true" };
const ask = { topic: "How does a heart pump blood?", kind: "explainer", seconds: 50 };

test("premium story: nothing changes for a request that names no engine, or names standard", () => {
  for (const env of [LIVE, ENABLED, OPEN]) {
    const plain = quoteStory(env, TEST_PLANS, ask);
    assert.deepEqual(plain.options.story, { topic: ask.topic, seconds: 50, kind: "explainer" }, "a standard job looks as it does today: no engine key");
    assert.equal(plain.options.cost_usd, storyExplainerCostUsd(env, 50)); assert.equal(plain.options.cost_usd, 3.04);
    assert.equal(plain.summary, "50 s 3D story · no character · vertical 9:16 · narrated");
    assert.deepEqual(quoteStory(env, TEST_PLANS, { ...ask, engine: "standard" }), plain, "standard by name is the same quote");
    assert.deepEqual(quoteStory(env, TEST_PLANS, { ...ask, engine: "" }), plain);
    assert.deepEqual(quoteStory(env, TEST_PLANS, { ...ask, engine: null }), plain);
  }
  // the premium price settings never move the standard price
  assert.equal(quoteStory({ ...OPEN, STUDIO_STORY_PREMIUM_COST_USD: "30", STUDIO_STORY_PREMIUM_MARGIN: "0.2" }, TEST_PLANS, ask).credits, quoteStory(LIVE, TEST_PLANS, ask).credits);
  assert.equal(parseStoryOptions(ask).engine, undefined);
  // a story with a character: standard by name is accepted and changes nothing
  assert.deepEqual(quoteStory(LIVE, TEST_PLANS, { topic: "building a bridge", engine: "standard" }), quoteStory(LIVE, TEST_PLANS, { topic: "building a bridge" }));
});

test("premium story: an engine we do not know is refused, and so is premium on a story with a character", () => {
  for (const engine of ["Premium", "signature", "director", "fast", 1, true, {}, ["premium"]]) {
    assert.throws(() => parseStoryOptions({ ...ask, engine }), (e: any) => e instanceof StoryError && e.code === "story_engine" && e.status === 400, `engine ${JSON.stringify(engine)}`);
    assert.throws(() => quoteStory(OPEN, TEST_PLANS, { ...ask, engine }, { owner: true }), (e: any) => e.code === "story_engine");
    assert.throws(() => parseStoryOptions({ topic: "building a bridge", engine }), (e: any) => e.code === "story_engine", "with a character too");
  }
  assert.throws(() => quoteStory(OPEN, TEST_PLANS, { topic: "building a bridge", engine: "premium" }, { owner: true }), (e: any) => e.code === "story_engine" && e.status === 400);
  assert.equal(parseStoryOptions({ ...ask, engine: "premium" }).engine, "premium");
});

test("premium story: refused while it is switched off, for the owner too; never made the standard way instead", () => {
  assert.equal(storyPremiumEnabled(LIVE), false); assert.equal(storyPremiumOpen(LIVE), false);
  for (const who of [{}, { owner: true }]) assert.throws(() => quoteStory(LIVE, TEST_PLANS, { ...ask, engine: "premium" }, who), (e: any) => e instanceof StoryError && e.code === "story_engine_off" && e.status === 403);
  // OPEN alone (without ENABLED) opens nothing
  const openOnly = { ...LIVE, STUDIO_STORY_PREMIUM_OPEN: "true" };
  assert.equal(storyPremiumOpen(openOnly), false);
  assert.throws(() => quoteStory(openOnly, TEST_PLANS, { ...ask, engine: "premium" }, { owner: true }), (e: any) => e.code === "story_engine_off");
  // the no-character story's own switches still come first
  assert.throws(() => quoteStory({ STUDIO_STORIES_ENABLED: "true", STUDIO_STORY_PREMIUM_ENABLED: "true", STUDIO_STORY_PREMIUM_OPEN: "true" }, TEST_PLANS, { ...ask, engine: "premium" }, { owner: true }), (e: any) => e.code === "story_kind_off");
});

test("premium story: switched on but not open, a customer is refused and the owner's account gets it; open, everyone does", () => {
  assert.equal(storyPremiumEnabled(ENABLED), true); assert.equal(storyPremiumOpen(ENABLED), false);
  assert.throws(() => quoteStory(ENABLED, TEST_PLANS, { ...ask, engine: "premium" }), (e: any) => e.code === "story_engine_off" && e.status === 403);
  assert.throws(() => quoteStory(ENABLED, TEST_PLANS, { ...ask, engine: "premium" }, { owner: false }), (e: any) => e.code === "story_engine_off");
  const mine = quoteStory(ENABLED, TEST_PLANS, { ...ask, engine: "premium" }, { owner: true });
  assert.equal(mine.options.story.engine, "premium");
  assert.equal(storyPremiumOpen(OPEN), true);
  assert.deepEqual(quoteStory(OPEN, TEST_PLANS, { ...ask, engine: "premium" }), mine, "open: a customer gets the quote the owner got");
});

test("premium story: its own price from its cost and margin, and the job carries the engine and the premium cost", () => {
  const floor = creditValueFloor(TEST_PLANS);
  const q = quoteStory(OPEN, TEST_PLANS, { ...ask, engine: "premium", world: "cosmos", sidekick: "Dave", stage: "script" });
  assert.equal(q.tool, "kage_motion");
  assert.deepEqual(q.options.story, { topic: ask.topic, seconds: 50, kind: "explainer", engine: "premium" }, "the worker reads options.story.engine");
  assert.equal(q.options.cost_usd, 9, "the cost recorded on the job is the premium cost");
  assert.equal(q.credits, creditsForCost(9, floor, MARGIN_TARGET), "priced by the same function as everything else");
  assert.equal(q.credits, storyPremiumCredits(OPEN, TEST_PLANS));
  assert.match(q.summary, /no character · built from scratch/);
  const standard = quoteStory(OPEN, TEST_PLANS, ask);
  assert.ok(q.credits > standard.credits * 2.5 && q.credits < standard.credits * 3.5, "about three times the standard story");
  // the same price at either length: the cost is one figure for the film
  assert.equal(quoteStory(OPEN, TEST_PLANS, { ...ask, seconds: 30, engine: "premium" }).credits, q.credits);
  assert.equal(quoteStory(OPEN, TEST_PLANS, { ...ask, seconds: 30, engine: "premium" }).options.story.seconds, 30);
  // the cost and the margin come from the settings
  assert.equal(storyPremiumCostUsd({}), 9); assert.equal(storyPremiumCostUsd({ STUDIO_STORY_PREMIUM_COST_USD: "7.5" }), 7.5);
  for (const bad of ["", "0", "-3", "abc"]) assert.equal(storyPremiumCostUsd({ STUDIO_STORY_PREMIUM_COST_USD: bad }), 9, `cost setting ${JSON.stringify(bad)} falls back`);
  assert.equal(storyPremiumMargin({}), MARGIN_TARGET); assert.equal(storyPremiumMargin({ STUDIO_STORY_PREMIUM_MARGIN: "0.3" }), 0.3); assert.equal(storyPremiumMargin({ STUDIO_STORY_PREMIUM_MARGIN: "0" }), 0);
  for (const bad of ["", " ", "1", "1.5", "-0.1", "half", "0.95"]) assert.equal(storyPremiumMargin({ STUDIO_STORY_PREMIUM_MARGIN: bad }), MARGIN_TARGET, `margin setting ${JSON.stringify(bad)} falls back`);
  const cheaper = quoteStory({ ...OPEN, STUDIO_STORY_PREMIUM_COST_USD: "7.5", STUDIO_STORY_PREMIUM_MARGIN: "0.3" }, TEST_PLANS, { ...ask, engine: "premium" });
  assert.equal(cheaper.options.cost_usd, 7.5); assert.equal(cheaper.credits, creditsForCost(7.5, floor, 0.3)); assert.ok(cheaper.credits < q.credits);
  // on the real plans: what the default comes to
  assert.equal(storyPremiumCredits({}, PLANS), creditsForCost(9, creditValueFloor(PLANS), MARGIN_TARGET));
});

test("premium story: the tools list says it is open only when every switch under it is", () => {
  assert.equal(toolsEnabled({}).story_premium, false);
  assert.equal(toolsEnabled(LIVE).story_premium, false);
  assert.equal(toolsEnabled(ENABLED).story_premium, false, "switched on for the owner's tests: not open to customers");
  assert.equal(toolsEnabled(OPEN).story_premium, true);
  assert.equal(toolsEnabled({ ...OPEN, STUDIO_STORY_EXPLAINER_OPEN: "false" }).story_premium, false, "no-character stories closed: nothing to make the premium way");
  assert.equal(toolsEnabled({ ...OPEN, STUDIO_KAGE_MOTION_ENABLED: "false" }).story_premium, false);
  assert.equal(toolsEnabled({ ...OPEN, STUDIO_STORIES_ENABLED: "false" }).story_premium, false);
  // nothing else in the list moves with the premium switches
  const { story_premium: _a, ...before } = toolsEnabled(LIVE) as any; const { story_premium: _b, ...after } = toolsEnabled(OPEN) as any;
  assert.deepEqual(after, before);
});

// The routes: the quote the page shows, and the job that reserves it. A stand-in database that answers every read with
// nothing and records the job the route creates.
async function serve(env: Record<string, string>) {
  clearAdminCacheForTests();
  const created: any[] = [];
  // (a person on the Creator plan, so the hourly job limit has room)
  const table = (name: string) => { const q: any = { select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, not: () => q, gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q, limit: () => q, contains: () => q, like: () => q,
    insert: () => q, update: () => q, upsert: () => q, delete: () => q, maybeSingle: async () => ({ data: name === "studio_customers" ? { plan_id: "creator", status: "active" } : null, error: null }), single: async () => ({ data: null, error: null }),
    then: (r: any, j: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(r, j) }; return q; };
  const sb: any = { from: table,
    rpc: async (fn: string, args: any) => { if (fn === "studio_create_job") { created.push(args); return { data: { id: `job-${created.length}`, tool: args.p_tool, status: "queued", options: args.p_options, credits_reserved: args.p_credits }, error: null }; } return { data: null, error: null }; },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: id === "u-owner" ? "support@clone8.io" : "ann@synthetic.invalid", email_confirmed_at: "2026-01-01" } } }) } } };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const who = req.headers["x-who"]; if (who) { req.auth = who === "owner" ? { user_id: "u-owner", email: "support@clone8.io" } : { user_id: "u-ann", email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: req.auth.user_id }; } next(); });
  registerStudio(app, () => sb, { stripe: null, env, log: () => {} });
  const srv = app.listen(0); await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, who?: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(who ? { "x-who": who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { call, created, close: () => new Promise((r) => srv.close(r)) };
}

test("premium story routes: the quote shows the premium price, the job reserves it; closed means refused, with nothing created", async (t) => {
  const premium = { tool: "story", asset_id: null, options: { ...ask, engine: "premium" } };
  const standard = { tool: "story", asset_id: null, options: ask };
  const want = storyPremiumCredits({}, PLANS);

  // switched off: the list says closed, everyone is refused, the standard story is as it was
  let s = await serve(LIVE); t.after(() => s.close());
  assert.equal((await s.call("GET", "/api/studio/plans")).body.tools.story_premium, false);
  for (const who of ["ann", "owner"]) {
    const r = await s.call("POST", "/api/studio/quote", who, premium);
    assert.equal(r.status, 403); assert.equal(r.body.error, "story_engine_off");
    assert.equal((await s.call("POST", "/api/studio/jobs", who, premium)).status, 403);
  }
  assert.equal(s.created.length, 0, "a refused premium request creates nothing, and is never made the standard way");
  const std = await s.call("POST", "/api/studio/quote", "ann", standard);
  assert.equal(std.status, 200); assert.equal(std.body.options.story.engine, undefined); assert.equal(std.body.options.cost_usd, 3.04);
  const bad = await s.call("POST", "/api/studio/quote", "ann", { tool: "story", asset_id: null, options: { ...ask, engine: "turbo" } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "story_engine");
  await s.close();

  // switched on, not open: the list still says closed (it speaks for customers); the owner's account quotes and makes one
  s = await serve(ENABLED);
  assert.equal((await s.call("GET", "/api/studio/plans")).body.tools.story_premium, false);
  assert.equal((await s.call("POST", "/api/studio/quote", "ann", premium)).body.error, "story_engine_off");
  assert.equal((await s.call("POST", "/api/studio/jobs", "ann", premium)).status, 403);
  assert.equal(s.created.length, 0);
  const oq = await s.call("POST", "/api/studio/quote", "owner", premium);
  assert.equal(oq.status, 200); assert.equal(oq.body.credits, want); assert.ok(oq.body.credits > std.body.credits);
  const oj = await s.call("POST", "/api/studio/jobs", "owner", premium);
  assert.equal(oj.status, 201); assert.equal(s.created.length, 1);
  assert.equal(s.created[0].p_tool, "kage_motion"); assert.equal(s.created[0].p_user, "u-owner");
  assert.equal(s.created[0].p_credits, want, "the job reserves the premium price");
  assert.deepEqual(s.created[0].p_options.story, { topic: ask.topic, seconds: 50, kind: "explainer", engine: "premium" });
  assert.equal(s.created[0].p_options.cost_usd, 9);
  await s.close();

  // open: the list says so and a customer's job carries the premium price; a standard job is unchanged beside it
  s = await serve({ ...OPEN, STUDIO_STORY_PREMIUM_COST_USD: "8" });
  assert.equal((await s.call("GET", "/api/studio/plans")).body.tools.story_premium, true);
  const cj = await s.call("POST", "/api/studio/jobs", "ann", premium);
  assert.equal(cj.status, 201); assert.equal(s.created[0].p_credits, storyPremiumCredits({ STUDIO_STORY_PREMIUM_COST_USD: "8" }, PLANS)); assert.equal(s.created[0].p_options.cost_usd, 8); assert.equal(s.created[0].p_options.story.engine, "premium");
  const sj = await s.call("POST", "/api/studio/jobs", "ann", standard);
  assert.equal(sj.status, 201); assert.equal(s.created[1].p_credits, std.body.credits); assert.equal("engine" in s.created[1].p_options.story, false); assert.equal(s.created[1].p_options.cost_usd, 3.04);
});
