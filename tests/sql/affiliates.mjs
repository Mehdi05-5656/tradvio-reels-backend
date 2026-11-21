// The affiliate links migration on a throwaway Postgres (PGlite): it applies, it is additive, and its rules hold.
// Run: node tests/sql/affiliates.mjs   (needs @electric-sql/pglite)
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const here = path.dirname(new URL(import.meta.url).pathname);
const sql = fs.readFileSync(path.join(here, "..", "..", "migrations", "20261128000000_studio_affiliates.sql"), "utf8");
const db = new PGlite();
// the one existing table the migration touches, as it is today (the columns that matter)
await db.exec(`CREATE TABLE public.studio_customers (user_id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'none', plan_id text);
  INSERT INTO public.studio_customers (user_id) VALUES ('22222222-2222-4222-8222-222222222222');`);
let ok = 0; const check = async (name, fn) => { await fn(); ok++; console.log(`ok ${ok} - ${name}`); };
const fails = async (q) => { try { await db.exec(q); } catch { return true; } return false; };

await check("applies, and applies again (IF NOT EXISTS everywhere)", async () => { await db.exec(sql); await db.exec(sql); });
await check("existing rows keep their data; the new columns are empty", async () => {
  const r = await db.query(`SELECT status, affiliate_code, affiliate_at FROM public.studio_customers`);
  assert.deepEqual(r.rows[0], { status: "none", affiliate_code: null, affiliate_at: null });
});
await check("codes: lower-case letters, numbers and dashes, 3 to 32; unique", async () => {
  await db.exec(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('jake', 'Jake'), ('sara-lee-x7k2', 'Sara')`);
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('jake', 'Again')`), "duplicate");
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('Jake', 'Caps')`), "capitals");
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('ab', 'Short')`), "too short");
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('a b', 'Space')`), "space");
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_links (code, name) VALUES ('-x1', 'Dash')`), "leading dash");
  const r = await db.query(`SELECT active FROM public.studio_affiliate_links WHERE code = 'jake'`); assert.equal(r.rows[0].active, true, "active by default");
});
await check("clicks: only for a real link; visitor ids are checked", async () => {
  await db.exec(`INSERT INTO public.studio_affiliate_clicks (code, visitor, device, browser, referrer, landing) VALUES ('jake', 'visitor-123456', 'phone', 'Instagram app', 'l.instagram.com', 'site')`);
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_clicks (code) VALUES ('nobody')`), "unknown code");
  assert.ok(await fails(`INSERT INTO public.studio_affiliate_clicks (code, visitor) VALUES ('jake', 'bad id!')`), "bad visitor id");
});
await check("a customer can point at a real link only", async () => {
  await db.exec(`UPDATE public.studio_customers SET affiliate_code = 'jake', affiliate_at = now()`);
  assert.ok(await fails(`UPDATE public.studio_customers SET affiliate_code = 'nobody'`));
});
await check("row level security is on (service role only, no policies)", async () => {
  const r = await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('studio_affiliate_links', 'studio_affiliate_clicks') ORDER BY relname`);
  assert.deepEqual(r.rows.map((x) => x.relrowsecurity), [true, true]);
});
await check("the undo in the header works", async () => {
  await db.exec(`ALTER TABLE public.studio_customers DROP COLUMN IF EXISTS affiliate_code, DROP COLUMN IF EXISTS affiliate_at; DROP TABLE public.studio_affiliate_clicks, public.studio_affiliate_links;`);
  const r = await db.query(`SELECT count(*)::int n FROM public.studio_customers`); assert.equal(r.rows[0].n, 1);
});
console.log(`\n${ok}/7 passed`);
