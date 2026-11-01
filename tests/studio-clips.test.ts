import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  linesFromSegments, linesFromWords, windows, finalizeMoments, buildClipFilter, shotsFrom, trackPath, sampleTimes, quoteClips, clipsPrice, clipsCharge,
  likelyClips, countCap, parseMeta, parseTranscript, isLongSource, runClipsJob, inputArgs, chooseMessage, CLIP_LIMITS, CLIP_LENGTHS, ClipsError, quoteCut,
  parseLoudness, loudnessExcess, loudPeaks, annotateLines, analysisUsd, perClipUsd, CLIP_RATES, CLIPS_SAFETY_MARGIN, frameUsdPerSecond, lengthWords,
  timingFrom, remainingSeconds, etaFor, DEFAULT_TIMING,
} from "../src/studio-clips.js";
import { creditValueFloor } from "../src/studio-pricing.js";
import { parseStreams, LinkError, downloadFormat } from "../src/studio-youtube.js";
import { quote, PLANS } from "../src/studio.js";
import { jobsNotice } from "../src/studio-notices.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV = { ANTHROPIC_API_KEY: "k", SCRAPECREATORS_API_KEY: "k", ELEVENLABS_API_KEY: "k" };

test("caption segments become short lines; timed words become sentences that know where thoughts start and end", () => {
  const segs = [
    { start: 0, end: 2.5, text: "so the thing nobody tells you" }, { start: 2, end: 4.8, text: "about pricing is this" },
    { start: 4.5, end: 7, text: "you are charging too little" }, { start: 10, end: 12, text: "and that is the problem." },
  ];
  const lines = linesFromSegments(segs, 10);
  assert.ok(lines.length >= 2);
  assert.equal(lines[0].start, 0);
  assert.ok(lines.every((l, k) => l.i === k && l.end > l.start), "numbered in order, each with a length");
  assert.ok(lines.some((l) => l.start === 10), "a pause over 1.5 s starts a new line");
  const w = (text: string, start: number, end: number, speaker = "s1") => ({ text, start, end, speaker });
  const words = [w("Pricing", 0, 0.4), w("is", 0.45, 0.6), w("really", 0.62, 0.64), w("hard.", 0.65, 1.0), w("Here's", 1.2, 1.5), w("why", 1.55, 1.8), w("it", 1.85, 1.9), w("matters.", 1.95, 2.4), w("Yes", 3.5, 3.8, "s2")];
  const wl = linesFromWords(words);
  assert.deepEqual(wl.map((l) => l.text), ["Pricing is really hard.", "Here's why it matters.", "Yes"]);
  assert.deepEqual([wl[1].w0, wl[1].w1], [4, 7], "lines keep their word span for exact cuts");
  assert.deepEqual(wl.map((l) => [l.opens, l.closes]), [[true, false], [false, true], [true, true]], "a sentence followed straight on by the same speaker does not close a thought; a breath or a new speaker does");
  assert.deepEqual(wl.map((l) => l.speaker), ["s1", "s1", "s2"]);
});

test("signals: loudness per second, the jumps over their surroundings, sounds that are not speech on their lines", () => {
  assert.deepEqual(parseLoudness("frame:0\nlavfi.astats.Overall.RMS_level=-21.5\nframe:1\nlavfi.astats.Overall.RMS_level=-inf\n"), [-21.5, -90]);
  const rms = Array.from({ length: 600 }, (_, i) => (i >= 300 && i < 310 ? -12 : i % 50 === 0 ? -80 : -24));
  const ex = loudnessExcess(rms);
  assert.equal(ex[100], 0, "ordinary speech is the baseline");
  assert.ok(ex[305] >= 11, `the shout stands out (${ex[305]})`);
  assert.equal(ex[50], 0, "silence is not a signal");
  const peaks = loudPeaks(ex);
  assert.ok(peaks.length >= 1 && peaks[0].start >= 296 && peaks[0].start <= 304, JSON.stringify(peaks[0]));
  const lines = [{ i: 0, start: 290, end: 299, text: "and then he said" }, { i: 1, start: 300, end: 309, text: "NO WAY" }, { i: 2, start: 312, end: 320, text: "anyway" }];
  const ann = annotateLines(lines, [{ text: "laughter", start: 309.5, end: 312 }], ex);
  assert.deepEqual(ann.map((l) => l.events), [[], ["laughter"], []], "the laugh belongs to the line it follows");
  assert.ok((ann[1].loud ?? 0) >= 10 && (ann[0].loud ?? 0) === 0);
  const msg = chooseMessage({ lines: ann, meta: { title: "T", channel: null, description: "", chapters: [], replay: [] }, length: "standard", wanted: 3, peaks });
  assert.match(msg, /L1 \[5:00\] NO WAY \[laughter\] ⟪\+\d+ dB⟫/);
  assert.match(msg, /Loudest stretches[^\n]*5:0\d \(\+\d+ dB\)/);
});

test("windows cover the whole transcript with overlap", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => ({ i, start: i * 6, end: i * 6 + 6, text: `line ${i}` }));
  const w = windows(lines);
  assert.equal(w.length, 3, "two hours in 40-minute windows, the short tail folded into the last");
  assert.equal(w[0][0].i, 0);
  assert.equal(w[w.length - 1][w[w.length - 1].length - 1].i, 1199, "nothing at the end is left out");
  assert.ok(w[1][0].start < w[0][w[0].length - 1].end, "windows overlap so a moment on a seam is seen whole");
});

