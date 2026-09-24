import {createHash} from "node:crypto";
// Signed URLs stay in process memory, never in outbox rows, API responses or logs.
export function createHandoffStorage(sb:any,base:string,request:typeof fetch=fetch) {
  const origin=new URL(base).origin;
  if(!origin.startsWith("https://"))throw new Error("storage_configuration_required");
  return async(j:any,signal:AbortSignal):Promise<string>=>{
    try {
      const a=j.artifact;
      if(a?.bucket!=="managed-variants"||!/^[a-f0-9]{64}$/.test(a.sha256)
        ||!new RegExp(`^${j.customer_user_id}/${j.account_id}/${j.generation_id}/[a-f0-9-]{36}/output[.]mp4$`).test(a.object_key))
        throw new Error();
      const bucket=await sb.storage.getBucket(a.bucket);
      if(bucket.error||bucket.data?.public!==false)throw new Error();
      const signed=await sb.storage.from(a.bucket).createSignedUrl(a.object_key,600);
      if(signed.error||!signed.data?.signedUrl)throw new Error();
      const url=new URL(signed.data.signedUrl);
      if(url.origin!==origin||url.username||url.password
        ||url.pathname!==`/storage/v1/object/sign/managed-variants/${a.object_key}`)throw new Error();
      const r=await request(url,{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
      if(!r.ok||!r.body||Number(r.headers.get("content-length")??0)>=67108864) {
        await r.body?.cancel();throw new Error();
      }
      const hash=createHash("sha256"),reader=r.body.getReader();let bytes=0;
      try {while(true) {const v=await reader.read();if(v.done)break;signal.throwIfAborted();
        bytes+=v.value.length;if(bytes>=67108864)throw new Error();hash.update(v.value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(bytes===0||hash.digest("hex")!==a.sha256)throw new Error();
      return url.toString();
    }catch {throw new Error("storage_unavailable");}
  };
}
