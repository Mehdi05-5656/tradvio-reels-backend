// Clone8 Studio: the Trends catalog. Each trend is a driving clip we host (the dashboard serves /trends/<id>.mp4 and
// /trends/<id>.jpg, like the preset portraits); the person adds a character and Genjutsu motion transfer performs the
// clip as them. The clips are ours or licensed, never another platform's community uploads. Seconds are the clip's
// length after our 720p encode and decide the price (seconds × the Recast rate of the chosen model).
export type StudioTrend = { id: string; name: string; lede: string; seconds: number; tags: string[]; /** people performing, left to right (1 when absent) */ people?: number };

// Clips: desk-talk and pitch-15 are a client's (used with permission); thumbs-up and dance-headphones are Pexels stock
// (Tima Miroshnichenko 4994156, Polina Tankilevitch 6868300), free for commercial use and modification, no attribution required.
export const STUDIO_TRENDS: StudioTrend[] = [
  { id: "thumbs-up", name: "Point and thumbs up", lede: "A seated take: a point at the camera, a laugh, a thumbs up. Your character performs it.", seconds: 6, tags: ["gesture", "reaction"] },
  { id: "dance-headphones", name: "Headphones dance", lede: "Six seconds of a living-room dance with headphones on. Your character dances it.", seconds: 6, tags: ["dance", "home"] },
  { id: "desk-talk", name: "Desk talk", lede: "A seated talking-head take with hand gestures. Your character delivers it.", seconds: 5, tags: ["talking head", "office"] },
  { id: "pitch-15", name: "Fifteen-second pitch", lede: "A straight-to-camera pitch with cuts. Your character says every word.", seconds: 16, tags: ["talking head", "pitch"] },
];

export const trendById = (id: unknown): StudioTrend | null => STUDIO_TRENDS.find((t) => t.id === id) ?? null;
/** The driving clips live in the public demo store (trends/<id>.mp4), not in the app: the app only ships the posters,
 *  and a deploy from a checkout without the clips served its own page in their place (found Nov 26 2026: every trend
 *  run was given HTML; none had been run since Oct 29). STUDIO_TREND_BASE can point elsewhere. */
export const TREND_CLIP_BASE = "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com";
export const trendClipUrl = (_base: string, id: string, env: Record<string, string | undefined> = process.env) => `${(env.STUDIO_TREND_BASE || TREND_CLIP_BASE).replace(/\/+$/, "")}/trends/${id}.mp4`;
export const trendPosterUrl = (base: string, id: string) => `${base.replace(/\/+$/, "")}/trends/${id}.jpg`;
