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
  /** the finished example (public demo media); none yet means admins only */
  example?: { poster: string; clip?: string } | null;
  added: string;
};

const PHOTO: PresetInput = { field: "image_url", kind: "image", label: "A photo of you", hint: "One person, face clearly visible, from the waist up or closer." };
const PRODUCT: PresetInput = { field: "image_url", kind: "image", label: "Your product", hint: "The product on its own, sharp, on a plain background if you have one." };
const PHOTO_REF: PresetInput = { field: "image_urls", kind: "image", label: "A photo of you", hint: "One person, face clearly visible." };
const PET_REF: PresetInput = { field: "image_urls", kind: "image", label: "Your pet", hint: "The animal on its own, face clearly visible." };

export const PRESETS: Preset[] = [
  // ---- video, from a photo of a person ----
  { id: "main-character", title: "Main character", line: "Walk into frame like the film is about you.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The person from the photo walks toward the camera in slow motion down a sunlit city street at golden hour, confident, wind moving their hair and clothes. People on the sidewalk turn to look. The camera tracks backward at eye level, shallow depth of field, warm cinematic film look." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], added: "2026-11-25" },
  { id: "paparazzi", title: "Paparazzi", line: "Out of the car, into a wall of flashes.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The person from the photo steps onto a red carpet at night as dozens of camera flashes go off around them. Photographers crowd the rope and call their name. They pause, glance over their shoulder at the camera and smile. Handheld press-camera feel, bright flash pops, glamorous." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], added: "2026-11-25" },
  { id: "walk-away", title: "Don't look back", line: "A blockbuster explosion behind you, with sound.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 5, aspect_ratio: "9:16", generate_audio: true, prompt: "The person from the photo walks calmly toward the camera without looking back as a huge fireball explosion erupts behind them in an abandoned industrial yard. Sparks and debris fly past. Slow push-in, blockbuster action-film look, deep booming explosion sound and rumbling bass." },
    inputs: [PHOTO], choose: ["aspect_ratio"], groups: ["ai", "characters", "personal"], added: "2026-11-25" },
  { id: "earth-zoom", title: "Earth zoom out", line: "From you to space in one move.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "Starting on the person in the photo, the camera rises straight up and pulls back in one continuous, seamless move: over the rooftops, through the clouds, until the whole Earth is visible from space, then it holds. Smooth, no cuts." },
    inputs: [PHOTO], groups: ["ai", "characters", "personal"], added: "2026-11-25" },
  { id: "street-interview", title: "Street interview", line: "Stopped on the street, mic in your face. You say the line.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 6, aspect_ratio: "9:16", generate_audio: true, prompt: "The person from the photo is stopped on a busy city street by an interviewer who holds a microphone into the frame. They laugh, then answer straight to the camera, saying clearly: \"{text}\". Natural street sound and passing traffic, handheld vertical phone footage, like a viral street interview." },
    inputs: [PHOTO], text: { label: "What you say", placeholder: "I quit my job to do this full time", max: 80 }, groups: ["personal", "ai"], added: "2026-11-25" },
  // ---- video, from a product photo ----
  { id: "product-spin", title: "Product hero", line: "Your product on a pedestal, lit like an ad.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "The product from the photo turns slowly on a glossy black pedestal while a soft light sweeps across it. Tiny particles drift in the air. The camera orbits slowly. Studio commercial look, crisp reflections, premium." },
    inputs: [PRODUCT], groups: ["ads", "ai"], added: "2026-11-25" },
  { id: "product-splash", title: "Splash drop", line: "Your product hits the water in slow motion, with sound.", output: "video", endpoint: "clone8/halo/image-to-video",
    recipe: { duration: 5, aspect_ratio: "9:16", generate_audio: true, prompt: "The product from the photo drops into crystal-clear water in slow motion. A big splash and bubbles burst around it, droplets catch the light, bright clean background, premium drink-commercial look, crisp splash sound." },
    inputs: [PRODUCT], choose: ["aspect_ratio"], groups: ["ads", "ai"], added: "2026-11-25" },
  { id: "unboxing", title: "Unboxing", line: "Hands lift it out of the box: real, cosy, UGC.", output: "video", endpoint: "kling-video/v4.0/image-to-video",
    recipe: { duration: 5, resolution: "1080p", prompt: "Two hands slowly lift the product from the photo out of a minimal box on a wooden desk in soft morning window light, then turn it toward the camera. Authentic, cosy, phone-camera UGC feel." },
    inputs: [PRODUCT], groups: ["ads", "personal"], added: "2026-11-25" },
  // ---- pictures ----
  { id: "action-figure", title: "Action figure", line: "You, boxed as a collectible toy, your name on the card.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Turn the person in @image_1 into a collectible action figure sealed in a retail blister pack. The figure keeps their face, hair and outfit, with small matching accessories in moulded slots beside it. The card backing shows the name \"{text}\" in bold toy-brand lettering. Product photo on a plain background, sharp, glossy plastic." },
    inputs: [PHOTO_REF], text: { label: "Name on the box", placeholder: "CAPTAIN ALEX", max: 24 }, groups: ["characters", "personal", "ai"], added: "2026-11-25" },
  { id: "magazine-cover", title: "Cover star", line: "You on a magazine cover, your title on the masthead.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "A high-fashion magazine cover with the person in @image_1 as the cover star, studio portrait. The masthead at the top reads \"{text}\" in large elegant serif letters, with a few short cover lines in smaller type. Glossy print look." },
    inputs: [PHOTO_REF], text: { label: "Magazine name", placeholder: "VOGUE-ISH", max: 20 }, groups: ["personal", "characters"], added: "2026-11-25" },
  { id: "thumbnail", title: "Shock thumbnail", line: "A click-me YouTube thumbnail with your words.", output: "image", endpoint: "kling-image/v4.0/edit",
    recipe: { resolution: "2k", aspect_ratio: "16:9", prompt: "A YouTube thumbnail: the person in @image_1 at a podcast microphone with a shocked expression, neon-lit studio behind them, and big bold words \"{text}\" with a thick outline beside them. High contrast, saturated, 16:9." },
    inputs: [PHOTO_REF], text: { label: "Thumbnail words", placeholder: "I WAS WRONG", max: 24 }, groups: ["clipping", "personal", "edit"], added: "2026-11-25" },
  { id: "pet-ceo", title: "Pet CEO", line: "Your pet runs the board meeting.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "The animal from the first picture sits at the head of a boardroom table in a tailored suit and tie, serious expression, city skyline through floor-to-ceiling windows. Corporate portrait photo, photorealistic." },
    inputs: [PET_REF], groups: ["characters", "ai"], added: "2026-11-25" },
  { id: "anime-still", title: "Painted anime", line: "You as a soft, hand-painted anime film still.", output: "image", endpoint: "bytedance/seedream/v5.0/pro/edit",
    recipe: { resolution: "2k", aspect_ratio: "3:4", prompt: "Redraw the person in the first picture as a soft hand-painted anime film still: warm afternoon light, a lush green hillside under tall summer clouds, gentle watercolour textures. Keep their face, hair and outfit." },
    inputs: [PHOTO_REF], groups: ["characters", "stories", "ai"], added: "2026-11-25" },
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
