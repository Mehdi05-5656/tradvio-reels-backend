// Clone8 Stories: a funny 3D "If you…" story film from a topic (kage-motion/docs: CLONE8_STORIES_PLAN.md). Claude writes
// the scene from our own 3D library, the KATANA narrator reads it at the format's pace, the kage-motion worker renders
// it. Here: the options are checked, the film is priced from its cost at the house margin, and the job goes to the same
// worker queue as Kage Motion (tool "kage_motion", options.story). Off until STUDIO_STORIES_ENABLED=true.
import { MARGIN_TARGET, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";

export class StoryError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const storiesEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_STORIES_ENABLED === "true";
export const STORY_FORMATS = ["auto", "buildup", "escalation"] as const;
export const STORY_LIMITS = { topicMin: 6, topicMax: 600, secondsMin: 20, secondsMax: 90, secondsDefault: 45 };

/** What one story costs us (USD): the writer with web checks, the v3 narration, the 3D render. STUDIO_STORY_COST_USD
 *  overrides it once real runs are measured; the default is the estimate in the plan (~$1–1.5 for 45 s). */
export function storyCostUsd(env: Record<string, string | undefined>, seconds: number): number {
  const v = Number(env.STUDIO_STORY_COST_USD);
  const per45 = Number.isFinite(v) && v > 0 ? v : 1.5;
  return Math.round(per45 * Math.max(0.6, seconds / 45) * 100) / 100;
}

export function storyCredits(env: Record<string, string | undefined>, plans: PlanLike[], seconds: number): number {
  const usd = storyCostUsd(env, seconds); const costs = studioCosts(env, plans);
  return Math.max(1, costs.credit_floor ? creditsForCost(usd, costs.credit_floor, MARGIN_TARGET) : Math.ceil(usd * 100));
}

export type StoryOptions = { topic: string; seconds: number; format: (typeof STORY_FORMATS)[number] };

export function parseStoryOptions(raw: any): StoryOptions {
  const topic = String(raw?.topic ?? "").replace(/\s+/g, " ").trim();
  if (topic.length < STORY_LIMITS.topicMin) throw new StoryError("story_topic", "Say what the story is about (for example: building a bridge across a river)");
  if (topic.length > STORY_LIMITS.topicMax) throw new StoryError("story_topic", `Keep the topic under ${STORY_LIMITS.topicMax} characters`);
  const s = Number(raw?.seconds);
  const seconds = Number.isFinite(s) ? Math.round(Math.min(STORY_LIMITS.secondsMax, Math.max(STORY_LIMITS.secondsMin, s))) : STORY_LIMITS.secondsDefault;
  const f = String(raw?.format ?? "auto");
  return { topic, seconds, format: (STORY_FORMATS as readonly string[]).includes(f) ? (f as StoryOptions["format"]) : "auto" };
}

export type StoryQuote = { tool: "kage_motion"; credits: number; options: Record<string, any>; summary: string };

export function quoteStory(env: Record<string, string | undefined>, plans: PlanLike[], raw: any): StoryQuote {
  if (!storiesEnabled(env)) throw new StoryError("story_off", "Stories are not switched on yet", 403);
  const o = parseStoryOptions(raw);
  const credits = storyCredits(env, plans, o.seconds);
  // the worker reads options.story; brief/style/aspect keep the Kage job list and library readable
  const options = { story: { topic: o.topic, seconds: o.seconds, ...(o.format !== "auto" ? { format: o.format } : {}) }, brief: o.topic, style: "story", aspect: "9:16", voice: "katana", seconds: o.seconds, cost_usd: storyCostUsd(env, o.seconds) };
  const kind = o.format === "buildup" ? "build-up story" : o.format === "escalation" ? "escalation story" : "story";
  return { tool: "kage_motion", credits, options, summary: `${o.seconds} s 3D ${kind} · vertical 9:16 · narrated by Kage` };
}
