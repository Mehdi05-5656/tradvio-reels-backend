import type {Express} from "express";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";

// A separate, disabled-by-default capability route, NOT an admin-login bypass.
// Tickets are operator-minted, single-redemption, bound to one exact source hash.
export function registerLibraryImport(app:Express,sbFn:()=>SupabaseClient,
  enabled=()=>process.env.LIBRARY_IMPORT_ENABLED==="1",origin=()=>process.env.SUPABASE_URL??""){
  let windowStart=0,requests=0;
  app.post("/internal/library/source-upload",async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    if(!enabled())return res.status(404).json({error:"not_found"});
    if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0;}
    if(++requests>90)return res.status(429).json({error:"rate_limited"});
    const match=req.header("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);
    if(!match)return res.status(403).json({error:"import_not_authorized"});
    try{
      const sb=sbFn();
      const r=await sb.rpc("library_redeem_import",{
        p_token_hash:createHash("sha256").update(match[1]).digest("hex")});
      if(r.error)throw new Error("import_unavailable");
      if(!r.data)return res.status(403).json({error:"import_not_authorized"});
      const s=r.data;
      if(!/^[a-f0-9]{64}$/.test(s.sha256)||s.object_key!==`originals/${s.sha256}.mp4`
        ||!Number.isSafeInteger(s.bytes)||s.bytes<1||s.bytes>134217728)throw new Error("invalid_import");
      const bucket=await sb.storage.getBucket("managed-raw");
      if(bucket.error||bucket.data?.public!==false)throw new Error("private_storage_required");
      const signed=await sb.storage.from("managed-raw").createSignedUploadUrl(s.object_key,{upsert:false});
      if(signed.error||!signed.data?.signedUrl)throw new Error("signing_failed");
      const expected=new URL(origin()),url=new URL(signed.data.signedUrl);
      if(expected.protocol!=="https:"||url.origin!==expected.origin||url.username||url.password
        ||url.pathname!==`/storage/v1/object/upload/sign/managed-raw/${s.object_key}`
        ||!url.searchParams.get("token"))throw new Error("invalid_signed_url");
      return res.json({sha256:s.sha256,bytes:s.bytes,object_key:s.object_key,signed_url:url.toString(),
        overwrite:false,publication_enabled:false});
    }catch{return res.status(503).json({error:"import_unavailable_reconcile_ticket_before_retry"});}
  });
}
