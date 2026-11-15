import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLANS, toolsEnabled } from "../src/studio.js";
import { resetCostsForTests } from "../src/studio-costs.js";
import { resetCutGate } from "../src/studio-capacity.js";
import { creditValueFloor, marginForSecond } from "../src/studio-pricing.js";
import { RecastError } from "../src/studio-recast.js";
import {
  RESHOOT_LIMITS, ReshootError, aspectFor, autoCuts, billedSeconds, bodyFor, cleanShots, creditsPerSecondFor, defaultShots, describe, engineFor, engineUsdPerSecond, isCopy, joinGraph, mergePlan, movePieces,
  parsePsnr, planFor, priceShots, promptFor, quoteReshoot, reshootConfig, reshootEnabled, reshootOpen, retimeFactor, runReshootJob, NO_CHANGE,
  CINEMA_ENDPOINT, FIRM_WORDS, PIECE_TRIES, cinemaMove, endpointFor, followedTake, movePieceSeconds, pieceMoved, renderUsdPerSecond,
} from "../src/studio-reshoot.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", J = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ON = { STUDIO_RESHOOT_ENABLED: "true", HIGGSFIELD_API_KEY: "k", ANTHROPIC_API_KEY: "k" };
const OPEN = { ...ON, STUDIO_RESHOOT_OPEN: "true" };
const asset = (duration = 30) => ({ id: A, kind: "video", name: "talk.mov", probe: { duration, width: 1080, height: 1920 } });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e instanceof ReshootError ? e.code : `other:${e?.message}`; } return "no error"; };
const shot = (start: number, end: number, c: Record<string, any> = {}) => ({ start, end, ...NO_CHANGE, ...c });
// the plan's worked example: a 30 s take, six 5 s shots
const SIX = [shot(0, 5, { keep: true }), shot(5, 10, { angle: "closeup" }), shot(10, 15, { angle: "wide" }), shot(15, 20, { angle: "three_quarter_left" }), shot(20, 25, { angle: "overhead" }), shot(25, 30, { angle: "low" })];

test("switches: off by default; the switch alone opens it to the owner only; the tool list says open only when both are on", () => {
  assert.equal(reshootEnabled({}), false);
  assert.equal(reshootEnabled({ STUDIO_RESHOOT_ENABLED: "true" }), false, "needs the platform key and the Claude key too");
  assert.equal(reshootEnabled(ON), true);
  assert.equal(reshootOpen(ON), false);
  assert.equal(reshootOpen({ STUDIO_RESHOOT_OPEN: "true" }), false, "the open switch cannot switch the feature on by itself");
  assert.equal(reshootOpen(OPEN), true);
  assert.equal((toolsEnabled({}) as any).reshoot, false);
  assert.equal((toolsEnabled(ON) as any).reshoot, false, "customers do not see it while only the owner can use it");
  assert.equal((toolsEnabled(OPEN) as any).reshoot, true);
  assert.equal(code(() => quoteReshoot({}, PLANS, asset(), { rights: true, shots: SIX })), "reshoot_off");
  assert.equal(code(() => quoteReshoot(ON, PLANS, asset(), { rights: true, shots: SIX })), "reshoot_off");
  assert.equal(quoteReshoot(ON, PLANS, asset(), { rights: true, shots: SIX }, { owner: true }).tool, "reshoot");
});

test("engines: a close face goes to the edit model, a wide or overhead camera to the cheap one, a move to chained reference pieces", () => {
  assert.equal(engineFor({ ...NO_CHANGE, angle: "closeup" }), "seedance_edit");
  assert.equal(engineFor({ ...NO_CHANGE, light: "night" }), "seedance_edit", "a relight with the camera kept: the face is as close as filmed");
  assert.equal(engineFor({ ...NO_CHANGE, place: "beach at sunset" }), "seedance_edit");
  assert.equal(engineFor({ ...NO_CHANGE, angle: "wide", outfit: "a blue ski jacket" }), "wan");
  assert.equal(engineFor({ ...NO_CHANGE, angle: "overhead" }), "wan");
  assert.equal(engineFor({ ...NO_CHANGE, angle: "wide", move: "orbit" }), "seedance_move", "a move wins over the angle");
});

test("price: 45 credits a second on the expensive engine (premium tier, a quarter retried), 10 on the cheap one; the worked example is 775", () => {
  assert.equal(engineUsdPerSecond("seedance_edit", {}), 0.463);
  assert.equal(engineUsdPerSecond("wan", {}), 0.05);
  assert.equal(engineUsdPerSecond("wan", { STUDIO_RESHOOT_WAN_USD: "0.07" }), 0.07, "the rate can follow the platform's");
  assert.equal(creditsPerSecondFor("seedance_edit", PLANS, {}), 45);
  assert.equal(creditsPerSecondFor("seedance_move", PLANS, {}), 45);
  assert.equal(creditsPerSecondFor("wan", PLANS, {}), 10);
  // each rate brings in, at the cheapest credit value, at least its cost with the retry allowance over (1 - margin)
  const floor = creditValueFloor(PLANS);
  for (const [e, share] of [["seedance_edit", 0.25], ["wan", 0.5]] as const) {
    const usd = engineUsdPerSecond(e, {}) * (1 + share), m = marginForSecond(usd, PLANS);
    assert.ok(creditsPerSecondFor(e, PLANS, {}) * floor * (1 - m) >= usd - 0.001, `${e}: ${creditsPerSecondFor(e, PLANS, {})} credits for $${usd}/s at ${m}`);
  }
  assert.equal(marginForSecond(0.463 * 1.25, PLANS), 0.2, "Seedance sits in the premium tier");
  assert.equal(billedSeconds({ start: 0, end: 8.03 }, "seedance_edit"), 9, "the platform bills the source rounded up");
  assert.equal(billedSeconds({ start: 0, end: 5 }, "seedance_edit"), 5);
  assert.equal(billedSeconds({ start: 0, end: 3.2 }, "seedance_edit"), 4, "never under its minimum");
  assert.equal(billedSeconds({ start: 0, end: 5 }, "wan"), 5);
  assert.equal(billedSeconds({ start: 0, end: 10 }, "seedance_move"), 10, "two pieces of 5 s");
  const q = quoteReshoot(OPEN, PLANS, asset(30), { rights: true, shots: SIX });
  assert.equal(q.credits, 3 * 5 * 45 + 2 * 5 * 10, "three close shots, two wide or overhead, the first kept: 775");
  assert.equal(q.credits, 775);
  assert.equal(q.options.cost_usd, Math.round((15 * 0.463 + 10 * 0.05) * 100) / 100);
  assert.equal(q.summary, "5 of 6 shots re-filmed · 30 s video");
  assert.deepEqual(q.options.shots.map((s: any) => s.engine), [null, "seedance_edit", "wan", "seedance_edit", "wan", "seedance_edit"]);
  assert.equal(q.options.shots[0].credits, 0, "a kept shot costs nothing");
  // margin on the worked example with no retries, at the cheapest credits
  const revenue = q.credits * floor, cost = q.options.cost_usd;
  assert.ok((revenue - cost) / revenue > 0.38, `margin ${((revenue - cost) / revenue).toFixed(3)}`);
});

