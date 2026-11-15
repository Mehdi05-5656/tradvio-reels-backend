// Credit expiry (migrations/20261122000000_studio_credit_expiry.sql) on a real Postgres engine (PGlite, in memory):
// the live credit functions as they are (tests/sql/live-credit-functions.sql), some credits held, then the migration,
// then the rules. Not part of `npm test` (it needs @electric-sql/pglite). Run:
//   npm i --no-save @electric-sql/pglite@0.3.15 && node tests/sql/credit-expiry.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
let n = 0; const ok = (name) => { n++; console.log(`ok ${name}`); };
const U = (k) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const bal = async (u) => (await one("SELECT public.studio_balance($1) AS b", [u])).b;
const lotsLeft = async (u) => Number((await one("SELECT coalesce(sum(remaining),0)::int AS s FROM public.studio_credit_lots WHERE user_id = $1", [u])).s);
/** the batches always add up to the balance */
const inStep = async (u, what) => assert.equal(await lotsLeft(u), await bal(u), `${what}: batches = balance`);
const daysFromNow = async (ts) => Math.round((new Date(ts).getTime() - Date.now()) / 86400000);

await db.exec(fs.readFileSync(path.join(here, "live-credit-functions.sql"), "utf8"));
// ---- before the switch-on: people holding credits the way they are held today
const MONTHLY = U(1), YEARLY = U(2), FREE = U(3), INFLIGHT = U(4), YEARLY_SMALL = U(5);
for (const u of [MONTHLY, YEARLY, FREE, INFLIGHT, YEARLY_SMALL]) await q("INSERT INTO auth.users (id) VALUES ($1)", [u]);
await q("INSERT INTO public.studio_customers (user_id, plan_id, billing_interval, status, period_start, period_end, credits_per_period) VALUES ($1,'creator','month','active', now() - interval '5 days', now() + interval '25 days', 3500)", [MONTHLY]);
await q("INSERT INTO public.studio_customers (user_id, plan_id, billing_interval, status, period_start, period_end, credits_per_period) VALUES ($1,'creator','year','active', now() - interval '15 days', now() + interval '350 days', 3500)", [YEARLY]);
await q("INSERT INTO public.studio_customers (user_id, plan_id, billing_interval, status, period_start, period_end, credits_per_period) VALUES ($1,'studio','year','active', now() - interval '15 days', now() + interval '350 days', 10000)", [YEARLY_SMALL]);
await q("INSERT INTO public.studio_customers (user_id, plan_id, billing_interval, status, period_start, period_end, credits_per_period, parallel_jobs) VALUES ($1,'creator','month','active', now() - interval '5 days', now() + interval '25 days', 3500, 2)", [INFLIGHT]);
await q("SELECT public.studio_grant($1, 5000, 'in_m1', true, 'Creator invoice')", [MONTHLY]);
await q("SELECT public.studio_grant($1, 42000, 'in_y1', true, 'Creator annual subscription_create')", [YEARLY]);
await q("INSERT INTO public.studio_credit_ledger (user_id, delta, reason, job_id) VALUES ($1, -6336, 'reserve', gen_random_uuid())", [YEARLY]); // spent 6,336: holds 35,664
await q("SELECT public.studio_grant($1, 8000, 'in_y2', true, 'Studio annual')", [YEARLY_SMALL]);                                            // holds less than a month's
await q("SELECT public.studio_grant($1, 300, 'gift-1', false, 'Welcome')", [FREE]);
await q("SELECT public.studio_grant($1, 2000, 'in_i1', true, 'Creator invoice')", [INFLIGHT]);
const inflight = await one("SELECT (public.studio_create_job($1, 'swap', NULL, '{}', 500)).id AS id", [INFLIGHT]);       // a video running at the switch-on
await q("UPDATE public.studio_jobs SET status = 'running', lease_token = '11111111-1111-4111-8111-111111111111' WHERE id = $1", [inflight.id]);

await db.exec(fs.readFileSync(path.join(here, "../../migrations/20261122000000_studio_credit_expiry.sql"), "utf8"));

