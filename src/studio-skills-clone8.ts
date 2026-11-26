// The skills by Clone8 (docs/higgsfield-parity/PLAN.md, phase 2): ready-made recipes Claude follows with the Clone8
// tools, shown first on the Skills page and run by name from a chat (clone8_skill). Each one is written against the
// tools as they are (src/studio-mcp.ts, src/studio-mcp-models.ts) and names models by their family and mode, never by
// an id: Claude looks the id up with clone8_models, so a renamed endpoint never breaks a skill. Covers are the presets'
// own examples (public demo media, AI-made people and products only).

export type SkillCategory = "ads" | "ugc" | "explainers" | "social" | "characters" | "video" | "other";
export const SKILL_CATEGORIES: Array<{ id: SkillCategory; label: string }> = [
  { id: "ads", label: "Ads" }, { id: "ugc", label: "UGC" }, { id: "explainers", label: "Explainers" }, { id: "social", label: "Social" },
  { id: "characters", label: "Characters" }, { id: "video", label: "Video" }, { id: "other", label: "Other" },
];
export type SkillCover = { poster: string; clip?: string; aspect?: string };
export type OfficialSkill = {
  slug: string; title: string; line: string; category: SkillCategory;
  /** "skill": one ability; "use_case": a whole piece of work from start to finish */
  kind: "skill" | "use_case";
  /** about how long it takes, start to finish */
  minutes: number;
  example: string; instructions: string; cover: SkillCover; related: string[];
};

const DEMO = "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com";
const clip = (id: string, aspect = "3:4"): SkillCover => ({ poster: `/explore/${id}.jpg`, clip: `${DEMO}/explore/${id}.mp4`, aspect });
const pic = (id: string, aspect = "3:4"): SkillCover => ({ poster: `/explore/${id}.jpg`, aspect });

/** How every photo-in skill gets the person's photo: a link, or a file already on Clone8. */
const GET_PHOTO = (what: string) => `Ask for ${what}. If they give a public link, bring it in with clone8_add_media. If it is already on Clone8, find it with clone8_library. If they only have it on their device, tell them to upload it at app.clone8.io (Library), then look again with clone8_library.`;

