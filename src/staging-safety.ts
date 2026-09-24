// Staging-only safeguards. Never imported by the production entry point.
const PRODUCTION_REF="gzvxqzguthrpvjtflxcx";
export const STAGING_MODE="managed-readonly-staging";
export function stagingConfig(env:NodeJS.ProcessEnv) {
  const ref=env.STAGING_PROJECT_REF??"";
  if(env.STAGING_MODE!==STAGING_MODE||!/^[a-z]{20}$/.test(ref)||ref===PRODUCTION_REF)
    throw new Error("isolated_staging_project_required");
  const origin=`https://${ref}.supabase.co`;
  if(env.SUPABASE_URL!==origin||!env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("staging_database_configuration_required");
  if(env.MANAGED_PROVISIONING_ENABLED!=="1"||env.MANAGED_GENERATION_ENABLED!=="0"
    ||env.MANAGED_HANDOFF_ENABLED!=="0"||env.INGESTION_WORKER_DISABLED!=="1")
    throw new Error("staging_workers_must_be_disabled");
  for(const [key,value] of Object.entries(env)) {
    if(value&&(/^(PUBLER|CREATORVAULT|CREATOR_VAULT|ANTHROPIC|OPENAI|SCRAPECREATORS|GEMINI)_/.test(key)
      ||key==="APP_WRITE_SECRET"))throw new Error("staging_provider_credentials_forbidden");
  }
  const frontend=new URL(env.STAGING_FRONTEND_ORIGIN??"");
  if(frontend.protocol!=="https:"||frontend.origin!==env.STAGING_FRONTEND_ORIGIN
    ||!/staging/.test(frontend.hostname))throw new Error("staging_frontend_origin_required");
  if(!/^[a-f0-9]{40}$/.test(env.STAGING_BUILD_SHA??""))throw new Error("staging_revision_required");
  return {project_ref:ref,supabase_origin:origin,frontend_origin:frontend.origin,build_sha:env.STAGING_BUILD_SHA!};
}
export function stagingFetch(origin:string,transport:typeof fetch):typeof fetch {
  return async(input,init)=>{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
    const method=(init?.method??(input instanceof Request?input.method:"GET")).toUpperCase();
    if(url.origin!==origin||url.username||url.password||!["GET","HEAD"].includes(method)
      ||!/^\/(?:auth\/v1\/\.well-known\/jwks\.json|rest\/v1\/(?:profiles|publer_slot_config|managed_[a-z_]+))$/.test(url.pathname))
      throw new Error("staging_outbound_request_blocked");
    return transport(input,{...init,redirect:"error",signal:AbortSignal.any([
      AbortSignal.timeout(15_000),...(init?.signal?[init.signal]:[]),
    ])});
  };
}
export async function stagingDatabaseSafety(db:any) {
  const snapshot:Record<string,number|boolean>={};
  for(const table of ["managed_handoff_control","managed_generation_control"]) {
    const r=await db.from(table).select("singleton,enabled");
    if(r.error||!Array.isArray(r.data)||r.data.length!==1||r.data[0].singleton!==true||r.data[0].enabled!==false)
      throw new Error("staging_database_gate_not_off");
    snapshot[table]=false;
  }
  const checks=[
    ["enabled_accounts","managed_accounts",(q:any)=>q.eq("publishing_enabled",true)],
    ["enabled_approvals","managed_handoff_approvals",(q:any)=>q.eq("enabled",true)],
    ["unpaused_legacy_slots","publer_slot_config",(q:any)=>q.eq("paused",false)],
    ["remote_receipts","managed_handoffs",(q:any)=>q.or("upload_job_id.not.is.null,submit_job_id.not.is.null,post_id.not.is.null,post_link.not.is.null")],
    ["active_handoff_leases","managed_handoffs",(q:any)=>q.not("lease_until","is",null)],
    ["active_generation_leases","managed_generation_jobs",(q:any)=>q.not("lease_until","is",null)],
  ] as const;
  for(const [name,table,filter] of checks) {
    const r=await filter(db.from(table).select("*",{head:true,count:"exact"}));
    if(r.error||r.count!==0)throw new Error("staging_database_not_inert");
    snapshot[name]=r.count;
  }
  return snapshot;
}