// ---- the switch-on
{
  for (const u of [MONTHLY, FREE, INFLIGHT]) {
    const lots = await q("SELECT kind, remaining, expires_at FROM public.studio_credit_lots WHERE user_id = $1", [u]);
    assert.equal(lots.length, 1); assert.equal(lots[0].kind, "legacy"); assert.equal(lots[0].expires_at, null, "credits held at the switch-on never expire"); await inStep(u, "switch-on");
  }
  assert.equal(await bal(MONTHLY), 5000, "nobody's balance changes at the switch-on");
  ok("what people hold at the switch-on becomes one batch that never expires; balances unchanged");
}
{
  for (const u of [YEARLY, YEARLY_SMALL]) {
    const lot = await one("SELECT l.expires_at, c.period_end FROM public.studio_credit_lots l JOIN public.studio_customers c USING (user_id) WHERE l.user_id = $1", [u]);
    assert.equal(new Date(lot.expires_at).getTime(), new Date(lot.period_end).getTime(), "a yearly plan's credits last until the end of the year paid for");
    assert.equal(Number((await one("SELECT count(*) AS c FROM public.studio_credit_schedule WHERE user_id = $1", [u])).c), 0, "nothing is held back");
    await inStep(u, "yearly switch-on");
  }
  assert.equal(await bal(YEARLY), 35664, "a yearly plan's balance is untouched");
  assert.equal(Number((await one("SELECT count(*) AS c FROM public.studio_credit_ledger WHERE reason = 'adjust'")).c), 0, "no adjustment for anyone");
  ok("a yearly plan's credits at the switch-on stay whole and last until the end of the year paid for");
}
// ---- spending, refunds
{
  const u = MONTHLY;
  await q("SELECT public.studio_grant($1, 1000, 'cs_topup1', false, 'Top-up $40')", [u]);
  await q("SELECT public.studio_grant($1, 700, 'apple_tx1', false, 'Starter pack (Apple)')", [u]);
  const kinds = await q("SELECT kind, expires_at FROM public.studio_credit_lots WHERE user_id = $1 ORDER BY id", [u]);
  assert.deepEqual(kinds.map((k) => k.kind), ["legacy", "topup", "apple_pack"]);
  assert.equal(await daysFromNow(kinds[1].expires_at), 365, "bought on the website: 12 months"); assert.equal(kinds[2].expires_at, null, "bought in the iPhone app: never");
  const j = await one("SELECT (public.studio_create_job($1, 'swap', NULL, '{}', 5500)).id AS id", [u]);
  const left = await q("SELECT kind, remaining FROM public.studio_credit_lots WHERE user_id = $1 ORDER BY id", [u]);
  assert.deepEqual(left.map((l) => [l.kind, l.remaining]), [["legacy", 500], ["topup", 0], ["apple_pack", 700]], "credits with a date go first, never-expiring ones last");
  await inStep(u, "after a reservation");
  await q("UPDATE public.studio_jobs SET status = 'running', lease_token = '22222222-2222-4222-8222-222222222222' WHERE id = $1", [j.id]);
  await q("SELECT public.studio_complete($1, '22222222-2222-4222-8222-222222222222', '[]', 5200)", [j.id]);
  const back = await q("SELECT kind, remaining FROM public.studio_credit_lots WHERE user_id = $1 ORDER BY id", [u]);
  assert.deepEqual(back.map((l) => [l.kind, l.remaining]), [["legacy", 800], ["topup", 0], ["apple_pack", 700]], "an unused part goes back to a batch it came from, the longest-lasting first");
  await inStep(u, "after a partial refund");
  ok("credits are spent soonest-expiring first, and refunds go back to the batches they came from");
}
{
  // a video running at the switch-on reserved before batches existed: its credits were held before the rule, so they come back never expiring
  await q("SELECT public.studio_fail($1, '11111111-1111-4111-8111-111111111111', 'render_failed', false)", [inflight.id]);
  const r = await one("SELECT kind, amount, expires_at FROM public.studio_credit_lots WHERE user_id = $1 AND ref = 'refund'", [INFLIGHT]);
  assert.equal(r.amount, 500); assert.equal(r.kind, "legacy"); assert.equal(r.expires_at, null); await inStep(INFLIGHT, "refund of a pre-switch-on video");
  ok("a video reserved before the switch-on is refunded as never-expiring credits, like everything held then");
}
// ---- expiry
{
  const u = FREE;
  await q("UPDATE public.studio_credit_lots SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u]);
  const m = await one("SELECT public.studio_credit_maintenance() AS r");
  assert.ok(m.r.expired >= 300); assert.equal(await bal(u), 0, "a batch past its date is gone");
  const e = await one("SELECT delta, note FROM public.studio_credit_ledger WHERE user_id = $1 AND reason = 'expire'", [u]);
  assert.equal(e.delta, -300); assert.match(e.note, /^Received \w{3} \d+, expired \w{3} \d+$/);
  await inStep(u, "after expiry");
  assert.equal((await one("SELECT public.studio_credit_maintenance() AS r")).r.expired, 0, "nothing expires twice");
  ok("an hourly run expires what is left of each batch past its date, once, with a dated note");
}
{
  // decision (owner, Nov 13 2026): refunded credits keep their batch's date, even one that has passed
  const u = U(6); await q("INSERT INTO auth.users (id) VALUES ($1)", [u]);
  await q("INSERT INTO public.studio_customers (user_id, status) VALUES ($1, 'active')", [u]);
  await q("SELECT public.studio_grant($1, 400, 'in_x', true, 'Starter invoice')", [u]);
  const j = await one("SELECT (public.studio_create_job($1, 'swap', NULL, '{}', 400)).id AS id", [u]);
  await q("UPDATE public.studio_credit_lots SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u]);
  await q("SELECT public.studio_credit_maintenance()"); assert.equal(await bal(u), 0, "nothing left to expire while it is reserved");
  await q("UPDATE public.studio_jobs SET status = 'running', lease_token = '33333333-3333-4333-8333-333333333333' WHERE id = $1", [j.id]);
  await q("SELECT public.studio_fail($1, '33333333-3333-4333-8333-333333333333', 'x', false)", [j.id]);
  assert.equal(await bal(u), 400, "the refund comes back"); await inStep(u, "refund to an expired batch");
  await q("SELECT public.studio_credit_maintenance()"); assert.equal(await bal(u), 0, "and, its batch's date having passed, expires at the next run");
  await inStep(u, "after the re-expiry");
  ok("a refund keeps its batch's date, even one that has passed");
}
{
  // never below zero: a batch past its date while an adjustment already took the balance down
  const u = U(7); await q("INSERT INTO auth.users (id) VALUES ($1)", [u]);
  await q("SELECT public.studio_grant($1, 100, 'g7', false, 'gift')", [u]);
  await q("INSERT INTO public.studio_credit_ledger (user_id, delta, reason, ref) VALUES ($1, -100, 'adjust', 'apple-refund')", [u]);
  await q("UPDATE public.studio_credit_lots SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u]);
  await q("SELECT public.studio_credit_maintenance()"); assert.equal(await bal(u), 0); await inStep(u, "never negative");
  ok("expiring never takes a balance below zero");
}
// ---- yearly plans, months released
{
  const u = U(8); await q("INSERT INTO auth.users (id) VALUES ($1)", [u]);
  const g = await one("SELECT public.studio_grant_spread($1, 42000, 'in_annual1', now() + interval '12 months', 'Creator annual') AS r", [u]);
  assert.deepEqual([g.r.months, g.r.each, g.r.now], [12, 3500, 3500]); assert.equal(await bal(u), 3500);
  const s = await q("SELECT amount, ref, note FROM public.studio_credit_schedule WHERE user_id = $1 ORDER BY release_at", [u]);
  assert.equal(s.length, 11); assert.equal(s[0].ref, "in_annual1:m2"); assert.equal(s[10].ref, "in_annual1:m12"); assert.match(s[0].note, /Creator annual · month 2/);
  assert.equal((await one("SELECT public.studio_grant_spread($1, 42000, 'in_annual1', now() + interval '12 months', 'x') AS r", [u])).r.granted, false, "the same invoice twice grants once");
  await q("UPDATE public.studio_credit_schedule SET release_at = now() - interval '1 minute' WHERE user_id = $1 AND ref = 'in_annual1:m2'", [u]);
  assert.equal((await one("SELECT public.studio_credit_maintenance() AS r")).r.released, 3500);
  assert.equal(await bal(u), 7000); const m2 = await one("SELECT kind, expires_at FROM public.studio_credit_lots WHERE user_id = $1 AND ref = 'in_annual1:m2'", [u]);
  assert.equal(m2.kind, "plan"); assert.equal(await daysFromNow(m2.expires_at), 60, "each month's credits last 60 days from when they arrive");
  assert.equal((await one("SELECT public.studio_credit_maintenance() AS r")).r.released, 0, "released once");
  const up = await one("SELECT public.studio_grant_spread($1, 9000, 'in_upgrade', now() + interval '3 months', 'Studio annual upgrade') AS r", [u]);
  assert.deepEqual([up.r.months, up.r.each, up.r.now], [3, 3000, 3000], "an upgrade part-way through: one batch per month left");
  const odd = await one("SELECT public.studio_grant_spread($1, 1000, 'in_odd', now() + interval '3 months', 'x') AS r", [u]);
  assert.equal(odd.r.now + odd.r.each * (odd.r.months - 1), 1000, "an amount that does not divide evenly loses nothing");
  await inStep(u, "yearly plan");
  ok("a yearly plan's credits arrive month by month, each lasting 60 days; an upgrade spreads over the months left");
}
{
  // promo codes and referrals: 60 days; what the app shows
  const u = U(9); await q("INSERT INTO auth.users (id) VALUES ($1)", [u]);
  await q("INSERT INTO public.studio_promo_codes (code, credits) VALUES ('HELLO', 250)");
  await q("SELECT public.studio_redeem_promo($1, 'hello')", [u]);
  const p = await one("SELECT kind, expires_at FROM public.studio_credit_lots WHERE user_id = $1", [u]); assert.equal(p.kind, "promo"); assert.equal(await daysFromNow(p.expires_at), 60);
  await q("SELECT public.studio_grant($1, 1000, 'cs_pack1', false, 'Creator pack')", [u]);
  await q("SELECT public.studio_grant($1, 500, 'apple_tx9', false, 'Starter pack (Apple)')", [u]);
  await q("SELECT public.studio_grant_spread($1, 7000, 'in_y9', now() + interval '2 months', 'Creator annual')", [u]);
  const s = (await one("SELECT public.studio_credit_summary($1) AS s", [u])).s;
  assert.equal(s.expiring.credits, 250 + 3500, "the next batch to expire: everything due that day"); assert.equal(await daysFromNow(s.expiring.at), 60);
  assert.equal(s.never, 500); assert.equal(s.upcoming.credits, 3500); assert.equal(s.upcoming.held, 3500); assert.ok([28, 29, 30, 31].includes(await daysFromNow(s.upcoming.at)), 'next month');
  const empty = (await one("SELECT public.studio_credit_summary($1) AS s", [U(3)])).s; assert.equal(empty.expiring, null); assert.equal(empty.upcoming, null);
  await inStep(u, "promo and summary");
  ok("promo codes last 60 days; the summary gives the next expiry, what never expires, and the next month to come");
}
{
  // the rule as a whole: every person, batches = balance
  const people = await q("SELECT DISTINCT user_id FROM public.studio_credit_ledger");
  for (const p of people) await inStep(p.user_id, `person ${p.user_id.slice(-2)}`);
  ok(`every person's batches add up to their balance (${people.length} people)`);
}
console.log(`credit expiry: ${n} passed`);
