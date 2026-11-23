import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { ayrshareProvider, friendlyError, statusOf, verifySignature } from "../src/social-ayrshare.js";
import { getSocialProvider } from "../src/social-provider.js";
import { registerSocial, socialTick, webhookUrl, cleanOptions, applyEvent, drainBatch } from "../src/studio-social.js";
import { registerPostGroups, staggerTimes } from "../src/studio-post-groups.js";
import { accountAccess } from "../src/account-access.js";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ENV = { STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "ayr-test-key", STUDIO_PUBLIC_API_URL: "https://api.example.test", STUDIO_SOCIAL_WEBHOOK_TOKEN: "tok123", STUDIO_SOCIAL_WEBHOOK_SECRET: "whsec" } as Record<string, string>;

/** A fake Ayrshare: records every call and answers like the docs (Oct 30, 2026). */
function fakeAyr(over: Partial<Record<string, (body: any, headers: Record<string, string>) => { status?: number; body: any }>> = {}) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  let n = 0;
  const fetchFn = async (url: string, init: any) => {
    const path = url.replace("https://api.ayrshare.com/api", "");
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, headers, body });
    const key = `${init.method} ${path.replace(/\/post\/[^/]+$/, "/post/:id")}`;
    const h = over[key];
    const r = h ? h(body, headers) : defaults(key, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const defaults = (key: string, body: any): { status?: number; body: any } => {
    switch (key) {
      case "POST /profiles": return { body: { status: "success", title: body.title, refId: `ref-${++n}`, profileKey: `pk-${n}` } };
      case "DELETE /profiles": return { body: { status: "success" } };
      case "POST /profiles/link-sessions": return { body: { status: "success", sessionId: "s1", url: "https://profile.ayrshare.com?session=ayr_ls_x", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } };
      case "GET /user": return { body: { activeSocialAccounts: ["tiktok", "youtube"], displayNames: [
        { platform: "tiktok", username: "ann.makes", displayName: "Ann", userImage: "https://img/t.jpg", profileUrl: "https://tiktok.com/@ann.makes" },
        { platform: "youtube", username: "Ann Person", displayName: "Ann Person", channelTitle: "Ann Makes", handle: "@annmakes", profileUrl: "https://youtube.com/@annmakes" },
        { platform: "facebook", username: "stale" },
      ] } };
      case "DELETE /profiles/social": return { body: { status: "success", platform: body.platform } };
      case "POST /post": return body.scheduleDate
        ? { body: { status: "success", posts: [{ status: "scheduled", scheduleDate: body.scheduleDate, id: `post-${++n}`, refId: "ref-1" }] } }
        : { body: { status: "success", posts: [{ status: "success", errors: [], id: `post-${++n}`, postIds: body.platforms.map((p: string) => ({ status: "success", id: p === "tiktok" ? "pending" : "x1", platform: p, postUrl: p === "tiktok" ? undefined : `https://${p}.example/1` })) }] } };
      case "GET /post/:id": return { body: { status: "success", platforms: ["tiktok"], postIds: [{ platform: "tiktok", status: "success", id: "t9", postUrl: "https://tiktok.com/v/9" }] } };
      case "DELETE /post": return { body: { status: "success" } };
      case "POST /hook/webhook": return { body: { status: "success", action: body.action, url: body.url } };
      default: return { status: 404, body: { message: `no fake for ${key}` } };
    }
  };
  return { fetchFn: fetchFn as any, calls };
}

test("provider: off without the switch or the key; X only with the account's own X keys", () => {
  assert.equal(getSocialProvider({ env: { AYRSHARE_API_KEY: "k" } }), null);
  assert.equal(getSocialProvider({ env: { STUDIO_SOCIAL_ENABLED: "true" } }), null);
  const p = ayrshareProvider({ env: ENV, fetch: fakeAyr().fetchFn })!;
  assert.ok(!p.offered().includes("twitter"));
  assert.ok(ayrshareProvider({ env: { ...ENV, AYRSHARE_X_API_KEY: "a", AYRSHARE_X_API_SECRET: "b" }, fetch: fakeAyr().fetchFn })!.offered().includes("twitter"));
});

