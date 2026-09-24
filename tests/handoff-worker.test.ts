import test from "node:test";
import assert from "node:assert/strict";
import {handoffDb} from "./helpers/handoff-db.js";
import {runHandoff} from "../src/managed-handoff.js";
async function setup(t:any) {
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);
  const calls:string[]=[];
  const provider:any={
    destination:async()=>{calls.push("destination");},calendar:async()=>{calls.push("calendar");},
    upload:async()=>{calls.push("upload");return "upload-job";},
    job:async(_ws:string,id:string)=>({status:"complete",payload:id==="upload-job"?
      {media:[{id:"media-a",path:"https://cdn.example.test/video.mp4"}]}:
      {posts:[{id:"post-a",account_id:"account-a"}]}}),
    schedule:async()=>{calls.push("schedule");return "submit-job";},
    post:async(j:any)=>({id:"post-a",account_id:j.publer_account_id,scheduled_at:j.scheduled_at,
      text:j.caption,media:[{id:"media-a"}],state:"scheduled"}),
  };
  const deps:any={db:s.adapter,enabled:()=>true,provider,
    storage:async()=>{calls.push("storage");return "https://project.supabase.co/private-signed-test";}};
  const tick=async()=>{
    await s.db.exec("UPDATE managed_handoff_control SET last_claim_at=NULL; UPDATE managed_handoffs SET next_check_at=now()");
    return runHandoff(deps,"test-worker");
  };
  return {...s,a,calls,provider,deps,tick};
}
test("disabled executable path has zero DB, storage or provider work",async()=>{
  assert.equal(await runHandoff({enabled:()=>false} as any,"test"),"disabled");
});
test("one-account handoff survives restart steps with exactly one upload and scheduling submission",async t=>{
  const s=await setup(t);
  for(const state of ["upload_wait","media_ready","submit_wait","confirming","scheduled"]) {
    await s.tick();
    assert.equal((await s.db.query<any>("SELECT state FROM managed_handoffs")).rows[0].state,state);
  }
  await s.tick();
  assert.equal(s.calls.filter(x=>x==="upload").length,1);
  assert.equal(s.calls.filter(x=>x==="schedule").length,1);
  assert.equal((await s.db.query<any>("SELECT state FROM managed_handoffs")).rows[0].state,"scheduled");
});
test("a timed-out upload is held, never silently retried",async t=>{
  const s=await setup(t);
  s.provider.upload=async()=>{s.calls.push("upload");throw new Error("timeout with sensitive token");};
  assert.equal(await s.tick(),"held");
  assert.equal(await s.tick(),"idle");
  assert.equal(s.calls.filter(x=>x==="upload").length,1);
  const j=(await s.db.query<any>("SELECT * FROM managed_handoffs")).rows[0];
  assert.equal(j.error_code,"upload_outcome_unknown");assert.equal(j.remote_review_required,true);
});
test("ambiguous submission is held even if the remote side may have created a post",async t=>{
  const s=await setup(t);await s.tick();await s.tick();
  s.provider.schedule=async()=>{s.calls.push("schedule");throw new Error("unknown outcome");};
  assert.equal(await s.tick(),"held");assert.equal(await s.tick(),"idle");
  assert.equal(s.calls.filter(x=>x==="schedule").length,1);
  assert.equal((await s.db.query<any>("SELECT error_code FROM managed_handoffs")).rows[0].error_code,"submit_outcome_unknown");
});
test("destination conflict and bad media cannot reach provider writes",async t=>{
  const s=await setup(t);s.provider.calendar=async()=>{throw new Error("calendar_conflict");};
  assert.equal(await s.tick(),"held");assert.ok(!s.calls.includes("upload"));assert.ok(!s.calls.includes("schedule"));
});
test("revocation between preflight and durable intent prevents a scheduling write",async t=>{
  const s=await setup(t);await s.tick();await s.tick();
  s.provider.calendar=async()=>{await s.db.exec("UPDATE managed_asset_grants SET enabled=false");};
  assert.equal(await s.tick(),"held");assert.ok(!s.calls.includes("schedule"));
  assert.equal((await s.db.query<any>("SELECT error_code FROM managed_handoffs")).rows[0].error_code,"handoff_ineligible");
});
test("lost database acknowledgment after accepted upload resumes by GET, not duplicate POST",async t=>{
  const s=await setup(t),original=s.deps.db;
  s.deps.db={rpc:async(name:string,args:any)=>{
    const r=await original.rpc(name,args);
    if(name==="managed_handoff_transition"&&args.p_event==="upload_receipt")return {error:{message:"lost acknowledgment"}};
    return r;
  }};
  assert.equal(await s.tick(),"persistence_unconfirmed");
  assert.equal(await s.tick(),"media_ready");
  assert.equal(s.calls.filter(x=>x==="upload").length,1);
});
test("failed durable intent never starts a remote mutation",async t=>{
  const s=await setup(t),original=s.deps.db;
  s.deps.db={rpc:async(name:string,args:any)=>name==="managed_handoff_transition"&&args.p_event==="upload_intent"
    ?{error:{message:"write rejected"}}:original.rpc(name,args)};
  assert.equal(await s.tick(),"held");
  assert.ok(!s.calls.includes("upload"));
});
test("temporary read error defers safely and wrong post proof is held",async t=>{
  const s=await setup(t);
  for(let i=0;i<4;i++)await s.tick();
  s.provider.post=async()=>{throw new Error("provider_unavailable");};
  assert.equal(await s.tick(),"pending");
  s.provider.post=async()=>({id:"someone-elses-post"});
  assert.equal(await s.tick(),"held");assert.equal(s.calls.filter(x=>x==="schedule").length,1);
});
