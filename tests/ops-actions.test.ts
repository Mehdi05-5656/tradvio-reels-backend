import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerOpsActions, validateSchedule, scheduleAccount, renderApi, RENDER_JOB_COMMAND, cronRuns, defaultGate } from "../src/ops-actions.js";
import { accountAccess } from "../src/account-access.js";
import { operatorUserIds } from "../src/auth.js";

const OP = [...operatorUserIds()][0]; // the configured operator: isOperator needs the id, a matching profile and the admin role

const now = new Date("2026-10-25T22:00:00Z");

test("schedule input validation: id shape, platform, target range and a start 1 h to 7 days ahead", () => {
  const ok = validateSchedule({ publer_account_id: "6ac981728c6bf22c85ebad8e", platform: "instagram", label: "jay.trades27", daily_target: 8, start: "2026-10-26T15:00:00Z" }, now);
  assert.equal(ok.ok, true); if (ok.ok) { assert.equal(ok.value.daily_target, 8); assert.equal(ok.value.label_is_username, true); }
  assert.equal((validateSchedule({ publer_account_id: "nope", platform: "instagram", label: "x", start: "2026-10-26T15:00:00Z" }, now) as any).error, "invalid_account_id");
  assert.equal((validateSchedule({ publer_account_id: "6ac981728c6bf22c85ebad8e", platform: "youtube", label: "x", start: "2026-10-26T15:00:00Z" }, now) as any).error, "invalid_platform");
  assert.equal((validateSchedule({ publer_account_id: "6ac981728c6bf22c85ebad8e", platform: "tiktok", label: "x", daily_target: 9, start: "2026-10-26T15:00:00Z" }, now) as any).error, "invalid_daily_target");
  assert.equal((validateSchedule({ publer_account_id: "6ac981728c6bf22c85ebad8e", platform: "tiktok", label: "x", start: "2026-10-25T22:30:00Z" }, now) as any).error, "start_must_be_1h_to_7d_ahead");
});

test("scheduleAccount calls ownership, plan and arm in order as the operator, with the platform's settings", async () => {
  const calls: any[] = [];
  const sb: any = { rpc: async (fn: string, args: any) => { calls.push([fn, args]); return { data: fn === "library_plan" ? 877 : fn === "publer_assign_operator_ownership" ? 1 : null, error: null }; } };
  const v = (validateSchedule({ publer_account_id: "6ac981d50f63602055ff842d", platform: "tiktok", label: "jaytrades", start: "2026-10-26T15:00:00Z" }, now) as any).value;
  const r = await scheduleAccount(sb, "op-1", v, "gate-1", now);
  assert.deepEqual(calls.map((c) => c[0]), ["publer_assign_operator_ownership", "library_plan", "library_arm_publishing"]);
  assert.equal(calls[0][1].p_owner, "op-1"); assert.equal(calls[0][1].p_accounts[0].label, "jaytrades");
  assert.equal(calls[2][1].p_settings.privacy, "PUBLIC_TO_EVERYONE"); assert.equal(calls[2][1].p_gate, "gate-1"); assert.equal(calls[2][1].p_daily, 8);
  assert.deepEqual(r, { ownership: 1, planned: 877, armed: true, start: "2026-10-26T15:00:00.000Z", daily_target: 8 });
  const failing: any = { rpc: async (fn: string) => (fn === "library_arm_publishing" ? { data: null, error: { message: "account_not_eligible" } } : { data: 1, error: null }) };
  await assert.rejects(scheduleAccount(failing, "op-1", v, null, now), /arm: account_not_eligible/);
});

