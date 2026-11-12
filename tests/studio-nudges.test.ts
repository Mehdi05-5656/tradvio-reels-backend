import test from "node:test";
import assert from "node:assert/strict";
import { dueNudges, eligible, goalOf, nudgeEmail, nudgesTick, nudgesOn, maxPerHour, type NudgeCustomer, type NudgeRow } from "../src/studio-nudges.js";

const U = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
const ENV = { RESEND_API_KEY: "re_test", STUDIO_NUDGES: "on", STUDIO_MAIL_SECRET: "s3cret", DASHBOARD_URL: "https://app.clone8.io" };
const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const cust = (i: number, minutesAgo: number, more: Partial<NudgeCustomer> = {}): NudgeCustomer => ({ user_id: U(i), status: "none", created_at: ago(minutesAgo), onboarding: { goal: "stories", goals: ["stories"] }, country: "US", ...more });

test("off unless switched on with mail configured; the hourly pace has a ceiling", () => {
  assert.equal(nudgesOn({ RESEND_API_KEY: "x" }), false);
  assert.equal(nudgesOn({ STUDIO_NUDGES: "on" }), false);
  assert.equal(nudgesOn(ENV), true);
  assert.deepEqual([maxPerHour({}), maxPerHour({ STUDIO_NUDGE_MAX_PER_HOUR: "5" }), maxPerHour({ STUDIO_NUDGE_MAX_PER_HOUR: "900" }), maxPerHour({ STUDIO_NUDGE_MAX_PER_HOUR: "x" })], [15, 5, 60, 15]);
});

test("who may be written to: no plan, never subscribed, emails on, outside Europe unless allowed", () => {
  assert.equal(eligible(cust(1, 60), ENV), true);
  assert.equal(eligible(cust(1, 60, { status: "active" }), ENV), false);
  assert.equal(eligible(cust(1, 60, { status: "canceled" }), ENV), false);
  assert.equal(eligible(cust(1, 60, { stripe_subscription_id: "sub_1" }), ENV), false);
  assert.equal(eligible(cust(1, 60, { email_opt_out: true }), ENV), false);
  assert.equal(eligible(cust(1, 60, { owner_pass: true }), ENV), false);
  assert.equal(eligible(cust(1, 60, { country: "DE" }), ENV), false);
  assert.equal(eligible(cust(1, 60, { country: "gb" }), ENV), false);
  assert.equal(eligible(cust(1, 60, { country: "DE" }), { ...ENV, STUDIO_NUDGE_EUROPE: "on" }), true);
  assert.equal(eligible(cust(1, 60, { country: null }), ENV), true);
});

test("the first email is due 30 minutes after sign-up, the second a day after the first went out, then nothing", () => {
  const sent = (i: number, step: any, minutesAgo: number, status = "sent"): NudgeRow => ({ user_id: U(i), step, status, created_at: ago(minutesAgo), sent_at: status === "sent" ? ago(minutesAgo) : null });
  const due = dueNudges([
    cust(1, 29),                       // too soon
    cust(2, 31),                       // first
    cust(3, 60 * 24 * 14),             // signed up two weeks ago, never written to: first
    cust(4, 60 * 30),                  // first went 23 h ago: wait
    cust(5, 60 * 30),                  // first went 25 h ago: second
    cust(6, 60 * 80),                  // both sent: nothing
    cust(7, 60 * 30),                  // first failed: no second, no retry
    cust(8, 60 * 24 * 90),             // too old
    cust(9, 45, { status: "active" }), // subscribed
  ], [sent(4, "plan_30m", 60 * 23), sent(5, "plan_30m", 60 * 25), sent(6, "plan_30m", 60 * 70), sent(6, "plan_day1", 60 * 40), sent(7, "plan_30m", 60 * 29, "failed")], NOW, ENV);
  assert.deepEqual(due.map((d) => [d.customer.user_id.slice(-1), d.step]), [["2", "plan_30m"], ["5", "plan_day1"], ["3", "plan_30m"]], "newest sign-ups first");
});

