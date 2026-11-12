// Clone8 Motivation: a topic (or the person's own script) in, a narrated motivational film out: black screen, white
// pictograms and bold words that land on the spoken word (kage-motion worker/motivation). Here: the options are
// checked, the job is priced from what a film costs us at the house margin, and it goes to the Kage Motion worker
// queue (tool "kage_motion", options.motivation), the way Stories do.
// Off until STUDIO_MOTIVATION_ENABLED=true; until STUDIO_MOTIVATION_OPEN=true only the owner's account can make one.
import { MARGIN_TARGET, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";

export class MotivationError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const motivationEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_MOTIVATION_ENABLED === "true";
/** Open to every customer. Until then only the owner's account (the Studio admin) can make films: the test films. */
export const motivationOpen = (env: Record<string, string | undefined> = process.env) => motivationEnabled(env) && env.STUDIO_MOTIVATION_OPEN === "true";
export const MOTIVATION_LENGTHS = [30, 45, 60, 90] as const;
/** The narrators: Henry (deep, serious) is the default; Thorn (a young, quick voice) is the second. */
export const MOTIVATION_VOICES = ["henry", "thorn"] as const;
export const MOTIVATION_VOICE_NAMES: Record<(typeof MOTIVATION_VOICES)[number], string> = { henry: "Henry", thorn: "Thorn" };
/** Vertical for phones is the default; wide is the other. */
export const MOTIVATION_SHAPES = ["9:16", "16:9"] as const;
/** the narrator speaks about 3.1 words a second (measured on the reference films and on ours, Nov 11 2026) */
export const MOTIVATION_WORDS_PER_SECOND = 3.1;
export const MOTIVATION_LIMITS = { topicMin: 6, topicMax: 600, scriptMinWords: 50, scriptMaxWords: 290, secondsDefault: 45 };

const usd = (env: Record<string, string | undefined>, key: string, d: number) => { const v = Number(env[key]); return Number.isFinite(v) && v > 0 ? v : d; };
/** What a film costs us (USD): a fixed part (the script, the first scene plan) plus a part per second (narration,
 *  scene repairs, render, worker time). Measured Nov 11 2026 on films rendered on a laptop: $0.22 for 54 s and $0.26
 *  for 59 s (Claude $0.15-0.18, ElevenLabs $0.06-0.08). The defaults add room for the Lambda render and the worker's
 *  time, which those runs did not pay: $0.15 + $0.006 a second ($0.51 for a minute). MOTIVATION_COST_USD_BASE and
 *  MOTIVATION_COST_USD_PER_SECOND replace them once films on the live worker are measured. */
export function motivationCostUsd(env: Record<string, string | undefined>, seconds: number): number {
  return Math.round((usd(env, "MOTIVATION_COST_USD_BASE", 0.15) + usd(env, "MOTIVATION_COST_USD_PER_SECOND", 0.006) * seconds) * 100) / 100;
}
export function motivationCredits(env: Record<string, string | undefined>, plans: PlanLike[], seconds: number): number {
  const costs = studioCosts(env, plans); const cost = motivationCostUsd(env, seconds);
  return Math.max(1, costs.credit_floor ? creditsForCost(cost, costs.credit_floor, MARGIN_TARGET) : Math.ceil(cost * 100));
}

export type MotivationOptions = { topic: string; script: string; seconds: number; voice: (typeof MOTIVATION_VOICES)[number]; shape: (typeof MOTIVATION_SHAPES)[number] };

export function parseMotivationOptions(raw: any): MotivationOptions {
  const voice = (MOTIVATION_VOICES as readonly string[]).includes(String(raw?.voice)) ? (String(raw.voice) as MotivationOptions["voice"]) : "henry";
  const shape = (MOTIVATION_SHAPES as readonly string[]).includes(String(raw?.shape)) ? (String(raw.shape) as MotivationOptions["shape"]) : "9:16";
  const script = String(raw?.script ?? "").replace(/\s+/g, " ").trim();
  if (script) {
    // the person's own words: the film is as long as they take to say
    const words = script.split(" ").length;
    if (words < MOTIVATION_LIMITS.scriptMinWords) throw new MotivationError("motivation_script", `Your script is ${words} words; it needs at least ${MOTIVATION_LIMITS.scriptMinWords} (about 15 seconds)`);
    if (words > MOTIVATION_LIMITS.scriptMaxWords) throw new MotivationError("motivation_script", `Your script is ${words} words; keep it under ${MOTIVATION_LIMITS.scriptMaxWords} (about 90 seconds)`);
    return { topic: "", script, seconds: Math.max(15, Math.round(words / MOTIVATION_WORDS_PER_SECOND)), voice, shape };
  }
  const topic = String(raw?.topic ?? "").replace(/\s+/g, " ").trim();
  if (topic.length < MOTIVATION_LIMITS.topicMin) throw new MotivationError("motivation_topic", "Say what the video is about (for example: why consistency beats talent)");
  if (topic.length > MOTIVATION_LIMITS.topicMax) throw new MotivationError("motivation_topic", `Keep the topic under ${MOTIVATION_LIMITS.topicMax} characters`);
  const s = Number(raw?.seconds);
  const seconds = Number.isFinite(s) ? MOTIVATION_LENGTHS.reduce<number>((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), MOTIVATION_LENGTHS[0]) : MOTIVATION_LIMITS.secondsDefault;
  return { topic, script: "", seconds, voice, shape };
}

export type MotivationQuote = { tool: "kage_motion"; credits: number; options: Record<string, any>; summary: string };

export function quoteMotivation(env: Record<string, string | undefined>, plans: PlanLike[], raw: any, who: { owner?: boolean } = {}): MotivationQuote {
  if (!motivationEnabled(env)) throw new MotivationError("motivation_off", "Motivation videos are not switched on yet", 403);
  if (!motivationOpen(env) && !who.owner) throw new MotivationError("motivation_off", "Motivation videos are not open yet", 403);
  const o = parseMotivationOptions(raw);
  const cost = motivationCostUsd(env, o.seconds);
  const motivation = { ...(o.script ? { script: o.script } : { topic: o.topic, seconds: o.seconds }), voice: o.voice, shape: o.shape };
  const brief = (o.script || o.topic).slice(0, 200);
  const options = { motivation, brief, style: "motivation", aspect: o.shape, voice: o.voice, seconds: o.seconds, cost_usd: cost };
  const summary = `${o.script ? `About ${o.seconds} s, your script` : `${o.seconds} s, script written for you`} · narrated by ${MOTIVATION_VOICE_NAMES[o.voice]} · ${o.shape === "9:16" ? "vertical 9:16" : "wide 16:9"} · sound effects · about 3 minutes to make`;
  return { tool: "kage_motion", credits: motivationCredits(env, plans, o.seconds), options, summary };
}
