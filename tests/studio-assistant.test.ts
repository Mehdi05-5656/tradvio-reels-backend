import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFile } from "node:fs/promises";
import { accountAccess } from "../src/account-access.js";
import { COSTS, PLANS } from "../src/studio.js";
import { buildSystemPrompt, PRESET_CHARACTERS } from "../src/studio-knowledge.js";
import { pricePlan, runTurn, startRun, advanceRun, importLink, linkPlatform, findMediaUrl, registerAssistant, startAssistantLoop, TOOLS, AssistantError, expectedOutput, type Conversation } from "../src/studio-assistant.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", CAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", CONVO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENV: Record<string, string | undefined> = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true", STUDIO_BLUEPRINT_ENABLED: "true", STUDIO_RECAST_FULL_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test", SCRAPECREATORS_API_KEY: "sc-test" };
const STYLES = [{ id: "11111111-1111-4111-8111-111111111111", name: "Anime", preview_url: null }, { id: "22222222-2222-4222-8222-222222222222", name: "Clay", preview_url: null }];
const video = { id: VID, user_id: ANN, kind: "video", name: "podcast.mp4", object_key: `${ANN}/${VID}.mp4`, bytes: 1000, status: "ready", probe: { duration: 12.2 } };
const cat = { id: CAT, user_id: ANN, kind: "image", name: "Orange cat.jpg", object_key: `${ANN}/${CAT}.jpg`, bytes: 100, status: "ready", probe: { character: true, prompt: "an orange cat" } };

