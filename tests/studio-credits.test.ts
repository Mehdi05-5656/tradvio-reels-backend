import { test } from "node:test";
import assert from "node:assert/strict";
import { grantForYear } from "../src/studio-credits.ts";

test("a year's credits: studio_grant_until; a plain grant only if the database does not have it yet", async () => {
  const calls: any[] = [];
  const sb = (missing: boolean): any => ({ rpc: async (name: string, args: any) => { calls.push({ name, args }); return name === "studio_grant_until" && missing ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.studio_grant_until" } } : { data: { granted: true }, error: null }; } });
  const a = { user: "u", credits: 42000, ref: "in_1", until: "2027-11-15T00:00:00.000Z", note: "Creator annual" };
  await grantForYear(sb(false), a);
  assert.deepEqual(calls.map((c) => c.name), ["studio_grant_until"]); assert.equal(calls[0].args.p_until, a.until);
  calls.length = 0; const r = await grantForYear(sb(true), a);
  assert.deepEqual(calls.map((c) => c.name), ["studio_grant_until", "studio_grant"]); assert.equal(calls[1].args.p_credits, 42000); assert.equal(r.error, null);
  // any other error is the caller's (Stripe retries the event), never hidden behind a plain grant
  const other: any = { rpc: async () => ({ data: null, error: { code: "P0001", message: "invalid_credits" } }) };
  assert.equal((await grantForYear(other, a)).error?.message, "invalid_credits");
});
