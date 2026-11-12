// The report must never hold the server: on Nov 12 2026 the warmer's 30-day report froze every request for 16 to 22
// seconds, every eight minutes (12 s of computing on a laptop at this size). These tests build the report at
// production size (about 122,000 readings for 30 days, 20 accounts) and check the time, the pauses and the output.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildReport, buildReportYielding, resolveRange } from "../src/reporting.js";
import { ptNow, ptDateTimeToUtc } from "../src/publer-schedule.js";

function synth(days: number, perDayPubler = 3400, liveTotal30 = 19875, logs30 = 4649) {
  const slots = Array.from({ length: 20 }, (_, i) => ({ phone_slot: `slot${i}`, handle: `h${i}`, provider: i % 2 ? "tiktok" : "instagram", paused: false, daily_target: 8 }));
  const end = Date.parse("2026-11-12T08:00:00Z"), start = end - days * 86400000;
  const nPosts = Math.round(4138 * Math.min(1, days / 7) + (days > 7 ? (days - 7) * 150 : 0));
  const posts = Array.from({ length: nPosts }, (_, i) => ({ slot: `slot${i % 20}`, id: `p${i}`, ig: i % 2 === 0, at: start + ((i * 7919) % (days * 86400)) * 1000, code: `C${i.toString(36)}x` }));
  const link = (p: any) => (p.ig ? `https://www.instagram.com/reel/${p.code}/` : `https://www.tiktok.com/@u/video/${700000000000 + Number(p.id.slice(1))}`);
  const snapshots: any[] = [], nPub = perDayPubler * days;
  for (let i = 0; i < nPub; i++) { const p = posts[(i * 31) % nPosts]; const t = start + ((i * 104729) % (days * 86400)) * 1000;
    snapshots.push({ id: i + 1, phone_slot: p.slot, publer_post_id: p.id, captured_at: new Date(t).toISOString().replace("Z", "+00:00"), video_views: 100 + (i % 977) * 3, likes: i % 50, reach: i % 400, saves: i % 7, shares: i % 5, comments: i % 9,
      raw: { id: p.id, text: "caption ".repeat(8), old_id: `old${p.id}`, post_link: link(p), thumbnail: "https://cdn.publer.com/x/y/z/small.jpg", published_at: null, scheduled_at: new Date(p.at).toISOString() } }); }
  const live: any[] = [], nLive = Math.round(liveTotal30 * days / 30);
  for (let i = 0; i < nLive; i++) { const p = posts[(i * 17) % nPosts]; const t = start + ((i * 15485863) % (days * 86400)) * 1000;
    live.push({ id: i + 1, phone_slot: p.slot, provider: p.ig ? "instagram" : "tiktok", platform_post_id: p.ig ? p.code : String(700000000000 + Number(p.id.slice(1))), publer_post_id: p.id, post_link: link(p), posted_at: new Date(p.at).toISOString(), captured_at: new Date(t).toISOString(), video_views: 200 + (i % 613) * 5, likes: i % 60, comments: i % 8, saves: null, shares: null, caption: "caption ".repeat(8) }); }
  const ymd = (ms: number) => new Date(ms - 8 * 3600000).toISOString().slice(0, 10);
  const logs: any[] = [], nLogs = Math.round(logs30 * days / 30);
  for (let i = 0; i < nLogs; i++) { const p = posts[i % nPosts]; logs.push({ id: i + 1, phone_slot: p.slot, queue_id: `q${i}`, slot_local_date: ymd(p.at), slot_index: i % 8, status: i % 11 === 0 ? "failed" : "published", planned_at: new Date(p.at).toISOString(), attempted_at: new Date(p.at).toISOString(), updated_at: new Date(p.at + 60000).toISOString(), publer_post_id: p.id, publer_post_link: link(p), caption_used: "caption", error: null }); }
  const from = ymd(start + 86400000), to = ymd(end);
  const liveAccounts = slots.map((s) => ({ phone_slot: s.phone_slot, username: s.handle, last_pulled_at: new Date(end).toISOString(), last_status: "ok" }));
  return { slots, logs, snapshots, live, liveAccounts, from, to, now: new Date(end) };
}
const hash = (r: any) => createHash("sha256").update(JSON.stringify({ ...r, checked_at: "x" })).digest("hex");

