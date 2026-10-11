// Run inside Code Mode with its already-described Supabase connector.
// Original bytes go directly to one-object signed upload URLs. No long-lived
// storage key or plaintext capability is read, saved, returned or logged.
import fs from "node:fs/promises";
import crypto from "node:crypto";
const PROJECT="gzvxqzguthrpvjtflxcx";
const ACTOR="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const APP="https://tradvio-reels-backend.onrender.com";
const ORIGIN=`https://${PROJECT}.supabase.co`;
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
function rows(response){
  const raw=response?.result?.result;
  if(typeof raw!=="string")throw new Error("sql_response_unconfirmed");
  const start=raw.indexOf("\n[");
  const end=raw.indexOf("</untrusted-data-",start);
  if(start<0||end<0)throw new Error("sql_response_unconfirmed");
  const r=JSON.parse(raw.slice(start,end).trim());
  if(!Array.isArray(r))throw new Error("sql_response_unconfirmed");
  return r;
}
export async function importLibrary(tools,emit,root="/home/user/workspace/tradvio-publisher-repair"){
  const sql=async query=>rows(await tools.call_external_tool({source_id:"supabase",tool_name:"execute_sql",
    arguments:{project_id:PROJECT,query}}));
  const audit=JSON.parse(await fs.readFile(`${root}/rehearsal/pool-audit.json`,"utf8"));
  const sources=audit.sources.filter(s=>s.eligible_for_rehearsal);
  if(sources.length!==877||new Set(sources.map(s=>s.original_sha256)).size!==877)
    throw new Error("original_pool_count_changed");
  const inventory=await sql("SELECT name,(metadata->>'size')::bigint AS bytes FROM storage.objects WHERE bucket_id='managed-raw' AND name LIKE 'originals/%'");
  const present=new Map(inventory.map(r=>[r.name,Number(r.bytes)]));
  let uploaded=0,existing=0,totalBytes=0;
  const pending=[];
  for(const s of sources){
    const key=`originals/${s.original_sha256}.mp4`;
    const id=s.filename.slice(s.source_handle.length+2).replace(/\.mp4$/,"");
    if(!/^[a-f0-9]{64}$/.test(s.original_sha256)||!/^[0-9]{10,30}$/.test(id)
      ||!/^[A-Za-z0-9_.-]{1,100}$/.test(s.source_handle))throw new Error("invalid_manifest_identity");
    if(present.has(key)){
      if(present.get(key)!==s.media.bytes)throw new Error("existing_object_size_conflict");
      existing++;continue;
    }
    pending.push({...s,id,key});
  }
  emit({stage:"import_reconciled",existing,pending:pending.length});
  const receipt=`${root}/rehearsal/private-import-receipts.jsonl`;
  for(let start=0;start<pending.length;start+=40){
    const batch=pending.slice(start,start+40).map(s=>{
      const token=crypto.randomBytes(32).toString("hex");
      return {s,token,entry:{token_hash:hash(token),source:{
        sha256:s.original_sha256,bytes:s.media.bytes,duration:s.media.duration,object_key:s.key,
        source_video_id:s.id,source_handle:s.source_handle,
        provenance:"Original downloaded Tradvio pool; original file independently hashed, not an older processed output.",
        permission_ref:"User-approved full private-library rollout; session b99b7376-d8dc-4bf8-b3ee-9bd596645e06, 2026-10-11"
      }}};
    });
    const data=quote(JSON.stringify(batch.map(x=>x.entry)));
    const result=await sql(`BEGIN;
      SELECT library_register_source('${ACTOR}',value->'source') FROM jsonb_array_elements(${data}::jsonb);
      SELECT library_issue_import('${ACTOR}',value#>>'{source,sha256}',value->>'token_hash') FROM jsonb_array_elements(${data}::jsonb);
      COMMIT;
      SELECT count(*)::int AS issued FROM library_import_tickets
        WHERE token_hash IN (SELECT value->>'token_hash' FROM jsonb_array_elements(${data}::jsonb))
        AND redeemed_at IS NULL AND expires_at>now();`);
    if(result.length!==1||result[0].issued!==batch.length)throw new Error("batch_tickets_unconfirmed");
    for(const {s,token} of batch){
      const began=Date.now();
      const bytes=await fs.readFile(s.original_path);
      if(bytes.length!==s.media.bytes||hash(bytes)!==s.original_sha256)throw new Error("local_original_changed");
      let response;
      try{response=await fetch(`${APP}/internal/library/source-upload`,{
        method:"POST",redirect:"error",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
        body:"{}",signal:AbortSignal.timeout(60000)});
      }catch{throw new Error("upload_authorization_unconfirmed");}
      if(!response.ok)throw new Error(`upload_authorization_http_${response.status}`);
      const signed=await response.json(),url=new URL(signed.signed_url);
      if(signed.sha256!==s.original_sha256||signed.bytes!==bytes.length||url.origin!==ORIGIN
        ||url.pathname!==`/storage/v1/object/upload/sign/managed-raw/${s.key}`||url.username||url.password)
        throw new Error("signed_upload_identity_mismatch");
      let result;
      try{result=await fetch(url,{method:"PUT",redirect:"error",
        headers:{"content-type":"video/mp4","x-upsert":"false","cache-control":"max-age=3600"},
        body:bytes,signal:AbortSignal.timeout(90000)});
      }catch{throw new Error("upload_response_unconfirmed_reconcile_before_retry");}
      if(!result.ok)throw new Error(`upload_http_${result.status}_reconcile_before_retry`);
      await result.arrayBuffer();
      await fs.appendFile(receipt,JSON.stringify({sha256:s.original_sha256,bytes:bytes.length,
        object_key:s.key,uploaded_at:new Date().toISOString(),hash_verification:"local_upload_bytes"})+"\n");
      uploaded++;totalBytes+=bytes.length;
      if(uploaded%20===0)emit({stage:"importing",uploaded,existing,total:877,uploaded_bytes:totalBytes});
      // Stay below the endpoint's 90/minute ceiling, even on fast uploads.
      await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-began))));
    }
  }
  const final=await sql("SELECT count(*)::int AS objects,coalesce(sum((metadata->>'size')::bigint),0)::text AS bytes FROM storage.objects WHERE bucket_id='managed-raw' AND name LIKE 'originals/%'");
  emit({stage:"import_finished",uploaded,existing,inventory:final});
  return final;
}
