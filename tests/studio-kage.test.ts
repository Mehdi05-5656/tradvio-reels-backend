import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { shotsOf, genSeconds, cleanPlan, kagePlanCost, kageCredits, analyzeReference, planRemix, runKageJob, quoteKage, KAGE_LIMITS, SHOT_MODEL, PLATE_MODEL, planKey, type Analysis } from "../src/studio-kage.js";
import { PLANS } from "../src/studio.js";

const ANN = "11111111-1111-4111-8111-111111111111", REF = "22222222-2222-4222-8222-222222222222", HERO = "33333333-3333-4333-8333-333333333333", JOB = "44444444-4444-4444-8444-444444444444", TOKEN = "55555555-5555-4555-8555-555555555555";
const ENV = { HIGGSFIELD_API_KEY: "id:secret", ANTHROPIC_API_KEY: "sk-test", STUDIO_KAGE_ENABLED: "true" };
const HF = "https://api.higgsfield.ai";
const analysis: Analysis = { seconds: 8, width: 1080, height: 1920, cuts: [2, 5], shots: [{ i: 0, start: 0, end: 2 }, { i: 1, start: 2, end: 5 }, { i: 2, start: 5, end: 8 }], motion: 0.3 };
const rawPlan = { concept: "A morning in the city", look: "photoreal", keep_music: true, locations: [{ id: "street", prompt: "A narrow sunlit street with cafe tables" }, { id: "unused", prompt: "x" }],
  shots: [{ ref: 1, role: "hook", hero: true, location: "street", prompt: "The street at golden hour. The hero stands by a table. They turn to camera. Medium shot, slow push in. Warm light, the hoodie from the photo.", camera: "medium, slow push in", text: "day one" },
    { ref: 2, role: "beat", hero: true, location: "street", prompt: "Same street. The hero walks past the tables. One continuous walk. Wide, tracking left. Same hoodie.", camera: "wide, track", text: null },
    { ref: 9, role: "junk", hero: true, location: "nowhere", prompt: "ignored", camera: "", text: null }] };

test("shots from cuts: flashes fold into the shot before, a short tail folds back; generated seconds are twice the screen time inside the floor and cap", () => {
  assert.deepEqual(shotsOf(10, [3, 3.2, 7, 9.8]), [{ i: 0, start: 0, end: 3.2 }, { i: 1, start: 3.2, end: 7 }, { i: 2, start: 7, end: 10 }], "the 0.2 s insert and the 0.2 s tail are not shots");
  assert.deepEqual(shotsOf(4, []), [{ i: 0, start: 0, end: 4 }]);
  assert.deepEqual(shotsOf(6, [0, 2, 6, 7]), [{ i: 0, start: 0, end: 2 }, { i: 1, start: 2, end: 6 }], "cuts at the edges or past the end are not shots");
  assert.equal(genSeconds(1), KAGE_LIMITS.gen_min); assert.equal(genSeconds(3), 6); assert.equal(genSeconds(2.5), 5); assert.equal(genSeconds(9), KAGE_LIMITS.gen_max);
});

test("the plan is cleaned to one shot per reference shot: a missing one is a hold, an unknown location is dropped, unused locations go", () => {
  const p = cleanPlan(rawPlan, analysis);
  assert.equal(p.shots.length, 3); assert.deepEqual(p.shots.map((s) => s.ref), [0, 1, 2]);
  assert.equal(p.shots[0].hero, true); assert.equal(p.shots[0].location, "street"); assert.equal(p.shots[0].text, "day one");
  assert.equal(p.shots[2].role, "hold"); assert.equal(p.shots[2].hero, false); assert.equal(p.shots[2].location, null); assert.match(p.shots[2].prompt, /plain dark background/);
  assert.deepEqual(p.locations.map((l) => l.id), ["street"], "only the places a shot uses");
  assert.equal(p.look, "photoreal"); assert.equal(p.keep_music, true);
  const cost = kagePlanCost(p, analysis, {});
  assert.equal(cost.gen_seconds, 4 + 6 + 6, "2 s, 3 s and 3 s of screen time rendered as 4, 6 and 6 s"); assert.equal(cost.plates, 1);
  assert.ok(cost.list_usd > 7 && cost.list_usd < 9, `16 s of Seedance at list plus a plate plus Claude (${cost.list_usd})`);
  assert.ok(kageCredits(cost.list_usd, {}, PLANS) > 100, "priced at the premium margin");
});