test("provider: profile, link session (no private key), accounts from active networks only, unlink with the profile header", async () => {
  const ayr = fakeAyr();
  const p = ayrshareProvider({ env: { ...ENV, AYRSHARE_DOMAIN: "clone8" }, fetch: ayr.fetchFn })!;
  const made = await p.createProfile("Clone8 · ann@x");
  assert.equal(made.profileKey, "pk-1");
  assert.equal(ayr.calls[0].headers.Authorization, "Bearer ayr-test-key");
  assert.equal(ayr.calls[0].headers["Profile-Key"], undefined);
  assert.equal(ayr.calls[0].body.hideLogo, true);
  const link = await p.connectUrl("pk-1", { redirect: "https://app.clone8.io/#studio/publish", origin: "https://app.clone8.io" });
  assert.match(link.url, /^https:\/\//);
  const ls = ayr.calls[1];
  assert.equal(ls.path, "/profiles/link-sessions");
  assert.equal(ls.headers["Profile-Key"], "pk-1");
  assert.equal(ls.body.privateKey, undefined);
  assert.equal(ls.body.domain, "clone8");
  assert.deepEqual(ls.body.allowedSocial.includes("twitter"), false);
  const accts = await p.accounts("pk-1");
  assert.deepEqual(accts.map((a) => a.platform), ["tiktok", "youtube"], "a network not in activeSocialAccounts is not shown");
  assert.equal(accts[1].username, "@annmakes");
  assert.equal(accts[1].display_name, "Ann Makes");
  await p.disconnect("pk-1", "tiktok");
  const un = ayr.calls.at(-1)!;
  assert.equal(un.method, "DELETE"); assert.equal(un.path, "/profiles/social"); assert.equal(un.headers["Profile-Key"], "pk-1"); assert.deepEqual(un.body, { platform: "tiktok" });
});

test("provider: a taken profile title is its own error", async () => {
  const ayr = fakeAyr({ "POST /profiles": () => ({ status: 400, body: { action: "create", status: "error", code: 146, message: "Profile title already exists." } }) });
  const p = ayrshareProvider({ env: ENV, fetch: ayr.fetchFn })!;
  await assert.rejects(p.createProfile("t"), (e: any) => e.code === "profile_title_taken");
});

test("provider: publish now, scheduled, partial and refused; YouTube title capped by code points and public", async () => {
  const ayr = fakeAyr();
  const p = ayrshareProvider({ env: ENV, fetch: ayr.fetchFn })!;
  const now = await p.publish("pk-1", { text: "hi", platforms: ["tiktok", "instagram"], mediaUrl: "https://signed/v.mp4", scheduleAt: null, idempotencyKey: "row-1" });
  assert.equal(now.status, "sending", "TikTok is still processing, so the post stays open");
  assert.equal(now.results.find((r) => r.platform === "instagram")!.status, "posted");
  assert.equal(now.results.find((r) => r.platform === "tiktok")!.status, "pending");
  const sent = ayr.calls.at(-1)!.body;
  assert.equal(sent.idempotencyKey, "row-1"); assert.deepEqual(sent.mediaUrls, ["https://signed/v.mp4"]); assert.equal(sent.isVideo, true);
  const at = new Date("2026-11-02T17:30:00.000Z");
  const longTitle = "🎬".repeat(120);
  const sch = await p.publish("pk-1", { text: "x", platforms: ["youtube"], mediaUrl: "https://signed/v.mp4", scheduleAt: at, options: { youtube: { title: longTitle } } });
  assert.equal(sch.status, "scheduled");
  const body = ayr.calls.at(-1)!.body;
  assert.equal(body.scheduleDate, "2026-11-02T17:30:00Z");
  assert.equal(Array.from(body.youTubeOptions.title).length, 100);
  assert.equal(body.youTubeOptions.visibility, "public");

  const partial = fakeAyr({ "POST /post": () => ({ status: 400, body: { status: "error", posts: [{ status: "error", id: "post-9", postIds: [{ status: "success", platform: "tiktok", id: "t1", postUrl: "https://t/1" }], errors: [{ action: "post", status: "error", code: 156, message: "Instagram is not linked", platform: "instagram" }] }] } }) });
  const pr = await ayrshareProvider({ env: ENV, fetch: partial.fetchFn })!.publish("pk-1", { text: "", platforms: ["tiktok", "instagram"], mediaUrl: "https://s/v.mp4", scheduleAt: null });
  assert.equal(pr.status, "partial");
  assert.match(pr.results.find((r) => r.platform === "instagram")!.error!, /not linked/);

  const refused = fakeAyr({ "POST /post": () => ({ status: 400, body: { status: "error", code: 106, message: "Monthly post quota used" } }) });
  const rr = await ayrshareProvider({ env: ENV, fetch: refused.fetchFn })!.publish("pk-1", { text: "", platforms: ["tiktok"], mediaUrl: "https://s/v.mp4", scheduleAt: null });
  assert.equal(rr.status, "failed"); assert.equal(rr.providerPostId, null);
});

test("provider: errors read plainly and never name the vendor; statuses roll up", () => {
  assert.match(friendlyError({ code: 272, platform: "twitter" }), /linked again/);
  assert.equal(/ayrshare/i.test(friendlyError({ code: 999, message: "Ayrshare said no" })), false);
  assert.equal(statusOf([{ platform: "a", status: "posted", url: null, error: null }, { platform: "b", status: "failed", url: null, error: "x" }], false), "partial");
  assert.equal(statusOf([{ platform: "a", status: "pending", url: null, error: null }], true), "scheduled");
  assert.equal(statusOf([{ platform: "a", status: "failed", url: null, error: null }], false), "failed");
});

test("provider: status read-back and cancel", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const ayr = fakeAyr({ "GET /post/:id": () => ({ body: { status: "pending", scheduleDate: future, platforms: ["tiktok"], postIds: [] } }), "DELETE /post": () => ({ status: 400, body: { code: 114, message: "Delete id not found." } }) });
  const p = ayrshareProvider({ env: ENV, fetch: ayr.fetchFn })!;
  assert.equal((await p.status("pk", "post-1"))!.status, "scheduled");
  await p.cancel("pk", "post-1"); // already gone counts as canceled
  const done = ayrshareProvider({ env: ENV, fetch: fakeAyr().fetchFn })!;
  const ev = await done.status("pk", "post-1");
  assert.equal(ev!.status, "posted"); assert.equal(ev!.results[0].url, "https://tiktok.com/v/9");
  const err = ayrshareProvider({ env: ENV, fetch: fakeAyr({ "GET /post/:id": () => ({ body: { status: "error", platforms: ["instagram"], errors: [{ platform: "instagram", code: 161, message: "auth" }] } }) }).fetchFn })!;
  const e2 = await err.status("pk", "post-1");
  assert.equal(e2!.status, "failed"); assert.match(e2!.error!, /linked again/);
});

test("provider: webhook signatures (current and rotated), scheduled and social payloads", () => {
  const p = ayrshareProvider({ env: ENV, fetch: fakeAyr().fetchFn })!;
  const raw = JSON.stringify({ action: "scheduled", status: "success", id: "post-7", postIds: [{ platform: "youtube", status: "success", id: "y1", postUrl: "https://youtu.be/1" }], errors: [] });
  const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
  assert.equal(verifySignature(raw, { "x-authorization-content-sha256": sig }, "whsec"), true);
  assert.equal(verifySignature(raw, { "X-Authorization-Content-SHA256-V2": `v1=${"0".repeat(64)},v1=${sig}` }, "whsec"), true);
  assert.equal(verifySignature(raw, { "x-authorization-content-sha256": "0".repeat(64) }, "whsec"), false);
  assert.throws(() => p.parseWebhook({ "x-authorization-content-sha256": "0".repeat(64) }, raw), (e: any) => e.code === "webhook_unverified");
  const hook = p.parseWebhook({ "x-authorization-content-sha256": sig }, raw)!;
  assert.equal(hook.kind, "post");
  assert.equal(hook.kind === "post" && hook.event.status, "posted");
  const social = JSON.stringify({ action: "social", type: "unlink", platform: "tiktok", refId: "ref-1", source: "system" });
  const h2 = p.parseWebhook({ "x-authorization-content-sha256": createHmac("sha256", "whsec").update(social).digest("hex") }, social)!;
  assert.deepEqual(h2, { kind: "account", refId: "ref-1", platform: "tiktok", change: "unlink", bySystem: true });
});

test("helpers: webhook URL carries the token; YouTube always gets a title", () => {
  assert.equal(webhookUrl(ENV), "https://api.example.test/api/studio/social/webhook?token=tok123");
  assert.equal(webhookUrl({}), null);
  assert.deepEqual(cleanOptions(["youtube"], {}, "First line\nsecond"), { youtube: { title: "First line", visibility: "public" } });
  assert.deepEqual(cleanOptions(["tiktok"], { youtube: { title: "x" } }, ""), {});
});

