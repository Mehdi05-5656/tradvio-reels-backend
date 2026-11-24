import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanRule, publicRule, capabilityOf, registerAutoReplies, AUTOREPLY_LIMITS } from "../src/studio-autoreply.js";
import { zernioProvider, linkScopes } from "../src/social-zernio.js";
import { accountAccess } from "../src/account-access.js";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
const ENV = { STUDIO_SOCIAL_ENABLED: "true", SOCIAL_PROVIDER: "zernio", ZERNIO_API_KEY: "sk_test" } as Record<string, string>;

test("rules: cleaned per network; DMs only where networks allow them; keywords and a link button checked", () => {
  const ig = cleanRule({ name: "Guide", platform: "instagram", keywords: ["GUIDE", "guide", " "], dm_message: "Here it is {{first_name}}", button: { title: "Get the guide", url: "https://clone8.io/g" }, comment_reply: "Sent!", also_dms: true, followers: "follower", hide_comment: true }, "instagram");
  assert.deepEqual(ig.keywords, ["GUIDE", "guide"]);
  assert.equal(ig.matchMode, "word"); assert.equal(ig.dmMessage, "Here it is {{first_name}}");
  assert.deepEqual(ig.buttons, [{ type: "url", title: "Get the guide", url: "https://clone8.io/g" }]);
  assert.equal(ig.alsoMatchInDms, true); assert.equal(ig.audience.followerStatus, "follower"); assert.equal(ig.actions.hideComment, true); assert.equal(ig.linkTracking, true);
  assert.throws(() => cleanRule({ keywords: ["x"], dm_message: "hi" }, "tiktok"), (e: any) => e.code === "dm_not_supported");
  assert.throws(() => cleanRule({ keywords: ["x"] }, "tiktok"), (e: any) => e.code === "reply_required");
  const tt = cleanRule({ keywords: ["link"], comment_reply: "Check my bio!" }, "tiktok");
  assert.equal(tt.commentReply, "Check my bio!"); assert.equal(tt.dmMessage, undefined); assert.equal(tt.alsoMatchInDms, undefined);
  assert.throws(() => cleanRule({ keywords: ["x"], dm_message: "hi", button: { title: "Go", url: "http://insecure" } }, "instagram"), (e: any) => e.code === "bad_button");
  assert.throws(() => cleanRule({ keywords: [], dm_message: "hi" }, "instagram"), (e: any) => e.code === "keywords_required");
  assert.throws(() => cleanRule({ trigger: "story_reply", keywords: ["x"], comment_reply: "y" }, "tiktok"), (e: any) => e.code === "trigger_not_supported");
  assert.deepEqual(cleanRule({ trigger: "story_mention", dm_message: "Thanks for the shoutout!" }, "instagram").keywords, [], "a mention needs no keyword");
  assert.deepEqual(cleanRule({ active: false }, "instagram", { partial: true }), { isActive: false }, "a toggle sends only the toggle");
});

test("capability: replies need a comments permission, DMs a messages permission (Instagram and Facebook only)", () => {
  const h = (scopes: string[]) => ({ permissions: { posting: [{ scope: "instagram_business_content_publish", granted: true }], optional: scopes.map((scope) => ({ scope, granted: true })) } });
  assert.deepEqual(capabilityOf("instagram", h([])), { reply: false, dm: false });
  assert.deepEqual(capabilityOf("instagram", h(["instagram_business_manage_comments", "instagram_business_manage_messages"])), { reply: true, dm: true });
  assert.deepEqual(capabilityOf("tiktok", h(["comment.list.manage", "message.list.send"])), { reply: true, dm: false });
  assert.deepEqual(capabilityOf("youtube", h(["https://www.googleapis.com/auth/youtube.force-ssl"])), { reply: true, dm: false });
  // the service's per-area summary counts too: a TikTok business account lists no comment scope but has the area (live, Nov 24 2026)
  assert.deepEqual(capabilityOf("tiktok", { permissions: { posting: [{ scope: "video.publish", granted: true }], scopeAreas: { posting: "granted", comments: "granted" } } }), { reply: true, dm: false });
  assert.deepEqual(capabilityOf("instagram", { permissions: { optional: [{ scope: "instagram_business_manage_comments", granted: false }], scopeAreas: { comments: "not_requested", messaging: "not_requested" } } }), { reply: false, dm: false });
  assert.deepEqual(capabilityOf("instagram", { permissions: { scopeAreas: { comments: "granted", messaging: "granted" } } }), { reply: true, dm: true });
});

