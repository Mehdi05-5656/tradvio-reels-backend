import test from "node:test";
import assert from "node:assert/strict";
import { parseStreamLink, parseMaster, pickRungs, nicheOf, twitchBroadcasts, twitchTopStreams, resetTwitchToken, type ChatMsg } from "../src/live-sources.js";
import { checklistScore, OVERSHOOT, chatSignals, chatCandidates, robustZ, firstCut, streamPrice, streamAnalysisUsd, streamClipUsd, quoteStreamClips, runStreamClipsJob, attributionFilter, streamerPermission, LIVE_RATES, LIVE_LIMITS, likelyStreamClips, streamCountCap, liveClipsEnabled, liveClipsOpen, VERIFY_BAR } from "../src/studio-live-clips.js";
import { linesFromWords, CLIP_LENGTHS, type Line } from "../src/studio-clips.js";
import { creditValueFloor } from "../src/studio-pricing.js";
import { PLANS } from "../src/studio.js";

const ENV = { STUDIO_LIVE_CLIPS_ENABLED: "true", STUDIO_LIVE_CLIPS_OPEN: "true", ANTHROPIC_API_KEY: "k", ELEVENLABS_API_KEY: "k", TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "sec" };
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("stream links: channels and past broadcasts on Twitch and Kick, nothing else", () => {
  assert.deepEqual(parseStreamLink("https://www.twitch.tv/videos/2932003293"), { platform: "twitch", kind: "vod", login: null, id: "2932003293", url: "https://www.twitch.tv/videos/2932003293" });
  assert.equal(parseStreamLink("https://m.twitch.tv/CaseOh_")?.login, "caseoh_");
  assert.equal(parseStreamLink("https://twitch.tv/caseoh_/video/2932003293")?.id, "2932003293");
  assert.equal(parseStreamLink("https://www.twitch.tv/directory/category/gta"), null);
  assert.deepEqual(parseStreamLink("https://kick.com/xqc/videos/716d63b6-afa9-4afd-a1a6-d9aedf3e3a23"), { platform: "kick", kind: "vod", login: "xqc", id: "716d63b6-afa9-4afd-a1a6-d9aedf3e3a23", url: "https://kick.com/xqc/videos/716d63b6-afa9-4afd-a1a6-d9aedf3e3a23" });
  assert.equal(parseStreamLink("https://kick.com/xqc")?.kind, "channel");
  assert.equal(parseStreamLink("https://kick.com/browse"), null);
  assert.equal(parseStreamLink("https://www.youtube.com/watch?v=abc"), null);
  assert.equal(parseStreamLink("not a link"), null);
});

