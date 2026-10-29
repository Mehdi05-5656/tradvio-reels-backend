import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = "migrations/20261027000000_studio_foundation.sql";
const MIGRATION2 = "migrations/20261029000000_studio_referrals_notices.sql";
const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function setup(t: any) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${ANN}','ann@synthetic.invalid','{}'),('${BOB}','bob@synthetic.invalid','{}');
  `);
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.exec(await readFile(MIGRATION, "utf8")); // idempotent
  await db.exec(await readFile(MIGRATION2, "utf8"));
  await db.exec(await readFile(MIGRATION2, "utf8")); // idempotent
  const rpc = async (fn: string, args: any[]) => (await db.query<any>(`SELECT to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})) r`, args)).rows[0].r;
  const balance = async (u: string) => (await db.query<any>("SELECT studio_balance($1) b", [u])).rows[0].b as number;
  const subscribe = (u: string, parallel = 2) => rpc("studio_apply_subscription", [u, "cus_test1", "sub_test1", "starter", "month", "active", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, 1000, parallel]);
  const asset = async (u: string) => (await db.query<any>(`INSERT INTO studio_assets(user_id,kind,name,object_key,bytes,status) VALUES($1::uuid,'video','a.mp4',$1::text||'/'||gen_random_uuid()::text||'.mp4',1000,'ready') RETURNING id`, [u])).rows[0].id as string;
  return { db, rpc, balance, subscribe, asset };
}

test("buckets exist, are private and accept only the expected files", async (t) => {
  const { db } = await setup(t);
  const rows = (await db.query<any>("SELECT id, public, allowed_mime_types FROM storage.buckets ORDER BY id")).rows;
  assert.deepEqual(rows.map((r: any) => [r.id, r.public]), [["studio-outputs", false], ["studio-uploads", false]]);
  assert.ok(rows[1].allowed_mime_types.includes("video/mp4"));
});

test("grants are unique per invoice and expire the previous period's leftovers", async (t) => {
  const { rpc, balance, subscribe } = await setup(t);
  await subscribe(ANN);
  assert.equal((await rpc("studio_grant", [ANN, 1000, "in_oct", true, null])).granted, true);
  assert.equal(await balance(ANN), 1000);
  assert.equal((await rpc("studio_grant", [ANN, 1000, "in_oct", true, null])).granted, false, "a replayed webhook grants nothing");
  assert.equal(await balance(ANN), 1000);
  const r = await rpc("studio_grant", [ANN, 1000, "in_nov", true, null]);
  assert.deepEqual([r.granted, r.expired, r.balance], [true, 1000, 1000], "leftover credits expire when the next period is granted");
  await assert.rejects(rpc("studio_grant", [ANN, 0, "in_dec", true, null]), /invalid_credits/);
  await assert.rejects(rpc("studio_grant", [ANN, 10, "", true, null]), /ref_required/);
});

test("a job reserves credits, settles what it used and refunds the rest", async (t) => {
  const { rpc, balance, subscribe, asset } = await setup(t);
  await subscribe(ANN);
  await rpc("studio_grant", [ANN, 500, "in_1", true, null]);
  const a = await asset(ANN);
  const job = await rpc("studio_create_job", [ANN, "blueprint", a, { copies: 25 }, 100]);
  assert.equal(job.status, "queued"); assert.equal(job.credits_reserved, 100);
  assert.equal(await balance(ANN), 400, "reserved credits leave the balance immediately");
  const claimed = await rpc("studio_claim", ["blueprint", "worker-1"]);
  assert.equal(claimed.id, job.id); assert.equal(claimed.status, "running"); assert.ok(claimed.lease_token);
  assert.equal(await rpc("studio_claim", ["blueprint", "worker-2"]), null, "a leased job is not handed out twice");
  assert.equal(await rpc("studio_renew", [job.id, claimed.lease_token, { done: 10, total: 25 }]), true);
  assert.equal(await rpc("studio_renew", [job.id, "00000000-0000-4000-8000-000000000000", null]), false, "a wrong token cannot renew");
  const done = await rpc("studio_complete", [job.id, claimed.lease_token, [{ key: "x/1.mp4" }], 92]);
  assert.equal(done.status, "done"); assert.equal(done.credits_charged, 92);
  assert.equal(await balance(ANN), 408, "8 unused credits came back");
  await assert.rejects(rpc("studio_complete", [job.id, claimed.lease_token, [], 92]), /lease_lost/, "finishing twice is refused");
});

test("charging more than reserved is capped, failures refund, cancel refunds, retries requeue", async (t) => {
  const { rpc, balance, subscribe, asset } = await setup(t);
  await subscribe(ANN, 4);
  await rpc("studio_grant", [ANN, 300, "in_1", true, null]);
  const a = await asset(ANN);
  const j1 = await rpc("studio_create_job", [ANN, "recast", a, {}, 100]);
  const c1 = await rpc("studio_claim", ["recast", "w"]);
  const d1 = await rpc("studio_complete", [j1.id, c1.lease_token, [], 150]);
  assert.equal(d1.credits_charged, 100, "never more than the reservation");
  assert.equal(await balance(ANN), 200);
  const j2 = await rpc("studio_create_job", [ANN, "recast", a, {}, 100]);
  const c2 = await rpc("studio_claim", ["recast", "w"]);
  const r2 = await rpc("studio_fail", [j2.id, c2.lease_token, "provider_timeout", true]);
  assert.equal(r2.status, "queued", "first failure with retry goes back to the queue");
  assert.equal(await balance(ANN), 100, "still reserved while queued");
  const c2b = await rpc("studio_claim", ["recast", "w"]);
  const f2 = await rpc("studio_fail", [j2.id, c2b.lease_token, "provider_failed", false]);
  assert.equal(f2.status, "failed"); assert.equal(f2.credits_charged, 0);
  assert.equal(await balance(ANN), 200, "a failed job refunds everything");
  const j3 = await rpc("studio_create_job", [ANN, "blueprint", a, {}, 60]);
  assert.equal(await balance(ANN), 140);
  const x3 = await rpc("studio_cancel", [ANN, j3.id]);
  assert.equal(x3.status, "canceled"); assert.equal(await balance(ANN), 200);
  await assert.rejects(rpc("studio_cancel", [BOB, j3.id]), /job_not_found/, "someone else cannot cancel it");
  await assert.rejects(rpc("studio_cancel", [ANN, j1.id]), /job_not_cancelable/);
});

test("jobs need an active subscription, enough credits, a ready asset and a free slot", async (t) => {
  const { db, rpc, subscribe, asset } = await setup(t);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", null, {}, 10]), /subscription_required/);
  await subscribe(ANN, 1);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", null, {}, 10]), /insufficient_credits/);
  await rpc("studio_grant", [ANN, 100, "in_1", true, null]);
  const other = await asset(BOB);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", other, {}, 10]), /asset_not_ready/, "another person's asset");
  await db.exec(`UPDATE studio_assets SET status='uploading'`);
  const mine = await asset(ANN);
  await db.exec(`UPDATE studio_assets SET status='uploading' WHERE id='${mine}'`);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", mine, {}, 10]), /asset_not_ready/, "still uploading");
  await db.exec(`UPDATE studio_assets SET status='ready' WHERE id='${mine}'`);
  await rpc("studio_create_job", [ANN, "blueprint", mine, {}, 10]);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", mine, {}, 10]), /too_many_jobs/, "parallel limit of the plan");
  await rpc("studio_apply_subscription", [ANN, "cus_test1", "sub_test1", "starter", "month", "canceled", null, null, false, 0, 1]);
  await assert.rejects(rpc("studio_create_job", [ANN, "blueprint", mine, {}, 0]), /subscription_required/, "canceled plan");
});

test("promo codes grant once per person and respect expiry and use limits", async (t) => {
  const { db, rpc, balance } = await setup(t);
  await db.exec(`INSERT INTO studio_promo_codes(code,credits,max_uses) VALUES('LAUNCH50',50,2); INSERT INTO studio_promo_codes(code,credits,max_uses,expires_at) VALUES('OLDCODE',10,9,'2000-01-01')`);
  assert.equal((await rpc("studio_redeem_promo", [ANN, " launch50 "])).credits, 50);
  assert.equal(await balance(ANN), 50);
  await assert.rejects(rpc("studio_redeem_promo", [ANN, "LAUNCH50"]), /promo_already_used/);
  await rpc("studio_redeem_promo", [BOB, "LAUNCH50"]);
  const CAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await db.exec(`INSERT INTO auth.users VALUES ('${CAT}','cat@synthetic.invalid','{}')`);
  await assert.rejects(rpc("studio_redeem_promo", [CAT, "LAUNCH50"]), /promo_exhausted/);
  await assert.rejects(rpc("studio_redeem_promo", [ANN, "OLDCODE"]), /promo_expired/);
  await assert.rejects(rpc("studio_redeem_promo", [ANN, "NOPE"]), /promo_unknown/);
});

test("anon and authenticated roles cannot touch studio tables or functions", async (t) => {
  const { db } = await setup(t);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT * FROM studio_customers"), /permission denied/);
  await assert.rejects(db.query(`SELECT studio_balance('${ANN}')`), /permission denied/);
  await db.exec("RESET ROLE");
});

test("referrals: a stable code, applied once before paying, rewards both sides once on the first invoice", async (t) => {
  const { db, rpc, balance, subscribe } = await setup(t);
  const code = await rpc("studio_referral_code", [ANN]);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(await rpc("studio_referral_code", [ANN]), code, "same code every time");
  assert.deepEqual(await rpc("studio_apply_referral", [ANN, code]), { applied: false, reason: "own_code" });
  assert.deepEqual(await rpc("studio_apply_referral", [BOB, "NOPE2222"]), { applied: false, reason: "unknown_code" });
  assert.deepEqual(await rpc("studio_apply_referral", [BOB, code.toLowerCase()]), { applied: true, referrer: ANN });
  assert.deepEqual(await rpc("studio_apply_referral", [BOB, code]), { applied: false, reason: "already_referred" });
  assert.deepEqual(await rpc("studio_referral_reward", [ANN, 500]), { granted: false }, "nobody referred Ann");
  await subscribe(BOB);
  assert.deepEqual(await rpc("studio_referral_reward", [BOB, 500]), { granted: true, referrer: ANN, credits: 500 });
  assert.deepEqual([await balance(ANN), await balance(BOB)], [500, 500]);
  assert.deepEqual(await rpc("studio_referral_reward", [BOB, 500]), { granted: false }, "never twice");
  assert.deepEqual([await balance(ANN), await balance(BOB)], [500, 500]);
  const refs = (await db.query<any>("SELECT user_id, ref FROM studio_credit_ledger WHERE reason='promo' ORDER BY user_id")).rows;
  assert.deepEqual(refs, [{ user_id: ANN, ref: `referral:${BOB}` }, { user_id: BOB, ref: `referred:${ANN}` }]);
  // A paying customer cannot be referred afterwards.
  await rpc("studio_apply_subscription", [ANN, "cus_test2", "sub_test2", "starter", "month", "active", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, 1000, 2]);
  const CAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await db.exec(`INSERT INTO auth.users VALUES ('${CAL}','cal@synthetic.invalid','{}')`);
  const bobCode = await rpc("studio_referral_code", [BOB]);
  assert.equal((await rpc("studio_apply_referral", [ANN, bobCode])).reason, "already_customer");
  assert.equal((await rpc("studio_apply_referral", [CAL, bobCode])).applied, true);
});

test("notices: finished jobs are listed once, then marked", async (t) => {
  const { db, rpc, subscribe, asset } = await setup(t);
  await subscribe(ANN);
  await rpc("studio_grant", [ANN, 1000, "in_1", true, null]);
  const a = await asset(ANN);
  const job = await rpc("studio_create_job", [ANN, "blueprint", a, { copies: 2 }, 8]);
  assert.deepEqual(await rpc("studio_jobs_to_notify", [50]).catch(() => null), null, "set-returning: queried below instead");
  let rows = (await db.query<any>("SELECT id FROM studio_jobs_to_notify(50)")).rows;
  assert.equal(rows.length, 0, "a queued job is not final");
  const claimed = await rpc("studio_claim", ["blueprint", "w1"]);
  await rpc("studio_complete", [claimed.id, claimed.lease_token, [{ key: "k" }], 8]);
  rows = (await db.query<any>("SELECT id FROM studio_jobs_to_notify(50)")).rows;
  assert.deepEqual(rows.map((r: any) => r.id), [job.id]);
  await db.query("SELECT studio_mark_notified($1)", [job.id]);
  rows = (await db.query<any>("SELECT id FROM studio_jobs_to_notify(50)")).rows;
  assert.equal(rows.length, 0);
});
