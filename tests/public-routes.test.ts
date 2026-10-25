import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { summarizeCaseStudy, validateInviteRequest, makeLimiter, registerPublicRoutes, registerInviteRequestInbox, type CaseStudyRaw } from "../src/public-routes.js";
import { accountAccess } from "../src/account-access.js";

const now = new Date("2026-10-24T22:00:00Z");
const raw = (): CaseStudyRaw => ({
  slots: [{ provider: "instagram", daily_target: 8, paused: false }, { provider: "tiktok", daily_target: 8, paused: false }, { provider: "tiktok", daily_target: 8, paused: true }],
  published_all: 2174, published_30d: 1992, published_7d: 882, first_publish: "2026-09-06T15:03:00Z",
  daily_30d: { "2026-10-24": 72, "2026-10-23": 120 },
  latest_all: [
    { publer_post_id: "https://www.instagram.com/reel/AAA/", phone_slot: "phone_a", captured_at: "2026-10-24T20:00:00Z", video_views: 20723, likes: 300, comments: 12, shares: 40, saves: 55, raw: { post_link: "https://www.instagram.com/reel/AAA/" } },
    { publer_post_id: "p2", phone_slot: "tiktok_x", captured_at: "2026-10-24T20:00:00Z", video_views: 1500, likes: 10, comments: null, raw: { post_link: "https://www.tiktok.com/@x/video/123" } },
    { publer_post_id: "p3", phone_slot: "phone_a", captured_at: "2026-10-24T20:00:00Z", video_views: 130, raw: { post_link: "javascript:alert(1)" } },
    { publer_post_id: "p4", phone_slot: "phone_a", captured_at: "2026-10-24T20:00:00Z", video_views: null, likes: 2, raw: {} },
  ],
});

test("case study: aggregate numbers only, unknown views not counted as zero, only public links surface", () => {
  const s = summarizeCaseStudy(raw(), now);
  assert.equal(s.since, "2026-09-06");
  assert.equal(s.days_running, 48);
  assert.deepEqual(s.accounts, { total: 3, instagram: 1, tiktok: 2, publishing: 2, videos_per_day: 16 });
  assert.equal(s.videos.all_time, 2174);
  assert.equal(s.videos.measured, 3);
  assert.equal(s.videos.over_1k_views, 2);
  assert.equal(s.videos.over_10k_views, 1);
  assert.equal(s.views.all_time, 20723 + 1500 + 130);
  assert.equal(s.views.median_per_video, 1500);
  assert.equal(s.views.best_video, 20723);
  assert.equal(s.interactions.all_time, 407 + 10 + 2);
  assert.equal(s.daily_published.length, 30);
  assert.equal(s.daily_published.at(-1)?.date, "2026-10-24");
  assert.equal(s.daily_published.at(-1)?.published, 72);
  assert.equal(s.daily_published[0].published, 0);
  assert.deepEqual(s.top_videos.map((t) => t.link), ["https://www.instagram.com/reel/AAA/", "https://www.tiktok.com/@x/video/123"]);
  assert.equal(JSON.stringify(s).includes("phone_a"), false, "account slots never leave the server");
});

test("invite request validation and the per-address limiter", () => {
  assert.deepEqual(validateInviteRequest({ name: " Jane ", email: "Jane@Example.com", company: " Northline ", website: "northline.example", platforms: ["Instagram", "TikTok"], accounts: "20", monthly_videos: "", library: "40 hours of calls", goals: "1M views" }),
    { ok: true, row: { name: "Jane", email: "jane@example.com", company: "Northline", website: "northline.example", platforms: "instagram, tiktok", accounts: 20, monthly_videos: null, library: "40 hours of calls", goals: "1M views", message: null } });
  assert.equal((validateInviteRequest({ name: "", email: "a@b.co", company: "x" }) as any).error, "invalid_name");
  assert.equal((validateInviteRequest({ name: "x", email: "nope", company: "x" }) as any).error, "invalid_email");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co" }) as any).error, "invalid_company");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", accounts: "lots" }) as any).error, "invalid_accounts");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", fax: "555" }) as any).honeypot, true);
  assert.equal((validateInviteRequest(null) as any).error, "invalid_body");
  const allow = makeLimiter(2, 1000);
  assert.equal(allow("a", 0), true); assert.equal(allow("a", 1), true); assert.equal(allow("a", 2), false);
  assert.equal(allow("b", 2), true);
  assert.equal(allow("a", 1001), true, "window resets");
});

test("public routes work without any auth; the case study is cached and the form is stored", async (t) => {
  const inserts: any[] = [];
  let rpcCalls = 0;
  const sb: any = {
    rpc: async () => { rpcCalls++; return { data: raw().latest_all, error: null }; },
    from(table: string) {
      const q: any = {
        select(_c: string, o?: any) { q.head = o?.head; return q; }, eq() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, single() { return q; },
        insert(v: any) { inserts.push({ table, v }); return q; },
        then(resolve: any) {
          if (table === "publer_slot_config") return resolve({ data: [{ phone_slot: "phone_a", provider: "instagram", daily_target: 8, paused: false }], error: null });
          if (table === "publer_publish_log") return resolve(q.head ? { count: 5, error: null } : { data: [{ attempted_at: "2026-09-06T15:03:00Z", slot_local_date: "2026-10-24" }], error: null });
          if (table === "invite_requests") return resolve({ data: { id: "req-1", created_at: now.toISOString() }, error: null });
          return resolve({ data: [], error: null });
        },
      };
      return q;
    },
  };
  const app = express(); app.use(express.json()); app.use(accountAccess(() => sb)); registerPublicRoutes(app, () => sb, { now: () => now }); registerInviteRequestInbox(app, () => sb);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const a = await fetch(`${base}/api/public/case-study`, { headers: { origin: "https://clone8.io" } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("access-control-allow-origin"), "*");
  assert.match(a.headers.get("cache-control") ?? "", /public/);
  const body = await a.json();
  assert.equal(body.videos.all_time, 5);
  assert.equal(body.views.all_time, 20723 + 1500 + 130);
  await fetch(`${base}/api/public/case-study`);
  assert.equal(rpcCalls, 1, "second request is served from cache");
  // Other /api routes stay closed to anonymous callers.
  assert.equal((await fetch(`${base}/api/ops/clients`)).status, 401);
  const post = (b: any) => fetch(`${base}/api/public/invite-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({ name: "Jane", email: "jane@example.com", company: "Northline", accounts: 12 })).status, 201);
  assert.equal(inserts[0].v.email, "jane@example.com");
  assert.equal(inserts[0].v.source, "clone8.io");
  assert.equal((await post({ name: "", email: "jane@example.com", company: "x" })).status, 400);
  assert.equal((await fetch(`${base}/api/ops/invite-requests`)).status, 401, "inbox is not public");
  assert.equal((await post({ name: "Bot", email: "b@b.co", company: "x", fax: "x" })).status, 202);
  assert.equal(inserts.length, 1, "honeypot submissions are not stored");
});
