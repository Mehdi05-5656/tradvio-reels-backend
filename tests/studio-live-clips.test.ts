import test from "node:test";
import assert from "node:assert/strict";
import { twitchCutFormat, parseStreamLink, parseMaster, pickRungs, nicheOf, twitchBroadcasts, twitchTopStreams, resetTwitchToken, isRecordingOf, twitchSearch, twitchFollowers, type ChatMsg } from "../src/live-sources.js";
import { partOf, liveNowOpen, resetBrief, checklistScore, OVERSHOOT, chatSignals, chatCandidates, robustZ, firstCut, streamPrice, streamAnalysisUsd, streamClipUsd, quoteStreamClips, runStreamClipsJob, attributionFilter, streamerPermission, LIVE_RATES, LIVE_LIMITS, likelyStreamClips, streamCountCap, liveClipsEnabled, liveClipsOpen, VERIFY_BAR, hoursToRead, contentLayout, cleanFacecam, TINY_CAM_W, excludeCam } from "../src/studio-live-clips.js";
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

test("an HLS master playlist gives its rungs, smallest first; the cut rung is the biggest at or under 720, or 1080 for HD", () => {
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9072504,RESOLUTION=1920x1080\n1080p60/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160\n160p/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3423000,RESOLUTION=1280x720\n720p60/playlist.m3u8\n`;
  const vs = parseMaster(master, "https://stream.kick.com/abc/master.m3u8");
  assert.deepEqual(vs.map((v) => v.height), [160, 720, 1080]);
  assert.equal(vs[0].url, "https://stream.kick.com/abc/160p/playlist.m3u8");
  const r = pickRungs(vs);
  assert.equal(r.audio, vs[0].url); assert.equal(r.video, vs[1].url);
  assert.equal(pickRungs(vs, 1080).video, vs[2].url);
  assert.match(twitchCutFormat(1080), /^1080p60\//); assert.match(twitchCutFormat(720), /^720p60\//);
  assert.equal(parseMaster("#EXTM3U\n#EXTINF:10,\nseg1.ts\n", "https://x/y.m3u8")[0].url, "https://x/y.m3u8");
  assert.equal(nicheOf("Grand Theft Auto VI (GTA)"), "gta"); assert.equal(nicheOf("Just Chatting"), "chatting"); assert.equal(nicheOf("Fortnite"), "games", "shooters are games now (owner, Nov 21 2026)"); assert.equal(nicheOf("Chess"), "games"); assert.equal(nicheOf("IRL"), "irl"); assert.equal(nicheOf("Always On"), "chatting");
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
  assert.equal(VERIFY_BAR.balanced, 55); assert.equal(VERIFY_BAR.best, VERIFY_BAR.balanced); assert.equal(VERIFY_BAR.more, 45);
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
    if (u.includes("/helix/search/channels?query=caseoh")) return json({ data: [{ broadcaster_login: "caseoh_", display_name: "CaseOh_", id: "123", is_live: true, game_name: "Just Chatting", thumbnail_url: "https://p/c.png" }, { broadcaster_login: "", display_name: "nameless" }] });
    if (u.includes("/helix/channels/followers?broadcaster_id=123")) return json({ total: 5300000, data: [] });
    if (u.includes("/helix/streams?")) return json({ data: [{ user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", game_name: "Grand Theft Auto VI", title: "GTA", viewer_count: 90000, started_at: "2026-11-18T20:00:00Z", language: "en", thumbnail_url: "https://t/{width}x{height}.jpg" }] });
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
}

test("Twitch through Helix with an app token: a channel's broadcasts, the top streams", async () => {
  resetTwitchToken(); resetBrief();
  const deps = { env: ENV, fetch: twitchFetch() };
  const list = await twitchBroadcasts(deps, "123");
  assert.equal(list.length, 2); assert.equal(list[0].seconds, 14443); assert.equal(list[0].thumbnail_url, "https://t/640x360.jpg"); assert.equal(list[0].url, "https://www.twitch.tv/videos/2932003293");
  const top = await twitchTopStreams(deps);
  assert.equal(top[0].viewers, 90000); assert.equal(top[0].category, "Grand Theft Auto VI");
});

test("a quote for a past broadcast: the reading, the clips, the source the run page shows; gated by the switches", async () => {
  resetTwitchToken(); resetBrief();
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
  // 1b. the model ends on a line that pauses mid-sentence ("You know about" then a second of air, then "TikTok?"):
  // the cut runs to the sentence's end
  const pause = () => { const w: any[] = []; let t = 20; for (let i = 0; i < 40; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; }
    for (const [text, gap] of [["You", 0.4], ["know", 0.4], ["about", 1.1], ["TikTok?", 0.4], ["Of", 0.4], ["course.", 1.2], ["Okay", 0.4], ["bye.", 0.4]] as Array<[string, number]>) { w.push({ text, start: t, end: t + 0.3, speaker: "S1" }); t += gap; } return w; };
  const cutP: any[] = [];
  const outP = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => chatWith(900, 3600),
    hear: async () => { const w = pause(); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    verify: async (i: any) => graded(i, { end_line: i.lines.find((l: any) => /about$/.test(l.text.trim())).i }), cut: async (ctx: any, m: any) => { cutP.push(m); return { asset_id: "p1", bytes: 1, seconds: m.end - m.start }; } }, job(1, 3600));
  assert.equal(outP, "done"); assert.equal(cutP.length, 1);
  assert.match(cutP[0].transcript, /course\.$/, `the cut ran to the end of the sentence, not the pause: ${cutP[0].transcript.slice(-40)}`);
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

test("the hybrid: the strongest hours are heard whole and read by Clips' picker; its moments join the checks, a chat moment nearby takes its cut, and a check inside a read hour needs no fetch", async () => {
  const mk = (from: number, n = 48) => { const w: any[] = []; let t = from; for (let i = 0; i < n; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
  const graded = (input: any) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: input.lines[0].i, end_line: input.lines[Math.min(input.lines.length - 1, 7)].i, title: "T", hook: "", hook_line: "", caption: "", why: "", why_not: "", tags: [] });
  const job = (count: number, seconds: number): any => ({ id: "job-h", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 200, attempts: 1, progress: {},
    options: { platform: "twitch", url: "https://www.twitch.tv/videos/1", stream: { platform: "twitch", vod_id: "1", login: "x", channel_id: "1", started_at: "2026-11-18T03:01:21Z", strictness: "balanced" }, source: { title: "T", channel: "x" }, seconds, count, length: "standard", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" } });
  // hour 0 (the burst's) has talk at the burst and, with no burst, at 1500 s; the picker finds the latter
  const hourWords = [...mk(880), ...mk(1300), ...mk(1500)];
  let hears = 0, picks = 0; const hourReads: number[] = []; const heads: string[] = []; const bodies: string[] = []; const cutH: any[] = [];
  const base: any = { env: { ...ENV, STUDIO_LIVE_QUIET: "off" }, log: () => undefined, plans: PLANS, drawtext: true, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), fetchWindow: async () => undefined, fetchStretch: async () => undefined, stills: async () => [],
    hear: async () => { hears++; const w = mk(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    hearHour: async (_f: string, sec: number) => { hourReads.push(sec); return { words: hourWords, events: [], language: "en" }; },
    pick: async (ls: any[]) => { picks++; const s = ls.find((l) => l.start >= 1500); const e = [...ls].reverse().find((l) => l.end <= 1530); return s && e ? [{ start_line: s.i, end_line: e.i, title: "Car talk", hook: "so", why: "talk", score: 70, tags: ["irl"] }] : []; },
    verify: async (i: any) => { heads.push(i.head); bodies.push(i.body); return graded(i); }, cut: async (ctx: any, m: any) => { cutH.push(m); return { asset_id: "h", bytes: 1, seconds: m.end - m.start }; } };
  const out = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => chatWith(900, 7200) }, job(2, 7200));
  assert.equal(out, "done"); assert.deepEqual(hourReads, [3600], "hour 0 (the burst's) heard whole; hour 1, with no candidate, not (the quiet-chat rule is off here: its own test is in live-margin.test.ts)");
  assert.ok(picks >= 1, "the picker read the hour"); assert.equal(hears, 0, "both windows sit inside the read hour: nothing fetched or heard again");
  assert.equal(cutH.length, 2, `the chat's moment and the picker's: ${cutH.map((m) => m.start)}`);
  assert.ok(cutH.some((m) => m.start > 1450 && m.start < 1520), `the picker's moment was cut: ${cutH.map((m) => m.start)}`);
  assert.ok(heads.some((h) => /found in the words/.test(h)), "the verifier is told where the moment came from");
  assert.ok(bodies.some((b) => /five minutes before the window/.test(b) && /yeah\./.test(b.split("five minutes before")[1] ?? "")), "the picker's window (1463 s on) sees the talk at 1300 s as context");
  // the picker marks the burst's own minute: no second candidate, the chat's takes the picker's cut
  const heads2: string[] = []; const cut2: any[] = []; hears = 0;
  const out2 = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => chatWith(900, 7200),
    pick: async (ls: any[]) => { const s = ls.find((l) => l.start >= 884); const e = [...ls].reverse().find((l) => l.end <= 912); return s && e ? [{ start_line: s.i, end_line: e.i, title: "Same minute", hook: "so", why: "talk", score: 70, tags: [] }] : []; },
    verify: async (i: any) => { heads2.push(i.head); return graded(i); }, cut: async (ctx: any, m: any) => { cut2.push(m); return { asset_id: "h2", bytes: 1, seconds: m.end - m.start }; } }, job(1, 7200));
  assert.equal(out2, "done"); assert.equal(cut2.length, 1); assert.equal(heads2.length, 1, "one candidate, not two"); assert.match(heads2[0], /picker of the words proposed/); assert.equal(hears, 0);
  // two bursts, the picker marks the second: a moment both readers marked is checked first, in a window that holds the cut
  const heads3: string[] = []; const two = [...chatWith(900, 7200), ...chatWith(1500, 7200).filter((m) => m.t >= 1500 && m.t < 1512 && /[A-Z]{4}/.test(m.c))];
  const out4 = await runStreamClipsJob(fakeSb().sb, { ...base, chat: async () => two,
    pick: async (ls: any[]) => { const s = ls.find((l) => l.start >= 1500); const e = [...ls].reverse().find((l) => l.end <= 1600); return s && e ? [{ start_line: s.i, end_line: e.i, title: "Both", hook: "so", why: "talk", score: 70, tags: [] }] : []; },
    hearHour: async () => ({ words: [...mk(880), ...mk(1500, 48), ...mk(1560, 48)], events: [], language: "en" }),
    verify: async (i: any) => { heads3.push(i.head); return graded(i); } }, job(1, 7200));
  assert.equal(out4, "done"); assert.match(heads3[0], /picker of the words proposed/, `the agreed moment first: ${heads3[0].slice(0, 120)}`);
  const win = /Window: (\d+):(\d+) to (\d+):(\d+)/.exec(heads3[0])!; const wEnd = Number(win[3]) * 60 + Number(win[4]);
  assert.ok(wEnd >= 1587 + 15, `the window reaches past the picker's cut end (~1587 s): ends ${wEnd}`);
  // the cheap door hears the hours only: an hour it heard gives the picker and the context its words, but a window inside
  // it is heard again by Scribe (the verdict and the cut need the exact words), and no kept clip is heard a third time
  const reheard: number[] = []; const cutR: any[] = []; hears = 0; const headsR: string[] = [];
  const outR = await runStreamClipsJob(fakeSb().sb, { ...base, env: { ...ENV, GROQ_API_KEY: "k" }, chat: async () => chatWith(900, 7200),
    hearClip: async (_f: string, sec: number) => { reheard.push(Math.round(sec)); return { words: [], events: [], language: "en" }; },
    verify: async (i: any) => { headsR.push(i.head); return graded(i); },
    cut: async (ctx: any, m: any) => { cutR.push(m); return { asset_id: "r", bytes: 1, seconds: m.end - m.start }; } }, job(1, 7200));
  assert.equal(outR, "done"); assert.equal(reheard.length, 0, "no third hearing"); assert.ok(hears >= 1, `the window was heard by Scribe, not taken from the cheap hour: ${hears}`);
  assert.equal(cutR.length, 1); assert.ok(headsR.some((h) => /picker of the words proposed|found in the words/.test(h)), "the cheap hour still fed the picker");
  // off: nothing read, the window fetched and heard as before
  hears = 0;
  const out3 = await runStreamClipsJob(fakeSb().sb, { ...base, env: { ...ENV, STUDIO_LIVE_HYBRID: "off" }, chat: async () => chatWith(900, 7200), hearHour: async () => { throw new Error("must not read"); } }, job(1, 7200));
  assert.equal(out3, "done"); assert.equal(hears, 1);
  // the hours: by the chat's strength, muted hours skipped, at most three, in stream order
  const c = (t_event: number, score: number) => ({ t_event, score });
  assert.deepEqual(hoursToRead([c(100, 5), c(4000, 9), c(8000, 1), c(12000, 7), c(16000, 8)], 18000, () => 0, 3), [1, 3, 4]);
  assert.deepEqual(hoursToRead([c(100, 5), c(4000, 9), c(8000, 1), c(12000, 7), c(16000, 8)], 18000, () => 0), [1, 4], "two hours by default");
  assert.deepEqual(hoursToRead([c(100, 5), c(4000, 9)], 18000, (a) => (a === 3600 ? 0.5 : 0)), [0]);
  assert.deepEqual(hoursToRead([c(100, 5), c(4000, 9)], 4000, () => 0), [0], "an hour under ten minutes long is not read");
});

