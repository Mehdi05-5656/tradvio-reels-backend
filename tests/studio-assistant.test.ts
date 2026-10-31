import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFile } from "node:fs/promises";
import { accountAccess } from "../src/account-access.js";
import { COSTS, PLANS } from "../src/studio.js";
import { buildSystemPrompt, PRESET_CHARACTERS } from "../src/studio-knowledge.js";
import { mergeMessages, pricePlan, runTurn, startRun, advanceRun, importLink, linkPlatform, findMediaUrl, registerAssistant, startAssistantLoop, TOOLS, AssistantError, expectedOutput, readAnthropicStream, compactIfNeeded, needsCompaction, hydrateChoices, titleIfNeeded, COMPACT_AFTER, KEEP_RAW, MEMORY_LIMIT, type Conversation, type TurnEvent } from "../src/studio-assistant.js";
import { templateFromPlan, instantiate, createAutomation, runAutomation, registerAutomations } from "../src/studio-automations.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", VID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", CAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", CONVO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENV: Record<string, string | undefined> = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true", STUDIO_BLUEPRINT_ENABLED: "true", STUDIO_RECAST_FULL_ENABLED: "true", ANTHROPIC_API_KEY: "sk-test", SCRAPECREATORS_API_KEY: "sc-test" };
const STYLES = [{ id: "11111111-1111-4111-8111-111111111111", name: "Anime", preview_url: null }, { id: "22222222-2222-4222-8222-222222222222", name: "Clay", preview_url: null }];
const video = { id: VID, user_id: ANN, kind: "video", name: "podcast.mp4", object_key: `${ANN}/${VID}.mp4`, bytes: 1000, status: "ready", probe: { duration: 12.2 } };
const cat = { id: CAT, user_id: ANN, kind: "image", name: "Orange cat.jpg", object_key: `${ANN}/${CAT}.jpg`, bytes: 100, status: "ready", probe: { character: true, mode: "animal", prompt: "an orange cat" } };

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
        ilike(k: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i"); filters.push((r) => re.test(String(r[k] ?? ""))); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { table, op: "insert", v }; rows = () => (Array.isArray(v) ? v : [v]); return q; },
        update(v: any) { pending = { table, op: "update", v }; return q; },
        upsert(v: any) { pending = { table, op: "upsert", v }; return q; },
        delete() { pending = { table, op: "delete" }; return q; },
        then(resolve: any, reject: any) {
          if (pending) {
            writes.push({ ...pending, filters: filters.length });
            if (pending.op === "delete") { const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r)); rows = () => []; filters.length = 0; }
            if (pending.op === "insert" && table === "studio_assistant_memory") { if ((tables[table] ?? []).some((r) => r.note.toLowerCase() === pending.v.note.toLowerCase())) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }).then(resolve, reject); const v = { id: `note-${(tables[table] ?? []).length + 1}`, created_at: "2026-10-29T00:00:00Z", ...pending.v }; (tables[table] ??= []).push(v); rows = () => [v]; }
            else if (pending.op === "insert" && table === "studio_automations") { const v = { id: `a${(tables[table] ?? []).length + 1}aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, runs: 0, last_run_at: null, description: null, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z", ...pending.v }; (tables[table] ??= []).push(v); rows = () => [v]; }
            else if (pending.op === "insert" && table === "studio_social_posts") { const v = { id: `post${(tables[table] ?? []).length + 1}-0000-4000-8000-000000000000`, results: [], error: null, provider_post_id: null, created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", ...pending.v }; (tables[table] ??= []).push(v); rows = () => [v]; }
            else if (pending.op === "insert") { const v = { id: CONVO, title: "New chat", status: "open", messages: [], plan: null, run: null, summary: null, summary_through: 0, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z", ...pending.v }; (tables[table] ??= []).push(v); rows = () => [v]; }
            if (pending.op === "upsert") { const t = (tables[table] ??= []); const hit = t.find((r) => r.user_id === pending.v.user_id); if (hit) Object.assign(hit, pending.v); else t.push({ ...pending.v }); rows = () => [hit ?? pending.v]; }
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
const baseTables = () => ({ studio_assets: [video, cat], studio_customers: [{ user_id: ANN, plan_id: "creator", status: "active", parallel_jobs: 2 }], studio_jobs: [] as any[], studio_conversations: [] as any[], studio_assistant_memory: [] as any[], studio_automations: [] as any[] });
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
    if (url.startsWith("https://api.anthropic.com")) { const body = JSON.parse(init.body); asked.push(body); const r = replies.shift(); if (!r) return new Response(JSON.stringify({ error: "script ran out" }), { status: 500 }); if (body.stream) return new Response(sse(r), { status: 200, headers: { "content-type": "text/event-stream" } }); return new Response(JSON.stringify(r), { status: 200 }); }
    if (url.startsWith("https://api.scrapecreators.com")) return new Response(JSON.stringify(scrape ? scrape(url) : {}), { status: 200 });
    if (url.startsWith("https://cdn.example/")) return new Response(new Uint8Array(2048), { status: 200 });
    if (url.startsWith("https://api.higgsfield.ai/estimate/")) return new Response(JSON.stringify({ usd: 0.4 }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchFn, asked };
}
/** A scripted reply as Anthropic's event stream: text in two deltas, tool input as partial JSON. */
function sse(reply: any): string {
  const ev = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("message_start", { message: { id: "msg_1", role: "assistant" } });
  (reply.content ?? []).forEach((b: any, i: number) => {
    if (b.type === "text") { out += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } }); const half = Math.ceil(b.text.length / 2); out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text.slice(0, half) } }); out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text.slice(half) } }); }
    else { out += ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); const j = JSON.stringify(b.input); out += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: j.slice(0, 7) } }); out += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: j.slice(7) } }); }
    out += ev("content_block_stop", { index: i });
  });
  out += ev("message_delta", { delta: { stop_reason: reply.stop_reason }, usage: { output_tokens: 10 } }) + ev("message_stop", {});
  return out;
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
  assert.equal(TOOLS.map((t) => t.name).join(","), "propose_plan,fetch_link,request_video,choose_people,preview_voices,preview_characters,offer_post,save_automation,remember");
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
  assert.ok(!("temperature" in asked[0]), "the API rejects temperature for this model");
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
  const bare = await importLink(sb, deps(fakeClaude([], () => ({ download_url: "https://cdn.example/dl.mp4" })).fetchFn), ANN, "https://www.tiktok.com/@osamas0ns/video/7692");
  assert.equal(bare.name, "TikTok @osamas0ns.mp4", "no caption: the account handle names the clip");
  const row = tables.studio_assets.find((r) => r.id === a.asset_id);
  assert.ok(row); assert.equal(row.status, "ready"); assert.equal(row.probe.source, "tiktok"); assert.equal(row.probe.duration, 7.5); assert.equal(row.probe.poster_key, `${ANN}/assets/${a.asset_id}.jpg`);
  assert.deepEqual(sb.uploads.slice(0, 2).map((u: any) => u.bucket), ["studio-uploads", "studio-outputs"]);
  // YouTube: metadata from the service (title, length), the file from the injected downloader; too long is refused before any download
  let downloaded: string[] = [];
  const yt = fakeClaude([], () => ({ title: "How I edit #shorts", durationMs: 42_000 })).fetchFn;
  const dl = async (url: string, target: string, o: any) => { downloaded.push(url); assert.equal(o.maxSeconds, 600); await writeFile(target, Buffer.from("mp4")); return { title: "How I edit" }; };
  const y = await importLink(sb, deps(yt, { download: dl }), ANN, "https://youtube.com/shorts/dQw4w9WgXcQ");
  assert.equal(y.name, "How I edit.mp4"); assert.deepEqual(downloaded, ["https://youtube.com/shorts/dQw4w9WgXcQ"]);
  assert.equal(tables.studio_assets.find((r) => r.id === y.asset_id).probe.source, "youtube");
  const noTitle = await importLink(sb, deps(fakeClaude([], () => ({})).fetchFn, { download: async (_u: string, target: string) => { await writeFile(target, Buffer.from("mp4")); return { title: null }; } }), ANN, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(noTitle.name, "YouTube dQw4w9WgXcQ.mp4");
  downloaded = [];
  await assert.rejects(importLink(sb, deps(fakeClaude([], () => ({ title: "Long", durationMs: 45 * 60_000 })).fetchFn, { download: dl }), ANN, "https://youtu.be/dQw4w9WgXcQ"), (e: any) => e.code === "link_too_long");
  assert.deepEqual(downloaded, [], "nothing is downloaded for an over-long video");
  await assert.rejects(importLink(sb, deps(yt, { download: async () => { const { LinkError } = await import("../src/studio-youtube.js"); throw new LinkError("link_blocked", "bot check"); } }), ANN, "https://youtu.be/dQw4w9WgXcQ"), (e: any) => e.code === "link_blocked" && e.status === 400);
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
  registerAutomations(app, () => sb, deps(fetchFn));
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port, base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = { "x-test-user": ANN }) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, port, close: () => new Promise((r) => server.close(r)) };
}

test("routes: create, message, confirm, read with hydrated jobs, cancel; strangers get 401 and empty messages 400", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([
    toolReply("propose_plan", { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: VID, options: { copies: 5 } }] }),
    textReply("Five originals for 25 credits. Confirm in the card."),
  ], () => ({ title: "linked clip", download_url: "https://cdn.example/dl.mp4" }));
  const s = await serve(sb, fetchFn);
  try {
    assert.equal((await s.call("GET", "/api/studio/assistant/conversations", undefined, {})).status, 401);
    const list0 = await s.call("GET", "/api/studio/assistant/conversations");
    assert.equal(list0.status, 200); assert.deepEqual(list0.body.conversations, []); assert.equal(list0.body.assistant, true);
    // a link brought into the library outside a chat, for the Automations page and the tool pages
    const linked = await s.call("POST", "/api/studio/links", { url: "https://www.tiktok.com/@cat/video/7301" });
    assert.equal(linked.status, 201, JSON.stringify(linked.body)); assert.equal(linked.body.asset.kind, "video"); assert.equal(linked.body.asset.status, "ready"); assert.ok(linked.body.asset.name.endsWith(".mp4"));
    const badLink = await s.call("POST", "/api/studio/links", { url: "https://example.com/v.mp4" });
    assert.equal(badLink.status, 400); assert.equal(badLink.body.error, "unsupported_link");
    assert.equal((await s.call("POST", "/api/studio/links", { url: "https://youtu.be/dQw4w9WgXcQ" }, {})).status, 401);
    const made = await s.call("POST", "/api/studio/assistant/conversations");
    assert.equal(made.status, 201); assert.equal(made.body.conversation.title, "New chat");
    const id = made.body.conversation.id;
    // without a plan a message is refused before any reply is written (a reply costs us); the dashboard opens the plans
    tables.studio_customers[0].status = "none";
    const refused = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "five originals of my podcast" });
    assert.deepEqual([refused.status, refused.body.error], [402, "subscription_required"]);
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`, {})).status, 402);
    tables.studio_customers[0].status = "active";
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


