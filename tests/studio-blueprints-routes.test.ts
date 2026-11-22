import test from "node:test";
import assert from "node:assert/strict";
import { blueprintsV2Enabled, blueprintsV2Open, blueprintVersionCredits, buildPlan, captionsKey, cleanOptions, lineOf, quoteBlueprints, readFor, readKey, versionCaptionsFor, writePlan } from "../src/studio-blueprints-routes.js";
import { toolsEnabled } from "../src/studio.js";
import { PLANS } from "../src/studio.js";
import type { CapWord } from "../src/caption-engine.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEYS = { ANTHROPIC_API_KEY: "k", ELEVENLABS_API_KEY: "e" };
const ON = { ...KEYS, STUDIO_BLUEPRINTS_V2_ENABLED: "true" }, OPEN = { ...ON, STUDIO_BLUEPRINTS_V2_OPEN: "true" };
const ASSET = { id: A, kind: "video", name: "kitkat.mp4", probe: { duration: 36 } };
const WORDS: CapWord[] = Array.from({ length: 60 }, (_, i) => ({ text: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.5, key: i % 9 === 0 }));
const HOOK = (id = "h1", start = 13.8, end = 15.3) => ({ id, title: "I counted every *KitKat* here", start, end });
const LOOK = { captions: false, format: "talking_head", people: 1, speaks_to_camera: true, facecam_over_gameplay: false, landscape_source: false, product_or_app: false, call_to_action: false } as const;

test("switches: off by default, enabled needs both keys, open needs enabled", () => {
  assert.equal(blueprintsV2Enabled({}), false);
  assert.equal(blueprintsV2Enabled({ STUDIO_BLUEPRINTS_V2_ENABLED: "true" }), false, "no keys");
  assert.equal(blueprintsV2Enabled(ON), true);
  assert.equal(blueprintsV2Open({ ...KEYS, STUDIO_BLUEPRINTS_V2_OPEN: "true" }), false);
  assert.equal(blueprintsV2Open(OPEN), true);
  assert.equal(toolsEnabled({}).blueprint_versions, false);
  assert.equal(toolsEnabled(OPEN as any).blueprint_versions, true);
});

test("price: 12 credits a version on today's plans (the Blueprint copy floor), never below it", () => {
  assert.equal(blueprintVersionCredits(PLANS), 12);
});

test("quote: closed to customers until open; the owner can quote on the first switch", () => {
  assert.throws(() => quoteBlueprints({}, PLANS, ASSET, { hooks: [HOOK()], looks: ["clean"] }), /not open/);
  assert.throws(() => quoteBlueprints(ON, PLANS, ASSET, { hooks: [HOOK()], looks: ["clean"] }), /not open/);
  const q = quoteBlueprints(ON, PLANS, ASSET, { hooks: [HOOK(), HOOK("h2", 23, 26)], looks: ["clean", "loud", "clean", "nope"], name: "kitkat.mp4" }, { owner: true });
  assert.equal(q.tool, "blueprint_versions");
  assert.deepEqual(q.options.looks, ["clean", "loud"]);
  assert.equal(q.options.versions, 4);
  assert.equal(q.credits, 48);
  assert.match(q.summary, /2 openings × 2 looks × 12/);
});

test("options: bad openings and looks are refused with words for the page", () => {
  const ok = { hooks: [HOOK()], looks: ["clean"] };
  assert.deepEqual(cleanOptions(ok, 36).looks, ["clean"]);
  assert.throws(() => cleanOptions({ ...ok, hooks: [] }, 36), /at least one opening/);
  assert.throws(() => cleanOptions({ ...ok, looks: [] }, 36), /at least one look/);
  assert.throws(() => cleanOptions({ ...ok, hooks: [HOOK("h1", 34, 38)] }, 36), /outside the video/);
  assert.throws(() => cleanOptions({ ...ok, hooks: [HOOK("h1", 10, 18)] }, 36), /outside the video/, "longer than 6 s");
  assert.throws(() => cleanOptions({ ...ok, hooks: [{ ...HOOK(), title: " ** " }] }, 36), /needs a title/);
  assert.throws(() => cleanOptions({ ...ok, hooks: [HOOK("H 1")] }, 36), /not valid/);
  assert.throws(() => cleanOptions({ hooks: Array.from({ length: 11 }, (_, i) => HOOK(`h${i}`)), looks: ["clean"] }, 36), /At most 10 openings/);
  // the most a run can make is 10 versions: 2 openings x 5 looks fits, 3 x 4 does not, 10 openings x 1 look fits
  assert.equal(cleanOptions({ hooks: [HOOK("h1"), HOOK("h2", 23, 26)], looks: ["clean", "card", "editorial", "loud", "split", "x"] }, 36).looks.length, 5);
  assert.throws(() => cleanOptions({ hooks: [HOOK("h1"), HOOK("h2", 23, 26), HOOK("h3", 23, 26)], looks: ["clean", "card", "editorial", "loud"] }, 36), /At most 10 versions/);
  assert.equal(cleanOptions({ hooks: Array.from({ length: 10 }, (_, i) => HOOK(`h${i}`)), looks: ["clean"] }, 36).hooks.length, 10);
  assert.equal(cleanOptions({ ...ok, hooks: [{ ...HOOK(), title: "*a* *b* *c*" }] }, 36).hooks[0].title, "a b c");
  assert.throws(() => quoteBlueprints(ON, PLANS, { ...ASSET, probe: { duration: 400 } }, ok, { owner: true }), /up to 3 minutes/);
  assert.throws(() => quoteBlueprints(ON, PLANS, { ...ASSET, probe: { duration: 3 } }, ok, { owner: true }), /at least 5 seconds/);
});

