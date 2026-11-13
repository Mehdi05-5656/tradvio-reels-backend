// The Clone8 connector (src/studio-mcp.ts): its switches, sign-in answers, the owner-only gate, and that every tool goes
// through the Studio's own routes as the person (so prices and refusals are the website's), never spending unasked.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { MCP_PATH, MCP_TOOLS, registerMcp, runTool, studioRequest, type StudioCall } from "../src/studio-mcp.ts";
import { accountAccess } from "../src/account-access.ts";

const ON = { STUDIO_MCP_ENABLED: "true", SUPABASE_URL: "https://proj.supabase.co" };
const OPEN = { ...ON, STUDIO_MCP_OPEN: "true" };

/** A fake Studio: records each call and answers like the real routes. */
function fakeStudio(o: { balance?: number; jobStatus?: number; jobBody?: any } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const call: StudioCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/studio/me") return { status: 200, json: { subscription: { plan: { name: "Creator" } }, active: true, balance: o.balance ?? 5000, usage_30d: { jobs: 3 } } };
    if (path === "/api/studio/plans") return { status: 200, json: { tools: { story_explainer: true, story_premium: true, motivation: true } } };
    if (path === "/api/studio/quote") return { status: 200, json: { tool: "kage_motion", credits: body?.options?.engine === "premium" ? 620 : 378, summary: "50 s 3D story" } };
    if (path === "/api/studio/jobs" && method === "POST") return { status: o.jobStatus ?? 201, json: o.jobBody ?? { job: { id: "11111111-2222-3333-4444-555555555555" } } };
    if (path.startsWith("/api/studio/jobs/")) return { status: 200, json: { job: { id: "x", tool: "kage_motion", options: { story: {} }, status: "done", outputs: [{ url: "https://v/1.mp4", poster_url: "https://v/1.jpg" }] } } };
    if (path.startsWith("/api/studio/jobs?")) return { status: 200, json: { jobs: [{ id: "j1", tool: "kage_motion", options: { motivation: {} }, status: "running", created_at: "2026-11-12T10:00:00Z" }] } };
    return { status: 404, json: { error: "not_found" } };
  };
  return { calls, call };
}

test("connector: a make tool without confirm only prices it; nothing is started", async () => {
  const s = fakeStudio();
  const r = await runTool("clone8_make_story", { topic: "How does a hot air balloon fly?" }, s.call);
  assert.ok(!r.isError); assert.equal(r.structuredContent?.started, false); assert.equal(r.structuredContent?.credits, 378);
  assert.ok(!s.calls.some((c) => c.path === "/api/studio/jobs"), "no job without confirm: true");
  // confirm must be exactly true, not a truthy string a model might send
  await runTool("clone8_make_story", { topic: "How does a hot air balloon fly?", confirm: "yes" }, s.call);
  assert.ok(!s.calls.some((c) => c.path === "/api/studio/jobs"));
});

test("connector: confirm starts exactly one job, with the same request the Stories page sends", async () => {
  const s = fakeStudio();
  const r = await runTool("clone8_make_story", { topic: "How does a hot air balloon fly?", engine: "signature", seconds: 48, confirm: true }, s.call);
  assert.equal(r.structuredContent?.started, true); assert.equal(r.structuredContent?.credits, 620);
  const jobs = s.calls.filter((c) => c.path === "/api/studio/jobs"); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].body, { tool: "story", asset_id: null, options: { topic: "How does a hot air balloon fly?", seconds: 50, kind: "explainer", format: "auto", world: "auto", captions: "auto", sidekick: "", stage: "all", engine: "premium" } });
  // express names no engine, as the page does
  assert.equal((studioRequest("clone8_make_story", { topic: "abcdefgh" }) as any).options.engine, undefined);
});

test("connector: the Studio's refusals come back as tool errors, in its words", async () => {
  const short = fakeStudio({ jobStatus: 402, jobBody: { error: "insufficient_credits", needed: 620, balance: 100 } });
  const r = await runTool("clone8_make_story", { topic: "How does a hot air balloon fly?", confirm: true }, short.call);
  assert.equal(r.isError, true); assert.match(r.content[0].text, /needs 620, the balance is 100/);
  const closed = fakeStudio({ jobStatus: 403, jobBody: { error: "tool_not_open", detail: "Stories built from scratch are not open yet" } });
  const c = await runTool("clone8_make_story", { topic: "How does a hot air balloon fly?", confirm: true }, closed.call);
  assert.equal(c.isError, true); assert.equal(c.content[0].text, "Stories built from scratch are not open yet");
  assert.equal((await runTool("clone8_make_story", { topic: "hi" }, fakeStudio().call)).isError, true, "a too-short topic is refused before anything is asked");
});