// A small in-memory Supabase stand-in with storage: filters by eq/in/neq/gte, records writes and rpc calls.
function fakeSb(tables: Record<string, any[]>, rpc: (name: string, args: any) => { data: any; error: any } = () => ({ data: null, error: null })) {
  const writes: any[] = [], calls: any[] = [], uploads: any[] = [];
  const sb: any = {
    writes, calls, uploads, tables,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return rpc(name, args); },
    storage: { from: (bucket: string) => ({
      upload: async (key: string, bytes: any, o: any) => { uploads.push({ bucket, key, bytes: bytes.length, type: o?.contentType }); return { data: { path: key }, error: null }; },
      download: async (key: string) => ({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }, error: null }),
      createSignedUrl: async (k: string, _e: number, o?: any) => ({ data: { signedUrl: `https://signed/${k}${o?.download ? `?download=${encodeURIComponent(o.download)}` : ""}` }, error: null }),
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
    }) },
    from(table: string) {
      let rows = () => tables[table] ?? [];
      const filters: ((r: any) => boolean)[] = [];
      let single = false, maybe = false, pending: any = null, head = false;
      const q: any = {
        select(_c?: any, o?: any) { if (o?.head) head = true; return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { table, op: "insert", v }; rows = () => (Array.isArray(v) ? v : [v]); return q; },
        update(v: any) { pending = { table, op: "update", v }; return q; },
        then(resolve: any, reject: any) {
          if (pending) {
            writes.push({ ...pending, filters: filters.length });
            if (pending.op === "insert") { const v = { id: CONVO, title: "New chat", status: "open", messages: [], plan: null, run: null, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z", ...pending.v }; (tables[table] ??= []).push(v); rows = () => [v]; }
            if (pending.op === "update") { const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); for (const r of hit) Object.assign(r, pending.v); rows = () => hit; filters.length = 0; }
          }
          const out = rows().filter((r) => filters.every((f) => f(r)));
          const data = head ? null : single || maybe ? (out[0] ?? null) : out;
          return Promise.resolve({ data, error: single && !out.length ? { message: "no rows" } : null, count: head ? out.length : null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return sb;
}
const baseTables = () => ({ studio_assets: [video, cat], studio_customers: [{ user_id: ANN, plan_id: "creator", status: "active", parallel_jobs: 2 }], studio_jobs: [] as any[], studio_conversations: [] as any[] });
const rpcs = (tables: Record<string, any[]>) => (name: string, args: any) => {
  if (name === "studio_balance") return { data: 5000, error: null };
  if (name === "studio_create_job") { const j = { id: `job-${tables.studio_jobs.length + 1}`, user_id: ANN, tool: args.p_tool, status: "queued", asset_id: args.p_asset, options: args.p_options, credits_reserved: args.p_credits, outputs: [], progress: {}, created_at: "2026-10-29T00:00:00Z" }; tables.studio_jobs.push(j); return { data: j, error: null }; }
  if (name === "studio_cancel") return { data: null, error: null };
  return { data: null, error: null };
};
const convo = (over: Partial<Conversation> = {}): Conversation => ({ id: CONVO, user_id: ANN, title: "New chat", status: "open", messages: [], plan: null, run: null, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z", ...over });
/** A Claude stand-in: answers each call from a script of replies; records what it was asked. */
function fakeClaude(replies: any[], scrape?: (url: string) => any) {
  const asked: any[] = [];
  const fetchFn: any = async (url: string, init: any) => {
    if (url.startsWith("https://api.anthropic.com")) { asked.push(JSON.parse(init.body)); const r = replies.shift(); if (!r) return new Response(JSON.stringify({ error: "script ran out" }), { status: 500 }); return new Response(JSON.stringify(r), { status: 200 }); }
    if (url.startsWith("https://api.scrapecreators.com")) return new Response(JSON.stringify(scrape ? scrape(url) : {}), { status: 200 });
    if (url.startsWith("https://cdn.example/")) return new Response(new Uint8Array(2048), { status: 200 });
    if (url.startsWith("https://api.higgsfield.ai/estimate/")) return new Response(JSON.stringify({ usd: 0.4 }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchFn, asked };
}
const textReply = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const toolReply = (name: string, input: any, text?: string) => ({ stop_reason: "tool_use", content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: "tu_1", name, input }] });
const deps = (fetchFn: any, over: any = {}) => ({ fetch: fetchFn, env: ENV, log: () => {}, styles: async () => STYLES, probeSeconds: async () => 7.5, poster: async (_v: string, target: string) => { await writeFile(target, new Uint8Array([0xff, 0xd8])); }, ...over });
const ctxFor = (sb: any) => ({ sb, u: ANN, env: ENV, assets: new Map([[VID, video], [CAT, cat]]), styles: STYLES, deps: deps(fakeClaude([]).fetchFn), tools: { blueprint: true, recast: true, recast_full: true, swap: true, restyle: true, trend: true, character: true, instrument: true, assistant: true } });

test("the system prompt teaches the tools, prices, library and rules, and never the Blueprint method or keys", () => {
  const p = buildSystemPrompt({ tools: ctxFor(null).tools, costs: COSTS, plans: PLANS, env: ENV, styles: STYLES, today: "2026-10-29",
    user: { plan: "creator", status: "active", balance: 5000, parallel_jobs: 2, assets: [{ id: VID, kind: "video", name: "podcast.mp4", seconds: 12.2 }, { id: CAT, kind: "image", name: "Orange cat.jpg", seconds: null, character: true, prompt: "an orange cat" }], recent_jobs: [] } });
  for (const must of ["Blueprint", "Recast", "Swap", "Styles", "Trends", "Characters", "Instruments", "fetch_link", "propose_plan", "Anime, Clay", "Balance: 5000", "podcast.mp4", "made character: an orange cat", `${COSTS.blueprint_copy} credits a copy`, "z-image/turbo", "Never describe how Blueprint", "celebrity"]) assert.ok(p.includes(must), `missing ${must}`);
  const prose = p.slice(0, p.indexOf("INSTRUMENTS (id"));
  for (const never of ["sk-test", "id:secret", "crop", "speed", "frame rate", "metadata", "Higgsfield", "ScrapeCreators", "margin", "Anthropic", "Claude"]) assert.ok(!prose.toLowerCase().includes(never.toLowerCase()), `leaks ${never}`);
  assert.ok(!p.includes("sk-test") && !p.includes("id:secret"));
  assert.match(p, /never say an id, a vendor or a provider/);
  assert.ok(PRESET_CHARACTERS.every((c) => p.includes(c.name)));
  assert.equal(TOOLS.map((t) => t.name).join(","), "propose_plan,fetch_link");
});

test("plans are priced step by step: concrete sources through the Studio quote, chained steps estimated and flagged", async () => {
  const ctx = ctxFor(fakeSb(baseTables()));
  const plan = await pricePlan(ctx as any, { title: "Cat podcast, ten originals", steps: [
    { tool: "swap", label: "Make the host a cat", source: VID, options: { model: "light", character_asset_id: CAT, prompt: "keep the mic" } },
    { tool: "blueprint", label: "Ten originals", source: "$1", options: { copies: 10 } },
  ] });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].credits, 13 * COSTS.recast_light_second, "12.2 s rounds to 13 billable seconds");
  assert.equal(plan.steps[0].estimate, false);
  assert.deepEqual(plan.steps[0].options.character_asset_id, CAT);
  assert.equal(plan.steps[1].source, "$1");
  assert.equal(plan.steps[1].credits, 10 * COSTS.blueprint_copy);
  assert.equal(plan.steps[1].estimate, true, "a step on a future output is an estimate");
  assert.equal(plan.total_credits, 13 * COSTS.recast_light_second + 10 * COSTS.blueprint_copy);
  assert.equal(plan.estimate, true);
  assert.equal(plan.status, "proposed");
  // a made character from a character step, by reference, then a preset by name
  const p2 = await pricePlan(ctx as any, { title: "New face", steps: [
    { tool: "character", label: "Make a fox", options: { mode: "animal", prompt: "a red fox in a hoodie" } },
    { tool: "recast", label: "Recast as the fox", source: VID, options: { model: "full", character_asset_id: "$1" } },
    { tool: "trend", label: "Noah does the dance", options: { trend_id: "dance-headphones", model: "light", character: "Noah" } },
  ] });
  assert.equal(p2.steps[0].output, "image");
  assert.equal(p2.steps[0].credits, COSTS.character_image);
  assert.equal(p2.steps[1].options.character_asset_id, "$1");
  assert.equal(p2.steps[1].estimate, true);
  assert.equal(p2.steps[2].options.character, "noah");
  assert.equal(p2.steps[2].estimate, false);
  // instruments: concrete inputs are estimated live; a "$N" input falls back to the list price
  const p3 = await pricePlan(ctx as any, { title: "Animate", steps: [
    { tool: "instrument", label: "A fox picture", options: { endpoint: "z-image/turbo", params: { prompt: "a fox" } } },
    { tool: "instrument", label: "Make it move", options: { endpoint: "wan/v2.7/image-to-video", params: { prompt: "the fox turns", duration: 5 }, inputs: { image_url: "$1" } } },
  ] });
  assert.equal(p3.steps[0].output, "image");
  assert.ok(p3.steps[0].credits > 0);
  assert.equal(p3.steps[1].estimate, true);
  assert.deepEqual(p3.steps[1].options.inputs, { image_url: "$1" });
  assert.ok(p3.steps[1].credits > 0, "list price for Wan image-to-video");
});

test("plans the model gets wrong are refused with a reason it can act on", async () => {
  const ctx = ctxFor(fakeSb(baseTables()));
  const bad = async (steps: any[], code: string, re: RegExp) => { await assert.rejects(pricePlan(ctx as any, { title: "x", steps }), (e: any) => { assert.ok(e instanceof AssistantError); assert.equal(e.code, code); assert.match(e.message, re); return true; }); };
  await bad([{ tool: "blueprint", label: "x", source: "$2", options: { copies: 1 } }, { tool: "blueprint", label: "y", source: VID, options: { copies: 1 } }], "plan_invalid", /comes later/);
  await bad([{ tool: "character", label: "x", options: { mode: "animal", prompt: "a fox" } }, { tool: "blueprint", label: "y", source: "$1", options: { copies: 1 } }], "plan_invalid", /makes a image|needs a video/);
  await bad([{ tool: "blueprint", label: "x", source: CAT, options: { copies: 1 } }], "plan_invalid", /is a image/);
  await bad([{ tool: "restyle", label: "x", source: VID, options: { style_name: "Watercolour" } }], "plan_invalid", /Styles: Anime, Clay/);
  await bad([{ tool: "recast", label: "x", source: VID, options: { model: "light", character: "Tom Cruise" } }], "plan_invalid", /no character called/);
  await bad([{ tool: "swap", label: "x", source: "99999999-9999-4999-8999-999999999999", options: { character: "noah" } }], "plan_invalid", /no file with id/);
  await bad([{ tool: "instrument", label: "x", options: { endpoint: "nope/model" } }], "plan_invalid", /not offered/);
  await bad([], "plan_invalid", /at least one step/);
  const closed = { ...ctx, tools: { ...ctx.tools, blueprint: false } };
  await assert.rejects(pricePlan(closed as any, { title: "x", steps: [{ tool: "blueprint", label: "x", source: VID, options: { copies: 1 } }] }), (e: any) => e.code === "plan_invalid" && /not taking jobs/.test(e.message));
  assert.deepEqual(expectedOutput("character", {}, null), { output: "image", seconds: null });
  assert.deepEqual(expectedOutput("trend", { trend_id: "dance-headphones" }, null).output, "video");
});

test("a turn: the model proposes a plan through the tool, the plan is priced and saved with the reply", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("propose_plan", { title: "Cat podcast, ten originals", steps: [{ tool: "swap", label: "Host becomes the cat", source: VID, options: { model: "light", character_asset_id: CAT } }, { tool: "blueprint", label: "Ten originals", source: "$1", options: { copies: 10 } }] }),
    textReply("The host becomes your orange cat, then Blueprint makes ten originals of that video. Confirm in the card to start."),
  ]);
  const c = convo(); tables.studio_conversations.push(c);
  const out = await runTurn(sb, deps(fetchFn), c, { text: "turn this podcast into a cat video and make ten originals of it", attachments: [{ asset_id: VID, name: "podcast.mp4", kind: "video", seconds: 12.2 }], links: [] });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[1].role, "assistant");
  assert.match(out.messages[1].text, /Confirm in the card/);
  assert.equal(out.messages[1].plan_id, out.plan!.id);
  assert.equal(out.plan!.steps.length, 2);
  assert.equal(out.plan!.total_credits, 13 * COSTS.recast_light_second + 10 * COSTS.blueprint_copy);
  assert.equal(out.title, "Cat podcast, ten originals", "the plan names the chat");
  // the model saw the library and the attachment, and got the priced plan back as the tool result
  assert.equal(asked.length, 2);
  assert.match(asked[0].system, /podcast\.mp4/);
  assert.match(asked[0].messages[0].content, /Attached: "podcast.mp4" \(video, 12 s\)/);
  const result = JSON.parse(asked[1].messages[2].content[0].content);
  assert.equal(result.ok, true);
  assert.equal(result.plan.total_credits, out.plan!.total_credits);
  assert.equal(asked[0].model, "claude-sonnet-5-5");
  assert.ok(sb.writes.some((w: any) => w.table === "studio_conversations" && w.op === "update" && w.v.plan?.id === out.plan!.id));
});

test("a turn with a bad plan: the tool refuses, the model reads the reason and answers in words; no plan is kept", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("propose_plan", { title: "x", steps: [{ tool: "restyle", label: "x", source: VID, options: { style_name: "Watercolour" } }] }),
    textReply("We do not have a watercolour style. Anime or Clay?"),
  ]);
  const c = convo(); tables.studio_conversations.push(c);
  const out = await runTurn(sb, deps(fetchFn), c, { text: "restyle it in watercolour", attachments: [], links: [] });
  assert.equal(out.plan, null);
  assert.match(out.messages[1].text, /Anime or Clay/);
  const result = JSON.parse(asked[1].messages[2].content[0].content);
  assert.equal(result.ok, false); assert.equal(result.error, "plan_invalid"); assert.match(result.detail, /Styles: Anime, Clay/);
});

