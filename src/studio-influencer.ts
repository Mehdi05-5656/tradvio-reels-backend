// AI Influencer: a character built from traits (the kind, the body, the hair, the style, the age, the skin) instead of a
// free description, so a creator who cannot write a prompt still gets a usable face. The traits become one portrait
// prompt here, server side, and ride on the ordinary "character" job (Soul, one image or four, saved to the library
// as a character every tool can put on screen). The vocabulary is mirrored in the dashboard (src/lib/influencer.ts):
// a value outside it is dropped, never passed through.
export const INFLUENCER_TRAITS = {
  type: ["average", "bold", "extreme", "insect", "frog", "cat", "dog", "rodent", "bird"],
  gender: ["woman", "man", "non-binary", "androgynous"],
  build: ["slim", "athletic", "average", "muscular", "ultra muscular", "heavy", "petite", "tall"],
  hairstyle: ["buzz cut", "bob", "pixie", "long straight", "long wavy", "curly", "afro", "braids", "locs", "mullet", "bowl cut", "slicked back", "ponytail", "bald", "mohawk", "shaved sides"],
  hair_color: ["black", "dark brown", "brown", "blonde", "platinum", "red", "auburn", "grey", "white", "pink", "blue", "green", "purple"],
  style: ["streetwear", "business", "athleisure", "vintage", "goth", "techwear", "cottagecore", "glam"],
  ethnicity: ["East Asian", "South Asian", "Black", "White", "Latino", "Middle Eastern"],
  age: ["young adult", "adult", "mature"],
  skin: ["very light", "light", "light-medium", "medium", "medium-tan", "tan", "deep", "very deep"],
} as const;
/** Details that can be stacked (any number of them). */
export const INFLUENCER_FEATURES = ["broad shoulders", "long limbs", "freckles", "round glasses", "sunglasses", "full beard", "moustache", "stubble", "tattoos", "gold chain", "piercings", "big ears", "gap teeth", "strong jaw", "dimples", "scar", "headphones", "cap"] as const;
export type TraitKey = keyof typeof INFLUENCER_TRAITS;
export type Traits = Partial<Record<TraitKey, string>> & { features?: string[] };
export const ANIMAL_TYPES = new Set(["insect", "frog", "cat", "dog", "rodent", "bird"]);
const ANIMAL_WORDS: Record<string, string> = { insect: "an insect character (a praying mantis or beetle)", frog: "a frog character", cat: "a cat character", dog: "a dog character (a pug or bulldog)", rodent: "a rodent character (a capybara or hamster)", bird: "a bird character (a penguin or parrot)" };
const TYPE_WORDS: Record<string, string> = { average: "a natural, everyday look", bold: "a striking, confident look with strong features", extreme: "an exaggerated, unforgettable look with surreal styling and proportions" };

/** Only values from the vocabulary survive; anything else is dropped. */
export function cleanTraits(raw: any): Traits {
  const out: Traits = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(INFLUENCER_TRAITS) as TraitKey[]) {
    const v = typeof raw[k] === "string" ? raw[k].trim() : "";
    if ((INFLUENCER_TRAITS[k] as readonly string[]).includes(v)) out[k] = v;
  }
  const features = [...new Set((Array.isArray(raw.features) ? raw.features : []).map((f: any) => String(f).trim()).filter((f: string) => (INFLUENCER_FEATURES as readonly string[]).includes(f)))] as string[];
  if (features.length) out.features = features.slice(0, 6);
  return out;
}

/** The portrait prompt from the traits: full body on a plain white studio background, facing the camera, the way a
 *  character reference should look. The creator's own words, if any, come last. */
export function influencerPrompt(traits: Traits, extra = "", photo = false): { prompt: string; mode: "human" | "animal" } {
  const t = cleanTraits(traits);
  const animal = !!t.type && ANIMAL_TYPES.has(t.type);
  const words = extra.trim().slice(0, 300);
  const hair = [t.hairstyle, t.hair_color ? `${t.hair_color} hair` : null].filter(Boolean).join(" ");
  const parts: string[] = [];
  if (animal) {
    parts.push(`Photorealistic full-body studio portrait of ${ANIMAL_WORDS[t.type!]} standing upright like a person`);
    if (t.build) parts.push(`${t.build} build`);
    if (hair) parts.push(`with ${hair}`);
    if (t.style) parts.push(`dressed in ${t.style} clothing`);
  } else {
    // with a photo, the person is the one in it: the words describe the styling, never another face or skin
    const who = photo ? "the person in the reference image, with exactly their face and identity" : [t.age, t.ethnicity, t.gender ?? "person"].filter(Boolean).join(" ");
    parts.push(`Photorealistic full-body studio portrait of ${photo ? who : `a ${who}`}`);
    if (t.build) parts.push(`${t.build} build`);
    if (hair) parts.push(`${hair}`);
    if (t.skin && !photo) parts.push(`${t.skin} skin`);
    if (t.style) parts.push(`dressed in ${t.style} clothing`);
    if (t.type && TYPE_WORDS[t.type]) parts.push(TYPE_WORDS[t.type]);
  }
  if (t.features?.length) parts.push(t.features.join(", "));
  if (words) parts.push(words);
  parts.push("standing facing the camera, full body visible from head to shoes, plain white studio background, soft even light, sharp detail, no text");
  return { prompt: parts.join(", "), mode: animal ? "animal" : "human" };
}
/** With a photo, the influencer is drawn by an image-edit model from it (the reference image carries the identity;
 *  the prompt carries the styling). Without one, Soul draws from the words alone. */
export const PHOTO_ENDPOINT = "marketing-studio/image/flare";

/** A one-line name for the library and the job card: "bold muscular man, mullet" and the like. */
export function influencerName(traits: Traits): string {
  const t = cleanTraits(traits);
  const bits = [t.type && !ANIMAL_TYPES.has(t.type) && t.type !== "average" ? t.type : null, t.build, t.type && ANIMAL_TYPES.has(t.type) ? t.type : t.gender ?? "person", t.hairstyle ? `${t.hairstyle}` : null].filter(Boolean);
  return bits.join(" ").replace(/\s+/g, " ").trim() || "influencer";
}
