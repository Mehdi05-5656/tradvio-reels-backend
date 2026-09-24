import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {registerGenerationRoutes} from "../src/generation-routes.js";
import {accountAccess} from "../src/account-access.js";
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",ID="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function setup(t:any,boundary=true,enabled=true) {
  const calls:any[]=[];const filters:any[]=[];
  const db:any={rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:ID};},
    from(table:string) {
      const clauses:any[]=[];const q:any={
        select(cols:string){assert.ok(!/recipe|result|source/.test(cols));return q;},
        eq(k:string,v:any){clauses.push([k,v]);filters.push([k,v]);return q;},order(){return q;},limit(){return q;},
        maybeSingle:async()=>({data:clauses.some(([k,v])=>k==="customer_user_id"&&v!==A)?null:{id:ID}}),
        then(resolve:any){return Promise.resolve({data:[{state:"quality_passed",ordinal:1}]}).then(resolve);},
      };return q;
    }};
  const app=express();app.use(express.json());
  app.use((req:any,_res,next)=>{const who=req.header("test-identity");
    req.auth=who?{user_id:who}:null;req.profile=who?{user_id:who,role:[OP,"read-admin"].includes(who)?"admin":"user"}:null;next();});
  if(boundary)app.use(accountAccess(()=>db));
  registerGenerationRoutes(app,()=>db,()=>enabled);
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {calls,filters,request:async(path:string,who:string,body?:any)=>{
    const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{
      method:body?"POST":"GET",headers:{"content-type":"application/json",...(who?{"test-identity":who}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json(),cache:r.headers.get("cache-control")};
  }};
}
test("generation writes independently enforce sole operator; actor is server-derived",async t=>{
  for(const boundary of [true,false]) {
    const s=await setup(t,boundary);
    for(const who of [A,B,"read-admin",""])for(const path of ["assets","grants","generation-control"]) {
      const r=await s.request(`/api/admin/managed/${path}`,who,{});
      assert.equal(r.status,who?403:401);
    }
    assert.equal(s.calls.length,0);
    const r=await s.request("/api/admin/managed/generation-control",OP,{enabled:false,max_active:1,max_daily_claims:2});
    assert.equal(r.status,200);assert.equal(s.calls[0].args.p_actor,OP);
  }
});
test("progress reads are owner-scoped; unknown ownership reveals nothing; admin can read",async t=>{
  const s=await setup(t),path=`/api/managed/generation/${ID}`;
  const a=await s.request(path,A);assert.equal(a.status,200);assert.equal(a.body.publishing_enabled,false);
  assert.equal(a.cache,"private, no-store");assert.ok(s.filters.some(([k,v])=>k==="customer_user_id"&&v===A));
  assert.equal((await s.request(path,B)).status,404);
  assert.equal((await s.request(path,"read-admin")).status,200);
});
test("feature gate and malformed control/grant bodies cannot mutate",async t=>{
  const off=await setup(t,true,false);
  assert.equal((await off.request("/api/admin/managed/assets",OP,{})).status,503);assert.equal(off.calls.length,0);
  const s=await setup(t);
  assert.equal((await s.request("/api/admin/managed/generation-control",OP,{enabled:true,max_active:99,max_daily_claims:2})).status,400);
  assert.equal((await s.request("/api/admin/managed/grants",OP,{account_id:A,asset_id:B,consent_ref:"yes",expires_at:"never",enabled:true})).status,400);
  assert.equal(s.calls.length,0);
});
