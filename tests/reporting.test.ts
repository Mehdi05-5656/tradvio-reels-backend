import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, resolveRange, paged } from "../src/reporting.js";

const slot=(id="a")=>({phone_slot:id,handle:`handle_${id}`,provider:"instagram",paused:false,daily_target:8,owner_user_id:"owner"});
const log=(id:number,status="published",extra:any={})=>({id,phone_slot:"a",status,slot_local_date:"2026-10-11",slot_index:0,attempted_at:"2026-10-11T15:00:00Z",planned_at:"2026-10-11T15:00:00Z",publer_post_id:"post1",...extra});
const snap=(id:number,t:string,views:number|null,extra:any={})=>({id,phone_slot:"a",publer_post_id:"post1",captured_at:t,video_views:views,raw:{scheduled_at:"2026-10-10T15:00:00Z"},...extra});
const range=resolveRange({from:"2026-10-11",to:"2026-10-11"},new Date("2026-10-11T20:00:00Z"));
test("Pacific range rejects invalid, reversed and future dates; DST days differ",()=>{
  assert.throws(()=>resolveRange({from:"2026-02-30",to:"2026-10-11"}));
  assert.throws(()=>resolveRange({from:"2026-10-12",to:"2026-10-11"}));
  assert.throws(()=>resolveRange({from:"2027-01-01",to:"2027-01-02"},new Date("2026-10-11")));
  const r=resolveRange({from:"2026-11-01",to:"2026-11-01"},new Date("2026-11-02"));
  assert.equal((Date.parse(r.end)-Date.parse(r.start))/3600000,25);
});
test("all accounts survive without legacy device rows, retries are not posts",()=>{
  const r=buildReport(Array.from({length:18},(_,i)=>slot(String(i))),[],[],range);
  assert.equal(r.accounts.length,18);
  const out=buildReport([slot()],[log(1,"failed",{publer_post_id:null}),log(2),log(3)],[],range);
  assert.equal(out.totals.published,1);
  assert.equal(out.accounts[0].attempts.length,3);
  assert.equal(out.accounts[0].retry_windows,1);
  assert.equal(out.totals.attention,0);
  assert.equal(out.posts[0].video_views,null);
});
test("period changes do not sum cumulative snapshots or use future snapshots",()=>{
  const r=buildReport([slot()],[],[
    snap(1,"2026-10-11T06:59:00Z",100),
    snap(2,"2026-10-11T09:00:00Z",120),
    snap(3,"2026-10-11T12:00:00Z",135),
    snap(4,"2026-10-12T08:00:00Z",900)
  ],range);
  assert.equal(r.totals.observed_views,35);
  assert.equal(r.series.length,1);
  assert.equal(r.series[0].date,"2026-10-11");
  assert.equal(r.posts.length,0);
});
test("missing baseline stays unknown; downward corrections are flagged",()=>{
  const missing=buildReport([slot()],[],[snap(1,"2026-10-11T12:00:00Z",100)],range);
  assert.equal(missing.totals.observed_views,null);
  assert.equal(missing.coverage.missing_baselines,1);
  const corrected=buildReport([slot()],[],[snap(1,"2026-10-11T06:00:00Z",100),snap(2,"2026-10-11T12:00:00Z",90)],range);
  assert.equal(corrected.coverage.corrections,1);
  assert.equal(corrected.totals.observed_views,null);
});
test("joins are account-scoped, accept ID or URL and retain known zero",()=>{
  const out=buildReport([slot(),slot("b")],[log(1,"published",{publer_post_link:"https://www.instagram.com/reel/example/"})],[
    snap(1,"2026-10-11T17:00:00Z",0,{publer_post_id:"https://www.instagram.com/reel/example/",raw:{scheduled_at:"2026-10-11T15:00:00Z"}}),
    snap(2,"2026-10-11T17:00:00Z",999,{phone_slot:"b"})
  ],range);
  assert.equal(out.posts[0].video_views,0);
  assert.equal(out.totals.published,1);
});
test("published cohort includes analytics-only posts but not out-of-range dates",()=>{
  const out=buildReport([slot()],[],[
    snap(1,"2026-10-11T17:00:00Z",40,{raw:{scheduled_at:"2026-10-11T15:00:00Z"}}),
    snap(2,"2026-10-11T17:00:00Z",900,{publer_post_id:"old",raw:{scheduled_at:"2026-09-11T15:00:00Z"}})
  ],range);
  assert.equal(out.posts.length,1);
  assert.equal(out.posts[0].video_views,40);
  assert.equal(out.totals.published,0);
});
test("bounded pagination refuses partial totals",async()=>{
  await assert.rejects(paged((a,b)=>Promise.resolve({data:Array(b-a+1).fill({}),error:null}),2,2),/report_too_large/);
  let calls=0; const rows=await paged(()=>Promise.resolve({data:++calls===1?[1,2]:[3],error:null}),2,3);
  assert.deepEqual(rows,[1,2,3]);
});
