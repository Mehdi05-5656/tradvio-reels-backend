import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { parseInstagram, parseTikTok, matchToLogs, collectLiveMetrics, LIVE_INTERVAL_MS } from "../src/live-metrics.js";
import { buildReport, resolveRange, platformKey } from "../src/reporting.js";

// Minimal in-memory stand-in for the supabase-js query builder calls the collector makes.
function fakeSb(tables: Record<string, any[]>) {
  return {
    tables,
    from(name: string) {
      const rows = (tables[name] ??= []);
      let filters: ((r: any) => boolean)[] = [], mode = "select", patch: any = null, order: [string, boolean] | null = null, lim: number | null = null;
      const q: any = {
        select() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        gte(k: string, v: any) { filters.push((r) => String(r[k]) >= String(v)); return q; },
        lt(k: string, v: any) { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) < String(v)); return q; },
        limit(n: number) { lim = n; return q; },
        order(k: string, o: any) { order = [k, o?.ascending !== false]; return q; },
        update(p: any) { mode = "update"; patch = p; return q; },
        insert(list: any[]) { list.forEach((r, i) => rows.push({ id: rows.length + i + 1, ...r })); return Promise.resolve({ error: null }); },
        then(res: any, rej: any) {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update") { hit.forEach((r) => Object.assign(r, patch)); return Promise.resolve({ error: null }).then(res, rej); }
          if (order) { const [k, asc] = order; hit.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (asc ? 1 : -1)); }
          const out = lim === null ? hit : hit.slice(0, lim);
          return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(res, rej);
        },
      };
      return q;
    },
  } as any;
}

const now = new Date("2026-10-11T22:00:00Z");
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("parses ScrapeCreators Instagram and TikTok responses and skips malformed ids", () => {
  const ig = parseInstagram({ more_available: true, next_max_id: "c1", items: [
    { code: "DeXmS7yFEqB", taken_at: sec("2026-10-11T21:00:00Z"), product_type: "clips", ig_play_count: 12, like_count: 1, comment_count: 0, reshare_count: null, save_count: null, caption: { text: "Bro what" } },
    { code: "bad code!", taken_at: 1 }] });
  assert.equal(ig.posts.length, 1);
  assert.equal(ig.posts[0].post_link, "https://www.instagram.com/reel/DeXmS7yFEqB/");
  assert.deepEqual([ig.posts[0].video_views, ig.posts[0].likes, ig.posts[0].shares], [12, 1, null]);
  assert.equal(ig.next, "c1");
  const tt = parseTikTok({ has_more: 0, max_cursor: 5, aweme_list: [
    { aweme_id: "7695518509371034910", create_time: sec("2026-10-11T21:00:00Z"), desc: "x", is_top: 1,
      statistics: { play_count: 21, digg_count: 2, comment_count: 1, share_count: 3, collect_count: 4 } }] }, "tradvio");
  assert.equal(tt.posts[0].post_link, "https://www.tiktok.com/@tradvio/video/7695518509371034910");
  assert.deepEqual([tt.posts[0].shares, tt.posts[0].saves, tt.posts[0].pinned], [3, 4, true]);
  assert.equal(tt.next, null);
});

test("TikTok matching needs the same caption and a close publish time, and refuses ambiguity", () => {
  const p = (id: string, caption: string, at: string) => ({ platform_post_id: id, post_link: "", posted_at: at, caption,
    video_views: 1, likes: 0, comments: 0, shares: 0, saves: 0, pinned: false });
  const logs = [
    { publer_post_id: "L1", caption_used: "When the setup finally plays out", updated_at: "2026-10-11T15:05:00Z" },
    { publer_post_id: "L2", caption_used: "Same caption twice in a row", updated_at: "2026-10-11T17:05:00Z" },
    { publer_post_id: "L3", caption_used: "Same caption twice in a row", updated_at: "2026-10-11T17:20:00Z" },
    { publer_post_id: "L4", caption_used: "Exact link wins", publer_post_link: "https://www.tiktok.com/@x/video/999999", updated_at: "2026-10-11T01:00:00Z" },
  ];
  const m = matchToLogs("tiktok", [
    p("111111", "When the setup finally plays out #trading #fx", "2026-10-11T15:09:00Z"),
    p("222222", "Same caption twice in a row", "2026-10-11T17:10:00Z"),
    p("333333", "When the setup finally plays out", "2026-10-11T19:09:00Z"), // too late for L1
    p("999999", "anything", "2026-10-11T23:00:00Z"),
  ], logs);
  assert.equal(m.get("111111"), "L1");
  assert.equal(m.has("222222"), false, "two candidate logs: ambiguous");
  assert.equal(m.has("333333"), false);
  assert.equal(m.get("999999"), "L4");
  const ig = matchToLogs("instagram", [p("DeXmS7yFEqB", "", "2026-10-11T21:00:00Z")],
    [{ publer_post_id: "P", publer_post_link: "https://www.instagram.com/reel/DeXmS7yFEqB/" }]);
  assert.equal(ig.get("DeXmS7yFEqB"), "P");
});

