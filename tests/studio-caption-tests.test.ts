import test from "node:test";
import assert from "node:assert/strict";
import { judgeTest, type TestVariant } from "../src/studio-caption-tests.js";

const NOW = Date.parse("2026-11-22T20:00:00Z");
const v = (variant: number, over: Partial<TestVariant> = {}): TestVariant => ({ variant, post_id: `p${variant}`, caption: `c${variant}`, status: "posted", url: null, posted_at: new Date(NOW - 5 * 86400_000).toISOString(), views: 1000, views_24h: null, views_3d: null, likes: null, shares: null, thumb_key: null, ...over });

test("caption tests: judged at the same age; a clear lead at 3 days wins, at 24 h it only leads; too close is a tie", () => {
  assert.equal(judgeTest([v(0, { status: "scheduled", views: null }), v(1)], NOW).state, "waiting", "not all out yet");
  assert.equal(judgeTest([v(0, { posted_at: new Date(NOW - 3600_000).toISOString() }), v(1, { posted_at: new Date(NOW - 3600_000).toISOString() })], NOW).state, "waiting", "under a day old");
  const lead = judgeTest([v(0, { views_24h: 900 }), v(1, { views_24h: 2000 })], NOW);
  assert.deepEqual([lead.state, lead.at, lead.winner], ["leading", "24h", 1]);
  const win = judgeTest([v(0, { views_24h: 900, views_3d: 1200, views: 50_000 }), v(1, { views_24h: 2000, views_3d: 4000, views: 4100 }), v(2, { views_24h: 1000, views_3d: 1500 })], NOW);
  assert.deepEqual([win.state, win.at, win.winner, win.lead], ["winner", "3d", 1, 2.67], "the same age, not today's totals");
  const tie = judgeTest([v(0, { views_24h: 1000, views_3d: 1100 }), v(1, { views_24h: 1000, views_3d: 1200 })], NOW);
  assert.deepEqual([tie.state, tie.winner], ["tie", null]);
});