test("Anthropic's event stream is read back into blocks: text deltas handed out, tool input assembled from partial JSON", async () => {
  const reply = toolReply("propose_plan", { title: "T", steps: [{ tool: "blueprint", label: "x", source: VID, options: { copies: 2 } }] }, "Let me price that.");
  const deltas: string[] = [];
  const got = await readAnthropicStream(new Response(sse(reply)).body!, (t) => deltas.push(t));
  assert.equal(got.stop_reason, "tool_use");
  assert.equal(deltas.join(""), "Let me price that.");
  assert.equal(deltas.length, 2);
  assert.deepEqual(got.content[0], { type: "text", text: "Let me price that." });
  assert.equal(got.content[1].type, "tool_use"); assert.equal(got.content[1].name, "propose_plan"); assert.deepEqual(got.content[1].input.steps[0].options, { copies: 2 });
  // a round that is only tool calls opens an empty text block; it must not travel back to the API
  const bare = { stop_reason: "tool_use", content: [{ type: "text", text: "" }, { type: "tool_use", id: "tu_9", name: "remember", input: { note: "Prefers Light" } }] };
  const got2 = await readAnthropicStream(new Response(sse(bare)).body!, () => undefined);
  assert.deepEqual(got2.content.map((b: any) => b.type), ["tool_use"]);
  // a mid-stream error from the API is surfaced, not swallowed
  await assert.rejects(readAnthropicStream(new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n').body!, () => undefined), (e: any) => e.code === "assistant_unavailable" && /Overloaded/.test(e.message));
});

test("a streaming turn reports rounds, text deltas and tool status in order, and the saved text keeps every round in order", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("propose_plan", { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: VID, options: { copies: 5 } }] }, "Pricing it now."),
    textReply("Five originals for 20 credits. Confirm in the card."),
  ]);
  const c = convo(); tables.studio_conversations.push(c);
  const events: TurnEvent[] = [];
  const out = await runTurn(sb, deps(fetchFn), c, { text: "five originals", attachments: [], links: [] }, (e) => events.push(e));
  assert.ok(asked.every((a) => a.stream === true), "the model is asked to stream");
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["round", "delta", "delta", "status", "round", "delta", "delta"]);
  assert.ok(!asked[1].messages[1].content.some((b: any) => b.type === "text" && !b.text), "no empty text block is sent back");
  assert.equal((events[3] as any).text, "Pricing the plan");
  assert.equal(events.filter((e) => e.type === "delta").map((e: any) => e.text).join(""), "Pricing it now.Five originals for 20 credits. Confirm in the card.");
  assert.equal(out.messages[1].text, "Pricing it now.\n\nFive originals for 20 credits. Confirm in the card.", "what it said before the tool ran stays above the answer");
  assert.equal(out.plan!.total_credits, 5 * COSTS.blueprint_copy);
});

