import {mediaReceipt,postReceipt,verifyPost,type ManagedPubler} from "./managed-publer.js";
type Deps={enabled:()=>boolean,db:any,provider:ManagedPubler,
  storage:(job:any,signal:AbortSignal)=>Promise<string>,now?:()=>number};
// One durable stage per invocation. No provider mutation is ever automatically retried.
export async function runHandoff(d:Deps,worker:string):Promise<string> {
  if(!d.enabled())return "disabled";
  const rpc=async(name:string,args:any={})=>{
    const r=await d.db.rpc(name,args);
    if(r.error)throw new Error(String(r.error.message).includes("handoff_ineligible")?"handoff_ineligible":"database_unavailable");
    return r.data;
  };
  await rpc("managed_handoff_enqueue");
  const j=await rpc("managed_handoff_claim",{p_worker:worker});if(!j)return "idle";
  const signal=AbortSignal.timeout(120000);
  const transition=(event:string,data:any={})=>rpc("managed_handoff_transition",
    {p_id:j.id,p_token:j.lease_token,p_event:event,p_data:data});
  let uncertainty:string|undefined;
  try {
    if(j.state==="reserved" || j.state==="media_ready") {
      await d.provider.destination(j,signal);
      await d.provider.calendar(j,signal);
      if(j.state==="reserved") {
        const signed=await d.storage(j,signal);
        signal.throwIfAborted();
        await transition("upload_intent");
        // From this point even a lost database receipt is an unknown remote outcome.
        uncertainty="upload_outcome_unknown";
        const jobId=await d.provider.upload(j,signed,signal);
        await transition("upload_receipt",{job_id:jobId});return "upload_wait";
      }
      signal.throwIfAborted();await transition("submit_intent");
      uncertainty="submit_outcome_unknown";
      const jobId=await d.provider.schedule(j,signal);
      await transition("submit_receipt",{job_id:jobId});return "submit_wait";
    }
    if(j.state==="upload_wait" || j.state==="submit_wait") {
      const r=await d.provider.job(j.workspace_id,j.state==="upload_wait"?j.upload_job_id:j.submit_job_id,signal);
      if(["working","pending"].includes(r.status)){await transition("pending");return "pending";}
      if(r.status==="failed")throw new Error("provider_rejected");
      if(!["complete","completed"].includes(r.status))throw new Error("receipt_unverified");
      if(j.state==="upload_wait") {await transition("media_ready",mediaReceipt(r.payload));return "media_ready";}
      await transition("post_receipt",{post_id:postReceipt(r.payload,j)});return "confirming";
    }
    if(j.state==="confirming"||j.state==="scheduled") {
      const proof=verifyPost(await d.provider.post(j,signal),j,(d.now??Date.now)());
      await transition("confirmed",proof);return proof.state;
    }
    throw new Error("unexpected_failure");
  }catch(e:any) {
    if(!uncertainty && e?.message==="provider_unavailable"
      && ["upload_wait","submit_wait","confirming","scheduled"].includes(j.state)) {
      try {await transition("pending");return "pending";}catch {return "persistence_unconfirmed";}
    }
    const known=["provider_unavailable","provider_rejected","receipt_unverified","destination_unverified",
      "calendar_conflict","calendar_unverified","storage_unavailable","handoff_ineligible"];
    const reason=uncertainty??(known.includes(e?.message)?e.message:"unexpected_failure");
    try {await transition("hold",{reason});return "held";}
    catch {return "persistence_unconfirmed";} // Expired sending lease is held by DB recovery; never resend.
  }
}
