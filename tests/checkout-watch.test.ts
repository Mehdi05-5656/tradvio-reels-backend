// How each checkout ended and why cards were declined (src/checkout-watch.ts), Nov 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { watchCheckouts, watchRows } from "../src/checkout-watch.js";

const U = "8453474c-e5da-450c-a662-e07f1ad4954e";
const session = (over: any) => ({ id: "cs_1", object: "checkout.session", status: "expired", payment_status: "unpaid", mode: "subscription", created: 1795700000, expires_at: 1795786400, amount_total: 2900, currency: "usd", customer: "cus_A", client_reference_id: U, metadata: { user_id: U, plan_id: "starter", interval: "month" }, customer_details: null, ...over });
const declined = (over: any) => ({ id: "ch_1", status: "failed", created: 1795700100, amount: 2900, currency: "usd", customer: "cus_B", failure_code: "card_declined", failure_message: "Your card was declined.", outcome: { type: "issuer_declined", reason: "do_not_honor", network_status: "declined_by_network", risk_level: "normal" }, payment_method_details: { card: { country: "IN", brand: "visa", funding: "debit", three_d_secure: null, wallet: null } }, ...over });

test("a finished session and a declined charge each become one row with the person; open sessions and paid charges do not", () => {
  const rows = watchRows([session({}), session({ id: "cs_2", status: "open" }), session({ id: "cs_3", status: "complete", payment_status: "paid", customer_details: { address: { country: "US" } } })],
    [declined({}), { id: "ch_ok", status: "succeeded" }], (c) => (c === "cus_B" ? "11111111-1111-4111-8111-111111111111" : null));
  assert.deepEqual(rows.map((r) => [r.name, r.props.ref, r.props.status ?? r.props.code]), [["checkout_outcome", "cs_1", "expired"], ["checkout_outcome", "cs_3", "complete"], ["payment_declined", "ch_1", "card_declined"]]);
  assert.equal(rows[0].user_id, U); assert.equal(rows[0].props.plan, "starter"); assert.equal(rows[0].props.amount, 29); assert.equal(rows[1].props.country, "US");
  const d = rows[2].props;
  assert.deepEqual([rows[2].user_id, d.decline, d.outcome, d.card_country, d.funding], ["11111111-1111-4111-8111-111111111111", "do_not_honor", "issuer_declined", "IN", "debit"]);
  assert.equal(rows[0].created_at, new Date(1795700000 * 1000).toISOString(), "dated when the checkout started");
});

test("the hourly read writes each session and decline once, and only reads Stripe", async () => {
  const inserted: any[] = []; const calls: string[] = [];
  const f = (async (url: any, init?: any) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).split("?")[0]}`);
    const body = String(url).includes("checkout/sessions") ? { data: [session({})], has_more: false } : { data: [declined({}), { id: "ch_ok", status: "succeeded" }], has_more: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  const sb: any = { from: (t: string) => ({
    select: () => {
      const q: any = { in: () => (t === "studio_customers" ? Promise.resolve({ data: [{ user_id: "22222222-2222-4222-8222-222222222222", stripe_customer_id: "cus_B" }], error: null }) : q), eq: () => q, gte: () => q,
        limit: async () => ({ data: inserted.map((r) => ({ props: r.props })), error: null }) };
      return q;
    },
    insert: async (rows: any[]) => { inserted.push(...rows); return { error: null }; } }) };
  const env = { STRIPE_SECRET_KEY: "sk_test_x" };
  const a = await watchCheckouts(sb, 2, { env, fetch: f, now: () => 1795790000 * 1000 });
  assert.deepEqual(a, { sessions: 1, declines: 1, written: 2 });
  assert.equal(inserted.find((r) => r.name === "payment_declined").user_id, "22222222-2222-4222-8222-222222222222");
  const b = await watchCheckouts(sb, 2, { env, fetch: f, now: () => 1795790000 * 1000 });
  assert.equal(b.written, 0, "already written: not again");
  assert.ok(calls.every((c) => c.startsWith("GET https://api.stripe.com/v1/")), "read only");
  assert.equal((await watchCheckouts(sb, 2, { env: {}, fetch: f })).written, 0, "no Stripe key: nothing");
});
