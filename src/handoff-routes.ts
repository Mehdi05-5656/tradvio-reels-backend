import type {Express,Request,Response} from "express";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isAdmin,isOperator} from "./auth.js";
import {managedEnabled} from "./managed-provisioning.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact=(v:any,keys:string[])=>v&&typeof v==="object"&&!Array.isArray(v)
  &&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function registerHandoffRoutes(app:Express,sbFn:()=>SupabaseClient,enabled=managedEnabled) {
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
      res.json({ok:true,...(r.data??{}),external_schedules_cancelled:false,
        notice:"Local controls prevent new work; review and cancel existing remote schedules in Publer."});
    }catch(e:any) {
      const code=["operator_required","invalid_activation","activation_ineligible","invalid_control","invalid_publication_settings"]
        .find(x=>String(e?.message).includes(x));
      res.status(code==="operator_required"?403:code?400:503).json({error:code??"handoff_unavailable"});
    }
  }
  app.post("/api/admin/managed/handoff-control",async(req,res)=>{
    if(!guard(req,res))return;const b=req.body;
    if(!exact(b,["enabled","daily_claims"])||typeof b.enabled!=="boolean"
      ||!Number.isInteger(b.daily_claims)||b.daily_claims<1||b.daily_claims>500)
      return res.status(400).json({error:"invalid_control"});
    await call(res,"managed_handoff_configure",{p_actor:(req.auth as any).user_id,p_enabled:b.enabled,p_daily:b.daily_claims});
  });
  app.post("/api/admin/managed/handoff-activation",async(req,res)=>{
    if(!guard(req,res))return;const b=req.body;
    if(!exact(b,["account_id","enabled","approval_ref","expires_at","publication_settings"])||!UUID.test(b.account_id)
      ||typeof b.enabled!=="boolean"||typeof b.approval_ref!=="string"||b.approval_ref.trim().length<1
      ||b.approval_ref.length>500||typeof b.expires_at!=="string"||!Number.isFinite(Date.parse(b.expires_at)))
      return res.status(400).json({error:"invalid_activation"});
    await call(res,"managed_handoff_activate",{p_actor:(req.auth as any).user_id,p_account:b.account_id,
      p_enabled:b.enabled,p_approval:b.approval_ref,p_expires:b.expires_at,p_settings:b.publication_settings});
  });
  app.get("/api/managed/handoffs/:accountId",async(req,res)=>{
    if(!guard(req,res,false))return;
    if(!UUID.test(req.params.accountId))return res.status(400).json({error:"invalid_account"});
    try {
      const sb=sbFn();
      let q=sb.from("managed_accounts").select("id,publishing_enabled").eq("id",req.params.accountId);
      if(!isAdmin(req))q=q.eq("customer_user_id",(req.auth as {user_id:string}).user_id);
      const a=await q.maybeSingle();if(a.error)throw a.error;
      if(!a.data)return res.status(404).json({error:"account_not_found"});
      const jobs=await sb.from("managed_handoffs")
        .select("id,generation_id,state,scheduled_at,timezone,local_date,local_time,post_link,error_code,remote_review_required,updated_at")
        .eq("account_id",a.data.id).order("scheduled_at").limit(24);
      if(jobs.error)throw jobs.error;
      res.json({account_id:a.data.id,publishing_enabled:Boolean(a.data.publishing_enabled),
        activation_meaning:"account_permission_only_not_worker_health",
        published_meaning:"provider_reported_not_independently_verified",
        handoffs:jobs.data??[]});
    }catch {res.status(503).json({error:"handoff_unavailable"});}
  });
}
