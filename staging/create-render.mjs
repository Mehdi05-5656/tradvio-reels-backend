// Credential transfer stays in memory; connector calls run without injected API credentials.
import {readFileSync} from "node:fs";
import {spawnSync,execFileSync} from "node:child_process";
const key=JSON.parse(readFileSync("/tmp/tradvio-staging-private/keys.json","utf8"));
if(key.project_ref!=="hjojeyewxtmunrwcjjzg")throw new Error("wrong_staging_project");
const revision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const env={
  STAGING_MODE:"managed-readonly-staging",STAGING_PROJECT_REF:key.project_ref,
  STAGING_BUILD_SHA:revision,STAGING_FRONTEND_ORIGIN:"https://tradvio-reels-staging.onrender.com",
  SUPABASE_URL:`https://${key.project_ref}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:key.service_key,
  MANAGED_PROVISIONING_ENABLED:"1",MANAGED_GENERATION_ENABLED:"0",MANAGED_HANDOFF_ENABLED:"0",
  INGESTION_WORKER_DISABLED:"1",NODE_VERSION:"22.16.0",
};
const args={
  name:"tradvio-reels-staging",runtime:"node",plan:"free",region:"oregon",autoDeploy:"no",
  branch:"staging/managed-readonly",repo:"https://github.com/Mehdi05-5656/tradvio-reels-backend",
  workspaceId:"tea-daenhlht0dsc73avs4d0",buildCommand:"npm ci && npm run build-staging",
  startCommand:"npm run start-staging",envVars:Object.entries(env).map(([key,value])=>({key,value})),
};
const p=spawnSync("pplx",["connector","call","render","create_web_service","--input",JSON.stringify(args)],
  {encoding:"utf8",timeout:120000,maxBuffer:1048576});
if(p.status!==0)throw new Error("staging_render_create_failed_check_inventory_before_retry");
// Redact a possible echoed environment response before displaying anything.
let output=p.stdout.replaceAll(key.service_key,"[REDACTED]");
console.log(output);
