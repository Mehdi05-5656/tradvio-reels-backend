import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerClientOrgRoutes, sha256Hex, newInviteToken, INVITE_TOKEN_RE, inviteUrl, inviteStatus, slugify, maskEmail, parseProfile, parseLearning, withRenewal, addMonths, renewalDays, parseLogo, ensureRenewalAlerts } from "../src/client-orgs.js";
import { accountAccess } from "../src/account-access.js";
import { filterVisibleSlots } from "../src/auth.js";

const OPERATOR = "71c2308a-9e23-4458-b4f0-df7ae53c841e";
const CLIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("invite helpers: tokens are URL-safe and hashed, links use the fragment, status and masking", () => {
  const token = newInviteToken();
  assert.match(token, INVITE_TOKEN_RE);
  assert.match(sha256Hex(token), /^[a-f0-9]{64}$/);
  assert.notEqual(sha256Hex(token), sha256Hex(newInviteToken()));
  assert.equal(inviteUrl("abc", {}), "https://tradvio-reels.vercel.app/#invite/abc");
  assert.equal(inviteUrl("abc", { DASHBOARD_URL: "https://app.clone8.io/" }), "https://app.clone8.io/#invite/abc");
  const now = Date.parse("2026-10-24T20:00:00Z");
  assert.equal(inviteStatus({ expires_at: "2026-10-31T00:00:00Z", accepted_at: null, revoked_at: null }, now), "valid");
  assert.equal(inviteStatus({ expires_at: "2026-10-20T00:00:00Z", accepted_at: null, revoked_at: null }, now), "expired");
  assert.equal(inviteStatus({ expires_at: "2026-10-31T00:00:00Z", accepted_at: "2026-10-22T00:00:00Z", revoked_at: null }, now), "used");
  assert.equal(inviteStatus({ expires_at: "2026-10-31T00:00:00Z", accepted_at: "2026-10-22T00:00:00Z", revoked_at: "2026-10-23T00:00:00Z" }, now), "revoked");
  assert.equal(slugify("Tradvio  Trading Co."), "tradvio-trading-co");
  assert.equal(slugify("  Éclair & Sons!  "), "eclair-sons");
  assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  assert.equal(maskEmail(null), null);
});

test("organization membership grants read visibility without changing ownership", () => {
  const slots = [{ phone_slot: "a", owner_user_id: OPERATOR }, { phone_slot: "b", owner_user_id: OPERATOR }, { phone_slot: "c", owner_user_id: CLIENT }];
  const req: any = { auth: { user_id: CLIENT }, profile: { role: "user", user_id: CLIENT }, orgSlots: new Set(["a"]) };
  assert.deepEqual(filterVisibleSlots(req, slots).map((s) => s.phone_slot), ["a", "c"]);
  assert.deepEqual(filterVisibleSlots({ auth: { user_id: CLIENT }, profile: { role: "user" } } as any, slots).map((s) => s.phone_slot), ["c"]);
  assert.deepEqual(filterVisibleSlots({ auth: { user_id: CLIENT }, profile: { role: "admin" } } as any, slots).length, 3);
});

