import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { accountAccess, selfAuthenticatedPost } from "../src/account-access.js";
import { registerStudio, quote, planForPrice, priceIdFor, subscriptionSnapshot, invoiceSubscriptionId, applyStripeEvent, downloadBase, billableSeconds, studioOverview, PLANS, COSTS } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ENV = { STUDIO_BLUEPRINT_ENABLED: "true", HIGGSFIELD_API_KEY: "hf_test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", DASHBOARD_URL: "https://app.clone8.io", STRIPE_PRICE_PACK_500: "price_p500", STRIPE_PRICE_PACK_2000: "price_p2000",
  STRIPE_PRICE_STARTER_MONTH: "price_sm", STRIPE_PRICE_STARTER_YEAR: "price_sy", STRIPE_PRICE_CREATOR_MONTH: "price_cm", STRIPE_PRICE_CREATOR_YEAR: "price_cy",
  STRIPE_PRICE_STUDIO_MONTH: "price_um", STRIPE_PRICE_STUDIO_YEAR: "price_uy" };

// A small in-memory Supabase stand-in: filters by eq/in/neq/gte, records writes and rpc calls, answers rpc.
function fakeSb(tables: Record<string, any[]>, rpc: (name: string, args: any) => { data: any; error: any }) {
  const writes: any[] = [], calls: any[] = [];
  const sb: any = {
    writes, calls,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return rpc(name, args); },
    storage: { from: () => ({ createSignedUploadUrl: async (key: string) => ({ data: { token: "tok", path: key }, error: null }),
      createSignedUrl: async (k: string, _e: number, o?: any) => ({ data: { signedUrl: `https://signed/${k}${o?.download ? `?download=${encodeURIComponent(o.download)}` : ""}` }, error: null }),
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
      // Storage listings answer with whatever was searched for, so an upload or a poster "exists" when asked about.
      list: async (_dir: string, o?: any) => ({ data: [{ name: o?.search ?? `${ASSET}.mp4`, metadata: { size: 1234 } }], error: null }), remove: async () => ({ data: null, error: null }) }) },
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
          if (pending) { writes.push({ ...pending, filters: filters.length }); if (pending.op === "insert" && table === "studio_stripe_events" && (tables[table] ?? []).some((r) => r.id === pending.v.id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(resolve, reject); if (pending.op === "insert") (tables[table] ??= []).push(pending.v); if (pending.op === "update") for (const r of (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))) Object.assign(r, pending.v); }
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
  assert.deepEqual([r.credits, r.options.seconds, r.options.model], [24 * COSTS.recast_second, 24, "full"], "a 23.4 s file bills 24 s at Higgsfield (container rounding)");
  assert.deepEqual([billableSeconds(4, 30), billableSeconds(3.7, 30), billableSeconds(15.27, 15), billableSeconds(30, 30), billableSeconds(0, 30)], [5, 4, 15, 30, 1]);
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
  // An invoice for a customer we have not linked yet, whose subscription names the person: linked and granted (the webhook race).
  assert.match(await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_3", customer: "cus_other", parent: { subscription_details: { subscription: "sub_1" } } } } }), /granted 3500/);
  assert.ok(sb.writes.some((w: any) => w.table === "studio_customers" && w.op === "upsert" && w.v.stripe_customer_id === "cus_other"), "the link is written from the subscription's user id");
  assert.equal(await applyStripeEvent(sb, stripe, { type: "payment_intent.created", data: { object: {} } }), "ignored");
  // Annual billing: one invoice a year pays for twelve months of credits, granted at once.
  process.env.STRIPE_PRICE_CREATOR_YEAR = "price_cy";
  const annual = fakeStripe({ sub_1: sub({ items: { data: [{ price: { id: "price_cy", recurring: { interval: "year" } }, current_period_start: 1761523200, current_period_end: 1793059200 }] } }) });
  assert.match(await applyStripeEvent(sb, annual, { type: "invoice.paid", data: { object: { id: "in_year", customer: "cus_1", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } } } }), /granted 42000/);
  const year = sb.calls.filter((c: any) => c.name === "studio_grant").at(-1);
  assert.deepEqual([year.args.p_credits, year.args.p_ref, year.args.p_expire_previous, year.args.p_note], [42000, "in_year", true, "Creator annual subscription_create"]);
  delete process.env.STRIPE_PRICE_CREATOR_MONTH; delete process.env.STRIPE_PRICE_CREATOR_YEAR;
});

