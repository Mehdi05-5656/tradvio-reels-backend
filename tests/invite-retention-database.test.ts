import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("invite request retention: 24 months from submission, active clients and holds kept, dry run deletes nothing", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
    CREATE TABLE public.client_orgs(id uuid PRIMARY KEY, contact_email text, archived_at timestamptz);
    CREATE TABLE public.client_org_members(org_id uuid, user_id uuid);
  `);
  for (const f of ["20261024110000_invite_requests.sql", "20261026090000_invite_requests_meta_capi.sql"]) await db.exec(readFileSync(`migrations/${f}`, "utf8"));
  const m = readFileSync("migrations/20261026100000_invite_requests_retention.sql", "utf8");
  await db.exec(m); await db.exec(m); // idempotent; pg_cron is absent here, so only the notice path runs

  await db.exec(`
    INSERT INTO client_orgs VALUES ('00000000-0000-0000-0000-00000000000a','Contact@Client.com',null),('00000000-0000-0000-0000-00000000000b','old@archived.com',now());
    INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-0000000000a1','member@client.com');
    INSERT INTO client_org_members VALUES ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1');
    INSERT INTO invite_requests(name,email,company,created_at,retention_hold,retention_hold_reason) VALUES
      ('old applicant','gone@x.com','A', now() - interval '25 months', false, null),
      ('old, archived client','old@archived.com','B', now() - interval '30 months', false, null),
      ('old, client contact','contact@CLIENT.com','C', now() - interval '26 months', false, null),
      ('old, client member','MEMBER@client.com','D', now() - interval '26 months', false, null),
      ('old, legal hold','hold@x.com','E', now() - interval '40 months', true, 'dispute 2028'),
      ('recent applicant','new@x.com','F', now() - interval '23 months', false, null);
  `);
  const names = async () => (await db.query<{ name: string }>(`SELECT name FROM invite_requests ORDER BY name`)).rows.map((r) => r.name);

  const dry = (await db.query<any>(`SELECT * FROM invite_requests_retention_purge(true)`)).rows[0];
  assert.deepEqual(dry, { expired: 5, kept_client: 2, kept_hold: 1, deleted: 0 });
  assert.equal((await names()).length, 6, "dry run deletes nothing");

  const real = (await db.query<any>(`SELECT * FROM invite_requests_retention_purge(false)`)).rows[0];
  assert.deepEqual(real, { expired: 5, kept_client: 2, kept_hold: 1, deleted: 2 });
  assert.deepEqual(await names(), ["old, client contact", "old, client member", "old, legal hold", "recent applicant"]);

  const again = (await db.query<any>(`SELECT * FROM invite_requests_retention_purge(false)`)).rows[0];
  assert.equal(again.deleted, 0, "a second run in the same month finds nothing new");
  const runs = (await db.query<any>(`SELECT dry_run, deleted FROM invite_request_retention_runs ORDER BY id`)).rows;
  assert.deepEqual(runs, [{ dry_run: true, deleted: 0 }, { dry_run: false, deleted: 2 }, { dry_run: false, deleted: 0 }]);

  await assert.rejects(db.exec(`SET ROLE anon; SELECT * FROM invite_requests_retention_purge(false);`), /permission denied/);
});
