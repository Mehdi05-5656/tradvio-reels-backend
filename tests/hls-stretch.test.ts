import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMediaPlaylist, segmentsFor, gatherStretch, mediaList, forgetMediaLists } from "../src/hls-stretch.js";

// a Twitch-like 47-hour playlist: 10-second segments, a few muted, relative names
const BASE = "https://cdn.example/vod/160p30/index-muted-X.m3u8";
const list47 = (n = 17087) => ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:10", "#EXT-X-PLAYLIST-TYPE:EVENT",
  ...Array.from({ length: n }, (_, k) => [`#EXTINF:${k === n - 1 ? "4.500" : "10.000"},`, k < 3 ? `${k}-muted.ts` : `${k}.ts`]).flat(), "#EXT-X-ENDLIST"].join("\n");

test("a media playlist: absolute segment URLs and start times summed from EXTINF", () => {
  const l = parseMediaPlaylist(list47(), BASE)!;
  assert.equal(l.segments.length, 17087);
  assert.equal(l.segments[0].url, "https://cdn.example/vod/160p30/0-muted.ts");
  assert.equal(l.segments[9600].url, "https://cdn.example/vod/160p30/9600.ts");
  assert.equal(l.segments[9600].start, 96000);
  assert.equal(l.seconds, 170864.5);
  const abs = parseMediaPlaylist("#EXTM3U\n#EXTINF:6,\nhttps://other.example/a/1.ts?sig=x\n#EXTINF:6,\n/b/2.ts", "https://cdn.example/x/i.m3u8")!;
  assert.deepEqual(abs.segments.map((s) => s.url), ["https://other.example/a/1.ts?sig=x", "https://cdn.example/b/2.ts"]);
});

