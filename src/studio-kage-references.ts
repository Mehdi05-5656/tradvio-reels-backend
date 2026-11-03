// Kage's reference presets: short videos we have the right to offer, shown in the Kage gallery so a person can remix one
// without bringing their own. Each clip lives beside the trends (public/trends in the dashboard, or an absolute URL),
// its poster next to it. The list is the catalog; adding one is a line here plus the two files.
export type KageReference = { id: string; name: string; lede: string; seconds: number; tags: string[]; /** absolute video URL, or the dashboard's /trends/<id>.mp4 when absent */ video?: string; poster?: string };
/** Empty for now: the owner curates these by hand (Nov 2 2026). The gallery shows "Create from your own video" alone. */
export const KAGE_REFERENCES: KageReference[] = [];
export const kageReferenceById = (id: unknown): KageReference | null => KAGE_REFERENCES.find((r) => r.id === id) ?? null;
export const kageReferenceVideoUrl = (base: string, r: KageReference) => r.video ?? `${base.replace(/\/+$/, "")}/trends/${r.id}.mp4`;
export const kageReferencePosterUrl = (base: string, r: KageReference) => r.poster ?? `${base.replace(/\/+$/, "")}/trends/${r.id}.jpg`;
