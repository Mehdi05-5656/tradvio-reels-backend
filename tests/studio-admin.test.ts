import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { computeAdmin, jobCost, paymentsFrom, jobVia, registerStudioAdmin, type AdminData } from "../src/studio-admin.js";
import { isStudioAdmin, isInternalEmail, adminEmails, clearAdminCacheForTests } from "../src/studio-admin-auth.js";
import { recordEvent, recordPageViews, initEvents, flushEvents, resetEventsForTests } from "../src/studio-events.js";
import { logClaudeCost } from "../src/studio-pricing.js";

const ENV = { HIGGSFIELD_DISCOUNT: "0", SEEDANCE_DISCOUNT: "0", STRIPE_PRICE_CREATOR_MONTH: "price_cm", STRIPE_PRICE_STUDIO_YEAR: "price_sy", STRIPE_PRICE_SOCIAL_ACCOUNT_MONTH: "price_seat", STUDIO_SWAP_ENABLED: "true" } as Record<string, string>;
const NOW = new Date("2026-10-31T12:00:00Z");
const ago = (days: number, h = 0) => new Date(NOW.getTime() - days * 86400000 - h * 3600000).toISOString();
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", ME = "cccccccc-0000-4000-8000-000000000003";

function data(): AdminData {
  return {
    users: [
      { id: A, email: "ann@example.com", created_at: ago(5), email_confirmed_at: ago(5), last_sign_in_at: ago(1) },
      { id: B, email: "bob@example.com", created_at: ago(40), email_confirmed_at: ago(40), last_sign_in_at: ago(2) },
      { id: ME, email: "support@clone8.io", created_at: ago(1), email_confirmed_at: ago(1), last_sign_in_at: ago(0) },
    ],
    customers: [
      { user_id: A, stripe_customer_id: "cus_a", plan_id: "creator", billing_interval: "month", status: "active", onboarding: { completed_at: ago(5), version: 2, role: "creator", goals: ["faceless"], goal: "faceless", heard: "tiktok" }, created_at: ago(5), social_extra: 1 },
      { user_id: B, stripe_customer_id: "cus_b", plan_id: "studio", billing_interval: "year", status: "active", onboarding: { completed_at: ago(40), intent: "blueprint" }, created_at: ago(40) },
      { user_id: ME, plan_id: null, status: "none", onboarding: {}, created_at: ago(1) },
    ],
    jobs: [
      // billed swap, finished
      { id: "j1", user_id: A, tool: "swap", status: "done", options: { model: "light", via: "tool" }, credits_reserved: 80, credits_charged: 80, attempts: 1, progress: { spend_usd: 0.5, spend_priced: "billed" }, outputs: [{ duration: 5 }], created_at: ago(2), started_at: ago(2), finished_at: new Date(Date.parse(ago(2)) + 120_000).toISOString() },
      // started from a chat (older job, no tag: the chat's run names it), retried, offered the high-capacity route, failed
      { id: "j2", user_id: A, tool: "recast", status: "failed", options: { model: "light" }, credits_reserved: 100, credits_charged: 0, attempts: 3, progress: { spend_usd: 0.3, offer: { engine: "seedance", credits: 300 } }, outputs: [], error_code: "renderer_busy", created_at: ago(3) },
      // long path on Seedance, cut at the opening shot, legacy spend
      { id: "j3", user_id: B, tool: "swap", status: "done", options: { model: "light" }, credits_reserved: 500, credits_charged: 500, attempts: 1, progress: { spend_usd: 4, engine: "seedance" }, outputs: [{ duration: 20, cut_at: 6 }], created_at: ago(4) },
      // instrument with the real estimate kept
      { id: "j4", user_id: B, tool: "instrument", status: "done", options: { endpoint: "kling-video/v3.0", usd: 0.5, cost_usd: 0.4, priced_by: "estimate", via: "chat" }, credits_reserved: 40, credits_charged: 40, attempts: 1, progress: {}, outputs: [{}], created_at: ago(1) },
      // blueprint 10 copies, costed from the table
      { id: "j5", user_id: B, tool: "blueprint", status: "done", options: { copies: 10 }, credits_reserved: 120, credits_charged: 120, attempts: 1, progress: {}, outputs: Array.from({ length: 10 }, () => ({})), created_at: ago(6) },
      // our own job: left out unless asked
      { id: "j6", user_id: ME, tool: "swap", status: "done", options: { model: "light" }, credits_reserved: 80, credits_charged: 80, attempts: 1, progress: { spend_usd: 9, spend_priced: "billed" }, outputs: [{ duration: 5 }], created_at: ago(0, 2) },
      // the window before (for deltas)
      { id: "j7", user_id: B, tool: "swap", status: "done", options: { model: "light" }, credits_reserved: 80, credits_charged: 80, attempts: 1, progress: { spend_usd: 0.5, spend_priced: "estimate" }, outputs: [{ duration: 5 }], created_at: ago(35) },
    ],
    ledger: [
      { user_id: A, delta: 3500, reason: "grant", ref: "in_1", note: "Creator subscription_create", created_at: ago(5) },
      { user_id: A, delta: 290, reason: "grant", ref: "pi_auto1", note: "Auto top-up $10", created_at: ago(1) },
      { user_id: A, delta: -80, reason: "reserve", ref: null, note: null, created_at: ago(2) },
      { user_id: A, delta: 100, reason: "refund", ref: null, note: null, created_at: ago(3) },
    ],
    stripe: [
      { id: "evt_1", type: "invoice.paid", received_at: ago(5), payload: { livemode: true, data: { object: { id: "in_1", customer: "cus_a", amount_paid: 9800, billing_reason: "subscription_create", lines: { data: [{ amount: 7900, pricing: { price_details: { price: "price_cm" } } }, { amount: 1900, pricing: { price_details: { price: "price_seat" } } }] } } } } },
      { id: "evt_2", type: "checkout.session.completed", received_at: ago(2), payload: { livemode: true, data: { object: { id: "cs_live_1", mode: "payment", amount_total: 1900, metadata: { pack: "pack_500", user_id: A } } } } },
      { id: "evt_3", type: "checkout.session.completed", received_at: ago(5), payload: { livemode: true, data: { object: { id: "cs_live_2", mode: "subscription", amount_total: 9800, metadata: { user_id: A } } } } },
      { id: "evt_4", type: "invoice.paid", received_at: ago(3), payload: { livemode: false, data: { object: { id: "in_test", customer: "cus_b", amount_paid: 199200, billing_reason: "subscription_create", lines: { data: [] } } } } },
      { id: "evt_5", type: "invoice.paid", received_at: ago(38), payload: { livemode: true, data: { object: { id: "in_b", customer: "cus_b", amount_paid: 199200, billing_reason: "subscription_create", lines: { data: [{ amount: 199200, price: { id: "price_sy" } }] } } } } },
    ],
    conversations: [
      { id: "c1", user_id: A, status: "idle", automation_id: null, created_at: ago(3), updated_at: ago(3), run: { plan_id: "p1", status: "failed", started_at: ago(3), steps: [{ index: 1, job_id: "j2", status: "failed" }] },
        messages: [{ id: "m1", role: "user", text: "recast this", at: ago(3), links: ["https://tiktok.com/x"] }, { id: "m2", role: "assistant", text: "plan", plan_id: "p1", at: ago(3) }, { id: "m3", role: "assistant", text: "pick", at: ago(3), choice: { job_id: null } }] },
    ],
    automations: [{ id: "a1", user_id: B, runs: 4, created_at: ago(20) }],
    posts: [{ id: "p1", user_id: A, status: "scheduled", platforms: ["tiktok", "instagram"], conversation_id: "c1", created_at: ago(1) }],
    profiles: [{ user_id: A, accounts: [{ platform: "tiktok" }], created_at: ago(4) }],
    insights: [{ user_id: A, created_at: ago(2) }], perfAccounts: [{ user_id: A, platform: "tiktok" }],
    assets: [{ user_id: A, kind: "video", bytes: 2e9, created_at: ago(3) }, { user_id: ME, kind: "video", bytes: 5e9, created_at: ago(0) }],
    events: [
      { user_id: A, kind: "claude", name: "assistant", usd: 0.05, props: { model: "claude-opus-5-5", input: 1000, output: 200 }, created_at: ago(3) },
      { user_id: A, kind: "claude", name: "caption", usd: 0.02, props: { model: "claude-opus-5-5", input: 500, output: 50 }, created_at: ago(1) },
      { user_id: null, kind: "vendor", name: "scrapecreators", usd: 0.0019, props: { use: "performance" }, created_at: ago(1) },
      { user_id: A, kind: "page", name: "swap", props: {}, created_at: ago(2) },
      { user_id: A, kind: "page", name: "swap", props: {}, created_at: ago(2) },
      { user_id: B, kind: "page", name: "home", props: {}, created_at: ago(1) },
      { user_id: A, kind: "checkout", name: "pack", usd: 19, props: {}, created_at: ago(2) },
      { user_id: A, kind: "email", name: "receipt", props: { ok: true }, created_at: ago(2) },
      { user_id: ME, kind: "page", name: "admin", props: {}, created_at: ago(0) },
    ],
    memory: [{ user_id: A, created_at: ago(3) }],
  };
}

