import test from "node:test";
import assert from "node:assert/strict";
import { sendMail, toHtml, mailConfigured } from "../src/studio-mail.js";
import { noticesTick, jobNotice } from "../src/studio-notices.js";
import { applyStripeEvent, REFERRAL_CREDITS } from "../src/studio.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV = { RESEND_API_KEY: "re_test", DASHBOARD_URL: "https://app.clone8.io", STUDIO_MAIL_FROM: "Clone8 Studio <studio@clone8.io>" };

function fakeResend(status = 200) {
  const sent: any[] = [];
  const fetchFn: any = async (url: string, init: any) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => (status < 300 ? { id: `msg_${sent.length}` } : { message: "nope" }) }; };
  return { fetchFn, sent };
}

test("mail is a no-op without a key, posts to Resend with one, and refuses a bad address", async () => {
  assert.equal(mailConfigured({}), false);
  assert.equal(await sendMail({ to: "a@b.co", subject: "s", text: "t" }, { env: {}, log: () => undefined }), null);
  const r = fakeResend();
  const id = await sendMail({ to: "ann@synthetic.invalid", subject: "Hello", text: "Line one\n\nSee https://app.clone8.io/#studio" }, { env: ENV, fetch: r.fetchFn });
  assert.equal(id, "msg_1");
  assert.equal(r.sent[0].url, "https://api.resend.com/emails");
  assert.equal(r.sent[0].headers.authorization, "Bearer re_test");
  assert.deepEqual([r.sent[0].body.from, r.sent[0].body.to, r.sent[0].body.subject, r.sent[0].body.reply_to], ["Clone8 Studio <studio@clone8.io>", ["ann@synthetic.invalid"], "Hello", "support@tradvio.com"]);
  assert.match(r.sent[0].body.html, /<a href="https:\/\/app\.clone8\.io\/#studio"/);
  await assert.rejects(sendMail({ to: "not-an-email", subject: "s", text: "t" }, { env: ENV, fetch: r.fetchFn }), /mail_invalid_recipient/);
  await assert.rejects(sendMail({ to: "a@b.co", subject: "s", text: "t" }, { env: ENV, fetch: fakeResend(500).fetchFn }), /mail_failed_500/);
  assert.ok(!toHtml("<script>x</script>").includes("<script>"), "text is escaped");
});

test("the words of a job notice", () => {
  const done = jobNotice({ tool: "blueprint", status: "done", outputs: [{}, {}, {}], credits_charged: 12, credits_reserved: 12 }, ENV);
  assert.equal(done.subject, "3 copies are ready · Clone8 Studio");
  assert.match(done.text, /app\.clone8\.io\/#studio\/blueprint/);
  const recast = jobNotice({ tool: "recast", status: "done", outputs: [{}], credits_charged: 330, credits_reserved: 330 }, ENV);
  assert.equal(recast.subject, "Your recast is ready · Clone8 Studio");
  const failed = jobNotice({ tool: "recast", status: "failed", error_code: "recast_nsfw", credits_reserved: 165 }, ENV);
  assert.equal(failed.subject, "Your Recast job could not be completed");
  assert.match(failed.text, /165/);
});

/** A database with one finished job, one customer running low, one renewing soon. */
function fakeSb(opts: { optOut?: boolean; balance?: number; periodEnd?: string; renewalNotified?: string | null; lowNotified?: string | null; email?: string | null } = {}) {
  const calls: any[] = [], updates: any[] = [];
  const customer = { user_id: ANN, plan_id: "creator", status: "active", period_start: "2026-10-01T00:00:00Z", period_end: opts.periodEnd ?? "2026-10-31T00:00:00Z", credits_per_period: 3500, cancel_at_period_end: false, email_opt_out: !!opts.optOut, low_credits_notified_at: opts.lowNotified ?? null, renewal_notified_for: opts.renewalNotified ?? null };
  const sb: any = {
    calls, updates,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); if (name === "studio_jobs_to_notify") return { data: [{ id: "job1", user_id: ANN, tool: "blueprint", status: "done", outputs: [{}, {}], credits_charged: 8, credits_reserved: 8 }], error: null }; if (name === "studio_balance") return { data: opts.balance ?? 200, error: null }; return { data: null, error: null }; },
    from: (table: string) => { const q: any = { select: () => q, eq: () => q, in: () => q, limit: () => q, maybeSingle: async () => ({ data: customer, error: null }), then: (res: any) => res({ data: [customer], error: null }), update: (v: any) => ({ eq: async () => { updates.push({ table, v }); return { error: null }; } }) }; return q; },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: opts.email === undefined ? "ann@synthetic.invalid" : opts.email } } }) } },
  };
  return sb;
}

