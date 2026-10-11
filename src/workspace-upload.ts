import {uploadFromUrl,waitForJob,jobStatus} from "./publer.js";

// One shared DB coordinator for all Node instances. Unknown writes are held;
// known provider jobs can be reconciled read-only before the next upload.
export async function coordinatedUpload(sb:any,workspace:string,url:string,name:string){
  async function rpc(fn:string,args:any){
    const r=await sb.rpc(fn,{p_workspace:workspace,...args});
    if(r.error)throw new Error("upload_coordinator_database_error");
    return r.data;
  }
  let claim=await rpc("publer_upload_acquire",{});
  if(claim?.mode==="reconcile"){
    const remote=await jobStatus(claim.job_id,workspace);
    const state=String(remote.status).toLowerCase();
    if(!["complete","completed","failed"].includes(state))throw new Error("upload_coordinator_busy");
    await rpc("publer_upload_finish",{p_job:claim.job_id,p_terminal:state});
    claim=await rpc("publer_upload_acquire",{});
  }
  if(claim?.mode!=="acquired")throw new Error(claim?.mode==="held"?"upload_coordination_held":"upload_coordinator_busy");
  const token=claim.token;
  await rpc("publer_upload_begin",{p_token:token});
  let job:string|undefined;
  try{
    const r=await uploadFromUrl(workspace,url,name);job=r.jobId;
    if(typeof job!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(job))
      throw new Error("upload_response_unconfirmed");
  }catch(e:any){
    if([400,401,403,422,429].includes(e?.status)){
      await rpc("publer_upload_rejected",{p_token:token});
    }else await rpc("publer_upload_hold",{p_token:token});
    throw e;
  }
  await rpc("publer_upload_record_job",{p_token:token,p_job:job});
  try{
    const payload=await waitForJob(job,{timeoutMs:180000,workspaceId:workspace});
    if(await rpc("publer_upload_finish",{p_job:job,p_terminal:"complete"})!==true)
      throw new Error("upload_completion_unconfirmed");
    return payload;
  }catch(e){
    // No re-upload. Leave the exact job ID in the coordinator for a later
    // read-only terminal-state check. This lease never expires into a new write.
    throw e;
  }
}
