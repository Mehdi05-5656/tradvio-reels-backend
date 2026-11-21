import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AddressInfo } from "node:net";
import { normalizeCode, codeFromName, deviceOf, canCredit, clickInput, summarizeAffiliates, creditAffiliate, registerAffiliates, affiliateLink, CLAIM_WINDOW_MS, type LinkRow, type ClickRow, type PersonRow } from "../src/studio-affiliates.js";
import { sanitizeAnswers } from "../src/studio-onboarding.js";
import { clearAdminCacheForTests } from "../src/studio-admin-auth.js";
import { selfAuthenticatedPost } from "../src/account-access.js";

const NOW = Date.parse("2026-11-21T20:00:00Z");
const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const OWNER = "11111111-1111-4111-8111-111111111111", NEWBIE = "22222222-2222-4222-8222-222222222222", OLDIE = "33333333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------- a small stand-in for the Supabase client
type Row = Record<string, any>;
function fakeSb(tables: Record<string, Row[]>, users: Record<string, Row>) {
  const log: Array<{ op: string; table: string; v?: any }> = [];
  const from = (table: string) => {
    let rows = () => (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select", payload: any = null, wantRows = false, lo = 0, hi = Infinity;
    const get = (r: Row, k: string) => k.includes("->") ? k.split(/->>?/).reduce((o: any, p) => o?.[p], r) : r[k];
    const run = (): Row[] => {
      if (op === "insert") { const add = (Array.isArray(payload) ? payload : [payload]).map((x: Row) => ({ id: rows().length + 1, created_at: iso(NOW), active: table === "studio_affiliate_links" ? true : undefined, ...x }));
        if (table === "studio_affiliate_links" && add.some((a: Row) => rows().some((r) => r.code === a.code))) throw Object.assign(new Error("duplicate key value"), { dup: true });
        rows().push(...add); log.push({ op, table, v: add }); return add; }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") { hit.forEach((r) => Object.assign(r, payload)); log.push({ op, table, v: payload }); return hit; }
      return hit.slice(lo, hi + 1);
    };
    const done = (single: boolean, must = false) => { try { const r = run(); return Promise.resolve({ data: single ? r[0] ?? null : r, error: must && !r.length ? { message: "no rows" } : null }); } catch (e: any) { return Promise.resolve({ data: null, error: { message: e.message } }); } };
    const q: any = {
      select: () => { if (op !== "select") wantRows = true; return q; },
      insert: (v: any) => { op = "insert"; payload = v; return q; }, update: (v: any) => { op = "update"; payload = v; return q; },
      upsert: (v: any) => { const k = (v as Row).user_id; if (!rows().some((r) => r.user_id === k)) rows().push({ affiliate_code: null, ...v }); log.push({ op: "upsert", table, v }); return q; },
      eq: (k: string, v: any) => { filters.push((r) => get(r, k) === v); return q; }, is: (k: string, v: any) => { filters.push((r) => (get(r, k) ?? null) === v); return q; },
      not: (k: string, _o: string, v: any) => { filters.push((r) => (get(r, k) ?? null) !== v); return q; }, in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(get(r, k))); return q; },
      order: () => q, limit: () => q, range: (a: number, b: number) => { lo = a; hi = b; return q; },
      maybeSingle: () => done(true), single: () => done(true, true), then: (ok: any, bad: any) => done(false).then(ok, bad),
    };
    void wantRows;
    return q;
  };
  return { from, log, auth: { admin: { getUserById: async (id: string) => ({ data: { user: users[id] ?? null } }) } } } as any;
}

