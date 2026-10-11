import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {registerLibraryImport} from "../src/library-import.js";
test("import is disabled without network or credential access",async t=>{
  const s=await setup(t,false);
  const r=await s.post("a".repeat(64));assert.equal(r.status,404);assert.equal(s.calls.length,0);
});
test("one-file import authenticates its capability before generating a private upload URL",async t=>{
  const s=await setup(t,true);
  assert.equal((await s.post("bad")).status,403);assert.equal(s.calls.length,0);
  const r=await s.post("a".repeat(64));assert.equal(r.status,200);
  assert.equal(s.calls[0][1].p_token_hash,createHash("sha256").update("a".repeat(64)).digest("hex"));
  assert.equal(s.calls[1][0],"managed-raw");
  assert.equal(s.calls[2][0],"originals/"+"b".repeat(64)+".mp4");
  assert.deepEqual(s.calls[2][1],{upsert:false});
  assert.equal(r.headers.get("cache-control"),"private, no-store");
});
test("expired tickets and unexpected storage URLs fail closed",async t=>{
  const s=await setup(t,true);
  s.state.expired=true;assert.equal((await s.post("a".repeat(64))).status,403);
  s.state.expired=false;s.state.wrongUrl=true;assert.equal((await s.post("a".repeat(64))).status,503);
});
async function setup(t:any,enabled:boolean){
  const calls:any[]=[];const state={expired:false,wrongUrl:false};const sha="b".repeat(64);
  const db:any={rpc:async(name:string,args:any)=>{
    calls.push([name,args]);return {data:state.expired?null:{sha256:sha,bytes:1024,object_key:`originals/${sha}.mp4`},error:null};
  },storage:{getBucket:async()=>({data:{public:false},error:null}),from:(bucket:string)=>{
    calls.push([bucket]);return {createSignedUploadUrl:async(key:string,opts:any)=>{
      calls.push([key,opts]);return {data:{signedUrl:state.wrongUrl?"https://attacker.test/upload":
        `https://example.supabase.co/storage/v1/object/upload/sign/managed-raw/${key}?token=private`},error:null};
    }};
  }}};
  const app=express();app.use(express.json());
  registerLibraryImport(app,()=>db,()=>enabled,()=>"https://example.supabase.co");
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  return {calls,state,post:(token:string)=>fetch(base+"/internal/library/source-upload",{
    method:"POST",headers:{"authorization":`Bearer ${token}`,"content-type":"application/json"},body:"{}"})};
}