test("an HLS master playlist gives its rungs, smallest first; the cut rung is the biggest at or under 720", () => {
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9072504,RESOLUTION=1920x1080\n1080p60/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160\n160p/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3423000,RESOLUTION=1280x720\n720p60/playlist.m3u8\n`;
  const vs = parseMaster(master, "https://stream.kick.com/abc/master.m3u8");
  assert.deepEqual(vs.map((v) => v.height), [160, 720, 1080]);
  assert.equal(vs[0].url, "https://stream.kick.com/abc/160p/playlist.m3u8");
  const r = pickRungs(vs);
  assert.equal(r.audio, vs[0].url); assert.equal(r.video, vs[1].url);
  assert.equal(parseMaster("#EXTM3U\n#EXTINF:10,\nseg1.ts\n", "https://x/y.m3u8")[0].url, "https://x/y.m3u8");
  assert.equal(nicheOf("Grand Theft Auto VI (GTA)"), "gta"); assert.equal(nicheOf("Just Chatting"), "chatting"); assert.equal(nicheOf("Fortnite"), "shooters"); assert.equal(nicheOf("Chess"), "games");
});

/** A chat that hums at a steady pace, with a burst of all-caps laughter at one moment. */
function chatWith(burstAt: number, seconds = 1800, perSec = 2): ChatMsg[] {
  const out: ChatMsg[] = [];
  let n = 0;
  for (let t = 0; t < seconds; t++) for (let k = 0; k < perSec; k++) out.push({ t, u: `u${(n++ % 300)}`, c: ["nice", "what game is this", "hello", "gg ez", "lol"][n % 5], e: 0 });
  for (let t = burstAt; t < burstAt + 12; t++) for (let k = 0; k < 9; k++) out.push({ t, u: `b${n++ % 500}`, c: ["LMAOOO", "NO WAY", "WHAT", "KEKW", "HAHAHAHA", "😂😂😂"][k % 6], e: k % 3 === 0 ? 1 : 0 });
  return out;
}
test("the chat's content against its own baseline finds the burst, puts the event 8 s before its onset and merges neighbours", () => {
  const msgs = chatWith(900);
  const s = chatSignals(msgs, 1800);
  assert.equal(s.bins, 181); assert.ok(s.perMinute > 100);
  const z = robustZ(s.caps);
  assert.ok(z[90] >= 3, `caps z at the burst: ${z[90]}`); assert.ok(Math.abs(z[60]) < 2);
  const cands = chatCandidates(s, msgs);
  assert.ok(cands.length >= 1 && cands.length <= 3, `candidates: ${cands.length}`);
  assert.equal(cands[0].onset, 900); assert.equal(cands[0].t_event, 892); assert.equal(cands[0].rank, 1);
  assert.ok(cands[0].score >= 6); assert.ok(cands[0].sample.some((x) => /LMAO|NO WAY|KEKW/.test(x)));
  // the same burst twice within 90 s is one candidate
  const twice = [...chatWith(900), ...chatWith(960).filter((m) => m.t >= 960 && m.t < 972 && /[A-Z]{4}/.test(m.c))];
  const c2 = chatCandidates(chatSignals(twice, 1800), twice);
  assert.equal(c2.filter((c) => c.onset >= 880 && c.onset <= 1000).length, 1);
  // phase A (research/viral-signals.md): the people and the shape behind a burst are counted
  assert.ok(s.reactors[90] >= 50, `reacting users at the burst: ${s.reactors[90]}`); assert.ok(s.reactors[60] < s.reactors[90] / 3);
  assert.ok(s.len[90] < s.len[60], "messages get shorter in a burst"); assert.ok(s.alike[90] > 0 && s.alike[90] <= 1);
  // one user shouting alone is not a burst: the spam rule weighs it down
  const one: ChatMsg[] = [...chatWith(0, 1800, 1)]; for (let t = 900; t < 912; t++) for (let k = 0; k < 9; k++) one.push({ t, u: "spammer", c: "LMAOOO NO WAY", e: 0 });
  const s1 = chatSignals(one, 1800); assert.ok(s1.topShare[90] > 0.3);
  assert.equal(chatCandidates(s1, one).filter((c) => c.onset >= 880 && c.onset <= 1000).length, 0, "a lone spammer makes no candidate");
  // a wave that never stops is several moments, not one (KaiCenat's chat, Nov 18 2026: one candidate spanned 42 minutes)
  const wave: ChatMsg[] = [...chatWith(0, 1800, 1)]; for (let t = 600; t < 1200; t++) for (let k = 0; k < 6; k++) wave.push({ t, u: `w${(t * 7 + k) % 400}`, c: ["LMAOOO", "NO WAY", "KEKW", "W"][k % 4], e: 0 });
  const cw = chatCandidates(chatSignals(wave, 1800), wave);
  assert.ok(cw.length >= 2, `a ten-minute wave gives several candidates, until it becomes the chat's own baseline: ${cw.length}`); assert.ok(cw.every((c) => c.last - c.onset <= 180));
  // the first and last minutes are never candidates
  const edge = [...chatWith(60, 1800), ...chatWith(1740, 1800).filter((m) => m.t >= 1740)];
  assert.ok(chatCandidates(chatSignals(edge, 1800), edge).every((c) => c.onset >= 180 && c.onset <= 1680));
});

test("the first cut starts on a thought 5-20 s before the event and ends on a thought once the chat falls, 20-55 s", () => {
  const words: Array<{ text: string; start: number; end: number; speaker: string | null }> = [];
  let t = 0;
  for (let i = 0; i < 130; i++) { words.push({ text: i % 6 === 5 ? "done." : "word", start: t, end: t + 0.4, speaker: "S1" }); t += i % 6 === 5 ? 1.2 : 0.5; }
  const lines: Line[] = linesFromWords(words);
  const rate = (rel: number) => (rel >= 53 && rel < 65 ? 40 : 10);
  const cut = firstCut(lines, 45, 58, rate, 10, []);
  const start = lines[cut.s].start, end = lines[cut.e].end;
  assert.ok(start <= 45 - 5 && start >= 45 - 20 - 3, `start ${start}`);
  assert.ok(end >= 58 + 3, `end ${end}`);
  assert.ok(end - start >= 20 && end - start <= 55, `length ${end - start}`);
  assert.ok(lines[cut.s].opens && lines[cut.e].closes);
});

