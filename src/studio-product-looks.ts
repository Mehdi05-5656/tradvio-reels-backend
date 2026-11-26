// Clone8 Studio: product looks (docs/model-features/PRODUCT_ADS_PLAN.md, owner Nov 26 2026). One product photo becomes
// many designs (shots) and short animations (motion). A look is a preset made for products: the person picks a look,
// the recipe (model, prompt, settings) stays here on the server and joins the request at run time, exactly like
// studio-presets.ts. Every run is an ordinary instrument job, priced and booked the same way.
//
// What the leaders taught us (research Nov 26 2026): one hero motion per clip, 4–6 s, ending on the product's front; a
// clean start frame; labels kept letter for letter; no hands, people or invented text; prices and claims added later as
// text, never generated. The product's category decides which looks are offered, so nobody sees "pour" for a sneaker.
//
// Tested Nov 26 2026 on the owner account (docs/model-features/tests-2026-11-26): Kling 3.0 Pro does the actions,
// Kling 4.0 the camera and light moves and the start-to-end-frame moves; Seedream 5.0 Pro edit makes the shots.

export const PRODUCT_CATEGORIES = ["beverage", "beauty", "fragrance", "fashion", "footwear", "accessories", "jewellery", "tech", "food", "supplements", "home", "toys", "pets", "app", "other"] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<ProductCategory, string> = {
  beverage: "Drink", beauty: "Beauty & skincare", fragrance: "Fragrance", fashion: "Clothing", footwear: "Shoes", accessories: "Bags & accessories",
  jewellery: "Jewellery & watches", tech: "Tech & gadgets", food: "Food & snacks", supplements: "Supplements", home: "Home", toys: "Toys & games", pets: "Pet products",
  app: "App or software", other: "Something else",
};
/** What we keep about a product (on its picture's probe, `probe.product`). Read by Claude, corrected by the person. */
export type ProductFacts = { name: string; category: ProductCategory; colour: string | null; label_text: string | null; line: string | null; source_url?: string | null; price?: string | null };

export type LookKind = "shot" | "motion";
export type LookInput = { field: string; label: string; hint: string; /** the picture this slot takes by default */ from: "product" | "exploded" };
export type Look = {
  id: string; kind: LookKind; title: string; line: string;
  /** shelf on the page */
  group: string;
  /** categories it suits; "all" fits every product except an app */
  fits: ProductCategory[] | "all";
  endpoint: string;
  /** the model's settings (never sent to the page); the prompt may use {name}, {colour}, {motion} */
  recipe: Record<string, any>;
  /** where each picture goes in the request; a motion look starts from the product (or a shot of it) */
  inputs: LookInput[];
  /** a matched sound effect laid under a motion clip (ElevenLabs), in words */
  sfx?: string;
  /** passes TikTok Shop's US rules (no AI-exaggerated effects, no animated static product): for the Shop-safe mode */
  shop_safe: boolean;
  /** a finished example we made; none means admins only */
  example?: { poster: string; clip?: string; aspect?: string } | null;
  added: string;
};

// Every product picture prompt says what must not change. The leaders' first defence against garbled labels.
const KEEP_STILL = "Keep the product from the first picture exactly as it is: same shape, proportions, colours, materials, logo and label; every letter stays sharp and unchanged; never invent, translate or add text; no extra logos, no watermark.";
const KEEP_MOTION = "The product is exactly the one in the image: same shape, proportions, colours, materials, logo and label. Every letter on it stays sharp, unchanged and readable in every frame; never invent, add, translate or warp text; no extra logos. No hands, no people, no captions, no added text. One continuous shot, no cuts. It ends on a clean, stable front view of the product.";
const shot = (prompt: string) => ({ resolution: "2k", aspect_ratio: "3:4", prompt: `${prompt} ${KEEP_STILL} Photorealistic product photography.` });
const action = (prompt: string) => ({ duration: 5, sound: "off", prompt: `${prompt} ${KEEP_MOTION}` });
const camera = (prompt: string) => ({ duration: 5, resolution: "720p", prompt: `${prompt} ${KEEP_MOTION}` });
const SEEDREAM = "bytedance/seedream/v5.0/pro/edit", KLING_ACT = "kling-video/v3.0/pro/image-to-video", KLING_CAM = "kling-video/v4.0/image-to-video";
const PRODUCT_IN: LookInput = { field: "image_url", label: "Your product", hint: "The product on its own, sharp, the label facing the camera.", from: "product" };
const PRODUCT_REF: LookInput = { ...PRODUCT_IN, field: "image_urls" };
const NOT_APP: ProductCategory[] = PRODUCT_CATEGORIES.filter((c) => c !== "app");