test("a cut never opens on a line that continues a sentence: it starts on the sentence's start, up to three lines back", async () => {
  // "Mahomes" | 1 s pause | "finally has a receiver." then more; the verifier opens on "finally"
  const w: any[] = []; let t = 30;
  for (let i = 0; i < 24; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; }
  w.push({ text: "Mahomes", start: t, end: t + 0.4, speaker: "S1" }); t += 1.4;
  for (const [text, gap] of [["finally", 0.4], ["has", 0.4], ["a", 0.3], ["receiver.", 1.0], ["Finally!", 0.6]] as Array<[string, number]>) { w.push({ text, start: t, end: t + 0.3, speaker: "S1" }); t += gap; }
  for (let i = 0; i < 40; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; }
  const lines = linesFromWords(w);
  const fin = lines.find((l) => /^finally has/.test(l.text))!; assert.ok(fin, `a line opens on "finally": ${lines.map((l) => l.text).join(" | ")}`);
  const cutP: any[] = [];
  const base: any = { env: ENV, log: () => undefined, plans: PLANS, drawtext: true, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), fetchWindow: async () => undefined, fetchStretch: async () => undefined, stills: async () => [],
    hear: async () => ({ words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }),
    verify: async (i: any) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: fin.i, end_line: i.lines[i.lines.length - 1].i, title: "T", hook: "", hook_line: "", caption: "", why: "", why_not: "", tags: [] }),
    cut: async (ctx: any, m: any) => { cutP.push(m); return { asset_id: "p", bytes: 1, seconds: m.end - m.start }; } };
  const job: any = { id: "job-s", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 200, attempts: 1, progress: {},
    options: { platform: "twitch", url: "https://www.twitch.tv/videos/1", stream: { platform: "twitch", vod_id: "1", login: "x", channel_id: "1", started_at: "2026-11-18T03:01:21Z", strictness: "balanced" }, source: { title: "T", channel: "x" }, seconds: 3600, count: 1, length: "standard", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" } };
  const out = await runStreamClipsJob(fakeSb().sb, { ...base, env: { ...ENV, STUDIO_LIVE_HYBRID: "off" }, chat: async () => chatWith(900, 3600) }, job);
  assert.equal(out, "done"); assert.equal(cutP.length, 1);
  assert.match(cutP[0].transcript, /^Mahomes finally has a receiver/, `the clip opens on "Mahomes": ${cutP[0].transcript.slice(0, 50)}`);
});

