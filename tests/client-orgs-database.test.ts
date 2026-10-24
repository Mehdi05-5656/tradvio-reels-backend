import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = "migrations/20261024100000_client_orgs_invites.sql";
const OPERATOR = "71c2308a-9e23-4458-b4f0-df7ae53c841e";
const JANE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const H = (c: string) => c.repeat(64); // a 64-hex "hash" for tests

async function setup(t: any) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE TABLE public.publer_slot_config(phone_slot text PRIMARY KEY, owner_user_id uuid);
    INSERT INTO auth.users VALUES ('${OPERATOR}','operator@synthetic.invalid','{}'),('${JANE}','Jane@Example.com','{}'),('${BOB}','bob@synthetic.invalid','{}');
    INSERT INTO public.publer_slot_config VALUES ('phone_a','${OPERATOR}'),('library_1','${OPERATOR}'),('other','${OPERATOR}');
  `);
  await db.exec(await readFile("migrations/2026_09_07_endpoint_user_auth.sql", "utf8"));
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.exec(await readFile(MIGRATION, "utf8")); // idempotent
  const org = (await db.query<any>(`INSERT INTO client_orgs(name,slug,created_by) VALUES('Tradvio','tradvio','${OPERATOR}') RETURNING id`)).rows[0].id as string;
  await db.exec(`INSERT INTO client_org_accounts(org_id,phone_slot) VALUES('${org}','phone_a'),('${org}','library_1')`);
  const invite = async (hash: string, opts: { email?: string | null; expires?: string; created?: string } = {}) =>
    (await db.query<any>(`INSERT INTO client_invites(org_id,token_hash,email,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [org, hash, opts.email ?? null, OPERATOR, opts.created ?? new Date().toISOString(), opts.expires ?? "2099-01-01T00:00:00Z"])).rows[0].id as string;
  const accept = async (user: string, hash: string) => (await db.query<any>("SELECT client_accept_invite($1,$2) r", [user, hash])).rows[0].r;
  const visible = async (user: string) => (await db.query<any>("SELECT phone_slot FROM client_visible_accounts WHERE user_id=$1 ORDER BY 1", [user])).rows.map((r: any) => r.phone_slot);
  return { db, org, invite, accept, visible };
}

test("accepting an invite grants organization visibility, once, to the right person", async (t) => {
  const { db, org, invite, accept, visible } = await setup(t);
  await invite(H("a"));
  assert.deepEqual(await visible(JANE), []);
  const r = await accept(JANE, H("a"));
  assert.equal(r.org_name, "Tradvio"); assert.equal(r.already_member, false);
  assert.deepEqual(await visible(JANE), ["library_1", "phone_a"]);
  assert.equal((await accept(JANE, H("a"))).already_member, true, "same person twice is a no-op");
  await assert.rejects(accept(BOB, H("a")), /invite_used/);
  assert.deepEqual(await visible(BOB), []);
  // Ownership did not move.
  assert.deepEqual((await db.query<any>("SELECT DISTINCT owner_user_id FROM publer_slot_config")).rows, [{ owner_user_id: OPERATOR }]);
  // Removing an account from the organization removes it from every member's view.
  await db.exec(`DELETE FROM client_org_accounts WHERE org_id='${org}' AND phone_slot='library_1'`);
  assert.deepEqual(await visible(JANE), ["phone_a"]);
  // Archiving the organization hides everything.
  await db.exec(`UPDATE client_orgs SET archived_at=now() WHERE id='${org}'`);
  assert.deepEqual(await visible(JANE), []);
});

test("expired, revoked, unknown and address-bound invites are refused with named reasons", async (t) => {
  const { db, invite, accept } = await setup(t);
  await assert.rejects(invite(H("b"), { expires: "2000-01-01T00:00:00Z" }), /violates check constraint/, "an invite cannot expire before it is created");
  await invite(H("c"), { created: new Date(Date.now() - 2 * 3600_000).toISOString(), expires: new Date(Date.now() - 60_000).toISOString() });
  await assert.rejects(accept(JANE, H("c")), /invite_expired/);
  const d = await invite(H("d")); await db.exec(`UPDATE client_invites SET revoked_at=now() WHERE id='${d}'`);
  await assert.rejects(accept(JANE, H("d")), /invite_revoked/);
  await assert.rejects(accept(JANE, H("e")), /invite_invalid/);
  await assert.rejects(accept(JANE, "not-a-hash"), /invite_invalid/);
  await invite(H("f"), { email: "jane@example.com" });
  await assert.rejects(accept(BOB, H("f")), /invite_email_mismatch/);
  assert.equal((await accept(JANE, H("f"))).already_member, false, "address match is case-insensitive");
  await assert.rejects(invite("tooshort"), /violates check constraint/);
});

test("browser roles cannot read organizations, invites or the accept function; only the server can", async (t) => {
  const { db } = await setup(t);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const rel of ["client_orgs", "client_org_members", "client_org_accounts", "client_invites", "client_visible_accounts"])
        await assert.rejects(db.query(`SELECT * FROM ${rel}`), /permission denied/, `${role} ${rel}`);
      await assert.rejects(db.query(`SELECT client_accept_invite('${JANE}','${H("a")}')`), /permission denied/);
    } finally { await db.exec("RESET ROLE"); }
  }
  await db.exec("SET ROLE service_role");
  try { assert.equal((await db.query<any>("SELECT count(*)::int n FROM client_orgs")).rows[0].n, 1); } finally { await db.exec("RESET ROLE"); }
});
