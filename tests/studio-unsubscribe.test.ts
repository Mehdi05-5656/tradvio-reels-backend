import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerStudio } from "../src/studio.js";
import { accountAccess, selfAuthenticatedPost } from "../src/account-access.js";
import { unsubscribeToken } from "../src/studio-mail.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV = { SUPABASE_SERVICE_ROLE_KEY: "k", DASHBOARD_URL: "https://app.clone8.io" };

test("unsubscribe: a confirm page on GET (scanners change nothing), the change on POST, a forged token does nothing", async () => {
  const updates: any[] = [];
  const sb: any = { from: () => { const q: any = { update: (v: any) => { updates.push(v); return q; }, eq: () => q, then: (r: any) => r({ data: null, error: null }) }; return q; } };
  const app = express();
  app.use(express.json());
  app.use(accountAccess(() => sb));
  registerStudio(app, () => sb, { stripe: null as any, env: ENV, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/studio/email/unsubscribe`;
  try {
    const good = `${base}?u=${ANN}&t=${unsubscribeToken(ANN, ENV)}`;
    const page = await fetch(good);
    assert.equal(page.status, 200); assert.match(await page.text(), /<form method="post"/);
    assert.equal(updates.length, 0, "opening the link changes nothing");
    const post = await fetch(good, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.equal(post.status, 200); assert.deepEqual(updates.map((u) => u.email_opt_out), [true]);
    const forged = await fetch(`${base}?u=${ANN}&t=${"x".repeat(32)}`, { method: "POST" });
    assert.equal(forged.status, 400); assert.equal(updates.length, 1);
    assert.equal(selfAuthenticatedPost("/api/studio/email/unsubscribe", "POST"), true);
  } finally { server.close(); }
});
