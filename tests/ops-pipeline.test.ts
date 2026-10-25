import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { summarizePipeline, registerOpsPipeline, summarizeWindows, type RawCounts } from "../src/ops-pipeline.js";
import { accountAccess } from "../src/account-access.js";

const now = new Date("2026-10-24T22:30:00Z");
const base = (): RawCounts => ({
  sources: 877, variants: { rendered_private: 12962, running: 4, pending: 189 }, queue: { "pending|managed-variants": 11636, "posted|managed-variants": 1326, "publer_publishing|reels": 9 },
  logs_today: { published: 72, failed: 1 }, stale_pending: 0, logs_7d_published: 846, logs_total_published: 2149, held_pending: 0, last_attempt_at: "2026-10-24T22:10:00Z",
  analytics_latest: "2026-10-24T22:00:00Z", analytics_snapshots_24h: 4100, analytics_pulls_24h: 140, measured_7d: 790, live_latest: null,
  live_accounts: { ok: 0, failed: 0, never: 18 }, features_latest: "2026-10-20T20:01:00Z", features_rows: 14742, captions_latest: "2026-09-13T10:53:00Z",
  library_control: { enabled: true, max_active: 4, max_daily_claims: 15000 }, upload: { phase: "idle", updated_at: "2026-10-24T21:15:00Z", expires_at: null },
  rate: { blocked_until: null, last_block_reason: null }, slots: { total: 18, enabled: 18, paused: 0 },
});

test("stages count the real pipeline and flag held submissions", () => {
  const s = summarizePipeline(base(), now);
  const byId = Object.fromEntries(s.stages.map((x) => [x.id, x]));
  assert.equal(byId.sources.count, 877);
  assert.equal(byId.rendered.count, 12962);
  assert.equal(byId.rendered.detail.running, 4);
  assert.equal(byId.queued.count, 11636);
  assert.equal(byId.queued.detail.in_flight, 9);
  assert.equal(byId.today.count, 72);
  assert.equal(byId.today.note, "1 failed windows");
  const held = summarizePipeline({ ...base(), held_pending: 2 }, now);
  assert.match(held.stages.find((x) => x.id === "today")!.note!, /2 held, do not resend/);
  assert.equal(held.jobs.find((j) => j.id === "publisher")!.health, "warn");
});

test("job health: stale captions are down, missing live metrics are off, idle features are ok", () => {
  const jobs = Object.fromEntries(summarizePipeline(base(), now).jobs.map((j) => [j.id, j]));
  assert.equal(jobs.publisher.health, "ok");
  assert.equal(jobs.analytics.health, "ok");
  assert.equal(jobs.captions.health, "down");
  assert.match(jobs.captions.note, /no new suggestions since 2026-09-13/);
  assert.equal(jobs.live.health, "off");
  assert.match(jobs.live.note, /ScrapeCreators key/);
  assert.equal(jobs.features.health, "ok");     // every queued video already has features, so a 4-day-old write is idle, not stale
  assert.match(jobs.features.note, /idle, all 14742 videos processed/);
  const backlog = summarizePipeline({ ...base(), features_rows: 12000 }, now);
  assert.equal(backlog.jobs.find((j) => j.id === "features")!.health, "down");
  assert.match(backlog.jobs.find((j) => j.id === "features")!.note, /971 videos waiting/);
  assert.equal(jobs.upload.health, "ok");
  const heldUpload = summarizePipeline({ ...base(), upload: { phase: "held", updated_at: "2026-10-24T20:00:00Z", expires_at: null } }, now);
  assert.equal(heldUpload.jobs.find((j) => j.id === "upload")!.health, "warn");
  assert.match(heldUpload.jobs.find((j) => j.id === "upload")!.note, /frozen/);
  const blocked = summarizePipeline({ ...base(), rate: { blocked_until: "2026-10-24T23:30:00Z", last_block_reason: "429" } }, now);
  assert.equal(blocked.jobs.find((j) => j.id === "rate")!.health, "warn");
});

test("route is admin-only: anonymous 401, customer 403, admin 200 with no table reads for the denied", async (t) => {
  const reads: string[] = [];
  const sb: any = { from(table: string) { reads.push(table); const q: any = { select() { return q }, order() { return q }, limit() { return q }, gte() { return q }, lt() { return q }, eq() { return q }, range() { return Promise.resolve({ data: [], error: null }) }, then(resolve: any) { return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve) } }; return q; } };
  const app = express();
  app.use((req: any, _res, next) => { if (req.headers["x-test-user"]) { req.auth = { user_id: req.headers["x-test-user"] }; req.profile = { role: req.headers["x-test-role"] ?? "user" }; } next(); });
  app.use(accountAccess(() => sb)); registerOpsPipeline(app, () => sb);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const get = async (user?: string, role?: string) => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/ops/pipeline`, { headers: { ...(user ? { "x-test-user": user } : {}), ...(role ? { "x-test-role": role } : {}) } });
  assert.equal((await get()).status, 401);
  assert.equal((await get("customer")).status, 403);
  assert.equal(reads.length, 0);
  const r = await get("operator", "admin");
  assert.equal(r.status, 200);
  const body: any = await r.json();
  assert.equal(body.stages.length, 6);
  assert.ok(body.jobs.some((j: any) => j.id === "publisher"));
});

test("today's windows count outcomes per window: a retried window is one published, not one failed", () => {
  const rows = [
    { phone_slot: "a", slot_index: 4, status: "failed", slot_local_date: "2026-10-24" },
    { phone_slot: "a", slot_index: 4, status: "failed", slot_local_date: "2026-10-24" },
    { phone_slot: "a", slot_index: 4, status: "published", slot_local_date: "2026-10-24" },
    { phone_slot: "a", slot_index: 5, status: "pending", slot_local_date: "2026-10-24" },
    { phone_slot: "b", slot_index: 4, status: "failed", slot_local_date: "2026-10-24" },
    { phone_slot: "b", slot_index: 3, status: "published", slot_local_date: "2026-10-24" },
  ];
  assert.deepEqual(summarizeWindows(rows), { published: 2, pending: 1, failed: 1 });
  const stale = summarizePipeline({ ...base(), stale_pending: 72 }, now);
  assert.match(stale.jobs.find((j) => j.id === "publisher")!.note, /72 old pending windows/);
  assert.equal(stale.jobs.find((j) => j.id === "publisher")!.health, "ok");
});
