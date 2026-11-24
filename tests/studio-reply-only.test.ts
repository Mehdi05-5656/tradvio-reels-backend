import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanOwnRule, fillReply, handleComment, keywordHit, parseCommentEvent, publicOwnRule, isOwnRuleId } from "../src/studio-reply-only.js";
import { attachAutoReplies, registerAutoReplies } from "../src/studio-autoreply.js";
import { zernioProvider, resetZernioForTests } from "../src/social-zernio.js";
import { webhookHash } from "../src/studio-social.js";
import { createHmac } from "node:crypto";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
const ENV = { STUDIO_SOCIAL_ENABLED: "true", SOCIAL_PROVIDER: "zernio", ZERNIO_API_KEY: "sk_test", STUDIO_AUTOREPLY_REPLY_ONLY: "true" } as Record<string, string>;

/** A small Supabase stand-in: filters, order, limits, insert/update/delete, and the log's unique (rule, comment) pair. */
function fakeSb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { studio_reply_rules: [], studio_reply_log: [], ...seed };
  let n = 0, logId = 0;
  const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;
  const from = (t: string) => {
    const f: Array<(r: any) => boolean> = []; let one = false, op: "select" | "insert" | "update" | "delete" = "select", val: any = null, lim = Infinity, from0 = 0, desc = false, ordKey: string | null = null;
    const q: any = {
      select() { return q; }, eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; },
      gte(k: string, v: any) { f.push((r) => String(r[k]) >= String(v)); return q; }, order(k: string, o?: any) { ordKey = k; desc = o?.ascending === false; return q; },
      limit(x: number) { lim = x; return q; }, range(a: number, b: number) { from0 = a; lim = b - a + 1; return q; }, maybeSingle() { one = true; return q; },
      insert(v: any) { op = "insert"; val = v; return q; }, update(v: any) { op = "update"; val = v; return q; }, delete() { op = "delete"; return q; },
      then(res: any, rej: any) {
        const rows = (tables[t] ??= []);
        let data: any = null, error: any = null;
        if (op === "insert") {
          const row = { created_at: new Date(Date.now() + n).toISOString(), ...val };
          if (t === "studio_reply_rules") Object.assign(row, { id: row.id ?? uuid(), keywords: row.keywords ?? [], exclude: row.exclude ?? [], reply_variations: row.reply_variations ?? [], match: row.match ?? "word", repeat: row.repeat ?? "once", active: row.active ?? true, post_id: row.post_id ?? null, platform_post_id: row.platform_post_id ?? null, post_title: row.post_title ?? null });
          if (t === "studio_reply_log") { if (rows.some((r) => r.rule_id === row.rule_id && r.comment_id === row.comment_id)) error = { code: "23505", message: "duplicate key" }; else row.id = ++logId; }
          if (!error) { rows.push(row); data = one ? row : [row]; }
        } else {
          let hit = rows.filter((r) => f.every((g) => g(r)));
          if (op === "update") { hit.forEach((r) => Object.assign(r, val)); }
          if (op === "delete") { tables[t] = rows.filter((r) => !hit.includes(r)); if (t === "studio_reply_rules") tables.studio_reply_log = tables.studio_reply_log.filter((l) => !hit.some((h) => h.id === l.rule_id)); }
          if (ordKey) hit = [...hit].sort((a, b) => (String(a[ordKey!]) < String(b[ordKey!]) ? -1 : 1) * (desc ? -1 : 1));
          hit = hit.slice(from0, from0 + lim);
          data = one ? hit[0] ?? null : hit;
        }
        return Promise.resolve({ data, error }).then(res, rej);
      },
    };
    return q;
  };
  return { from, tables } as any;
}
const customers = (plan = "starter") => [{ user_id: ANN, plan_id: plan, status: "active" }, { user_id: BOB, plan_id: "creator", status: "active" }];
const profiles = () => [{ user_id: ANN, provider: "zernio", profile_key: "prof-ann" }, { user_id: BOB, provider: "zernio", profile_key: "prof-bob" }];

