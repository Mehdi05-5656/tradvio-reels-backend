import {mkdtemp,rm,readFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {validatePlan,planIdentity,sha256} from "./video-plan.js";
import {inspectSource,renderVideo,qualityCheck,sampleSourceFrames} from "./video-render.js";
import {PipelineError,validateReview} from "./video-models.js";
export interface GenerationDependencies {
  db:{rpc:(name:string,args?:any)=>any};
  enabled:()=>boolean;
  storage:{check:()=>Promise<any>;download:(job:any,path:string,signal:AbortSignal)=>Promise<any>;
    upload:(key:string,path:string,signal:AbortSignal)=>Promise<any>};
  models:{plan:(job:any,signal:AbortSignal)=>Promise<any>;
    review:(job:any,plan:any,frames:string[],signal:AbortSignal)=>Promise<any>};
  media?:{inspect:typeof inspectSource;render:typeof renderVideo;quality:typeof qualityCheck;sample?:typeof sampleSourceFrames};
}
export async function runGeneration(d:GenerationDependencies,worker:string) {
  if(!d.enabled())return "disabled";
  async function rpc(name:string,args:any={}) {
    const r=await d.db.rpc(name,args);if(r.error)throw r.error;return r.data;
  }
  await d.storage.check(); // A public or misconfigured bucket prevents any claim/model call.
  await rpc("managed_generation_enqueue");
  const job=await rpc("managed_generation_claim",{p_worker:worker});if(!job)return "idle";
  const controller=new AbortController(),signal=controller.signal;
  const deadline=setTimeout(()=>controller.abort(),480000);
  let renewing=false,leaseLost=false,dir:string|undefined;
  const args={p_job:job.id,p_token:job.lease_token};
  async function renew() {
    if(signal.aborted)throw new PipelineError("lease_lost");
    try {if(!await rpc("managed_generation_renew",args))throw new Error("lease_lost");}
    catch {leaseLost=true;controller.abort();throw new PipelineError("lease_lost");}
  }
  const heartbeat=setInterval(async()=>{
    if(renewing)return;renewing=true;
    try{await renew();}catch{/* Main path checks abort before next side effect. */}finally{renewing=false;}
  },30000);
  const media=d.media??{inspect:inspectSource,render:renderVideo,quality:qualityCheck,sample:sampleSourceFrames};
  try {
    await renew();
    dir=await mkdtemp(join(tmpdir(),"managed-render-"));
    const input=join(dir,"source.mp4");
    await d.storage.download(job,input,signal);
    if((await stat(input)).size!==job.asset.bytes || sha256(await readFile(input))!==job.asset.sha256)
      throw new PipelineError("source_invalid");
    const source=await media.inspect(input,signal);
    if(Math.abs(source.duration-job.asset.duration)>0.25)throw new PipelineError("source_invalid");
    await renew();
    const sourceFrames=!job.recipe&&media.sample?await media.sample(input,source.duration,signal):[];
    const plan=validatePlan(job.recipe??await d.models.plan({...job,source_frames:sourceFrames},signal),source.duration);
    const identity=planIdentity(plan);
    await rpc("managed_generation_reserve",{...args,p_recipe:plan,p_recipe_hash:identity.hash,p_tokens:identity.tokens});
    await renew();
    const output=await media.render(input,plan,dir,signal);
    const expected=plan.segments.reduce((n,s)=>n+s.duration,0);
    const qc=await media.quality(output,expected,dir,signal);
    if(qc.technical_pass!==true)throw new PipelineError("quality_failed");
    await renew();
    const review=validateReview(await d.models.review(job,plan,qc.frames,signal));
    if(!review.approved)throw new PipelineError("quality_failed");
    await renew();
    const key=`${job.customer_user_id}/${job.account_id}/${job.id}/${job.lease_token}/output.mp4`;
    const hash=sha256(await readFile(output));
    await d.storage.upload(key,output,signal);
    await renew();
    const {frames,fingerprints,...technical}=qc;
    await rpc("managed_generation_complete",{...args,p_result:{bucket:"managed-variants",object_key:key,sha256:hash,
      fingerprints,qc:{...technical,content_pass:true,review_method:"sampled_frames_and_approved_notes_v1"}}});
    return "quality_passed";
  }catch(error:any) {
    const message=String(error?.message??"");
    const known=["source_invalid","quality_failed","model_failed","recipe_collision","output_collision",
      "generation_ineligible","lease_lost"] as const;
    const code=leaseLost?"lease_lost":known.find(c=>message.includes(c))??
      (message.includes("invalid_plan")?"quality_failed":message.includes("media_process")?"render_failed":"infrastructure_error");
    const retry=job.attempts<3 && error instanceof PipelineError && error.retry && ["model_failed","infrastructure_error"].includes(code);
    try{await rpc("managed_generation_fail",{...args,p_reason:code,p_retry:retry});}
    catch{return "failure_unconfirmed";} // A lost response/lease cannot be described as a persisted failure.
    return retry?"retry_pending":"blocked";
  }finally {
    clearInterval(heartbeat);clearTimeout(deadline);controller.abort();
    if(dir)await rm(dir,{recursive:true,force:true});
  }
}
