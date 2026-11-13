// Signature written by the person's own AI (src/studio-byo.ts, the connector's scene tools in src/studio-mcp.ts, the
// price in src/studio-stories.ts): who may ask, what it costs, the brief in parts, one call at a time, answers with
// their pictures, the waiting room after finish. The worker's side is kage-motion worker/test/hand-byo.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { BRIEF_PART_CHARS, briefParts, registerByo } from "../src/studio-byo.ts";
import { BYO_MCP_TOOLS, MCP_TOOLS, mcpServer, runTool, studioRequest, type StudioCall } from "../src/studio-mcp.ts";
import { StoryError, parseStoryOptions, quoteStory, storyByoCostUsd, storyByoMargin, storyByoMinMargin } from "../src/studio-stories.ts";
import { PLANS as LIVE_PLANS } from "../src/studio.ts";
import { creditValueFloor, creditsForCost } from "../src/studio-pricing.ts";

const PLANS = [{ id: "starter", monthly_usd: 29, annual_usd_per_month: 24, credits: 1000 }, { id: "studio", monthly_usd: 199, annual_usd_per_month: 166, credits: 10000 }];
const LIVE = { STUDIO_STORIES_ENABLED: "true", STUDIO_KAGE_MOTION_ENABLED: "true", STUDIO_STORY_EXPLAINER_ENABLED: "true", STUDIO_STORY_EXPLAINER_OPEN: "true", STUDIO_STORY_PREMIUM_ENABLED: "true", STUDIO_STORY_PREMIUM_OPEN: "true", STUDIO_STORY_PREMIUM_COST_USD: "2.95", STUDIO_STORY_PREMIUM_MARGIN: "0.6095" };
const BYO = { ...LIVE, STUDIO_STORY_BYO_ENABLED: "true" };
const ask = { topic: "Want a treehouse in your backyard?", kind: "explainer", seconds: 50, engine: "premium", byo: true };

test("in-chat Signature: off, owner-only, then open; priced from its own cost at Signature's margin; only for Signature", () => {
  assert.throws(() => quoteStory(LIVE, PLANS, ask, { owner: true }), (e: any) => e instanceof StoryError && e.code === "story_byo_off" && e.status === 403, "not switched on: refused, even for the owner");
  assert.throws(() => quoteStory(BYO, PLANS, ask), (e: any) => e.code === "story_byo_off", "switched on but not open: customers are refused");
  const q = quoteStory(BYO, PLANS, ask, { owner: true });
  assert.deepEqual(q.options.story, { topic: ask.topic, seconds: 50, kind: "explainer", engine: "premium", byo: true }); assert.equal(q.options.cost_usd, 1.2);
  assert.equal(storyByoMargin(BYO), 0.5, "the house margin, not Signature's"); assert.equal(storyByoMinMargin(BYO), 0.45);
  assert.equal(q.credits, creditsForCost(1.2, creditValueFloor(PLANS), 0.5));
  // the ceiling handed to the worker: what the credits earn at the cheapest credit, less the 45 % floor
  assert.equal(q.options.cost_cap_usd, Math.floor(q.credits * creditValueFloor(PLANS) * 0.55 * 100) / 100);
  // on the live plans: 150 credits, and a film may cost us at most $1.32
  const live = quoteStory(BYO, LIVE_PLANS as any, ask, { owner: true }); assert.equal(live.credits, 150); assert.equal(live.options.cost_cap_usd, 1.32);
  assert.ok(live.options.cost_cap_usd / (live.credits * creditValueFloor(LIVE_PLANS as any)) <= 0.55 + 1e-9, "at the ceiling the margin is still 45 % or more");
  assert.equal(quoteStory({ ...BYO, STUDIO_STORY_BYO_MIN_MARGIN: "0.5" }, LIVE_PLANS as any, ask, { owner: true }).options.cost_cap_usd, 1.2);
  assert.equal(quoteStory(BYO, PLANS, { ...ask, byo: undefined }, { owner: true }).options.cost_cap_usd, undefined, "only films written in a chat carry a ceiling");
  const full = quoteStory(BYO, PLANS, { ...ask, byo: undefined }, { owner: true });
  assert.ok(q.credits < full.credits * 0.5, `written in the chat is under half Signature's price (${q.credits} against ${full.credits})`);
  assert.match(q.summary, /written in your own chat/);
  assert.equal(quoteStory({ ...BYO, STUDIO_STORY_BYO_OPEN: "true" }, PLANS, ask).credits, q.credits, "open: everyone, same price");
  assert.equal(storyByoCostUsd({ STUDIO_STORY_BYO_COST_USD: "1.5" }), 1.5);
  assert.throws(() => parseStoryOptions({ ...ask, engine: undefined }), (e: any) => e.code === "story_engine", "only a Signature story can be written in a chat");
  assert.equal(parseStoryOptions({ ...ask, byo: "yes" }).byo, undefined, "only true asks for it");
});