test("content-first framing: a desktop stream with a tiny camera (or none) and a content box fills the frame with the content, not the whole desktop letterboxed", () => {
  assert.equal(TINY_CAM_W, 0.1);
  assert.ok(cleanFacecam({ present: true, x: 0.01, y: 0.02, w: 0.06, h: 0.1 }), "a camera 6 % wide is a camera now (it was dropped under 10 %)");
  assert.equal(cleanFacecam({ present: true, x: 0.01, y: 0.02, w: 0.04, h: 0.08 }), null);
  // a landscape content box (a browser card): scaled to the full width, centred over a blurred fill of itself
  const g = contentLayout({ w: 1920, h: 1080, fps: 60 }, { x: 0.2, y: 0.1, w: 0.5, h: 0.8 });
  assert.equal(g.w, 1080); assert.equal(g.h, 1920); assert.equal(g.camH, 0);
  assert.match(g.graph, /^\[0:v\]split=2\[a\]\[b\];\[a\]crop=960:864:384:108,scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.08\[bg\];\[b\]crop=960:864:384:108,scale=1080:-2\[fg\];\[bg\]\[fg\]overlay=\(W-w\)\/2:\(H-h\)\/2,setsar=1,fps=30,format=yuv420p\[v\]$/);
  // a tall content box (a phone-shaped player) is cropped to the frame
  assert.match(contentLayout({ w: 1920, h: 1080, fps: 30 }, { x: 0.35, y: 0, w: 0.3, h: 1 }).graph, /^\[0:v\]crop=576:1080:672:2,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p\[v\]$/);
});

