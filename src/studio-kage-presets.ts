// Kage presets as the dashboard sees them (the owner, Nov 6 2026: users pick a template, add their assets and
// instructions, and get variants). The look, the beats and the category moments live in the worker's catalogue
// (kage-motion/src/kit/presets.ts); this keeps the same ids with what the picker shows. Keep the two in step.
export type KagePresetCategory = "ad" | "landing" | "organic" | "launch" | "explainer";
export type KagePreset = { id: string; name: string; category: KagePresetCategory; blurb: string; sound: "voice" | "music"; aspect: "16:9" | "9:16"; seconds: number; needs: ("product" | "logo" | "screens")[] };

export const KAGE_PRESET_CATEGORIES: { id: KagePresetCategory; name: string }[] = [
  { id: "ad", name: "Ad creatives" }, { id: "landing", name: "Landing page" }, { id: "organic", name: "Organic posts" },
  { id: "launch", name: "Launches" }, { id: "explainer", name: "Explainers" },
];

export const KAGE_PRESETS: KagePreset[] = [
  { id: "brutal-promo", name: "Brutal promo", category: "launch", blurb: "Heavy type slammed on every word, grounds flipping on the hits, a villain narrator in control.", sound: "voice", aspect: "16:9", seconds: 20, needs: [] },
  { id: "the-bet", name: "The bet", category: "launch", blurb: "A dare against the clock: small lines written by a comet, a countdown in the corner, the punches in big blocks.", sound: "voice", aspect: "16:9", seconds: 20, needs: [] },
  { id: "product-drop", name: "Product drop", category: "ad", blurb: "A hype ad for a release: the product at the centre, scarcity and the date called out, a stamp when it lands.", sound: "voice", aspect: "9:16", seconds: 16, needs: ["product"] },
  { id: "landing-hero", name: "Landing hero", category: "landing", blurb: "A muted loop for a landing page: the product at the centre, its material and details called out in clean type.", sound: "music", aspect: "16:9", seconds: 16, needs: ["product"] },
  { id: "tiktok-hook", name: "TikTok hook", category: "organic", blurb: "A native-feeling vertical post: a scroll-stopping hook, quick lines, one big reveal, made to be posted as is.", sound: "voice", aspect: "9:16", seconds: 16, needs: [] },
  { id: "luxe-editorial", name: "Luxe editorial", category: "ad", blurb: "A slow, premium ad: serif type, generous space, the product treated like a magazine cover.", sound: "music", aspect: "9:16", seconds: 16, needs: ["product"] },
  { id: "stat-attack", name: "Stat attack", category: "explainer", blurb: "Numbers do the talking: big counts, prices and percentages slammed one after another.", sound: "voice", aspect: "16:9", seconds: 20, needs: [] },
  { id: "app-walkthrough", name: "App walkthrough", category: "explainer", blurb: "A product tour drawn as panels: each step shown as it is said, a cursor doing the work.", sound: "voice", aspect: "16:9", seconds: 20, needs: [] },
];
export const kagePresetById = (id: unknown): KagePreset | undefined => KAGE_PRESETS.find((p) => p.id === id);
/** Variants per request: each is its own film (its own angle and look), charged as one film. */
export const KAGE_MAX_VARIANTS = 3;