test("linking asks for what auto-replies need from the first link", () => {
  assert.equal(linkScopes("instagram"), "posting,analytics,comments,messaging");
  assert.equal(linkScopes("facebook"), "posting,analytics,comments,messaging");
  assert.equal(linkScopes("tiktok"), "posting,analytics,comments");
  assert.equal(linkScopes("youtube"), "posting,analytics,comments");
  assert.equal(linkScopes("bluesky"), "posting,analytics", "no auto-replies there, nothing more asked");
});

test("public rule: the page's own shape with a click-through rate", () => {
  const r = publicRule({ id: "a1", name: "Guide", accountId: "acc-ig", keywords: ["guide"], matchMode: "word", dmMessage: "hi", buttons: [{ type: "url", title: "Go", url: "https://x.y" }], isActive: true, stats: { triggered: 10, dmsSent: 9, uniqueContacts: 9, trackedSends: 8, uniqueClicks: 2, linkClicks: 3 } }, () => "instagram");
  assert.equal(r.platform, "instagram"); assert.deepEqual(r.button, { title: "Go", url: "https://x.y" }); assert.equal(r.stats.ctr, 25); assert.equal(r.stats.sent, 9);
  assert.equal(r.account_id, "acc-ig", "a rule names its account (two Instagrams each have their own rules); routes check it is the person's");
});

