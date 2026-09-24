import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerAccountInventory } from "../src/account-inventory.js";
import { accountAccess } from "../src/account-access.js";
import { registerCreatorVaultRoutes } from "../src/creatorvault.js";

function database() {
  const tables: Record<string, any[]> = {
    publer_config: [{ id: "main", workspace_id: "w", timezone: "America/Los_Angeles", slot_times: ["08:00", "10:00"], jitter_minutes: 0 }],
    profiles: [
      { user_id: "a", external_user_id: "ext-a", display_name: "Owner A" },
      { user_id: "b", external_user_id: "ext-b", display_name: "Owner B" },
    ],
    publer_slot_config: [
      { phone_slot: "slot-a", owner_user_id: "a", handle: "alpha", provider: "instagram", publer_account_id: "p-a", daily_target: 2, paused: false },
      { phone_slot: "slot-b", owner_user_id: "b", handle: "beta", provider: "instagram", publer_account_id: "p-b", daily_target: 2, paused: true },
      { phone_slot: "slot-unowned", owner_user_id: null, handle: "unowned", provider: "tiktok", publer_account_id: "p-c", daily_target: 2, paused: false },
    ],
    creatorvault_accounts: [
      { cv_account_id: "cv-a", external_user_id: "ext-a", platform: "instagram", platform_handle: "alpha", is_active: true, local_phone_slot: "slot-b", access_token: "NEVER_SEND" },
      { cv_account_id: "cv-b", external_user_id: "ext-b", platform: "instagram", platform_handle: "second", is_active: false },
    ],
    publer_publish_log: [
      { id: 1, phone_slot: "slot-a", status: "published", slot_index: 0, slot_local_date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), attempted_at: new Date().toISOString() },
    ],
    reels_manual_queue: [{ id: "q-a", phone_slot: "slot-a", status: "pending" }, { id: "q-b", phone_slot: "slot-b", status: "pending" }],
    leader_accounts: [{ id: "l", handle: "research-only", provider: "instagram", active: true }],
    reels_source_accounts: [{ handle: "source-only", active: true }],
  };
  const db: any = { tables, fail: "", calls: [] as string[], from(table: string) {
    db.calls.push(table);
    const filters: any[] = [];
    let cols = "*", start = 0, end = Infinity, single = false, opts: any = {};
    const q: any = {
      select(c: string, o = {}) { cols = c; opts = o; return q; },
      eq(k: string, v: any) { filters.push((r: any) => r[k] === v); return q; },
      order() { return q; },
      range(a: number, b: number) { start = a; end = b; return q; },
      limit(n: number) { end = n - 1; return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          if (db.fail === table) return { error: { message: "private_database_error" }, data: null };
          const all = (tables[table] || []).filter(r => filters.every(f => f(r)));
          const rows = all.slice(start, end + 1).map(r => cols === "*" ? r : Object.fromEntries(cols.split(",").map(k => k.trim()).filter(k => k in r).map(k => [k, r[k]])));
          return { data: opts.head ? null : single ? rows[0] ?? null : rows, count: all.length, error: null };
        }).then(resolve, reject);
      },
    };
    return q;
  }};
  return db;
}
async function setup(t: any, opts: { providerFails?: boolean } = {}) {
  const db = database();
  let providerCalls = 0;
  const app = express();
  // Test-only identities, not an authentication mechanism in application code.
  app.use((req: any, _res, next) => {
    const who = req.header("test-identity");
    const uid = who === "operator" ? "71c2308a-9e23-4458-b4f0-df7ae53c841e" : who;
    req.auth = who === "shared-secret" ? { admin_secret: true } : who ? { user_id: uid } : null;
    req.profile = who && who !== "no-profile" ? {
      user_id: uid, external_user_id: `ext-${who}`, role: ["admin", "operator"].includes(who) ? "admin" : "user",
    } : null;
    next();
  });
  app.use(accountAccess(() => db));
  registerAccountInventory(app, () => db, async () => {
    providerCalls++;
    if (opts.providerFails) throw new Error("secret provider payload");
    return [
      { id: "p-a", name: "alpha", provider: "instagram", type: "instagram" },
      { id: "p-b", name: "beta", provider: "instagram", type: "instagram" },
      { id: "unmapped", name: "unmapped", provider: "tiktok", type: "tiktok" },
    ];
  });
  registerCreatorVaultRoutes(app, () => db);
  app.all("*", (_req, res) => res.json({ passed: true }));
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { db, providerCalls: () => providerCalls, async get(path = "/api/v2/accounts", who = "admin", method = "GET") {
    const r = await fetch(base + path, { method, headers: who ? { "test-identity": who } : {} });
    return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
  }};
}