test("quote: the video has to be the person's, 5 to 60 s, and they have to say it is them", () => {
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, null, { rights: true, shots: SIX })), "video_not_found");
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, { ...asset(), kind: "image" }, { rights: true, shots: SIX })), "video_not_found");
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, { ...asset(), probe: {} }, { rights: true, shots: SIX })), "asset_not_inspected");
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, asset(4), { rights: true, shots: [shot(0, 4, { angle: "closeup" })] })), "reshoot_too_short");
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, asset(61), { rights: true, shots: SIX })), "reshoot_too_long");
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, asset(), { shots: SIX })), "reshoot_rights");
  // one look for the whole take: even shots, the camera kept, every shot priced on the edit model
  const look = quoteReshoot(OPEN, PLANS, asset(20), { rights: true, mode: "look", look: { light: "golden_hour", angle: "overhead", move: "orbit" } });
  assert.equal(look.options.mode, "look");
  assert.ok(look.options.shots.every((s: any) => !s.keep && s.angle === "same" && s.move === "none" && s.light === "golden_hour" && s.engine === "seedance_edit"), "a look never moves the camera");
  assert.equal(look.options.shots[look.options.shots.length - 1].end, 20);
  assert.equal(look.credits, look.options.shots.reduce((t: number, s: any) => t + s.seconds * 45, 0));
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, asset(20), { rights: true, mode: "look", look: {} })), "reshoot_nothing");
  // the page sends the stretches it showed and priced (cut on the words): the server uses those, so the button's price
  // is the charge. A 20 s take cut on the words at 5, 10.5 and 15.5 s bills 5 + 6 + 5 + 5 = 21 s; cut evenly at 6 and
  // 12 s (what the server did before) it billed 6 + 6 + 8 = 20 s, a price the page never showed.
  const shown = quoteReshoot(OPEN, PLANS, asset(20), { rights: true, mode: "look", look: { place: "snowy mountain ridge" }, shots: [{ start: 0, end: 5 }, { start: 5, end: 10.5 }, { start: 10.5, end: 15.5 }, { start: 15.5, end: 20 }] });
  assert.deepEqual(shown.options.shots.map((s: any) => [s.start, s.end, s.place]), [[0, 5, "snowy mountain ridge"], [5, 10.5, "snowy mountain ridge"], [10.5, 15.5, "snowy mountain ridge"], [15.5, 20, "snowy mountain ridge"]]);
  assert.equal(shown.credits, 21 * 45);
  const even = quoteReshoot(OPEN, PLANS, asset(20), { rights: true, mode: "look", look: { place: "x y" } });
  assert.deepEqual(even.options.shots.map((s: any) => s.start), [0, 6, 12], "with no stretches sent, cut evenly");
  assert.equal(even.credits, 20 * 45);
  assert.equal(code(() => quoteReshoot(OPEN, PLANS, asset(8.03), { rights: true, mode: "look", look: { place: "x y" }, shots: [{ start: 0, end: 2 }, { start: 2, end: 8.03 }] })), "reshoot_shot_short", "the same rules as any edit");
});

test("shots: one after another over the whole take; changed shots 4 to 8 s, moves up to 12 s and two at most; something has to change", () => {
  assert.equal(code(() => cleanShots([], 30)), "reshoot_no_shot");
  assert.equal(code(() => cleanShots(Array.from({ length: 13 }, (_, i) => shot(i * 2, i * 2 + 2)), 26)), "reshoot_too_many");
  assert.equal(code(() => cleanShots([shot(1, 30, { angle: "closeup" })], 30)), "reshoot_gap");
  assert.equal(code(() => cleanShots([shot(0, 20, { keep: true })], 30)), "reshoot_gap");
  assert.equal(code(() => cleanShots([shot(0, 10, { keep: true }), shot(11, 30, { keep: true })], 30)), "reshoot_gap");
  assert.equal(code(() => cleanShots([shot(0, 27, { keep: true }), shot(27, 30, { angle: "closeup" })], 30)), "reshoot_shot_short");
  assert.equal(code(() => cleanShots([shot(0, 20, { keep: true }), shot(20, 30, { angle: "closeup" })], 30)), "reshoot_shot_long");
  assert.equal(code(() => cleanShots([shot(0, 17, { keep: true }), shot(17, 30, { move: "orbit" })], 30)), "reshoot_move_long");
  assert.equal(code(() => cleanShots([shot(0, 6, { move: "orbit" }), shot(6, 12, { move: "push_in" }), shot(12, 18, { move: "orbit" }), shot(18, 30, { keep: true })], 30)), "reshoot_too_many_moves");
  assert.equal(code(() => cleanShots([shot(0, 30, { keep: true })], 30)), "reshoot_nothing");
  const s = cleanShots([shot(20, 30, { keep: true }), shot(0, 8, { angle: "closeup", light: "neon", place: "  a\nrooftop ", junk: 1 }), shot(8, 20, { move: "push_in" })], 30);
  assert.deepEqual(s.map((x) => [x.start, x.end, x.keep]), [[0, 8, false], [8, 20, false], [20, 30, true]], "sorted");
  assert.equal(s[0].place, "a rooftop");
  assert.equal(s[0].light, "neon");
  assert.equal((s[0] as any).junk, undefined, "only known fields are kept");
  const unknown = cleanShots([shot(0, 6, { angle: "fisheye", light: "laser" }), shot(6, 12, { angle: "wide" }), shot(12, 30, { keep: true })], 30);
  assert.ok(unknown[0].keep, "a shot with nothing known left to change becomes a kept shot");
  assert.equal(code(() => cleanShots([shot(0, 6, { angle: "fisheye" }), shot(6, 30, { keep: true })], 30)), "reshoot_nothing");
  const kept = cleanShots([shot(0, 6, { keep: true, angle: "closeup" }), shot(6, 12, { angle: "wide" }), shot(12, 30, { keep: true })], 30);
  assert.equal(kept[0].angle, "same", "a kept shot carries no change");
});

