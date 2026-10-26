import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

// Storage stewardship SQL on a real Postgres: who is a purge candidate, what marking records, and the renderer's
// per-account buffer with strongest-first order.
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A="6ac831b2e73f366e1cbd1699", ACC_B="6ac981728c6bf22c85ebad8e";
const sha=(i:number)=>i.toString(16).padStart(64,"0");

async function fixture(t:any){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA storage;CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE publer_account_ownership(publer_account_id text PRIMARY KEY,owner_user_id uuid NOT NULL,workspace_id text NOT NULL);
    INSERT INTO publer_account_ownership VALUES('${ACC_A}','${OP}','workspace'),('${ACC_B}','${OP}','workspace');
    CREATE FUNCTION managed_require_operator(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF p_actor IS DISTINCT FROM '${OP}'::uuid THEN RAISE EXCEPTION 'operator_required';END IF;END $$;`);
  for(const f of ["migrations/20261011010000_private_library.sql","migrations/20261011020000_library_storage_budget.sql"]) await db.exec(await readFile(f,"utf8"));
  await db.exec(`
    CREATE TABLE client_account_setup(publer_account_id text PRIMARY KEY,org_id uuid,daily_target int DEFAULT 8);
    INSERT INTO client_account_setup VALUES('${ACC_A}','${ORG_A}',2),('${ACC_B}','${ORG_A}',2);
    CREATE TABLE client_source_stats(org_id uuid,source_sha256 text,avg_composite numeric,retired boolean DEFAULT false,PRIMARY KEY(org_id,source_sha256));
    CREATE TABLE reels_manual_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_slot text,status text DEFAULT 'pending',storage_path text,storage_bucket text,library_variant_id uuid,posted_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE publer_publish_log(id bigserial PRIMARY KEY,queue_id uuid,status text,attempted_at timestamptz DEFAULT now());
    CREATE TABLE video_content_features(id bigserial PRIMARY KEY,queue_id uuid);
    ALTER TABLE library_sources ADD COLUMN IF NOT EXISTS org_id uuid;`);
  await db.exec(await readFile("migrations/20261026070000_library_archive.sql","utf8"));
  const q=async(sql:string,params:any[]=[])=>(await db.query<any>(sql,params)).rows;
  const rpc=async(name:string,args:any={})=>(await db.query<any>(`SELECT ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) value`,Object.values(args).map(v=>v&&typeof v==="object"?JSON.stringify(v):v))).rows[0].value;
  for(let i=1;i<=7;i++){
    await rpc("library_register_source",{p_actor:OP,p_source:{sha256:sha(i),bytes:1024,duration:16,object_key:`originals/${sha(i)}.mp4`,source_video_id:String(7000000000+i),source_handle:"h",provenance:"test source for storage stewardship",permission_ref:"operator-approved-private-render"}});
    await q(`UPDATE library_sources SET org_id=$1, source=source||jsonb_build_object('prior_views',$2::int) WHERE sha256=$3`,[ORG_A,i*100,sha(i)]);
  }
  await q(`UPDATE library_control SET enabled=true,max_active=4,max_daily_claims=100,max_output_bytes=1000000000`);
  return {db,q,rpc};
}

test("purge candidates: only verified-published, feature-extracted, past-grace, unarchived variants; marking records the archive and the poster",async(t)=>{
  const {q,rpc}=await fixture(t);
  // Three rendered variants on account A: posted 20 days ago with features (eligible), posted 2 days ago (too young), posted 20 days ago without features (kept).
  const mk=async(i:number,daysAgo:number,features:boolean,status="posted")=>{
    const v=(await q(`INSERT INTO library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version,state,result) VALUES($1,$2,'workspace',$3,'legacy-light-account-v2','rendered_private',$4) RETURNING id`,
      [ACC_A,OP,sha(i),JSON.stringify({object_key:`library/${OP}/${ACC_A}/${i}/f.mp4`,bytes:3700000,sha256:sha(i+50)})]))[0].id;
    await q(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('managed-variants',$1,$2)`,[`library/${OP}/${ACC_A}/${i}/f.mp4`,JSON.stringify({size:3700000})]);
    const qid=(await q(`INSERT INTO reels_manual_queue(phone_slot,status,storage_path,storage_bucket,library_variant_id,posted_at) VALUES($1,$2,$3,'managed-variants',$4,now()-make_interval(days=>$5)) RETURNING id`,[`library_${ACC_A}`,status,`library/${OP}/${ACC_A}/${i}/f.mp4`,v,daysAgo]))[0].id;
    await q(`INSERT INTO publer_publish_log(queue_id,status,attempted_at) VALUES($1,'published',now()-make_interval(days=>$2))`,[qid,daysAgo]);
    if(features)await q(`INSERT INTO video_content_features(queue_id) VALUES($1)`,[qid]);
    return {v,qid};
  };
  const a=await mk(1,20,true), b=await mk(2,2,true), c=await mk(3,20,false), d=await mk(4,20,true,"pending");
  void b; void c; void d;
  const cands=await q(`SELECT variant_id,bytes,file_sha256 FROM library_purge_candidates(40)`);
  assert.deepEqual(cands.map((r:any)=>r.variant_id),[a.v],"only the old, featured, posted one");
  assert.equal(Number(cands[0].bytes),3700000);
  // A pending submission for that post blocks it.
  await q(`INSERT INTO publer_publish_log(queue_id,status) VALUES($1,'pending')`,[a.qid]);
  assert.equal((await q(`SELECT count(*) n FROM library_purge_candidates(40)`))[0].n,0);
  await q(`DELETE FROM publer_publish_log WHERE queue_id=$1 AND status='pending'`,[a.qid]);
  const before=await q(`SELECT (stored_bytes) sb,(posted_unpurged_objects) pu,(purge_candidates) pc,(purge_enabled) pe FROM library_storage_usage()`);
  assert.equal(Number(before[0].pu),3);assert.equal(Number(before[0].pc),1);assert.equal(before[0].pe,false);
  const marked=await rpc("library_mark_purged",{p_variant:a.v,p_entry:{org_id:ORG_A,bytes_freed:3700000,file_sha256:sha(51),sha_verified:true,poster_key:`archive/${a.v}/poster.jpg`,strip_key:`archive/${a.v}/strip.jpg`,archive_bytes:60000,probe:{duration:16},posted_at:new Date().toISOString(),published_at:new Date().toISOString(),features_present:true}});
  assert.equal(marked.outcome,"purged");
  const row=await q(`SELECT (result->>'purged_at') IS NOT NULL AS purged,result->>'poster_key' poster FROM library_variants WHERE id=$1`,[a.v]);
  assert.equal(row[0].purged,true);assert.equal(row[0].poster,`archive/${a.v}/poster.jpg`);
  assert.equal((await q(`SELECT poster_path FROM reels_manual_queue WHERE id=$1`,[a.qid]))[0].poster_path,`archive/${a.v}/poster.jpg`);
  assert.equal((await q(`SELECT count(*) n FROM library_purge_candidates(40)`))[0].n,0,"marked rows leave the candidate list");
  const ledger=await q(`SELECT bytes_freed,sha_verified,outcome FROM library_purges`);
  assert.deepEqual(ledger,[{bytes_freed:3700000,sha_verified:true,outcome:"purged"}]);
  const after=await q(`SELECT freed_bytes,purged_objects FROM library_storage_usage()`);
  assert.equal(Number(after[0].freed_bytes),3700000);assert.equal(Number(after[0].purged_objects),1);
  await assert.rejects(()=>rpc("library_mark_purged",{p_variant:a.v,p_entry:{}}),/unique|duplicate/i);
});

