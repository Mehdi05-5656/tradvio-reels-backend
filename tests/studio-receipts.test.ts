import test from "node:test";
import assert from "node:assert/strict";
import { receiptFromEvent, receiptMail, sendReceipt, money } from "../src/studio-receipts.js";

const U = "11111111-1111-4111-8111-111111111111";

test("receipts: a top-up, a bundle and a plan invoice each make one; a plan checkout and a $0 invoice make none", () => {
  const topup = receiptFromEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 500, currency: "usd", payment_intent: "pi_1", created: 1793417136, metadata: { topup: "1", credits: "142", user_id: U } } } });
  assert.deepEqual([topup?.amount_cents, topup?.credits, topup?.items, topup?.reference], [500, 142, ["Top-up: 142 credits"], "pi_1"]);
  const pack = receiptFromEvent({ type: "checkout.session.completed", data: { object: { id: "cs_2", mode: "payment", payment_status: "paid", amount_total: 5900, currency: "usd", metadata: { pack: "pack_2000" } } } });
  assert.deepEqual([pack?.credits, pack?.items[0], pack?.reference], [2000, "Credit bundle: 2,000 credits", "cs_2"]);
  assert.equal(receiptFromEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", amount_total: 7900 } } }), null, "the plan's first invoice is its receipt");
  assert.equal(receiptFromEvent({ type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "unpaid", amount_total: 500 } } }), null);
  const inv = receiptFromEvent({ type: "invoice.paid", data: { object: { id: "in_1", number: "C8-0001", amount_paid: 79200, currency: "usd", billing_reason: "subscription_create", hosted_invoice_url: "https://invoice.stripe.com/i/x", lines: { data: [{ description: "1 × Clone8 Creator (at $792.00 / year)" }] } } } });
  assert.deepEqual([inv?.amount_cents, inv?.items, inv?.reference, inv?.invoice_url], [79200, ["1 × Clone8 Creator (at $792.00 / year)"], "C8-0001", "https://invoice.stripe.com/i/x"]);
  assert.equal(receiptFromEvent({ type: "invoice.paid", data: { object: { amount_paid: 0 } } }), null, "nothing charged, no receipt");
  assert.equal(receiptFromEvent({ type: "customer.subscription.updated", data: { object: {} } }), null);
});

test("the receipt email says what was paid, for what, and where to look", () => {
  const m = receiptMail({ amount_cents: 500, currency: "usd", items: ["Top-up: 142 credits"], credits: 142, reference: "pi_1", paid_at: new Date("2026-10-31T03:25:36Z") }, "https://app.clone8.io");
  assert.equal(m.subject, "Receipt for $5.00");
  for (const s of ["$5.00", "October 31, 2026", "For: Top-up: 142 credits", "Credits added: 142", "Reference: pi_1", "https://app.clone8.io/#studio/account"]) assert.ok(m.text.includes(s), s);
  assert.equal(money(79200), "$792.00");
});

test("sendReceipt mails the sign-up address and never throws", async () => {
  const sent: any[] = [];
  const sb: any = { auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: id === U ? "ann@synthetic.invalid" : null } } }) } } };
  const fetch: any = async (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: "re_1" }) }; };
  const r = { amount_cents: 500, currency: "usd", items: ["Top-up: 142 credits"], credits: 142, reference: "pi_1", paid_at: new Date() };
  const env = { RESEND_API_KEY: "test" };
  assert.equal(await sendReceipt(sb, U, r, { fetch, env, log: () => {} }), true);
  assert.deepEqual(sent[0].to, ["ann@synthetic.invalid"]);
  assert.equal(await sendReceipt(sb, null, r, { fetch, env, log: () => {} }), false, "no user: logged, not thrown");
  const boom: any = async () => ({ ok: false, status: 500, json: async () => ({ message: "down" }) });
  assert.equal(await sendReceipt(sb, U, r, { fetch: boom, env, log: () => {} }), false, "a provider error: logged, not thrown");
});
