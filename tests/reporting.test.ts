import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, resolveRange, paged, publerThumbnail } from "../src/reporting.js";

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
test("TikTok posts without a permalink match analytics through Publer old_id, without a duplicate row",()=>{
  const tt={...slot(),provider:"tiktok"};
  const url="https://www.tiktok.com/@tradvio/video/7695054763573923102?utm_campaign=tt4d_open_api";
  const r=buildReport([tt],[log(1,"published",{publer_post_id:"6aca539310a76b25d4f418e8",publer_post_link:null,caption_used:"Bro"})],[
    snap(1,"2026-10-11T18:00:00Z",420,{publer_post_id:url,likes:12,raw:{id:"219632075",old_id:"6aca539310a76b25d4f418e8",post_link:url,scheduled_at:"2026-10-11T15:05:00Z"}}),
  ],range);
  assert.equal(r.posts.length,1);
  assert.equal(r.posts[0].recorded_by,"publisher");
  assert.equal(r.posts[0].video_views,420);
  assert.equal(r.posts[0].likes,12);
  assert.equal(r.posts[0].post_link,url);
  assert.equal(r.accounts[0].metrics_available,1);
  // A different Publer id must not borrow another post's metrics.
  const other=buildReport([tt],[log(1,"published",{publer_post_id:"different",publer_post_link:null})],[
    snap(1,"2026-10-11T18:00:00Z",420,{publer_post_id:url,raw:{old_id:"6aca539310a76b25d4f418e8",post_link:url,scheduled_at:"2026-10-11T15:05:00Z"}}),
  ],range);
  const own=other.posts.find(p=>p.recorded_by==="publisher")!;
  assert.equal(own.video_views,null);
  assert.equal(own.captured_at,null);
});

