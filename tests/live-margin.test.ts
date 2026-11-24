import test from "node:test";
import assert from "node:assert/strict";
import { streamPrice, LIVE_RATES } from "../src/studio-live-clips.js";
import { withCostRun, withRun, currentCostRun } from "../src/studio-costs.js";
import { PLANS } from "../src/studio.js";

const env = {} as Record<string, string | undefined>;
test("a live run's reading is at least 4 credits per clip asked; past streams are priced as before", () => {
  const hour = 3600;
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env, live: true }).analysis, 10 * LIVE_RATES.live_per_asked, "1 h live, 10 asked: 40, not 30");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 4, env, live: true }).analysis, LIVE_RATES.min, "4 asked: the 30 minimum still applies");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env }).analysis, LIVE_RATES.min, "a past hour: unchanged");
  assert.equal(streamPrice(PLANS, { seconds: 8 * hour, length: "standard", count: 10, env, live: true }).analysis, 8 * LIVE_RATES.per_hour, "a long part: its hours already cost more");
  assert.equal(streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env, live: true }).per_clip, streamPrice(PLANS, { seconds: hour, length: "standard", count: 10, env }).per_clip, "per clip unchanged");
});

test("a cost recorded inside a run carries that run; one that names its own job keeps it", async () => {
  const row = { provider: "anthropic", product: "claude-sonnet-5-5", source: "live_clips_verify", usd: 0.01 } as any;
  assert.equal(withRun(row).job_id, undefined, "outside a run: nothing added");
  await withCostRun({ job_id: "job-1", user_id: "user-1", tool: "clips" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    const r = withRun(row);
    assert.equal(r.job_id, "job-1"); assert.equal(r.user_id, "user-1"); assert.equal(r.tool, "clips");
    assert.equal(withRun({ ...row, job_id: "other" }).job_id, "other");
    assert.equal(currentCostRun()?.job_id, "job-1");
  });
  // two runs at once each keep their own
  const seen: string[] = [];
  await Promise.all(["a", "b"].map((id) => withCostRun({ job_id: id, user_id: null, tool: "clips" }, async () => { await new Promise((r) => setTimeout(r, id === "a" ? 10 : 1)); seen.push(`${id}:${withRun(row).job_id}`); })));
  assert.deepEqual(seen.sort(), ["a:a", "b:b"]);
});

import { hoursToRead, isQuiet, QUIET, VERIFY_SYSTEM } from "../src/studio-live-clips.js";
test("a quiet chat: every hour is heard, the hours the chat reacted to first; a busy one: only its top hours", () => {
  const none = () => 0;
  const cands = [{ t_event: 7300, score: 9 }, { t_event: 7400, score: 5 }, { t_event: 200, score: 3 }];
  assert.deepEqual(hoursToRead(cands, 12170, none, 2), [0, 2], "busy: the 2 hours with moments");
  assert.deepEqual(hoursToRead(cands, 12170, none, QUIET.max_hours, true), [0, 1, 2, 3], "quiet: every hour of the 3.4 h stream");
  assert.equal(isQuiet(18, 15, 10), true, "Nov 22 2026 gattouz0: 18 a minute, 15 moments for 10 asked");
  assert.equal(isQuiet(400, 60, 10), false);
  assert.equal(isQuiet(400, 12, 10), true, "busy chat but too few moments for 10 clips");
});
test("the moment checker never marks a clip down for its language", () => {
  assert.match(VERIFY_SYSTEM, /never marked down for not being in English/);
});

import { unsafeNote, UNSAFE } from "../src/studio-live-clips.js";
test("when many moments were explicit or slurs, the run's note says so and why it protects the person", () => {
  assert.equal(unsafeNote(1, 23), "", "one is not worth a word");
  assert.match(unsafeNote(1, 1), /^ It was explicit content or slurs/, "the only moment: it is said");
  assert.match(unsafeNote(4, 4), /^ All 4 were explicit content or slurs/);
  assert.equal(unsafeNote(3, 40), "", "a few among many: not the reason for fewer clips");
  assert.match(unsafeNote(6, 23), /6 of the moments we passed on were explicit content or slurs/);
  assert.match(unsafeNote(6, 23), /TikTok, Instagram and YouTube take posts like that down/);
  assert.ok(UNSAFE.test("explicit sexual content (GTA threesome scene)") && UNSAFE.test("homophobic slur repeated") && !UNSAFE.test("needs the previous five minutes"));
});
test("a little mixing of languages is normal and never a reason to turn a moment down", () => {
  assert.match(VERIFY_SYSTEM, /A little mixing is never a reason to lower a grade/);
});

test("the run's language is settled from all it heard, by words, and the moment checker is told it (Nov 23 2026: French titles for an English stream)", async () => {
  const { runLanguage, voteLanguage, languageLine } = await import("../src/studio-live-clips.js");
  const v = new Map<string, number>();
  assert.equal(runLanguage(v), null);
  assert.equal(languageLine(null), "", "nothing heard yet: no line");
  voteLanguage(v, "eng", 5000); // an hour heard whole
  voteLanguage(v, "fra", 300);  // one window with French in it
  voteLanguage(v, null, 900); voteLanguage(v, "eng", 0);
  assert.equal(runLanguage(v), "eng");
  assert.match(languageLine("eng"), /The stream is in English: write the title, hook_line and caption in English/);
  assert.match(languageLine("ara"), /in Arabic/);
  assert.match(languageLine("xyz"), /in xyz/, "an unknown code is passed as it is");
  const fr = new Map<string, number>(); voteLanguage(fr, "fra", 4000); voteLanguage(fr, "eng", 800);
  assert.equal(runLanguage(fr), "fra", "a French stream with some English stays French");
});