/** A fake posting service holding ANN's two accounts and BOB's one, and their rules. */
function fakeService() {
  const rules: any[] = [{ id: "bobrule1", accountId: "acc-bob", keywords: ["x"], isActive: true, stats: {} }];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const accounts: Record<string, any[]> = { "prof-ann": [{ _id: "acc-ig", platform: "instagram", username: "ann", isActive: true }, { _id: "acc-tt", platform: "tiktok", username: "ann.tt", isActive: true }], "prof-bob": [{ _id: "acc-bob", platform: "instagram", isActive: true }] };
  let n = 0;
  const fetchFn = async (u: string, init: any) => {
    const url = new URL(u); const path = url.pathname.replace("/api/v1", ""); const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const send = (status: number, b: any) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/accounts") return send(200, { accounts: accounts[url.searchParams.get("profileId")!] ?? [] });
    if (/^\/accounts\/[^/]+\/health$/.test(path)) { const id = path.split("/")[2]; return send(200, { permissions: { optional: id === "acc-ig" ? [{ scope: "instagram_business_manage_comments", granted: true }, { scope: "instagram_business_manage_messages", granted: true }] : [] } }); }
    if (path === "/comment-automations" && init.method === "GET") { const prof = url.searchParams.get("profileId"); const ids = (accounts[prof!] ?? []).map((a) => a._id); return send(200, { automations: rules.filter((r) => ids.includes(r.accountId)) }); }
    if (path === "/comment-automations" && init.method === "POST") { if (body.accountId === "acc-tt") return send(403, { error: "This account has not granted the comments permission" }); const r = { id: `rule${++n}`, ...body, stats: {} }; rules.push(r); return send(201, { automation: r }); }
    const m = path.match(/^\/comment-automations\/([^/]+)(\/logs)?$/);
    if (m) {
      const r = rules.find((x) => x.id === m[1]);
      if (!r) return send(404, { error: "not found" });
      if (m[2]) return send(200, { logs: [{ createdAt: "2026-11-21T10:00:00Z", commenterUsername: "fan1", commentText: "GUIDE pls", status: "sent", source: "comment" }], pagination: { hasMore: false }, misses: { total: 2, retentionDays: 7, samples: [{ commentText: "guid", at: "2026-11-21T09:00:00Z" }] } });
      if (init.method === "GET") return send(200, { automation: r });
      if (init.method === "PATCH") { Object.assign(r, body); return send(200, { automation: r }); }
      if (init.method === "DELETE") { rules.splice(rules.indexOf(r), 1); return send(200, { success: true }); }
    }
    if (path === "/analytics") return send(200, { posts: [{ content: "my reel", thumbnailUrl: "https://t/1.jpg", publishedAt: "2026-11-20T00:00:00Z", platforms: [{ platform: "instagram", platformPostId: "1790001", platformPostUrl: "https://instagram.com/p/x" }] }] });
    return send(404, { error: `no fake for ${init.method} ${path}` });
  };
  return { fetchFn: fetchFn as any, calls, rules };
}
function sbFor(plan: string) {
  const tables: Record<string, any[]> = {
    studio_customers: [{ user_id: ANN, plan_id: plan, status: "active" }, { user_id: BOB, plan_id: "creator", status: "active" }],
    studio_social_profiles: [{ user_id: ANN, provider: "zernio", profile_key: "prof-ann" }, { user_id: BOB, provider: "zernio", profile_key: "prof-bob" }],
  };
  return {
    from(t: string) {
      const f: Array<(r: any) => boolean> = []; let one = false, upd: any = null;
      const q: any = { select() { return q; }, eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { one = true; return q; }, update(v: any) { upd = v; return q; },
        then(res: any, rej: any) { const rows = (tables[t] ?? []).filter((r) => f.every((g) => g(r))); if (upd) rows.forEach((r) => Object.assign(r, upd)); return Promise.resolve({ data: one ? rows[0] ?? null : rows, error: null }).then(res, rej); } };
      return q;
    },
  } as any;
}
async function serve(sb: any, fetchFn: any, user = ANN) {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, next) => { req.auth = { user_id: user }; req.profile = { role: "user", user_id: user }; next(); });
  app.use(accountAccess(() => sb));
  registerAutoReplies(app, () => sb, { env: ENV, fetch: fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("routes: a person sees and changes only their own rules; plan limit; permission asked when missing", async () => {
  const svc = fakeService(), s = await serve(sbFor("starter"), svc.fetchFn);
  const page = await s.call("GET", "/api/studio/autoreply");
  assert.equal(page.body.enabled, true); assert.equal(page.body.limit, AUTOREPLY_LIMITS.starter);
  assert.deepEqual(page.body.accounts.map((a: any) => [a.platform, a.can_reply, a.can_dm]), [["instagram", true, true], ["tiktok", false, false]]);
  assert.equal(page.body.rules.length, 0, "BOB's rule is not shown to ANN");
  const made = await s.call("POST", "/api/studio/autoreply", { platform: "instagram", name: "Guide", keywords: ["guide"], dm_message: "Here you go", button: { title: "Open", url: "https://clone8.io" } });
  assert.equal(made.status, 201); assert.equal(made.body.rule.platform, "instagram");
  const sent = svc.calls.find((c) => c.method === "POST" && c.path === "/comment-automations")!.body;
  assert.equal(sent.profileId, "prof-ann"); assert.equal(sent.accountId, "acc-ig"); assert.equal(sent.linkTracking, true);
  assert.equal((await s.call("POST", "/api/studio/autoreply", { platform: "tiktok", keywords: ["x"], comment_reply: "hi" })).body.error, "needs_permission");
  assert.equal((await s.call("POST", "/api/studio/autoreply", { platform: "youtube", keywords: ["x"], comment_reply: "hi" })).body.error, "not_linked");
  assert.equal((await s.call("PATCH", "/api/studio/autoreply/bobrule1", { active: false })).status, 404, "someone else's rule is a 404");
  assert.equal((await s.call("DELETE", "/api/studio/autoreply/bobrule1")).status, 404);
  assert.equal((await s.call("GET", "/api/studio/autoreply/bobrule1/activity")).status, 404);
  for (const k of ["a", "b"]) await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: [k], dm_message: "hi" });
  const over = await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["d"], dm_message: "hi" });
  assert.equal(over.status, 409); assert.equal(over.body.error, "autoreply_limit");
  const id = made.body.rule.id;
  assert.equal((await s.call("PATCH", `/api/studio/autoreply/${id}`, { active: false })).body.rule.active, false);
  assert.equal((await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["d"], dm_message: "hi" })).status, 201, "a paused rule frees a place");
  const act = await s.call("GET", `/api/studio/autoreply/${id}/activity`);
  assert.equal(act.body.rows[0].who, "fan1"); assert.equal(act.body.misses.total, 2);
  const posts = await s.call("GET", "/api/studio/autoreply/posts?platform=instagram");
  assert.deepEqual(posts.body.posts.map((p: any) => p.id), ["1790001"]);
  assert.equal((await s.call("DELETE", `/api/studio/autoreply/${id}`)).body.ok, true);
  await s.close();
});

