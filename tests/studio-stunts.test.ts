import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLANS, toolsEnabled } from "../src/studio.js";
import { resetCostsForTests } from "../src/studio-costs.js";
import { resetCutGate } from "../src/studio-capacity.js";
import { STUNT_LIMITS, StuntsError, cleanGags, cleanMoments, colourFix, joinGraph, planTimeline, quoteStunts, runStuntsJob, stillTimes, stuntGagCostUsd, stuntGagCredits, stuntGenerationUsd, stuntsEnabled, stuntsOpen, workingSize } from "../src/studio-stunts.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ON = { STUDIO_STUNTS_ENABLED: "true", HIGGSFIELD_API_KEY: "k", ANTHROPIC_API_KEY: "k" };
const OPEN = { ...ON, STUDIO_STUNTS_OPEN: "true" };
const asset = (duration = 30) => ({ id: A, kind: "video", name: "forklift.mp4", probe: { duration, width: 1080, height: 1920 } });
const gag = (at: number, extra: Record<string, any> = {}) => ({ at, prompt: "He lifts the whole forklift over his head and throws it.", ...extra });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e instanceof StuntsError ? e.code : `other:${e?.message}`; } return "no error"; };

test("switches: off by default; the switch alone opens it to the owner only; the tool list says open only when both are on", () => {
  assert.equal(stuntsEnabled({}), false);
  assert.equal(stuntsEnabled({ STUDIO_STUNTS_ENABLED: "true" }), false, "needs the model key and the Claude key too");
  assert.equal(stuntsEnabled(ON), true);
  assert.equal(stuntsOpen(ON), false);
  assert.equal(stuntsOpen({ STUDIO_STUNTS_OPEN: "true" }), false, "the open switch cannot switch the feature on by itself");
  assert.equal(stuntsOpen(OPEN), true);
  assert.equal((toolsEnabled({}) as any).stunts, false);
  assert.equal((toolsEnabled(ON) as any).stunts, false, "customers do not see it while only the owner can use it");
  assert.equal((toolsEnabled(OPEN) as any).stunts, true);
  assert.equal(code(() => quoteStunts({}, PLANS, asset(), { rights: true, gags: [gag(5)] })), "stunts_off");
  assert.equal(code(() => quoteStunts(ON, PLANS, asset(), { rights: true, gags: [gag(5)] })), "stunts_off");
  assert.equal(quoteStunts(ON, PLANS, asset(), { rights: true, gags: [gag(5)] }, { owner: true }).tool, "stunts");
});

test("price: a stunt is priced on one generation, half of another and the reading, at the standard margin", () => {
  assert.equal(stuntGenerationUsd({}), 0.375, "5 s at $0.075");
  assert.equal(stuntGagCostUsd({}), 0.5925);
  assert.equal(stuntGenerationUsd({ STUDIO_STUNTS_USD_PER_SECOND: "0.105" }), 0.525, "the rate can follow the platform's");
  const each = stuntGagCredits({}, PLANS);
  assert.ok(each >= 1 && Number.isInteger(each));
  const q = quoteStunts(OPEN, PLANS, asset(), { rights: true, gags: [gag(5), gag(12), gag(20)] });
  assert.equal(q.credits, each * 3);
  assert.equal(q.options.credits_per_gag, each);
  assert.equal(q.summary, "3 stunts · 30 s video");
  // what the credits bring in at the cheapest credit value covers twice the cost (a 50% margin), give or take rounding up
  const floor = Math.min(...PLANS.map((p) => Math.min(p.monthly_usd, p.annual_usd_per_month) / p.credits));
  assert.ok(each * floor >= stuntGagCostUsd({}) * 2 - floor, `${each} credits at $${floor.toFixed(4)} each for a $${stuntGagCostUsd({})} stunt`);
});

