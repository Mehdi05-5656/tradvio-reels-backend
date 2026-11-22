import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { zernioProvider, verifyZernio, resetZernioForTests } from "../src/social-zernio.js";
import { getSocialProvider } from "../src/social-provider.js";
import { zernioBill } from "../src/studio-social-upkeep.js";

const ENV = { STUDIO_SOCIAL_ENABLED: "true", SOCIAL_PROVIDER: "zernio", ZERNIO_API_KEY: "sk_test", STUDIO_SOCIAL_WEBHOOK_SECRET: "whsec" } as Record<string, string>;
const PROFILE = "6b0262bc57e5bc64149e7b2c", TT = "acc-tt", YT = "acc-yt";

/** A fake Zernio answering like the real one did on Nov 21 2026 (ops/zernio-test). */
function fakeZernio(over: Record<string, (body: any, url: URL, headers: Record<string, string>) => { status?: number; body: any }> = {}) {
  const calls: Array<{ method: string; path: string; url: URL; body: any; headers: Record<string, string> }> = [];
  const accounts = [
    { _id: TT, platform: "tiktok", username: "clone8.io", displayName: "Clone8.io", profilePicture: "https://media.zernio.com/a.jpg", profileUrl: "https://tiktok.com/@clone8.io", isActive: true, enabled: true, followersCount: 9, metadata: { profileData: { extraData: { videoCount: 10, likesCount: 202 } } } },
    { _id: YT, platform: "youtube", username: "mehdixdb", displayName: "Mehdi", isActive: true, enabled: true, followersCount: 59, needsReconnection: false },
  ];
  const fetchFn = async (u: string, init: any) => {
    const url = new URL(u);
    const path = url.pathname.replace("/api/v1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method, path, url, body, headers });
    const key = `${init.method} ${path.replace(/\/(posts|accounts|profiles)\/[^/]+$/, "/$1/:id")}`;
    const r = over[key] ? over[key](body, url, headers) : (() => {
      switch (key) {
        case "POST /profiles": return { status: 201, body: { profile: { _id: PROFILE, name: body.name, externalId: body.externalId } } };
        case "GET /accounts": return { body: { accounts } };
        case "GET /connect/tiktok": case "GET /connect/youtube": return { body: { authUrl: "https://zernio.com/connect/welcome?ticket=x" } };
        case "POST /posts": return { status: 201, body: { post: { _id: "post-1", status: body.scheduledFor ? "scheduled" : "published", scheduledFor: body.scheduledFor, platforms: body.platforms.map((p: any) => ({ platform: p.platform, status: body.scheduledFor ? "pending" : p.platform === "tiktok" ? "processing" : "published", platformPostUrl: p.platform === "youtube" && !body.scheduledFor ? "https://www.youtube.com/watch?v=azCLYZshKiw" : null })) } } };
        case "GET /posts/:id": return { body: { post: { _id: "post-1", status: "published", platforms: [{ platform: "tiktok", status: "published", platformPostUrl: "https://www.tiktok.com/@clone8.io/video/1" }] } } };
        case "DELETE /posts/:id": return { body: { message: "Post deleted successfully" } };
        case "DELETE /accounts/:id": case "DELETE /profiles/:id": return { body: {} };
        case "GET /webhooks/settings": return { body: { webhooks: [] } };
        case "POST /webhooks/settings": return { status: 201, body: { webhook: { _id: "wh1" } } };
        case "GET /analytics": return { body: { posts: [
          { content: "Comment CLONE8", publishedAt: "2026-11-10T04:18:52.000Z", thumbnailUrl: "https://p16.tiktokcdn.com/t.jpg", platforms: [{ platform: "tiktok", platformPostId: "7706392401350364430", platformPostUrl: "https://www.tiktok.com/@clone8.io/video/7706392401350364430", analytics: { views: 585, likes: 10, comments: 0, shares: 0, saves: 0, reach: 561, igReelsAvgWatchTime: 6690, completionRate: 0.0066, videoDurationSeconds: 52.9, impressionSources: { forYou: 0.981 }, retentionCurve: { 0: 1, 1: 0.6, 2: 0.4, 3: 0.35, 5: 0.24, 10: 0.18 } } }] },
          { content: "no link yet", platforms: [{ platform: "tiktok", platformPostId: null, platformPostUrl: null, analytics: {} }] },
        ] } };
        default: return { status: 404, body: { error: `no fake for ${key}` } };
      }
    })();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn: fetchFn as any, calls };
}
const z = (over = {}, env = ENV) => { const f = fakeZernio(over); return { p: zernioProvider({ env, fetch: f.fetchFn })!, calls: f.calls }; };

test("zernio: picked by SOCIAL_PROVIDER, links per network, never offers X without the switch or Bluesky", () => {
  assert.equal(getSocialProvider({ env: ENV })?.name, "zernio");
  assert.equal(getSocialProvider({ env: { ...ENV, SOCIAL_PROVIDER: "" , AYRSHARE_API_KEY: "k" } })?.name, "ayrshare");
  const { p } = z();
  assert.equal(p.linking, "per_network");
  assert.ok(p.offered().includes("tiktok") && p.offered().includes("youtube"));
  assert.ok(!p.offered().includes("twitter") && !p.offered().includes("bluesky"));
  assert.ok(zernioProvider({ env: { ...ENV, ZERNIO_OFFER_X: "true" } })!.offered().includes("twitter"));
});

test("zernio: a profile per person tagged with our id; an orphan from an earlier save is taken over", async () => {
  const { p, calls } = z();
  assert.deepEqual(await p.createProfile("Clone8 · ann@x", "user-1"), { profileKey: PROFILE, refId: PROFILE });
  assert.equal(calls[0].body.externalId, "user-1");
  assert.equal(calls[0].headers.Authorization, "Bearer sk_test");
  const taken = z({ "POST /profiles": () => ({ status: 409, body: { code: "profile_external_id_conflict", details: { existingProfileId: "old-1" } } }) });
  assert.equal((await taken.p.createProfile("t", "user-1")).profileKey, "old-1");
});

test("zernio: the link is Clone8-branded, asks only for posting and analytics, needs a network, relinks in place at the limit", async () => {
  const { p, calls } = z();
  await assert.rejects(p.connectUrl(PROFILE, {}), (e: any) => e.code === "pick_network");
  const l = await p.connectUrl(PROFILE, { platform: "tiktok", redirect: "https://app.clone8.io/#studio/publish" });
  assert.match(l.url, /^https:\/\/zernio\.com\/connect\/welcome/);
  const q = calls.at(-1)!.url.searchParams;
  assert.equal(q.get("welcome"), "true"); assert.equal(q.get("brandName"), "Clone8"); assert.equal(q.get("scopes"), "posting,analytics");
  assert.equal(q.get("logoUrl"), "https://clone8.io/brand/icon-512.png");
  assert.equal(JSON.parse(q.get("welcomeTheme")!).heading, "Link your {platform} to Clone8");
  assert.equal(q.get("redirect_url"), "https://app.clone8.io/#studio/publish");
  await assert.rejects(p.connectUrl(PROFILE, { platform: "instagram", only: ["tiktok"] }), (e: any) => e.code === "account_limit");
  await p.connectUrl(PROFILE, { platform: "tiktok", only: ["tiktok"] });
  assert.equal(calls.at(-1)!.url.searchParams.get("reconnectAccountId"), TT);
  const unpaid = z({ "GET /connect/tiktok": () => ({ status: 402, body: { error: "Add a payment method to connect more than 2 accounts." } }) });
  await assert.rejects(unpaid.p.connectUrl(PROFILE, { platform: "tiktok" }), (e: any) => e.code === "linking_full" && !/zernio/i.test(e.message));
});

test("zernio: accounts, followers and unlinking", async () => {
  const { p, calls } = z();
  const accs = await p.accounts(PROFILE);
  assert.deepEqual(accs.map((a) => [a.platform, a.username]), [["tiktok", "clone8.io"], ["youtube", "mehdixdb"]]);
  assert.equal(accs[0].image_url, "https://media.zernio.com/a.jpg");
  assert.deepEqual((await p.accountStats!(PROFILE, ["tiktok", "youtube"])).map((s) => s.followers), [9, 59]);
  await p.disconnect(PROFILE, "youtube");
  assert.equal(calls.at(-1)!.method, "DELETE"); assert.equal(calls.at(-1)!.path, `/accounts/${YT}`);
});

test("zernio: post now and scheduled; TikTok public with consent flags; YouTube title and visibility; unlinked network fails alone", async () => {
  const { p, calls } = z();
  const now = await p.publish(PROFILE, { text: "hi", platforms: ["tiktok", "youtube"], mediaUrl: "https://signed/v.mp4", scheduleAt: null, idempotencyKey: "row-1", options: { youtube: { title: "🎬".repeat(120), visibility: "private" } } });
  const body = calls.at(-1)!.body;
  assert.equal(body.publishNow, true); assert.equal(body.profileId, PROFILE); assert.deepEqual(body.mediaItems, [{ type: "video", url: "https://signed/v.mp4" }]);
  assert.equal(body.tiktokSettings.privacy_level, "PUBLIC_TO_EVERYONE"); assert.equal(body.tiktokSettings.express_consent_given, true);
  const yt = body.platforms.find((x: any) => x.platform === "youtube");
  assert.equal(Array.from(yt.platformSpecificData.title).length, 100); assert.equal(yt.platformSpecificData.visibility, "private");
  assert.equal(yt.accountId, YT);
  assert.equal(calls.at(-1)!.headers["Idempotency-Key"], "row-1");
  assert.equal(now.providerPostId, "post-1"); assert.equal(now.status, "sending", "TikTok still processing keeps it open");
  assert.equal(now.results.find((r) => r.platform === "youtube")!.status, "posted");
  const at = new Date(Date.now() + 86400_000);
  const sch = await p.publish(PROFILE, { text: "x", platforms: ["tiktok"], mediaUrl: "https://signed/v.mp4", scheduleAt: at });
  assert.equal(sch.status, "scheduled"); assert.equal(calls.at(-1)!.body.scheduledFor, at.toISOString()); assert.equal(calls.at(-1)!.body.publishNow, undefined);
  const part = await p.publish(PROFILE, { text: "x", platforms: ["tiktok", "instagram"], mediaUrl: "https://signed/v.mp4", scheduleAt: null });
  assert.equal(part.results.find((r) => r.platform === "instagram")!.status, "failed");
  const down = z({ "POST /posts": () => ({ status: 503, body: {} }) });
  await assert.rejects(down.p.publish(PROFILE, { text: "x", platforms: ["tiktok"], mediaUrl: "https://s/v.mp4", scheduleAt: null }), (e: any) => e.unknown === true, "a 5xx with no post id may have gone out: never resent as new");
});

test("zernio: status read-back, a deleted post reads as canceled, cancel tolerates already gone", async () => {
  const { p } = z();
  const ev = await p.status(PROFILE, "post-1");
  assert.equal(ev!.status, "posted"); assert.equal(ev!.results[0].url, "https://www.tiktok.com/@clone8.io/video/1");
  const gone = z({ "GET /posts/:id": () => ({ status: 404, body: { error: "Post not found" } }), "DELETE /posts/:id": () => ({ status: 404, body: {} }) });
  assert.equal((await gone.p.status(PROFILE, "post-1"))!.status, "canceled");
  await gone.p.cancel(PROFILE, "post-1");
  const late = z({ "DELETE /posts/:id": () => ({ status: 400, body: { error: "Cannot delete already published posts" } }) });
  await assert.rejects(late.p.cancel(PROFILE, "post-1"), (e: any) => e.code === "cancel_failed");
});

test("zernio: one webhook endpoint for the workspace, registered once with our secret", async () => {
  resetZernioForTests();
  const { p, calls } = z();
  await p.registerWebhook(PROFILE, "https://api.example.test/api/studio/social/webhook?token=t");
  await p.registerWebhook("another-profile", "https://api.example.test/api/studio/social/webhook?token=t");
  const made = calls.filter((c) => c.method === "POST" && c.path === "/webhooks/settings");
  assert.equal(made.length, 1);
  assert.equal(made[0].body.secret, "whsec");
  assert.ok(made[0].body.events.includes("post.published") && made[0].body.events.includes("account.disconnected"));
  resetZernioForTests();
});

test("zernio: webhooks are verified (hex HMAC) and read into post and account events", () => {
  const { p } = z();
  const sign = (o: any) => { const raw = JSON.stringify(o); return { raw, h: { "x-zernio-signature": createHmac("sha256", "whsec").update(raw).digest("hex") } }; };
  const pub = sign({ id: "e1", event: "post.published", post: { id: "post-1", status: "published", platforms: [{ platform: "tiktok", status: "published", publishedUrl: "https://www.tiktok.com/@clone8.io/video/1" }] } });
  const w = p.parseWebhook(pub.h, pub.raw)!;
  assert.equal(w.kind, "post"); assert.equal((w as any).event.status, "posted"); assert.equal((w as any).event.results[0].url, "https://www.tiktok.com/@clone8.io/video/1");
  assert.throws(() => p.parseWebhook({ "x-zernio-signature": "00" }, pub.raw), (e: any) => e.code === "webhook_unverified");
  assert.equal(verifyZernio(pub.raw, { "X-Zernio-Signature": pub.h["x-zernio-signature"] }, "whsec"), true);
  const fail = sign({ id: "e2", event: "post.platform.failed", platform: "youtube", post: { id: "post-1", platforms: [{ platform: "tiktok", status: "processing" }, { platform: "youtube", status: "failed", error: "Token expired", errorCategory: "auth_expired" }] } });
  const f = p.parseWebhook(fail.h, fail.raw) as any;
  assert.equal(f.event.partial, true); assert.deepEqual(f.event.results.map((r: any) => r.platform), ["youtube"]);
  assert.match(f.event.results[0].error, /linked again/);
  const can = sign({ id: "e3", event: "post.cancelled", post: { id: "post-1" } });
  assert.equal((p.parseWebhook(can.h, can.raw) as any).event.status, "canceled");
  const off = sign({ id: "e4", event: "account.disconnected", account: { accountId: TT, profileId: PROFILE, platform: "tiktok", disconnectionType: "unintentional" } });
  assert.deepEqual(p.parseWebhook(off.h, off.raw), { kind: "account", refId: PROFILE, platform: "tiktok", accountId: null, change: "unlink", bySystem: true });
  const on = sign({ id: "e5", event: "account.connected", account: { accountId: TT, profileId: PROFILE, platform: "tiktok", username: "clone8.io" } });
  assert.equal((p.parseWebhook(on.h, on.raw) as any).change, "link");
  const t = sign({ id: "e6", event: "webhook.test", test: true });
  assert.equal(p.parseWebhook(t.h, t.raw), null);
});

test("zernio: recent posts with views, watch time, retention and For You share; posts without a link are skipped", async () => {
  const { p } = z();
  const posts = await p.recentPosts!(PROFILE, "tiktok", 50);
  assert.equal(posts.length, 1);
  const x = posts[0];
  assert.equal(x.id, "7706392401350364430"); assert.equal(x.views, 585); assert.equal(x.duration_s, 52.9);
  assert.equal(x.extra.avg_watch_s, 6.7); assert.equal(x.extra.full_watch_rate, 0.0066); assert.equal(x.extra.fyp_share, 0.981);
  assert.equal(x.extra.hold_3s, 0.35);
  assert.deepEqual(await p.recentPosts!(PROFILE, "instagram", 50), [], "a network not linked has no posts");
});

test("zernio: removing a person removes each linked account (what is billed), then the profile", async () => {
  const { p, calls } = z();
  await p.deleteProfile(PROFILE);
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), [`/accounts/${TT}`, `/accounts/${YT}`, `/profiles/${PROFILE}`]);
});

