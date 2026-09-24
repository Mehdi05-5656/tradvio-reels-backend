import test from "node:test";
import assert from "node:assert/strict";
import {handoffDb,OP,A,B} from "./helpers/handoff-db.js";
test("handoff is off by default; activation is operator-only; enqueue is exact and leaves legacy unchanged",async t=>{
  const s=await handoffDb(t),a=await s.ready();
  assert.equal(await s.rpc("managed_handoff_enqueue"),0);
  await assert.rejects(s.rpc("managed_handoff_activate",{p_actor:A,p_account:a.account,p_enabled:true,
    p_approval:"test",p_expires:new Date(Date.now()+86400000).toISOString()}),/operator_required/);
  await s.activate(a.account);
  assert.equal(await s.rpc("managed_handoff_enqueue"),1);assert.equal(await s.rpc("managed_handoff_enqueue"),0);
  const j=(await s.db.query<any>("SELECT * FROM managed_handoffs")).rows[0];
  assert.equal(j.account_id,a.account);assert.equal(j.workspace_id,"workspace-a");assert.equal(j.publer_account_id,"account-a");
  assert.ok(new Date(j.scheduled_at).getTime()>Date.now()+50*60000);
  assert.deepEqual((await s.db.query("SELECT * FROM publer_slot_config")).rows,[{phone_slot:"phone_a",publer_account_id:"legacy-account",paused:false}]);
});
test("timezone grid skips nonexistent spring times and picks only the later repeated autumn slot",async t=>{
  const s=await handoffDb(t);
  const spring=await s.rpc("managed_handoff_slots",{p_policy:{timezone:"America/Los_Angeles",slot_times:["02:30"]},
    p_after:"2026-03-08T00:00:00Z"});
  assert.ok(!spring.some((x:any)=>x.local_date==="2026-03-08"));
  const autumn=await s.rpc("managed_handoff_slots",{p_policy:{timezone:"America/Los_Angeles",slot_times:["01:30"]},
    p_after:"2026-11-01T00:00:00Z"});
  const same=autumn.filter((x:any)=>x.local_date==="2026-11-01");
  assert.equal(same.length,1);assert.equal(new Date(same[0].scheduled_at).toISOString(),"2026-11-01T09:30:00.000Z");
});
test("no unapproved media or expired rights enters the handoff",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);
  await s.db.query("UPDATE managed_generation_jobs SET state='blocked' WHERE id=$1",[a.generation]);
  assert.equal(await s.rpc("managed_handoff_enqueue"),0);
  await s.db.query("UPDATE managed_generation_jobs SET state='quality_passed' WHERE id=$1",[a.generation]);
  await s.db.exec("UPDATE managed_asset_grants SET expires_at=now()+interval '20 minutes'");
  assert.equal(await s.rpc("managed_handoff_enqueue"),0);
});
test("expired sending lease holds uncertain work; a stale token cannot save receipts or cause resubmission",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);await s.rpc("managed_handoff_enqueue");
  const j=await s.rpc("managed_handoff_claim",{p_worker:"test"});
  await s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,p_event:"upload_intent",p_data:{}});
  await s.db.exec("UPDATE managed_handoffs SET lease_until=now()-interval '1 second'");
  assert.equal(await s.rpc("managed_handoff_claim",{p_worker:"replacement"}),null);
  assert.equal((await s.db.query<any>("SELECT state FROM managed_handoffs")).rows[0].state,"held");
  await assert.rejects(s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,
    p_event:"upload_receipt",p_data:{job_id:"remote-job"}}),/lease_lost/);
});
test("browser access and direct service writes are denied",async t=>{
  const s=await handoffDb(t);
  for(const role of ["anon","authenticated"]) {
    await s.db.exec(`SET ROLE ${role}`);
    await assert.rejects(s.db.query("SELECT * FROM managed_handoffs"),/permission denied/);
    await assert.rejects(s.rpc("managed_handoff_enqueue"),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
  await s.db.exec("SET ROLE service_role");
  await assert.rejects(s.db.exec("UPDATE managed_handoff_control SET enabled=true"),/permission denied/);
});
test("two customers reserve their own workspace and slot; no account fan-out",async t=>{
  const s=await handoffDb(t),a=await s.ready(),b=await s.ready(B,"account-b");
  await s.activate(a.account);await s.activate(b.account);
  assert.equal(await s.rpc("managed_handoff_enqueue"),2);
  const rows=(await s.db.query<any>("SELECT * FROM managed_handoffs ORDER BY customer_user_id")).rows;
  assert.deepEqual(rows.map(x=>[x.customer_user_id,x.workspace_id,x.publer_account_id]),
    [[A,"workspace-a","account-a"],[B,"workspace-b","account-b"]]);
  assert.equal(await s.rpc("managed_handoff_enqueue"),0);
});
test("claims are serialized and daily budget bounded; held work does not silently reactivate",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);await s.rpc("managed_handoff_enqueue");
  const j=await s.rpc("managed_handoff_claim",{p_worker:"first"});
  assert.equal(await s.rpc("managed_handoff_claim",{p_worker:"second"}),null);
  await s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,p_event:"upload_intent",p_data:{}});
  await s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,p_event:"upload_receipt",p_data:{job_id:"job"}});
  await s.rpc("managed_handoff_configure",{p_actor:OP,p_enabled:true,p_daily:1});
  await s.db.exec("UPDATE managed_handoff_control SET last_claim_at=NULL");
  assert.equal(await s.rpc("managed_handoff_claim",{p_worker:"over-budget"}),null);
});
test("disable does not cancel remote schedules and read reconciliation remains claimable",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);await s.rpc("managed_handoff_enqueue");
  // Owner-only fixture positions the row after an acknowledged remote submission.
  await s.db.exec("UPDATE managed_handoffs SET state='submit_wait',submit_job_id='remote-job'");
  const r=await s.rpc("managed_handoff_activate",{p_actor:OP,p_account:a.account,p_enabled:false,p_approval:"stop-new-work",
    p_expires:new Date(Date.now()+86400000).toISOString()});
  assert.equal(r.external_schedules_cancelled,false);assert.equal(r.remote_review_count,1);
  await s.rpc("managed_handoff_configure",{p_actor:OP,p_enabled:false,p_daily:100});
  const j=await s.rpc("managed_handoff_claim",{p_worker:"reader"});
  assert.equal(j.state,"submit_wait");assert.equal(j.remote_review_required,true);
});
test("reserved snapshots cannot be sent after their caption or media changes",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);await s.rpc("managed_handoff_enqueue");
  const j=await s.rpc("managed_handoff_claim",{p_worker:"test"});
  await s.db.exec(`UPDATE managed_generation_jobs SET recipe='{"caption":"A different educational caption."}'`);
  await assert.rejects(s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,
    p_event:"upload_intent",p_data:{}}),/handoff_ineligible/);
});
test("same-account jobs reserve separate slots; SQL rejects cross-account read-back proof",async t=>{
  const s=await handoffDb(t),a=await s.ready();await s.activate(a.account);
  await s.db.exec(`INSERT INTO managed_generation_jobs(batch_id,account_id,ordinal,asset_id,state,lease_token,recipe,result)
    SELECT batch_id,account_id,2,asset_id,state,lease_token,recipe,'{}'::jsonb FROM managed_generation_jobs;
    UPDATE managed_generation_jobs SET result=jsonb_build_object('bucket','managed-variants',
      'object_key','${A}'||'/'||account_id||'/'||id||'/'||lease_token||'/output.mp4',
      'sha256',repeat('e',64),'qc',jsonb_build_object('technical_pass',true,'content_pass',true)) WHERE ordinal=2;`);
  assert.equal(await s.rpc("managed_handoff_enqueue"),2);
  const rows=(await s.db.query<any>("SELECT scheduled_at FROM managed_handoffs")).rows;
  assert.notEqual(String(rows[0].scheduled_at),String(rows[1].scheduled_at));
  const j=await s.rpc("managed_handoff_claim",{p_worker:"test"});
  await s.db.query("UPDATE managed_handoffs SET state='confirming',post_id='post-a',media='{\"id\":\"media-a\"}' WHERE id=$1",[j.id]);
  await assert.rejects(s.rpc("managed_handoff_transition",{p_id:j.id,p_token:j.lease_token,p_event:"confirmed",p_data:{
    post_id:"post-a",account_id:"account-b",scheduled_at:j.scheduled_at,text:j.caption,media_id:"media-a",state:"scheduled",
  }}),/invalid_receipt/);
});
test("activation requires explicit platform settings; TikTok disclosures are never silently defaulted",async t=>{
  const s=await handoffDb(t),a=await s.ready();
  const args={p_actor:OP,p_account:a.account,p_enabled:true,p_approval:"approved",
    p_expires:new Date(Date.now()+86400000).toISOString()};
  await assert.rejects(s.rpc("managed_handoff_activate",args),/invalid_publication_settings/);
  await s.db.query("UPDATE managed_accounts SET platform='tiktok' WHERE id=$1",[a.account]);
  await assert.rejects(s.rpc("managed_handoff_activate",{...args,p_settings:{feed:true}}),/invalid_publication_settings/);
  const settings={privacy:"PUBLIC_TO_EVERYONE",comment:true,duet:false,stitch:false,promotional:true,paid:false};
  await s.rpc("managed_handoff_activate",{...args,p_settings:settings});
  await s.rpc("managed_handoff_configure",{p_actor:OP,p_enabled:true,p_daily:100});
  await s.rpc("managed_handoff_enqueue");
  assert.deepEqual((await s.db.query<any>("SELECT publication_settings FROM managed_handoffs")).rows[0].publication_settings,settings);
});