test("the content box loses the camera's corner when they overlap: the larger rectangle beside or below the camera", () => {
  // the Lacy trivia frame: the camera top-left 27 % wide, the content box starting at the same corner
  assert.deepEqual(excludeCam({ x: 0, y: 0, w: 0.7, h: 0.955 }, { x: 0, y: 0, w: 0.268, h: 0.265 }), { x: 0, y: 0.265, w: 0.7, h: 0.69 }, "below the camera keeps more than beside it");
  assert.deepEqual(excludeCam({ x: 0, y: 0, w: 0.7, h: 0.5 }, { x: 0, y: 0, w: 0.15, h: 0.45 }), { x: 0.15, y: 0, w: 0.55, h: 0.5 }, "a tall camera at the left: beside it");
  assert.deepEqual(excludeCam({ x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, { x: 0.02, y: 0.7, w: 0.15, h: 0.25 }), { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, "no overlap: unchanged");
  assert.equal(excludeCam(null, { x: 0, y: 0, w: 0.2, h: 0.2 }), null);
});

test("live: a stream still on is its newest part; the part's rules", () => {
  // a live stream reads its latest hour by default; a past one the whole broadcast
  assert.deepEqual(partOf({}, 9000, true), { from: 5400, to: 9000, scope: "latest_60" });
  assert.equal(partOf({}, 9000, false), null);
  assert.deepEqual(partOf({ scope: "latest_30" }, 9000, true), { from: 7200, to: 9000, scope: "latest_30" });
  assert.deepEqual(partOf({ scope: "latest_120" }, 9000, true), { from: 1800, to: 9000, scope: "latest_120" });
  assert.equal(partOf({ scope: "all" }, 9000, true), null, "the whole stream so far");
  assert.equal(partOf({ scope: "latest_120" }, 5000, true), null, "a stream shorter than the part is read whole");
  // since a run's end: the new part, at least ten minutes of it
  assert.deepEqual(partOf({ scope: "since", since: 6000 }, 9000, true), { from: 6000, to: 9000, scope: "since" });
  assert.throws(() => partOf({ scope: "since", since: 8700 }, 9000, true), (e: any) => e.code === "part_too_short" && /5 min/.test(e.message));
  assert.throws(() => partOf({ scope: "since", since: 9000 }, 9000, true), (e: any) => e.code === "part_nothing_new");
  assert.throws(() => partOf({ scope: "since" }, 9000, true), (e: any) => e.code === "part_nothing_new");
  // the recording of the stream on now: started within 15 minutes of it
  assert.equal(isRecordingOf({ started_at: "2026-11-21T18:26:53Z" }, { started_at: "2026-11-21T18:27:10Z" }), true);
  assert.equal(isRecordingOf({ started_at: "2026-11-20T18:26:53Z" }, { started_at: "2026-11-21T18:27:10Z" }), false, "yesterday's broadcast");
  assert.equal(isRecordingOf({ started_at: "2026-11-21T18:26:53Z" }, null), false, "nobody live");
  assert.equal(liveNowOpen({}), false); assert.equal(liveNowOpen({ STUDIO_LIVE_NOW: "true" }), true);
});

test("live: the quote marks a stream still on, prices its latest hour, and stays as before until the switch (the owner sees it first)", async () => {
  resetTwitchToken(); resetBrief();
  // the same 4-hour broadcast, its channel live now (the stream started a minute after the recording)
  const live = ((inner: typeof fetch) => (async (url: any, init?: any) => String(url).includes("/helix/streams?user_id=123")
    ? new Response(JSON.stringify({ data: [{ user_id: "123", user_login: "caseoh_", game_name: "Just Chatting", title: "LIVE", viewer_count: 5000, started_at: "2026-11-18T03:02:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_caseoh_-{width}x{height}.jpg" }] }), { status: 200, headers: { "content-type": "application/json" } })
    : inner(url, init)) as typeof fetch)(twitchFetch());
  const url = "https://www.twitch.tv/videos/2932003293";
  const q = await quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_NOW: "true" }, fetch: live }, PLANS, { url, length: "standard", count: 3 }, {});
  assert.equal(q.options.stream.live, true); assert.deepEqual(q.options.part, { from: 14443 - 3600, to: 14443, scope: "latest_60" });
  assert.equal(q.options.source.live, true); assert.deepEqual(q.options.source.part, q.options.part, "the run page knows where to pick up");
  assert.match(q.options.source.thumbnail_url, /^https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_caseoh_-640x360\.jpg\?t=\d+$/, "a stream on now shows its live preview");
  assert.equal(q.options.price.analysis, 30, "an hour read is priced as an hour (the minimum)");
  assert.equal(q.options.likely, 4); assert.match(q.summary, /the latest hour of CaseOh_ \(live\) · up to 3 clips/);
  const half = await quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_NOW: "true" }, fetch: live }, PLANS, { url, scope: "latest_30", count: 1 }, {});
  assert.match(half.summary, /the latest 30 min of CaseOh_/);
  const since = await quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_NOW: "true" }, fetch: live }, PLANS, { url, scope: "since", since: 12000, count: 1 }, {});
  assert.deepEqual(since.options.part, { from: 12000, to: 14443, scope: "since" }); assert.match(since.summary, /41 new min of CaseOh_ \(live\)/);
  const whole = await quoteStreamClips({ env: { ...ENV, STUDIO_LIVE_NOW: "true" }, fetch: live }, PLANS, { url, scope: "all", count: 3 }, {});
  assert.equal(whole.options.part, undefined); assert.equal(whole.options.stream.live, true); assert.match(whole.summary, /4 h of CaseOh_ \(live\) so far/);
  // switch off: customers clip the recording so far as before (no live mark, no part, no plan gate); the owner gets the live flow
  const before = await quoteStreamClips({ env: ENV, fetch: live }, PLANS, { url, count: 3 }, {});
  assert.equal(before.options.stream.live, undefined); assert.equal(before.options.part, undefined); assert.match(before.summary, /4 h of CaseOh_/);
  // a hand-made stretch of a stream still on is the whole stream so far where Live is not open to the person (audit, Nov 21 2026)
  const crafted = await quoteStreamClips({ env: ENV, fetch: live }, PLANS, { url, scope: "range", from: 14443 - 3600, to: 14443, count: 3 }, {});
  assert.equal(crafted.options.part, undefined); assert.equal(crafted.options.stream.live, undefined); assert.equal(crafted.options.price.analysis, 61, "priced as the whole stream");
  const owner = await quoteStreamClips({ env: ENV, fetch: live }, PLANS, { url, count: 3 }, { owner: true });
  assert.equal(owner.options.stream.live, true); assert.equal(owner.options.part.scope, "latest_60");
});