test("prices: reading by the hour with a minimum, clips at Clips' price, both over the safety margins at the floor", () => {
  const floor = creditValueFloor(PLANS);
  const p1 = streamPrice(PLANS, { seconds: 3600, length: "standard", env: ENV });
  assert.equal(p1.analysis, LIVE_RATES.min); assert.equal(p1.per_clip, 10);
  const p4 = streamPrice(PLANS, { seconds: 4 * 3600, length: "standard", env: ENV });
  assert.equal(p4.analysis, 60);
  assert.ok(p4.analysis * floor * (1 - 0.35) >= streamAnalysisUsd(4 * 3600), "reading keeps 35 % at the floor");
  assert.ok(p4.per_clip * floor * 0.5 >= streamClipUsd("standard", ENV), "a clip keeps 50 % at the floor");
  assert.equal(streamPrice(PLANS, { seconds: 7200, length: "long", env: ENV }).per_clip, 12);
  // the reading is charged for the first 8 hours only (our cost of reading is capped by the checks), so a 20-hour
  // broadcast reads for the same 120 credits as an 8-hour one
  assert.equal(streamPrice(PLANS, { seconds: 20 * 3600, length: "standard", env: ENV }).analysis, streamPrice(PLANS, { seconds: 8 * 3600, length: "standard", env: ENV }).analysis);
  assert.equal(LIVE_LIMITS.max_seconds, 48 * 3600);
  assert.equal(likelyStreamClips(4 * 3600), 14); assert.equal(streamCountCap(600), 5); assert.equal(streamCountCap(10 * 3600), LIVE_LIMITS.max_clips);
  assert.equal(VERIFY_BAR.balanced, 55); assert.equal(VERIFY_BAR.best, 65); assert.equal(VERIFY_BAR.more, 45);
});

test("the registry: campaign streamers, blocked ones (file and environment), everyone else unknown", () => {
  assert.equal(streamerPermission("twitch", "KaiCenat", {}), "campaign");
  assert.equal(streamerPermission("twitch", "qtcinderella", {}), "blocked");
  assert.equal(streamerPermission("twitch", "someone", { STUDIO_LIVE_BLOCK: "twitch:someone, kick:other" }), "blocked");
  assert.equal(streamerPermission("kick", "someone", {}), "unknown");
  assert.match(attributionFilter("caseoh_ on Twitch", {}), /^drawtext=.*text='caseoh_ on Twitch'/);
  assert.ok(!attributionFilter("a:b'c", {}).includes("'c"));
  assert.equal(liveClipsEnabled({}), false); assert.equal(liveClipsOpen({ ...ENV, STUDIO_LIVE_CLIPS_OPEN: undefined }), false); assert.equal(liveClipsOpen(ENV), true);
});