// ---------------------------------------------------------------------------------------------------
// Routes, against a small in-memory database.
function fakeSb(tables: Record<string, any[]>) {
  const signed: Array<{ key: string; ttl: number }> = [];
  let ids = 0;
  const sb: any = {
    tables, signed,
    storage: { from: () => ({
      createSignedUrl: async (k: string, ttl: number) => { signed.push({ key: k, ttl }); return { data: { signedUrl: `https://signed/${k}` }, error: null }; },
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
    }) },
    from(table: string) {
      let rows = () => tables[table] ?? [];
      const filters: ((r: any) => boolean)[] = [];
      let single = false, maybe = false, pending: any = null;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
        is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        not(k: string, _op: string, _v: any) { filters.push((r) => r[k] != null); return q; },
        or(expr: string) {
          const gte = expr.match(/schedule_at\.gte\.([^,]+),/)?.[1];
          if (gte) { filters.push((r) => (r.schedule_at ? r.schedule_at >= gte : r.created_at >= gte)); return q; }
          const lt = expr.match(/schedule_at\.lt\.(.+)$/)?.[1]; filters.push((r) => r.schedule_at == null || (lt ? r.schedule_at < lt : false)); return q;
        },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { op: "insert", v }; return q; },
        delete() { pending = { op: "delete" }; return q; },
        update(v: any) { pending = { op: "update", v }; return q; },
        then(resolve: any, reject: any) {
          if (pending?.op === "insert") {
            if (table === "studio_social_profiles" && (tables[table] ?? []).some((r) => r.user_id === pending.v.user_id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }).then(resolve, reject);
            const v = { id: `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`, created_at: new Date().toISOString(), updated_at: "2000-01-01T00:00:00Z", results: [], error: null, provider_post_id: null, accounts: [], webhook_registered_at: null, ...pending.v };
            (tables[table] ??= []).push(v); rows = () => [v];
          }
          if (pending?.op === "delete") { const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r)); rows = () => hit; filters.length = 0; }
          if (pending?.op === "update") { const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); for (const r of hit) Object.assign(r, pending.v); rows = () => hit; filters.length = 0; }
          const out = rows().filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: single || maybe ? (out[0] ?? null) : out, error: single && !out.length ? { message: "no rows" } : null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return sb;
}
const doneJob = (over: any = {}) => ({ id: JOB, user_id: ANN, status: "done", finished_at: new Date().toISOString(), outputs: [{ key: `${ANN}/${JOB}/1.mp4`, kind: "video" }, { key: `${ANN}/${JOB}/2.mp4`, kind: "video" }], ...over });

async function serve(sb: any, fetchFn: any, env = ENV) {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) { req.auth = { user_id: u, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: u }; } next(); });
  app.use(accountAccess(() => sb));
  registerSocial(app, () => sb, { env, fetch: fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = { "x-test-user": ANN }) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("routes: off shows nothing; connect needs a plan, makes one profile, registers the webhook, never returns the key", async () => {
  const off = await serve(fakeSb({}), fakeAyr().fetchFn, { ...ENV, STUDIO_SOCIAL_ENABLED: "false" });
  assert.deepEqual((await off.call("GET", "/api/studio/social")).body, { enabled: false, connected: false, accounts: [], platforms: [] });
  await off.close();

  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active" }, { user_id: BOB, status: "canceled" }], studio_social_profiles: [], studio_jobs: [], studio_social_posts: [] };
  const sb = fakeSb(tables), ayr = fakeAyr();
  const s = await serve(sb, ayr.fetchFn);
  assert.equal((await s.call("POST", "/api/studio/social/connect", {}, { "x-test-user": BOB })).body.error, "subscription_required");
  const c1 = await s.call("POST", "/api/studio/social/connect", { return_to: "https://app.clone8.io/#studio/publish" });
  assert.match(c1.body.url, /^https:\/\//);
  assert.equal(tables.studio_social_profiles.length, 1, "one profile per person, however often they connect");
  assert.equal(ayr.calls.filter((c) => c.path === "/profiles").length, 1);
  const hooks = ayr.calls.filter((c) => c.path === "/hook/webhook");
  assert.deepEqual(hooks.map((h) => h.body.action), ["scheduled", "social"]);
  assert.equal(hooks[0].body.url, "https://api.example.test/api/studio/social/webhook?token=tok123");
  assert.equal(hooks[0].body.secret, "whsec");
  assert.ok(tables.studio_social_profiles[0].title.startsWith("Clone8 · ann@"));
  const st = await s.call("GET", "/api/studio/social");
  assert.equal(st.body.connected, true);
  assert.equal(JSON.stringify(st.body).includes("pk-"), false, "the profile key never leaves the server");
  assert.equal(JSON.stringify(c1.body).includes("pk-"), false);
  await s.close();
});

test("routes: post now and scheduled with spacing; ownership, linking and the 30-day window are checked; cancel; webhook moves rows", async () => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", ref_id: "ref-ann", accounts: [{ platform: "tiktok" }, { platform: "youtube" }], webhook_registered_at: "2026-10-30T00:00:00Z" }], studio_jobs: [doneJob(), { ...doneJob(), id: "44444444-4444-4444-8444-444444444444", user_id: BOB }], studio_social_posts: [] };
  const sb = fakeSb(tables), ayr = fakeAyr();
  const s = await serve(sb, ayr.fetchFn);
  const item = (n: number, job = JOB) => ({ job_id: job, output_key: `${ANN}/${JOB}/${n}.mp4` });

  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["instagram"], caption: "x" })).body.error, "platform_not_linked");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1, "44444444-4444-4444-8444-444444444444")], platforms: ["tiktok"], caption: "x" })).body.error, "video_not_found", "someone else's job is not found");
  // up to 90 days ahead (owner, Nov 22 2026); made videos are kept for posts that wait on them
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"], schedule_at: new Date(Date.now() + 95 * 86400_000).toISOString() })).body.error, "too_late");

  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"], schedule_at: new Date(Date.now() - 60_000).toISOString() })).body.error, "too_soon", "a time that has passed is refused, not posted now");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"], schedule_at: new Date(Date.now() + 2 * 60_000).toISOString() })).body.error, "too_soon");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1), item(1)], platforms: ["youtube"] })).body.error, "same_video_twice");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["twitter"] })).body.error, "platform_unavailable", "a network not offered is refused, not dropped");
  assert.equal(ayr.calls.filter((c) => c.path === "/post").length, 0, "nothing was sent by the refusals");

  const now = await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["youtube"], caption: "Launch day\n#clone8" });
  assert.equal(now.status, 201);
  assert.equal(now.body.posts[0].status, "posted");
  const sent = ayr.calls.filter((c) => c.path === "/post").at(-1)!;
  assert.equal(sent.headers["Profile-Key"], "pk-ann");
  assert.equal(sent.body.youTubeOptions.title, "Launch day");
  assert.equal(sent.body.idempotencyKey, tables.studio_social_posts[0].id);
  assert.ok(sb.signed.at(-1).ttl >= 7 * 86400, "the video link outlives the provider's 7-day ask");
  const again = await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["youtube"] });
  assert.equal(again.body.error, "already_posted", "the same video to the same network in a day is refused");

  const at = new Date(Date.now() + 2 * 3600_000);
  const sch = await s.call("POST", "/api/studio/social/posts", { items: [item(1), item(2)], platforms: ["tiktok"], caption: "", schedule_at: at.toISOString(), spacing_minutes: 180 });
  assert.deepEqual(sch.body.posts.map((p: any) => p.status), ["scheduled", "scheduled"]);
  const dates = ayr.calls.filter((c) => c.path === "/post").slice(-2).map((c) => Date.parse(c.body.scheduleDate));
  assert.equal(dates[1] - dates[0], 180 * 60_000);

  const posted = tables.studio_social_posts.find((p) => p.status === "posted" || p.status === "sending")!;
  assert.equal((await s.call("DELETE", `/api/studio/social/posts/${posted.id}`)).body.error, "not_cancelable");
  const first = tables.studio_social_posts.find((p) => p.status === "scheduled")!;
  assert.equal((await s.call("DELETE", `/api/studio/social/posts/${first.id}`)).body.post.status, "canceled");
  assert.equal(ayr.calls.at(-1)!.path, "/post"); assert.equal(ayr.calls.at(-1)!.method, "DELETE");

  // webhook: token and signature both checked; a canceled row stays canceled
  const second = tables.studio_social_posts.find((p) => p.status === "scheduled")!;
  const raw = JSON.stringify({ action: "scheduled", status: "success", id: second.provider_post_id, postIds: [{ platform: "tiktok", status: "success", id: "t5", postUrl: "https://tiktok.com/v/5" }] });
  const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
  assert.equal((await s.call("POST", "/api/studio/social/webhook?token=nope", raw, { "x-authorization-content-sha256": sig })).status, 401);
  assert.equal((await s.call("POST", "/api/studio/social/webhook?token=tok123", raw, { "x-authorization-content-sha256": "0".repeat(64) })).status, 401);
  const ok = await s.call("POST", "/api/studio/social/webhook?token=tok123", raw, { "x-authorization-content-sha256": sig });
  assert.equal(ok.body.updated, 1);
  assert.equal(second.status, "posted"); assert.equal(second.results[0].url, "https://tiktok.com/v/5");
  const rawC = JSON.stringify({ action: "scheduled", status: "success", id: first.provider_post_id, postIds: [{ platform: "tiktok", status: "success", id: "t6" }] });
  await s.call("POST", "/api/studio/social/webhook?token=tok123", rawC, { "x-authorization-content-sha256": createHmac("sha256", "whsec").update(rawC).digest("hex") });
  assert.equal(first.status, "canceled");

  const list = await s.call("GET", "/api/studio/social/posts");
  assert.equal(list.body.posts.length, 3);
  // fail closed: without the signing secret no delivery is trusted, even with the right token
  const open = await serve(sb, ayr.fetchFn, { ...ENV, STUDIO_SOCIAL_WEBHOOK_SECRET: "" });
  assert.equal((await open.call("POST", "/api/studio/social/webhook?token=tok123", raw, {})).status, 401);
  await open.close();
  assert.equal(list.body.posts[0].poster_url.endsWith(".jpg"), true);
  await s.close();
});