test("the plan: one EDL per opening per look, openings first, the Split look on the library loop", () => {
  const p = buildPlan(A, 36, WORDS, [{ t: 1, cx: 0.5, cy: 0.4, h: 0.5 }], [HOOK(), HOOK("h2", 23, 26)], ["clean", "split"], {});
  assert.deepEqual(p.versions.map((v) => `${v.index}:${v.hook_id}-${v.look_id}`), ["1:h1-clean", "2:h1-split", "3:h2-clean", "4:h2-split"]);
  assert.equal(p.versions[1].edl.game?.key, "subway-official");
  assert.equal(p.versions[0].edl.game, null);
  assert.equal(p.versions[0].edl.focus_track.length, 1);
  assert.match(p.versions[0].edl.captions_ass, /\[Events\]/);
});

test("lineOf: the words said inside an opening", () => {
  assert.equal(lineOf(WORDS, 0.55, 1.9), "w1 w2");
});

// a fake Supabase: storage in a map, one ready asset
function fakeSb() {
  const files = new Map<string, string>();
  const sb: any = {
    files,
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => (table === "studio_assets" ? { data: { id: A, kind: "video", name: "kitkat.mp4", object_key: `${U}/${A}.mp4`, status: "ready", probe: { duration: 36 } }, error: null } : { data: null, error: null }) }) }) }) }),
    storage: { from: (bucket: string) => ({
      createSignedUrl: async () => ({ data: { signedUrl: "https://example.invalid/v.mp4" }, error: null }),
      download: async (key: string) => (files.has(`${bucket}/${key}`) ? { data: { text: async () => files.get(`${bucket}/${key}`)! }, error: null } : { data: null, error: { message: "not found" } }),
      upload: async (key: string, body: Buffer, o: any) => { if (o?.contentType !== "text/plain") return { error: { message: "type refused" } }; if (!o.upsert && files.has(`${bucket}/${key}`)) return { error: { message: "exists" } }; files.set(`${bucket}/${key}`, body.toString()); return { error: null }; },
    }) },
  };
  return sb;
}

test("read: openings with their lines and the face track, kept; read again from the kept file; fresh adds new ones", async () => {
  const sb = fakeSb(); let calls = 0, faceCalls = 0, capCalls = 0;
  const deps: any = { env: ON, words: async () => WORDS, stills: async () => [{ at: 1, jpeg: Buffer.from("x") }],
    hooks: async () => { calls++; return calls === 1 ? [HOOK("h1", 13.8, 15.3)] : [HOOK("h1", 13.8, 15.3), HOOK("h2", 23, 26)]; },
    faces: async () => { faceCalls++; return [{ t: 1, cx: 0.5, cy: 0.4, h: 0.5 }]; }, lookRead: async () => { capCalls++; return { ...LOOK, captions: true }; } };
  const first = await readFor(sb, deps, U, A);
  assert.equal(first.purpose, "own", "a talking head with no role: my own content");
  assert.equal(first.doc.hooks[0].purpose, "own");
  assert.equal(first.cached, false);
  assert.equal(first.doc.hooks.length, 1);
  assert.match(first.doc.hooks[0].line, /^w23 w24/);
  assert.ok(sb.files.has(`studio-outputs/${readKey(U, A)}`));
  const again = await readFor(sb, deps, U, A);
  assert.equal(again.cached, true); assert.equal(calls, 1);
  const fresh = await readFor(sb, deps, U, A, { fresh: true });
  assert.equal(fresh.added.length, 1, "only the new one");
  assert.match(fresh.added[0].id, /^h2-/);
  assert.equal(fresh.doc.hooks.length, 2);
  assert.equal(faceCalls, 1, "the face track is read once");
  assert.equal(first.doc.has_captions, true);
  assert.equal(capCalls, 1, "the look read runs once and is kept");
  assert.equal(first.doc.look?.format, "talking_head");
  await assert.rejects(readFor(sb, deps, U, A, { fresh: true, allowNew: false }), /a lot of reading/);
});

