// Story styles (docs/story-styles/PLAN.md): Block Town ("blocky") on the website and through the connector, both as
// Signature by our author and written in the person's own chat; its switches; a person's own script; that the house
// look's requests are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StoryError, parseStoryOptions, quoteStory, storyByoCostUsd, storyPremiumCostUsd, storyPremiumCredits, storyStylesOpen } from "../src/studio-stories.ts";
import { studioRequest, MCP_TOOLS, BYO_MCP_TOOLS, runTool, type StudioCall } from "../src/studio-mcp.ts";
import { toolsEnabled } from "../src/studio.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const LIVE = { STUDIO_STORIES_ENABLED: "true", STUDIO_KAGE_MOTION_ENABLED: "true", STUDIO_STORY_EXPLAINER_ENABLED: "true", STUDIO_STORY_EXPLAINER_OPEN: "true", STUDIO_STORY_PREMIUM_ENABLED: "true", STUDIO_STORY_PREMIUM_OPEN: "true", STUDIO_STORY_BYO_ENABLED: "true", STUDIO_STORY_BYO_OPEN: "true" };
const STYLES = { ...LIVE, STUDIO_STORY_STYLES_ENABLED: "true" };
const OPEN = { ...STYLES, STUDIO_STORY_STYLES_OPEN: "true" };
const ask = { topic: "A town where nobody is ever late", style: "blocky", seconds: 45 };
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof StoryError ? e.code : String(e); } };
const SCRIPT = "Every night at midnight, the streetlights go out. All of them. Except one. Nobody knows why. Nina is eight, and she has a plan.";

test("styles: off by default, then the owner only, then everyone", () => {
  assert.equal(code(() => quoteStory(LIVE, PLANS, ask, { owner: true })), "story_style_off", "not switched on: refused even for the owner");
  assert.equal(code(() => quoteStory(STYLES, PLANS, ask)), "story_style_off", "switched on but not open: customers refused");
  assert.equal(code(() => quoteStory(STYLES, PLANS, ask, { owner: true })), null, "the owner may");
  assert.equal(code(() => quoteStory(OPEN, PLANS, ask)), null, "open: everyone");
  assert.equal(storyStylesOpen(OPEN), true); assert.equal(storyStylesOpen(STYLES), false);
  assert.equal(toolsEnabled(LIVE as any).story_styles, false); assert.equal(toolsEnabled(OPEN as any).story_styles, true);
  assert.equal(code(() => quoteStory({ ...OPEN, STUDIO_STORY_PREMIUM_ENABLED: "" }, PLANS, ask)), "story_engine_off", "Block Town is Signature: no Signature, no Block Town");
});

test("Block Town is always Signature, priced as Signature; in a chat, as in-chat Signature with its cost ceiling", () => {
  const q = quoteStory(OPEN, PLANS, ask);
  assert.deepEqual(q.options.story, { topic: ask.topic, seconds: 45, style: "blocky", engine: "premium" });
  assert.equal(q.credits, storyPremiumCredits(OPEN, PLANS)); assert.equal(q.options.cost_usd, storyPremiumCostUsd(OPEN)); assert.equal(q.options.voice, "jesse");
  assert.equal(q.summary, "45 s Block Town story · Signature · vertical 9:16 · narrated");
  assert.equal(code(() => parseStoryOptions({ ...ask, engine: "standard" })), "story_engine", "never made by the engine");
  const byo = quoteStory(OPEN, PLANS, { ...ask, byo: true });
  assert.deepEqual(byo.options.story, { topic: ask.topic, seconds: 45, style: "blocky", engine: "premium", byo: true });
  assert.equal(byo.options.cost_usd, storyByoCostUsd(OPEN)); assert.ok(byo.credits < q.credits, "cheaper written in the person's chat"); assert.ok(byo.options.cost_cap_usd > 0, "with its cost ceiling");
  assert.equal(code(() => quoteStory({ ...OPEN, STUDIO_STORY_BYO_OPEN: "" }, PLANS, { ...ask, byo: true })), "story_byo_off", "in-chat refused while closed, never made by our model instead");
  assert.equal(parseStoryOptions({ ...ask, seconds: 50 }).seconds, 45, "the nearest Block Town length"); assert.equal(parseStoryOptions({ ...ask, seconds: 90 }).seconds, 90); assert.equal(parseStoryOptions({ ...ask, seconds: 200 }).seconds, 120);
});

test("a person's own script: kept, its length its own, a topic made from it when none is given", () => {
  const o = parseStoryOptions({ style: "blocky", script: `  ${SCRIPT}\n\n` });
  assert.equal(o.script, SCRIPT); assert.equal(o.topic, SCRIPT.slice(0, 120)); assert.equal(o.seconds, Math.max(15, Math.round(SCRIPT.split(" ").length / 3)), "a short script still makes at least 15 s"); assert.equal(parseStoryOptions({ style: "blocky", script: "word ".repeat(200) }).seconds, 67);
  const q = quoteStory(OPEN, PLANS, { style: "blocky", script: SCRIPT, topic: "The last light" });
  assert.equal(q.options.story.script, SCRIPT); assert.match(q.summary, /^Your script as a Block Town story/);
  assert.equal(code(() => parseStoryOptions({ style: "blocky", script: "Too short to tell." })), "story_script");
  assert.equal(code(() => parseStoryOptions({ style: "blocky", script: "word ".repeat(401) })), "story_script");
});