test("admin inventory includes both profiles, every provider and unmapped accounts", async t => {
  const s = await setup(t); const r = await s.get();
  assert.equal(r.status, 200); assert.equal(r.body.scope, "all_profiles");
  assert.equal(r.body.accounts.length, 6); assert.equal(r.body.monitored.length, 2);
  assert.equal(r.cache, "private, no-store");
  assert.ok(r.body.accounts.some((a: any) => a.owner?.label === "Owner B"));
  assert.ok(r.body.accounts.find((a: any) => a.id === "creatorvault:cv-a").issue.includes("does not match"));
  assert.equal(r.body.accounts.find((a: any) => a.id === "publer:slot-unowned").connection, "missing");
  assert.ok(!JSON.stringify(r.body).includes("NEVER_SEND"));
});
test("ordinary user sees only owned slots and their external profile; forged filters do not expand scope", async t => {
  const s = await setup(t);
  const r = await s.get("/api/v2/accounts?external_user_id=ext-b&owner_user_id=b&role=admin&scope=all_profiles", "a");
  assert.equal(r.body.scope, "own_profile"); assert.equal(r.body.accounts.length, 2);
  assert.deepEqual(r.body.monitored, []);
  assert.ok(r.body.accounts.every((a: any) => a.owner === undefined));
  assert.ok(!JSON.stringify(r.body).includes("second"));
  assert.ok(!s.db.calls.includes("profiles"));
  assert.ok(!s.db.calls.includes("leader_accounts"));
});
test("unassigned new user receives an empty inventory, not admin defaults", async t => {
  const s = await setup(t); const r = await s.get("/api/v2/accounts", "new");
  assert.equal(r.status, 200); assert.deepEqual(r.body.accounts, []); assert.deepEqual(r.body.monitored, []);
});
test("anonymous and missing-profile requests fail before database/provider reads", async t => {
  const s = await setup(t);
  assert.equal((await s.get("/api/v2/accounts", "")).status, 401);
  assert.equal((await s.get("/api/v2/accounts", "no-profile")).status, 403);
  assert.equal(s.db.calls.length, 0); assert.equal(s.providerCalls(), 0);
});
test("database failures are explicit and do not expose raw error details", async t => {
  const s = await setup(t); s.db.fail = "creatorvault_accounts";
  const r = await s.get(); assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes("private_database_error"));
});
test("provider check failure keeps stored accounts but never invents healthy authorization", async t => {
  const s = await setup(t, { providerFails: true }); const r = await s.get();
  assert.equal(r.body.provider_check, "unavailable");
  assert.ok(r.body.accounts.filter((a: any) => a.source === "Publer").every((a: any) => a.connection === "unverified"));
  assert.ok(!JSON.stringify(r.body).includes("secret provider payload"));
});
test("inventory paginates past 500 connections without a silent cap", async t => {
  const s = await setup(t);
  s.db.tables.creatorvault_accounts = Array.from({ length: 502 }, (_, i) => ({ cv_account_id: `cv-${i}`, external_user_id: "ext-a" }));
  const r = await s.get("/api/v2/accounts", "a");
  assert.equal(r.body.accounts.length, 503);
});
test("legacy reads require ownership; IDs and slot parameters cannot bypass isolation", async t => {
  const s = await setup(t);
  for (const path of ["/api/queue/slot-b", "/api/next/slot-b", "/api/publer/timeline/slot-b", "/api/signed/q-b", "/api/publer/config", "/api/summary", "/api/creatorvault/status"]) {
    assert.equal((await s.get(path, "a")).status, 403, path);
    assert.equal((await s.get(path, "")).status, 401, path);
    assert.equal((await s.get(path, "admin")).status, 200, path);
  }
  for (const path of ["/api/queue/slot-a", "/api/next/slot-a", "/api/publer/timeline/slot-a", "/api/signed/q-a"]) {
    assert.equal((await s.get(path, "a")).status, 200, path);
  }
});
test("global write controls reject ordinary users", async t => {
  const s = await setup(t);
  for (const path of ["/api/v2/devices/other", "/api/v2/alerts/dismiss-all", "/api/publer/reconcile", "/api/publer/publish-now/slot-b", "/api/creatorvault/sync/accounts"]) {
    assert.equal((await s.get(path, "a", "POST")).status, 403, path);
  }
  assert.equal((await s.get("/api/publer/slot/slot-a", "a", "POST")).status, 403);
  assert.equal((await s.get("/api/publer/slot/slot-b", "a", "POST")).status, 403);
});
test("managed customers cannot change even their own content, schedule or onboarding", async t => {
  const s = await setup(t);
  const paths = [
    "/api/publer/slot/slot-a",
    "/api/publer/publish-now/slot-a",
    "/api/v2/templates/slot-a",
    "/api/v2/queue-suggestions/q-a/accept",
    "/api/v2/queue-suggestions/q-a/reject",
    "/api/onboard/retry",
    "/api/onboard/enqueue",
    "/api/creatorvault/bridge/oauth/start",
    "/api/reels/schedule",
    "/api/reels/upload-url",
    "/api/reels/sign-storage",
    "/api/archive/q-a",
    "/api/undo/q-a",
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of paths) {
      const r = await s.get(`${path}?role=admin&owner_user_id=a`, "a", method);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  }
  assert.equal(s.db.calls.length, 0, "no writes or ownership/provider lookups for denied mutations");
  assert.equal(s.providerCalls(), 0);
});
test("read-only policy leaves owned reads, operator operations and signed webhook dispatch intact", async t => {
  const s = await setup(t);
  assert.equal((await s.get("/api/queue/slot-a", "a")).status, 200);
  assert.equal((await s.get("/api/queue/slot-b", "a")).status, 403);
  assert.equal((await s.get("/api/publer/slot/slot-a", "operator", "POST")).status, 200);
  // The real webhook handler still verifies its HMAC; access middleware must
  // not replace that with a requirement for an interactive customer login.
  const middleware = accountAccess(() => s.db);
  let continued = false;
  await middleware({ path: "/api/creatorvault/webhook", method: "POST", auth: null } as any,
    { status() { throw new Error("webhook must reach signature verification"); } } as any,
    () => { continued = true; });
  assert.equal(continued, true);
});
test("non-operator administrators retain inventory visibility but cannot mutate any account", async t => {
  const s = await setup(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/publer/slot/slot-a", "/api/publer/publish-now/slot-b", "/api/admin/accounts/assign", "/api/onboard/enqueue"]) {
      assert.equal((await s.get(`${path}?email=support@tradvio.com&role=admin`, "admin", method)).status, 403);
    }
  }
  assert.equal(s.db.calls.length, 0);
  assert.equal(s.providerCalls(), 0);
  assert.equal((await s.get()).body.scope, "all_profiles");
});
test("legacy shared secret cannot grant human operator mutation authority", async t => {
  const s = await setup(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await s.get("/api/publer/slot/slot-a", "shared-secret", method)).status, 403);
  }
  assert.equal(s.db.calls.length, 0);
  assert.equal(s.providerCalls(), 0);
});
test("operator authorization requires the selected subject and matching server administrator profile", async () => {
  const uid = "71c2308a-9e23-4458-b4f0-df7ae53c841e";
  const cases = [
    { auth: { user_id: uid }, profile: { user_id: uid, role: "admin" }, expected: true },
    { auth: { user_id: uid, email: "changed@example.test" }, profile: { user_id: uid, role: "admin" }, expected: true },
    { auth: { user_id: uid }, profile: null, expected: false },
    { auth: { user_id: uid }, profile: { user_id: "other", role: "admin" }, expected: false },
    { auth: { user_id: uid }, profile: { user_id: uid, role: "user" }, expected: false },
    { auth: { user_id: "other", email: "support@tradvio.com" }, profile: { user_id: "other", role: "admin" }, expected: false },
    { auth: { admin_secret: true }, profile: { user_id: uid, role: "admin" }, expected: false },
    { auth: null, profile: { user_id: uid, role: "admin" }, expected: false },
  ];
  for (const c of cases) {
    let continued = false;
    let status = 0;
    const middleware = accountAccess(() => { throw new Error("authorization must not query data"); });
    const res: any = { status(n: number) { status = n; return res; }, json() { return res; } };
    await middleware({ path: "/api/admin/accounts/assign", method: "POST", auth: c.auth, profile: c.profile } as any,
      res, () => { continued = true; });
    assert.equal(continued, c.expected, JSON.stringify(c));
    if (!c.expected) assert.equal(status, c.auth ? 403 : 401);
  }
});
test("ownership lookup failure denies the request instead of allowing it", async t => {
  const s = await setup(t); s.db.fail = "publer_slot_config";
  assert.equal((await s.get("/api/queue/slot-a", "a")).status, 503);
});
test("connection-status lookup does not reveal another user's handle", async t => {
  const s = await setup(t);
  const foreign = await s.get("/api/creatorvault/account-status?cv_account_id=cv-b", "a");
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign.body, { status: "other_user" });
  const own = await s.get("/api/creatorvault/account-status?cv_account_id=cv-a", "a");
  assert.equal(own.body.platform_handle, "alpha");
  const admin = await s.get("/api/creatorvault/account-status?cv_account_id=cv-b", "admin");
  assert.equal(admin.body.platform_handle, "second");
});
test("held submissions from previous days remain visible without counting failed retries as posts", async t => {
  const s = await setup(t);
  const today = s.db.tables.publer_publish_log[0];
  s.db.tables.publer_publish_log.push(
    { ...today, id: 2, status: "failed" },
    { ...today, id: 3, status: "published" },
    { ...today, id: 4, status: "pending", attempted_at: "2026-01-01T00:00:00Z", slot_local_date: "2026-01-01" },
  );
  const r = await s.get("/api/v2/accounts", "a");
  const slot = r.body.accounts.find((a: any) => a.id === "publer:slot-a");
  assert.equal(slot.published_today, 1);
  assert.equal(slot.held_count, 1);
  assert.match(slot.issue, /needs review/);
});
