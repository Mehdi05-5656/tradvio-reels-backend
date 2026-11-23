import test from "node:test";
import assert from "node:assert/strict";
import { analyze, type PostRow } from "../src/studio-performance.js";
import { captionShape, confidenceOf, fillPostFeatures, permutationP, readCovers, whatsWorking, FEATURES_VERSION } from "../src/studio-post-features.js";
import { chatBrief } from "../src/studio-insights.js";

const DAY = 86400_000, NOW = Date.parse("2026-11-20T20:00:00Z");
const U = "11111111-1111-4111-8111-111111111111";

function post(i: number, over: Partial<PostRow> = {}): PostRow {
  return { id: `p${i}`, platform: "tiktok", account_key: "tt1", platform_post_id: String(7_000_000 + i), url: `https://www.tiktok.com/@ann/video/${7_000_000 + i}`, caption: `post ${i}`,
    published_at: new Date(NOW - (i + 1) * DAY).toISOString(), duration_s: 20, views: 1000, likes: 50, comments: 5, shares: 5, saves: 5, ...over };
}
const feat = (face: boolean, opts: { text?: boolean; format?: string; tags?: string[]; chars?: number } = {}) => ({
  v: FEATURES_VERSION, caption: { chars: opts.chars ?? 40, first_line_chars: 40, words: 8, hashtags: opts.tags ?? [], question: false, emoji: 0, cta: false, mentions: 0 },
  cover: { face, people: face ? "one" : "none", text_on_cover: opts.text ?? false, cover_text: null, format: opts.format ?? "talking_head", subject: "cats" }, made: null,
});

test("caption shape: text length without the hashtags, first line, question, emoji, call to action", () => {
  const c = captionShape("japan kitkat flavours ranked?\nlink in bio 🍫🍫 #japan #KitKat #japan");
  assert.deepEqual(c.hashtags, ["#japan", "#kitkat"]);
  assert.equal(c.first_line_chars, "japan kitkat flavours ranked?".length);
  assert.equal(c.question, true); assert.equal(c.emoji, 2); assert.equal(c.cta, true);
  assert.equal(captionShape(null).chars, 0);
});

test("permutation test: a clear gap is sure, a coin flip is not; confidence needs posts on both sides", () => {
  const hi = [3, 3.2, 2.8, 3.5, 2.9, 3.1, 3.3, 2.7, 3.4], lo = [1, 0.9, 1.1, 0.8, 1.2, 1, 0.95, 1.05, 0.9];
  const p = permutationP(hi, lo);
  assert.ok(p < 0.05, `p=${p}`);
  assert.equal(confidenceOf(9, 9, p), "strong");
  const same = permutationP([1, 1.2, 0.9, 1.1], [1.05, 0.95, 1.15, 1]);
  assert.ok(same > 0.3, `p=${same}`);
  assert.equal(confidenceOf(4, 4, same), "early");
  assert.equal(confidenceOf(2, 9, 0.001), null);
  assert.equal(permutationP(hi, lo), p, "same data, same answer");
});