test("the assistant is unavailable without a Claude key, and a Claude outage is a 503 not a crash", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const c = convo(); tables.studio_conversations.push(c);
  await assert.rejects(runTurn(sb, deps(fakeClaude([]).fetchFn, { env: { ...ENV, ANTHROPIC_API_KEY: undefined } }), c, { text: "hi", attachments: [], links: [] }), (e: any) => e.code === "assistant_unavailable" && e.status === 503);
  const down: any = async (url: string) => new Response("overloaded", { status: 529 });
  await assert.rejects(runTurn(sb, deps(down), c, { text: "hi", attachments: [], links: [] }), (e: any) => e.code === "assistant_unavailable" && e.status === 503);
});

test("links: TikTok and Instagram are fetched into the library as ready video assets; YouTube and others are declined", async () => {
  assert.equal(linkPlatform("https://www.tiktok.com/@cat/video/7301"), "tiktok");
  assert.equal(linkPlatform("https://vm.tiktok.com/ZMabc/"), "tiktok");
  assert.equal(linkPlatform("https://www.instagram.com/reel/C1x/"), "instagram");
  assert.equal(linkPlatform("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(linkPlatform("https://evil.example/tiktok.com"), null);
  assert.equal(linkPlatform("not a url"), null);
  assert.equal(findMediaUrl({ video: { play_addr: "https://cdn.example/a.mp4" }, download_url: "https://cdn.example/dl.mp4", thumb: "https://cdn.example/t.jpg" }), "https://cdn.example/dl.mp4");
  assert.equal(findMediaUrl({ data: { items: [{ video_versions: [{ url: "https://cdn.example/v1.mp4?x=1" }] }] } }), "https://cdn.example/v1.mp4?x=1");
  assert.equal(findMediaUrl({ title: "no media here" }), null);
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([], () => ({ title: "my cat driving", download_url: "https://cdn.example/dl.mp4" }));
  const a = await importLink(sb, deps(fetchFn), ANN, "https://www.tiktok.com/@cat/video/7301");
  assert.equal(a.kind, "video"); assert.equal(a.name, "my cat driving.mp4"); assert.equal(a.seconds, 7.5);
  const row = tables.studio_assets.find((r) => r.id === a.asset_id);
  assert.ok(row); assert.equal(row.status, "ready"); assert.equal(row.probe.source, "tiktok"); assert.equal(row.probe.duration, 7.5); assert.equal(row.probe.poster_key, `${ANN}/assets/${a.asset_id}.jpg`);
  assert.deepEqual(sb.uploads.map((u: any) => u.bucket), ["studio-uploads", "studio-outputs"]);
  await assert.rejects(importLink(sb, deps(fetchFn), ANN, "https://youtu.be/dQw4w9WgXcQ"), (e: any) => e.code === "unsupported_link");
  await assert.rejects(importLink(sb, deps(fetchFn), ANN, "https://example.com/v.mp4"), (e: any) => e.code === "unsupported_link");
  const { fetchFn: empty } = fakeClaude([], () => ({ title: "nothing" }));
  await assert.rejects(importLink(sb, deps(empty), ANN, "https://www.instagram.com/reel/C1x/"), (e: any) => e.code === "link_no_media");
});

test("a turn with a link: the model calls fetch_link, the asset joins the message's attachments and the plan can use it", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("fetch_link", { url: "https://www.tiktok.com/@cat/video/7301" }),
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_2", name: "propose_plan", input: { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: "FILL", options: { copies: 5 } }] } }] },
    textReply("Fetched it. Five originals for 5 credits each; confirm in the card."),
  ], () => ({ desc: "driving", download_url: "https://cdn.example/dl.mp4" }));
  // the second scripted call needs the asset id the first produced: patch it in when Claude is asked
  const patched: any = async (url: string, init: any) => {
    if (url.startsWith("https://api.anthropic.com") && asked.length === 1) { const body = JSON.parse(init.body); const r = JSON.parse(body.messages[2].content[0].content); const id = r.asset.asset_id; const reply = await fetchFn(url, init); const j = await reply.json(); j.content[0].input.steps[0].source = id; return new Response(JSON.stringify(j)); }
    return fetchFn(url, init);
  };
  const c = convo(); tables.studio_conversations.push(c);
  const out = await runTurn(sb, deps(patched), c, { text: "make 5 originals of this", attachments: [], links: ["https://www.tiktok.com/@cat/video/7301"] });
  assert.equal(out.messages[0].attachments!.length, 1);
  assert.equal(out.messages[0].attachments![0].name, "driving.mp4");
  assert.equal(out.plan!.steps[0].source, out.messages[0].attachments![0].asset_id);
  assert.equal(out.plan!.total_credits, 5 * COSTS.blueprint_copy);
});