test("Stop mid-reply keeps the words so far as an interrupted message and the chat stays usable", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const ctl = new AbortController();
  // the fake aborts itself after the first delta reaches the turn
  const { fetchFn } = fakeClaude([textReply("First half of a long answer, second half never arrives.")]);
  const c = convo(); tables.studio_conversations.push(c);
  let deltas = 0;
  const out = await runTurn(sb, deps(fetchFn, { signal: ctl.signal }), c, { text: "tell me everything", attachments: [], links: [] }, (e) => { if (e.type === "delta" && ++deltas === 1) ctl.abort(); });
  const last = out.messages[1];
  assert.equal(last.role, "assistant"); assert.equal(last.interrupted, true);
  assert.ok(last.text.length > 0 && last.text.length < "First half of a long answer, second half never arrives.".length, `partial text kept: ${JSON.stringify(last.text)}`);
  assert.equal(tables.studio_conversations[0].messages.length, 2, "the user message and the partial reply are saved");
});

test("remember: the model files a durable note, duplicates are fine, the limit is honest, and the next turn reads the notes", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("remember", { note: "Always use the Light model; they post the same clip on six accounts." }),
    textReply("Noted."),
    toolReply("remember", { note: "always use the light model; they post the same clip on six accounts." }),
    textReply("Already noted."),
    textReply("Sure."),
  ]);
  const c = convo(); tables.studio_conversations.push(c);
  await runTurn(sb, deps(fetchFn), c, { text: "always use light, I post on six accounts", attachments: [], links: [] });
  assert.equal(tables.studio_assistant_memory.length, 1);
  assert.equal(tables.studio_assistant_memory[0].conversation_id, CONVO);
  const lastResult = (a: any) => JSON.parse(a.messages[a.messages.length - 1].content[0].content);
  assert.equal(lastResult(asked[1]).ok, true);
  await runTurn(sb, deps(fetchFn), c, { text: "again: light model", attachments: [], links: [] });
  assert.equal(tables.studio_assistant_memory.length, 1, "the same note is not kept twice");
  assert.deepEqual(lastResult(asked[3]), { ok: true, already: true });
  await runTurn(sb, deps(fetchFn), c, { text: "hi", attachments: [], links: [] });
  assert.match(asked[4].system, /WHAT YOU REMEMBER ABOUT THIS PERSON[\s\S]*Always use the Light model/);
  // full memory refuses with a reason
  for (let i = 0; i < MEMORY_LIMIT; i++) tables.studio_assistant_memory.push({ id: `n${i}`, user_id: ANN, note: `note ${i}`, created_at: "2026-10-29T00:00:00Z" });
  const more = fakeClaude([toolReply("remember", { note: "one more thing" }), textReply("ok")]);
  await runTurn(sb, deps(more.fetchFn), c, { text: "remember this", attachments: [], links: [] });
  assert.equal(lastResult(more.asked[1]).error, "memory_full");
});

test("long chats fold: the older part becomes a summary the model reads, the recent messages travel raw, and the fold point is kept", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const c = convo(); tables.studio_conversations.push(c);
  for (let i = 0; i < COMPACT_AFTER; i++) c.messages.push({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `message ${i}`, at: "2026-10-29T00:00:00Z" });
  assert.equal(needsCompaction(c), true);
  const { fetchFn, asked } = fakeClaude([textReply("The person wants ten originals of podcast.mp4; a 5-copy plan was proposed and confirmed; they prefer Light.")]);
  assert.equal(await compactIfNeeded(sb, deps(fetchFn), c), true);
  assert.equal(asked.length, 1); assert.ok(!("tools" in asked[0]), "summarizing uses no tools"); assert.equal(asked[0].stream, false);
  assert.match(asked[0].messages[0].content, /message 0[\s\S]*message 11/); assert.ok(!asked[0].messages[0].content.includes(`message ${COMPACT_AFTER - 1}`), "the recent messages are not summarized");
  assert.equal(c.summary_through, COMPACT_AFTER - KEEP_RAW); assert.match(c.summary!, /ten originals/);
  assert.equal(tables.studio_conversations[0].summary_through, COMPACT_AFTER - KEEP_RAW);
  assert.equal(needsCompaction(c), false);
  // the next turn: the summary is in the system prompt and only the raw tail goes as messages
  const next = fakeClaude([textReply("Right, ten originals.")]);
  await runTurn(sb, deps(next.fetchFn), c, { text: "where were we?", attachments: [], links: [] });
  assert.match(next.asked[0].system, /EARLIER IN THIS CHAT[\s\S]*ten originals/);
  assert.equal(next.asked[0].messages.length, KEEP_RAW + 1);
  assert.ok(!JSON.stringify(next.asked[0].messages).includes("message 3"), "summarized messages are not resent");
  // the second fold merges the earlier summary
  for (let i = 0; i < COMPACT_AFTER; i++) c.messages.push({ id: `x${i}`, role: i % 2 ? "assistant" : "user", text: `later ${i}`, at: "2026-10-29T00:00:00Z" });
  const again = fakeClaude([textReply("merged summary")]);
  assert.equal(await compactIfNeeded(sb, deps(again.fetchFn), c), true);
  assert.match(again.asked[0].messages[0].content, /Summary so far:\nThe person wants ten originals/);
});