/** The posting service: ANN has an Instagram (comments + messages allowed), a Facebook page (comments only) and a TikTok. */
function fakeService(opts: { replyStatus?: number; throwOnReply?: boolean } = {}) {
  const rules: any[] = [];
  const calls: Array<{ method: string; path: string; body: any; headers: any }> = [];
  const accounts: Record<string, any[]> = {
    "prof-ann": [{ _id: "acc-ig", platform: "instagram", username: "ann", isActive: true }, { _id: "acc-fb", platform: "facebook", username: "annpage", isActive: true }, { _id: "acc-tt", platform: "tiktok", username: "ann.tt", isActive: true }],
    "prof-bob": [{ _id: "acc-bob", platform: "instagram", username: "bob", isActive: true }],
  };
  let n = 0;
  const fetchFn = async (u: string, init: any) => {
    const url = new URL(u); const path = url.pathname.replace("/api/v1", ""); const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, headers: init.headers });
    const send = (status: number, b: any) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/accounts") return send(200, { accounts: accounts[url.searchParams.get("profileId")!] ?? [] });
    if (/^\/accounts\/[^/]+\/health$/.test(path)) {
      const id = path.split("/")[2];
      const optional = id === "acc-ig" ? [{ scope: "instagram_business_manage_comments", granted: true }, { scope: "instagram_business_manage_messages", granted: true }] : id === "acc-fb" ? [{ scope: "pages_manage_engagement", granted: true }] : [];
      return send(200, { permissions: { optional } });
    }
    if (path === "/comment-automations" && init.method === "GET") { const ids = (accounts[url.searchParams.get("profileId")!] ?? []).map((a) => a._id); return send(200, { automations: rules.filter((r) => ids.includes(r.accountId)) }); }
    if (path === "/comment-automations" && init.method === "POST") { if (["instagram", "facebook"].includes(accounts["prof-ann"].concat(accounts["prof-bob"]).find((a) => a._id === body.accountId)?.platform) && !body.dmMessage) return send(400, { error: "dmMessage is required" }); const r = { id: `65f0000000000000000000${String(++n).padStart(2, "0")}`, ...body, stats: {}, createdAt: "2026-11-24T00:00:00Z" }; rules.push(r); return send(201, { automation: r }); }
    const m = path.match(/^\/comment-automations\/([^/]+)$/);
    if (m) {
      const r = rules.find((x) => x.id === m[1]);
      if (!r) return send(404, { error: "not found" });
      if (init.method === "GET") return send(200, { automation: r });
      if (init.method === "PATCH") { Object.assign(r, body); return send(200, { automation: r }); }
      if (init.method === "DELETE") { rules.splice(rules.indexOf(r), 1); return send(200, { success: true }); }
    }
    if (path.startsWith("/inbox/comments/") && init.method === "POST") {
      if (opts.throwOnReply) throw new Error("socket hang up");
      return send(opts.replyStatus ?? 200, opts.replyStatus && opts.replyStatus >= 300 ? { error: "Inbox addon required" } : { success: true, data: { commentId: "c-reply" } });
    }
    return send(404, { error: `no fake for ${init.method} ${path}` });
  };
  return { fetchFn: fetchFn as any, calls, rules };
}
async function serve(sb: any, fetchFn: any, env = ENV, user = ANN) {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, next) => { req.auth = { user_id: user }; next(); });
  registerAutoReplies(app, () => sb, { env, fetch: fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, close: () => new Promise((r) => server.close(r)) };
}
const comment = (over: Record<string, any> = {}, c: Record<string, any> = {}) => ({
  id: "evt1", event: "comment.received", timestamp: "2026-11-24T10:00:00Z",
  account: { id: "acc-ig", accountId: "acc-ig", platform: "instagram", username: "ann" },
  post: { id: "zpost1", platformPostId: "1790001", content: "my reel", imageUrl: null, permalink: null },
  comment: { id: "c1", postId: "zpost1", platformPostId: "1790001", platform: "instagram", text: "GUIDE please!", author: { id: "u1", username: "fan.one", name: "Maya Lee", isOwnAccount: false }, createdAt: "2026-11-24T10:00:00Z", isReply: false, parentCommentId: null, ...c },
  ...over,
});