test("a run: confirm starts step 1; when its job finishes the output is promoted and step 2 starts; the end is announced", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const ctx = ctxFor(sb);
  const plan = await pricePlan(ctx as any, { title: "Cat podcast, ten originals", steps: [
    { tool: "swap", label: "Host becomes the cat", source: VID, options: { model: "light", character_asset_id: CAT } },
    { tool: "blueprint", label: "Ten originals", source: "$1", options: { copies: 10 } },
  ] });
  const c = convo({ plan }); tables.studio_conversations.push(c);
  assert.throws(() => startRun(convo()), (e: any) => e.code === "no_plan");
  const run = startRun(c);
  assert.equal(c.plan!.status, "confirmed"); assert.equal(c.status, "running"); assert.equal(run.steps.length, 2);
  const d = deps(fakeClaude([]).fetchFn);
  // a stale copy (as a second advancer would hold) is refused and gets the live row back; it creates nothing
  const stale = { ...c, updated_at: "2020-01-01T00:00:00Z", run: JSON.parse(JSON.stringify(c.run)) };
  const got = await advanceRun(sb, d, stale);
  assert.equal(got.id, c.id); assert.equal(sb.calls.filter((x: any) => x.name === "studio_create_job").length, 0, "a lost claim creates no job");
  await advanceRun(sb, d, c);
  assert.equal(c.run!.steps[0].status, "queued"); assert.equal(c.run!.steps[0].job_id, "job-1");
  assert.equal(c.run!.steps[1].status, "waiting", "step 2 waits for step 1's file");
  const created = sb.calls.filter((x: any) => x.name === "studio_create_job");
  assert.equal(created.length, 1); assert.equal(created[0].args.p_tool, "swap"); assert.equal(created[0].args.p_asset, VID); assert.equal(created[0].args.p_credits, 13 * COSTS.recast_light_second);
  // nothing new while it renders
  tables.studio_jobs[0].status = "running";
  await advanceRun(sb, d, c);
  assert.equal(c.run!.steps[0].status, "running"); assert.equal(sb.calls.filter((x: any) => x.name === "studio_create_job").length, 1);
  // done: the swap's output becomes a library asset and the blueprint job is created on it, priced on the real file
  tables.studio_jobs[0].status = "done"; tables.studio_jobs[0].outputs = [{ index: 1, key: `${ANN}/job-1/01.mp4`, poster_key: `${ANN}/job-1/01.jpg`, kind: "video", duration: 12.0 }];
  await advanceRun(sb, d, c);
  assert.equal(c.run!.steps[0].status, "done"); assert.ok(c.run!.steps[0].asset_id);
  const promoted = tables.studio_assets.find((a) => a.id === c.run!.steps[0].asset_id);
  assert.ok(promoted); assert.equal(promoted.kind, "video"); assert.equal(promoted.status, "ready"); assert.equal(promoted.probe.duration, 12); assert.equal(promoted.probe.derived_from_job, "job-1"); assert.match(promoted.name, /Host becomes the cat · result\.mp4/);
  assert.equal(c.run!.steps[1].status, "queued"); assert.equal(c.run!.steps[1].job_id, "job-2");
  const second = sb.calls.filter((x: any) => x.name === "studio_create_job")[1];
  assert.equal(second.args.p_tool, "blueprint"); assert.equal(second.args.p_asset, promoted.id); assert.equal(second.args.p_credits, 10 * COSTS.blueprint_copy);
  tables.studio_jobs[1].status = "done"; tables.studio_jobs[1].outputs = [{ index: 1, key: `${ANN}/job-2/01.mp4` }];
  await advanceRun(sb, d, c);
  assert.equal(c.run!.status, "done"); assert.equal(c.status, "done");
  assert.match(c.messages[c.messages.length - 1].text, /2 steps are done/);
  assert.equal(c.run!.steps[1].asset_id, null, "a final output is not copied into the library twice");
});

