import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { isDue, pullContent, summarize, rangeFor, sanitizeAccountInput, parseProfileLink, median, HOUR, DAY, type AccountRow, type VideoRow, type SnapshotRow, type SignupRow } from "../src/studio-content-perf.js";
import { registerContentPerf } from "../src/studio-content-perf-routes.js";
import { sanitizeAnswers } from "../src/studio-onboarding.js";
import { clearAdminCacheForTests } from "../src/studio-admin-auth.js";

const NOW = Date.parse("2026-11-19T20:00:00Z"); // noon PT
const PT = -480;
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (t: number) => new Date(t).toISOString();

function account(over: Partial<AccountRow> = {}): AccountRow {
  return { id: A1, platform: "tiktok", handle: "bty.clips", url: null, display_name: null, owner_kind: "creator", cost_usd_per_video: null, cost_usd_per_month: null, default_feature: null, enabled: true,
    tracking_since: iso(NOW - 5 * DAY), followers: 1000, avatar_key: null, latest_posted_at: null, last_pulled_at: null, last_profile_at: null, last_status: null, last_error: null, ...over };
}
function video(id: string, over: Partial<VideoRow> = {}): VideoRow {
  return { id, account_id: A1, platform: "tiktok", platform_post_id: id, url: `https://www.tiktok.com/@bty.clips/video/${id}`, caption: `video ${id}`, posted_at: iso(NOW - 2 * DAY), duration_s: 25, thumb_key: null,
    first_seen_at: iso(NOW - 2 * DAY), pre_tracking: false, base_views: 100, base_likes: 10, base_comments: 1, base_shares: 1, base_saves: 1, views: 100, likes: 10, comments: 1, shares: 1, saves: 1, latest_at: iso(NOW - 2 * DAY),
    tags: {}, tag_source: null, cost_usd: null, variant_of: null, hidden: false, ...over };
}
const snap = (video_id: string, at: number, views: number, likes = 10): SnapshotRow => ({ video_id, captured_at: iso(at), views, likes, comments: 1, shares: 1, saves: 1 });
function signup(i: number, over: Partial<SignupRow> = {}): SignupRow {
  return { user_id: `u${i}`, created_at: iso(NOW - 3 * HOUR), heard: "tiktok", heard_account: null, heard_video: null, utm_source: null, country: "US", paid: false, paid_at: null, net_usd: 0, internal: false, ...over };
}

test("cadence: never pulled is due; hourly with a video under 48 h, every 4 hours otherwise; disabled never", () => {
  assert.equal(isDue(account(), NOW), true);
  assert.equal(isDue(account({ enabled: false }), NOW), false);
  const hot = account({ latest_posted_at: iso(NOW - 10 * HOUR), last_pulled_at: iso(NOW - 61 * 60_000) });
  assert.equal(isDue(hot, NOW), true);
  assert.equal(isDue({ ...hot, last_pulled_at: iso(NOW - 30 * 60_000) }, NOW), false);
  const quiet = account({ latest_posted_at: iso(NOW - 3 * DAY), last_pulled_at: iso(NOW - 2 * HOUR) });
  assert.equal(isDue(quiet, NOW), false, "two hours is not enough for a quiet account");
  assert.equal(isDue({ ...quiet, last_pulled_at: iso(NOW - 5 * HOUR) }, NOW), true);
});