function base() {
  const tables: Record<string, Row[]> = {
    studio_affiliate_links: [{ code: "jake", name: "Jake", note: null, active: true, created_at: iso(NOW - 10 * D) }, { code: "old-deal", name: "Old deal", note: null, active: false, created_at: iso(NOW - 40 * D) }],
    studio_affiliate_clicks: [],
    studio_customers: [{ user_id: NEWBIE, affiliate_code: null, created_at: iso(NOW - H) }, { user_id: OLDIE, affiliate_code: null, created_at: iso(NOW - 30 * D) }, { user_id: OWNER, affiliate_code: null, created_at: iso(NOW - 60 * D) }],
  };
  const users: Record<string, Row> = {
    [NEWBIE]: { id: NEWBIE, email: "new@example.com", created_at: iso(NOW - H), user_metadata: {} },
    [OLDIE]: { id: OLDIE, email: "old@example.com", created_at: iso(NOW - 30 * D), user_metadata: {} },
    [OWNER]: { id: OWNER, email: "boss@clone8.io", created_at: iso(NOW - 60 * D), email_confirmed_at: iso(NOW - 60 * D), user_metadata: {} },
  };
  return { tables, users, sb: fakeSb(tables, users) };
}

// ---------------------------------------------------------------- pure rules

test("codes: typed names become clean codes; bad ones are refused; a taken code gets a short unique tail", () => {
  assert.equal(normalizeCode(" Jake Paul "), "jake-paul");
  assert.equal(normalizeCode("JAKE_paul!!"), "jake-paul");
  assert.equal(normalizeCode("ab"), null, "too short");
  assert.equal(normalizeCode("-x"), null);
  assert.equal(normalizeCode("a".repeat(40)), null, "too long");
  assert.equal(codeFromName("Jake", new Set()), "jake");
  const second = codeFromName("Jake", new Set(["jake"]));
  assert.match(second, /^jake-[a-z2-9]{4}$/);
  assert.notEqual(codeFromName("Jake", new Set(["jake", second])), second);
  assert.match(codeFromName("Al", new Set()), /^linkal$/, "a name too short to be a code still gives one");
  assert.equal(affiliateLink("jake", {}), "https://clone8.io/?aff=jake");
});

