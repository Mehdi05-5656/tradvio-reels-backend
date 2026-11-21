import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, heat, youtubeFeed, resetYoutubeFeed, YT_CREATORS, YT_FEED } from "../src/youtube-feed.js";

const now = Date.parse("2026-11-21T20:00:00Z");
const entry = (id: string, title: string, published: string, views: number, short = false) => `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><link rel="alternate" href="https://www.youtube.com/${short ? `shorts/${id}` : `watch?v=${id}`}"/><published>${published}</published><media:group><media:statistics views="${views}"/></media:group></entry>`;
const c = { name: "Kai Cenat", group: "streamers" as const, channel_id: "UCvCfpQXRXdJdL07pzTIA6Cw", handle: "KaiCenatLive", avatar: "https://yt3/x.jpg" };

test("a channel's feed: long videos only, titles unescaped, views kept", () => {
  const v = parseFeed(`<feed>${entry("aaaaaaaaaaa", "Beating GTA 6 &amp; more", "2026-11-20T20:00:00+00:00", 1000)}${entry("bbbbbbbbbbb", "a short", "2026-11-21T10:00:00+00:00", 9, true)}</feed>`, c);
  assert.equal(v.length, 1); assert.equal(v[0].title, "Beating GTA 6 & more"); assert.equal(v[0].url, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
  assert.equal(v[0].views, 1000); assert.equal(v[0].channel, "Kai Cenat"); assert.equal(v[0].thumbnail, "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg");
  // a fresh video with fewer views can be hotter than an old one with more
  assert.ok(heat({ views: 300_000, published: "2026-11-21T14:00:00Z" }, now) > heat({ views: 2_000_000, published: "2026-11-12T14:00:00Z" }, now));
});

test("the feed: every channel read once, kept three hours, hottest first, three a channel at most, nothing older than two weeks", async () => {
  resetYoutubeFeed();
  let calls = 0;
  const f = (async (url: any) => { calls++; const id = String(url).split("channel_id=")[1];
    const k = YT_CREATORS.findIndex((x) => x.channel_id === id);
    const rows = Array.from({ length: 5 }, (_, i) => entry(`${String(k).padStart(5, "0")}v${i}xxxx`.slice(0, 11), `video ${i}`, new Date(now - (i + 1) * 3600_000 * (k + 1)).toISOString(), 1000 * (k + 1)));
    return new Response(`<feed>${rows.join("")}${entry("oldoldoldol", "old", "2026-10-01T00:00:00Z", 9e9)}</feed>`); }) as typeof fetch;
  const feed = await youtubeFeed({ fetch: f, now: () => now });
  assert.equal(calls, YT_CREATORS.length);
  assert.ok(feed.videos.every((v) => v.title !== "old"), "a video older than two weeks is left out");
  const per = new Map<string, number>(); for (const v of feed.videos) per.set(v.channel_id, (per.get(v.channel_id) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= YT_FEED.per_channel));
  for (let i = 1; i < feed.videos.length; i++) assert.ok(heat(feed.videos[i - 1], now) >= heat(feed.videos[i], now));
  assert.equal(feed.creators.length, YT_CREATORS.length);
  await youtubeFeed({ fetch: f, now: () => now + 3600_000 }); assert.equal(calls, YT_CREATORS.length, "kept for three hours");
  // nothing answering is an error, not an empty page, and is not kept
  resetYoutubeFeed();
  await assert.rejects(youtubeFeed({ fetch: (async () => new Response("no", { status: 500 })) as typeof fetch, now: () => now }));
  resetYoutubeFeed();
});