test("quote: the video has to be the person's, short enough, and they have to say it is theirs", () => {
  assert.equal(code(() => quoteStunts(OPEN, PLANS, null, { rights: true, gags: [gag(5)] })), "video_not_found");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, { ...asset(), kind: "image" }, { rights: true, gags: [gag(5)] })), "video_not_found");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, { ...asset(), probe: {} }, { rights: true, gags: [gag(5)] })), "asset_not_inspected");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, asset(2), { rights: true, gags: [gag(1.5)] })), "stunts_too_short");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, asset(61), { rights: true, gags: [gag(5)] })), "stunts_too_long");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, asset(), { gags: [gag(5)] })), "stunts_rights");
  assert.equal(code(() => quoteStunts(OPEN, PLANS, asset(), { rights: "yes", gags: [gag(5)] })), "stunts_rights");
  assert.equal(quoteStunts(OPEN, PLANS, asset(), { rights: true, gags: [gag(5)], speed: 9 }).options.speed, 2, "an unknown speed falls back");
  assert.equal(quoteStunts(OPEN, PLANS, asset(), { rights: true, gags: [gag(5)], speed: 2.5 }).options.speed, 2.5);
});

test("gags: in order, inside the video, apart from each other, each with words", () => {
  assert.equal(code(() => cleanGags([], 30)), "stunts_no_gag");
  assert.equal(code(() => cleanGags(Array.from({ length: 7 }, (_, i) => gag(2 + i * 3)), 30)), "stunts_too_many");
  assert.equal(code(() => cleanGags([gag(0.4)], 30)), "stunts_bad_moment");
  assert.equal(code(() => cleanGags([gag(31)], 30)), "stunts_bad_moment");
  assert.equal(code(() => cleanGags([{ at: 5, prompt: "boom" }], 30)), "stunts_bad_prompt");
  assert.equal(code(() => cleanGags([gag(5), gag(6)], 30)), "stunts_too_close");
  const g = cleanGags([gag(20, { resume: 22 }), gag(5.004, { resume: 3, title: "  Lift\nit  " }), gag(12, { resume: 19.8 })], 30);
  assert.deepEqual(g.map((x) => [x.at, x.resume]), [[5, 5], [12, 12], [20, 22]], "sorted; a resume before the gag is ignored; one that would overlap the next gag falls back to the gag's own time");
  assert.equal(g[0].title, "Lift it");
  assert.equal(cleanGags([gag(5, { prompt: "x".repeat(900) })], 30)[0].prompt.length, STUNT_LIMITS.prompt_max);
});

test("ideas: Claude's moments are kept in bounds, apart, with at most three clean ideas", () => {
  const idea = (t: string) => ({ title: t, prompt: `${t}: the chair launches through the ceiling.` });
  const m = cleanMoments([
    { at: 14, resume: 15.5, why: "end of the sentence", ideas: [idea("a"), idea("b"), idea("c"), idea("d")] },
    { at: 0.3, resume: 0.3, why: "too early", ideas: [idea("a")] },
    { at: 14.6, resume: 14.6, why: "too close to the one before", ideas: [idea("a")] },
    { at: 6, resume: 2, why: "resume before", ideas: [idea("a"), { title: "", prompt: "nothing" }, { title: "short", prompt: "boom" }] },
    { at: 99, resume: 99, why: "outside", ideas: [idea("a")] },
    { at: 20, resume: 20, why: "no ideas", ideas: [] },
  ], 30);
  assert.deepEqual(m.map((x) => [x.at, x.resume, x.ideas.length]), [[6, 6, 1], [14, 15.5, 3]]);
  assert.deepEqual(cleanMoments("nonsense", 30), []);
  const t = stillTimes(20);
  assert.equal(t.length, 20); assert.equal(t[0], 0.5); assert.equal(t[t.length - 1], 19.5);
  assert.equal(stillTimes(60).length, STUNT_LIMITS.stills, "never more stills than the limit");
});

