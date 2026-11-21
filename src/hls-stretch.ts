// A stretch of an HLS recording read from its own segments, not by seeking the whole playlist (Nov 20 2026).
//
// Why: MPEG-TS timestamps are 33 bits at 90 kHz, so they wrap to zero every 95,443.7 s (26.5 hours). ffmpeg's HLS reader
// picks the right segment from the playlist, then throws packets away until their timestamp reaches the target; past the
// wrap the timestamps are small again, so it never gets there. It reads to the end of the recording or times out, and a
// long stream's whole second half cannot be heard, seen or cut. The first customer run on a 47-hour stream (IShowSpeed,
// Nov 20 2026) lost 35 of its moments, its second-best hour and the chat's four biggest peaks to it: 2 clips of 10 in
// 66 minutes. Taking only the segments that cover the stretch, joined into a short local file, sidesteps it: ffmpeg
// mends a wrap or a jump inside a continuous file, and seeks at most one segment into it. Measured on that recording:
// 150 s from hour 40.5 in 5 s (the playlist seek: nothing after 300 s); sound, copy and stills exact on both sides of
// the wrap.
//
// MPEG-TS playlists, and fragmented-MP4 ones (one init segment, #EXT-X-MAP): those are read the same way, the init
// segment first and then the covering fragments, joined into a short local .mp4. Twitch serves some recordings this way
// (a 16-hour one on Nov 20 2026); the old whole-playlist seek on Render's ffmpeg 5.1 came back empty on every window and
// hour of it, while the fragments read this way decode exactly. Encryption, byte ranges or several init segments return
// null, and the caller reads the playlist the old way.
import { open, rm } from "node:fs/promises";

export type Segment = { url: string; start: number; dur: number };
export type MediaList = { segments: Segment[]; seconds: number; /** a fragmented-MP4 playlist's init segment (#EXT-X-MAP), absolute */ init?: string };

/** A media playlist's segments with their start times (the sum of EXTINF before each), URLs made absolute against the
 *  playlist. null when it is neither plain MPEG-TS nor fragmented MP4 with one init segment (a master list, encryption, byte ranges). */
export function parseMediaPlaylist(text: string, base: string): MediaList | null {
  if (!/^#EXTM3U/.test(text.trimStart())) return null;
  if (/#EXT-X-STREAM-INF|#EXT-X-BYTERANGE/i.test(text)) return null;
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(text)) return null;
  // fragmented MP4: exactly one init segment, given by URI, with no byte range
  const maps = [...text.matchAll(/^#EXT-X-MAP:(.*)$/gim)].map((m) => m[1]);
  let init: string | undefined;
  if (maps.length > 1) return null;
  if (maps.length === 1) {
    if (/BYTERANGE=/i.test(maps[0])) return null;
    const uri = maps[0].match(/URI="([^"]+)"/i)?.[1];
    if (!uri) return null;
    try { init = new URL(uri, base).toString(); } catch { return null; }
  }
  const segments: Segment[] = []; let t = 0, dur: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) { dur = Number(line.slice(8).split(",")[0]); if (!Number.isFinite(dur) || dur < 0) return null; continue; }
    if (!line || line.startsWith("#")) continue;
    if (dur == null) return null;
    let url: string; try { url = new URL(line, base).toString(); } catch { return null; }
    segments.push({ url, start: t, dur }); t += dur; dur = null;
  }
  return segments.length ? { segments, seconds: t, ...(init ? { init } : {}) } : null;
}

/** The segments that cover [start, start + seconds) and how far into the first one the stretch begins. */
export function segmentsFor(list: MediaList, start: number, seconds: number): { segments: Segment[]; offset: number } {
  const from = Math.max(0, start), to = from + Math.max(0, seconds);
  const segs = list.segments.filter((s) => s.start + s.dur > from + 1e-6 && s.start < to - 1e-6);
  return { segments: segs, offset: segs.length ? Math.max(0, from - segs[0].start) : 0 };
}

type Fetch = typeof fetch;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// a run asks for the same playlist dozens of times (every window, still and cut): read it once (a 47-hour playlist is
// 17,000 lines); a list is kept 30 minutes, the eight most recent
const lists = new Map<string, { at: number; list: Promise<MediaList | null> }>();
const LIST_TTL_MS = 30 * 60_000, LIST_MAX = 8;

/** The playlist read once and kept (null when it cannot be read this way; the caller falls back). */
export function mediaList(url: string, f: Fetch = fetch): Promise<MediaList | null> {
  const now = Date.now();
  const had = lists.get(url);
  if (had && now - had.at < LIST_TTL_MS) return had.list;
  const list = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await f(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (r && r.ok) return parseMediaPlaylist(await r.text().catch(() => ""), url);
      if (r && r.status >= 400 && r.status < 500) return null;
      await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
    }
    return null;
  })();
  lists.set(url, { at: now, list });
  list.then((l) => { if (!l) lists.delete(url); }).catch(() => lists.delete(url));
  while (lists.size > LIST_MAX) lists.delete(lists.keys().next().value!);
  return list;
}
export const forgetMediaLists = () => lists.clear();

async function segmentBytes(f: Fetch, s: Segment, k: number): Promise<Uint8Array> {
  let last = "no answer";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await f(s.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).catch((e) => { last = String(e?.name ?? e); return null; });
    if (r && r.ok) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length) return b; last = "empty"; }
    else if (r) { last = String(r.status); if (r.status === 404 || r.status === 410) break; }
    await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
  }
  throw new Error(`segment ${k} of the recording could not be read (${last})`);
}

/** The segments covering the stretch, fetched a few at a time and written in order to `target` (a .ts file; at most
 *  `parallel` segments are held at once). Gives how far into the file the stretch begins; null when the playlist is not
 *  readable this way (the caller reads the playlist the old way). Throws when the stretch is past the end of the recording
 *  or a segment cannot be read. */
export async function gatherStretch(playlist: string, start: number, seconds: number, target: string, o: { fetch?: Fetch; parallel?: number } = {}): Promise<{ offset: number; segments: number } | null> {
  const f = o.fetch ?? fetch;
  const list = await mediaList(playlist, f);
  if (!list) return null;
  const { segments, offset } = segmentsFor(list, start, seconds);
  if (!segments.length) throw new Error(`the stretch at ${Math.round(start)} s is past the end of the recording (${Math.round(list.seconds)} s)`);
  const parallel = Math.max(1, o.parallel ?? 6);
  const pending: Array<Promise<Uint8Array> | undefined> = [];
  const begin = (k: number) => { if (k < segments.length && !pending[k]) { pending[k] = segmentBytes(f, segments[k], k); pending[k]!.catch(() => undefined); } };
  const fh = await open(target, "w");
  try {
    // a fragmented-MP4 recording: its init segment (the codecs and the timescale) goes first, then the fragments
    if (list.init) await fh.write(await segmentBytes(f, { url: list.init, start: 0, dur: 0 }, -1));
    for (let k = 0; k < Math.min(parallel, segments.length); k++) begin(k);
    for (let k = 0; k < segments.length; k++) {
      const bytes = await pending[k]!;
      pending[k] = undefined;
      begin(k + parallel);
      await fh.write(bytes);
    }
  } catch (err) { await fh.close().catch(() => undefined); await rm(target, { force: true }).catch(() => undefined); throw err; }
  await fh.close();
  return { offset, segments: segments.length };
}
