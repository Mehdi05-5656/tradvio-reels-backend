// YouTube on the Clips hub (owner, Nov 21 2026): not live streams, the newest long videos of the creators clippers work
// from (streamers who post their streams, the biggest US YouTubers, the podcasts with clipping campaigns), freshest and
// most watched first. The list is src/data/youtube-creators.json, each channel checked by hand; their videos come from
// YouTube's public feeds (no key), read again every three hours.
import data from "./data/youtube-creators.json" with { type: "json" };

export type YtGroup = "streamers" | "youtubers" | "podcasts";
export type YtCreator = { name: string; group: YtGroup; channel_id: string; handle: string | null; avatar: string | null };
export type YtVideo = { id: string; url: string; title: string; channel: string; channel_id: string; group: YtGroup; avatar: string | null; published: string; views: number | null; thumbnail: string };
export type YtFeed = { creators: Array<YtCreator & { latest: string | null; videos: number }>; videos: YtVideo[]; fresh_at: string };
export const YT_CREATORS = (data as { creators: YtCreator[] }).creators;
export const YT_FEED = { ttl_ms: 3 * 3600_000, keep_days: 14, max_videos: 90, per_channel: 3, parallel: 6 };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** One channel's feed: its long videos (a link to /shorts/ is left out), newest first. */
export function parseFeed(xml: string, c: YtCreator): YtVideo[] {
  const out: YtVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(e)?.[1];
    const link = /<link rel="alternate" href="([^"]+)"/.exec(e)?.[1] ?? "";
    if (!id || /\/shorts\//.test(link)) continue;
    const title = unescape(/<title>([^<]*)<\/title>/.exec(e)?.[1] ?? "").slice(0, 200);
    const published = /<published>([^<]+)<\/published>/.exec(e)?.[1] ?? "";
    const views = /<media:statistics views="(\d+)"/.exec(e)?.[1];
    out.push({ id, url: `https://www.youtube.com/watch?v=${id}`, title, channel: c.name, channel_id: c.channel_id, group: c.group, avatar: c.avatar, published, views: views != null ? Number(views) : null, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
  }
  return out;
}
/** How hot a video is now: its views over the hours it has been up (two hours' grace), so a fresh hit beats an old one. */
export const heat = (v: Pick<YtVideo, "views" | "published">, now = Date.now()) => (v.views ?? 0) / Math.pow(Math.max(0, (now - Date.parse(v.published)) / 3600_000) + 2, 1.15);

let cache: { at: number; feed: Promise<YtFeed> } | null = null;
export const resetYoutubeFeed = () => { cache = null; };
export function youtubeFeed(deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<YtFeed> {
  const now = deps.now?.() ?? Date.now();
  if (cache && now - cache.at < YT_FEED.ttl_ms) return cache.feed;
  const f = deps.fetch ?? fetch;
  const feed = (async (): Promise<YtFeed> => {
    const per: YtVideo[][] = new Array(YT_CREATORS.length).fill(null).map(() => []);
    let next = 0;
    await Promise.all(Array.from({ length: YT_FEED.parallel }, async () => {
      for (let k = next++; k < YT_CREATORS.length; k = next++) {
        const c = YT_CREATORS[k];
        const r = await f(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.channel_id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
        if (r && r.ok) per[k] = parseFeed(await r.text().catch(() => ""), c);
      }
    }));
    const fresh = per.flat().filter((v) => now - Date.parse(v.published) < YT_FEED.keep_days * 86400_000);
    if (!fresh.length) throw new Error("no YouTube feed answered");
    // hottest first, at most three a channel (one streamer's week of uploads must not fill the page)
    const per3 = new Map<string, number>();
    const videos = fresh.sort((a, b) => heat(b, now) - heat(a, now)).filter((v) => { const n = per3.get(v.channel_id) ?? 0; per3.set(v.channel_id, n + 1); return n < YT_FEED.per_channel; }).slice(0, YT_FEED.max_videos);
    const creators = YT_CREATORS.map((c, k) => ({ ...c, latest: per[k][0]?.published ?? null, videos: per[k].length }));
    return { creators, videos, fresh_at: new Date(now).toISOString() };
  })();
  cache = { at: now, feed };
  feed.catch(() => { if (cache?.feed === feed) cache = null; });
  return feed;
}
