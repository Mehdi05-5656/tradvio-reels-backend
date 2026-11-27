import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { busyAnswer, busyDetail, runLabel, poolOf } from "../src/studio-busy.js";
import { queueRank } from "../src/studio-clips.js";
import { PLANS } from "../src/studio.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // Starter
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // Creator
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // Studio
const O = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // the owner's pass, 10 at once

async function db(t: any) {
  const d = new PGlite(); t.after(() => d.close());
  await d.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${A}','a@synthetic.invalid','{}'),('${B}','b@synthetic.invalid','{}'),('${C}','c@synthetic.invalid','{}'),('${O}','o@synthetic.invalid','{}');`);
  await d.exec(await readFile("migrations/20261027000000_studio_foundation.sql", "utf8"));
  await d.exec("ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS owner_pass boolean NOT NULL DEFAULT false;");
  await d.exec(await readFile("migrations/20261111000000_studio_library_clips.sql", "utf8"));
  await d.exec(await readFile("migrations/20261112000000_studio_captions.sql", "utf8"));
  await d.exec(await readFile("migrations/20261124000100_studio_failures.sql", "utf8"));
  const sql = await readFile("migrations/20261121000000_studio_parallel_by_plan.sql", "utf8");
  await d.exec(sql); await d.exec(sql); // idempotent
  const rpc = async (fn: string, args: any[]) => (await d.query<any>(`SELECT to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})) r`, args)).rows[0].r;
  for (const [u, plan, n] of [[A, "starter", 1], [B, "creator", 2], [C, "studio", 4]] as const) {
    await rpc("studio_apply_subscription", [u, `cus_${plan}`, `sub_${plan}`, plan, "month", "active", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", false, 100000, n]);
    await rpc("studio_grant", [u, 100000, `in_${plan}`, true, null]);
  }
  await d.query(`INSERT INTO studio_customers(user_id, status, parallel_jobs, owner_pass) VALUES ($1, 'none', 10, true) ON CONFLICT (user_id) DO UPDATE SET owner_pass = true, parallel_jobs = 10`, [O]);
  await rpc("studio_grant", [O, 100000, "in_owner", true, null]);
  return { d, rpc };
}

test("Clips, Captions and imports each follow the plan's number, apart from the other tools", async (t) => {
  const { rpc } = await db(t);
  // Starter: one Clips run, and a Swap still starts beside it
  assert.equal((await rpc("studio_create_job", [A, "clips", null, {}, 10])).tool, "clips");
  await assert.rejects(rpc("studio_create_job", [A, "clips", null, {}, 10]), /too_many_jobs/, "Starter: one Clips run at a time");
  assert.equal((await rpc("studio_create_job", [A, "swap", null, {}, 10])).tool, "swap", "a Clips run never blocks the other tools");
  await assert.rejects(rpc("studio_create_job", [A, "recast", null, {}, 10]), /too_many_jobs/, "Starter: one run of the other tools");
  assert.equal((await rpc("studio_create_job", [A, "captions", null, {}, 3])).tool, "captions", "Captions counts on its own");
  // Creator: two Clips runs, not three
  for (let i = 0; i < 2; i++) assert.equal((await rpc("studio_create_job", [B, "clips", null, {}, 10])).tool, "clips");
  await assert.rejects(rpc("studio_create_job", [B, "clips", null, {}, 10]), /too_many_jobs/);
  // Studio: four
  for (let i = 0; i < 4; i++) await rpc("studio_create_job", [C, "clips", null, {}, 10]);
  await assert.rejects(rpc("studio_create_job", [C, "clips", null, {}, 10]), /too_many_jobs/);
  // the owner's pass: its own number (this is the refusal the owner hit with one Clips run going)
  for (let i = 0; i < 3; i++) await rpc("studio_create_job", [O, "clips", null, {}, 10]);
});

test("the priority queue: a free worker takes Studio, then Creator, then Starter; oldest first within a plan", async (t) => {
  const { d, rpc } = await db(t);
  const a = await rpc("studio_create_job", [A, "swap", null, {}, 1]);   // oldest, Starter
  const b = await rpc("studio_create_job", [B, "swap", null, {}, 1]);   // Creator
  const b2 = await rpc("studio_create_job", [B, "recast", null, {}, 1]);
  const c = await rpc("studio_create_job", [C, "swap", null, {}, 1]);   // newest, Studio
  await d.query("UPDATE studio_jobs SET tool = 'swap'");
  await d.query("UPDATE studio_jobs SET created_at = now() - (interval '1 minute' * CASE id WHEN $1::uuid THEN 4 WHEN $2::uuid THEN 3 WHEN $3::uuid THEN 2 ELSE 1 END)", [a.id, b.id, b2.id]);
  const order: string[] = [];
  for (let i = 0; i < 4; i++) order.push((await rpc("studio_claim", ["swap", "w1"])).id);
  assert.deepEqual(order, [c.id, b.id, b2.id, a.id]);
  assert.equal(await rpc("studio_claim", ["swap", "w1"]), null);
});

test("the worker_lost rule is kept: a job whose worker died three times is failed and refunded, not handed out again", async (t) => {
  const { d, rpc } = await db(t);
  const j = await rpc("studio_create_job", [A, "swap", null, {}, 40]);
  await d.query("UPDATE studio_jobs SET status = 'running', attempts = 3, lease_until = now() - interval '1 minute' WHERE id = $1", [j.id]);
  assert.equal(await rpc("studio_claim", ["swap", "w1"]), null);
  const row = (await d.query<any>("SELECT status, error_code FROM studio_jobs WHERE id = $1", [j.id])).rows[0];
  assert.deepEqual([row.status, row.error_code], ["failed", "worker_lost"]);
  assert.equal(Number((await d.query<any>("SELECT count(*) n FROM studio_failures WHERE job_id = $1 AND kind = 'lost'", [j.id])).rows[0].n), 1);
});

test("the busy answer: what takes the places, and the plan that would give more", () => {
  const jobs = [
    { id: "1", tool: "clips", status: "running", progress: { stage: "cutting" }, created_at: "2026-11-20T10:00:00Z" },
    { id: "2", tool: "kage_motion", status: "queued", options: { story: {} }, created_at: "2026-11-20T10:05:00Z" },
  ];
  const a = busyAnswer("clips", { plan_id: "starter", parallel_jobs: 1 }, jobs, PLANS);
  assert.equal(a.pool, "clips"); assert.equal(a.limit, 1);
  assert.deepEqual(a.running.map((r) => [r.label, r.stage]), [["Clips", "cutting"]], "only the Clips run counts for Clips");
  assert.deepEqual(a.next, { id: "creator", name: "Creator", parallel: 2, monthly_usd: 79 });
  assert.match(busyDetail(a), /^Your plan runs 1 Clips run at a time, and one is going\. Upgrade to Creator for 2 at once, or wait for one to finish\.$/);
  const s = busyAnswer("swap", { plan_id: "studio", parallel_jobs: 4 }, jobs, PLANS);
  assert.equal(s.pool, "tools"); assert.deepEqual(s.running.map((r) => r.label), ["Story"]); assert.equal(s.next, null, "Studio is the most there is");
  assert.match(busyDetail(s), /This one can start when one finishes/);
  assert.equal(busyAnswer("clips", { plan_id: null, parallel_jobs: 10, owner_pass: true }, jobs, PLANS).next, null, "no upgrade offered on the owner's pass");
  assert.equal(runLabel("kage_motion", { motivation: {} }), "Motivation"); assert.equal(runLabel("blueprint_versions", {}), "Blueprint");
  assert.equal(poolOf("import"), "import"); assert.equal(poolOf("recast"), "tools");
});

test("the Clips queue estimate takes runs in the same order as the servers", () => {
  assert.deepEqual([queueRank({ plan_id: "studio" }), queueRank({ owner_pass: true }), queueRank({ plan_id: "creator" }), queueRank({ plan_id: "starter" }), queueRank(undefined)], [0, 0, 1, 2, 2]);
});

test("a product piece is named by its own title, not 'Instruments'", () => {
  assert.equal(runLabel("instrument", { look: "move-turn", look_title: "Half turn" }), "Half turn");
  assert.equal(runLabel("instrument", { hook: { tier: "standard" }, look_title: "Hook · Standard" }), "Hook · Standard");
  assert.equal(runLabel("instrument", {}), "Instruments");
});