test("the words: the person's own goal, one button to the plans, a way out, both forms the same, nothing shouted", () => {
  assert.equal(goalOf({ goal: "clips", goals: ["stories", "clips"] })?.tool, "Clips");
  assert.equal(goalOf({ goals: ["other"] }), null);
  const a = nudgeEmail("plan_30m", { userId: U(1), onboarding: { goal: "stories" } }, ENV);
  assert.equal(a.subject, "Your first Story is one step away");
  assert.match(a.text, /You told us you want to make faceless shorts from an idea\. In Stories/);
  assert.match(a.text, /Pick a plan: https:\/\/app\.clone8\.io\/#studio\/pricing\?e=plan_30m\n/);
  assert.match(a.text, /reply to this email/);
  assert.match(a.text, /Stop these emails: https:\/\//);
  assert.ok(a.unsubscribeUrl);
  const g = nudgeEmail("plan_30m", { userId: U(1), onboarding: {} }, ENV);
  assert.equal(g.subject, "Your first video is one step away");
  assert.ok(!/You told us/.test(g.text));
  const b = nudgeEmail("plan_day1", { userId: U(1), onboarding: { goal: "stories" } }, { ...ENV, STUDIO_MAIL_SIGNER: "Sam, Clone8", STUDIO_MAIL_ADDRESS: "Clone8, 1 Example St, Town" });
  assert.equal(b.subject, "What a plan gets you in Stories");
  assert.match(b.text, /Starter · \$29 a month: 1,000 credits/);
  assert.match(b.text, /A 45-second Story costs [\d,]+ credits\./);
  assert.match(b.text, /Sam, Clone8/);
  assert.match(b.text, /1 Example St/);
  for (const m of [a, g, b]) {
    assert.ok(!/free|discount|% off|act now|limited time|guarantee|click here|!/i.test(`${m.subject}\n${m.text}`), "no words spam filters score");
    assert.ok(!/<img|background-image|http:\/\//i.test(m.html), "no images, no plain-http links");
    assert.match(m.html, /name="color-scheme" content="light dark"/);
    assert.match(m.html, /prefers-color-scheme:dark/);
    assert.equal((m.html.match(/class="e-btn"/g) ?? []).length, 1, "one button");
    assert.ok(m.subject.length <= 45 && m.subject === m.subject.trim());
  }
});

// a small stand-in for the two tables, the jobs table and the sign-in directory
function fakeDb(customers: NudgeCustomer[], opts: { emails?: Record<string, string>; jobs?: string[]; nudges?: any[]; onClaim?: (u: string) => void } = {}) {
  const nudges: any[] = [...(opts.nudges ?? [])];
  let seq = 0;
  const from = (table: string) => {
    const st: any = { filters: [] as Array<(r: any) => boolean>, op: "select", payload: null, head: false };
    const rowsOf = () => (table === "studio_customers" ? customers : table === "studio_nudges" ? nudges : (opts.jobs ?? []).map((u) => ({ id: `j-${u}`, user_id: u })));
    const run = () => {
      if (table === "studio_nudges" && st.op === "insert") {
        if (nudges.some((r) => r.user_id === st.payload.user_id && r.step === st.payload.step)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        opts.onClaim?.(st.payload.user_id);
        const row = { id: `n${++seq}`, created_at: NOW.toISOString(), sent_at: null, ...st.payload }; nudges.push(row); return { data: row, error: null };
      }
      const hit = rowsOf().filter((r: any) => st.filters.every((f: any) => f(r)));
      if (st.op === "update") { for (const r of hit) Object.assign(r, st.payload); return { data: null, error: null }; }
      return st.head ? { data: null, count: hit.length, error: null } : { data: hit, error: null };
    };
    const q: any = {
      select: (_c?: string, o?: any) => { if (o?.head) st.head = true; return q; },
      insert: (p: any) => { st.op = "insert"; st.payload = p; return q; },
      update: (p: any) => { st.op = "update"; st.payload = p; return q; },
      eq: (k: string, v: any) => { st.filters.push((r: any) => r[k] === v); return q; },
      in: (k: string, v: any[]) => { st.filters.push((r: any) => v.includes(r[k])); return q; },
      gte: (k: string, v: any) => { st.filters.push((r: any) => String(r[k]) >= String(v)); return q; },
      order: () => q, limit: () => q,
      maybeSingle: async () => { const r = run(); return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r; },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  const sb: any = { from, auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: opts.emails?.[id] ?? `p${id.slice(-3)}@synthetic.invalid` } } }) } } };
  return { sb, nudges };
}
function fakeResend(status = 200) {
  const sent: any[] = [];
  const fetchFn: any = async (_url: string, init: any) => { sent.push(JSON.parse(init.body)); return { ok: status < 300, status, json: async () => (status < 300 ? { id: `msg_${sent.length}` } : { message: "nope" }) }; };
  return { fetchFn, sent };
}