// 60 lines 5 s apart (3 s of speech, a 2 s breath), two words each; every third line ends a thought
const L60 = Array.from({ length: 60 }, (_, i) => ({ i, start: i * 5, end: i * 5 + 3, text: i % 3 === 2 ? `sentence ${i}.` : `words ${i}`, w0: i * 2, w1: i * 2 + 1, speaker: "s1", opens: i % 3 === 0, closes: i % 3 === 2 }));
const W120 = Array.from({ length: 120 }, (_, k) => ({ text: `w${k}`, start: (k >> 1) * 5 + (k % 2) * 1.6, end: (k >> 1) * 5 + (k % 2) * 1.6 + 1.4, speaker: "s1" }));
test("picks become clean clips: start and end where thoughts do, inside the length range, no overlaps, strong ones only, best first", () => {
  const raw = [
    { start_line: 3, end_line: 8, title: "Good one", hook: "h", why: "w", score: 88, tags: ["Pricing"] },     // ends on a closing line
    { start_line: 4, end_line: 9, title: "Overlaps the good one", hook: "h", why: "w", score: 70, tags: [] },
    { start_line: 21, end_line: 22, title: "Too short, grows to the next end", hook: "h", why: "w", score: 75, tags: [] },
    { start_line: 30, end_line: 50, title: "Too long, cut back to an end", hook: "h", why: "w", score: 92, tags: [] },
    { start_line: 55, end_line: 58, title: "Weak", hook: "h", why: "w", score: 40, tags: [] },
    { start_line: 999, end_line: 1000, title: "Bad lines", hook: "h", why: "w", score: 95, tags: [] },
    { start_line: 12, end_line: 16, title: "Ends mid-thought", hook: "h", why: "w", score: 80, tags: [] },  // line 16 does not close
  ];
  const ms = finalizeMoments(raw as any, L60, W120, "standard", 10);
  assert.deepEqual(ms.map((m) => m.title), ["Too long, cut back to an end", "Good one", "Ends mid-thought", "Too short, grows to the next end"]);
  assert.deepEqual(ms.map((m) => m.rank), [1, 2, 3, 4]);
  for (const m of ms) { const d = m.end - m.start; assert.ok(d >= CLIP_LENGTHS.standard.min && d <= CLIP_LENGTHS.standard.max + 1, `${m.title}: ${d}`); }
  const good = ms.find((m) => m.title === "Good one")!;
  assert.equal(good.start, Math.round((W120[6].start - 0.15) * 100) / 100, "starts just before the first word");
  assert.equal(good.end, Math.round((W120[17].end + 0.45) * 100) / 100, "ends just after the last word, before the next");
  assert.deepEqual(good.tags, ["pricing"]);
  assert.ok(good.speech!.length >= 1 && good.speech![0][2] === "s1", "who says what, for framing");
  const mid = ms.find((m) => m.title === "Ends mid-thought")!;
  assert.equal(mid.end, Math.round((W120[35].end + 0.45) * 100) / 100, "carried on to the end of the thought (line 17), not cut as the speaker goes on");
  const lastLine = (m: any) => L60.find((l) => Math.abs(l.end - (m.end - 0.45)) < 0.01);
  for (const m of ms) assert.ok(lastLine(m)?.closes, `${m.title} ends where a thought ends`);
  assert.equal(finalizeMoments(raw as any, L60, W120, "standard", 1).length, 1, "the cap holds");
});

test("a laugh or applause after the payoff rings out in the clip, but never into the next words", () => {
  const raw = [{ start_line: 3, end_line: 8, title: "Joke", hook: "h", why: "w", score: 90, tags: [] }];
  const plain = finalizeMoments(raw as any, L60, W120, "standard", 5)[0];
  const laughing = finalizeMoments(raw as any, L60, W120, "standard", 5, 60, [{ text: "laughter", start: W120[17].end + 0.1, end: W120[17].end + 2.0 }])[0];
  assert.ok(laughing.end > plain.end, "the laugh is kept");
  assert.ok(laughing.end <= W120[18].start - 0.06 + 1e-9, "and stops before the next word");
});

test("the 1 min+ length never runs under 61 s: a short pick grows to the next end of a thought, or is dropped", () => {
  const ok = finalizeMoments([{ start_line: 3, end_line: 11, title: "Story", hook: "h", why: "w", score: 85, tags: [] }] as any, L60, W120, "minute", 5);
  assert.equal(ok.length, 1);
  assert.ok(ok[0].end - ok[0].start >= 61, `${ok[0].end - ok[0].start}`);
  assert.ok(ok[0].end - ok[0].start <= CLIP_LENGTHS.minute.max + 2);
  // at the end of the video it grows at the front instead, from a line that opens a thought
  const end = finalizeMoments([{ start_line: 54, end_line: 59, title: "Short at the end", hook: "h", why: "w", score: 85, tags: [] }] as any, L60, W120, "minute", 5);
  assert.equal(end.length, 1);
  assert.ok(end[0].end - end[0].start >= 61 && L60.find((l) => Math.abs(l.start - (end[0].start + 0.15)) < 0.01)?.opens);
  // fewer than 61 s of speech to work with: dropped, never shipped under a minute
  const none = finalizeMoments([{ start_line: 0, end_line: 8, title: "Too short", hook: "h", why: "w", score: 85, tags: [] }] as any, L60.slice(0, 11), W120.slice(0, 22), "minute", 5);
  assert.equal(none.length, 0);
  assert.match(lengthWords("minute"), /at least 61 seconds/);
  assert.match(lengthWords("standard"), /Goal: 24 to 45 seconds/);
});

