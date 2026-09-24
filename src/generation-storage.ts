import {open,stat,readFile} from "node:fs/promises";
import {PipelineError} from "./video-models.js";
export function createGenerationStorage(sb:any,url:string,serviceKey:string,request:typeof fetch=fetch) {
  const origin=new URL(url).origin;
  if(!origin.startsWith("https://"))throw new Error("storage_configuration_required");
  return {
    async check() {
      for(const name of ["managed-raw","managed-variants"]) {
        const r=await sb.storage.getBucket(name);
        if(r.error || !r.data || r.data.public!==false)throw new Error("private_storage_required");
      }
    },
    async download(job:any,path:string,signal:AbortSignal) {
      const a=job.asset;
      if(a.bucket!=="managed-raw" || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*[.]mp4$/.test(a.object_key)
        || !Number.isInteger(a.bytes) || a.bytes<1 || a.bytes>134217728)throw new PipelineError("source_invalid");
      const r=await sb.storage.from("managed-raw").createSignedUrl(a.object_key,600);
      if(r.error || !r.data?.signedUrl)throw new PipelineError("infrastructure_error",true);
      const signed=new URL(r.data.signedUrl);
      if(signed.origin!==origin || signed.pathname!==`/storage/v1/object/sign/managed-raw/${a.object_key}`)
        throw new PipelineError("source_invalid");
      const res=await request(signed,{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
      if(!res.ok || !res.body)throw new PipelineError("infrastructure_error",res.status===429 || res.status>=500);
      if(Number(res.headers.get("content-length")??0)>a.bytes) {
        await res.body.cancel();throw new PipelineError("source_invalid");
      }
      const file=await open(path,"wx",0o600),reader=res.body.getReader();let bytes=0;
      try {
        while(true) {
          const r=await reader.read();if(r.done)break;signal.throwIfAborted();
          bytes+=r.value.length;if(bytes>a.bytes)throw new PipelineError("source_invalid");
          await file.writeFile(r.value);
        }
        if(bytes!==a.bytes)throw new PipelineError("source_invalid");
      }finally {await reader.cancel().catch(()=>{});reader.releaseLock();await file.close();}
    },
    async upload(key:string,path:string,signal:AbortSignal) {
      if(!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/output[.]mp4$/.test(key)
        || (await stat(path)).size>=67108864)throw new PipelineError("source_invalid");
      // No upsert: an attempt can never overwrite an earlier artifact.
      const res=await request(`${origin}/storage/v1/object/managed-variants/${key}`,{
        method:"POST",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),
        headers:{authorization:`Bearer ${serviceKey}`,apikey:serviceKey,"content-type":"video/mp4","x-upsert":"false"},
        body:await readFile(path),
      });
      if(!res.ok)throw new PipelineError("infrastructure_error",res.status===429 || res.status>=500);
      await res.body?.cancel();
    },
  };
}
