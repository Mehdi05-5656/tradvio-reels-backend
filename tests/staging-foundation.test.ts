import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
test("clean staging foundation has no real data and structurally rejects activation",async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb,
      email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public,storage TO anon,authenticated,service_role;
  `);
  for(const file of [
    "staging/foundation.sql","migrations/2026_09_07_endpoint_user_auth.sql",
    "migrations/20260924001500_managed_provisioning.sql",
    "migrations/20260924010000_managed_generation.sql",
    "migrations/20260924020000_managed_handoff.sql","staging/lockdown.sql",
  ])await db.exec(await readFile(file,"utf8"));
  const rows=(await db.exec(await readFile("staging/database-audit.sql","utf8")))
    .flatMap(r=>r.rows as any[]);
  assert.equal(rows.filter(r=>r.check_name).length,8);
  assert.ok(rows.filter(r=>r.check_name).every(r=>r.passed));
  assert.ok(rows.filter(r=>r.relname).every(r=>r.relrowsecurity&&!r.anon_has_any_access&&!r.customer_has_any_access));
  assert.ok(rows.filter(r=>r.signature).every(r=>!r.anon_can_execute&&!r.customer_can_execute));
  for(const table of ["managed_generation_control","managed_handoff_control"]) {
    await assert.rejects(db.exec(`UPDATE ${table} SET enabled=true`),/staging_.*_off/);
  }
  await assert.rejects(db.exec("INSERT INTO publer_slot_config VALUES('synthetic','not-a-provider-id',false)"),/check constraint/);
  assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM auth.users")).rows[0].n,0);
  assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM managed_accounts")).rows[0].n,0);
  const constraints=(await db.query<any>("SELECT conname FROM pg_constraint WHERE conname LIKE 'staging_%'")).rows;
  assert.ok(constraints.some(r=>r.conname==="staging_handoff_no_remote"));
  assert.ok(constraints.some(r=>r.conname==="staging_account_publishing_off"));
  await assert.rejects(db.exec(await readFile("staging/foundation.sql","utf8")),/empty_staging_schema_required/);
});
