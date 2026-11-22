import test from "node:test";
import assert from "node:assert/strict";
import { streamPrice, LIVE_RATES } from "../src/studio-live-clips.js";
import { withCostRun, withRun, currentCostRun } from "../src/studio-costs.js";
import { PLANS } from "../src/studio.js";

const env = {} as Record<string, string | undefined>;
test("a live run's reading is at least 4 credits per clip asked; past streams are priced as before", () => {
  const hour = 3600;
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env, live: true }).analysis, 10 * LIVE_RATES.live_per_asked, "1 h live, 10 asked: 40, not 30");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 4, env, live: true }).analysis, LIVE_RATES.min, "4 asked: the 30 minimum still applies");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env }).analysis, LIVE_RATES.min, "a past hour: unchanged");
  assert.equal(streamPrice(PLANS, { seconds: 8 * hour, length: "standard", count: 10, env, live: true }).analysis, 8 * LIVE_RATES.per_hour, "a long part: its hours already cost more");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env, live: true }).per_clip, streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env }).per_clip, "per clip unchanged");
});

test("a cost recorded inside a run carries that run; one that names its own job keeps it", async () => {
  const row = { provider: "anthropic", product: "claude-sonnet-5-5", source: "live_clips_verify", usd: 0.01 } as any;
  assert.equal(withRun(row).job_id, undefined, "outside a run: nothing added");
  await withCostRun({ job_id: "job-1", user_id: "user-1", tool: "clips" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    const r = withRun(row);
    assert.equal(r.job_id, "job-1"); assert.equal(r.user_id, "user-1"); assert.equal(r.tool, "clips");
    assert.equal(withRun({ ...row, job_id: "other" }).job_id, "other");
    assert.equal(currentCostRun()?.job_id, "job-1");
  });
  // two runs at once each keep their own
  const seen: string[] = [];
  await Promise.all(["a", "b"].map((id) => withCostRun({ job_id: id, user_id: null, tool: "clips" }, async () => { await new Promise((r) => setTimeout(r, id === "a" ? 10 : 1)); seen.push(`${id}:${withRun(row).job_id}`); })));
  assert.deepEqual(seen.sort(), ["a:a", "b:b"]);
});