// A small in-memory Supabase stand-in: filters by eq/in/is, records writes, answers rpc.
function fakeSb(tables: Record<string, any[]>, rpc: (name: string, args: any) => { data: any; error: any }) {
  const writes: any[] = [];
  const sb: any = {
    writes,
    rpc: async (name: string, args: any) => rpc(name, args),
    from(table: string) {
      let rows = () => tables[table] ?? [];
      const filters: ((r: any) => boolean)[] = [];
      let single = false, maybe = false, pending: any = null;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        is(k: string, v: any) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { table, op: "insert", v }; rows = () => (Array.isArray(v) ? v : [v]).map((x: any) => ({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...x })); return q; },
        update(v: any) { pending = { table, op: "update", v }; return q; },
        delete() { pending = { table, op: "delete" }; return q; },
        then(resolve: any, reject: any) {
          if (pending) writes.push({ ...pending, filters: filters.length });
          const out = rows().filter((r) => filters.every((f) => f(r)));
          const data = single || maybe ? (out[0] ?? null) : out;
          const error = single && !out.length ? { message: "no rows" } : null;
          return Promise.resolve({ data, error }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return sb;
}

async function serve(sb: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const u = req.headers["x-test-user"];
    if (u) { req.auth = { user_id: u }; req.profile = { role: req.headers["x-test-role"] ?? "user", user_id: u }; if (req.headers["x-test-org-slots"]) req.orgSlots = new Set(String(req.headers["x-test-org-slots"]).split(",")); }
    next();
  });
  app.use(accountAccess(() => sb));
  registerClientOrgRoutes(app, () => sb);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const token = newInviteToken();
const baseTables = () => ({
  client_orgs: [{ id: ORG, name: "Tradvio", slug: "tradvio", created_at: "2026-10-24T00:00:00Z", archived_at: null }],
  client_org_members: [], client_org_accounts: [],
  client_invites: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", org_id: ORG, token_hash: sha256Hex(token), email: "jane@example.com", created_at: "2026-10-24T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", accepted_at: null, accepted_by: null, revoked_at: null }],
  publer_slot_config: [{ phone_slot: "phone_a", handle: "tradvio", provider: "instagram", paused: false, owner_user_id: OPERATOR, publer_account_id: "x", daily_target: 8 }],
  profiles: [],
});

test("operator console is admin-read, operator-write; clients and anonymous callers are refused", async (t) => {
  const sb = fakeSb(baseTables(), () => ({ data: null, error: null }));
  const s = await serve(sb); t.after(s.close);
  assert.equal((await s.call("GET", "/api/ops/clients")).status, 401);
  assert.equal((await s.call("GET", "/api/ops/clients", { "x-test-user": CLIENT })).status, 403);
  assert.equal((await s.call("POST", "/api/ops/clients", { "x-test-user": CLIENT }, { name: "Evil" })).status, 403);
  const list = await s.call("GET", "/api/ops/clients", { "x-test-user": OPERATOR, "x-test-role": "admin" });
  assert.equal(list.status, 200);
  assert.equal(list.body.clients[0].slug, "tradvio");
  assert.equal(list.body.clients[0].invites[0].status, "valid");
  assert.equal("token_hash" in list.body.clients[0].invites[0], false, "hashes never leave the server");
  assert.equal(list.body.accounts[0].handle, "tradvio");
  const created = await s.call("POST", "/api/ops/clients", { "x-test-user": OPERATOR, "x-test-role": "admin" }, { name: "Acme Trading" });
  assert.equal(created.status, 201);
  assert.equal(created.body.client.slug, "acme-trading");
  assert.equal((await s.call("POST", "/api/ops/clients", { "x-test-user": OPERATOR, "x-test-role": "admin" }, { name: "" })).status, 400);
  const inv = await s.call("POST", `/api/ops/clients/${ORG}/invites`, { "x-test-user": OPERATOR, "x-test-role": "admin" }, { email: "Bob@Example.com", expires_in_days: 3 });
  assert.equal(inv.status, 201);
  assert.match(inv.body.invite_url, /^https:\/\/.+\/#invite\/[A-Za-z0-9_-]{43}$/);
  const stored = sb.writes.find((w: any) => w.table === "client_invites" && w.op === "insert");
  assert.equal(stored.v.email, "bob@example.com");
  assert.match(stored.v.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(inv.body.invite_url.includes(stored.v.token_hash), false);
  assert.equal((await s.call("POST", `/api/ops/clients/${ORG}/accounts`, { "x-test-user": OPERATOR, "x-test-role": "admin" }, { phone_slots: ["phone_a", "nope"] })).status, 400);
  const assigned = await s.call("POST", `/api/ops/clients/${ORG}/accounts`, { "x-test-user": OPERATOR, "x-test-role": "admin" }, { phone_slots: ["phone_a"] });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.added, ["phone_a"]);
});

test("invite preview is public but reveals only the organization; accepting needs a signed-in user", async (t) => {
  const calls: any[] = [];
  const sb = fakeSb(baseTables(), (name, args) => { calls.push({ name, args }); return { data: { org_id: ORG, org_name: "Tradvio", slug: "tradvio", already_member: false }, error: null }; });
  const s = await serve(sb); t.after(s.close);
  const preview = await s.call("GET", `/api/invites/${token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, { org_name: "Tradvio", status: "valid", expires_at: "2099-01-01T00:00:00Z", email_hint: "j***@example.com" });
  assert.equal((await s.call("GET", `/api/invites/${newInviteToken()}`)).status, 404);
  assert.equal((await s.call("GET", "/api/invites/short")).status, 404);
  assert.equal((await s.call("POST", `/api/invites/${token}/accept`)).status, 401);
  const joined = await s.call("POST", `/api/invites/${token}/accept`, { "x-test-user": CLIENT });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.joined.org_name, "Tradvio");
  assert.deepEqual(calls[0], { name: "client_accept_invite", args: { p_user: CLIENT, p_token_hash: sha256Hex(token) } });
  // Database verdicts map to clear statuses.
  for (const [code, status] of [["invite_expired", 410], ["invite_used", 409], ["invite_email_mismatch", 403], ["invite_invalid", 404]] as const) {
    const sb2 = fakeSb(baseTables(), () => ({ data: null, error: { message: `ERROR: ${code}` } }));
    const s2 = await serve(sb2);
    const r = await s2.call("POST", `/api/invites/${token}/accept`, { "x-test-user": CLIENT });
    await s2.close();
    assert.equal(r.status, status, code);
    assert.equal(r.body.error, code);
  }
  // A client with organization visibility can read a slot route the gate used to refuse.
  assert.equal((await s.call("GET", "/api/publer/timeline/phone_a", { "x-test-user": CLIENT })).status, 403);
  const viaOrg = await s.call("GET", "/api/publer/timeline/phone_a", { "x-test-user": CLIENT, "x-test-org-slots": "phone_a" });
  assert.notEqual(viaOrg.status, 403);
});

test("client profile: fields are validated and trimmed, blanks clear, renewal follows signed date plus term", () => {
  const ok = parseProfile({ description: "  Trading education brand ", website: "tradvio.com", contact_email: "ops@tradvio.com", contract_value: "$12,000 / month", signed_at: "2026-10-01", term_months: "12", notes: "", unknown: "x" });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.patch, { description: "Trading education brand", website: "tradvio.com", contact_email: "ops@tradvio.com", contract_value: "$12,000 / month", notes: null, signed_at: "2026-10-01", term_months: 12 });
  assert.deepEqual(withRenewal(ok.patch).renews_at, "2027-10-01");
  assert.equal(parseProfile({ contact_email: "not-an-email" }).error, "invalid_contact_email");
  assert.equal(parseProfile({ signed_at: "2026-02-30" }).error, "invalid_signed_at");
  assert.equal(parseProfile({ term_months: 0 }).error, "invalid_term_months");
  assert.equal(parseProfile({ description: "x".repeat(2001) }).error, "invalid_description");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-10-26", 6), "2027-04-26");
  // A partial patch keeps the row's other half of the equation; an explicit date wins; clearing a half clears the date.
  assert.equal(withRenewal({ term_months: 6 }, { signed_at: "2026-10-01", term_months: 12 }).renews_at, "2027-04-01");
  assert.equal(withRenewal({ renews_at: "2027-01-15", term_months: 12 }, { signed_at: "2026-10-01" }).renews_at, "2027-01-15");
  assert.equal(withRenewal({ signed_at: null }, { signed_at: "2026-10-01", term_months: 12 }).renews_at, null);
  assert.equal(withRenewal({ description: "x" }, { signed_at: "2026-10-01", term_months: 12 }).renews_at, undefined);
  const now = new Date("2026-10-26T09:00:00Z");
  assert.equal(renewalDays("2026-11-25", now), 30); assert.equal(renewalDays("2026-10-26", now), 0); assert.equal(renewalDays("2026-10-20", now), -6); assert.equal(renewalDays(null, now), null);
  const png = "data:image/png;base64," + Buffer.from("\x89PNG fake").toString("base64");
  assert.equal(parseLogo(png)?.mime, "image/png");
  assert.equal(parseLogo("data:image/gif;base64,R0lGODlh"), null);
  assert.equal(parseLogo("data:image/png;base64," + "A".repeat(600 * 1024)), null);
});

test("renewal alerts: one per client per renewal date inside the 30-day window, never duplicated, overdue is critical", async () => {
  const now = new Date("2026-10-26T09:00:00Z");
  const orgs = [
    { id: "o1", name: "Acme", slug: "acme", renews_at: "2026-11-10", contract_value: "$8k / mo" },
    { id: "o2", name: "Far", slug: "far", renews_at: "2027-06-01", contract_value: null },
    { id: "o3", name: "Late", slug: "late", renews_at: "2026-10-20", contract_value: null },
    { id: "o4", name: "Seen", slug: "seen", renews_at: "2026-11-01", contract_value: null },
  ];
  const inserted: any[] = [];
  const sb: any = { from(table: string) {
    const q: any = { select() { return q }, is() { return q }, not() { return q }, eq() { return q }, in() { return q },
      then(res: any) { return Promise.resolve(table === "client_orgs" ? { data: orgs, error: null } : { data: [{ payload: { org_id: "o4", renews_at: "2026-11-01" } }], error: null }).then(res) },
      insert(rows: any[]) { inserted.push(...rows); return Promise.resolve({ error: null }) } };
    return q; } };
  assert.equal(await ensureRenewalAlerts(sb, now), 2);
  assert.deepEqual(inserted.map((r) => [r.payload.org_id, r.severity, r.title]), [["o1", "info", "Acme renews in 15 days"], ["o3", "critical", "Late: renewal overdue by 6 days"]]);
  assert.match(inserted[0].body, /Signed for \$8k \/ mo/);
});


test("parseLearning: brand, niche, voice trimmed; hashtags as list or text, # stripped, de-duplicated, validated", () => {
  const ok = parseLearning({ brand: " @acme ", niche: "options education", voice: "calm, precise", hashtags: "#Options, trading  #Trading options" });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.value, { brand: "@acme", niche: "options education", voice: "calm, precise", hashtags: ["Options", "trading"] });
  assert.deepEqual(parseLearning({ hashtags: ["A", "a", "#B"] }).value.hashtags, ["A", "B"]);
  assert.equal(parseLearning({ hashtags: ["bad tag!"] }).error, "invalid_learning_hashtags");
  assert.equal(parseLearning("nope").error, "invalid_learning");
  assert.deepEqual(parseLearning(null).value, {});
  assert.deepEqual(parseLearning({ optimize: true, exploration_share: "0.3", retire_after_posts: 8, retire_below_pct: 20, winner_weight: 0.9 }).value, { optimize: true, exploration_share: 0.3, retire_after_posts: 8, retire_below_pct: 20, winner_weight: 0.9 });
  assert.equal(parseLearning({ optimize: "yes" }).error, "invalid_learning_optimize");
  assert.equal(parseLearning({ exploration_share: 0.9 }).error, "invalid_learning_exploration_share");
  assert.equal(parseLearning({ retire_after_posts: 2.5 }).error, "invalid_learning_retire_after_posts");
  assert.deepEqual(parseProfile({ learning: { niche: "x" } }).patch, { learning: { niche: "x" } });
  assert.deepEqual(parseProfile({ learning: { hashtags: ["#"] } }).patch.learning, { hashtags: [] });
});