test("routes: rename, delete (canceling queued steps), search, memory list and delete, and a streamed message", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([
    toolReply("propose_plan", { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: VID, options: { copies: 5 } }] }, "Pricing."),
    textReply("Five originals for 20 credits. Confirm in the card."),
    toolReply("preview_characters", { prompt: "a cat", mode: "animal" }),
    textReply("Pick a cat."),
  ]);
  tables.studio_assistant_memory.push({ id: "aaaaaaaa-0000-4000-8000-000000000001", user_id: ANN, note: "Prefers Light", created_at: "2026-10-29T00:00:00Z" });
  const s = await serve(sb, fetchFn);
  try {
    const made = await s.call("POST", "/api/studio/assistant/conversations");
    const id = made.body.conversation.id;
    // streamed message: events in order, then the whole conversation
    const res = await fetch(`http://127.0.0.1:${(s as any).port}/api/studio/assistant/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "x-test-user": ANN }, body: JSON.stringify({ text: "five originals of my podcast", attachments: [VID] }) });
    assert.equal(res.status, 200); assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const raw = await res.text();
    const events = raw.split("\n\n").filter((x) => x.startsWith("event:")).map((x) => ({ event: x.match(/^event: (\S+)/)![1], data: JSON.parse(x.slice(x.indexOf("data: ") + 6)) }));
    assert.deepEqual(events.map((e) => e.event), ["round", "delta", "delta", "status", "round", "delta", "delta", "done"]);
    const done = events[events.length - 1].data;
    assert.equal(done.conversation.plan.total_credits, 5 * COSTS.blueprint_copy); assert.equal(done.conversation.messages.length, 2); assert.equal(done.conversation.summary_through, 0);
    // a streamed face card arrives with its pictures signed, like a plain read
    const faces = await fetch(`http://127.0.0.1:${(s as any).port}/api/studio/assistant/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "x-test-user": ANN }, body: JSON.stringify({ text: "make it a cat" }) });
    const raw2 = await faces.text();
    const done2 = JSON.parse(raw2.split("\n\n").filter((x) => x.startsWith("event: done")).map((x) => x.slice(x.indexOf("data: ") + 6))[0]);
    assert.match(done2.conversation.messages.at(-1).choice.existing[0].url, /^https:\/\/signed\//);
    // rename
    const renamed = await s.call("PATCH", `/api/studio/assistant/conversations/${id}`, { title: "  Podcast  originals " });
    assert.equal(renamed.status, 200); assert.equal(renamed.body.conversation.title, "Podcast originals");
    assert.equal((await s.call("PATCH", `/api/studio/assistant/conversations/${id}`, { title: " " })).body.error, "title_empty");
    // search
    assert.equal((await s.call("GET", "/api/studio/assistant/conversations?q=podcast")).body.conversations.length, 1);
    assert.equal((await s.call("GET", "/api/studio/assistant/conversations?q=nothing%25here")).body.conversations.length, 0);
    // memory
    const mem = await s.call("GET", "/api/studio/assistant/memory");
    assert.equal(mem.status, 200); assert.equal(mem.body.notes.length, 1); assert.equal(mem.body.limit, MEMORY_LIMIT);
    assert.equal((await s.call("DELETE", "/api/studio/assistant/memory/aaaaaaaa-0000-4000-8000-000000000001")).status, 200);
    assert.equal((await s.call("GET", "/api/studio/assistant/memory")).body.notes.length, 0);
    assert.equal((await s.call("DELETE", "/api/studio/assistant/memory")).body.deleted, "all");
    // delete a running conversation: its queued step is canceled first
    await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`, { plan_id: done.conversation.plan.id });
    const del = await s.call("DELETE", `/api/studio/assistant/conversations/${id}`);
    assert.equal(del.status, 200); assert.equal(del.body.deleted, id);
    assert.ok(sb.calls.some((x: any) => x.name === "studio_cancel"), "the queued job was canceled");
    assert.equal(tables.studio_conversations.length, 0);
    assert.equal((await s.call("GET", `/api/studio/assistant/conversations/${id}`)).status, 404);
  } finally { await s.close(); }
});


test("choice cards: the model offers four faces, the person generates them (a character job), the card fills from the job, and a pick is recorded", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([
    toolReply("preview_characters", { prompt: "a silver-haired astronaut in her 50s", mode: "human" }),
    textReply("Four takes on the astronaut. Pick one, or upload a photo instead."),
  ]);
  const s = await serve(sb, fetchFn);
  try {
    const made = await s.call("POST", "/api/studio/assistant/conversations"); const id = made.body.conversation.id;
    const msg = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "swap me for a silver-haired astronaut" });
    assert.equal(msg.status, 200, JSON.stringify(msg.body));
    const card = msg.body.conversation.messages[1].choice;
    assert.ok(card, "the assistant message carries a card");
    assert.equal(card.status, "offered"); assert.equal(card.count, 4); assert.equal(card.credits, 4 * COSTS.character_image); assert.equal(card.mode, "human"); assert.equal(card.auto_credits, COSTS.character_image);
    assert.deepEqual(card.existing, [], "the cat is an animal, not offered for a human");
    assert.equal(msg.body.conversation.plan, null, "no plan before the pick");
    // generate: one character job for four portraits
    const gen = await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/generate`);
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.conversation.messages[1].choice.status, "generating");
    const created = sb.calls.filter((x: any) => x.name === "studio_create_job");
    assert.equal(created.length, 1); assert.equal(created[0].args.p_tool, "character"); assert.equal(created[0].args.p_options.count, 4); assert.equal(created[0].args.p_credits, 4 * COSTS.character_image);
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/generate`)).body.error, "choice_done");
    // the job finishes with four assets: the card is ready with signed posters
    const job = tables.studio_jobs[0]; job.status = "done"; job.outputs = [1, 2, 3, 4].map((i) => ({ index: i, key: `${ANN}/job-1/${i}.jpg`, poster_key: `${ANN}/job-1/${i}.jpg`, kind: "image", asset_id: `0000000${i}-0000-4000-8000-00000000000${i}` }));
    const read = await s.call("GET", `/api/studio/assistant/conversations/${id}`);
    const ready = read.body.conversation.messages[1].choice;
    assert.equal(ready.status, "ready"); assert.equal(ready.options.length, 4); assert.equal(ready.options[2].name, "Option 3"); assert.match(ready.options[0].url, /^https:\/\/signed\//);
    assert.equal(tables.studio_conversations[0].messages[1].choice.status, "ready", "the settled card is saved");
    // pick
    assert.equal((await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/pick`, { asset_id: "nope" })).body.error, "choice_invalid");
    const pick = await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/pick`, { asset_id: ready.options[1].asset_id });
    assert.equal(pick.status, 200); assert.equal(pick.body.conversation.messages[1].choice.status, "picked"); assert.equal(pick.body.conversation.messages[1].choice.picked, ready.options[1].asset_id);
  } finally { await s.close(); }
});

test("a failed options job marks the card failed and lets the person try again", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const c = convo({ messages: [{ id: "m1", role: "assistant", text: "Pick", at: "2026-10-29T00:00:00Z", choice: { id: "ch1", kind: "characters", prompt: "a fox", mode: "animal", count: 4, credits: 40, status: "generating", job_id: "job-9" } }] });
  tables.studio_conversations.push(c); tables.studio_jobs.push({ id: "job-9", user_id: ANN, status: "failed", error_code: "recast_nsfw", outputs: [] });
  await hydrateChoices(sb, ANN, c);
  assert.equal(c.messages[0].choice!.status, "failed"); assert.equal(c.messages[0].choice!.error_code, "recast_nsfw");
});

test("automations: a confirmed plan becomes a recipe with the video as an open input and the made character fixed; running it on a new file prices and starts a run", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const ctx = ctxFor(sb);
  const plan = await pricePlan(ctx as any, { title: "Cat podcast, ten originals", steps: [
    { tool: "swap", label: "Host becomes the cat", source: VID, options: { model: "light", character_asset_id: CAT, prompt: "keep the mic" } },
    { tool: "blueprint", label: "Ten originals", source: "$1", options: { copies: 10 } },
  ] });
  const t = templateFromPlan(plan, new Map([[VID, "podcast.mp4"]]));
  assert.deepEqual(t.inputs, [{ key: "video_1", kind: "video", label: "The video", from_name: "podcast.mp4" }]);
  assert.equal(t.steps[0].source, "{video_1}"); assert.equal(t.steps[0].options.character_asset_id, CAT, "the cat stays"); assert.equal(t.steps[0].options.seconds, undefined, "seconds are recomputed per file");
  assert.equal(t.steps[1].source, "$1"); assert.equal(t.steps[1].options.copies, 10);
  assert.throws(() => instantiate(t.steps, t.inputs, {}), (e: any) => e.code === "input_missing" && /The video/.test(e.message));
  assert.equal(instantiate(t.steps, t.inputs, { video_1: VID }).steps[0].source, VID);
  // saving needs a confirmed plan with a video in it
  await assert.rejects(createAutomation(sb, ANN, { name: "x", plan: await pricePlan(ctx as any, { title: "x", steps: [{ tool: "character", label: "fox", options: { mode: "animal", prompt: "a fox" } }] }) }), (e: any) => e.code === "automation_no_input");
  plan.status = "confirmed";
  const a = await createAutomation(sb, ANN, { name: "  Cat podcast  ", plan, conversation_id: CONVO });
  assert.equal(a.name, "Cat podcast"); assert.equal(tables.studio_automations.length, 1);
  // run on another video: a conversation is created with the plan confirmed and the first job started
  const other = { ...video, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "episode-2.mp4", object_key: `${ANN}/ffffffff-ffff-4fff-8fff-ffffffffffff.mp4`, probe: { duration: 8 } };
  tables.studio_assets.push(other);
  const out = await runAutomation(sb, deps(fakeClaude([]).fetchFn), a, { video_1: other.id });
  assert.equal(out.automation_id, a.id); assert.equal(out.status, "running"); assert.equal(out.plan!.status, "confirmed");
  assert.equal(out.title, "Cat podcast · episode-2");
  assert.equal(out.plan!.steps[0].credits, 9 * COSTS.recast_light_second, "priced on the new file (8 s rounds to 9)");
  assert.equal(out.run!.steps[0].status, "queued"); assert.equal(sb.calls.filter((x: any) => x.name === "studio_create_job")[0].args.p_asset, other.id);
  assert.equal(tables.studio_automations[0].runs, 1);
  await assert.rejects(runAutomation(sb, deps(fakeClaude([]).fetchFn), a, {}), (e: any) => e.code === "input_missing");
  await assert.rejects(runAutomation(sb, deps(fakeClaude([]).fetchFn), a, { video_1: CAT }), (e: any) => e.code === "input_invalid");
});

test("automation routes: save from a chat (and from the save_automation tool), list, get with runs, rename and edit copies, quote, run, delete", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn } = fakeClaude([
    toolReply("propose_plan", { title: "Five originals", steps: [{ tool: "blueprint", label: "Five originals", source: VID, options: { copies: 5 } }] }),
    textReply("Five originals for 20 credits. Confirm in the card."),
    toolReply("save_automation", { name: "Five originals of anything" }),
    textReply("Saved. Find it under Automations."),
  ]);
  const s = await serve(sb, fetchFn);
  try {
    const made = await s.call("POST", "/api/studio/assistant/conversations"); const id = made.body.conversation.id;
    const msg = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "five originals of my podcast" });
    assert.equal((await s.call("POST", "/api/studio/automations", { conversation_id: id })).body.error, "no_confirmed_plan", "not before Confirm");
    await s.call("POST", `/api/studio/assistant/conversations/${id}/confirm`, { plan_id: msg.body.conversation.plan.id });
    const saved = await s.call("POST", "/api/studio/automations", { conversation_id: id, name: "Podcast originals" });
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.automation.name, "Podcast originals"); assert.equal(saved.body.automation.inputs[0].from_name, "podcast.mp4");
    // the tool path
    const viaTool = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "make this an automation" });
    assert.equal(viaTool.status, 200, JSON.stringify(viaTool.body)); assert.match(viaTool.body.conversation.messages.at(-1).text, /Saved/);
    const list = await s.call("GET", "/api/studio/automations");
    assert.equal(list.body.automations.length, 2); assert.equal(list.body.automations.some((a: any) => a.name === "Five originals of anything"), true);
    const aid = saved.body.automation.id;
    const renamed = await s.call("PATCH", `/api/studio/automations/${aid}`, { name: "Podcast, 8 originals", steps: [{ index: 1, options: { copies: 8 } }] });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body)); assert.equal(renamed.body.automation.steps[0].options.copies, 8);
    const q = await s.call("POST", `/api/studio/automations/${aid}/quote`, { inputs: { video_1: VID } });
    assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.credits, 8 * COSTS.blueprint_copy);
    assert.equal((await s.call("POST", `/api/studio/automations/${aid}/quote`, { inputs: {} })).body.error, "input_missing");
    const run = await s.call("POST", `/api/studio/automations/${aid}/run`, { inputs: { video_1: VID } });
    assert.equal(run.status, 201, JSON.stringify(run.body)); assert.equal(run.body.conversation.status, "running"); assert.equal(run.body.conversation.automation_id, aid); assert.equal(run.body.conversation.jobs.length, 1);
    const got = await s.call("GET", `/api/studio/automations/${aid}`);
    assert.equal(got.body.automation.runs, 1); assert.equal(got.body.runs.length, 1); assert.equal(got.body.runs[0].run_status, "running");
    assert.equal((await s.call("DELETE", `/api/studio/automations/${aid}`)).body.deleted, aid);
    assert.equal((await s.call("GET", `/api/studio/automations/${aid}`)).status, 404);
  } finally { await s.close(); }
});


test("a request card asks for the video instead of guessing, the next attachment closes it, and the animal card offers the library cat for free", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([
    toolReply("request_video", { kind: "video", reason: "The clip to turn into a cat video" }),
    textReply("Drop it below and I will take it from there."),
    textReply("Cat video from a clip"), // the background naming call after the first reply
    toolReply("preview_characters", { prompt: "a tabby cat", mode: "animal" }),
    textReply("Your cat from the library is there for free, or new takes."),
  ]);
  const s = await serve(sb, fetchFn);
  try {
    const made = await s.call("POST", "/api/studio/assistant/conversations"); const id = made.body.conversation.id;
    const m1 = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "turn this into a cat video" });
    const req = m1.body.conversation.messages[1].request;
    assert.ok(req); assert.equal(req.kind, "video"); assert.equal(req.status, "open"); assert.match(req.reason, /cat video/);
    assert.match(asked[0].system, /never pick a library file for them/);
    await new Promise((r) => setTimeout(r, 30)); // the naming call runs after the reply
    const m2 = await s.call("POST", `/api/studio/assistant/conversations/${id}/messages`, { text: "Here is the video.", attachments: [VID] });
    assert.equal(m2.body.conversation.messages[1].request.status, "done", "the attachment answered the card");
    assert.equal(m2.body.conversation.title, "Cat video from a clip", "named by the model, not the raw message");
    const card = m2.body.conversation.messages[3].choice;
    assert.ok(card); assert.equal(card.mode, "animal");
    assert.deepEqual(card.existing.map((e: any) => e.name), ["Orange cat.jpg"], "the made cat is a free pick");
    assert.match(card.existing[0].url, /^https:\/\/signed\/.*dddddddd.*\.jpg$/, "shown from its own picture when it has no poster");
    assert.ok(!m2.body.conversation.messages[2].text.includes("[People seen"), "the people note stays out of the bubble");
    // Let Clone8 decide: one portrait, one unit of credits, picked for them
    const auto = await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/generate`, { mode: "auto" });
    assert.equal(auto.status, 200, JSON.stringify(auto.body));
    const ch = auto.body.conversation.messages[3].choice;
    assert.equal(ch.auto, true); assert.equal(ch.count, 1); assert.equal(ch.credits, COSTS.character_image);
    assert.equal(sb.calls.filter((x: any) => x.name === "studio_create_job").at(-1).args.p_options.count, 1);
    // an existing character can be picked straight away
    const pickExisting = await s.call("POST", `/api/studio/assistant/conversations/${id}/choices/${card.id}/pick`, { asset_id: CAT });
    assert.equal(pickExisting.status, 200, JSON.stringify(pickExisting.body)); assert.equal(pickExisting.body.conversation.messages[3].choice.picked, CAT);
  } finally { await s.close(); }
});