test("collector is hourly per account, dedupes unchanged numbers, deep-pages, and isolates errors", async () => {
  const sb = fakeSb({
    live_metric_accounts: [
      { phone_slot: "ig1", provider: "instagram", username: "tradvio", enabled: true },
      { phone_slot: "tt1", provider: "tiktok", username: "tradvio", enabled: true },
      { phone_slot: "bad", provider: "tiktok", username: "gone", enabled: true },
      { phone_slot: "off", provider: "tiktok", username: "off", enabled: false },
    ],
    publer_publish_log: [
      { phone_slot: "ig1", status: "published", slot_local_date: "2026-10-11", publer_post_id: "P1", publer_post_link: "https://www.instagram.com/reel/AAAAA1/" },
      { phone_slot: "tt1", status: "published", slot_local_date: "2026-10-11", publer_post_id: "T1", caption_used: "Gold just swept the lows again", updated_at: "2026-10-11T15:00:00Z" },
    ],
    live_post_metrics: [],
  });
  const calls: string[] = [];
  let views = 100;
  const fetchImpl: any = async (url: string, init: any) => {
    assert.equal(init.headers["x-api-key"], "k");
    calls.push(url);
    if (url.includes("handle=gone")) return new Response("{}", { status: 404 });
    if (url.includes("instagram")) {
      const second = url.includes("next_max_id");
      return Response.json({ success: true, more_available: !second, next_max_id: "n1", items: second
        ? [{ code: "OLDOLD", taken_at: sec("2026-09-01T00:00:00Z"), ig_play_count: 5 }]
        : [{ code: "AAAAA1", taken_at: sec("2026-10-11T15:00:00Z"), ig_play_count: views, like_count: 3, comment_count: 1 }] });
    }
    return Response.json({ success: true, has_more: 0, aweme_list: [
      { aweme_id: "7000000000001", create_time: sec("2026-10-11T15:06:00Z"), desc: "Gold just swept the lows again #gold", is_top: 0,
        statistics: { play_count: 50, digg_count: 2, comment_count: 0, share_count: 1, collect_count: 1 } },
      { aweme_id: "7000000000002", create_time: sec("2025-01-01T00:00:00Z"), desc: "old pinned", is_top: 1, statistics: { play_count: 9e5 } }] });
  };
  const opts = { apiKey: "k", fetchImpl, sleep: async () => {}, now };
  assert.deepEqual(await collectLiveMetrics(sb, { ...opts, apiKey: "" }), { status: "disabled" });

  const r1: any = await collectLiveMetrics(sb, opts);
  assert.equal(r1.accounts, 2);
  assert.equal(r1.errors.length, 1);
  assert.equal(calls.filter((u) => u.includes("instagram")).length, 2, "first run is a long-tail pull (pages until the feed is older than 90 days)");
  assert.equal(r1.long_tail, 2, "both working accounts had never had a long-tail pass");
  const rows = sb.tables.live_post_metrics;
  // The 40-day-old post is inside the 90-day long tail and is kept; the pinned 2025 post is outside it.
  assert.deepEqual(rows.map((r: any) => [r.platform_post_id, r.publer_post_id]).sort(), [["7000000000001", "T1"], ["AAAAA1", "P1"], ["OLDOLD", null]]);
  const bad = sb.tables.live_metric_accounts.find((a: any) => a.phone_slot === "bad");
  assert.equal(bad.last_error, "scrapecreators_http_404");
  assert.equal(now.getTime() - Date.parse(bad.last_pulled_at), LIVE_INTERVAL_MS - 15 * 60_000, "retry in 15 minutes");

  // 10 minutes later nothing is due except nothing; an hour later only changed numbers are saved.
  calls.length = 0;
  await collectLiveMetrics(sb, { ...opts, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(calls.length, 0);
  views = 140;
  const r3: any = await collectLiveMetrics(sb, { ...opts, now: new Date(now.getTime() + 60 * 60_000) });
  assert.equal(calls.filter((u) => u.includes("instagram")).length, 1, "hourly pull is one page; the long tail ran today already");
  assert.equal(r3.long_tail, 0);
  assert.equal(r3.snapshots, 1, "TikTok unchanged, Instagram changed");
  assert.equal(rows.length, 4);
});

test("report merges live and Publer: live wins when fresh, Publer fills shares and saves, one timeline", () => {
  const range = resolveRange({ from: "2026-10-11", to: "2026-10-11" }, new Date("2026-10-11T23:00:00Z"));
  const slots = [{ phone_slot: "a", handle: "tradvio", provider: "instagram", paused: false, daily_target: 8 }];
  const link = "https://www.instagram.com/reel/DeXmS7yFEqB/";
  const logs = [{ id: 1, phone_slot: "a", status: "published", slot_local_date: "2026-10-11", slot_index: 0,
      updated_at: "2026-10-11T08:00:00Z", publer_post_id: "P1", publer_post_link: link },
    { id: 2, phone_slot: "a", status: "published", slot_local_date: "2026-10-11", slot_index: 1,
      updated_at: "2026-10-11T18:00:00Z", publer_post_id: "P2", publer_post_link: "https://www.instagram.com/reel/HIDDEN1/" }];
  const pub = [
    { id: 1, phone_slot: "a", publer_post_id: link, captured_at: "2026-10-11T10:00:00Z", video_views: 50, reach: 40, likes: 1, comments: 0, shares: 2, saves: 3, raw: { scheduled_at: "2026-10-11T08:00:00Z", post_link: link } },
    { id: 2, phone_slot: "a", publer_post_id: link, captured_at: "2026-10-11T21:00:00Z", video_views: 60, reach: 45, likes: 1, comments: 0, shares: 2, saves: 3, raw: { scheduled_at: "2026-10-11T08:00:00Z", post_link: link } },
  ];
  const live = [
    { id: 1, phone_slot: "a", provider: "instagram", platform_post_id: "DeXmS7yFEqB", post_link: link, publer_post_id: "P1", posted_at: "2026-10-11T08:00:00Z", captured_at: "2026-10-11T12:00:00Z", video_views: 300, likes: 9, comments: 2, shares: null, saves: null },
    { id: 2, phone_slot: "a", provider: "instagram", platform_post_id: "DeXmS7yFEqB", post_link: link, publer_post_id: "P1", posted_at: "2026-10-11T08:00:00Z", captured_at: "2026-10-11T22:00:00Z", video_views: 1969, likes: 22, comments: 4, shares: null, saves: null },
  ];
  const accounts = [{ phone_slot: "a", username: "tradvio", last_pulled_at: "2026-10-11T22:00:00Z", last_status: "ok: 1" }];
  const r: any = buildReport(slots, logs, pub, range, live, accounts);
  const p = r.posts.find((x: any) => x.id === "a|P1");
  assert.deepEqual([p.video_views, p.likes, p.comments, p.shares, p.saves, p.reach], [1969, 22, 4, 2, 3, 45]);
  assert.equal(p.metrics_source, "live+publer");
  assert.equal(p.live_captured_at, "2026-10-11T22:00:00.000Z");
  assert.equal(p.public_visibility, "public");
  assert.equal(r.posts.find((x: any) => x.id === "a|P2").public_visibility, "not_found_publicly");
  // Gains: Publer 50 (new post) until live starts, then live 300 -> 1969. Publer's later 60 is ignored.
  assert.equal(r.totals.observed_views, 50 + (300 - 50) + (1969 - 300));
  assert.equal(r.posts.length, 2, "no duplicate analytics-only row");
  assert.equal(r.accounts[0].not_found_publicly, 1);
  assert.equal(r.totals.latest_live_update, "2026-10-11T22:00:00.000Z");

  // Stale live data (collector stopped) gives way to Publer.
  const stale: any = buildReport(slots, logs, [{ ...pub[1], captured_at: "2026-10-11T22:30:00Z" }], range, [live[0]], accounts);
  const s = stale.posts.find((x: any) => x.id === "a|P1");
  assert.equal(s.metrics_source, "publer");
  assert.equal(s.video_views, 60);
  assert.equal(platformKey("https://www.tiktok.com/@x/video/123?utm=1"), "tt:123");
});

test("live migration is idempotent, seeds only matching slots, and reduces to one row per post per day", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE publer_slot_config(phone_slot text primary key, provider text);
    INSERT INTO publer_slot_config VALUES ('phone_a','instagram'),('tiktok_tradvio','tiktok'),('library_6ac6bf7c88440f1ee1267b04','instagram');`);
  const m = await readFile("migrations/20261011220000_live_post_metrics.sql", "utf8");
  await db.exec(m); await db.exec(m);
  const seeded = (await db.query<any>("SELECT phone_slot, username FROM live_metric_accounts ORDER BY 1")).rows;
  assert.deepEqual(seeded, [{ phone_slot: "phone_a", username: "tradvio" }, { phone_slot: "tiktok_tradvio", username: "tradvio" }], "provider mismatch is skipped");
  await db.exec(`INSERT INTO live_post_metrics(phone_slot,provider,platform_post_id,captured_at,video_views) VALUES
    ('phone_a','instagram','X','2026-10-10T20:00:00Z',5),
    ('phone_a','instagram','X','2026-10-11T08:00:00Z',10),('phone_a','instagram','X','2026-10-11T20:00:00Z',20),
    ('phone_a','instagram','X','2026-10-12T06:30:00Z',30),('phone_a','instagram','X','2026-10-12T08:00:00Z',99),
    ('phone_a','instagram','Y','2026-10-11T09:00:00Z',1)`);
  await db.exec("SET ROLE service_role");
  const rows = (await db.query<any>("SELECT dashboard_live_snapshots(ARRAY['phone_a'],'2026-10-11T07:00:00Z','2026-10-12T07:00:00Z') d")).rows[0].d;
  assert.deepEqual(rows.map((r: any) => [r.platform_post_id, r.video_views]), [["X", 5], ["Y", 1], ["X", 30]]);
  await db.exec("RESET ROLE");
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query("SELECT * FROM live_post_metrics"), /permission denied/);
    await assert.rejects(db.query("SELECT dashboard_live_snapshots(ARRAY['phone_a'],now(),now())"), /permission denied/);
    await db.exec("RESET ROLE");
  }
});