test("cuts: on sentence breaks, 4 to 8 s, as near 6 s as the breaks allow; a silent take is cut evenly; a short take is one shot", () => {
  const words: Array<{ text: string; start: number; end: number }> = [];
  // a sentence ends at about 5.5 s and 12.2 s (a pause and a full stop); the rest is a steady stream of words
  for (let t = 0; t < 20; t += 0.4) words.push({ text: Math.abs(t - 5.2) < 0.01 || Math.abs(t - 12) < 0.01 ? "end." : "word", start: Math.round(t * 100) / 100, end: Math.round((t + 0.3) * 100) / 100 });
  const cuts = autoCuts(20, words);
  assert.equal(cuts[0], 0); assert.equal(cuts[cuts.length - 1], 20);
  for (let i = 1; i < cuts.length; i++) { const len = cuts[i] - cuts[i - 1]; assert.ok(len >= RESHOOT_LIMITS.shot_min - 0.01 && len <= RESHOOT_LIMITS.shot_max + 0.01, `shot ${i} is ${len} s`); }
  assert.ok(cuts.some((c) => Math.abs(c - 5.55) < 0.06), `a cut on the first full stop: ${cuts}`);
  assert.ok(cuts.some((c) => Math.abs(c - 12.35) < 0.06), `a cut on the second: ${cuts}`);
  assert.deepEqual(autoCuts(7, []), [0, 7]);
  const even = autoCuts(30, []);
  for (let i = 1; i < even.length; i++) assert.ok(even[i] - even[i - 1] >= 4 && even[i] - even[i - 1] <= 8);
  assert.deepEqual(autoCuts(13, []), [0, 6, 13]);
  assert.deepEqual(autoCuts(9, []), [0, 5, 9], "the remainder is never under 4 s");
});

test("the plan: Claude's choices are laid on the cuts, moves capped, anything missing falls back; the result always passes the shot rules", () => {
  const cuts = [0, 6, 12, 18, 24, 30];
  const base = defaultShots(cuts);
  assert.ok(base[0].keep && base.slice(1).every((s) => !s.keep), "by default the first shot is as filmed, the rest change");
  assert.ok(base.slice(1).every((s, i, a) => i === 0 || s.angle !== a[i - 1].angle), "never the same camera twice in a row");
  assert.ok(!defaultShots([0, 7])[0].keep, "a take that is one shot is changed, or there would be nothing to make");
  const merged = mergePlan(cuts, [
    { index: 0, keep: true, angle: "same", move: "none", light: "same", place: "", outfit: "", why: "Opening" },
    { index: 1, keep: false, angle: "closeup", move: "orbit", light: "same", place: "", outfit: "", why: "The hook" },
    { index: 2, keep: false, angle: "wide", move: "push_in", light: "night", place: "", outfit: "", why: "x" },
    { index: 3, keep: false, angle: "low", move: "orbit", light: "same", place: "", outfit: "", why: "x" },
    { index: 4, keep: false, angle: "laser", move: "none", light: "same", place: "", outfit: "", why: "nothing known" },
  ]);
  assert.deepEqual(merged.map((s) => s.move), ["none", "orbit", "push_in", "none", "none"], "two moves at most: the third is dropped");
  assert.ok(merged[4].keep, "a shot with nothing valid to change is kept as filmed");
  assert.equal(merged[1].why, "The hook");
  assert.doesNotThrow(() => cleanShots(merged, 30));
  assert.deepEqual(mergePlan(cuts, "nonsense"), base);
  assert.deepEqual(mergePlan(cuts, [0, 1, 2, 3, 4].map((index) => ({ index, keep: true }))), base, "a plan that changes nothing falls back to the default");
});

test("moves are rendered in pieces of 4 s or more, equal, covering the shot", () => {
  assert.deepEqual(movePieces(0, 12).map((p) => [p.start, p.end, p.seconds]), [[0, 4, 4], [4, 8, 4], [8, 12, 4]]);
  assert.deepEqual(movePieces(10, 20).map((p) => [p.start, p.end, p.seconds]), [[10, 15, 5], [15, 20, 5]]);
  assert.deepEqual(movePieces(0, 4.5).map((p) => [p.start, p.end, p.seconds]), [[0, 4.5, 5]]);
  assert.deepEqual(movePieces(0, 7.9).map((p) => p.seconds), [8]);
});

