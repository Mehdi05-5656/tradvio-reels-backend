import test from "node:test";
import assert from "node:assert/strict";
import { publishOne, reconcilePendingPublications, eligibleSlotIndexes, ptDateTimeToUtc } from "../src/publer-schedule.js";

const cfg = { workspaceId: "workspace", timezone: "America/Los_Angeles", slotTimes: ["08:00", "10:00"], jitterMinutes: 10 };
const slot = { phone_slot: "phone_a", publer_account_id: "a1", provider: "instagram" as const, handle: "test", daily_target: 2, paused: false, owner_user_id: null };
const result = [{ post: { id: "post1", account_id: "a1", state: "published", post_link: null } }];

function database() {
  const tables: Record<string, any[]> = {
    reels_manual_queue: [{ id: "q1", phone_slot: "phone_a", status: "pending", storage_path: "x.mp4", created_at: "2026-01-01" }],
    publer_publish_log: [], queue_suggestions: [], device_content_templates: [],
  };
  let failWrite: ((table: string, value: any) => boolean) | undefined;
  const sb: any = {
    tables,
    fail(fn: typeof failWrite) { failWrite = fn; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://test.invalid/video" }, error: null }) }) },
    from(table: string) {
      const filters: ((row: any) => boolean)[] = [];
      let action = "select", value: any, single = false, options: any, limit = Infinity;
      let sort = "", ascending = true;
      const query: any = {
        select(_columns: string, opts?: any) { options = opts; return query; },
        eq(k: string, v: any) { filters.push(r => r[k] === v); return query; },
        in(k: string, v: any[]) { filters.push(r => v.includes(r[k])); return query; },
        lt(k: string, v: any) { filters.push(r => r[k] < v); return query; },
        order(k: string, opts: any) { sort = k; ascending = opts.ascending; return query; },
        limit(n: number) { limit = n; return query; },
        update(v: any) { action = "update"; value = v; return query; },
        insert(v: any) { action = "insert"; value = v; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            if (action !== "select" && failWrite?.(table, value)) return { data: null, error: { message: "database unavailable" } };
            const rows = tables[table] ||= [];
            if (action === "insert") rows.push({ id: rows.length + 1, attempted_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...value });
            let matching = rows.filter(r => filters.every(f => f(r)));
            if (action === "insert") matching = [rows[rows.length - 1]];
            if (sort) matching.sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
            matching = matching.slice(0, limit);
            if (action === "update") matching.forEach(r => Object.assign(r, value));
            return { data: options?.head ? null : single ? matching[0] ?? null : matching.map(r => ({ ...r })), count: matching.length, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return sb;
}

function network(t: any, opts: { payload?: any; upload?: any; sendThrows?: boolean; onSend?: () => void } = {}) {
  process.env.PUBLER_API_KEY = "test-only";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: any) => {
    calls.push(url);
    let body: any;
    if (url.endsWith("/media/from-url")) body = { job_id: "upload1" };
    else if (url.endsWith("/job_status/upload1")) body = { status: "complete", payload: opts.upload ?? [{ id: "media1", path: "https://test.invalid/media" }] };
    else if (url.endsWith("/posts/schedule/publish")) {
      opts.onSend?.();
      if (opts.sendThrows) throw new Error("lost connection after submit");
      body = { job_id: "publish1" };
    } else if (url.endsWith("/job_status/publish1")) body = { status: "complete", payload: opts.payload ?? result };
    else throw new Error("unexpected network request: " + url);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

test("publish persists exact ID and marks queue posted without list heuristics", async t => {
  const sb = database();
  const calls = network(t);
  assert.equal((await publishOne(sb, cfg, slot, 0, "2026-09-23")).status, "published");
  assert.equal(sb.tables.publer_publish_log[0].publer_job_id, "publish1");
  assert.equal(sb.tables.publer_publish_log[0].publer_post_id, "post1");
  assert.equal(sb.tables.reels_manual_queue[0].status, "posted");
  assert.equal(calls.length, 4);
});
test("atomic queue claim allows only one worker to send", async t => {
  const sb = database();
  const calls = network(t);
  await Promise.all([publishOne(sb, cfg, slot, 0, "2026-09-23"), publishOne(sb, cfg, slot, 1, "2026-09-23")]);
  assert.equal(calls.filter(url => url.endsWith("/posts/schedule/publish")).length, 1);
});
test("lost submit response holds the row and keeps reservation", async t => {
  const sb = database();
  network(t, { sendThrows: true });
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(sb.tables.reels_manual_queue[0].status, "publer_publishing");
  assert.equal(sb.tables.publer_publish_log[0].status, "pending");
  assert.equal(sb.tables.publer_publish_log[0].raw_publish_payload._publisher.phase, "submitting");
  assert.equal((await publishOne(sb, cfg, slot, 1, "2026-09-23")).status, "no_queue");
});
test("unrecognized completed payload is held, not marked published", async t => {
  const sb = database();
  network(t, { payload: { post_ids: ["not-enough-proof"] } });
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(sb.tables.publer_publish_log[0].status, "pending");
  assert.equal(sb.tables.publer_publish_log[0].publer_job_id, "publish1");
});
test("failed pre-submit database write never calls publish", async t => {
  const sb = database();
  const calls = network(t);
  sb.fail((table, value) => table === "publer_publish_log" && value?.raw_publish_payload?._publisher?.phase === "submitting");
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(calls.filter(url => url.endsWith("/posts/schedule/publish")).length, 0);
  assert.equal(sb.tables.reels_manual_queue[0].status, "pending");
});
test("confirmed publish with failed final DB write is never resent", async t => {
  const sb = database();
  const calls = network(t);
  sb.fail((table, value) => table === "publer_publish_log" && value?.status === "published");
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(sb.tables.reels_manual_queue[0].status, "posted");
  assert.equal(sb.tables.publer_publish_log[0].status, "pending");
  sb.fail(undefined);
  sb.tables.publer_publish_log[0].updated_at = "2026-01-01";
  await reconcilePendingPublications(sb, cfg, slot);
  assert.equal(sb.tables.publer_publish_log[0].status, "published");
  assert.equal(calls.filter(url => url.endsWith("/posts/schedule/publish")).length, 1);
});
test("stale submitted job is reconciled with GET only", async t => {
  const sb = database();
  sb.tables.reels_manual_queue[0].status = "publer_publishing";
  sb.tables.publer_publish_log.push({ id: 1, queue_id: "q1", phone_slot: "phone_a", status: "pending", publer_job_id: "publish1", updated_at: "2026-01-01", raw_publish_payload: { _publisher: { phase: "submitted" } } });
  const calls = network(t);
  await reconcilePendingPublications(sb, cfg, slot);
  assert.equal(sb.tables.publer_publish_log[0].status, "published");
  assert.deepEqual(calls, ["https://app.publer.com/api/v1/job_status/publish1"]);
});
test("media rejection quarantines only after retry budget; storage retained", async t => {
  const sb = database();
  sb.tables.publer_publish_log.push(...[1, 2].map(id => ({ id, queue_id: "q1", status: "failed", attempted_at: "2026-01-01", error: "Videos need to be smaller than 2 gb" })));
  network(t, { upload: [{ error: "Videos need to be smaller than 2 gb" }] });
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(sb.tables.reels_manual_queue[0].status, "skipped");
  assert.equal(sb.tables.reels_manual_queue[0].storage_path, "x.mp4");
});
test("cooling down row does not stop later ready videos", async t => {
  const sb = database();
  sb.tables.reels_manual_queue.push({ ...sb.tables.reels_manual_queue[0], id: "q2", created_at: "2026-01-02" });
  sb.tables.publer_publish_log.push({ id: 1, queue_id: "q1", status: "failed", attempted_at: new Date().toISOString(), error: "HTTP 503" });
  network(t);
  await publishOne(sb, cfg, slot, 0, "2026-09-23");
  assert.equal(sb.tables.reels_manual_queue[0].status, "pending");
  assert.equal(sb.tables.reels_manual_queue[1].status, "posted");
});
test("schedule due times, target cap and DST remain unchanged", () => {
  assert.deepEqual(eligibleSlotIndexes(["08:00", "10:00", "12:00"], 2, 12 * 60), [0, 1]);
  assert.deepEqual(eligibleSlotIndexes(["08:00"], 8, 7 * 60), []);
  assert.equal(ptDateTimeToUtc("2026-09-23", "14:00").toISOString(), "2026-09-23T21:00:00.000Z");
  assert.equal(ptDateTimeToUtc("2026-12-23", "14:00").toISOString(), "2026-12-23T22:00:00.000Z");
});
