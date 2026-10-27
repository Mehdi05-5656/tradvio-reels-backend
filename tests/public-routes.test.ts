import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { summarizeCaseStudy, validateInviteRequest, makeLimiter, registerPublicRoutes, registerInviteRequestInbox, foldApplyFields, inboxRow, attributionOf, type CaseStudyRaw } from "../src/public-routes.js";
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
    { ok: true, row: { name: "Jane", email: "jane@example.com", company: "Northline", website: "northline.example", platforms: "instagram, tiktok", accounts: 20, monthly_videos: null, library: "40 hours of calls", goals: "1M views", message: null, source: "clone8.io", content_status: null, library_size: null, objective: null, phone: null, attribution: null } });
  assert.equal((validateInviteRequest({ name: "", email: "a@b.co", company: "x" }) as any).error, "invalid_name");
  assert.equal((validateInviteRequest({ name: "x", email: "nope", company: "x" }) as any).error, "invalid_email");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co" }) as any).error, "invalid_company");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", accounts: "lots" }) as any).error, "invalid_accounts");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", fax: "555" }) as any).honeypot, true);
  assert.equal((validateInviteRequest(null) as any).error, "invalid_body");
  // /apply qualification fields: closed lists, optional phone, allow-listed attribution, named source.
  const apply = validateInviteRequest({ name: "Ana", email: "ana@brand.co", company: "Brand", website: "@brand", platforms: ["instagram", "tiktok"], content_status: "some", library_size: "25_100", objective: "reach", phone: " +1 (415) 555-0100 ", message: "Mostly product demos", source: "clone8.io/apply", attribution: { utm_source: "meta", utm_campaign: "launch", utm_content: "creative-a", fbclid: "no", email: "x@y.z", landing_path: "/apply" } });
  assert.equal(apply.ok, true);
  const row = (apply as any).row;
  assert.equal(row.source, "clone8.io/apply"); assert.equal(row.content_status, "some"); assert.equal(row.library_size, "25_100"); assert.equal(row.objective, "reach");
  assert.equal(row.phone, "+1 (415) 555-0100"); assert.equal(row.message, "Mostly product demos");
  assert.deepEqual(row.attribution, { utm_source: "meta", utm_campaign: "launch", utm_content: "creative-a", landing_path: "/apply" }, "only campaign keys survive");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", content_status: "maybe" }) as any).error, "invalid_content_status");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", library_size: "lots" }) as any).error, "invalid_library_size");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", objective: "money" }) as any).error, "invalid_objective");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", phone: "call me" }) as any).error, "invalid_phone");
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", phone: "" }) as any).row.phone, null);
  assert.equal((validateInviteRequest({ name: "x", email: "a@b.co", company: "x", source: "evil.example" }) as any).row.source, "clone8.io", "unknown source falls back to the homepage");
  assert.equal(attributionOf("utm_source=meta"), null);
  assert.equal(attributionOf({ utm_source: "" }), null);
  // Before the migration: every answer survives in the message text; the new columns are dropped.
  const folded = foldApplyFields(row);
  assert.equal("content_status" in folded, false); assert.equal("attribution" in folded, false); assert.equal("phone" in folded, false);
  assert.match(folded.message!, /^Mostly product demos\n\n\[apply fields, migration pending\]\nPublished short-form videos: some\nExisting videos: 25–100 videos\nObjective: reach\nPhone \(callback requested\): \+1 \(415\) 555-0100\nAttribution: utm_source=meta utm_campaign=launch utm_content=creative-a landing_path=\/apply$/);
  assert.equal(foldApplyFields({ ...row, content_status: null, library_size: null, objective: null, phone: null, attribution: null }).message, "Mostly product demos");
  // The inbox never sees the Meta delivery context.
  const seen = inboxRow({ id: "r", name: "n", email: "e", company: "c", status: "new", created_at: "t", meta_capi_context: { ip: "1.2.3.4" }, meta_event_id: "c8_x", content_status: "yes", phone: "+1 555" });
  assert.equal("meta_capi_context" in seen, false); assert.equal("meta_event_id" in seen, false); assert.equal(seen.content_status, "yes"); assert.equal(seen.website, null); assert.equal(seen.source, null);
  const allow = makeLimiter(2, 1000);
  assert.equal(allow("a", 0), true); assert.equal(allow("a", 1), true); assert.equal(allow("a", 2), false);
  assert.equal(allow("b", 2), true);
  assert.equal(allow("a", 1001), true, "window resets");
});

test("public routes work without any auth; the case study is cached and the form is stored", async (t) => {
  const inserts: any[] = [];
  let rpcCalls = 0, failApplyColumnsOnce = false;
  const sb: any = {
    rpc: async () => { rpcCalls++; return { data: raw().latest_all, error: null }; },
    from(table: string) {
      const q: any = {
        select(_c: string, o?: any) { q.head = o?.head; return q; }, eq() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, single() { return q; },
        insert(v: any) { inserts.push({ table, v }); q.inserted = v; return q; },
        then(resolve: any) {
          if (table === "invite_requests" && q.inserted && failApplyColumnsOnce && "content_status" in q.inserted) { failApplyColumnsOnce = false; q.inserted = null; return resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'content_status' column of 'invite_requests' in the schema cache" } }); }
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
  assert.equal(inserts[0].v.content_status, null, "homepage form stores the new columns as null");
  const applyBody = { name: "Ana", email: "ana@brand.co", company: "Brand", website: "brand.co", platforms: ["instagram"], content_status: "yes", library_size: "100_500", objective: "distribution", phone: "+44 20 7946 0000", source: "clone8.io/apply", attribution: { utm_content: "creative-b" } };
  assert.equal((await post(applyBody)).status, 201);
  assert.equal(inserts[1].v.source, "clone8.io/apply"); assert.equal(inserts[1].v.library_size, "100_500"); assert.deepEqual(inserts[1].v.attribution, { utm_content: "creative-b" });
  assert.equal((await post({ ...applyBody, objective: "profit" })).status, 400, "an unknown answer is refused, not coerced");
  failApplyColumnsOnce = true;
  assert.equal((await post(applyBody)).status, 201, "stored even before the migration");
  assert.equal(inserts.length, 4, "one failed insert, one retry");
  assert.equal("content_status" in inserts[3].v, false);
  assert.match(inserts[3].v.message, /Existing videos: 100–500 videos/);
  assert.match(inserts[3].v.message, /Phone \(callback requested\): \+44 20 7946 0000/);
  inserts.length = 1;
  assert.equal((await post({ name: "", email: "jane@example.com", company: "x" })).status, 400);
  assert.equal((await fetch(`${base}/api/ops/invite-requests`)).status, 401, "inbox is not public");
  assert.equal((await post({ name: "Bot", email: "b@b.co", company: "x", fax: "x" })).status, 202);
  assert.equal(inserts.length, 1, "honeypot submissions are not stored");
  assert.equal((await post({ name: "Bot", email: "b@b.co", company: "x", fax: "x", source: "clone8.io/apply", content_status: "yes" })).status, 202, "honeypot on the apply page too");
  assert.equal(inserts.length, 1);
});
