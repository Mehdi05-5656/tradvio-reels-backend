import {createClient} from "@supabase/supabase-js";
import {randomUUID} from "node:crypto";
import {runHandoff} from "./managed-handoff.js";
import {createManagedPubler} from "./managed-publer.js";
import {createHandoffStorage} from "./handoff-storage.js";
async function main() {
  if(process.env.MANAGED_HANDOFF_ENABLED!=="1") {
    console.log(JSON.stringify({status:"disabled"}));return;
  }
  if(["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","PUBLER_API_KEY"].some(k=>!process.env[k]))
    throw new Error("handoff_configuration_required");
  const url=process.env.SUPABASE_URL!;
  const sb=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([
      AbortSignal.timeout(20000),...(init?.signal?[init.signal]:[])])})},
  });
  const status=await runHandoff({enabled:()=>true,db:sb,
    provider:createManagedPubler(process.env.PUBLER_API_KEY!),
    storage:createHandoffStorage(sb,url)},`handoff-${randomUUID()}`);
  console.log(JSON.stringify({status}));
  if(status==="persistence_unconfirmed")process.exitCode=1;
}
main().catch(()=>{console.error(JSON.stringify({error:"handoff_worker_failed"}));process.exitCode=1;});
