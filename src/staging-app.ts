import express from "express";
import type {RequestHandler} from "express";
import {isOperator} from "./auth.js";
import {accountCapabilities} from "./account-capabilities.js";
import {accountAccess} from "./account-access.js";
import {registerManagedRoutes} from "./managed-routes.js";
import {registerGenerationRoutes} from "./generation-routes.js";
import {registerHandoffRoutes} from "./handoff-routes.js";
import {STAGING_MODE,stagingDatabaseSafety} from "./staging-safety.js";

// Deliberately not the production server: no legacy routes, webhooks or workers.
export function stagingApp(deps:{db:any,auth:RequestHandler,config:{
  project_ref:string;frontend_origin:string;build_sha:string;
}}) {
  const app=express();app.disable("x-powered-by");
  app.use((req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("X-Staging-Mode",STAGING_MODE);
    if(req.header("origin")===deps.config.frontend_origin) {
      res.setHeader("Access-Control-Allow-Origin",deps.config.frontend_origin);
      res.setHeader("Vary","Origin");
      res.setHeader("Access-Control-Allow-Headers","authorization,content-type");
      res.setHeader("Access-Control-Allow-Methods","GET,HEAD,OPTIONS");
    }
    if(req.method==="OPTIONS")return res.status(204).end();
    if(!["GET","HEAD"].includes(req.method)) {
      res.setHeader("Allow","GET,HEAD,OPTIONS");
      return res.status(405).json({error:"staging_read_only"});
    }
    if(req.header("x-app-secret"))return res.status(401).json({error:"real_user_session_required"});
    next();
  });
  app.get("/healthz",(_req,res)=>res.json({mode:STAGING_MODE}));
  app.use(deps.auth);
  app.get("/api/staging/safety",async(req,res)=>{
    if(!isOperator(req))return res.status(req.auth?403:401).json({error:"operator_required"});
    try {
      const database=await stagingDatabaseSafety(deps.db);
      res.json({mode:STAGING_MODE,project_ref:deps.config.project_ref,build_sha:deps.config.build_sha,
        mutations_blocked:true,workers_started:false,provider_credentials_present:false,database});
    }catch {res.status(503).json({error:"staging_safety_unverified"});}
  });
  app.use(accountAccess(()=>deps.db));
  app.get("/api/me",(req,res)=>{
    if(!req.auth||!("user_id" in req.auth))return res.status(401).json({error:"unauthorized"});
    if(!req.profile||req.profile.user_id!==req.auth.user_id)return res.status(404).json({error:"profile not provisioned"});
    res.json({mode:"user",...req.profile,capabilities:accountCapabilities(req)});
  });
  registerManagedRoutes(app,()=>deps.db,{enabled:()=>true,
    providerList:async()=>{throw new Error("staging_provider_access_forbidden");}});
  registerGenerationRoutes(app,()=>deps.db,()=>true);
  registerHandoffRoutes(app,()=>deps.db,()=>true);
  app.use((_req,res)=>res.status(404).json({error:"staging_route_not_found"}));
  return app;
}