// ---- View-gain math (added 2026-10-18 after the analytics audit) ----
const snapAt=(id:number,t:string,views:number|null,extra:any={})=>snap(id,t,views,{raw:{scheduled_at:"2026-10-11T15:00:00Z"},...extra});
const liveAt=(id:number,t:string,views:number|null,extra:any={})=>({id,phone_slot:"a",provider:"instagram",platform_post_id:"abc",post_link:"https://www.instagram.com/reel/abc/",posted_at:"2026-10-11T15:00:00Z",captured_at:t,video_views:views,likes:1,comments:0,shares:null,saves:null,...extra});
test("a downward correction keeps the higher baseline, so recovering to it adds no views",()=>{
  const r=buildReport([slot()],[],[snapAt(1,"2026-10-11T16:00:00Z",1000),snapAt(2,"2026-10-11T18:00:00Z",900),snapAt(3,"2026-10-11T20:00:00Z",1000)],range);
  assert.equal(r.coverage.corrections,1);
  assert.equal(r.totals.observed_views,1000); // seeded by the first in-range reading of a post published in range
  const above=buildReport([slot()],[],[snapAt(1,"2026-10-11T16:00:00Z",1000),snapAt(2,"2026-10-11T18:00:00Z",900),snapAt(3,"2026-10-11T20:00:00Z",1100)],range);
  assert.equal(above.totals.observed_views,1100);
  const before=buildReport([slot()],[],[snap(1,"2026-10-10T20:00:00Z",1000),snap(2,"2026-10-11T12:00:00Z",900),snap(3,"2026-10-11T16:00:00Z",1000)],range);
  assert.equal(before.totals.observed_views,0);
});
test("a reading without a view count is skipped instead of resetting the baseline",()=>{
  const r=buildReport([slot()],[],[snapAt(1,"2026-10-11T16:00:00Z",500),snapAt(2,"2026-10-11T18:00:00Z",null),snapAt(3,"2026-10-11T20:00:00Z",600)],range);
  assert.equal(r.totals.observed_views,600);
  assert.equal(r.coverage.missing_baselines,0);
  const before=buildReport([slot()],[],[snap(1,"2026-10-10T20:00:00Z",500),snap(2,"2026-10-11T12:00:00Z",null),snap(3,"2026-10-11T16:00:00Z",600)],range);
  assert.equal(before.totals.observed_views,100);
});
test("Publer and live readings are never differenced against each other",()=>{
  const link="https://www.instagram.com/reel/abc/";
  const pub=(id:number,t:string,v:number)=>snap(id,t,v,{publer_post_id:link,raw:{scheduled_at:"2026-10-10T15:00:00Z",post_link:link}});
  // Post published before the range. Publer counts 120 -> 140; live (different scale) 50 -> 80 the same day.
  const same=buildReport([slot()],[],[pub(1,"2026-10-10T20:00:00Z",120),pub(2,"2026-10-11T18:00:00Z",140)],range,
    [liveAt(1,"2026-10-11T16:00:00Z",50,{posted_at:"2026-10-10T15:00:00Z"}),liveAt(2,"2026-10-11T20:00:00Z",80,{posted_at:"2026-10-10T15:00:00Z"})]);
  assert.equal(same.totals.observed_views,30);
  assert.equal(same.coverage.corrections,0);
  assert.equal(same.coverage.missing_baselines,0);
  // Live covered the first day only; Publer keeps counting on the second day.
  const two=resolveRange({from:"2026-10-11",to:"2026-10-12"},new Date("2026-10-12T23:00:00Z"));
  const later=buildReport([slot()],[],[pub(1,"2026-10-10T20:00:00Z",120),pub(2,"2026-10-11T18:00:00Z",140),pub(3,"2026-10-12T18:00:00Z",190)],two,
    [liveAt(1,"2026-10-11T16:00:00Z",50,{posted_at:"2026-10-10T15:00:00Z"}),liveAt(2,"2026-10-11T20:00:00Z",80,{posted_at:"2026-10-10T15:00:00Z"})]);
  assert.deepEqual(later.series.map(d=>d.observed_views),[30,50]);
});
test("a post published in range is seeded once, by the source used on its first day",()=>{
  const link="https://www.instagram.com/reel/abc/";
  const pub=(id:number,t:string,v:number)=>snap(id,t,v,{publer_post_id:link,raw:{scheduled_at:"2026-10-11T15:00:00Z",post_link:link}});
  // Same day: Publer seeds 100 at 17:00, live seeds 150 at 18:00 and gains 30 by 20:00 -> live wins the day: 180.
  const same=buildReport([slot()],[],[pub(1,"2026-10-11T17:00:00Z",100)],range,[liveAt(1,"2026-10-11T18:00:00Z",150),liveAt(2,"2026-10-11T20:00:00Z",180)]);
  assert.equal(same.totals.observed_views,180);
  // Different days: Publer seeds on day one; live starting on day two must not seed again.
  const two=resolveRange({from:"2026-10-11",to:"2026-10-12"},new Date("2026-10-12T23:00:00Z"));
  const split=buildReport([slot()],[],[pub(1,"2026-10-11T17:00:00Z",100),pub(2,"2026-10-12T17:00:00Z",160)],two,[liveAt(1,"2026-10-12T18:00:00Z",170),liveAt(2,"2026-10-12T21:00:00Z",200)]);
  assert.deepEqual(split.series.map(d=>d.observed_views),[100,30]);
});

test("posts carry Publer's public thumbnail, never the private one or a foreign host",()=>{
  const media=[{default_thumbnail:1,thumbnails:[{real:"https://cdn.publer.com/uploads/photos/a.jpg",small:"https://cdn.publer.com/uploads/photos/thumb_a.jpg"},{real:"https://cdn.publer.com/uploads/photos/b.jpg",small:"https://cdn.publer.com/uploads/photos/thumb_b.jpg"}]}];
  assert.equal(publerThumbnail({media}),"https://cdn.publer.com/uploads/photos/thumb_b.jpg");
  assert.equal(publerThumbnail({media:[{thumbnails:[{small:"https://evil.example/x.jpg"}]}]}),null);
  assert.equal(publerThumbnail({}),null);
  const r:any=buildReport([slot()],[log(1)],[snap(1,"2026-10-11T17:00:00Z",40,{raw:{scheduled_at:"2026-10-11T15:00:00Z",media}})],range);
  assert.equal(r.posts[0].thumbnail,"https://cdn.publer.com/uploads/photos/thumb_b.jpg");
  const none:any=buildReport([slot()],[log(1)],[],range);
  assert.equal(none.posts[0].thumbnail,null);
});
