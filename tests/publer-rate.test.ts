import test from "node:test";
import assert from "node:assert/strict";
import { _setPublerRateForTest, takeSlot, RateBudgetDeferred } from "../src/publer-rate.js";
import { jobStatus, uploadFromUrl, waitForJob, postInsights } from "../src/publer.js";
import { inPostingWindow, analyticsTick, ANALYTICS_ACCOUNT_INTERVAL_MS, inLongTailHours } from "../src/publer-schedule.js";

process.env.PUBLER_API_KEY = "test-key";
const realFetch = globalThis.fetch;
function backend(waits: number[] = []) {
  const calls: any = { acquire: [] as string[], block: [] as Array<[number, string]> };
  return {
    calls,
    b: {
      async acquire(l: any) { calls.acquire.push(l); return waits.length ? waits.shift()! : 0; },
      async block(u: number, r: string) { calls.block.push([u, r]); },
    },
  };
}
function respond(list: Array<{ status: number; body?: any; headers?: Record<string, string> }>) {
  const seen: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), method: init?.method || "GET" });
    const r = list.length > 1 ? list.shift()! : list[0];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as any;
  return seen;
}
test.afterEach(() => { globalThis.fetch = realFetch; _setPublerRateForTest(null); });

test("budget is a no-op when unconfigured; publishing waits for room, analytics defers without waiting", async () => {
  await takeSlot();
  const sleeps: number[] = [];
  const pub = backend([900, 400, 0]);
  _setPublerRateForTest(pub.b, { lane: "publish", sleep: async (ms) => { sleeps.push(ms); } });
  await takeSlot();
  assert.deepEqual(sleeps, [900, 400]);
  assert.equal(pub.calls.acquire.length, 3);
  const an = backend([5000]);
  _setPublerRateForTest(an.b, { lane: "analytics", sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(takeSlot(), RateBudgetDeferred);
  assert.equal(sleeps.length, 2);
});

test("publishing gives up after 3 minutes of waiting instead of hanging", async () => {
  const pub = backend(Array(10).fill(60_000));
  _setPublerRateForTest(pub.b, { lane: "publish", sleep: async () => {} });
  await assert.rejects(takeSlot(), RateBudgetDeferred);
  assert.equal(pub.calls.acquire.length, 4);
});

test("database outage falls back to local spacing rather than blocking publishing", async () => {
  const sleeps: number[] = [];
  let t = 1_000_000;
  _setPublerRateForTest({ async acquire() { throw new Error("db down"); }, async block() {} },
    { lane: "publish", sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
  await takeSlot(); await takeSlot();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1000 && sleeps[0] <= 1500);
});

test("a 429 on a status read pauses every process until Publer's reset, then retries the read", async () => {
  const sleeps: number[] = [];
  const pub = backend();
  _setPublerRateForTest(pub.b, { lane: "publish", sleep: async (ms) => { sleeps.push(ms); } });
  const reset = String(Math.floor(Date.now() / 1000) + 40);
  const seen = respond([
    { status: 429, body: { error: "Rate limit exceeded. Retry later." }, headers: { "x-ratelimit-reset": reset, "x-ratelimit-remaining": "0" } },
    { status: 200, body: { status: "complete", payload: { ok: 1 } } },
  ]);
  const j = await jobStatus("job1", "ws");
  assert.equal(j.status, "complete");
  assert.equal(seen.length, 2);
  assert.equal(pub.calls.block.length, 1);
  assert.equal(pub.calls.block[0][0], Number(reset) * 1000);
  assert.match(pub.calls.block[0][1], /429 GET \/job_status\/job1/);
  assert.ok(sleeps[0] > 30_000 && sleeps[0] <= 40_000);
  assert.equal(pub.calls.acquire.length, 2); // every attempt goes through the budget
});

test("a 429 on an upload or publish is never resent automatically", async () => {
  const pub = backend();
  _setPublerRateForTest(pub.b, { lane: "publish", sleep: async () => {} });
  const seen = respond([{ status: 429, body: { error: "Rate limit exceeded. Retry later." } }]);
  await assert.rejects(uploadFromUrl("ws", "https://x/v.mp4", "v.mp4"), (e: any) => e.status === 429);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(pub.calls.block.length, 1);
  // Missing or absurd reset headers fall back to a bounded pause.
  assert.ok(pub.calls.block[0][0] - Date.now() <= 60_000);
});

test("repeated 429s on a read stop after two retries", async () => {
  _setPublerRateForTest(backend().b, { lane: "publish", sleep: async () => {} });
  const seen = respond([{ status: 429, body: {}, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 9999) } }]);
  await assert.rejects(jobStatus("j", "ws"), (e: any) => e.status === 429);
  assert.equal(seen.length, 3);
});

test("analytics stops immediately on a 429 and an almost-empty window pauses everyone", async () => {
  const an = backend();
  _setPublerRateForTest(an.b, { lane: "analytics", sleep: async () => { throw new Error("analytics must not sleep"); } });
  respond([{ status: 429, body: {} }]);
  await assert.rejects(postInsights("ws", "acct", "2026-10-01", "2026-10-11"), RateBudgetDeferred);
  const pub = backend();
  _setPublerRateForTest(pub.b, { lane: "publish", sleep: async () => {} });
  respond([{ status: 200, body: { posts: [] }, headers: { "x-ratelimit-remaining": "3", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 20) } }]);
  await postInsights("ws", "acct", "2026-10-01", "2026-10-11");
  assert.equal(pub.calls.block[0][1], "near_limit");
  respond([{ status: 200, body: { posts: [] }, headers: { "x-ratelimit-remaining": "50" } }]);
  await postInsights("ws", "acct", "2026-10-01", "2026-10-11");
  assert.equal(pub.calls.block.length, 1);
});

