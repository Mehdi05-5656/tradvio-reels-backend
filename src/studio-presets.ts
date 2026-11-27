// Clone8 Studio: presets (the home's Trending tab). A preset is a finished example plus one or two inputs (your photo,
// your product, a line of text) on top of one model. The model, the prompt and the settings are the recipe: ours, kept
// on the server, never sent to the page or stored on the job. Running one is an ordinary instrument run.
//
// Owner, Nov 25 2026 (docs/home-tabs/RESEARCH.md): copy the layer OpenArt, Everygen and Higgsfield put over their
// models (a named example, the model as a badge, Recreate). Phase 1 keeps the list in code; phase 2 moves it to a table
// with an admin tab and real recreate counts.
//
// A preset with no example yet is shown to admins only: every card a person sees must show a real result we made.

export type PresetInput = { field: string; kind: "image" | "video"; label: string; hint: string };
export type Preset = {
  id: string; title: string; line: string; output: "video" | "image";
  /** the public instrument id the recipe runs on */
  endpoint: string;
  /** the model's settings and prompt; `{text}` in the prompt is filled with the person's line */
  recipe: Record<string, any>;
  inputs: PresetInput[];
  /** settings the person may change (the rest are the recipe's) */
  choose?: string[];
  /** a short line the person writes into the prompt (a name on a box, the words on a thumbnail) */
  text?: { label: string; placeholder: string; max: number };
  /** the home-plan groups this suits, for the For you tab */
  groups: string[];
  /** the finished example (public demo media); none yet means admins only. `aspect`: its shape, for the card */
  example?: { poster: string; clip?: string; aspect?: string; /** the photo it was made from, shown beside the result */ input?: string } | null;
  added: string;
};

// Examples made Nov 25 2026 on the same models from AI-made people and products (no real person): posters ship with the
// app (public/explore/), clips sit in the public demo store under explore/.
const DEMO = "https://n0vjuejp1iev9hnr.public.blob.vercel-storage.com/explore";
const clipEx = (id: string, from: string, aspect = "3:4") => ({ poster: `/explore/${id}.jpg`, clip: `${DEMO}/${id}.mp4`, aspect, input: `/explore/in-${from}.jpg` });
const picEx = (id: string, from: string, aspect = "3:4") => ({ poster: `/explore/${id}.jpg`, aspect, input: `/explore/in-${from}.jpg` });
const PHOTO: PresetInput = { field: "image_url", kind: "image", label: "A photo of you", hint: "One person, face clearly visible, from the waist up or closer." };
const PRODUCT: PresetInput = { field: "image_url", kind: "image", label: "Your product", hint: "The product on its own, sharp, on a plain background if you have one." };
const PHOTO_REF: PresetInput = { field: "image_urls", kind: "image", label: "A photo of you", hint: "One person, face clearly visible." };
const PET_REF: PresetInput = { field: "image_urls", kind: "image", label: "Your pet", hint: "The animal on its own, face clearly visible." };
const PRODUCT_REF: PresetInput = { ...PRODUCT, field: "image_urls" };
const DISH: PresetInput = { field: "image_url", kind: "image", label: "Your dish", hint: "One plate, from above or at the table's angle, in good light." };
const GARMENT_REF: PresetInput = { field: "image_urls", kind: "image", label: "Your garment", hint: "The piece on its own, laid flat or on a hanger, sharp and well lit." };
const PET: PresetInput = { field: "image_url", kind: "image", label: "Your pet", hint: "The animal on its own, whole body visible." };
// Drafts added Nov 26 2026 (docs/catalog/FILL_PLAN.md, batches A-E): no example yet, so admins only until each one is
// tested on three inputs, its example is made and the owner approves it. Every person in an example is AI-made.
const V = (prompt: string, extra: Record<string, any> = {}) => ({ duration: 5, resolution: "1080p", prompt, ...extra });
/** Products only: a model once wrote a real luxury brand on a plain lipstick (Nov 26 2026 test), so every product
 *  recipe says no new names or words. */
const NO_BRANDS = " Do not add any brand name, logo, label or words that are not already on the product in the photo.";
const K = (prompt: string, aspect = "3:4") => ({ resolution: "2k", aspect_ratio: aspect, prompt });

