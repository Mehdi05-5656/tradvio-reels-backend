import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

// Phase 3 SQL against a real Postgres (PGlite): queue ranking, retirement and restore, caption winner weighting
// and render fairness, with two clients side by side so nothing leaks across them.
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ORG_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_A="6ac831b2e73f366e1cbd1699", ACC_B="6ac981728c6bf22c85ebad8e";
const sha=(i:number)=>i.toString(16).padStart(64,"0");

async function fixture(t:any){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA storage;CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb);
    CREATE TABLE publer_account_ownership(publer_account_id text PRIMARY KEY,owner_user_id uuid NOT NULL,workspace_id text NOT NULL);
    INSERT INTO publer_account_ownership VALUES('${ACC_A}','${OP}','workspace'),('${ACC_B}','${OP}','workspace');
    CREATE FUNCTION managed_require_operator(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF p_actor IS DISTINCT FROM '${OP}'::uuid THEN RAISE EXCEPTION 'operator_required';END IF;END $$;`);
  for(const f of ["migrations/20261011010000_private_library.sql","migrations/20261011020000_library_storage_budget.sql"]) await db.exec(await readFile(f,"utf8"));
  await db.exec(`
    CREATE TABLE client_orgs(id uuid PRIMARY KEY,name text,slug text,archived_at timestamptz,created_at timestamptz DEFAULT now(),caption_templates jsonb,learning jsonb NOT NULL DEFAULT '{}');
    INSERT INTO client_orgs(id,name,slug,caption_templates) VALUES('${ORG_A}','A','a','["Template one for client A, long enough","Template two for client A, long enough"]'),('${ORG_B}','B','b','["Only template for B, long enough text"]');
    CREATE TABLE client_org_accounts(org_id uuid,phone_slot text PRIMARY KEY);
    INSERT INTO client_org_accounts VALUES('${ORG_A}','library_${ACC_A}'),('${ORG_B}','library_${ACC_B}');
    CREATE TABLE client_account_setup(publer_account_id text PRIMARY KEY,org_id uuid);
    INSERT INTO client_account_setup VALUES('${ACC_A}','${ORG_A}'),('${ACC_B}','${ORG_B}');
    CREATE TABLE client_source_stats(org_id uuid,source_sha256 text,posts int DEFAULT 0,accounts int DEFAULT 0,median_views numeric,p75_views numeric,avg_composite numeric,first_posted_at timestamptz,last_posted_at timestamptz,retired boolean NOT NULL DEFAULT false,retired_at timestamptz,retired_reason text,computed_at timestamptz DEFAULT now(),PRIMARY KEY(org_id,source_sha256));
    CREATE TABLE client_experiments(org_id uuid,id text,hypothesis text,primary_metric text,assignment_method text,minimum_per_arm int DEFAULT 100,winner_arm text,decided_at timestamptz,notes text,registered_at timestamptz DEFAULT now(),evaluation jsonb,evaluated_at timestamptz,PRIMARY KEY(org_id,id));
    CREATE TABLE client_learning_runs(id bigserial PRIMARY KEY,org_id uuid,ran_at timestamptz DEFAULT now(),posts_scored int DEFAULT 0,posts_published int DEFAULT 0,sources int DEFAULT 0,experiments jsonb,duration_ms int);
    CREATE FUNCTION client_experiment_id(p_org uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT id FROM client_experiments WHERE org_id=p_org AND decided_at IS NULL ORDER BY registered_at DESC LIMIT 1),'caption-question-v1') $$;
    CREATE FUNCTION client_learning_refresh_org(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('org_id',p_org) $$;
    CREATE TABLE reels_manual_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_slot text,status text DEFAULT 'pending',notes text,library_variant_id uuid,library_caption text,library_experiment_arm text,created_at timestamptz DEFAULT now());`);
  await db.exec(await readFile("migrations/20261026060000_client_learning_ordering.sql","utf8"));
  const q=async(sql:string,params:any[]=[])=>(await db.query<any>(sql,params)).rows;
  const rpc=async(name:string,args:any={})=>(await db.query<any>(`SELECT ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) value`,Object.values(args).map(v=>v&&typeof v==="object"?JSON.stringify(v):v))).rows[0].value;
  // Six sources for A, two for B, planned onto their accounts; queue rows for every variant.
  for(let i=1;i<=8;i++){
    const org=i<=6?ORG_A:ORG_B;
    await rpc("library_register_source",{p_actor:OP,p_source:{sha256:sha(i),bytes:1024,duration:16,object_key:`originals/${sha(i)}.mp4`,source_video_id:String(7000000000+i),source_handle:"h",provenance:"test source for phase 3 ordering",permission_ref:"operator-approved-private-render"}});
    await q(`UPDATE library_sources SET source=source||jsonb_build_object('prior_views',$1::int) WHERE sha256=$2`,[i*100,sha(i)]);
  }
  await q(`ALTER TABLE library_sources ADD COLUMN IF NOT EXISTS org_id uuid`);
  await q(`UPDATE library_sources SET org_id=CASE WHEN sha256<=$1 THEN $2::uuid ELSE $3::uuid END`,[sha(6),ORG_A,ORG_B]);
  await q(`INSERT INTO library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version,state) SELECT CASE WHEN org_id=$1 THEN $2 ELSE $3 END,$4,'workspace',sha256,'legacy-light-account-v2','pending' FROM library_sources`,[ORG_A,ACC_A,ACC_B,OP]);
  await q(`INSERT INTO reels_manual_queue(phone_slot,library_variant_id,library_caption,library_experiment_arm,created_at) SELECT 'library_'||account_id,id,'caption',' A',now()-interval '1 hour'*(row_number() OVER ()) FROM library_variants`);
  return {db,q,rpc};
}

test("queue ranking: off leaves ranks empty; on puts the client's strongest videos first with an exploration share mixed in, per client",async(t)=>{
  const {q,rpc}=await fixture(t);
  // A's stats: source 1 strongest, 6 weakest, 3 unmeasured (cold start, prior views decide).
  await q(`INSERT INTO client_source_stats(org_id,source_sha256,posts,avg_composite) VALUES($1,$2,4,1.5),($1,$3,4,0.5),($1,$4,4,-0.2),($1,$5,4,-0.9),($1,$6,6,-1.8)`,[ORG_A,sha(1),sha(2),sha(4),sha(5),sha(6)]);
  assert.equal(await rpc("client_learning_rank_queue",{p_org:ORG_A}),0);
  assert.equal((await q(`SELECT count(*) n FROM reels_manual_queue WHERE queue_rank IS NOT NULL`))[0].n,0);
  await q(`UPDATE client_orgs SET learning='{"optimize":true,"exploration_share":0}' WHERE id=$1`,[ORG_A]);
  assert.equal(await rpc("client_learning_rank_queue",{p_org:ORG_A}),6);
  const order=await q(`SELECT v.source_sha256 s FROM reels_manual_queue r JOIN library_variants v ON v.id=r.library_variant_id WHERE r.phone_slot=$1 ORDER BY r.queue_rank`,[`library_${ACC_A}`]);
  assert.deepEqual(order.map((r:any)=>r.s),[sha(1),sha(2),sha(3),sha(4),sha(5),sha(6)],"strongest first; the unmeasured video sits at zero between winners and losers");
  // B untouched: its switch is off.
  assert.equal((await q(`SELECT count(*) n FROM reels_manual_queue WHERE phone_slot=$1 AND queue_rank IS NOT NULL`,[`library_${ACC_B}`]))[0].n,0);
  // Exploration: with a half share, the hash-chosen rows interleave rather than all strongest first.
  await q(`UPDATE client_orgs SET learning='{"optimize":true,"exploration_share":0.5}' WHERE id=$1`,[ORG_A]);
  await rpc("client_learning_rank_queue",{p_org:ORG_A});
  const mixed=await q(`SELECT v.source_sha256 s FROM reels_manual_queue r JOIN library_variants v ON v.id=r.library_variant_id WHERE r.phone_slot=$1 ORDER BY r.queue_rank`,[`library_${ACC_A}`]);
  assert.equal(mixed.length,6);assert.notDeepEqual(mixed.map((r:any)=>r.s),order.map((r:any)=>r.s));
  // Switching off clears the ranks again.
  await q(`UPDATE client_orgs SET learning='{"optimize":false}' WHERE id=$1`,[ORG_A]);
  await rpc("client_learning_rank_queue",{p_org:ORG_A});
  assert.equal((await q(`SELECT count(*) n FROM reels_manual_queue WHERE queue_rank IS NOT NULL`))[0].n,0);
});

test("retiring: weak videos with enough posts are retired and their pending rows skipped with a note; restore pins and brings them back",async(t)=>{
  const {q,rpc}=await fixture(t);
  await q(`INSERT INTO client_source_stats(org_id,source_sha256,posts,avg_composite) VALUES($1,$2,4,1.5),($1,$3,4,0.5),($1,$4,4,-0.2),($1,$5,4,-0.9),($1,$6,6,-1.8),($1,$7,1,-3)`,[ORG_A,sha(1),sha(2),sha(3),sha(4),sha(6),sha(5)]);
  assert.deepEqual(await rpc("client_learning_retire",{p_org:ORG_A}),{retired:0,skipped_rows:0,threshold:null},"switch off: nothing retires");
  await q(`UPDATE client_orgs SET learning='{"optimize":true,"retire_after_posts":4,"retire_below_pct":25}' WHERE id=$1`,[ORG_A]);
  const r=await rpc("client_learning_retire",{p_org:ORG_A});
  assert.equal(r.retired,1,JSON.stringify(r));
  const retired=await q(`SELECT source_sha256 s,retired_reason FROM client_source_stats WHERE org_id=$1 AND retired`,[ORG_A]);
  assert.deepEqual(retired.map((x:any)=>x.s),[sha(6)],"only the weakest with enough posts; the 1-post video is left alone");
  assert.match(retired[0].retired_reason,/6 posts/);
  const row=await q(`SELECT r.status,r.notes FROM reels_manual_queue r JOIN library_variants v ON v.id=r.library_variant_id WHERE v.source_sha256=$1`,[sha(6)]);
  assert.equal(row[0].status,"skipped");assert.match(row[0].notes,/retired by learning/);
  assert.equal((await q(`SELECT count(*) n FROM reels_manual_queue WHERE status='pending'`))[0].n,7,"every other row, including client B's, still pending");
  const back=await rpc("client_source_set_retired",{p_org:ORG_A,p_sha:sha(6),p_retired:false,p_actor:"op"});
  assert.equal(back.rows,1);
  const after=await q(`SELECT r.status,r.notes,s.retired,s.pinned FROM reels_manual_queue r JOIN library_variants v ON v.id=r.library_variant_id JOIN client_source_stats s ON s.source_sha256=v.source_sha256 WHERE v.source_sha256=$1`,[sha(6)]);
  assert.equal(after[0].status,"pending");assert.equal(after[0].notes,null);assert.equal(after[0].retired,false);assert.equal(after[0].pinned,true);
  assert.equal((await rpc("client_learning_retire",{p_org:ORG_A})).retired,0,"a pinned video is not retired again");
  // B cannot touch A's video: its stats row would be created under B, but A's rows are untouched.
  await rpc("client_source_set_retired",{p_org:ORG_B,p_sha:sha(1),p_retired:true,p_actor:"op"});
  assert.equal((await q(`SELECT status FROM reels_manual_queue r JOIN library_variants v ON v.id=r.library_variant_id WHERE v.source_sha256=$1`,[sha(1)]))[0].status,"pending");
});

test("caption winner: without optimise arms split evenly; with a decided winner about winner_weight of new rows take it; a one-template client is untouched",async(t)=>{
  const {q,rpc}=await fixture(t);
  const arms=async(acc:string)=>{const rows=await q(`SELECT (library_caption_for($1,md5(g::text)||md5(g::text))).arm a FROM generate_series(1,400) g`,[acc]);const c:Record<string,number>={};for(const r of rows)c[r.a]=(c[r.a]??0)+1;return c;};
  const even=await arms(ACC_A);
  assert.ok(Math.abs(even.A-even.B)<80,`even split, got ${JSON.stringify(even)}`);
  await q(`INSERT INTO client_experiments(org_id,id,hypothesis,primary_metric,assignment_method,winner_arm,decided_at) VALUES($1,'caption-question-v1','h','m','hash','B',now())`,[ORG_A]);
  assert.deepEqual(await arms(ACC_A),even,"a winner changes nothing until the client opts in");
  await q(`UPDATE client_orgs SET learning='{"optimize":true,"winner_weight":0.8}' WHERE id=$1`,[ORG_A]);
  const weighted=await arms(ACC_A);
  assert.ok(weighted.B>=280&&weighted.B<=360,`about 80 % on the winner, got ${JSON.stringify(weighted)}`);
  const only=await arms(ACC_B);
  assert.deepEqual(Object.keys(only),["A"]);
  const single=await q(`SELECT (library_caption_for($1,$2)).* `,[ACC_B,sha(7)]);
  assert.equal(single[0].arm,"A");assert.match(single[0].caption,/Only template for B/);
});

test("render fairness: claims alternate between clients with pending work instead of draining the first client's queue",async(t)=>{
  const {q,rpc}=await fixture(t);
  await q(`UPDATE library_control SET enabled=true,max_active=4,max_daily_claims=100,max_output_bytes=1000000000`);
  const seen:string[]=[];
  for(let i=0;i<4;i++){const c=await rpc("library_claim",{p_worker:"w"+i});assert.ok(c,"a claim");seen.push(c.account_id);await new Promise(r=>setTimeout(r,15));} // the WASM clock is coarse; production claims are seconds apart
  assert.deepEqual(seen,[ACC_A,ACC_B,ACC_A,ACC_B],`alternating clients, got ${seen.join(",")}`);
});