test("devices: phones, computers and the in-app browsers that matter for sign-up", () => {
  assert.deepEqual(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit Instagram 350.0"), { device: "phone", browser: "Instagram app" });
  assert.deepEqual(deviceOf("Mozilla/5.0 (Linux; Android 14) musical_ly_2023 BytedanceWebview"), { device: "phone", browser: "TikTok app" });
  assert.deepEqual(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"), { device: "computer", browser: "Safari" });
  assert.deepEqual(deviceOf("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36"), { device: "computer", browser: "Chrome" });
  assert.deepEqual(deviceOf(""), { device: "unknown", browser: "Unknown" });
});

test("crediting: only a new account (48 hours), only once", () => {
  assert.equal(canCredit({ affiliate_code: null }, iso(NOW - H), NOW), true);
  assert.equal(canCredit({ affiliate_code: null }, iso(NOW - CLAIM_WINDOW_MS - 1000), NOW), false, "an existing customer is never moved onto a link");
  assert.equal(canCredit({ affiliate_code: "jake" }, iso(NOW - H), NOW), false, "never twice");
  assert.equal(canCredit(null, iso(NOW - H), NOW), false);
  assert.equal(canCredit({ affiliate_code: null }, "nonsense", NOW), false);
});

test("clicks: the beacon's body is checked (text or JSON), junk is dropped", () => {
  assert.deepEqual(clickInput('{"code":"Jake","v":"abcdefgh1234","landing":"site","ref":"l.instagram.com"}'), { code: "jake", visitor: "abcdefgh1234", landing: "site", referrer: "l.instagram.com" });
  assert.deepEqual(clickInput({ code: "jake", v: "x", landing: "app" }), { code: "jake", visitor: null, landing: "app", referrer: null });
  assert.equal(clickInput("not json"), null);
  assert.equal(clickInput({ code: "<script>" }), null);
});

test("the sign-up answers keep the code (the fallback when the app never claimed)", () => {
  const a = sanitizeAnswers({ attribution: { aff: "jake", utm_source: "ig", evil: "x" } } as any) as any;
  assert.equal(a.attribution?.aff, "jake");
  assert.equal(a.attribution?.evil, undefined);
});

// ---------------------------------------------------------------- the page's numbers

test("summary: clicks, unique visitors, sign-ups, tried, paid, paying now, cancelling, money and rates per link", () => {
  const links: LinkRow[] = [{ code: "jake", name: "Jake", note: null, active: true, created_at: iso(NOW - 10 * D) }, { code: "sara", name: "Sara", note: "TikTok", active: true, created_at: iso(NOW - 5 * D) }];
  const click = (code: string, visitor: string, t: number, browser = "Instagram app"): ClickRow => ({ code, visitor, device: "phone", browser, referrer: "l.instagram.com", landing: "site", created_at: iso(t) });
  const clicks = [click("jake", "v1", NOW - 3 * D), click("jake", "v1", NOW - 2 * D), click("jake", "v2", NOW - D, "Safari"), click("jake", "v3", NOW - H), click("sara", "s1", NOW - 2 * H), click("jake", "v9", NOW - 40 * D)];
  const person = (i: number, over: Partial<PersonRow>): PersonRow => ({ user_id: `u${i}`, email: `p${i}@x.com`, code: "jake", credited_via: "account", signed_up: iso(NOW - 2 * D), plan: null, interval: null, status: "none", cancel_at_period_end: false,
    billing_source: null, onboarded: true, jobs: 0, opened_checkout: false, paid_usd: 0, net_usd: 0, first_paid_at: null, last_seen: null, internal: false, ...over });
  const people = [
    person(1, { jobs: 3, opened_checkout: true, paid_usd: 29, net_usd: 27.86, plan: "starter", status: "active", first_paid_at: iso(NOW - 2 * D + 2 * H) }),
    person(2, { jobs: 1, opened_checkout: true, paid_usd: 79, net_usd: 76.41, plan: "creator", status: "active", cancel_at_period_end: true, first_paid_at: iso(NOW - 2 * D + 6 * H) }),
    person(3, { credited_via: "answers" }),
    person(4, { internal: true, paid_usd: 999 }),
    person(5, { code: "sara", signed_up: iso(NOW - H) }),
  ];
  const s = summarizeAffiliates({ links, clicks, people, days: 30, tz: -480, now: NOW, env: {} });
  const j = s.links.find((l) => l.code === "jake")!;
  assert.equal(j.clicks, 4, "the 40-day-old click is outside 30 days"); assert.equal(j.visitors, 3, "v1 clicked twice: one visitor");
  assert.equal(j.signups, 3, "our own account is left out"); assert.equal(j.tried, 2); assert.equal(j.opened_checkout, 2);
  assert.equal(j.paid, 2); assert.equal(j.paying_now, 1); assert.equal(j.cancelling, 1);
  assert.equal(j.revenue_usd, 108); assert.equal(Math.round(j.net_usd * 100) / 100, 104.27);
  assert.equal(j.click_to_signup, 1); assert.equal(j.signup_to_paid, 2 / 3); assert.equal(j.revenue_per_click, 36); assert.equal(j.revenue_per_payer, 54);
  assert.equal(j.median_hours_to_pay, 4);
  assert.deepEqual(j.browsers[0], { key: "Instagram app", n: 3 });
  assert.equal(j.days.length, 30); assert.equal(j.days.reduce((n, d) => n + d.clicks, 0), 4);
  assert.equal(s.links[0].code, "jake", "the link with payers first");
  assert.equal(s.totals.signups, 4); assert.equal(s.totals.paid, 2); assert.equal(s.totals.clicks, 5);
  assert.ok(s.notes.some((n) => /sign-up answers/.test(n)));
  assert.equal(s.people.length, 4); assert.equal(s.people[0].user_id, "u5", "newest first");
  const all = summarizeAffiliates({ links, clicks, people, days: null, tz: -480, now: NOW, includeInternal: true, env: {} });
  assert.equal(all.links.find((l) => l.code === "jake")!.clicks, 5); assert.equal(all.links.find((l) => l.code === "jake")!.signups, 4);
});

// ---------------------------------------------------------------- crediting against the stand-in database

test("credit: the code on the account (set at sign-up) wins over the browser's; once; new accounts only; paused or unknown links never", async () => {
  const { tables, users, sb } = base();
  users[NEWBIE].user_metadata = { aff: "jake" };
  assert.deepEqual(await creditAffiliate(sb, NEWBIE, "someone-else", NOW), { credited: true, code: "jake" });
  assert.equal(tables.studio_customers.find((c) => c.user_id === NEWBIE)!.affiliate_code, "jake");
  assert.equal((await creditAffiliate(sb, NEWBIE, "jake", NOW)).reason, "already_credited");
  assert.equal((await creditAffiliate(sb, OLDIE, "jake", NOW)).reason, "not_new", "a 30-day-old customer clicking a link is not moved");
  const b = base();
  assert.equal((await creditAffiliate(b.sb, NEWBIE, "old-deal", NOW)).reason, "paused");
  assert.equal((await creditAffiliate(b.sb, NEWBIE, "nobody", NOW)).reason, "unknown_code");
  assert.equal((await creditAffiliate(b.sb, NEWBIE, null, NOW)).reason, "no_code");
  assert.deepEqual(await creditAffiliate(b.sb, NEWBIE, "JAKE", NOW), { credited: true, code: "jake" }, "the browser's code (Google sign-in: no metadata) works too");
});

// ---------------------------------------------------------------- the routes

async function serve(sb: any, who: string | null, env: Record<string, string>) {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, next) => { if (who) req.auth = { user_id: who, email: who === OWNER ? "boss@clone8.io" : "new@example.com" }; next(); });
  registerAffiliates(app, () => sb, { env, now: () => NOW });
  const server = app.listen(0); const port = (server.address() as AddressInfo).port;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", connection: "close", ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, json };
  };
  return { call, close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); }) };
}
const ENV = { STUDIO_AFFILIATES_ENABLED: "true", STUDIO_ADMIN_EMAILS: "boss@clone8.io" };