test("live: a run reads only its part (the newest hour heard whole) and never checks a moment before it", async () => {
  const mk = (from: number, n = 48) => { const w: any[] = []; let t = from; for (let i = 0; i < n; i++) { w.push({ text: i % 8 === 7 ? "yeah." : "so", start: t, end: t + 0.3, speaker: "S1" }); t += i % 8 === 7 ? 1 : 0.5; } return w; };
  const graded = (input: any) => ({ keep: true, score: 80, standalone: true, grades: { hook: 8, standalone: 8, payoff: 8, reaction: 7, quotable: 6, length: 8 }, hard_fail: "", start_line: input.lines[0].i, end_line: input.lines[Math.min(input.lines.length - 1, 7)].i, title: "T", hook: "", hook_line: "", caption: "", why: "", why_not: "", tags: [] });
  const job = (part: any): any => ({ id: "job-l", user_id: U, lease_token: "t", asset_id: null, credits_reserved: 200, attempts: 1, progress: {},
    options: { platform: "twitch", url: "https://www.twitch.tv/videos/1", stream: { platform: "twitch", vod_id: "1", login: "x", channel_id: "1", started_at: "2026-11-18T03:01:21Z", strictness: "balanced", live: true }, part, source: { title: "T", channel: "x" }, seconds: 9000, count: 2, length: "standard", format: "vertical", price: { analysis: 30, per_clip: 10, lite: 0 }, collection_id: "col-1" } });
  // two chat bursts, one long before the part (900 s) and one in it (7000 s); the part's words hold a second moment at 8000 s
  const chat = [...chatWith(900, 9000), ...chatWith(7000, 9000).filter((m) => m.t >= 7000 && m.t < 7012 && /[A-Z]{4}/.test(m.c))];
  const fetched: Array<[number, number]> = []; const heads: string[] = []; const cuts: any[] = []; const hourSecs: number[] = [];
  const deps: any = { env: ENV, log: () => undefined, plans: PLANS, drawtext: true, playlists: async () => ({ audio: "a.m3u8", video: "v.m3u8" }), stills: async () => [],
    fetchWindow: async (_u: string, start: number, sec: number) => { fetched.push([start, sec]); }, fetchStretch: async () => undefined, chat: async () => chat,
    hear: async () => { const w = mk(30); return { words: w, events: [], lines: linesFromWords(w), excess: null, language: "en" }; },
    hearHour: async (_f: string, sec: number) => { hourSecs.push(sec); return { words: [...mk(1580), ...mk(2580)], events: [], language: "en" }; },
    pick: async (ls: any[]) => { const s = ls.find((l) => l.start >= 2580); const e = [...ls].reverse().find((l) => l.end <= 2610); return s && e ? [{ start_line: s.i, end_line: e.i, title: "New part", hook: "so", why: "talk", score: 70, tags: [] }] : []; },
    verify: async (i: any) => { heads.push(i.head); return graded(i); }, cut: async (_c: any, m: any) => { cuts.push(m); return { asset_id: "l", bytes: 1, seconds: m.end - m.start }; } };
  const out = await runStreamClipsJob(fakeSb().sb, deps, job({ from: 5400, to: 9000, scope: "latest_60" }));
  assert.equal(out, "done");
  assert.deepEqual(fetched[0], [5400, 3600], `the part itself was fetched whole for the hearing, not a clock hour: ${JSON.stringify(fetched)}`);
  assert.deepEqual(hourSecs, [3600]);
  const minutes = heads.map((h) => { const m = /Window: (\d+):(\d+)/.exec(h)!; return Number(m[1]) + Number(m[2]) / 60; });
  assert.ok(minutes.length >= 2 && minutes.every((m) => m >= 88), `no check before the part (90 min in): ${minutes}`);
  assert.ok(cuts.length >= 1 && cuts.every((m) => m.start >= 5400), `every clip from the part: ${cuts.map((m) => m.start)}`);
  assert.ok(cuts.some((m) => m.start > 7900 && m.start < 8020), `the words' own moment in the part was clipped: ${cuts.map((m) => Math.round(m.start))}`);
  // a part with a quiet chat still runs on its words; a part with neither stops cleanly
  const quiet = await runStreamClipsJob(fakeSb().sb, { ...deps, chat: async () => chatWith(900, 9000) }, job({ from: 5400, to: 9000, scope: "latest_60" }));
  assert.equal(quiet, "done");
  const none = fakeSb();
  assert.equal(await runStreamClipsJob(none.sb, { ...deps, chat: async () => chatWith(900, 9000).filter((m) => m.t < 5400), pick: async () => [] }, job({ from: 5400, to: 9000, scope: "latest_60" })), "clips_none_found");
  assert.ok(!none.calls.some(([fn]: any) => fn === "studio_complete"), "nothing settled as made: the reservation goes back with the failure");
});

