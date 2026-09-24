import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerManagedRoutes, normalizeManagedInventory } from "../src/managed-routes.js";
import { provisionManagedAccounts } from "../src/managed-provisioning.js";
import { accountAccess } from "../src/account-access.js";

const OP = "71c2308a-9e23-4458-b4f0-df7ae53c841e";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const body = {
  customer_user_id: A, workspace_id: "workspace-a", inventory_id: INV,
  publer_account_id: "account-a", idempotency_key: "request-0001",
  policy: { timezone: "America/Los_Angeles", slot_times: ["10:00"], buffer_days: 3 },
  brand_inputs: { audience: "New traders", language: "en", voice: "Educational", cta: "Learn more" },
  rights_confirmed: false,
};
async function setup(t: any, options: { enabled?: boolean; providerFails?: boolean; provisionFails?: boolean; boundary?: boolean } = {}) {
  const rpcCalls: any[] = [], filters: any[] = [];
  let providerCalls = 0;
  const db: any = {
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name==="managed_provision_pending" && options.provisionFails) return { error: { message: "private SQL details" } };
      return { data: name==="managed_provision_pending" ? 1 : name==="managed_record_inventory" ? INV : "assigned-account", error: null };
    },
    from(table: string) {
      const clauses: any[] = [];
      const q: any = {
        select() { return q; }, eq(k: string,v: any) { clauses.push([k,v]); filters.push([table,k,v]); return q; },
        order() { return q; }, limit() { return q; }, gt() { return q; },
        then(resolve: any) {
          return Promise.resolve({ data: table==="managed_workspaces" ? [{workspace_id:"workspace-a"}] :
            [{ id:"account-a",customer_user_id:A,state:"blocked",publishing_enabled:false },
             { id:"account-b",customer_user_id:B,state:"assigned",publishing_enabled:false }]
              .filter(r => clauses.every(([k,v]) => (r as any)[k]===v)), error:null }).then(resolve);
        },
      };
      return q;
    },
  };
  const app = express(); app.use(express.json());
  app.use((req: any,_res,next) => {
    const who = req.header("test-identity");
    req.auth = who==="secret" ? {admin_secret:true} : who ? {user_id:who} : null;
    req.profile = who ? {user_id:who,role:[OP,"admin"].includes(who) ? "admin":"user"} : null;
    next();
  });
  if(options.boundary!==false) app.use(accountAccess(() => db));
  registerManagedRoutes(app,()=>db,{
    enabled:()=>options.enabled!==false,
    providerList: async () => {
      providerCalls++;
      if(options.providerFails) throw new Error("secret provider payload");
      return [{id:"account-a",provider:"instagram",username:"customer_a",name:"Customer A",type:"instagram"}];
    },
  });
  const server = createServer(app);
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{ server.closeAllConnections();server.close(); });
  return { rpcCalls,filters,providerCalls:()=>providerCalls,db,
    async request(path: string, who=OP, method="POST", payload: any=body) {
      const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{
        method,headers:{"content-type":"application/json",...(who?{"test-identity":who}:{})},
        ...(method==="GET"?{}:{body:JSON.stringify(payload)}),
      });
      return {status:r.status,body:await r.json(),cache:r.headers.get("cache-control")};
    },
  };
}
test("managed route handlers require the sole operator even without the global middleware",async t=>{
  const s=await setup(t,{boundary:false});
  for(const who of [A,"admin","secret",""]) {
    for(const path of ["/api/admin/managed/workspaces","/api/admin/managed/discover","/api/admin/managed/assign"]) {
      assert.ok([401,403].includes((await s.request(path,who)).status));
    }
  }
  assert.equal(s.rpcCalls.length,0);assert.equal(s.providerCalls(),0);
});
test("managed feature off makes no database or provider calls",async t=>{
  const s=await setup(t,{enabled:false});
  assert.equal((await s.request("/api/admin/managed/assign")).status,503);
  assert.equal((await s.request("/api/managed/accounts",A,"GET")).status,503);
  assert.equal(s.rpcCalls.length,0);assert.equal(s.providerCalls(),0);
});
test("workspace registration snapshots only allowlisted server-observed account facts",async t=>{
  const s=await setup(t);
  const r=await s.request("/api/admin/managed/workspaces",OP,"POST",{
    customer_user_id:A,workspace_id:"workspace-a",consent_ref:"consent-123",
  });
  assert.equal(r.status,201);
  assert.deepEqual(s.rpcCalls.map(x=>x.name),["managed_register_workspace","managed_record_inventory"]);
  assert.equal(s.rpcCalls[0].args.p_actor,OP);
  assert.deepEqual(s.rpcCalls[1].args.p_accounts,[{id:"account-a",platform:"instagram",handle:"customer_a"}]);
  assert.equal(r.body.connection_evidence,"listed_only");
});
test("provider failure cannot register a workspace or pretend discovery succeeded",async t=>{
  const s=await setup(t,{providerFails:true});
  const r=await s.request("/api/admin/managed/workspaces",OP,"POST",{
    customer_user_id:A,workspace_id:"workspace-a",consent_ref:"consent-123",
  });
  assert.equal(r.status,502);assert.equal(s.rpcCalls.length,0);
  assert.ok(!JSON.stringify(r.body).includes("secret"));
});
test("assignment creates the durable request before triggering automatic provisioning",async t=>{
  const s=await setup(t,{provisionFails:true});
  const r=await s.request("/api/admin/managed/assign");
  assert.equal(r.status,202);assert.equal(r.body.setup_dispatch,"pending_recovery");
  assert.equal(r.body.publishing_enabled,false);
  assert.deepEqual(s.rpcCalls.map(x=>x.name),["managed_assign_account","managed_provision_pending"]);
  assert.equal(s.rpcCalls[0].args.p_actor,OP);
  assert.equal(s.rpcCalls[0].args.p_customer,A);
  assert.ok(!JSON.stringify(r.body).includes("SQL"));
});
test("assignment input rejects client provider facts and invalid schedules before any writes",async t=>{
  const s=await setup(t);
  for(const payload of [
    {...body,observed_at:new Date().toISOString()},
    {...body,handle:"forged"},
    {...body,customer_user_id:"not-a-uuid"},
    {...body,rights_confirmed:"true"},
    {...body,policy:{...body.policy,slot_times:["10:00","10:00"]}},
    {...body,policy:{...body.policy,timezone:"Not/AZone"}},
    {...body,brand_inputs:{...body.brand_inputs,password:"do-not-store"}},
  ]) assert.equal((await s.request("/api/admin/managed/assign",OP,"POST",payload)).status,400);
  assert.equal(s.rpcCalls.length,0);
});
test("customer setup status is owner-scoped and admin visibility remains read-only",async t=>{
  const s=await setup(t);
  const r=await s.request(`/api/managed/accounts?customer_user_id=${B}&scope=all`,A,"GET");
  assert.equal(r.status,200);assert.equal(r.body.accounts.length,1);
  assert.equal(r.body.accounts[0].id,"account-a");assert.equal(r.cache,"private, no-store");
  assert.ok(s.filters.some(x=>x[1]==="customer_user_id"&&x[2]===A));
  assert.equal((await s.request("/api/managed/accounts","admin","GET")).body.accounts.length,2);
});
test("inventory normalization refuses duplicate or malformed accounts and never copies secrets",()=>{
  assert.deepEqual(normalizeManagedInventory([{id:"a",provider:"instagram",name:"Name",access_token:"secret"}]),
    [{id:"a",platform:"instagram",handle:"Name"}]);
  assert.deepEqual(normalizeManagedInventory([{id:"a",provider:"facebook",name:"Name"}]),[]);
  for(const rows of [null,{},[{id:"a",provider:"instagram"}],
    [{id:"a",provider:"instagram",name:"A"},{id:"a",provider:"instagram",name:"B"}]]) {
    assert.throws(()=>normalizeManagedInventory(rows));
  }
});
test("provisioning worker is inert unless explicitly enabled",async t=>{
  const s=await setup(t);
  assert.deepEqual(await provisionManagedAccounts(s.db,false),{enabled:false,processed:0});
  assert.equal(s.rpcCalls.length,0);
  assert.deepEqual(await provisionManagedAccounts(s.db,true),{enabled:true,processed:1});
});