test("status checks back off instead of polling every 2 seconds", async () => {
  const sleeps: number[] = [];
  _setPublerRateForTest(backend().b, { lane: "publish", sleep: async (ms) => { sleeps.push(ms); } });
  const seen = respond([
    { status: 200, body: { status: "working" } }, { status: 200, body: { status: "working" } },
    { status: 200, body: { status: "working" } }, { status: 200, body: { status: "working" } },
    { status: 200, body: { status: "working" } }, { status: 200, body: { status: "complete", payload: { id: 1 } } },
  ]);
  assert.deepEqual(await waitForJob("j", { workspaceId: "ws" }), { id: 1 });
  assert.deepEqual(sleeps, [3000, 4000, 6000, 10000, 15000, 15000]);
  assert.equal(seen.length, 6);
  // Old behaviour for a 40-second job: ~16 checks at 2.5s. New: 6.
});

test("posting windows cover 5 minutes before to 25 minutes after each slot", () => {
  const slots = ["08:00", "10:00", "22:00"];
  assert.equal(inPostingWindow(slots, 7 * 60 + 54), false);
  assert.equal(inPostingWindow(slots, 7 * 60 + 55), true);
  assert.equal(inPostingWindow(slots, 8 * 60 + 15), true);
  assert.equal(inPostingWindow(slots, 8 * 60 + 25), false);
  assert.equal(inPostingWindow(slots, 22 * 60 + 20), true);
  assert.equal(inPostingWindow(slots, 9 * 60 + 30), false);
});

