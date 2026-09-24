import type {Express,Request,Response} from "express";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isAdmin,isOperator} from "./auth.js";
import {managedEnabled} from "./managed-provisioning.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact=(v:any,keys:string[])=>v && typeof v==="object" && !Array.isArray(v)
  && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export function registerGenerationRoutes(app:Express,sbFn:()=>SupabaseClient,enabled=managedEnabled) {
  function guard(req:Request,res:Response,operator=true) {
    res.setHeader("Cache-Control","private, no-store");
    if(!req.auth){res.status(401).json({error:"unauthorized"});return false;}
    if(operator&&!isOperator(req)){res.status(403).json({error:"operator_required"});return false;}
    if(!operator&&!isAdmin(req)&&(!("user_id" in req.auth)||req.profile?.user_id!==req.auth.user_id)) {
      res.status(403).json({error:"profile_required"});return false;
    }
    if(!enabled()){res.status(503).json({error:"managed_setup_disabled"});return false;}return true;
  }
  async function call(res:Response,name:string,args:any) {
    try {
      const r=await sbFn().rpc(name,args);if(r.error)throw r.error;
      res.json({ok:true,id:r.data??undefined});
    }catch(e:any) {
      const known=["invalid_source","invalid_grant","source_conflict","operator_required"].find(x=>String(e?.message).includes(x));
      res.status(known==="operator_required"?403:known?400:503).json({error:known??"generation_unavailable"});
    }
  }
  app.post("/api/admin/managed/assets",async(req,res)=>{
    if(!guard(req,res))return;
    // Strict source validation in SQL; no URL fetch or upload is triggered here.
    await call(res,"managed_register_asset",{p_actor:(req.auth as any).user_id,p_source:req.body});
  });
  app.post("/api/admin/managed/grants",async(req,res)=>{
    if(!guard(req,res))return;const b=req.body;
    if(!exact(b,["account_id","asset_id","consent_ref","expires_at","enabled"])
      || !UUID.test(b.account_id) || !UUID.test(b.asset_id) || typeof b.consent_ref!=="string"
      || b.consent_ref.trim().length<1 || b.consent_ref.length>500 || typeof b.expires_at!=="string"
      || !Number.isFinite(Date.parse(b.expires_at)) || typeof b.enabled!=="boolean")
      return res.status(400).json({error:"invalid_grant"});
    await call(res,"managed_grant_asset",{p_actor:(req.auth as any).user_id,p_account:b.account_id,
      p_asset:b.asset_id,p_consent:b.consent_ref,p_expires:b.expires_at,p_enabled:b.enabled});
  });
  app.post("/api/admin/managed/generation-control",async(req,res)=>{
    if(!guard(req,res))return;const b=req.body;
    if(!exact(b,["enabled","max_active","max_daily_claims"]) || typeof b.enabled!=="boolean"
      || !Number.isInteger(b.max_active) || b.max_active<1 || b.max_active>4
      || !Number.isInteger(b.max_daily_claims) || b.max_daily_claims<1 || b.max_daily_claims>100)
      return res.status(400).json({error:"invalid_control"});
    await call(res,"managed_generation_configure",{p_actor:(req.auth as any).user_id,p_enabled:b.enabled,
      p_max_active:b.max_active,p_daily:b.max_daily_claims});
  });
  app.get("/api/managed/generation/:accountId",async(req,res)=>{
    if(!guard(req,res,false))return;
    if(!UUID.test(req.params.accountId))return res.status(400).json({error:"invalid_account"});
    try {
      const sb=sbFn();
      let q=sb.from("managed_accounts").select("id,publishing_enabled").eq("id",req.params.accountId);
      if(!isAdmin(req))q=q.eq("customer_user_id",(req.auth as {user_id:string}).user_id);
      const a=await q.maybeSingle();if(a.error)throw a.error;
      if(!a.data)return res.status(404).json({error:"account_not_found"});
      // Current contract: exactly one initial batch <=24; no raw inputs/artifacts.
      const j=await sb.from("managed_generation_jobs").select("id,ordinal,state,error_code")
        .eq("account_id",a.data.id).order("ordinal").limit(24);
      if(j.error)throw j.error;
      res.json({account_id:a.data.id,jobs:j.data??[],publishing_enabled:Boolean(a.data.publishing_enabled),
        ready_meaning:"quality_passed_is_not_scheduling_proof",
        scheduling_status_url:`/api/managed/handoffs/${a.data.id}`});
    }catch {res.status(503).json({error:"generation_unavailable"});}
  });
}