test("a run stops when a step fails, when a slot is busy it waits, and when credits run short it says so", async () => {
  const tables = baseTables();
  let fail: string | null = null;
  const sb = fakeSb(tables, (name, args) => fail && name === "studio_create_job" ? { data: null, error: { message: fail } } : rpcs(tables)(name, args));
  const ctx = ctxFor(sb);
  const plan = await pricePlan(ctx as any, { title: "x", steps: [{ tool: "blueprint", label: "Three", source: VID, options: { copies: 3 } }, { tool: "recast", label: "Noah", source: "$1", options: { model: "light", character: "noah" } }] });
  const c = convo({ plan }); tables.studio_conversations.push(c); startRun(c);
  const d = deps(fakeClaude([]).fetchFn);
  fail = "too_many_jobs";
  await advanceRun(sb, d, c);
  assert.equal(c.run!.status, "running"); assert.equal(c.run!.steps[0].status, "waiting", "waits for a free slot");
  fail = null;
  await advanceRun(sb, d, c);
  assert.equal(c.run!.steps[0].status, "queued");
  tables.studio_jobs[0].status = "failed"; tables.studio_jobs[0].error_code = "render_failed";
  await advanceRun(sb, d, c);
  assert.equal(c.run!.status, "failed"); assert.equal(c.status, "failed"); assert.equal(c.run!.steps[0].status, "failed"); assert.equal(c.run!.steps[1].status, "skipped");
  assert.match(c.messages[c.messages.length - 1].text, /Step 1 \(Three\) failed: render_failed/);
  // short on credits
  const t2 = baseTables(); const sb2 = fakeSb(t2, (name, args) => name === "studio_create_job" ? { data: null, error: { message: "insufficient_credits" } } : rpcs(t2)(name, args));
  const p2 = await pricePlan(ctxFor(sb2) as any, { title: "x", steps: [{ tool: "blueprint", label: "Fifty", source: VID, options: { copies: 50 } }] });
  const c2 = convo({ plan: p2 }); t2.studio_conversations.push(c2); startRun(c2);
  await advanceRun(sb2, d, c2);
  assert.equal(c2.run!.status, "failed"); assert.match(c2.messages[c2.messages.length - 1].text, /balance is short/);
  assert.equal(startAssistantLoop(() => sb2, { env: { ...ENV, ANTHROPIC_API_KEY: undefined } }), null, "no loop without the key");
});