test("reading a reference: shots, a still each, motion; a strobe edit is refused", async () => {
  const d = { probeSeconds: async () => 8, probeDimensions: async () => ({ width: 1080, height: 1920 }), sceneCuts: async () => [2, 5], motion: async () => [[1, 0.2], [2, 0.4]] as Array<[number, number]>, still: async (_v: string, at: number) => `frame@${at}` };
  const r = await analyzeReference("/nope.mp4", d);
  assert.deepEqual(r.analysis.shots, analysis.shots); assert.equal(r.analysis.motion, 0.3); assert.deepEqual(r.frames, ["frame@1", "frame@3.5", "frame@6.5"]);
  await assert.rejects(analyzeReference("/nope.mp4", { ...d, probeSeconds: async () => 20, sceneCuts: async () => Array.from({ length: 19 }, (_, i) => i + 1) }), (e: any) => e.code === "reference_too_busy");
  await assert.rejects(analyzeReference("/nope.mp4", { ...d, still: async () => null }), (e: any) => e.code === "reference_unreadable");
});

test("the plan request: one still per shot with its timing, the hero's photos, the brief; the answer cleaned", async () => {
  const bodies: any[] = [];
  const fetchFn: any = async (url: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ model: "claude-sonnet-5-5", usage: {}, content: [{ type: "text", text: JSON.stringify(rawPlan) }] }) }; };
  const p = await planRemix({ env: ENV, fetch: fetchFn, log: () => undefined }, analysis, ["f1", "f2", "f3"], [{ data: "h1", media_type: "image/jpeg" }], "keep the song", ANN);
  const content = bodies[0].messages[0].content;
  assert.equal(content.filter((c: any) => c.type === "image").length, 4, "three stills and one hero photo");
  assert.match(content[0].text, /Reference shot 1 of 3: 0.00 to 2.00 s/); assert.match(content.at(-1).text, /keep the song/);
  assert.equal(bodies[0].output_config.format.type, "json_schema");
  assert.equal(p.shots.length, 3); assert.equal(p.concept, "A morning in the city");
});

/** A fake Studio: the plan in storage, the hero photo and the reference as library assets, every rpc answered. */
function fakeSb(stored: any) {
  const calls: any[] = [], uploads: any[] = [];
  const assets = [{ id: REF, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${REF}.mp4`, probe: { duration: 8 } }, { id: HERO, user_id: ANN, kind: "image", status: "ready", object_key: `${ANN}/${HERO}.jpg` }];
  const sb: any = {
    calls, uploads,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); if (name === "studio_renew") return { data: true, error: null }; return { data: { ok: true }, error: null }; },
    from: (table: string) => { const f: any = {}; let ids: string[] | null = null; const q: any = { select: () => q, eq: (k: string, v: any) => { f[k] = v; return q; }, in: (_k: string, v: string[]) => { ids = v; return q; }, gte: () => q, order: () => q, limit: () => q,
      then: (res: any) => res({ data: table === "studio_assets" ? assets.filter((a) => Object.entries(f).every(([k, v]) => (a as any)[k] === v) && (!ids || ids.includes(a.id))) : [], error: null }),
      maybeSingle: async () => ({ data: (table === "studio_assets" ? assets : []).find((a) => Object.entries(f).every(([k, v]) => (a as any)[k] === v)) ?? null, error: null }) }; return q; },
    storage: { from: (bucket: string) => ({
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://signed/${bucket}/${key}` }, error: null }),
      download: async (key: string) => ({ data: { arrayBuffer: async () => (key.endsWith(".json") ? Buffer.from(JSON.stringify(stored)) : key.endsWith(".jpg") ? Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) : Buffer.from(`file:${key}`)) }, error: null }),
      upload: async (key: string, body: Buffer, o: any) => { uploads.push({ bucket, key, bytes: body.length, type: o.contentType }); return { data: { path: key }, error: null }; },
    }) },
  };
  return sb;
}