test("summarize: gains are latest minus the baseline (never lifetime); pre-tracking videos are out unless asked; a downward revision is clamped and noted", () => {
  const v1 = video("1", { views: 5000, likes: 400 }), v2 = video("2", { views: 300 }), pre = video("3", { pre_tracking: true, posted_at: iso(NOW - 30 * DAY), base_views: 900000, views: 950000 });
  const snapshots = [snap("1", NOW - 2 * DAY, 100), snap("1", NOW - DAY, 1500, 120), snap("1", NOW - 2 * HOUR, 4200, 300), snap("1", NOW - 30 * 60_000, 5000, 400), snap("2", NOW - 2 * DAY, 100), snap("2", NOW - DAY, 400), snap("2", NOW - HOUR, 300), snap("3", NOW - DAY, 950000)];
  const base = { accounts: [account()], videos: [v1, v2, pre], snapshots, account_snapshots: [], signups: [] as SignupRow[] };
  const s = summarize({ ...base, range: rangeFor(7, PT, NOW) });
  assert.equal(s.kpis.views, 4900 + 200, "v1 gained 4,900 since its first reading; v2 is at 300 against a baseline of 100, its drop from 400 is never subtracted");
  const o1 = s.videos.find((v) => v.id === "1")!;
  assert.equal(o1.gain.views, 4900); assert.equal(o1.velocity_1h, 800, "the last hour: 4,200 to 5,000"); assert.equal(o1.velocity_24h, 3500);
  assert.equal(o1.engagement, (390 + 0 + 0 + 0) / 4900);
  const o2 = s.videos.find((v) => v.id === "2")!;
  assert.equal(o2.gain.views, 200); assert.equal(o2.gain.revised, true);
  assert.ok(s.notes.some((n) => /revised a count downward/.test(n)));
  assert.equal(s.videos.length, 2, "the pre-tracking video is left out");
  assert.equal(s.accounts[0].videos_pre, 1);
  const withPre = summarize({ ...base, range: rangeFor(7, PT, NOW), include_pre: true });
  assert.equal(withPre.videos.length, 3);
  assert.equal(withPre.videos.find((v) => v.id === "3")!.gain.views, 50000, "even included, only the gain since its first reading counts, never the 950,000");
  assert.equal(s.now[0].id, "1", "pulling views now: the biggest 24-hour gain first");
  assert.equal(s.daily.length, 7);
  assert.ok(s.daily.reduce((a, d) => a + d.views, 0) >= s.kpis.views, "the days add up to at least the total (a day never goes below zero, so a revision can make them add up to more)");
  assert.equal(s.daily.at(-1)!.day, "2026-11-19");
});

test("summarize: sign-ups named at sign-up count as stated, a link's utm_source as link, the rest as unknown; paid inherits; words match one video", () => {
  const v1 = video("1", { caption: "I used Clone8 Clips to cut this podcast", views: 2000 }), v2 = video("2", { caption: "my morning routine", views: 500 });
  const signups = [
    signup(1, { heard_account: A1, paid: true, net_usd: 27.86, heard_video: "the podcast one" }),
    signup(2, { heard_account: `tiktok:@bty.clips` }),
    signup(3, { utm_source: "bty.clips" }),
    signup(4), signup(5, { heard: "instagram", heard_account: "unsure" }),
    signup(6, { heard_account: A1, internal: true }),
    signup(7, { heard_account: A1, created_at: iso(NOW - 10 * DAY) }),
  ];
  const s = summarize({ accounts: [account({ cost_usd_per_video: 20 })], videos: [v1, v2], snapshots: [snap("1", NOW - HOUR, 2000), snap("2", NOW - HOUR, 500)], account_snapshots: [{ account_id: A1, day: "2026-11-12", followers: 900 }, { account_id: A1, day: "2026-11-19", followers: 1100 }], signups, range: rangeFor(7, PT, NOW) });
  assert.equal(s.kpis.signups, 5, "internal and out-of-range sign-ups are left out");
  assert.equal(s.kpis.signups_stated, 2); assert.equal(s.kpis.signups_link, 1); assert.equal(s.kpis.signups_unknown, 2);
  assert.equal(s.kpis.paid, 1); assert.equal(s.kpis.paid_attributed, 1); assert.equal(s.kpis.net_usd, 27.86);
  assert.equal(s.kpis.conversion_attributed, null, "a rate needs 10 attributed sign-ups");
  const a = s.accounts[0];
  assert.equal(a.signups_stated, 2); assert.equal(a.signups_link, 1); assert.equal(a.paid, 1);
  assert.equal(a.followers_delta, 200);
  assert.equal(a.cost_usd, 40, "two videos posted in the range at $20");
  assert.equal(a.cpm_usd, (40 / 2300) * 1000); assert.equal(a.cost_per_signup, 40 / 3); assert.equal(a.cost_per_paid, 40);
  assert.equal(s.kpis.cost_per_paid, 40);
  const o1 = s.videos.find((v) => v.id === "1")!;
  assert.equal(o1.signups_stated, 1, "'the podcast one' matches the clips caption and no other"); assert.equal(o1.paid, 1);
  assert.equal(s.stated.length, 2); assert.equal(s.stated[0].handle, "bty.clips");
  assert.equal(s.by_feature.length, 1); assert.equal(s.by_feature[0].feature, "none"); assert.equal(s.by_feature[0].enough, false, "two videos say nothing");
  assert.ok(s.notes.every((n) => !/No account has a cost/.test(n)));
});

test("rangeFor: whole local days back from now; 'all' starts at tracking", () => {
  const r = rangeFor(7, PT, NOW);
  assert.equal(new Date(r.since).toISOString(), "2026-11-13T08:00:00.000Z", "7 days back to midnight PT");
  assert.equal(rangeFor(null, PT, NOW, "2026-11-18T19:00:00Z").since, Date.parse("2026-11-18T19:00:00Z"));
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([]), null);
});