test("routes: off without the switch; needs a plan", async () => {
  const svc = fakeService();
  const app = express(); app.use(express.json()); app.use((req: any, _r, n) => { req.auth = { user_id: ANN }; n(); });
  registerAutoReplies(app, () => sbFor("starter"), { env: { ...ENV, SOCIAL_PROVIDER: "" }, fetch: svc.fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/studio/autoreply`).then((x) => x.json());
  assert.equal(r.enabled, false); server.close();
});

test("trial reels: Instagram target carries trialParams and a first comment; engage asks for comments and messages", async () => {
  const calls: any[] = [];
  const fetchFn = (async (u: string, init: any) => {
    const url = new URL(u); const path = url.pathname.replace("/api/v1", ""); calls.push({ path, url, body: init.body ? JSON.parse(init.body) : null });
    const send = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/accounts") return send({ accounts: [{ _id: "acc-ig", platform: "instagram", isActive: true }] });
    if (path === "/posts") return send({ post: { _id: "p1", status: "published", platforms: [{ platform: "instagram", status: "published", platformPostUrl: "https://instagram.com/reel/1" }] } }, 201);
    if (path.startsWith("/connect/")) return send({ authUrl: "https://zernio.com/connect/welcome?ticket=x" });
    return send({}, 404);
  }) as any;
  const p = zernioProvider({ env: ENV, fetch: fetchFn })!;
  await p.publish("prof-ann", { text: "hi", platforms: ["instagram"], mediaUrl: "https://s/v.mp4", scheduleAt: null, options: { instagram: { trial: "auto", first_comment: "Comment GUIDE for the link" } } });
  const t = calls.find((c) => c.path === "/posts").body.platforms[0];
  assert.deepEqual(t.platformSpecificData, { trialParams: { graduationStrategy: "SS_PERFORMANCE" }, firstComment: "Comment GUIDE for the link" });
  await p.connectUrl("prof-ann", { platform: "instagram", engage: true });
  const q = calls.at(-1).url.searchParams;
  assert.equal(q.get("scopes"), "posting,analytics,comments,messaging"); assert.equal(q.get("reconnectAccountId"), "acc-ig");
});

import { attachAutoReplies } from "../src/studio-autoreply.js";
import { suggestReply } from "../src/studio-assistant.js";

test("attach: one post binds a rule to it; a batch makes one rule per account and reuses it; limits and permissions reported", async () => {
  const svc = fakeService();
  const sb = sbFor("starter");
  const spec = { keywords: ["GUIDE"], dm_message: "Here it is", comment_reply: "Sent you a DM 📩" };
  const one = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost000000000000000000a1", platforms: ["instagram", "tiktok"], status: "scheduled" }], spec, { env: ENV, fetch: svc.fetchFn, log: () => {}, via: "publish" });
  assert.deepEqual(one.on, [{ platform: "instagram", username: "ann", account_id: "acc-ig", scope: "post" }]);
  assert.deepEqual(one.skipped.map((x) => [x.platform, x.reason]), [["tiktok", "needs_permission"]]);
  const made = svc.calls.filter((c) => c.method === "POST" && c.path === "/comment-automations");
  assert.equal(made[0].body.postId, "zpost000000000000000000a1", "bound to the post, armed when it goes out");
  assert.equal(made[0].body.dmMessage, "Here it is");
  const batch = [1, 2, 3].map((i) => ({ provider_post_id: `zpost00000000000000000b${i}`, platforms: ["instagram"], status: "scheduled" }));
  const b1 = await attachAutoReplies(sb, ANN, batch, spec, { env: ENV, fetch: svc.fetchFn, log: () => {}, via: "clips" });
  assert.deepEqual(b1.on, [{ platform: "instagram", username: "ann", account_id: "acc-ig", scope: "account" }]);
  const b2 = await attachAutoReplies(sb, ANN, batch, spec, { env: ENV, fetch: svc.fetchFn, log: () => {}, via: "clips" });
  assert.deepEqual(b2.on, [{ platform: "instagram", username: "ann", account_id: "acc-ig", scope: "account", reused: true }], "the same keywords reuse the batch rule");
  const third = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost000000000000000000c1", platforms: ["instagram"], status: "scheduled" }], { ...spec, keywords: ["NEW"] }, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.equal(third.on.length, 1, "the third rule fits Starter's 3");
  const full = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost000000000000000000c2", platforms: ["instagram"], status: "scheduled" }], { ...spec, keywords: ["MORE"] }, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.deepEqual(full.skipped.map((x) => x.reason), ["limit"], "the fourth is over the limit; the post still went out");
  const failed = await attachAutoReplies(sb, ANN, [{ provider_post_id: null, platforms: ["instagram"], status: "failed" }], spec, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.equal(failed.on.length, 0, "nothing is attached to a post that did not go out");
});

test("chat: the assistant's suggested auto-reply is cleaned", () => {
  assert.deepEqual(suggestReply({ keyword: "recipe!!", dm_message: "Here you go {{first_name}}", comment_reply: "Sent 📩" }), { keyword: "RECIPE", dm_message: "Here you go {{first_name}}", comment_reply: "Sent 📩" });
  assert.equal(suggestReply({ keyword: "   " }), null);
  assert.equal(suggestReply(null), null);
});

import { resumeAutoReplies, waitingSummary } from "../src/studio-autoreply.js";

/** A database with the posts table, enough for waiting auto-replies (eq, in, not-null json, gte, order, limit, update). */
function sbWithPosts(posts: any[]) {
  const tables: Record<string, any[]> = {
    studio_customers: [{ user_id: ANN, plan_id: "creator", status: "active" }],
    studio_social_profiles: [{ user_id: ANN, provider: "zernio", profile_key: "prof-ann" }],
    studio_social_posts: posts,
  };
  return {
    tables,
    from(t: string) {
      const f: Array<(r: any) => boolean> = []; let one = false, upd: any = null;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { one = true; return q; }, update(v: any) { upd = v; return q; },
        eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; },
        gte(k: string, v: any) { f.push((r) => String(r[k]) >= String(v)); return q; },
        not(k: string, _op: string, _v: any) { const [col, key] = k.split("->"); f.push((r) => r[col]?.[key] != null); return q; },
        then(res: any, rej: any) { const rows = (tables[t] ?? []).filter((r) => f.every((g) => g(r))); if (upd) rows.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(upd)))); return Promise.resolve({ data: one ? rows[0] ?? null : JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej); },
      };
      return q;
    },
  } as any;
}

test("waiting: an auto-reply refused for a missing permission stays on the post and starts once the account allows it", async () => {
  const svc = fakeService();
  const now = new Date().toISOString();
  const post = { id: "p1", user_id: ANN, batch_id: "b1", provider_post_id: "zpost000000000000000000d1", platforms: ["instagram", "tiktok"], options: { accounts: [{ id: "acc-ig", platform: "instagram" }, { id: "acc-tt", platform: "tiktok" }], results: { x: 1 } }, status: "published", created_at: now };
  const sb = sbWithPosts([post]);
  const spec = { keywords: ["GUIDE"], dm_message: "Here it is", comment_reply: "Sent you a DM 📩" };
  const first = await attachAutoReplies(sb, ANN, [post], spec, { env: ENV, fetch: svc.fetchFn, log: () => {}, via: "publish" });
  assert.deepEqual(first.on.map((x) => x.account_id), ["acc-ig"]);
  assert.deepEqual(first.skipped.map((x) => [x.account_id, x.reason, x.waiting]), [["acc-tt", "needs_permission", true]]);
  const saved = sb.tables.studio_social_posts[0].options;
  assert.deepEqual(saved.autoreply_wait.accounts, ["acc-tt"], "only the account that lacks the permission waits");
  assert.deepEqual(saved.autoreply_wait.spec.keywords, ["GUIDE"]); assert.deepEqual(saved.results, { x: 1 }, "the post's other options are kept");
  assert.deepEqual((await waitingSummary(sb, ANN)).map((w) => [w.account_id, w.posts, w.keyword]), [["acc-tt", 1, "GUIDE"]]);

  // still not allowed: resuming leaves it waiting and makes no rule
  const before = svc.calls.filter((c) => c.method === "POST").length;
  const still = await resumeAutoReplies(sb, ANN, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.equal(still.on.length, 0); assert.equal(still.waiting, 1);
  assert.equal(svc.calls.filter((c) => c.method === "POST").length, before, "Instagram (already on) is not set up twice");

  // the person allows it: the TikTok rule starts on that post and nothing waits any more
  const allowed = fakeService();
  const fetchAllowed = async (u: string, init: any) => (/\/accounts\/acc-tt\/health$/.test(new URL(u).pathname) ? new Response(JSON.stringify({ permissions: { scopeAreas: { comments: "granted" } } }), { status: 200 }) : /comment-automations$/.test(new URL(u).pathname) && init.method === "POST" ? new Response(JSON.stringify({ automation: { id: "ruleTT", ...JSON.parse(init.body) } }), { status: 201 }) : allowed.fetchFn(u, init));
  const done = await resumeAutoReplies(sb, ANN, { env: ENV, fetch: fetchAllowed as any, log: () => {} });
  assert.deepEqual(done.on.map((x) => [x.account_id, x.scope]), [["acc-tt", "post"]]);
  assert.equal(done.waiting, 0);
  assert.equal(sb.tables.studio_social_posts[0].options.autoreply_wait, undefined, "cleared once it started");
  assert.deepEqual(sb.tables.studio_social_posts[0].options.results, { x: 1 });
});

test("waiting: two resumes at once (the relink webhook and Allow) make the rule once", async () => {
  const post = { id: "p2", user_id: ANN, batch_id: "b2", provider_post_id: "zpost000000000000000000e1", platforms: ["tiktok"], options: { accounts: [{ id: "acc-tt", platform: "tiktok" }], autoreply_wait: { spec: { keywords: ["GUIDE"], comment_reply: "Sent!" }, accounts: ["acc-tt"], since: new Date().toISOString() } }, status: "published", created_at: new Date().toISOString() };
  const sb = sbWithPosts([post]);
  const base = fakeService(); let made = 0;
  const f = async (u: string, init: any) => { const p = new URL(u).pathname; if (/\/accounts\/acc-tt\/health$/.test(p)) return new Response(JSON.stringify({ permissions: { scopeAreas: { comments: "granted" } } }), { status: 200 }); if (/comment-automations$/.test(p) && init.method === "POST") { made++; await new Promise((r) => setTimeout(r, 20)); return new Response(JSON.stringify({ automation: { id: `r${made}` } }), { status: 201 }); } return base.fetchFn(u, init); };
  const [a, b] = await Promise.all([resumeAutoReplies(sb, ANN, { env: ENV, fetch: f as any, log: () => {} }), resumeAutoReplies(sb, ANN, { env: ENV, fetch: f as any, log: () => {}, accountId: "acc-tt" })]);
  assert.equal(made, 1, "one rule, not two");
  assert.equal(a.on.length + b.on.length, 1);
});