test("keywords: whole words by default, contains and exact on request, excluded words win, case ignored", () => {
  const r = (keywords: string[], match = "word", exclude: string[] = []) => ({ keywords, match, exclude });
  assert.ok(keywordHit(r(["guide"]), "GUIDE please!"));
  assert.ok(keywordHit(r(["guide"]), "can i get the guide 🙏"));
  assert.ok(!keywordHit(r(["guide"]), "guidebook?"), "not inside another word");
  assert.ok(keywordHit(r(["free guide"]), "Free Guide pls"), "a phrase");
  assert.ok(keywordHit(r(["guide"], "contains"), "guidebook?"));
  assert.ok(keywordHit(r(["guide"], "exact"), "  Guide!! 🔥"));
  assert.ok(!keywordHit(r(["guide"], "exact"), "guide me"));
  assert.ok(!keywordHit(r(["guide"], "word", ["spam"]), "guide SPAM"));
  assert.ok(keywordHit(r(["ÉTÉ"]), "été!"), "accents and case");
  assert.ok(!keywordHit(r(["a.b"]), "axb"), "keywords are literal text, never patterns");
});

test("reply text: {{first_name}} from the commenter, no gap when unknown", () => {
  assert.equal(fillReply("Sent it {{first_name}}!", { authorName: "Maya Lee", authorUsername: "fan.one" }), "Sent it Maya!");
  assert.equal(fillReply("Thanks {{first_name}}!", { authorName: null, authorUsername: "fan.one" }), "Thanks fan.one!");
  assert.equal(fillReply("Thanks {{ first_name }}!", { authorName: null, authorUsername: null }), "Thanks!");
  assert.equal(fillReply("Hi {{username}}", { authorName: null, authorUsername: "fan.one" }), "Hi @fan.one");
});

test("event: comment.received read; tests, own comments and thread replies marked", () => {
  const ev = parseCommentEvent(comment())!;
  assert.equal(ev.accountId, "acc-ig"); assert.equal(ev.postId, "zpost1"); assert.equal(ev.platformPostId, "1790001"); assert.equal(ev.commentId, "c1"); assert.equal(ev.authorId, "u1");
  assert.equal(ev.own, false); assert.equal(ev.isReply, false);
  assert.equal(parseCommentEvent({ ...comment(), test: true }), null);
  assert.equal(parseCommentEvent({ ...comment(), event: "post.published" }), null);
  assert.equal(parseCommentEvent(comment({}, { author: { id: "me", isOwnAccount: true } }))!.own, true);
  assert.equal(parseCommentEvent(comment({}, { isReply: true, parentCommentId: "c0" }))!.isReply, true);
  assert.equal(parseCommentEvent(comment({ post: { id: null, platformPostId: "1790001" } }, { postId: null }))!.postId, null, "a post not made through the service has only its network id");
});

