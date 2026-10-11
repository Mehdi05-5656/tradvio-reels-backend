import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
test("report SQL reduces snapshots, preserves baseline, bounds time and denies customer execution",async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE publer_analytics(id bigint,phone_slot text,publer_post_id text,captured_at timestamptz,
      video_views integer,reach integer,likes integer,comments integer,shares integer,saves integer,raw jsonb);
    INSERT INTO publer_analytics(id,phone_slot,publer_post_id,captured_at,video_views,raw) VALUES
      (1,'a','post','2026-10-10T01:00:00Z',10,'{}'),
      (2,'a','post','2026-10-11T06:00:00Z',20,'{}'),
      (3,'a','post','2026-10-11T08:00:00Z',25,'{}'),
      (4,'a','post','2026-10-11T09:00:00Z',30,'{}'),
      (5,'a','post','2026-10-11T10:00:00Z',35,'{}'),
      (6,'a','post','2026-10-12T08:00:00Z',900,'{}'),
      (7,'b','post','2026-10-11T09:00:00Z',500,'{}');`);
  const migration=await readFile("migrations/20261011193000_dashboard_report.sql","utf8");
  await db.exec(migration);await db.exec(migration);
  const q="SELECT dashboard_report_snapshots(ARRAY['a'],'2026-10-11T07:00:00Z','2026-10-12T07:00:00Z') data";
  const result=(await db.query<any>(q)).rows[0].data;
  assert.deepEqual(result.map((r:any)=>r.id),[2,3,5]);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query(q),/permission denied/);
  await db.exec("RESET ROLE");
  await assert.rejects(db.query("SELECT dashboard_report_snapshots(ARRAY['a'],'2026-10-12','2026-10-11')"),/invalid_report_range/);
});
