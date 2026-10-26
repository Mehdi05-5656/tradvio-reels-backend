import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {generateKeyPair, exportJWK, SignJWT} from "jose";

// Research accounts are per client: an admin asking for one client's leaders never sees another client's, and a
// new leader is written with the client it was added for. Auth runs through the real middleware on a loopback server.
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ORG_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const keys=await generateKeyPair("RS256");
const jwk={...await exportJWK(keys.publicKey),kid:"local-regression",alg:"RS256"};
const authApp=express();
authApp.get("/auth/v1/.well-known/jwks.json",(_req,res)=>res.json({keys:[jwk]}));
authApp.get("/rest/v1/profiles",(req,res)=>{const uid=String(req.query.user_id??"").replace(/^eq\./,"");res.json({user_id:uid,role:"admin",external_user_id:`synthetic-${uid}`,display_name:"Synthetic"});});
const authServer=createServer(authApp);
await new Promise<void>(r=>authServer.listen(0,"127.0.0.1",r));
const authOrigin=`http://127.0.0.1:${(authServer.address() as any).port}`;
process.env.SUPABASE_URL=authOrigin;
process.env.SUPABASE_SERVICE_ROLE_KEY="local-test-key-not-a-credential";
process.env.APP_WRITE_SECRET="local-test-secret-not-a-credential";
const {resolveAuth}=await import("../src/auth.js");
const {registerV2Routes}=await import("../src/v2-routes.js");
test.after(()=>{authServer.closeAllConnections();authServer.close();});
const jwt=(uid:string)=>new SignJWT({}).setProtectedHeader({alg:"RS256",kid:jwk.kid}).setSubject(uid).setAudience("authenticated").setIssuer(`${authOrigin}/auth/v1`).setExpirationTime("5m").sign(keys.privateKey);

const leaders=[
  {id:"11111111-1111-4111-8111-111111111111",org_id:ORG_A,phone_slot:"phone_a",provider:"instagram",handle:"tradvio",active:true,created_at:"2026-09-08T00:00:00Z"},
  {id:"22222222-2222-4222-8222-222222222222",org_id:ORG_B,phone_slot:null,provider:"tiktok",handle:"acme",active:true,created_at:"2026-10-26T00:00:00Z"},
];
function fakeDb(inserts:any[]) {
  return {from(table:string){
    const f:Record<string,any>={};
    const q:any={
      select(){return q;},order(){return q;},limit(){return q;},
      eq(k:string,v:any){f[k]=v;return q;},
      insert(row:any){inserts.push({table,row});q._inserted={...row,id:"33333333-3333-4333-8333-333333333333",phone_slot:null,created_at:"2026-10-26T01:00:00Z"};return q;},
      async single(){return table==="leader_accounts"&&q._inserted?{data:q._inserted,error:null}:{data:null,error:null};},
      async maybeSingle(){return table==="client_orgs"?{data:{id:f.id,archived_at:null},error:null}:{data:null,error:null};},
      then(res:any){
        if(table==="leader_accounts")return Promise.resolve({data:leaders.filter(l=>!("org_id" in f)||l.org_id===f.org_id),error:null}).then(res);
        return Promise.resolve({data:[],error:null,count:0}).then(res);
      },
    };
    return q;
  }};
}
async function setup(t:any) {
  const inserts:any[]=[];
  const app=express();app.use(express.json());app.use("/api",resolveAuth);
  registerV2Routes(app,()=>fakeDb(inserts),{harvestCaptions:async()=>({ok:true} as any)});
  const server=createServer(app);
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const token=await jwt(OP);
  const call=async(method:string,path:string,body?:any)=>{const r=await fetch(base+path,{method,headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};};
  return {inserts,call};
}

test("GET /api/v2/leaders?org= returns only that client's research accounts; without org an admin sees all",async(t)=>{
  const {call}=await setup(t);
  const a=await call("GET",`/api/v2/leaders?org=${ORG_A}`);
  assert.equal(a.status,200);assert.deepEqual(a.json.leaders.map((l:any)=>l.handle),["tradvio"]);
  const b=await call("GET",`/api/v2/leaders?org=${ORG_B}`);
  assert.deepEqual(b.json.leaders.map((l:any)=>l.handle),["acme"]);
  assert.equal(b.json.leaders[0].org_id,ORG_B);
  const all=await call("GET","/api/v2/leaders");
  assert.equal(all.json.leaders.length,2);
  assert.equal((await call("GET","/api/v2/leaders?org=nope")).status,400);
});

test("POST /api/v2/leaders writes the leader for the client it was added to and validates the input",async(t)=>{
  const {inserts,call}=await setup(t);
  const r=await call("POST","/api/v2/leaders",{org_id:ORG_B,provider:"Instagram",handle:"https://www.instagram.com/@new.creator/"});
  assert.equal(r.status,201,JSON.stringify(r.json));
  assert.deepEqual(inserts,[{table:"leader_accounts",row:{org_id:ORG_B,provider:"instagram",handle:"new.creator",active:true}}]);
  assert.equal(r.json.leader.org_id,ORG_B);assert.equal(r.json.leader.post_count,0);
  assert.equal((await call("POST","/api/v2/leaders",{provider:"instagram",handle:"x"})).json.error,"client_required");
  assert.equal((await call("POST","/api/v2/leaders",{org_id:ORG_A,provider:"youtube",handle:"x"})).json.error,"invalid_provider");
  assert.equal((await call("POST","/api/v2/leaders",{org_id:ORG_A,provider:"tiktok",handle:"bad handle!"})).json.error,"invalid_handle");
  assert.equal(inserts.length,1);
});
