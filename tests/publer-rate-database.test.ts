import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = () => readFile("migrations/20261011210000_publer_rate_budget.sql", "utf8");

test("shared budget caps publishing at 80 and analytics at 40 per sliding 2 minutes, and honours blocks", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;"); // matches Supabase
  const m = await migration();
  await db.exec(m); await db.exec(m); // idempotent
  await db.exec("SET ROLE service_role");
  const take = async (lane: string) => (await db.query<any>("SELECT publer_rate_acquire($1) w", [lane])).rows[0].w as number;

  for (let i = 0; i < 40; i++) assert.equal(await take("analytics"), 0);
  const aWait = await take("analytics");
  assert.ok(aWait > 100_000 && aWait <= 120_500, `analytics wait ${aWait}`);
  for (let i = 0; i < 40; i++) assert.equal(await take("publish"), 0);
  const pWait = await take("publish");
  assert.ok(pWait > 100_000 && pWait <= 120_500);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM publer_rate_events")).rows[0].n, 80);

  // Old events age out of the 2-minute window and are pruned after 10 minutes.
  await db.exec("UPDATE publer_rate_events SET at = at - interval '11 minutes'");
  assert.equal(await take("publish"), 0);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM publer_rate_events")).rows[0].n, 1);

  // A 429 elsewhere pauses everyone; absurd reset times are capped at 150 seconds.
  await db.exec("SELECT publer_rate_block(clock_timestamp() + interval '1 hour', '429 GET /job_status/x')");
  const bWait = await take("publish");
  assert.ok(bWait > 145_000 && bWait <= 150_000, `block wait ${bWait}`);
  assert.equal((await db.query<any>("SELECT last_block_reason r FROM publer_rate_state")).rows[0].r, "429 GET /job_status/x");
  await db.exec("UPDATE publer_rate_state SET blocked_until = clock_timestamp() - interval '1 second'");
  assert.equal(await take("publish"), 0);
  await assert.rejects(db.query("SELECT publer_rate_acquire('other')"), /invalid_lane/);
  await db.exec("RESET ROLE");

  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query("SELECT publer_rate_acquire('publish')"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM publer_rate_events"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM publer_analytics_pulls"), /permission denied/);
    await db.exec("RESET ROLE");
  }
});