async function serve(sb: any, fetchFn: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) { req.auth = { user_id: u, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: u }; } next(); });
  app.use(accountAccess(() => sb));
  registerAssistant(app, () => sb, deps(fetchFn));
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = { "x-test-user": ANN }) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("routes: create, message, confirm, read with hydrated jobs, cancel; strangers get 401 and empty messages 400", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([
    toolReply("propose_plan", { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: VID, options: { copies: 5 } }] }),
    textReply("Five originals for 25 credits. Confirm in the card."),
  ]);
  const s = await serve(sb, fetchFn);
  try {
    assert.equal((await s.call("GET", "/api/studio/assistant/conversations", undefined, {})).status, 401);
    const list0 = await s.call("GET", "/api/studio/assistant/conversations");
    assert.equal(list0.status, 200); assert.deepEqual(list0.body.conversations, []); assert.equal(list0.body.assistant, true);
    const made = await s.call("POST", "/api/studio/assistant/conversations");
    assert.equal(made.status, 201); assert.equal(made.body.conversation.title, "New chat");
    const id = made.body.conversation.id;
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "   " })).body.error, "message_empty");
    const msg = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "five originals of my podcast", attachments: [VID, "not-an-id"] });
    assert.equal(msg.status, 200, JSON.stringify(msg.body));
    assert.equal(msg.body.conversation.plan.total_credits, 5 * COSTS.blueprint_copy);
    assert.equal(msg.body.conversation.messages[0].attachments.length, 1);
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`, { plan_id: "stale" })).body.error, "plan_stale");
    const ok = await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`, { plan_id: msg.body.conversation.plan.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.conversation.status, "running"); assert.equal(ok.body.conversation.run.steps[0].status, "queued"); assert.equal(ok.body.conversation.jobs.length, 1); assert.equal(ok.body.conversation.jobs[0].tool, "blueprint");
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`)).body.error, "no_plan");
    tables.studio_jobs[0].status = "done"; tables.studio_jobs[0].outputs = [{ index: 1, key: `${ANN}/job-1/01.mp4`, poster_key: `${ANN}/job-1/01.jpg` }];
    const read = await s.call("GET", `/api/studio/assistant/conversations/${id}`);
    assert.equal(read.status, 200);
    assert.match(read.body.conversation.jobs[0].outputs[0].url, /^https:\/\/signed\/.*download=podcast-[a-z]+-01\.mp4/);
    assert.equal(read.body.conversation.jobs[0].outputs[0].poster_url, `https://signed/${ANN}/job-1/01.jpg`);
    assert.equal((await s.call("GET", `/api/studio/assistant/conversations/${id}`, undefined, { "x-test-user": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).status, 404);
    assert.equal((await s.call("GET", `/api/studio/assistant/conversations/nope`)).status, 404);
    const cancel = await s.call("POST", `/api/studio/assistant/conversations/${id}/cancel`);
    assert.equal(cancel.status, 200); assert.equal(cancel.body.conversation.status, "canceled");
    assert.match(cancel.body.conversation.messages[cancel.body.conversation.messages.length - 1].text, /Stopped/);
    const list = await s.call("GET", "/api/studio/assistant/conversations");
    assert.equal(list.body.conversations.length, 1); assert.equal(list.body.conversations[0].title, "Five originals");
  } finally { await s.close(); }
});

test("routes: without the migration the reply is a 503 that names it, not a stack trace", async () => {
  const sb: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'relation "public.studio_conversations" does not exist' } }) }) }) }) }) };
  const s = await serve(sb, fakeClaude([]).fetchFn);
  try { const r = await s.call("GET", "/api/studio/assistant/conversations"); assert.equal(r.status, 503); assert.equal(r.body.error, "assistant_unavailable"); assert.match(r.body.detail, /migration/); } finally { await s.close(); }
});