test("a chat still titled with its first message gets a short name from the model", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const c = convo({ title: "turn this into a cat video then make 3 copies of it", messages: [{ id: "u", role: "user", text: "turn this into a cat video then make 3 copies of it", at: "2026-10-29T00:00:00Z" }, { id: "a", role: "assistant", text: "Which video?", at: "2026-10-29T00:00:00Z" }] });
  tables.studio_conversations.push(c);
  const { fetchFn, asked } = fakeClaude([textReply('"Cat video with three copies."')]);
  assert.equal(await titleIfNeeded(sb, deps(fetchFn), c), true);
  assert.equal(c.title, "Cat video with three copies"); assert.equal(tables.studio_conversations[0].title, "Cat video with three copies");
  assert.ok(asked[0].max_tokens <= 32);
  // a plan-named chat is left alone
  const named = convo({ title: "Five originals", messages: c.messages });
  assert.equal(await titleIfNeeded(sb, deps(fakeClaude([]).fetchFn), named), false);
});


test("YouTube helpers: the binary for this machine, the id in every link shape, yt-dlp's complaints in plain words, and the arguments", async () => {
  const { ytDlpAsset, youtubeId, classifyYtDlpError, ytDlpArgs } = await import("../src/studio-youtube.js");
  assert.equal(ytDlpAsset("linux", "x64"), "yt-dlp_linux"); assert.equal(ytDlpAsset("linux", "arm64"), "yt-dlp_linux_aarch64"); assert.equal(ytDlpAsset("darwin", "arm64"), "yt-dlp_macos");
  for (const u of ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "https://youtube.com/shorts/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"]) assert.equal(youtubeId(u), "dQw4w9WgXcQ", u);
  assert.equal(youtubeId("https://www.youtube.com/@channel"), null);
  assert.equal(classifyYtDlpError("ERROR: [youtube] abc: Sign in to confirm you're not a bot").code, "link_blocked");
  assert.equal(classifyYtDlpError("ERROR: File is larger than max-filesize").code, "link_too_large");
  assert.equal(classifyYtDlpError("abc: Private video. Sign in if you've been granted access").code, "link_no_media");
  assert.equal(classifyYtDlpError("something odd").code, "link_fetch_failed");
  const args = ytDlpArgs("https://youtu.be/x", "/tmp/v.mp4", { maxBytes: 10, maxSeconds: 600, node: "/usr/bin/node" });
  assert.ok(args.includes("--no-playlist")); assert.ok(args.includes("--force-ipv4")); assert.equal(args[args.indexOf("--max-filesize") + 1], "10"); assert.equal(args[args.indexOf("--match-filter") + 1], "duration <= 600"); assert.equal(args[args.length - 1], "https://youtu.be/x");
  assert.equal(args[args.indexOf("--js-runtimes") + 1], "node:/usr/bin/node"); assert.ok(args.indexOf("--no-js-runtimes") < args.indexOf("--js-runtimes"), "deno is turned off before node is named");
  assert.ok(!args.includes("--proxy") && !args.includes("--cookies"), "no proxy or cookies unless given");
  const viaProxy = ytDlpArgs("https://youtu.be/x", "/tmp/v.mp4", { maxBytes: 10, maxSeconds: 600, proxy: "socks5://u:p@proxy.example:1080", cookies: "/tmp/c.txt" });
  assert.equal(viaProxy[viaProxy.indexOf("--proxy") + 1], "socks5://u:p@proxy.example:1080"); assert.equal(viaProxy[viaProxy.indexOf("--cookies") + 1], "/tmp/c.txt");
});