test("a job's cost: what Higgsfield charged, its estimate, our table, or the figure booked before Oct 31", () => {
  assert.deepEqual(jobCost({ tool: "swap", status: "done", progress: { spend_usd: 0.5, spend_priced: "billed" } }, ENV), { usd: 0.5, source: "billed" });
  assert.deepEqual(jobCost({ tool: "recast", status: "failed", progress: { spend_usd: 0.3 } }, ENV), { usd: 0, source: "none" }, "an old failed job was not billed");
  assert.deepEqual(jobCost({ tool: "recast", status: "failed", progress: { spend_usd: 0.3, spend_priced: "estimate" } }, ENV), { usd: 0.3, source: "estimate" }, "a booked piece of a failed long job counts");
  assert.equal(jobCost({ tool: "swap", status: "done", options: { model: "light" }, progress: {}, outputs: [{ duration: 10 }] }, ENV).source, "model");
  assert.deepEqual(jobCost({ tool: "instrument", status: "done", options: { usd: 0.5, cost_usd: 0.4, priced_by: "estimate" } }, ENV), { usd: 0.4, source: "estimate" });
  assert.deepEqual(jobCost({ tool: "instrument", status: "failed", options: { cost_usd: 0.4 } }, ENV), { usd: 0, source: "none" });
  assert.equal(jobCost({ tool: "blueprint", status: "done", outputs: [{}, {}] }, ENV).source, "model");
});

