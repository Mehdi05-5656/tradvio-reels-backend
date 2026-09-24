import {generationDb,OP,A} from "./generation-db.js";
export {OP,A,B} from "./generation-db.js";
export async function handoffDb(t:any) {
  const s=await generationDb(t,["20260924020000_managed_handoff.sql"]);
  async function ready(customer=A,destination="account-a") {
    const account=await s.account(customer,destination);
    const asset=await s.rpc("managed_register_asset",{p_actor:OP,p_source:{bucket:"managed-raw",
      object_key:`approved/${destination}.mp4`,sha256:(customer===A?"a":"b").repeat(64),bytes:1024,duration:30,
      facts:"Approved educational source, test only.",audio_rights:true,editorial_approved:true,license_ref:"license"}});
    await s.rpc("managed_grant_asset",{p_actor:OP,p_account:account,p_asset:asset,p_consent:"test",
      p_expires:new Date(Date.now()+30*86400000).toISOString(),p_enabled:true});
    const batch=(await s.db.query<any>("SELECT id FROM managed_batches WHERE account_id=$1",[account])).rows[0].id;
    const token="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const id=(await s.db.query<any>(`INSERT INTO managed_generation_jobs(batch_id,account_id,ordinal,asset_id,state,lease_token,recipe,result)
      VALUES($1,$2,1,$3,'quality_passed',$4,'{"caption":"Approved educational caption."}', '{}') RETURNING id`,[batch,account,asset,token])).rows[0].id;
    await s.db.query("UPDATE managed_generation_jobs SET result=$2 WHERE id=$1",[id,JSON.stringify({
      bucket:"managed-variants",object_key:`${customer}/${account}/${id}/${token}/output.mp4`,
      sha256:(customer===A?"c":"d").repeat(64),qc:{technical_pass:true,content_pass:true},
    })]);
    return {account,asset,generation:id};
  }
  async function activate(account:string) {
    await s.rpc("managed_handoff_activate",{p_actor:OP,p_account:account,p_enabled:true,p_approval:"approved-test-cadence",
      p_expires:new Date(Date.now()+14*86400000).toISOString(),p_settings:{feed:true}});
    await s.rpc("managed_handoff_configure",{p_actor:OP,p_enabled:true,p_daily:20});
  }
  return {...s,ready,activate};
}