test("Stripe's webhook is exempt from both request guards; everything else still needs a session", async (t) => {
  assert.equal(selfAuthenticatedPost("/api/studio/stripe/webhook", "POST"), true);
  assert.equal(selfAuthenticatedPost("/api/studio/stripe/webhook/", "POST"), true, "a trailing slash is the same route");
  assert.equal(selfAuthenticatedPost("/api/studio/stripe/webhook", "GET"), false);
  assert.equal(selfAuthenticatedPost("/api/creatorvault/webhook", "POST"), true);
  assert.equal(selfAuthenticatedPost("/api/public/invite-requests", "POST"), true);
  assert.equal(selfAuthenticatedPost("/api/public/funnel-events", "POST"), true);
  for (const p of ["/api/studio/checkout", "/api/studio/jobs", "/api/studio/promo", "/api/studio/me"]) assert.equal(selfAuthenticatedPost(p, "POST"), false, p);
  // The production chain: the access boundary, then the mutation guard from routes.ts, then the Studio routes.
  const sb = fakeSb({ studio_customers: [], studio_stripe_events: [] }, () => ({ data: {}, error: null }));
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(accountAccess(() => sb));
  app.use((req: any, res, next) => { if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.path.startsWith("/api/") || selfAuthenticatedPost(req.path, req.method) || req.auth) return next(); res.status(401).json({ error: "unauthorized" }); });
  registerStudio(app, () => sb, { stripe: fakeStripe(), env: ENV, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (path: string, headers: Record<string, string> = {}) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Stripe/1.0", ...headers }, body: JSON.stringify({ id: "evt_x", type: "invoice.paid", data: { object: {} } }) })).status;
  assert.equal(await post("/api/studio/stripe/webhook", { "stripe-signature": "bad" }), 400, "reaches the handler, which rejects the signature itself");
  assert.equal(await post("/api/studio/stripe/webhook", { "stripe-signature": "good" }), 200);
  assert.equal(await post("/api/studio/checkout"), 401, "a sessionless POST anywhere else is refused");
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
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "recast", asset_id: ASSET, options: { character: "noah", model: "light" } }, { "x-test-user": ANN })).status, 201);
  const up = await s.call("POST", "/api/studio/assets/upload-url", { name: "clip.mp4", size: 1234, type: "video/mp4" }, { "x-test-user": ANN });
  assert.equal(up.status, 200); assert.match(up.body.key, new RegExp(`^${ANN}/[0-9a-f-]{36}\\.mp4$`));
  assert.equal((await s.call("POST", "/api/studio/assets/upload-url", { name: "x.exe", size: 10, type: "" }, { "x-test-user": ANN })).body.error, "invalid_file");
  // Plan limits (studio-limits.ts): Ann is on Creator (200 files, 30 GB, 40 jobs an hour). Fill the library, then the hour.
  const kept = tables.studio_assets.length;
  for (let i = 0; i < 200; i++) tables.studio_assets.push({ id: `${i}`, user_id: ANN, kind: "video", status: i % 2 ? "ready" : "uploading", bytes: 1 });
  assert.equal((await s.call("POST", "/api/studio/assets/upload-url", { name: "clip.mp4", size: 1234, type: "video/mp4" }, { "x-test-user": ANN })).body.error, "too_many_files");
  tables.studio_assets.length = kept;
  tables.studio_assets.push({ id: "big", user_id: ANN, kind: "video", status: "ready", bytes: 30 * 1024 ** 3 - 100 });
  const full = await s.call("POST", "/api/studio/assets/upload-url", { name: "clip.mp4", size: 1234, type: "video/mp4" }, { "x-test-user": ANN });
  assert.equal(full.status, 409); assert.equal(full.body.error, "storage_full");
  tables.studio_assets.pop();
  for (let i = 0; i < 40; i++) tables.studio_jobs.push({ id: `j${i}`, user_id: ANN, tool: "blueprint", status: "done", created_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  const limited = await s.call("POST", "/api/studio/jobs", { tool: "blueprint", asset_id: ASSET, options: { copies: 1 } }, { "x-test-user": ANN });
  assert.equal(limited.status, 429); assert.equal(limited.body.error, "rate_limited");
  tables.studio_jobs.length = 0;
  assert.equal((await s.call("POST", `/api/studio/assets/${ASSET}/complete`, {}, { "x-test-user": ANN })).body.asset?.status ?? "ready", "ready");
  assert.equal((await s.call("POST", "/api/studio/promo", { code: "launch50" }, { "x-test-user": ANN })).body.credits, 50);
  assert.equal((await s.call("POST", "/api/studio/promo", { code: "x" }, { "x-test-user": ANN })).body.error, "invalid_code");
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "blueprint_plus", asset_id: ASSET, options: { copies: 2 } }, { "x-test-user": ANN })).body.error, "tool_not_open", "a tool without a worker refuses jobs");
  assert.deepEqual((await s.call("GET", "/api/studio/plans")).body.tools, { blueprint: true, blueprint_plus: false, recast: true, recast_full: false, swap: true, restyle: true, trend: true, character: true, instrument: false });
  assert.equal((await s.call("POST", "/api/studio/jobs", { tool: "recast", asset_id: ASSET, options: { character: "noah", model: "full" } }, { "x-test-user": ANN })).body.error, "model_not_open", "the full model is closed until measured");
});

