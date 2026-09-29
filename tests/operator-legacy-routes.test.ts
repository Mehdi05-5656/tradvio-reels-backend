import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {generateKeyPair, exportJWK, SignJWT} from "jose";

// Set the Auth origin before importing the real middleware. All verification,
// JWKS and profile requests stay on this synthetic loopback server.
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const CUSTOMER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVOKED="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const keys=await generateKeyPair("RS256");
const jwk={...await exportJWK(keys.publicKey),kid:"local-regression",alg:"RS256"};
const authApp=express();
authApp.get("/auth/v1/.well-known/jwks.json",(_req,res)=>res.json({keys:[jwk]}));
authApp.get("/rest/v1/profiles",(req,res)=>{
  const uid=String(req.query.user_id??"").replace(/^eq\./,"");
  res.json(uid===MISSING?null:{
    user_id:uid,role:[OP,ADMIN].includes(uid)?"admin":"user",
    external_user_id:`synthetic-${uid}`,display_name:"Synthetic",
  });
});
const authServer=createServer(authApp);
await new Promise<void>(r=>authServer.listen(0,"127.0.0.1",r));
const authOrigin=`http://127.0.0.1:${(authServer.address() as any).port}`;
process.env.SUPABASE_URL=authOrigin;
process.env.SUPABASE_SERVICE_ROLE_KEY="local-test-key-not-a-credential";
process.env.APP_WRITE_SECRET="local-test-secret-not-a-credential";
const {resolveAuth}=await import("../src/auth.js");
const {accountAccess}=await import("../src/account-access.js");
const {registerV2Routes}=await import("../src/v2-routes.js");
test.after(()=>{authServer.closeAllConnections();authServer.close();});
async function jwt(uid:string) {
  return new SignJWT({}).setProtectedHeader({alg:"RS256",kid:jwk.kid})
    .setSubject(uid).setAudience("authenticated").setIssuer(`${authOrigin}/auth/v1`)
    .setExpirationTime("5m").sign(keys.privateKey);
}
async function setup(t:any,boundary=true) {
  const writes:any[]=[],harvests:string[]=[];
  const db:any={from(table:string){
    const q:any={upsert(body:any){writes.push({table,body});return q;},
      select(){return q;},async single(){return {data:{phone_slot:"phone_a"},error:null};}};
    return q;
  }};
  const app=express();app.use(express.json());app.use("/api",resolveAuth);
  if(boundary)app.use(accountAccess(()=>db));
  registerV2Routes(app,()=>db,{
    harvestCaptions:async(_sb:any,slot:string)=>{harvests.push(slot);return {ok:true} as any;},
  });
  const server=createServer(app);
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  return {writes,harvests,async post(kind:string,token?:string,secret?:string,slot="phone_a"){
    const r=await fetch(`${base}/api/v2/${kind}/${slot}`,{
      method:"POST",headers:{"content-type":"application/json",
        ...(token?{authorization:`Bearer ${token}`} : {}),
        ...(secret?{"x-app-secret":secret}: {})},
      body:JSON.stringify({caption_hooks:["Synthetic hook"]}),
    });
    return {status:r.status,body:await r.json()};
  }};
}
test("operator JWT works on both legacy routes without the shared secret",async t=>{
  const s=await setup(t),token=await jwt(OP);
  assert.equal((await s.post("templates",token)).status,200);
  assert.equal((await s.post("harvest",token)).status,200);
  assert.equal(s.writes.length,1);assert.deepEqual(s.harvests,["phone_a"]);
});
for(const boundary of [true,false]) {
  test(`legacy mutations reject nonoperators; boundary=${boundary}`,async t=>{
    const s=await setup(t,boundary);
    for(const uid of [CUSTOMER,ADMIN,MISSING,REVOKED]) {
      for(const route of ["templates","harvest"])
        assert.equal((await s.post(route,await jwt(uid))).status,403);
    }
    for(const route of ["templates","harvest"]) {
      assert.ok([401,403].includes((await s.post(route)).status));
      assert.equal((await s.post(route,undefined,process.env.APP_WRITE_SECRET)).status,403);
    }
    assert.equal(s.writes.length,0);assert.equal(s.harvests.length,0);
  });
}
test("mixed headers and invalid tokens cannot acquire operator mutation authority",async t=>{
  const s=await setup(t);
  for(const route of ["templates","harvest"]) {
    for(const token of [await jwt(OP),await jwt(CUSTOMER),"invalid"])
      assert.equal((await s.post(route,token,process.env.APP_WRITE_SECRET)).status,403);
    assert.equal((await s.post(route,"invalid")).status,401);
    // A wrong unused secret does not negate a valid verified operator session.
    assert.equal((await s.post(route,await jwt(OP),"incorrect")).status,200);
  }
  assert.equal(s.writes.length,1);assert.equal(s.harvests.length,1);
});
test("operator cannot mutate unsupported legacy destinations",async t=>{
  const s=await setup(t),token=await jwt(OP);
  for(const route of ["templates","harvest"])
    assert.equal((await s.post(route,token,undefined,"foreign_slot")).status,400);
  assert.equal(s.writes.length,0);assert.equal(s.harvests.length,0);
});
