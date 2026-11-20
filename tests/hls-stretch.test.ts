import test from "node:test";
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

test("not plain MPEG-TS: a master list, an init segment, encryption or byte ranges read the old way", () => {
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8", BASE), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\n1.m4s", BASE), null);
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

test("an fMP4 or unreadable playlist gives null (the old playlist seek is used), and is not kept", async () => {
  forgetMediaLists();
  const dir = await mkdtemp(join(tmpdir(), "hls-"));
  try {
    assert.equal(await gatherStretch(BASE, 0, 30, join(dir, "a.ts"), { fetch: fakeFetch({ list: "#EXTM3U\n#EXT-X-MAP:URI=\"i.mp4\"\n#EXTINF:4,\n1.m4s" }) }), null);
    assert.ok(await mediaList(BASE, fakeFetch()));
    forgetMediaLists();
    assert.equal(await mediaList(BASE, (async () => new Response("no", { status: 403 })) as typeof fetch), null);
    assert.ok(await mediaList(BASE, fakeFetch()), "a failed read is not cached");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
