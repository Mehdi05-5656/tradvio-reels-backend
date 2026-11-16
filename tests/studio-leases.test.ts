import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { claimJob, heldJobs, isStopping, releaseHeld, resetLeases, stopGracefully } from "../src/studio-leases.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function db() {
  const d = new PGlite();
  await d.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${U}','ann@synthetic.invalid','{}');`);
  await d.exec(await readFile("migrations/20261027000000_studio_foundation.sql", "utf8"));
  const sql = await readFile("migrations/20261123000000_studio_release.sql", "utf8");
  await d.exec(sql); await d.exec(sql); // idempotent
  const rpc = async (fn: string, args: any[]) => (await d.query<any>(`SELECT to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})) r`, args)).rows[0].r;
  await rpc("studio_apply_subscription", [U, "cus_1", "sub_1", "starter", "month", "active", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, 1000, 1]);
  await rpc("studio_grant", [U, 1000, "in_1", true, null]);
  return { d, rpc };
}

test("studio_release: only the holder's token, only while running; back in the queue at once, the attempt given back, the progress kept", async (t) => {
  const { d, rpc } = await db(); t.after(() => d.close());
  const job = await rpc("studio_create_job", [U, "recast", null, {}, 100]);
  const a = await rpc("studio_claim", ["recast", "old-server"]);
  assert.equal(a.id, job.id); assert.equal(a.attempts, 1);
  assert.equal(await rpc("studio_renew", [a.id, a.lease_token, { stage: "cutting", made: [{ rank: 1 }] }]), true);
  assert.equal(await rpc("studio_release", [a.id, "00000000-0000-4000-8000-000000000000", "x"]), false, "a stranger's token releases nothing");
  assert.equal(await rpc("studio_release", [a.id, a.lease_token, "server stopping (SIGTERM)"]), true);
  const after = (await d.query<any>("SELECT status, attempts, lease_token, lease_until, worker, error_code, progress, credits_reserved FROM studio_jobs WHERE id=$1", [a.id])).rows[0];
  assert.deepEqual([after.status, after.attempts, after.lease_token, after.lease_until, after.worker], ["queued", 0, null, null, null]);
  assert.match(after.error_code, /SIGTERM/);
  assert.equal(after.progress.made[0].rank, 1, "the work saved so far is kept for the next attempt");
  assert.equal(after.credits_reserved, 100, "nothing charged or refunded: the reservation waits for the run");
  assert.equal(await rpc("studio_release", [a.id, a.lease_token, "again"]), false, "the old token is spent");
  // the new server takes it straight away (no lease to wait out) and the old server can no longer touch it
  const b = await rpc("studio_claim", ["recast", "new-server"]);
  assert.equal(b.id, a.id); assert.equal(b.attempts, 1, "a deploy did not use up one of its three tries");
  assert.equal(await rpc("studio_renew", [a.id, a.lease_token, null]), false, "the old server's renewals fail");
  await assert.rejects(rpc("studio_complete", [a.id, a.lease_token, [], 10]), /lease_lost/, "and so would its finish");
  await rpc("studio_complete", [b.id, b.lease_token, [], 60]);
  assert.equal(await rpc("studio_release", [b.id, b.lease_token, "late"]), false, "a finished job is never put back");
  assert.equal((await d.query<any>("SELECT status, credits_charged FROM studio_jobs WHERE id=$1", [b.id])).rows[0].status, "done");
});

function fakeSb(o: { releaseError?: any } = {}) {
  const calls: Array<[string, any]> = [];
  let n = 0;
  return { calls, rpc: async (fn: string, args: any) => {
    calls.push([fn, args]);
    if (fn === "studio_claim") { n++; return { data: { id: `job${n}`, lease_token: `tok${n}`, tool: args.p_tool }, error: null }; }
    if (fn === "studio_release") return o.releaseError ? { data: null, error: o.releaseError } : { data: args.p_job !== "job2", error: null };
    return { data: null, error: null };
  } };
}

test("claimJob remembers what it took; releaseHeld hands each back with its own token; nothing is taken once stopping", async () => {
  resetLeases();
  const sb = fakeSb();
  const r = await claimJob(sb, "clips", "w1");
  assert.equal(r.data.id, "job1", "the loop reads the answer as before");
  await claimJob(sb, "stunts", "w1");
  assert.deepEqual(heldJobs().map((h) => [h.id, h.token, h.tool]), [["job1", "tok1", "clips"], ["job2", "tok2", "stunts"]]);
  const out = await releaseHeld(sb, "server stopping (SIGTERM)", () => {});
  assert.deepEqual(out, { released: ["job1"], kept: ["job2"] }, "job2 had already finished: left alone");
  assert.deepEqual(sb.calls.filter((c) => c[0] === "studio_release").map((c) => [c[1].p_job, c[1].p_token]), [["job1", "tok1"], ["job2", "tok2"]]);
  assert.equal(heldJobs().length, 0);
  resetLeases();
  const failing = fakeSb({ releaseError: { message: "could not find the function public.studio_release" } });
  await claimJob(failing, "clips", "w1");
  const logs: string[] = [];
  assert.deepEqual(await releaseHeld(failing, "x", (l) => logs.push(l)), { released: [], kept: [] }, "without the function the job is left to its lease");
  assert.ok(!failing.calls.some((c) => c[0] === "studio_fail"), "never failed or refunded on the way out");
  assert.match(logs[0], /could not hand back clips job job1/);
  resetLeases();
});

test("stopGracefully: no more jobs, open requests get their time, then every held job goes back, buffers are written, exit 0; a second signal changes nothing", async () => {
  resetLeases();
  const sb = fakeSb();
  await claimJob(sb, "clips", "w1");
  const order: string[] = [];
  let exitCode: number | null = null;
  const server = { close(cb?: () => void) { order.push("close"); setTimeout(() => { order.push("closed"); cb?.(); }, 30); }, closeIdleConnections() { order.push("idle"); } };
  const flush = [async () => { order.push("flush events"); }, async () => { order.push("flush costs"); }];
  const logs: string[] = [];
  const done = stopGracefully({ signal: "SIGTERM", sb: () => ({ rpc: async (fn: string, a: any) => { order.push(fn); return sb.rpc(fn, a); } }), server, flush, log: (l) => logs.push(l), exit: (c) => { exitCode = c; order.push("exit"); } });
  assert.equal(isStopping(), true);
  assert.deepEqual(await claimJob(sb, "clips", "w1"), { data: null, error: null }, "nothing taken once stopping");
  await stopGracefully({ signal: "SIGTERM", sb: () => sb, exit: () => { throw new Error("must not exit twice"); } });
  await done;
  assert.deepEqual(order, ["close", "idle", "closed", "studio_release", "flush events", "flush costs", "exit"], "requests first, then the jobs, then the buffers");
  assert.equal(exitCode, 0);
  assert.match(logs.join("\n"), /handed back 1 job\(s\) to the queue: job1/);
  resetLeases();
});

test("stopGracefully: requests that never end do not hold the jobs past the wait", async () => {
  resetLeases();
  const sb = fakeSb();
  await claimJob(sb, "reshoot", "w1");
  let exited = false;
  const began = Date.now();
  await stopGracefully({ signal: "SIGTERM", sb: () => sb, server: { close() { /* a long-poll that never closes */ } }, log: () => {}, waitMs: 200, exit: () => { exited = true; } });
  assert.ok(exited && Date.now() - began < 2000, "out well inside Render's 30 s");
  assert.ok(sb.calls.some((c) => c[0] === "studio_release"));
  resetLeases();
});