test("one tick: the finished job is announced and marked; low credits and the renewal each go out once", async () => {
  const r = fakeResend();
  const sb = fakeSb({ balance: 200 });
  const out = await noticesTick(sb, { env: ENV, fetch: r.fetchFn, log: () => undefined, now: () => new Date("2026-10-29T00:00:00Z") });
  assert.deepEqual(out, { jobs: 1, low: 1, renewals: 1, skipped: 0 });
  assert.deepEqual(r.sent.map((m) => m.body.subject), ["2 copies are ready · Clone8 Studio", "200 credits left · Clone8 Studio", "Your plan renews on October 31 · Clone8 Studio"]);
  assert.ok(sb.calls.some((c: any) => c.name === "studio_mark_notified" && c.args.p_job === "job1"));
  assert.deepEqual(sb.updates.map((u: any) => Object.keys(u.v)[0]), ["low_credits_notified_at", "renewal_notified_for"]);
  // Already notified this period, balance fine, renewal far away: nothing but the job.
  const r2 = fakeResend();
  const sb2 = fakeSb({ balance: 3000, periodEnd: "2026-11-20T00:00:00Z" });
  const out2 = await noticesTick(sb2, { env: ENV, fetch: r2.fetchFn, log: () => undefined, now: () => new Date("2026-10-29T00:00:00Z") });
  assert.deepEqual(out2, { jobs: 1, low: 0, renewals: 0, skipped: 0 });
  // Opted out: the job is marked without a mail; nothing else is sent.
  const r3 = fakeResend();
  const sb3 = fakeSb({ optOut: true });
  assert.deepEqual(await noticesTick(sb3, { env: ENV, fetch: r3.fetchFn, log: () => undefined, now: () => new Date("2026-10-29T00:00:00Z") }), { jobs: 0, low: 0, renewals: 0, skipped: 1 });
  assert.equal(r3.sent.length, 0);
  assert.ok(sb3.calls.some((c: any) => c.name === "studio_mark_notified"));
  // Provider down: nothing is marked, so the next tick retries.
  const sb4 = fakeSb({ balance: 3000, periodEnd: "2026-11-20T00:00:00Z" });
  await noticesTick(sb4, { env: ENV, fetch: fakeResend(503).fetchFn, log: () => undefined, now: () => new Date("2026-10-29T00:00:00Z") });
  assert.ok(!sb4.calls.some((c: any) => c.name === "studio_mark_notified"));
});

test("the first paid invoice of a referred person credits both sides through the webhook", async () => {
  process.env.STRIPE_PRICE_CREATOR_MONTH = "price_cm";
  const calls: any[] = [];
  const sb: any = {
    rpc: async (name: string, args: any) => { calls.push({ name, args }); if (name === "studio_grant") return { data: { granted: true }, error: null }; if (name === "studio_referral_reward") return { data: { granted: true, referrer: "r", credits: args.p_credits }, error: null }; return { data: {}, error: null }; },
    from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { user_id: ANN, stripe_customer_id: "cus_1" }, error: null }), upsert: async () => ({ error: null }) }; return q; },
  };
  const stripe = { subscriptions: { retrieve: async () => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { user_id: ANN }, items: { data: [{ price: { id: "price_cm", recurring: { interval: "month" } }, current_period_start: 1761523200, current_period_end: 1764115200 }] } }) } } as any;
  const out = await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_first", customer: "cus_1", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } } } });
  assert.match(out, /referral 500 both ways/);
  assert.deepEqual(calls.find((c) => c.name === "studio_referral_reward").args, { p_user: ANN, p_credits: REFERRAL_CREDITS });
  calls.length = 0;
  await applyStripeEvent(sb, stripe, { type: "invoice.paid", data: { object: { id: "in_2", customer: "cus_1", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_1" } } } } });
  assert.ok(!calls.some((c) => c.name === "studio_referral_reward"), "renewals never reward");
  delete process.env.STRIPE_PRICE_CREATOR_MONTH;
});