test("rule: cleaned; a reply and a keyword are required; story triggers need the DM", () => {
  const r = cleanOwnRule({ name: "Guide", keywords: ["GUIDE", "guide", " "], comment_reply: "  Sent it {{first_name}}  ", repeat: "every", post_id: "1790001", post_title: "my reel" });
  assert.deepEqual(r.keywords, ["GUIDE", "guide"]); assert.equal(r.comment_reply, "Sent it {{first_name}}"); assert.equal(r.repeat, "every"); assert.equal(r.platform_post_id, "1790001"); assert.equal(r.post_title, "my reel");
  assert.throws(() => cleanOwnRule({ keywords: ["x"] }), (e: any) => e.code === "reply_required");
  assert.throws(() => cleanOwnRule({ keywords: [], comment_reply: "y" }), (e: any) => e.code === "keywords_required");
  assert.throws(() => cleanOwnRule({ trigger: "story_reply", keywords: ["x"], comment_reply: "y" }), (e: any) => e.code === "dm_required");
  assert.throws(() => cleanOwnRule({ keywords: ["x"], comment_reply: "y", post_id: "../etc" }), (e: any) => e.code === "bad_post");
  assert.deepEqual(cleanOwnRule({ active: false }, { partial: true }), { active: false });
  const p = publicOwnRule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", user_id: ANN, account_id: "acc-ig", platform: "instagram", name: "G", keywords: ["g"], match: "word", exclude: [], comment_reply: "hi", reply_variations: [], post_id: null, platform_post_id: null, post_title: null, repeat: "once", active: true, created_at: "x" });
  assert.equal(p.dm, false); assert.equal(p.dm_message, null); assert.equal(p.trigger, "comment");
  assert.ok(isOwnRuleId(p.id)); assert.ok(!isOwnRuleId("65f000000000000000000001"));
});

const rule = (over: Record<string, any> = {}) => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1", user_id: ANN, account_id: "acc-ig", platform: "instagram", name: "Guide", keywords: ["guide"], match: "word", exclude: [], comment_reply: "Sent it {{first_name}} 🙌", reply_variations: [], post_id: null, platform_post_id: null, post_title: null, repeat: "once", active: true, created_at: "2026-11-24T00:00:00Z", ...over });