function fakeDb(pulls: Array<{ phone_slot: string; pulled_at: string }>, slots: string[]) {
  const writes: any[] = [];
  const q = (table: string) => {
    const chain: any = {
      select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit() { return chain; },
      single: async () => ({ data: { workspace_id: "ws", timezone: "America/Los_Angeles", slot_times: ["08:00", "10:00", "12:00", "14:00"], jitter_minutes: 0 }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async (row: any) => { writes.push([table, row]); return { error: null }; },
      insert: async (row: any) => { writes.push([table, row]); return { error: null }; },
      then(res: any, rej: any) {
        const data = table === "publer_analytics_pulls" ? pulls :
          table === "publer_slot_config" ? slots.map((s) => ({ phone_slot: s, publer_account_id: `acct_${s}`, provider: "instagram", handle: s, daily_target: 4, paused: false, owner_user_id: "o" })) : [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return chain;
  };
  return { db: { from: q } as any, writes };
}

test("collector skips posting windows, pulls each account at most every 3 hours, oldest first, and defers cleanly", async () => {
  const at = new Date("2026-10-11T22:40:00Z"); // 3:40 PM PT, outside windows
  const inWindow = new Date("2026-10-11T21:05:00Z"); // 2:05 PM PT
  const seen = respond([{ status: 200, body: { posts: [] } }]);
  _setPublerRateForTest(backend().b, { lane: "analytics", sleep: async () => {} });
  const { db } = fakeDb([], ["a"]);
  assert.deepEqual(await analyticsTick(db, inWindow), { snapshots: 0, skipped: "posting_window" });
  assert.equal(seen.length, 0);

  const recent = new Date(at.getTime() - ANALYTICS_ACCOUNT_INTERVAL_MS + 60_000).toISOString();
  const old = new Date(at.getTime() - 5 * 3600_000).toISOString();
  const f = fakeDb([{ phone_slot: "a", pulled_at: recent }, { phone_slot: "b", pulled_at: old }], ["a", "b", "c"]);
  const r = await analyticsTick(f.db, at);
  assert.equal(r.accounts_pulled, 2);
  assert.deepEqual(seen.map((s) => new URL(s.url).pathname), ["/api/v1/analytics/acct_c/post_insights", "/api/v1/analytics/acct_b/post_insights"]);
  assert.deepEqual(f.writes.map((w) => w[1].phone_slot), ["c", "b"]);

  _setPublerRateForTest(backend([0, 7000]).b, { lane: "analytics", sleep: async () => {} });
  const g = fakeDb([], ["a", "b"]);
  const d = await analyticsTick(g.db, at);
  assert.equal(d.deferred, true);
  assert.equal(d.accounts_pulled, 1);
  assert.equal(g.writes.length, 1);
});

test("the Publer long tail runs only at night, one account per run, over posts 31-180 days old, and is marked weekly", async () => {
  const night = new Date("2026-10-12T09:40:00Z"); // 2:40 AM PT
  assert.equal(inLongTailHours(2 * 60 + 40), true); assert.equal(inLongTailHours(15 * 60), false); assert.equal(inLongTailHours(30), false);
  const seen = respond([
    { status: 200, body: { posts: [] } },                                            // regular pull, account b
    { status: 200, body: { posts: [{ id: 1, scheduled_at: "2026-09-06T15:00:00Z", analytics: { reach: { value: 10 }, video_views: { value: 12 } } }] } }, // long tail, account b
    { status: 200, body: { posts: [] } },                                            // regular pull, account a
  ]);
  _setPublerRateForTest(backend().b, { lane: "analytics", sleep: async () => {} });
  const old = new Date(night.getTime() - 5 * 3600_000).toISOString();
  const f = fakeDb([{ phone_slot: "a", pulled_at: old }, { phone_slot: "b", pulled_at: new Date(night.getTime() - 6 * 3600_000).toISOString() }, { phone_slot: "a:longtail", pulled_at: new Date(night.getTime() - 86400_000).toISOString() }], ["a", "b"]);
  const r = await analyticsTick(f.db, night);
  assert.equal(r.accounts_pulled, 2);
  assert.equal(r.long_tail_accounts, 1, "only one account per run, and a's long tail is a day old");
  assert.equal(r.snapshots, 1, "every long-tail post is snapshotted without the age filter");
  const urls = seen.map((s) => new URL(s.url));
  assert.equal(urls.length, 3);
  const lt = urls[1].searchParams;
  assert.equal(lt.get("to"), "2026-09-11"); // 31 days before the run, Pacific
  assert.equal(lt.get("from"), "2026-09-05"); // never before the pipeline start
  assert.deepEqual(f.writes.filter((w) => w[0] === "publer_analytics_pulls").map((w) => w[1].phone_slot), ["b", "b:longtail", "a"]);
});