export const PRESETS: Preset[] = [
  // ---- video, from a photo of a person ----
  { id: "main-character", title: "Main character", line: "Walk into frame like the film is about you.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The person from the photo walks toward the camera in slow motion down a sunlit city street at golden hour, confident, wind moving their hair and clothes. People on the sidewalk turn to look. The camera tracks backward at eye level, shallow depth of field, warm cinematic film look." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], example: clipEx("main-character", "woman"), added: "2026-11-25" },
  { id: "paparazzi", title: "Paparazzi", line: "Out of the car, into a wall of flashes.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The person from the photo steps onto a red carpet at night as dozens of camera flashes go off around them. Photographers crowd the rope and call their name. They pause, glance over their shoulder at the camera and smile. Handheld press-camera feel, bright flash pops, glamorous." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], example: clipEx("paparazzi", "man"), added: "2026-11-25" },
  { id: "walk-away", title: "Don't look back", line: "A blockbuster explosion behind you, with sound.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 5, aspect_ratio: "9:16", generate_audio: true, prompt: "The person from the photo walks calmly toward the camera without looking back as a huge fireball explosion erupts behind them in an abandoned industrial yard. Sparks and debris fly past. Slow push-in, blockbuster action-film look, deep booming explosion sound and rumbling bass." },
    inputs: [PHOTO], choose: ["aspect_ratio"], groups: ["ai", "characters", "personal"], added: "2026-11-25" },
  { id: "earth-zoom", title: "Earth zoom out", line: "From you to space in one move.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "Starting on the person in the photo, the camera rises straight up and pulls back in one continuous, seamless move: over the rooftops, through the clouds, until the whole Earth is visible from space, then it holds. Smooth, no cuts." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], example: clipEx("earth-zoom", "woman"), added: "2026-11-25" },
  { id: "street-interview", title: "Street interview", line: "Stopped on the street, mic in your face. You say the line.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 6, aspect_ratio: "9:16", generate_audio: true, prompt: "The person from the photo is stopped on a busy city street by an interviewer who holds a microphone into the frame. They laugh, then answer straight to the camera, saying clearly: \"{text}\". Natural street sound and passing traffic, handheld vertical phone footage, like a viral street interview." },
    inputs: [PHOTO], text: { label: "What you say", placeholder: "I quit my job to do this full time", max: 80 }, groups: ["personal", "ai"], added: "2026-11-25" },
  // ---- video, from a product photo ----
  { id: "product-spin", title: "Product hero", line: "Your product on a pedestal, lit like an ad.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The product from the photo turns slowly on a glossy black pedestal while a soft light sweeps across it. Tiny particles drift in the air. The camera orbits slowly. Studio commercial look, crisp reflections, premium." },
    inputs: [PRODUCT], groups: ["ads", "ai"], example: clipEx("product-spin", "can"), added: "2026-11-25" },
  { id: "product-splash", title: "Splash drop", line: "Your product hits the water in slow motion, with sound.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 5, aspect_ratio: "9:16", generate_audio: true, prompt: "The product from the photo drops into crystal-clear water in slow motion. A big splash and bubbles burst around it, droplets catch the light, bright clean background, premium drink-commercial look, crisp splash sound." },
    inputs: [PRODUCT], choose: ["aspect_ratio"], groups: ["ads", "ai"], added: "2026-11-25" },
  { id: "unboxing", title: "Unboxing", line: "Hands lift it out of the box: real, cosy, UGC.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "Two hands slowly lift the product from the photo out of a minimal box on a wooden desk in soft morning window light, then turn it toward the camera. Authentic, cosy, phone-camera UGC feel." },
    inputs: [PRODUCT], groups: ["ads", "personal"], example: clipEx("unboxing", "sneaker"), added: "2026-11-25" },
  // ---- pictures ----
  { id: "action-figure", title: "Action figure", line: "You, boxed as a collectible toy, your name on the card.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Turn the person in @image_1 into a collectible action figure sealed in a retail blister pack. The figure keeps their face, hair and outfit, with small matching accessories in moulded slots beside it. The card backing shows the name \"{text}\" in bold toy-brand lettering. Product photo on a plain background, sharp, glossy plastic." },
    inputs: [PHOTO_REF], text: { label: "Name on the box", placeholder: "CAPTAIN ALEX", max: 24 }, groups: ["characters", "personal", "ai"], example: picEx("action-figure", "woman"), added: "2026-11-25" },
  { id: "magazine-cover", title: "Cover star", line: "You on a magazine cover, your title on the masthead.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "A high-fashion magazine cover with the person in @image_1 as the cover star, studio portrait. The masthead at the top reads \"{text}\" in large elegant serif letters, with a few short cover lines in smaller type. Glossy print look." },
    inputs: [PHOTO_REF], text: { label: "Magazine name", placeholder: "VOGUE-ISH", max: 20 }, groups: ["personal", "characters"], example: picEx("magazine-cover", "man"), added: "2026-11-25" },
  { id: "thumbnail", title: "Shock thumbnail", line: "A click-me YouTube thumbnail with your words.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "16:9", prompt: "A YouTube thumbnail: the person in @image_1 at a podcast microphone with a shocked expression, neon-lit studio behind them, and big bold words \"{text}\" with a thick outline beside them. High contrast, saturated, 16:9." },
    inputs: [PHOTO_REF], text: { label: "Thumbnail words", placeholder: "I WAS WRONG", max: 24 }, groups: ["clipping", "personal", "edit"], example: picEx("thumbnail", "man", "16:9"), added: "2026-11-25" },
  { id: "pet-ceo", title: "Pet CEO", line: "Your pet runs the board meeting.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "The animal from the first picture sits at the head of a boardroom table in a tailored suit and tie, serious expression, city skyline through floor-to-ceiling windows. Corporate portrait photo, photorealistic." },
    inputs: [PET_REF], groups: ["characters", "ai"], example: picEx("pet-ceo", "dog"), added: "2026-11-25" },
  { id: "anime-still", title: "Painted anime", line: "You as a soft, hand-painted anime film still.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Redraw the person in the first picture as a soft hand-painted anime film still: warm afternoon light, a lush green hillside under tall summer clouds, gentle watercolour textures. Keep their face, hair and outfit." },
    inputs: [PHOTO_REF], groups: ["characters", "stories", "ai"], example: picEx("anime-still", "woman"), added: "2026-11-25" },
  // ---- Nov 25 2026, second set (owner: fill Explore) ----
  { id: "neon-rain", title: "Neon rain", line: "You, still, as slow-motion rain falls in neon light.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "Night falls: the person from the photo stands still on a neon-lit city street as heavy rain falls in slow motion around them, pink and blue neon reflections on the wet ground, they slowly look up into the camera. Cinematic, moody, beautiful." },
    inputs: [PHOTO], groups: ["ai", "personal"], example: clipEx("neon-rain", "woman"), added: "2026-11-25" },
  { id: "hero-landing", title: "Hero landing", line: "Drop from the sky into a superhero landing.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The person from the photo leaps down from above and lands in a superhero landing on the street, one knee and fist on the ground, cracks spreading through the asphalt and dust blasting outward, then they slowly stand and look into the camera. Epic slow motion." },
    inputs: [PHOTO], groups: ["ai", "personal"], example: clipEx("hero-landing", "man"), added: "2026-11-25" },
  { id: "pet-run", title: "Happy run", line: "Your pet runs to the camera in slow motion.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The animal from the photo leaps up and runs joyfully straight toward the camera across a sunny meadow in slow motion, ears flapping, grass and sunlight flaring around it. Cinematic, heart-warming." },
    inputs: [{ ...PET_REF, field: "image_url" }], groups: ["characters", "ai"], example: clipEx("pet-run", "dog"), added: "2026-11-25" },
  { id: "can-splash", title: "Ice splash", line: "Your drink bursts out of ice and splashing water.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The product from the photo bursts upward out of a splash of ice cubes, citrus slices and water droplets that freeze in mid-air around it, bright studio light, slow-motion drink commercial." },
    inputs: [PRODUCT], groups: ["ads", "ai"], example: clipEx("can-splash", "can"), added: "2026-11-25" },
  { id: "sneaker-float", title: "Levitate", line: "Your product floats and turns, lit like a launch.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The product from the photo lifts off and floats in mid-air, slowly rotating, as glowing particles and small pebbles levitate around it against a dark studio backdrop with a soft rim light. Premium launch ad." },
    inputs: [PRODUCT], groups: ["ads", "ai"], example: clipEx("sneaker-float", "sneaker"), added: "2026-11-25" },
  { id: "headshot", title: "Pro headshot", line: "A clean studio headshot for your profile.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Professional studio headshot of the person in the first picture for a work profile: navy blazer over a crisp white shirt, soft light grey backdrop, soft key light, friendly confident smile, sharp focus, photorealistic." },
    inputs: [PHOTO_REF], groups: ["personal"], example: picEx("headshot", "man"), added: "2026-11-25" },
  { id: "cartoon-3d", title: "3D cartoon", line: "You as an animated movie character.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Turn the person in the first picture into a cute stylised 3D animated movie character with big expressive eyes, keeping their hair, outfit and accessories, soft studio lighting, a colourful city background." },
    inputs: [PHOTO_REF], groups: ["characters", "ai"], example: picEx("cartoon-3d", "woman"), added: "2026-11-25" },
  { id: "album-cover", title: "Album cover", line: "Your own album cover, your title on it.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "1:1", prompt: "A square album cover: the person in @image_1 lit in moody red and blue light with film grain, the title \"{text}\" in bold condensed letters across the bottom. Clean, striking, readable text." },
    inputs: [PHOTO_REF], text: { label: "Album title", placeholder: "AFTER HOURS", max: 24 }, groups: ["personal", "characters"], example: picEx("album-cover", "man", "1:1"), added: "2026-11-25" },
  { id: "royal-pet", title: "Royal portrait", line: "Your pet as a monarch, in oils.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "A classical oil painting portrait of the animal in the first picture as a royal monarch wearing a red velvet cape with white ermine trim and a small golden crown, in an ornate gilded frame, museum lighting, fine brushwork." },
    inputs: [PET_REF], groups: ["characters"], example: picEx("royal-pet", "dog"), added: "2026-11-25" },
  { id: "plush", title: "Plush toy", line: "Your pet as a soft toy.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Turn the animal in the first picture into an adorable plush toy sitting on a kid's bed, soft fuzzy fabric, visible stitching, keeping its colours and happy face, cosy warm light, product photo." },
    inputs: [PET_REF], groups: ["characters"], example: picEx("plush", "dog"), added: "2026-11-25" },
  { id: "billboard", title: "Billboard", line: "Your product on a city billboard, your line on it.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "The product from @image_1 shown on a giant illuminated billboard above a busy city intersection at night, the billboard headline reads \"{text}\", people and traffic below, photorealistic, crisp readable text." },
    inputs: [{ ...PRODUCT, field: "image_urls" }], text: { label: "Headline", placeholder: "STAY CHARGED", max: 24 }, groups: ["ads"], example: picEx("billboard", "can"), added: "2026-11-25" },
  { id: "comic-panel", title: "Comic hero", line: "You in a comic panel, your words in the bubble.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "A comic book page panel of the person in @image_1 as a hero leaping between rooftops at sunset, bold ink lines, halftone dots, vivid colours, a speech bubble that says \"{text}\" in clean comic lettering." },
    inputs: [PHOTO_REF], text: { label: "Speech bubble", placeholder: "NOT TODAY!", max: 24 }, groups: ["characters"], example: picEx("comic-panel", "woman"), added: "2026-11-25" },
  { id: "sneaker-ad", title: "Luxury ad", line: "A calm, premium magazine ad for your product.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "A luxury magazine advertisement for the product in @image_1, floating above a calm infinity pool at sunset, minimal layout, the headline \"{text}\" in elegant serif type at the top, premium and calm." },
    inputs: [{ ...PRODUCT, field: "image_urls" }], text: { label: "Headline", placeholder: "WALK SOFTLY", max: 24 }, groups: ["ads"], example: picEx("sneaker-ad", "sneaker"), added: "2026-11-25" },
  // ---- batch A: products and e-commerce (drafts) ----
  { id: "food-hero", title: "Food hero", line: "Your dish, steaming, with a slow sauce pour.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The dish from the photo sits on a dark wooden table. Steam rises from it and a spoonful of glossy sauce drizzles over it in slow motion. Warm side light, the camera pushes in slowly, a premium food-commercial look. The plate, the food and its colours stay exactly as in the photo." + NO_BRANDS),
    inputs: [DISH], groups: ["ads"], added: "2026-11-26" },
  { id: "drink-pour", title: "Perfect pour", line: "Your drink poured in slow motion, ice and all.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The drink from the photo is poured into a chilled glass in slow motion: the liquid curls, ice cubes tumble and bubbles rise, a few droplets run down the glass. Bright studio light on a clean background, a beverage-commercial look. The bottle or can keeps its label exactly." + NO_BRANDS),
    inputs: [PRODUCT], groups: ["ads"], added: "2026-11-26" },
  { id: "jewelry-macro", title: "Jewelry macro", line: "Your piece on velvet, every facet catching light.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A macro product photograph of the jewelry in the first picture resting on deep midnight-blue velvet. Tiny sparkles on every facet, a soft spotlight, shallow depth of field, luxury catalogue look. The piece keeps its exact design, metal colour and stones." + NO_BRANDS),
    inputs: [PRODUCT_REF], groups: ["ads"], added: "2026-11-26" },
  { id: "beauty-splash", title: "Beauty splash", line: "Your bottle in a crown of water on pastel.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("The skincare or beauty product in @image_1 stands in the middle of a perfect crown of clear water splash on a soft pastel background, droplets frozen in mid-air, clean high-key light, premium beauty advert. Its packaging and printed words stay exactly as in the photo." + NO_BRANDS),
    inputs: [PRODUCT_REF], groups: ["ads"], added: "2026-11-26" },
  { id: "perfume-mist", title: "Perfume mist", line: "Your bottle in drifting mist and light rays.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The bottle from the photo stands on a reflective surface as soft mist drifts slowly around it and rays of light cut through the haze. The camera circles a quarter turn. Elegant fragrance-commercial look. The bottle keeps its exact shape and label." + NO_BRANDS),
    inputs: [PRODUCT], groups: ["ads"], added: "2026-11-26" },
  { id: "flat-lay", title: "Styled flat-lay", line: "Your piece laid out with matching accessories.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A styled overhead flat-lay of the garment in @image_1 on natural linen, neatly folded, with two or three matching accessories (sunglasses, a watch, a small bag) arranged around it, soft daylight, fashion-magazine styling. The garment keeps its exact colour, cut, print and logo." + NO_BRANDS, "3:4"),
    inputs: [GARMENT_REF], groups: ["ads"], added: "2026-11-26" },
  { id: "try-on", title: "On-model try-on", line: "Your garment worn by a model in a clean studio.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A full-body fashion photograph of a model wearing the garment in @image_1 in a clean light-grey studio, natural pose, soft key light, e-commerce lookbook style. The model is an invented person, not anyone real. The garment keeps its exact colour, cut, fabric, print and logo, and fits naturally." + NO_BRANDS),
    inputs: [GARMENT_REF], groups: ["ads"], added: "2026-11-26" },
  { id: "white-background", title: "Marketplace white", line: "A clean white-background shot for any shop.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A clean e-commerce product photo of the product in @image_1 centred on a pure white background with a soft natural shadow beneath it, evenly lit, sharp edges, nothing else in frame. The product keeps its exact shape, colour, logo and printed words." + NO_BRANDS, "1:1"),
    inputs: [PRODUCT_REF], groups: ["ads"], added: "2026-11-26" },
  { id: "in-hand", title: "In hand", line: "Your product held up in a real moment.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A natural lifestyle photo of a hand holding the product in @image_1 up toward the camera in a sunlit cafe, background softly blurred, phone-camera feel, authentic and warm. The product keeps its exact packaging and words; the hand holds it naturally." + NO_BRANDS, "3:4"),
    inputs: [PRODUCT_REF], groups: ["ads", "personal"], added: "2026-11-26" },
  { id: "turntable", title: "360 turntable", line: "A full turn on a white sweep, every side shown.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The product from the photo turns one full slow rotation on a white turntable against a seamless white studio sweep, evenly lit, a soft shadow, the camera still. Clean e-commerce 360 view. The product keeps its exact shape, colour and logo." + NO_BRANDS),
    inputs: [PRODUCT], groups: ["ads"], added: "2026-11-26" },
  // ---- batch B: effects on your photo (drafts) ----
  { id: "crash-zoom", title: "Crash zoom", line: "The camera slams in on your face.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The camera rushes in from a wide shot to an extreme close-up of the face of the person in the photo in one fast crash zoom, then holds as they raise an eyebrow. Punchy, high energy, like a viral edit."),
    inputs: [PHOTO], groups: ["ai", "personal"], added: "2026-11-26" },
  { id: "orbit-360", title: "360 orbit", line: "The camera circles all the way around you.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The camera orbits a full slow circle around the person in the photo as they stand still and look into the lens at the end. Their face, hair and clothes stay consistent from every angle. Cinematic music-video look."),
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], added: "2026-11-26" },
  { id: "marble-statue", title: "Turn to marble", line: "You turn into a marble statue, crack by crack.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo slowly turns into a polished white marble statue, starting at their hands and spreading upward with fine cracks and a soft dusty glow, until the whole figure is stone in a museum hall. Smooth, eerie, cinematic."),
    inputs: [PHOTO], groups: ["ai", "characters"], added: "2026-11-26" },
  { id: "paint-melt", title: "Melt into paint", line: "You dissolve into colourful dripping paint.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo melts into thick, colourful liquid paint that drips and swirls downward in slow motion against a white background, vivid and satisfying."),
    inputs: [PHOTO], groups: ["ai", "characters"], added: "2026-11-26" },
  { id: "butterflies", title: "Butterfly burst", line: "You scatter into a cloud of butterflies.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo smiles, then their body gently breaks apart into hundreds of bright butterflies that fly up and away into a sunny sky. Magical, soft light, smooth."),
    inputs: [PHOTO], groups: ["ai", "characters"], added: "2026-11-26" },
  { id: "hair-flip", title: "Hair flip", line: "A slow-motion hair flip, lit like an ad.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo turns their head and flips their hair in slow motion, the hair catching warm backlight, a confident smile at the end. Shampoo-commercial look, the face consistent throughout."),
    inputs: [PHOTO], groups: ["ai", "personal"], added: "2026-11-26" },
  { id: "runway-walk", title: "Runway walk", line: "You on a fashion runway, flashes going off.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo walks confidently down a fashion-show runway toward the camera, an audience on both sides with camera flashes popping, dramatic spotlights. Their face and outfit stay the same."),
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], added: "2026-11-26" },
  { id: "drone-pullback", title: "City drone pull-back", line: "From you on a rooftop to the whole city at night.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The person in the photo stands on a rooftop at night; the camera pulls back and rises like a drone in one smooth move, revealing the glowing city skyline around them. Cinematic, no cuts."),
    inputs: [PHOTO], groups: ["ai", "personal"], added: "2026-11-26" },
  // ---- batch C: portraits and looks (drafts) ----
  { id: "yearbook-90s", title: "90s yearbook", line: "Your school photo, straight out of 1996.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A 1990s American high-school yearbook portrait of the person in the first picture: laser-blue studio backdrop, soft flash, era-accurate hair and clothes, slight film grain. Their face stays recognisably theirs."),
    inputs: [PHOTO_REF], groups: ["characters", "personal"], added: "2026-11-26" },
  { id: "film-noir", title: "Film noir", line: "Black and white, venetian-blind shadows, 1947.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A black-and-white 1940s film-noir portrait of the person in the first picture: a fedora or a pinned wave, venetian-blind shadows across the face, cigarette-smoke haze without a cigarette, high contrast. Their face stays recognisably theirs."),
    inputs: [PHOTO_REF], groups: ["characters"], added: "2026-11-26" },
  { id: "fashion-editorial", title: "Fashion editorial", line: "You on the cover shoot of a fashion magazine.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A high-fashion editorial photograph of the person in the first picture in a bold designer outfit, dramatic studio light, a strong pose against a coloured paper backdrop, magazine quality. Their face stays recognisably theirs."),
    inputs: [PHOTO_REF], groups: ["characters", "personal"], added: "2026-11-26" },
  { id: "renaissance", title: "Renaissance portrait", line: "You, painted in oil by an old master.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A Renaissance oil painting of the person in the first picture in period clothes, soft window light, a dark background, visible brushwork and craquelure, museum quality. Their face stays recognisably theirs."),
    inputs: [PHOTO_REF], groups: ["characters"], added: "2026-11-26" },
  { id: "claymation", title: "Claymation", line: "You as a hand-made clay figure.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("The person in the first picture as a handmade claymation figure with visible fingerprints in the clay, a small miniature set behind them, warm stop-motion lighting. Keep their hair, outfit and expression."),
    inputs: [PHOTO_REF], groups: ["characters", "ai"], added: "2026-11-26" },
  { id: "astronaut", title: "Astronaut", line: "You in a spacesuit, Earth over your shoulder.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A cinematic portrait of the person in the first picture as an astronaut in a white spacesuit with the helmet off, inside a space station window with Earth glowing behind them. Their face stays recognisably theirs, realistic."),
    inputs: [PHOTO_REF], groups: ["characters", "ai"], added: "2026-11-26" },
  { id: "polaroid", title: "Vintage Polaroid", line: "A sun-faded instant photo from a summer long ago.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A vintage instant-film Polaroid of the person in the first picture on a summer beach in the late 1970s: faded warm colours, soft focus, light leaks, the white Polaroid frame around it. Their face stays recognisably theirs.", "3:4"),
    inputs: [PHOTO_REF], groups: ["personal", "characters"], added: "2026-11-26" },
  { id: "cyberpunk", title: "Cyberpunk", line: "You in a neon city, rain and holograms.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("A cyberpunk portrait of the person in the first picture on a rainy neon-lit street at night, holographic signs, reflective wet asphalt, a techwear jacket, cinematic magenta and teal light. Their face stays recognisably theirs."),
    inputs: [PHOTO_REF], groups: ["characters", "ai"], added: "2026-11-26" },
  // ---- batch D: social and thumbnails (drafts) ----
  { id: "reaction-thumbnail", title: "Reaction thumbnail", line: "Your shocked face, big words, high contrast.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A YouTube thumbnail: the person in @image_1 on the left with a big shocked expression, mouth open, bright rim light, a bold yellow outline around them; on the right the words \"{text}\" in huge white block letters with a black outline; a saturated background. Their face stays recognisably theirs.", "16:9"),
    inputs: [PHOTO_REF], text: { label: "Thumbnail words", placeholder: "I CAN'T BELIEVE IT", max: 24 }, groups: ["personal"], added: "2026-11-26" },
  { id: "podcast-cover", title: "Podcast cover", line: "A square show cover with your name on it.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A professional square podcast cover: the person in @image_1 in a tight portrait with a microphone, a bold duotone colour treatment, and the show's name \"{text}\" in large clean letters across the top. Readable at a small size. Their face stays recognisably theirs.", "1:1"),
    inputs: [PHOTO_REF], text: { label: "Show name", placeholder: "LATE SHIFT", max: 24 }, groups: ["personal"], added: "2026-11-26" },
  { id: "channel-banner", title: "Channel banner", line: "A wide channel banner with your name.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A wide YouTube channel banner: the person in @image_1 on the right, smiling, cut out cleanly over a bold gradient background with subtle shapes, and the channel name \"{text}\" in big modern letters in the centre-left, all important content kept inside the middle third. Their face stays recognisably theirs.", "16:9"),
    inputs: [PHOTO_REF], text: { label: "Channel name", placeholder: "Maya Makes", max: 24 }, groups: ["personal"], added: "2026-11-26" },
  { id: "quote-card", title: "Quote card", line: "Your words and your face on a share-ready card.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A clean square social quote card: a soft black-and-white portrait of the person in @image_1 on the left third, and the quote \"{text}\" in large elegant serif type on the right on a warm off-white background, with generous margins. Every word spelled exactly.", "1:1"),
    inputs: [PHOTO_REF], text: { label: "Your quote", placeholder: "Start before you feel ready", max: 60 }, groups: ["personal"], added: "2026-11-26" },
  { id: "event-poster", title: "Event poster", line: "A bold poster for your show, launch or night.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: K("A bold event poster featuring the person in @image_1 as the headliner in dramatic stage light, with the event name \"{text}\" in huge display letters at the top, gig-poster style, grainy print texture. Their face stays recognisably theirs. Every word spelled exactly."),
    inputs: [PHOTO_REF], text: { label: "Event name", placeholder: "FRIDAY NIGHT LIVE", max: 24 }, groups: ["personal"], added: "2026-11-26" },
  // ---- batch E: pets (drafts) ----
  { id: "pet-astronaut", title: "Pet astronaut", line: "Your pet in a tiny spacesuit, floating in orbit.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("The pet in the first picture wearing a tiny white spacesuit with the helmet visor up, floating weightless inside a space station with Earth in the window behind. Keep its exact breed, fur colour and markings. Cute, realistic."),
    inputs: [PET_REF], groups: ["characters"], added: "2026-11-26" },
  { id: "pet-superhero", title: "Pet superhero", line: "Your pet in a cape, saving the city.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: K("The pet in the first picture as a superhero with a flowing red cape and a small mask, standing heroically on a rooftop at sunset over a city. Keep its exact breed, fur colour and markings. Comic-movie poster look."),
    inputs: [PET_REF], groups: ["characters"], added: "2026-11-26" },
  { id: "pet-runway", title: "Pet runway", line: "Your pet struts the catwalk to the flashes.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: V("The pet from the photo struts proudly down a fashion runway toward the camera wearing a tiny stylish jacket, camera flashes popping on both sides, spotlights. Keep its exact breed, fur colour and markings. Funny and charming."),
    inputs: [PET], groups: ["characters"], added: "2026-11-26" },
];