test("a pass sends one email, records it, and the next pass does not send it again", async () => {
  const db = fakeDb([cust(1, 45), cust(2, 50)]);
  const r = fakeResend();
  const deps = { env: ENV, fetch: r.fetchFn, now: () => NOW };
  assert.deepEqual(await nudgesTick(db.sb, deps), { sent: 1, skipped: 0, failed: 0, waiting: 2 });
  assert.equal(r.sent[0].subject, "Your first Story is one step away");
  assert.equal(r.sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.deepEqual(db.nudges.map((x) => [x.user_id.slice(-1), x.step, x.status, x.message_id]), [["1", "plan_30m", "sent", "msg_1"]]);
  await nudgesTick(db.sb, deps); await nudgesTick(db.sb, deps);
  assert.deepEqual(r.sent.map((m) => m.to[0]), ["p001@synthetic.invalid", "p002@synthetic.invalid"], "each person once");
});

test("someone who subscribes between being picked and being written to gets nothing", async () => {
  const people = [cust(1, 45)];
  const db = fakeDb(people, { onClaim: () => { people[0].status = "active"; } });
  const r = fakeResend();
  assert.deepEqual(await nudgesTick(db.sb, { env: ENV, fetch: r.fetchFn, now: () => NOW }), { sent: 0, skipped: 1, failed: 0, waiting: 1 });
  assert.equal(r.sent.length, 0);
  assert.deepEqual([db.nudges[0].status, db.nudges[0].reason], ["skipped", "no_longer_eligible"]);
});

test("our own accounts and people who already made something are skipped; a refused send is not retried", async () => {
  const db = fakeDb([cust(1, 45), cust(2, 46), cust(3, 47)], { emails: { [U(1)]: "qa@clone8.io" }, jobs: [U(2)] });
  const r = fakeResend(500);
  const deps = { env: ENV, fetch: r.fetchFn, now: () => NOW, log: () => undefined };
  assert.deepEqual(await nudgesTick(db.sb, deps), { sent: 0, skipped: 2, failed: 1, waiting: 3 });
  assert.deepEqual(db.nudges.map((x) => [x.user_id.slice(-1), x.status, x.reason?.slice(0, 15)]), [["1", "skipped", "internal"], ["2", "skipped", "has_made_someth"], ["3", "failed", "mail_failed_500"]]);
  assert.deepEqual(await nudgesTick(db.sb, deps), { sent: 0, skipped: 0, failed: 0, waiting: 0 });
  assert.equal(r.sent.length, 1);
});

test("the hour's allowance holds the backlog back; off means nothing is read or sent", async () => {
  const sentThisHour = Array.from({ length: 15 }, (_, i) => ({ id: `o${i}`, user_id: U(100 + i), step: "plan_30m", status: "sent", created_at: ago(20), sent_at: ago(20) }));
  const db = fakeDb([cust(1, 45)], { nudges: sentThisHour });
  const r = fakeResend();
  assert.deepEqual(await nudgesTick(db.sb, { env: ENV, fetch: r.fetchFn, now: () => NOW }), { sent: 0, skipped: 0, failed: 0, waiting: 1 });
  assert.deepEqual(await nudgesTick(db.sb, { env: { ...ENV, STUDIO_NUDGES: "off" }, fetch: r.fetchFn, now: () => NOW }), { sent: 0, skipped: 0, failed: 0, waiting: 0 });
  assert.equal(r.sent.length, 0);
});
