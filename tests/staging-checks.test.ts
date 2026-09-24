import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {generateKeyPair,SignJWT,jwtVerify} from "jose";
import {stagingApp} from "../src/staging-app.js";
import {runChecks,validateManifest} from "../staging/check-managed.mjs";
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e",ADMIN="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AA="11111111-1111-4111-8111-111111111111",AB="22222222-2222-4222-8222-222222222222";
const REF="abcdefghijklmnopqrst",ISS=`https://${REF}.supabase.co/auth/v1`;
const manifest={schema_version:1,mode:"managed-readonly-staging",backend_origin:"https://reels-staging.example.test",
  project_ref:REF,build_sha:"a".repeat(40),users:{operator:OP,view_admin:ADMIN,customer_a:A,customer_b:B},
  accounts:{customer_a:[AA],customer_b:[AB]}};
async function setup(t:any) {
  const previous=process.env.MANAGED_PROVISIONING_ENABLED;process.env.MANAGED_PROVISIONING_ENABLED="1";
  t.after(()=>{if(previous===undefined)delete process.env.MANAGED_PROVISIONING_ENABLED;else process.env.MANAGED_PROVISIONING_ENABLED=previous;});
  const {publicKey,privateKey}=await generateKeyPair("ES256");
  const tokens:Record<string,string>={};
  for(const [name,id] of Object.entries(manifest.users))tokens[name]=await new SignJWT({role:"authenticated"})
    .setProtectedHeader({alg:"ES256"}).setSubject(id).setIssuer(ISS).setAudience("authenticated")
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const data:Record<string,any[]>={
    profiles:Object.values(manifest.users).map(id=>({user_id:id,role:[OP,ADMIN].includes(id)?"admin":"user",
      external_user_id:`fixture-${id}`,display_name:"Synthetic staging user",email:null})),
    managed_accounts:[{id:AA,customer_user_id:A},{id:AB,customer_user_id:B}].map(a=>({...a,
      publishing_enabled:false,platform:"instagram",handle:"fixture",state:"blocked",blocked_reason:"handoff_pending",created_at:new Date().toISOString()})),
    managed_handoff_control:[{singleton:true,enabled:false}],managed_generation_control:[{singleton:true,enabled:false}],
    managed_handoff_approvals:[],publer_slot_config:[],
    managed_generation_jobs:[{id:"synthetic-generation",account_id:AA,ordinal:1,state:"quality_passed",error_code:null,lease_until:null}],
    managed_handoffs:[{id:"synthetic-handoff",generation_id:"synthetic-generation",account_id:AA,state:"held",
      scheduled_at:"2026-11-01T09:30:00Z",timezone:"America/Los_Angeles",local_date:"2026-11-01",local_time:"01:30",
      post_link:null,error_code:"test_fixture",remote_review_required:false,updated_at:"2026-10-30T12:00:00Z",
      lease_until:null,post_id:null,upload_job_id:null,submit_job_id:null}],
  };
  let reads=0,rpcs=0;
  const db:any={rpc:async()=>{rpcs++;throw new Error("test_mutation_forbidden");},from:(table:string)=>{
    let filters:((r:any)=>boolean)[]=[],columns="*",head=false,limit=Infinity;
    function result() {
      reads++;
      const rows=(data[table]??[]).filter(r=>filters.every(f=>f(r))).slice(0,limit);
      return {data:head?null:rows.map(r=>columns==="*"?r:Object.fromEntries(columns.split(",").map(k=>[k,r[k]]))),
        count:head?rows.length:null,error:null};
    }
    const q:any={select:(cols:string,opts:any)=>{columns=cols;head=!!opts?.head;return q;},
      eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return q;},
      gt:(k:string,v:any)=>{filters.push(r=>r[k]>v);return q;},
      not:(k:string)=>{filters.push(r=>r[k]!=null);return q;},
      or:(s:string)=>{const keys=s.split(",").map(x=>x.split(".")[0]);filters.push(r=>keys.some(k=>r[k]!=null));return q;},
      order:()=>q,limit:(n:number)=>{limit=n;return q;},
      maybeSingle:async()=>({...result(),data:result().data?.[0]??null}),
      then:(resolve:any)=>Promise.resolve(result()).then(resolve)};
    return q;
  }};
  const app=stagingApp({db,config:{project_ref:REF,frontend_origin:"https://ui-staging.example.test",build_sha:manifest.build_sha},
    auth:async(req,res,next)=>{
      req.auth=null;req.profile=null;
      try {
        const {payload}=await jwtVerify((req.header("authorization")??"").replace(/^Bearer /,""),publicKey,
          {issuer:ISS,audience:"authenticated"});
        req.auth={user_id:payload.sub!};
        req.profile=data.profiles.find(p=>p.user_id===payload.sub);
      }catch {}
      next();
    }});
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const methods:string[]=[];
  const transport=async(url:string,init:any)=>{
    methods.push(init.method);return fetch(origin+new URL(url).pathname+new URL(url).search,init);
  };
  return {origin,tokens,data,transport,methods,counts:()=>({reads,rpcs})};
}
test("prepared API acceptance runs across four signed test sessions without a write",async t=>{
  const s=await setup(t);
  const result=await runChecks(manifest,s.tokens,s.transport as any);
  assert.equal(result.status,"passed");assert.equal(result.checks.length,7);
  assert.ok(s.methods.length>35);assert.ok(s.methods.every(m=>m==="GET"));assert.equal(s.counts().rpcs,0);
});
test("staging entry rejects every mutation method before auth, database or provider code",async t=>{
  const s=await setup(t);
  for(const method of ["POST","PUT","PATCH","DELETE"])for(const token of [undefined,s.tokens.operator,s.tokens.customer_a]) {
    const r=await fetch(`${s.origin}/api/admin/managed/handoff-activation`,{method,
      headers:token?{Authorization:`Bearer ${token}`}:{},body:JSON.stringify({enabled:true,account_id:AA})});
    assert.equal(r.status,405);assert.equal((await r.json()).error,"staging_read_only");
  }
  assert.deepEqual(s.counts(),{reads:0,rpcs:0});
});
test("shared-secret authentication and unauthorized safety inspection are not accepted",async t=>{
  const s=await setup(t);
  assert.equal((await fetch(`${s.origin}/api/me`,{headers:{"x-app-secret":"not-a-user-session"}})).status,401);
  assert.equal((await fetch(`${s.origin}/api/staging/safety`,{headers:{Authorization:`Bearer ${s.tokens.view_admin}`}})).status,403);
  assert.equal((await fetch(`${s.origin}/api/creatorvault/webhook`,{method:"POST"})).status,405);
  assert.equal((await fetch(`${s.origin}/api/publer/accounts`,{headers:{Authorization:`Bearer ${s.tokens.operator}`}})).status,404);
});
test("acceptance fails closed when database gates change",async t=>{
  const s=await setup(t);s.data.managed_handoff_control[0].enabled=true;
  await assert.rejects(runChecks(manifest,s.tokens,s.transport as any),/http_status/);
  assert.equal(s.methods.length,1);
});
test("production origins, wrong identities and non-staging tokens fail before network use",async t=>{
  const s=await setup(t);
  assert.throws(()=>validateManifest({...manifest,backend_origin:"https://tradvio-reels-backend.onrender.com"}));
  assert.throws(()=>validateManifest({...manifest,project_ref:"gzvxqzguthrpvjtflxcx"}));
  assert.throws(()=>validateManifest({...manifest,users:{...manifest.users,view_admin:OP}}));
  await assert.rejects(runChecks(manifest,{...s.tokens,customer_a:s.tokens.customer_b},s.transport as any),/staging_session_required/);
  await assert.rejects(runChecks(manifest,{...s.tokens,operator:"broken"},s.transport as any),/staging_session_required/);
  assert.equal(s.methods.length,0);
});
test("checker detects tenant leakage and a falsely granted customer operator capability",async t=>{
  const s=await setup(t);
  const corrupt=async(url:string,init:any)=>{
    const r=await s.transport(url,init);
    if(url.includes("/api/me")&&init.headers.Authorization===`Bearer ${s.tokens.customer_a}`) {
      const b=await r.json();b.capabilities.operate_accounts=true;
      return new Response(JSON.stringify(b),{status:200,headers:r.headers});
    }
    return r;
  };
  await assert.rejects(runChecks(manifest,s.tokens,corrupt as any),/identity_or_capability_mismatch/);
  const leak=async(url:string,init:any)=>{
    const r=await s.transport(url,init);
    if(url.includes("/api/managed/accounts?")&&init.headers.Authorization===`Bearer ${s.tokens.customer_a}`) {
      const b=await r.json();b.accounts.push(s.data.managed_accounts[1]);
      return new Response(JSON.stringify(b),{status:200,headers:r.headers});
    }
    return r;
  };
  await assert.rejects(runChecks(manifest,s.tokens,leak as any),/account_isolation_failed/);
});
