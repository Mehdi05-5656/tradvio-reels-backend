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
  live_accounts: { ok: 0, failed: 0, never: 18 }, features_latest: "2026-10-20T20:01:00Z", features_rows: 14742, captions_latest: "2026-09-13T10:53:00Z", captions: { slots: 3, pending: 895, backlog: 0 }, leader_latest: "2026-10-24T10:00:00Z", render_latest: "2026-10-24T10:00:00Z",
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

test("job health: captions with no backlog are idle, missing live metrics are off, idle features are ok", () => {
  const jobs = Object.fromEntries(summarizePipeline(base(), now).jobs.map((j) => [j.id, j]));
  assert.equal(jobs.publisher.health, "ok");
  assert.equal(jobs.analytics.health, "ok");
  assert.equal(jobs.captions.health, "ok");
  assert.match(jobs.captions.note, /^idle: all 895 pending videos on 3 accounts have a suggestion/);
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
  // Like supabase-js, rpc() returns a thenable with no .catch(); a missing function answers with an error, not a throw.
  const sb: any = { rpc(name: string) { reads.push(`rpc:${name}`); return { then(resolve: any) { return Promise.resolve({ data: null, error: { message: "function not found" } }).then(resolve) } }; }, from(table: string) { reads.push(table); const q: any = { select() { return q }, order() { return q }, limit() { return q }, gte() { return q }, lt() { return q }, eq() { return q }, in() { return q }, range() { return Promise.resolve({ data: [], error: null }) }, then(resolve: any) { return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve) } }; return q; } };
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

test("caption job is idle, not down, when every pending video already has a suggestion; a real backlog with stale writes warns", () => {
  const now = new Date("2026-10-25T20:00:00Z");
  const idle = summarizePipeline({ ...base(), captions_latest: "2026-09-13T10:53:00Z", captions: { slots: 3, pending: 895, backlog: 0 } }, now).jobs.find((j) => j.id === "captions")!;
  assert.equal(idle.health, "ok"); assert.match(idle.note, /^idle: all 895 pending videos on 3 accounts have a suggestion/);
  const behind = summarizePipeline({ ...base(), captions_latest: "2026-09-13T10:53:00Z", captions: { slots: 3, pending: 895, backlog: 40 } }, now).jobs.find((j) => j.id === "captions")!;
  assert.equal(behind.health, "down"); assert.match(behind.note, /^40 of 895 pending videos still need a suggestion/);
  const none = summarizePipeline({ ...base(), captions: { slots: 0, pending: 0, backlog: 0 } }, now).jobs.find((j) => j.id === "captions")!;
  assert.equal(none.health, "off");
});

test("captionBacklog counts pending videos on the worker's accounts that lack a nightly suggestion", async () => {
  const calls: string[] = [];
  const table = (name: string, rows: any[]) => { const q: any = { select() { return q }, eq() { return q }, in(_c: string, v: string[]) { q._in = v; return q }, range() { return Promise.resolve({ data: rows, error: null }) }, then(res: any) { calls.push(name); return Promise.resolve({ data: name === "queue_suggestions" ? rows.filter((r) => (q._in ?? []).includes(r.queue_id)) : rows, error: null }).then(res) } }; return q; };
  const sb: any = { from(name: string) { return table(name, name === "reels_devices" ? [{ phone_slot: "phone_a" }, { phone_slot: "phone_b" }] : name === "publer_slot_config" ? [{ phone_slot: "phone_a" }, { phone_slot: "library_1" }] : name === "reels_manual_queue" ? [{ id: "q1" }, { id: "q2" }, { id: "q3" }] : [{ queue_id: "q1" }, { queue_id: "q3" }, { queue_id: "other" }]); } };
  const { captionBacklog } = await import("../src/ops-pipeline.js");
  assert.deepEqual(await captionBacklog(sb), { slots: 3, pending: 3, backlog: 1 }, "legacy and library accounts, deduplicated");
});

test("Render run records separate 'not running' from 'running but every item fails', and blocked variants do not alarm the renderer", () => {
  const now = new Date("2026-10-26T01:00:00Z");
  const withRuns = (runs: Record<string, string | null>, extra: Partial<RawCounts> = {}) => Object.fromEntries(summarizePipeline({ ...base(), ...extra, cron_runs: runs }, now).jobs.map((j) => [j.id, j]));
  // Features: backlog, no write for 5 days, but the hourly cron exited 0 an hour ago -> the worker runs and fails inside.
  const silent = withRuns({ features: "2026-10-26T00:09:00Z" }, { features_rows: 12000 }).features;
  assert.equal(silent.health, "warn"); assert.match(silent.note, /ran 51 min ago but has written nothing since 5 days ago/); assert.equal(silent.last_at, "2026-10-26T00:09:00Z");
  // Same backlog, cron not seen for a day -> down.
  const dead = withRuns({ features: "2026-10-25T00:09:00Z" }, { features_rows: 12000 }).features;
  assert.equal(dead.health, "down");
  // Captions: a backlog with the nightly run 14 h ago is healthy; a run 40 h ago warns; none in 4 days is down.
  const backlog = { slots: 20, pending: 13199, backlog: 12310 };
  assert.equal(withRuns({ captions: "2026-10-25T10:50:00Z" }, { captions: backlog }).captions.health, "ok");
  assert.match(withRuns({ captions: "2026-10-25T10:50:00Z" }, { captions: backlog }).captions.note, /^ran 14 h ago; 12310 of 13199 pending videos have no nightly suggestion yet/);
  assert.equal(withRuns({ captions: "2026-10-24T09:00:00Z" }, { captions: backlog }).captions.health, "warn");
  assert.equal(withRuns({ captions: "2026-10-22T09:00:00Z" }, { captions: backlog }).captions.health, "down");
  // Renderer: 3 blocked variants are a note, not a warning, while rendering is active.
  const active = withRuns({ render: "2026-10-26T00:45:00Z" }, { variants: { rendered_private: 13400, running: 3, pending: 1100, blocked: 3 }, render_latest: "2026-10-26T00:50:00Z" }).render;
  assert.equal(active.health, "ok"); assert.match(active.note, /3 blocked/);
  // A pending backlog whose scheduled pass has never succeeded warns and says why.
  const never = withRuns({ render: null }, { variants: { rendered_private: 13400, running: 0, pending: 1100 }, render_latest: "2026-10-25T23:30:00Z" }).render;
  assert.equal(never.health, "warn"); assert.match(never.note, /never succeeded/);
  // Without a Render key nothing changes: table timestamps decide.
  const legacy = Object.fromEntries(summarizePipeline({ ...base(), features_rows: 12000 }, now).jobs.map((j) => [j.id, j]));
  assert.equal(legacy.features.health, "down");
});

test("a full storage budget explains an idle renderer with pending work", () => {
  const now = new Date("2026-10-26T01:05:00Z");
  const full = summarizePipeline({ ...base(), variants: { rendered_private: 13777, running: 0, pending: 1132, blocked: 3 }, render_latest: "2026-10-26T01:01:00Z",
    library_storage: { stored_bytes: 53620937453, stored_objects: 13774, max_output_bytes: 53687091200, reserve_bytes: 67108864 }, cron_runs: { render: "2026-10-26T01:01:40Z" } }, now).jobs.find((j) => j.id === "render")!;
  assert.equal(full.health, "warn"); assert.match(full.note, /storage budget reached \(49\.9 of 50\.0 GiB\)/);
  const room = summarizePipeline({ ...base(), variants: { rendered_private: 13777, running: 2, pending: 1132 }, render_latest: "2026-10-26T01:01:00Z",
    library_storage: { stored_bytes: 53620937453, stored_objects: 13774, max_output_bytes: 64424509440, reserve_bytes: 67108864 }, cron_runs: { render: "2026-10-26T01:01:40Z" } }, now).jobs.find((j) => j.id === "render")!;
  assert.equal(room.health, "ok"); assert.doesNotMatch(room.note, /budget/);
});
