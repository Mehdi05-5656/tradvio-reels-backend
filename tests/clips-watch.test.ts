import test from "node:test";
import assert from "node:assert/strict";
import { clipsRuns, clipsAlerts, clipsSummary, digestText, digestDue, TRANSCRIBE_USD_PER_HOUR } from "../src/clips-watch.js";
import { creditValueFloor } from "../src/studio-pricing.js";
import { PLANS } from "../src/studio.js";

const T = Date.parse("2026-11-17T01:00:00Z"), at = (min: number) => new Date(T + min * 60_000).toISOString();
const credit = creditValueFloor(PLANS);

// a clean lean run like the owner's 17c89f19 (83 min, 5 clips, 6 proxy calls), and another person's run at the same time
const job = (id: string, user: string, o: any = {}) => ({ id, user_id: user, status: "done", error_code: null, credits_reserved: 191, credits_charged: 191,
  options: { seconds: 4980, count: 5, eta_seconds: 460, lean: true }, created_at: at(0), started_at: at(0), finished_at: at(8), ...o });
const doneEvt = (id: string, timing: any = {}) => ({ name: "clips_done", kind: "feature", user_id: "u1", usd: null, created_at: at(8),
  props: { job: id, asked: 5, clips: 5, timing: { video_s: 4980, clips: 5, eta_s: 460, total_s: 467, fetch_mb: 65.4, lean: { calls: 6, fallback: false }, ...timing } } });
const ev = (name: string, kind: string, user: string, usd: number, min: number, props: any = {}) => ({ name, kind, user_id: user, usd, created_at: at(min), props });

test("a run's cost: proxy by job, Claude by person and time, transcription estimated; margin at the cheapest credit", () => {
  const [r] = clipsRuns([job("a", "u1")], [
    doneEvt("a"),
    ev("youtube_proxy", "vendor", "u1", 0.2, 1, { job: "a", bytes: 31e6, lean: "sound" }), ev("youtube_proxy", "vendor", "u1", 0.21, 4, { job: "a", bytes: 34e6, lean: "stretch" }),
    ev("clips_choose", "claude", "u1", 0.47, 3), ev("clips_frame", "claude", "u1", 0.01, 5),
    ev("clips_choose", "claude", "u2", 9, 3), // someone else's
    ev("clips_choose", "claude", "u1", 9, 30), // the same person, after this run
  ], T + 3600_000);
  assert.equal(r.cost.proxy, 0.41); assert.equal(r.cost.claude, 0.48);
  assert.equal(r.cost.transcribe, Math.round((4980 / 3600) * TRANSCRIBE_USD_PER_HOUR * 100) / 100);
  assert.equal(r.proxy_mb, 65); assert.equal(r.retries, 0); assert.equal(r.lean, true); assert.equal(r.fallback, false);
  const revenue = 191 * credit;
  assert.equal(r.margin, Math.round(((revenue - r.cost.total) / revenue) * 100) / 100);
  assert.ok(r.margin! > 0.4);
});

test("a stream run (Live Clips): transcription is the windows it heard, Claude includes its own calls; a 35-hour stream is not priced as 35 hours of sound", () => {
  // the owner's run of Nov 19 2026: 35 h of stream, 11 windows heard, 140 credits
  const [r] = clipsRuns([job("s", "u1", { options: { seconds: 126420, count: 5, stream: { platform: "twitch" } }, credits_charged: 140, credits_reserved: 140 })], [
    { ...doneEvt("s"), props: { job: "s", asked: 5, clips: 2, stream: true, timing: { video_s: 126420, chat_messages: 374933, heard: 11, clips: 2 } } },
    ...Array.from({ length: 11 }, (_, k) => ev("elevenlabs_scribe", "vendor", "u1", 0.0083, 1 + k * 0.5, { use: "live_clips" })),
    ...Array.from({ length: 11 }, (_, k) => ev("live_clips_verify", "claude", "u1", 0.0147, 1.2 + k * 0.5)),
    ev("live_clips_facecam", "claude", "u1", 0.0003, 7),
    ev("elevenlabs_scribe", "vendor", "u2", 5, 3, { use: "live_clips" }), // someone else's
  ], T + 3600_000);
  assert.equal(r.cost.transcribe, 0.09, "11 windows at Scribe's rate, not 35 hours");
  assert.equal(r.cost.claude, 0.16);
  assert.ok(r.cost.total < 0.3 && r.margin! > 0.8, `margin ${r.margin} on $${r.cost.total}`);
});