test("account input: a handle or a pasted link, costs to the cent, features from the list; junk refused", () => {
  assert.deepEqual(parseProfileLink("https://www.instagram.com/bty.clips/reels/"), { platform: "instagram", handle: "bty.clips" });
  assert.deepEqual(parseProfileLink("https://www.tiktok.com/@bty.clips?_r=1"), { platform: "tiktok", handle: "bty.clips" });
  assert.equal(parseProfileLink("https://x.com/bty"), null);
  const ok = sanitizeAccountInput({ platform: "tiktok", handle: "@bty.clips", cost_usd_per_video: "12.345", default_feature: "clips", owner_kind: "ours", enabled: 1 });
  assert.deepEqual(ok, { platform: "tiktok", handle: "bty.clips", cost_usd_per_video: 12.35, default_feature: "clips", owner_kind: "ours", enabled: true });
  assert.deepEqual(sanitizeAccountInput({ handle: "bad handle" }), { error: "invalid_handle" });
  assert.deepEqual(sanitizeAccountInput({ default_feature: "nope" }), { error: "invalid_feature" });
  assert.deepEqual(sanitizeAccountInput({ cost_usd_per_month: -1 }), { error: "invalid_cost_usd_per_month" });
  assert.deepEqual(sanitizeAccountInput({ cost_usd_per_month: "" }), { cost_usd_per_month: null });
});

test("sign-up answers keep the account they saw and a few words about the video", () => {
  const a = sanitizeAnswers({ role: "clipper", heard: "tiktok", heard_account: A1, heard_video: "the one with the podcast clip", version: 3 });
  assert.equal(a.heard_account, A1); assert.equal(a.heard_video, "the one with the podcast clip"); assert.equal(a.heard, "tiktok");
  assert.equal(sanitizeAnswers({ heard_account: "unsure" }).heard_account, "unsure");
  assert.equal(sanitizeAnswers({ heard_account: "<script>" }).heard_account, "script", "only word characters survive");
});

