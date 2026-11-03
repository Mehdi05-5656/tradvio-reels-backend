// AI Influencer: a character built from traits (the kind, the body, the hair, the style, the age, the skin) instead of a
// free description, so a creator who cannot write a prompt still gets a usable face. The traits become one portrait
// prompt here, server side, and ride on the ordinary "character" job (Soul, one image or four, saved to the library
// as a character every tool can put on screen). The vocabulary is mirrored in the dashboard (src/lib/influencer.ts):
// a value outside it is dropped, never passed through.
export const INFLUENCER_TRAITS = {
  type: ["average", "bold", "extreme", "insect", "frog", "cat", "dog", "rodent", "bird"],
  gender: ["woman", "man", "non-binary", "androgynous"],
  build: ["slim", "athletic", "average", "muscular", "ultra muscular", "heavy", "petite", "tall"],
  hairstyle: ["buzz cut", "bob", "pixie", "long straight", "long wavy", "curly", "afro", "braids", "locs", "mullet", "bowl cut", "mushroom cut", "beehive", "soft-serve swirl", "hair horns", "pigtails", "tight perm", "slicked back", "ponytail", "bald", "mohawk", "shaved sides"],
  hair_color: ["black", "dark brown", "brown", "blonde", "platinum", "red", "ginger", "auburn", "grey", "white", "pink", "lilac", "blue", "green", "purple"],
  style: ["streetwear", "business", "athleisure", "vintage", "retro", "y2k", "theatre", "goth", "techwear", "cottagecore", "glam"],
  ethnicity: ["East Asian", "South Asian", "Black", "White", "Latino", "Middle Eastern"],
  age: ["young adult", "adult", "mature", "senior"],
  skin: ["very light", "light", "light-medium", "medium", "medium-tan", "tan", "deep", "very deep"],
} as const;
/** Details that can be stacked (up to six): the face, the body, the extras. The odd ones are what make a character. */
export const INFLUENCER_FEATURES = ["broad shoulders", "long limbs", "short legs", "tiny waist", "egg body", "long neck", "freckles", "heavy eye bags", "high cheekbones", "jug ears", "big ears", "gap teeth", "buck teeth", "potato nose", "button nose", "tiny pursed mouth", "wide mouth", "unibrow", "no brows", "bleached brows", "strong jaw", "weak chin", "dimples", "scar", "full beard", "curled moustache", "moustache", "stubble", "goatee", "round glasses", "sunglasses", "braces", "gold grill", "piercings", "tattoos", "gold chain", "headphones", "cap", "nose tape"] as const;
export type TraitKey = keyof typeof INFLUENCER_TRAITS;
export type Traits = Partial<Record<TraitKey, string>> & { features?: string[] };
export const ANIMAL_TYPES = new Set(["insect", "frog", "cat", "dog", "rodent", "bird"]);
// A real animal, not a costume: "head on a human body" came back as a mask and a onesie for the mantis and the frog
// (Nov 2 2026), while the cat, the pug and the penguin, described as real animals, came out right.
const ANIMAL_WORDS: Record<string, string> = { insect: "a real praying mantis, life-size, with genuine chitin, compound eyes and antennae, standing upright on two legs like a person", frog: "a real tree frog, life-size, with genuine glossy amphibian skin and big gold eyes, standing upright on two legs like a person", cat: "a cat character with a real cat head on a human body", dog: "a dog character with a real pug head on a human body", rodent: "a capybara character with a real capybara head on a human body", bird: "a bird character with a real penguin head on a human body" };
const ANIMAL_LOCK = "a living animal photographed, never a costume, mask, puppet or suit";
// The look the type sets. These portraits are a genre: a deadpan fashion-campaign still, one odd thing pushed just past
// believable, played completely straight. The type decides how far.
const TYPE_WORDS: Record<string, string> = { average: "an ordinary person with one quietly odd detail, played straight", bold: "a striking look with one feature pushed past believable, played straight", extreme: "a caricature made real: exaggerated features and surreal proportions, completely deadpan" };
/** The frame every influencer portrait is shot in (the whole genre lives in this sentence). */
// "fully clothed" is load-bearing: without it Soul undresses every muscular or heavy build (seen Nov 2 2026).
const FRAME = "fully clothed, standing facing the camera in a deadpan editorial fashion-campaign portrait, full body visible from head to shoes, plain white seamless studio backdrop, direct on-camera flash, hyper-detailed skin and fabric, sharp focus, no text";

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
    parts.push(`Photorealistic full-body studio portrait of ${ANIMAL_WORDS[t.type!]}${/standing upright/.test(ANIMAL_WORDS[t.type!]) ? "" : " standing upright like a person"}`);
    if (t.build) parts.push(`${t.build} build`);
    if (hair) parts.push(`with ${hair}`);
    if (t.style) parts.push(`dressed in ${t.style} clothing`);
    parts.push(ANIMAL_LOCK);
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
  parts.push(FRAME);
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