test("where a job came from: its tag, else the chat or automation that ran it", () => {
  assert.equal(jobVia({ id: "x", options: { via: "tool" } }, new Set(), new Set()), "tool");
  assert.equal(jobVia({ id: "x", options: {} }, new Set(["x"]), new Set()), "chat");
  assert.equal(jobVia({ id: "x", options: {} }, new Set(), new Set(["x"])), "automation");
  assert.equal(jobVia({ id: "x", options: {} }, new Set(), new Set()), "unknown");
});

test("money in: live payments only, split by kind and plan; auto top-ups from the ledger; a plan's checkout is not counted twice", () => {
  const d = data();
  const { payments, sandbox } = paymentsFrom(d.stripe, d.ledger, d.customers, ENV);
  assert.equal(sandbox, 1);
  assert.deepEqual(payments.map((p) => [p.kind, p.usd, p.plan ?? null]).sort(), [["auto_topup", 10, null], ["new_plan", 1992, "studio"], ["new_plan", 79, "creator"], ["pack", 19, null], ["seat", 19, null]].sort());
  assert.ok(payments.every((p) => p.user_id), "every payment is tied to a person");
});

test("the admin numbers for 30 days: money, profit, tools, fallbacks, chat, usage, funnel, people, onboarding", () => {
  const m = computeAdmin(data(), { days: 30, includeInternal: false, now: NOW }, ENV);
  // money: 79 + 19 seat + 19 pack + 10 auto top-up; the annual Studio plan was paid 38 days ago
  assert.equal(m.kpis.cash_usd, 127);
  assert.equal(m.kpis.cash_prev, 1992);
  const fee = (x: number) => x * 0.029 + 0.3;
  const gen = 0.5 + 4 + 0.4 + 10 * 0.001;
  assert.equal(m.costs.generation_usd, Math.round(gen * 100) / 100);
  assert.equal(m.costs.stripe_fees_usd, Math.round((fee(79) + fee(19) + fee(19) + fee(10)) * 100) / 100, "one fee per line here, close enough to Stripe's per-charge fee");
  assert.equal(m.costs.claude_usd, 0.07);
  assert.ok(Math.abs(m.kpis.profit_usd - (127 - m.kpis.cost_usd)) < 0.011);
  assert.equal(m.kpis.mrr_usd, 79 + 19 + 166);
  assert.equal(m.kpis.paying, 2);
  assert.equal(m.kpis.jobs, 5, "our own job is left out");
  assert.equal(m.kpis.success_rate, 0.8);
  // tools
  const swap = m.tools.find((t) => t.tool === "swap")!;
  assert.deepEqual([swap.jobs, swap.done, swap.credits, swap.cost_usd], [2, 2, 580, 4.5]);
  assert.deepEqual(swap.via, { tool: 1, chat: 0, automation: 0, unknown: 1 });
  assert.ok(swap.value_usd > 0 && swap.margin! > 0);
  assert.equal(m.tools.find((t) => t.tool === "recast")!.via.chat, 1, "the chat's run names the older job");
  // fallbacks
  assert.deepEqual(m.reliability.fallbacks, { renders: 3, retried: 1, retry_spend_usd: 0, long_path: 1, escalated: 0, opening_shot: 1, pieces: 0, high_capacity_offered: 1, high_capacity_chosen: 0, renderer_busy: 1, light_refused: 0 });
  assert.deepEqual(m.reliability.failures.map((f) => [f.code, f.jobs, f.credits_refunded]), [["renderer_busy", 1, 100]]);
  assert.deepEqual(m.costs.by_source.map((s) => s.source).sort(), ["billed", "estimate", "legacy", "model"]);
  // chat
  assert.equal(m.chat.conversations, 1); assert.equal(m.chat.user_messages, 1); assert.equal(m.chat.plans_proposed, 1);
  assert.equal(m.chat.jobs_from_chat, 2, "the tagged instrument job and the run's recast");
  assert.equal(m.chat.links, 1); assert.equal(m.chat.characters_offered, 1); assert.equal(m.chat.automation_runs, 4);
  // usage
  assert.deepEqual(m.usage.pages, [{ page: "swap", views: 2, users: 1 }, { page: "home", views: 1, users: 1 }], "our own admin view is left out");
  assert.equal(m.usage.uploads.videos, 1); assert.equal(m.usage.social.posts, 1); assert.equal(m.usage.social.from_chat, 1);
  assert.deepEqual(m.usage.emails.map((e) => [e.name, e.n]), [["receipt", 1]]);
  assert.deepEqual(m.usage.checkouts.map((e) => [e.name, e.n]), [["pack", 1]]);
  // funnel: Ann signed up in the window and did everything but five jobs
  assert.deepEqual(m.funnel.map((f) => f.users), [1, 1, 1, 1, 1, 1, 0]);
  // people
  assert.deepEqual(m.users.map((u) => u.email), ["ann@example.com", "bob@example.com"]);
  const ann = m.users[0];
  assert.equal(ann.paid_usd, 127); assert.equal(ann.via_chat, 1); assert.deepEqual(ann.onboarding?.goals, ["faceless"]);
  // onboarding answers counted
  assert.equal(m.onboarding.answered, 2);
  assert.ok(m.notes.some((n) => /sandbox/.test(n)));
});

