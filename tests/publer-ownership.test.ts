import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {generationDb,OP,A} from "./helpers/generation-db.js";
async function setup(t:any) {
  const s=await generationDb(t);
  await s.db.exec(`ALTER TABLE publer_slot_config ADD COLUMN owner_user_id uuid; UPDATE publer_slot_config SET owner_user_id='${OP}';`);
  const sql=await readFile("migrations/20261008020000_publer_ownership.sql","utf8");
  await s.db.exec(sql);await s.db.exec(sql);
  const rows=Array.from({length:18},(_,i)=>({id:i===0?'legacy-account':`new-${i}`,
    platform:i<9?'instagram':'tiktok',label:`account-${i}`,label_is_username:i<9}));
  const assign=(accounts=rows,owner=OP,actor=OP)=>s.rpc("publer_assign_operator_ownership",
    {p_actor:actor,p_owner:owner,p_workspace:"legacy",p_accounts:accounts,p_observed_at:new Date().toISOString()});
  return {...s,rows,assign};
}
test("all 18 ownership records are idempotent and never create schedules or generation jobs",async t=>{
  const s=await setup(t);
  assert.equal(await s.assign(),18);assert.equal(await s.assign(),18);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM publer_account_ownership")).rows[0].n,18);
  for(const table of ["managed_accounts","managed_generation_jobs","managed_setup_jobs"])
    assert.equal((await s.db.query<any>(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  assert.deepEqual((await s.db.query("SELECT phone_slot,paused,owner_user_id FROM publer_slot_config")).rows,
    [{phone_slot:"phone_a",paused:false,owner_user_id:OP}]);
  await assert.rejects(s.db.query("UPDATE publer_slot_config SET owner_user_id=$1",[A]),/ownership_conflict/);
});
test("ownership assignment rejects other actors, wrong owners, conflicting legacy rows and malformed inventory atomically",async t=>{
  const s=await setup(t);
  await assert.rejects(s.assign(s.rows,OP,A),/operator_required/);
  await assert.rejects(s.assign(s.rows,A),/operator_owner_required/);
  await assert.rejects(s.assign([s.rows[0],s.rows[0]]),/invalid_inventory/);
  await assert.rejects(s.assign([{...s.rows[0],secret:"not-allowed"}] as any),/invalid_inventory/);
  await s.db.query("UPDATE publer_slot_config SET owner_user_id=$1",[A]);
  await assert.rejects(s.assign(),/ownership_conflict/);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM publer_account_ownership")).rows[0].n,0);
});
test("browser roles cannot read ownership table or invoke assignment; service role cannot edit directly",async t=>{
  const s=await setup(t);
  for(const role of ["anon","authenticated"]) {
    await s.db.exec(`SET ROLE ${role}`);
    await assert.rejects(s.db.query("SELECT * FROM publer_account_ownership"),/permission denied/);
    await assert.rejects(s.assign(),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
  await s.db.exec("SET ROLE service_role");
  assert.equal(await s.assign(),18);
  await assert.rejects(s.db.exec("DELETE FROM publer_account_ownership"),/permission denied/);
});