/** A fake Twitch: the token, a user, their broadcasts, one broadcast by id, the top streams. */
function twitchFetch(): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://id.twitch.tv/oauth2/token")) return json({ access_token: "tok", expires_in: 5000 });
    if (!init?.headers?.Authorization) return json({}, 401);
    if (u.includes("/helix/users?login=caseoh_")) return json({ data: [{ id: "123", login: "caseoh_", display_name: "CaseOh_", profile_image_url: "https://p/x.png" }] });
    if (u.includes("/helix/videos?user_id=123")) return json({ data: [{ id: "2932003293", user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", title: "LOSING MY MIND", created_at: "2026-11-18T03:01:21Z", duration: "4h0m43s", view_count: 768287, thumbnail_url: "https://t/%{width}x%{height}.jpg", type: "archive" }, { id: "1", user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", title: "short", created_at: "2026-11-17T03:01:21Z", duration: "5m0s", view_count: 1, thumbnail_url: null, type: "archive" }] });
    if (u.includes("/helix/videos?id=2932003293")) return json({ data: [{ id: "2932003293", user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", title: "LOSING MY MIND", created_at: "2026-11-18T03:01:21Z", duration: "4h0m43s", view_count: 768287, thumbnail_url: null, type: "archive" }] });
    if (u.includes("/helix/videos?id=9999999999")) return json({ data: [] });
    if (u.includes("/helix/streams?")) return json({ data: [{ user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", game_name: "Grand Theft Auto VI", title: "GTA", viewer_count: 90000, started_at: "2026-11-18T20:00:00Z", language: "en", thumbnail_url: "https://t/{width}x{height}.jpg" }] });
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
}

test("Twitch through Helix with an app token: a channel's broadcasts, the top streams", async () => {
  resetTwitchToken();
  const deps = { env: ENV, fetch: twitchFetch() };
  const list = await twitchBroadcasts(deps, "123");
  assert.equal(list.length, 2); assert.equal(list[0].seconds, 14443); assert.equal(list[0].thumbnail_url, "https://t/640x360.jpg"); assert.equal(list[0].url, "https://www.twitch.tv/videos/2932003293");
  const top = await twitchTopStreams(deps);
  assert.equal(top[0].viewers, 90000); assert.equal(top[0].category, "Grand Theft Auto VI");
});

test("a quote for a past broadcast: the reading, the clips, the source the run page shows; gated by the switches", async () => {
  resetTwitchToken();
  const q = await quoteStreamClips({ env: ENV, fetch: twitchFetch() }, PLANS, { url: "https://www.twitch.tv/videos/2932003293", length: "standard", count: 8 }, {});
  assert.equal(q.tool, "clips");
  assert.equal(q.options.stream.platform, "twitch"); assert.equal(q.options.stream.vod_id, "2932003293"); assert.equal(q.options.stream.login, "caseoh_");
  assert.equal(q.options.source.platform, "twitch"); assert.equal(q.options.source.channel, "CaseOh_"); assert.equal(q.options.seconds, 14443);
  assert.equal(q.options.price.analysis, 61); assert.equal(q.options.price.per_clip, 10); assert.equal(q.credits, 61 + 8 * 10);
  assert.equal(q.options.count, 8); assert.equal(q.options.likely, 14); assert.ok(q.options.eta_seconds > 300);
  assert.match(q.summary, /4 h of CaseOh_/);
  // the owner sees it before it opens; customers do not; a channel link asks for a broadcast; a short one is refused
  await assert.rejects(quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_CLIPS_OPEN: undefined }, fetch: twitchFetch() }, PLANS, { url: "https://www.twitch.tv/videos/2932003293" }, {}), /not open/);
  assert.ok(await quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_CLIPS_OPEN: undefined }, fetch: twitchFetch() }, PLANS, { url: "https://www.twitch.tv/videos/2932003293" }, { owner: true }));
  await assert.rejects(quoteStreamClips({ env: ENV, fetch: twitchFetch() }, PLANS, { url: "https://www.twitch.tv/caseoh_" }, {}), (e: any) => e.code === "pick_broadcast");
  await assert.rejects(quoteStreamClips({ env: ENV, fetch: twitchFetch() }, PLANS, { url: "https://www.twitch.tv/videos/9999999999" }, {}), (e: any) => e.code === "link_no_media");
  await assert.rejects(quoteStreamClips({ env: ENV, fetch: twitchFetch() }, PLANS, { url: "https://www.youtube.com/watch?v=abcdefghijk" }, {}), (e: any) => e.code === "unsupported_link");
});

/** A fake database: renew says yes, complete records the charge, the collection update is remembered. */
function fakeSb() {
  const calls: any[] = []; const updates: any[] = [];
  const sb: any = {
    rpc: async (fn: string, args: any) => { calls.push([fn, args]); if (fn === "studio_renew") return { data: true, error: null }; if (fn === "studio_complete") return { data: { id: args.p_job }, error: null }; return { data: null, error: null }; },
    from: () => ({ update: (f: any) => ({ eq: () => ({ eq: async () => { updates.push(f); return { error: null }; } }) }) }),
  };
  return { sb, calls, updates };
}

test("a run: chat read, candidates heard and checked, the kept moment cut and charged; nothing kept = nothing charged", async () => {
  const words = (startRel: number) => { const w = []; let t = startRel; for (let i = 0; i < 40; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
  const msgs = chatWith(900, 3600);
  const { sb, calls, updates } = fakeSb();
  const cutCalls: any[] = []; const verifyInputs: any[] = [];
  const deps: any = { env: ENV, log: () => undefined, plans: PLANS, drawtext: true,
    chat: async () => msgs, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), fetchWindow: async () => undefined, fetchStretch: async () => undefined, stills: async () => [],
    hear: async () => { const w = words(30); return { words: w, events: [{ text: "laughter", start: 52, end: 53.5 }], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (input: any) => { verifyInputs.push(input); const ls = input.lines; return { keep: true, score: 72, standalone: true, start_line: ls[0].i, end_line: ls[Math.min(ls.length - 1, 7)].i, title: "He loses it", hook: "so so so", why: "big laugh", why_not: "", tags: ["gta"] }; },
    cut: async (ctx: any, m: any) => { cutCalls.push([ctx, m]); return { asset_id: "asset-1", bytes: 1000, seconds: m.end - m.start }; } };
  const job: any = { id: "job-1", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 30 + 10 * 3, attempts: 1,
    options: { platform: "twitch", url: "https://www.twitch.tv/videos/2932003293", stream: { platform: "twitch", vod_id: "2932003293", login: "caseoh_", channel_id: "123", started_at: "2026-11-18T03:01:21Z", strictness: "balanced" }, source: { title: "LOSING MY MIND", channel: "CaseOh_" }, seconds: 3600, count: 3, length: "standard", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" }, progress: {} };
  const out = await runStreamClipsJob(sb, deps, job);
  assert.equal(out, "done");
  assert.equal(cutCalls.length, 1);
  const [ctx, m] = cutCalls[0];
  assert.ok(m.start >= 850 && m.start < 900, `the clip starts near the event: ${m.start}`); assert.ok(m.end - m.start >= 17, `length ${m.end - m.start}`);
  assert.equal(m.title, "He loses it"); assert.ok(m.words.length > 0 && m.words[0][1] >= 850);
  assert.equal(ctx.overlay, null, "no burned-in credit on the clip"); assert.equal(ctx.src.offset, Math.max(0, m.start - 2));
  assert.equal(ctx.tall, true, "1080x1920 out"); assert.equal(ctx.limiter, true); assert.match(ctx.framingHint, /IRL stream/);
  assert.match(verifyInputs[0].body, /chat burst begins/); assert.match(verifyInputs[0].head, /CaseOh_ on Twitch/);
  const complete = calls.find((c) => c[0] === "studio_complete");
  assert.equal(complete[1].p_credits_charged, 30 + 10);
  assert.equal(updates.at(-1).status, "ready"); assert.match(updates.at(-1).note, /1 clip stood alone/);
  // nothing kept: the run fails without a charge
  const { sb: sb2, calls: calls2 } = fakeSb();
  const out2 = await runStreamClipsJob(sb2, { ...deps, verify: async () => ({ keep: false, score: 40, standalone: false, start_line: 0, end_line: 0, title: "", hook: "", why: "", why_not: "needs context", tags: [] }) }, { ...job, progress: {} });
  assert.equal(out2, "clips_none_found");
  assert.ok(!calls2.some((c) => c[0] === "studio_complete"));
  // the model's cut past the ceiling is trimmed to the length, its payoff kept, instead of dropped as "too long"
  const long = (startRel: number) => { const w = []; let t = startRel; for (let i = 0; i < 150; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
  const cutCalls4: any[] = [];
  const out4 = await runStreamClipsJob(fakeSb().sb, { ...deps, hear: async () => { const w = long(5); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (input: any) => ({ keep: true, score: 78, standalone: true, start_line: input.lines[0].i, end_line: input.lines[input.lines.length - 1].i, title: "The whole bit", hook: "", why: "", why_not: "", tags: [] }),
    cut: async (ctx: any, m: any) => { cutCalls4.push(m); return { asset_id: "asset-4", bytes: 1000, seconds: m.end - m.start }; } }, { ...job, progress: {} });
  assert.equal(out4, "done"); assert.equal(cutCalls4.length, 1);
  const d4 = cutCalls4[0].end - cutCalls4[0].start;
  assert.ok(d4 >= 18 && d4 <= 55.5, `trimmed to the standard length (18-55 s), not dropped: ${d4}`);
  // the checklist (phase B): the six grades weigh into one score; a hard fail vetoes whatever the grades
  assert.equal(checklistScore({ score: 90, grades: { hook: 8, standalone: 9, payoff: 7, reaction: 6, quotable: 5, length: 8 } }), 70);
  assert.equal(checklistScore({ score: 72 }), 72, "no grades (an older seam): the model's own score");
  assert.equal(OVERSHOOT(3), 2); assert.equal(OVERSHOOT(1), 1);
  const graded = (title: string, extra: any = {}) => (input: any) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: input.lines[0].i, end_line: input.lines[Math.min(input.lines.length - 1, 7)].i, title, hook: "so so", hook_line: "He bet it all", caption: "He bet the whole round on one call.", why: "big", why_not: "", tags: ["gta"], ...extra });
  const cut5: any[] = [];
  const out5 = await runStreamClipsJob(fakeSb().sb, { ...deps, verify: async (i: any) => graded("Fine clip")(i), cut: async (ctx: any, m: any) => { cut5.push(m); return { asset_id: "a5", bytes: 1, seconds: m.end - m.start }; } }, { ...job, progress: {} });
  assert.equal(out5, "done"); assert.equal(cut5[0].score, 73, "the checklist score (72.5 rounded), not the felt 80"); assert.equal(cut5[0].hook_line, "He bet it all"); assert.match(cut5[0].caption, /whole round/); assert.equal(cut5[0].grades.hook, 8);
  const out6 = await runStreamClipsJob(fakeSb().sb, { ...deps, verify: async (i: any) => graded("Music", { hard_fail: "copyrighted music is the main sound" })(i) }, { ...job, progress: {} });
  assert.equal(out6, "clips_none_found", "a hard fail vetoes a well-graded moment");
  const out7 = await runStreamClipsJob(fakeSb().sb, { ...deps, verify: async (i: any) => graded("Needs it", { grades: { hook: 9, standalone: 4, payoff: 9, reaction: 9, quotable: 9, length: 9 } })(i) }, { ...job, progress: {} });
  assert.equal(out7, "clips_none_found", "a stranger must understand it: standalone under 6 is out");
  // more kept than asked: the rerank picks, and only `count` are cut (two bursts 300 s apart, one clip asked)
  const two = [...chatWith(900, 1800), ...chatWith(1200, 1800).filter((m) => m.t >= 1200 && m.t < 1212 && /[A-Z]{4}/.test(m.c))];
  let n7 = 0; const cut7: any[] = []; const seen: string[][] = [];
  const out8 = await runStreamClipsJob(fakeSb().sb, { ...deps, chat: async () => two, verify: async (i: any) => graded(`M${++n7}`)(i), rerank: async (ms: any[]) => { seen.push(ms.map((m) => m.title)); return [1, 0]; }, cut: async (ctx: any, m: any) => { cut7.push(m); return { asset_id: "a7", bytes: 1, seconds: m.end - m.start }; } },
    { ...job, options: { ...job.options, count: 1 }, credits_reserved: 40, progress: {} });
  assert.equal(out8, "done"); assert.equal(seen.length, 1, "one rerank call"); assert.equal(seen[0].length, 2, "it saw both kept moments"); assert.equal(cut7.length, 1, "only the one asked for is cut"); assert.equal(cut7[0].title, seen[0][1], "the rerank's first pick");
  // a window the platform muted, or one that cannot be heard, is not a verdict: the next candidate is checked instead
  // (the 35-hour run of Nov 19 2026 spent 10 of its 21 checks on muted windows)
  const two2 = [...chatWith(900, 1800), ...chatWith(1200, 1800).filter((m) => m.t >= 1200 && m.t < 1212 && /[A-Z]{4}/.test(m.c))];
  let hears = 0; const verified: number[] = []; const cut9: any[] = [];
  const out9 = await runStreamClipsJob(fakeSb().sb, { ...deps, chat: async () => two2, muted: [[840, 1000]],
    hear: async () => { hears++; const w = words(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (i: any) => { verified.push(i.lines.length); return graded("Second one")(i); }, cut: async (ctx: any, m: any) => { cut9.push(m); return { asset_id: "a9", bytes: 1, seconds: m.end - m.start }; } },
    { ...job, options: { ...job.options, count: 1 }, credits_reserved: 40, progress: {} });
  assert.equal(out9, "done"); assert.equal(hears, 1, "the muted window was never fetched or heard"); assert.equal(verified.length, 1); assert.equal(cut9.length, 1); assert.ok(cut9[0].start >= 1150, `the clip came from the unmuted moment: ${cut9[0].start}`);
  let fails = 0; const cut10: any[] = [];
  const out10 = await runStreamClipsJob(fakeSb().sb, { ...deps, chat: async () => two2, hear: async () => { if (fails++ === 0) throw new Error("audio service 400: File is corrupted"); const w = words(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (i: any) => graded("Heard one")(i), cut: async (ctx: any, m: any) => { cut10.push(m); return { asset_id: "a10", bytes: 1, seconds: m.end - m.start }; } }, { ...job, options: { ...job.options, count: 1 }, credits_reserved: 40, progress: {} });
  assert.equal(out10, "done"); assert.equal(cut10.length, 1, "an unheard window does not use up the budget");
  // a quiet chat is refused before anything is heard
  const out3 = await runStreamClipsJob(fakeSb().sb, { ...deps, chat: async () => msgs.filter((x) => x.t % 10 === 0).slice(0, 100) }, { ...job, progress: {} });
  assert.equal(out3, "chat_too_quiet");
});

test("stacked framing: the facecam box on top at its own shape, the game under it, 1920 lines in all", async () => {
  const { stackedFilter, stackedLayout, cleanFacecam, cleanContent, FORMAT } = await import("../src/studio-live-clips.js");
  const g = stackedFilter({ w: 1920, h: 1080, fps: 60 }, { x: 0.02, y: 0.7, w: 0.25, h: 0.28 });
  // 1080x1920 out; the camera panel is at most a third of the frame (640 lines) and is cropped from a third of the way
  // down, never the middle (a near-square box took 900 lines, half the frame, on the first run of Nov 19 2026)
  assert.match(g, /crop=480:302:38:756,scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640:0:\(ih-640\)\*0\.3\[cam\]/);
  assert.match(g, /\[g\]scale=1080:1280:force_original_aspect_ratio=increase,crop=1080:1280\[game\]/);
  assert.match(g, /vstack,setsar=1,fps=30,format=yuv420p\[v\]$/);
  assert.deepEqual([stackedLayout({ w: 1920, h: 1080, fps: 60 }, { x: 0.02, y: 0.7, w: 0.25, h: 0.28 }).w, stackedLayout({ w: 1920, h: 1080, fps: 60 }, { x: 0.02, y: 0.7, w: 0.25, h: 0.28 }).h], [1080, 1920]);
  assert.equal(FORMAT.cam.max, 640); assert.ok(!("hook" in FORMAT) && !("trim" in FORMAT) && !("punch" in FORMAT), "no text, no trim, no punch-in on the picture");
  // KaiCenat's near-square box of Nov 19 2026 (400x335): capped at a third, not half the frame
  assert.match(stackedFilter({ w: 1920, h: 1080, fps: 30 }, { x: 0, y: 0.14, w: 0.208, h: 0.31 }), /scale=1080:640:/);
  // with a content box (a chess board beside its move list), the game panel is cut from that box first
  const g2 = stackedFilter({ w: 1920, h: 1080, fps: 30 }, { x: 0.736, y: 0.563, w: 0.264, h: 0.437 }, { x: 0.05, y: 0.08, w: 0.5, h: 0.85 });
  assert.match(g2, /\[g\]crop=960:918:96:86,scale=1080:1280:force_original_aspect_ratio=increase,crop=1080:1280\[game\]/);
  assert.equal(cleanContent({ present: false, x: 0, y: 0, w: 0, h: 0 }), null);
  assert.equal(cleanContent({ present: true, x: 0, y: 0, w: 0.98, h: 0.98 }), null, "the whole frame is no content box");
  assert.equal(cleanContent({ present: true, x: 0.7, y: 0.6, w: 0.2, h: 0.2 }), null, "a corner is too small to be the content");
  assert.deepEqual(cleanContent({ present: true, x: 0.05, y: 0.08, w: 0.5, h: 0.85 }), { x: 0.05, y: 0.08, w: 0.5, h: 0.85 });
  assert.equal(cleanFacecam({ present: false, x: 0, y: 0, w: 0, h: 0 }), null);
  assert.equal(cleanFacecam({ present: true, x: 0, y: 0, w: 0.9, h: 0.9 }), null, "the whole frame is not a corner camera");
  assert.deepEqual(cleanFacecam({ present: true, x: 0.02, y: 0.7, w: 0.25, h: 0.28 }), { x: 0.02, y: 0.7, w: 0.25, h: 0.28 });
});

test("the edge: a cut that ends where the window ends hears 30 s more and closes on the next thought; a cold hour waits behind the rest", async () => {
  const words = (startRel: number, n = 40) => { const w = []; let t = startRel; for (let i = 0; i < n; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
  const base: any = { env: ENV, log: () => undefined, plans: PLANS, drawtext: true, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), fetchWindow: async () => undefined, fetchStretch: async () => undefined, stills: async () => [] };
  const job = (count: number, seconds: number): any => ({ id: "job-e", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 200, attempts: 1, progress: {},
    options: { platform: "twitch", url: "https://www.twitch.tv/videos/1", stream: { platform: "twitch", vod_id: "1", login: "x", channel_id: "1", started_at: "2026-11-18T03:01:21Z", strictness: "balanced" }, source: { title: "T", channel: "x" }, seconds, count, length: "standard", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" } });
  const graded = (input: any, extra: any = {}) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: input.lines[0].i, end_line: input.lines[input.lines.length - 1].i, title: "T", hook: "", hook_line: "", caption: "", why: "", why_not: "", tags: [], ...extra });
  // 1. the words run to the window's end (150 s) and the model ends on the last line: the extension is heard (a file
  // named ...x.mp3, 30 s), the cut closes on its first closing thought, and the clip's words include it
  const heardFiles: string[] = []; const cut: any[] = [];
  const out = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => chatWith(900, 3600),
    hear: async (f: string, d: string, sec?: number) => { heardFiles.push(`${f.split("/").pop()}:${sec ?? ""}`); const w = /x\.mp3$/.test(f) ? words(0.5, 16) : words(126); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (i: any) => graded(i), cut: async (ctx: any, m: any) => { cut.push(m); return { asset_id: "e1", bytes: 1, seconds: m.end - m.start }; } }, job(1, 3600));
  assert.equal(out, "done"); assert.equal(cut.length, 1);
  assert.equal(heardFiles.length, 2, `the window, then its extension: ${heardFiles}`); assert.match(heardFiles[1], /x\.mp3:30$/);
  const d = cut[0].end - cut[0].start;
  assert.ok(d > 27 && d < 32, `the cut grew past the window's end to the next closing thought: ${d}`);
  assert.ok(cut[0].words.some((w: any) => w[0] === "yeah." && w[1] > cut[0].start + 25), "the extension's words are the clip's too");
  // 2. three bursts in the first hour the model turns down, one weaker burst in the second it keeps: after two
  // verdicts the first hour is cold, so the second hour's burst is the THIRD check (not the fourth), and the deferred
  // one is still checked afterwards while budget remains
  const chat = [...chatWith(900, 5400), ...chatWith(1500, 5400).filter((m) => m.t >= 1500 && m.t < 1512 && /[A-Z]{4}/.test(m.c) || m.t >= 1500 && m.t < 1512 && m.e), ...chatWith(2100, 5400).filter((m) => m.t >= 2100 && m.t < 2112 && /[A-Z]{4}/.test(m.c) || m.t >= 2100 && m.t < 2112 && m.e),
    ...chatWith(4500, 5400).filter((m) => m.t >= 4500 && m.t < 4512 && /[A-Z]{4}/.test(m.c))];
  const starts: number[] = []; const cut2: any[] = [];
  const minutesOf = (head: string) => { const m = /Window: (\d+):(\d+)/.exec(head)!; return Number(m[1]) + Number(m[2]) / 60; };
  const out2 = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => chat,
    hear: async () => { const w = words(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (i: any) => { const min = minutesOf(i.head); starts.push(min); return min > 60 ? graded(i) : graded(i, { keep: false, why_not: "needs the game" }); },
    cut: async (ctx: any, m: any) => { cut2.push(m); return { asset_id: "e2", bytes: 1, seconds: m.end - m.start }; } }, job(1, 5400));
  assert.equal(out2, "done"); assert.equal(cut2.length, 1); assert.ok(cut2[0].start > 4400, `the second hour's moment: ${cut2[0].start}`);
  assert.equal(starts.length, 4, `all four checked (budget 12): ${starts}`);
  assert.ok(starts[0] < 60 && starts[1] < 60, `the first hour's strongest two first: ${starts}`);
  assert.ok(starts[2] > 60, `the first hour went cold after two misses, so the second hour came third: ${starts}`);
  assert.ok(starts[3] < 60, `the deferred one was still checked: ${starts}`);
});
