import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createGenerationStorage} from "../src/generation-storage.js";
test("private storage rejects public buckets, foreign URLs and over-size downloads",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"managed-storage-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  let publicBucket=false,url="https://test.supabase.co/storage/v1/object/sign/managed-raw/approved/source.mp4?token=fixture";
  let bytes="source",fetches=0;
  const db:any={storage:{getBucket:async()=>({data:{public:publicBucket}}),
    from:()=>({createSignedUrl:async()=>({data:{signedUrl:url}})})}};
  const storage=createGenerationStorage(db,"https://test.supabase.co","fixture-key",async(_url,init)=>{
    fetches++;assert.equal(init?.redirect,"error");return new Response(bytes);
  });
  await storage.check();publicBucket=true;await assert.rejects(storage.check(),/private_storage_required/);
  const job={asset:{bucket:"managed-raw",object_key:"approved/source.mp4",bytes:6}};
  const signal=new AbortController().signal;
  await storage.download(job,join(dir,"good.mp4"),signal);
  assert.equal(await readFile(join(dir,"good.mp4"),"utf8"),"source");
  bytes="longer than six";await assert.rejects(storage.download(job,join(dir,"large.mp4"),signal),/source_invalid/);
  url="https://attacker.invalid/source.mp4";
  await assert.rejects(storage.download(job,join(dir,"foreign.mp4"),signal),/source_invalid/);
  assert.equal(fetches,2);
});
