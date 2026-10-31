import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  linesFromSegments, linesFromWords, windows, finalizeMoments, buildClipFilter, shotsFrom, planShots, quoteClips, clipsCostUsd, clipsCredits,
  maxClipsFor, parseMeta, parseTranscript, isLongSource, runClipsJob, inputArgs, chooseMessage, CLIP_LIMITS, ClipsError, quoteCut,
} from "../src/studio-clips.js";
import { parseStreams, LinkError } from "../src/studio-youtube.js";
import { quote, PLANS } from "../src/studio.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV = { ANTHROPIC_API_KEY: "k", SCRAPECREATORS_API_KEY: "k", ELEVENLABS_API_KEY: "k" };

test("caption segments become short lines; timed words become sentences", () => {
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
});

test("windows cover the whole transcript with overlap", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => ({ i, start: i * 6, end: i * 6 + 6, text: `line ${i}` }));
  const w = windows(lines);
  assert.equal(w.length, 3, "two hours in 40-minute windows, the short tail folded into the last");
  assert.equal(w[0][0].i, 0);
  assert.equal(w[w.length - 1][w[w.length - 1].length - 1].i, 1199, "nothing at the end is left out");
  assert.ok(w[1][0].start < w[0][w[0].length - 1].end, "windows overlap so a moment on a seam is seen whole");
});

test("picks become clean clips: inside the length range, no overlaps, strong ones only, best first, on word boundaries", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ i, start: i * 5, end: i * 5 + 5, text: `sentence ${i}.`, w0: i * 2, w1: i * 2 + 1 }));
  const words = Array.from({ length: 120 }, (_, k) => ({ text: `w${k}`, start: k * 2.5 + 0.2, end: k * 2.5 + 2.2, speaker: null }));
  const raw = [
    { start_line: 2, end_line: 7, title: "Good one", hook: "h", why: "w", score: 88, tags: ["Pricing"] },       // 30 s
    { start_line: 4, end_line: 9, title: "Overlaps the good one", hook: "h", why: "w", score: 70, tags: [] },   // overlaps heavily
    { start_line: 20, end_line: 21, title: "Too short, grows to fit", hook: "h", why: "w", score: 75, tags: [] }, // 10 s -> extended
    { start_line: 30, end_line: 50, title: "Too long, trimmed", hook: "h", why: "w", score: 92, tags: [] },     // 105 s -> trimmed
    { start_line: 55, end_line: 58, title: "Weak", hook: "h", why: "w", score: 40, tags: [] },
    { start_line: 999, end_line: 1000, title: "Bad lines", hook: "h", why: "w", score: 95, tags: [] },
  ];
  const ms = finalizeMoments(raw as any, lines, words, "standard", 10);
  assert.deepEqual(ms.map((m) => m.title), ["Too long, trimmed", "Good one", "Too short, grows to fit"]);
  assert.deepEqual(ms.map((m) => m.rank), [1, 2, 3]);
  for (const m of ms) { const d = m.end - m.start; assert.ok(d >= 20 && d <= 50, `${m.title}: ${d}`); }
  const good = ms.find((m) => m.title === "Good one")!;
  assert.equal(good.start, words[4].start - 0.12, "starts just before the first word");
  assert.equal(good.end, words[15].end + 0.3, "ends just after the last word");
  assert.deepEqual(good.tags, ["pricing"]);
  assert.equal(finalizeMoments(raw as any, lines, words, "standard", 1).length, 1, "the cap holds");
});

