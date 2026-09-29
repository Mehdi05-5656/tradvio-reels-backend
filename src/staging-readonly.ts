import {resolveAuth} from "./auth.js";
import {supabase} from "./supabase.js";
import {stagingConfig,stagingFetch,stagingDatabaseSafety} from "./staging-safety.js";
import {stagingApp} from "./staging-app.js";
async function main() {
  const config=stagingConfig(process.env);
  globalThis.fetch=stagingFetch(config.supabase_origin,globalThis.fetch);
  const db=supabase();
  await stagingDatabaseSafety(db);
  const app=stagingApp({db,auth:resolveAuth,config,frontendDir:"staging-dashboard"});
  const port=Number(process.env.PORT??10000);
  app.listen(port,"0.0.0.0",()=>console.log(JSON.stringify({mode:"managed-readonly-staging",ready:true})));
}
main().catch(()=>{
  // No credentials, response bodies or customer data in startup logs.
  console.error(JSON.stringify({error:"staging_startup_safety_check_failed"}));process.exitCode=1;
});