test("download names come from the upload's name and the tool", () => {
  assert.equal(downloadBase("v12044gd0000davhid7og65ts4lhv3b0.MP4", "blueprint"), "v12044gd0000davhid7og65ts4lhv3b0-copy");
  assert.equal(downloadBase("My clip (final) v2.mov", "blueprint"), "My-clip-final-v2-copy");
  assert.equal(downloadBase(null, "recast"), "clone8-recast");
  assert.equal(downloadBase("../../etc/passwd", "blueprint"), "etc-passwd-copy");
});

test("routes: uploads carry the browser's probe and poster; finished jobs list posters and name their downloads", async (t) => {
  const DONE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const outputs = [1, 2].map((i) => ({ index: i, key: `${ANN}/${DONE}/lease/${i}.mp4`, poster_key: `${ANN}/${DONE}/lease/${i}.jpg`, bytes: 10, duration: 9.9 }));
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, stripe_customer_id: "cus_1", status: "active", plan_id: "creator", onboarding: {} }],
    studio_assets: [{ id: ASSET, user_id: ANN, kind: "video", name: "Morning routine.MP4", status: "uploading", probe: null, object_key: `${ANN}/${ASSET}.mp4`, bytes: 1 }],
    studio_jobs: [{ id: DONE, user_id: ANN, tool: "blueprint", status: "done", asset_id: ASSET, options: { copies: 2 }, credits_reserved: 8, credits_charged: 8, progress: { done: 2, total: 2 }, outputs, error_code: null, created_at: "2026-10-28T21:45:30Z", started_at: null, finished_at: null }],
    studio_credit_ledger: [], studio_stripe_events: [] };
  const sb = fakeSb(tables, (name) => ({ data: name === "studio_balance" ? 900 : {}, error: null }));
  const s = await serve(sb, fakeStripe()); t.after(s.close);
  const poster = await s.call("POST", `/api/studio/assets/${ASSET}/poster-url`, {}, { "x-test-user": ANN });
  assert.equal(poster.status, 200); assert.equal(poster.body.key, `${ANN}/assets/${ASSET}.jpg`); assert.equal(poster.body.bucket, "studio-outputs");
  const done = await s.call("POST", `/api/studio/assets/${ASSET}/complete`, { probe: { duration: 14.1, width: 1080, height: 1920, junk: "x" }, poster: true }, { "x-test-user": ANN });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.asset.probe, { duration: 14.1, width: 1080, height: 1920, poster_key: `${ANN}/assets/${ASSET}.jpg` });
  assert.equal(done.body.asset.poster_url, `https://signed/${ANN}/assets/${ASSET}.jpg`);
  const listed = await s.call("GET", "/api/studio/assets", undefined, { "x-test-user": ANN });
  assert.equal(listed.body.assets[0].poster_url, `https://signed/${ANN}/assets/${ASSET}.jpg`);
  const jobs = await s.call("GET", "/api/studio/jobs", undefined, { "x-test-user": ANN });
  assert.equal(jobs.body.jobs[0].asset_name, "Morning routine.MP4");
  assert.equal(jobs.body.jobs[0].outputs[0].poster_url, `https://signed/${ANN}/${DONE}/lease/1.jpg`, "the list carries posters");
  assert.equal(jobs.body.jobs[0].outputs[0].url, undefined, "but not video links");
  const job = await s.call("GET", `/api/studio/jobs/${DONE}`, undefined, { "x-test-user": ANN });
  assert.equal(job.body.job.outputs[1].url, `https://signed/${ANN}/${DONE}/lease/2.mp4?download=Morning-routine-copy-02.mp4`);
  assert.equal(job.body.job.outputs[1].poster_url, `https://signed/${ANN}/${DONE}/lease/2.jpg`);
});