test("with our own accounts included, and over all time", () => {
  const m = computeAdmin(data(), { days: null, includeInternal: true, now: NOW }, ENV);
  assert.equal(m.kpis.jobs, 7);
  assert.equal(m.kpis.cash_usd, 127 + 1992);
  assert.equal(m.kpis.cash_prev, null);
  assert.equal(m.users.length, 3);
  assert.ok(m.users.find((u) => u.email === "support@clone8.io")!.internal);
  assert.ok(m.daily.length >= 30);
});

test("only the owner's confirmed account is the Studio admin", async () => {
  clearAdminCacheForTests();
  assert.deepEqual(adminEmails({}), ["support@clone8.io"]);
  assert.ok(isInternalEmail("support+10@tradvio.com", {})); assert.ok(!isInternalEmail("ann@example.com", {}));
  const sb = (user: any) => ({ auth: { admin: { getUserById: async () => ({ data: { user } }) } } }) as any;
  const req = (auth: any) => ({ auth }) as any;
  assert.equal(await isStudioAdmin(req({ user_id: ME, email: "support@clone8.io" }), sb({ id: ME, email: "support@clone8.io", email_confirmed_at: ago(1) }), {}), true);
  clearAdminCacheForTests();
  assert.equal(await isStudioAdmin(req({ user_id: ME, email: "support@clone8.io" }), sb({ id: ME, email: "support@clone8.io", email_confirmed_at: null }), {}), false, "an unconfirmed address is not enough");
  clearAdminCacheForTests();
  assert.equal(await isStudioAdmin(req({ user_id: A, email: "ann@example.com" }), sb({ id: A, email: "ann@example.com", email_confirmed_at: ago(1) }), {}), false);
  assert.equal(await isStudioAdmin(req({ admin_secret: true }), sb(null), {}), false, "the operator console's secret is not the Studio admin");
  clearAdminCacheForTests();
  assert.equal(await isStudioAdmin(req({ user_id: A, email: "support@clone8.io" }), sb({ id: A, email: "ann@example.com", email_confirmed_at: ago(1) }), {}), false, "the token's email must be the account's");
});

