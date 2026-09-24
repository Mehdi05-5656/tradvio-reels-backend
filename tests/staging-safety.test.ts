import test from "node:test";
import assert from "node:assert/strict";
import {stagingConfig,stagingFetch,stagingDatabaseSafety} from "../src/staging-safety.js";
const REF="abcdefghijklmnopqrst";
const env={
  STAGING_MODE:"managed-readonly-staging",STAGING_PROJECT_REF:REF,SUPABASE_URL:`https://${REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY:"test-only",MANAGED_PROVISIONING_ENABLED:"1",MANAGED_GENERATION_ENABLED:"0",
  MANAGED_HANDOFF_ENABLED:"0",INGESTION_WORKER_DISABLED:"1",
  STAGING_FRONTEND_ORIGIN:"https://reels-staging.example.test",STAGING_BUILD_SHA:"a".repeat(40),
};
test("staging boot requires a nonproduction project and exact disabled-worker flags",()=>{
  assert.equal(stagingConfig(env).project_ref,REF);
  for(const overrides of [
    {STAGING_PROJECT_REF:"gzvxqzguthrpvjtflxcx"},{SUPABASE_URL:"https://gzvxqzguthrpvjtflxcx.supabase.co"},
    {STAGING_MODE:"production"},{MANAGED_HANDOFF_ENABLED:"1"},{MANAGED_GENERATION_ENABLED:"1"},
    {MANAGED_PROVISIONING_ENABLED:"0"},{INGESTION_WORKER_DISABLED:"0"},{STAGING_BUILD_SHA:""},
    {STAGING_FRONTEND_ORIGIN:"https://real-production.example.test"},
  ])assert.throws(()=>stagingConfig({...env,...overrides}));
});
test("staging boot rejects publishing credentials and shared administrator secrets",()=>{
  for(const name of ["PUBLER_API_KEY","CREATORVAULT_API_KEY","APP_WRITE_SECRET","ANTHROPIC_API_KEY"])
    assert.throws(()=>stagingConfig({...env,[name]:"never-print-this"}),/credentials_forbidden/);
});
test("outbound guard permits only staging database reads, never provider calls or RPC writes",async()=>{
  const calls:any[]=[];
  const guarded=stagingFetch(env.SUPABASE_URL,(async(...args:any[])=>{calls.push(args);return new Response("{}");}) as any);
  await guarded(`${env.SUPABASE_URL}/rest/v1/managed_accounts?select=id`);
  assert.equal(calls[0][1].redirect,"error");
  for(const [url,init] of [
    ["https://app.publer.com/api/v1/accounts",{}],
    ["https://gzvxqzguthrpvjtflxcx.supabase.co/rest/v1/profiles",{}],
    [`${env.SUPABASE_URL}/rest/v1/rpc/managed_handoff_enqueue`,{}],
    [`${env.SUPABASE_URL}/rest/v1/managed_accounts`,{method:"PATCH"}],
    [`${env.SUPABASE_URL}/rest/v1/managed_accounts`,{method:"POST"}],
    [`${env.SUPABASE_URL}/storage/v1/object/a`,{}],
  ] as const)await assert.rejects(guarded(url,init),/outbound_request_blocked/);
  assert.equal(calls.length,1);
});
test("database safety rejects missing controls, nonzero counts and query failures",async()=>{
  for(const kind of ["enabled","missing","count","error","unknown-count"]) {
    const db:any={from:()=> {
      const q:any={select:(_s:any,opts:any)=>opts?q:Promise.resolve({
        data:kind==="missing"?[]:[{singleton:true,enabled:kind==="enabled"}]}),
        eq:()=>q,not:()=>q,or:()=>q,
        then:(resolve:any)=>Promise.resolve({count:kind==="count"?1:kind==="unknown-count"?null:0,
          error:kind==="error"?{}:null}).then(resolve)};
      return q;
    }};
    await assert.rejects(stagingDatabaseSafety(db),/staging_database/);
  }
});
