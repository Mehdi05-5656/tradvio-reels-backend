// A part of a stream with no chat kept (Nov 25 2026): a new Starter customer's first run, the first 2 hours of a 13-hour
// Kick stream whose replay holds no chat before hour 10, stopped at "chat too quiet" although the hearing needs no chat.
// Now: a part (or a whole short stream with no chat at all) is heard whole; the quote says so before anyone pays; what
// still cannot run says why and what will.
import test from "node:test";
import assert from "node:assert/strict";
import { kickChatProbe, resetKickPace, type ChatMsg } from "../src/live-sources.js";
import { listenOnly, quietChatWords, quoteStreamClips, resetBrief, runStreamClipsJob } from "../src/studio-live-clips.js";
import { linesFromWords } from "../src/studio-clips.js";
import { PLANS } from "../src/studio.js";

const ENV = { STUDIO_LIVE_CLIPS_ENABLED: "true", STUDIO_LIVE_CLIPS_OPEN: "true", ANTHROPIC_API_KEY: "k", ELEVENLABS_API_KEY: "k", TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "sec" };
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START = "2026-11-24T20:21:29.000Z", SECONDS = 47814, CHAT_FROM = 36000; // the stream of Nov 25: chat only from hour 10

function fakeSb() {
  const calls: any[] = []; const updates: any[] = [];
  const sb: any = {
    rpc: async (fn: string, args: any) => { calls.push([fn, args]); if (fn === "studio_renew") return { data: true, error: null }; if (fn === "studio_complete") return { data: { id: args.p_job }, error: null }; return { data: null, error: null }; },
    from: () => ({ update: (f: any) => ({ eq: () => ({ eq: async () => { updates.push(f); return { error: null }; } }) }) }),
  };
  return { sb, calls, updates };
}
const mk = (from: number, n = 48) => { const w: any[] = []; let t = from; for (let i = 0; i < n; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
const graded = (input: any) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: input.lines[0].i, end_line: input.lines[Math.min(input.lines.length - 1, 7)].i, title: "T", hook: "", hook_line: "", caption: "", why: "", why_not: "", tags: [] });
const job = (part: any, seconds = SECONDS): any => ({ id: "job-q", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 200, attempts: 3, progress: {},
  options: { platform: "kick", url: "https://kick.com/cgeezy/videos/227bf0a5-dcbf-402f-a152-f98007b0bc2a", stream: { platform: "kick", vod_id: "227bf0a5-dcbf-402f-a152-f98007b0bc2a", login: "cgeezy", channel_id: "1114244", started_at: START, strictness: "best" }, ...(part ? { part } : {}), source: { title: "Day In The Life", channel: "cgeezy" }, seconds, count: 2, length: "short", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" } });
function runDeps(chat: ChatMsg[], extra: any = {}) {
  const heads: string[] = []; const cuts: any[] = []; const hourSecs: number[] = []; const logs: string[] = [];
  const deps: any = { env: ENV, log: (l: string) => logs.push(l), plans: PLANS, drawtext: true, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), stills: async () => [],
    fetchWindow: async () => undefined, fetchStretch: async () => undefined, chat: async () => chat,
    hear: async () => { const w = mk(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    hearHour: async (_f: string, sec: number) => { hourSecs.push(sec); return { words: [...mk(1580)], events: [], language: "en" }; },
    pick: async (ls: any[]) => { const s = ls.find((l) => l.start >= 1580); const e = [...ls].reverse().find((l) => l.end <= 1610); return s && e ? [{ start_line: s.i, end_line: e.i, title: "Heard", hook: "so", why: "talk", score: 70, tags: [] }] : []; },
    verify: async (i: any) => { heads.push(i.head); return graded(i); }, cut: async (_c: any, m: any) => { cuts.push(m); return { asset_id: "c", bytes: 1, seconds: m.end - m.start }; }, ...extra };
  return { deps, heads, cuts, hourSecs, logs };
}

test("a part with no chat kept is clipped by listening to it, and the checker is told there is no chat to weigh", async () => {
  const r = runDeps([]);
  const out = await runStreamClipsJob(fakeSb().sb, r.deps, job({ from: 0, to: 7200, scope: "range" }));
  assert.equal(out, "done", "the run of Nov 25 2026 would now make clips");
  assert.deepEqual(r.hourSecs, [3600, 3600], "both hours of the part heard whole");
  assert.ok(r.cuts.length >= 1 && r.cuts.every((m) => m.start >= 0 && m.end <= 7200), `clips from the part: ${r.cuts.map((m) => Math.round(m.start))}`);
  assert.ok(r.heads.length && r.heads.every((h) => /No chat is available for this part/.test(h)), "the checker does not mark moments down for a silent chat");
  assert.ok(r.logs.some((l) => l.startsWith("[live] listening only")));
});

test("a part with a thin chat (under the floor) is heard too; nothing heard worth a clip says what happened", async () => {
  const thin: ChatMsg[] = Array.from({ length: 60 }, (_, k) => ({ t: k * 100, u: `u${k}`, c: "hi", e: 0 }));
  const r = runDeps(thin);
  assert.equal(await runStreamClipsJob(fakeSb().sb, r.deps, job({ from: 0, to: 7200, scope: "range" })), "done");
  const f = fakeSb();
  const none = runDeps([], { pick: async () => [] });
  assert.equal(await runStreamClipsJob(f.sb, none.deps, job({ from: 0, to: 7200, scope: "range" })), "clips_none_found");
  assert.ok(!f.calls.some(([fn]: any) => fn === "studio_complete"), "nothing charged");
});

test("a whole stream short enough to hear, with no chat kept at all, is heard whole", async () => {
  const r = runDeps([]);
  assert.equal(await runStreamClipsJob(fakeSb().sb, r.deps, job(null, 3 * 3600)), "done");
  assert.equal(r.hourSecs.length, 3, "every hour of a 3-hour stream heard");
});

test("what cannot be heard whole still stops, and says why and what will work", async () => {
  const f = fakeSb();
  const r = runDeps([], { hearHour: async () => { throw new Error("must not read"); } });
  assert.equal(await runStreamClipsJob(f.sb, r.deps, job({ from: 0, to: 36000, scope: "range" })), "chat_too_quiet", "10 hours is past what a run hears");
  const said = JSON.stringify(f.updates);
  assert.match(said, /Kick (has no chat saved|has not made the chat) for that part of the stream/); assert.match(said, /Pick a part of up to 6 hours/);
  // the whole 13-hour stream with chat only at its end: where the chat is
  // the whole 13-hour stream with chat only at its end: where the chat is, and, an hour after it ended, that Kick has not
  // filled the rest in yet (it did ~2 hours after the stream ended); a day later, that there is none
  const ended = Date.parse(START) + SECONDS * 1000;
  const soon = quietChatWords({ platform: "kick", seconds: SECONDS, started_at: START }, null, [{ t: CHAT_FROM }, { t: 47800 }], 0.4, ENV, ended + 3600_000);
  assert.match(soon, /Kick has not made the chat for most of this stream available yet \(it can take a few hours after a stream ends\) \(its chat runs only from 10:00 to 13:16 into the stream so far\)/);
  const later = quietChatWords({ platform: "kick", seconds: SECONDS, started_at: START }, null, [], 0, ENV, ended + 48 * 3600_000);
  assert.match(later, /^Kick has no chat saved for this stream, and Live Clips follows the chat/);
  assert.match(quietChatWords({ platform: "twitch", seconds: 3600, started_at: START }, null, [], 0, ENV, ended), /^Twitch has no chat saved/, "only Kick fills in late");
  // the hearing switched off: no promise of listening
  const off = fakeSb();
  assert.equal(await runStreamClipsJob(off.sb, { ...r.deps, env: { ...ENV, STUDIO_LIVE_HYBRID: "off" } }, job({ from: 0, to: 7200, scope: "range" })), "chat_too_quiet");
  assert.doesNotMatch(JSON.stringify(off.updates), /Pick a part/);
});

test("listenOnly: parts up to the hearing's hours; whole streams only with no chat at all; a busy chat never", () => {
  assert.deepEqual(listenOnly(0, 0, { from: 0, to: 7200 }, SECONDS, ENV), { from: 0, to: 7200 });
  assert.deepEqual(listenOnly(8, 900, { from: 0, to: 7200 }, SECONDS, ENV), { from: 0, to: 7200 }, "a thin chat in a part");
  assert.equal(listenOnly(20, 900, { from: 0, to: 7200 }, SECONDS, ENV), null, "over the floor: the chat leads as always");
  assert.equal(listenOnly(0, 0, { from: 0, to: 6 * 3600 + 61 }, SECONDS, ENV), null, "longer than the hearing reaches");
  assert.equal(listenOnly(0, 0, { from: 0, to: 300 }, SECONDS, ENV), null, "shorter than an hour's least hearing");
  assert.deepEqual(listenOnly(0, 0, null, 3 * 3600, ENV), { from: 0, to: 10800 });
  assert.equal(listenOnly(1.7, 100, null, 3600, ENV), null, "a whole stream with a thin chat keeps its old answer");
  assert.equal(listenOnly(0, 0, null, SECONDS, ENV), null, "a whole 13-hour stream is too long to hear");
  assert.deepEqual(listenOnly(0, 0, { from: 0, to: 7200 }, SECONDS, { ...ENV, STUDIO_LIVE_QUIET: "off" }), { from: 0, to: 7200 });
  assert.equal(listenOnly(0, 0, { from: 0, to: 3 * 3600 }, SECONDS, { ...ENV, STUDIO_LIVE_QUIET: "off" }), null, "without the quiet rule: the hybrid's 2 hours");
});

// Kick, faked: the channel, its listing, the recording, and a chat replay that holds messages only from hour 10
const ok = (body: unknown) => ({ code: 0, so: `${JSON.stringify(body)}\n200`, se: "" });
function kickFake() {
  const t0 = Date.parse(START); const paths: string[] = [];
  const kickCurl = async (path: string) => {
    paths.push(path);
    if (path.startsWith("api/v1/video/")) return ok({ source: "https://x/master.m3u8", livestream: { id: 1, start_time: "2026-11-24 20:21:29" } });
    if (path === "api/v2/channels/cgeezy") return ok({ id: 1114244, slug: "cgeezy", user: { username: "cgeezy" }, chatroom: { id: 1107321 } });
    if (path === "api/v2/channels/cgeezy/videos") return ok([{ video: { uuid: "227bf0a5-dcbf-402f-a152-f98007b0bc2a" }, duration: SECONDS * 1000, session_title: "Day In The Life", start_time: "2026-11-24 20:21:29", views: 10 }]);
    const m = /^api\/v2\/channels\/1114244\/messages\?cursor=(\d+)$/.exec(path);
    if (m) {
      const at = Math.min(SECONDS, (Number(m[1]) / 1000 - t0) / 1000);
      const msgs = at <= CHAT_FROM ? [] : Array.from({ length: 25 }, (_, k) => ({ id: `m${at}-${k}`, created_at: new Date(t0 + (at - 1 - k * 4) * 1000).toISOString(), content: "W", sender: { id: `u${k}` } }));
      return ok({ data: { messages: msgs, cursor: null } });
    }
    return { code: 0, so: "{}\n404", se: "" };
  };
  return { kickCurl, paths, sleep: async () => undefined };
}

test("Kick's chat probe: one call at the part's end, a second at its middle only when the first saw none inside", async () => {
  resetKickPace();
  const k = kickFake();
  assert.equal(await kickChatProbe(k as any, "1114244", START, 0, 7200), 0);
  assert.equal(k.paths.length, 2);
  assert.ok((await kickChatProbe(k as any, "1114244", START, CHAT_FROM, SECONDS))! > 0);
  assert.equal(k.paths.length, 3, "chat found on the first call");
  assert.equal(await kickChatProbe(k as any, "1114244", "not a date", 0, 7200), null);
});

test("the quote says, before anyone pays, that a part has no chat kept and that it will be heard instead", async () => {
  resetKickPace(); resetBrief();
  const k = kickFake();
  const url = "https://kick.com/cgeezy/videos/227bf0a5-dcbf-402f-a152-f98007b0bc2a";
  const soon = () => Date.parse(START) + SECONDS * 1000 + 3600_000; // an hour after the stream ended, as on Nov 25
  const first2 = await quoteStreamClips({ env: ENV, now: soon, ...k } as any, PLANS, { url, scope: "range", from: 0, to: 7200, count: 7, length: "short" });
  assert.match(String(first2.options.warning), /Kick has not made the chat for this part of the stream available yet \(it can take a few hours after a stream ends\), so we'll find its moments by listening to every word/);
  assert.equal(first2.options.chat_kept, false);
  const ten = await quoteStreamClips({ env: ENV, now: () => Date.parse(START) + 72 * 3600_000, ...k } as any, PLANS, { url, scope: "range", from: 0, to: 36000, count: 7, length: "short" });
  assert.match(String(ten.options.warning), /Kick has no chat saved for this part of the stream\. Pick a part of up to 6 hours/);
  const late = await quoteStreamClips({ env: ENV, ...k } as any, PLANS, { url, scope: "range", from: CHAT_FROM, to: CHAT_FROM + 7200, count: 3, length: "short" });
  assert.equal(late.options.chat_kept, true); assert.doesNotMatch(String(late.options.warning ?? ""), /chat/);
  const calls = k.paths.length;
  await quoteStreamClips({ env: ENV, ...k } as any, PLANS, { url, scope: "range", from: 0, to: 7200, count: 5, length: "short" });
  assert.equal(k.paths.filter((p) => p.includes("/messages")).length, k.paths.slice(0, calls).filter((p) => p.includes("/messages")).length, "the same part asked again is remembered, not probed again");
});

test("a moment check that fails is not a verdict: it does not count, and a run where no check worked says it was our side (Nov 26 2026)", async () => {
  // every check refused (the broken-emoji request): no clip, the run says so honestly, nothing is charged
  const f = fakeSb();
  const r = runDeps([], { verify: async () => { throw new Error("Claude 400: The request body is not valid JSON: unexpected end of hex escape"); } });
  assert.equal(await runStreamClipsJob(f.sb, r.deps, job({ from: 0, to: 7200, scope: "range" })), "clips_check_failed");
  const said = JSON.stringify(f.updates);
  assert.match(said, /could not check this stream's moments this time; that was on our side/);
  assert.doesNotMatch(said, /stands alone/, "the stream is not blamed");
  assert.ok(!f.calls.some(([fn]: any) => fn === "studio_complete"));
  // one check fails, the next works: the run goes on and makes its clip
  let n = 0;
  const g = runDeps([], { verify: async (i: any) => { if (n++ === 0) throw new Error("Claude 529 overloaded"); return graded(i); } });
  assert.equal(await runStreamClipsJob(fakeSb().sb, g.deps, job({ from: 0, to: 7200, scope: "range" })), "done");
  assert.ok(g.cuts.length >= 1);
});

test("a run handed back (a deploy, a lost lease) cuts the moments it chose before: no second chat read or checks, no clip twice", async () => {
  const { ClipsError } = await import("../src/studio-clips.js");
  const store = new Map<string, string>();
  const withStore = () => { const f = fakeSb(); f.sb.storage = { from: () => ({
    upload: async (k: string, buf: Buffer) => { store.set(k, buf.toString()); return { error: null }; },
    download: async (k: string) => (store.has(k) ? { data: new Blob([store.get(k)!]), error: null } : { data: null, error: { message: "not found" } }) }) }; return f; };
  let chatReads = 0, checks = 0; const cut1: any[] = [], cut2: any[] = [];
  const first = runDeps([], { chat: async () => { chatReads++; return []; }, verify: async (i: any) => { checks++; return graded(i); },
    cut: async (_c: any, m: any) => { if (cut1.length >= 1) throw new ClipsError("lease_lost", "lease lost"); cut1.push(m); return { asset_id: `a${m.rank}`, bytes: 1, seconds: m.end - m.start }; } });
  const j = job({ from: 0, to: 7200, scope: "range" });
  j.options.count = 2;
  assert.equal(await runStreamClipsJob(withStore().sb, first.deps, j), "lease_lost");
  assert.equal(cut1.length, 1); const readsBefore = chatReads, checksBefore = checks;
  assert.ok(store.size === 1, "the choice was kept");
  // the next attempt: the same job, with what the first one made in its progress
  const again = { ...j, progress: { made: [{ rank: cut1[0].rank, asset_id: "a1", seconds: 30 }] } };
  const second = runDeps([], { chat: async () => { chatReads++; return []; }, verify: async (i: any) => { checks++; return graded(i); },
    cut: async (_c: any, m: any) => { cut2.push(m); return { asset_id: `b${m.rank}`, bytes: 1, seconds: m.end - m.start }; } });
  assert.equal(await runStreamClipsJob(withStore().sb, second.deps, again), "done");
  assert.equal(chatReads, readsBefore, "the chat is not read again"); assert.equal(checks, checksBefore, "no moment is checked again");
  assert.ok(cut2.every((m) => m.rank !== cut1[0].rank), "the clip already made is not cut twice");
  assert.ok(second.logs.some((l) => l.startsWith("[live] resumed")));
  // another job's plan is never taken
  const other = runDeps([], { chat: async () => { chatReads++; return []; } });
  await runStreamClipsJob(withStore().sb, other.deps, { ...j, id: "job-other" });
  assert.equal(chatReads, readsBefore + 1, "a different job reads its own chat");
});
