import test from "node:test";
import assert from "node:assert/strict";
import {queueMediaBucket,libraryWindowAllowed,libraryReceipt,pickLibraryHashtags,libraryHashtags} from "../src/library-publishing.js";
const a="a".repeat(24),id="11111111-1111-4111-8111-111111111111";
const row={id,phone_slot:`library_${a}`,library_variant_id:id,storage_bucket:"managed-variants",
  storage_path:`library/${id}/${a}/${id}/${id}.mp4`};
test("library media identity is account-bound and bucket-whitelisted",()=>{
  assert.equal(queueMediaBucket({storage_path:"phone_a/a.mp4"}),"reels");
  assert.equal(queueMediaBucket(row),"managed-variants");
  for(const delta of [{storage_bucket:"public"},{phone_slot:"phone_a"},{library_variant_id:"bad"},
    {storage_path:row.storage_path.replace(a,"b".repeat(24))},{storage_bucket:"reels"}])
    assert.throws(()=>queueMediaBucket({...row,...delta}));
});
test("new accounts never backfill expired windows or publish before activation",()=>{
  const now=Date.parse("2026-10-11T15:10:00Z");
  assert.ok(libraryWindowAllowed("2026-10-11T15:00:00Z","2026-10-11T15:00:00Z",now));
  assert.ok(!libraryWindowAllowed("2026-10-11T17:00:00Z","2026-10-11T15:00:00Z",now));
  assert.ok(!libraryWindowAllowed("2026-10-10T15:00:00Z","2026-10-11T13:00:00Z",now));
  assert.ok(!libraryWindowAllowed(null,"2026-10-11T15:00:00Z",now));
});
test("server publication receipt must bind the same artifact and caption",async()=>{
  const receipt={storage_bucket:row.storage_bucket,storage_path:row.storage_path,variant_id:id,
    caption:"Approved process caption for this exact video.",settings:{feed:true}};
  assert.equal((await libraryReceipt({rpc:async()=>({data:receipt})},row,a)).caption,receipt.caption);
  await assert.rejects(libraryReceipt({rpc:async()=>({data:{...receipt,variant_id:"foreign"}})},row,a));
  await assert.rejects(libraryReceipt({rpc:async()=>({data:null})},row,a));
});

test("library hashtags: accepted suggestion, then the nightly one, then the client's own; never a constant",()=>{
  assert.deepEqual(pickLibraryHashtags({hashtags:["Trading","TradingEducation"]},null),{hashtags:["Trading","TradingEducation"],source:"client_hashtags"});
  assert.deepEqual(pickLibraryHashtags({hashtags:["Trading"]},{user_action:"pending",suggested_hashtags:["#options","Options","futures"]}),{hashtags:["options","futures"],source:"nightly_suggestion"});
  assert.deepEqual(pickLibraryHashtags({hashtags:["Trading"]},{user_action:"accepted",suggested_hashtags:["x"],final_hashtags:["chosen"]}),{hashtags:["chosen"],source:"accepted_suggestion"});
  assert.deepEqual(pickLibraryHashtags({},null),{hashtags:[],source:"none"});
  assert.deepEqual(pickLibraryHashtags(undefined,{user_action:"rejected",suggested_hashtags:["no"]}),{hashtags:[],source:"none"});
});
test("libraryHashtags reads the slot's client and the row's suggestion",async()=>{
  const calls:any[]=[];
  const sb:any={rpc:async(fn:string,args:any)=>{calls.push([fn,args]);return {data:{org_id:"o",learning:{hashtags:["Acme"]}},error:null};},
    from(){const q:any={select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},maybeSingle:async()=>({data:null,error:null})};return q;}};
  assert.deepEqual(await libraryHashtags(sb,"library_"+a,id),{hashtags:["Acme"],source:"client_hashtags"});
  assert.deepEqual(calls,[["client_learning_for_slot",{p_slot:"library_"+a}]]);
});
