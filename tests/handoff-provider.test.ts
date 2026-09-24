import test from "node:test";
import assert from "node:assert/strict";
import {createManagedPubler,mediaReceipt,postReceipt,verifyPost,scheduleBody} from "../src/managed-publer.js";
const j:any={workspace_id:"workspace-a",publer_account_id:"account-a",platform:"instagram",
  publication_settings:{feed:true},
  caption:"Approved educational caption.",scheduled_at:"2030-01-01T10:00:00Z",
  media:{id:"media-a",path:"https://cdn.example.test/video.mp4"},post_id:"post-a"};
test("scheduling binds one destination, caption, media and explicit future timestamp",()=>{
  const body=scheduleBody(j,Date.parse("2030-01-01T08:00:00Z"));
  assert.equal(body.bulk.state,"scheduled");assert.equal(body.bulk.posts.length,1);
  assert.deepEqual(body.bulk.posts[0].accounts,[{id:"account-a",scheduled_at:"2030-01-01T10:00:00.000Z"}]);
  assert.deepEqual(Object.keys(body.bulk.posts[0].networks),["instagram"]);
  assert.equal(body.bulk.posts[0].networks.instagram.text,j.caption);
  assert.throws(()=>scheduleBody(j,Date.parse("2030-01-01T10:00:00Z")),/slot_missed/);
  assert.throws(()=>scheduleBody({...j,platform:"youtube"},0),/receipt_unverified/);
});
test("adapter uses only the future endpoint, scoped headers and recognizes documented job envelopes",async()=>{
  const calls:any[]=[];
  const provider=createManagedPubler("secret-key",async(url:any,init:any)=>{
    calls.push({url,init});return new Response(JSON.stringify({success:true,data:{job_id:"job-1"}}));
  },()=>0);
  assert.equal(await provider.schedule(j),"job-1");
  assert.equal(calls[0].url,"https://app.publer.com/api/v1/posts/schedule");
  assert.equal(calls[0].init.headers["Publer-Workspace-Id"],"workspace-a");
  assert.equal(calls[0].init.redirect,"error");
  assert.equal(calls[0].init.headers.Authorization,"Bearer-API secret-key");
});
test("no mutation retry and no provider secrets in thrown errors",async()=>{
  let calls=0;
  const p=createManagedPubler("secret",async()=>{calls++;return new Response("sensitive provider body",{status:503});});
  await assert.rejects(p.schedule(j),e=>String(e)==="Error: provider_unavailable");
  assert.equal(calls,1);
  const malformed=createManagedPubler("secret",async()=>new Response('{"success":false,"data":{"job_id":"x"}}'));
  await assert.rejects(malformed.schedule(j),/receipt_unverified/);
});
test("media and post job receipts fail closed on missing, multiple or cross-account objects",()=>{
  assert.deepEqual(mediaReceipt({media:[j.media]}),j.media);
  assert.throws(()=>mediaReceipt({media:[j.media,j.media]}),/receipt_unverified/);
  assert.throws(()=>mediaReceipt({id:"x",path:"http://unsafe.test"}),/receipt_unverified/);
  assert.throws(()=>mediaReceipt({id:"x",path:"https://user:password@unsafe.test/a"}),/receipt_unverified/);
  assert.equal(postReceipt({posts:[{id:"post-a",account_id:"account-a"}]},j),"post-a");
  assert.throws(()=>postReceipt({posts:[{id:"post-a",account_id:"account-b"}]},j),/receipt_unverified/);
  assert.throws(()=>postReceipt({posts:[{id:"post-a"}]},j),/receipt_unverified/);
});
test("scheduled is not published; read-back must match every reserved field",()=>{
  const post={id:"post-a",account_id:"account-a",scheduled_at:j.scheduled_at,text:j.caption,
    state:"scheduled",media:[{id:"media-a"}]};
  assert.equal(verifyPost(post,j,0).state,"scheduled");
  for(const mutation of [{account_id:"account-b"},{text:"changed"},{media:[{id:"other"}]},
    {state:"scheduled_pending"},{scheduled_at:"2030-01-02T10:00:00Z"},{state:"published"}])
    assert.throws(()=>verifyPost({...post,...mutation},j,0),/receipt_unverified/);
  assert.equal(verifyPost({...post,state:"published"},j,Date.parse(j.scheduled_at)+60000).state,"published");
});
test("calendar conflict or unbounded/unknown pagination stops scheduling",async()=>{
  const row={id:"manual-post",account_id:"account-a",scheduled_at:j.scheduled_at,state:"scheduled"};
  const conflict=createManagedPubler("secret",async()=>new Response(JSON.stringify({posts:[row],page:0,total_pages:1})));
  await assert.rejects(conflict.calendar(j),/calendar_conflict/);
  const unknown=createManagedPubler("secret",async()=>new Response(JSON.stringify({posts:[]})));
  await assert.rejects(unknown.calendar(j),/calendar_unverified/);
  const empty=createManagedPubler("secret",async()=>new Response(JSON.stringify({posts:[],page:0,total_pages:0})));
  await empty.calendar(j);
});
test("documented nested status envelopes, mixed failures and locked plans are not successful receipts",async()=>{
  const p=createManagedPubler("secret",async()=>new Response(JSON.stringify({
    success:true,data:{status:"complete",result:{status:"complete",payload:{media:[j.media]}}}})));
  assert.equal((await p.job("workspace-a","job-a")).status,"complete");
  for(const payload of [{posts:[{id:"post-a",account_id:"account-a"}],failures:{account:"failed"}},
    {posts:[{id:"post-a",account_id:"account-a"}],errors:["rejected"]}])
    assert.throws(()=>postReceipt(payload,j),/receipt_unverified/);
  const locked=createManagedPubler("secret",async()=>new Response(JSON.stringify({
    success:true,data:{status:"complete",result:{status:"complete",payload:{},plan:{locked:true}}}})));
  await assert.rejects(locked.job("workspace-a","job-a"),/receipt_unverified/);
});
test("TikTok payload stays account-specific; unknown destination and oversized responses fail closed",async()=>{
  const publication_settings={privacy:"PUBLIC_TO_EVERYONE",comment:true,duet:false,stitch:false,promotional:true,paid:false};
  const b=scheduleBody({...j,platform:"tiktok",publication_settings},0);
  assert.deepEqual(Object.keys(b.bulk.posts[0].networks),["tiktok"]);
  assert.equal(b.bulk.posts[0].networks.tiktok.details.duet,false);
  assert.equal(b.bulk.posts[0].networks.tiktok.details.promotional,true);
  assert.throws(()=>scheduleBody({...j,publication_settings:null},0),/receipt_unverified/);
  const wrong=createManagedPubler("secret",async()=>new Response(JSON.stringify([{id:"account-a",provider:"tiktok"}])));
  await assert.rejects(wrong.destination(j),/destination_unverified/);
  const huge=createManagedPubler("secret",async()=>new Response("x".repeat(1048577)));
  await assert.rejects(huge.job("workspace-a","job-a"),/receipt_unverified/);
});