export const LOOKS: Look[] = [
  // ---- Shots: one photo, many designs (Seedream 5.0 Pro edit, 2K, 3:4) ----
  { id: "shot-white", kind: "shot", title: "Clean white", line: "The marketplace packshot: pure white, soft shadow.", group: "Studio", fits: "all", endpoint: SEEDREAM,
    recipe: shot("The product from the first picture alone on a pure white seamless background, centred, filling about two thirds of the frame, front facing, soft even studio light, a soft natural contact shadow."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-brand", kind: "shot", title: "Brand colour hero", line: "Your product on a seamless wall in its own colour.", group: "Studio", fits: "all", endpoint: SEEDREAM,
    recipe: shot("The product from the first picture standing on a seamless studio backdrop in a soft tint of its own main colour ({colour}), shot from a slightly low hero angle, crisp key light, gentle reflection on the floor."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-pedestal", kind: "shot", title: "Pedestal", line: "On a sculpted stone plinth, lit like a gallery piece.", group: "Studio", fits: ["beauty", "fragrance", "jewellery", "tech", "footwear", "accessories", "beverage", "supplements"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture displayed on a pale travertine pedestal with soft geometric shadows, a warm neutral backdrop, refined gallery lighting, calm and premium."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-glow", kind: "shot", title: "Night glow", line: "Dark backdrop, a rim of light: premium and moody.", group: "Studio", fits: ["fragrance", "jewellery", "beauty", "tech", "beverage", "footwear", "accessories"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture on a deep charcoal backdrop, sculpted by a thin rim light and a soft glow behind it, glossy dark surface with a faint reflection, luxurious and moody."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-flatlay", kind: "shot", title: "Flat lay", line: "Top-down, styled with a few things that belong with it.", group: "Lifestyle", fits: ["fashion", "beauty", "supplements", "food", "accessories", "jewellery", "tech", "pets", "toys"], endpoint: SEEDREAM,
    recipe: shot("A top-down flat lay of the product from the first picture on a soft linen surface, styled with three or four simple props that suit it, neat spacing, soft daylight from one side."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-kitchen", kind: "shot", title: "Kitchen counter", line: "Morning light on a real kitchen counter.", group: "Lifestyle", fits: ["beverage", "food", "supplements", "home", "pets"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture on a sunlit kitchen counter in the morning, a softly blurred cosy kitchen behind it, natural window light, lived-in and real."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-bathroom", kind: "shot", title: "Bathroom shelf", line: "On a marble shelf beside a sunny window.", group: "Lifestyle", fits: ["beauty", "fragrance", "supplements"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture on a white marble bathroom shelf beside a bright window, a sprig of eucalyptus and a folded towel softly blurred nearby, fresh morning light."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-desk", kind: "shot", title: "Desk setup", line: "On a clean modern desk, laptop glow behind.", group: "Lifestyle", fits: ["tech", "accessories", "beverage", "supplements"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture on a clean modern wooden desk, a laptop and a small plant softly blurred behind, warm afternoon light, tidy and aspirational."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-hand", kind: "shot", title: "In hand", line: "Held up to the camera, like a real phone photo.", group: "Lifestyle", fits: ["beverage", "beauty", "fragrance", "tech", "food", "supplements", "jewellery", "accessories", "toys", "pets"], endpoint: SEEDREAM,
    recipe: shot("A hand holds the product from the first picture up toward the camera, the label facing the lens and fully visible, fingers clear of the logo, a casual real-life background softly blurred, natural phone-camera look."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-street", kind: "shot", title: "Worn outside", line: "On a model on a city street, editorial style.", group: "Lifestyle", fits: ["fashion", "footwear", "accessories", "jewellery"], endpoint: SEEDREAM,
    recipe: shot("An editorial street-style photo of a model wearing the product from the first picture on a sunny city sidewalk, the product clearly the focus, natural golden-hour light, fashion magazine look."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-macro", kind: "shot", title: "Close-up", line: "So close you can feel the texture.", group: "Detail", fits: ["beauty", "food", "fashion", "footwear", "jewellery", "accessories", "beverage"], endpoint: SEEDREAM,
    recipe: shot("An extreme close-up macro photo of the product from the first picture showing its surface texture and finish in fine detail, shallow depth of field, soft directional light; the logo, if in frame, stays exactly as it is."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-pop", kind: "shot", title: "Colour pop", line: "Bold blocks of colour and playful shapes.", group: "Bold", fits: "all", endpoint: SEEDREAM,
    recipe: shot("The product from the first picture in a playful set of bold colour blocks and simple geometric shapes picked to match its colours, hard light with crisp shadows, fresh and graphic."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-holiday", kind: "shot", title: "Holiday", line: "Wrapped in winter lights and a little snow.", group: "Seasonal", fits: "all", endpoint: SEEDREAM,
    recipe: shot("The product from the first picture in a warm festive winter setting with soft fairy lights, pine sprigs and a dusting of snow, cosy holiday mood, the product clearly the hero."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-summer", kind: "shot", title: "Poolside", line: "Bright summer light by a turquoise pool.", group: "Seasonal", fits: ["beverage", "beauty", "fashion", "footwear", "accessories", "food", "fragrance"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture on the warm stone edge of a turquoise swimming pool in bright summer sun, rippling water light, crisp shadows, holiday feeling."), inputs: [PRODUCT_REF], shop_safe: true, added: "2026-11-26" },
  { id: "shot-float", kind: "shot", title: "Levitate", line: "Floating in mid-air, a soft shadow below.", group: "Surreal", fits: NOT_APP.filter((c) => c !== "home"), endpoint: SEEDREAM,
    recipe: shot("The product from the first picture floating in mid-air above a smooth surface in a soft tint of its own colour ({colour}), a soft round shadow below it, clean studio light, weightless and calm."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },
  { id: "shot-splash", kind: "shot", title: "Splash crown", line: "Water bursting around it, frozen in time.", group: "Surreal", fits: ["beverage", "beauty", "fragrance", "food"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture in the middle of a crisp crown of clear splashing water frozen in time, droplets sparkling in bright backlight, fresh and cold."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },
  { id: "shot-ice", kind: "shot", title: "On ice", line: "Buried in crushed ice, beaded with cold.", group: "Surreal", fits: ["beverage"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture half buried in a bed of crushed ice, cold condensation beads all over it, cool blue light, icy and refreshing."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },
  { id: "shot-powder", kind: "shot", title: "Powder burst", line: "An explosion of coloured powder behind it.", group: "Surreal", fits: ["footwear", "fashion", "supplements", "accessories", "toys", "beverage"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture in front of an explosive burst of coloured powder in its own colours, frozen mid-air, dark backdrop, high-energy sports-ad look."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },
  { id: "shot-exploded", kind: "shot", title: "Exploded view", line: "Its parts floating apart, like an engineer's drawing.", group: "Surreal", fits: ["tech", "footwear", "toys", "accessories", "jewellery"], endpoint: SEEDREAM,
    recipe: shot("An exploded-view product render of the product from the first picture: its real parts separated and floating apart in mid-air in an orderly exploded diagram, each part keeping its exact colour and material, same plain background and camera angle, no labels, arrows or lines."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },
  { id: "shot-billboard", kind: "shot", title: "City billboard", line: "Your product, giant, above a busy street at night.", group: "Surreal", fits: ["beverage", "fashion", "footwear", "tech", "beauty", "fragrance", "accessories", "food"], endpoint: SEEDREAM,
    recipe: shot("The product from the first picture shown huge on a bright digital billboard above a busy city intersection at night, people and traffic below, realistic city lights; the billboard shows only the product, no other text."), inputs: [PRODUCT_REF], shop_safe: false, added: "2026-11-26" },

  // ---- Motion: one hero move, 5 s, ending on the front (Kling 3.0 Pro actions, Kling 4.0 camera and light) ----
  { id: "move-push", kind: "motion", title: "Slow push", line: "The camera glides in, the light shifts softly.", group: "Camera", fits: "all", endpoint: KLING_CAM,
    recipe: camera("Premium commercial shot. The camera pushes in slowly and smoothly toward the product while the light shifts softly across it."), inputs: [PRODUCT_IN], sfx: "a soft airy cinematic whoosh with a gentle shimmer", shop_safe: false, added: "2026-11-26" },
  { id: "move-sweep", kind: "motion", title: "Light sweep", line: "A band of light glides across it, catching every detail.", group: "Camera", fits: ["tech", "jewellery", "beauty", "fragrance", "beverage", "footwear", "accessories"], endpoint: KLING_CAM,
    recipe: camera("Premium commercial shot. A soft band of white light sweeps slowly across the product from left to right, picking out its texture and edges; the camera glides in a small 10-degree arc and settles back on the exact starting view; the product itself does not rotate."), inputs: [PRODUCT_IN], sfx: "a smooth glassy shimmer sweeping from left to right", shop_safe: false, added: "2026-11-26" },
  { id: "move-turn", kind: "motion", title: "Half turn", line: "It turns to show its side, then back to you.", group: "Camera", fits: NOT_APP, endpoint: KLING_CAM,
    recipe: camera("Clean studio commercial shot. The product turns slowly about 30 degrees to one side, then turns back to face the camera; static camera, soft even light."), inputs: [PRODUCT_IN], sfx: "a quiet smooth mechanical turn with a soft whoosh", shop_safe: false, added: "2026-11-26" },
  { id: "move-pop", kind: "motion", title: "Pop & fizz", line: "It cracks open with a burst of cold fizz.", group: "Action", fits: ["beverage"], endpoint: KLING_ACT,
    recipe: action("Slow-motion drinks commercial. The product stands upright. It snaps open by itself and a big, clearly visible burst of cold white mist and sparkling fizz shoots up out of the opening, droplets flying through a bright rim light, while cold condensation beads run down it. The camera pushes in slowly."), inputs: [PRODUCT_IN], sfx: "a crisp aluminium can tab cracking open with a sharp hiss, then fizzy carbonation crackling", shop_safe: false, added: "2026-11-26" },
  { id: "move-chill", kind: "motion", title: "Ice cold", line: "Frost forms and cold drops run down it.", group: "Action", fits: ["beverage"], endpoint: KLING_CAM,
    recipe: camera("Refreshing drinks commercial. Frost and cold condensation form on the product and droplets slowly run down its surface, cold mist drifting around its base; slow push in, cool bright light."), inputs: [PRODUCT_IN], sfx: "an icy crackle and a cold airy hiss", shop_safe: false, added: "2026-11-26" },
  { id: "move-mist", kind: "motion", title: "Mist", line: "A fine glowing spray drifts through the light.", group: "Action", fits: ["fragrance", "beauty"], endpoint: KLING_ACT,
    recipe: action("Luxury fragrance commercial. A fine, glowing mist sprays from the top of the product in a soft arc and drifts across the frame, catching warm light; a few petals drift down slowly behind it. Slow push in."), inputs: [PRODUCT_IN], sfx: "a soft perfume atomiser spray hiss with an airy shimmer", shop_safe: false, added: "2026-11-26" },
  { id: "move-rise", kind: "motion", title: "Twist up", line: "It twists open by itself, smooth and slow.", group: "Action", fits: ["beauty"], endpoint: KLING_ACT,
    recipe: action("Beauty macro commercial. The product twists or opens smoothly by itself, revealing what is inside a little further, while a soft band of light glides across it. Static camera with a slight push in."), inputs: [PRODUCT_IN], sfx: "a smooth satisfying twist click", shop_safe: false, added: "2026-11-26" },
  { id: "move-lid", kind: "motion", title: "Lid lift", line: "The lid lifts off by itself, showing what's inside.", group: "Action", fits: ["beauty", "food", "supplements", "tech", "toys", "jewellery", "pets"], endpoint: KLING_ACT,
    recipe: action("Clean product commercial. The lid or cap of the product lifts off slowly by itself and floats just above it, revealing what is inside; soft light, static camera."), inputs: [PRODUCT_IN], sfx: "a soft satisfying lid pop with a gentle whoosh", shop_safe: false, added: "2026-11-26" },
  { id: "move-float", kind: "motion", title: "Float", line: "It lifts off and hangs weightless, turning gently.", group: "Action", fits: NOT_APP.filter((c) => c !== "home"), endpoint: KLING_ACT,
    recipe: action("Weightless commercial shot. The product lifts gently off the surface and floats in mid-air, turning a little to one side and back to face the camera, a soft shadow below it."), inputs: [PRODUCT_IN], sfx: "a soft rising airy hum", shop_safe: false, added: "2026-11-26" },
  { id: "move-sway", kind: "motion", title: "Worn by air", line: "It moves as if an invisible person wears it.", group: "Action", fits: ["fashion"], endpoint: KLING_ACT,
    recipe: action("Fashion commercial. The garment lifts gently and floats in mid-air as if worn by an invisible person, its sleeves and fabric swaying softly in a light breeze; it turns only about 15 degrees and comes back to face the camera."), inputs: [PRODUCT_IN], sfx: "a soft fabric rustle in a light breeze", shop_safe: false, added: "2026-11-26" },
  { id: "move-impact", kind: "motion", title: "Impact", line: "It lands hard in a burst of dust, in slow motion.", group: "Action", fits: ["footwear", "toys", "accessories", "tech"], endpoint: KLING_ACT,
    recipe: action("Slow-motion sport commercial. The product hops a little into the air and lands back down hard on the same spot; a big, clearly visible ring of pale dust and particles explodes outward from where it lands, hanging in slow motion, then settles."), inputs: [PRODUCT_IN], sfx: "a heavy thud with a dusty burst and a low boom", shop_safe: false, added: "2026-11-26" },
  { id: "move-steam", kind: "motion", title: "Fresh & hot", line: "Steam curls up in warm light.", group: "Action", fits: ["food", "beverage"], endpoint: KLING_CAM,
    recipe: camera("Appetising food commercial. Soft wisps of steam curl up from the food in warm light; slow push in, shallow depth of field."), inputs: [PRODUCT_IN], sfx: "a gentle warm sizzle with soft steam", shop_safe: false, added: "2026-11-26" },
  { id: "move-assemble", kind: "motion", title: "Comes together", line: "Its parts fly in and lock into place.", group: "Action", fits: ["tech", "footwear", "toys", "accessories", "jewellery"], endpoint: KLING_CAM,
    recipe: camera("Product engineering commercial. The floating parts drift in slowly and lock together into the finished product. Static camera, soft even light, same plain background. Every part keeps its exact colour, material and logo."),
    inputs: [{ field: "image_url", label: "The exploded view", hint: "Make the Exploded view shot first; it starts here.", from: "exploded" }, { field: "end_image_url", label: "Your product", hint: "The finished product, where it ends.", from: "product" }],
    sfx: "mechanical parts clicking and locking into place with a satisfying final snap", shop_safe: false, added: "2026-11-26" },
  { id: "move-apart", kind: "motion", title: "Comes apart", line: "It separates into its parts, like an engineer's drawing.", group: "Action", fits: ["tech", "footwear", "toys", "accessories", "jewellery"], endpoint: KLING_CAM,
    recipe: camera("Product engineering commercial. The product smoothly comes apart into its parts, which drift apart slowly in mid-air and settle into an orderly exploded view. Static camera, soft even light, same plain background. Every part keeps its exact colour, material and logo."),
    inputs: [{ field: "image_url", label: "Your product", hint: "The finished product, where it starts.", from: "product" }, { field: "end_image_url", label: "The exploded view", hint: "Make the Exploded view shot first; it ends here.", from: "exploded" }],
    sfx: "mechanical parts releasing with soft clicks and an airy whoosh", shop_safe: false, added: "2026-11-26" },
  // Describe your own: Claude turns the person's words into one hero motion ({motion}); the guardrails stay ours
  { id: "move-custom", kind: "motion", title: "Describe your own", line: "Say what should happen; we'll make it one clean shot.", group: "Yours", fits: NOT_APP, endpoint: KLING_ACT,
    recipe: action("Commercial product shot. {motion}"), inputs: [PRODUCT_IN], sfx: "{sfx}", shop_safe: false, added: "2026-11-26" },
];

const byId = new Map(LOOKS.map((l) => [l.id, l]));
export const lookById = (id: unknown): Look | null => (typeof id === "string" ? byId.get(id) ?? null : null);
export const fitsCategory = (l: Look, c: ProductCategory | null | undefined): boolean => l.fits === "all" ? c !== "app" : !!c && (l.fits as string[]).includes(c);

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩"{}]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** The full model settings for a look run: the recipe with the product's facts and (for "your own") the planned motion. */
export function withLookRecipe(lookId: unknown, params: Record<string, any>): Record<string, any> {
  const l = lookById(lookId);
  if (!l) return params;
  const colour = clean(params?.colour, 40) || "a soft neutral";
  const motion = clean(params?.motion, 400);
  const recipe: Record<string, any> = { ...l.recipe };
  if (typeof recipe.prompt === "string") recipe.prompt = recipe.prompt.replace("{colour}", colour).replace("{motion}", motion).replace(/\s+/g, " ").trim();
  // a custom move that needs a moving camera rather than an action runs on the camera model (the planner says)
  if (l.id === "move-custom" && params?.engine === "camera") return { ...camera(`Commercial product shot. ${motion}`) };
  return recipe;
}
/** The sound laid under a motion clip, if any. */
export function lookSfx(lookId: unknown, params: Record<string, any>): string | null {
  const l = lookById(lookId);
  if (!l?.sfx) return null;
  const s = l.sfx === "{sfx}" ? clean(params?.sfx, 160) : l.sfx;
  return s || null;
}
/** What the job keeps from the person's request: the product's facts the recipe uses and the planned motion. Never the recipe. */
export function lookChoices(l: Look, facts: Partial<ProductFacts>, raw: any): Record<string, any> {
  const out: Record<string, any> = { colour: clean(facts.colour, 40) || null };
  if (l.id === "move-custom") {
    const motion = clean(raw?.motion, 400);
    if (motion.length < 12) throw new LookError("look_motion_required", "Say what should happen first");
    out.motion = motion; out.sfx = clean(raw?.sfx, 160) || null; out.engine = raw?.engine === "camera" ? "camera" : "action";
    out.words = clean(raw?.words, 300) || null;
  }
  return out;
}
/** The instrument request a look makes: its model, the full settings, and the pictures in the slots it names. */
export function lookRequest(l: Look, pictures: { product: string; exploded?: string | null }, choices: Record<string, any>): { endpoint: string; params: Record<string, any>; inputs: Record<string, any> } {
  const inputs: Record<string, any> = {};
  for (const i of l.inputs) {
    const id = i.from === "exploded" ? pictures.exploded : pictures.product;
    if (!id) throw new LookError("look_input_required", i.from === "exploded" ? "Make the Exploded view shot first" : "Add your product first");
    inputs[i.field] = i.field.endsWith("s") ? [id] : id;
  }
  return { endpoint: l.endpoint, params: withLookRecipe(l.id, choices), inputs };
}
export class LookError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

/** What the page gets: never the recipe, the prompt or the sound words. */
export function publicLook(l: Look) {
  return { id: l.id, kind: l.kind, title: l.title, line: l.line, group: l.group, fits: l.fits, output: l.kind === "shot" ? "image" : "video", shop_safe: l.shop_safe,
    needs: l.inputs.some((i) => i.from === "exploded") ? "exploded" : null, example: l.example ?? null, draft: !l.example, added: l.added };
}
/** The looks a person can see for a category: those with a real example (admins also see drafts). */
export function looksFor(category: ProductCategory | null, opts: { admin?: boolean; shopSafe?: boolean } = {}): Look[] {
  return LOOKS.filter((l) => (category ? fitsCategory(l, category) : true) && (opts.admin || !!l.example) && (!opts.shopSafe || l.shop_safe));
}
