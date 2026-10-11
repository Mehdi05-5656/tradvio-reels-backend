import test from "node:test";
import assert from "node:assert/strict";
import {coordinatedUpload} from "../src/workspace-upload.js";
function setup(t:any,mode="acquired",failure=false){
  process.env.PUBLER_API_KEY="test-only";
  const events:string[]=[];
  const db={rpc:async(name:string,args:any)=>{
    events.push(name);
    return {error:null,data:name==="publer_upload_acquire"?{mode,token:"t",job_id:"existing"}:true};
  }};
  t.mock.method(globalThis,"fetch",async(url:any,init:any)=>{
    events.push(init?.method==="POST"?"remote_upload":"remote_read");
    if(failure)throw new Error("unknown outcome");
    return new Response(JSON.stringify(String(url).includes("media/from-url")?{job_id:"job1"}:
      {status:mode==="reconcile"?"working":"complete",payload:[{id:"media1",path:"https://test.invalid/video"}]}));
  });
  return {db,events};
}
test("coordinator persists upload intent and exact job before polling",async t=>{
  const s=setup(t);
  assert.deepEqual(await coordinatedUpload(s.db,"workspace","https://test.invalid/source","video.mp4"),
    [{id:"media1",path:"https://test.invalid/video"}]);
  assert.deepEqual(s.events,["publer_upload_acquire","publer_upload_begin","remote_upload",
    "publer_upload_record_job","remote_read","publer_upload_finish"]);
});
test("busy and held workspace never uploads",async t=>{
  const s=setup(t,"held");
  await assert.rejects(coordinatedUpload(s.db,"workspace","https://test.invalid/source","video.mp4"),/held/);
  assert.deepEqual(s.events,["publer_upload_acquire"]);
});
test("uncertain upload is held with no automatic replay",async t=>{
  const s=setup(t,"acquired",true);
  await assert.rejects(coordinatedUpload(s.db,"workspace","https://test.invalid/source","video.mp4"));
  assert.deepEqual(s.events,["publer_upload_acquire","publer_upload_begin","remote_upload","publer_upload_hold"]);
});
test("known active remote upload is reconciled read-only",async t=>{
  const s=setup(t,"reconcile");
  await assert.rejects(coordinatedUpload(s.db,"workspace","https://test.invalid/source","video.mp4"),/busy/);
  assert.deepEqual(s.events,["publer_upload_acquire","remote_read"]);
});
