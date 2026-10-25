import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createServer} from "node:http";
import {registerReportingRoutes} from "../src/reporting.js";
import {accountAccess} from "../src/account-access.js";

async function fixture(t:any){
  const scopes:any[]=[];
  const slots=Array.from({length:18},(_,i)=>({phone_slot:`library_${i}`,handle:`account_${i}`,provider:"instagram",owner_user_id:i<2?"customer":"operator",paused:false,daily_target:8}));
  const sb:any={from(table:string){
    const q:any={select(){return q},order(){return q},gte(){return q},lte(){return q},
      in(_key:string,ids:string[]){scopes.push(ids);return q},
      range(){return Promise.resolve({data:[],error:null})},
      then(resolve:any){return Promise.resolve({data:table==="publer_slot_config"?slots:[],error:null}).then(resolve)}};
    return q;
  },async rpc(_name:string,args:any){scopes.push(args.p_slots);return {data:[],error:null}}};
  const app=express();
  app.use((req:any,_res,next)=>{
    if(req.headers["x-test-user"]){req.auth={user_id:req.headers["x-test-user"]};req.profile={role:req.headers["x-test-role"]??"user"};}next();
  });
  app.use(accountAccess(()=>sb));registerReportingRoutes(app,()=>sb);
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close()});
  return {scopes,async get(user?:string,role?:string,query=""){
    const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/v2/report?from=2026-10-10&to=2026-10-11${query}`,
      {headers:{...(user?{"x-test-user":user}:{}),...(role?{"x-test-role":role}:{})}});
    return {status:r.status,body:await r.json()};
  }};
}
test("report admin sees all 18 accounts without device registry",async t=>{
  const f=await fixture(t),r=await f.get("operator","admin");
  assert.equal(r.status,200);assert.equal(r.body.accounts.length,18);
});
test("report customer sees only their two accounts and every DB read is scoped",async t=>{
  const f=await fixture(t),r=await f.get("customer");
  assert.equal(r.status,200);assert.equal(r.body.accounts.length,2);
  assert.ok(f.scopes.every(ids=>ids.length===2&&ids.every((s:string)=>["library_0","library_1"].includes(s))));
});
test("unowned selectors, anonymous requests and unassigned customers fail closed",async t=>{
  const f=await fixture(t);
  assert.equal((await f.get()).status,401);
  assert.equal((await f.get("customer","user","&accounts=library_3")).status,403);
  assert.equal((await f.get("stranger")).body.accounts.length,0);
  assert.equal(f.scopes.length,0);
});
test("identical report requests are served from the per-app cache; ?fresh=1 recomputes",async t=>{
  const f=await fixture(t);
  const before=f.scopes.length;
  const a=await f.get("operator","admin");assert.equal(a.status,200);
  const reads=f.scopes.length-before;assert.ok(reads>0);
  const b=await f.get("operator","admin");assert.equal(b.status,200);
  assert.equal(f.scopes.length-before,reads,"second identical request did not touch the database");
  assert.ok(b.body.cached_at,"cached responses say when they were computed");
  const c=await f.get("operator","admin","&fresh=1");assert.equal(c.status,200);
  assert.ok(f.scopes.length-before>reads,"fresh=1 recomputed");
  assert.equal(c.body.cached_at,undefined);
});

test("publerThumbnail accepts the compact raw.thumbnail projection and the full media shape", async () => {
  const { publerThumbnail } = await import("../src/reporting.js");
  assert.equal(publerThumbnail({ thumbnail: "https://cdn.publer.com/uploads/photos/thumb_a.jpg" }), "https://cdn.publer.com/uploads/photos/thumb_a.jpg");
  assert.equal(publerThumbnail({ thumbnail: "https://evil.example/x.jpg" }), null);
  assert.equal(publerThumbnail({ media: [{ default_thumbnail: 1, thumbnails: [{ small: "https://cdn.publer.com/a.jpg" }, { small: "https://cdn.publer.com/b.jpg" }] }] }), "https://cdn.publer.com/b.jpg");
  assert.equal(publerThumbnail({ id: "x" }), null);
});
