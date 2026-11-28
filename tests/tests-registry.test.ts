// The tests registry (src/tests-registry.ts), Nov 28 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { fisher, groupOf, readTest, testCuts, type TestRow } from "../src/tests-registry.js";
import { computeDay } from "../src/daily-metrics.js";

const SIM: TestRow = { id: "sim_results", name: "See it before you pay", status: "running", measure: "paid", audience: "valued", focus: { role: "clipper" },
  split: { kind: "hex_parity", position: 1, odd: "walk-through", even: "control" }, started_at: "2026-11-24T06:35:00Z", ended_at: null, needed_per_side: 1840 };
const id = (tail: string) => `00000000-0000-4000-8000-0000000000${tail}`;

test("a person's group: the rule's hex digit, only from the test's start, never for a planned test", () => {
  assert.equal(groupOf(SIM, { user_id: id("a1"), created_at: "2026-11-25T00:00:00Z" }), "walk-through");
  assert.equal(groupOf(SIM, { user_id: id("a2"), created_at: "2026-11-25T00:00:00Z" }), "control");
  assert.equal(groupOf(SIM, { user_id: id("a1"), created_at: "2026-11-23T00:00:00Z" }), null, "signed up before it began");
  assert.equal(groupOf({ ...SIM, ended_at: "2026-12-01T00:00:00Z" }, { user_id: id("a1"), created_at: "2026-12-02T00:00:00Z" }), null, "after it ended");
  assert.equal(groupOf({ ...SIM, status: "planned" }, { user_id: id("a1"), created_at: "2026-11-25T00:00:00Z" }), null);
  // a second test on another digit splits the same people differently
  const other = { ...SIM, id: "t2", split: { kind: "hex_parity" as const, position: 2, odd: "B", even: "A" } };
  assert.equal(groupOf(other, { user_id: id("a1"), created_at: "2026-11-25T00:00:00Z" }), "A"); assert.equal(groupOf(other, { user_id: id("b1"), created_at: "2026-11-25T00:00:00Z" }), "B");
});

test("Fisher's exact test matches the Nov 28 read", () => {
  assert.equal(fisher(11, 400, 6, 419), 0.2242); // all valued: not beyond chance
  assert.equal(fisher(9, 101, 2, 107), 0.0297); // clippers
  assert.equal(fisher(0, 0, 1, 5), null);
});

test("a running test's groups land in the tracker, and its result is read back with the focus segment deciding", () => {
  const mk = (tail: string, country: string, role: string) => ({ user_id: id(tail), created_at: "2026-11-25T18:00:00.000Z", country, role, heard: "tiktok" });
  const people = [mk("01", "US", "clipper"), mk("03", "US", "clipper"), mk("02", "US", "clipper"), mk("04", "US", "creator"), mk("05", "IN", "clipper")];
  const paidAt = new Map([[id("01"), "2026-11-25T18:05:00.000Z"], [id("03"), "2026-11-25T18:06:00.000Z"]]);
  const rows = computeDay({ day: "2026-11-25", people, events: [], paidAt, tests: [SIM] });
  const get = (cut: string, value: string) => rows.find((r) => r.cut === cut && r.value === value)?.metrics;
  assert.equal(get("test:sim_results", "walk-through")!.signups, 3, "everyone, India included");
  assert.equal(get("test_valued:sim_results", "walk-through")!.signups, 2); assert.equal(get("test_valued:sim_results", "control")!.signups, 2);
  assert.equal(get("test_valued_role:sim_results", "walk-through|clipper")!.paid, 2);
  assert.deepEqual(testCuts([SIM], people[4], { valued: false, role: "clipper", first_tool: "clips" }), [["test:sim_results", "walk-through"]]);
  const res = readTest(SIM, rows);
  assert.deepEqual(res.valued.groups, { control: { signups: 2, checkout: 0, paid: 0 }, "walk-through": { signups: 2, checkout: 0, paid: 2 } });
  assert.deepEqual(res.focus!.groups, { control: { signups: 1, checkout: 0, paid: 0 }, "walk-through": { signups: 2, checkout: 0, paid: 2 } });
  assert.equal(res.focus!.ahead, "walk-through"); assert.equal(res.per_side_now, 2); assert.equal(res.progress, 0); assert.match(res.verdict, /walk-through is ahead, not beyond chance yet/);
});
