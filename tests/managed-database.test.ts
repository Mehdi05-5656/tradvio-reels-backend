import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import { createServer } from "node:http";
import { registerManagedRoutes } from "../src/managed-routes.js";
import { accountAccess } from "../src/account-access.js";

const OP = "71c2308a-9e23-4458-b4f0-df7ae53c841e";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POLICY = { timezone: "America/Los_Angeles", slot_times: ["10:00", "16:00"], buffer_days: 3 };
const BRAND = { audience: "New traders", voice: "Educational", language: "en", cta: "Learn more" };
const tables = ["managed_workspaces", "managed_inventory", "managed_accounts",
  "managed_assignment_requests", "managed_setup_jobs", "managed_blueprints", "managed_batches", "managed_audit"];

async function setup(t: any) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
    CREATE TABLE public.profiles(user_id uuid PRIMARY KEY REFERENCES auth.users, role text, display_name text);
    CREATE TABLE public.publer_config(id text PRIMARY KEY, workspace_id text);
    CREATE TABLE public.publer_slot_config(phone_slot text PRIMARY KEY, publer_account_id text, paused boolean);
    INSERT INTO publer_config VALUES ('main','legacy-workspace');
    INSERT INTO publer_slot_config VALUES ('phone_a','legacy-account',false);
    INSERT INTO auth.users(id,email_confirmed_at) VALUES ('${OP}',now()),('${A}',now()),('${B}',now());
    INSERT INTO profiles VALUES ('${OP}','admin','Operator'),('${A}','user','A'),('${B}','user','B');
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
  `);
  const sql = await readFile("migrations/20260924001500_managed_provisioning.sql", "utf8");
  await db.exec(sql);
  await db.exec(sql);
  const rpc = async (fn: string, values: any[]) => {
    const r = await db.query<any>(`SELECT public.${fn}(${values.map((_,i) => "$"+(i+1)).join(",")}) AS value`, values);
    return r.rows[0].value;
  };
  const register = (actor = OP, customer = A, workspace = "workspace-a") =>
    rpc("managed_register_workspace", [actor, customer, workspace, "consent-record-123"]);
  const snapshot = (workspace: string, id = "account-a") =>
    rpc("managed_record_inventory", [OP, workspace, JSON.stringify([{ id, platform: "instagram", handle: "customer_a" }])]);
  const assign = (inventory: string, key = "request-0001", brand = BRAND, customer = A, workspace = "workspace-a", account = "account-a", rights = true) =>
    rpc("managed_assign_account", [OP, customer, workspace, inventory, account, key, JSON.stringify(POLICY), JSON.stringify(brand), rights]);
  return { db, rpc, register, snapshot, assign };
}

test("managed registration validates actor and customer, preserves legacy and forbids workspace reassignment", async t => {
  const s = await setup(t);
  await assert.rejects(s.register(A), /operator_required/);
  await s.db.exec(`UPDATE auth.users SET email_confirmed_at=NULL WHERE id='${A}'`);
  await assert.rejects(s.register(), /customer_ineligible/);
  await s.db.exec(`UPDATE auth.users SET email_confirmed_at=now() WHERE id='${A}'`);
  await assert.rejects(s.register(OP,A,"legacy-workspace"), /legacy_workspace/);
  await s.register(); await s.register();
  await assert.rejects(s.register(OP,B), /workspace_conflict/);
  assert.deepEqual((await s.db.query("SELECT * FROM publer_slot_config")).rows,
    [{ phone_slot: "phone_a", publer_account_id: "legacy-account", paused: false }]);
});

test("assignment is atomic, payload-bound idempotent, unique and never activates publishing", async t => {
  const s = await setup(t); await s.register();
  const inv = await s.snapshot("workspace-a");
  const first = await s.assign(inv);
  assert.equal(await s.assign(inv), first);
  assert.equal(await s.assign(inv, "request-0002"), first);
  await assert.rejects(s.assign(inv, "request-0001", { ...BRAND, voice: "Different" }), /assignment_conflict/);
  await s.register(OP,B,"workspace-b");
  const otherInv = await s.snapshot("workspace-b");
  await assert.rejects(s.assign(otherInv,"request-0003",BRAND,B,"workspace-b"), /destination_conflict/);
  for (const table of ["managed_accounts","managed_setup_jobs"]) {
    assert.equal((await s.db.query<any>(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,1);
  }
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_audit WHERE action='assigned'")).rows[0].n,1);
  const row = (await s.db.query<any>("SELECT * FROM managed_accounts")).rows[0];
  assert.equal(row.state,"assigned"); assert.equal(row.publishing_enabled,false);
  await assert.rejects(s.db.exec("UPDATE managed_accounts SET publishing_enabled=true"), /check constraint/);
});

test("assignment refuses stale inventory, wrong destination, wrong tenant and legacy accounts", async t => {
  const s = await setup(t); await s.register();
  const inv = await s.snapshot("workspace-a");
  await assert.rejects(s.assign(inv,"request-0001",BRAND,B), /workspace_conflict/);
  await assert.rejects(s.assign(inv,"request-0001",BRAND,A,"workspace-a","missing"), /account_not_observed/);
  await s.db.query("UPDATE managed_inventory SET observed_at=now()-interval '6 minutes' WHERE id=$1",[inv]);
  await assert.rejects(s.assign(inv), /inventory_stale/);
  const legacy = await s.snapshot("workspace-a","legacy-account");
  await assert.rejects(s.assign(legacy,"request-0001",BRAND,A,"workspace-a","legacy-account"), /legacy_destination/);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_accounts")).rows[0].n,0);
});

test("automatic provisioning creates exactly one baseline blueprint and blocked initial batch", async t => {
  const s = await setup(t); await s.register();
  await s.assign(await s.snapshot("workspace-a"));
  assert.equal(await s.rpc("managed_provision_pending",[5]),1);
  assert.equal(await s.rpc("managed_provision_pending",[5]),0);
  for (const table of ["managed_blueprints","managed_batches"]) {
    assert.equal((await s.db.query<any>(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,1);
  }
  const batch = (await s.db.query<any>("SELECT * FROM managed_batches")).rows[0];
  assert.equal(batch.target_count,6); assert.equal(batch.state,"blocked");
  assert.equal(batch.blocked_reason,"renderer_not_configured");
  const account = (await s.db.query<any>("SELECT * FROM managed_accounts")).rows[0];
  assert.equal(account.publishing_enabled,false); assert.equal(account.state,"blocked");
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM publer_slot_config")).rows[0].n,1);
});

test("missing rights or a now-ineligible owner blocks automatic provisioning without fallback content", async t => {
  const s = await setup(t); await s.register();
  await s.assign(await s.snapshot("workspace-a"),"request-0001",BRAND,A,"workspace-a","account-a",false);
  await s.rpc("managed_provision_pending",[5]);
  assert.equal((await s.db.query<any>("SELECT blocked_reason FROM managed_batches")).rows[0].blocked_reason,"rights_not_confirmed");
  await s.register(OP,B,"workspace-b");
  await s.assign(await s.snapshot("workspace-b","account-b"),"request-0002",BRAND,B,"workspace-b","account-b");
  await s.db.exec(`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id='${B}'`);
  await s.rpc("managed_provision_pending",[5]);
  assert.equal((await s.db.query<any>("SELECT blocked_reason FROM managed_accounts WHERE customer_user_id=$1",[B])).rows[0].blocked_reason,"customer_ineligible");
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_batches")).rows[0].n,1);
  await assert.rejects(s.db.exec(`DELETE FROM auth.users WHERE id='${A}'`),/foreign key/);
});

test("provisioning rollback retains pending work and successful retry cannot duplicate records", async t => {
  const s = await setup(t); await s.register();
  await s.assign(await s.snapshot("workspace-a"));
  await s.db.exec(`CREATE FUNCTION test_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_failure'; END $$;
    CREATE TRIGGER fail_batch BEFORE INSERT ON managed_batches FOR EACH ROW EXECUTE FUNCTION test_fail_batch();`);
  await assert.rejects(s.rpc("managed_provision_pending",[5]),/injected_failure/);
  assert.equal((await s.db.query<any>("SELECT state FROM managed_setup_jobs")).rows[0].state,"pending");
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_blueprints")).rows[0].n,0);
  await s.db.exec("DROP TRIGGER fail_batch ON managed_batches");
  await s.rpc("managed_provision_pending",[5]);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_batches")).rows[0].n,1);
});

test("managed tables and RPCs are inaccessible to browsers, service role cannot directly mutate", async t => {
  const s = await setup(t);
  for (const role of ["anon","authenticated"]) {
    await s.db.exec(`SET ROLE ${role}`);
    for (const table of tables) await assert.rejects(s.db.query(`SELECT * FROM ${table}`),/permission denied/);
    await assert.rejects(s.rpc("managed_provision_pending",[5]),/permission denied/);
    await assert.rejects(s.register(),/permission denied/);
    await s.db.exec("RESET ROLE");
  }
  await s.db.exec("SET ROLE service_role");
  await s.register();
  const inv = await s.snapshot("workspace-a");
  await s.assign(inv); await s.rpc("managed_provision_pending",[5]);
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_accounts")).rows[0].n,1);
  await assert.rejects(s.db.exec("UPDATE managed_accounts SET state='assigned'"),/permission denied/);
});

test("payload validation, key reuse and disabled workspaces fail closed inside SQL",async t=>{
  const s=await setup(t);await s.register();
  for(const accounts of [[{id:"a",platform:"instagram",handle:"a",token:"secret"}],
    [{id:"a",platform:"instagram",handle:"a"},{id:"a",platform:"instagram",handle:"b"}]]) {
    await assert.rejects(s.rpc("managed_record_inventory",[OP,"workspace-a",JSON.stringify(accounts)]),/invalid_inventory/);
  }
  const inv=await s.snapshot("workspace-a");
  for(const policy of [{...POLICY,timezone:"invalid"},{...POLICY,slot_times:["25:00"]},
    {...POLICY,slot_times:["10:00","10:00"]},{...POLICY,buffer_days:100}]) {
    await assert.rejects(s.rpc("managed_assign_account",[OP,A,"workspace-a",inv,"account-a","request-0001",
      JSON.stringify(policy),JSON.stringify(BRAND),true]),/invalid_policy/);
  }
  const account=await s.assign(inv);
  assert.equal(await s.assign(inv,"request-0002"),account);
  const another=await s.snapshot("workspace-a","account-b");
  await assert.rejects(s.assign(another,"request-0002",BRAND,A,"workspace-a","account-b"),/assignment_conflict/);
  await s.db.exec("UPDATE managed_workspaces SET enabled=false");
  await s.rpc("managed_provision_pending",[5]);
  assert.equal((await s.db.query<any>("SELECT blocked_reason FROM managed_accounts")).rows[0].blocked_reason,"workspace_disabled");
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_batches")).rows[0].n,0);
});

test("staged HTTP flow reaches real SQL assignment and automatic setup, with customer isolation",async t=>{
  const s=await setup(t);
  // Real database RPCs with a minimal Supabase transport adapter. Authentication
  // contexts and provider inventory are fixtures; no JWT or live-provider claim.
  const sb: any={
    async rpc(name: string,args: Record<string,any>) {
      try {
        const names=Object.keys(args);
        const values=Object.values(args).map(v=>v&&typeof v==="object"?JSON.stringify(v):v);
        const r=await s.db.query<any>(`SELECT public.${name}(${names.map((k,i)=>`${k} => $${i+1}`).join(",")}) AS value`,values);
        return {data:r.rows[0].value,error:null};
      } catch(error) {return {data:null,error};}
    },
    from(table: string) {
      assert.equal(table,"managed_accounts");
      let cols="",filters: [string,any][]=[];
      const q: any={
        select(c:string){cols=c;return q;},eq(k:string,v:any){filters.push([k,v]);return q;},
        order(){return q;},limit(){return q;},
        then(resolve:any) {
          return s.db.query(`SELECT ${cols} FROM managed_accounts ${filters.length?"WHERE "+filters.map(([k],i)=>`${k}=$${i+1}`).join(" AND "):""}`,
            filters.map(([,v])=>v)).then(r=>resolve({data:r.rows,error:null}));
        },
      };return q;
    },
  };
  const app=express();app.use(express.json());
  app.use((req:any,_res,next)=>{
    const uid=req.header("test-user");
    req.auth={user_id:uid};req.profile={user_id:uid,role:uid===OP?"admin":"user"};next();
  });
  app.use(accountAccess(()=>sb));
  registerManagedRoutes(app,()=>sb,{enabled:()=>true,
    providerList:async()=>[{id:"account-a",provider:"instagram",name:"Customer A",type:"instagram"}]});
  const server=createServer(app);
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=async(path:string,body:any)=>{
    const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","test-user":OP},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  await s.db.exec("SET ROLE service_role");
  const registered=await post("/api/admin/managed/workspaces",{customer_user_id:A,workspace_id:"workspace-a",consent_ref:"consent-123"});
  assert.equal(registered.status,201);
  const assignment={customer_user_id:A,workspace_id:"workspace-a",inventory_id:registered.body.inventory_id,
    publer_account_id:"account-a",idempotency_key:"request-0001",policy:POLICY,brand_inputs:BRAND,rights_confirmed:true};
  const first=await post("/api/admin/managed/assign",assignment);
  assert.equal(first.status,202);assert.equal(first.body.setup_dispatch,"attempted");
  assert.equal((await post("/api/admin/managed/assign",assignment)).body.account_id,first.body.account_id);
  for(const [uid,count] of [[A,1],[B,0]] as const){
    const r=await fetch(base+"/api/managed/accounts?customer_user_id="+A,{headers:{"test-user":uid}});
    assert.equal(r.status,200);
    const result=await r.json();assert.equal(result.accounts.length,count);
    if(count) {
      assert.equal(result.accounts[0].blocked_reason,"renderer_not_configured");
      assert.equal(result.accounts[0].publishing_enabled,false);
      assert.equal(result.accounts[0].brand_inputs,undefined);
    }
  }
  assert.equal((await s.db.query<any>("SELECT count(*)::int n FROM managed_batches")).rows[0].n,1);
});
