// Clone8 Stories: a funny 3D "If you…" story film from a topic (kage-motion/docs: CLONE8_STORIES_PLAN.md). Claude writes
// the scene from our own 3D library, the KATANA narrator reads it at the format's pace, the kage-motion worker renders
// it. Two steps, so the person stays in control of what gets made: "script" (Claude writes it; they read and edit the
// lines) and "film" (recorded, rendered, delivered). Here: options are checked, each step is priced from its cost at
// the house margin, and the job goes to the Kage Motion worker queue (tool "kage_motion", options.story).
// Off until STUDIO_STORIES_ENABLED=true.
import { MARGIN_TARGET, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";

export class StoryError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const storiesEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_STORIES_ENABLED === "true";
export const STORY_FORMATS = ["auto", "buildup", "escalation", "scale"] as const;
export const STORY_WORLDS = ["auto", "river", "yard", "jungle", "field", "cosmos", "underground"] as const;
export const STORY_CAPTIONS = ["auto", "word", "phrase"] as const;
/** The lengths offered. 65 is "60+": just over a minute, never under 60 s (what monetisation programs ask for). */
export const STORY_LENGTHS = [30, 45, 65, 90] as const;
// The no-character film ("Want a bunker under your backyard?": the thing itself is the star, one cut-open scene that
// changes on the narrator's words; the kage-motion worker's explainer). Its own switch, and until it is open only the
// owner's account can make one (the tests): STUDIO_STORY_EXPLAINER_ENABLED, then STUDIO_STORY_EXPLAINER_OPEN.
export const storyExplainerEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_STORY_EXPLAINER_ENABLED === "true";
export const storyExplainerOpen = (env: Record<string, string | undefined> = process.env) => storyExplainerEnabled(env) && env.STUDIO_STORY_EXPLAINER_OPEN === "true";
// (50 s is the reference's length: 172 words in 16 sentences; 30 s is the short cut of the same shape)
export const STORY_EXPLAINER_LENGTHS = [30, 50] as const;
/** What a no-character film costs us (the plan, the scene built part by part and checked, the preview, the voice, the render). */
export const storyExplainerCostUsd = (env: Record<string, string | undefined>, seconds: number) => Math.round(usd(env, "STUDIO_STORY_EXPLAINER_COST_USD", 1.9) * (seconds > 30 ? 1.6 : 1) * 100) / 100;
export const STORY_LIMITS = { topicMin: 6, topicMax: 600, secondsDefault: 65, sidekickMax: 20, sceneMaxBytes: 120_000 };

const usd = (env: Record<string, string | undefined>, key: string, d: number) => { const v = Number(env[key]); return Number.isFinite(v) && v > 0 ? v : d; };
/** What the film step costs us (USD) for its length: the v3 narration and the 3D render. STUDIO_STORY_COST_USD is the
 *  45 s figure (default $1.2 until real runs are measured). */
export function storyFilmCostUsd(env: Record<string, string | undefined>, seconds: number): number {
  return Math.round(usd(env, "STUDIO_STORY_COST_USD", 1.2) * Math.max(0.6, seconds / 45) * 100) / 100;
}
/** What writing the script costs us (USD): Claude with web checks (STUDIO_STORY_SCRIPT_COST_USD, default $0.35). */
export const storyScriptCostUsd = (env: Record<string, string | undefined>) => usd(env, "STUDIO_STORY_SCRIPT_COST_USD", 0.35);
export function storyCostUsd(env: Record<string, string | undefined>, seconds: number): number {
  return Math.round((storyFilmCostUsd(env, seconds) + storyScriptCostUsd(env)) * 100) / 100;
}
const credits = (env: Record<string, string | undefined>, plans: PlanLike[], usdCost: number) => { const costs = studioCosts(env, plans); return Math.max(1, costs.credit_floor ? creditsForCost(usdCost, costs.credit_floor, MARGIN_TARGET) : Math.ceil(usdCost * 100)); };
export const storyCredits = (env: Record<string, string | undefined>, plans: PlanLike[], seconds: number) => credits(env, plans, storyCostUsd(env, seconds));

export type StoryOptions = {
  topic: string; seconds: (typeof STORY_LENGTHS)[number] | (typeof STORY_EXPLAINER_LENGTHS)[number]; min_seconds: number; format: (typeof STORY_FORMATS)[number];
  world: (typeof STORY_WORLDS)[number]; sidekick: string; captions: (typeof STORY_CAPTIONS)[number];
  stage: "script" | "film" | "all"; scene: Record<string, unknown> | null;
  /** "explainer": the no-character film; unset: the story with a character */
  kind?: "explainer";
};

const pick = <T extends readonly string[]>(list: T, v: unknown, d: T[number]): T[number] => ((list as readonly string[]).includes(String(v)) ? (String(v) as T[number]) : d);

export function parseStoryOptions(raw: any): StoryOptions {
  const topic = String(raw?.topic ?? "").replace(/\s+/g, " ").trim();
  if (topic.length < STORY_LIMITS.topicMin) throw new StoryError("story_topic", "Say what the story is about (for example: building a bridge across a river)");
  if (topic.length > STORY_LIMITS.topicMax) throw new StoryError("story_topic", `Keep the topic under ${STORY_LIMITS.topicMax} characters`);
  const s = Number(raw?.seconds);
  // the no-character film: a topic and a length, nothing else (no script stage, no world, no sidekick)
  if (raw?.kind === "explainer") {
    const secs = (Number.isFinite(s) ? STORY_EXPLAINER_LENGTHS.reduce<number>((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), STORY_EXPLAINER_LENGTHS[0]) : 50) as StoryOptions["seconds"];
    return { topic, seconds: secs, min_seconds: 0, format: "auto", world: "auto", sidekick: "", captions: "auto", stage: "all", scene: null, kind: "explainer" };
  }
  // nearest offered length (older pages sent any number)
  const seconds: StoryOptions["seconds"] = Number.isFinite(s) ? STORY_LENGTHS.reduce<StoryOptions["seconds"]>((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), STORY_LENGTHS[0]) : 65;
  const sidekick = String(raw?.sidekick ?? "").replace(/[^\p{L}\p{N} '\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, STORY_LIMITS.sidekickMax) || "Kevin";
  const stage = raw?.stage === "script" ? "script" : raw?.stage === "film" ? "film" : "all";
  let scene: Record<string, unknown> | null = null;
  if (stage === "film") {
    if (!raw?.scene || typeof raw.scene !== "object" || !Array.isArray(raw.scene.beats)) throw new StoryError("story_scene", "Write the script first, then make the film");
    if (JSON.stringify(raw.scene).length > STORY_LIMITS.sceneMaxBytes) throw new StoryError("story_scene", "This script is too long");
    scene = raw.scene;
  }
  return { topic, seconds, min_seconds: seconds >= 60 ? 60 : 0, format: pick(STORY_FORMATS, raw?.format, "auto"), world: pick(STORY_WORLDS, raw?.world, "auto"), sidekick, captions: pick(STORY_CAPTIONS, raw?.captions, "auto"), stage, scene };
}

export type StoryQuote = { tool: "kage_motion"; credits: number; options: Record<string, any>; summary: string };

export function quoteStory(env: Record<string, string | undefined>, plans: PlanLike[], raw: any, who: { owner?: boolean } = {}): StoryQuote {
  if (!storiesEnabled(env)) throw new StoryError("story_off", "Stories are not switched on yet", 403);
  const o = parseStoryOptions(raw);
  if (o.kind === "explainer") {
    if (!storyExplainerEnabled(env)) throw new StoryError("story_kind_off", "Stories without a character are not switched on yet", 403);
    if (!storyExplainerOpen(env) && !who.owner) throw new StoryError("story_kind_off", "Stories without a character are not open yet", 403);
    const cost = storyExplainerCostUsd(env, o.seconds);
    const options = { story: { topic: o.topic, seconds: o.seconds, kind: "explainer" }, brief: o.topic, style: "story", aspect: "9:16", voice: "henry", seconds: o.seconds, cost_usd: cost };
    return { tool: "kage_motion", credits: credits(env, plans, cost), options, summary: `${o.seconds} s 3D story · no character · vertical 9:16 · narrated` };
  }
  const cost = o.stage === "script" ? storyScriptCostUsd(env) : o.stage === "film" ? storyFilmCostUsd(env, o.seconds) : storyCostUsd(env, o.seconds);
  const story = { topic: o.topic, seconds: o.seconds, ...(o.min_seconds ? { min_seconds: o.min_seconds } : {}), ...(o.format !== "auto" ? { format: o.format } : {}), ...(o.world !== "auto" ? { world: o.world } : {}), sidekick: o.sidekick, ...(o.captions !== "auto" ? { captions: o.captions } : {}), ...(o.stage !== "all" ? { stage: o.stage } : {}), ...(o.scene ? { scene: o.scene } : {}) };
  const options = { story, brief: o.topic, style: "story", aspect: "9:16", voice: "katana", seconds: o.seconds, cost_usd: cost };
  const length = o.seconds === 65 ? "60+ s" : `${o.seconds} s`;
  const kind = o.format === "buildup" ? "build-up story" : o.format === "escalation" ? "escalation story" : o.format === "scale" ? "scale story" : "story";
  const summary = o.stage === "script" ? `The script for a ${length} ${kind} · you read it before anything is filmed` : `${length} 3D ${kind} · vertical 9:16 · narrated by Kage${o.min_seconds ? " · at least a minute" : ""}`;
  return { tool: "kage_motion", credits: credits(env, plans, cost), options, summary };
}
