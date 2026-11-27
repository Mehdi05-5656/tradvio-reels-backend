// Clone8 Studio: the Trends catalog. Each trend is a driving clip we host (the dashboard serves /trends/<id>.mp4 and
// /trends/<id>.jpg, like the preset portraits); the person adds a character and Genjutsu motion transfer performs the
// clip as them. The clips are ours or licensed, never another platform's community uploads. Seconds are the clip's
// length after our 720p encode and decide the price (seconds × the Recast rate of the chosen model).
export type StudioTrend = { id: string; name: string; lede: string; seconds: number; tags: string[]; /** people performing, left to right (1 when absent) */ people?: number; /** not yet run end to end: the owner's admin accounts only */ draft?: boolean };

// Clips: desk-talk and pitch-15 are a client's (used with permission); thumbs-up and dance-headphones are Pexels stock
// (Tima Miroshnichenko 4994156, Polina Tankilevitch 6868300), free for commercial use and modification, no attribution required.
export const STUDIO_TRENDS: StudioTrend[] = [
  { id: "thumbs-up", name: "Point and thumbs up", lede: "A seated take: a point at the camera, a laugh, a thumbs up. Your character performs it.", seconds: 6, tags: ["gesture", "reaction"] },
  { id: "dance-headphones", name: "Headphones dance", lede: "Six seconds of a living-room dance with headphones on. Your character dances it.", seconds: 6, tags: ["dance", "home"] },
  { id: "desk-talk", name: "Desk talk", lede: "A seated talking-head take with hand gestures. Your character delivers it.", seconds: 5, tags: ["talking head", "office"] },
  { id: "pitch-15", name: "Fifteen-second pitch", lede: "A straight-to-camera pitch with cuts. Your character says every word.", seconds: 16, tags: ["talking head", "pitch"] },
  // Made Nov 26 2026 on Kling 4.0 with invented performers (ours; docs/catalog/FILL_PLAN.md wave 3); performed end to
  // end by a character the same night (heart hands, job 6db02581)
  { id: "heart-hands", name: "Heart hands", lede: "A smile, two hands make a heart, a tilt and a laugh. Your character does it.", seconds: 6, tags: ["gesture", "love"] },
  { id: "mind-blown", name: "Mind blown", lede: "Hands to the temples, then the big burst open. Your character's mind is blown.", seconds: 6, tags: ["reaction", "gesture"] },
  { id: "shrug", name: "Who knows?", lede: "Palms up, eyebrows up, a playful shrug. Your character doesn't know either.", seconds: 6, tags: ["reaction", "gesture"] },
  { id: "victory-dance", name: "Victory dance", lede: "Fist pumps, a shoulder shimmy, a finger spin. Your character celebrates.", seconds: 6, tags: ["dance", "celebration"] },
  { id: "point-up", name: "Point up", lede: "Both fingers point up at the words above, with an excited nod. Made for captions.", seconds: 6, tags: ["gesture", "captions"] },
  { id: "slow-clap", name: "Slow clap", lede: "A slow, impressed clap and an approving thumbs up from your character.", seconds: 6, tags: ["reaction", "gesture"] },
  { id: "chefs-kiss", name: "Chef's kiss", lede: "Fingertips to the lips, a kiss, and a delighted open hand. Perfection.", seconds: 6, tags: ["reaction", "food"] },
  { id: "walk-in-wave", name: "Walk in and wave", lede: "Your character walks into frame, stops and waves hello. A perfect opener.", seconds: 6, tags: ["intro", "gesture"] },
];

export const trendById = (id: unknown): StudioTrend | null => STUDIO_TRENDS.find((t) => t.id === id) ?? null;
/** The driving clips live in the public demo store (trends/<id>.mp4), not in the app: the app only ships the posters,
 *  and a deploy from a checkout without the clips served its own page in their place (found Nov 26 2026: every trend
 *  run was given HTML; none had been run since Oct 29). STUDIO_TREND_BASE can point elsewhere. */
export const TREND_CLIP_BASE = "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com";
export const trendClipUrl = (_base: string, id: string, env: Record<string, string | undefined> = process.env) => `${(env.STUDIO_TREND_BASE || TREND_CLIP_BASE).replace(/\/+$/, "")}/trends/${id}.mp4`;
export const trendPosterUrl = (base: string, id: string) => `${base.replace(/\/+$/, "")}/trends/${id}.jpg`;
