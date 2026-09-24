import test from "node:test";
import assert from "node:assert/strict";
import {generationDb,OP,A,B} from "./helpers/generation-db.js";

const SHA="a".repeat(64);
const source={bucket:"managed-raw",object_key:"approved/source.mp4",sha256:SHA,bytes:1024,
  duration:30,facts:"Educational market risk example. No guaranteed outcome.",audio_rights:true,editorial_approved:true,license_ref:"license-001"};
async function ready(t:any) {
  const s=await generationDb(t),account=await s.account();
  const asset=await s.rpc("managed_register_asset",{p_actor:OP,p_source:source});
  await s.rpc("managed_grant_asset",{p_actor:OP,p_account:account,p_asset:asset,p_consent:"customer-license",
    p_expires:new Date(Date.now()+86400000).toISOString(),p_enabled:true});
  return {...s,accountId:account,asset};
}
test("generation disabled is inert; repeated enqueue respects exact batch target and legacy rows",async t=>{
  const s=await ready(t);
  assert.equal(await s.rpc("managed_generation_enqueue"),0);
  assert.equal(await s.rpc("managed_generation_claim",{p_worker:"test-worker"}),null);
  await s.db.exec("UPDATE managed_generation_control SET enabled=true");
  assert.equal(await s.rpc("managed_generation_enqueue"),1);
  assert.equal(await s.rpc("managed_generation_enqueue"),0);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_generation_jobs")).rows[0].n,1);
  assert.deepEqual((await s.db.query("SELECT * FROM publer_slot_config")).rows,[{phone_slot:"phone_a",publer_account_id:"legacy-account",paused:false}]);
});
test("source registry validates operator, immutable identity, audio rights and unsafe paths",async t=>{
  const s=await ready(t);
  await assert.rejects(s.rpc("managed_register_asset",{p_actor:A,p_source:source}),/operator_required/);
  for(const patch of [{object_key:"../secret"},{bucket:"reels-uploads"},{sha256:"bad"},{duration:0},{audio_rights:false},{editorial_approved:false}]) {
    await assert.rejects(s.rpc("managed_register_asset",{p_actor:OP,p_source:{...source,...patch}}),/invalid_source/);
  }
  assert.equal(await s.rpc("managed_register_asset",{p_actor:OP,p_source:source}),s.asset);
  await assert.rejects(s.rpc("managed_register_asset",{p_actor:OP,p_source:{...source,facts:"Changed facts"}}),/source_conflict/);
});
test("claims require account-scoped live grants and enforce leases, capacity and daily budget",async t=>{
  const s=await ready(t); const other=await s.account(B,"account-b");
  await s.db.exec("UPDATE managed_generation_control SET enabled=true,max_active=1,max_daily_claims=1");
  await s.rpc("managed_generation_enqueue");
  const job=await s.rpc("managed_generation_claim",{p_worker:"worker-one"});
  assert.equal(job.account_id,s.accountId);assert.equal(job.asset.id,s.asset);
  assert.equal(await s.rpc("managed_generation_claim",{p_worker:"worker-two"}),null);
  await s.db.query("UPDATE managed_generation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  assert.equal(await s.rpc("managed_generation_renew",{p_job:job.id,p_token:job.lease_token}),false);
  assert.equal(await s.rpc("managed_generation_claim",{p_worker:"worker-two"}),null);
  assert.equal((await s.db.query<any>("SELECT state FROM managed_generation_jobs WHERE account_id=$1",[other])).rows[0].state,"blocked");
});
test("expired lease is replaced, old token is fenced, revoked rights prevent completion",async t=>{
  const s=await ready(t);
  await s.db.exec("UPDATE managed_generation_control SET enabled=true");
  await s.rpc("managed_generation_enqueue");
  const first=await s.rpc("managed_generation_claim",{p_worker:"one"});
  await s.db.query("UPDATE managed_generation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[first.id]);
  const second=await s.rpc("managed_generation_claim",{p_worker:"two"});
  assert.equal(second.id,first.id);assert.notEqual(second.lease_token,first.lease_token);
  await assert.rejects(s.rpc("managed_generation_fail",{p_job:first.id,p_token:first.lease_token,p_reason:"render_failed",p_retry:true}),/lease_lost/);
  await s.rpc("managed_grant_asset",{p_actor:OP,p_account:s.accountId,p_asset:s.asset,p_consent:"revoked",
    p_expires:new Date(Date.now()+86400000).toISOString(),p_enabled:false});
  assert.equal(await s.rpc("managed_generation_renew",{p_job:second.id,p_token:second.lease_token}),false);
  await assert.rejects(s.rpc("managed_generation_complete",{p_job:second.id,p_token:second.lease_token,p_result:{}}),/generation_ineligible/);
});
test("generation tables and functions reject browser roles and direct service writes",async t=>{
  const s=await ready(t);
  for(const role of ["anon","authenticated"]) {
    await s.db.exec(`SET ROLE ${role}`);
    for(const table of ["managed_raw_assets","managed_asset_grants","managed_generation_jobs","managed_generation_attempts","managed_generation_control"])
      await assert.rejects(s.db.query(`SELECT * FROM ${table}`),/permission denied/);
    await assert.rejects(s.rpc("managed_generation_claim",{p_worker:"browser"}),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
  await s.db.exec("SET ROLE service_role");
  await assert.rejects(s.db.exec("UPDATE managed_generation_control SET enabled=true"),/permission denied/);
});
test("storage boundary defeats an existing broad customer policy without hiding legacy media",async t=>{
  const s=await ready(t);
  await s.db.exec(`INSERT INTO storage.objects(bucket_id,name) VALUES('managed-raw','raw.mp4'),('managed-variants','variant.mp4'),('legacy','existing.mp4');
    SET ROLE authenticated;`);
  assert.deepEqual((await s.db.query<any>("SELECT name FROM storage.objects")).rows,[{name:"existing.mp4"}]);
  await assert.rejects(s.db.exec("INSERT INTO storage.objects(bucket_id,name) VALUES('managed-raw','attack.mp4')"),/row-level security/);
  await s.db.exec("RESET ROLE");
  const rows=(await s.db.query<any>("SELECT public FROM storage.buckets")).rows;
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.public===false));
});
test("recipe reservations span customers; completion rejects foreign paths, malformed QC and perceptual duplicates",async t=>{
  const s=await ready(t),other=await s.account(B,"account-b");
  await s.rpc("managed_grant_asset",{p_actor:OP,p_account:other,p_asset:s.asset,p_consent:"customer-b-license",
    p_expires:new Date(Date.now()+86400000).toISOString(),p_enabled:true});
  await s.db.exec("UPDATE managed_generation_control SET enabled=true");
  await s.rpc("managed_generation_enqueue");
  const one=await s.rpc("managed_generation_claim",{p_worker:"one"}),two=await s.rpc("managed_generation_claim",{p_worker:"two"});
  const args=(j:any)=>({p_job:j.id,p_token:j.lease_token});
  const tokens=Array.from({length:8},(_,i)=>String(i).repeat(64));
  const recipe={version:1,angle:"Educational approved facts"};
  await s.rpc("managed_generation_reserve",{...args(one),p_recipe:recipe,p_recipe_hash:"b".repeat(64),p_tokens:tokens});
  await assert.rejects(s.rpc("managed_generation_reserve",{...args(two),p_recipe:recipe,p_recipe_hash:"c".repeat(64),p_tokens:tokens}),/recipe_collision/);
  await s.rpc("managed_generation_reserve",{...args(two),p_recipe:recipe,p_recipe_hash:"c".repeat(64),
    p_tokens:Array.from({length:8},(_,i)=>"a".repeat(63)+String(i))});
  const result=(j:any,hash:string)=>({bucket:"managed-variants",
    object_key:`${j.customer_user_id}/${j.account_id}/${j.id}/${j.lease_token}/output.mp4`,sha256:hash.repeat(64),
    qc:{technical_pass:true,content_pass:true},fingerprints:Array(8).fill("0".repeat(64))});
  await assert.rejects(s.rpc("managed_generation_complete",{...args(one),p_result:{...result(one,"d"),object_key:result(two,"d").object_key}}),/quality_failed/);
  await assert.rejects(s.rpc("managed_generation_complete",{...args(one),p_result:{...result(one,"d"),fingerprints:Array(8).fill(null)}}),/quality_failed/);
  await assert.rejects(s.rpc("managed_generation_complete",{...args(one),p_result:{...result(one,"d"),qc:{technical_pass:true}}}),/quality_failed/);
  await s.rpc("managed_generation_complete",{...args(one),p_result:result(one,"d")});
  await assert.rejects(s.rpc("managed_generation_complete",{...args(two),p_result:result(two,"e")}),/output_collision/);
  await s.rpc("managed_generation_complete",{...args(two),p_result:{...result(two,"e"),fingerprints:Array(8).fill("1".repeat(64))}});
  const accounts=(await s.db.query<any>("SELECT publishing_enabled,blocked_reason FROM managed_accounts")).rows;
  assert.ok(accounts.every(a=>a.publishing_enabled===false&&a.blocked_reason==="scheduler_not_configured"));
});
test("retry budget survives repeated claims and stops after the third attempt",async t=>{
  const s=await ready(t);
  await s.db.exec("UPDATE managed_generation_control SET enabled=true");await s.rpc("managed_generation_enqueue");
  for(let attempt=1;attempt<=3;attempt++) {
    const j=await s.rpc("managed_generation_claim",{p_worker:"retry"});
    assert.equal(j.attempts,attempt);
    await s.rpc("managed_generation_fail",{p_job:j.id,p_token:j.lease_token,p_reason:"model_failed",p_retry:true});
    await s.db.exec("UPDATE managed_generation_jobs SET next_attempt_at=now()");
  }
  assert.equal(await s.rpc("managed_generation_claim",{p_worker:"retry"}),null);
  assert.equal((await s.db.query<any>("SELECT state FROM managed_generation_jobs")).rows[0].state,"blocked");
});