test("comment: a matching keyword gets one public reply under the comment, with a retry-safe key", async () => {
  const svc = fakeService(), sb = fakeSb({ studio_customers: customers(), studio_reply_rules: [rule()] });
  const out = await handleComment(sb, parseCommentEvent(comment())!, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.equal(out.status, "sent");
  const sent = svc.calls.filter((c) => c.path.startsWith("/inbox/comments/"));
  assert.equal(sent.length, 1); assert.equal(sent[0].path, "/inbox/comments/zpost1");
  assert.deepEqual(sent[0].body, { accountId: "acc-ig", message: "Sent it Maya 🙌", commentId: "c1" });
  assert.equal(sent[0].headers["Idempotency-Key"], "c8-reply-aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1-c1");
  assert.equal(sb.tables.studio_reply_log[0].status, "sent");
  assert.equal(svc.calls.filter((c) => c.path === "/comment-automations").length, 0, "no DM rule anywhere");
  // the same event delivered again, and the same person commenting again on a once rule
  assert.equal((await handleComment(sb, parseCommentEvent(comment())!, { env: ENV, fetch: svc.fetchFn, log: () => {} })).status, "already_answered");
  sb.tables.studio_reply_log.find((l: any) => l.comment_id === "c1").commenter_id = "someone-else";
  assert.equal((await handleComment(sb, parseCommentEvent(comment())!, { env: ENV, fetch: svc.fetchFn, log: () => {} })).status, "duplicate", "the (rule, comment) pair stops a second answer");
  assert.equal(svc.calls.filter((c) => c.path.startsWith("/inbox/comments/")).length, 1);
});

test("comment: nothing is sent for other words, other posts, our own replies, thread replies, a lapsed plan, or with the switch off", async () => {
  const svc = fakeService();
  const go = async (sb: any, ev: any, env = ENV) => (await handleComment(sb, parseCommentEvent(ev)!, { env, fetch: svc.fetchFn, log: () => {} })).status;
  const base = () => fakeSb({ studio_customers: customers(), studio_reply_rules: [rule()] });
  assert.equal(await go(base(), comment({}, { text: "love this" })), "no_rule");
  assert.equal(await go(fakeSb({ studio_customers: customers(), studio_reply_rules: [rule({ post_id: "zpost9" })] }), comment()), "no_rule", "a rule for another post");
  assert.equal(await go(fakeSb({ studio_customers: customers(), studio_reply_rules: [rule({ platform_post_id: "1790001" })] }), comment({ post: { id: null, platformPostId: "1790001" } }, { postId: null })), "sent", "bound by the network id");
  assert.equal(await go(base(), comment({}, { author: { id: "me", isOwnAccount: true } })), "ignored");
  assert.equal(await go(base(), comment({}, { isReply: true, parentCommentId: "c0" })), "ignored");
  assert.equal(await go(fakeSb({ studio_customers: [{ user_id: ANN, plan_id: "starter", status: "canceled" }], studio_reply_rules: [rule()] }), comment()), "no_plan");
  assert.equal(await go(fakeSb({ studio_customers: customers(), studio_reply_rules: [rule({ active: false })] }), comment()), "no_rule");
  assert.equal(await go(base(), comment(), { ...ENV, STUDIO_AUTOREPLY_REPLY_ONLY: "" }), "ignored");
  assert.equal(await go(base(), comment({ account: { id: "acc-tt", platform: "tiktok", username: "x" } }, { platform: "tiktok" })), "ignored", "TikTok rules stay with the service");
});

test("comment: a post's own rule answers before an every-post rule; 'every' answers again only after a day", async () => {
  const svc = fakeService();
  const sb = fakeSb({ studio_customers: customers(), studio_reply_rules: [rule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000b1", comment_reply: "every post" }), rule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000b2", post_id: "zpost1", comment_reply: "this post", repeat: "every" })] });
  const t0 = Date.parse("2026-11-24T10:00:00Z");
  const go = (id: string, now: number) => handleComment(sb, parseCommentEvent(comment({}, { id }))!, { env: ENV, fetch: svc.fetchFn, log: () => {}, now: () => now });
  assert.equal((await go("c1", t0)).rule_id, "aaaaaaaa-aaaa-4aaa-8aaa-0000000000b2");
  assert.equal(svc.calls.at(-1)!.body.message, "this post");
  sb.tables.studio_reply_log[0].created_at = new Date(t0).toISOString();
  assert.equal((await go("c2", t0 + 3600_000)).status, "already_answered");
  assert.equal((await go("c3", t0 + 25 * 3600_000)).status, "sent");
});

test("comment: a refused or unanswered reply is recorded as failed and never sent again", async () => {
  for (const svc of [fakeService({ replyStatus: 403 }), fakeService({ throwOnReply: true })]) {
    const sb = fakeSb({ studio_customers: customers(), studio_reply_rules: [rule()] });
    const out = await handleComment(sb, parseCommentEvent(comment())!, { env: ENV, fetch: svc.fetchFn, log: () => {} });
    assert.equal(out.status, "failed");
    assert.equal(sb.tables.studio_reply_log[0].status, "failed"); assert.ok(sb.tables.studio_reply_log[0].error);
    assert.equal((await handleComment(sb, parseCommentEvent(comment())!, { env: ENV, fetch: svc.fetchFn, log: () => {} })).status, "duplicate");
    assert.equal(svc.calls.filter((c) => c.path.startsWith("/inbox/comments/")).length, 1);
  }
});

