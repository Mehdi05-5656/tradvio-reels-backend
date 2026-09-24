// Separate worker executable. No renderer is started by the HTTP process.
import {createClient} from "@supabase/supabase-js";
import {randomUUID} from "node:crypto";
import {runGeneration} from "./managed-generation.js";
import {createModels} from "./video-models.js";
import {createGenerationStorage} from "./generation-storage.js";
async function main() {
  if(process.env.MANAGED_GENERATION_ENABLED!=="1") {
    console.log(JSON.stringify({status:"disabled"}));return;
  }
  const required=["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","ANTHROPIC_API_KEY",
    "MANAGED_PLANNER_MODEL","MANAGED_REVIEW_MODEL"];
  if(required.some(k=>!process.env[k]))throw new Error("generation_configuration_required");
  const url=process.env.SUPABASE_URL!,key=process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([
      ...(init?.signal?[init.signal]:[]),AbortSignal.timeout(20000)])})}});
  const status=await runGeneration({db:sb,enabled:()=>true,storage:createGenerationStorage(sb,url,key),
    models:createModels({key:process.env.ANTHROPIC_API_KEY!,plannerModel:process.env.MANAGED_PLANNER_MODEL!,
      reviewModel:process.env.MANAGED_REVIEW_MODEL!})},`generation-${randomUUID()}`);
  console.log(JSON.stringify({status})); // No customer IDs, prompts, tokens or provider bodies.
}
main().catch(()=>{console.error(JSON.stringify({error:"generation_worker_failed"}));process.exitCode=1;});