test("read: too little speech is refused before any model call", async () => {
  const sb = fakeSb();
  await assert.rejects(readFor(sb, { env: ON, words: async () => WORDS.slice(0, 3), hooks: async () => { throw new Error("no call"); } } as any, U, A), /not enough speech/);
});

test("writePlan: the plan is uploaded as text under the person's folder and its key returned", async () => {
  const sb = fakeSb();
  const key = await writePlan(sb, { env: ON, words: async () => WORDS } as any, U, { id: A, probe: { duration: 36 } }, { hooks: [HOOK()], looks: ["clean", "card"] });
  assert.match(key, new RegExp(`^${U}/blueprints/plans/[0-9a-f-]{36}\\.json$`));
  const plan = JSON.parse(sb.files.get(`studio-outputs/${key}`));
  assert.equal(plan.versions.length, 2);
  assert.equal(plan.asset_id, A);
});

test("read: a read kept before v3 gets the look read once and openings for its purpose; Clone8-captioned videos are captioned", async () => {
  const sb = fakeSb(); let looks = 0, writes = 0;
  sb.files.set(`studio-outputs/${readKey(U, A)}`, JSON.stringify({ v: 1, at: "x", seconds: 36, hooks: [{ ...HOOK(), line: "w" }], focus: [{ t: 1, cx: 0.5, cy: 0.4, h: 0.3 }] }));
  const deps: any = { env: ON, words: async () => WORDS, stills: async () => [{ at: 1, jpeg: Buffer.from("x") }], lookRead: async () => { looks++; return LOOK; },
    hooks: async (_w: any, _n: any, _u: any, purpose: string) => { writes++; return [{ ...HOOK("h1", 23, 26), angle: purpose === "own" ? "question" : "reaction" }]; }, faces: async () => { throw new Error("face track kept"); } };
  const a = await readFor(sb, deps, U, A);
  assert.equal(a.cached, false); assert.equal(writes, 1); assert.equal(looks, 1);
  assert.equal(a.doc.has_captions, false);
  assert.equal(a.doc.hooks.length, 2, "the old opening is kept beside the new one");
  const b = await readFor(sb, deps, U, A);
  assert.equal(b.cached, true); assert.equal(looks, 1, "kept"); assert.equal(writes, 1);
  // a video Clone8 captioned: captioned whatever the stills say
  const sb2 = fakeSb(); const from = sb2.from;
  sb2.from = (t: string) => t === "studio_assets" ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: A, kind: "video", name: "x.mp4", object_key: `${U}/${A}.mp4`, status: "ready", probe: { duration: 36, captions: { style: "bold_pop" }, source: "clips" } }, error: null }) }) }) }) } : from(t);
  const c = await readFor(sb2, { ...deps, faces: async () => [] }, U, A);
  assert.equal(c.doc.has_captions, true);
  assert.equal(c.purpose, "clip", "made by Clips: a clip");
});

test("read: openings are kept per purpose; switching purpose writes its own set, switching back is free", async () => {
  const sb = fakeSb(); const asked: string[] = [];
  const deps: any = { env: ON, words: async () => WORDS, stills: async () => [{ at: 1, jpeg: Buffer.from("x") }], lookRead: async () => LOOK, faces: async () => [],
    hooks: async (_w: any, _n: any, _u: any, purpose: string) => { asked.push(purpose); return purpose === "clip" ? [{ ...HOOK("h1", 23, 26), angle: "reaction" }] : [{ ...HOOK(), angle: "result" }]; } };
  const own = await readFor(sb, deps, U, A, { role: "creator" });
  assert.equal(own.purpose, "own"); assert.equal(own.suggested, "own");
  const clip = await readFor(sb, deps, U, A, { purpose: "clip", role: "creator" });
  assert.equal(clip.purpose, "clip"); assert.equal(clip.suggested, "own");
  assert.deepEqual(clip.added.map((h) => h.angle), ["reaction"]);
  const back = await readFor(sb, deps, U, A, { purpose: "own" });
  assert.equal(back.cached, true);
  assert.deepEqual(asked, ["own", "clip"]);
  assert.equal(back.doc.hooks.filter((h) => h.purpose === "own").length, 1);
  assert.equal(back.doc.hooks.filter((h) => h.purpose === "clip").length, 1);
  assert.equal(new Set(back.doc.hooks.map((h) => h.id)).size, 2, "ids stay unique across purposes");
});