test("the face card offers the made characters that match the ask, not every animal in the library", async () => {
  const { matchingCharacters } = await import("../src/studio-assistant.js");
  const mk = (id: string, name: string, mode: string, prompt?: string) => ({ id, kind: "image", name, probe: { character: true, mode, prompt } });
  const lib = [mk("c", "Character: a tabby cat wearing a hollowed watermelon rind as a helmet", "animal"), mk("t", "Character: a tiger mascot with orange fur in a yellow football kit", "animal"), mk("d", "Character: a golden retriever wearing a black gaming headset", "animal"), mk("h", "Character: a rugged 1980s action-movie hero", "human", "a rugged hero"), { id: "v", kind: "video", name: "clip.mp4", probe: {} }];
  assert.deepEqual(matchingCharacters(lib as any, "A friendly tabby cat, natural look, facing the camera", "animal").map((a) => a.id), ["c"]);
  assert.deepEqual(matchingCharacters(lib as any, "a fox in a scarf", "animal").map((a) => a.id), ["c", "t", "d"], "no word in common: every animal is offered rather than a wrong guess");
  assert.deepEqual(matchingCharacters(lib as any, "two tigers", "animal").map((a) => a.id), ["t"], "plural and singular meet");
  assert.deepEqual(matchingCharacters(lib as any, "a rugged action hero", "human").map((a) => a.id), ["h"]);
});


