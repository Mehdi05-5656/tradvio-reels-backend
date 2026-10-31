import test from "node:test";
import assert from "node:assert/strict";
import { topupCredits, topupsClearFloor, recommendAuto, chargeAutoTopUp, topupInfo, TOPUP_MIN_USD } from "../src/studio-topup.js";
import { PLANS } from "../src/studio.js";

const U = "11111111-1111-4111-8111-111111111111";

test("top-ups: cheaper credits on bigger plans, a bonus for bigger top-ups, every rate clears the credit floor", () => {
  assert.equal(TOPUP_MIN_USD, 5);
  assert.deepEqual(["starter", "creator", "studio"].map((p) => topupCredits(5, p)), [125, 142, 166], "$5 on each plan");
  assert.equal(topupCredits(25, "creator"), Math.floor(714 * 1.05), "5% more from $25");
  assert.equal(topupCredits(100, "studio"), Math.floor(3333 * 1.15), "15% more from $100");
  assert.equal(topupCredits(5, null), 125, "no plan: the Starter rate");
  assert.ok(topupsClearFloor(PLANS), "no top-up sells a credit under what the tools are priced on");
});

test("auto top-up recommendations come from the last 30 days, with sensible minimums", () => {
  assert.deepEqual(recommendAuto(0, "starter"), { below: 100, usd: 10 }, "a new account: the minimums");
  const heavy = recommendAuto(30_000, "creator"); // 1,000 credits a day
  assert.equal(heavy.below, 2000, "two days of use");
  assert.equal(heavy.usd, 100, "about three days of use at 3.5¢ ($105), the nearest friendly amount");
  assert.equal(recommendAuto(3000, "starter").usd, 10, "a light user: the $10 minimum");
  const info = topupInfo({ plan_id: "studio", auto_topup_enabled: true, auto_topup_below: 300, auto_topup_usd: 50 }, 3000);
  assert.deepEqual([info.auto.enabled, info.auto.below, info.auto.usd, info.rate_usd], [true, 300, 50, 0.03]);
  assert.equal(info.presets[0].usd, 5);
});

function fakeSb(customer: any, grants = 0) {
  const calls: any[] = [];
  const sb: any = {
    calls,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: name === "studio_balance" ? 50 : { granted: true }, error: null }; },
    from(table: string) {
      let op: any = null; const filters: any[] = [];
      const q: any = {
        select() { return q; }, eq(k: string, v: any) { filters.push([k, v]); return q; }, is(k: string, v: any) { filters.push([k, v]); return q; }, like() { return q; }, gte() { return q; }, in() { return q; }, limit() { return q; },
        maybeSingle() { return q; }, update(v: any) { op = v; return q; },
        then(res: any) {
          if (table === "studio_credit_ledger") return res({ data: Array.from({ length: grants }, (_, i) => ({ id: i })), error: null });
          if (op) {
            calls.push({ update: op, filters: [...filters] });
            // the claim: only when the last-run stamp still matches
            const lastFilter = filters.find((f) => f[0] === "auto_topup_last_at");
            if ("auto_topup_last_at" in op && lastFilter && (lastFilter[1] ?? null) !== (customer.auto_topup_last_at ?? null)) return res({ data: [], error: null });
            Object.assign(customer, op);
            return res({ data: [{ user_id: U }], error: null });
          }
          return res({ data: customer, error: null });
        },
      };
      return q;
    },
  };
  return sb;
}
const card = { customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_1" } }) }, paymentMethods: { list: async () => ({ data: [] }) } };

test("auto top-up charges the saved card once, grants the credits, and keeps to its guards", async () => {
  const c = { plan_id: "creator", status: "active", stripe_customer_id: "cus_1", auto_topup_enabled: true, auto_topup_usd: 25, auto_topup_last_at: null as string | null };
  const sb = fakeSb(c);
  const intents: any[] = [];
  const stripe = { ...card, paymentIntents: { create: async (p: any, o: any) => { intents.push({ p, o }); return { id: "pi_1", status: "succeeded" }; } } };
  const r = await chargeAutoTopUp(sb, stripe, U, () => {}, "test");
  assert.deepEqual(r, { ok: true, credits: topupCredits(25, "creator") });
  assert.equal(intents[0].p.amount, 2500); assert.equal(intents[0].p.off_session, true); assert.equal(intents[0].p.payment_method, "pm_1");
  const grant = sb.calls.find((x: any) => x.name === "studio_grant").args;
  assert.deepEqual([grant.p_credits, grant.p_ref, grant.p_expire_previous], [topupCredits(25, "creator"), "pi_1", false], "bought credits carry over");
  // straight after: the cooldown holds
  assert.equal((await chargeAutoTopUp(sb, stripe, U, () => {}, "again")).reason, "cooldown");
  // a day's worth already: no more
  const c2 = { ...c, auto_topup_last_at: null };
  assert.equal((await chargeAutoTopUp(fakeSb(c2, 5), stripe, U, () => {}, "test")).reason, "daily_limit");
});

test("a declined card turns auto top-up off with the reason, so it never retries a failing card", async () => {
  const c = { plan_id: "starter", status: "active", stripe_customer_id: "cus_1", auto_topup_enabled: true, auto_topup_usd: 10, auto_topup_last_at: null, auto_topup_error: null as string | null };
  const sb = fakeSb(c);
  const stripe = { ...card, paymentIntents: { create: async () => { throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined" }); } } };
  const r = await chargeAutoTopUp(sb, stripe, U, () => {}, "test");
  assert.deepEqual(r, { ok: false, reason: "card_failed" });
  assert.equal(c.auto_topup_enabled, false); assert.match(String(c.auto_topup_error), /declined/);
  assert.ok(!sb.calls.some((x: any) => x.name === "studio_grant"), "no credits without a payment");
  // and nothing happens while it is off
  assert.equal((await chargeAutoTopUp(sb, stripe, U, () => {}, "again")).reason, "off");
});