test("routes: reply-only rules on Instagram and Facebook live at Clone8, beside the others, under one plan limit", async () => {
  const svc = fakeService(), sb = fakeSb({ studio_customers: customers("starter"), studio_social_profiles: profiles() });
  const s = await serve(sb, svc.fetchFn);
  const page0 = await s.call("GET", "/api/studio/autoreply");
  assert.equal(page0.body.reply_only, true);
  const fb = page0.body.accounts.find((a: any) => a.platform === "facebook");
  assert.deepEqual([fb.can_reply, fb.can_dm], [true, false], "a page that allowed comments but not messages can still reply");
  const made = await s.call("POST", "/api/studio/autoreply", { platform: "facebook", name: "Link", keywords: ["link"], dm: false, comment_reply: "It's in the bio {{first_name}}" });
  assert.equal(made.status, 201); assert.equal(made.body.rule.dm, false); assert.equal(made.body.rule.platform, "facebook");
  assert.equal(svc.calls.filter((c) => c.method === "POST" && c.path === "/comment-automations").length, 0, "the service never gets it");
  assert.equal(sb.tables.studio_reply_rules[0].account_id, "acc-fb");
  assert.equal((await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["x"], dm: false })).body.error, "reply_required");
  assert.equal((await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["x"], comment_reply: "y" })).body.error, "dm_required", "without dm:false a DM is still asked for, as before");
  await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["dm1"], dm_message: "hi" });
  await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["r2"], dm: false, comment_reply: "hey" });
  const over = await s.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["r3"], dm: false, comment_reply: "hey" });
  assert.equal(over.body.error, "autoreply_limit", "Starter's 3 counts both kinds");
  const page = await s.call("GET", "/api/studio/autoreply");
  assert.equal(page.body.rules.length, 3); assert.equal(page.body.used, 3);
  assert.deepEqual(page.body.rules.map((r: any) => r.dm).sort(), [false, false, true]);
  const id = made.body.rule.id;
  assert.equal((await s.call("PATCH", `/api/studio/autoreply/${id}`, { active: false })).body.rule.active, false);
  assert.equal((await s.call("PATCH", `/api/studio/autoreply/${id}`, { comment_reply: "Bio link {{first_name}}" })).body.rule.comment_reply, "Bio link {{first_name}}");
  sb.tables.studio_reply_log.push({ id: 1, rule_id: id, user_id: ANN, comment_id: "c9", commenter_id: "u9", commenter: "fan9", comment_text: "link?", status: "sent", created_at: "2026-11-24T10:00:00Z" });
  const act = await s.call("GET", `/api/studio/autoreply/${id}/activity`);
  assert.deepEqual(act.body.rows.map((r: any) => [r.who, r.status]), [["fan9", "sent"]]);
  assert.equal((await s.call("DELETE", `/api/studio/autoreply/${id}`)).body.ok, true);
  assert.equal(sb.tables.studio_reply_rules.some((r: any) => r.id === id), false);
  await s.close();
});