test("plans: a cast is resolved member by member (presets, made characters, \"$N\"), and a trend can take a fetched clip as its source", async () => {
  const tables = baseTables(); const sb = fakeSb(tables, rpcs(tables));
  const ctx = ctxFor(sb) as any;
  const plan = await pricePlan(ctx, { title: "Trio", steps: [
    { tool: "character", label: "A fox", source: null, options: { mode: "animal", prompt: "a red fox" } },
    { tool: "trend", label: "Car 24 with the three", source: VID, options: { model: "light", trend_name: "Car 24", cast: [{ character: "Noah", label: "left" }, { character_asset_id: CAT, label: "middle" }, { character_asset_id: "$1", label: "right" }] } },
  ] });
  const st = plan.steps[1];
  assert.equal(st.tool, "trend"); assert.equal(st.source, VID); assert.equal(st.options.trend_id, null); assert.equal(st.options.trend_name, "Car 24");
  assert.deepEqual(st.options.cast.map((m: any) => [m.character, m.character_asset_id, m.label]), [["noah", null, "left"], [null, CAT, "middle"], [null, "$1", "right"]]);
  assert.equal(st.estimate, true, "a member made by an earlier step settles when it starts");
  assert.ok(st.credits > 0);
  await assert.rejects(pricePlan(ctx, { title: "x", steps: [{ tool: "recast", label: "x", source: VID, options: { model: "light", cast: [{ character: "Noah" }, { character: "nobody-here" }] } }] }), (e: any) => e.code === "plan_invalid");
});


// ---------------------------------------------------------------------------------------------------
// Posting from the chat: the assistant knows what is linked, offers a publish card after a run and on request, and the
// card's buttons post through the same path as the Publish page. Ayrshare is faked; nothing is called for real.
const SOCIAL_ENV: Record<string, string | undefined> = { ...ENV, STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "ayr-test" };
function withAyr(base: any) {
  const calls: any[] = [];
  const f = async (url: string, init: any) => {
    if (!url.startsWith("https://api.ayrshare.com/api")) return base(url, init);
    const path = url.slice("https://api.ayrshare.com/api".length), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, headers: init.headers });
    if (path === "/user") return new Response(JSON.stringify({ activeSocialAccounts: ["tiktok", "youtube"], displayNames: [{ platform: "tiktok", username: "ann" }, { platform: "youtube", username: "Ann", channelTitle: "Ann Makes" }] }));
    if (path === "/post" && init.method === "POST") return new Response(JSON.stringify({ status: "success", posts: [body.scheduleDate ? { status: "scheduled", id: "ayr-1" } : { status: "success", id: "ayr-1", postIds: body.platforms.map((p: string) => ({ platform: p, status: "success", id: "x", postUrl: `https://${p}.example/1` })) }] }));
    return new Response("{}");
  };
  return { f, calls };
}
const JOBV = "55555555-5555-4555-8555-555555555555";
const doneVideoJob = () => ({ id: JOBV, user_id: ANN, tool: "blueprint", status: "done", options: { copies: 2 }, finished_at: new Date().toISOString(), outputs: [{ index: 1, key: `${ANN}/${JOBV}/01.mp4`, poster_key: `${ANN}/${JOBV}/01.jpg`, kind: "video" }, { index: 2, key: `${ANN}/${JOBV}/02.mp4`, kind: "video" }], created_at: "2026-10-30T00:00:00Z" });

test("knowledge: posting is taught only when on, with what is linked and the quiet rule", () => {
  const base = { tools: { blueprint: true }, costs: COSTS, plans: PLANS, env: ENV, styles: [], user: { plan: "creator", status: "active", balance: 100, parallel_jobs: 2, assets: [], recent_jobs: [] } } as any;
  assert.equal(buildSystemPrompt(base).includes("Posting to their socials"), false);
  const on = buildSystemPrompt({ ...base, social: { enabled: true, linked: ["tiktok", "youtube"], quiet: false } });
  assert.match(on, /Linked right now: TikTok, YouTube/);
  assert.match(on, /Nothing is posted until they press the button/);
  assert.match(buildSystemPrompt({ ...base, social: { enabled: true, linked: [], quiet: true } }), /not now/);
  assert.equal(/ayrshare/i.test(on), false, "the provider is never named");
});

test("a finished run offers its final videos for posting; with nothing linked and a recent no, it stays quiet", async () => {
  for (const [linked, prefs, expectCard] of [[true, [], true], [false, [], true], [false, [{ user_id: ANN, connect_dismissed_at: new Date().toISOString(), connect_dismissals: 1 }], false]] as const) {
    const tables = { ...baseTables(), studio_social_profiles: linked ? [{ user_id: ANN, profile_key: "pk", accounts: [{ platform: "tiktok" }] }] : [], studio_social_prefs: [...prefs] } as any;
    const sb = fakeSb(tables, rpcs(tables));
    const ctx = ctxFor(sb);
    const plan = await pricePlan(ctx as any, { title: "Two originals", steps: [{ tool: "blueprint", label: "Two originals", source: VID, options: { copies: 2 } }] });
    const c = convo({ plan }); tables.studio_conversations.push(c);
    startRun(c);
    const d = deps(fakeClaude([]).fetchFn, { env: SOCIAL_ENV });
    await advanceRun(sb, d, c);
    Object.assign(tables.studio_jobs[0], { status: "done", outputs: [{ index: 1, key: `${ANN}/job-1/01.mp4`, poster_key: `${ANN}/job-1/01.jpg`, kind: "video" }, { index: 2, key: `${ANN}/job-1/02.mp4`, kind: "video" }] });
    await advanceRun(sb, d, c);
    const last = c.messages[c.messages.length - 1];
    assert.equal(c.run!.status, "done");
    assert.equal(!!last.publish, expectCard, `linked=${linked} quiet=${prefs.length > 0}`);
    if (expectCard) {
      assert.equal(last.publish!.items.length, 2); assert.equal(last.publish!.auto, true);
      assert.match(last.text, linked ? /post now or schedule/ : /Connect your socials/);
    } else assert.match(last.text, /results are in the cards/);
  }
});