test("zernio bill: 2 free, $6 to 10, $3 to 100, $1 after", () => {
  assert.equal(zernioBill(2).usd_month, 0);
  assert.equal(zernioBill(10).usd_month, 48, "the pricing page's own example");
  assert.equal(zernioBill(20).usd_month, 78);
  assert.equal(zernioBill(100).usd_month, 318);
  assert.equal(zernioBill(1000).usd_month, 1218);
  assert.equal(zernioBill(600).usd_month, 818);
  assert.equal(zernioBill(50).next_account_usd, 3);
  assert.equal(zernioBill(150).next_account_usd, 1);
});

// ---------------------------------------------------------------------------------------------------
// The routes with Zernio: per-network linking, and a person still on an Ayrshare profile moving over
// ---------------------------------------------------------------------------------------------------
import express from "express";
import { registerSocial } from "../src/studio-social.js";
import { accountAccess } from "../src/account-access.js";

function routeSb(tables: Record<string, any[]>) {
  return {
    tables,
    storage: { from: () => ({ createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }), createSignedUrls: async () => ({ data: [], error: null }) }) },
    from(table: string) {
      const filters: ((r: any) => boolean)[] = []; let op: any = null, head = false, one = false, single = false;
      const q: any = {
        select(_c?: string, o?: any) { if (o?.head) head = true; return q; }, limit() { return q; }, order() { return q; }, or() { return q; }, not() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; }, gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; }, lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; },
        maybeSingle() { one = true; return q; }, single() { one = true; single = true; return q; },
        insert(v: any) { op = { k: "insert", v }; return q; }, update(v: any) { op = { k: "update", v }; return q; }, delete() { op = { k: "delete" }; return q; }, upsert(v: any) { op = { k: "upsert", v }; return q; },
        then(res: any, rej: any) {
          const rows = (tables[table] ??= []); const hit = () => rows.filter((r) => filters.every((f) => f(r))); let data: any;
          if (op?.k === "insert") { const v = { created_at: new Date().toISOString(), accounts: [], ...op.v }; if (table === "studio_social_profiles" && rows.some((r) => r.user_id === v.user_id)) return Promise.resolve({ data: null, error: { message: "duplicate" } }).then(res, rej); rows.push(v); data = [v]; }
          else if (op?.k === "upsert") { const at = rows.find((r) => r.user_id === op.v.user_id); if (at) Object.assign(at, op.v); else rows.push({ ...op.v }); data = [op.v]; }
          else if (op?.k === "update") { data = hit(); for (const r of data) Object.assign(r, op.v); }
          else if (op?.k === "delete") { data = hit(); tables[table] = rows.filter((r) => !data.includes(r)); }
          else data = hit();
          return Promise.resolve(head ? { data: null, count: data.length, error: null } : { data: one ? data[0] ?? null : data, error: single && !data.length ? { message: "no rows" } : null }).then(res, rej);
        },
      };
      return q;
    },
  } as any;
}
async function serveZ(sb: any, fetchFn: any, env: Record<string, string>) {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: "11111111-1111-4111-8111-111111111111", email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: req.auth.user_id }; next(); });
  app.use(accountAccess(() => sb));
  registerSocial(app, () => sb, { env, fetch: fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("routes with Zernio: an Ayrshare profile reads as not connected, linking needs a network, the old profile is retired with a note", async () => {
  resetZernioForTests();
  const ANN = "11111111-1111-4111-8111-111111111111";
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, provider: "ayrshare", profile_key: "ayr-key", accounts: [{ platform: "tiktok" }], created_at: "2026-11-01T00:00:00Z" }], studio_social_prefs: [], studio_social_posts: [] };
  const sb = routeSb(tables), zf = fakeZernio({ "GET /accounts": () => ({ body: { accounts: [] } }) });
  const s = await serveZ(sb, zf.fetchFn, { ...ENV, STUDIO_PUBLIC_API_URL: "https://api.example.test", STUDIO_SOCIAL_WEBHOOK_TOKEN: "t" });
  const st = await s.call("GET", "/api/studio/social");
  assert.equal(st.body.connected, false); assert.equal(st.body.linking, "per_network");
  assert.equal((await s.call("POST", "/api/studio/social/connect", {})).body.error, "pick_network");
  const c = await s.call("POST", "/api/studio/social/connect", { platform: "tiktok", return_to: "https://app.clone8.io/#studio/publish" });
  assert.equal(c.status, 200); assert.match(c.body.url, /zernio\.com\/connect\/welcome/);
  assert.equal(tables.studio_social_profiles.length, 1);
  assert.equal(tables.studio_social_profiles[0].provider, "zernio");
  assert.equal(tables.studio_social_profiles[0].profile_key, PROFILE);
  assert.equal(tables.studio_social_prefs[0].cleared_reason, "provider_moved");
  assert.equal(zf.calls.find((x) => x.path === "/profiles")!.body.externalId, ANN);
  assert.equal(JSON.stringify(c.body).includes(PROFILE), false, "the profile id never leaves the server");
  await s.close();
  resetZernioForTests();
});