test("what is sent: the edit model reads the shot, the reference models are pointed at it; the words always ask for the same lips and timing", () => {
  const close = { ...NO_CHANGE, angle: "three_quarter_left" as const, light: "golden_hour" as const };
  const p = promptFor(close, "seedance_edit");
  assert.match(p, /three-quarter view from about 40 degrees to the person's left/);
  assert.match(p, /golden hour/);
  assert.match(p, /lip movements, mouth shapes, words/);
  assert.match(p, /Keep the same place\. Keep the same clothes\./);
  assert.ok(!/<<<|Keep the same light/.test(p), "no reference tokens for the edit model; the light was asked to change");
  const wide = promptFor({ ...NO_CHANGE, angle: "wide", place: "snowy mountain ridge", outfit: "a blue ski jacket" }, "wan");
  assert.match(wide, /^Recreate the reference video <<<video_1>>>/);
  assert.match(wide, /The place is now: snowy mountain ridge/);
  assert.match(wide, /now wears: a blue ski jacket/);
  const orbit = { ...NO_CHANGE, move: "orbit" as const };
  const first = promptFor(orbit, "seedance_move", { k: 0, n: 2, chained: false }), second = promptFor(orbit, "seedance_move", { k: 1, n: 2, chained: true });
  // worded as a new video: the platform reads edit-like words as an edit and renders on the take's own camera
  assert.match(first, /^Generate a new video\. The person from <<<image_1>>> performs the same movements, gestures and timing as the person in <<<video_1>>>: the same light; the same place; the same clothes\. The camera: .*from in front of the person to behind the person.*a new, moving camera that never stops travelling\.$/);
  assert.match(second, /^Generate a new video that opens on <<<image_1>>>\. From that first frame, .*from behind the person to in front of the person.*looks as in <<<image_2>>>/);
  for (const m of [first, second]) assert.ok(!/Recreate|re-film|exactly|only the camera differs|is now|Keep the same|lip movements, mouth shapes/i.test(m), `nothing that reads as an edit: ${m}`);
  const snowy = promptFor({ ...NO_CHANGE, move: "orbit", place: "snowy mountain ridge", outfit: "a blue ski jacket", light: "night" }, "seedance_move", { k: 0, n: 1, chained: false });
  assert.match(snowy, /the place is snowy mountain ridge; they wear a blue ski jacket/);
  assert.ok(!/ now |relit/i.test(snowy), snowy);
  assert.match(snowy, /: lit as night: dark surroundings/);
  assert.match(promptFor(close, "seedance_edit", undefined, true), /The reference image is a still from another shot of this same video: match its place, its light and the person's outfit exactly\.$/);
  assert.deepEqual(bodyFor({ engine: "seedance_edit", prompt: "p", videoUrl: "v", imageUrls: ["a"], seconds: 6, aspect: "9:16" }).image_urls, ["a"], "the anchor still goes with the edit model");
  assert.match(promptFor({ ...NO_CHANGE, move: "push_in" }, "seedance_move", { k: 1, n: 2, chained: true }), /pushes in .* to a close-up of the face/);
  assert.deepEqual(bodyFor({ engine: "seedance_edit", prompt: "p", videoUrl: "v", imageUrls: [], seconds: 6, aspect: "9:16" }), { prompt: "p", video_url: "v", resolution: "720p", generate_audio: false });
  assert.deepEqual(bodyFor({ engine: "wan", prompt: "p", videoUrl: "v", imageUrls: [], seconds: 6, aspect: "9:16" }), { prompt: "p", video_urls: ["v"], duration: 6, resolution: "720p", aspect_ratio: "9:16", generate_audio: false });
  assert.deepEqual(bodyFor({ engine: "seedance_move", prompt: "p", videoUrl: "v", imageUrls: ["a", "b"], seconds: 4, aspect: "16:9" }).image_urls, ["a", "b"]);
  assert.equal(aspectFor(720, 1280), "9:16"); assert.equal(aspectFor(1280, 720), "16:9"); assert.equal(aspectFor(720, 720), "1:1"); assert.equal(aspectFor(960, 1280), "3:4");
  assert.equal(describe({ ...NO_CHANGE, angle: "wide", light: "night", outfit: "a suit" }), "wide, night light, wearing a suit");
});

test("checks and timing: a near copy is caught; results are stretched back to their shot's length", () => {
  assert.equal(parsePsnr("[Parsed_psnr_6 @ 0x1] PSNR y:30.1 u:40 v:41 average:31.352931 min:28 max:33"), 31.352931);
  assert.equal(parsePsnr("PSNR y:inf average:inf min:inf"), 99);
  assert.equal(parsePsnr("nothing"), null);
  assert.equal(isCopy(31.35), true, "the unchanged copy measured on Nov 14 2026");
  assert.equal(isCopy(29.48), true);
  assert.equal(isCopy(17.67), false, "a real new angle");
  assert.equal(isCopy(null), false, "no measure is not a reason to throw a shot away");
  assert.equal(retimeFactor(8, 7.708333), 1.03784, "Seedance gives back 7.7 s for 8 s");
  assert.equal(retimeFactor(8, 0), 1);
});

test("the join: kept stretches and re-filmed shots in order at the take's size, the take's own sound under all of it", () => {
  const g = joinGraph([{ kind: "real", from: 0, to: 5 }, { kind: "made", file: "a.mp4", seconds: 6 }, { kind: "real", from: 11, to: 17 }, { kind: "made", file: "b.mp4", seconds: 6 }], { w: 720, h: 1280, sourceAudio: true, seconds: 23 });
  assert.match(g, /^\[0:v\]split=2\[sv0\]\[sv1\];/);
  assert.match(g, /\[sv1\]trim=start=11\.000:end=17\.000/);
  assert.match(g, /\[1:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30.*trim=duration=6\.000/);
  assert.match(g, /\[2:v\]scale=720:1280/);
  assert.match(g, /\[v0\]\[v1\]\[v2\]\[v3\]concat=n=4:v=1:a=0\[v\]/);
  assert.match(g, /\[0:a\]atrim=duration=23\.000/);
  assert.ok(!/\[1:a\]|\[2:a\]/.test(g), "the re-filmed shots' own sound is never used");
  const silent = joinGraph([{ kind: "made", file: "a.mp4", seconds: 7 }], { w: 720, h: 1280, sourceAudio: false, seconds: 7 });
  assert.match(silent, /anullsrc=r=44100:cl=stereo,atrim=duration=7\.000\[a\]/);
  assert.ok(!silent.includes("[0:v]"), "a take that is wholly re-filmed is not read for pictures");
});

// A run with the platform, the checks and the cutter replaced: what is sent, retried, kept, joined, charged and given back.
function fakeSb() {
  const rpc: any[] = [], uploads: any[] = [];
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: A, kind: "video", name: "talk.mov", object_key: `${U}/x.mov`, status: "ready", probe: { duration: 30, width: 1080, height: 1920 } }, error: null }) }; return q; },
    storage: { from: (bucket: string) => ({
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${key}` }, error: null }),
      upload: async (key: string, body: Buffer, o: any) => { uploads.push({ bucket, key, bytes: body.length, type: o?.contentType }); return { error: null }; },
    }) },
  };
  return { sb, rpc, uploads };
}
const jobOf = (shots: any[], seconds = 30) => {
  const priced = priceShots(cleanShots(shots, seconds), PLANS, {});
  return { id: J, user_id: U, lease_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", asset_id: A, credits_reserved: priced.reduce((t, s) => t + s.credits, 0), attempts: 1, progress: {}, options: { shots: priced, seconds, name: "talk.mov" } };
};

test("a run: a near copy is made again, a refused shot keeps the original and is not charged, a move is rendered piece by piece from the last picture", async () => {
  resetCostsForTests(); resetCutGate();
  const { sb, rpc, uploads } = fakeSb();
  const sent: Array<{ key: string; engine: string; images: string[]; prompt: string; seconds: number }> = [];
  let joined: any = null;
  const job = jobOf([shot(0, 6, { keep: true }), shot(6, 12, { angle: "closeup" }), shot(12, 18, { angle: "wide" }), shot(18, 26, { move: "orbit" }), shot(26, 30, { angle: "low" })]);
  const out = await runReshootJob(sb, {
    env: {}, log: () => undefined,
    prepare: async (_u, t) => writeFile(t, "take"),
    cut: async (_s, from, to, t) => writeFile(t, `cut ${from}-${to}`),
    retime: async (f, secs, _size, t) => writeFile(t, `retimed ${secs} from ${f}`),
    render: async (c) => {
      sent.push({ key: c.key, engine: c.engine, images: c.imageUrls, prompt: c.prompt, seconds: c.seconds });
      await c.onSubmit?.(`req-${c.key}`);
      if (c.engine === "seedance_edit" && c.prompt.includes("low angle")) throw new RecastError("recast_nsfw", "refused");
      const f = join(c.dir, `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "made"); return { file: f, requestId: `req-${c.key}` };
    },
    // the close-up's first try comes back as the source (a copy); the second try is a real new angle
    likeness: async (_s, r) => (/shot-1-1\.mp4$/.test(r) ? 31.3 : 16),
    check: async () => ({ verdict: "good", note: "same person, new angle" }),
    join: async (c) => { joined = c; await writeFile(c.target, "the edit"); },
  }, job as any);
  assert.equal(out, "partial");
  const keys = sent.map((s) => s.key).sort();
  assert.deepEqual(keys, [`${J}:1:1`, `${J}:1:2`, `${J}:2:1`, `${J}:3:1:0`, `${J}:3:1:1`, `${J}:4:1`].sort(), "the copy is made again; the refusal is not (the platform would refuse it again); the 8 s move is two pieces");
  const move = sent.filter((s) => s.engine === "seedance_move").sort((a, b) => a.key.localeCompare(b.key));
  assert.equal(move[0].images.length, 1, "the first piece is shown only how the person looks");
  assert.equal(move[1].images.length, 2, "the second opens on the first piece's last picture");
  assert.match(move[1].images[0], /shot-3-1-p0-last\.jpg/);
  assert.deepEqual(move.map((m) => m.seconds), [4, 4]);
  assert.equal(sent.find((s) => s.key === `${J}:2:1`)!.engine, "wan");
  // the edit: the kept first shot, the close-up (second try), the wide shot, the move, and the refused shot as filmed
  assert.deepEqual(joined.parts.map((p: any) => p.kind === "real" ? `real ${p.from}-${p.to}` : `made ${p.seconds}`), ["real 0-6", "made 6", "made 6", "made 8", "real 26-30"]);
  assert.match(joined.parts[1].file, /shot-1-2\.mp4$/, "the second, real try is the one used");
  const done = rpc.find((r) => r.name === "studio_complete")!;
  const shots = done.args.p_outputs[0].shots;
  assert.deepEqual(shots.map((s: any) => [s.made, s.tries]), [[false, 0], [true, 2], [true, 1], [true, 1], [false, 1]]);
  assert.equal(done.args.p_credits_charged, 6 * 45 + 6 * 10 + 8 * 45, "charged for the three that made it; the refused shot goes back");
  assert.ok(done.args.p_credits_charged < job.credits_reserved);
  assert.equal(done.args.p_outputs[0].tool, "reshoot");
  assert.equal(done.args.p_outputs[0].duration, 30);
  assert.ok(!rpc.some((r) => r.name === "studio_fail"));
  // every piece the platform read was put in the job's own work folder; the edit is stored as the output
  assert.ok(uploads.filter((u) => /\/work\//.test(u.key)).every((u) => u.bucket === "studio-outputs" && u.key.startsWith(`${U}/${J}/work/`)));
  assert.deepEqual(uploads.filter((u) => !/\/work\//.test(u.key)).map((u) => u.type), ["video/mp4"]);
  const seen = rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress?.states).filter(Boolean);
  assert.deepEqual(seen[0], ["original", "waiting", "waiting", "waiting", "waiting"]);
  assert.deepEqual(seen[seen.length - 1], ["original", "made", "made", "made", "kept"]);
  assert.ok(seen.some((s) => s.includes("again")) && seen.some((s) => s.includes("checking")));
  const kept = rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress?.requests).filter(Boolean).pop();
  assert.equal(Object.keys(kept).length, 6, "every request sent is remembered, so a restart waits for it instead of sending it again");
});