test("framing: the crop follows the speaker (holds, pans as they walk, cuts to the next speaker), shows the whole picture with nobody to frame", () => {
  const shots = shotsFrom([0.3, 5, 5.4, 12], 30);
  assert.deepEqual(shots.map((s) => [s.start, s.end]), [[0, 5], [5, 12], [12, 30]], "slivers under 0.8 s are folded in");
  assert.deepEqual(sampleTimes(10, [4]).slice(0, 5), [0.3, 1.3, 2.3, 3.3, 4.2], "a look every second and one just after each cut");
  assert.ok(sampleTimes(600, []).length <= 90, "at most ~90 stills");
  const P = (t: number, x: number) => ({ t, layout: "person" as const, x, speaker_visible: true });
  // one shot: still at 0.30 (tiny jitter held), walks right from 3 s to 6 s, then another person at 0.8 speaks from 7.4 s
  const path = trackPath([P(0.3, 0.3), P(1.3, 0.31), P(2.3, 0.29), P(3.3, 0.36), P(4.3, 0.42), P(5.3, 0.48), P(6.3, 0.5), P(7.3, 0.5), P(8.3, 0.8), P(9.3, 0.8)], [], 10, [7.6]);
  assert.ok(path.every((g) => g.mode === "crop"));
  assert.equal(path[0].x0, 0.3, "held still at first");
  assert.ok(path.some((g) => g.x1 > g.x0 + 0.01), "pans while they walk");
  const cutAt = path.find((g) => g.x0 === 0.8)!;
  assert.equal(cutAt.start, 7.6, "the cut to the other person lands when their voice starts");
  assert.ok(path.every((g, k) => k === 0 || g.start === path[k - 1].end), "no gaps");
  // nobody to frame for a stretch: the whole picture; a one-second flicker is smoothed away
  const N = (t: number) => ({ t, layout: "none" as const, x: 0.5, speaker_visible: false });
  const mixed = trackPath([P(0.5, 0.6), P(1.5, 0.6), N(2.5), P(3.5, 0.6), N(4.5), N(5.5), N(6.5), N(7.5)], [], 8);
  assert.deepEqual(mixed.map((g) => g.mode), ["crop", "fit"]);
  assert.ok(mixed[1].start > 3.5 && mixed[1].start < 4.5);
  const f = buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: path, fps: 60 });
  assert.match(f, /^\[0:v\]crop=608:1080:'if\(lt\(t,/);
  assert.match(f, /\+\d+\*\(t-\d+\.\d{3}\)\/\d+\.\d{3}/, "a pan is a straight move between two looks");
  assert.match(f, /fps=30/, "60 fps sources come down to 30");
  const fm = buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: mixed, fps: 30 });
  assert.match(fm, /^\[0:v\]split=3/);
  assert.match(fm, /boxblur/);
  assert.match(fm, /enable='between\(t,4\.000,7\.999\)'/);
  assert.equal(buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: [{ start: 0, end: 30, mode: "crop", x0: 0.5, x1: 0.5 }], fps: 30 }), "[0:v]crop=608:1080:'656':0,scale=720:1280,setsar=1,format=yuv420p[v]");
  assert.match(buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: [{ start: 0, end: 5, mode: "crop", x0: 0.99, x1: 0.99 }], fps: 30 }), /'1312'/, "a face at the edge still crops inside the picture");
  assert.match(buildClipFilter({ w: 1080, h: 1920, format: "vertical", segs: [], fps: 30 }), /^\[0:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280/, "a vertical source is only resized");
  assert.equal(buildClipFilter({ w: 1920, h: 1080, format: "original", segs: [], fps: 30 }), "[0:v]scale='min(1280,iw)':-2,setsar=1,format=yuv420p[v]");
  // a long clip with many moves stays inside ffmpeg's nesting limit (a balanced tree of ifs)
  const many = trackPath(Array.from({ length: 90 }, (_, k) => P(k + 0.3, k % 2 ? 0.3 : 0.7)), [], 91);
  const fl = buildClipFilter({ w: 1920, h: 1080, format: "vertical", segs: many, fps: 30 });
  let depth = 0, maxDepth = 0; for (const ch of fl) { if (ch === "(") maxDepth = Math.max(maxDepth, ++depth); if (ch === ")") depth--; }
  assert.ok(many.length > 60 && maxDepth < 40, `${many.length} stretches, nesting ${maxDepth}`);
});
test("reading the source: exact seeks, YouTube's separate sound, the proxy", () => {
  const up = inputArgs({ video: "https://store/x.mp4?sig", audio: null, proxy: null, width: 0, height: 0, fps: null }, 61.5, 30);
  assert.deepEqual(up.slice(0, 2), ["-ss", "61.500"]);
  assert.deepEqual(up.slice(-6), ["-t", "30.000", "-map", "0:v:0", "-map", "0:a:0?"]);
  const yt = inputArgs({ video: "https://g/v", audio: "https://g/a", proxy: "http://u:p@proxy:8000", width: 1920, height: 1080, fps: 30 }, 10, 20);
  assert.equal(yt.filter((x) => x === "-i").length, 2);
  assert.equal(yt.filter((x) => x === "-http_proxy").length, 2, "both streams go through the same proxy (the addresses are tied to its IP)");
  assert.ok(yt.includes("1:a:0"));
  const st = parseStreams("dims:1920|1080|30.0|8636\nhttps://manifest/v\nhttps://rr/a\n", null);
  assert.deepEqual([st.video, st.audio, st.width, st.height, st.fps, st.seconds], ["https://manifest/v", "https://rr/a", 1920, 1080, 30, 8636]);
  assert.throws(() => parseStreams("dims:NA|NA|NA|NA\n", null), (e: any) => e instanceof LinkError && e.code === "link_no_media");
});

