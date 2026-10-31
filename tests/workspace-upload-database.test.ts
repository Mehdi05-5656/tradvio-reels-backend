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
  const release=await readFile("migrations/20261031193000_publer_upload_auto_release.sql","utf8");
  await db.exec(release);await db.exec(release);
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
test("expired unstarted claims recover; uncertain sending is held, then released after 30 minutes",async t=>{
  const s=await fixture(t),one=await s.rpc("publer_upload_acquire");
  await s.db.exec("UPDATE publer_workspace_upload SET expires_at=now()-interval '1 second'");
  const two=await s.rpc("publer_upload_acquire");assert.notEqual(one.token,two.token);
  await s.rpc("publer_upload_begin",{p_token:two.token});
  await s.db.exec("UPDATE publer_workspace_upload SET expires_at=now()-interval '1 second'");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
  // 29 minutes: still held.
  await s.db.exec("UPDATE publer_workspace_upload SET updated_at=now()-interval '29 minutes'");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
  // 31 minutes: released and a fresh lease is handed out; the old token is dead.
  await s.db.exec("UPDATE publer_workspace_upload SET updated_at=now()-interval '31 minutes'");
  const three=await s.rpc("publer_upload_acquire");
  assert.equal(three.mode,"acquired");assert.notEqual(three.token,two.token);
  await assert.rejects(s.rpc("publer_upload_record_job",{p_token:two.token,p_job:"late"}),/lease_lost/);
  const row=(await s.db.query<any>("SELECT auto_release_count,auto_released_at FROM publer_workspace_upload")).rows[0];
  assert.equal(row.auto_release_count,1);assert.ok(row.auto_released_at);
  // A hold set by a direct upload error (publer_upload_hold) follows the same rule.
  await s.rpc("publer_upload_begin",{p_token:three.token});
  await s.rpc("publer_upload_hold",{p_token:three.token});
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"held");
  await s.db.exec("UPDATE publer_workspace_upload SET updated_at=now()-interval '31 minutes'");
  assert.equal((await s.rpc("publer_upload_acquire")).mode,"acquired");
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