test("not readable piece by piece: a master list, encryption, byte ranges or several init segments read the old way", () => {
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n#EXTINF:4,\n1.m4s", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-MAP:URI=\"a.mp4\"\n#EXTINF:4,\n1.m4s\n#EXT-X-MAP:URI=\"b.mp4\"\n#EXTINF:4,\n2.m4s", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:4,\n1.ts", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-BYTERANGE:100@0\n#EXTINF:4,\n1.ts", BASE), null);
  assert.equal(parseMediaPlaylist("not a playlist", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-ENDLIST", BASE), null);
  assert.ok(parseMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\n1.ts", BASE));
});

test("the segments covering a stretch, and how far into the first it begins: early, past the 26.5-hour wrap, at the end", () => {
  const l = parseMediaPlaylist(list47(), BASE)!;
  const early = segmentsFor(l, 3687, 150);
  assert.equal(early.segments[0].url.endsWith("/368.ts"), true); assert.equal(early.segments.length, 16); assert.equal(early.offset, 7);
  // the window that sat past the wrap on the Nov 20 2026 run (chat peak at 146,002 s, window from 145,957 s)
  const late = segmentsFor(l, 145957, 150);
  assert.equal(late.segments[0].start, 145950); assert.equal(late.offset, 7); assert.equal(late.segments.length, 16);
  // a stretch on a segment boundary takes no segment before it
  const edge = segmentsFor(l, 96000, 20);
  assert.deepEqual(edge.segments.map((s) => s.start), [96000, 96010]); assert.equal(edge.offset, 0);
  // the last, short segment; nothing past the end
  assert.deepEqual(segmentsFor(l, 170862, 30).segments.map((s) => s.start), [170860]);
  assert.equal(segmentsFor(l, 171000, 30).segments.length, 0);
  // a still: the one segment holding the moment
  assert.deepEqual(segmentsFor(l, 146003.2, 0.5).segments.map((s) => s.start), [146000]);
});

const fakeFetch = (o: { list?: string; fail?: Record<string, number>; calls?: string[] } = {}) => (async (url: any) => {
  const u = String(url); o.calls?.push(u);
  if (u.endsWith(".m3u8")) return new Response(o.list ?? list47(40), { status: 200 });
  const name = u.split("/").pop()!;
  if (o.fail && (o.fail[name] ?? 0) > 0) { o.fail[name]--; return new Response("no", { status: 503 }); }
  if (o.fail && o.fail[name] === -1) return new Response("gone", { status: 404 });
  return new Response(`<${name}>`, { status: 200 });
}) as typeof fetch;

test("a stretch's segments are fetched once each, written in order, and the playlist is read once a run", async () => {
  forgetMediaLists();
  const dir = await mkdtemp(join(tmpdir(), "hls-")); const calls: string[] = [];
  try {
    const f = fakeFetch({ calls });
    const target = join(dir, "a.ts");
    const got = await gatherStretch(BASE, 95, 150, target, { fetch: f, parallel: 3 });
    assert.deepEqual(got, { offset: 5, segments: 16 });
    assert.equal(await readFile(target, "utf8"), Array.from({ length: 16 }, (_, k) => `<${k + 9}.ts>`).join(""));
    await gatherStretch(BASE, 300, 20, join(dir, "b.ts"), { fetch: f });
    assert.equal(calls.filter((c) => c.endsWith(".m3u8")).length, 1);
    assert.equal(calls.filter((c) => c.endsWith("/10.ts")).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a segment that fails twice is retried; one that is gone fails the stretch and leaves no file", async () => {
  forgetMediaLists();
  const dir = await mkdtemp(join(tmpdir(), "hls-"));
  try {
    const target = join(dir, "a.ts");
    assert.ok(await gatherStretch(BASE, 0, 30, target, { fetch: fakeFetch({ fail: { "1-muted.ts": 2 } }) }));
    assert.equal(await readFile(target, "utf8"), "<0-muted.ts><1-muted.ts><2-muted.ts>");
    forgetMediaLists();
    await assert.rejects(gatherStretch(BASE, 0, 30, join(dir, "b.ts"), { fetch: fakeFetch({ fail: { "2-muted.ts": -1 } }) }), /segment 2 of the recording could not be read \(404\)/);
    await assert.rejects(stat(join(dir, "b.ts")));
    forgetMediaLists();
    await assert.rejects(gatherStretch(BASE, 9999, 30, join(dir, "c.ts"), { fetch: fakeFetch() }), /past the end of the recording/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an encrypted or unreadable playlist gives null (the old playlist seek is used), and is not kept", async () => {
  forgetMediaLists();
  const dir = await mkdtemp(join(tmpdir(), "hls-"));
  try {
    assert.equal(await gatherStretch(BASE, 0, 30, join(dir, "a.ts"), { fetch: fakeFetch({ list: "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:4,\n1.ts" }) }), null);
    assert.ok(await mediaList(BASE, fakeFetch()));
    forgetMediaLists();
    assert.equal(await mediaList(BASE, (async () => new Response("no", { status: 403 })) as typeof fetch), null);
    assert.ok(await mediaList(BASE, fakeFetch()), "a failed read is not cached");
  } finally { await rm(dir, { recursive: true, force: true }); }
});


// Twitch's fragmented-MP4 recordings (a 16-hour one on Nov 20 2026: #EXT-X-MAP init-0.mp4, 0.mp4 ... 5734.mp4)
test("a fragmented-MP4 playlist: its init segment kept, the fragments timed like any other", () => {
  const text = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:10", "#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-TWITCH-TOTAL-SECS:30.000", '#EXT-X-MAP:URI="init-0.mp4"',
    "#EXTINF:10.000,", "0.mp4", "#EXTINF:10.000,", "1.mp4", "#EXTINF:10.000,", "2.mp4", "#EXT-X-ENDLIST"].join("\n");
  const l = parseMediaPlaylist(text, "https://cdn.example/vod/160p30/index-muted-X.m3u8")!;
  assert.equal(l.init, "https://cdn.example/vod/160p30/init-0.mp4");
  assert.equal(l.segments.length, 3);
  assert.equal(l.segments[2].start, 20);
  assert.equal(l.seconds, 30);
  assert.equal(parseMediaPlaylist(list47(), BASE)!.init, undefined);
});

test("gathering a fragmented-MP4 stretch writes the init segment first, then the covering fragments in order", async () => {
  forgetMediaLists();
  const text = ["#EXTM3U", '#EXT-X-MAP:URI="init-0.mp4"', ...Array.from({ length: 6 }, (_, k) => [`#EXTINF:10.000,`, `${k}.mp4`]).flat(), "#EXT-X-ENDLIST"].join("\n");
  const asked: string[] = [];
  const f: any = async (u: string) => { asked.push(u.split("/").pop()!); return new Response(u.endsWith(".m3u8") ? text : `[${u.split("/").pop()}]`); };
  const dir = await mkdtemp(join(tmpdir(), "hls-fmp4-"));
  try {
    const out = join(dir, "s.src.ts");
    const got = await gatherStretch("https://cdn.example/v/160p30/index.m3u8", 25, 20, out, { fetch: f });
    assert.deepEqual(got, { offset: 5, segments: 3 });
    assert.equal(String(await readFile(out)), "[init-0.mp4][2.mp4][3.mp4][4.mp4]");
  } finally { await rm(dir, { recursive: true, force: true }); forgetMediaLists(); }
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("a real fragmented-MP4 recording: a stretch read piece by piece decodes at the right length", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  forgetMediaLists();
  const dir = await mkdtemp(join(tmpdir(), "hls-fmp4-real-"));
  try {
    // 60 s of picture and sound cut into 10-second fragmented-MP4 pieces with one init segment, as Twitch serves them
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x90:r=30:d=60", "-f", "lavfi", "-i", "sine=f=440:d=60", "-c:v", "libx264", "-g", "30", "-c:a", "aac", "-shortest",
      "-f", "hls", "-hls_time", "10", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init-0.mp4", "-hls_segment_filename", join(dir, "%d.mp4"), join(dir, "index.m3u8")]);
    assert.equal(g.status, 0, String(g.stderr));
    const local: any = async (u: string) => new Response(await readFile(join(dir, u.split("/").pop()!)));
    const out = join(dir, "w.src.ts");
    const got = (await gatherStretch("https://cdn.example/v/160p30/index.m3u8", 32, 15, out, { fetch: local }))!;
    assert.equal(got.segments, 2);
    assert.equal(got.offset, 2);
    const mp3 = join(dir, "w.mp3");
    const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", got.offset.toFixed(3), "-i", out, "-t", "15", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", mp3]);
    assert.equal(r.status, 0, String(r.stderr));
    const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]);
    assert.ok(Math.abs(Number(String(p.stdout).trim()) - 15) < 0.3, `duration ${String(p.stdout).trim()}`);
  } finally { await rm(dir, { recursive: true, force: true }); forgetMediaLists(); }
});