test("what's working: faces on covers win with a firm card and a Blueprint action; YouTube never counts", () => {
  const rows: PostRow[] = [];
  for (let i = 0; i < 10; i++) rows.push(post(i, { views: [3000, 3200, 2800, 3500, 2900, 3100, 3300, 2700, 3400, 3000][i], features: feat(true, { tags: ["#cats"] }) }));
  for (let i = 10; i < 20; i++) rows.push(post(i, { views: [1000, 900, 1100, 800, 1200, 1000, 950, 1050, 900, 1000][i - 10], features: feat(false, { tags: ["#pets"] }) }));
  // a YouTube Short with huge views and a face: it must not move anything
  rows.push({ ...post(30, { views: 900_000, features: feat(true) }), platform: "youtube", account_key: "yt1", url: "https://www.youtube.com/shorts/abc" });
  const a = analyze(rows, [], { range_days: 28, now: NOW, offset_min: 0, platform: null });
  assert.equal(a.posts.find((p) => p.id === "p30")!.multiple, null, "YouTube stays raw");
  const w = whatsWorking(a);
  assert.equal(w.youtube_raw, true);
  const face = w.cards.find((c) => c.kind === "cover_face")!;
  assert.ok(face, JSON.stringify(w.cards.map((c) => c.kind)));
  assert.equal(face.title, "Covers with a face do better");
  assert.equal(face.confidence, "strong"); assert.equal(face.a.n, 10); assert.equal(face.b.n, 10);
  assert.ok(face.ratio! > 2.5);
  assert.equal(face.action?.tool, "blueprint"); assert.equal(face.action?.post_id, face.win_ids[0]);
  assert.ok(!face.win_ids.includes("p30"));
  const tags = w.cards.find((c) => c.kind === "hashtags");
  assert.ok(tags && tags.action?.tool === "copy" && /#cats/.test(tags.action.text!));
  // the same groups the other way round are worded for the winner
  const flipped = whatsWorking(analyze(rows.map((r) => ({ ...r, features: r.features ? { ...r.features, cover: { ...r.features.cover, face: !r.features.cover.face } } : r.features })), [], { range_days: 28, now: NOW, offset_min: 0, platform: null }));
  assert.equal(flipped.cards.find((c) => c.kind === "cover_face")!.title, "Covers without a face do better");
  // the chat hears the firm findings
  assert.ok(chatBrief(a, null).some((l) => /Covers with a face/.test(l)));
});

test("what's working: too few posts say so instead of guessing; no difference makes no card", () => {
  const few = analyze([post(0, { features: feat(true) }), post(1, { features: feat(false) })], [], { range_days: 28, now: NOW, offset_min: 0, platform: null });
  const w = whatsWorking(few);
  assert.equal(w.cards.length, 0);
  assert.ok(w.pending.some((x) => /Post \d+ more/.test(x)));
  const flat: PostRow[] = Array.from({ length: 16 }, (_, i) => post(i, { views: 1000 + (i % 3) * 10, features: feat(i % 2 === 0) }));
  assert.equal(whatsWorking(analyze(flat, [], { range_days: 28, now: NOW, offset_min: 0, platform: null })).cards.filter((c) => c.kind === "cover_face").length, 0);
});

/** A tiny stand-in for the database calls fillPostFeatures makes. */
function fakeSb(rows: any[], jobs: any[] = []) {
  const updates: any[] = [];
  const q = (data: any[]) => { const o: any = { select: () => o, eq: () => o, or: () => o, order: () => o, limit: () => o, in: () => o, then: (r: any) => r({ data, error: null }) }; return o; };
  return {
    updates,
    from: (t: string) => t === "studio_jobs" ? q(jobs) : { ...q(rows), update: (v: any) => { const o: any = { eq: (k: string, x: any) => { if (k === "id") updates.push({ id: x, ...v }); return o; }, then: (r: any) => r({ error: null }) }; return o; } },
    storage: { from: () => ({ createSignedUrls: async (keys: string[]) => ({ data: keys.map((k) => ({ path: k, signedUrl: k === "bad.jpg" ? null : `https://signed/${k}`, error: k === "bad.jpg" ? "x" : null })) }) }) },
  } as any;
}

test("filling features: captions counted for all, covers read in batches, a bad image doesn't block the queue, the tool behind Clone8 posts", async () => {
  const rows = [
    { id: "a", platform: "tiktok", caption: "short one #cats", thumb_key: "a.jpg", job_id: "j1" },
    { id: "b", platform: "instagram", caption: "no cover", thumb_key: null, job_id: null },
    { id: "c", platform: "tiktok", caption: "broken cover", thumb_key: "c.jpg", job_id: null },
  ];
  const sb = fakeSb(rows, [{ id: "j1", tool: "blueprint" }]);
  let calls = 0;
  const read = async (posts: any[]) => {
    calls++;
    if (posts.some((p) => p.id === "c")) throw new Error("features_http_400: could not fetch image");
    return new Map(posts.map((p) => [p.id, { face: true, people: "one", text_on_cover: false, cover_text: null, format: "talking_head", subject: "cats" } as any]));
  };
  const r = await fillPostFeatures(sb, U, { log: () => {}, readCovers: read as any });
  assert.equal(r.read, 3, "the broken one is saved without a cover rather than retried forever");
  assert.equal(calls, 3, "batch, then one by one after a 4xx");
  const a = sb.updates.find((x: any) => x.id === "a");
  assert.equal(a.features.cover.face, true); assert.deepEqual(a.features.caption.hashtags, ["#cats"]); assert.deepEqual(a.features.made, { tool: "blueprint" });
  assert.equal(sb.updates.find((x: any) => x.id === "b").features.cover, null);
  assert.equal(sb.updates.find((x: any) => x.id === "c").features.cover, null);
  // a busy model leaves the posts for next time
  const sb2 = fakeSb([rows[0]]);
  const r2 = await fillPostFeatures(sb2, U, { log: () => {}, readCovers: (async () => { throw new Error("features_http_529: overloaded"); }) as any });
  assert.equal(r2.read, 0); assert.equal(sb2.updates.length, 0);
});

test("reading covers: images by link, a JSON schema, unknown ids and odd values dropped, cost logged", async () => {
  let body: any = null; const logs: string[] = [];
  const f = (async (_u: string, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: "claude-haiku-5-5", usage: { input_tokens: 3000, output_tokens: 200 }, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ posts: [
      { id: "x", face: true, people: "one", text_on_cover: true, cover_text: "3 kitkats  you never tried", format: "tutorial", subject: "japanese snacks" },
      { id: "ghost", face: true, people: "one", text_on_cover: false, cover_text: null, format: "skit", subject: "?" },
      { id: "y", face: false, people: "lots", text_on_cover: false, cover_text: null, format: "dance", subject: "x" },
    ] }) }] }), { status: 200 });
  }) as any;
  const m = await readCovers([{ id: "x", caption: "c", thumb_url: "https://signed/x" }, { id: "y", caption: null, thumb_url: "https://signed/y" }], { env: { ANTHROPIC_API_KEY: "k" }, fetch: f, log: (l) => logs.push(l) });
  assert.equal(body.model, "claude-haiku-5-5"); assert.equal(body.output_config.format.type, "json_schema");
  assert.ok(body.messages[0].content.some((c: any) => c.type === "image" && c.source.url === "https://signed/x"));
  assert.equal(m.get("x")!.cover_text, "3 kitkats you never tried"); assert.equal(m.has("ghost"), false);
  assert.equal(m.get("y")!.people, null); assert.equal(m.get("y")!.format, null);
  assert.ok(logs.some((l) => /\[cost\] claude .*post_features/.test(l)));
});
