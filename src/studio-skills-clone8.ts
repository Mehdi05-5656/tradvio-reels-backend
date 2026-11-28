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
  /** what the person brings and what they get, said for a customer (the instructions are written for Claude) */
  bring?: string; gets?: string[];
};

const DEMO = "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com";
const clip = (id: string, aspect = "3:4"): SkillCover => ({ poster: `/explore/${id}.jpg`, clip: `${DEMO}/explore/${id}.mp4`, aspect });
const pic = (id: string, aspect = "3:4"): SkillCover => ({ poster: `/explore/${id}.jpg`, aspect });
/** A real Clone8 result from another tool (Films, Motivation, Stories, Kage, Live Clips): its poster in the app, its loop in the demo store. */
const real = (poster: string, loop: string, aspect = "9:16"): SkillCover => ({ poster, clip: `${DEMO}/${loop}`, aspect });

/** How every photo-in skill gets the person's photo: a link, or a file already on Clone8. */
const GET_PHOTO = (what: string) => `Ask for ${what}. If they give a public link, bring it in with clone8_add_media. If it is already on Clone8, find it with clone8_library. If they only have it on their device, tell them to upload it at app.clone8.io (Library), then look again with clone8_library.`;

export const CLONE8_SKILLS: OfficialSkill[] = [
  {
    slug: "product-ad", bring: "One photo of your product", gets: ["Up to three ad looks: hero, splash, levitate or luxury", "Your favourite as a 5-second video, if it is a picture"], title: "Product ad from one photo", line: "One product photo in: three ad looks, then the best one moving.", category: "ads", kind: "use_case", minutes: 6,
    example: "@Clone8 /product-ad for my energy drink. Here is the photo: <link>", cover: clip("product-spin"), related: ["ugc-unboxing", "ad-hooks", "thumbnail-set"],
    instructions: `1. ${GET_PHOTO("one sharp photo of the product on its own")}
2. Call clone8_presets and offer the product looks that fit it (Product hero, Splash drop, Ice splash for a drink can, Levitate or Luxury ad for shoes and objects). Let the person pick one to three.
3. For each pick, call clone8_run_preset without confirm to get the price. Show every price together with the total, and wait for the person's yes.
4. Run them with confirm: true and follow each with clone8_job until it is done. Show the results.
5. Ask which one they like best. If it is a picture, offer to make it move: a 5-second vertical video with Kling 4.0's "Video from a picture" mode (find the id with clone8_models), describing a slow camera push-in and one small motion of the product. Price it first, then make it on their yes.`,
  },
  {
    slug: "ugc-unboxing", bring: "One photo of your product", gets: ["A creator-style unboxing clip", "A street-interview reaction clip, if you want a second", "A caption line for each"], title: "UGC unboxing", line: "A creator-style unboxing and a street-interview reaction for your product.", category: "ugc", kind: "skill", minutes: 5,
    example: "@Clone8 /ugc-unboxing for these sneakers: <link>", cover: clip("unboxing"), related: ["product-ad", "ad-hooks"],
    instructions: `1. ${GET_PHOTO("a photo of the product")}
2. Run the Unboxing preset on it (clone8_run_preset, preset "unboxing"): price first, then make it on the person's yes, and follow it with clone8_job.
3. Offer a second clip in the same campaign: the Street interview preset needs a photo of a person. Only use a photo of someone who agreed to it (the person themselves, or an AI-made face from clone8_generate with a picture model). Never use a photo of a real person found online.
4. Give both links and suggest a caption line for each (you write these; they are free).`,
  },
  {
    slug: "ad-hooks", bring: "What you sell and who it is for", gets: ["Five opening lines to choose from, free", "The winning hook as a 5-second vertical video"], title: "Ad hooks", line: "Five scroll-stopping opening lines, then the winning hook's first shot.", category: "ads", kind: "skill", minutes: 4,
    example: "@Clone8 /ad-hooks for a budgeting app aimed at students", cover: real("/kage-presets/tiktok-hook.jpg", "kage/v2/tiktok-hook.mp4"), related: ["product-ad", "shot-list"],
    instructions: `1. Ask what is being advertised and who it is for, if they have not said.
2. Write five different hooks (the first two seconds of an ad): a bold claim, a question, a "stop doing this", a surprising number, and a visual pattern-break. One line each, under 12 words. This part is free.
3. Ask which hook to shoot. Describe its opening shot in one sentence: the subject, what happens, the camera.
4. Make it as a 5-second vertical video with Kling 4.0's "Video from words" mode (look up the id with clone8_models). Price first with clone8_generate without confirm, then make it on the person's yes and follow it with clone8_job.`,
  },
  {
    slug: "faceless-explainer", bring: "A topic, in one line", gets: ["A narrated 3D story video in the style and length you pick", "Ready in 15 to 30 minutes; you can leave and come back"], title: "Faceless explainer", line: "A narrated 3D story video on any topic, no face or voice needed.", category: "explainers", kind: "use_case", minutes: 25,
    example: "@Clone8 /faceless-explainer: how a backyard pool is built", cover: { poster: "/motion/story-pool.jpg", clip: `${DEMO}/motion/loops/story-pool.mp4`, aspect: "9:16" }, related: ["motivation-short", "mini-documentary"],
    instructions: `1. Agree the topic in one line, phrased the way a viewer would ask it ("Want a pool in your backyard?").
2. Call clone8_catalog to see the story styles and lengths, and offer the person the choice.
3. Call clone8_quote for the story, show the price, and wait for the person's yes.
4. Start it with clone8_make_story (confirm: true) and follow it with clone8_job. It takes 15 to 30 minutes: tell the person they can leave and ask "how is my video doing?" later.`,
  },
  {
    slug: "motivation-short", bring: "One message, in one line", gets: ["A narrated motivation video with sound, ready to post"], title: "Motivation short", line: "A cinematic motivation video with a narrator, from one idea.", category: "explainers", kind: "skill", minutes: 15,
    example: "@Clone8 /motivation-short about starting before you feel ready", cover: real("/motion/motivation-start.jpg", "motion/loops/motivation-start.mp4"), related: ["faceless-explainer", "mini-documentary"],
    instructions: `1. Agree the message in one line.
2. Price it with clone8_quote (the motivation kind), show the price and wait for the person's yes.
3. Start it with clone8_make_motivation (confirm: true) and follow it with clone8_job until it is done.`,
  },
  {
    slug: "mini-documentary", bring: "A true story or a question", gets: ["A researched, narrated film at the length you pick", "A thumbnail, title and description with it"], title: "Mini documentary", line: "A researched, narrated film from a true story or a question.", category: "explainers", kind: "use_case", minutes: 40,
    example: "@Clone8 /mini-documentary: the lighthouse keepers who vanished from the Flannan Isles", cover: real("/motion/films/loop-ship.jpg", "motion/loops/film-ship.mp4", "16:9"), related: ["faceless-explainer", "motivation-short"],
    instructions: `1. Agree the subject and the length the person wants (call clone8_catalog for the lengths offered).
2. Price it with clone8_quote (the film kind), show the price and wait for the person's yes.
3. Start it with clone8_make_film (confirm: true) and follow it with clone8_job. Long films take a while: tell the person they can come back and ask how it is going.`,
  },
  {
    slug: "thumbnail-set", bring: "A photo of you and a few words", gets: ["Three thumbnails: shock, cover star and billboard", "Which one reads best at phone size, and why"], title: "Thumbnail set", line: "Three thumbnail looks from one photo: shock, cover star, billboard.", category: "social", kind: "skill", minutes: 4,
    example: "@Clone8 /thumbnail-set with the words \"I QUIT\" and my photo: <link>", cover: pic("thumbnail"), related: ["character-pack", "product-ad"],
    instructions: `1. ${GET_PHOTO("a clear photo of the person (their own)")}
2. Ask for the words on the thumbnail (up to a few words, the shorter the better).
3. Run three presets on the photo: "thumbnail" (Shock thumbnail), "magazine-cover" (Cover star) and "billboard", each with the words as its text where it takes one. Price all three first and show the total; make them on the person's yes.
4. Show the three side by side and say which one reads best at a small size, and why.`,
  },
  {
    slug: "character-pack", bring: "A photo of you or your pet", gets: ["The characters you pick: action figure, 3D cartoon, plush, comic hero, anime", "Shown together as a set"], title: "Character pack", line: "Turn one photo into a set: action figure, 3D cartoon, plush, comic hero.", category: "characters", kind: "skill", minutes: 5,
    example: "@Clone8 /character-pack from my photo: <link>", cover: pic("action-figure"), related: ["thumbnail-set"],
    instructions: `1. ${GET_PHOTO("a photo of the person (their own) or their pet")}
2. Offer the character presets (from clone8_presets): Action figure, 3D cartoon, Plush toy, Comic hero, Painted anime; for a pet, Pet CEO and Royal portrait. Let them pick.
3. Price every pick together, show the total, and make them on the person's yes. Follow each with clone8_job and show them as a set.`,
  },
  {
    slug: "shot-list", bring: "An idea", gets: ["A three-shot plan with the same people and place in every shot", "Each shot as a video clip, in order, ready to cut"], title: "Shot list to clips", line: "Write a three-shot sequence together, then make every shot.", category: "video", kind: "skill", minutes: 10,
    example: "@Clone8 /shot-list: a rainy night chase through a neon market", cover: clip("drone-pullback"), related: ["ad-hooks"],
    instructions: `1. Agree the idea and the shape (vertical 9:16 or wide 16:9).
2. Write three shots: for each, the subject, the action, the camera move and the light, one or two sentences. Keep the same people, clothes and place in every shot so they cut together.
3. Pick a model with clone8_models: Kling 4.0 "Video from words" by default; Seedance for dialogue or fast action. Read its settings with clone8_model.
4. Price the three shots with clone8_generate (no confirm), show the total, and make them on the person's yes. Follow each with clone8_job.
5. Give the links in order. The person can cut them together in the Clone8 editor at app.clone8.io.`,
  },

  // ---- added Nov 26 2026 (docs/catalog/FILL_PLAN.md, wave 1): only tools Claude can reach; models named by family
  {
    slug: "food-menu-reel", bring: "A photo of each dish, up to six", gets: ["A 3-second hero clip per dish: steam, a sauce landing, warm light", "A caption line per dish"], title: "Food menu reel", line: "Every dish on your menu as a mouth-watering three-second hero shot.", category: "ads", kind: "use_case", minutes: 10,
    example: "@Clone8 /food-menu-reel for my ramen shop: <links to three dish photos>", cover: clip("food-hero"), related: ["product-ad", "marketplace-set", "post-a-week"],
    instructions: `1. ${GET_PHOTO("a photo of each dish (up to six), one plate per photo, from above or at the table's angle")}
2. For each dish, make a 3-second vertical video with Kling 4.0's "Video from a picture" mode (find the id with clone8_models): a slow push-in, steam rising, a sauce or garnish landing, warm side light. Keep the plate, the food and the colours exactly as in the photo.
3. Price all the dishes together, show the total, and make them on the person's yes. Follow each with clone8_job.
4. Give the links in menu order and suggest one short line per dish for the caption (free).`,
  },
  {
    slug: "fashion-drop", bring: "One photo of the garment", gets: ["On a model, a flat-lay and a detail shot, the garment kept exact", "A 5-second runway walk, if you want it"], title: "Fashion drop", line: "One garment photo in: an on-model look, a flat-lay and a runway clip.", category: "ads", kind: "use_case", minutes: 8,
    example: "@Clone8 /fashion-drop for this jacket: <link>", cover: clip("main-character"), related: ["try-on-haul", "product-ad", "beauty-launch"],
    instructions: `1. ${GET_PHOTO("a clear photo of the garment on its own")}
2. Make three pictures with Kling Image 4.0's "Edit a picture" mode (clone8_models for the id), each keeping the garment's colour, cut and logo exactly: (a) worn by an AI-made model in a clean studio, full body; (b) a styled flat-lay with two matching accessories on linen; (c) worn on a city street at golden hour. Never put the garment on a real person's photo unless it is the person themselves.
3. Price the three together, make them on the person's yes, and follow each with clone8_job.
4. Offer a 5-second runway walk from picture (a) with Kling 4.0's "Video from a picture" mode, priced first.`,
  },
  {
    slug: "beauty-launch", bring: "One photo of the bottle or jar", gets: ["Splash, mist and texture shots with your packaging kept exact", "Your favourite as a 5-second video, if you want it"], title: "Beauty launch", line: "A skincare or makeup product in splash, mist and texture shots.", category: "ads", kind: "skill", minutes: 6,
    example: "@Clone8 /beauty-launch for my serum: <link>", cover: clip("perfume-mist"), related: ["product-ad", "before-after-ad"],
    instructions: `1. ${GET_PHOTO("a sharp photo of the bottle or jar on its own")}
2. Make three pictures with Seedream 5.0 Pro's "Edit a picture" mode, keeping the packaging and its words exactly: (a) the product in a crown of water splash on a soft pastel background; (b) in a cloud of fine mist with morning light; (c) beside a swatch of its texture on glass, macro.
3. Price them together and make them on the person's yes; follow each with clone8_job.
4. Offer to turn the favourite into a 5-second video (Kling 4.0 "Video from a picture": the splash or mist moving slowly), priced first.`,
  },
  {
    slug: "before-after-ad", bring: "A before photo and the change", gets: ["The after picture: same place, framing and light", "A 5-second reveal clip from before to after", "An honest caption"], title: "Before-and-after ad", line: "A clean before / after pair and a reveal clip for any transformation.", category: "ads", kind: "skill", minutes: 6,
    example: "@Clone8 /before-after-ad for my cleaning spray: here is the dirty oven <link>", cover: real("/motion/loops/reshoot-snow.jpg", "motion/loops/reshoot-snow.mp4"), related: ["beauty-launch", "ad-hooks"],
    instructions: `1. ${GET_PHOTO("the BEFORE photo (the person's own: a room, a car, a garden, a product in use)")}
2. Make the AFTER with Kling Image 4.0's "Edit a picture" mode: the same place, framing and light, only the change the person describes (clean, renovated, repaired). Never invent results the product cannot give, and never edit a real person's body or face.
3. Price it, make it on the person's yes, then offer a 5-second reveal with Kling 4.0 "Video from a picture" from the BEFORE photo, described as a wipe or a slow transformation into the AFTER. Price that first too.
4. Suggest an honest caption, e.g. "Before / after: 10 minutes".`,
  },
  {
    slug: "marketplace-set", bring: "One photo of your product", gets: ["Four listing photos: white background, in use, detail and scale"], title: "Marketplace listing set", line: "Clean white-background, lifestyle and detail photos for a shop listing.", category: "ads", kind: "skill", minutes: 5,
    example: "@Clone8 /marketplace-set for this backpack: <link>", cover: pic("flat-lay"), related: ["product-ad", "fashion-drop"],
    instructions: `1. ${GET_PHOTO("a photo of the product")}
2. Make four pictures with Kling Image 4.0's "Edit a picture" mode, keeping the product exactly (shape, colour, logo, text): (a) on pure white, centred, soft shadow, square; (b) in use in a fitting real setting; (c) a close detail of its best feature; (d) next to a common object for scale.
3. Price the four together and make them on the person's yes; follow each with clone8_job and give them in listing order.`,
  },
  {
    slug: "try-on-haul", bring: "A photo of each garment, up to three", gets: ["One AI-made model wearing every outfit in the same room", "A 5-second clip per outfit, if you want them"], title: "Try-on haul", line: "Three outfits on the same AI model, ready for a haul video.", category: "ugc", kind: "use_case", minutes: 8,
    example: "@Clone8 /try-on-haul with these three tops: <links>", cover: clip("runway-walk"), related: ["fashion-drop", "ugc-unboxing"],
    instructions: `1. ${GET_PHOTO("a photo of each garment (up to three)")}
2. First make one AI-made model with a picture model (Clone8 Portrait or Seedream 5.0 Pro, "Picture from words"): a friendly creator in a bright bedroom, mirror selfie framing. Show it and ask the person to keep it or try again (priced first).
3. For each garment, use Kling Image 4.0 "Edit a picture" with the model's picture and the garment to dress the same model, same room and pose. Price all together; make them on the person's yes.
4. Offer a 5-second clip per outfit (Kling 4.0 "Video from a picture": a turn and a smile), priced first.`,
  },
  {
    slug: "product-reaction", bring: "One photo of your product", gets: ["A 5-second UGC clip: an AI-made creator trying it and reacting"], title: "Product reaction", line: "An AI creator reacting to your product, as a 5-second UGC clip.", category: "ugc", kind: "skill", minutes: 5,
    example: "@Clone8 /product-reaction for my protein bar: <link>", cover: clip("street-interview", "9:16"), related: ["ugc-unboxing", "ugc-hook-test"],
    instructions: `1. ${GET_PHOTO("a photo of the product")}
2. Make the opening frame with Kling Image 4.0 "Edit a picture": an AI-made creator holding the product up to the camera in a kitchen, surprised and smiling, phone-camera look. Keep the product's packaging exactly.
3. Turn it into a 5-second vertical clip with Kling 4.0 "Video from a picture": they take a bite or try it and react with a big positive face.
4. Price both steps together, make them on the person's yes, follow with clone8_job.`,
  },
  {
    slug: "ugc-hook-test", bring: "One photo of your product", gets: ["Three hooks in three styles, free", "Three 5-second opening shots to test", "Posted on different days, if you want"], title: "Three-hook UGC test", line: "The same product with three different opening hooks, to test which stops the scroll.", category: "ugc", kind: "use_case", minutes: 10,
    example: "@Clone8 /ugc-hook-test for my water bottle that keeps ice for 24 hours", cover: clip("unboxing"), related: ["ad-hooks", "product-reaction"],
    instructions: `1. Ask for the product photo (clone8_add_media or clone8_library) and who it is for.
2. Write three hooks in different styles (a surprising claim, a problem, a challenge), one line each. Free.
3. For each hook, make a 5-second vertical opening shot with Kling 4.0 (from the product photo, "Video from a picture") that shows the hook happening. Price the three together and make them on the person's yes.
4. Give the three links with their hook lines, and offer to schedule them on different days with clone8_post so they can compare (show each post first).`,
  },
  {
    slug: "daily-facts-series", bring: "A theme", gets: ["Seven topics you approve, free", "Seven narrated 3D explainers", "One posted a day, if you want"], title: "Daily facts series", line: "Seven narrated 3D explainers on one theme, one for every day of the week.", category: "explainers", kind: "use_case", minutes: 60,
    example: "@Clone8 /daily-facts-series about the ocean", cover: real("/motion/story-dig.jpg", "motion/story-dig.mp4"), related: ["faceless-explainer", "post-a-week"],
    instructions: `1. Agree the theme and write seven topics, each phrased the way a viewer would ask it ("Why is the ocean salty?"). Show them; let the person change any.
2. Call clone8_catalog for styles, then clone8_quote for one story and multiply by seven. Show the total and wait for the person's yes.
3. Start the seven with clone8_make_story (confirm: true), one after another, and follow them with clone8_job. They take 15 to 30 minutes each: tell the person they can come back.
4. When they are done, offer to schedule one a day with clone8_post (show every post first).`,
  },
  {
    slug: "history-mystery", bring: "A case from history", gets: ["A researched mystery film told like a thriller, 2, 5 or 10 minutes"], title: "History mystery film", line: "A researched, narrated mystery from history, told like a thriller.", category: "explainers", kind: "use_case", minutes: 40,
    example: "@Clone8 /history-mystery: the Dyatlov Pass incident", cover: real("/motion/films/loop-attic.jpg", "motion/loops/film-attic.mp4", "16:9"), related: ["mini-documentary", "faceless-explainer"],
    instructions: `1. Agree the case. If it involves real people who died, keep it respectful and factual; no gore.
2. Price a 5-minute film with clone8_quote (film kind) and show it; offer 2 or 10 minutes as alternatives.
3. Start it with clone8_make_film (confirm: true), asking for a mystery tone: the question first, the evidence in order, the theories, what is still unknown. Follow it with clone8_job.`,
  },
  {
    slug: "how-its-made", bring: "An object or a place", gets: ["A narrated 3D story that builds it from the ground up"], title: "How it's made", line: "A narrated 3D story that builds any object or place from the ground up.", category: "explainers", kind: "skill", minutes: 25,
    example: "@Clone8 /how-its-made: a skyscraper", cover: real("/motion/story-bunker.jpg", "motion/story-bunker.mp4"), related: ["faceless-explainer", "daily-facts-series"],
    instructions: `1. Agree the object or place and phrase the topic as a question ("How is a skyscraper built?").
2. Call clone8_catalog and offer the story styles; price it with clone8_quote and wait for the person's yes.
3. Start it with clone8_make_story (confirm: true) and follow it with clone8_job.`,
  },
  {
    slug: "motivation-week", bring: "A theme", gets: ["Seven angles you approve, free", "Seven narrated motivation videos", "One posted a day at your time, if you want"], title: "Motivation week", line: "Seven motivation shorts on one message, scheduled one a day.", category: "explainers", kind: "use_case", minutes: 45,
    example: "@Clone8 /motivation-week on discipline, posted at 8 am", cover: real("/motion/motivation-comfort.jpg", "motion/loops/motivation-comfort.mp4"), related: ["motivation-short", "post-a-week"],
    instructions: `1. Agree the theme and write seven different angles on it, one line each. Show them.
2. Price one with clone8_quote (motivation kind), multiply by seven, show the total, and wait for the person's yes.
3. Make the seven with clone8_make_motivation (confirm: true) and follow them with clone8_job.
4. Offer to schedule one a day with clone8_post at the time the person picks (call clone8_accounts first; show every post before sending).`,
  },
  {
    slug: "thumbnail-ab", bring: "A photo of you and the video title", gets: ["Two very different thumbnails with their words", "Which reads better at phone size"], title: "Thumbnail A/B set", line: "Two very different thumbnails for one video, to test which gets the click.", category: "social", kind: "skill", minutes: 4,
    example: "@Clone8 /thumbnail-ab for my video \"I lived in a tent for 30 days\" with my photo: <link>", cover: pic("reaction-thumbnail", "16:9"), related: ["thumbnail-set", "podcast-cover"],
    instructions: `1. ${GET_PHOTO("a clear photo of the person (their own)")}
2. Ask for the video's title; write two thumbnail texts of up to four words, one curious and one bold.
3. Run the "thumbnail" preset twice with each text, and make a second, different version with Kling Image 4.0 "Edit a picture": the person's face large on one side, one striking object from the video on the other, high contrast, 16:9. Price all together, make them on the person's yes.
4. Put the two best side by side and say which reads better at a phone's size.`,
  },
  {
    slug: "podcast-cover", bring: "A photo of the host and the show's name", gets: ["A square show cover", "A matching wide banner"], title: "Podcast cover and banner", line: "A square show cover and a matching wide banner from the host's photo.", category: "social", kind: "skill", minutes: 5,
    example: "@Clone8 /podcast-cover for \"Late Shift\" with my photo: <link>", cover: pic("podcast-cover", "1:1"), related: ["thumbnail-ab", "quote-cards"],
    instructions: `1. ${GET_PHOTO("a photo of the host (their own)")}
2. Ask for the show's name and its mood. Run the "album-cover" preset with the show's name as its text for the square cover.
3. Make the wide banner (16:9) with Kling Image 4.0 "Edit a picture" from the cover: the same colours, type and host, laid out wide with space on the right for text.
4. Price both together; make them on the person's yes.`,
  },
  {
    slug: "quote-cards", bring: "A script or transcript", gets: ["The five strongest lines, free", "Five square quote cards, each checked word for word"], title: "Quote cards from a script", line: "The five strongest lines from a script or episode as shareable picture cards.", category: "social", kind: "skill", minutes: 4,
    example: "@Clone8 /quote-cards from this episode transcript: <paste>", cover: pic("quote-card", "1:1"), related: ["podcast-cover", "post-a-week"],
    instructions: `1. Ask for the script or transcript (pasted text). Pick the five lines that stand alone best, under 20 words each. Show them; let the person change any. Free.
2. For each line make a square picture card with a picture model that writes clean text (Kling Image 4.0 "Picture from words"): the quote in large type, a simple matching background, the speaker's name small at the bottom.
3. Price the five together; make them on the person's yes. Check every card's words against the quote and remake any with a typo (priced again).`,
  },
  {
    slug: "post-a-week", bring: "Videos you already made", gets: ["A week of posts planned: day, time, account and caption", "Everything scheduled after you approve the list"], title: "Post a week", line: "Take videos already made and schedule a week of posts across accounts.", category: "social", kind: "skill", minutes: 5,
    example: "@Clone8 /post-a-week: my last seven videos, TikTok and Instagram, 6 pm", cover: real("/motion/loops/clip-passport.jpg", "motion/loops/clip-passport.mp4"), related: ["daily-facts-series", "motivation-week"],
    instructions: `1. Call clone8_recent to list the person's finished videos, and clone8_accounts for their linked accounts. If nothing is linked, send them to link one first.
2. Agree which videos, which accounts and the time of day. Write a short caption for each (free).
3. Show the whole week as a list (day, time, video, accounts, caption) and wait for the person's yes.
4. Schedule each with clone8_post: call it without confirm first, then with confirm: true for each one in the agreed list. Finish with clone8_posts to show the week.`,
  },
  {
    slug: "brand-mascot", bring: "Your brand and its colours", gets: ["Two mascot tries to pick from", "A character sheet: front, side, back and three faces", "A 5-second intro clip"], title: "Brand mascot", line: "A friendly mascot for your brand, in a character sheet and an intro clip.", category: "characters", kind: "use_case", minutes: 8,
    example: "@Clone8 /brand-mascot for a coffee shop called Bean There", cover: pic("cartoon-3d"), related: ["character-pack", "one-character-five-looks"],
    instructions: `1. Agree the mascot: what it is (an animal, an object, a creature), its personality and the brand's colours. Free.
2. Make the mascot with a picture model ("Picture from words"; Seedream 5.0 Pro or Clone8 Portrait): front view, friendly, simple shapes, on white. Offer two tries priced together; let the person pick.
3. From the picked one, make a character sheet with Kling Image 4.0 "Edit a picture" (front, side, back, three expressions) and a 5-second intro clip with Kling 4.0 "Video from a picture" (a wave and a bounce). Price both together; make them on the person's yes.`,
  },
  {
    slug: "pet-star", bring: "A photo of your pet", gets: ["A royal portrait, a plush toy and a happy-run clip, as a set"], title: "Pet star", line: "Your pet as a royal portrait, a plush toy and a happy-run clip.", category: "characters", kind: "skill", minutes: 6,
    example: "@Clone8 /pet-star with my dog Biscuit: <link>", cover: pic("royal-pet"), related: ["character-pack", "brand-mascot"],
    instructions: `1. ${GET_PHOTO("a clear photo of the pet, face visible")}
2. Run the "royal-pet" and "plush" presets on it, and the "pet-run" preset for a video. Price the three together; make them on the person's yes.
3. Show them as a set with a caption idea using the pet's name.`,
  },
  {
    slug: "one-character-five-looks", bring: "A photo of you", gets: ["You in five looks: anime, 3D cartoon, comic, plush and action figure", "Your favourite moving, if you want it"], title: "One character, five looks", line: "The same person in five styles: anime, 3D cartoon, comic, plush and action figure.", category: "characters", kind: "skill", minutes: 6,
    example: "@Clone8 /one-character-five-looks from my photo: <link>", cover: pic("anime-still"), related: ["character-pack", "pet-star"],
    instructions: `1. ${GET_PHOTO("a photo of the person (their own), face clearly visible")}
2. Run five presets on it: "anime-still", "cartoon-3d", "comic-panel", "plush" and "action-figure" (it asks for a name on the box). Price all five together; make them on the person's yes.
3. Show them as a grid and offer to make the favourite move with Kling 4.0 "Video from a picture", priced first.`,
  },
  {
    slug: "product-teaser", bring: "One photo of your product", gets: ["Three dark, dramatic 5-second shots that end on the reveal", "In order, ready to cut"], title: "Product teaser in three shots", line: "A dark, dramatic three-shot teaser that reveals a product at the end.", category: "video", kind: "use_case", minutes: 10,
    example: "@Clone8 /product-teaser for my new headphones: <link>", cover: real("/kage-presets/product-drop.jpg", "kage/v2/product-drop.mp4"), related: ["shot-list", "product-ad"],
    instructions: `1. ${GET_PHOTO("a sharp photo of the product")}
2. Plan three 5-second shots: (1) darkness with a rim of light tracing the product's edge, (2) a close detail turning slowly, (3) the full product lit in its colour with space for the launch date. Keep the product exact in every shot.
3. Make each with Kling 4.0 "Video from a picture" from the product photo, 16:9 or 9:16 as the person wants. Price the three together; make them on the person's yes.
4. Give them in order; the person can cut them together in the Clone8 editor.`,
  },
  {
    slug: "music-video-look", bring: "A photo of the artist and a mood", gets: ["Three cinematic 5-second shots in one look, in order"], title: "Music-video look", line: "One photo of an artist into three cinematic music-video shots.", category: "video", kind: "skill", minutes: 8,
    example: "@Clone8 /music-video-look with my photo, moody neon: <link>", cover: clip("neon-rain"), related: ["shot-list", "one-character-five-looks"],
    instructions: `1. ${GET_PHOTO("a photo of the artist (the person themselves), face clearly visible")}
2. Agree the mood (neon night, desert dawn, rain, stage lights). Run the "neon-rain" preset when it fits, and make two more 5-second shots with Kling 4.0 "Video from a picture" in the same mood: a slow orbit around the artist, and a wide shot walking toward the camera.
3. Price the three together; make them on the person's yes and give the links in order.`,
  },
];

export const officialSkill = (slug: string) => CLONE8_SKILLS.find((s) => s.slug === slug) ?? null;
