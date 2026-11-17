import test from "node:test";
import assert from "node:assert/strict";
import { cleanHooks, focusTrack, hookMessage, writeHooks, HOOK_SCHEMA } from "../src/studio-blueprints-read.js";
import type { CapWord } from "../src/caption-engine.js";

// 30 words, one every 0.5 s from 0 to 15 s
const WORDS: CapWord[] = Array.from({ length: 30 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));

test("the message numbers every word with its time and asks for the count", () => {
  const m = hookMessage(WORDS, 5, "travel fans");
  assert.match(m, /\[0 @0\.00\] w0/);
  assert.match(m, /\[29 @14\.50\] w29/);
  assert.match(m, /Write 5 cold opens/);
  assert.match(m, /for: travel fans/);
});

test("cleanHooks keeps good ranges and drops the rest", () => {
  const raw = { hooks: [
    { first: 8, last: 12, title: "I counted every *KitKat* here", why: "x" },      // 4.0-6.4 s: ok
    { first: 0, last: 4, title: "Opening line again", why: "x" },                  // inside the first 3 s
    { first: 10, last: 13, title: "Overlaps the first one", why: "x" },             // overlaps
    { first: 20, last: 29, title: "Way *too* long a *cold* *open*", why: "x" },     // 10-14.4 s: trimmed to 6 s, stars stripped (3)
    { first: 14, last: 14, title: "Too short", why: "x" },                          // 0.4 s
    { first: 15, last: 40, title: "Out of range", why: "x" },
    { first: 16, last: 18, title: "#ad buy now", why: "x" },                        // hashtag
    { first: 16, last: 19, title: "Unbalanced *stars here", why: "x" },             // stars removed, kept
  ] };
  const h = cleanHooks(raw, WORDS, 10);
  assert.deepEqual(h.map((x) => x.title), ["I counted every *KitKat* here", "Way too long a cold open", "Unbalanced stars here"]);
  assert.deepEqual([h[0].start, h[0].end], [4, 6.4]);
  assert.ok(h[1].end! - h[1].start! <= 6 + 1e-9);
  assert.deepEqual(h.map((x) => x.id), ["h1", "h2", "h3"]);
  assert.equal(cleanHooks(raw, WORDS, 1).length, 1);
  assert.deepEqual(cleanHooks({ nope: 1 }, WORDS, 3), []);
});

test("writeHooks: one call, the schema, the model switch; extra asked for, n returned", async () => {
  let body: any = null;
  const fetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    const hooks = [8, 16, 22].map((f) => ({ first: f, last: f + 3, title: `Line *${f}* is good`, why: "y" }));
    return new Response(JSON.stringify({ model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: "text", text: JSON.stringify({ hooks }) }] }), { status: 200 });
  }) as any;
  const logs: string[] = [];
  const h = await writeHooks({ env: { ANTHROPIC_API_KEY: "k", STUDIO_BLUEPRINTS_HOOK_MODEL: "claude-test" }, fetch, log: (l) => logs.push(l) }, WORDS, { n: 2 });
  assert.equal(h.length, 2);
  assert.equal(body.model, "claude-test");
  assert.deepEqual(body.output_config.format.schema, HOOK_SCHEMA);
  assert.match(body.messages[0].content, /Write 4 cold opens/);
  assert.ok(logs.some((l) => l.includes("blueprints_hooks")), "a cost line is logged");
});

test("writeHooks refuses to call for a near-silent video", async () => {
  const h = await writeHooks({ env: { ANTHROPIC_API_KEY: "k" }, fetch: (() => { throw new Error("no call expected"); }) as any }, WORDS.slice(0, 3), { n: 3 });
  assert.deepEqual(h, []);
});

test("focusTrack: faces nudged up by a fifth of their height, subjects as they are, screens skipped", () => {
  const t = focusTrack([
    { t: 0, kind: "face", x: 0.5, y: 0.5, h: 0.5 },
    { t: 1, kind: "subject", x: 0.3, y: 0.6, h: 0.2 },
    { t: 2, kind: "screen", x: 0.5, y: 0.5, h: 0 },
    { t: 3, kind: "face", x: 1.2, y: 0.05, h: 0.4 },
  ]);
  assert.deepEqual(t, [{ t: 0, cx: 0.5, cy: 0.4, h: 0.5 }, { t: 1, cx: 0.3, cy: 0.6, h: 0 }, { t: 3, cx: 1, cy: 0, h: 0.4 }]);
});

test("hasBurnedCaptions: at most six stills, the schema, a cost line; true only when the model says so", async () => {
  const { hasBurnedCaptions, CAPTION_CHECK_SCHEMA } = await import("../src/studio-blueprints-read.js");
  let body: any = null; const logs: string[] = [];
  const fetch = (async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ model: body.model, stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify({ captions: true }) }] }), { status: 200 }); }) as any;
  const frames = Array.from({ length: 20 }, (_, i) => ({ t: i, jpg: Buffer.from(`f${i}`) }));
  assert.equal(await hasBurnedCaptions({ env: { ANTHROPIC_API_KEY: "k" }, fetch, log: (l) => logs.push(l) }, frames), true);
  assert.equal(body.messages[0].content.filter((c: any) => c.type === "image").length, 6);
  assert.deepEqual(body.output_config.format.schema, CAPTION_CHECK_SCHEMA);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.ok(logs.some((l) => l.includes("blueprints_caption_check")));
  assert.equal(await hasBurnedCaptions({ env: { ANTHROPIC_API_KEY: "k" }, fetch: (() => { throw new Error("no call"); }) as any }, []), false);
});