test("tick: reads back sends and overdue schedules the webhook did not settle", async () => {
  const old = new Date(Date.now() - 3600_000).toISOString();
  const tables: Record<string, any[]> = { studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann" }], studio_social_posts: [
    { id: "p1", user_id: ANN, provider: "ayrshare", provider_post_id: "post-1", status: "sending", schedule_at: null, updated_at: old },
    { id: "p2", user_id: ANN, provider: "ayrshare", provider_post_id: "post-2", status: "scheduled", schedule_at: new Date(Date.now() + 86400_000).toISOString(), updated_at: old },
  ] };
  const ayr = fakeAyr();
  const moved = await socialTick(fakeSb(tables), { env: ENV, fetch: ayr.fetchFn, log: () => {} });
  assert.equal(moved, 1);
  assert.equal(tables.studio_social_posts[0].status, "posted");
  assert.equal(tables.studio_social_posts[1].status, "scheduled", "a future schedule is not touched");
  assert.equal(ayr.calls.length, 1);
});

test("captions: frames and speech go to Claude with a JSON schema (no forced tool), hashtags cleaned, YouTube title only when asked", async () => {
  const { draftCaption, allowCaption } = await import("../src/studio-captions.js");
  const tables: Record<string, any[]> = { studio_jobs: [doneJob()] };
  const sb = fakeSb(tables);
  const asked: any[] = [];
  const fetchFn: any = async (url: string, init: any) => {
    if (url.startsWith("https://signed/")) return new Response(new Uint8Array([1, 2, 3]));
    if (url === "https://api.anthropic.com/v1/messages") { asked.push({ headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ caption: "POV: the cat runs the podcast now", hashtags: ["catsoftiktok", "#podcast", "two words"], youtube_title: "The cat took over the podcast" }) }] })); }
    throw new Error(`unexpected ${url}`);
  };
  const d = await draftCaption(sb, ANN, { job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4`, platforms: ["tiktok", "youtube"], note: "funny" }, { env: { ANTHROPIC_API_KEY: "sk" }, fetch: fetchFn, frames: async () => ["AAA", "BBB"], speech: async () => "welcome back to the show" });
  assert.equal(d.caption, "POV: the cat runs the podcast now");
  assert.deepEqual(d.hashtags, ["#catsoftiktok", "#podcast", "#twowords"]);
  assert.equal(d.youtube_title, "The cat took over the podcast");
  assert.equal(d.heard_speech, true);
  const b = asked[0].body;
  assert.equal(b.model, "claude-opus-5-5");
  assert.equal(b.tool_choice, undefined); assert.equal(b.tools, undefined);
  assert.equal(b.output_config.format.type, "json_schema");
  assert.equal(b.fallbacks, "default"); assert.equal(asked[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const content = b.messages[0].content;
  assert.deepEqual(content.slice(0, 2).map((c: any) => c.source.media_type), ["image/jpeg", "image/jpeg"]);
  assert.match(content.at(-1).text, /welcome back to the show/); assert.match(content.at(-1).text, /funny/);
  const noYt = await draftCaption(sb, ANN, { job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4`, platforms: ["tiktok"] }, { env: { ANTHROPIC_API_KEY: "sk" }, fetch: fetchFn, frames: async () => ["AAA"], speech: async () => null });
  assert.equal(noYt.youtube_title, null);
  await assert.rejects(draftCaption(sb, BOB, { job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4`, platforms: [] }, { env: { ANTHROPIC_API_KEY: "sk" }, fetch: fetchFn, frames: async () => ["A"], speech: async () => null }), (e: any) => e.code === "video_not_found", "someone else's video");
  await assert.rejects(draftCaption(sb, ANN, { job_id: JOB, output_key: "x", platforms: [] }, { env: {}, fetch: fetchFn }), (e: any) => e.code === "captions_off");
  const t0 = 1_000_000;
  for (let i = 0; i < 100; i++) assert.equal(allowCaption("rate-user", t0 + i), true);
  assert.equal(allowCaption("rate-user", t0 + 101), false);
  assert.equal(allowCaption("rate-user", t0 + 3600_001 + 101), true, "the hour rolls over");
});

test("routes: a send the service never answers is kept as unconfirmed, never sent again; a TikTok-only delivery merges", async () => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", ref_id: "ref-ann", accounts: [{ platform: "tiktok" }, { platform: "youtube" }], webhook_hash: "x" }], studio_jobs: [doneJob()], studio_social_posts: [] };
  const sb = fakeSb(tables);
  let down = true;
  const ayr = fakeAyr({ "POST /post": (body) => (down ? { status: 503, body: { message: "upstream Ayrshare timeout" } } : { body: { status: "success", posts: [{ status: "success", id: "post-m", postIds: body.platforms.map((p: string) => ({ platform: p, status: "success", id: p === "tiktok" ? "pending" : "y1", postUrl: p === "tiktok" ? undefined : "https://youtube.example/1" })) }] } }) });
  const s = await serve(sb, ayr.fetchFn);
  const item = (n: number) => ({ job_id: JOB, output_key: `${ANN}/${JOB}/${n}.mp4` });
  const r = await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"], caption: "x" });
  assert.equal(r.status, 201);
  assert.equal(r.body.posts[0].status, "sending", "unknown is not failed");
  assert.match(r.body.posts[0].error, /could not confirm/i);
  assert.doesNotMatch(JSON.stringify(r.body), /ayrshare/i);
  down = false;
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"] })).body.error, "already_posted", "an unconfirmed send blocks a resend");
  assert.equal(ayr.calls.filter((c) => c.path === "/post").length, 1);
  // after 30 minutes with no answer the loop closes it as unconfirmed (it still blocks a resend)
  tables.studio_social_posts[0].created_at = new Date(Date.now() - 31 * 60_000).toISOString();
  await socialTick(sb, { env: ENV, fetch: ayr.fetchFn, log: () => {} });
  assert.equal(tables.studio_social_posts[0].status, "failed");
  assert.match(tables.studio_social_posts[0].error, /could not confirm/i);
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"] })).body.error, "already_posted");

  // video 2 to both networks: YouTube answers at once, TikTok later on its own
  const both = await s.call("POST", "/api/studio/social/posts", { items: [item(2)], platforms: ["tiktok", "youtube"] });
  const row = tables.studio_social_posts.find((p) => p.provider_post_id === "post-m")!;
  assert.equal(both.body.posts[0].status, "sending");
  const raw = JSON.stringify({ action: "scheduled", status: "success", id: "post-m", postIds: [{ platform: "tiktok", status: "success", id: "t1", postUrl: "https://www.tiktok.com/@ann/video/1" }] });
  await s.call("POST", "/api/studio/social/webhook?token=tok123", raw, { "x-authorization-content-sha256": createHmac("sha256", "whsec").update(raw).digest("hex") });
  assert.equal(row.status, "posted", "both networks done");
  assert.deepEqual(row.results.map((x: any) => x.platform).sort(), ["tiktok", "youtube"], "the YouTube result survives the TikTok delivery");
  assert.equal(row.results.find((x: any) => x.platform === "youtube").url, "https://youtube.example/1");
  // a forged-looking link never becomes clickable
  const bad = JSON.stringify({ action: "scheduled", status: "success", id: "post-m", postIds: [{ platform: "tiktok", status: "success", id: "t1", postUrl: "javascript:alert(1)" }] });
  await s.call("POST", "/api/studio/social/webhook?token=tok123", bad, { "x-authorization-content-sha256": createHmac("sha256", "whsec").update(bad).digest("hex") });
  assert.equal(row.results.find((x: any) => x.platform === "tiktok").url, null);
  await s.close();
});

test("routes: the daily allowance is counted per person by network sends", async () => {
  const outputs = Array.from({ length: 6 }, (_, i) => ({ key: `${ANN}/${JOB}/${i + 1}.mp4`, kind: "video" }));
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", accounts: [{ platform: "tiktok" }, { platform: "youtube" }] }], studio_jobs: [doneJob({ outputs })], studio_social_posts: [] };
  const sb = fakeSb(tables), ayr = fakeAyr();
  const s = await serve(sb, ayr.fetchFn, { ...ENV, STUDIO_SOCIAL_DAILY_POSTS: "5" });
  const item = (n: number) => ({ job_id: JOB, output_key: `${ANN}/${JOB}/${n}.mp4` });
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1), item(2)], platforms: ["tiktok", "youtube"] })).status, 201);
  const over = await s.call("POST", "/api/studio/social/posts", { items: [item(3), item(4)], platforms: ["tiktok"] });
  assert.equal(over.status, 429); assert.equal(over.body.error, "daily_limit"); assert.match(over.body.detail, /limit of 5 posts a day on/);
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(3)], platforms: ["tiktok"] })).status, 201);
  // the allowance counts the day a post goes out: three more, one a day from tomorrow, fit
  const tomorrow = new Date(Date.now() + 86400_000); tomorrow.setUTCHours(12, 0, 0, 0);
  const spread = await s.call("POST", "/api/studio/social/posts", { items: [item(4), item(5), item(6)], platforms: ["tiktok", "youtube"], schedule_at: tomorrow.toISOString(), spacing_minutes: 1440 });
  assert.equal(spread.status, 201, JSON.stringify(spread.body));
  await s.close();
});

test("routes: a batch of videos can carry a caption and a YouTube title each (a run of clips)", async () => {
  const outputs = Array.from({ length: 2 }, (_, i) => ({ key: `${ANN}/${JOB}/${i + 1}.mp4`, kind: "video" }));
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", accounts: [{ platform: "tiktok" }, { platform: "youtube" }] }], studio_jobs: [doneJob({ outputs })], studio_social_posts: [] };
  const sb = fakeSb(tables), ayr = fakeAyr();
  const s = await serve(sb, ayr.fetchFn, ENV);
  const r = await s.call("POST", "/api/studio/social/posts", { items: [{ job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4`, caption: "First one #a", youtube_title: "First" }, { job_id: JOB, output_key: `${ANN}/${JOB}/2.mp4`, caption: "Second one #b" }], platforms: ["tiktok", "youtube"], caption: "shared" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sent = ayr.calls.filter((c) => c.method === "POST" && c.path === "/post").map((c) => c.body);
  assert.deepEqual(sent.map((b) => b.post), ["First one #a", "Second one #b"]);
  assert.equal(sent[0].youTubeOptions?.title, "First");
  assert.equal(sent[1].youTubeOptions?.title, "Second one #b", "no title given: the caption's first line");
  assert.deepEqual(tables.studio_social_posts.map((x) => x.caption), ["First one #a", "Second one #b"]);
  await s.close();
});

