import test from "node:test";
import assert from "node:assert/strict";
import { blueprintsV2Enabled, blueprintsV2Open, blueprintVersionCredits, buildPlan, cleanOptions, lineOf, quoteBlueprints, readFor, readKey, writePlan } from "../src/studio-blueprints-routes.js";
import { toolsEnabled } from "../src/studio.js";
import { PLANS } from "../src/studio.js";
import type { CapWord } from "../src/caption-engine.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEYS = { ANTHROPIC_API_KEY: "k", ELEVENLABS_API_KEY: "e" };
const ON = { ...KEYS, STUDIO_BLUEPRINTS_V2_ENABLED: "true" }, OPEN = { ...ON, STUDIO_BLUEPRINTS_V2_OPEN: "true" };
const ASSET = { id: A, kind: "video", name: "kitkat.mp4", probe: { duration: 36 } };
const WORDS: CapWord[] = Array.from({ length: 60 }, (_, i) => ({ text: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.5, key: i % 9 === 0 }));
const HOOK = (id = "h1", start = 13.8, end = 15.3) => ({ id, title: "I counted every *KitKat* here", start, end });

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
    faces: async () => { faceCalls++; return [{ t: 1, cx: 0.5, cy: 0.4, h: 0.5 }]; }, captionsCheck: async () => { capCalls++; return true; } };
  const first = await readFor(sb, deps, U, A);
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
  assert.equal(capCalls, 1, "the captions check runs once and is kept");
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

test("read: a read kept before the captions check gets it once; Clone8 Captions videos skip the call", async () => {
  const sb = fakeSb(); let capCalls = 0;
  sb.files.set(`studio-outputs/${readKey(U, A)}`, JSON.stringify({ v: 1, at: "x", seconds: 36, hooks: [{ ...HOOK(), line: "w" }], focus: [] }));
  const deps: any = { env: ON, stills: async () => [{ at: 1, jpeg: Buffer.from("x") }], captionsCheck: async () => { capCalls++; return false; }, hooks: async () => { throw new Error("no new openings expected"); } };
  const a = await readFor(sb, deps, U, A);
  assert.equal(a.cached, true); assert.equal(a.doc.has_captions, false); assert.equal(capCalls, 1);
  const b = await readFor(sb, deps, U, A);
  assert.equal(b.doc.has_captions, false); assert.equal(capCalls, 1, "kept");
  // a video Clone8 captioned: known without a look
  const sb2 = fakeSb(); const from = sb2.from;
  sb2.from = (t: string) => t === "studio_assets" ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: A, kind: "video", name: "x.mp4", object_key: `${U}/${A}.mp4`, status: "ready", probe: { duration: 36, captions: true } }, error: null }) }) }) }) } : from(t);
  const c = await readFor(sb2, { ...deps, words: async () => WORDS, hooks: async () => [HOOK()], faces: async () => [] }, U, A);
  assert.equal(c.doc.has_captions, true); assert.equal(capCalls, 1, "no look needed");
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