test("renderApi is absent without a key, and posts job and cron-run requests with the key when present", async () => {
  assert.equal(renderApi({}), null);
  const seen: any[] = [];
  const f: any = async (url: string, init: any) => { seen.push([url, init.method, init.headers.authorization, init.body]); return { ok: true, text: async () => JSON.stringify({ id: "job-1", status: "pending" }) }; };
  const api = renderApi({ RENDER_API_KEY: "k" }, f)!;
  assert.deepEqual(await api.createJob("crn-x", RENDER_JOB_COMMAND(50)), { id: "job-1", status: "pending" });
  assert.equal(seen[0][0], "https://api.render.com/v1/services/crn-x/jobs"); assert.equal(seen[0][2], "Bearer k"); assert.match(seen[0][3], /LIBRARY_MAX_JOBS=50/); assert.match(seen[0][3], /env LIBRARY_RENDER_ENABLED=1/);
  await api.runCron("crn-c"); assert.equal(seen[1][0], "https://api.render.com/v1/cron-jobs/crn-c/runs");
  const svc: any = async (url: string, init: any) => { seen.push([url, init.method]); return { ok: true, text: async () => JSON.stringify({ suspended: "not_suspended", serviceDetails: { lastSuccessfulRunAt: "2026-10-25T22:09:06Z" } }) }; };
  assert.deepEqual(await renderApi({ RENDER_API_KEY: "k" }, svc)!.service("crn-f"), { lastSuccessfulRunAt: "2026-10-25T22:09:06Z", suspended: false });
  assert.deepEqual(seen[2], ["https://api.render.com/v1/services/crn-f", "GET"]);
  const runs = await cronRuns({ createJob: async () => { throw new Error("no"); }, runCron: async () => { throw new Error("no"); }, service: async (id) => { if (id === "crn-dbf7fau7bikc73cfh6og") throw new Error("render_api_500"); return { lastSuccessfulRunAt: id === "crn-dagu505g1s2s73cmseog" ? "2026-10-25T10:50:39Z" : null, suspended: false }; } });
  assert.equal(runs!.captions, "2026-10-25T10:50:39Z"); assert.equal(runs!.features, null); assert.equal("render" in runs!, false);
  assert.equal(await cronRuns(null), undefined);
  const bad: any = async () => ({ ok: false, status: 401, text: async () => "nope" });
  await assert.rejects(renderApi({ RENDER_API_KEY: "k" }, bad)!.runCron("crn-c"), /render_api_401/);
});

test("routes: operator-only, 503 without a Render key, publisher not runnable, render passes create one job per request slot", async (t) => {
  const sb: any = { from() { const q: any = { select() { return q }, gte() { return q }, order() { return q }, limit() { return q }, not() { return q }, range() { return Promise.resolve({ data: [], error: null }) }, then(r: any) { return Promise.resolve({ data: [], error: null, count: 0 }).then(r) } }; return q; }, rpc: async () => ({ data: 1, error: null }) };
  const created: string[] = [];
  const fakeRender = { createJob: async (_s: string, cmd: string) => { created.push(cmd); return { id: `job-${created.length}`, status: "pending" }; }, runCron: async (id: string) => ({ id: `run-${id}`, status: "triggered" }) };
  let key: any = null;
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { if (req.headers["x-test-user"]) { req.auth = { user_id: req.headers["x-test-user"] }; req.profile = { user_id: req.headers["x-test-user"], role: req.headers["x-test-role"] ?? "user" }; } next(); });
  app.use(accountAccess(() => sb)); registerOpsActions(app, () => sb, { render: () => key, now: () => now });
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: any, user?: string, role?: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...(role ? { "x-test-role": role } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post("/api/ops/actions/render", {})).status, 401);
  assert.equal((await post("/api/ops/actions/render", {}, "customer", "user")).status, 403);
  assert.equal((await post("/api/ops/actions/render", {}, OP, "admin")).status, 503);
  key = fakeRender;
  const r = await post("/api/ops/actions/render", { jobs: 2, max_jobs: 40 }, OP, "admin");
  assert.equal(r.status, 200); const body: any = await r.json(); assert.equal(body.jobs.length, 2); assert.equal(body.max_jobs, 40); assert.match(created[0], /LIBRARY_MAX_JOBS=40/);
  assert.equal((await post("/api/ops/actions/render", { jobs: 1 }, OP, "admin")).status, 429, "cooldown");
  assert.equal((await post("/api/ops/actions/run/publisher", {}, OP, "admin")).status, 404);
  const run = await post("/api/ops/actions/run/captions", {}, OP, "admin");
  assert.equal(run.status, 200); assert.equal(((await run.json()) as any).run.id, "run-crn-dagu505g1s2s73cmseog");
  assert.equal((await post("/api/ops/actions/schedule-account", { publer_account_id: "bad" }, OP, "admin")).status, 400);
});

test("defaultGate asks for the client's own gate account and never borrows another client's", async () => {
  const calls: any[] = [];
  const sb: any = { rpc: async (fn: string, args: any) => { calls.push([fn, args]); return { data: args.p_org === "org-a" ? "6ac981728c6bf22c85ebad8e" : null, error: null }; } };
  assert.equal(await defaultGate(sb, "org-a"), "6ac981728c6bf22c85ebad8e");
  assert.equal(await defaultGate(sb, "org-b"), null);
  assert.deepEqual(calls.map((c) => c[0]), ["client_gate_for", "client_gate_for"]);
});