test("social accounts: the plan's allowance, relink-only linking at the limit, posting paused when over it", async () => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "starter", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", ref_id: "ref-ann", accounts: [{ platform: "tiktok" }], webhook_hash: "x" }], studio_jobs: [doneJob()], studio_social_posts: [] };
  const sb = fakeSb(tables);
  const ayr = fakeAyr({ "GET /user": () => ({ body: { activeSocialAccounts: ["tiktok"], displayNames: [{ platform: "tiktok", username: "ann" }] } }) });
  const s = await serve(sb, ayr.fetchFn);
  const st = await s.call("GET", "/api/studio/social");
  assert.deepEqual([st.body.allowance.included, st.body.allowance.extra, st.body.allowance.total, st.body.allowance.price_usd_month], [1, 0, 1, 19], "Starter: 1 account; extras $19 a month");
  const link = await s.call("POST", "/api/studio/social/connect", { return_to: "https://app.clone8.io/#studio/publish" });
  assert.equal(link.body.relink_only, true);
  assert.deepEqual(ayr.calls.filter((c) => c.path === "/profiles/link-sessions").at(-1)!.body.allowedSocial, ["tiktok"], "at the limit the linking page only relinks");
  // two linked on a one-account plan (both added in one visit to the linking page): posting waits
  tables.studio_social_profiles[0].accounts = [{ platform: "tiktok" }, { platform: "youtube" }];
  const over = await s.call("POST", "/api/studio/social/posts", { items: [{ job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4` }], platforms: ["tiktok"] });
  assert.equal(over.status, 409); assert.equal(over.body.error, "over_account_limit"); assert.match(over.body.detail, /covers 1 social account and 2 are linked/);
  // one extra account bought: posting goes through, and linking offers every network again while there is room
  tables.studio_customers[0].social_extra = 1;
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [{ job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4` }], platforms: ["tiktok"] })).status, 201);
  tables.studio_customers[0].social_extra = 2; tables.studio_social_profiles[0].accounts = [{ platform: "tiktok" }];
  await s.call("POST", "/api/studio/social/connect", {});
  assert.ok(ayr.calls.filter((c) => c.path === "/profiles/link-sessions").at(-1)!.body.allowedSocial.length > 2, "room left: every network is offered");
  await s.close();
});