test("Pacific time: the shared formatters give what a fresh formatter gives, across both clock changes", () => {
  const fresh = (d: Date) => { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d); const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"; return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`; };
  // every 37 minutes through the March and November 2026 changes, and a spread over the year
  const times: number[] = [];
  for (const day of ["2026-03-07", "2026-10-31", "2026-11-11"]) for (let m = 0; m < 3 * 24 * 60; m += 37) times.push(Date.parse(day + "T00:00:00Z") + m * 60000);
  for (let i = 0; i < 400; i++) times.push(Date.parse("2026-01-01T00:00:00Z") + i * 79_000_000);
  for (const t of times) { const p = ptNow(new Date(t)); assert.equal(`${p.ymd} ${p.hhmm}`, fresh(new Date(t)), new Date(t).toISOString()); }
  for (const [ymd, hhmm, utc] of [["2026-07-01", "08:00", "2026-07-01T15:00:00.000Z"], ["2026-12-01", "08:00", "2026-12-01T16:00:00.000Z"], ["2026-11-01", "00:00", "2026-11-01T07:00:00.000Z"], ["2026-11-02", "00:00", "2026-11-02T08:00:00.000Z"], ["2026-03-08", "03:00", "2026-03-08T10:00:00.000Z"]])
    assert.equal(ptDateTimeToUtc(ymd, hhmm).toISOString(), utc, `${ymd} ${hhmm}`);
  const t0 = performance.now(); for (let i = 0; i < 20000; i++) ptNow(new Date(times[i % times.length])); const ms = performance.now() - t0;
  assert.ok(ms < 400, `20,000 Pacific-time lookups took ${Math.round(ms)} ms (they took about 800 when a formatter was built for each)`);
});

test("a 30-day report of every account is built in about a second, not twelve", () => {
  const d = synth(30), range = resolveRange({ from: d.from, to: d.to }, d.now);
  assert.ok(d.snapshots.length + d.live.length > 120_000);
  const t0 = performance.now(); const r: any = buildReport(d.slots, d.logs, d.snapshots, range, d.live, d.liveAccounts, d.now); const ms = performance.now() - t0;
  assert.ok(r.posts.length > 5000 && r.series.length === 30 && r.coverage.snapshots > 100_000);
  assert.ok(ms < 4000, `the build took ${Math.round(ms)} ms`);
});

test("built in slices, the report is the same and nobody waits: a heartbeat keeps beating while it is built", async () => {
  for (const days of [1, 7, 30]) {
    const d = synth(days), range = resolveRange({ from: d.from, to: d.to }, d.now);
    const whole = buildReport(d.slots, d.logs, d.snapshots, range, d.live, d.liveAccounts, d.now);
    // a 5 ms heartbeat stands for the requests waiting on the server: its longest gap is the longest anyone waits
    let last = performance.now(), worst = 0, beats = 0; const beat = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; beats++; }, 5);
    const stats = { longest_ms: 0, work_ms: 0, pauses: 0 };
    const sliced = await buildReportYielding([d.slots, d.logs, d.snapshots, range, d.live, d.liveAccounts, d.now], 12, stats);
    clearInterval(beat);
    assert.equal(hash(sliced), hash(whole), `${days} days: the same report either way`);
    if (days === 30) {
      assert.ok(stats.pauses >= 10, `paused ${stats.pauses} times`);
      assert.ok(beats >= 10, `the heartbeat fired ${beats} times during the build`);
      assert.ok(stats.longest_ms < 400 && worst < 400, `longest stretch without a pause ${Math.round(stats.longest_ms)} ms, longest wait ${Math.round(worst)} ms`);
    }
  }
});

test("an empty report and a report with no readings still come out, either way", async () => {
  const range = resolveRange({ from: "2026-11-01", to: "2026-11-07" }, new Date("2026-11-12T08:00:00Z"));
  const a: any = buildReport([], [], [], range), b: any = await buildReportYielding([[], [], [], range]);
  assert.deepEqual([a.posts.length, a.series.length, a.totals.accounts], [0, 7, 0]);
  assert.equal(hash(a), hash(b));
});
