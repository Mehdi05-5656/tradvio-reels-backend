import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { ayrshareProvider, friendlyError, statusOf, verifySignature } from "../src/social-ayrshare.js";
import { getSocialProvider } from "../src/social-provider.js";
import { registerSocial, socialTick, webhookUrl, cleanOptions } from "../src/studio-social.js";
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
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        not(k: string, _op: string, _v: any) { filters.push((r) => r[k] != null); return q; },
        or(expr: string) { const lt = expr.match(/schedule_at\.lt\.(.+)$/)?.[1]; filters.push((r) => r.schedule_at == null || (lt ? r.schedule_at < lt : false)); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { op: "insert", v }; return q; },
        update(v: any) { pending = { op: "update", v }; return q; },
        then(resolve: any, reject: any) {
          if (pending?.op === "insert") {
            if (table === "studio_social_profiles" && (tables[table] ?? []).some((r) => r.user_id === pending.v.user_id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }).then(resolve, reject);
            const v = { id: `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`, created_at: new Date().toISOString(), updated_at: "2000-01-01T00:00:00Z", results: [], error: null, provider_post_id: null, accounts: [], webhook_registered_at: null, ...pending.v };
            (tables[table] ??= []).push(v); rows = () => [v];
          }
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
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, status: "active" }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", ref_id: "ref-ann", accounts: [{ platform: "tiktok" }, { platform: "youtube" }], webhook_registered_at: "2026-10-30T00:00:00Z" }], studio_jobs: [doneJob(), { ...doneJob(), id: "44444444-4444-4444-8444-444444444444", user_id: BOB }], studio_social_posts: [] };
  const sb = fakeSb(tables), ayr = fakeAyr();
  const s = await serve(sb, ayr.fetchFn);
  const item = (n: number, job = JOB) => ({ job_id: job, output_key: `${ANN}/${JOB}/${n}.mp4` });

  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["instagram"], caption: "x" })).body.error, "platform_not_linked");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1, "44444444-4444-4444-8444-444444444444")], platforms: ["tiktok"], caption: "x" })).body.error, "video_not_found", "someone else's job is not found");
  assert.equal((await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok"], schedule_at: new Date(Date.now() + 40 * 86400_000).toISOString() })).body.error, "too_late");

  const now = await s.call("POST", "/api/studio/social/posts", { items: [item(1)], platforms: ["tiktok", "youtube"], caption: "Launch day\n#clone8" });
  assert.equal(now.status, 201);
  assert.equal(now.body.posts[0].status, "sending");
  const sent = ayr.calls.filter((c) => c.path === "/post").at(-1)!;
  assert.equal(sent.headers["Profile-Key"], "pk-ann");
  assert.equal(sent.body.youTubeOptions.title, "Launch day");
  assert.equal(sent.body.idempotencyKey, tables.studio_social_posts[0].id);
  assert.ok(sb.signed.at(-1).ttl >= 7 * 86400, "the video link outlives the provider's 7-day ask");

  const at = new Date(Date.now() + 2 * 3600_000);
  const sch = await s.call("POST", "/api/studio/social/posts", { items: [item(1), item(2)], platforms: ["tiktok"], caption: "", schedule_at: at.toISOString(), spacing_minutes: 180 });
  assert.deepEqual(sch.body.posts.map((p: any) => p.status), ["scheduled", "scheduled"]);
  const dates = ayr.calls.filter((c) => c.path === "/post").slice(-2).map((c) => Date.parse(c.body.scheduleDate));
  assert.equal(dates[1] - dates[0], 180 * 60_000);

  const posted = tables.studio_social_posts.find((p) => p.status === "sending")!;
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
  assert.equal(list.body.posts[0].poster_url.endsWith(".jpg"), true);
  await s.close();
});

test("tick: reads back sends and overdue schedules the webhook did not settle", async () => {
  const old = new Date(Date.now() - 3600_000).toISOString();
  const tables: Record<string, any[]> = { studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann" }], studio_social_posts: [
    { id: "p1", user_id: ANN, provider_post_id: "post-1", status: "sending", schedule_at: null, updated_at: old },
    { id: "p2", user_id: ANN, provider_post_id: "post-2", status: "scheduled", schedule_at: new Date(Date.now() + 86400_000).toISOString(), updated_at: old },
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
  for (let i = 0; i < 30; i++) assert.equal(allowCaption("rate-user", t0 + i), true);
  assert.equal(allowCaption("rate-user", t0 + 31), false);
  assert.equal(allowCaption("rate-user", t0 + 3600_001 + 31), true, "the hour rolls over");
});