test("a run: the plate once, the first hero shot alone, then every other shot at once; a shot the judge rejects goes once more; the cut keeps the reference's timing and sound", async () => {
  const plan = cleanPlan(rawPlan, analysis);
  const stored = { v: 1, reference_asset_id: REF, hero_asset_ids: [HERO], brief: null, analysis, plan, created_at: new Date().toISOString() };
  const sb = fakeSb(stored);
  const calls: any[] = []; let judged = 0, submits = 0;
  const fetchFn: any = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, idem: init.headers?.["idempotency-key"] });
    const res = (body: any, raw = false) => ({ ok: true, status: 200, text: async () => (raw ? body : JSON.stringify(body)), json: async () => body, arrayBuffer: async () => body, headers: new Map() });
    if (url === "https://api.anthropic.com/v1/messages") { judged++; return res({ model: "claude-sonnet-5-5", usage: {}, content: [{ type: "text", text: JSON.stringify(judged === 2 ? { verdict: "reroll", reason: "the hoodie is wrong" } : { verdict: "match", reason: "reads as the hero" }) }] }); }
    if (url === `${HF}/${PLATE_MODEL}` || url === `${HF}/${SHOT_MODEL}`) { submits++; return res({ status: "queued", request_id: `req_${submits}` }); }
    const m = url.match(/\/requests\/(req_\d+)\/status$/); if (m) return res(m[1] === "req_1" ? { status: "completed", images: [{ url: "https://cdn.example/plate.jpg" }] } : { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
    if (url.startsWith("https://cdn.example/")) return res(Buffer.from(`bytes:${url}`), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const trims: number[] = [], concats: number[] = [], muxed: string[] = [];
  const out = await runKageJob(sb, { env: ENV, fetch: fetchFn, log: () => undefined, sleep: async () => undefined, still: async () => "ZnJhbWU=", probeSeconds: async () => 8,
    trim: async (_s: string, t: string, secs: number) => { trims.push(secs); await writeFile(t, "cut"); }, concat: async (f: string[], t: string) => { concats.push(f.length); await writeFile(t, "joined"); },
    mux: async (_j: string, s: string, t: string) => { muxed.push(s.split("/").pop()!); await writeFile(t, "final"); }, poster: async (_v: string, t: string) => { await writeFile(t, "jpg"); } },
    { id: JOB, user_id: ANN, lease_token: TOKEN, options: { plan_key: planKey(ANN, "p1") }, credits_reserved: 500, progress: {}, attempts: 1 });
  assert.equal(out, "done");
  const posts = calls.filter((c) => c.method === "POST" && c.url.startsWith(HF));
  assert.deepEqual(posts.map((c) => c.url.replace(`${HF}/`, "")), [PLATE_MODEL, SHOT_MODEL, SHOT_MODEL, SHOT_MODEL, SHOT_MODEL], "one plate, then the canary, then the two others, then the one reroll");
  assert.match(posts[0].body.prompt, /no people/); assert.equal(posts[0].body.aspect_ratio, "9:16");
  assert.equal(posts[1].idem, `${JOB}:1:plate:street`.replace("plate:street", "shot:0:0")); assert.deepEqual(posts[1].body.image_urls, [`https://signed/studio-uploads/${ANN}/${HERO}.jpg`, `https://signed/studio-outputs/${ANN}/${JOB}/${TOKEN}/plate-street.jpg`], "the hero's photo first, the place last");
  assert.equal(posts[1].body.duration, 4); assert.equal(posts[1].body.generate_audio, false); assert.match(posts[1].body.prompt, /No text or lettering/);
  assert.equal(posts[3].body.image_urls, undefined, "the hold has no hero and no place"); assert.equal(posts[3].body.duration, 6);
  assert.equal(posts[4].idem, `${JOB}:1:shot:1:1`, "the rejected shot goes again under its own key");
  assert.equal(judged, 4, "every landed shot is judged: canary, shot 2 (rejected), shot 2 again, shot 3");
  assert.deepEqual(trims, [2, 3, 3], "each shot cut to its screen time"); assert.deepEqual(concats, [3]); assert.deepEqual(muxed, ["reference.mp4"], "the reference's sound goes back on");
  assert.deepEqual(sb.uploads.map((u: any) => u.key.split("/").pop()), ["plate-street.jpg", "shot-1.mp4", "shot-2.mp4", "shot-3.mp4", "1.mp4", "1.jpg"]);
  const done = sb.calls.find((c: any) => c.name === "studio_complete").args;
  assert.equal(done.p_outputs[0].shots, 3); assert.equal(done.p_outputs[0].audio, "muxed_from_reference"); assert.equal(done.p_outputs[0].note, undefined, "every shot passed in the end"); assert.equal(done.p_credits_charged, 500);
  const last = sb.calls.filter((c: any) => c.name === "studio_renew").at(-1).args.p_progress;
  assert.equal(last.shots[1].rerolls, 1); assert.equal(last.shots[1].verdict, "match"); assert.equal(last.done, 3);
});

test("a run stops after the first shot when the hero does not land twice, so the rest is never paid for", async () => {
  const plan = cleanPlan(rawPlan, analysis);
  const sb = fakeSb({ v: 1, reference_asset_id: REF, hero_asset_ids: [HERO], brief: null, analysis, plan, created_at: new Date().toISOString() });
  let submits = 0;
  const fetchFn: any = async (url: string, init: any = {}) => {
    const res = (body: any, raw = false) => ({ ok: true, status: 200, text: async () => (raw ? body : JSON.stringify(body)), json: async () => body, arrayBuffer: async () => body, headers: new Map() });
    if (url === "https://api.anthropic.com/v1/messages") return res({ model: "m", usage: {}, content: [{ type: "text", text: JSON.stringify({ verdict: "reroll", reason: "another face" }) }] });
    if (url.startsWith(`${HF}/`) && init.method === "POST") { submits++; return res({ status: "queued", request_id: `req_${submits}` }); }
    const m = url.match(/\/requests\/(req_\d+)\/status$/); if (m) return res(m[1] === "req_1" ? { status: "completed", images: [{ url: "https://cdn.example/plate.jpg" }] } : { status: "completed", video: { url: `https://cdn.example/${m[1]}.mp4` } });
    if (url.startsWith("https://cdn.example/")) return res(Buffer.from("b"), true);
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await runKageJob(sb, { env: ENV, fetch: fetchFn, log: () => undefined, sleep: async () => undefined, still: async () => "ZnJhbWU=", probeSeconds: async () => 4 }, { id: JOB, user_id: ANN, lease_token: TOKEN, options: { plan_key: planKey(ANN, "p1") }, credits_reserved: 500, progress: {}, attempts: 1 });
  assert.equal(out, "failed");
  assert.equal(submits, 3, "the plate and the first shot twice; nothing else");
  const f = sb.calls.find((c: any) => c.name === "studio_fail").args; assert.equal(f.p_reason, "kage_hero_lost"); assert.equal(f.p_retry, false);
});

test("the quote reads the stored plan and refuses another reference or a missing plan", async () => {
  const plan = cleanPlan(rawPlan, analysis);
  const sb = fakeSb({ v: 1, reference_asset_id: REF, hero_asset_ids: [HERO], brief: null, analysis, plan, created_at: new Date().toISOString() });
  const q = await quoteKage(sb, ANN, ENV, PLANS, { plan_key: planKey(ANN, "p1") }, { id: REF, kind: "video" });
  assert.equal(q.tool, "kage"); assert.ok(q.credits > 100); assert.equal(q.options.shots, 3); assert.equal(q.options.plates, 1); assert.equal(q.summary, "3 shots · 8 s");
  await assert.rejects(quoteKage(sb, ANN, ENV, PLANS, { plan_key: planKey(ANN, "p1") }, { id: HERO, kind: "image" }), (e: any) => e.code === "kage_reference_mismatch");
  await assert.rejects(quoteKage(sb, ANN, ENV, PLANS, { plan_key: planKey("someone-else", "p1") }, { id: REF, kind: "video" }), (e: any) => e.code === "kage_plan_missing");
  await assert.rejects(quoteKage(sb, ANN, { ...ENV, STUDIO_KAGE_ENABLED: "false" }, PLANS, {}, null), (e: any) => e.code === "kage_unavailable");
  // a plan made from one of our gallery presets: no library reference, the preset named instead
  const sbp = fakeSb({ v: 1, reference_asset_id: null, reference_id: "pitch-15", hero_asset_ids: [HERO], brief: null, analysis, plan, created_at: new Date().toISOString() });
  const qp = await quoteKage(sbp, ANN, ENV, PLANS, { plan_key: planKey(ANN, "p2") }, null);
  assert.equal(qp.options.reference_id, "pitch-15"); assert.equal(qp.options.reference_asset_id, null);
  await assert.rejects(quoteKage(sbp, ANN, ENV, PLANS, { plan_key: planKey(ANN, "p2") }, { id: REF, kind: "video" }), (e: any) => e.code === "kage_reference_mismatch", "a preset plan does not take a library video as its asset");
});
