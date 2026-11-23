import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanPlan, registerPostingPlan } from "../src/studio-posting-plan.js";

test("posting plan: bounded and cleaned; nothing usable is null", () => {
  const p = cleanPlan({ per_day: 3, countries: ["us", "gb", "xxx"], timezone: "America/New_York", times: ["19:00", "09:00", "9:00", "13:00", "19:00"], days: [1, 2, 9] })!;
  assert.deepEqual(p.times, ["09:00", "13:00", "19:00"]); assert.deepEqual(p.countries, ["US", "GB"]); assert.deepEqual(p.days, [1, 2]); assert.equal(p.per_day, 3);
  assert.equal(cleanPlan({ timezone: "Mars/Base", times: ["09:00"] }), null);
  assert.equal(cleanPlan({ timezone: "Europe/London", times: [] }), null);
  assert.deepEqual(cleanPlan({ timezone: "Europe/London", times: ["08:30"] })!.days, [0, 1, 2, 3, 4, 5, 6]);
});

test("posting plan routes: saved on the person's profile, read back; refused without a linked profile", async () => {
  const U = "11111111-1111-4111-8111-111111111111";
  const rows: any[] = [{ user_id: U, posting_plan: null }];
  const sb: any = { from: () => {
    const q: any = { _upd: null as any,
      select: () => q, eq: (_k: string, v: string) => { q._u = v; return q; },
      maybeSingle: async () => ({ data: rows.find((r) => r.user_id === q._u) ?? null, error: null }),
      update: (v: any) => { q._upd = v; return q; },
      then: (r: any) => { const hit = rows.filter((x) => x.user_id === q._u); if (q._upd) hit.forEach((x) => Object.assign(x, q._upd)); return r({ data: hit.map((x) => ({ user_id: x.user_id })), error: null }); } };
    return q; } };
  const app = express(); app.use(express.json());
  let who = U;
  app.use((req: any, _r, next) => { req.auth = { user_id: who }; next(); });
  registerPostingPlan(app, () => sb);
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const put = await fetch(`${base}/api/studio/social/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: { per_day: 2, countries: ["US"], timezone: "America/New_York", times: ["12:00", "19:00"], days: [0, 1, 2, 3, 4, 5, 6] } }) });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/studio/social/plan`)).json();
    assert.deepEqual(got.plan.times, ["12:00", "19:00"]); assert.ok(got.plan.updated_at);
    assert.equal((await fetch(`${base}/api/studio/social/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: { timezone: "nope" } }) })).status, 400);
    who = "22222222-2222-4222-8222-222222222222";
    assert.equal((await fetch(`${base}/api/studio/social/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: { timezone: "UTC", times: ["10:00"] } }) })).status, 409);
  } finally { server.close(); }
});
