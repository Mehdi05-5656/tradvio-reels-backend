import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const ACCOUNT="6ac831b2e73f366e1cbd1699";
const SHA="a".repeat(64);
async function fixture(t:any){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE publer_account_ownership(publer_account_id text PRIMARY KEY,owner_user_id uuid NOT NULL,workspace_id text NOT NULL);
    INSERT INTO publer_account_ownership VALUES('${ACCOUNT}','${OP}','workspace');
    CREATE FUNCTION managed_require_operator(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF p_actor IS DISTINCT FROM '${OP}'::uuid THEN RAISE EXCEPTION 'operator_required';END IF;END $$;`);
  const sql=await readFile("migrations/20261011010000_private_library.sql","utf8");
  await db.exec(sql);await db.exec(sql);
  const rpc=async(name:string,args:any={})=>(await db.query<any>(
    `SELECT ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) value`,
    Object.values(args).map(v=>v&&typeof v==="object"?JSON.stringify(v):v))).rows[0].value;
  const source={sha256:SHA,bytes:1024,duration:16,object_key:`originals/${SHA}.mp4`,
    source_video_id:"7582448651809688845",source_handle:"ali_d3trades",
    provenance:"Original downloaded Tradvio pool; ownership statement September 5",
    permission_ref:"operator-approved-private-render"};
  await rpc("library_register_source",{p_actor:OP,p_source:source});
  const plan=()=>rpc("library_plan",{p_actor:OP,p_account:ACCOUNT});
  return {db,rpc,source,plan};
}
test("full-library plans are idempotent, start disabled, and cannot publish",async t=>{
  const s=await fixture(t);assert.equal(await s.plan(),1);assert.equal(await s.plan(),0);
  assert.equal(await s.rpc("library_claim",{p_worker:"worker"}),null);
  const rows=(await s.db.query<any>("SELECT state,recipe_version FROM library_variants")).rows;
  assert.deepEqual(rows,[{state:"pending",recipe_version:"legacy-light-account-v2"}]);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM library_events")).rows[0].n,1);
});
test("source identity is immutable, validates scope and requires operator",async t=>{
  const s=await fixture(t);
  await assert.rejects(s.rpc("library_register_source",{p_actor:null,p_source:s.source}),/operator_required/);
  for(const delta of [{object_key:"../x.mp4"},{bytes:0},{duration:601},{extra:true},{sha256:"bad"}])
    await assert.rejects(s.rpc("library_register_source",{p_actor:OP,p_source:{...s.source,...delta}}),/invalid_source/);
  await assert.rejects(s.rpc("library_register_source",{p_actor:OP,p_source:{...s.source,bytes:2048}}),/source_conflict/);
  await assert.rejects(s.rpc("library_plan",{p_actor:OP,p_account:"missing"}),/account_not_owned/);
});
test("claims enforce concurrency, fencing, disable and immutable ownership",async t=>{
  const s=await fixture(t);await s.plan();
  await s.rpc("library_configure",{p_actor:OP,p_enabled:true,p_max_active:1,p_daily:30});
  const one=await s.rpc("library_claim",{p_worker:"one"});
  assert.equal(one.account_id,ACCOUNT);assert.equal(one.source.sha256,SHA);
  assert.equal(await s.rpc("library_claim",{p_worker:"two"}),null);
  await s.db.exec("UPDATE library_variants SET lease_until=now()-interval '1 second'");
  const two=await s.rpc("library_claim",{p_worker:"two"});
  assert.equal(two.id,one.id);assert.notEqual(two.lease_token,one.lease_token);
  assert.equal(await s.rpc("library_renew",{p_job:one.id,p_token:one.lease_token}),false);
  await s.db.exec("UPDATE publer_account_ownership SET owner_user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
  assert.equal(await s.rpc("library_renew",{p_job:two.id,p_token:two.lease_token}),false);
  await s.db.exec(`UPDATE publer_account_ownership SET owner_user_id='${OP}'`);
  await s.rpc("library_configure",{p_actor:OP,p_enabled:false,p_max_active:1,p_daily:30});
  assert.equal(await s.rpc("library_renew",{p_job:two.id,p_token:two.lease_token}),false);
});
test("completion binds exact attempt object and cannot imply editorial approval or scheduling",async t=>{
  const s=await fixture(t);await s.plan();
  await s.rpc("library_configure",{p_actor:OP,p_enabled:true,p_max_active:1,p_daily:30});
  const j=await s.rpc("library_claim",{p_worker:"one"});
  const result={object_key:`library/${OP}/${ACCOUNT}/${j.id}/${j.lease_token}.mp4`,
    sha256:"b".repeat(64),bytes:1024,duration:16,full_decode_passed:true,recipe:{
      version:"legacy-light-account-v2",source_sha256:SHA,account_id:ACCOUNT,
      crop_per_edge:0.015,speed:1.01,trim_start:0.05,requested_trim_start:0.2,
      reviewed_corner_masks:false,trim_policy:"leading_silence_only_with_30ms_guard"},
    render_seconds:20};
  for(const delta of [{object_key:"someone-else.mp4"},{full_decode_passed:false},{recipe:null},{bytes:0}])
    await assert.rejects(s.rpc("library_complete",{p_job:j.id,p_token:j.lease_token,p_result:{...result,...delta}}),/invalid_result/);
  await s.rpc("library_complete",{p_job:j.id,p_token:j.lease_token,p_result:result});
  assert.equal((await s.db.query<any>("SELECT state FROM library_variants")).rows[0].state,"rendered_private");
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM library_events")).rows[0].n,3);
  await assert.rejects(s.rpc("library_complete",{p_job:j.id,p_token:j.lease_token,p_result:result}),/lease_lost/);
});
test("expired attempts stop at three; daily limits survive retries",async t=>{
  const s=await fixture(t);await s.plan();
  await s.rpc("library_configure",{p_actor:OP,p_enabled:true,p_max_active:1,p_daily:1});
  const j=await s.rpc("library_claim",{p_worker:"one"});
  await s.db.exec("UPDATE library_variants SET lease_until=now()-interval '1 second'");
  assert.equal(await s.rpc("library_claim",{p_worker:"two"}),null);
  await s.rpc("library_configure",{p_actor:OP,p_enabled:true,p_max_active:1,p_daily:3});
  for(let n=2;n<=3;n++){
    const x=await s.rpc("library_claim",{p_worker:"next"});assert.equal(x.attempts,n);
    await s.db.exec("UPDATE library_variants SET lease_until=now()-interval '1 second'");
  }
  assert.equal(await s.rpc("library_claim",{p_worker:"last"}),null);
  assert.equal((await s.db.query<any>("SELECT state FROM library_variants WHERE id=$1",[j.id])).rows[0].state,"blocked");
});
test("browser access and direct service mutations are denied",async t=>{
  const s=await fixture(t);
  for(const role of ["anon","authenticated","service_role"]){
    await s.db.exec(`SET ROLE ${role}`);
    for(const table of ["library_sources","library_variants","library_control","library_attempts","library_events","library_import_tickets"]){
      if(role!=="service_role")await assert.rejects(s.db.exec(`SELECT * FROM ${table}`),/permission denied/);
      await assert.rejects(s.db.exec(`DELETE FROM ${table}`),/permission denied/);
    }
    if(role!=="service_role")await assert.rejects(s.rpc("library_claim",{p_worker:"browser"}),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
});
test("progress exposes totals and safe events only to owner or operator",async t=>{
  const s=await fixture(t);await s.plan();
  const result=await s.rpc("library_account_progress",{p_actor:OP,p_account:ACCOUNT});
  assert.deepEqual(result.counts,{total:1,pending:1,running:0,blocked:0,rendered_private:0});
  assert.equal(result.publishing_enabled,false);
  assert.deepEqual(Object.keys(result.events[0]).sort(),["created_at","event","id"]);
  await assert.rejects(s.rpc("library_account_progress",{
    p_actor:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",p_account:ACCOUNT}),/operator_required/);
  await assert.rejects(s.rpc("library_account_progress",{p_actor:null,p_account:ACCOUNT}),/account_not_owned/);
});
test("source import tickets are source-bound, single redemption and expiring",async t=>{
  const s=await fixture(t),token="c".repeat(64);
  await s.rpc("library_issue_import",{p_actor:OP,p_source:SHA,p_token_hash:token});
  assert.equal((await s.rpc("library_redeem_import",{p_token_hash:token})).sha256,SHA);
  assert.equal(await s.rpc("library_redeem_import",{p_token_hash:token}),null);
  await s.rpc("library_issue_import",{p_actor:OP,p_source:SHA,p_token_hash:"d".repeat(64)});
  await s.db.exec("UPDATE library_import_tickets SET expires_at=now()-interval '1 second'");
  assert.equal(await s.rpc("library_redeem_import",{p_token_hash:"d".repeat(64)}),null);
  await assert.rejects(s.rpc("library_issue_import",{p_actor:null,p_source:SHA,p_token_hash:token}),/operator_required/);
});
