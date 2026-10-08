import test from "node:test";
import assert from "node:assert/strict";
import {generationDb,OP,A,B} from "./helpers/generation-db.js";

test("operator may own a managed account without widening other admins or legacy access",async t=>{
  const s=await generationDb(t,["20261008010000_managed_operator_owner.sql"]);
  assert.equal(await s.rpc("managed_customer_eligible",{p_customer:OP}),true);
  assert.equal(await s.rpc("managed_customer_eligible",{p_customer:A}),true);
  await s.db.query("UPDATE profiles SET role='admin' WHERE user_id=$1",[B]);
  assert.equal(await s.rpc("managed_customer_eligible",{p_customer:B}),false);
  await assert.rejects(s.rpc("managed_register_workspace",{p_actor:OP,p_customer:OP,
    p_workspace:"legacy",p_consent_ref:"operator-request"}),/legacy_workspace/);
  const id=await s.account(OP,"new-operator-destination");
  const row=(await s.db.query<any>("SELECT customer_user_id,publishing_enabled FROM managed_accounts WHERE id=$1",[id])).rows[0];
  assert.equal(row.customer_user_id,OP);assert.equal(row.publishing_enabled,false);
  assert.deepEqual((await s.db.query("SELECT * FROM publer_slot_config")).rows,
    [{phone_slot:"phone_a",publer_account_id:"legacy-account",paused:false}]);
  await assert.rejects(s.account(OP,"legacy-account"),/legacy_destination/);
});
test("operator ownership still requires a verified active profile and denies browser RPCs",async t=>{
  const s=await generationDb(t,["20261008010000_managed_operator_owner.sql"]);
  await s.db.query("UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=$1",[OP]);
  assert.equal(await s.rpc("managed_customer_eligible",{p_customer:OP}),false);
  for(const role of ["anon","authenticated"]) {
    await s.db.exec(`SET ROLE ${role}`);
    await assert.rejects(s.rpc("managed_customer_eligible",{p_customer:OP}),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
});