test("credit packs: a payment-mode checkout, granted once by the webhook, only with an active plan", async (t) => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, stripe_customer_id: "cus_1", status: "active", plan_id: "creator", onboarding: {} }], studio_assets: [], studio_jobs: [], studio_credit_ledger: [], studio_stripe_events: [] };
  const sb = fakeSb(tables, (name) => ({ data: name === "studio_balance" ? 900 : name === "studio_grant" ? { granted: true } : {}, error: null }));
  const stripe = fakeStripe();
  const s = await serve(sb, stripe); t.after(s.close);
  const catalog = await s.call("GET", "/api/studio/plans");
  assert.deepEqual(catalog.body.packs.map((p: any) => [p.id, p.credits, p.usd, p.available]), [["pack_500", 500, 19, true], ["pack_2000", 2000, 59, true], ["pack_6000", 6000, 149, false]]);
  const co = await s.call("POST", "/api/studio/checkout-pack", { pack: "pack_2000" }, { "x-test-user": ANN });
  assert.equal(co.status, 200); assert.equal(co.body.url, "https://checkout.stripe.com/cs_1");
  const created = stripe.created.at(-1);
  assert.deepEqual([created.mode, created.line_items[0].price, created.customer, created.metadata.pack, created.metadata.credits], ["payment", "price_p2000", "cus_1", "pack_2000", "2000"]);
  assert.equal((await s.call("POST", "/api/studio/checkout-pack", { pack: "pack_6000" }, { "x-test-user": ANN })).status, 503, "an unconfigured pack");
  assert.equal((await s.call("POST", "/api/studio/checkout-pack", { pack: "pack_9" }, { "x-test-user": ANN })).body.error, "unknown_pack");
  tables.studio_customers[0].status = "canceled";
  assert.equal((await s.call("POST", "/api/studio/checkout-pack", { pack: "pack_500" }, { "x-test-user": ANN })).body.error, "subscription_required");
  const ev = { id: "evt_pack", type: "checkout.session.completed", data: { object: { id: "cs_pack_1", mode: "payment", payment_status: "paid", customer: "cus_1", metadata: { user_id: ANN, pack: "pack_2000", credits: "2000" } } } };
  assert.deepEqual((await s.call("POST", "/api/studio/stripe/webhook", ev, { "stripe-signature": "good" })).body, { received: true });
  const grant = sb.calls.find((c: any) => c.name === "studio_grant");
  assert.deepEqual([grant.args.p_user, grant.args.p_credits, grant.args.p_ref, grant.args.p_expire_previous, grant.args.p_note], [ANN, 2000, "cs_pack_1", false, "2,000 credits pack"]);
  assert.deepEqual((await s.call("POST", "/api/studio/stripe/webhook", ev, { "stripe-signature": "good" })).body, { received: true, duplicate: true });
  const unpaid = { id: "evt_pack2", type: "checkout.session.completed", data: { object: { id: "cs_pack_2", mode: "payment", payment_status: "unpaid", customer: "cus_1", metadata: { user_id: ANN, pack: "pack_500" } } } };
  await s.call("POST", "/api/studio/stripe/webhook", unpaid, { "stripe-signature": "good" });
  assert.equal(sb.calls.filter((c: any) => c.name === "studio_grant").length, 1, "an unpaid session grants nothing");
});