test("the metrics route: 404 for anyone but the owner; the owner gets the numbers", async () => {
  clearAdminCacheForTests();
  const app = express();
  let who: any = null;
  app.use((req, _res, next) => { (req as any).auth = who; next(); });
  const sb = { auth: { admin: { getUserById: async (id: string) => ({ data: { user: id === ME ? { id: ME, email: "support@clone8.io", email_confirmed_at: ago(1) } : { id, email: "ann@example.com", email_confirmed_at: ago(1) } } }) } } } as any;
  registerStudioAdmin(app, () => sb, { env: ENV, load: async () => data() });
  const srv = app.listen(0); const port = (srv.address() as any).port;
  try {
    who = { user_id: A, email: "ann@example.com" };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/admin/metrics`)).status, 404);
    who = null;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/admin/metrics`)).status, 404);
    who = { user_id: ME, email: "support@clone8.io" };
    const r = await fetch(`http://127.0.0.1:${port}/api/studio/admin/metrics?days=7&internal=1`);
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.range.days, 7); assert.equal(body.include_internal, true);
    const all = await (await fetch(`http://127.0.0.1:${port}/api/studio/admin/metrics?days=all`)).json() as any;
    assert.equal(all.range.days, null);
  } finally { srv.close(); }
});

test("events: buffered and written in one insert; page views bounded per person; Claude costs recorded with the person", async () => {
  resetEventsForTests();
  recordEvent({ kind: "page", name: "home" }); // before init: dropped
  const inserted: any[] = [];
  initEvents(() => ({ from: (t: string) => ({ insert: async (rows: any[]) => { assert.equal(t, "studio_events"); inserted.push(...rows); return { error: null }; } }) }) as any);
  assert.equal(recordPageViews(A, [{ page: "swap" }, { page: "nope" }, { page: "admin", tab: "money<script>" }]), 2);
  assert.equal(recordPageViews(A, Array.from({ length: 40 }, () => ({ page: "home" }))), 20, "20 a request");
  assert.equal(recordPageViews(A, Array.from({ length: 20 }, () => ({ page: "home" }))), 8, "30 a minute");
  logClaudeCost(undefined, "caption", "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }, A);
  recordEvent({ kind: "email", name: "receipt", user_id: "not-a-uuid" });
  assert.equal(await flushEvents(), 32);
  const claude = inserted.find((r) => r.kind === "claude");
  assert.deepEqual([claude.user_id, claude.name, claude.usd], [A, "caption", 4]);
  assert.equal(inserted.find((r) => r.name === "admin").props.tab, "moneyscript");
  assert.equal(inserted.find((r) => r.kind === "email").user_id, null);
  resetEventsForTests();
});

test("a failed write drops the rows and never throws", async () => {
  resetEventsForTests();
  initEvents(() => ({ from: () => ({ insert: async () => ({ error: { message: "relation \"studio_events\" does not exist" } }) }) }) as any);
  recordEvent({ kind: "vendor", name: "scrapecreators", usd: 0.002 });
  assert.equal(await flushEvents(), 0);
  resetEventsForTests();
});

test("the owner pass: plan access and the largest plan's limits, for the flagged account only", async () => {
  const { hasPlanAccess, limitsFor, PLAN_LIMITS, NO_PLAN_LIMITS } = await import("../src/studio-limits.js");
  assert.equal(hasPlanAccess({ status: "none", owner_pass: true }), true);
  assert.equal(hasPlanAccess({ status: "active" }), true);
  assert.equal(hasPlanAccess({ status: "canceled", owner_pass: false }), false);
  assert.equal(hasPlanAccess(null), false);
  // the largest plan's files and storage, without the hourly job cap (owner's batch runs, Nov 9 2026)
  assert.deepEqual(limitsFor({ status: "none", plan_id: null, owner_pass: true }), { ...PLAN_LIMITS.studio, jobs_per_hour: 100_000 });
  assert.deepEqual(limitsFor({ status: "none", plan_id: null }), NO_PLAN_LIMITS);
});

// ---------------------------------------------------------------------------------------------------
// Country, film costs and the activity log (Nov 10 2026)
// ---------------------------------------------------------------------------------------------------
import { adminLog, adminLogCsv, countryByUser, featureOf } from "../src/studio-admin.js";
import { countryFromRequest, noteCountry, resetGeoForTests } from "../src/studio-geo.js";

test("a finished Kage, Story or Film costs what it was budgeted at; a failed one is not counted", () => {
  assert.deepEqual(jobCost({ tool: "kage_motion", status: "done", options: { cost_usd: 2.1 } }, ENV), { usd: 2.1, source: "estimate" });
  assert.deepEqual(jobCost({ tool: "longform", status: "done", options: { cost_usd: 3 } }, ENV), { usd: 3, source: "estimate" });
  assert.deepEqual(jobCost({ tool: "kage_motion", status: "failed", options: { cost_usd: 2.1 } }, ENV), { usd: 0, source: "none" });
  assert.deepEqual(jobCost({ tool: "clips", status: "done", options: {} }, ENV), { usd: 0, source: "none" }, "Clips keeps no cost: the log says so instead of showing a profit");
  assert.equal(featureOf({ tool: "kage_motion", options: { story: { topic: "x" } } }), "Stories");
  assert.equal(featureOf({ tool: "kage_motion", options: {} }), "Kage");
  assert.equal(featureOf({ tool: "longform" }), "Films");
});

test("country: the edge header, two letters only; kept once per person and again when it changes", async () => {
  assert.equal(countryFromRequest({ headers: { "cf-ipcountry": "fr" } }), "FR");
  assert.equal(countryFromRequest({ headers: { "cf-ipcountry": "XX" } }), null);
  assert.equal(countryFromRequest({ headers: { "cf-ipcountry": "France" } }), null);
  assert.equal(countryFromRequest({ headers: {} }), null);
  resetGeoForTests();
  const writes: any[] = []; let rows = 1, fail = false;
  const sb = { from: () => ({ update: (v: any) => ({ eq: (_k: string, id: string) => ({ select: async () => { if (fail) return { error: { message: "column country does not exist" } }; writes.push({ id, ...v }); return { data: Array.from({ length: rows }, () => ({ user_id: id })) }; } }) }) }) } as any;
  assert.equal(await noteCountry(sb, A, { headers: { "cf-ipcountry": "US" } }), true);
  assert.equal(await noteCountry(sb, A, { headers: { "cf-ipcountry": "US" } }), false, "the same country is not written twice");
  assert.equal(await noteCountry(sb, A, { headers: { "cf-ipcountry": "GB" } }), true, "a move is");
  assert.equal(await noteCountry(sb, A, { headers: {} }), false);
  assert.deepEqual(writes.map((w) => w.country), ["US", "GB"]);
  rows = 0; // no Studio row yet: nothing kept, so it is tried again next time
  assert.equal(await noteCountry(sb, B, { headers: { "cf-ipcountry": "DE" } }), false);
  rows = 1;
  assert.equal(await noteCountry(sb, B, { headers: { "cf-ipcountry": "DE" } }), true);
  fail = true; // before the migration
  assert.equal(await noteCountry(sb, ME, { headers: { "cf-ipcountry": "US" } }), false);
});

test("people carry a country: the one we saw, else the payer's billing country", () => {
  const d = data();
  d.customers[0].country = "FR";
  d.stripe.push({ id: "evt_c", type: "invoice.paid", received_at: ago(3), payload: { livemode: true, data: { object: { customer: "cus_b", customer_address: { country: "GB" }, amount_paid: 0 } } } });
  d.stripe.push({ id: "evt_d", type: "invoice.paid", received_at: ago(3), payload: { livemode: true, data: { object: { customer: "cus_a", customer_address: { country: "US" }, amount_paid: 0 } } } });
  const by = countryByUser(d);
  assert.equal(by.get(A), "FR", "what we saw wins over the card's country");
  assert.equal(by.get(B), "GB");
  const m = computeAdmin(d, { days: 30, includeInternal: true, now: NOW }, ENV);
  assert.equal(m.users.find((u) => u.user_id === A)!.country, "FR");
  assert.equal(m.users.find((u) => u.user_id === ME)!.country, null);
});

test("the activity log: newest first, 50 a page, one person or everyone, a date range, and what each thing earned", () => {
  const d = data();
  const all = adminLog(d, {}, ENV);
  assert.ok(all.rows.every((r) => r.user_id !== ME), "our own accounts are left out of the full log");
  assert.deepEqual(all.rows.map((r) => r.at), [...all.rows.map((r) => r.at)].sort().reverse());
  assert.equal(adminLog(d, { includeInternal: true }, ENV).total, all.total + d.jobs.filter((j) => j.user_id === ME).length);
  const mine = adminLog(d, { user: ME }, ENV);
  assert.ok(mine.total > 0 && mine.rows.every((r) => r.user_id === ME), "one person's log shows them even when they are one of ours");
  assert.equal(mine.user?.email, "support@clone8.io");
  // the billed swap: 80 credits on Creator monthly, cost $0.50
  const j1 = adminLog(d, { user: A }, ENV).rows.find((r) => r.id === "j1")!;
  assert.equal(j1.feature, "Swap"); assert.equal(j1.credits, 80); assert.equal(j1.cost_usd, 0.5); assert.equal(j1.cost_source, "billed");
  assert.ok(j1.worth_usd > 0 && Math.abs(j1.profit_usd! - (j1.worth_usd - 0.5)) < 1e-3 && Math.abs(j1.margin! - (j1.worth_usd - 0.5) / j1.worth_usd) < 1e-3);
  assert.equal(j1.render_s, 120); assert.equal(j1.via, "tool");
  // a date range
  const t = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();
  const week = adminLog(d, { from: t(2.5), to: t(0) }, ENV);
  assert.deepEqual(week.rows.map((r) => r.id).sort(), d.jobs.filter((j) => j.user_id !== ME && Date.parse(j.created_at) >= Date.parse(t(2.5))).map((j) => j.id).sort());
  // totals add up over every row, not just the page
  const many: AdminData = { ...d, jobs: Array.from({ length: 120 }, (_, i) => ({ id: `k${i}`, user_id: A, tool: "kage_motion", status: "done", options: { cost_usd: 2, brief: "=cmd" }, credits_charged: 560, progress: {}, outputs: [], created_at: ago(1, i) })) };
  const p1 = adminLog(many, {}, ENV), p3 = adminLog(many, { page: 3 }, ENV), p9 = adminLog(many, { page: 9 }, ENV);
  assert.equal(p1.rows.length, 50); assert.equal(p1.pages, 3); assert.equal(p3.rows.length, 20); assert.equal(p9.page, 3, "a page past the end is the last page");
  assert.equal(p1.totals.jobs, 120); assert.equal(p1.totals.cost_usd, 240); assert.equal(p1.totals.credits, 67200);
  assert.equal(p1.rows[0].id, "k0"); assert.equal(p3.rows[19].id, "k119");
  // a finished job with no cost on record has no profit figure, and is counted as unpriced
  const odd = adminLog({ ...d, jobs: [{ id: "c1", user_id: A, tool: "mystery", status: "done", options: {}, credits_charged: 200, progress: {}, outputs: [], created_at: ago(1) }] }, {}, ENV);
  assert.equal(odd.rows[0].cost_usd, null); assert.equal(odd.rows[0].profit_usd, null); assert.equal(odd.totals.unpriced, 1); assert.equal(odd.totals.margin, null);
  // Clips and Captions: the download (tagged with the job), the Claude calls made while it ran, the transcript and the clips made
  const t0 = Date.parse(ago(1));
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const worker: AdminData = { ...d,
    jobs: [
      { id: "c1", user_id: A, tool: "clips", status: "done", options: { seconds: 3600 }, credits_charged: 200, progress: {}, outputs: [{}, {}, {}, {}, {}], created_at: at(0), finished_at: at(20) },
      { id: "c2", user_id: A, tool: "clips", status: "failed", options: { seconds: 3600 }, credits_charged: 0, progress: {}, outputs: [], created_at: at(60), finished_at: at(70) },
      { id: "c3", user_id: A, tool: "captions", status: "done", options: { seconds: 60 }, credits_charged: 10, progress: {}, outputs: [{}], created_at: at(120), finished_at: at(122) },
    ],
    events: [
      { user_id: A, kind: "vendor", name: "youtube_proxy", usd: 0.9, props: { job: "c1" }, created_at: at(2) },
      { user_id: A, kind: "claude", name: "clips_choose", usd: 0.4, props: {}, created_at: at(-5) }, // priced on the page just before it was queued
      { user_id: A, kind: "claude", name: "clips_frame", usd: 0.01, props: {}, created_at: at(10) },
      { user_id: A, kind: "vendor", name: "youtube_proxy", usd: 0.5, props: { job: "c2" }, created_at: at(62) },
      { user_id: A, kind: "claude", name: "captions_keys", usd: 0.001, props: {}, created_at: at(121) },
      { user_id: A, kind: "claude", name: "assistant", usd: 5, props: {}, created_at: at(5) }, // a chat at the same time is not the job's
      { user_id: B, kind: "claude", name: "clips_choose", usd: 7, props: {}, created_at: at(5) }, // someone else's
    ] };
  const w = new Map(adminLog(worker, {}, ENV).rows.map((r) => [r.id, r]));
  assert.equal(w.get("c1")!.cost_source, "calls"); assert.equal(w.get("c1")!.cost_usd, Math.round((0.9 + 0.4 + 0.01 + 0.22 + 5 * 0.004) * 1e4) / 1e4);
  assert.ok(w.get("c1")!.profit_usd != null && w.get("c1")!.margin != null);
  assert.equal(w.get("c2")!.cost_usd, 0.5, "a failed run still paid for its download"); assert.ok(w.get("c2")!.profit_usd! < 0);
  assert.equal(w.get("c3")!.cost_usd, Math.round((0.001 + (60 / 3600) * 0.22) * 1e4) / 1e4);
  // the panel's totals count those calls once, as before: the job itself adds nothing to them
  const tot = computeAdmin(worker, { days: 30, includeInternal: true, now: NOW }, ENV);
  assert.equal(tot.costs.generation_usd, 0);
  assert.ok(Math.abs(tot.tools.find((x) => x.tool === "clips")!.cost_usd - (0.9 + 0.4 + 0.01 + 0.22 + 0.02 + 0.5)) < 0.011, "the Clips row of the tools table shows it");
  // the spreadsheet: a header, every row, formulas made plain
  const csv = adminLogCsv(many, {}, ENV).trim().split("\r\n");
  assert.equal(csv.length, 121); assert.ok(csv[0].startsWith("time_utc,email,country,feature,detail,status"));
  assert.ok(csv[1].includes("ann@example.com") && csv[1].includes("Kage Motion · =cmd"), csv[1]);
  assert.ok(adminLogCsv({ ...many, users: [{ ...d.users[0], email: "=evil@x.com" }, ...d.users.slice(1)] }, {}, ENV).includes(",'=evil@x.com,"));
});

test("the log route: the owner only; pages, one person, and a csv download", async () => {
  clearAdminCacheForTests();
  const app = express();
  let who: any = null;
  app.use((req, _res, next) => { (req as any).auth = who; next(); });
  const sb = { auth: { admin: { getUserById: async (id: string) => ({ data: { user: id === ME ? { id: ME, email: "support@clone8.io", email_confirmed_at: ago(1) } : { id, email: "ann@example.com", email_confirmed_at: ago(1) } } }) } } } as any;
  registerStudioAdmin(app, () => sb, { env: ENV, load: async () => data() });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}/api/studio/admin/log`;
  try {
    who = { user_id: A, email: "ann@example.com" };
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(`${base}?format=csv`)).status, 404);
    who = { user_id: ME, email: "support@clone8.io" };
    const body: any = await (await fetch(`${base}?user=${A}`)).json();
    assert.ok(body.total > 0 && body.rows.every((r: any) => r.user_id === A) && body.per === 50);
    assert.equal((await fetch(`${base}?user=nope`)).status, 400);
    const none: any = await (await fetch(`${base}?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`)).json();
    assert.equal(none.total, 0); assert.equal(none.pages, 1);
    const csv = await fetch(`${base}?user=${A}&format=csv`);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/); assert.match(csv.headers.get("content-disposition") ?? "", /attachment; filename="clone8-activity-/);
    assert.equal((await csv.text()).trim().split("\r\n").length, body.total + 1);
  } finally { srv.close(); }
});