test("a run: a request already sent is waited for, not sent again; nothing made is a failure with nothing charged", async () => {
  resetCostsForTests(); resetCutGate();
  const a = fakeSb(), seen: Array<string | null | undefined> = [];
  const j = jobOf([shot(0, 6, { keep: true }), shot(6, 12, { angle: "closeup" }), shot(12, 30, { keep: true })]);
  (j as any).progress = { requests: { [`${J}:1:1`]: "req-kept" } };
  const base = { env: {}, log: () => undefined, prepare: async (_u: string, t: string) => writeFile(t, "s"), cut: async (_s: string, _f: number, _t: number, t: string) => writeFile(t, "c"), retime: async (_f: string, _s: number, _z: any, t: string) => writeFile(t, "r"), likeness: async () => 15, check: async () => ({ verdict: "good" as const }), join: async (c: any) => writeFile(c.target, "v") };
  await runReshootJob(a.sb, { ...base, render: async (c) => { seen.push(c.requestId); const f = join(c.dir, "g.mp4"); await writeFile(f, "g"); return { file: f, requestId: c.requestId ?? "new" }; } }, j as any);
  assert.deepEqual(seen, ["req-kept"]);
  assert.equal(a.rpc.find((r) => r.name === "studio_complete")!.args.p_credits_charged, 6 * 45);

  const b = fakeSb();
  const out = await runReshootJob(b.sb, { ...base, check: async () => ({ verdict: "broken" }), join: async () => { throw new Error("must not join"); },
    render: async (c) => { const f = join(c.dir, `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "g"); return { file: f, requestId: "r" }; } }, jobOf([shot(0, 6, { angle: "closeup" }), shot(6, 30, { keep: true })]) as any);
  assert.equal(out, "reshoot_failed");
  assert.ok(!b.rpc.some((r) => r.name === "studio_complete"));
  const f = b.rpc.find((r) => r.name === "studio_fail")!;
  assert.deepEqual([f.args.p_reason, f.args.p_retry], ["reshoot_failed", false], "the reservation goes back whole; the run is not tried again by itself");

  const c = fakeSb();
  const refused = await runReshootJob(c.sb, { ...base, render: async () => { throw new RecastError("recast_nsfw", "refused"); } }, jobOf([shot(0, 6, { angle: "closeup" }), shot(6, 30, { keep: true })]) as any);
  assert.equal(refused, "reshoot_refused", "the page can say the platform would not make this face");
  const out2 = await runReshootJob(fakeSb().sb, { ...base, render: async () => { throw new RecastError("recast_balance", "empty"); } }, jobOf([shot(0, 6, { angle: "closeup" }), shot(6, 30, { keep: true })]) as any);
  assert.equal(out2, "recast_balance", "our own problem stops the run instead of being blamed on the shot");
});

test("a run: shots that share a look are matched to the first one's still; a move is never anchored", async () => {
  resetCostsForTests(); resetCutGate();
  const { sb } = fakeSb();
  const order: string[] = [], images: Record<string, string[]> = {}, prompts: Record<string, string> = {};
  const snow = { place: "snowy mountain ridge", outfit: "a blue ski jacket" };
  const job = jobOf([shot(0, 6, { ...snow }), shot(6, 12, { ...snow, angle: "closeup" }), shot(12, 18, { angle: "low" }), shot(18, 26, { move: "orbit", ...snow }), shot(26, 30, { ...snow, angle: "wide" })]);
  await runReshootJob(sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), cut: async (_s, _f, _t, t) => writeFile(t, "c"), retime: async (_f, _s, _z, t) => writeFile(t, "r"), likeness: async () => 15, check: async () => ({ verdict: "good" }), join: async (c) => writeFile(c.target, "v"),
    render: async (c) => { const shotNo = c.key.split(":")[1]; order.push(shotNo); images[c.key] = c.imageUrls; prompts[c.key] = c.prompt; await new Promise((r) => setTimeout(r, 10)); const f = join(c.dir, `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "g"); return { file: f, requestId: "r" }; } }, job as any);
  assert.deepEqual(images[`${J}:0:1`], [], "the first shot of the look sets it");
  assert.match(images[`${J}:1:1`][0], /anchor-0\.jpg/, "the next shot of the same look carries its still");
  assert.match(images[`${J}:4:1`][0], /anchor-0\.jpg/);
  assert.match(prompts[`${J}:1:1`], /match its place, its light and the person's outfit exactly/);
  assert.deepEqual(images[`${J}:2:1`], [], "a camera-only shot is not part of a look");
  assert.ok(!images[`${J}:3:1:0`].some((u) => /anchor/.test(u)), "a move keeps its own pictures");
  assert.ok(order.indexOf("1") > order.indexOf("0") && order.indexOf("4") > order.indexOf("0"), "followers start after the first shot of their look");
});

test("costs are written when a render is delivered, not when it is sent (a failed or refused one is refunded)", async () => {
  resetCostsForTests();
  const calls: string[] = [];
  const mk = (final: string) => async (url: string, init: any) => {
    calls.push(`${init?.method} ${url}`);
    const body = /\/requests\//.test(url) ? { status: final, video: { url: "https://cdn.example/out.mp4" } } : /cdn\.example/.test(url) ? null : { request_id: "req-1" };
    if (/cdn\.example/.test(url)) return new Response(Buffer.from("mp4"), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { initCosts, bufferedCostsForTests } = await import("../src/studio-costs.js");
  initCosts(() => ({ from: () => ({ insert: async () => ({ error: null }) }) }) as any);
  const { sb } = fakeSb();
  const run = (final: string) => runReshootJob(sb, { env: { HIGGSFIELD_API_KEY: "k" }, fetch: mk(final) as any, sleep: async () => undefined, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), cut: async (_s, _f, _t, t) => writeFile(t, "c"), retime: async (_f, _s, _z, t) => writeFile(t, "r"), likeness: async () => 15, check: async () => ({ verdict: "good" }), join: async (c) => writeFile(c.target, "v") }, jobOf([shot(0, 6, { angle: "closeup" }), shot(6, 30, { keep: true })]) as any);
  await run("failed");
  assert.equal(bufferedCostsForTests().length, 0, "a refused or failed render costs nothing");
  await run("completed");
  const rows = bufferedCostsForTests();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].tool, rows[0].product, rows[0].usd, rows[0].basis, rows[0].ref], ["reshoot", "bytedance/seedance-2.5/video-edit", 6 * 0.463, "list", "req-1"]);
  resetCostsForTests();
});