test("routes: the owner makes links (unique codes), renames and pauses them; anyone else gets 404; off means 404", async () => {
  clearAdminCacheForTests();
  const { tables, sb } = base();
  const s = await serve(sb, OWNER, ENV);
  try {
    const a = await s.call("POST", "/api/studio/admin/affiliates", { name: "Sara Lee" });
    assert.equal(a.status, 201); assert.equal(a.json.link.code, "sara-lee"); assert.equal(a.json.link.url, "https://clone8.io/?aff=sara-lee");
    const b = await s.call("POST", "/api/studio/admin/affiliates", { name: "Sara Lee" });
    assert.equal(b.status, 201); assert.match(b.json.link.code, /^sara-lee-[a-z2-9]{4}$/, "same name twice: still unique");
    assert.equal((await s.call("POST", "/api/studio/admin/affiliates", { name: "X", code: "jake" })).status, 409, "a chosen code that exists is refused");
    assert.equal((await s.call("POST", "/api/studio/admin/affiliates", { name: "X", code: "!!" })).status, 400);
    assert.equal((await s.call("POST", "/api/studio/admin/affiliates", { name: "" })).status, 400);
    const p = await s.call("PATCH", "/api/studio/admin/affiliates/jake", { active: false, note: "deal ended" });
    assert.equal(p.status, 200); assert.equal(tables.studio_affiliate_links.find((l) => l.code === "jake")!.active, false);
    const g = await s.call("GET", "/api/studio/admin/affiliates?days=30");
    assert.equal(g.status, 200); assert.ok(Array.isArray(g.json.links)); assert.equal(g.json.links.length, 4);
  } finally { await s.close(); }
  clearAdminCacheForTests();
  const other = await serve(base().sb, NEWBIE, ENV);
  try { assert.equal((await other.call("GET", "/api/studio/admin/affiliates")).status, 404); assert.equal((await other.call("POST", "/api/studio/admin/affiliates", { name: "x" })).status, 404); } finally { await other.close(); }
  clearAdminCacheForTests();
  const off = await serve(base().sb, OWNER, { ...ENV, STUDIO_AFFILIATES_ENABLED: "false" });
  try { assert.equal((await off.call("GET", "/api/studio/admin/affiliates")).status, 404); } finally { await off.close(); }
});