test("YouTube listing and transcript are read from ScrapeCreators' shapes", () => {
  const m = parseMeta("https://www.youtube.com/watch?v=L_Guz73e6fw", { title: "Podcast #1", durationMs: 8637000, channel: { title: "Lex" }, thumbnail: "https://img/x.jpg",
    chapters: [{ title: "Intro", timeDescription: "0:00", startSeconds: 0 }, { title: "AGI", timeDescription: "47:36" }],
    most_replayed: { markers: [{ startMillis: 86370, durationMillis: 86370, intensityScoreNormalized: 0.8 }] } });
  assert.deepEqual([m.id, m.seconds, m.channel, m.chapters[1].start, m.replay[0].start], ["L_Guz73e6fw", 8637, "Lex", 2856, 86.37]);
  const segs = parseTranscript({ transcript: [{ text: "hello  there", startMs: "160", endMs: "1920" }, { text: "", startMs: "2000", endMs: "3000" }] })!;
  assert.deepEqual(segs, [{ start: 0.16, end: 1.92, text: "hello there" }]);
  assert.equal(parseTranscript({ transcript: null }), null, "no captions");
  const msg = chooseMessage({ lines: [{ i: 7, start: 100, end: 106, text: "the best part" }], meta: { title: "Podcast #1", channel: "Lex", description: "", chapters: m.chapters, replay: [{ start: 0, end: 86, score: 1 }, { start: 90, end: 120, score: 0.9 }] }, length: "standard", wanted: 5 });
  assert.match(msg, /L7 \[1:40\] the best part/);
  assert.match(msg, /replayed these stretches most[^\n]*1:30-2:00/);
  assert.doesNotMatch(msg, /0:00-1:26/, "the always-hot opening is not a signal");
});

