import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { accountAccess } from "../src/account-access.js";
import { registerStudio, quote, planForPrice, priceIdFor, subscriptionSnapshot, invoiceSubscriptionId, applyStripeEvent, PLANS, COSTS } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ENV = { STUDIO_BLUEPRINT_ENABLED: "true", HIGGSFIELD_API_KEY: "hf_test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", DASHBOARD_URL: "https://app.clone8.io",
  STRIPE_PRICE_STARTER_MONTH: "price_sm", STRIPE_PRICE_STARTER_YEAR: "price_sy", STRIPE_PRICE_CREATOR_MONTH: "price_cm", STRIPE_PRICE_CREATOR_YEAR: "price_cy",
  STRIPE_PRICE_STUDIO_MONTH: "price_um", STRIPE_PRICE_STUDIO_YEAR: "price_uy" };

// A small in-memory Supabase stand-in: filters by eq/in/neq/gte, records writes and rpc calls, answers rpc.
function fakeSb(tables: Record<string, any[]>, rpc: (name: string, args: any) => { data: any; error: any }) {
  const writes: any[] = [], calls: any[] = [];
  const sb: any = {
    writes, calls,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return rpc(name, args); },
    storage: { from: () => ({ createSignedUploadUrl: async (key: string) => ({ data: { token: "tok", path: key }, error: null }), createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }),
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }), list: async () => ({ data: [{ name: `${ASSET}.mp4`, metadata: { size: 1234 } }], error: null }), remove: async () => ({ data: null, error: null }) }) },
    from(table: string) {
      let rows = () => tables[table] ?? [];
      const filters: ((r: any) => boolean)[] = [];
      let single = false, maybe = false, pending: any = null, head = false;
      const q: any = {
        select(_c?: any, o?: any) { if (o?.head) head = true; return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { table, op: "insert", v }; rows = () => (Array.isArray(v) ? v : [v]); return q; },
        upsert(v: any) { pending = { table, op: "upsert", v }; rows = () => [v]; return q; },
        update(v: any) { pending = { table, op: "update", v }; return q; },
        then(resolve: any, reject: any) {
          if (pending) { writes.push({ ...pending, filters: filters.length }); if (pending.op === "insert" && table === "studio_stripe_events" && (tables[table] ?? []).some((r) => r.id === pending.v.id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(resolve, reject); if (pending.op === "insert") (tables[table] ??= []).push(pending.v); }
          const out = rows().filter((r) => filters.every((f) => f(r)));
          const data = head ? null : single || maybe ? (out[0] ?? null) : out;
          return Promise.resolve({ data, error: single && !out.length ? { message: "no rows" } : null, count: head ? out.length : null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return sb;
}
function fakeStripe(subs: Record<string, any> = {}) {
  const created: any[] = [];
  return { created, checkout: { sessions: { create: async (p: any) => { created.push(p); return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" }; } } },
    billingPortal: { sessions: { create: async (p: any) => ({ url: `https://billing.stripe.com/${p.customer}` }) } },
    subscriptions: { retrieve: async (id: string) => subs[id] ?? Promise.reject(new Error("no such subscription")) },
    webhooks: { constructEvent: (raw: string, sig: string) => { if (sig !== "good") throw new Error("No signatures found"); return JSON.parse(raw); } } };
}
async function serve(sb: any, stripe: any) {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) { req.auth = { user_id: u, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: u }; } next(); });
  app.use(accountAccess(() => sb));
  registerStudio(app, () => sb, { stripe, env: ENV, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}
const sub = (over: any = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: { user_id: ANN },
  items: { data: [{ price: { id: "price_cm", recurring: { interval: "month" } }, current_period_start: 1761523200, current_period_end: 1764115200 }] }, ...over });

test("quotes: blueprint by copies, recast by seconds, with validation", () => {
  const video = { kind: "video", probe: { duration: 23.4 } };
  assert.deepEqual(quote("blueprint", { copies: 25 }, video).credits, 25 * COSTS.blueprint_copy);
  assert.equal(quote("blueprint_plus", { copies: "3" }, video).credits, 3 * COSTS.blueprint_plus_copy);
  assert.throws(() => quote("blueprint", { copies: 0 }, video), { code: "invalid_copies" });
  assert.throws(() => quote("blueprint", { copies: 51 }, video), { code: "invalid_copies" });
  assert.throws(() => quote("blueprint", { copies: 1 }, { kind: "image" }), { code: "asset_required" });
  const r = quote("recast", { character: "noah" }, video);
  assert.deepEqual([r.credits, r.options.seconds, r.options.model], [24 * COSTS.recast_second, 24, "full"]);
  assert.equal(quote("recast", { character: "noah", model: "light" }, { kind: "video", probe: { duration: 40 } }).credits, 15 * COSTS.recast_light_second, "light caps at 15 s");
  assert.throws(() => quote("recast", {}, video), { code: "character_required" });
  assert.throws(() => quote("recast", { character: "noah" }, { kind: "video" }), { code: "asset_not_inspected" });
  assert.throws(() => quote("poster", {}, video), { code: "unknown_tool" });
});

test("price ids map to plans and intervals from the environment", () => {
  assert.equal(priceIdFor("creator", "year", ENV), "price_cy");
  assert.deepEqual([planForPrice("price_um", ENV)?.plan.id, planForPrice("price_um", ENV)?.interval], ["studio", "month"]);
  assert.equal(planForPrice("price_nope", ENV), null);
  assert.equal(PLANS.length, 3);
});

test("subscription and invoice shapes from the 2026 API are read correctly", () => {
  process.env.STRIPE_PRICE_CREATOR_MONTH = "price_cm";
  const s = subscriptionSnapshot(sub());
  assert.deepEqual([s.plan?.id, s.interval, s.period_start, s.period_end, s.customer, s.user_id], ["creator", "month", "2025-10-27T00:00:00.000Z", "2025-11-26T00:00:00.000Z", "cus_1", ANN]);
  assert.equal(invoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_9" } } }), "sub_9");
  assert.equal(invoiceSubscriptionId({ subscription: { id: "sub_8" } }), "sub_8");
  assert.equal(invoiceSubscriptionId({}), null);
  delete process.env.STRIPE_PRICE_CREATOR_MONTH;
});

test("checkout links the customer, subscription events mirror the plan, paid invoices grant credits once", async () => {
  process.env.STRIPE_PRICE_CREATOR_MONTH = "price_cm";
  const tables: Record<string, any[]> = { studio_customers: [] };
  const sb = fakeSb(tables, (name) => ({ data: name === "studio_grant" ? { granted: true } : {}, error: null }));
  const stripe = fakeStripe({ sub_1: sub() });
  assert.match(await applyStripeEvent(sb, stripe, { type: "checkout.session.completed", data: { object: { customer: "cus_1", subscription: "sub_1", metadata: { user_id: ANN } } } }), /creator active/);
  assert.equal(sb.writes[0].op, "upsert"); assert.equal(sb.writes[0].v.stripe_customer_id, "cus_1");
  const apply = sb.calls.find((c: any) => c.name === "studio_apply_subscription");
  assert.deepEqual([apply.args.p_user, apply.args.p_plan, apply.args.p_status, apply.args.p_credits_per_period, apply.args.p_parallel], [ANN, "creator", "active", 3500, 2]);
  tables.studio_customers.push({ user_id: ANN, stripe_customer_id: "cus_1" });
  assert.match(await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } } } }), /granted 3500/);
  const grant = sb.calls.find((c: any) => c.name === "studio_grant");
  assert.deepEqual([grant.args.p_user, grant.args.p_credits, grant.args.p_ref, grant.args.p_expire_previous], [ANN, 3500, "in_1", true]);
  const upgrade = sb.calls.length;
  await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_2", customer: "cus_1", billing_reason: "subscription_update", parent: { subscription_details: { subscription: "sub_1" } } } } });
  assert.equal(sb.calls.slice(upgrade).find((c: any) => c.name === "studio_grant").args.p_expire_previous, false, "an upgrade mid-cycle adds credits without expiring the rest");
  assert.match(await applyStripeEvent(sb, stripe, { type: "customer.subscription.deleted", data: { object: sub({ status: "canceled", metadata: {} }) } }), /canceled/);
  assert.equal(await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_3", customer: "cus_other", parent: { subscription_details: { subscription: "sub_1" } } } } }), "invoice for unknown customer");
  assert.equal(await applyStripeEvent(sb, stripe, { type: "payment_intent.created", data: { object: {} } }), "ignored");
  delete process.env.STRIPE_PRICE_CREATOR_MONTH;
});

test("routes: gate, plans, checkout, webhook idempotency, jobs and assets", async (t) => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, stripe_customer_id: "cus_1", status: "active", plan_id: "creator", onboarding: {} }],
    studio_assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", probe: { duration: 10 }, object_key: `${ANN}/${ASSET}.mp4`, bytes: 1 }], studio_jobs: [], studio_credit_ledger: [], studio_stripe_events: [] };
  const sb = fakeSb(tables, (name, args) => {
    if (name === "studio_balance") return { data: 900, error: null };
    if (name === "studio_create_job") return args.p_credits > 900 ? { data: null, error: { message: "insufficient_credits" } } : { data: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "queued", tool: args.p_tool, credits_reserved: args.p_credits, options: args.p_options, outputs: [] }, error: null };
    if (name === "studio_redeem_promo") return { data: { code: args.p_code, credits: 50, balance: 950 }, error: null };
    return { data: {}, error: null };
  });
  const stripe = fakeStripe({ sub_1: sub() });
  const s = await serve(sb, stripe); t.after(s.close);
  assert.equal((await s.call("GET", "/api/studio/plans")).status, 200, "plans are public");
  assert.equal((await s.call("GET", "/api/studio/me")).status, 401, "everything else needs a session");
  const me = await s.call("GET", "/api/studio/me", undefined, { "x-test-user": ANN });
  assert.equal(me.status, 200); assert.equal(me.body.balance, 900); assert.equal(me.body.active, true); assert.equal(me.body.subscription.plan.id, "creator");
  assert.equal((await s.call("POST", "/api/studio/checkout", { plan: "studio" }, { "x-test-user": ANN })).body.error, "already_subscribed");
  tables.studio_customers[0].status = "canceled";
  const co = await s.call("POST", "/api/studio/checkout", { plan: "studio", interval: "year" }, { "x-test-user": ANN });
  assert.equal(co.status, 200); assert.equal(co.body.url, "https://checkout.stripe.com/cs_1");
  assert.deepEqual([stripe.created[0].line_items[0].price, stripe.created[0].customer, stripe.created[0].metadata.user_id, stripe.created[0].mode], ["price_uy", "cus_1", ANN, "subscription"]);
  assert.equal("customer_creation" in stripe.created[0], false, "subscription mode refuses customer_creation");
  tables.studio_customers[0].stripe_customer_id = null;
  await s.call("POST", "/api/studio/checkout", { plan: "starter" }, { "x-test-user": ANN });
  assert.deepEqual([stripe.created[1].customer, stripe.created[1].customer_email, "customer_creation" in stripe.created[1]], [undefined, "ann@synthetic.invalid", false], "a first-time buyer is identified by email only");
  tables.studio_customers[0].stripe_customer_id = "cus_1";
  assert.equal((await s.call("POST", "/api/studio/checkout", { plan: "gold" }, { "x-test-user": ANN })).body.error, "unknown_plan");
  assert.equal((await s.call("POST", "/api/studio/portal", {}, { "x-test-user": ANN })).body.url, "https://billing.stripe.com/cus_1");
  const ev = { id: "evt_1", type: "customer.subscription.updated", data: { object: sub() } };
  assert.equal((await s.call("POST", "/api/studio/stripe/webhook", ev, { "stripe-signature": "bad" })).status, 400);
  assert.deepEqual((await s.call("POST", "/api/studio/stripe/webhook", ev, { "stripe-signature": "good" })).body, { received: true });
  assert.deepEqual((await s.call("POST", "/api/studio/stripe/webhook", ev, { "stripe-signature": "good" })).body, { received: true, duplicate: true }, "the same event twice is a no-op");
  tables.studio_customers[0].status = "active";
  const q = await s.call("POST", "/api/studio/quote", { tool: "blueprint", asset_id: ASSET, options: { copies: 10 } }, { "x-test-user": ANN });
  assert.equal(q.body.credits, 40);
  const job = await s.call("POST", "/api/studio/jobs", { tool: "blueprint", asset_id: ASSET, options: { copies: 10 } }, { "x-test-user": ANN });
  assert.equal(job.status, 201); assert.equal(job.body.job.credits_reserved, 40);
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "blueprint", asset_id: ASSET, options: { copies: 50 } }, { "x-test-user": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).body.error, "asset_not_found", "another person's asset");
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "recast", asset_id: ASSET, options: { character: "noah", model: "full" } }, { "x-test-user": ANN })).status, 201);
  const up = await s.call("POST", "/api/studio/assets/upload-url", { name: "clip.mp4", size: 1234, type: "video/mp4" }, { "x-test-user": ANN });
  assert.equal(up.status, 200); assert.match(up.body.key, new RegExp(`^${ANN}/[0-9a-f-]{36}\\.mp4$`));
  assert.equal((await s.call("POST", "/api/studio/assets/upload-url", { name: "x.exe", size: 10, type: "" }, { "x-test-user": ANN })).body.error, "invalid_file");
  assert.equal((await s.call("POST", `/api/studio/assets/${ASSET}/complete`, {}, { "x-test-user": ANN })).body.asset?.status ?? "ready", "ready");
  assert.equal((await s.call("POST", "/api/studio/promo", { code: "launch50" }, { "x-test-user": ANN })).body.credits, 50);
  assert.equal((await s.call("POST", "/api/studio/promo", { code: "x" }, { "x-test-user": ANN })).body.error, "invalid_code");
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "blueprint_plus", asset_id: ASSET, options: { copies: 2 } }, { "x-test-user": ANN })).body.error, "tool_not_open", "a tool without a worker refuses jobs");
  assert.deepEqual((await s.call("GET", "/api/studio/plans")).body.tools, { blueprint: true, blueprint_plus: false, recast: true });
});