test("routes: a click (text beacon) is saved with its device; the same visitor within 30 minutes once; unknown and paused codes nothing; always 204", async () => {
  const { tables, sb } = base();
  const s = await serve(sb, null, ENV);
  const ua = { "user-agent": "Mozilla/5.0 (iPhone) Instagram 350", "content-type": "text/plain" };
  try {
    const body = JSON.stringify({ code: "jake", v: "visitor-123456", landing: "site", ref: "l.instagram.com" });
    assert.equal((await s.call("POST", "/api/public/aff-click", body, ua)).status, 204);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tables.studio_affiliate_clicks.length, 1);
    assert.deepEqual([tables.studio_affiliate_clicks[0].device, tables.studio_affiliate_clicks[0].browser, tables.studio_affiliate_clicks[0].referrer], ["phone", "Instagram app", "l.instagram.com"]);
    await s.call("POST", "/api/public/aff-click", body, ua);
    await s.call("POST", "/api/public/aff-click", JSON.stringify({ code: "jake", v: "another-visitor1" }), ua);
    await s.call("POST", "/api/public/aff-click", JSON.stringify({ code: "nobody", v: "visitor-123456" }), ua);
    await s.call("POST", "/api/public/aff-click", JSON.stringify({ code: "old-deal", v: "visitor-123456" }), ua);
    assert.equal((await s.call("POST", "/api/public/aff-click", "garbage", ua)).status, 204);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tables.studio_affiliate_clicks.length, 2, "one repeat dropped, one new visitor kept, unknown and paused codes dropped");
  } finally { await s.close(); }
});

test("routes: the claim credits the signed-in new account; signed out is 401; off answers credited false", async () => {
  const { tables, sb } = base();
  const s = await serve(sb, NEWBIE, ENV);
  try {
    const r = await s.call("POST", "/api/studio/affiliate/claim", { code: "jake" });
    assert.equal(r.status, 200); assert.equal(r.json.credited, true);
    assert.equal(tables.studio_customers.find((c) => c.user_id === NEWBIE)!.affiliate_code, "jake");
    assert.equal((await s.call("POST", "/api/studio/affiliate/claim", { code: "jake" })).json.credited, false);
  } finally { await s.close(); }
  const anon = await serve(base().sb, null, ENV);
  try { assert.equal((await anon.call("POST", "/api/studio/affiliate/claim", { code: "jake" })).status, 401); } finally { await anon.close(); }
  const off = await serve(base().sb, NEWBIE, { STUDIO_AFFILIATES_ENABLED: "false" });
  try { assert.deepEqual((await off.call("POST", "/api/studio/affiliate/claim", { code: "jake" })).json, { credited: false, reason: "off" }); } finally { await off.close(); }
});

test("the click beacon passes both of the server's guards (no account, no write secret): it is a self-checked public POST", () => {
  assert.equal(selfAuthenticatedPost("/api/public/aff-click", "POST"), true);
  assert.equal(selfAuthenticatedPost("/api/public/aff-click/", "POST"), true);
  assert.equal(selfAuthenticatedPost("/api/public/aff-click", "GET"), false);
});

test("credit: a brand-new person whose Studio row is not written yet is still credited (the row is made by the claim)", async () => {
  const { tables, users, sb } = base();
  const FRESH = "44444444-4444-4444-8444-444444444444";
  users[FRESH] = { id: FRESH, email: "fresh@example.com", created_at: iso(NOW - 2 * 60_000), user_metadata: { aff: "jake" } };
  assert.equal(tables.studio_customers.some((c) => c.user_id === FRESH), false);
  assert.deepEqual(await creditAffiliate(sb, FRESH, null, NOW), { credited: true, code: "jake" }, "the code saved at sign-up, with no row and no browser code (confirmation opened elsewhere)");
  assert.equal(tables.studio_customers.find((c) => c.user_id === FRESH)!.affiliate_code, "jake");
  assert.equal((await creditAffiliate(sb, "55555555-5555-4555-8555-555555555555", "jake", NOW)).reason, "no_account", "an id that is not a user never gets a row");
  assert.equal(tables.studio_customers.some((c) => c.user_id === "55555555-5555-4555-8555-555555555555"), false);
});