test("alerts: our failures, fallbacks, thin margins, slow and stuck runs; never the person's own unusable video", () => {
  const jobs = [
    job("ok", "u1"),
    job("theirs", "u2", { status: "failed", error_code: "link_no_media", credits_charged: 0 }),
    job("ours", "u3", { status: "failed", error_code: "clips_cut_failed", credits_charged: 0 }),
    job("fell", "u4"), job("thin", "u5", { credits_charged: 20 }), job("slow", "u6"),
    job("stuck", "u7", { status: "running", finished_at: null, created_at: at(-40), started_at: at(-40) }),
    job("old", "u8", { status: "failed", error_code: "clips_cut_failed", finished_at: at(-120) }),
  ];
  const events = [doneEvt("ok"), doneEvt("fell", { lean: { calls: 9, fallback: true } }), doneEvt("thin"), doneEvt("slow", { total_s: 1800 }),
    ev("youtube_proxy", "vendor", "u4", 5.3, 2, { job: "fell", bytes: 849e6 })];
  const runs = clipsRuns(jobs, events, T + 10 * 60_000);
  const keys = clipsAlerts(runs, [{ created_at: at(9), props: { fell_back: 2, of: 7, until: at(69) } }], T, {}).map((a) => `${a.key}:${a.job?.slice(0, 5) ?? "-"}`).sort();
  assert.deepEqual(keys, ["clips_failed:ours", "clips_fallback:fell", "clips_lean_paused:-", "clips_margin:fell", "clips_margin:thin", "clips_slow:slow", "clips_stuck:stuck"]);
  assert.equal(runs.find((r) => r.job === "fell")!.retries, 3);
});

test("the day's summary and its email", () => {
  const runs = clipsRuns([job("a", "u1"), job("b", "u2", { status: "failed", error_code: "link_no_media", credits_charged: 0 }), job("c", "u1")],
    [doneEvt("a"), doneEvt("c", { lean: { calls: 8, fallback: true } }), ev("youtube_proxy", "vendor", "u1", 0.4, 1, { job: "a", bytes: 65e6 })], T + 3600_000);
  const s = clipsSummary(runs);
  assert.equal(s.runs, 3); assert.equal(s.done, 2); assert.equal(s.failed_theirs, 1); assert.equal(s.failed_ours, 0);
  assert.equal(s.people, 2); assert.equal(s.lean, 2); assert.equal(s.fallbacks, 1); assert.equal(s.retries, 2); assert.equal(s.clips, 10);
  assert.equal(s.codes.link_no_media, 1); assert.equal(s.eta_error_pct_median, 2);
  const m = digestText(s, runs, 24);
  assert.match(m.subject, /^Clips daily: 2\/3 done, margin \d+ %, 1 fallback$/);
  assert.match(m.text, /1 fell back to the whole download; 2 stretch retries/);
  assert.match(m.text, /link_no_media ×1/);
});

test("the digest is due from 07:00 Pacific, once per Pacific day", () => {
  assert.deepEqual(digestDue(Date.parse("2026-11-17T14:59:00Z")), { due: false, day: "2026-11-17" }); // 06:59 PST
  assert.deepEqual(digestDue(Date.parse("2026-11-17T15:00:00Z")), { due: true, day: "2026-11-17" });  // 07:00 PST
  assert.deepEqual(digestDue(Date.parse("2026-11-18T07:30:00Z")), { due: true, day: "2026-11-17" });  // 23:30 PST
});
