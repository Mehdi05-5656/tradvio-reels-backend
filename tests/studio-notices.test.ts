import test from "node:test";
import assert from "node:assert/strict";
import { sendMail, toHtml, mailConfigured, unsubscribeToken, checkUnsubscribeToken } from "../src/studio-mail.js";
import { noticesTick, jobNotice, jobsNotice } from "../src/studio-notices.js";
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

test("the words of a job notice, for every tool", () => {
  const done = jobNotice({ tool: "blueprint", status: "done", outputs: [{}, {}, {}], options: { copies: 3 }, credits_charged: 12, credits_reserved: 12 }, ENV);
  assert.equal(done.subject, "Your 3 Blueprint copies are ready");
  assert.match(done.text, /app\.clone8\.io\/#studio\/library/);
  assert.equal(jobNotice({ tool: "blueprint", status: "done", outputs: [{}], options: { copies: 1 } }, ENV).subject, "Your 1 Blueprint copy is ready");
  assert.equal(jobNotice({ tool: "recast", status: "done", outputs: [{}] }, ENV).subject, "Your Recast is ready");
  assert.equal(jobNotice({ tool: "swap", status: "done", outputs: [{}], options: { seconds: 12 } }, ENV).subject, "Your Swap is ready");
  assert.equal(jobNotice({ tool: "restyle", status: "done", outputs: [{}], options: { style_name: "Anime" } }, ENV).subject, "Your styled video is ready");
  assert.equal(jobNotice({ tool: "instrument", status: "done", outputs: [{}], options: { output: "image", endpoint: "image/flux" } }, ENV).subject, "Your image is ready");
  assert.equal(jobNotice({ tool: "character", status: "done", outputs: [{}] }, ENV).subject, "Your character is ready");
  const failed = jobNotice({ tool: "recast", status: "failed", error_code: "recast_nsfw", credits_reserved: 165 }, ENV);
  assert.equal(failed.subject, "Your Recast did not finish");
  assert.match(failed.text, /165 credits it held are back/);
  // a batch: one email, a row per job
  const batch = jobsNotice([{ tool: "swap", status: "done", options: { seconds: 8 } }, { tool: "restyle", status: "done", options: { style_name: "Clay" } }, { tool: "recast", status: "failed", credits_reserved: 90 }], ENV, ANN);
  assert.equal(batch.subject, "2 ready, 1 did not finish");
  assert.match(batch.text, /Swap · 8 s: Ready/); assert.match(batch.text, /Not finished, refunded/); assert.match(batch.text, /90 credits are back/);
});

test("emails are built to land in the inbox: no images, no trackers, one button, a one-click unsubscribe", async () => {
  const m = jobsNotice([{ tool: "swap", status: "done", options: {} }], { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "k" }, ANN);
  assert.ok(!/<img/i.test(m.html), "no images");
  assert.equal((m.html.match(/<a /g) ?? []).length, 2, "the button and the unsubscribe link, nothing else");
  assert.ok(!/free|offer|discount|deal|% off|!|upgrade/i.test(m.subject + m.text), "no sales words");
  assert.ok(m.unsubscribeUrl?.includes(`u=${ANN}`));
  const r = fakeResend();
  await sendMail({ to: "ann@synthetic.invalid", subject: m.subject, text: m.text, html: m.html, unsubscribeUrl: m.unsubscribeUrl }, { env: ENV, fetch: r.fetchFn });
  const h = r.sent[0].body.headers;
  assert.equal(h["List-Unsubscribe"], `<${m.unsubscribeUrl}>`); assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click"); assert.match(h["X-Entity-Ref-ID"], /^[0-9a-f-]{36}$/);
  // the token only works for its own person, and only when signed with the server's key
  const env = { SUPABASE_SERVICE_ROLE_KEY: "k" };
  const t = unsubscribeToken(ANN, env);
  assert.equal(checkUnsubscribeToken(ANN, t, env), true);
  assert.equal(checkUnsubscribeToken("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", t, env), false);
  assert.equal(checkUnsubscribeToken(ANN, t, { SUPABASE_SERVICE_ROLE_KEY: "other" }), false);
  assert.equal(checkUnsubscribeToken(ANN, t, {}), false, "no key, no unsubscribing by link");
});

/** A database with one finished job, one customer running low, one renewing soon. */
function fakeSb(opts: { live?: boolean; jobs?: any[]; optOut?: boolean; balance?: number; periodEnd?: string; renewalNotified?: string | null; lowNotified?: string | null; email?: string | null } = {}) {
  const calls: any[] = [], updates: any[] = [];
  const customer = { user_id: ANN, plan_id: "creator", status: "active", period_start: "2026-10-01T00:00:00Z", period_end: opts.periodEnd ?? "2026-10-31T00:00:00Z", credits_per_period: 3500, cancel_at_period_end: false, email_opt_out: !!opts.optOut, low_credits_notified_at: opts.lowNotified ?? null, renewal_notified_for: opts.renewalNotified ?? null };
  const sb: any = {
    calls, updates,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); if (name === "studio_jobs_to_notify") return { data: opts.jobs ?? [{ id: "job1", user_id: ANN, tool: "blueprint", status: "done", outputs: [{}, {}], options: { copies: 2 }, credits_charged: 8, credits_reserved: 8, finished_at: "2026-10-28T23:55:00Z" }], error: null }; if (name === "studio_balance") return { data: opts.balance ?? 200, error: null }; return { data: null, error: null }; },
    from: (table: string) => { const q: any = { select: () => q, eq: () => q, in: () => q, limit: () => q, maybeSingle: async () => ({ data: customer, error: null }), then: (res: any) => res({ data: table === "studio_jobs" ? (opts.live ? [{ id: "live" }] : []) : [customer], error: null }), update: (v: any) => ({ eq: async () => { updates.push({ table, v }); return { error: null }; } }) }; return q; },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: opts.email === undefined ? "ann@synthetic.invalid" : opts.email } } }) } },
  };
  return sb;
}

