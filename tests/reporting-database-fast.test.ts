import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

const schema=`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE publer_analytics(id bigint primary key,phone_slot text,publer_post_id text,captured_at timestamptz,
    video_views integer,reach integer,likes integer,comments integer,shares integer,saves integer,raw jsonb);`;

test("fast report SQL returns exactly the original function's output across ranges and edge cases",async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(schema);
  // Deterministic synthetic history: several slots, shared and null post ids, ties, DST boundary dates.
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  const rows:string[]=[];
  const base=Date.parse("2026-10-25T00:00:00Z");
  for(let id=1;id<=4000;id++){
    const slot=["a","b","c","d"][Math.floor(rnd()*4)];
    const post=rnd()<0.04?null:`p${Math.floor(rnd()*60)}`;
    const at=new Date(base+Math.floor(rnd()*30*24*4)*15*60000).toISOString();
    const views=rnd()<0.1?"NULL":String(Math.floor(rnd()*5000));
    const raw=JSON.stringify({id:post,text:`caption ${id}`,scheduled_at:at}).replace(/'/g,"''");
    rows.push(`(${id},'${slot}',${post?`'${post}'`:"NULL"},'${at}',${views},1,2,3,4,5,'${raw}')`);
  }
  await db.exec(`INSERT INTO publer_analytics VALUES ${rows.join(",")}`);
  await db.exec((await readFile("migrations/20261011193000_dashboard_report.sql","utf8"))
    .replace(/dashboard_report_snapshots/g,"old_report_snapshots"));
  const fast=await readFile("migrations/20261011194000_dashboard_report_fast.sql","utf8");
  await db.exec(fast);await db.exec(fast);
  const cases=[
    [["a"],"2026-11-01T07:00:00Z","2026-11-02T07:00:00Z"],
    [["a","b","c","d"],"2026-11-01T07:00:00Z","2026-11-08T08:00:00Z"],
    [["b","d"],"2026-10-25T07:00:00Z","2026-11-24T08:00:00Z"],
    [["c","zzz"],"2026-11-10T08:00:00Z","2026-11-11T08:00:00Z"],
    [["a","a"],"2026-11-20T08:00:00Z","2026-11-21T08:00:00Z"],
    [["none"],"2026-11-01T07:00:00Z","2026-11-02T07:00:00Z"],
  ] as const;
  for(const [slots,from,to] of cases){
    const args=[slots,from,to];
    const old=(await db.query<any>("SELECT old_report_snapshots($1,$2,$3) d",args as any)).rows[0].d;
    const now=(await db.query<any>("SELECT dashboard_report_snapshots($1,$2,$3) d",args as any)).rows[0].d;
    assert.deepEqual(now,old,`${slots} ${from}`);
  }
  const big=(await db.query<any>("SELECT jsonb_array_length(dashboard_report_snapshots(ARRAY['a','b','c','d'],'2026-11-01T07:00:00Z','2026-11-08T08:00:00Z')) n")).rows[0].n;
  assert.ok(big>100);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT dashboard_report_snapshots(ARRAY['a'],'2026-11-01','2026-11-02')"),/permission denied/);
  await db.exec("RESET ROLE");
  await assert.rejects(db.query("SELECT dashboard_report_snapshots(ARRAY['a'],'2026-11-02','2026-11-01')"),/invalid_report_range/);
  const idx=(await db.query<any>("SELECT indexname FROM pg_indexes WHERE tablename='publer_analytics' ORDER BY 1")).rows.map(r=>r.indexname);
  assert.ok(idx.includes("publer_analytics_report_post_capture")&&idx.includes("publer_analytics_report_range"));
});

test("old_id migration exposes Publer old_id and otherwise preserves the fast function output",async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO publer_analytics VALUES
    (1,'a','https://www.tiktok.com/@x/video/1','2026-10-11T08:00:00Z',5,1,1,1,1,1,'{"id":"9","old_id":"6aca","post_link":"https://www.tiktok.com/@x/video/1","scheduled_at":"2026-10-11T07:30:00Z","text":"hi"}'),
    (2,'a','https://www.tiktok.com/@x/video/1','2026-10-11T09:00:00Z',8,1,1,1,1,1,'{"id":"9","old_id":"6aca","post_link":"https://www.tiktok.com/@x/video/1","scheduled_at":"2026-10-11T07:30:00Z","text":"hi"}')`);
  await db.exec(await readFile("migrations/20261011194000_dashboard_report_fast.sql","utf8"));
  const q="SELECT dashboard_report_snapshots(ARRAY['a'],'2026-10-11T07:00:00Z','2026-10-12T07:00:00Z') d";
  const before=(await db.query<any>(q)).rows[0].d;
  const m=await readFile("migrations/20261011200000_dashboard_report_old_id.sql","utf8");
  await db.exec(m);await db.exec(m);
  const after=(await db.query<any>(q)).rows[0].d;
  assert.deepEqual(after.map((r:any)=>r.raw.old_id),["6aca","6aca"]);
  assert.deepEqual(after.map((r:any)=>{const {old_id,...raw}=r.raw;return {...r,raw};}),before);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query(q),/permission denied/);
});