test("timeline: real up to each gag, the gag sped up, real again from where the person carries on", () => {
  const made = [{ index: 1, at: 20, resume: 23, seconds: 5 }, { index: 0, at: 8, resume: 8, seconds: 5 }];
  const { segments, total } = planTimeline(30, made, 2);
  assert.deepEqual(segments, [
    { kind: "real", from: 0, to: 8 }, { kind: "gag", index: 0, seconds: 2.5 },
    { kind: "real", from: 8, to: 20 }, { kind: "gag", index: 1, seconds: 2.5 },
    { kind: "real", from: 23, to: 30 },
  ]);
  assert.equal(total, 8 + 2.5 + 12 + 2.5 + 7);
  // a gag at the very end: nothing real after it
  assert.deepEqual(planTimeline(10, [{ index: 0, at: 9.95, resume: 9.95, seconds: 5 }], 2.5).segments, [{ kind: "real", from: 0, to: 9.95 }, { kind: "gag", index: 0, seconds: 2 }]);
});

test("the join: every piece trimmed, sped up and levelled, silence where there is no sound, one concat at the end", () => {
  const { segments } = planTimeline(30, [{ index: 0, at: 8, resume: 8, seconds: 5 }, { index: 1, at: 20, resume: 23, seconds: 5 }], 2.5);
  const { graph } = joinGraph(segments, [{ index: 0, fix: { y: 4, u: -2, v: 0 }, hasAudio: true }, { index: 1, fix: null, hasAudio: false }], { w: 720, h: 1280, speed: 2.5, sourceAudio: true });
  assert.match(graph, /^\[0:v\]split=3\[sv0\]\[sv1\]\[sv2\];\[0:a\]asplit=3\[sa0\]\[sa1\]\[sa2\];/, "the person's video is split once per real stretch (an input feeds one filter only)");
  assert.match(graph, /\[sv0\]trim=start=0\.000:end=8\.000/);
  assert.match(graph, /\[1:v\]setpts=\(PTS-STARTPTS\)\/2\.5,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280/);
  assert.match(graph, /lutyuv=y=clip\(val\+4\\,16\\,235\):u=clip\(val\+-2\\,16\\,240\)/, "the first gag's colour is nudged to the real frame's");
  assert.match(graph, /\[1:a\]atempo=2,atempo=1\.250,loudnorm=I=-15/, "over 2x, the sound is sped up in two steps and levelled");
  assert.match(graph, /anullsrc=r=44100:cl=stereo,atrim=duration=2\.000\[a3\]/, "a gag that came back silent gets silence, not a missing track");
  assert.match(graph, /\[sa2\]atrim=start=23\.000:end=30\.000/);
  assert.ok(graph.endsWith("[v0][a0][v1][a1][v2][a2][v3][a3][v4][a4]concat=n=5:v=1:a=1[v][a]"));
  assert.equal((graph.match(/lutyuv/g) ?? []).length, 1, "no correction where none is needed");
  const silent = joinGraph(segments, [{ index: 0, fix: null, hasAudio: true }, { index: 1, fix: null, hasAudio: true }], { w: 720, h: 1280, speed: 2, sourceAudio: false }).graph;
  assert.ok(!silent.includes("[0:a]"), "a silent source is never asked for sound");
  assert.match(silent, /\[2:a\]atempo=2\.000,/);
  const one = joinGraph([{ kind: "real", from: 0, to: 9 }, { kind: "gag", index: 0, seconds: 2.5 }], [{ index: 0, fix: null, hasAudio: true }], { w: 720, h: 1280, speed: 2, sourceAudio: true }).graph;
  assert.ok(one.startsWith("[0:v]trim=") && one.includes("[0:a]atrim=") && !one.includes("split"), "one real stretch needs no split");
});

test("colour and size: a small difference is corrected, a large one is capped, none is left alone; the model's size is 720 on the short side", () => {
  assert.equal(colourFix({ y: 120, u: 128, v: 128 }, { y: 120.4, u: 128, v: 127.6 }), null);
  assert.deepEqual(colourFix({ y: 120, u: 128, v: 130 }, { y: 112, u: 129, v: 127 }), { y: 8, u: -1, v: 3 });
  assert.deepEqual(colourFix({ y: 60, u: 128, v: 128 }, { y: 140, u: 128, v: 128 }), { y: -14, u: 0, v: 0 }, "never more than a nudge");
  assert.deepEqual(workingSize(1080, 1920), { w: 720, h: 1280 });
  assert.deepEqual(workingSize(1920, 1080), { w: 1280, h: 720 });
  assert.deepEqual(workingSize(540, 960), { w: 540, h: 960 }, "never scaled up");
  assert.deepEqual(workingSize(0, 0), { w: 720, h: 1280 });
});