// ---------------------------------------------------------------------------------------------------
/** Ids shaped like the real ones (the routes refuse anything that is not a uuid). */
const fakeId = (table: string, n: number) => `00000000-0000-4000-8000-${String(Math.abs([...table].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 1e6).padStart(6, "0")}${String(n).padStart(6, "0")}`;
function fakeSb(tables: Record<string, any[]>) {
  const uploads: string[] = [];
  const keyOf: Record<string, string[]> = { content_accounts: ["platform", "handle"], content_account_snapshots: ["account_id", "day"] };
  const sb: any = {
    tables, uploads,
    storage: { from: () => ({
      upload: async (k: string) => { uploads.push(k); return { data: { path: k }, error: null }; },
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
    }) },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: "support@clone8.io", email_confirmed_at: "2026-01-01T00:00:00Z" } } }), listUsers: async () => ({ data: { users: [] } }) } },
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let op: any = null, single = false, maybe = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] != null && r[k] >= v); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { op = { kind: "insert", v }; return q; }, update(v: any) { op = { kind: "update", v }; return q; }, upsert(v: any) { op = { kind: "upsert", v }; return q; },
        then(res: any, rej: any) {
          const t = (tables[table] ??= []);
          let out: any[] = [];
          if (op?.kind === "insert") { for (const v of [].concat(op.v)) { const row = { id: fakeId(table, t.length + 1), created_at: new Date().toISOString(), ...v }; t.push(row); out.push(row); } }
          else if (op?.kind === "upsert") { for (const v of [].concat(op.v)) { const ks = keyOf[table] ?? ["id"]; const hit = t.find((r) => ks.every((k) => r[k] === (v as any)[k])); if (hit) { Object.assign(hit, v); out.push(hit); } else { const row = { id: fakeId(table, t.length + 1), ...(v as any) }; t.push(row); out.push(row); } } }
          else if (op?.kind === "update") { out = t.filter((r) => filters.every((f) => f(r))); for (const r of out) Object.assign(r, op.v); }
          else out = t.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: single || maybe ? out[0] ?? null : out, error: single && !out.length ? { message: "no rows" } : null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return sb;
}
function fakeNet(views: Record<string, number>, opts: { notFound?: string[] } = {}) {
  const calls: string[] = [];
  const f: any = async (url: string) => {
    calls.push(url);
    const handle = new URL(url).searchParams.get("handle") ?? "";
    if (opts.notFound?.includes(handle)) return new Response("{}", { status: 404 });
    if (url.includes("/v3/tiktok/profile/videos")) return new Response(JSON.stringify({ aweme_list: Object.entries(views).map(([id, v], i) => ({ aweme_id: id, desc: `clip ${id}`, create_time: Math.floor((NOW - (i + 1) * 6 * HOUR) / 1000), statistics: { play_count: v, digg_count: 5, comment_count: 1, share_count: 2, collect_count: 1 }, video: { duration: 20, cover: { url_list: ["https://img/c.jpg"] } } })) }));
    if (url.includes("/v1/tiktok/profile")) return new Response(JSON.stringify({ user: { nickname: "BTY", avatarMedium: "https://img/a.jpg" }, stats: { followerCount: 1234 } }));
    if (url.includes("/v1/instagram/user/reels")) return new Response(JSON.stringify({ items: [{ media: { code: "IGCODE1", taken_at: Math.floor((NOW - DAY) / 1000), product_type: "clips", play_count: views.IGCODE1 ?? 10, like_count: 1, comment_count: 0, video_duration: 12 } }] }));
    if (url.includes("/v1/instagram/profile")) return new Response(JSON.stringify({ data: { user: { edge_followed_by: { count: 50 }, full_name: "Ray", profile_pic_url: "https://img/r.jpg" } } }));
    if (url.startsWith("https://img/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    return new Response("{}", { status: 404 });
  };
  return { f, calls };
}
const ENV = { SCRAPECREATORS_API_KEY: "sc", STUDIO_CONTENT_PERF_ENABLED: "true" } as Record<string, string>;

test("pull: the first reading sets the baseline and tracking_since; a changed count writes one snapshot; unchanged writes nothing; followers once a day", async () => {
  const tables: Record<string, any[]> = { content_accounts: [{ ...account({ tracking_since: null, followers: null }), id: A1 }] };
  const sb = fakeSb(tables); const net = fakeNet({ "7000000000000000001": 1000, "7000000000000000002": 50 });
  const r1 = await pullContent(sb, { env: ENV, fetch: net.f, log: () => {}, now: () => NOW });
  assert.deepEqual([r1.accounts, r1.videos_new, r1.snapshots, r1.errors], [1, 2, 2, []]);
  const a = tables.content_accounts[0];
  assert.equal(a.tracking_since, iso(NOW)); assert.equal(a.followers, 1234); assert.equal(a.display_name, "BTY"); assert.equal(a.avatar_key, "content/avatars/tiktok-bty.clips.jpg");
  const v = tables.content_videos.find((x) => x.platform_post_id === "7000000000000000001");
  assert.equal(v.base_views, 1000); assert.equal(v.views, 1000); assert.equal(v.pre_tracking, true, "posted before this first reading: pre-tracking");
  assert.equal(v.thumb_key, "content/tiktok/7000000000000000001.jpg");
  assert.equal(tables.content_account_snapshots.length, 1);
  assert.equal(net.calls.filter((c) => c.includes("scrapecreators")).length, 2, "one page of videos and one profile");
  // an hour later: one video moved
  const net2 = fakeNet({ "7000000000000000001": 1400, "7000000000000000002": 50 });
  const r2 = await pullContent(sb, { env: ENV, fetch: net2.f, log: () => {}, now: () => NOW + HOUR }, { force: true });
  assert.deepEqual([r2.videos_new, r2.snapshots], [0, 1]);
  assert.equal(tables.content_snapshots.length, 3);
  assert.equal(v.views, 1400); assert.equal(v.base_views, 1000, "the baseline never moves");
  assert.equal(net2.calls.filter((c) => c.includes("/v1/tiktok/profile?")).length, 0, "the profile is read once a day");
  assert.equal(tables.content_accounts[0].last_status, "ok: 2 videos read");
});

test("pull: an account that answers 404 is marked and retried in 15 minutes; the others still read", async () => {
  const tables: Record<string, any[]> = { content_accounts: [{ ...account(), id: A1, handle: "gone" }, { ...account({ platform: "instagram", handle: "raycrado" }), id: A2 }] };
  const sb = fakeSb(tables); const net = fakeNet({ IGCODE1: 77 }, { notFound: ["gone"] });
  const r = await pullContent(sb, { env: ENV, fetch: net.f, log: () => {}, now: () => NOW });
  assert.equal(r.accounts, 1); assert.deepEqual(r.errors, ["tiktok:gone: account_not_found"]);
  assert.equal(tables.content_accounts[0].last_status, "error"); assert.equal(tables.content_accounts[0].last_error, "account_not_found");
  assert.equal(NOW - Date.parse(tables.content_accounts[0].last_pulled_at), 45 * 60_000, "due again in 15 minutes");
  assert.equal(tables.content_videos.length, 1); assert.equal(tables.content_videos[0].platform, "instagram");
});

test("routes: the owner's account only; the page's numbers come signed; an account can be added by link; the sign-up list is open to any signed-in person", async () => {
  clearAdminCacheForTests();
  const tables: Record<string, any[]> = { content_accounts: [], content_videos: [], content_snapshots: [], content_account_snapshots: [], studio_customers: [], studio_stripe_events: [] };
  const sb = fakeSb(tables); const net = fakeNet({ "7000000000000000001": 10 });
  const app = express(); app.use(express.json());
  const ME = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  app.use((req: any, _res, next) => { const who = req.headers["x-who"]; req.auth = who === "me" ? { user_id: ME, email: "support@clone8.io" } : who === "other" ? { user_id: OTHER, email: "ann@example.com" } : undefined; next(); });
  registerContentPerf(app, () => sb, { env: ENV, fetch: net.f, log: () => {}, now: () => NOW });
  const srv = app.listen(0); const port = (srv.address() as any).port; const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/studio/admin/content`, { headers: { "x-who": "other" } })).status, 404, "not the owner: as if the page did not exist");
    assert.equal((await fetch(`${base}/api/studio/admin/content`)).status, 404);
    const add = await fetch(`${base}/api/studio/admin/content/accounts`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: JSON.stringify({ link: "https://www.tiktok.com/@bty.clips?_r=1", owner_kind: "creator", cost_usd_per_video: 15 }) });
    const addBody = await add.json();
    assert.equal(add.status, 200, JSON.stringify(addBody));
    const added = addBody.account;
    assert.equal(added.handle, "bty.clips"); assert.equal(added.platform, "tiktok"); assert.equal(added.url, "https://www.tiktok.com/@bty.clips");
    await new Promise((r) => setTimeout(r, 50)); // the new account is read in the background
    assert.equal(tables.content_videos.length, 1);
    const bad = await fetch(`${base}/api/studio/admin/content/accounts`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: JSON.stringify({ link: "https://x.com/nope" }) });
    assert.equal(bad.status, 400);
    const page = await fetch(`${base}/api/studio/admin/content?days=7&tz=-480&pre=1`, { headers: { "x-who": "me" } });
    assert.equal(page.status, 200);
    const body = await page.json();
    assert.equal(body.accounts.length, 1); assert.equal(body.accounts[0].avatar_url, "https://signed/content/avatars/tiktok-bty.clips.jpg");
    assert.equal(body.videos.length, 1); assert.equal(body.videos[0].thumb_url, "https://signed/content/tiktok/7000000000000000001.jpg");
    assert.equal(body.kpis.views, 0, "the first reading is the baseline: nothing gained yet");
    assert.ok(Array.isArray(body.features));
    const tag = await fetch(`${base}/api/studio/admin/content/videos/${body.videos[0].id}`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: JSON.stringify({ feature: "clips" }) });
    assert.equal(tag.status, 200); assert.deepEqual((await tag.json()).video.tags, { feature: "clips" });
    assert.equal((await fetch(`${base}/api/studio/admin/content/videos/${body.videos[0].id}`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: JSON.stringify({ feature: "nope" }) })).status, 400);
    const list = await fetch(`${base}/api/studio/content/accounts`, { headers: { "x-who": "other" } });
    assert.equal(list.status, 200);
    const l = await list.json();
    assert.deepEqual(Object.keys(l.accounts[0]).sort(), ["avatar_url", "display_name", "handle", "id", "platform"], "nothing about costs or readings leaves the admin");
    assert.equal((await fetch(`${base}/api/studio/content/accounts`)).status, 401);
    const pull = await fetch(`${base}/api/studio/admin/content/pull`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: "{}" });
    assert.equal(pull.status, 200);
    assert.equal((await fetch(`${base}/api/studio/admin/content/pull`, { method: "POST", headers: { "content-type": "application/json", "x-who": "me" }, body: "{}" })).status, 429, "once every 10 minutes by hand");
  } finally { srv.close(); }
});

test("routes: with the gate off every route answers as if absent, and the sign-up list is empty", async () => {
  clearAdminCacheForTests();
  const sb = fakeSb({ content_accounts: [] });
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", email: "support@clone8.io" }; next(); });
  registerContentPerf(app, () => sb, { env: { SCRAPECREATORS_API_KEY: "sc" }, fetch: fakeNet({}).f, now: () => NOW });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/api/studio/admin/content`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/studio/content/accounts`)).json(), { accounts: [] });
  } finally { srv.close(); }
});