test("the operator overview: customers with plan and balance, run-rate, tools, failures, refunds and packs", async () => {
  const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const tables: Record<string, any[]> = {
    studio_customers: [{ user_id: ANN, plan_id: "creator", billing_interval: "year", status: "active", onboarding: { intent: "blueprint" }, created_at: "2026-10-01T00:00:00Z" }, { user_id: BOB, plan_id: "starter", billing_interval: "month", status: "canceled", onboarding: {}, created_at: "2026-10-02T00:00:00Z" }],
    studio_jobs: [{ id: "j1", user_id: ANN, tool: "blueprint", status: "done", credits_reserved: 20, credits_charged: 20, options: { copies: 5 }, created_at: "2026-10-28T00:00:00Z", started_at: "2026-10-28T00:00:00Z", finished_at: "2026-10-28T00:02:00Z" }, { id: "j2", user_id: ANN, tool: "recast", status: "failed", error_code: "recast_nsfw", credits_reserved: 165, credits_charged: 0, options: {}, created_at: "2026-10-28T01:00:00Z" }],
    studio_credit_ledger: [{ user_id: ANN, delta: 2000, reason: "grant", note: "2,000 credits pack", created_at: "2026-10-28T00:00:00Z" }, { user_id: ANN, delta: 165, reason: "refund", note: "recast_nsfw", created_at: "2026-10-28T01:00:00Z" }, { user_id: ANN, delta: 42000, reason: "grant", note: "Creator annual subscription_create", created_at: "2026-10-28T00:00:00Z" }],
  };
  const sb = fakeSb(tables, (name, args) => ({ data: name === "studio_balance" ? (args.p_user === ANN ? 41980 : 0) : {}, error: null }));
  sb.auth = { admin: { listUsers: async () => ({ data: { users: [{ id: ANN, email: "ann@synthetic.invalid" }] } }) } };
  const o = await studioOverview(sb, ENV, new Date("2026-10-29T00:00:00Z"));
  assert.deepEqual(o.totals, { customers: 2, active: 1, mrr_usd: 66, jobs_30d: 2, failed_30d: 1, credits_charged_30d: 20, refunded_30d: 165, pack_credits_30d: 2000, pack_sales_30d: 1 });
  assert.deepEqual(o.failures, [{ code: "recast_nsfw", count: 1 }]);
  assert.equal(o.tools.find((t: any) => t.tool === "blueprint").avg_seconds, 120);
  const ann = o.customers.find((c: any) => c.user_id === ANN);
  assert.deepEqual([ann.email, ann.plan, ann.balance, ann.jobs_30d, ann.intent], ["ann@synthetic.invalid", "creator", 41980, 2, "blueprint"]);
  assert.equal(o.customers.find((c: any) => c.user_id === BOB).email, null, "no auth record, no email, no crash");
});

test("quotes for the Genjutsu suite: swap and trend price like recast, restyle like the full model, a character is one unit", () => {
  const video = { kind: "video", probe: { duration: 23.4 } };
  const swap = quote("swap", { model: "light", character: "noah", prompt: "  make it a tabby cat  " }, video);
  assert.deepEqual([swap.credits, swap.options.seconds, swap.options.model, swap.options.prompt], [15 * COSTS.recast_light_second, 15, "light", "make it a tabby cat"]);
  assert.equal(quote("swap", { model: "full", character_asset_id: ASSET }, video).credits, 24 * COSTS.recast_second);
  assert.throws(() => quote("swap", { model: "full" }, video), (e: any) => e.code === "character_required");
  const style = "11111111-1111-4111-8111-111111111111";
  const re = quote("restyle", { style_id: style, style_name: "Knitted Yarn World" }, video);
  assert.deepEqual([re.credits, re.options.model, re.options.style_id, re.options.style_name], [24 * COSTS.recast_second, "full", style, "Knitted Yarn World"]);
  assert.throws(() => quote("restyle", { style_id: "yarn" }, video), (e: any) => e.code === "style_required");
  const tr = quote("trend", { trend_id: "desk-talk", model: "light", character: "maya" }, null);
  assert.deepEqual([tr.credits, tr.options.trend_id, tr.options.seconds], [6 * COSTS.recast_light_second, "desk-talk", 6], "a 5 s clip bills 6 at Higgsfield's rounding");
  assert.throws(() => quote("trend", { trend_id: "nope", character: "maya" }, null), (e: any) => e.code === "trend_required");
  const ch = quote("character", { mode: "animal", prompt: "a tabby cat in a watermelon helmet" }, null);
  assert.deepEqual([ch.credits, ch.options.mode], [COSTS.character_image, "animal"]);
  assert.throws(() => quote("character", { prompt: "" }, null), (e: any) => e.code === "prompt_required");
});