test("the house look is untouched; an unknown style is refused", () => {
  const plain = { topic: "How does a heart pump blood?", kind: "explainer", seconds: 50 };
  assert.deepEqual(quoteStory(OPEN, PLANS, plain), quoteStory(LIVE, PLANS, plain));
  assert.deepEqual(quoteStory(OPEN, PLANS, { ...plain, style: "worlds" }), quoteStory(LIVE, PLANS, plain), "worlds by name is the same");
  assert.equal(code(() => parseStoryOptions({ ...plain, style: "anime" })), "story_style");
});

test("the connector: style and script on the story tools, Block Town in the chat as Signature", () => {
  const make = MCP_TOOLS.find((t) => t.name === "clone8_make_story")!; const chat = BYO_MCP_TOOLS.find((t) => t.name === "clone8_make_signature_in_chat")!;
  for (const t of [make, chat]) { const p = (t.inputSchema as any).properties; assert.deepEqual(p.style.enum, ["worlds", "blocky"]); assert.equal(p.script.type, "string"); }
  assert.deepEqual((studioRequest("clone8_make_story", { topic: "A town where nobody is ever late", style: "blocky" }) as any).options, { topic: "A town where nobody is ever late", style: "blocky", engine: "premium", seconds: 45 });
  assert.deepEqual((studioRequest("clone8_make_signature_in_chat", { topic: "The last light", style: "blocky", script: ` ${SCRIPT} ` }) as any).options, { topic: "The last light", style: "blocky", engine: "premium", seconds: 45, script: SCRIPT, byo: true });
  assert.equal((studioRequest("clone8_quote", { kind: "story", style: "blocky", seconds: 30 }) as any).options.seconds, 30);
  // the house look through the connector is as before
  assert.deepEqual((studioRequest("clone8_make_story", { topic: "abcdefgh" }) as any).options, { topic: "abcdefgh", seconds: 50, kind: "explainer", format: "auto", world: "auto", captions: "auto", sidekick: "", stage: "all" });
  // and what the website would quote is what the connector asks for
  const q = quoteStory(OPEN, PLANS, (studioRequest("clone8_make_signature_in_chat", { topic: "The last light", style: "blocky" }) as any).options);
  assert.equal(q.options.story.byo, true); assert.equal(q.options.story.style, "blocky");
});

test("the connector's catalog lists Block Town only when it is open", async () => {
  const call = (tools: Record<string, boolean>): StudioCall => async (_m, path) => (path === "/api/studio/plans" ? { status: 200, json: { tools } } : { status: 403, json: {} });
  const off = await runTool("clone8_catalog", {}, call({ story_explainer: true, story_premium: true }));
  const on = await runTool("clone8_catalog", {}, call({ story_explainer: true, story_premium: true, story_styles: true }));
  const text = (r: any) => JSON.stringify(r);
  assert.doesNotMatch(text(off), /Block Town/); assert.match(text(on), /Block Town/);
});

test("templates: a known id sets the length and reaches the job; an unknown one is refused; the connector passes it", async () => {
  const { STORY_TEMPLATES } = await import("../src/studio-story-templates.ts");
  assert.ok(STORY_TEMPLATES.length >= 6); assert.ok(STORY_TEMPLATES.every((t) => /^[a-z-]+$/.test(t.id) && t.name && t.example));
  const q = quoteStory(OPEN, PLANS, { style: "blocky", topic: "In this town, you must never look up", template: "one-rule" });
  assert.equal(q.options.story.template, "one-rule"); assert.equal(q.options.story.seconds, 120); assert.match(q.summary, /\(The One Rule\)/);
  assert.equal(quoteStory(OPEN, PLANS, { style: "blocky", topic: "In this town, your shoe size decides your job", template: "number-decides" }).options.story.seconds, 90);
  assert.equal(quoteStory(OPEN, PLANS, { style: "blocky", topic: "In this town, you must never look up", template: "one-rule", seconds: 60 }).options.story.seconds, 60, "the person's own length wins");
  assert.equal(code(() => parseStoryOptions({ style: "blocky", topic: "In this town, you must never look up", template: "nope" })), "story_template");
  assert.deepEqual((studioRequest("clone8_make_story", { topic: "In this town, nobody has ever heard music", style: "blocky", template: "never-seen" }) as any).options, { topic: "In this town, nobody has ever heard music", style: "blocky", engine: "premium", seconds: 120, template: "never-seen" });
  const chat = BYO_MCP_TOOLS.find((t) => t.name === "clone8_make_signature_in_chat")!; assert.deepEqual((chat.inputSchema as any).properties.template.enum, STORY_TEMPLATES.map((t) => t.id));
});
