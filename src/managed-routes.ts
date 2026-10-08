import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";
import { listAccounts } from "./publer.js";
import { managedEnabled, provisionManagedAccounts } from "./managed-provisioning.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_COLS = "id,customer_user_id,platform,handle,state,blocked_reason,publishing_enabled,created_at";
const errors: Record<string, number> = {
  operator_required:403, customer_ineligible:409, workspace_conflict:409,
  legacy_workspace:409, legacy_destination:409, destination_conflict:409,
  assignment_conflict:409, inventory_stale:409, account_not_observed:409,
  invalid_setup_input:400, invalid_inventory:502, invalid_policy:400, invalid_blueprint:400,
  provider_unavailable:502,
};
function fail(res: Response, e: any) {
  const code = Object.keys(errors).find(code => String(e?.message ?? "").includes(code));
  return res.status(code ? errors[code] : 503).json({ error: code ?? "managed_setup_unavailable" });
}
function object(v: any): v is Record<string, any> {
  return !!v && typeof v==="object" && !Array.isArray(v);
}
function exact(v: any, keys: string[]) {
  return object(v) && Object.keys(v).length===keys.length && keys.every(k => Object.hasOwn(v,k));
}
function text(v: any, max=500) {
  return typeof v==="string" && v.trim().length>0 && v.length<=max;
}
function id(v: any) { return typeof v==="string" && PROVIDER_ID.test(v); }
function uuid(v: any) { return typeof v==="string" && UUID.test(v); }
function validPolicy(v: any) {
  if (!exact(v,["timezone","slot_times","buffer_days"]) || !text(v.timezone,100) ||
    !Number.isInteger(v.buffer_days) || v.buffer_days<1 || v.buffer_days>3 ||
    !Array.isArray(v.slot_times) || v.slot_times.length<1 || v.slot_times.length>8 ||
    new Set(v.slot_times).size!==v.slot_times.length ||
    !v.slot_times.every((t: any) => typeof t==="string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return false;
  try { new Intl.DateTimeFormat("en",{timeZone:v.timezone}); return true; } catch { return false; }
}
function validBrand(v: any) {
  return exact(v,["audience","voice","language","cta"]) && Object.values(v).every(x => text(x));
}
export function normalizeManagedInventory(rows: unknown) {
  if (!Array.isArray(rows) || rows.length>500) throw new Error("invalid_inventory");
  const result: {id:string;platform:string;handle:string}[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!object(row) || !id(row.id)) throw new Error("invalid_inventory");
    const platform = row.provider || row.type;
    if (typeof platform!=="string") throw new Error("invalid_inventory");
    if (!["instagram","tiktok"].includes(platform)) continue;
    const handle = row.username || row.name;
    if (!text(handle,128) || seen.has(row.id)) throw new Error("invalid_inventory");
    seen.add(row.id);
    result.push({id:row.id,platform,handle});
  }
  return result;
}

export function registerManagedRoutes(app: Express, sbFn: () => SupabaseClient,
  options: { enabled?: () => boolean; providerList?: typeof listAccounts } = {}) {
  const enabled = options.enabled ?? managedEnabled;
  const providerList = options.providerList ?? listAccounts;
  function guard(req: Request,res: Response, operator = true) {
    res.setHeader("Cache-Control","private, no-store");
    if (!req.auth) { res.status(401).json({error:"unauthorized"}); return false; }
    if (operator && !isOperator(req)) { res.status(403).json({error:"operator_required"}); return false; }
    if (!operator && !isAdmin(req) && (!req.profile || !("user_id" in req.auth) || req.profile.user_id!==req.auth.user_id)) {
      res.status(403).json({error:"profile_required"}); return false;
    }
    if (!enabled()) { res.status(503).json({error:"managed_setup_disabled"}); return false; }
    return true;
  }
  async function observed(workspace: string) {
    let rows: unknown;
    try { rows = await providerList(workspace); }
    catch { throw new Error("provider_unavailable"); }
    return normalizeManagedInventory(rows);
  }
  async function rpc(sb: SupabaseClient, name: string, args: Record<string,any>) {
    const r = await sb.rpc(name,args); if(r.error) throw r.error; return r.data;
  }
  function page(req: Request) {
    if(req.query.after!==undefined && !uuid(req.query.after)) throw new Error("invalid_setup_input");
    return typeof req.query.after==="string" ? req.query.after : null;
  }
  app.get("/api/admin/managed/customers",async(req,res)=>{
    if(!guard(req,res)) return;
    try {
      const after=page(req);
      let q=sbFn().from("profiles").select("user_id,display_name,email").eq("role","user").order("user_id").limit(50);
      if(after) q=q.gt("user_id",after);
      const r=await q; if(r.error) throw r.error;
      const rows=r.data??[];
      // Operator ownership is a narrow SQL eligibility exception, not general
      // admin eligibility. Include self once without changing customer cursors.
      const own = !after ? await sbFn().from("profiles").select("user_id,display_name,email")
        .eq("user_id",(req.auth as {user_id:string}).user_id).eq("role","admin") : {data:[],error:null};
      if(own.error) throw own.error;
      res.json({customers:[...(own.data??[]),...rows],next_cursor:rows.length===50?rows[49].user_id:null});
    } catch(e) { fail(res,e); }
  });
  app.post("/api/admin/managed/workspaces",async(req,res)=>{
    if(!guard(req,res)) return;
    const b=req.body;
    if(!exact(b,["customer_user_id","workspace_id","consent_ref"]) || !uuid(b.customer_user_id) ||
      !id(b.workspace_id) || !text(b.consent_ref)) return res.status(400).json({error:"invalid_setup_input"});
    try {
      const accounts=await observed(b.workspace_id); const sb=sbFn();
      await rpc(sb,"managed_register_workspace",{p_actor:(req.auth as any).user_id,p_customer:b.customer_user_id,
        p_workspace:b.workspace_id,p_consent_ref:b.consent_ref});
      const inventory=await rpc(sb,"managed_record_inventory",{p_actor:(req.auth as any).user_id,p_workspace:b.workspace_id,p_accounts:accounts});
      res.status(201).json({workspace_id:b.workspace_id,inventory_id:inventory,accounts,connection_evidence:"listed_only"});
    } catch(e) { fail(res,e); }
  });
  app.post("/api/admin/managed/discover",async(req,res)=>{
    if(!guard(req,res)) return;
    const b=req.body;
    if(!exact(b,["workspace_id"]) || !id(b.workspace_id)) return res.status(400).json({error:"invalid_setup_input"});
    try {
      const sb=sbFn();
      const w=await sb.from("managed_workspaces").select("workspace_id").eq("workspace_id",b.workspace_id).eq("enabled",true);
      if(w.error) throw w.error;
      if(!w.data?.length) throw new Error("workspace_conflict");
      const accounts=await observed(b.workspace_id);
      const inventory=await rpc(sb,"managed_record_inventory",{p_actor:(req.auth as any).user_id,p_workspace:b.workspace_id,p_accounts:accounts});
      res.json({workspace_id:b.workspace_id,inventory_id:inventory,accounts,connection_evidence:"listed_only"});
    } catch(e) { fail(res,e); }
  });
  app.post("/api/admin/managed/assign",async(req,res)=>{
    if(!guard(req,res)) return;
    const b=req.body;
    if(!exact(b,["customer_user_id","workspace_id","inventory_id","publer_account_id","idempotency_key","policy","brand_inputs","rights_confirmed"]) ||
      !uuid(b.customer_user_id) || !uuid(b.inventory_id) || !id(b.workspace_id) || !id(b.publer_account_id) ||
      !text(b.idempotency_key,128) || b.idempotency_key.length<8 || !validPolicy(b.policy) ||
      !validBrand(b.brand_inputs) || typeof b.rights_confirmed!=="boolean") return res.status(400).json({error:"invalid_setup_input"});
    try {
      const sb=sbFn();
      const account=await rpc(sb,"managed_assign_account",{p_actor:(req.auth as any).user_id,p_customer:b.customer_user_id,
        p_workspace:b.workspace_id,p_inventory:b.inventory_id,p_account:b.publer_account_id,p_key:b.idempotency_key,
        p_policy:b.policy,p_brand:b.brand_inputs,p_rights:b.rights_confirmed});
      // Assignment already committed. A sweep failure must not turn a durable
      // accepted assignment into an ambiguous 500 or invite duplicate requests.
      let dispatch="attempted";
      try { await provisionManagedAccounts(sb,true); } catch { dispatch="pending_recovery"; }
      res.status(202).json({account_id:account,setup_dispatch:dispatch,publishing_enabled:false,
        status_url:"/api/managed/accounts"});
    } catch(e) { fail(res,e); }
  });
  app.get("/api/managed/accounts",async(req,res)=>{
    if(!guard(req,res,false)) return;
    try {
      const after=page(req);
      let q=sbFn().from("managed_accounts").select(ACCOUNT_COLS).order("id").limit(50);
      if(!isAdmin(req)) q=q.eq("customer_user_id",(req.auth as {user_id:string}).user_id);
      if(after) q=q.gt("id",after);
      const r=await q; if(r.error) throw r.error;
      const rows=r.data??[];
      res.json({accounts:rows,next_cursor:rows.length===50?rows[49].id:null});
    } catch(e) { fail(res,e); }
  });
}