test("framing: shots from cuts, crops for one person, blurred fill for two, the filter for each case", () => {
  const shots = shotsFrom([0.3, 5, 5.4, 12], 30);
  assert.deepEqual(shots.map((s) => [s.start, s.end]), [[0, 5], [5, 12], [12, 30]], "slivers under 0.8 s are folded in");
  const plan = planShots(shots, [{ subject: "one_person", x: 0.7 }, { subject: "two_people", x: 0.5 }, { subject: "one_person", x: 0.72 }]);
  assert.deepEqual(plan.map((p) => p.mode), ["crop", "fit", "crop"]);
  const mixed = buildClipFilter({ w: 1920, h: 1080, format: "vertical", shots: plan, fps: 60 });
  assert.match(mixed, /^\[0:v\]split=3/);
  assert.match(mixed, /crop=608:1080:'if\(lt\(t,5\.000\),1040,if\(lt\(t,12\.000\),1040,1078\)\)':0/);
  assert.match(mixed, /enable='between\(t,5\.000,11\.999\)'/);
  assert.match(mixed, /fps=30/, "60 fps sources come down to 30");
  const crop = buildClipFilter({ w: 1920, h: 1080, format: "vertical", shots: [{ start: 0, end: 30, mode: "crop", x: 0.5 }], fps: 30 });
  assert.equal(crop, "[0:v]crop=608:1080:'656':0,scale=720:1280,setsar=1,format=yuv420p[v]");
  assert.match(buildClipFilter({ w: 1280, h: 720, format: "vertical", shots: [{ start: 0, end: 9, mode: "fit", x: 0.5 }], fps: 25 }), /^\[0:v\]split=2\[a\]\[b\];.*boxblur/);
  assert.match(buildClipFilter({ w: 1080, h: 1920, format: "vertical", shots: [], fps: 30 }), /^\[0:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280/, "a vertical source is only resized");
  assert.equal(buildClipFilter({ w: 1920, h: 1080, format: "original", shots: [], fps: 30 }), "[0:v]scale='min(1280,iw)':-2,setsar=1,format=yuv420p[v]");
  // edges: a face at the very edge still gives a crop inside the picture
  assert.match(buildClipFilter({ w: 1920, h: 1080, format: "vertical", shots: [{ start: 0, end: 5, mode: "crop", x: 0.99 }], fps: 30 }), /'1312'/);
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

test("prices: by length and clips made; YouTube through a proxy pays for the bytes; the quote is the most a run can cost", async () => {
  assert.equal(maxClipsFor(3600), 48); assert.equal(maxClipsFor(150), 3); assert.equal(maxClipsFor(4 * 3600), CLIP_LIMITS.max_clips);
  const up = clipsCostUsd({ seconds: 3600, platform: "upload", clips: 30, clipSeconds: 32, transcribe: true, choose: true, env: {} });
  assert.ok(up > 0.4 && up < 0.6, `an hour's upload with 30 clips costs about half a dollar (${up})`);
  const ytNoProxy = clipsCostUsd({ seconds: 3600, platform: "youtube", clips: 30, clipSeconds: 32, transcribe: false, choose: true, env: {} });
  const ytProxy = clipsCostUsd({ seconds: 3600, platform: "youtube", clips: 30, clipSeconds: 32, transcribe: false, choose: true, env: { STUDIO_YT_PROXY: "http://p", STUDIO_YT_PROXY_USD_PER_GB: "3" } });
  assert.ok(ytProxy > ytNoProxy + 0.4, "the proxy's bytes are priced in");
  assert.ok(clipsCredits(up, PLANS) > clipsCredits(0.01, PLANS) && clipsCredits(0.0001, PLANS) === CLIP_LIMITS.min_credits);
  assert.ok(quoteCut(PLANS, 30, 3600) < clipsCredits(up, PLANS), "cutting moments already chosen costs less than a full run");

  const meta = async () => ({ id: "x", url: "u", title: "My podcast", channel: "Me", description: "", seconds: 3725, thumbnail_url: "https://img", chapters: [], replay: [] });
  const q = await quoteClips({ env: ENV, meta }, PLANS, null, { url: "https://www.youtube.com/watch?v=L_Guz73e6fw", length: "short", format: "original" });
  assert.equal(q.tool, "clips");
  assert.deepEqual([q.options.platform, q.options.minutes, q.options.max_clips, q.options.length, q.options.format, q.options.source.title], ["youtube", 63, 49, "short", "original", "My podcast"]);
  assert.match(q.summary, /63 min · up to 49 clips/);
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
const JOB = (o: any, extra: any = {}) => ({ id: "job1", user_id: U, lease_token: "tok", asset_id: null, credits_reserved: 400, progress: {}, attempts: 1, options: { collection_id: "col1", length: "standard", format: "vertical", ...o }, ...extra });
const segs = Array.from({ length: 400 }, (_, k) => ({ start: k * 3, end: k * 3 + 3, text: `words ${k} here` }));
const choose = async () => [
  { start_line: 10, end_line: 20, title: "First", hook: "h", why: "w", score: 90, tags: [] },
  { start_line: 60, end_line: 70, title: "Second", hook: "h", why: "w", score: 80, tags: [] },
];

test("a YouTube run: transcript in, moments chosen and saved, two clips cut into the collection, charged for what was made", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const cut: any[] = [];
  const deps: any = { env: ENV, plans: PLANS, log: () => {},
    meta: async () => ({ id: "x", url: "u", title: "Show", channel: "C", description: "", seconds: 1200, thumbnail_url: null, chapters: [], replay: [] }),
    transcript: async () => segs, choose,
    streams: async () => ({ video: "https://v", audio: "https://a", proxy: null, width: 1920, height: 1080, fps: 30, seconds: 1200 }),
    cut: async (ctx: any, m: any) => { cut.push([m.rank, ctx.src.video, ctx.collectionId]); sb.t.studio_assets.push({ id: `clip${m.rank}`, collection_id: ctx.collectionId }); return { asset_id: `clip${m.rank}`, bytes: 1e6, seconds: m.end - m.start }; } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://www.youtube.com/watch?v=L_Guz73e6fw", seconds: 1200 }) as any), "done");
  assert.deepEqual(cut.map((c) => c[0]).sort(), [1, 2]);
  assert.ok(cut.every((c) => c[1] === "https://v" && c[2] === "col1"));
  assert.ok(sb.files.has(`studio-outputs/${U}/clips/col1/plan.txt`), "the chosen moments are saved, so a retry or an upload can reuse them");
  const done = sb.calls.find((c: any) => c.fn === "studio_complete");
  assert.ok(done.args.p_credits_charged >= CLIP_LIMITS.min_credits && done.args.p_credits_charged <= 400);
  assert.equal(sb.t.studio_collections[0].status, "ready");
  const stages = sb.calls.filter((c: any) => c.fn === "studio_renew").map((c: any) => c.args.p_progress.stage);
  assert.deepEqual([...new Set(stages)], ["reading", "choosing", "cutting"]);
});

test("YouTube refusing our servers: the moments are kept, only choosing is charged, the collection asks for the file; the upload then cuts them", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const deps: any = { env: ENV, plans: PLANS, log: () => {},
    meta: async () => ({ id: "x", url: "u", title: "Show", channel: "C", description: "", seconds: 1200, thumbnail_url: null, chapters: [], replay: [] }),
    transcript: async () => segs, choose,
    streams: async () => { throw new LinkError("link_blocked", "YouTube refused"); },
    cut: async () => { throw new Error("must not cut"); } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://www.youtube.com/watch?v=L_Guz73e6fw", seconds: 1200 }) as any), "needs_file");
  assert.equal(sb.t.studio_collections[0].status, "needs_file");
  assert.match(sb.t.studio_collections[0].note, /picked 2 moments/);
  const charged = sb.calls.find((c: any) => c.fn === "studio_complete").args.p_credits_charged;
  assert.ok(charged >= 1 && charged < 20, `choosing only (${charged})`);
  // the upload: a new run that reads the saved moments and cuts from the file
  sb.t.studio_assets.push({ id: "upl", user_id: U, object_key: `${U}/upl.mp4`, status: "ready", probe: { duration: 1200 } });
  const seen: string[] = [];
  const deps2: any = { ...deps, choose: async () => { throw new Error("must not choose again"); }, cut: async (ctx: any, m: any) => { seen.push(ctx.src.video); return { asset_id: `c${m.rank}`, bytes: 1, seconds: 30 }; } };
  sb.calls.length = 0;
  assert.equal(await runClipsJob(sb, deps2, JOB({ platform: "upload", plan_from: "col1", seconds: 1200 }, { id: "job2", asset_id: "upl", credits_reserved: quoteCut(PLANS, 2, 1200) }) as any), "done");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.startsWith("https://signed/")), "cut from the uploaded file");
});

test("an upload run transcribes the sound with word times, skips a clip that fails, and stops cleanly when storage is full", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  sb.t.studio_assets.push({ id: "src", user_id: U, object_key: `${U}/src.mp4`, status: "ready", probe: { duration: 1800 } });
  const words = Array.from({ length: 900 }, (_, k) => ({ text: k % 9 === 8 ? `w${k}.` : `w${k}`, start: k * 2, end: k * 2 + 1.5, speaker: "s1" }));
  let n = 0;
  const deps: any = { env: ENV, plans: PLANS, log: () => {},
    extractAudio: async (_src: any, target: string) => { const { writeFile } = await import("node:fs/promises"); await writeFile(target, Buffer.from("mp3")); },
    words: async (audio: Buffer) => { assert.equal(audio.toString(), "mp3"); return words; },
    choose: async () => [
      { start_line: 2, end_line: 3, title: "A", hook: "h", why: "w", score: 95, tags: [] },
      { start_line: 20, end_line: 21, title: "B", hook: "h", why: "w", score: 85, tags: [] },
      { start_line: 40, end_line: 41, title: "C", hook: "h", why: "w", score: 75, tags: [] },
    ],
    cut: async (_ctx: any, m: any) => { n++; if (m.rank === 2) throw new ClipsError("clip_media_failed", "broken", 502, true); if (m.rank === 3) throw new ClipsError("storage_full", "Your plan stores up to 10 GB", 409); return { asset_id: `c${m.rank}`, bytes: 1, seconds: 30 }; } };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "upload", seconds: 1800 }, { asset_id: "src" }) as any), "done");
  assert.match(sb.t.studio_collections[0].note, /1 of 3 clips made: Your plan stores up to 10 GB/);
  assert.equal(sb.t.studio_collections[0].status, "ready");
});

test("nothing worth clipping, or no speech: the run fails and every credit is refunded", async () => {
  const sb = fakeSb(); sb.t.studio_collections.push({ id: "col1", user_id: U, status: "processing" });
  const deps: any = { env: ENV, plans: PLANS, log: () => {},
    meta: async () => ({ id: "x", url: "u", title: "Show", channel: "C", description: "", seconds: 1200, thumbnail_url: null, chapters: [], replay: [] }),
    transcript: async () => segs, choose: async () => [{ start_line: 1, end_line: 9, title: "meh", hook: "h", why: "w", score: 30, tags: [] }] };
  assert.equal(await runClipsJob(sb, deps, JOB({ platform: "youtube", url: "https://youtu.be/L_Guz73e6fw" }) as any), "clips_none_found");
  const fail = sb.calls.find((c: any) => c.fn === "studio_fail");
  assert.deepEqual(Object.keys(fail.args).sort(), ["p_job", "p_reason", "p_retry", "p_token"], "the database function's own parameter names (a wrong one fails silently and the job runs forever)");
  assert.deepEqual([fail.args.p_reason, fail.args.p_retry], ["clips_none_found", false]);
  assert.equal(sb.t.studio_collections[0].status, "failed");
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