test("renderer buffer: an account that is far enough ahead is skipped, the next claim is the strongest video of an account that still needs work",async(t)=>{
  const {q,rpc}=await fixture(t);
  await q(`UPDATE library_control SET render_buffer_days=3`);
  // Account A has daily_target 2 → buffer 6; give it 6 rendered-unposted variants: full. Account B has none.
  for(let i=1;i<=6;i++){
    const v=(await q(`INSERT INTO library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version,state,result) VALUES($1,$2,'workspace',$3,'legacy-light-account-v2','rendered_private','{"object_key":"library/x"}') RETURNING id`,[ACC_A,OP,sha(i)]))[0].id;
    await q(`INSERT INTO reels_manual_queue(phone_slot,status,library_variant_id) VALUES($1,'pending',$2)`,[`library_${ACC_A}`,v]);
  }
  // Pending work: one more for A (should wait) and three for B with different strengths.
  await q(`INSERT INTO library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version,state) VALUES($1,$2,'workspace',$3,'legacy-light-account-v2','pending')`,[ACC_A,OP,sha(7)]);
  for(const i of [1,2,3]) await q(`INSERT INTO library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version,state) VALUES($1,$2,'workspace',$3,'legacy-light-account-v2','pending')`,[ACC_B,OP,sha(i)]);
  await q(`INSERT INTO client_source_stats(org_id,source_sha256,avg_composite) VALUES($1,$2,-0.5),($1,$3,1.2)`,[ORG_A,sha(1),sha(2)]);
  const first=await rpc("library_claim",{p_worker:"w1"});
  assert.equal(first.account_id,ACC_B,"A is a full buffer ahead; B gets rendered");
  assert.equal(first.source_sha256,sha(2),"strongest video first");
  const second=await rpc("library_claim",{p_worker:"w2"});
  assert.equal(second.source_sha256,sha(3),"unmeasured video with the higher intake prior before the weak one");
  const third=await rpc("library_claim",{p_worker:"w3"});
  assert.equal(third.source_sha256,sha(1));
  assert.equal(await rpc("library_claim",{p_worker:"w4"}),null,"A still waits: nothing else is claimable");
  // A posts two, dropping below its buffer: its pending variant becomes claimable.
  await q(`UPDATE reels_manual_queue SET status='posted' WHERE phone_slot=$1 AND id IN (SELECT id FROM reels_manual_queue WHERE phone_slot=$1 LIMIT 2)`,[`library_${ACC_A}`]);
  const later=await rpc("library_claim",{p_worker:"w5"});
  assert.ok(later&&later.account_id===ACC_A,"A renders again once it has posted");
});