test("routes: a person never sees or changes someone else's reply-only rule", async () => {
  const svc = fakeService(), sb = fakeSb({ studio_customers: customers(), studio_social_profiles: profiles(), studio_reply_rules: [rule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1", user_id: BOB, account_id: "acc-bob" })] });
  const s = await serve(sb, svc.fetchFn);
  assert.equal((await s.call("GET", "/api/studio/autoreply")).body.rules.length, 0);
  for (const [m, p] of [["PATCH", ""], ["DELETE", ""], ["GET", "/activity"]] as const) assert.equal((await s.call(m, `/api/studio/autoreply/aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1${p}`, m === "PATCH" ? { active: false } : undefined)).status, 404);
  assert.equal(sb.tables.studio_reply_rules[0].active, true);
  await s.close();
});

test("routes: switching the DM off moves a rule to Clone8; switching it on moves it back; nothing runs twice", async () => {
  const svc = fakeService(), sb = fakeSb({ studio_customers: customers("creator"), studio_social_profiles: profiles() });
  const s = await serve(sb, svc.fetchFn);
  const dm = await s.call("POST", "/api/studio/autoreply", { platform: "instagram", name: "Guide", keywords: ["guide"], dm_message: "Here {{first_name}}", comment_reply: "Sent you a DM 📩", repeat: "every" });
  const off = await s.call("PATCH", `/api/studio/autoreply/${dm.body.rule.id}`, { dm: false, comment_reply: "It's in my bio {{first_name}}" });
  assert.equal(off.status, 200); assert.equal(off.body.rule.dm, false); assert.equal(off.body.replaced, dm.body.rule.id);
  assert.deepEqual(off.body.rule.keywords, ["guide"]); assert.equal(off.body.rule.repeat, "every"); assert.equal(off.body.rule.comment_reply, "It's in my bio {{first_name}}");
  assert.equal(svc.rules.length, 0, "the service's rule is gone");
  const on = await s.call("PATCH", `/api/studio/autoreply/${off.body.rule.id}`, { dm: true });
  assert.equal(on.body.error, "dm_required", "switching the DM on needs the message");
  const on2 = await s.call("PATCH", `/api/studio/autoreply/${off.body.rule.id}`, { dm: true, dm_message: "Here you go" });
  assert.equal(on2.status, 200); assert.equal(on2.body.rule.dm, true); assert.equal(svc.rules.length, 1); assert.equal(svc.rules[0].dmMessage, "Here you go");
  assert.equal(sb.tables.studio_reply_rules.length, 0, "ours is gone");
  const page = await s.call("GET", "/api/studio/autoreply");
  assert.equal(page.body.rules.length, 1);
  // a rule made with a post keeps that post through an edit and through switching the DM on
  const made = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost7", platforms: ["instagram"], status: "published" }], { keywords: ["SEVEN"], comment_reply: "hi", dm: false }, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.equal(made.on.length, 1);
  const r7 = (await s.call("GET", "/api/studio/autoreply")).body.rules.find((r: any) => r.keywords[0] === "SEVEN");
  assert.equal(r7.post.id, "zpost7");
  await s.call("PATCH", `/api/studio/autoreply/${r7.id}`, { post_id: "zpost7", post_title: null, comment_reply: "hey", keywords: ["SEVEN"] });
  assert.deepEqual([sb.tables.studio_reply_rules.find((r: any) => r.id === r7.id).post_id, sb.tables.studio_reply_rules.find((r: any) => r.id === r7.id).platform_post_id], ["zpost7", null]);
  const on7 = await s.call("PATCH", `/api/studio/autoreply/${r7.id}`, { dm: true, dm_message: "DM", post_id: "zpost7" });
  assert.equal(on7.status, 200); assert.equal(svc.rules.at(-1).postId, "zpost7"); assert.equal(svc.rules.at(-1).platformPostId, undefined);
  // with the switch off, the choice is refused and nothing moves
  const s2 = await serve(sb, svc.fetchFn, { ...ENV, STUDIO_AUTOREPLY_REPLY_ONLY: "" });
  assert.equal((await s2.call("GET", "/api/studio/autoreply")).body.reply_only, false);
  assert.equal((await s2.call("PATCH", `/api/studio/autoreply/${svc.rules[0].id}`, { dm: false, comment_reply: "x" })).body.error, "reply_only_off");
  assert.equal((await s2.call("POST", "/api/studio/autoreply", { platform: "instagram", keywords: ["x"], dm: false, comment_reply: "x" })).body.error, "reply_only_off");
  assert.equal(svc.rules.length, 2, "nothing moved");
  await s.close(); await s2.close();
});

test("attach: a post with the DM off gets a reply-only rule on Instagram and Facebook; other networks unchanged", async () => {
  const svc = fakeService(), sb = fakeSb({ studio_customers: customers("creator"), studio_social_profiles: profiles() });
  const spec = { keywords: ["GUIDE"], comment_reply: "It's in my bio 🔗", dm: false };
  const one = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost1", platforms: ["instagram", "facebook", "tiktok"], status: "scheduled" }], spec, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.deepEqual(one.on.map((x) => [x.platform, x.scope]), [["instagram", "post"], ["facebook", "post"]]);
  assert.deepEqual(one.skipped.map((x) => [x.platform, x.reason]), [["tiktok", "needs_permission"]]);
  assert.deepEqual(sb.tables.studio_reply_rules.map((r: any) => [r.account_id, r.post_id, r.comment_reply]), [["acc-ig", "zpost1", "It's in my bio 🔗"], ["acc-fb", "zpost1", "It's in my bio 🔗"]]);
  assert.equal(svc.calls.filter((c) => c.method === "POST" && c.path === "/comment-automations").length, 0);
  const batch = [1, 2].map((i) => ({ provider_post_id: `zpostb${i}`, platforms: ["instagram"], status: "scheduled" }));
  assert.deepEqual((await attachAutoReplies(sb, ANN, batch, spec, { env: ENV, fetch: svc.fetchFn, log: () => {} })).on, [{ platform: "instagram", username: "ann", account_id: "acc-ig", scope: "account" }]);
  assert.deepEqual((await attachAutoReplies(sb, ANN, batch, spec, { env: ENV, fetch: svc.fetchFn, log: () => {} })).on, [{ platform: "instagram", username: "ann", account_id: "acc-ig", scope: "account", reused: true }]);
  const noText = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost2", platforms: ["instagram"], status: "scheduled" }], { keywords: ["X"], dm: false }, { env: ENV, fetch: svc.fetchFn, log: () => {} });
  assert.deepEqual(noText.skipped.map((x) => x.reason), ["no_reply_text"]);
  const off = await attachAutoReplies(sb, ANN, [{ provider_post_id: "zpost3", platforms: ["instagram"], status: "scheduled" }], spec, { env: { ...ENV, STUDIO_AUTOREPLY_REPLY_ONLY: "" }, fetch: svc.fetchFn, log: () => {} });
  assert.deepEqual(off.skipped.map((x) => x.reason), ["failed"]);
});

test("webhook: comment events asked for only with the switch on; a signed comment event is read", async () => {
  const calls: any[] = [];
  const fetchFn = (async (u: string, init: any) => { const path = new URL(u).pathname.replace("/api/v1", ""); calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify(path === "/webhooks/settings" && init.method === "GET" ? { webhooks: [] } : { ok: true }), { status: 200 }); }) as any;
  for (const on of [false, true]) {
    resetZernioForTests(); calls.length = 0;
    const env = { ...ENV, STUDIO_SOCIAL_WEBHOOK_SECRET: "s3cret", STUDIO_AUTOREPLY_REPLY_ONLY: on ? "true" : "" };
    await zernioProvider({ env, fetch: fetchFn })!.registerWebhook("prof-ann", "https://api.example/api/studio/social/webhook?token=t");
    const events = calls.find((c) => c.method === "POST" && c.path === "/webhooks/settings").body.events;
    assert.equal(events.includes("comment.received"), on);
    assert.ok(events.includes("post.published"));
  }
  const url = "https://api.example/hook";
  assert.notEqual(webhookHash(url, { STUDIO_SOCIAL_WEBHOOK_SECRET: "s" }), webhookHash(url, { STUDIO_SOCIAL_WEBHOOK_SECRET: "s", STUDIO_AUTOREPLY_REPLY_ONLY: "true" }), "switching on re-registers once");
  assert.equal(webhookHash(url, { STUDIO_SOCIAL_WEBHOOK_SECRET: "s" }), webhookHash(url, { STUDIO_SOCIAL_WEBHOOK_SECRET: "s", STUDIO_AUTOREPLY_REPLY_ONLY: "" }), "off: the same hash as before, so nothing re-registers on deploy");
  const p = zernioProvider({ env: { ...ENV, STUDIO_SOCIAL_WEBHOOK_SECRET: "s3cret" }, fetch: fetchFn })!;
  const raw = JSON.stringify(comment());
  const sig = createHmac("sha256", "s3cret").update(raw).digest("hex");
  assert.equal(p.parseWebhook({ "x-zernio-signature": sig }, raw)!.kind, "comment");
  assert.throws(() => p.parseWebhook({ "x-zernio-signature": "bad" }, raw));
});