test("trial reels: Instagram-only trials may repeat a video up to 5 times; anything else still refuses repeats", async () => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "studio", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", ref_id: "ref-ann", accounts: [{ platform: "instagram" }, { platform: "tiktok" }], webhook_hash: "x" }], studio_jobs: [doneJob()], studio_social_posts: [] };
  const sb = fakeSb(tables);
  const ayr = fakeAyr({ "GET /user": () => ({ body: { activeSocialAccounts: ["instagram", "tiktok"], displayNames: [{ platform: "instagram", username: "ann" }, { platform: "tiktok", username: "ann" }] } }) });
  const s = await serve(sb, ayr.fetchFn);
  const item = { job_id: JOB, output_key: `${ANN}/${JOB}/1.mp4` };
  const plain = await s.call("POST", "/api/studio/social/posts", { items: [item, item], platforms: ["instagram"] });
  assert.equal(plain.body.error, "same_video_twice", "outside a trial, the same video twice is refused");
  const trial = await s.call("POST", "/api/studio/social/posts", { items: [item], platforms: ["instagram"], options: { instagram: { trial: "auto" } }, trial_copies: 3, spacing_minutes: 30 });
  assert.equal(trial.status, 201); assert.equal(trial.body.posts.length, 3, "three trial copies of one video");
  const again = await s.call("POST", "/api/studio/social/posts", { items: [item], platforms: ["instagram"], options: { instagram: { trial: "manual" } }, trial_copies: 9 });
  assert.equal(again.status, 201); assert.equal(again.body.posts.length, 5, "copies are capped at 5");
  const mixed = await s.call("POST", "/api/studio/social/posts", { items: [item], platforms: ["instagram", "tiktok"], options: { instagram: { trial: "auto" } }, trial_copies: 3 });
  assert.equal(mixed.body.error, "already_posted", "a trial with another network is a normal post: repeats refused");
  await s.close();
});

