import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {readFile} from "node:fs/promises";
async function fixture(t:any){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE publer_config(workspace_id text);INSERT INTO publer_config VALUES('w');`);
  const sql=await readFile("migrations/20261011030000_publer_workspace_upload.sql","utf8");
  await db.exec(sql);await db.exec(sql);
  const rpc=async(name:string,args:any={})=>(await db.query<any>(`SELECT ${name}(${Object.keys({p_workspace:"w",...args})
    .map((k,i)=>`${k}=>$${i+1}`).join(",")}) value`,Object.values({p_workspace:"w",...args}))).rows[0].value;
  return {db,rpc};
}
test("workspace upload lock fences concurrent instances and binds exact provider job",async t=>{
  const s=await fixture(t),one=await s.rpc("publer_upload_acquire");
  assert.equal(one.mode,"acquired");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"busy");
  await s.rpc("publer_upload_begin",{p_token:one.token});
  await s.rpc("publer_upload_record_job",{p_token:one.token,p_job:"job-one"});
  assert.deepEqual(await s.rpc("publer_upload_acquire"),{mode:"reconcile",job_id:"job-one"});
  assert.equal(await s.rpc("publer_upload_finish",{p_job:"wrong",p_terminal:"complete"}),false);
  assert.equal(await s.rpc("publer_upload_finish",{p_job:"job-one",p_terminal:"complete"}),true);
  const two=await s.rpc("publer_upload_acquire");assert.notEqual(two.token,one.token);
  assert.equal(await s.rpc("publer_upload_finish",{p_job:"job-one",p_terminal:"complete"}),true);
  await assert.rejects(s.rpc("publer_upload_begin",{p_token:one.token}),/lease_lost/);
});
test("expired unstarted claims recover but uncertain sending is held indefinitely",async t=>{
  const s=await fixture(t),one=await s.rpc("publer_upload_acquire");
  await s.db.exec("UPDATE publer_workspace_upload SET expires_at=now()-interval '1 second'");
  const two=await s.rpc("publer_upload_acquire");assert.notEqual(one.token,two.token);
  await s.rpc("publer_upload_begin",{p_token:two.token});
  await s.db.exec("UPDATE publer_workspace_upload SET expires_at=now()-interval '1 second'");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
});
test("known rejection releases; unknown workspace and browser calls are denied",async t=>{
  const s=await fixture(t),one=await s.rpc("publer_upload_acquire");
  await s.rpc("publer_upload_begin",{p_token:one.token});
  await s.rpc("publer_upload_rejected",{p_token:one.token});
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"acquired");
  await assert.rejects(s.rpc("publer_upload_acquire",{p_workspace:"foreign"}),/unknown_workspace/);
  await s.db.exec("SET ROLE authenticated");
  await assert.rejects(s.rpc("publer_upload_acquire"),/permission denied/);
});