test("connector: motivation, account, catalog, job and recent read the Studio's own answers", async () => {
  const s = fakeStudio();
  assert.deepEqual((studioRequest("clone8_make_motivation", { script: "  Get up.  ", wide: true }) as any).options, { script: "Get up.", shape: "16:9" });
  assert.deepEqual((studioRequest("clone8_make_motivation", { topic: "discipline", seconds: 50 }) as any).options, { topic: "discipline", seconds: 45, shape: "9:16" });
  assert.match((await runTool("clone8_account", {}, s.call)).content[0].text, /Creator plan · 5000 credits · 3 videos/);
  assert.match((await runTool("clone8_catalog", {}, s.call)).content[0].text, /express or signature/);
  const done = await runTool("clone8_job", { job_id: "11111111-2222-3333-4444-555555555555" }, s.call);
  assert.match(done.content[0].text, /https:\/\/v\/1\.mp4/); assert.match(done.content[0].text, /#studio\/stories/);
  assert.equal((await runTool("clone8_job", { job_id: "../me" }, s.call)).isError, true, "only a job id reaches the route");
  assert.match((await runTool("clone8_recent", {}, s.call)).content[0].text, /motivation · running · j1/);
  for (const t of MCP_TOOLS) if (t.name.startsWith("clone8_make_")) assert.match(t.description, /SPENDS CREDITS/);
});

async function serve(env: Record<string, string>, fetchFn?: typeof fetch) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const u = req.header("x-test-user"); (req as any).auth = u ? { user_id: u, email: "someone@example.com" } : null; next(); });
  registerMcp(app, () => ({}) as any, { env, fetchFn });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => srv.close() };
}
const rpc = (base: string, body: unknown, user?: string) => fetch(`${base}${MCP_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(user ? { "x-test-user": user, authorization: "Bearer t" } : {}) }, body: JSON.stringify(body) });

test("connector over HTTP: off is 404; signed out is 401 naming where to sign in; not open is owner-only", async () => {
  const off = await serve({});
  try {
    assert.equal((await rpc(off.base, {}, "u1")).status, 404);
    assert.equal((await fetch(`${off.base}/.well-known/oauth-protected-resource`)).status, 404);
  } finally { off.close(); }
  const on = await serve(ON);
  try {
    const r = await rpc(on.base, {});
    assert.equal(r.status, 401); assert.match(String(r.headers.get("www-authenticate")), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/api\/studio\/mcp"/);
    const meta = await (await fetch(`${on.base}/.well-known/oauth-protected-resource${MCP_PATH}`)).json();
    assert.deepEqual(meta.authorization_servers, ["https://proj.supabase.co/auth/v1"]); assert.match(meta.resource, /\/api\/studio\/mcp$/);
    // signed in, but not the owner (the admin check finds no confirmed owner email), and the connector not open
    assert.equal((await rpc(on.base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "u1")).status, 403);
  } finally { on.close(); }
});

test("connector over HTTP: when open, a signed-in person lists the tools and a call goes to the Studio as them", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (async (url: any, init: any) => { seen.push({ url: String(url), auth: init?.headers?.authorization ?? null }); return new Response(JSON.stringify({ subscription: null, active: false, balance: 42, usage_30d: { jobs: 0 } }), { status: 200 }); }) as typeof fetch;
  const s = await serve(OPEN, fakeFetch);
  try {
    const init = await rpc(s.base, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, "u1");
    assert.equal(init.status, 200); assert.equal((await init.json()).result.serverInfo.name, "clone8");
    const list = await (await rpc(s.base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "u1")).json();
    assert.deepEqual(list.result.tools.map((t: any) => t.name), MCP_TOOLS.map((t) => t.name));
    const call = await (await rpc(s.base, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clone8_account", arguments: {} } }, "u1")).json();
    assert.match(call.result.content[0].text, /No plan · 42 credits/);
    assert.equal(seen.length, 1); assert.match(seen[0].url, /\/api\/studio\/me$/); assert.equal(seen[0].auth, "Bearer t", "the Studio is asked with the person's own sign-in");
  } finally { s.close(); }
});

test("connector behind the real access boundary: signed out gets the sign-in header; a signed-in customer reaches it", async () => {
  // what production does: resolveAuth's result, then account-access.ts, then the connector. The connector's path must sit
  // where a signed-in customer (not only the operator) is let through, and the boundary's own 401 must carry the header.
  const env = { ...OPEN };
  const saved = { ...process.env }; Object.assign(process.env, env);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const u = req.header("x-test-user"); (req as any).auth = u ? { user_id: u, email: "c@example.com" } : null; (req as any).profile = u ? { user_id: u, role: "client" } : null; next(); });
  app.use(accountAccess((() => ({})) as any));
  const fakeFetch = (async () => new Response(JSON.stringify({ subscription: null, active: true, balance: 7, usage_30d: { jobs: 0 } }), { status: 200 })) as typeof fetch;
  registerMcp(app, () => ({}) as any, { env, fetchFn: fakeFetch });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(MCP_PATH, "/api/studio/mcp");
    const out = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(out.status, 401); assert.match(String(out.headers.get("www-authenticate")), /oauth-protected-resource\/api\/studio\/mcp/);
    const call = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "clone8_account", arguments: {} } }, "customer-1");
    assert.equal(call.status, 200, "a signed-in customer is not refused as a non-operator");
    assert.match((await call.json()).result.content[0].text, /7 credits/);
  } finally { srv.close(); process.env = saved; }
});