test("routes: the trends catalog, the styles catalog through the key, and a swap job", async (t) => {
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: ANN, stripe_customer_id: "cus_1", status: "active", plan_id: "creator", onboarding: {} }],
    studio_assets: [{ id: ASSET, user_id: ANN, kind: "video", status: "ready", probe: { duration: 10 }, object_key: `${ANN}/${ASSET}.mp4`, bytes: 1 }], studio_jobs: [], studio_credit_ledger: [], studio_stripe_events: [] };
  const sb = fakeSb(tables, (name, args) => name === "studio_balance" ? { data: 5000, error: null } : name === "studio_create_job" ? { data: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "queued", tool: args.p_tool, credits_reserved: args.p_credits, options: args.p_options }, error: null } : { data: {}, error: null });
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) { req.auth = { user_id: u, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: u }; } next(); });
  let styleCalls = 0;
  registerStudio(app, () => sb, { stripe: fakeStripe(), env: { ...ENV, STUDIO_RECAST_FULL_ENABLED: "true" }, log: () => {}, styles: async () => { styleCalls++; return [{ id: "11111111-1111-4111-8111-111111111111", name: "Knitted Yarn World", preview_url: null }]; } });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => { const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const plans = await call("GET", "/api/studio/plans");
  assert.deepEqual([plans.body.tools.swap, plans.body.tools.restyle, plans.body.tools.trend, plans.body.tools.character], [true, true, true, true], "the suite opens with the key");
  assert.ok(plans.body.costs.character_image >= 4);
  const trends = await call("GET", "/api/studio/trends");
  assert.equal(trends.body.trends[0].id, "thumbs-up"); assert.match(trends.body.trends[0].video_url, /^https:\/\/app\.clone8\.io\/trends\/thumbs-up\.mp4$/);
  const styles = await call("GET", "/api/studio/styles"); await call("GET", "/api/studio/styles");
  assert.equal(styles.body.styles[0].name, "Knitted Yarn World"); assert.equal(styleCalls, 1, "the catalog is cached");
  const job = await call("POST", "/api/studio/jobs", { tool: "swap", asset_id: ASSET, options: { model: "full", character: "noah", prompt: "a tabby cat" } }, { "x-test-user": ANN });
  assert.equal(job.status, 201); assert.equal(job.body.job.tool, "swap"); assert.equal(job.body.job.credits_reserved, 11 * COSTS.recast_second);
  assert.equal((await call("POST", "/api/studio/jobs", { tool: "trend", options: { trend_id: "pitch-15", model: "light", character: "noah" } }, { "x-test-user": ANN })).status, 201, "a trend needs no upload");
  assert.equal((await call("POST", "/api/studio/jobs", { tool: "character", options: { mode: "animal", prompt: "a corgi in a suit" } }, { "x-test-user": ANN })).status, 201);
});

test("invoice.paid that arrives before the customer link still grants, by the subscription's user id; one with no clue is left for retry", async () => {
  const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const tables: Record<string, any[]> = { studio_customers: [{ user_id: NEW, stripe_customer_id: null, status: "none", plan_id: null, onboarding: {} }], studio_credit_ledger: [], studio_stripe_events: [] };
  const grants: any[] = [];
  const sb = fakeSb(tables, (name, args) => { if (name === "studio_grant") { grants.push(args); return { data: { granted: true }, error: null }; } if (name === "studio_referral_reward") return { data: { granted: false }, error: null }; return { data: {}, error: null }; });
  const stripe = fakeStripe({ sub_new: sub({ id: "sub_new", customer: "cus_new", metadata: { user_id: NEW }, items: { data: [{ price: { id: "price_cy", recurring: { interval: "year" } }, current_period_start: 1761523200, current_period_end: 1793059200 }] } }) });
  process.env.STRIPE_PRICE_CREATOR_YEAR = "price_cy";
  const out = await applyStripeEvent(sb, stripe, { id: "evt_race", type: "invoice.paid", data: { object: { id: "in_race", customer: "cus_new", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_new" } } } } });
  assert.match(out, /granted 42000/);
  assert.deepEqual([grants[0].p_user, grants[0].p_credits, grants[0].p_ref, grants[0].p_expire_previous], [NEW, 42000, "in_race", true]);
  assert.ok(sb.writes.some((w: any) => w.table === "studio_customers" && w.op === "upsert" && w.v.stripe_customer_id === "cus_new"), "the customer link is written on the way");
  const stripe2 = fakeStripe({ sub_x: sub({ id: "sub_x", customer: "cus_x", metadata: {} }) });
  await assert.rejects(() => applyStripeEvent(sb, stripe2, { id: "evt_x", type: "invoice.paid", data: { object: { id: "in_x", customer: "cus_x", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_x" } } } } }), /unknown customer/, "no user anywhere: throw so Stripe retries");
  delete process.env.STRIPE_PRICE_CREATOR_YEAR;
});
