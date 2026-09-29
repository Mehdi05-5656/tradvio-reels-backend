import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

const MIGRATION="migrations/20260930000000_production_privacy_hardening.sql";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN="71c2308a-9e23-4458-b4f0-df7ae53c841e";
async function setup(t:any) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role,supabase_auth_admin;
    GRANT INSERT ON auth.users TO supabase_auth_admin;
  `);
  await db.exec(await readFile("migrations/2026_09_07_endpoint_user_auth.sql","utf8"));
  await db.exec(`
    INSERT INTO auth.users VALUES
      ('${A}','a@synthetic.invalid','{}'),('${B}','b@synthetic.invalid','{}'),
      ('${ADMIN}','operator@synthetic.invalid','{}');
    UPDATE profiles SET role='admin' WHERE user_id='${ADMIN}';
    CREATE TABLE scheduled_reels(id integer PRIMARY KEY,updated_at timestamptz);
    CREATE FUNCTION set_scheduled_reels_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
    CREATE TRIGGER scheduled_touch BEFORE UPDATE ON scheduled_reels
      FOR EACH ROW EXECUTE FUNCTION set_scheduled_reels_updated_at();
    INSERT INTO scheduled_reels VALUES(1,'2000-01-01');
    CREATE TABLE reels_manual_queue(id uuid PRIMARY KEY,storage_path text,created_at timestamptz DEFAULT now());
    CREATE TABLE video_content_features(queue_id uuid);
    CREATE FUNCTION pending_feature_extraction(lim integer DEFAULT 100)
      RETURNS TABLE(id uuid,storage_path text) LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT q.id,q.storage_path FROM public.reels_manual_queue q
      LEFT JOIN public.video_content_features f ON f.queue_id=q.id
      WHERE q.storage_path IS NOT NULL AND f.queue_id IS NULL
      ORDER BY q.created_at DESC LIMIT lim $$;
    REVOKE ALL ON FUNCTION pending_feature_extraction(integer) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION pending_feature_extraction(integer) TO service_role;
    INSERT INTO reels_manual_queue(id,storage_path) VALUES('${A}','synthetic.mp4');
    CREATE TABLE publer_analytics(publer_post_id text,saves integer,shares integer,
      reach integer,video_views integer,captured_at timestamptz);
    CREATE TABLE leader_posts(shortcode text,provider text,saves integer,shares integer,
      reach integer,video_views integer,last_refreshed_at timestamptz);
    CREATE FUNCTION merge_own_analytics_to_leader_posts() RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE updated_count int; BEGIN
      WITH latest AS (
        SELECT DISTINCT ON (publer_post_id)
          substring(publer_post_id from 'reel/([^/]+)/') as shortcode,
          saves,shares,reach,video_views as latest_views FROM publer_analytics
        WHERE publer_post_id LIKE 'https://www.instagram.com/reel/%'
        ORDER BY publer_post_id,captured_at DESC
      ), upd AS (
        UPDATE leader_posts l SET saves=COALESCE(latest.saves,l.saves),
          shares=COALESCE(latest.shares,l.shares),reach=COALESCE(latest.reach,l.reach),
          video_views=GREATEST(l.video_views,COALESCE(latest.latest_views,0)),last_refreshed_at=NOW()
        FROM latest WHERE l.shortcode=latest.shortcode AND l.provider='instagram'
        AND (latest.saves IS NOT NULL OR latest.shares IS NOT NULL OR latest.reach IS NOT NULL)
        RETURNING 1
      ) SELECT count(*) INTO updated_count FROM upd; RETURN updated_count; END $$;
    INSERT INTO publer_analytics VALUES('https://www.instagram.com/reel/synthetic/',1,2,3,4,now());
    INSERT INTO leader_posts VALUES('synthetic','instagram',NULL,NULL,NULL,0,NULL);
    CREATE TABLE ingestion_jobs(id uuid PRIMARY KEY,cv_account_id uuid,status text DEFAULT 'pending',
      claimed_by text,claimed_at timestamptz,attempts integer DEFAULT 0,since_cursor timestamptz,
      page_limit integer DEFAULT 50,created_at timestamptz DEFAULT now(),updated_at timestamptz);
    CREATE FUNCTION touch_ingestion_jobs_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at:=NOW(); RETURN NEW; END $$;
    CREATE TRIGGER ingestion_touch BEFORE UPDATE ON ingestion_jobs FOR EACH ROW
      EXECUTE FUNCTION touch_ingestion_jobs_updated_at();
    CREATE FUNCTION claim_next_ingestion_job(worker_id text)
      RETURNS TABLE(job_id uuid,cv_account_id uuid,since_cursor timestamptz,page_limit integer,attempts integer)
      LANGUAGE plpgsql AS $$ BEGIN RETURN QUERY UPDATE ingestion_jobs j
      SET status='claimed',claimed_by=worker_id,claimed_at=NOW(),attempts=j.attempts+1
      WHERE j.id=(SELECT id FROM ingestion_jobs WHERE status='pending'
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING j.id,j.cv_account_id,j.since_cursor,j.page_limit,j.attempts; END $$;
    INSERT INTO ingestion_jobs(id,cv_account_id) VALUES('${A}','${B}');
    CREATE MATERIALIZED VIEW caption_performance AS
      SELECT 1 AS synthetic_id,'private synthetic caption'::text AS caption;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON caption_performance TO anon,authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
  `);
  return {db,apply:async()=>db.exec(await readFile(MIGRATION,"utf8"))};
}
async function asRole(db:PGlite,role:string,uid:string,sql:string) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[uid,role]);
  await db.exec(`SET ROLE ${role}`);
  try{return await db.query<any>(sql);}
  finally{await db.exec("RESET ROLE");}
}
test("privacy migration closes the real grant pattern without deleting materialized data",async t=>{
  const s=await setup(t);
  assert.equal((await asRole(s.db,"anon","","SELECT * FROM caption_performance")).rows.length,1);
  await s.apply();await s.apply();
  for(const role of ["anon","authenticated"]) {
    await assert.rejects(asRole(s.db,role,A,"SELECT * FROM caption_performance"),/permission denied/);
    const grants=(await s.db.query<any>(`SELECT has_table_privilege($1,'caption_performance','SELECT') AS allowed`,[role])).rows;
    assert.equal(grants[0].allowed,false);
  }
  const row=(await asRole(s.db,"service_role","","SELECT * FROM caption_performance")).rows[0];
  assert.equal(row.caption,"private synthetic caption");
});
test("profile RLS and signup survive; role helper cannot disclose other users' roles",async t=>{
  const s=await setup(t);await s.apply();
  assert.deepEqual((await asRole(s.db,"authenticated",A,"SELECT user_id FROM profiles")).rows,[{user_id:A}]);
  assert.equal((await asRole(s.db,"authenticated",ADMIN,"SELECT user_id FROM profiles")).rows.length,3);
  assert.equal((await asRole(s.db,"authenticated",A,`SELECT is_admin('${ADMIN}') AS value`)).rows[0].value,false);
  assert.equal((await asRole(s.db,"authenticated",ADMIN,`SELECT is_admin('${ADMIN}') AS value`)).rows[0].value,true);
  await assert.rejects(asRole(s.db,"anon","",`SELECT is_admin('${ADMIN}')`),/permission denied/);
  await asRole(s.db,"authenticated",A,`UPDATE profiles SET role='admin',email='forged',display_name='Permitted' WHERE user_id='${A}'`);
  const profile=(await s.db.query<any>("SELECT role,email,display_name FROM profiles WHERE user_id=$1",[A])).rows[0];
  assert.deepEqual(profile,{role:"user",email:"a@synthetic.invalid",display_name:"Permitted"});
  await asRole(s.db,"supabase_auth_admin","",`INSERT INTO auth.users VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','new@synthetic.invalid','{"display_name":"New"}')`);
  assert.equal((await s.db.query<any>("SELECT role FROM profiles WHERE email='new@synthetic.invalid'")).rows[0].role,"user");
});
test("audited worker functions preserve backend behavior and reject browser RPC execution",async t=>{
  const s=await setup(t);await s.apply();
  const functions=(await s.db.query<any>(`SELECT proname,proconfig FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN (
      'profiles_lock_columns','set_scheduled_reels_updated_at','merge_own_analytics_to_leader_posts',
      'pending_feature_extraction','touch_ingestion_jobs_updated_at','claim_next_ingestion_job',
      'handle_new_user','is_admin')`)).rows;
  assert.equal(functions.length,8);
  assert.ok(functions.every(f=>f.proconfig?.includes("search_path=pg_catalog, public, pg_temp")));
  for(const role of ["anon","authenticated"]) {
    const exposed=(await s.db.query<any>(`SELECT proname FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND has_function_privilege($1,oid,'EXECUTE') ORDER BY proname`,[role])).rows;
    assert.deepEqual(exposed,role==="authenticated"?[{proname:"is_admin"}]:[]);
  }
  assert.equal((await asRole(s.db,"service_role","","SELECT * FROM pending_feature_extraction(1)")).rows.length,1);
  assert.equal((await asRole(s.db,"service_role","","SELECT merge_own_analytics_to_leader_posts() AS n")).rows[0].n,1);
  assert.equal((await asRole(s.db,"service_role","","SELECT * FROM claim_next_ingestion_job('synthetic-worker')")).rows[0].attempts,1);
  await asRole(s.db,"service_role","","UPDATE scheduled_reels SET updated_at='2001-01-01' WHERE id=1");
  assert.equal((await s.db.query<any>("SELECT updated_at>'2020-01-01' AS touched FROM scheduled_reels")).rows[0].touched,true);
});
test("missing privacy prerequisites fail atomically instead of silently skipping",async t=>{
  const s=await setup(t);await s.db.exec("DROP MATERIALIZED VIEW caption_performance");
  await assert.rejects(s.apply(),/caption_performance.*required/);
  await s.db.exec("ROLLBACK");
  const r=(await s.db.query<any>("SELECT proconfig FROM pg_proc WHERE proname='profiles_lock_columns'")).rows[0];
  assert.equal(r.proconfig,null);
});
test("inherited browser grants abort the migration and preserve pre-migration state",async t=>{
  const s=await setup(t);
  await s.db.exec("CREATE ROLE legacy_reader; GRANT SELECT ON caption_performance TO legacy_reader; GRANT legacy_reader TO authenticated");
  await assert.rejects(s.apply(),/caption_performance_privileges_not_closed/);
  await s.db.exec("ROLLBACK");
  assert.equal((await s.db.query<any>("SELECT proconfig FROM pg_proc WHERE proname='profiles_lock_columns'")).rows[0].proconfig,null);
});
test("pinned worker paths ignore caller-owned temporary shadow tables",async t=>{
  const s=await setup(t);await s.apply();
  await asRole(s.db,"service_role","","CREATE TEMP TABLE ingestion_jobs(id integer)");
  assert.equal((await asRole(s.db,"service_role","","SELECT * FROM claim_next_ingestion_job('shadow-probe')")).rows[0].job_id,A);
  assert.equal((await asRole(s.db,"service_role","",`SELECT is_admin('${ADMIN}') AS allowed`)).rows[0].allowed,true);
});
