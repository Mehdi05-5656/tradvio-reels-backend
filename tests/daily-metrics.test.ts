// The daily tracker's numbers (src/daily-metrics.ts), Nov 28 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { computeDay, geoOf, payingNow, type DayInput, type Ev, type Person } from "../src/daily-metrics.js";

const T0 = "2026-11-26T18:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const person = (id: string, country: string, role: string, heard = "tiktok"): Person => ({ user_id: `00000000-0000-4000-8000-00000000000${id}`, created_at: T0, country, role, heard });
const ev = (p: Person, kind: string, name: string, min: number, props: any = {}): Ev => ({ user_id: p.user_id, kind, name, created_at: at(min), props });

test("the funnel of a day's sign-ups, by group; a payment counts whenever it comes, and how fast", () => {
  const a = person("1", "US", "clipper"), b = person("2", "IN", "creator", "instagram"), c = person("3", "GB", "clipper"), d = person("4", "US", "creator");
  const inp: DayInput = { day: "2026-11-26", people: [a, b, c, d], paidAt: new Map([[a.user_id, at(9)], [c.user_id, at(60 * 30)]]), events: [
    ev(a, "page", "home", 0), ev(a, "page", "clips", 1), ev(a, "page", "pricing", 3), ev(a, "checkout", "plan", 4),
    ev(b, "page", "home", 0), ev(b, "page", "stories", 2), ev(b, "page", "pricing", 3), ev(b, "checkout", "plan", 5),
    ev(c, "page", "clips", 1), ev(c, "page", "pricing", 2), ev(c, "checkout", "plan", 3), ev(c, "checkout", "payment_declined", 4), ev(c, "page", "clips", 60 * 29),
    ev(d, "page", "home", 0) ] };
  const rows = computeDay(inp); const get = (cut: string, value = "") => rows.find((r) => r.cut === cut && r.value === value)?.metrics;
  assert.deepEqual(get("all"), { signups: 4, opened_tool: 3, saw_plans: 3, checkout: 3, declined: 1, paid: 2, paid_15m: 1, paid_day0: 1, back_next_day: 1 });
  assert.equal(get("valued", "yes")!.signups, 3); assert.equal(get("valued", "yes")!.paid, 2); assert.equal(get("valued", "no")!.paid, 0);
  assert.equal(get("geo", "south")!.checkout, 1); assert.equal(get("geo", "west")!.paid, 1);
  assert.equal(get("first_tool", "clips")!.paid, 2); assert.equal(get("first_tool", "stories")!.paid, 0); assert.equal(get("first_tool", "none")!.signups, 1);
  assert.equal(get("valued_role", "clipper")!.paid, 2); assert.equal(get("valued_role", "creator")!.signups, 1, "the Indian creator is not in the valued cuts");
  // the test's groups: last hex digit odd = walk-through
  assert.equal(get("ab", "walk-through")!.signups, 2); assert.equal(get("ab", "control")!.signups, 2);
  assert.equal(geoOf("KE"), "south"); assert.equal(geoOf("BR"), "other"); assert.equal(geoOf(null), "other");
});

test("the day's activity sits on the all row: sales, cancels with reasons, runs, failures, cost", () => {
  const a = person("1", "US", "clipper");
  const rows = computeDay({ day: "2026-11-26", people: [a], events: [], paidAt: new Map(), activity: {
    invoices: [{ reason: "subscription_create", cents: 2900 }, { reason: "subscription_create", cents: 7900 }, { reason: "subscription_update", cents: 1899 }, { reason: "subscription_cycle", cents: 2900 }],
    dayEvents: [ev(a, "checkout", "plan", 1), ev(a, "checkout", "topup", 5, { credits: 250 }), ev(a, "checkout", "payment_declined", 6),
      ev(a, "feature", "plan_cancel", 120, { started: at(0) }), ev(a, "feature", "plan_cancel_reason", 121, { feedback: "too_expensive" })],
    jobs: [{ tool: "clips", status: "done", credits_charged: 122, error_code: null }, { tool: "clips", status: "failed", credits_charged: 0, error_code: "chat_too_quiet" }, { tool: "kage_motion", status: "done", credits_charged: 130, error_code: null }],
    costs: [{ provider: "claude", usd: 0.4 }, { provider: "claude", usd: 0.25 }, { provider: "stripe", usd: 1.14 }], payersNow: { paying: 47, set_to_cancel: 13, comped: 2 } } });
  const m = rows.find((r) => r.cut === "all")!.metrics;
  assert.deepEqual([m.new_subs, m.new_subs_usd, m.renewals, m.plan_changes_usd], [2, 108, 1, 18.99]);
  assert.deepEqual([m.topups, m.topup_credits, m.declines, m.checkouts_opened], [1, 250, 1, 1]);
  assert.deepEqual([m.cancels, m.cancel_hours_after_paying, m.cancel_reasons], [1, [2], { too_expensive: 1 }]);
  assert.deepEqual(m.runs, { clips: 2, kage_motion: 1 }); assert.deepEqual(m.runs_failed, { clips: 1 }); assert.deepEqual(m.failure_reasons, { "clips:chat_too_quiet": 1 });
  assert.equal(m.credits_charged, 252); assert.equal(m.cost_usd, 1.79); assert.deepEqual(m.cost_by_supplier, { claude: 0.65, stripe: 1.14 }); assert.deepEqual([m.payers_now, m.payers_set_to_cancel, m.comped_plans], [47, 13, 2]);
  // a day with no sign-ups still has its all row
  assert.equal(computeDay({ day: "2026-11-01", people: [], events: [], paidAt: new Map(), activity: { invoices: [], dayEvents: [], jobs: [], costs: [] } }).find((r) => r.cut === "all")!.metrics.signups, 0);
});

test("who pays now leaves out plans set to cancel and comped plans (the owner's Stripe count, Nov 28 2026: 47 of 62 active)", () => {
  const active = [...Array(47).fill({ stripe_subscription_id: "sub_x", cancel_at_period_end: false }), ...Array(13).fill({ stripe_subscription_id: "sub_y", cancel_at_period_end: true }), ...Array(2).fill({ stripe_subscription_id: null })];
  assert.deepEqual(payingNow(active), { paying: 47, set_to_cancel: 13, comped: 2 });
  assert.equal(payingNow([{ billing_source: "apple", stripe_subscription_id: null }]).paying, 1, "a plan billed by Apple is a real one");
});
