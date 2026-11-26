// The failures of Nov 25-26 2026:
//  - a Live Clips run on a Twitch stream titled with 💰 lost every moment check: the title, cut at 80 characters, ended in
//    half an emoji, and Claude refused the request ("not valid JSON: unexpected end of hex escape"); the person was told
//    4 moments "did not stand alone" although none was judged;
//  - a Characters run failed in 6 s with "recast_failed" and no reason logged; the same prompt worked a minute later.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeBody, wellFormed } from "../src/claude-body.js";
import { attemptKey, runCharacterJob } from "../src/studio-characters.js";

const TITLE = "💰GTA 6 PLAYTHROUGH💰60 FPS GAMEPLAY💰I LIKE THE GAME💰SHUT UP💰EXCLUSIVE BADGE💰GOOD VIBES💰[twitter/insta stableronaldo] !sub !com !ultra";
const LONE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i;

test("a Claude request body is valid JSON even when a cut ends inside an emoji; whole emoji are kept", () => {
  const cut = TITLE.slice(0, 80);
  assert.match(JSON.stringify({ t: cut }), LONE_ESCAPE, "the old body: a lone surrogate escape, which Claude refuses");
  const body = claudeBody({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: `Stream titled "${cut}"` }] }], n: 3, ok: true });
  assert.doesNotMatch(body, LONE_ESCAPE);
  const back = JSON.parse(body);
  assert.equal(back.n, 3); assert.equal(back.ok, true);
  assert.ok(back.messages[0].content[0].text.endsWith("�\""), "the broken half becomes U+FFFD");
  assert.equal(wellFormed("💰 ok 😂"), "💰 ok 😂", "whole emoji untouched");
  assert.equal(wellFormed("\uDE00 start"), "� start", "a lone second half too (a cut from the end, .slice(-n))");
});

// Characters: a fake database and a fake Higgsfield whose status answers are given in order
function fakeSb() {
  const fails: any[] = []; const progress: any[] = [];
  const sb: any = {
    rpc: async (fn: string, args: any) => {
      if (fn === "studio_renew") { progress.push(args.p_progress); return { data: true, error: null }; }
      if (fn === "studio_fail") { fails.push(args); return { data: null, error: null }; }
      return { data: null, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
  };
  return { sb, fails, progress };
}
const job = (attempts: number): any => ({ id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222", lease_token: "t", attempts, credits_reserved: 12,
  options: { kind: "influencer", mode: "human", prompt: "a person", count: 1 }, progress: { request_id: "r1", submitted_at: new Date().toISOString() } });
const hfWith = (status: any) => (async () => new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } })) as any;

test("Characters: a render that fails with no reason is sent again as a new request; a real reason is kept and logged", async () => {
  const env = { HIGGSFIELD_API_KEY: "id:secret" };
  // no reason, first attempt: back in the queue, the old request forgotten so a new one is made
  const a = fakeSb(); const logs: string[] = [];
  const out = await runCharacterJob(a.sb, { env, fetch: hfWith({ status: "failed" }), log: (l) => logs.push(l), sleep: async () => undefined }, job(1));
  assert.equal(out, "requeued");
  assert.equal(a.fails[0].p_retry, true); assert.equal(a.fails[0].p_reason, "recast_failed");
  assert.equal(a.progress.at(-1).request_id, null, "the failed request is not polled again");
  assert.ok(logs.some((l) => l.startsWith("[character] failed") && l.includes("\"request\":\"r1\"")), "Higgsfield's answer is in the log");
  // a stated reason: not retried, the reason logged
  const b = fakeSb(); const logsB: string[] = [];
  assert.equal(await runCharacterJob(b.sb, { env, fetch: hfWith({ status: "failed", error: "No face detected in the reference image" }), log: (l) => logsB.push(l), sleep: async () => undefined }, job(1)), "failed");
  assert.equal(b.fails[0].p_retry, false);
  assert.ok(logsB.some((l) => l.includes("No face detected")));
  // the third attempt is the last
  const c = fakeSb();
  assert.equal(await runCharacterJob(c.sb, { env, fetch: hfWith({ status: "failed" }), sleep: async () => undefined }, job(3)), "failed");
  // moderated: never retried
  const d = fakeSb();
  assert.equal(await runCharacterJob(d.sb, { env, fetch: hfWith({ status: "nsfw" }), sleep: async () => undefined }, job(1)), "failed");
  assert.equal(d.fails[0].p_reason, "recast_nsfw");
  // our account's problem is named as ours
  const e = fakeSb();
  await runCharacterJob(e.sb, { env, fetch: hfWith({ status: "failed", error: "Insufficient credits on the account" }), sleep: async () => undefined }, job(1));
  assert.equal(e.fails[0].p_reason, "recast_balance");
});

test("Characters: each attempt asks Higgsfield for a new request (a repeated key returns the failed one)", () => {
  assert.equal(attemptKey({ id: "j", attempts: 1 }), "j", "the first attempt keeps the job's id, as before");
  assert.equal(attemptKey({ id: "j", attempts: 2 }), "j:2");
  assert.equal(attemptKey({ id: "j" }), "j");
});

test("a run on a part hears only hours that overlap the part, even when the part itself is too muted to hear whole", async () => {
  const { hoursToRead, QUIET } = await import("../src/studio-live-clips.js");
  const part = { from: 42835, to: 44635 }; // 11:53-12:23 into a 12.4-hour stream, as on Nov 26 2026
  const cands = [{ t_event: 43607, score: 47 }, { t_event: 500, score: 30 }, { t_event: 9000, score: 20 }];
  assert.ok(hoursToRead(cands, 44640, () => 0, QUIET.max_hours, true).some((h) => h < 11), "without the part: hours from anywhere in the stream");
  assert.deepEqual(hoursToRead(cands, 44640, () => 0, QUIET.max_hours, true, part), [11, 12], "with the part: only the two clock hours it touches");
  assert.deepEqual(hoursToRead(cands, 44640, (a) => (a >= 39600 ? 1 : 0), QUIET.max_hours, true, part), [], "both of the part's hours muted: nothing is heard, nothing wasted");
});
