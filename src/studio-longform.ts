// Clone8 Films (long form): a story prompt in, a narrated 2D motion-graphics film out, with its thumbnail, title and
// description (clone8-longform, docs/longform/STORY_ENGINE_PLAN.md). Here: the options are checked, the job is priced
// from what a film costs us at the house margin, and it goes to the clone8-longform worker queue (tool "longform").
// Off until STUDIO_LONGFORM_ENABLED=true.
import { MARGIN_TARGET, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";

export class LongformError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const longformEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_LONGFORM_ENABLED === "true";
export const LONGFORM_MINUTES = [2, 5, 10] as const;
export const LONGFORM_MODES = ["auto", "true", "speculative", "fiction"] as const;
export const LONGFORM_LIMITS = { promptMin: 6, promptMax: 600 };

const usd = (env: Record<string, string | undefined>, key: string, d: number) => { const v = Number(env[key]); return Number.isFinite(v) && v > 0 ? v : d; };
/** What a film costs us (USD): a fixed part for the plan, research, script and checks (LONGFORM_COST_USD_BASE,
 *  default $1.50) plus a per-minute part for pictures, narration, direction, sound, QC and render
 *  (LONGFORM_COST_USD_PER_MINUTE, default $0.75: measured Nov 9 2026 at $0.43–0.58 a minute before art, plus new
 *  pictures for a theme the library has not seen). */
export function longformCostUsd(env: Record<string, string | undefined>, minutes: number): number {
  return Math.round((usd(env, "LONGFORM_COST_USD_BASE", 1.5) + usd(env, "LONGFORM_COST_USD_PER_MINUTE", 0.75) * minutes) * 100) / 100;
}
export function longformCredits(env: Record<string, string | undefined>, plans: PlanLike[], minutes: number): number {
  const costs = studioCosts(env, plans); const cost = longformCostUsd(env, minutes);
  return Math.max(1, costs.credit_floor ? creditsForCost(cost, costs.credit_floor, MARGIN_TARGET) : Math.ceil(cost * 100));
}

export type LongformOptions = { prompt: string; minutes: (typeof LONGFORM_MINUTES)[number]; mode: (typeof LONGFORM_MODES)[number] };

export function parseLongformOptions(raw: any): LongformOptions {
  const prompt = String(raw?.prompt ?? "").replace(/\s+/g, " ").trim();
  if (prompt.length < LONGFORM_LIMITS.promptMin) throw new LongformError("longform_prompt", "Say what the story is about (for example: the Gardner museum heist)");
  if (prompt.length > LONGFORM_LIMITS.promptMax) throw new LongformError("longform_prompt", `Keep the prompt under ${LONGFORM_LIMITS.promptMax} characters`);
  const m = Number(raw?.minutes);
  const minutes: LongformOptions["minutes"] = Number.isFinite(m) ? LONGFORM_MINUTES.reduce<LongformOptions["minutes"]>((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a), LONGFORM_MINUTES[0]) : 10;
  const mode = (LONGFORM_MODES as readonly string[]).includes(String(raw?.mode)) ? (String(raw.mode) as LongformOptions["mode"]) : "auto";
  return { prompt, minutes, mode };
}

export type LongformQuote = { tool: "longform"; credits: number; options: Record<string, any>; summary: string };

export function quoteLongform(env: Record<string, string | undefined>, plans: PlanLike[], raw: any): LongformQuote {
  if (!longformEnabled(env)) throw new LongformError("longform_off", "Films are not switched on yet", 403);
  const o = parseLongformOptions(raw);
  const cost = longformCostUsd(env, o.minutes);
  const modeWord = o.mode === "true" ? "a true story" : o.mode === "fiction" ? "fiction" : o.mode === "speculative" ? "real facts, imagined scenario" : "true story, what-if or fiction: the planner decides";
  const summary = `${o.minutes}-minute narrated film · ${modeWord} · illustrated for this story · thumbnail, title and description included · about ${o.minutes * 4} minutes to make`;
  return { tool: "longform", credits: longformCredits(env, plans, o.minutes), options: { longform: { prompt: o.prompt, minutes: o.minutes, mode: o.mode }, cost_usd: cost }, summary };
}