test("the brief comes in parts that are cut at line ends and add up to the whole", () => {
  const text = Array.from({ length: 9000 }, (_, i) => `line ${i} ${"x".repeat(i % 50)}`).join("\n");
  const parts = briefParts(text); assert.ok(parts.length > 1); assert.equal(parts.join(""), text);
  for (const p of parts.slice(0, -1)) { assert.ok(p.length <= BRIEF_PART_CHARS); assert.ok(p.endsWith("\n")); }
  assert.deepEqual(briefParts(""), [""]);
});

// ---- an in-memory Supabase: the two tables and the work folder, with the query shapes the routes use
function fakeDb() {
  const t: Record<string, any[]> = { studio_jobs: [], studio_byo_calls: [] }; const files = new Map<string, Buffer>(); let seq = 0;
  const q = (table: string) => {
    const f: Array<(r: any) => boolean> = []; let ord: { k: string; asc: boolean } | null = null, lim = Infinity, patch: any = null, inserted: any = null;
    const rows = () => { let r = t[table].filter((x) => f.every((g) => g(x))); if (ord) r = [...r].sort((a, b) => (a[ord!.k] - b[ord!.k]) * (ord!.asc ? 1 : -1)); return r.slice(0, lim); };
    const done = () => { if (inserted) return { data: inserted, error: null }; if (patch) { for (const r of rows()) Object.assign(r, patch); return { data: rows(), error: null }; } return { data: rows(), error: null }; };
    const b: any = {
      select: () => b, eq: (k: string, v: any) => { f.push((r) => r[k] === v); return b; }, in: (k: string, v: any[]) => { f.push((r) => v.includes(r[k])); return b; }, is: (k: string, v: any) => { f.push((r) => (r[k] ?? null) === v); return b; },
      order: (k: string, o: any) => { ord = { k, asc: o?.ascending !== false }; return b; }, limit: (n: number) => { lim = n; return b; },
      insert: (v: any) => { inserted = { id: ++seq, delivered_at: null, started_at: null, result: null, created_at: new Date().toISOString(), ...v }; t[table].push(inserted); return b; },
      update: (v: any) => { patch = v; return b; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }), single: async () => ({ data: inserted ?? rows()[0], error: null }),
      then: (ok: any, no: any) => Promise.resolve(done()).then(ok, no),
    };
    return b;
  };
  const sb: any = { from: q, storage: { from: () => ({ download: async (k: string) => (files.has(k) ? { data: new Blob([files.get(k)!]), error: null } : { data: null, error: { message: "missing" } }) }) } };
  return { sb, t, files };
}
async function serve(db: ReturnType<typeof fakeDb>) {
  const app = express(); app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => { const u = req.header("x-test-user"); (req as any).auth = u ? { user_id: u } : null; next(); });
  registerByo(app, () => db.sb, { pollMs: 10 });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => srv.close() };
}
const JOB = "11111111-2222-3333-4444-555555555555";
const job = (over: any = {}) => ({ id: JOB, user_id: "u1", status: "running", tool: "kage_motion", options: { story: { byo: true, engine: "premium" } }, progress: { note: "Writing the script" }, error_code: null, ...over });
/** the worker: answers each pending call after `ms` */
function worker(db: ReturnType<typeof fakeDb>, ms: number, reply: (tool: string, input: any) => any) {
  let on = true; const tick = async () => { while (on) { for (const r of db.t.studio_byo_calls.filter((x) => x.kind === "call" && x.status === "pending")) { r.status = "running"; r.started_at = new Date().toISOString(); setTimeout(() => { Object.assign(r, { status: "done", result: reply(r.tool, r.input) }); }, ms); } await new Promise((s) => setTimeout(s, 5)); } };
  void tick(); return () => { on = false; };
}
const get = (base: string, path: string, user = "u1") => fetch(`${base}${path}`, { headers: { "x-test-user": user } }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const post = (base: string, path: string, body: any, user = "u1") => fetch(`${base}${path}`, { method: "POST", headers: { "x-test-user": user, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));

test("routes: only the person's own in-chat job; the brief once it is posted; calls answered with their pictures; one at a time", async () => {
  const db = fakeDb(); db.t.studio_jobs.push(job(), job({ id: "99999999-2222-3333-4444-555555555555", options: { story: { engine: "premium" } } })); db.files.set("k/sheet.jpg", Buffer.from("JPEGDATA"));
  const s = await serve(db); const stop = worker(db, 30, (tool, input) => (tool === "render_stills" ? { text: `frames ${input.frames.join(", ")}`, image: "k/sheet.jpg" } : { text: `${tool} ok` }));
  try {
    assert.equal((await get(s.base, `/api/studio/byo/${JOB}/brief`, "someone-else")).status, 404, "another person's film");
    assert.equal((await get(s.base, `/api/studio/byo/99999999-2222-3333-4444-555555555555/brief`)).status, 404, "a film not written in a chat");
    assert.equal((await get(s.base, `/api/studio/byo/${JOB}/brief`, "")).status, 401);
    assert.deepEqual((await get(s.base, `/api/studio/byo/${JOB}/brief`)).json, { ready: false, status: "running", note: "Writing the script", error: null });
    db.t.studio_byo_calls.push({ id: 900, job_id: JOB, kind: "brief", tool: "brief", status: "done", result: { text: "a\n".repeat(40_000) } });
    const b1 = (await get(s.base, `/api/studio/byo/${JOB}/brief?part=1`)).json; assert.equal(b1.ready, true); assert.equal(b1.parts, 2); assert.equal(b1.part, 1);
    assert.equal((await get(s.base, `/api/studio/byo/${JOB}/brief?part=7`)).json.part, 2, "past the end: the last part");
    assert.equal((await post(s.base, `/api/studio/byo/${JOB}/calls`, { tool: "rm_rf", input: {} })).status, 400, "only the six tools");
    const st = await post(s.base, `/api/studio/byo/${JOB}/calls?wait=5`, { tool: "render_stills", input: { frames: [0, 30] } });
    assert.equal(st.status, 200); assert.equal(st.json.done, true); assert.equal(st.json.text, "frames 0, 30"); assert.deepEqual(st.json.images, [Buffer.from("JPEGDATA").toString("base64")]);
    const row = db.t.studio_byo_calls.find((r) => r.id === st.json.call_id); assert.equal(row.user_id, "u1"); assert.ok(row.delivered_at, "an answer handed over is not handed over again");
    // a slow call: not answered within the wait, then fetched with wait; a second call meanwhile is refused
    stop(); const slow = worker(db, 400, () => ({ text: "preview done", image: "k/sheet.jpg" }));
    const pv = await post(s.base, `/api/studio/byo/${JOB}/calls?wait=0`, { tool: "render_preview", input: {} }); assert.equal(pv.json.done, false); assert.match(pv.json.text, /clone8_scene_wait/);
    const busy = await post(s.base, `/api/studio/byo/${JOB}/calls?wait=0`, { tool: "typecheck", input: {} }); assert.equal(busy.status, 409); assert.equal(busy.json.error, "busy");
    const w = await get(s.base, `/api/studio/byo/${JOB}/wait?wait=5`); assert.equal(w.json.kind, "call"); assert.equal(w.json.tool, "render_preview"); assert.equal(w.json.text, "preview done"); assert.equal(w.json.images.length, 1);
    slow();
    // the next round's opening reaches the chat through wait; then the state; a finished film refuses calls
    db.t.studio_byo_calls.push({ id: 950, job_id: JOB, kind: "message", tool: "message", status: "done", result: { text: "line 3 was not shown", images: ["k/sheet.jpg"] }, delivered_at: null });
    const m = await get(s.base, `/api/studio/byo/${JOB}/wait?wait=1`); assert.equal(m.json.kind, "message"); assert.equal(m.json.text, "line 3 was not shown"); assert.equal(m.json.images.length, 1);
    const idle = await get(s.base, `/api/studio/byo/${JOB}/wait?wait=0`); assert.equal(idle.json.kind, "state"); assert.match(idle.json.text, /Nothing new yet/);
    db.t.studio_jobs[0].status = "done";
    assert.match((await get(s.base, `/api/studio/byo/${JOB}/wait?wait=0`)).json.text, /finished/);
    assert.equal((await post(s.base, `/api/studio/byo/${JOB}/calls`, { tool: "typecheck", input: {} })).status, 409);
  } finally { stop(); s.close(); }
});

test("connector: the in-chat tools are listed only when allowed; the start tool prices first; scene tools pass pictures on", async () => {
  for (const t of BYO_MCP_TOOLS) { assert.ok((t as any).title, t.name); assert.equal(typeof (t as any).annotations.readOnlyHint, "boolean"); }
  const list = async (byo: boolean) => { const server = mcpServer((async () => ({ status: 200, json: {} })) as StudioCall, { base: "https://x", byo }); const h = (server as any)._requestHandlers.get("tools/list"); return (await h({ method: "tools/list", params: {} }, {})).tools.map((t: any) => t.name); };
  assert.deepEqual(await list(false), MCP_TOOLS.map((t) => t.name)); assert.ok((await list(true)).includes("clone8_make_signature_in_chat"));
  assert.deepEqual((studioRequest("clone8_make_signature_in_chat", { topic: "Want a treehouse?" }) as any).options, { topic: "Want a treehouse?", seconds: 50, kind: "explainer", format: "auto", world: "auto", captions: "auto", sidekick: "", stage: "all", engine: "premium", byo: true });
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const call: StudioCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/studio/me") return { status: 200, json: { active: true, balance: 5000 } };
    if (path === "/api/studio/quote") return { status: 200, json: { credits: 191, summary: "50 s 3D story · Signature, the scene written in your own chat" } };
    if (path === "/api/studio/jobs" && method === "POST") return { status: 201, json: { job: { id: JOB } } };
    if (path.includes("/calls")) return { status: 200, json: { done: true, call_id: 5, text: "frames 0, 30", images: ["QUJD"] } };
    if (path.includes("/brief")) return { status: 200, json: { ready: true, part: 1, parts: 5, text: "THE RULES" } };
    if (path.includes("/wait")) return { status: 200, json: { kind: "message", text: "Your film: ...", images: [] } };
    return { status: 404, json: {} };
  };
  const price = await runTool("clone8_make_signature_in_chat", { topic: "Want a treehouse?" }, call); assert.equal(price.structuredContent?.started, false); assert.ok(!calls.some((c) => c.path === "/api/studio/jobs"));
  const go = await runTool("clone8_make_signature_in_chat", { topic: "Want a treehouse?", confirm: true }, call); assert.equal(go.structuredContent?.job_id, JOB); assert.match(go.content[0].type === "text" ? go.content[0].text : "", /clone8_scene_brief/);
  const br = await runTool("clone8_scene_brief", { job_id: JOB, part: 1 }, call); assert.match((br.content[0] as any).text, /part 1 of 5[\s\S]*THE RULES[\s\S]*Read part 2 next/);
  const st = await runTool("clone8_render_stills", { job_id: JOB, frames: [0, 30] }, call);
  assert.deepEqual(calls[calls.length - 1], { method: "POST", path: `/api/studio/byo/${JOB}/calls?wait=40`, body: { tool: "render_stills", input: { frames: [0, 30] } } }, "the job_id stays out of the tool's input");
  assert.deepEqual(st.content[1], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
  assert.match((await runTool("clone8_scene_wait", { job_id: JOB }, call)).content[0].type, /text/);
  assert.equal((await runTool("clone8_write_scene", { job_id: "../me", code: "x" }, call)).isError, true, "only a job id reaches the routes");
});
