import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {registerHandoffRoutes} from "../src/handoff-routes.js";
import {accountAccess} from "../src/account-access.js";
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",ID="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function setup(t:any,boundary=true,enabled=true) {
  const calls:any[]=[];const filters:any[]=[];
  const db:any={rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:{enabled:false,external_schedules_cancelled:false}};},
    from(table:string) {
      const clauses:any[]=[];const q:any={
        select(cols:string){assert.ok(!/artifact|caption|workspace|lease|customer_user_id/.test(cols));return q;},
        eq(k:string,v:any){clauses.push([k,v]);filters.push([k,v]);return q;},order(){return q;},limit(){return q;},
        maybeSingle:async()=>({data:clauses.some(([k,v])=>k==="customer_user_id"&&v!==A)?null:{id:ID,publishing_enabled:true}}),
        then(resolve:any){return Promise.resolve({data:[{state:"scheduled",remote_review_required:false}]}).then(resolve);},
      };return q;
    }};
  const app=express();app.use(express.json());
  app.use((req:any,_res,next)=>{const who=req.header("test-identity");
    req.auth=who?{user_id:who}:null;req.profile=who?{user_id:who,role:[OP,"read-admin"].includes(who)?"admin":"user"}:null;next();});
  if(boundary)app.use(accountAccess(()=>db));
  registerHandoffRoutes(app,()=>db,()=>enabled);
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {calls,filters,request:async(path:string,who:string,body?:any)=>{
    const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{
      method:body?"POST":"GET",headers:{"content-type":"application/json",...(who?{"test-identity":who}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json(),cache:r.headers.get("cache-control")};
  }};
}
test("handoff writes independently require operator, never customer or viewing admin",async t=>{
  for(const boundary of [true,false]) {
    const s=await setup(t,boundary);
    for(const who of [A,B,"read-admin",""])for(const path of ["handoff-control","handoff-activation"]) {
      assert.equal((await s.request(`/api/admin/managed/${path}`,who,{})).status,who?403:401);
    }
    assert.equal(s.calls.length,0);
    const r=await s.request("/api/admin/managed/handoff-control",OP,{enabled:false,daily_claims:100});
    assert.equal(r.status,200);assert.equal(s.calls[0].args.p_actor,OP);
    assert.equal(r.body.external_schedules_cancelled,false);
  }
});
test("handoff reads are owner-scoped and distinguish activation from provider state",async t=>{
  const s=await setup(t),path=`/api/managed/handoffs/${ID}`;
  const r=await s.request(path,A);
  assert.equal(r.status,200);assert.equal(r.body.publishing_enabled,true);
  assert.equal(r.body.handoffs[0].state,"scheduled");assert.equal(r.cache,"private, no-store");
  assert.ok(s.filters.some(([k,v])=>k==="customer_user_id"&&v===A));
  assert.equal((await s.request(path,B)).status,404);
  assert.equal((await s.request(path,"read-admin")).status,200);
});
test("handoff feature switch and strict bodies reject unintended activation",async t=>{
  const off=await setup(t,true,false);
  assert.equal((await off.request("/api/admin/managed/handoff-control",OP,{enabled:true,daily_claims:100})).status,503);
  const s=await setup(t);
  assert.equal((await s.request("/api/admin/managed/handoff-control",OP,{enabled:true,daily_claims:999})).status,400);
  assert.equal((await s.request("/api/admin/managed/handoff-activation",OP,
    {account_id:ID,enabled:true,approval_ref:"",expires_at:"tomorrow"})).status,400);
  assert.equal(s.calls.length,0);assert.equal(off.calls.length,0);
});