test("one tick: the finished job is announced and marked; low credits and the renewal each go out once", async () => {
  const r = fakeResend();
  const sb = fakeSb({ balance: 200 });
  const out = await noticesTick(sb, { env: ENV, fetch: r.fetchFn, log: () => undefined, now: () => new Date("2026-10-29T00:00:00Z") });
  assert.deepEqual(out, { jobs: 1, low: 1, renewals: 1, skipped: 0 });
  assert.deepEqual(r.sent.map((m) => m.body.subject), ["Your 2 Blueprint copies are ready", "200 credits left", "Your plan renews on October 31"]);
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

test("one email per batch: it waits while more is rendering or a step just finished, then sends everything at once", async () => {
  const now = new Date("2026-10-29T00:00:00Z");
  const two = [
    { id: "a", user_id: ANN, tool: "swap", status: "done", options: { seconds: 8 }, finished_at: "2026-10-28T23:55:00Z" },
    { id: "b", user_id: ANN, tool: "restyle", status: "done", options: { style_name: "Clay" }, finished_at: "2026-10-28T23:57:00Z" },
  ];
  const base = { balance: 3000, periodEnd: "2026-11-20T00:00:00Z" };
  // something of hers is still rendering: hold
  let r = fakeResend(); let sb = fakeSb({ ...base, jobs: two, live: true });
  assert.equal((await noticesTick(sb, { env: ENV, fetch: r.fetchFn, now: () => now })).jobs, 0);
  assert.ok(!sb.calls.some((c: any) => c.name === "studio_mark_notified"));
  // the newest finished 30 s ago: the next chat step may be starting, hold
  r = fakeResend(); sb = fakeSb({ ...base, jobs: [{ ...two[0], finished_at: "2026-10-28T23:59:30Z" }] });
  assert.equal((await noticesTick(sb, { env: ENV, fetch: r.fetchFn, now: () => now })).jobs, 0);
  // all settled, nothing rendering: one email for both, both marked
  r = fakeResend(); sb = fakeSb({ ...base, jobs: two });
  assert.equal((await noticesTick(sb, { env: ENV, fetch: r.fetchFn, now: () => now })).jobs, 2);
  assert.deepEqual(r.sent.map((m) => m.body.subject), ["2 results are ready"]);
  assert.deepEqual(sb.calls.filter((c: any) => c.name === "studio_mark_notified").map((c: any) => c.args.p_job), ["a", "b"]);
  // a long queue never holds finished work back past 15 minutes
  r = fakeResend(); sb = fakeSb({ ...base, jobs: [{ ...two[0], finished_at: "2026-10-28T23:40:00Z" }], live: true });
  assert.equal((await noticesTick(sb, { env: ENV, fetch: r.fetchFn, now: () => now })).jobs, 1);
});