test("offer_post: the assistant shows a card for the latest video, prefilled with what was asked", async () => {
  const tables = { ...baseTables(), studio_jobs: [doneVideoJob()], studio_social_profiles: [{ user_id: ANN, profile_key: "pk", accounts: [{ platform: "tiktok" }] }], studio_social_prefs: [] } as any;
  const sb = fakeSb(tables, rpcs(tables));
  const { fetchFn, asked } = fakeClaude([toolReply("offer_post", { videos: ["latest"], action: "schedule", platforms: ["tiktok", "instagram"], note: "playful" }), textReply("Pick a time on the card.")]);
  const c = convo(); tables.studio_conversations.push(c);
  const out = await runTurn(sb, deps(fetchFn, { env: SOCIAL_ENV }), c, { text: "schedule my latest video on tiktok and instagram", attachments: [], links: [] });
  const card = out.messages[out.messages.length - 1].publish!;
  assert.equal(card.items.length, 2); assert.equal(card.items[0].job_id, JOBV);
  assert.equal(card.suggested!.action, "schedule"); assert.deepEqual(card.suggested!.platforms, ["tiktok", "instagram"]); assert.equal(card.suggested!.note, "playful");
  const toolResult = JSON.parse(asked[1].messages.at(-1).content[0].content);
  assert.match(toolResult.note, /instagram is not linked/);
  assert.match(asked[0].system, /Linked right now: TikTok/);
});

test("publish card routes: linking is noticed once, Post now goes out through the shared path, a used card is closed, Ignore closes", async () => {
  const tables = { ...baseTables(), studio_jobs: [doneVideoJob()], studio_social_profiles: [{ user_id: ANN, profile_key: "pk-ann", accounts: [] }], studio_social_prefs: [], studio_social_posts: [] } as any;
  const sb = fakeSb(tables, rpcs(tables));
  const c = convo({ messages: [
    { id: "m1", role: "assistant", text: "All done.", at: "2026-10-30T00:00:00Z", publish: { id: "card-1", items: [{ job_id: JOBV, output_key: `${ANN}/${JOBV}/01.mp4` }], status: "open", linked_seen: [] } },
    { id: "m2", role: "assistant", text: "Another.", at: "2026-10-30T00:00:01Z", publish: { id: "card-2", items: [{ job_id: JOBV, output_key: `${ANN}/${JOBV}/02.mp4` }], status: "open", linked_seen: [] } },
  ] as any });
  tables.studio_conversations.push(c);
  const ayr = withAyr(fakeClaude([]).fetchFn);
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: ANN, email: "ann@synthetic.invalid" }; req.profile = { role: "user", user_id: ANN }; next(); });
  app.use(accountAccess(() => sb));
  registerAssistant(app, () => sb, deps(ayr.f, { env: SOCIAL_ENV }));
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/studio/assistant/conversations/${CONVO}`;
  const post = async (path: string, body: any = {}) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const l1 = await post("/social-linked");
    assert.match(l1.body.conversation.messages.at(-1).text, /TikTok and YouTube are linked/);
    const n = l1.body.conversation.messages.length;
    assert.equal((await post("/social-linked")).body.conversation.messages.length, n, "the same networks are announced once");
    const sent = await post("/publish/card-2", { action: "now", platforms: ["tiktok"], caption: "Launch day" });
    assert.equal(sent.status, 200);
    const msgs = sent.body.conversation.messages;
    assert.equal(msgs.find((m: any) => m.publish?.id === "card-2").publish.status, "sent");
    assert.match(msgs.at(-1).text, /On its way to TikTok/);
    assert.equal(tables.studio_social_posts.length, 1);
    assert.equal(tables.studio_social_posts[0].conversation_id, CONVO);
    const postCall = ayr.calls.find((x) => x.path === "/post");
    assert.equal(postCall.headers["Profile-Key"], "pk-ann"); assert.equal(postCall.body.post, "Launch day");
    assert.equal((await post("/publish/card-2", { action: "now", platforms: ["tiktok"] })).body.error, "card_closed");
    const ig = await post("/publish/card-1/ignore");
    assert.equal(ig.body.conversation.messages.find((m: any) => m.publish?.id === "card-1").publish.status, "ignored");
    assert.equal(tables.studio_social_prefs.length, 0, "with networks linked, ignoring is not a no to linking");
  } finally { await new Promise((r) => server.close(r)); }
});

test("saving a chat never undoes a card press made meanwhile, and keeps the messages the press added", () => {
  const card = (status: any, extra: any = {}) => ({ id: "c1", items: [], status, ...extra });
  const mine: any[] = [{ id: "m1", role: "user", text: "hi", at: "1" }, { id: "m2", role: "assistant", text: "post?", at: "2", publish: card("open", { linked_seen: ["tiktok"] }) }, { id: "m4", role: "assistant", text: "new reply", at: "4" }];
  const stored: any[] = [{ id: "m1", role: "user", text: "hi", at: "1" }, { id: "m2", role: "assistant", text: "post?", at: "2", publish: card("sent", { post_ids: ["p1"], linked_seen: ["youtube"] }) }, { id: "m3", role: "assistant", text: "On its way", at: "3" }];
  const out = mergeMessages(stored, mine);
  assert.deepEqual(out.map((m) => m.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(out[1].publish!.status, "sent"); assert.deepEqual(out[1].publish!.post_ids, ["p1"]);
  assert.deepEqual(out[1].publish!.linked_seen!.sort(), ["tiktok", "youtube"]);
  // a card only moves forward: an open stored card does not reopen one this save closed
  const back = mergeMessages([{ ...stored[1], publish: card("open") }], [{ ...stored[1], publish: card("ignored") }]);
  assert.equal(back[0].publish!.status, "ignored");
});