test("prices: reading by the minute plus each clip (about 2-2.5x OpusClip), safety nets on cost; the count is chosen and checked", async () => {
  const floor = creditValueFloor(PLANS);
  const env = { ...ENV, STUDIO_YT_PROXY: "http://p", STUDIO_YT_PROXY_USD_PER_GB: "6.25" };
  const yt = clipsPrice(PLANS, { seconds: 900, platform: "youtube", length: "standard", env });
  assert.deepEqual(yt, { analysis: 75, per_clip: 5, lite: 15 }, "15 minutes of YouTube: 5 a minute, 5 a clip");
  assert.equal(clipsCharge(yt, 10), 125);
  const up = clipsPrice(PLANS, { seconds: 900, platform: "upload", length: "minute", env });
  assert.deepEqual([up.analysis, up.per_clip], [30, 8], "uploads 2 a minute; 1 min+ and long clips 8 each");
  assert.equal(clipsPrice(PLANS, { seconds: 150, platform: "upload", length: "short", env }).analysis, CLIP_RATES.analysis_min, "never under 10 to read");
  // even on the cheapest credit we sell, a run never drops under the safety margins
  for (const [sec, plat] of [[900, "youtube"], [3600, "youtube"], [7200, "youtube"], [3600, "upload"]] as const) {
    const p = clipsPrice(PLANS, { seconds: sec, platform: plat, length: "standard", env });
    const usd = analysisUsd({ seconds: sec, platform: plat, download: plat === "youtube", transcribe: true, choose: true, env });
    assert.ok(1 - usd / (p.analysis * floor) >= CLIPS_SAFETY_MARGIN.analysis - 1e-9, `${sec} ${plat}`);
  }
  assert.ok(1 - perClipUsd("long", env) / (clipsPrice(PLANS, { seconds: 900, platform: "upload", length: "long", env }).per_clip * floor) >= CLIPS_SAFETY_MARGIN.clip);
  // a dearer proxy raises the price by itself instead of selling at a loss
  const dear = clipsPrice(PLANS, { seconds: 3600, platform: "youtube", length: "standard", env: { ...env, STUDIO_YT_PROXY_USD_PER_GB: "20" } });
  assert.ok(dear.analysis > 300, `${dear.analysis}`);
  assert.match(downloadFormat(1080), /^bv\*\[height<=1080\]\[vcodec!\^=av01\]\+ba\[acodec=opus\]/, "no AV1; the light Opus sound first");
  assert.ok(frameUsdPerSecond({}) < frameUsdPerSecond({ STUDIO_CLIPS_FRAME_MODEL: "claude-sonnet-5-5" }), "Haiku frames by default; Sonnet costs more");
  assert.equal(clipsCharge(yt, 3, { analysis: false }), 3 * yt.per_clip, "cutting moments chosen earlier: clips only");
  assert.equal(quoteCut(PLANS, 4, 843, "standard").credits, 4 * 5);
  assert.equal(likelyClips(843, "standard"), 12); assert.equal(likelyClips(843, "minute"), 6); assert.equal(likelyClips(300, "standard"), 4);
  assert.equal(countCap(300, "standard"), 9); assert.equal(countCap(4 * 3600, "short"), CLIP_LIMITS.max_clips);

  const meta = async () => ({ id: "x", url: "u", title: "My podcast", channel: "Me", description: "", seconds: 3725, thumbnail_url: "https://img", chapters: [], replay: [] });
  const q = await quoteClips({ env, meta }, PLANS, null, { url: "https://www.youtube.com/watch?v=L_Guz73e6fw", length: "short", format: "original", count: 12 });
  assert.equal(q.tool, "clips");
  assert.deepEqual([q.options.platform, q.options.minutes, q.options.count, q.options.length, q.options.format, q.options.source.title, q.options.youtube_direct], ["youtube", 63, 12, "short", "original", "My podcast", true]);
  assert.equal(q.credits, q.options.price.analysis + 12 * q.options.price.per_clip, "reserved: reading plus every clip asked for");
  assert.equal(q.options.warning, null);
  assert.match(q.summary, /63 min · up to 12 clips/);
  // five minutes, twenty clips: warned and capped, still charged only for clips made
  const five = async () => ({ ...(await meta()), seconds: 300 });
  const q5 = await quoteClips({ env, meta: five }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", count: 20 });
  assert.equal(q5.options.count, 9);
  assert.match(q5.options.warning, /fits at most 9 30-second clips[^]*only charged for the clips we make/);
  const q7 = await quoteClips({ env, meta: five }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", count: 7 });
  assert.match(q7.options.warning, /usually holds about 4 strong 30-second clips[^]*up to 7/);
  const qm = await quoteClips({ env, meta }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", length: "minute" });
  assert.equal(qm.options.length, "minute");
  assert.equal(qm.options.count, Math.min(likelyClips(3725, "minute"), 10), "no count asked: what the video likely holds, at most 10");
  const noProxy = await quoteClips({ env: ENV, meta }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", count: 5 });
  assert.equal(noProxy.options.youtube_direct, false);
  assert.equal(noProxy.credits, noProxy.options.price.lite, "without our proxy only choosing is reserved; the cut is paid when the file comes");
  const asset = { id: "a1", kind: "video", name: "Episode 12.mp4", bytes: 2e9, probe: { duration: 1800 } };
  const qa = await quoteClips({ env: ENV }, PLANS, asset, {});
  assert.deepEqual([qa.options.platform, qa.options.source.title, qa.options.format, qa.options.length], ["upload", "Episode 12", "vertical", "standard"]);
  const code = (p: Promise<any>) => p.then(() => "ok", (e) => e.code);
  assert.equal(await code(quoteClips({ env: ENV, meta }, PLANS, null, { url: "https://www.youtube.com/shorts/abcdefghijk" })), "clip_source_too_short");
  assert.equal(await code(quoteClips({ env: ENV, meta }, PLANS, null, { url: "https://www.tiktok.com/@a/video/1" })), "unsupported_link");
  assert.equal(await code(quoteClips({ env: ENV, meta }, PLANS, null, {})), "clip_source_required");
  assert.equal(await code(quoteClips({ env: ENV, meta: async () => ({ ...(await meta()), seconds: 4 * 3600 }) }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw" })), "clip_source_too_long");
  assert.equal(await code(quoteClips({ env: ENV }, PLANS, { ...asset, probe: { duration: 60 } }, {})), "clip_source_too_short");
  assert.equal(await code(quoteClips({ env: { ...ENV, ELEVENLABS_API_KEY: "" } }, PLANS, asset, {})), "clips_unavailable");
});

test("time left: learned from past runs, by video length, clip count and length, and the runs queued ahead", () => {
  assert.deepEqual(timingFrom([]), DEFAULT_TIMING, "no runs yet: the defaults");
  const t = timingFrom([
    { timing: { video_s: 1000, fetch_s: 100, listen_s: 30, choose_s: 45, cut_s: 10 * 15 + 2 * 300, clips: 10, clip_s: 300 } },
    { timing: { video_s: 2000, fetch_s: 200, listen_s: 60, choose_s: 65, cut_s: 5 * 15 + 2 * 150, clips: 5, clip_s: 150 } },
  ]);
  assert.equal(t.runs, 2);
  assert.ok(Math.abs(t.fetch_per_s - 0.1) < 1e-9 && Math.abs(t.listen_per_s - 0.03) < 1e-9 && Math.abs(t.cut_per_s - 2) < 1e-9, JSON.stringify(t));
  const job = (o: any, extra: any = {}) => ({ options: { platform: "youtube", seconds: 900, length: "standard", count: 10, ...o }, ...extra });
  const full = remainingSeconds(job({}, { status: "queued" }), t);
  assert.ok(full > remainingSeconds(job({ count: 3 }, { status: "queued" }), t), "more clips, longer");
  assert.ok(remainingSeconds(job({ length: "minute" }, { status: "queued" }), t) > full, "longer clips, longer");
  assert.ok(remainingSeconds(job({ seconds: 3600 }, { status: "queued" }), t) > full, "a longer video, longer");
  assert.ok(remainingSeconds(job({ platform: "upload" }, { status: "queued" }), t) < full, "no download for an upload");
  // working: what is left from where it is; a cut measured on this run once clips are made
  const now = Date.parse("2026-11-01T01:00:00Z");
  const cutting = job({}, { status: "running", progress: { stage: "cutting", stage_at: "2026-11-01T00:58:00Z", done: 4, total: 10, clip_at: "2026-11-01T01:00:00Z" } });
  const left = remainingSeconds(cutting, t, now);
  assert.ok(left >= 160 && left <= 200, `6 clips at the 30 s each measured so far: ${left}`);
  // queued behind another run: its time left comes first
  const queue = [{ id: "a", status: "running", options: cutting.options, progress: cutting.progress }, { id: "b", status: "queued", options: job({}).options, progress: {} }];
  const e = etaFor({ id: "b", status: "queued", options: job({}).options }, queue as any, t, 1, now);
  assert.equal(e.ahead, 1);
  assert.ok(Math.abs(e.seconds - (left + full)) <= 1, `${e.seconds} vs ${left + full}`);
  assert.equal(etaFor({ id: "a", status: "running", options: cutting.options, progress: cutting.progress }, queue as any, t, 1, now).ahead, 0);
});

test("the Clips email: how many, what was charged and what went back, the link to the run; or the one step left", () => {
  const base = { id: "j1", tool: "clips", status: "done", credits_reserved: 125, credits_charged: 110, options: { collection_id: "col9", count: 10, source: { title: "Inside the Mind of a Master Procrastinator" } } };
  const m = jobsNotice([{ ...base, progress: { outcome: "fewer", made_count: 7, asked: 10 } }], { DASHBOARD_URL: "https://app.clone8.io" }, U);
  assert.equal(m.subject, 'Your 7 clips from "Inside the Mind of a Master Procrastinator" are ready');
  assert.match(m.text, /You asked for 10; the video had 7 clips strong enough/);
  assert.match(m.text, /Charged: 110 credits\. The other 15 credits set aside for clips not made are back/);
  assert.match(m.text, /#studio\/clips\?id=col9/);
  assert.match(m.text, /schedule them to your socials/);
  const nf = jobsNotice([{ ...base, credits_charged: 15, progress: { outcome: "needs_file", total: 8 } }], {}, U);
  assert.match(nf.subject, /^One step left/);
  assert.match(nf.text, /picked 8 moments/);
  const failed = jobsNotice([{ ...base, status: "failed", credits_charged: null, progress: {} }], {}, U);
  assert.match(failed.subject, /did not finish/);
  assert.match(failed.text, /the 125 credits it held are back/);
});

test("long sources go to Clips only: every other tool refuses them", () => {
  assert.equal(isLongSource({ bytes: 6e8, probe: { duration: 30 } }), true);
  assert.equal(isLongSource({ bytes: 1e6, probe: { duration: 601 } }), true);
  assert.equal(isLongSource({ bytes: 1e6, probe: { duration: 590 } }), false);
  assert.throws(() => quote("blueprint", { copies: 2 }, { kind: "video", probe: { duration: 2400, long_source: true } }), (e: any) => e.code === "long_source" && /40 minutes/.test(e.message));
  assert.doesNotThrow(() => quote("blueprint", { copies: 2 }, { kind: "video", probe: { duration: 30 } }));
});

// ---------------------------------------------------------------------------------------------------
// The run, against a small in-memory stand-in for Supabase
// ---------------------------------------------------------------------------------------------------
function fakeSb() {
  const t: Record<string, any[]> = { studio_assets: [], studio_collections: [], studio_customers: [{ user_id: U, plan_id: "starter", status: "active" }] };
  const files = new Map<string, Buffer>();
  const calls: Array<{ fn: string; args: any }> = [];
  const sb: any = {
    t, files, calls,
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args });
      if (fn === "studio_renew") return { data: true, error: null };
      if (fn === "studio_library_usage") return { data: [{ files: t.studio_assets.length, bytes: 0 }], error: null };
      return { data: { ok: true }, error: null };
    },
    storage: { from: (bucket: string) => ({
      download: async (k: string) => (files.has(`${bucket}/${k}`) ? { data: new Blob([new Uint8Array(files.get(`${bucket}/${k}`)!)]), error: null } : { data: null, error: { message: "not found" } }),
      upload: async (k: string, b: Buffer) => { files.set(`${bucket}/${k}`, Buffer.from(b)); return { data: {}, error: null }; },
      createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }),
      remove: async () => ({ data: [], error: null }),
    }) },
    from(table: string) {
      const rows = () => (t[table] ??= []);
      const f: Array<(r: any) => boolean> = []; let op: any = null, one = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { f.push((r) => r[k] !== v); return q; }, in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; },
        maybeSingle() { one = true; return q; }, single() { one = true; return q; },
        insert(v: any) { op = { k: "insert", v }; return q; }, update(v: any) { op = { k: "update", v }; return q; }, delete() { op = { k: "delete" }; return q; },
        then(res: any, rej: any) {
          let out: any[] = [];
          if (op?.k === "insert") { const v = { id: op.v.id ?? `id${rows().length}`, created_at: new Date().toISOString(), ...op.v }; rows().push(v); out = [v]; }
          else if (op?.k === "update") { out = rows().filter((r) => f.every((x) => x(r))); for (const r of out) Object.assign(r, op.v); }
          else if (op?.k === "delete") { t[table] = rows().filter((r) => !f.every((x) => x(r))); }
          else out = rows().filter((r) => f.every((x) => x(r)));
          return Promise.resolve({ data: one ? out[0] ?? null : out, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return sb;
}
const PRICE = { analysis: 100, per_clip: 14, lite: 12 };
const JOB = (o: any, extra: any = {}) => ({ id: "job1", user_id: U, lease_token: "tok", asset_id: null, credits_reserved: 400, progress: {}, attempts: 1, options: { collection_id: "col1", length: "standard", format: "vertical", price: PRICE, count: 5, ...o }, ...extra });
const segs = Array.from({ length: 400 }, (_, k) => ({ start: k * 3, end: k * 3 + 3, text: `words ${k} here` }));
// 900 words, two seconds apart, a sentence every 9 words (a line of ~17.5 s that closes a thought)
const WORDS = Array.from({ length: 900 }, (_, k) => ({ text: k % 9 === 8 ? `w${k}.` : `w${k}`, start: k * 2, end: k * 2 + 1.5, speaker: k < 450 ? "s1" : "s2" }));
const choose = async () => [
  { start_line: 10, end_line: 11, title: "First", hook: "h", why: "w", score: 90, tags: [] },
  { start_line: 60, end_line: 61, title: "Second", hook: "h", why: "w", score: 80, tags: [] },
];
const writeStub = async (_a: any, target: string) => { const { writeFile } = await import("node:fs/promises"); await writeFile(target, Buffer.from("mp3")); };
const META = async () => ({ id: "x", url: "u", title: "Show", channel: "C", description: "", seconds: 1800, thumbnail_url: null, chapters: [], replay: [{ start: 400, end: 430, score: 0.9 }] });

test("a YouTube run: the video fetched once, every word and laugh heard, moments chosen with the signals, cut from the file, charged for what was made", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const cut: any[] = [], got: any[] = [], seen: any[] = [];
  const deps: any = { env: ENV, plans: PLANS, log: () => {}, meta: META,
    transcript: async () => { throw new Error("captions are not needed when the sound is heard"); },
    download: async (url: string, target: string, h: number) => { got.push([url, h]); const { writeFile } = await import("node:fs/promises"); await writeFile(target, "mp4"); },
    extractAudio: async (src: any, target: string) => { assert.ok(String(src.video).endsWith("youtube.mp4"), "the sound comes from the fetched file"); await writeStub(src, target); },
    loudness: async () => Array.from({ length: 1800 }, (_, i) => (i >= 180 && i < 200 ? -10 : -24)),
    words: async () => ({ words: WORDS, events: [{ text: "laughter", start: 210, end: 213 }] }),
    choose: async (x: any) => { seen.push(x); return choose(); },
    cut: async (ctx: any, m: any) => { cut.push([m.rank, ctx.src.video, ctx.collectionId, ctx.length, m.speech?.length]); return { asset_id: `clip${m.rank}`, bytes: 1e6, seconds: m.end - m.start }; } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://www.youtube.com/watch?v=L_Guz73e6fw", seconds: 1800 }) as any), "done");
  assert.deepEqual(got, [["https://www.youtube.com/watch?v=L_Guz73e6fw", 1080]], "the whole video is fetched once (1080 lines under an hour)");
  assert.deepEqual(cut.map((c) => c[0]).sort(), [1, 2]);
  assert.ok(cut.every((c) => String(c[1]).endsWith("youtube.mp4") && c[2] === "col1" && c[3] === "standard" && c[4] > 0), "cut from that file, with who-says-what for framing");
  const x = seen[0];
  assert.ok(x.lines.some((l: any) => (l.events ?? []).includes("laughter")), "the laugh reaches the chooser");
  assert.ok(x.peaks.length >= 1 && x.peaks[0].start >= 176 && x.peaks[0].start <= 196, "so do the loud stretches");
  assert.ok(x.wanted >= 5, "asked for at least the clips wanted");
  assert.ok(sb.files.has(`studio-outputs/${U}/clips/col1/plan.txt`), "the chosen moments are saved, so a retry or an upload can reuse them");
  const done = sb.calls.find((c: any) => c.fn === "studio_complete");
  assert.equal(done.args.p_credits_charged, PRICE.analysis + 2 * PRICE.per_clip, "reading once plus the two clips made; the three not made went back");
  assert.equal(sb.t.studio_collections[0].status, "ready");
  assert.match(sb.t.studio_collections[0].note, /had 2 clips strong enough to post, of the 5 you asked for\. You were charged for 2 clips; the rest went back\./);
  const stages = sb.calls.filter((c: any) => c.fn === "studio_renew").map((c: any) => c.args.p_progress.stage);
  assert.deepEqual([...new Set(stages)], ["reading", "transcribing", "choosing", "cutting", "done"]);
  const last = sb.calls.filter((c: any) => c.fn === "studio_renew").pop().args.p_progress;
  assert.deepEqual([last.outcome, last.made_count, last.asked, last.charged], ["fewer", 2, 5, PRICE.analysis + 2 * PRICE.per_clip], "what the email reads");
  assert.ok(last.stage_at && last.clip_at, "each stage and clip has its clock, for the time left");
});

test("YouTube refusing our servers: chosen from its captions, only choosing is charged, the collection asks for the file; the upload then cuts them", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const deps: any = { env: ENV, plans: PLANS, log: () => {}, meta: META,
    transcript: async () => segs, choose,
    download: async () => { throw new LinkError("link_blocked", "YouTube refused"); },
    extractAudio: async () => { throw new Error("nothing to listen to"); },
    cut: async () => { throw new Error("must not cut"); } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://www.youtube.com/watch?v=L_Guz73e6fw", seconds: 1800 }) as any), "needs_file");
  assert.equal(sb.t.studio_collections[0].status, "needs_file");
  assert.match(sb.t.studio_collections[0].note, /picked 2 moments/);
  assert.equal(sb.calls.find((c: any) => c.fn === "studio_complete").args.p_credits_charged, PRICE.lite, "choosing only");
  // the upload: a new run that reads the saved moments and cuts from the file, charged per clip
  sb.t.studio_assets.push({ id: "upl", user_id: U, object_key: `${U}/upl.mp4`, status: "ready", probe: { duration: 1800 } });
  const seen: string[] = [];
  const deps2: any = { ...deps, choose: async () => { throw new Error("must not choose again"); }, cut: async (ctx: any, m: any) => { seen.push(ctx.src.video); return { asset_id: `c${m.rank}`, bytes: 1, seconds: 30 }; } };
  sb.calls.length = 0;
  const q = quoteCut(PLANS, 2, 1800, "standard");
  assert.equal(await runClipsJob(sb, deps2, JOB({ platform: "upload", plan_from: "col1", seconds: 1800, price: q.price, count: 2 }, { id: "job2", asset_id: "upl", credits_reserved: q.credits }) as any), "done");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((x) => x.startsWith("https://signed/")), "cut from the uploaded file");
  assert.equal(sb.calls.find((c: any) => c.fn === "studio_complete").args.p_credits_charged, q.credits);
});

test("an upload run transcribes with word times, skips a clip that fails, stops cleanly when storage is full, and charges only for what it made", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  sb.t.studio_assets.push({ id: "src", user_id: U, object_key: `${U}/src.mp4`, status: "ready", probe: { duration: 1800 } });
  const deps: any = { env: ENV, plans: PLANS, log: () => {}, extractAudio: writeStub, loudness: async () => [],
    words: async (audio: Buffer) => { assert.equal(audio.toString(), "mp3"); return WORDS; },
    choose: async () => [
      { start_line: 2, end_line: 3, title: "A", hook: "h", why: "w", score: 95, tags: [] },
      { start_line: 20, end_line: 21, title: "B", hook: "h", why: "w", score: 85, tags: [] },
      { start_line: 40, end_line: 41, title: "C", hook: "h", why: "w", score: 75, tags: [] },
    ],
    cut: async (_ctx: any, m: any) => { if (m.rank === 2) throw new ClipsError("clip_media_failed", "broken", 502, true); if (m.rank === 3) throw new ClipsError("storage_full", "Your plan stores up to 10 GB", 409); return { asset_id: `c${m.rank}`, bytes: 1, seconds: 30 }; } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "upload", seconds: 1800, count: 3 }, { asset_id: "src" }) as any), "done");
  assert.match(sb.t.studio_collections[0].note, /1 of 3 clips made: Your plan stores up to 10 GB\. You were charged for the 1 clip made; the rest went back\./);
  assert.equal(sb.t.studio_collections[0].status, "ready");
  assert.equal(sb.calls.find((c: any) => c.fn === "studio_complete").args.p_credits_charged, PRICE.analysis + PRICE.per_clip);
});

test("nothing worth clipping, or no speech: the run fails and every credit is refunded", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const deps: any = { env: ENV, plans: PLANS, log: () => {}, meta: META,
    download: async () => { throw new LinkError("link_blocked", "no"); },
    transcript: async () => segs, choose: async () => [{ start_line: 1, end_line: 9, title: "meh", hook: "h", why: "w", score: 30, tags: [] }] };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://youtu.be/L_Guz73e6fw" }) as any), "clips_none_found");
  const fail = sb.calls.find((c: any) => c.fn === "studio_fail");
  assert.deepEqual(Object.keys(fail.args).sort(), ["p_job", "p_reason", "p_retry", "p_token"], "the database function's own parameter names (a wrong one fails silently and the job runs forever)");
  assert.deepEqual([fail.args.p_reason, fail.args.p_retry], ["clips_none_found", false]);
  assert.equal(sb.t.studio_collections[0].status, "failed");
  assert.equal(sb.t.studio_collections[0].note, "No moment in this video stands out enough to be a clip.");
  assert.equal(sb.calls.filter((c: any) => c.fn === "studio_complete").length, 0, "nothing charged");
});

// ---------------------------------------------------------------------------------------------------
// The SQL: slots, tools, sizes, totals
// ---------------------------------------------------------------------------------------------------
test("migration: clips and imports sit outside the parallel limit (one each), videos up to 4 GB, exact library totals", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${U}','ann@synthetic.invalid','{}');`);
  await db.exec(await readFile("migrations/20261027000000_studio_foundation.sql", "utf8"));
  await db.exec("ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS owner_pass boolean NOT NULL DEFAULT false;");
  const sql = await readFile("migrations/20261111000000_studio_library_clips.sql", "utf8");
  await db.exec(sql); await db.exec(sql); // idempotent
  const rpc = async (fn: string, args: any[]) => (await db.query<any>(`SELECT to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})) r`, args)).rows[0].r;
  await rpc("studio_apply_subscription", [U, "cus_1", "sub_1", "starter", "month", "active", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, 1000, 1]);
  await rpc("studio_grant", [U, 1000, "in_1", true, null]);
  const big = (await db.query<any>(`INSERT INTO studio_assets(user_id,kind,name,object_key,bytes,status) VALUES($1::uuid,'video','long.mp4',$1::text||'/'||gen_random_uuid()::text||'.mp4',3000000000,'ready') RETURNING id`, [U])).rows[0].id;
  await assert.rejects(db.query(`INSERT INTO studio_assets(user_id,kind,name,object_key,bytes,status) VALUES($1::uuid,'image','big.png',$1::text||'/'||gen_random_uuid()::text||'.png',600000000,'ready')`, [U]), /bytes_check/, "pictures stay at 512 MB");
  const swap = await rpc("studio_create_job", [U, "recast", null, {}, 10]);
  assert.equal(swap.status, "queued");
  await assert.rejects(rpc("studio_create_job", [U, "recast", null, {}, 10]), /too_many_jobs/, "the one parallel slot is taken");
  const clips = await rpc("studio_create_job", [U, "clips", big, { collection_id: null }, 100]);
  assert.equal(clips.tool, "clips", "a clips run starts even with the slot taken");
  await assert.rejects(rpc("studio_create_job", [U, "clips", big, {}, 100]), /too_many_jobs/, "one clips run at a time");
  assert.equal((await rpc("studio_create_job", [U, "import", null, {}, 5])).tool, "import");
  const usage = (await db.query<any>("SELECT * FROM studio_library_usage($1)", [U])).rows[0];
  assert.deepEqual([Number(usage.files), Number(usage.bytes)], [1, 3000000000]);
  const c = (await db.query<any>(`INSERT INTO studio_collections(user_id,name,kind) VALUES($1,'Ep 1','clips') RETURNING id`, [U])).rows[0].id;
  await db.query("UPDATE studio_assets SET collection_id=$1 WHERE id=$2", [c, big]);
  await db.query("DELETE FROM studio_collections WHERE id=$1", [c]);
  assert.equal((await db.query<any>("SELECT collection_id FROM studio_assets WHERE id=$1", [big])).rows[0].collection_id, null, "deleting a collection leaves its files loose");
});
