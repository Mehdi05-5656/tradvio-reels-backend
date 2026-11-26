import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_TOOLS, runModelTool } from "../src/studio-mcp-models.js";
import { fetchLinkBytes, sniff, MediaLinkError } from "../src/studio-media-link.js";
import { MCP_TOOLS } from "../src/studio-mcp.js";

type Call = { method: string; path: string; body?: any };
const fakeStudio = (answers: Record<string, { status: number; json: any }>) => {
  const calls: Call[] = [];
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => { calls.push({ method, path, body }); const k = `${method} ${path.split("?")[0]}`; return answers[k] ?? { status: 404, json: { error: "nope" } }; };
  return { call, calls };
};
const ME = { status: 200, json: { balance: 900, active: true } };
const QUOTE = { status: 200, json: { credits: 120, summary: "5 s · 120" } };

test("the model tools have unique names, none clashing with the connector's own", () => {
  const names = [...MCP_TOOLS, ...MODEL_TOOLS].map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of MODEL_TOOLS) assert.ok(t.description.length > 40, `${t.name} explains itself`);
});

test("a model run without confirm prices it and spends nothing; with confirm it starts", async () => {
  const s = fakeStudio({ "POST /api/studio/quote": QUOTE, "GET /api/studio/me": ME, "POST /api/studio/jobs": { status: 201, json: { job: { id: "job-1" } } } });
  const price = await runModelTool("clone8_generate", { model: "kling-video/v4.0/text-to-video", params: { prompt: "a horse" } }, s.call);
  assert.match(price!.content[0].text, /120 credits/);
  assert.ok(!s.calls.some((c) => c.path === "/api/studio/jobs"), "no job without confirm");
  assert.deepEqual(s.calls.find((c) => c.path === "/api/studio/quote")!.body, { tool: "instrument", asset_id: null, options: { endpoint: "kling-video/v4.0/text-to-video", params: { prompt: "a horse" }, inputs: {} } });
  const go = await runModelTool("clone8_generate", { model: "kling-video/v4.0/text-to-video", params: { prompt: "a horse" }, confirm: true }, s.call);
  assert.equal(go!.structuredContent?.job_id, "job-1");
});

test("a preset run sends the preset, its media and its line; the recipe is the server's", async () => {
  const s = fakeStudio({ "POST /api/studio/quote": QUOTE, "GET /api/studio/me": ME });
  await runModelTool("clone8_run_preset", { preset: "action-figure", media: { image_urls: "asset-1" }, text: "CAPTAIN" }, s.call);
  assert.deepEqual(s.calls.find((c) => c.path === "/api/studio/quote")!.body.options, { preset: "action-figure", inputs: { image_urls: "asset-1" }, params: { text: "CAPTAIN" } });
});

test("no plan: the price and where to get a plan, nothing started even with confirm", async () => {
  const s = fakeStudio({ "POST /api/studio/quote": QUOTE, "GET /api/studio/me": { status: 200, json: { balance: 0, active: false } } });
  const r = await runModelTool("clone8_generate", { model: "x", confirm: true }, s.call);
  assert.match(r!.content[0].text, /needs a Clone8 plan/);
  assert.ok(!s.calls.some((c) => c.path === "/api/studio/jobs"));
});

test("models are grouped by family with each mode's id; presets list what they need; a refusal is said plainly", async () => {
  const inst = { status: 200, json: { instruments: [
    { id: "kling-video/v4.0/text-to-video", family: "Kling 4.0", provider: "Kling", output: "video", kind_label: "Video from words", summary: "s", fields: [], media: [], price_hint: { credits: 24, unit: "a second", per: "second" } },
    { id: "kling-video/v4.0/image-to-video", family: "Kling 4.0", provider: "Kling", output: "video", kind_label: "Video from a picture", summary: "s", fields: [], media: [] },
    { id: "clone8/soul/v2/standard", family: "Soul 2", provider: "Clone8", output: "image", kind_label: "Picture from words", summary: "s", fields: [], media: [] }] } };
  const s = fakeStudio({ "GET /api/studio/instruments": inst, "GET /api/studio/presets": { status: 200, json: { presets: [{ id: "paparazzi", title: "Paparazzi", line: "Flashes.", output: "video", model: "Kling 4.0", inputs: [{ field: "image_url", label: "A photo of you" }], text: null, draft: false }, { id: "draft", title: "D", line: "", output: "video", model: null, inputs: [], text: null, draft: true }] } } });
  const m = await runModelTool("clone8_models", { output: "video" }, s.call);
  assert.match(m!.content[0].text, /Kling 4\.0 \(Kling, video\): Video from words = kling-video\/v4\.0\/text-to-video \[from 24 credits a second\]; Video from a picture/);
  assert.doesNotMatch(m!.content[0].text, /Soul/);
  const p = await runModelTool("clone8_presets", {}, s.call);
  assert.match(p!.content[0].text, /paparazzi: Paparazzi .* Needs: A photo of you as media\.image_url/);
  assert.doesNotMatch(p!.content[0].text, /draft/);
  const refused = await runModelTool("clone8_add_media", { url: "http://x" }, fakeStudio({ "POST /api/studio/assets/from-link": { status: 400, json: { error: "link_invalid", detail: "Give an https link to a picture or a clip" } } }).call);
  assert.equal(refused!.isError, true);
  assert.equal(await runModelTool("clone8_make_story", {}, s.call), null, "not one of these tools");
});

test("a file is what its first bytes say: JPEG, PNG, WebP, MP4, MOV; anything else is refused", () => {
  assert.deepEqual(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { kind: "image", ext: "jpg" });
  assert.deepEqual(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { kind: "image", ext: "png" });
  assert.deepEqual(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), { kind: "image", ext: "webp" });
  assert.deepEqual(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])), { kind: "video", ext: "mp4" });
  assert.deepEqual(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  ")])), { kind: "video", ext: "mov" });
  assert.equal(sniff(Buffer.from("<html>")), null);
});

test("a link to a private or local address, a page, or an oversized file is refused, also after a redirect", async () => {
  const pub = async () => ["93.184.216.34"], local = async () => ["10.0.0.5"];
  await assert.rejects(fetchLinkBytes("https://intranet.example/a.jpg", { resolve: local, fetch: (async () => new Response("x")) as any }), (e: any) => e instanceof MediaLinkError && e.code === "link_unsafe");
  await assert.rejects(fetchLinkBytes("http://example.com/a.jpg", { resolve: pub }), (e: any) => e.code === "link_unsafe", "http is refused");
  let hop = 0;
  const redirectToLocal = (async (u: string) => { hop++; return hop === 1 ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }) : new Response("secret"); }) as any;
  const resolveBoth = async (h: string) => (h === "169.254.169.254" ? ["169.254.169.254"] : ["93.184.216.34"]);
  await assert.rejects(fetchLinkBytes("https://example.com/a.jpg", { resolve: resolveBoth, fetch: redirectToLocal }), (e: any) => e.code === "link_unsafe", "a redirect to a local address is refused");
  await assert.rejects(fetchLinkBytes("https://example.com/page", { resolve: pub, fetch: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as any }), (e: any) => e.code === "link_no_media");
  await assert.rejects(fetchLinkBytes("https://example.com/big.mp4", { resolve: pub, max: 10, fetch: (async () => new Response(new Uint8Array(50))) as any }), (e: any) => e.code === "link_too_large");
  const bytes = await fetchLinkBytes("https://example.com/a.jpg", { resolve: pub, fetch: (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2]))) as any });
  assert.equal(bytes.length, 5);
});
