import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e",A="a".repeat(24);
async function fixture(t:any){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE publer_account_ownership(publer_account_id text PRIMARY KEY,owner_user_id uuid,workspace_id text,platform text,label text);
    INSERT INTO publer_account_ownership VALUES('${A}','${OP}','w','instagram','pilot');
    CREATE TABLE publer_config(workspace_id text);INSERT INTO publer_config VALUES('w');
    CREATE TABLE publer_slot_config(phone_slot text PRIMARY KEY,publer_account_id text,provider text,handle text,daily_target int,paused boolean,owner_user_id uuid,
      CONSTRAINT publer_slot_config_slot_check CHECK(phone_slot IN ('phone_a','phone_b','tiktok_tradvio')));
    INSERT INTO publer_slot_config VALUES('phone_a','legacy','instagram','legacy',8,false,'${OP}');
    CREATE TABLE reels_manual_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_slot text,source_handle text,source_video_id text,
      filename text,storage_path text,duration_sec numeric,size_bytes bigint,status text,source_aweme_id text,content_video_hash text,
      CONSTRAINT reels_manual_queue_phone_slot_check CHECK(phone_slot IN ('phone_a','phone_b','tiktok_tradvio')));
    CREATE TABLE publer_publish_log(queue_id uuid,phone_slot text,status text,publer_post_id text);
    CREATE FUNCTION managed_require_operator(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF p_actor IS DISTINCT FROM '${OP}'::uuid THEN RAISE EXCEPTION 'operator_required';END IF;END $$;`);
  for(const file of ["20261011010000_private_library.sql","20261011040000_library_publisher_bridge.sql"]){
    const sql=await readFile("migrations/"+file,"utf8");await db.exec(sql);await db.exec(sql);
  }
  const rpc=async(name:string,args:any={})=>(await db.query<any>(
    `SELECT ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) value`,
    Object.values(args).map(v=>v&&typeof v==="object"?JSON.stringify(v):v))).rows[0].value;
  const policy={p_actor:OP,p_account:A,p_start:new Date(Date.now()+2*3600000).toISOString(),
    p_daily:8,p_min_ready:3,p_settings:{feed:true},p_approval:"User-approved full-library launch"};
  for(let i=0;i<3;i++){
    const sha=String(i).repeat(64);
    await rpc("library_register_source",{p_actor:OP,p_source:{sha256:sha,bytes:1024,duration:16,
      object_key:`originals/${sha}.mp4`,source_video_id:"758244865180968884"+i,source_handle:"creator",
      provenance:"Test original pool identity",permission_ref:"test private render"}});
  }
  await rpc("library_plan",{p_actor:OP,p_account:A});
  const render=()=>db.exec(`UPDATE library_variants SET state='rendered_private',result=jsonb_build_object(
    'full_decode_passed',true,'object_key','library/${OP}/${A}/'||id||'/11111111-1111-4111-8111-111111111111.mp4',
    'sha256',md5(source_sha256||account_id)||md5(source_sha256||account_id),'bytes',1024,'duration',16)`);
  return {db,rpc,policy,render};
}
test("arming does not publish; readiness feeds an idempotent account-bound queue and preserves legacy slots",async t=>{
  const s=await fixture(t);
  await s.rpc("library_arm_publishing",s.policy);
  const progress=await s.rpc("library_account_progress",{p_actor:OP,p_account:A});
  assert.equal(progress.publishing_enabled,true);
  assert.equal(progress.minimum_ready,3);
  assert.equal(await s.rpc("library_feed_publishers"),0);
  await s.render();assert.equal(await s.rpc("library_feed_publishers"),3);
  assert.equal(await s.rpc("library_feed_publishers"),0);
  const q=(await s.db.query<any>("SELECT * FROM reels_manual_queue")).rows;
  assert.equal(q.length,3);assert.ok(q.every(r=>r.phone_slot==="library_"+A&&r.storage_bucket==="managed-variants"&&r.status==="pending"));
  assert.ok(q.every(r=>["A","B"].includes(r.library_experiment_arm)&&r.library_caption.includes("Trading involves risk")));
  assert.equal((await s.db.query<any>("SELECT paused FROM publer_slot_config WHERE phone_slot='phone_a'")).rows[0].paused,false);
  assert.equal(await s.rpc("library_publication_receipt",{p_queue:q[0].id,p_account:A}),null);
  await s.db.exec("UPDATE library_publishing_policy SET not_before=now()-interval '1 minute'; UPDATE publer_slot_config SET publish_after=now()-interval '1 minute' WHERE phone_slot LIKE 'library_%'");
  const r=await s.rpc("library_publication_receipt",{p_queue:q[0].id,p_account:A});
  assert.equal(r.variant_id,q[0].library_variant_id);
  await s.db.exec("UPDATE publer_slot_config SET paused=true WHERE phone_slot LIKE 'library_%'");
  await s.rpc("library_feed_publishers");
  assert.equal(await s.rpc("library_publication_receipt",{p_queue:q[0].id,p_account:A}),null);
});
test("foreign owner, changed destination and absent platform disclosure fail closed",async t=>{
  const s=await fixture(t);
  await assert.rejects(s.rpc("library_arm_publishing",{...s.policy,p_actor:null}),/operator_required/);
  await assert.rejects(s.rpc("library_arm_publishing",{...s.policy,p_settings:{}}),/invalid_platform_settings/);
  await s.db.exec("UPDATE publer_account_ownership SET platform='tiktok'");
  await assert.rejects(s.rpc("library_arm_publishing",s.policy),/invalid_platform_settings/);
  const settings={privacy:"PUBLIC_TO_EVERYONE",comment:true,duet:false,stitch:false,promotional:true,paid:false};
  await s.rpc("library_arm_publishing",{...s.policy,p_settings:settings});await s.render();
  await s.db.exec("UPDATE publer_account_ownership SET owner_user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
  assert.equal(await s.rpc("library_feed_publishers"),0);
  await s.db.exec("SET ROLE authenticated");
  await assert.rejects(s.rpc("library_feed_publishers"),/permission denied/);
});
test("other accounts cannot enter the publisher until the first account has an exact publication receipt",async t=>{
  const s=await fixture(t),B="b".repeat(24);
  await s.db.exec(`INSERT INTO publer_account_ownership VALUES('${B}','${OP}','w','instagram','second')`);
  await s.rpc("library_arm_publishing",s.policy);
  await assert.rejects(s.rpc("library_arm_publishing",{...s.policy,p_account:B,p_gate:B}),/invalid_launch_gate/);
  await s.rpc("library_arm_publishing",{...s.policy,p_account:B,p_gate:A});
  await s.rpc("library_plan",{p_actor:OP,p_account:B});
  await s.render();
  // fixture renderer uses account A's path; correct B's identity before feeding.
  await s.db.exec(`UPDATE library_variants SET result=jsonb_set(result,'{object_key}',to_jsonb(
    'library/${OP}/'||account_id||'/'||id||'/11111111-1111-4111-8111-111111111111.mp4'))`);
  assert.equal(await s.rpc("library_feed_publishers"),3);
  assert.equal((await s.rpc("library_account_progress",{p_actor:OP,p_account:B})).waiting_for_pilot,true);
  const q=(await s.db.query<any>("SELECT * FROM reels_manual_queue LIMIT 1")).rows[0];
  await s.db.exec(`UPDATE reels_manual_queue SET status='posted' WHERE id='${q.id}';
    INSERT INTO publer_publish_log VALUES('${q.id}','library_${A}','pending','post-1')`);
  assert.equal(await s.rpc("library_feed_publishers"),0);
  await s.db.exec("UPDATE publer_publish_log SET status='published'");
  assert.equal(await s.rpc("library_feed_publishers"),3);
  assert.equal((await s.rpc("library_account_progress",{p_actor:OP,p_account:B})).waiting_for_pilot,false);
});
