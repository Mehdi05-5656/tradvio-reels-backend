import test from "node:test";
import assert from "node:assert/strict";
import { bufferedCostsForTests, cleanCost, costFromEvent, flushCosts, initCosts, recordCost, resetCostsForTests, summarizeCosts } from "../src/studio-costs.js";
import { recordEvent, resetEventsForTests } from "../src/studio-events.js";
import { logClaudeCost } from "../src/studio-pricing.js";

const JOB = "11111111-1111-4111-8111-111111111111", USER = "22222222-2222-4222-8222-222222222222";
const fakeSb = (got: any[], fail = false) => (() => ({ from: (t: string) => ({ insert: async (rows: any[]) => { assert.equal(t, "studio_costs"); if (fail) return { error: { message: "permission denied" } }; got.push(...rows); return { error: null }; } }) })) as any;

test("a cost row is cleaned for the table: ids checked, lengths kept, dollars to six places and never negative", () => {
  const c = cleanCost({ provider: "anthropic", product: "claude-opus-5-5", source: "plan", usd: 0.12345678, basis: "metered", job_id: "not-an-id", user_id: USER, note: "x".repeat(400) }, new Date("2026-11-11T08:00:00Z"));
  assert.equal(c.usd, 0.123457); assert.equal(c.job_id, null); assert.equal(c.user_id, USER); assert.equal(c.note!.length, 300); assert.equal(c.writer, "backend"); assert.equal(c.spent_at, "2026-11-11T08:00:00.000Z");
  assert.equal(cleanCost({ provider: "x", product: "y", source: "z", usd: -5, basis: "list" }).usd, 0);
  assert.equal(cleanCost({ provider: "x", product: "y", source: "z", usd: NaN, basis: "list" }).usd, 0);
});

test("events that carry dollars become cost rows: a Claude call with its tokens, a vendor call as an estimate; others do not", () => {
  const cl = costFromEvent({ user_id: USER, kind: "claude", name: "clips.pick", usd: 0.0421, props: { model: "claude-sonnet-5-5", input: 1200, output: 300, cache_write: 50, cache_read: 900, job: JOB } })!;
  assert.equal(cl.provider, "anthropic"); assert.equal(cl.product, "claude-sonnet-5-5"); assert.equal(cl.source, "clips.pick"); assert.equal(cl.basis, "metered"); assert.equal(cl.job_id, JOB);
  assert.deepEqual(cl.units, { input_tokens: 1200, output_tokens: 300, cache_write_tokens: 50, cache_read_tokens: 900, calls: 1 });
  const v = costFromEvent({ kind: "vendor", name: "youtube_proxy", usd: 0.03, props: { job: JOB, bytes: 5_000_000, seconds: 120 } })!;
  assert.equal(v.provider, "youtube_proxy"); assert.equal(v.basis, "estimated"); assert.deepEqual(v.units, { calls: 1, bytes: 5_000_000, seconds: 120 });
  const sc = costFromEvent({ kind: "vendor", name: "scrapecreators", usd: 0.0019, props: { path: "/v2/instagram/user/posts", status: 200, use: "profile import" } })!;
  assert.equal(sc.product, "/v2/instagram/user/posts"); assert.equal(sc.source, "profile import");
  assert.equal(costFromEvent({ kind: "page", name: "home" }), null); assert.equal(costFromEvent({ kind: "email", name: "welcome", props: { ok: true } }), null); assert.equal(costFromEvent({ kind: "vendor", name: "x" }), null);
});

test("recording a Claude cost the old way also writes the ledger; rows are buffered and written in one insert", async () => {
  resetCostsForTests(); resetEventsForTests(); const got: any[] = []; initCosts(fakeSb(got));
  logClaudeCost(undefined, "assistant.plan", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, USER);
  recordEvent({ kind: "vendor", name: "scrapecreators", usd: 0.0019, props: { path: "/v1/instagram/post", use: "performance" } });
  recordEvent({ kind: "page", name: "home", user_id: USER });
  recordCost({ provider: "elevenlabs", product: "speech: eleven_turbo_v2_5", source: "audio instrument", units: { credits: 430 }, usd: 430 * 0.000165, basis: "metered", job_id: JOB, tool: "instrument" });
  assert.equal(bufferedCostsForTests().length, 3); assert.equal(await flushCosts(), 3); assert.equal(got.length, 3);
  assert.equal(got[0].provider, "anthropic"); assert.equal(got[0].usd, (1000 * 4 + 500 * 20) / 1e6); assert.equal(got[0].user_id, USER); assert.equal(got[2].tool, "instrument");
  // a refused write never throws, and nothing is recorded before the ledger is switched on
  resetCostsForTests(); initCosts(fakeSb([], true)); recordCost({ provider: "x", product: "y", source: "z", usd: 1, basis: "list" }); assert.equal(await flushCosts(), 0);
  resetCostsForTests(); recordCost({ provider: "x", product: "y", source: "z", usd: 1, basis: "list" }); assert.equal(bufferedCostsForTests().length, 0);
});

test("the panel's view adds the same dollars up by vendor, tool, step, product, basis, day and job", () => {
  const row = (o: any) => ({ spent_at: "2026-11-11T08:00:00Z", job_id: null, tool: null, provider: "anthropic", product: "claude-opus-5-5", source: "plan", usd: 0, basis: "metered", writer: "kage-motion", ...o });
  const v = summarizeCosts([
    row({ job_id: JOB, tool: "kage_motion", usd: 2.5, source: "scene" }), row({ job_id: JOB, tool: "kage_motion", usd: 0.5, source: "plan" }),
    row({ job_id: JOB, tool: "kage_motion", provider: "elevenlabs", product: "speech: eleven_turbo_v2_5", source: "voice", usd: 0.07 }),
    row({ job_id: JOB, tool: "kage_motion", provider: "render", product: "worker time", source: "job", usd: "0.12", basis: "estimated" }),
    row({ spent_at: "2026-11-10T20:00:00Z", provider: "scrapecreators", product: "/v1/instagram/post", source: "performance", usd: 0.0019, basis: "estimated", writer: "backend" }),
  ], { days: 30, from: "2026-10-12T00:00:00Z" });
  assert.equal(v.rows, 5); assert.equal(v.total_usd, 3.1919); assert.deepEqual(v.by_provider[0], { key: "anthropic", usd: 3, rows: 2 }); assert.equal(v.by_tool[0].key, "kage_motion"); assert.equal(v.by_tool[1].key, "(no tool)");
  assert.equal(v.by_source[0].key, "anthropic: scene"); assert.deepEqual(v.by_basis.map((b) => b.key), ["metered", "estimated"]); assert.equal(v.by_basis[1].usd, 0.1219);
  assert.deepEqual(v.by_day, [{ day: "2026-11-10", usd: 0.0019 }, { day: "2026-11-11", usd: 3.19 }]);
  assert.equal(v.jobs.count, 1); assert.equal(v.jobs.max_usd, 3.19); assert.equal(v.jobs.top[0].job_id, JOB); assert.equal(v.jobs.top[0].rows, 4); assert.equal(v.first_row_at, "2026-11-10T20:00:00Z");
  assert.equal(summarizeCosts([], { days: null, from: null }).total_usd, 0);
});