// A run with the model, the check and the cutter replaced: what is asked for, retried, joined, charged and given back.
function fakeSb() {
  const rpc: any[] = [], uploads: any[] = [];
  const sb: any = {
    rpc: async (name: string, args: any) => { rpc.push({ name, args }); return { data: name === "studio_renew" ? true : { ok: true }, error: null }; },
    from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: A, kind: "video", name: "forklift.mp4", object_key: `${U}/x.mp4`, status: "ready", probe: { duration: 30, width: 1080, height: 1920 } }, error: null }) }; return q; },
    storage: { from: (bucket: string) => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x.mp4" }, error: null }), upload: async (key: string, body: Buffer, o: any) => { uploads.push({ bucket, key, bytes: body.length, type: o?.contentType }); return { error: null }; } }) },
  };
  return { sb, rpc, uploads };
}
const jobOf = (gags: any[], each = 10) => ({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: U, lease_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", asset_id: A, credits_reserved: each * gags.length, attempts: 1, progress: {},
  options: { gags: cleanGags(gags, 30), speed: 2, seconds: 30, credits_per_gag: each } });

test("a run: a broken gag is made once more, one broken twice is left out and not charged, a weak one is used as it is", async () => {
  resetCostsForTests(); resetCutGate();
  const { sb, rpc, uploads } = fakeSb();
  const asked: string[] = [], verdicts: Record<string, string[]> = { "0": ["broken", "good"], "1": ["broken", "broken"], "2": ["weak"] };
  let rendered: any = null;
  const out = await runStuntsJob(sb, {
    env: {}, log: () => undefined,
    prepare: async (_url, target) => writeFile(target, "source"),
    generate: async (c) => { asked.push(c.key); const f = join(c.frame, "..", `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "gag"); await c.onSubmit?.(`req-${c.key}`); return { file: f, requestId: `req-${c.key}` }; },
    check: async (c) => { const i = c.clip.match(/_(\d)_\d\.mp4$/)![1]; return verdicts[i].shift() as any; },
    render: async (c) => { rendered = c; await writeFile(c.target, "joined video"); },
  }, jobOf([gag(5, { title: "Lift" }), gag(12, { title: "Wall" }), gag(20, { title: "Rocket", resume: 22 })]));
  assert.equal(out, "partial");
  const J = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.deepEqual(asked.sort(), [`${J}:0:1`, `${J}:0:2`, `${J}:1:1`, `${J}:1:2`, `${J}:2:1`], "two tries at most; a good or a weak one is not made again");
  assert.deepEqual(rendered.made.map((m: any) => m.index), [0, 2]);
  assert.match(rendered.made[0].file, /_0_2\.mp4$/, "the second, good try is the one used");
  assert.deepEqual(rendered.segments.map((s: any) => s.kind), ["real", "gag", "real", "gag", "real"]);
  assert.deepEqual([rendered.w, rendered.h, rendered.speed], [720, 1280, 2]);
  const done = rpc.find((r) => r.name === "studio_complete")!;
  assert.equal(done.args.p_credits_charged, 20, "two of three made: two charged, the third goes back");
  const o = done.args.p_outputs[0];
  assert.deepEqual([o.kind, o.tool, o.duration], ["video", "stunts", 5 + 2.5 + 15 + 2.5 + 8]);
  assert.deepEqual(o.gags.map((g: any) => [g.title, g.made, g.verdict, g.tries]), [["Lift", true, "good", 2], ["Wall", false, "failed", 2], ["Rocket", true, "weak", 1]]);
  assert.deepEqual(uploads.map((u) => [u.bucket, u.type]), [["studio-outputs", "video/mp4"]]);
  assert.ok(!rpc.some((r) => r.name === "studio_fail"));
  const seen = rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress?.states).filter(Boolean);
  assert.deepEqual(seen[0], ["making", "making", "making"], "the page is told what each stunt is doing from the start");
  assert.deepEqual(seen[seen.length - 1], ["made", "left", "made"], "and how each one ended");
  assert.ok(seen.some((s) => s.includes("again")) && seen.some((s) => s.includes("checking")), "a second try and the look at it are shown too");
  const kept = rpc.filter((r) => r.name === "studio_renew").map((r) => r.args.p_progress?.requests).filter(Boolean).pop();
  assert.equal(Object.keys(kept).length, 5, "every request sent is remembered, so a restart waits for it instead of sending it again");
});

test("a run: a request already sent is waited for, not sent again; nothing made means a failure with nothing charged", async () => {
  resetCostsForTests(); resetCutGate();
  const a = fakeSb();
  const seen: Array<string | null | undefined> = [];
  const j = jobOf([gag(5)]);
  (j as any).progress = { requests: { [`${j.id}:0:1`]: "req-kept" } };
  await runStuntsJob(a.sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), check: async () => "good", render: async (c) => writeFile(c.target, "v"),
    generate: async (c) => { seen.push(c.requestId); const f = join(c.frame, "..", "g.mp4"); await writeFile(f, "g"); return { file: f, requestId: c.requestId ?? "new" }; } }, j);
  assert.deepEqual(seen, ["req-kept"]);
  // the frame's address on the platform is remembered too: a resend after a restart is the same request, not a new one
  const c = fakeSb(); const urls: Array<string | null | undefined> = [];
  const j2 = jobOf([gag(5)]); (j2 as any).progress = { frames: { "0": "https://cdn.example/frame.jpg" } };
  await runStuntsJob(c.sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), check: async () => "good", render: async (x) => writeFile(x.target, "v"),
    generate: async (x) => { urls.push(x.frameUrl); const f = join(x.frame, "..", "g.mp4"); await writeFile(f, "g"); return { file: f, requestId: "r" }; } }, j2);
  assert.deepEqual(urls, ["https://cdn.example/frame.jpg"]);
  assert.equal(a.rpc.find((r) => r.name === "studio_complete")!.args.p_credits_charged, 10);

  const b = fakeSb();
  const out = await runStuntsJob(b.sb, { env: {}, log: () => undefined, prepare: async (_u, t) => writeFile(t, "s"), check: async () => "broken", render: async () => { throw new Error("must not render"); },
    generate: async (c) => { const f = join(c.frame, "..", `${c.key.replace(/:/g, "_")}.mp4`); await writeFile(f, "g"); return { file: f, requestId: "r" }; } }, jobOf([gag(5), gag(12)]));
  assert.equal(out, "stunts_failed");
  assert.ok(!b.rpc.some((r) => r.name === "studio_complete"));
  const f = b.rpc.find((r) => r.name === "studio_fail")!;
  assert.deepEqual([f.args.p_reason, f.args.p_retry], ["stunts_failed", false], "the reservation goes back whole; the run is not tried again by itself");
  assert.equal(b.uploads.length, 0);
});

test("the migration adds 'stunts' and keeps every job type the live rule has", () => {
  const sql = readFileSync(join(process.cwd(), "migrations/20261118000000_studio_stunts.sql"), "utf8");
  for (const t of ["blueprint", "blueprint_plus", "recast", "swap", "restyle", "trend", "character", "instrument", "clips", "import", "captions", "kage", "kage_motion", "longform", "stunts"]) assert.ok(sql.includes(`'${t}'`), t);
  assert.ok(!/IF EXISTS/i.test(sql.replace(/^--.*$/gm, "")), "no IF EXISTS: the Supabase tool declines those");
  assert.equal((sql.replace(/^--.*$/gm, "").match(/;/g) ?? []).length, 1, "one statement, so the rule is never absent");
});
