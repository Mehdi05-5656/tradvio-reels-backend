import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("privacy migration blocks browser table/view reads, preserves server access and rows, and is repeatable", async () => {
  const db = new PGlite();
  const tables = [
    "creatorvault_accounts", "creatorvault_config", "creatorvault_videos",
    "creatorvault_video_snapshots", "creatorvault_webhook_events",
    "source_video_stats", "content_fingerprints", "scheduled_reels", "video_content_features",
  ];
  const views = ["reels_dashboard_summary", "posted_reel_performance"];
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;");
    for (const name of tables) {
      await db.exec(`CREATE TABLE public.${name} (id int PRIMARY KEY, value text); INSERT INTO public.${name} VALUES (1, 'retained'); GRANT ALL ON public.${name} TO anon, authenticated, service_role;`);
    }
    for (const name of views) {
      await db.exec(`CREATE VIEW public.${name} AS SELECT * FROM public.creatorvault_accounts; GRANT ALL ON public.${name} TO anon, authenticated, service_role;`);
    }
    const migration = await readFile("migrations/20260923234000_account_data_server_only.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[])", [tables],
    );
    assert.equal(rls.rows.length, tables.length);
    assert.ok(rls.rows.every(r => r.relrowsecurity));
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      for (const name of [...tables, ...views]) {
        await assert.rejects(db.query(`SELECT * FROM public.${name}`), /permission denied/);
      }
      await db.exec("RESET ROLE");
    }
    await db.exec("SET ROLE service_role");
    for (const name of [...tables, ...views]) {
      const r = await db.query<{ id: number; value: string }>(`SELECT * FROM public.${name}`);
      assert.deepEqual(r.rows, [{ id: 1, value: "retained" }]);
    }
    for (const name of tables) {
      await db.exec(`UPDATE public.${name} SET value='server-ok' WHERE id=1`);
      const r = await db.query<{ value: string }>(`SELECT value FROM public.${name}`);
      assert.equal(r.rows[0].value, "server-ok");
    }
  } finally {
    await db.close();
  }
});