export const CLONE8_SKILLS: OfficialSkill[] = [
  {
    slug: "product-ad", title: "Product ad from one photo", line: "One product photo in: three ad looks, then the best one moving.", category: "ads", kind: "use_case", minutes: 6,
    example: "@Clone8 /product-ad for my energy drink. Here is the photo: <link>", cover: clip("product-spin"), related: ["ugc-unboxing", "ad-hooks", "thumbnail-set"],
    instructions: `1. ${GET_PHOTO("one sharp photo of the product on its own")}
2. Call clone8_presets and offer the product looks that fit it (Product hero, Splash drop, Ice splash for a drink can, Levitate or Luxury ad for shoes and objects). Let the person pick one to three.
3. For each pick, call clone8_run_preset without confirm to get the price. Show every price together with the total, and wait for the person's yes.
4. Run them with confirm: true and follow each with clone8_job until it is done. Show the results.
5. Ask which one they like best. If it is a picture, offer to make it move: a 5-second vertical video with Kling 4.0's "Video from a picture" mode (find the id with clone8_models), describing a slow camera push-in and one small motion of the product. Price it first, then make it on their yes.`,
  },
  {
    slug: "ugc-unboxing", title: "UGC unboxing", line: "A creator-style unboxing and a street-interview reaction for your product.", category: "ugc", kind: "skill", minutes: 5,
    example: "@Clone8 /ugc-unboxing for these sneakers: <link>", cover: clip("unboxing"), related: ["product-ad", "ad-hooks"],
    instructions: `1. ${GET_PHOTO("a photo of the product")}
2. Run the Unboxing preset on it (clone8_run_preset, preset "unboxing"): price first, then make it on the person's yes, and follow it with clone8_job.
3. Offer a second clip in the same campaign: the Street interview preset needs a photo of a person. Only use a photo of someone who agreed to it (the person themselves, or an AI-made face from clone8_generate with a picture model). Never use a photo of a real person found online.
4. Give both links and suggest a caption line for each (you write these; they are free).`,
  },
  {
    slug: "ad-hooks", title: "Ad hooks", line: "Five scroll-stopping opening lines, then the winning hook's first shot.", category: "ads", kind: "skill", minutes: 4,
    example: "@Clone8 /ad-hooks for a budgeting app aimed at students", cover: clip("hero-landing"), related: ["product-ad", "shot-list"],
    instructions: `1. Ask what is being advertised and who it is for, if they have not said.
2. Write five different hooks (the first two seconds of an ad): a bold claim, a question, a "stop doing this", a surprising number, and a visual pattern-break. One line each, under 12 words. This part is free.
3. Ask which hook to shoot. Describe its opening shot in one sentence: the subject, what happens, the camera.
4. Make it as a 5-second vertical video with Kling 4.0's "Video from words" mode (look up the id with clone8_models). Price first with clone8_generate without confirm, then make it on the person's yes and follow it with clone8_job.`,
  },
  {
    slug: "faceless-explainer", title: "Faceless explainer", line: "A narrated 3D story video on any topic, no face or voice needed.", category: "explainers", kind: "use_case", minutes: 25,
    example: "@Clone8 /faceless-explainer: how a backyard pool is built", cover: { poster: "/motion/story-pool.jpg", clip: `${DEMO}/motion/loops/story-pool.mp4`, aspect: "9:16" }, related: ["motivation-short", "mini-documentary"],
    instructions: `1. Agree the topic in one line, phrased the way a viewer would ask it ("Want a pool in your backyard?").
2. Call clone8_catalog to see the story styles and lengths, and offer the person the choice.
3. Call clone8_quote for the story, show the price, and wait for the person's yes.
4. Start it with clone8_make_story (confirm: true) and follow it with clone8_job. It takes 15 to 30 minutes: tell the person they can leave and ask "how is my video doing?" later.`,
  },
  {
    slug: "motivation-short", title: "Motivation short", line: "A cinematic motivation video with a narrator, from one idea.", category: "explainers", kind: "skill", minutes: 15,
    example: "@Clone8 /motivation-short about starting before you feel ready", cover: { poster: "/explore/seedance.jpg", aspect: "16:9" }, related: ["faceless-explainer", "mini-documentary"],
    instructions: `1. Agree the message in one line.
2. Price it with clone8_quote (the motivation kind), show the price and wait for the person's yes.
3. Start it with clone8_make_motivation (confirm: true) and follow it with clone8_job until it is done.`,
  },
  {
    slug: "mini-documentary", title: "Mini documentary", line: "A researched, narrated film from a true story or a question.", category: "explainers", kind: "use_case", minutes: 40,
    example: "@Clone8 /mini-documentary: the lighthouse keepers who vanished from the Flannan Isles", cover: { poster: "/explore/kling-4.jpg", aspect: "16:9" }, related: ["faceless-explainer", "motivation-short"],
    instructions: `1. Agree the subject and the length the person wants (call clone8_catalog for the lengths offered).
2. Price it with clone8_quote (the film kind), show the price and wait for the person's yes.
3. Start it with clone8_make_film (confirm: true) and follow it with clone8_job. Long films take a while: tell the person they can come back and ask how it is going.`,
  },
  {
    slug: "thumbnail-set", title: "Thumbnail set", line: "Three thumbnail looks from one photo: shock, cover star, billboard.", category: "social", kind: "skill", minutes: 4,
    example: "@Clone8 /thumbnail-set with the words \"I QUIT\" and my photo: <link>", cover: pic("thumbnail"), related: ["character-pack", "product-ad"],
    instructions: `1. ${GET_PHOTO("a clear photo of the person (their own)")}
2. Ask for the words on the thumbnail (up to a few words, the shorter the better).
3. Run three presets on the photo: "thumbnail" (Shock thumbnail), "magazine-cover" (Cover star) and "billboard", each with the words as its text where it takes one. Price all three first and show the total; make them on the person's yes.
4. Show the three side by side and say which one reads best at a small size, and why.`,
  },
  {
    slug: "character-pack", title: "Character pack", line: "Turn one photo into a set: action figure, 3D cartoon, plush, comic hero.", category: "characters", kind: "skill", minutes: 5,
    example: "@Clone8 /character-pack from my photo: <link>", cover: pic("action-figure"), related: ["thumbnail-set"],
    instructions: `1. ${GET_PHOTO("a photo of the person (their own) or their pet")}
2. Offer the character presets (from clone8_presets): Action figure, 3D cartoon, Plush toy, Comic hero, Painted anime; for a pet, Pet CEO and Royal portrait. Let them pick.
3. Price every pick together, show the total, and make them on the person's yes. Follow each with clone8_job and show them as a set.`,
  },
  {
    slug: "shot-list", title: "Shot list to clips", line: "Write a three-shot sequence together, then make every shot.", category: "video", kind: "skill", minutes: 10,
    example: "@Clone8 /shot-list: a rainy night chase through a neon market", cover: clip("neon-rain"), related: ["ad-hooks"],
    instructions: `1. Agree the idea and the shape (vertical 9:16 or wide 16:9).
2. Write three shots: for each, the subject, the action, the camera move and the light, one or two sentences. Keep the same people, clothes and place in every shot so they cut together.
3. Pick a model with clone8_models: Kling 4.0 "Video from words" by default; Seedance for dialogue or fast action. Read its settings with clone8_model.
4. Price the three shots with clone8_generate (no confirm), show the total, and make them on the person's yes. Follow each with clone8_job.
5. Give the links in order. The person can cut them together in the Clone8 editor at app.clone8.io.`,
  },
];

export const officialSkill = (slug: string) => CLONE8_SKILLS.find((s) => s.slug === slug) ?? null;