test("zernio: two TikToks: each listed with its id, another one added, one relinked, both posted to, one unlinked", async () => {
  const TT2 = "acc-tt2";
  const two = (url: URL) => ({ body: { accounts: [
    { _id: TT, platform: "tiktok", username: "clone8.io", isActive: true, enabled: true },
    { _id: TT2, platform: "tiktok", username: "clone8.clips", isActive: true, enabled: true },
    { _id: "acc-ig", platform: "instagram", username: "clone8", isActive: true, enabled: true },
  ] } });
  const { p, calls } = z({
    "GET /accounts": (_b, url) => two(url),
    "GET /connect/instagram": () => ({ body: { authUrl: "https://zernio.com/connect/welcome?ticket=ig" } }),
    "POST /posts": (body) => ({ status: 201, body: { post: { _id: "post-2", status: "published", platforms: body.platforms.map((t: any) => ({ platform: t.platform, accountId: t.accountId, status: "processing" })) } } }),
  });
  const accs = await p.accounts(PROFILE);
  assert.deepEqual(accs.map((a) => [a.id, a.platform, a.username]), [[TT, "tiktok", "clone8.io"], [TT2, "tiktok", "clone8.clips"], ["acc-ig", "instagram", "clone8"]]);
  // adding another: no reconnect id (a different login becomes a new account); Instagram asks for the login
  await p.connectUrl(PROFILE, { platform: "tiktok", add: true });
  let c = calls.filter((x) => x.path === "/connect/tiktok").at(-1)!;
  assert.equal(c.url.searchParams.get("reconnectAccountId"), null);
  await p.connectUrl(PROFILE, { platform: "instagram", add: true });
  c = calls.filter((x) => x.path === "/connect/instagram").at(-1)!;
  assert.equal(c.url.searchParams.get("forceReauth"), "true");
  // relinking the second one refreshes exactly that one; an id from elsewhere is refused
  await p.connectUrl(PROFILE, { platform: "tiktok", accountId: TT2 });
  c = calls.filter((x) => x.path === "/connect/tiktok").at(-1)!;
  assert.equal(c.url.searchParams.get("reconnectAccountId"), TT2);
  await assert.rejects(p.connectUrl(PROFILE, { platform: "tiktok", accountId: "acc-ig" }), /not linked/);
  // at the limit, relinking a named account still works (no "add" happens)
  await p.connectUrl(PROFILE, { platform: "tiktok", accountId: TT, only: ["tiktok"] });
  c = calls.filter((x) => x.path === "/connect/tiktok").at(-1)!;
  assert.equal(c.url.searchParams.get("reconnectAccountId"), TT);
  // posting to both TikToks: two targets, one result per account; a gone account fails alone
  const r = await p.publish(PROFILE, { text: "hi", platforms: ["tiktok"], accounts: [TT, TT2, "acc-gone"], mediaUrl: "https://x/v.mp4", scheduleAt: null });
  const sent = calls.find((x) => x.method === "POST" && x.path === "/posts")!.body;
  assert.deepEqual(sent.platforms.map((t: any) => t.accountId), [TT, TT2]);
  assert.ok(sent.tiktokSettings, "TikTok consent flags go with any TikTok target");
  assert.deepEqual(r.results.map((x) => [x.account_id, x.status]), [[TT, "pending"], [TT2, "pending"], ["acc-gone", "failed"]]);
  // unlinking one removes only that one
  await p.disconnect(PROFILE, "tiktok", TT2);
  const dels = calls.filter((x) => x.method === "DELETE" && x.path.startsWith("/accounts/")).map((x) => x.path);
  assert.deepEqual(dels, [`/accounts/${TT2}`]);
});

test("zernio: a per-account webhook names the account; a post event is split by account", () => {
  const { p } = z();
  const body = JSON.stringify({ event: "post.platform.published", platform: "tiktok", account: { id: "acc-tt2", platform: "tiktok" }, post: { id: "post-2", status: "publishing", platforms: [
    { platform: "tiktok", accountId: "acc-tt", status: "processing" }, { platform: "tiktok", accountId: "acc-tt2", status: "published", publishedUrl: "https://www.tiktok.com/@clone8.clips/video/2" } ] } });
  const sig = createHmac("sha256", "whsec").update(body).digest("hex");
  const w = p.parseWebhook({ "x-zernio-signature": sig }, body);
  assert.equal(w?.kind, "post");
  const ev = (w as any).event;
  assert.deepEqual(ev.results.map((x: any) => [x.account_id, x.status]), [["acc-tt2", "posted"]]);
});