const byId = new Map(PRESETS.map((p) => [p.id, p]));
export const presetById = (id: unknown): Preset | null => (typeof id === "string" ? byId.get(id) ?? null : null);

/** What the person chose for a preset: only the settings it lets them change, plus its line of text (trimmed). */
export function presetChoices(p: Preset, raw: any): Record<string, any> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out: Record<string, any> = {};
  for (const k of p.choose ?? []) if (input[k] !== undefined && input[k] !== null && input[k] !== "") out[k] = input[k];
  if (p.text) {
    const t = String(input.text ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩"]/g, "").replace(/\s+/g, " ").trim().slice(0, p.text.max);
    if (!t) throw new PresetError("preset_text_required", `${p.text.label} is needed`);
    out.text = t;
  }
  return out;
}
/** The model's full settings for a preset run: the recipe, the person's choices on top, their line in the prompt. */
export function withRecipe(presetId: unknown, params: Record<string, any>): Record<string, any> {
  const p = presetById(presetId);
  if (!p) return params;
  const { text, ...chosen } = params ?? {};
  const recipe = { ...p.recipe };
  if (typeof recipe.prompt === "string") recipe.prompt = recipe.prompt.replace("{text}", String(text ?? ""));
  const allowed: Record<string, any> = {};
  for (const k of p.choose ?? []) if (chosen[k] !== undefined) allowed[k] = chosen[k];
  return { ...recipe, ...allowed };
}
/** The instrument request a preset run makes: its model, the full settings, and only the inputs it asks for. */
export function presetRequest(p: Preset, options: any): { endpoint: string; params: Record<string, any>; inputs: Record<string, any> } {
  const choices = presetChoices(p, options?.params);
  const given = options?.inputs && typeof options.inputs === "object" ? options.inputs : {};
  const inputs: Record<string, any> = {};
  for (const i of p.inputs) {
    const v = given[i.field];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) throw new PresetError("preset_input_required", `${i.label} is needed`);
    inputs[i.field] = v;
  }
  return { endpoint: p.endpoint, params: withRecipe(p.id, choices), inputs };
}
export class PresetError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

/** The presets a person can see: those on an offered model, with a real example (admins also see the ones without). */
export function presetsOffered(offered: Set<string>, opts: { admin?: boolean } = {}): Preset[] {
  return PRESETS.filter((p) => offered.has(p.endpoint) && (opts.admin || !!p.example));
}
/** What the page gets: never the recipe. */
export function publicPreset(p: Preset, model: { family: string; title: string } | null) {
  return { id: p.id, title: p.title, line: p.line, output: p.output, endpoint: p.endpoint, model: model?.family ?? null, inputs: p.inputs, choose: p.choose ?? [], text: p.text ?? null,
    groups: p.groups, example: p.example ?? null, added: p.added, draft: !p.example };
}