test("several accounts of one network: post to two TikToks, a repeat to the same account is refused, the other account is fine, sends count per account", async () => {
  const outputs = Array.from({ length: 3 }, (_, i) => ({ key: `${ANN}/${JOB}/${i + 1}.mp4`, kind: "video" }));
  const accs = [{ id: "tt1", platform: "tiktok", username: "ann" }, { id: "tt2", platform: "tiktok", username: "ann.clips" }, { id: "yt1", platform: "youtube", username: "ann" }];
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "studio", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, provider: "zernio", profile_key: "pk-ann", accounts: accs, webhook_hash: "x" }], studio_jobs: [doneJob({ outputs })], studio_social_posts: [] };
  const sb = fakeSb(tables);
  const sent: any[] = [];
  const provider: any = {
    name: "zernio", linking: "per_network", offered: () => ["tiktok", "youtube", "instagram"],
    accounts: async () => accs, registerWebhook: async () => undefined,
    connectUrl: async (_k: string, o: any) => { sent.push({ connect: o }); return { url: "https://link", expiresInMinutes: 30 }; },
    disconnect: async (_k: string, platform: string, id?: string) => { sent.push({ unlink: [platform, id] }); },
    publish: async (_k: string, req: any) => { sent.push(req); return { providerPostId: `pp${sent.length}`, status: "sending", results: req.accounts.map((id: string) => ({ platform: accs.find((a) => a.id === id)!.platform, account_id: id, status: "pending", url: null, error: null })), error: null }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: ANN, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: ANN }; next(); });
  registerSocial(app, () => sb, { env: { ...ENV, STUDIO_SOCIAL_DAILY_POSTS: "4" }, provider, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const item = (n: number) => ({ job_id: JOB, output_key: `${ANN}/${JOB}/${n}.mp4` });
  try {
    const both = await call("POST", "/api/studio/social/posts", { items: [item(1)], accounts: ["tt1", "tt2"] });
    assert.equal(both.status, 201, JSON.stringify(both.body));
    assert.deepEqual(sent.at(-1).accounts, ["tt1", "tt2"]); assert.deepEqual(sent.at(-1).platforms, ["tiktok"]);
    assert.deepEqual(tables.studio_social_posts[0].options.accounts.map((a: any) => [a.id, a.platform, a.username]), [["tt1", "tiktok", "ann"], ["tt2", "tiktok", "ann.clips"]]);
    const again = await call("POST", "/api/studio/social/posts", { items: [item(1)], accounts: ["tt2"] });
    assert.equal(again.body.error, "already_posted"); assert.match(again.body.detail, /@ann\.clips/);
    assert.equal((await call("POST", "/api/studio/social/posts", { items: [item(1)], accounts: ["yt1"] })).status, 201, "the same video to another account is fine");
    const gone = await call("POST", "/api/studio/social/posts", { items: [item(2)], accounts: ["tt9"] });
    assert.equal(gone.body.error, "account_not_linked");
    // 3 sends so far (two TikToks + YouTube); two more accounts is over the 4 a day
    const over = await call("POST", "/api/studio/social/posts", { items: [item(2)], accounts: ["tt1", "tt2"] });
    assert.equal(over.body.error, "daily_limit");
    // a webhook for one account merges into its own entry
    await applyEvent(sb, { providerPostId: "pp1", status: "posted", results: [{ platform: "tiktok", account_id: "tt2", status: "posted", url: "https://t/2", error: null }], error: null, partial: true });
    assert.deepEqual(tables.studio_social_posts[0].results.map((r: any) => [r.account_id, r.status]), [["tt1", "pending"], ["tt2", "posted"]]);
    // link another TikTok, relink one, unlink one
    await call("POST", "/api/studio/social/connect", { platform: "tiktok", mode: "add" });
    assert.equal(sent.at(-1).connect.add, true);
    await call("POST", "/api/studio/social/connect", { platform: "tiktok", account_id: "tt2" });
    assert.equal(sent.at(-1).connect.accountId, "tt2");
    assert.equal((await call("POST", "/api/studio/social/connect", { platform: "tiktok", account_id: "nope" })).status, 404);
    await call("DELETE", "/api/studio/social/accounts/tiktok?account=tt2");
    assert.deepEqual(sent.at(-1).unlink, ["tiktok", "tt2"]);
    // a full plan refuses adding, still relinks
    tables.studio_customers[0].plan_id = "starter";
    const full = await call("POST", "/api/studio/social/connect", { platform: "tiktok", mode: "add" });
    assert.equal(full.status, 409); assert.equal(full.body.error, "account_limit");
    assert.equal((await call("POST", "/api/studio/social/connect", { platform: "tiktok", account_id: "tt1" })).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});


test("posting groups (owner's test): Group A = IG A + TikTok A, Group B = IG B + TikTok B; each video lands only on its own group, same-network accounts are spaced, sign-offs kept; edit, retry, background batches", async () => {
  const outputs = Array.from({ length: 40 }, (_, i) => ({ key: `${ANN}/${JOB}/${i + 1}.mp4`, kind: "video" }));
  const accs = [{ id: "igA", platform: "instagram", username: "brand.a" }, { id: "ttA", platform: "tiktok", username: "brand.a" }, { id: "igB", platform: "instagram", username: "brand.b" }, { id: "ttB", platform: "tiktok", username: "brand.b" }];
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active", plan_id: "studio", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: ANN, provider: "zernio", profile_key: "pk-ann", accounts: accs, webhook_hash: "x" }], studio_jobs: [doneJob({ outputs })], studio_social_posts: [], studio_social_groups: [] };
  const sb = fakeSb(tables);
  const published: any[] = [], updated: any[] = [], retried: any[] = [];
  const provider: any = {
    name: "zernio", linking: "per_network", offered: () => ["tiktok", "youtube", "instagram"],
    accounts: async () => accs, registerWebhook: async () => undefined,
    publish: async (_k: string, req: any) => { published.push(req); return { providerPostId: `pp${published.length}`, status: req.scheduleAt ? "scheduled" : "sending", results: req.targets.map((t: any) => ({ platform: t.platform, account_id: t.accountId, status: req.scheduleAt ? "scheduled" : "pending", url: null, error: null })), error: null }; },
    update: async (_k: string, id: string, change: any) => { updated.push({ id, change }); return null; },
    retry: async (_k: string, id: string, targets: any) => { retried.push({ id, targets }); return { providerPostId: id, status: "posted", results: targets.map((t: any) => ({ platform: t.platform, account_id: t.accountId, status: "posted", url: "https://x/1", error: null })), error: null }; },
    status: async () => null, cancel: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: ANN, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: ANN }; next(); });
  registerSocial(app, () => sb, { env: { ...ENV }, provider, log: () => {} });
  registerPostGroups(app, () => sb, { log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const item = (n: number, extra: any = {}) => ({ job_id: JOB, output_key: `${ANN}/${JOB}/${n}.mp4`, ...extra });
  try {
    // groups: named, coloured, own accounts only, defaults start on (10 min apart, light rewording)
    const a = await call("POST", "/api/studio/social/groups", { name: "Group A", account_ids: ["igA", "ttA"], defaults: { caption_extra: "Link in bio · Brand A" } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([a.body.group.name, a.body.group.networks, a.body.group.defaults.stagger_minutes, a.body.group.defaults.vary_captions], ["Group A", ["instagram", "tiktok"], 10, true]);
    const b = await call("POST", "/api/studio/social/groups", { name: "Group B", account_ids: ["igB", "ttB"] });
    assert.equal(b.status, 201);
    assert.equal((await call("POST", "/api/studio/social/groups", { name: "group a", account_ids: [] })).body.error, "group_name_taken");
    assert.equal((await call("POST", "/api/studio/social/groups", { name: "X", account_ids: ["someone-else"] })).body.error, "account_not_linked");
    const A = a.body.group.id, B = b.body.group.id;
    // the owner's case: these to Group A, those to Group B, in one send
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const r = await call("POST", "/api/studio/social/posts", { caption: "New drop", schedule_at: at, spacing_minutes: 60, items: [item(1, { group_ids: [A] }), item(2, { group_ids: [A] }), item(3, { group_ids: [B] })] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(published.map((p) => p.targets.map((t: any) => t.accountId)), [["igA", "ttA"], ["igA", "ttA"], ["igB", "ttB"]], "each video lands only on its own group's accounts");
    assert.equal(published[0].targets[0].text, "New drop\n\nLink in bio · Brand A", "Group A's sign-off goes under the caption");
    assert.equal(published[2].targets[0].text ?? published[2].text, "New drop", "Group B has no sign-off: the post's own caption");
    assert.equal(published[0].targets[0].at.getTime(), published[0].targets[1].at.getTime(), "Instagram A and TikTok A go out together (different networks)");
    assert.equal(tables.studio_social_posts[0].group_id, A);
    // both groups at once: the two TikToks are 10 minutes apart, the two Instagrams too; one account is posted once
    const both = await call("POST", "/api/studio/social/posts", { caption: "Same clip", schedule_at: at, items: [item(4)], group_ids: [A, B], accounts: ["ttA"] });
    assert.equal(both.status, 201, JSON.stringify(both.body));
    const t = published.at(-1).targets;
    assert.deepEqual(t.map((x: any) => x.accountId), ["igA", "ttA", "igB", "ttB"]);
    const min = (x: any) => Math.round((x.at.getTime() - Date.parse(at)) / 60_000);
    assert.deepEqual(t.map(min), [0, 0, 10, 10], "same-network accounts 10 minutes apart; different networks together");
    assert.deepEqual(staggerTimes(new Date(0), [{ platform: "tiktok" }, { platform: "tiktok" }, { platform: "tiktok" }], 5).map((d) => d.getTime() / 60_000), [0, 5, 10]);
    // reschedule in place: every account moves by the same amount, spacing kept, the provider's post updated
    const post = tables.studio_social_posts.at(-1);
    const later = new Date(Date.parse(at) + 86400_000).toISOString();
    const ed = await call("PATCH", `/api/studio/social/posts/${post.id}`, { schedule_at: later, caption: "Same clip, new words" });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal(updated.at(-1).id, post.provider_post_id);
    assert.deepEqual(updated.at(-1).change.targets.map((x: any) => Math.round((x.at.getTime() - Date.parse(later)) / 60_000)), [0, 0, 10, 10]);
    assert.equal(updated.at(-1).change.targets[0].text, "Same clip, new words\n\nLink in bio · Brand A", "the sign-off is kept on an edited caption");
    assert.equal(tables.studio_social_posts.at(-1).schedule_at, later);
    // retry only what failed; never a send we could not confirm
    Object.assign(post, { status: "partial", results: [{ platform: "instagram", account_id: "igA", status: "posted", url: "https://x", error: null }, { platform: "tiktok", account_id: "ttA", status: "failed", url: null, error: "TikTok needs to be linked again. Relink it in Accounts, then retry." }] });
    const rt = await call("POST", `/api/studio/social/posts/${post.id}/retry`, {});
    assert.equal(rt.status, 200, JSON.stringify(rt.body));
    assert.deepEqual(retried.at(-1).targets, [{ platform: "tiktok", accountId: "ttA" }]);
    assert.equal((await call("POST", `/api/studio/social/posts/${post.id}/retry`, {})).body.error, "not_retryable", "nothing failed any more");
    // a big batch is saved as queued and sent in the background, in order
    const many = Array.from({ length: 8 }, (_, i) => item(5 + i));
    const big = await call("POST", "/api/studio/social/posts", { caption: "Batch", schedule_at: new Date(Date.now() + 2 * 86400_000).toISOString(), spacing_minutes: 180, items: many, group_ids: [B] });
    assert.equal(big.status, 201, JSON.stringify(big.body));
    assert.equal(big.body.queued, true, "16 sends: queued");
    const batch = tables.studio_social_posts.filter((x) => x.batch_id === big.body.batch_id);
    for (let i = 0; i < 50 && batch.some((x) => x.status === "queued" || x.status === "sending" && !x.provider_post_id); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(batch.every((x) => x.status === "scheduled"), JSON.stringify(batch.map((x) => x.status)));
    assert.equal(await drainBatch(sb, provider, ANN, big.body.batch_id), 0, "nothing left to send twice");
    // the accounts read: groups and today's use per account
    const st = await call("GET", "/api/studio/social");
    assert.deepEqual(st.body.groups.map((g: any) => g.name), ["Group A", "Group B"]);
    assert.equal(st.body.per_account_daily, 15);
    // per-account allowance: 16 to Group B's TikTok on one day is over 15
    const tooMany = Array.from({ length: 16 }, (_, i) => item(20 + i));
    const over = await call("POST", "/api/studio/social/posts", { caption: "x", schedule_at: new Date(Date.now() + 5 * 86400_000).toISOString(), spacing_minutes: 1, items: tooMany, accounts: ["ttB"] });
    assert.equal(over.body.error, "daily_limit"); assert.match(over.body.detail, /@brand\.b on Tiktok .*limit of 15 a day/);
    // editing a group never moves posts already scheduled; deleting it keeps them
    await call("PATCH", `/api/studio/social/groups/${A}`, { remove_account: "ttA" });
    assert.deepEqual(tables.studio_social_posts[0].options.accounts.map((x: any) => x.id), ["igA", "ttA"]);
    assert.equal((await call("DELETE", `/api/studio/social/groups/${B}`)).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test("media check: the posting service's size limits per network, read as 'too large for'", async () => {
  const { readMediaCheck } = await import("../src/studio-post-uploads.js");
  const r = readMediaCheck("a1", { valid: true, size: 400_000_000, format: "mp4", platformLimits: { tiktok: { limit: 4_000_000_000, withinLimit: true }, instagram: { limit: 300_000_000, withinLimit: false }, bluesky: { limit: 50_000_000 } } });
  assert.deepEqual(r.over.map((x: any) => x.platform), ["instagram", "bluesky"]);
  assert.equal(r.ok, true); assert.equal(r.format, "mp4");
  assert.equal(readMediaCheck("a2", { valid: false, code: "MEDIA_UNDECODABLE" }).error, "MEDIA_UNDECODABLE");
});

test("captions v2: the voice comes from the person's best posts (against their own median), each hashtag carries its record, generic tags are dropped", async () => {
  const { captionContext, cleanTags } = await import("../src/studio-captions.js");
  const now = Date.now(), d = (n: number) => new Date(now - n * 86400_000).toISOString();
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({ platform: "tiktok", account_key: "a", caption: `normal day ${i} #kitkat #snacks?`, views: 1000, comments: 5, published_at: d(i + 1) })),
    { platform: "tiktok", account_key: "a", caption: "japan has 300 kitkat flavours #kitkat #japan", views: 9000, comments: 10, published_at: d(8) },
    { platform: "tiktok", account_key: "a", caption: "the wasabi one #kitkat #japan", views: 6000, comments: 8, published_at: d(9) },
    { platform: "tiktok", account_key: "a", caption: "matcha ranking #japan #snacks", views: 5000, comments: 4, published_at: d(10) },
  ];
  const sb: any = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) };
  const ctx = await captionContext(sb, "u1", ["tiktok"]);
  assert.ok(ctx.voice[0].startsWith("japan has 300"), "the best post first");
  const japan = ctx.tags.find((t) => t.tag === "#japan")!, snacks = ctx.tags.find((t) => t.tag === "#snacks")!;
  assert.ok(japan.multiple! > snacks.multiple!, "#japan sits on their best posts");
  assert.deepEqual(cleanTags(["fyp", "#Viral", "kitkat japan", "#kitkat", "#kitkat", "a", "b", "c", "d"], "instagram"), ["#kitkatjapan", "#kitkat", "#a", "#b", "#c"], "no generic tags, no spaces, no repeats, 5 at most");
});
