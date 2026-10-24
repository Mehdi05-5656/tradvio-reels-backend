import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, allowedOrigins, corsMiddleware } from "../src/cors.js";
import { latestPerPost, sumLatest, effectiveStaleMinutes } from "../src/analytics-util.js";

test("CORS allowlist: production, previews, clone8, localhost; everything else refused", () => {
  const list = allowedOrigins({});
  for (const ok of ["https://tradvio-reels.vercel.app", "https://tradvio-reels-git-feature-x.vercel.app", "https://clone8.io", "https://app.clone8.io", "http://localhost:5173"])
    assert.equal(isAllowedOrigin(ok, list), true, ok);
  for (const bad of ["https://evil.example", "http://clone8.io", "https://clone8.io.evil.example", "https://vercel.app", "null", undefined, "https://app.clone8.io/path"])
    assert.equal(isAllowedOrigin(bad as any, list), false, String(bad));
  assert.equal(isAllowedOrigin("https://staging.example.net", allowedOrigins({ CORS_ORIGINS: "https://staging.example.net, *.partner.test" })), true);
  assert.equal(isAllowedOrigin("https://a.partner.test", allowedOrigins({ CORS_ORIGINS: "*.partner.test" })), true);
});

test("CORS middleware sets headers only for allowed origins and answers preflight", () => {
  const mw = corsMiddleware(allowedOrigins({}));
  const run = (origin: string | undefined, method = "GET") => {
    const headers: Record<string, string> = {}; let status = 0, ended = false, nexted = false;
    const req: any = { method, header: (k: string) => (k === "origin" ? origin : undefined) };
    const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; }, status: (s: number) => { status = s; return res; }, end: () => { ended = true; } };
    mw(req, res, () => { nexted = true; });
    return { headers, status, ended, nexted };
  };
  const good = run("https://tradvio-reels.vercel.app");
  assert.equal(good.headers["Access-Control-Allow-Origin"], "https://tradvio-reels.vercel.app");
  assert.equal(good.nexted, true);
  const bad = run("https://evil.example");
  assert.equal(bad.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(bad.nexted, true);
  const pre = run("https://evil.example", "OPTIONS");
  assert.equal(pre.status, 204); assert.equal(pre.ended, true); assert.equal(pre.nexted, false);
  const none = run(undefined);
  assert.equal(none.headers["Access-Control-Allow-Origin"], undefined); assert.equal(none.nexted, true);
});

test("latestPerPost keeps one newest reading per post and sums do not double count", () => {
  const rows = [
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-20T10:00:00Z", video_views: 100 },
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-21T10:00:00Z", video_views: 150 },
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-19T10:00:00Z", video_views: 50 },
    { publer_post_id: "p2", phone_slot: "a", captured_at: "2026-10-21T09:00:00Z", video_views: null },
    { publer_post_id: "p1", phone_slot: "b", captured_at: "2026-10-21T10:00:00Z", video_views: 7 },
  ];
  const latest = latestPerPost(rows);
  assert.equal(latest.length, 3);
  assert.equal(sumLatest(rows, "video_views"), 157);
});

test("analytics staleness threshold never drops below the 3-hour pull interval", () => {
  assert.equal(effectiveStaleMinutes(30), 180);
  assert.equal(effectiveStaleMinutes(240), 240);
  assert.equal(effectiveStaleMinutes(undefined), 180);
});

test("window helpers: newest in-window capture per post, interactions and Publer's engagement rate", async () => {
  const { latestInWindow, interactions, engagementRatePct } = await import("../src/analytics-util.js");
  const rows = [
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-16T12:00:00Z", video_views: 10, reach: 10 }, // baseline, before window
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-17T08:00:00Z", video_views: 20, reach: 18 },
    { publer_post_id: "p1", phone_slot: "a", captured_at: "2026-10-17T23:00:00Z", video_views: 30, reach: 25, likes: 3, comments: 1, shares: null, saves: 1 },
    { publer_post_id: null as any, phone_slot: "a", captured_at: "2026-10-17T23:00:00Z", video_views: 999 }, // account-level row, ignored
  ];
  const latest = latestInWindow(rows, "2026-10-17T07:00:00Z");
  assert.equal(latest.length, 1);
  assert.equal(latest[0].video_views, 30);
  assert.equal(interactions(latest[0]), 5);
  assert.equal(engagementRatePct(latest[0]), 20);
  assert.equal(engagementRatePct({ likes: 4, reach: 0 }), 0);
  assert.equal(engagementRatePct({ likes: 1, comments: 0, reach: 3 }), 33.33);
});

test("fetchWindowSnapshots splits by account, then by time, when the database function refuses a large call", async () => {
  const { fetchWindowSnapshots } = await import("../src/analytics-util.js");
  const DAY = 86400_000, start = Date.parse("2026-10-01T07:00:00Z"), end = start + 8 * DAY;
  const slots = ["s1", "s2", "s3", "s4"];
  // Ground truth: each slot has 3 posts, one capture per day whose views grow by the day.
  const allRows = (slot: string, from: number, to: number) => {
    const rows: any[] = [];
    for (let d = 0; d < 8; d++) for (let p = 0; p < 3; p++) {
      const t = start + d * DAY + 3600_000;
      if (t >= from && t < to) rows.push({ publer_post_id: `${slot}-p${p}`, phone_slot: slot, captured_at: new Date(t).toISOString(), video_views: d * 10 + p, reach: 100 });
    }
    return rows;
  };
  const calls: number[] = [];
  const rpc = async ({ p_slots, p_start, p_end }: any) => {
    const from = Date.parse(p_start), to = Date.parse(p_end);
    const rows = p_slots.flatMap((s: string) => allRows(s, from, to));
    calls.push(rows.length);
    // Refuse anything over 20 rows, the way the real function refuses over 50,000.
    if (rows.length > 20) return { data: null, error: { message: "report_too_large_choose_shorter_range" } };
    return { data: rows, error: null };
  };
  const out = await fetchWindowSnapshots(rpc, slots, new Date(start).toISOString(), new Date(end).toISOString());
  assert.equal(out.length, 12); // 4 slots x 3 posts, one newest capture each
  for (const r of out) assert.equal(r.video_views >= 70, true, `newest capture kept for ${r.publer_post_id}`);
  assert.equal(calls.some((n) => n > 20), true); // the first call was refused
  assert.equal(calls.filter((n) => n <= 20).length >= 4, true); // then served in smaller parts
  // Errors other than the size cap propagate unchanged.
  await assert.rejects(fetchWindowSnapshots(async () => ({ data: null, error: { message: "permission denied" } }), ["s1"], new Date(start).toISOString(), new Date(end).toISOString()), /permission denied/);
  assert.deepEqual(await fetchWindowSnapshots(rpc, [], new Date(start).toISOString(), new Date(end).toISOString()), []);
});
