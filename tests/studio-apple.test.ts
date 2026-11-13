import test from "node:test";
import assert from "node:assert/strict";
import { APPLE_PRODUCTS, applyAppleTransaction, iapEnabled, makeVerifier, ownerOf } from "../src/studio-apple.js";
import { PLANS } from "../src/studio.js";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;

/** A small stand-in for Supabase: customer row, ledger rows, recorded calls. */
function fakeSb(o: { customer?: any; ledger?: any[]; balance?: number } = {}) {
  const calls: { name: string; args: any }[] = [];
  const writes: { table: string; op: string; value: any; filters: any[] }[] = [];
  const sb: any = {
    calls, writes,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: name === "studio_balance" ? (o.balance ?? 0) : { granted: true }, error: null }; },
    from(table: string) {
      let op = "select", value: any = null; const filters: any[] = [];
      const q: any = {
        select() { return q; }, eq(k: string, v: any) { filters.push([k, v]); return q; }, in(k: string, v: any) { filters.push([`in:${k}`, v]); return q; }, limit() { return q; },
        maybeSingle() { return q; },
        update(v: any) { op = "update"; value = v; return q; }, upsert(v: any) { op = "upsert"; value = v; return q; }, insert(v: any) { op = "insert"; value = v; return q; },
        then(res: any) {
          if (op !== "select") { writes.push({ table, op, value, filters }); return res({ data: null, error: null }); }
          if (table === "studio_customers") return res({ data: o.customer ?? null, error: null });
          if (table === "studio_credit_ledger") {
            const want = (k: string) => filters.find(([f]) => f === k)?.[1];
            const rows = (o.ledger ?? []).filter((r) => (want("reason") == null || r.reason === want("reason")) && (want("ref") == null || r.ref === want("ref")) && (want("in:ref") == null || (want("in:ref") as string[]).includes(r.ref)));
            return res({ data: rows, error: null });
          }
          return res({ data: null, error: null });
        },
      };
      return q;
    },
  };
  return sb;
}

const tx = (over: any = {}) => ({ transactionId: "2000000111", originalTransactionId: "2000000100", productId: "io.clone8.app.creator.month", purchaseDate: Date.now() - DAY, expiresDate: Date.now() + 29 * DAY, appAccountToken: U, environment: "Production", ...over });

test("apple: off unless switched on; no root certificates means not configured", () => {
  assert.equal(iapEnabled({}), false);
  assert.equal(iapEnabled({ STUDIO_MOBILE_IAP: "on" }), true);
  assert.equal(makeVerifier({ STUDIO_APPLE_ROOT_CERTS_DIR: "/nonexistent" }), null);
});

test("apple: every product id maps to a real plan or pack, and every plan is sold monthly", () => {
  for (const p of PLANS) assert.ok(APPLE_PRODUCTS[`io.clone8.app.${p.id}.month`], p.id);
  assert.deepEqual(APPLE_PRODUCTS["io.clone8.app.creator.year"], { plan: "creator", interval: "year" });
});

test("apple: a plan purchase sets the plan and grants the period's credits as a plan grant (replacing last period's)", async () => {
  const sb = fakeSb();
  const out = await applyAppleTransaction(sb, U, tx() as any);
  const creator = PLANS.find((p) => p.id === "creator")!;
  assert.equal(out.plan, "creator");
  assert.equal(out.credits, creator.credits);
  const sub = sb.calls.find((c: any) => c.name === "studio_apply_subscription")!.args;
  assert.deepEqual([sub.p_plan, sub.p_interval, sub.p_status, sub.p_customer, sub.p_subscription], ["creator", "month", "active", null, null]);
  const grant = sb.calls.find((c: any) => c.name === "studio_grant")!.args;
  assert.equal(grant.p_ref, "in_apple_2000000111", "an in_ ref: studio_grant treats it as a plan period, like a Stripe invoice");
  assert.equal(grant.p_expire_previous, true);
  const link = sb.writes.find((w: any) => w.table === "studio_customers" && w.op === "upsert")!.value;
  assert.deepEqual([link.billing_source, link.apple_original_transaction_id], ["apple", "2000000100"]);
});

test("apple: a yearly plan grants twelve months at once", async () => {
  const sb = fakeSb();
  const out = await applyAppleTransaction(sb, U, tx({ productId: "io.clone8.app.starter.year", expiresDate: Date.now() + 360 * DAY }) as any);
  assert.equal(out.credits, PLANS.find((p) => p.id === "starter")!.credits * 12);
});

test("apple: a lapsed period updates the plan row but grants nothing", async () => {
  const sb = fakeSb();
  const out = await applyAppleTransaction(sb, U, tx({ expiresDate: Date.now() - DAY }) as any);
  assert.equal(sb.calls.find((c: any) => c.name === "studio_apply_subscription")!.args.p_status, "canceled");
  assert.equal(sb.calls.some((c: any) => c.name === "studio_grant"), false);
  assert.match(out.note, /lapsed/);
});

test("apple: never doubles a live website plan", async () => {
  const sb = fakeSb({ customer: { stripe_subscription_id: "sub_1", status: "active", billing_source: "stripe" } });
  const out = await applyAppleTransaction(sb, U, tx() as any);
  assert.match(out.note, /website plan already live/);
  assert.equal(sb.calls.length, 0);
});

test("apple: a credit pack adds on top and never expires anything", async () => {
  const sb = fakeSb();
  const out = await applyAppleTransaction(sb, U, tx({ productId: "io.clone8.app.credits.500", expiresDate: undefined }) as any);
  const grant = sb.calls.find((c: any) => c.name === "studio_grant")!.args;
  assert.deepEqual([grant.p_credits, grant.p_expire_previous, grant.p_ref], [500, false, "apple_2000000111"]);
  assert.equal(out.credits, 500);
});

test("apple: a refund takes back what that purchase gave, never below zero, once", async () => {
  const ledger = [{ ref: "in_apple_2000000111", reason: "grant", delta: 3500 }];
  const sb = fakeSb({ ledger, balance: 1200 });
  const out = await applyAppleTransaction(sb, U, tx({ revocationDate: Date.now() }) as any);
  const take = sb.writes.find((w: any) => w.table === "studio_credit_ledger" && w.op === "insert")!.value;
  assert.deepEqual([take.delta, take.reason, take.ref], [-1200, "adjust", "apple_refund_2000000111"], "only what is left");
  assert.equal(out.credits, -1200);
  const again = fakeSb({ ledger: [...ledger, { ref: "apple_refund_2000000111", reason: "adjust", delta: -1200 }], balance: 0 });
  assert.match((await applyAppleTransaction(again, U, tx({ revocationDate: Date.now() }) as any)).note, /already/);
});

test("apple: the owner is the account the purchase was made with, else the account holding its original id", async () => {
  assert.equal(await ownerOf(fakeSb(), { appAccountToken: U.toUpperCase(), originalTransactionId: "1" }), U);
  assert.equal(await ownerOf(fakeSb({ customer: { user_id: OTHER } }), { appAccountToken: undefined, originalTransactionId: "1" }), OTHER);
  assert.equal(await ownerOf(fakeSb(), { appAccountToken: "not-a-uuid", originalTransactionId: undefined as any }), null);
});