test("a run: progress reports are written one after another, so the last word is always the newest", async () => {
  resetCostsForTests(); resetCutGate();
  const { sb, rpc } = fakeSb();
  let inflight = 0, overlapped = false;
  const rpc0 = sb.rpc;
  // a database that answers slowly and unevenly, as the live one did
  sb.rpc = async (name: string, args: any) => { inflight++; if (inflight > 1) overlapped = true; await new Promise((r) => setTimeout(r, 5 + Math.random() * 25)); inflight--; return rpc0(name, args); };
  const job = jobOf([shot(0, 6, { angle: "closeup" }), shot(6, 12, { angle: "low" }), shot(12, 18, { angle: "three_quarter_left" }), shot(18, 30, { keep: true })]);
  await runReshootJob(sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), cut: async (_s, _f, _t, t) => writeFile(t, "c"), retime: async (_f, _s, _z, t) => writeFile(t, "r"), likeness: async () => 15, check: async () => ({ verdict: "good" }), join: async (c) => writeFile(c.target, "v"),
    render: async (c) => { await c.onSubmit?.(`req-${c.key}`); await new Promise((r) => setTimeout(r, Math.random() * 30)); const f = join(c.dir, `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "g"); return { file: f, requestId: `req-${c.key}` }; } }, job as any);
  assert.equal(overlapped, false, "never two writes at once");
  const renews = rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress);
  const lastMaking = renews.filter((p) => p.stage === "making").pop();
  assert.deepEqual(lastMaking.states, ["made", "made", "made", "original"]);
  assert.equal(Object.keys(renews[renews.length - 1].requests ?? {}).length, 3, "every request id is kept to the end");
});

test("plan route core: cuts from the words, Claude's choices merged, kept as plain text and read back for free", async () => {
  const files = new Map<string, string>(), uploads: Array<{ key: string; type: string }> = [];
  const words = { v: 1, at: "2026-11-14T00:00:00Z", words: Array.from({ length: 40 }, (_, i) => [i === 14 ? "done." : "word", i * 0.5, i * 0.5 + 0.4, null]), keys: [], language: "en", duration: 20 };
  const sb: any = {
    from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: A, kind: "video", name: "x.mov", object_key: `${U}/x.mov`, status: "ready", probe: { duration: 20, width: 1080, height: 1920 } }, error: null }) }; return q; },
    storage: { from: () => ({
      createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x.mov" }, error: null }),
      download: async (key: string) => { const d = /\/captions\//.test(key) ? JSON.stringify(words) : files.get(key); return d ? { data: new Blob([d]), error: null } : { data: null, error: new Error("not found") }; },
      upload: async (key: string, body: Buffer, o: any) => { uploads.push({ key, type: o?.contentType }); files.set(key, body.toString("utf8")); return { error: null }; },
    }) },
  };
  let asked = 0, input: any = null;
  const deps = { env: {}, log: () => undefined, stills: async (_v: string, times: number[]) => times.map(() => Buffer.from("jpg")),
    plan: async (shots: any) => { asked++; input = shots; return shots.map((s: any) => ({ index: s.index, keep: s.index === 0, angle: s.index === 1 ? "closeup" : "wide", move: "none", light: "same", place: "", outfit: "", why: "x" })); } };
  const first = await planFor(sb, deps, U, A);
  assert.equal(first.cached, false); assert.equal(asked, 1);
  assert.ok(input.every((s: any) => s.jpeg && typeof s.words === "string"), "each shot is shown with its still and its words");
  assert.ok(first.shots[0].keep && first.shots[1].angle === "closeup");
  assert.equal(uploads.find((u) => /\/reshoot\//.test(u.key))!.type, "text/plain", "kept in a type the bucket accepts");
  const again = await planFor(sb, deps, U, A);
  assert.deepEqual([again.cached, asked], [true, 1], "a second visit costs nothing");
  // a model that cannot answer still gives a plan: the default rotation on the same cuts
  const fallback = await planFor(sb, { ...deps, plan: async () => { throw new Error("down"); } }, U, A, { fresh: true });
  assert.ok(fallback.shots[0].keep && fallback.shots.slice(1).every((s) => !s.keep));
  assert.equal(code(() => { throw new ReshootError("x", "y"); }), "x");
  const cfg = reshootConfig({}, PLANS);
  assert.deepEqual(cfg.credits_per_second, { seedance_edit: 45, seedance_move: 45, wan: 10 });
  assert.equal(cfg.limits.max_seconds, 60);
});

test("the migration adds 'reshoot' and keeps every job type the live rule has", () => {
  const sql = readFileSync(join(process.cwd(), "migrations/20261122000000_studio_reshoot.sql"), "utf8");
  for (const t of ["blueprint", "blueprint_plus", "recast", "swap", "restyle", "trend", "character", "instrument", "clips", "import", "captions", "kage", "kage_motion", "longform", "stunts", "splitscreen", "reshoot"]) assert.ok(sql.includes(`'${t}'`), t);
  assert.ok(!/IF EXISTS/i.test(sql.replace(/^--.*$/gm, "")), "no IF EXISTS: the Supabase tool declines those");
  assert.equal((sql.replace(/^--.*$/gm, "").match(/;/g) ?? []).length, 1, "one statement, so the rule is never absent");
});

test("a move's piece: the camera counts as moved only when the background shows it somewhere else", () => {
  const bg = (...b: string[]) => b.map((background) => ({ background, size: "same" })) as any;
  // the live re-run 58da68c7: the first piece went round behind; in the second the person turned on the car, the pump stayed put
  assert.equal(pieceMoved("orbit", bg("other_side", "other_side", "other_side")).moved, true);
  assert.equal(pieceMoved("orbit", bg("same", "same", "shifted")).moved, false, "a drift or a pan is not an orbit");
  assert.equal(pieceMoved("orbit", bg("shifted", "other_side", "same")).moved, true, "a whole circle in one piece ends where it began; the stills between show it");
  const sized = (...z: string[]) => z.map((size) => ({ background: "same", size })) as any;
  assert.equal(pieceMoved("push_in", sized("same", "bigger", "bigger")).moved, true);
  assert.equal(pieceMoved("push_in", sized("bigger", "same", "same")).moved, false, "judged on the last still");
  assert.equal(pieceMoved("orbit", []).moved, true, "nothing to judge: never costs the person their shot");
  assert.equal(PIECE_TRIES, 2);
  // measured Nov 14 2026: renders that kept to the take's camera 19.4 to 19.6 dB, real orbits 13.5 to 13.8
  for (const db of [19.42, 19.62]) assert.equal(followedTake(db), true);
  for (const db of [13.5, 13.84, null]) assert.equal(followedTake(db), false);
});

test("switches for moves: the piece length, and Cinema Studio with a named camera move", () => {
  assert.equal(movePieceSeconds({}), 4);
  assert.equal(movePieceSeconds({ STUDIO_RESHOOT_MOVE_PIECE: "12" }), 12);
  assert.equal(movePieceSeconds({ STUDIO_RESHOOT_MOVE_PIECE: "40" }), 4, "out of range falls back");
  assert.deepEqual(movePieces(18, 26, 12).map((p) => [p.start, p.end, p.seconds]), [[18, 26, 8]], "one render for the whole 8 s move");
  assert.equal(billedSeconds({ start: 18, end: 26 }, "seedance_move", { STUDIO_RESHOOT_MOVE_PIECE: "12" }), 8, "the same seconds billed either way");
  assert.equal(endpointFor("seedance_move", {}), "bytedance/seedance-2.5/reference-to-video");
  const C = { STUDIO_RESHOOT_MOVE_ENGINE: "cinema" };
  assert.equal(endpointFor("seedance_move", C), CINEMA_ENDPOINT);
  assert.equal(endpointFor("seedance_edit", C), "bytedance/seedance-2.5/video-edit", "only moves go there");
  assert.equal(cinemaMove("orbit", {}), "arc-right"); assert.equal(cinemaMove("push_in", {}), "dolly-in");
  assert.equal(cinemaMove("orbit", { STUDIO_RESHOOT_CINEMA_ORBIT: "drone-orbit" }), "drone-orbit");
  assert.equal(renderUsdPerSecond("seedance_move", C), 0.206);
  assert.equal(renderUsdPerSecond("seedance_move", {}), engineUsdPerSecond("seedance_move", {}));
  assert.equal(creditsPerSecondFor("seedance_move", PLANS, C), 45, "the customer's price does not move until a real cost is read");
  const body = bodyFor({ engine: "seedance_move", prompt: "p", videoUrl: "v", imageUrls: ["a"], seconds: 8, aspect: "9:16", endpoint: CINEMA_ENDPOINT, camera: "arc-right" });
  assert.deepEqual(body, { prompt: "p", video_urls: ["v"], image_urls: ["a"], duration: 8, resolution: "720p", aspect_ratio: "9:16", generate_audio: false, camera_movement: "arc-right" });
  assert.ok(!("camera_movement" in bodyFor({ engine: "seedance_move", prompt: "p", videoUrl: "v", imageUrls: ["a"], seconds: 4, aspect: "9:16" })));
  const firm = promptFor({ ...NO_CHANGE, move: "orbit" }, "seedance_move", { k: 1, n: 2, chained: true, firm: true });
  assert.ok(firm.endsWith(FIRM_WORDS));
  assert.match(promptFor({ ...NO_CHANGE, move: "orbit" }, "seedance_move", { k: 0, n: 1, chained: false }), /all the way around .* behind them/, "one piece is the whole circle, never 'from in front to in front'");
  assert.ok(!promptFor({ ...NO_CHANGE, move: "orbit" }, "seedance_move", { k: 1, n: 2, chained: true }).includes(FIRM_WORDS));
});

test("a run: a piece that stayed on the take's camera is made again on its own; stuck twice, the shot keeps the original, uncharged", async () => {
  const base = (sent: any[], stuck: (k: number, firm: boolean) => boolean, env: Record<string, string> = {}) => ({
    env, log: () => undefined, prepare: async (_u: string, t: string) => writeFile(t, "s"), cut: async (_s: string, _f: number, _t: number, t: string) => writeFile(t, "c"),
    retime: async (_f: string, _s: number, _z: any, t: string) => writeFile(t, "r"), likeness: async () => 15, check: async () => ({ verdict: "good" as const }),
    join: async (c: any) => writeFile(c.target, "edit"),
    render: async (c: any) => { sent.push({ key: c.key, prompt: c.prompt, endpoint: c.endpoint, camera: c.camera }); const f = join(c.dir, `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "m"); return { file: f, requestId: `q-${c.key}` }; },
    pieceCheck: async (c: any) => ({ moved: !stuck(c.piece, c.firm), note: "seen" }),
  });
  // the second piece stays put once, then moves with the firmer words
  resetCostsForTests(); resetCutGate();
  const a = fakeSb(), sentA: any[] = [];
  const outA = await runReshootJob(a.sb, base(sentA, (k, firm) => k === 1 && !firm) as any, jobOf([shot(0, 8, { move: "orbit" }), shot(8, 30, { keep: true })]) as any);
  assert.equal(outA, "done");
  assert.deepEqual(sentA.map((x) => x.key), [`${J}:0:1:0`, `${J}:0:1:1`, `${J}:0:1:1:r1`], "only the piece that stayed put is made again, not the whole move");
  assert.ok(sentA[2].prompt.endsWith(FIRM_WORDS));
  assert.match(sentA[1].prompt, /^Generate a new video that opens on <<<image_1>>>/);
  const doneA = a.rpc.find((r) => r.name === "studio_complete")!;
  assert.equal(doneA.args.p_credits_charged, 8 * 45, "the extra piece is ours, not the person's");
  const checks = a.rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress?.move_checks).filter(Boolean).pop();
  assert.deepEqual(checks.map((m: any) => [m.piece, m.try, m.moved]), [[0, 1, true], [1, 1, false], [1, 2, true]]);
  // the free measure catches a piece that kept to the take's camera before Claude is asked
  resetCostsForTests(); resetCutGate();
  const m = fakeSb(), sentM: any[] = [], asked: number[] = [];
  const bm: any = base(sentM, () => false);
  bm.likeness = async (src: string, res: string) => (/shot-0-p1\.mp4$/.test(src) && !/r1/.test(res) ? 19.6 : 14);
  bm.pieceCheck = async (c: any) => { asked.push(c.piece); return { moved: true }; };
  assert.equal(await runReshootJob(m.sb, bm, jobOf([shot(0, 8, { move: "orbit" }), shot(8, 30, { keep: true })]) as any), "done");
  assert.deepEqual(sentM.map((x) => x.key), [`${J}:0:1:0`, `${J}:0:1:1`, `${J}:0:1:1:r1`]);
  assert.deepEqual(asked, [0, 1], "Claude is not asked about the piece the measure already caught");
  // stuck twice: no third piece, no whole-shot retry; the original stays and nothing is charged for it
  resetCostsForTests(); resetCutGate();
  const b = fakeSb(), sentB: any[] = [];
  const outB = await runReshootJob(b.sb, base(sentB, (k) => k === 1) as any, jobOf([shot(0, 8, { move: "orbit" }), shot(8, 14, { angle: "closeup" }), shot(14, 30, { keep: true })]) as any);
  assert.equal(outB, "partial");
  assert.deepEqual(sentB.filter((x) => x.key.startsWith(`${J}:0:`)).map((x) => x.key), [`${J}:0:1:0`, `${J}:0:1:1`, `${J}:0:1:1:r1`]);
  const doneB = b.rpc.find((r) => r.name === "studio_complete")!;
  assert.deepEqual(doneB.args.p_outputs[0].shots.map((s: any) => s.made), [false, true, false]);
  assert.equal(doneB.args.p_credits_charged, 6 * 45, "only the close-up is charged");
  // the whole move in one render on Cinema Studio: one request, its endpoint and named move
  resetCostsForTests(); resetCutGate();
  const c = fakeSb(), sentC: any[] = [];
  assert.equal(await runReshootJob(c.sb, base(sentC, () => false, { STUDIO_RESHOOT_MOVE_ENGINE: "cinema", STUDIO_RESHOOT_MOVE_PIECE: "12" }) as any, jobOf([shot(0, 8, { move: "orbit" }), shot(8, 30, { keep: true })]) as any), "done");
  assert.deepEqual(sentC.map((x) => [x.key, x.endpoint, x.camera]), [[`${J}:0:1:0`, CINEMA_ENDPOINT, "arc-right"]]);
});