test("options: the purpose and each opening's angle are kept when they fit; anything else is dropped", () => {
  const o = cleanOptions({ purpose: "own", hooks: [{ ...HOOK(), angle: "question" }, { ...HOOK("h2", 23, 26), angle: "reaction" }], looks: ["clean"] }, 36);
  assert.equal(o.purpose, "own");
  assert.equal(o.hooks[0].angle, "question");
  assert.equal(o.hooks[1].angle, undefined, "a clip angle on an own set is dropped");
  assert.equal(cleanOptions({ purpose: "nope", hooks: [HOOK()], looks: ["clean"] }, 36).purpose, null);
  const q = quoteBlueprints(ON, PLANS, ASSET, { purpose: "brand", hooks: [{ ...HOOK(), angle: "benefit" }], looks: ["card"] }, { owner: true });
  assert.equal(q.options.purpose, "brand");
  assert.equal(q.options.hooks[0].angle, "benefit");
  assert.equal("purpose" in quoteBlueprints(ON, PLANS, ASSET, { hooks: [HOOK()], looks: ["card"] }, { owner: true }).options, false);
});

test("version captions: one call for the set, kept per job and networks; not before the versions exist", async () => {
  const sb = fakeSb(); const J = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; let calls = 0, seen: any = null;
  const job: any = { id: J, user_id: U, tool: "blueprint_versions", status: "done", asset_id: A,
    options: { purpose: "own", hooks: [{ ...HOOK("h1", 13.8, 15.3), angle: "question" }, { ...HOOK("h2", 23, 26), angle: "result" }] },
    outputs: [{ index: 1, hook_id: "h1", look_id: "clean" }, { index: 2, hook_id: "h1", look_id: "editorial" }, { index: 3, hook_id: "h2", look_id: "clean" }] };
  const from = sb.from;
  sb.from = (t: string) => t === "studio_jobs" ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: job, error: null }) }) }) }) } : from(t);
  const deps: any = { env: ON, words: async () => WORDS, captions: async (o: any) => { calls++; seen = o; return o.versions.map((v: any) => ({ index: v.index, caption: `c${v.index}`, hashtags: ["#a"], youtube_title: null })); } };
  const out = await versionCaptionsFor(sb, deps, U, J, ["instagram"]);
  assert.deepEqual(out.map((c) => c.caption), ["c1", "c2", "c3"]);
  assert.equal(seen.purpose, "own");
  assert.deepEqual(seen.versions.map((v: any) => [v.index, v.angle, v.look]), [[1, "question", "Clean"], [2, "question", "Editorial"], [3, "result", "Clean"]]);
  assert.match(seen.versions[0].line, /^w23 w24/);
  assert.ok(sb.files.has(`studio-outputs/${captionsKey(U, J, ["instagram"])}`));
  await versionCaptionsFor(sb, deps, U, J, ["instagram"]);
  assert.equal(calls, 1, "kept");
  await versionCaptionsFor(sb, deps, U, J, ["instagram"], { fresh: true });
  assert.equal(calls, 2, "fresh writes again");
  job.outputs = [];
  await assert.rejects(versionCaptionsFor(sb, deps, U, J, ["tiktok"]), /once the versions are made/);
  job.tool = "clips";
  await assert.rejects(versionCaptionsFor(sb, deps, U, J, ["tiktok"]), /not in your account/);
});

test("captions off: the quote keeps it, the plan adds no captions and keeps the whole frame", () => {
  const q = quoteBlueprints(ON, PLANS, ASSET, { hooks: [HOOK()], looks: ["clean"], captions: false }, { owner: true });
  assert.equal(q.options.captions, false);
  assert.equal(quoteBlueprints(ON, PLANS, ASSET, { hooks: [HOOK()], looks: ["clean"] }, { owner: true }).options.captions, true, "on by default");
  const off = buildPlan(A, 36, WORDS, [], [HOOK()], ["clean", "card"], {}, false);
  for (const v of off.versions) {
    assert.equal(v.edl.keep_frame, true);
    assert.doesNotMatch(v.edl.captions_ass, /Dialogue:/, "no caption events");
    assert.match(v.edl.overlay_ass, /Dialogue:/, "the title card stays");
  }
  const on = buildPlan(A, 36, WORDS, [], [HOOK()], ["clean"], {});
  assert.equal(on.versions[0].edl.keep_frame, undefined);
  assert.match(on.versions[0].edl.captions_ass, /Dialogue:/);
});

