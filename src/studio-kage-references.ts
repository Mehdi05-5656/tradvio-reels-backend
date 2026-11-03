// Kage's reference presets: short videos we have the right to offer, shown in the Kage gallery so a person can remix one
// without bringing their own. Each clip lives beside the trends (public/trends in the dashboard, or an absolute URL),
// its poster next to it. The list is the catalog; adding one is a line here plus the two files.
export type KageReference = { id: string; name: string; lede: string; seconds: number; tags: string[]; /** absolute video URL, or the dashboard's /trends/<id>.mp4 when absent */ video?: string; poster?: string };
export const KAGE_REFERENCES: KageReference[] = [
  { id: "pitch-15", name: "Fifteen-second pitch", lede: "A straight-to-camera pitch with cuts: the rhythm of a founder clip.", seconds: 16, tags: ["talking head", "pitch"] },
  { id: "desk-talk", name: "Desk talk", lede: "A seated talking-head take with hand gestures.", seconds: 5, tags: ["talking head", "office"] },
  { id: "dance-headphones", name: "Headphones dance", lede: "Six seconds of a living-room dance.", seconds: 6, tags: ["dance", "home"] },
  { id: "thumbs-up", name: "Point and thumbs up", lede: "A point at the camera, a laugh, a thumbs up.", seconds: 6, tags: ["gesture", "reaction"] },
];
export const kageReferenceById = (id: unknown): KageReference | null => KAGE_REFERENCES.find((r) => r.id === id) ?? null;
export const kageReferenceVideoUrl = (base: string, r: KageReference) => r.video ?? `${base.replace(/\/+$/, "")}/trends/${r.id}.mp4`;
export const kageReferencePosterUrl = (base: string, r: KageReference) => r.poster ?? `${base.replace(/\/+$/, "")}/trends/${r.id}.jpg`;