test("a recording still processing has no picture (Twitch's placeholder does not load)", async () => {
  resetTwitchToken(); resetBrief();
  const inner = twitchFetch();
  const f = (async (url: any, init?: any) => String(url).includes("/helix/videos?user_id=123")
    ? new Response(JSON.stringify({ data: [{ id: "7", user_id: "123", user_login: "caseoh_", user_name: "CaseOh_", title: "on now", created_at: "2026-11-18T03:01:21Z", duration: "2h0m0s", view_count: 1, thumbnail_url: "https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png", type: "archive" }] }), { status: 200, headers: { "content-type": "application/json" } })
    : inner(url, init)) as typeof fetch;
  const list = await twitchBroadcasts({ env: ENV, fetch: f }, "123");
  assert.equal(list[0].thumbnail_url, null);
});

test("the Clips hub: creators by name, their followers, and any stretch of a past stream", async () => {
  resetTwitchToken(); resetBrief();
  const deps = { env: ENV, fetch: twitchFetch() };
  const hits = await twitchSearch(deps, "caseoh");
  assert.deepEqual(hits, [{ platform: "twitch", login: "caseoh_", channel: "CaseOh_", channel_id: "123", live: true, category: "Just Chatting", profile_image_url: "https://p/c.png", url: "https://www.twitch.tv/caseoh_" }], "a hit without a login is dropped");
  assert.equal(await twitchFollowers(deps, "123"), 5300000);
  assert.equal(await twitchFollowers(deps, "999"), null, "an answer without a total is unknown, not 0");
  // a stretch picked on the timeline: inside the broadcast, ten minutes at least; the whole of it is the whole stream
  assert.deepEqual(partOf({ scope: "range", from: 3600, to: 7200 }, 14443, false), { from: 3600, to: 7200, scope: "range" });
  assert.deepEqual(partOf({ scope: "range", from: 13000, to: 99999 }, 14443, false), { from: 13000, to: 14443, scope: "range" }, "the end is held to the broadcast's");
  assert.equal(partOf({ scope: "range", from: 0, to: 14443 }, 14443, false), null);
  assert.throws(() => partOf({ scope: "range", from: 100, to: 400 }, 14443, false), (e: any) => e.code === "part_too_short");
  assert.throws(() => partOf({ scope: "range", from: 500, to: 100 }, 14443, false), (e: any) => e.code === "part_invalid");
  assert.throws(() => partOf({ scope: "range" }, 14443, false), (e: any) => e.code === "part_invalid");
  // the quote prices the stretch, not the broadcast, and says where it starts
  const q = await quoteStreamClips(deps, PLANS, { url: "https://www.twitch.tv/videos/2932003293", scope: "range", from: 3600, to: 7200, count: 2 }, {});
  assert.deepEqual(q.options.part, { from: 3600, to: 7200, scope: "range" }); assert.equal(q.options.price.analysis, 30);
  assert.match(q.summary, /1 h of CaseOh_, from 1:00 · up to 2 clips/);
});
