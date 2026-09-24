import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHandoffStorage} from "../src/handoff-storage.js";
const customer="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",account="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  generation="cccccccc-cccc-4ccc-8ccc-cccccccccccc",attempt="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const path=`${customer}/${account}/${generation}/${attempt}/output.mp4`,origin="https://test.supabase.co";
const bytes=Buffer.from("synthetic video bytes");
const job:any={customer_user_id:customer,account_id:account,generation_id:generation,
  artifact:{bucket:"managed-variants",object_key:path,sha256:createHash("sha256").update(bytes).digest("hex")}};
function storage(publicBucket=false,url=`${origin}/storage/v1/object/sign/managed-variants/${path}?token=test`) {
  return {storage:{getBucket:async()=>({data:{public:publicBucket}}),
    from:(bucket:string)=>{assert.equal(bucket,"managed-variants");return {createSignedUrl:async(key:string,ttl:number)=>{
      assert.equal(key,path);assert.equal(ttl,600);return {data:{signedUrl:url}};}};}}};
}
test("handoff verifies private, exact customer artifact hash before disclosing signed URL",async()=>{
  let calls=0;
  const signer=createHandoffStorage(storage(),origin,async(_url,init)=>{
    calls++;assert.equal(init?.redirect,"error");return new Response(bytes);});
  assert.match(await signer(job,new AbortController().signal),/^https:\/\/test.supabase.co/);
  assert.equal(calls,1);
  await assert.rejects(signer({...job,artifact:{...job.artifact,sha256:"0".repeat(64)}},new AbortController().signal),/storage_unavailable/);
});
test("public bucket, wrong owner and foreign signed URL fail before media read",async()=>{
  let calls=0;const request:any=async()=>{calls++;return new Response(bytes);};
  for(const sb of [storage(true),storage(false,"https://foreign.test/video")])
    await assert.rejects(createHandoffStorage(sb,origin,request)(job,new AbortController().signal),/storage_unavailable/);
  await assert.rejects(createHandoffStorage(storage(),origin,request)({...job,customer_user_id:account},new AbortController().signal),/storage_unavailable/);
  assert.equal(calls,0);
});
