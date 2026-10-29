import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_LIMITS, NO_PLAN_LIMITS, limitsFor, uploadAllowance, jobAllowance, checkUpload, checkJobRate } from "../src/studio-limits.js";

test("limits: an active plan gets its own allowance, anyone else the small one", () => {
  assert.equal(limitsFor({ plan_id: "creator", status: "active" }), PLAN_LIMITS.creator);
  assert.equal(limitsFor({ plan_id: "studio", status: "trialing" }), PLAN_LIMITS.studio);
  assert.equal(limitsFor({ plan_id: "creator", status: "canceled" }), NO_PLAN_LIMITS, "a lapsed plan keeps only the small allowance");
  assert.equal(limitsFor(null), NO_PLAN_LIMITS);
  for (const l of Object.values(PLAN_LIMITS)) { assert.ok(l.assets > NO_PLAN_LIMITS.assets); assert.ok(l.storage_bytes > NO_PLAN_LIMITS.storage_bytes); assert.ok(l.jobs_per_hour > 0); }
  assert.ok(PLAN_LIMITS.starter.assets < PLAN_LIMITS.creator.assets && PLAN_LIMITS.creator.assets < PLAN_LIMITS.studio.assets, "limits grow with the plan");
});

test("limits: file count, then bytes, then nothing", () => {
  const l = { assets: 2, storage_bytes: 100, jobs_per_hour: 3 };
  assert.equal(uploadAllowance(l, [{ bytes: 10 }], 20), null);
  assert.equal(uploadAllowance(l, [{ bytes: 10 }, { bytes: 10 }], 1)?.code, "too_many_files");
  assert.equal(uploadAllowance(l, [{ bytes: 90 }], 11)?.code, "storage_full");
  assert.equal(uploadAllowance(l, [{ bytes: 90 }], 10), null, "exactly full still fits");
  assert.equal(uploadAllowance(l, [{ bytes: null }], 100), null, "an unknown size counts as nothing");
  assert.equal(jobAllowance(l, 2), null);
  assert.equal(jobAllowance(l, 3)?.code, "rate_limited");
  assert.equal(jobAllowance(NO_PLAN_LIMITS, 0)?.code, "rate_limited", "no plan, no jobs (the database refuses them too)");
  assert.equal(uploadAllowance(l, [{ bytes: 90 }], 11)?.status, 409);
  assert.equal(jobAllowance(l, 3)?.status, 429);
});

// A minimal query stand-in: every chain resolves to the rows or count given for its table.
function sbWith(answers: Record<string, { data?: any; count?: number; error?: any }>) {
  return { from(table: string) { const q: any = {}; for (const m of ["select", "eq", "neq", "gte", "limit", "maybeSingle"]) q[m] = () => q; q.then = (res: any) => res({ data: null, count: null, error: null, ...answers[table] }); return q; } };
}
test("limits: reads fail open, never closed", async () => {
  const u = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal((await checkUpload(sbWith({ studio_customers: { data: { plan_id: "starter", status: "active" } }, studio_assets: { data: Array.from({ length: 60 }, () => ({ bytes: 1 })) } }), u, 5))?.code, "too_many_files");
  assert.equal(await checkUpload(sbWith({ studio_customers: { data: { plan_id: "starter", status: "active" } }, studio_assets: { data: [{ bytes: 1 }] } }), u, 5), null);
  assert.equal(await checkUpload(sbWith({ studio_customers: { error: { message: "down" } }, studio_assets: { data: [] } }), u, 5), null, "a read error enforces nothing");
  assert.equal(await checkUpload({ from() { throw new Error("boom"); } }, u, 5), null);
  assert.equal((await checkJobRate(sbWith({ studio_customers: { data: { plan_id: "starter", status: "active" } }, studio_jobs: { count: 20 } }), u))?.code, "rate_limited");
  assert.equal(await checkJobRate(sbWith({ studio_customers: { data: { plan_id: "starter", status: "active" } }, studio_jobs: { count: 19 } }), u), null);
});
