// Clone8 Studio: the self-serve, paid, credit-based product beside the managed service.
//
// Plans are sold through Stripe Checkout; Stripe's webhooks are the only thing that changes a plan or
// grants credits (studio_apply_subscription, studio_grant). Tools cost credits that are reserved when a
// job is created and settled by the worker that runs it. Every route here is for the signed-in person
// themselves; nothing is operator-only except what the access gate already enforces elsewhere.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerPlanChange, ensurePortalConfig, missingPrices, isNoSuchPrice, upgradeCredits } from "./studio-plan-change.js";
import { creditsForCost, MAX_SOCIAL_EXTRA, SOCIAL_ACCOUNTS, SOCIAL_SEAT_USD, planFeatureLines, studioCosts, unitEconomics, packById, PACKS, type StudioCosts } from "./studio-pricing.js";
import { MAX_SECONDS as GENJUTSU_MAX, planLongPath } from "./studio-longpath.js";
import { AUTO_MAX_USD, AUTO_MIN_USD, TOPUP_MAX_USD, TOPUP_MIN_USD, chargeAutoTopUp, cleanUsd, maybeAutoTopUp, savedCard, startAutoTopUpLoop, topupCredits, topupInfo, topupRate, type StripeTopUp } from "./studio-topup.js";
import { isAdmin } from "./auth.js";
import { checkUpload, checkJobRate, hasPlanAccess } from "./studio-limits.js";
import { STUDIO_TRENDS, trendById, trendClipUrl, trendPosterUrl } from "./studio-trends.js";
import { instrumentsEnabled, publicInstrument, quoteInstrument, InstrumentError, type InstrumentQuote } from "./studio-instruments.js";
import { randomUUID } from "node:crypto";
import { receiptFromEvent, sendReceipt } from "./studio-receipts.js";
import { checkUnsubscribeToken } from "./studio-mail.js";
import { managedFit, sanitizeAnswers, signupInsights } from "./studio-onboarding.js";
import { recordEvent, recordPageViews } from "./studio-events.js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import Stripe from "stripe";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------
// Catalog. Prices live in Stripe; the ids come from the environment so test and live keys can differ.
// ---------------------------------------------------------------------------------------------------
export type PlanId = "starter" | "creator" | "studio";
export type Interval = "month" | "year";
export type Plan = { id: PlanId; name: string; tagline: string; monthly_usd: number; annual_usd_per_month: number; credits: number; parallel: number; features: string[]; popular?: boolean };

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", tagline: "For one creator with a library to put to work", monthly_usd: 29, annual_usd_per_month: 24, credits: 1000, parallel: 1,
    features: ["Every tool: Blueprint, Swap, Recast, Styles, Trends, Characters", "Every model in Instruments: video, pictures, voice and sound", "The assistant: say what you want, it plans and runs it", "Post and schedule to 1 social account", "Performance dashboard with an AI overview", "Downloads in 1080×1920, no watermark", "1 job at a time", "Top-ups at 4¢ a credit"] },
  { id: "creator", name: "Creator", tagline: "For creators and small teams posting daily", monthly_usd: 79, annual_usd_per_month: 66, credits: 3500, parallel: 2, popular: true,
    features: ["Everything in Starter", "Post and schedule to 3 social accounts", "2 jobs at a time, in the priority queue", "Top-ups at 3.5¢ a credit"] },
  { id: "studio", name: "Studio", tagline: "For brands and agencies running many accounts", monthly_usd: 199, annual_usd_per_month: 166, credits: 10000, parallel: 4,
    features: ["Everything in Creator", "Post and schedule to 10 social accounts", "4 jobs at a time, in the priority queue", "Top-ups at 3¢ a credit, our lowest rate", "A path to managed distribution"] },
];

// What a tool costs, in credits: derived in studio-pricing.ts from Higgsfield's rates, our plan prices and the
// margin target, so a price can never drift from a cost. COSTS is the value under the process environment.
/** What each side receives when a referred person pays their first invoice. */
export const REFERRAL_CREDITS = 500;
export const costsFor = (env: Record<string, string | undefined> = process.env): StudioCosts => studioCosts(env, PLANS);
export const COSTS: StudioCosts = costsFor();
/** Plans with the price-dependent feature lines filled in from the live costs. */
export function plansWithFeatures(costs: StudioCosts): Plan[] {
  return PLANS.map((p) => ({ ...p, features: [...planFeatureLines(p, costs), ...p.features] }));
}

export function planById(id: string | null | undefined): Plan | null { return PLANS.find((p) => p.id === id) ?? null; }

export function priceIdFor(plan: PlanId, interval: Interval, env: Record<string, string | undefined> = process.env): string | null {
  return env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] || null;
}
export function packPriceIdFor(packId: string, env: Record<string, string | undefined> = process.env): string | null {
  return env[`STRIPE_PRICE_${packId.toUpperCase()}`] || null;
}
/** The Stripe price of one extra social account, matching the plan's billing interval. */
export function seatPriceId(interval: Interval, env: Record<string, string | undefined> = process.env): string | null {
  return env[`STRIPE_PRICE_SOCIAL_ACCOUNT_${interval.toUpperCase()}`] || null;
}
/** Extra social accounts on a subscription: the quantity of its "extra social account" item. */
export function seatsOf(sub: any, env: Record<string, string | undefined> = process.env): number {
  const ids = new Set([seatPriceId("month", env), seatPriceId("year", env)].filter(Boolean));
  return ((sub?.items?.data ?? []) as any[]).filter((it) => ids.has(it?.price?.id ?? it?.plan?.id)).reduce((n, it) => n + (Number(it.quantity) || 0), 0);
}
export function planForPrice(priceId: string | null | undefined, env: Record<string, string | undefined> = process.env): { plan: Plan; interval: Interval } | null {
  if (!priceId) return null;
  for (const plan of PLANS) for (const interval of ["month", "year"] as Interval[]) if (priceIdFor(plan.id, interval, env) === priceId) return { plan, interval };
  return null;
}
export function stripeConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.STRIPE_SECRET_KEY && PLANS.every((p) => priceIdFor(p.id, "month", env));
}
// Which tools accept jobs. A tool opens when its worker is deployed (and, for Recast, when the Higgsfield
// platform key exists); until then the page is visible but Generate is disabled, so no credits can be
// reserved for work nothing would run.
export function toolsEnabled(env: Record<string, string | undefined> = process.env) {
  const recast = !!env.HIGGSFIELD_API_KEY && env.STUDIO_RECAST_ENABLED !== "false";
  // The full Genjutsu model stays closed until a paid run has measured what Higgsfield bills for it.
  // The Genjutsu suite (swap, restyle, trend) rides on the same key and runner; each can be closed on its own.
  return { blueprint: env.STUDIO_BLUEPRINT_ENABLED === "true", blueprint_plus: env.STUDIO_BLUEPRINT_PLUS_ENABLED === "true", recast, recast_full: recast && env.STUDIO_RECAST_FULL_ENABLED === "true",
    swap: recast && env.STUDIO_SWAP_ENABLED !== "false", restyle: recast && env.STUDIO_RESTYLE_ENABLED !== "false", trend: recast && env.STUDIO_TREND_ENABLED !== "false" && STUDIO_TRENDS.length > 0,
    character: recast && env.STUDIO_CHARACTER_ENABLED !== "false",
    // Instruments: every other platform model through one generic tool; opened by flag, narrowed by allow/hidden lists.
    instrument: instrumentsEnabled(env).length > 0,
    // The assistant: a Claude key and not switched off.
    assistant: !!env.ANTHROPIC_API_KEY && env.STUDIO_ASSISTANT_ENABLED !== "false" };
}

// ---------------------------------------------------------------------------------------------------
// Quotes: the credits a job will reserve, computed from validated options before anything is queued.
// ---------------------------------------------------------------------------------------------------
export type Quote = { tool: "blueprint" | "blueprint_plus" | "recast" | "swap" | "restyle" | "trend" | "character" | "instrument"; credits: number; options: Record<string, any>; summary: string };
const UUID_OPT = (v: unknown) => UUID_RE.test(String(v ?? ""));
const characterChoice = (o: any) => {
  const cast = castChoice(o);
  if (cast) return cast;
  if (!UUID_OPT(o.character_asset_id) && !/^[a-z0-9_-]{2,40}$/.test(String(o.character ?? ""))) throw new StudioError("character_required", "Pick a character or upload a photo");
  return { character: o.character ?? null, character_asset_id: o.character_asset_id ?? null };
};
export type CastMember = { character: string | null; character_asset_id: string | null; label: string | null };
/** Which people change when the clip has several (Swap, Recast, Trends): plain labels, carried into the renderer's
 *  prompt ("replace only this person"). None means everyone. Ignored when there is a cast (a character each). */
export function targetsOf(o: any): string[] {
  if (Array.isArray(o?.cast) && o.cast.length > 1) return [];
  return Array.isArray(o?.targets) ? o.targets.map((t: unknown) => String(t).replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 6) : [];
}
/** A character per person, left to right (2 to 8). One member collapses to the plain single choice; none means no cast. */
export function castChoice(o: any): { character: string | null; character_asset_id: string | null; cast?: CastMember[] } | null {
  if (!Array.isArray(o?.cast) || !o.cast.length) return null;
  if (o.cast.length > 8) throw new StudioError("cast_too_large", "Up to 8 people can be cast");
  const cast: CastMember[] = o.cast.map((m: any, i: number) => {
    const asset = UUID_OPT(m?.character_asset_id) ? String(m.character_asset_id) : null;
    const preset = !asset && /^[a-z0-9_-]{2,40}$/.test(String(m?.character ?? "")) ? String(m.character) : null;
    if (!asset && !preset) throw new StudioError("character_required", `Pick who plays person ${i + 1}`);
    const label = typeof m?.label === "string" ? m.label.replace(/\s+/g, " ").trim().slice(0, 60) || null : null;
    return { character: preset, character_asset_id: asset, label };
  });
  if (cast.length === 1) return { character: cast[0].character, character_asset_id: cast[0].character_asset_id };
  return { character: cast[0].character, character_asset_id: cast[0].character_asset_id, cast };
}

/** A job named the way a person thinks of it: "Swap · 44 s", "Blueprint · 3 copies", "Seedance 2.5 · 31 s". */
export function jobLabel(j: { tool: string; options?: any }): string {
  const o = j.options ?? {};
  const names: Record<string, string> = { blueprint: "Blueprint", blueprint_plus: "Blueprint+", recast: "Recast", swap: "Swap", restyle: "Style", trend: "Trend", character: "Character", instrument: "Instrument" };
  if (j.tool === "blueprint" || j.tool === "blueprint_plus") return `${names[j.tool]} · ${o.copies ?? "?"} ${o.copies === 1 ? "copy" : "copies"}`;
  if (j.tool === "instrument") { const ep = String(o.endpoint ?? ""); const fam = ep.startsWith("audio/") ? ep.slice(6).replace(/-/g, " ") : ep.split("/").slice(0, 2).pop()?.replace(/-/g, " ") ?? "model"; return `${fam.charAt(0).toUpperCase()}${fam.slice(1)}${o.units && o.output === "video" ? ` · ${Math.round(o.units)} s` : ""}`; }
  if (j.tool === "character") return o.style_name ? `Character · ${o.style_name}` : "Character";
  const secs = Number(o.seconds);
  return `${names[j.tool] ?? j.tool}${o.style_name ? ` · ${o.style_name}` : o.trend_name ? ` · ${o.trend_name}` : ""}${secs > 0 ? ` · ${secs} s` : ""}`;
}
/** Credits for a Light swap, recast or brought trend: the per-second price, or (when the clip is longer than one Light
 *  request or has camera changes) what its long-path plan costs at the Light tools' margin, whichever is higher. The
 *  plan needs the clip's cuts (found in the background after an upload); without them the per-second price stands. */
export function lightCredits(seconds: number, asset: { probe?: any } | null, costs: StudioCosts, env: Record<string, string | undefined> = process.env): number {
  const base = seconds * costs.recast_light_second;
  const cuts: number[] | null = Array.isArray(asset?.probe?.cuts) ? asset!.probe.cuts.filter((c: number) => c >= 0.5 && c < seconds - 0.5) : null;
  if (!costs.credit_floor || costs.light_margin == null || (seconds <= GENJUTSU_MAX.light && !cuts?.length)) return base;
  const plan = planLongPath(seconds, cuts ?? [], env);
  return Math.max(base, creditsForCost(plan.list_usd, costs.credit_floor, costs.light_margin));
}
/** Credits for the high-capacity route (Seedance, rendered in pieces): what its plan costs at list, at the margin of the
 *  expensive models, never under the Light per-second price. Offered with its price when Light is busy or refuses a clip. */
export function highCapacityCredits(seconds: number, asset: { probe?: any } | null, costs: StudioCosts, env: Record<string, string | undefined> = process.env): number {
  const cuts: number[] = Array.isArray(asset?.probe?.cuts) ? asset!.probe.cuts.filter((c: number) => c >= 0.5 && c < seconds - 0.5) : [];
  const plan = planLongPath(seconds, cuts, env, true);
  const margin = costs.light_margin ?? 0.2;
  return Math.max(seconds * costs.recast_light_second, costs.credit_floor ? creditsForCost(plan.list_usd, costs.credit_floor, margin) : 0);
}
export function quote(tool: string, options: any, asset: { kind: string; probe?: any } | null, costs: StudioCosts = COSTS): Quote {
  const o = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  if (tool === "blueprint" || tool === "blueprint_plus") {
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const copies = Math.floor(Number(o.copies));
    if (!(copies >= 1 && copies <= 50)) throw new StudioError("invalid_copies", "Between 1 and 50 copies");
    const per = tool === "blueprint" ? costs.blueprint_copy : costs.blueprint_plus_copy;
    return { tool, credits: copies * per, options: { copies }, summary: `${copies} ${copies === 1 ? "copy" : "copies"} × ${per}` };
  }
  if (tool === "recast") {
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const duration = Number(asset.probe?.duration);
    if (!(duration > 0)) throw new StudioError("asset_not_inspected", "The video is still being checked");
    const model = o.model === "light" ? "light" : "full";
    // Higgsfield's limits: the full model trims a source to 30 s, Light uses the first 15 s. They bill the input's container
    // duration rounded up, and a re-encoded 4.00 s file reads a hair over 4, so a tenth of a second is added before rounding.
    const cap = windowSeconds(o, WINDOW[model]);
    const seconds = billableSeconds(duration, cap);
    const who = characterChoice(o);
    const per = model === "light" ? costs.recast_light_second : costs.recast_second;
    const high = model === "light" && o.engine === "seedance";
    const credits = model === "light" ? (high ? highCapacityCredits(seconds, asset, costs) : lightCredits(seconds, asset, costs)) : seconds * per;
    return { tool, credits, options: { model, seconds, ...(cap < WINDOW[model] ? { max_seconds: cap } : {}), ...who, ...(targetsOf(o).length ? { targets: targetsOf(o) } : {}), ...(high ? { engine: "seedance" } : {}) }, summary: credits === seconds * per ? `${seconds} s × ${per}` : `${seconds} s, ${credits}${high ? " (high capacity)" : ""}` };
  }
  if (tool === "swap") {
    // Object swap: the person or thing in the video replaced by the reference image, scene and motion kept. Same rates as
    // Recast; Light takes up to 2 minutes (rendered in pieces at the camera changes), Full renders one shot of up to 30 s.
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const duration = Number(asset.probe?.duration);
    if (!(duration > 0)) throw new StudioError("asset_not_inspected", "The video is still being checked");
    const model = o.model === "light" ? "light" : "full";
    const cap = windowSeconds(o, WINDOW[model]);
    const seconds = billableSeconds(duration, cap);
    const who = characterChoice(o);
    const prompt = typeof o.prompt === "string" ? o.prompt.trim().slice(0, 600) : "";
    const targets = targetsOf(o);
    const per = model === "light" ? costs.recast_light_second : costs.recast_second;
    const high = model === "light" && o.engine === "seedance";
    const credits = model === "light" ? (high ? highCapacityCredits(seconds, asset, costs) : lightCredits(seconds, asset, costs)) : seconds * per;
    return { tool, credits, options: { model, seconds, ...(cap < WINDOW[model] ? { max_seconds: cap } : {}), ...who, prompt, ...(targets.length ? { targets } : {}), ...(high ? { engine: "seedance" } : {}) }, summary: credits === seconds * per ? `${seconds} s × ${per}` : `${seconds} s, ${credits}${high ? " (high capacity)" : ""}` };
  }
  if (tool === "restyle") {
    // Restyle: every frame redrawn in a Higgsfield style; motion, camera and audio stay. Full model only, up to 30 s.
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const duration = Number(asset.probe?.duration);
    if (!(duration > 0)) throw new StudioError("asset_not_inspected", "The video is still being checked");
    if (!UUID_OPT(o.style_id)) throw new StudioError("style_required", "Pick a style");
    const cap = windowSeconds(o, 30);
    const seconds = billableSeconds(duration, cap);
    const prompt = typeof o.prompt === "string" ? o.prompt.trim().slice(0, 600) : "";
    const style_name = typeof o.style_name === "string" ? o.style_name.slice(0, 80) : null;
    return { tool, credits: seconds * costs.recast_second, options: { model: "full", seconds, ...(cap < 30 ? { max_seconds: cap } : {}), style_id: o.style_id, style_name, prompt, character_asset_id: UUID_OPT(o.character_asset_id) ? o.character_asset_id : null }, summary: `${seconds} s × ${costs.recast_second}` };
  }
  if (tool === "trend") {
    // Trend: a driving clip performed by the person's character(s): one of our catalog clips, or any trend they bring as
    // a video (a TikTok or Instagram link fetched into the library, or an upload). The clip's length sets the price.
    const model = o.model === "light" ? "light" : "full";
    const per = model === "light" ? costs.recast_light_second : costs.recast_second;
    if (asset && asset.kind === "video") {
      const duration = Number(asset.probe?.duration);
      if (!(duration > 0)) throw new StudioError("asset_not_inspected", "The video is still being checked");
      const cap = windowSeconds(o, WINDOW[model]);
      const seconds = billableSeconds(duration, cap);
      const who = characterChoice(o);
      const trend_name = typeof o.trend_name === "string" && o.trend_name.trim() ? o.trend_name.trim().slice(0, 80) : "Your trend";
      const credits = model === "light" ? lightCredits(seconds, asset, costs) : seconds * per;
      return { tool, credits, options: { model, seconds, ...(cap < WINDOW[model] ? { max_seconds: cap } : {}), trend_id: null, trend_name, ...who, ...(targetsOf(o).length ? { targets: targetsOf(o) } : {}) }, summary: credits === seconds * per ? `${seconds} s × ${per}` : `${seconds} s, ${credits}` };
    }
    const trend = trendById(o.trend_id);
    if (!trend) throw new StudioError("trend_required", "Pick a trend");
    const seconds = billableSeconds(trend.seconds, model === "light" ? 15 : 30);
    const who = characterChoice(o);
    return { tool, credits: seconds * per, options: { model, seconds, trend_id: trend.id, trend_name: trend.name, ...who, ...(targetsOf(o).length ? { targets: targetsOf(o) } : {}) }, summary: `${seconds} s × ${per}` };
  }
  if (tool === "character") {
    // Character: a reusable character image from a prompt (human or animal), saved to the library for Recast, Swap and Trend.
    const prompt = typeof o.prompt === "string" ? o.prompt.trim().slice(0, 600) : "";
    if (prompt.length < 3) throw new StudioError("prompt_required", "Describe the character");
    const mode = o.mode === "animal" ? "animal" : "human";
    // Soul draws one portrait or a set of four; four options let the person pick a face before anything else runs.
    const count = Number(o.count) === 4 ? 4 : 1;
    return { tool, credits: count * costs.character_image, options: { mode, prompt, count }, summary: `${count} ${count === 1 ? "image" : "images"} × ${costs.character_image}` };
  }
  throw new StudioError("unknown_tool", "Unknown tool");
}

/** Seconds Higgsfield will bill for an input of `duration`. Longer sources are trimmed to the model's cap and billed exactly
 *  that (15.27 s Light runs billed 15); shorter ones bill the container duration rounded up, and a re-encoded 4.00 s file reads
 *  a hair over 4 (a 4.0 s Full run billed 5), so a tenth of a second is added before rounding. */
/** How much of a clip a model takes: Full (Genjutsu) one request of up to 30 s; Light up to 2 minutes, rendered in
 *  pieces of at most 30 s at the camera changes when the clip is long or cuts between shots. */
export const WINDOW = { full: 30, light: 120 } as const;
/** The stretch of the clip to use: the model's cap, or a shorter opening the person asked for (max_seconds, at least 4). */
export function windowSeconds(o: any, cap: number): number {
  const asked = Number(o?.max_seconds);
  return Number.isFinite(asked) && asked >= 4 ? Math.min(cap, Math.floor(asked)) : cap;
}
export function billableSeconds(duration: number, cap: number): number {
  if (!(duration > 0)) return 1;
  return duration >= cap ? cap : Math.max(1, Math.ceil(duration + 0.1));
}

export class StudioError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

// ---------------------------------------------------------------------------------------------------
// Stripe shapes. API 2026-09-30 moved the billing period onto subscription items and the subscription
// reference of an invoice under invoice.parent; older shapes are still read for safety.
// ---------------------------------------------------------------------------------------------------
const iso = (unix: any) => (Number.isFinite(Number(unix)) && Number(unix) > 0 ? new Date(Number(unix) * 1000).toISOString() : null);

export function subscriptionSnapshot(sub: any) {
  // the plan's item (a subscription may also carry an "extra social account" item)
  const items: any[] = sub?.items?.data ?? [];
  const item = items.find((it) => planForPrice(it?.price?.id ?? it?.plan?.id)) ?? items[0] ?? null;
  const priceId: string | null = item?.price?.id ?? item?.plan?.id ?? null;
  const match = planForPrice(priceId);
  return {
    id: String(sub?.id ?? ""),
    customer: typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id ?? null,
    status: String(sub?.status ?? "none"),
    price_id: priceId,
    plan: match?.plan ?? null,
    interval: match?.interval ?? ((item?.price?.recurring?.interval === "year" ? "year" : "month") as Interval),
    period_start: iso(item?.current_period_start ?? sub?.current_period_start),
    period_end: iso(item?.current_period_end ?? sub?.current_period_end),
    cancel_at_period_end: !!sub?.cancel_at_period_end,
    user_id: (sub?.metadata?.user_id as string | undefined) ?? null,
    social_extra: seatsOf(sub),
  };
}
/** Whether an invoice charges for a plan (a line priced at a plan's Stripe price with a positive amount). */
export function invoiceChargesPlan(inv: any, env: Record<string, string | undefined> = process.env): boolean {
  return ((inv?.lines?.data ?? []) as any[]).some((l) => {
    const price = l?.pricing?.price_details?.price ?? l?.price?.id ?? l?.plan?.id ?? null;
    return !!planForPrice(typeof price === "string" ? price : price?.id, env) && Number(l?.amount ?? 0) > 0;
  });
}
export function invoiceSubscriptionId(inv: any): string | null {
  const p = inv?.parent?.subscription_details?.subscription ?? inv?.subscription ?? null;
  return typeof p === "string" ? p : p?.id ?? null;
}

const STATUS_OK = new Set(["none", "incomplete", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);
const toStatus = (s: string) => (STATUS_OK.has(s) ? s : s === "incomplete_expired" ? "canceled" : "none");

type StripeLike = {
  checkout: { sessions: { create: (p: any) => Promise<{ url: string | null; id: string }> } };
  billingPortal: { sessions: { create: (p: any) => Promise<{ url: string }> } };
  subscriptions: { retrieve: (id: string) => Promise<any>; update?: (id: string, p: any) => Promise<any> };
} & StripeTopUp & {
  webhooks: { constructEvent: (raw: string, sig: string, secret: string) => any };
};

async function userForCustomer(sb: SupabaseClient, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const r = await sb.from("studio_customers").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  if (r.error) throw r.error;
  return r.data?.user_id ?? null;
}

async function applySubscription(sb: SupabaseClient, userId: string, sub: any) {
  const s = subscriptionSnapshot(sub);
  const r = await sb.rpc("studio_apply_subscription", {
    p_user: userId, p_customer: s.customer, p_subscription: s.id || null, p_plan: s.plan?.id ?? null, p_interval: s.plan ? s.interval : null,
    p_status: toStatus(s.status), p_period_start: s.period_start, p_period_end: s.period_end, p_cancel_at_period_end: s.cancel_at_period_end,
    p_credits_per_period: s.plan?.credits ?? 0, p_parallel: s.plan?.parallel ?? 1,
  });
  if (r.error) throw r.error;
  // extra social accounts follow the subscription's item (best effort: the route also writes it, and the next event syncs)
  try {
    const seats = await sb.from("studio_customers").update({ social_extra: Math.min(100, s.social_extra) }).eq("user_id", userId);
    if (seats?.error && !/social_extra/.test(String(seats.error.message ?? ""))) console.error(`[studio] social_extra sync for ${userId}: ${seats.error.message}`);
  } catch (e: any) { console.error(`[studio] social_extra sync for ${userId}: ${String(e?.message ?? e).slice(0, 120)}`); }
  return s;
}

/** Apply one Stripe event. Returns a short description for the log. Idempotency is the caller's job. */
export async function applyStripeEvent(sb: SupabaseClient, stripe: StripeLike, event: any): Promise<string> {
  const type = String(event?.type ?? ""), obj = event?.data?.object ?? {};
  if (type === "checkout.session.completed") {
    const userId = (obj.metadata?.user_id as string | undefined) ?? (obj.client_reference_id as string | undefined) ?? null;
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id ?? null;
    if (!userId || !UUID_RE.test(userId)) return "checkout without user";
    if (customer) {
      const link = await sb.from("studio_customers").upsert({ user_id: userId, stripe_customer_id: customer, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (link.error) throw link.error;
    }
    // A credit pack: one payment, credits on top, never expired by the next renewal. The session id makes the grant unique.
    if (obj.mode === "payment" && obj.metadata?.topup === "1") {
      // a top-up: the credits were worked out by the server when the session was made; the amount paid must match
      const credits = Math.floor(Number(obj.metadata?.credits)), usd = Number(obj.metadata?.usd);
      if (!(credits > 0) || !(usd >= TOPUP_MIN_USD)) return "top-up without credits";
      if (obj.payment_status && obj.payment_status !== "paid") return `top-up checkout ${obj.payment_status}`;
      if (obj.amount_total != null && Number(obj.amount_total) + 1 < Math.round(usd * 100)) return `top-up paid ${obj.amount_total} for $${usd}: not granted`;
      const g = await sb.rpc("studio_grant", { p_user: userId, p_credits: credits, p_ref: String(obj.id), p_expire_previous: false, p_note: `Top-up $${usd}` });
      if (g.error) throw g.error;
      return `top-up → ${g.data?.granted ? "granted" : "already granted"} ${credits}`;
    }
    if (obj.mode === "payment") {
      const pack = packById(obj.metadata?.pack);
      if (!pack) return "payment checkout without a known pack";
      if (obj.payment_status && obj.payment_status !== "paid") return `pack checkout ${obj.payment_status}`;
      const g = await sb.rpc("studio_grant", { p_user: userId, p_credits: pack.credits, p_ref: String(obj.id), p_expire_previous: false, p_note: `${pack.name} pack` });
      if (g.error) throw g.error;
      return `pack → ${g.data?.granted ? "granted" : "already granted"} ${pack.credits}`;
    }
    if (subId) { const sub = await stripe.subscriptions.retrieve(subId); const s = await applySubscription(sb, userId, { ...sub, metadata: { ...(sub.metadata ?? {}), user_id: userId } }); return `checkout → ${s.plan?.id ?? "unknown plan"} ${s.status}`; }
    return "checkout linked customer";
  }
  if (type.startsWith("customer.subscription.")) {
    const s = subscriptionSnapshot(obj);
    const userId = (s.user_id && UUID_RE.test(s.user_id) ? s.user_id : null) ?? (await userForCustomer(sb, s.customer));
    if (!userId) return "subscription for unknown customer";
    await applySubscription(sb, userId, obj);
    // A plan that has ended frees its self-serve posting profile (linked network tokens and a provider plan slot).
    let social = "";
    if (["canceled", "incomplete_expired"].includes(String(s.status))) {
      try { const { releaseSocialProfile } = await import("./studio-social.js"); if (await releaseSocialProfile(sb, userId)) social = ", posting profile removed"; }
      catch (e: any) { console.error(`[social] ALERT could not remove the posting profile of ${userId}: ${String(e?.message ?? e).slice(0, 160)}`); }
    }
    return `${type} → ${s.plan?.id ?? "unknown plan"} ${s.status}${social}`;
  }
  if (type === "invoice.paid") {
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    const subId = invoiceSubscriptionId(obj);
    if (!subId) return "invoice without subscription";
    // Stripe sends checkout.session.completed, customer.subscription.created and invoice.paid within the same second, and
    // the invoice can land first, before anything has linked the Stripe customer to a person. The subscription carries the
    // user id in its metadata (set at checkout), so resolve through it and write the link here. If that also fails, throw:
    // the event is then stored with its error and Stripe retries it minutes later, instead of a silent "unknown customer".
    const sub = await stripe.subscriptions.retrieve(subId);
    let userId = await userForCustomer(sb, customer);
    if (!userId) {
      const fromSub = typeof sub?.metadata?.user_id === "string" && UUID_RE.test(sub.metadata.user_id) ? sub.metadata.user_id : null;
      if (!fromSub) throw new Error(`invoice ${obj.id} for unknown customer ${customer ?? "?"} and subscription without user_id; left for retry`);
      userId = fromSub;
      if (customer) {
        const link = await sb.from("studio_customers").upsert({ user_id: userId, stripe_customer_id: customer, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        if (link.error) throw link.error;
      }
    }
    const s = await applySubscription(sb, userId, sub);
    if (!s.plan) return "invoice for unknown plan";
    const reason = String(obj.billing_reason ?? "");
    // An invoice for extra social accounts alone (added mid-period) buys no credits: only an invoice that charges for the
    // plan itself grants them (otherwise adding an account would hand out a month of credits).
    if (reason === "subscription_update" && !invoiceChargesPlan(obj)) return `invoice.paid → extra social accounts only (${s.social_extra}), no credits`;
    // A new period replaces what was left; a mid-cycle upgrade adds its credits on top.
    const expire = reason === "subscription_cycle" || reason === "subscription_create" || reason === "";
    // Credits are priced per month. An annual invoice pays for twelve of them at once, so it grants the
    // year's credits in one go; they last until the next annual invoice replaces them. A mid-period upgrade buys the new
    // plan's credits for the time left, less the old plan's unused share, as Stripe prorates the price.
    const prorated = reason === "subscription_update" ? upgradeCredits(obj) : null;
    const credits = prorated ?? s.plan.credits * (s.interval === "year" ? 12 : 1);
    if (credits <= 0) return `invoice.paid → upgrade with no credits to add (${reason})`;
    const g = await sb.rpc("studio_grant", { p_user: userId, p_credits: credits, p_ref: String(obj.id), p_expire_previous: expire, p_note: `${s.plan.name} ${s.interval === "year" ? "annual " : ""}${reason || "invoice"}` });
    if (g.error) throw g.error;
    // The first paid invoice of a referred person credits both sides, once; the function is a no-op otherwise.
    let referral = "";
    if (reason === "subscription_create" && g.data?.granted) {
      const r = await sb.rpc("studio_referral_reward", { p_user: userId, p_credits: REFERRAL_CREDITS });
      if (r.error) throw r.error;
      if (r.data?.granted) referral = `, referral ${REFERRAL_CREDITS} both ways`;
    }
    return `invoice.paid → ${g.data?.granted ? "granted" : "already granted"} ${credits} (${reason || "invoice"})${referral}`;
  }
  return "ignored";
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
const safeName = (s: any) => String(s ?? "").replace(/[^\w.() -]+/g, "_").slice(0, 120) || "upload";
function kindFor(name: string, type: string): { kind: "video" | "image"; ext: "mp4" | "mov" | "jpg" | "png" } | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (type === "video/mp4" || ext === "mp4") return { kind: "video", ext: "mp4" };
  if (type === "video/quicktime" || ext === "mov") return { kind: "video", ext: "mov" };
  if (type === "image/jpeg" || ext === "jpg" || ext === "jpeg") return { kind: "image", ext: "jpg" };
  if (type === "image/png" || ext === "png") return { kind: "image", ext: "png" };
  return null;
}

export type StudioStyle = { id: string; name: string; preview_url: string | null };
/** GET the restyle presets from Higgsfield's platform API. */
export async function fetchStyles(env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): Promise<StudioStyle[]> {
  const key = env.HIGGSFIELD_API_KEY; if (!key) return [];
  const auth = key.includes(":") ? `Key ${key.trim()}` : `Bearer ${key.trim()}`;
  const r = await fetchFn("https://api.higgsfield.ai/models/higgsfield/genjutsu/restyle/v1.0/presets", { headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`styles ${r.status}`);
  const body: any = await r.json();
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.presets) ? body.presets : Array.isArray(body?.items) ? body.items : [];
  return list.filter((p) => UUID_RE.test(String(p?.id ?? ""))).map((p) => ({ id: String(p.id), name: String(p.name ?? "Style").slice(0, 80), preview_url: typeof p.preview_url === "string" ? p.preview_url : null }));
}

export function registerStudio(app: Express, sbFn: () => SupabaseClient, deps: { stripe?: StripeLike | null; env?: Record<string, string | undefined>; log?: (s: string) => void; styles?: (env: Record<string, string | undefined>) => Promise<StudioStyle[]> } = {}): void {
  const env = deps.env ?? process.env;
  const costs = studioCosts(env, PLANS);
  const log = deps.log ?? ((s: string) => console.log(s));
  let stripeClient: StripeLike | null | undefined = deps.stripe;
  const stripe = (): StripeLike => {
    if (stripeClient === undefined) stripeClient = env.STRIPE_SECRET_KEY ? (new Stripe(env.STRIPE_SECRET_KEY) as unknown as StripeLike) : null;
    if (!stripeClient) throw new StudioError("billing_unavailable", "Billing is not configured yet", 503);
    return stripeClient;
  };
  const dashboard = () => (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "");
  const stripeOrNull = (): StripeLike | null => { try { return stripe(); } catch { return null; } };
  // auto top-up for chat runs and anything else that spends outside the job route (production only)
  if (deps.stripe === undefined && env.STRIPE_SECRET_KEY && env.STUDIO_AUTO_TOPUP !== "off") startAutoTopUpLoop(sbFn, stripeOrNull, log);
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof StudioError || e instanceof InstrumentError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    const named = msg.match(/\b(subscription_required|insufficient_credits|too_many_jobs|asset_not_ready|job_not_found|job_not_cancelable|promo_unknown|promo_expired|promo_exhausted|promo_already_used|invalid_credits)\b/);
    if (named) return res.status(named[1] === "job_not_found" ? 404 : 409).json({ error: named[1] });
    if (/relation .* does not exist|function .* does not exist/i.test(msg)) return res.status(503).json({ error: "studio_unavailable", detail: "The Studio migration has not been applied" });
    if (isNoSuchPrice(e)) { console.error(`[studio] ALERT a STRIPE_PRICE_* setting is not a price in this Stripe account: ${msg.slice(0, 160)}`); return res.status(503).json({ error: "billing_misconfigured", detail: "That plan is not set up in billing yet. We have been alerted." }); }
    console.error("[studio]", msg);
    res.status(500).json({ error: "studio_failed", detail: msg.slice(0, 200) });
  };
  const requireUser = (req: Request, res: Response): string | null => {
    const u = userId(req);
    if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    return u;
  };
  registerPlanChange(app, { sbFn, stripe, env, dashboard, requireUser, fail, log });
  // every price setting looked up once at start: a sandbox id left behind shows in the log by its setting's name
  if (deps.stripe === undefined && env === process.env && env.STRIPE_SECRET_KEY) setTimeout(() => {
    void missingPrices(stripe(), env).then((bad) => { if (bad.length) console.error(`[studio] ALERT these Stripe price settings are not prices in this Stripe account: ${bad.join(", ")}`); else log("[studio] Stripe prices: all found"); }).catch(() => undefined);
    void ensurePortalConfig(stripe(), env, log).catch(() => undefined);
  }, 8000).unref?.();

  app.get("/api/studio/plans", (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    // per plan, the numbers the comparison shows: social accounts, the top-up rate, what an extra account costs
    const plans = plansWithFeatures(costs).map((p: any) => ({ ...p, social_accounts: SOCIAL_ACCOUNTS[p.id] ?? 1, topup_rate_usd: topupRate(p.id) }));
    res.json({ plans, costs, billing_ready: stripeConfigured(env), tools: toolsEnabled(env), packs: PACKS.map((p) => ({ ...p, available: !!packPriceIdFor(p.id, env) })), extra_account_usd: SOCIAL_SEAT_USD, topup_min_usd: TOPUP_MIN_USD });
  });

  // The Trends catalog: our driving clips, served by the dashboard host next to the preset portraits.
  app.get("/api/studio/trends", (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    const base = env.STUDIO_PRESET_BASE ?? env.DASHBOARD_URL ?? "https://app.clone8.io";
    res.json({ trends: STUDIO_TRENDS.map((t) => ({ ...t, video_url: trendClipUrl(base, t.id), poster_url: trendPosterUrl(base, t.id) })) });
  });

  // Higgsfield's restyle presets, fetched with our key and cached for an hour. Empty without a key, never an error.
  let stylesCache: { at: number; styles: any[] } | null = null;
  app.get("/api/studio/styles", async (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    try {
      if (stylesCache && Date.now() - stylesCache.at < 3600_000) return res.json({ styles: stylesCache.styles });
      const styles = await (deps.styles ?? fetchStyles)(env);
      stylesCache = { at: Date.now(), styles };
      res.json({ styles });
    } catch (e: any) { log(`[studio] styles ${String(e?.message ?? e).slice(0, 200)}`); res.json({ styles: stylesCache?.styles ?? [] }); }
  });

  // The operator console's Studio tab: who pays, what they run, what failed, what was refunded. Admin only.
  app.get("/api/ops/studio/overview", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try { res.json(await studioOverview(sbFn(), env)); } catch (e) { fail(res, e); }
  });

  // The owner's sheet: what each unit earns, costs and yields on every plan. Admin only; nothing a customer needs.
  app.get("/api/studio/economics", (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    res.json(unitEconomics(env, PLANS));
  });

  app.get("/api/studio/me", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const BASE = "plan_id,billing_interval,status,period_start,period_end,cancel_at_period_end,credits_per_period,parallel_jobs,onboarding,stripe_customer_id,stripe_subscription_id";
      const [cust0, bal, jobs, ledger] = await Promise.all([
        sb.from("studio_customers").select(`${BASE},referral_code,referred_by,email_opt_out,auto_topup_enabled,auto_topup_below,auto_topup_usd,auto_topup_last_at,auto_topup_error,owner_pass`).eq("user_id", u).maybeSingle(),
        sb.rpc("studio_balance", { p_user: u }),
        sb.from("studio_jobs").select("id,tool,status,credits_reserved,credits_charged,created_at").eq("user_id", u).gte("created_at", since).order("created_at", { ascending: false }).limit(200),
        sb.from("studio_credit_ledger").select("delta,reason,job_id,ref,note,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(50),
      ]);
      // Before the referrals migration those three columns do not exist: read the row without them, referral stays empty.
      const cust = cust0.error && /referral_code|referred_by|email_opt_out|auto_topup|owner_pass/.test(String(cust0.error.message ?? "")) ? await sb.from("studio_customers").select(BASE).eq("user_id", u).maybeSingle() : cust0;
      for (const r of [cust, bal, jobs, ledger]) if (r.error) throw r.error;
      const c: any = cust.data ?? null;
      const plan = planById(c?.plan_id);
      const spent = ((jobs.data ?? []) as any[]).reduce((n, j) => n + (j.credits_charged ?? (j.status === "queued" || j.status === "running" ? j.credits_reserved : 0)), 0);
      // name each credit movement by its job ("Swap · 44 s") instead of "Reserved for a job"
      const jobIds = [...new Set(((ledger.data ?? []) as any[]).map((l) => l.job_id).filter(Boolean))] as string[];
      const named = jobIds.length ? await sb.from("studio_jobs").select("id,tool,status,options,created_at").eq("user_id", u).in("id", jobIds) : { data: [] as any[] };
      const labels = new Map(((named.data ?? []) as any[]).map((j) => [j.id, { label: jobLabel(j), status: j.status }]));
      const ledgerOut = ((ledger.data ?? []) as any[]).map((l) => (l.job_id && labels.has(l.job_id) ? { ...l, job_label: labels.get(l.job_id)!.label, job_status: labels.get(l.job_id)!.status } : l));
      res.json({
        subscription: c ? { plan, interval: c.billing_interval, status: c.status, period_start: c.period_start, period_end: c.period_end, cancel_at_period_end: c.cancel_at_period_end, credits_per_period: c.credits_per_period, parallel_jobs: c.parallel_jobs, has_billing: !!c.stripe_customer_id, has_subscription: !!c.stripe_subscription_id && ["active", "trialing", "past_due"].includes(c.status) } : null,
        active: hasPlanAccess(c),
        ...(c?.owner_pass ? { owner_pass: true } : {}),
        balance: Number(bal.data ?? 0),
        onboarding: c?.onboarding ?? {},
        usage_30d: { jobs: (jobs.data ?? []).length, credits: spent },
        ledger: ledgerOut,
        costs,
        topup: c ? topupInfo(c, spent) : null,
        referral: await referralInfo(sb, u, (await applySignupReferral(sb, u, c)) ? { ...c, referred_by: true } : c),
        email_opt_out: !!c?.email_opt_out,
        // the owner's account sees the admin button; the key is absent for everyone else
        ...((await isStudioAdmin(req, sb, env)) ? { admin: true } : {}),
      });
    } catch (e) { fail(res, e); }
  });

  // Pages people open, sent by the dashboard in small batches, for the admin panel's usage counts.
  app.post("/api/studio/events", (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    let kept = 0;
    try { kept = recordPageViews(u, req.body?.events); } catch { /* never fails the page */ }
    res.status(202).json({ kept });
  });

  app.post("/api/studio/onboarding", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const raw = req.body?.answers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(raw).length > 8000) return res.status(400).json({ error: "invalid_answers" });
    // only known questions with known answers are kept (src/studio-onboarding.ts); anything else is dropped quietly
    const a = sanitizeAnswers(raw);
    try {
      const sb = sbFn();
      const r = await sb.from("studio_customers").upsert({ user_id: u, onboarding: { ...a, completed_at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select("onboarding").single();
      if (r.error) throw r.error;
      res.json({ onboarding: r.data.onboarding });
    } catch (e) { fail(res, e); }
  });

  /** A Studio page to land back on after checkout: #studio/<page>, with an instrument's id at most. Anything else: none. */
  const returnTo = (h: unknown): string | null => (typeof h === "string" && /^#studio\/[a-z-]{1,30}(\?id=[\w.%/-]{1,160})?$/.test(h) ? h : null);

  app.post("/api/studio/checkout", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const plan = planById(req.body?.plan), interval: Interval = req.body?.interval === "year" ? "year" : "month";
    if (!plan) return res.status(400).json({ error: "unknown_plan" });
    const price = priceIdFor(plan.id, interval, env);
    if (!price) return res.status(503).json({ error: "billing_unavailable", detail: "That plan is not configured in Stripe yet" });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id,stripe_subscription_id,status").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      // a real subscription changes plan in place (POST /api/studio/billing/change); a second one is never started
      if ((cust.data?.status === "active" || cust.data?.status === "trialing") && cust.data?.stripe_subscription_id) return res.status(409).json({ error: "already_subscribed", detail: "Change plans from the plan page" });
      const email = req.auth && "email" in req.auth ? req.auth.email : undefined;
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        // Subscription mode always creates a customer; customer_creation is only valid in payment mode.
        ...(cust.data?.stripe_customer_id ? { customer: cust.data.stripe_customer_id } : { customer_email: email }),
        client_reference_id: u,
        metadata: { user_id: u, plan_id: plan.id, interval },
        subscription_data: { metadata: { user_id: u, plan_id: plan.id } },
        allow_promotion_codes: true,
        // back to the page they left to pick a plan (their setup is kept there), else their account
        success_url: `${dashboard()}/${returnTo(req.body?.return_hash) ?? "#studio/account"}${returnTo(req.body?.return_hash)?.includes("?") ? "&" : "?"}checkout=success`,
        cancel_url: `${dashboard()}/#studio/pricing?checkout=canceled`,
      });
      log(`[studio] checkout ${JSON.stringify({ user: u, plan: plan.id, interval, session: session.id })}`);
      recordEvent({ user_id: u, kind: "checkout", name: "plan", props: { plan: plan.id, interval } });
      res.json({ url: session.url });
    } catch (e) { fail(res, e); }
  });

  // Extra social accounts: the same plan, made larger. The "extra social account" item on the person's subscription is
  // set to the number asked for; Stripe charges the prorated difference now (and refunds it as credit when lowered).
  app.post("/api/studio/billing/social-accounts", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const extra = Math.floor(Number(req.body?.extra));
    if (!(extra >= 0 && extra <= MAX_SOCIAL_EXTRA)) return res.status(400).json({ error: "invalid_extra", detail: `Between 0 and ${MAX_SOCIAL_EXTRA} extra accounts` });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("status,stripe_subscription_id,billing_interval,plan_id").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (!cust.data || !["active", "trialing"].includes(cust.data.status) || !cust.data.stripe_subscription_id) return res.status(409).json({ error: "subscription_required", detail: "Extra accounts are added to a plan; pick a plan first" });
      const interval: Interval = cust.data.billing_interval === "year" ? "year" : "month";
      const price = seatPriceId(interval, env);
      if (!price) return res.status(503).json({ error: "billing_unavailable", detail: "Extra accounts are not on sale yet" });
      const st = stripe();
      if (!st.subscriptions.update) return res.status(503).json({ error: "billing_unavailable", detail: "Billing is not configured yet" });
      const sub = await st.subscriptions.retrieve(cust.data.stripe_subscription_id);
      const item = ((sub?.items?.data ?? []) as any[]).find((it) => (it?.price?.id ?? it?.plan?.id) === price);
      const items = item ? [extra > 0 ? { id: item.id, quantity: extra } : { id: item.id, deleted: true }] : extra > 0 ? [{ price, quantity: extra }] : [];
      if (items.length) {
        // the difference is invoiced now; a card that fails leaves the subscription as it was
        const updated = await st.subscriptions.update(sub.id, { items, proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" });
        const seats = await sb.from("studio_customers").update({ social_extra: seatsOf(updated, env), updated_at: new Date().toISOString() }).eq("user_id", u);
        if (seats.error) throw seats.error;
      }
      log(`[studio] social accounts ${JSON.stringify({ user: u, extra, interval })}`);
      res.json({ extra, price_usd_month: interval === "year" ? SOCIAL_SEAT_USD.year_per_month : SOCIAL_SEAT_USD.month, interval });
    } catch (e: any) {
      if (e?.type === "StripeCardError" || e?.code === "card_declined" || /payment/i.test(String(e?.message ?? ""))) return res.status(402).json({ error: "payment_failed", detail: "The card on file was declined; update it in Billing and try again" });
      fail(res, e);
    }
  });

  // Top up any amount from $5: a one-off payment for credits on top of the plan. The card is saved (setup_future_usage)
  // so auto top-up can charge it later. The webhook grants the credits worked out here, at the plan's top-up rate.
  app.post("/api/studio/topup", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const usd = cleanUsd(req.body?.usd, TOPUP_MIN_USD, TOPUP_MAX_USD);
    if (usd == null) return res.status(400).json({ error: "invalid_amount", detail: `A top-up is between $${TOPUP_MIN_USD} and $${TOPUP_MAX_USD}, in whole dollars` });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id,status,plan_id").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (!cust.data || !["active", "trialing"].includes(cust.data.status)) return res.status(409).json({ error: "subscription_required", detail: "Credits are spent with a plan; pick a plan first" });
      const credits = topupCredits(usd, cust.data.plan_id);
      const email = req.auth && "email" in req.auth ? (req.auth as any).email : undefined;
      const back = typeof req.body?.return_hash === "string" && /^#studio\/[a-z-]+$/.test(req.body.return_hash) ? req.body.return_hash : "#studio/account";
      const session = await stripe().checkout.sessions.create({
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: usd * 100, product_data: { name: `Clone8 credits: ${new Intl.NumberFormat("en-US").format(credits)}`, description: "Added on top of your plan; they carry over at renewal." } } }],
        ...(cust.data.stripe_customer_id ? { customer: cust.data.stripe_customer_id } : { customer_email: email, customer_creation: "always" }),
        payment_intent_data: { setup_future_usage: "off_session", metadata: { user_id: u, topup: "1" } },
        client_reference_id: u,
        metadata: { user_id: u, topup: "1", usd: String(usd), credits: String(credits) },
        success_url: `${dashboard()}/${back}?topup=success`,
        cancel_url: `${dashboard()}/${back}?topup=canceled`,
      });
      log(`[studio] top-up checkout ${JSON.stringify({ user: u, usd, credits, session: session.id })}`);
      recordEvent({ user_id: u, kind: "checkout", name: "topup", usd, props: { credits } });
      res.json({ url: session.url, credits });
    } catch (e) { fail(res, e); }
  });
  // Auto top-up: on, the line (credits) and the amount. Turning it on needs a saved card (from a top-up or the plan).
  app.post("/api/studio/topup/auto", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const enabled = req.body?.enabled === true;
    const usd = cleanUsd(req.body?.usd, AUTO_MIN_USD, AUTO_MAX_USD), below = Math.floor(Number(req.body?.below));
    if (enabled && (usd == null || !(below >= 0 && below <= 100_000))) return res.status(400).json({ error: "invalid_auto", detail: `Pick a line of 0 to 100,000 credits and an amount of $${AUTO_MIN_USD} to $${AUTO_MAX_USD}` });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id,status").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (enabled) {
        if (!cust.data || !["active", "trialing"].includes(cust.data.status)) return res.status(409).json({ error: "subscription_required", detail: "Auto top-up needs a plan" });
        const card = await savedCard(stripe(), cust.data.stripe_customer_id);
        if (!card) return res.status(409).json({ error: "no_card", detail: "Top up once by hand to save your card, then turn this on" });
      }
      const w = await sb.from("studio_customers").update({ auto_topup_enabled: enabled, ...(enabled ? { auto_topup_below: below, auto_topup_usd: usd, auto_topup_error: null } : {}), updated_at: new Date().toISOString() }).eq("user_id", u);
      if (w.error) throw w.error;
      log(`[studio] auto top-up ${JSON.stringify({ user: u, enabled, below: enabled ? below : undefined, usd: enabled ? usd : undefined })}`);
      res.json({ enabled, below, usd });
      if (enabled) void maybeAutoTopUp(sb, stripeOrNull(), u, log, "turned on").catch(() => undefined);
    } catch (e) { fail(res, e); }
  });

  // One-off credit pack: Stripe Checkout in payment mode; the webhook grants the credits when it is paid.
  app.post("/api/studio/checkout-pack", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const pack = packById(req.body?.pack);
    if (!pack) return res.status(400).json({ error: "unknown_pack" });
    const price = packPriceIdFor(pack.id, env);
    if (!price) return res.status(503).json({ error: "billing_unavailable", detail: "That pack is not configured in Stripe yet" });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id,status").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      // Credits are spendable only with an active plan; a pack bought without one would sit unusable.
      if (!cust.data || !["active", "trialing"].includes(cust.data.status)) return res.status(409).json({ error: "subscription_required" });
      const email = req.auth && "email" in req.auth ? (req.auth as any).email : undefined;
      const session = await stripe().checkout.sessions.create({
        mode: "payment",
        line_items: [{ price, quantity: 1 }],
        ...(cust.data.stripe_customer_id ? { customer: cust.data.stripe_customer_id } : { customer_email: email, customer_creation: "always" }),
        client_reference_id: u,
        metadata: { user_id: u, pack: pack.id, credits: String(pack.credits) },
        success_url: `${dashboard()}/#studio/account?pack=success`,
        cancel_url: `${dashboard()}/#studio/account?pack=canceled`,
        allow_promotion_codes: true,
      });
      log(`[studio] pack checkout ${JSON.stringify({ user: u, pack: pack.id, session: session.id })}`);
      recordEvent({ user_id: u, kind: "checkout", name: "pack", usd: pack.usd, props: { pack: pack.id } });
      res.json({ url: session.url });
    } catch (e) { fail(res, e); }
  });

  // A referral code from a friend's link, applied once, before any plan is paid.
  app.post("/api/studio/referral", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) return res.status(400).json({ error: "invalid_code" });
    try {
      const r = await sbFn().rpc("studio_apply_referral", { p_user: u, p_code: code });
      if (r.error) throw r.error;
      if (r.data?.applied) log(`[studio] referral ${JSON.stringify({ user: u, referrer: r.data.referrer })}`);
      res.json(r.data);
    } catch (e) { fail(res, e); }
  });

  // One-click unsubscribe from the optional notices (results ready, low credits, renewal). The link carries a signed
  // token; GET shows a small confirm page (so a mail scanner that opens links unsubscribes nobody), POST does it. Gmail
  // and Yahoo POST "List-Unsubscribe=One-Click" here straight from their own unsubscribe button. Receipts keep coming.
  const unsubPage = (title: string, body: string, form = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f5f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1720"><div style="max-width:440px;margin:64px auto;padding:28px;background:#fff;border:1px solid #e6eaed;border-radius:14px"><p style="margin:0 0 14px;font-weight:700">Clone8 Studio</p><h1 style="margin:0 0 10px;font-size:20px">${title}</h1><p style="margin:0 0 18px;line-height:1.55;color:#33404a">${body}</p>${form}</div></body></html>`;
  app.get("/api/studio/email/unsubscribe", (req, res) => {
    const u = String(req.query.u ?? ""), t = String(req.query.t ?? "");
    if (!UUID_RE.test(u) || !checkUnsubscribeToken(u, t, env)) return res.status(400).type("html").send(unsubPage("This link is not valid", "Turn emails on or off from the Account page in Clone8 Studio instead."));
    const action = `/api/studio/email/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`;
    res.type("html").send(unsubPage("Stop Clone8 Studio notices?", "You will no longer get emails when results are ready, when credits run low or before your plan renews. Receipts for payments still arrive.", `<form method="post" action="${action}"><button type="submit" style="padding:11px 18px;border:0;border-radius:10px;background:#0f8f7f;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Stop these emails</button></form>`));
  });
  app.post("/api/studio/email/unsubscribe", async (req, res) => {
    const u = String(req.query.u ?? ""), t = String(req.query.t ?? "");
    if (!UUID_RE.test(u) || !checkUnsubscribeToken(u, t, env)) return res.status(400).type("html").send(unsubPage("This link is not valid", "Turn emails on or off from the Account page in Clone8 Studio instead."));
    try {
      const r = await sbFn().from("studio_customers").update({ email_opt_out: true, updated_at: new Date().toISOString() }).eq("user_id", u);
      if (r.error) throw r.error;
      log(`[mail] unsubscribed ${u}`);
      res.type("html").send(unsubPage("You will not get these emails", `Turned off. You can turn them back on any time from the Account page: ${(env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "")}/#studio/account`));
    } catch (e) { fail(res, e); }
  });

  // Email notices on or off.
  app.post("/api/studio/notices", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const optOut = req.body?.email_opt_out === true;
    try {
      const sb = sbFn();
      await sb.rpc("studio_lock_customer", { p_user: u });
      const r = await sb.from("studio_customers").update({ email_opt_out: optOut, updated_at: new Date().toISOString() }).eq("user_id", u);
      if (r.error) throw r.error;
      res.json({ email_opt_out: optOut });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/portal", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (!cust.data?.stripe_customer_id) return res.status(409).json({ error: "no_billing_account" });
      const configuration = await ensurePortalConfig(stripe(), env, log);
      const session = await stripe().billingPortal.sessions.create({ customer: cust.data.stripe_customer_id, return_url: `${dashboard()}/#studio/account`, ...(configuration ? { configuration } : {}) });
      res.json({ url: session.url });
    } catch (e) { fail(res, e); }
  });

  // Stripe → us. Signature-verified; the raw body is captured by the express.json verify hook in index.ts.
  app.post("/api/studio/stripe/webhook", async (req, res) => {
    // trimmed: a secret pasted with a trailing space or newline would otherwise fail every signature
    const secret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    if (!secret) return res.status(503).json({ error: "webhook_unconfigured" });
    let event: any;
    try { event = stripe().webhooks.constructEvent(String((req as any).rawBody ?? ""), String(req.header("stripe-signature") ?? ""), secret); }
    catch (e: any) { return res.status(400).json({ error: "bad_signature", detail: String(e?.message ?? e).slice(0, 120) }); }
    try {
      const sb = sbFn();
      const ins = await sb.from("studio_stripe_events").insert({ id: event.id, type: event.type, payload: event }).select("id").maybeSingle();
      if (ins.error) {
        if (!(/duplicate|unique|23505/i.test(ins.error.message ?? "") || (ins.error as any).code === "23505")) throw ins.error;
        // Seen before. Done: a no-op. Failed earlier (no processed_at): this is Stripe's retry, so apply it again; every
        // step is idempotent (grants are unique by reference, the subscription row is overwritten with the same values).
        const seen = await sb.from("studio_stripe_events").select("processed_at").eq("id", event.id).maybeSingle();
        if (seen.error) throw seen.error;
        if (!seen.data || seen.data.processed_at) return res.json({ received: true, duplicate: true });
      }
      let outcome = "";
      try { outcome = await applyStripeEvent(sb, stripe(), event); }
      catch (e: any) {
        await sb.from("studio_stripe_events").update({ error: String(e?.message ?? e).slice(0, 300) }).eq("id", event.id);
        console.error("[studio] webhook", event.type, String(e?.message ?? e));
        return res.status(500).json({ error: "webhook_failed" }); // Stripe retries; the event row keeps the error.
      }
      // Only the delivery that marks the event processed sends its receipt, so two deliveries at once email once.
      const done = await sb.from("studio_stripe_events").update({ processed_at: new Date().toISOString(), error: null }).eq("id", event.id).is("processed_at", null).select("id");
      log(`[studio] webhook ${event.type}: ${outcome}`);
      res.json({ received: true });
      const receipt = receiptFromEvent(event);
      if (receipt && !done.error && (done.data ?? []).length) {
        const o = event.data?.object ?? {};
        const customer = typeof o.customer === "string" ? o.customer : o.customer?.id ?? null;
        const hint = o.metadata?.user_id ?? o.client_reference_id;
        const who = typeof hint === "string" && UUID_RE.test(hint) ? hint : await userForCustomer(sb, customer).catch(() => null);
        void sendReceipt(sb, who, receipt, { env, log });
      }
    } catch (e) { if (!res.headersSent) fail(res, e); }
  });

  app.post("/api/studio/promo", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,24}$/.test(code)) return res.status(400).json({ error: "invalid_code" });
    try {
      const r = await sbFn().rpc("studio_redeem_promo", { p_user: u, p_code: code });
      if (r.error) throw r.error;
      log(`[studio] promo ${JSON.stringify({ user: u, code })}`);
      res.json(r.data);
    } catch (e) { fail(res, e); }
  });

  // Uploads: the browser PUTs straight to storage with a signed URL, then confirms.
  app.post("/api/studio/assets/upload-url", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const name = safeName(req.body?.name), size = Number(req.body?.size ?? 0), k = kindFor(name, String(req.body?.type ?? ""));
    if (!k) return res.status(400).json({ error: "invalid_file", detail: "MP4, MOV, JPG or PNG" });
    if (!(size > 0 && size <= 536870912)) return res.status(400).json({ error: "file_too_large", detail: "at most 512 MB" });
    try {
      const sb = sbFn();
      // Per-plan library limits (studio-limits.ts): files kept and bytes stored. Credits do not bound uploads, these do.
      const limit = await checkUpload(sb, u, size);
      if (limit) throw new StudioError(limit.code, limit.message, limit.status);
      const id = randomUUID(), key = `${u}/${id}.${k.ext}`;
      const row = await sb.from("studio_assets").insert({ id, user_id: u, kind: k.kind, name, object_key: key, bytes: size, status: "uploading" }).select("id").single();
      if (row.error) throw row.error;
      const signed = await sb.storage.from("studio-uploads").createSignedUploadUrl(key);
      if (signed.error || !signed.data) throw signed.error ?? new Error("signing_failed");
      res.json({ asset_id: id, key, token: signed.data.token, path: signed.data.path, bucket: "studio-uploads" });
    } catch (e) { fail(res, e); }
  });

  // The browser may also upload a poster frame for the thumbnail grids: one signed PUT into studio-outputs.
  app.post("/api/studio/assets/:id/poster-url", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id").eq("id", req.params.id).eq("user_id", u).neq("status", "deleted").maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const key = assetPosterKey(u, a.data.id);
      const signed = await sb.storage.from("studio-outputs").createSignedUploadUrl(key, { upsert: true });
      if (signed.error || !signed.data) throw signed.error ?? new Error("signing_failed");
      res.json({ key, token: signed.data.token, path: signed.data.path, bucket: "studio-outputs" });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/assets/:id/complete", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id,object_key,bytes,status,probe").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const dir = a.data.object_key.split("/")[0], file = a.data.object_key.split("/")[1];
      const listed = await sb.storage.from("studio-uploads").list(dir, { search: file, limit: 5 });
      if (listed.error) throw listed.error;
      const obj = (listed.data ?? []).find((o: any) => o.name === file);
      if (!obj) return res.status(409).json({ error: "upload_missing" });
      const bytes = Number(obj.metadata?.size ?? a.data.bytes) || a.data.bytes;
      // What the browser measured (duration, size) and whether it stored a poster. A worker's ffprobe later
      // replaces the numbers; the poster is kept unless the worker writes its own.
      const probe = { ...(a.data.probe ?? {}), ...clientProbe(req.body?.probe) };
      if (req.body?.poster === true) {
        const posters = await sb.storage.from("studio-outputs").list(`${u}/assets`, { search: `${a.data.id}.jpg`, limit: 5 });
        if (!posters.error && (posters.data ?? []).some((o: any) => o.name === `${a.data.id}.jpg`)) probe.poster_key = assetPosterKey(u, a.data.id);
      }
      const r = await sb.from("studio_assets").update({ status: "ready", bytes, probe, updated_at: new Date().toISOString() }).eq("id", a.data.id).select("id,kind,name,bytes,status,probe,created_at").single();
      if (r.error) throw r.error;
      // camera changes, in the background: they price a long swap from its real plan
      if (r.data.kind === "video") void import("./studio-recast.js").then((m) => m.detectCuts(sb, u, r.data.id, { log: (l) => console.log(l) })).catch(() => undefined);
      res.json({ asset: (await withPosterUrls(sb, [r.data]))[0] });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/assets", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_assets").select("id,kind,name,bytes,status,probe,created_at").eq("user_id", u).neq("status", "deleted").order("created_at", { ascending: false }).limit(200);
      if (r.error) throw r.error;
      res.json({ assets: await withPosterUrls(sb, r.data ?? []) });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/assets/:id/url", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("object_key,status").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.status === "deleted") return res.status(404).json({ error: "asset_not_found" });
      const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 900);
      if (s.error || !s.data) throw s.error ?? new Error("signing_failed");
      res.json({ url: s.data.signedUrl, expires_in: 900 });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/assets/:id", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id,object_key").eq("id", req.params.id).eq("user_id", u).neq("status", "deleted").maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const busy = await sb.from("studio_jobs").select("id", { count: "exact", head: true }).eq("asset_id", a.data.id).in("status", ["queued", "running"]);
      if (busy.error) throw busy.error;
      if ((busy.count ?? 0) > 0) return res.status(409).json({ error: "asset_in_use" });
      const rm = await sb.storage.from("studio-uploads").remove([a.data.object_key]);
      if (rm.error) throw rm.error;
      const r = await sb.from("studio_assets").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("id", a.data.id);
      if (r.error) throw r.error;
      res.json({ deleted: a.data.id });
    } catch (e) { fail(res, e); }
  });

  // Instruments: the catalog the dashboard draws forms from. Public like /plans; nothing in it is per person.
  app.get("/api/studio/instruments", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ instruments: instrumentsEnabled(env).map((m) => publicInstrument(m, env, PLANS)) });
  });
  /** The person's assets as signed URLs for an instrument quote or estimate (10 minutes is plenty for an estimate). */
  const resolveAssets = (sb: SupabaseClient, u: string) => async (ids: string[]) => {
    const r = await sb.from("studio_assets").select("id,kind,status,object_key,probe").eq("user_id", u).in("id", ids);
    if (r.error) throw r.error;
    const out = new Map<string, { url: string; kind: string; seconds: number | null }>();
    for (const a of (r.data ?? []) as any[]) {
      if (a.status !== "ready") continue;
      const s = await sb.storage.from("studio-uploads").createSignedUrl(a.object_key, 600);
      if (s.error || !s.data) continue;
      out.set(a.id, { url: s.data.signedUrl, kind: a.kind, seconds: Number(a.probe?.duration) > 0 ? Number(a.probe.duration) : null });
    }
    return out;
  };
  const quoteFor = async (sb: SupabaseClient, u: string, body: any): Promise<Quote> => {
    if (String(body?.tool ?? "") === "instrument") {
      const q: InstrumentQuote = await quoteInstrument({ env, log }, PLANS, body?.options, resolveAssets(sb, u));
      return q;
    }
    const asset = await loadAsset(sb, u, body?.asset_id);
    return quote(String(body?.tool ?? ""), body?.options, asset, costs);
  };

  // Jobs
  app.post("/api/studio/quote", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      res.json(await quoteFor(sbFn(), u, req.body));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/jobs", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const q = await quoteFor(sb, u, req.body);
      const asset = q.tool === "instrument" ? null : await loadAsset(sb, u, req.body?.asset_id);
      const tools = toolsEnabled(env);
      if (!(tools as any)[q.tool]) throw new StudioError("tool_not_open", "This tool is not taking jobs yet", 503);
      if ((q.tool === "recast" || q.tool === "swap" || q.tool === "trend") && q.options.model === "full" && !tools.recast_full) throw new StudioError("model_not_open", "The full model is not taking jobs yet", 503);
      // Per-plan rate limit on job creation; the database function bounds how many run at once, this bounds how many start an hour.
      const limit = await checkJobRate(sb, u);
      if (limit) throw new StudioError(limit.code, limit.message, limit.status);
      const create = () => sb.rpc("studio_create_job", { p_user: u, p_tool: q.tool, p_asset: asset?.id ?? null, p_options: { ...q.options, via: "tool" }, p_credits: q.credits });
      let r = await create();
      // short of credits with auto top-up on: top up, then start the job (once)
      if (r.error && /insufficient_credits/.test(String(r.error.message ?? r.error))) {
        const st = stripeOrNull();
        const auto = st ? await chargeAutoTopUp(sb, st, u, log, `job ${q.tool} needs ${q.credits}`) : { ok: false };
        if (auto.ok) r = await create();
        if (r.error && /insufficient_credits/.test(String(r.error.message ?? r.error))) {
          const bal = await sb.rpc("studio_balance", { p_user: u });
          return res.status(402).json({ error: "insufficient_credits", detail: "Not enough credits for this", needed: q.credits, balance: Number(bal.data ?? 0) });
        }
      }
      if (r.error) throw r.error;
      log(`[studio] job ${JSON.stringify({ user: u, tool: q.tool, credits: q.credits, job: r.data?.id })}`);
      res.status(201).json({ job: r.data, quote: q });
      void maybeAutoTopUp(sb, stripeOrNull(), u, log, "after a job").catch(() => undefined);
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/jobs", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_jobs").select("id,tool,status,asset_id,options,credits_reserved,credits_charged,progress,outputs,error_code,created_at,started_at,finished_at").eq("user_id", u).order("created_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      const jobs = await withAssetNames(sb, u, (r.data ?? []).map(publicJob));
      // Posters for the grids: the first few of each finished job in one signing call. Videos are signed per job.
      const keys = jobs.flatMap((j) => (j.status === "done" ? j.outputs.slice(0, LIST_POSTERS).map((o: any) => o.poster_key).filter(Boolean) : []));
      if (keys.length) {
        const signed = await sb.storage.from("studio-outputs").createSignedUrls(keys, 900);
        if (signed.error) throw signed.error;
        const urls = new Map((signed.data ?? []).map((x: any) => [x.path, x.signedUrl]));
        for (const j of jobs) if (j.status === "done") j.outputs = j.outputs.map((o: any, i: number) => (i < LIST_POSTERS && o.poster_key ? { ...o, poster_url: urls.get(o.poster_key) ?? null } : o));
      }
      res.json({ jobs });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/jobs/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "job_not_found" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_jobs").select("id,tool,status,asset_id,options,credits_reserved,credits_charged,progress,outputs,error_code,created_at,started_at,finished_at").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "job_not_found" });
      const job = (await withAssetNames(sb, u, [publicJob(r.data)]))[0];
      if (job.status === "done" && Array.isArray(job.outputs) && job.outputs.length) {
        const posters = job.outputs.map((o: any) => o.poster_key).filter(Boolean);
        const signed = posters.length ? await sb.storage.from("studio-outputs").createSignedUrls(posters, 900) : { data: [], error: null };
        if (signed.error) throw signed.error;
        const urls = new Map((signed.data ?? []).map((s: any) => [s.path, s.signedUrl]));
        // Each video is signed on its own so the browser saves it under a readable name.
        const base = downloadBase(job.asset_name, job.tool);
        const videos = await Promise.all(job.outputs.map((o: any, i: number) => sb.storage.from("studio-outputs").createSignedUrl(o.key, 900, { download: `${base}-${String(o.index ?? i + 1).padStart(2, "0")}.${String(o.key).split(".").pop() || "mp4"}` })));
        job.outputs = job.outputs.map((o: any, i: number) => ({ ...o, url: videos[i].data?.signedUrl ?? null, poster_url: o.poster_key ? urls.get(o.poster_key) ?? null : null }));
      }
      res.json({ job });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/jobs/:id/cancel", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "job_not_found" });
    try {
      const r = await sbFn().rpc("studio_cancel", { p_user: u, p_job: req.params.id });
      if (r.error) throw r.error;
      res.json({ job: publicJob(r.data) });
    } catch (e) { fail(res, e); }
  });
}

/** Everything the operator console shows about the Studio: customers with their plan and balance, revenue run-rate,
 *  the last 30 days of jobs, failures by reason, refunds and pack sales. Emails come from auth when the client has it. */
export async function studioOverview(sb: SupabaseClient, env: Record<string, string | undefined> = process.env, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86400000).toISOString();
  const [customers, jobs, ledger] = await Promise.all([
    sb.from("studio_customers").select("user_id,plan_id,billing_interval,status,period_end,cancel_at_period_end,credits_per_period,onboarding,created_at,updated_at").order("created_at", { ascending: false }).limit(500),
    sb.from("studio_jobs").select("id,user_id,tool,status,credits_reserved,credits_charged,error_code,options,progress,attempts,created_at,started_at,finished_at").gte("created_at", since).order("created_at", { ascending: false }).limit(2000),
    sb.from("studio_credit_ledger").select("user_id,delta,reason,ref,note,created_at").gte("created_at", since).limit(5000),
  ]);
  for (const r of [customers, jobs, ledger]) if (r.error) throw r.error;
  const rows = (customers.data ?? []) as any[];
  const emails = new Map<string, string>();
  const admin = (sb as any).auth?.admin;
  if (admin?.listUsers) {
    try { const u = await admin.listUsers({ page: 1, perPage: 1000 }); for (const x of (u.data?.users ?? []) as any[]) emails.set(x.id, x.email ?? ""); } catch { /* emails stay blank */ }
  }
  const balances = await Promise.all(rows.map(async (c) => { const b = await sb.rpc("studio_balance", { p_user: c.user_id }); return [c.user_id, Number(b.data ?? 0)] as const; }));
  const balance = new Map(balances);
  const jobList = (jobs.data ?? []) as any[];
  const byUser = new Map<string, { jobs: number; credits: number; last: string | null }>();
  for (const j of jobList) { const r = byUser.get(j.user_id) ?? { jobs: 0, credits: 0, last: null }; r.jobs++; r.credits += j.credits_charged ?? 0; r.last = r.last ?? j.created_at; byUser.set(j.user_id, r); }
  const active = rows.filter((c) => c.status === "active" || c.status === "trialing");
  const mrr = active.reduce((n, c) => { const p = planById(c.plan_id); if (!p) return n; return n + (c.billing_interval === "year" ? p.annual_usd_per_month : p.monthly_usd); }, 0);
  const led = (ledger.data ?? []) as any[];
  const packs = led.filter((l) => l.reason === "grant" && /pack$/.test(String(l.note ?? "")));
  const refunds = led.filter((l) => l.reason === "refund");
  const failures = jobList.filter((j) => j.status === "failed");
  const byReason: Record<string, number> = {};
  for (const f of failures) byReason[f.error_code ?? "unknown"] = (byReason[f.error_code ?? "unknown"] ?? 0) + 1;
  const byTool: Record<string, { jobs: number; done: number; failed: number; credits: number; seconds: number }> = {};
  for (const j of jobList) {
    const t = byTool[j.tool] ?? (byTool[j.tool] = { jobs: 0, done: 0, failed: 0, credits: 0, seconds: 0 });
    t.jobs++; if (j.status === "done") t.done++; if (j.status === "failed") t.failed++; t.credits += j.credits_charged ?? 0;
    if (j.started_at && j.finished_at) t.seconds += (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000;
  }
  // What failures and retries cost us: refunded credits, and the renderer spend (estimated at our rates when each request
  // was sent) on jobs that were refunded or needed more than one attempt. Higgsfield may not bill every failed render, so
  // the spend is an upper bound; the trend matters more than the cent.
  const spendOf = (j: any) => Number(j.progress?.spend_usd) || 0;
  const wasteBy: Record<string, { jobs: number; credits_refunded: number; spend_usd: number }> = {};
  for (const f of failures) { const w = wasteBy[f.error_code ?? "unknown"] ?? (wasteBy[f.error_code ?? "unknown"] = { jobs: 0, credits_refunded: 0, spend_usd: 0 }); w.jobs++; w.credits_refunded += f.credits_reserved ?? 0; w.spend_usd += spendOf(f); }
  const retried = jobList.filter((j) => j.status === "done" && (j.attempts ?? 1) > 1);
  const offered = failures.filter((j) => j.progress?.offer);
  const waste = {
    refunded_jobs: failures.length,
    credits_refunded: failures.reduce((n, j) => n + (j.credits_reserved ?? 0), 0),
    spend_on_refunded_usd: Math.round(failures.reduce((n, j) => n + spendOf(j), 0) * 100) / 100,
    retried_jobs: retried.length,
    spend_on_retried_usd: Math.round(retried.reduce((n, j) => n + spendOf(j), 0) * 100) / 100,
    high_capacity_offered: offered.length,
    by_code: Object.entries(wasteBy).map(([code, w]) => ({ code, ...w, spend_usd: Math.round(w.spend_usd * 100) / 100 })).sort((a, b) => b.spend_usd - a.spend_usd || b.jobs - a.jobs),
  };
  return {
    generated_at: now.toISOString(), window_days: 30, waste,
    // who is signing up: the answers to the questions after sign-up, counted (latest 500 customers)
    signups: signupInsights(rows.map((c) => ({ onboarding: c.onboarding, status: c.status }))),
    totals: { customers: rows.length, active: active.length, mrr_usd: mrr, jobs_30d: jobList.length, failed_30d: failures.length, credits_charged_30d: jobList.reduce((n, j) => n + (j.credits_charged ?? 0), 0), refunded_30d: refunds.reduce((n, l) => n + l.delta, 0), pack_credits_30d: packs.reduce((n, l) => n + l.delta, 0), pack_sales_30d: packs.length },
    tools: Object.entries(byTool).map(([tool, t]) => ({ tool, ...t, avg_seconds: t.done ? Math.round(t.seconds / t.done) : null })),
    failures: Object.entries(byReason).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    customers: rows.map((c) => ({ user_id: c.user_id, email: emails.get(c.user_id) ?? null, plan: c.plan_id, interval: c.billing_interval, status: c.status, period_end: c.period_end, cancel_at_period_end: c.cancel_at_period_end, balance: balance.get(c.user_id) ?? 0, intent: c.onboarding?.goal ?? c.onboarding?.intent ?? null, role: c.onboarding?.role ?? null, accounts: c.onboarding?.accounts ?? null, heard: c.onboarding?.heard ?? null, managed_fit: managedFit(c.onboarding), jobs_30d: byUser.get(c.user_id)?.jobs ?? 0, credits_30d: byUser.get(c.user_id)?.credits ?? 0, last_job_at: byUser.get(c.user_id)?.last ?? null, since: c.created_at })),
    recent_failures: failures.slice(0, 20).map((j) => ({ id: j.id, user_id: j.user_id, tool: j.tool, code: j.error_code, created_at: j.created_at })),
    tools_enabled: toolsEnabled(env),
  };
}

/** Sign-up codes already looked at in this process (one lookup per person, not one per page load). */
const signupRefChecked = new Set<string>();
/** A code saved on the account at sign-up (user metadata "ref"): applied here when the browser that opened the link is
 *  not the one that finished signing up (the confirmation email opened on a phone). Before any payment, once. */
export async function applySignupReferral(sb: SupabaseClient, u: string, c: any): Promise<boolean> {
  if (c?.referred_by || c?.stripe_subscription_id || !["none", "incomplete", undefined, null].includes(c?.status) || signupRefChecked.has(u)) return false;
  signupRefChecked.add(u);
  try {
    const got = await (sb as any).auth?.admin?.getUserById?.(u);
    const code = String(got?.data?.user?.user_metadata?.ref ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) return false;
    const r = await sb.rpc("studio_apply_referral", { p_user: u, p_code: code });
    if (r.error) throw r.error;
    if (r.data?.applied) console.log(`[studio] referral from sign-up ${JSON.stringify({ user: u, referrer: r.data.referrer })}`);
    return !!r.data?.applied;
  } catch (e: any) { console.error(`[studio] sign-up referral for ${u}: ${String(e?.message ?? e).slice(0, 160)}`); return false; }
}

/** The person's referral link and what it earned: friends who joined with it, friends who subscribed (both sides got
 *  credits), and the credits earned. The code is minted on first sight; a missing migration yields nulls. */
async function referralInfo(sb: SupabaseClient, u: string, c: any) {
  let code: string | null = c?.referral_code ?? null;
  if (!code) { const r = await sb.rpc("studio_referral_code", { p_user: u }); code = r.error ? null : (r.data as string | null); }
  const [joined, rewards] = await Promise.all([
    sb.from("studio_customers").select("user_id", { count: "exact", head: true }).eq("referred_by", u),
    sb.from("studio_credit_ledger").select("delta").eq("user_id", u).eq("reason", "promo").like("ref", "referral:%").limit(1000),
  ]);
  const rows = ((rewards.data ?? []) as any[]);
  return { code, url: code ? `${(process.env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "")}/#signup?ref=${code}` : null, credits_each: REFERRAL_CREDITS, joined: joined.count ?? 0, referred: rows.length, earned: rows.reduce((n, l) => n + (Number(l.delta) || 0), 0), referred_by: !!c?.referred_by };
}

export async function loadAsset(sb: SupabaseClient, u: string, assetId: any) {
  if (assetId == null) return null;
  if (!UUID_RE.test(String(assetId))) throw new StudioError("asset_not_found", "Unknown video", 404);
  const r = await sb.from("studio_assets").select("id,kind,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data || r.data.status === "deleted") throw new StudioError("asset_not_found", "Unknown video", 404);
  if (r.data.status !== "ready") throw new StudioError("asset_not_ready", "The upload has not finished", 409);
  return r.data as { id: string; kind: string; status: string; probe: any };
}

const LIST_POSTERS = 8;
const assetPosterKey = (u: string, id: string) => `${u}/assets/${id}.jpg`;

/** Numbers the browser measured on its own video element; anything else is ignored. */
function clientProbe(p: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!p || typeof p !== "object") return out;
  for (const k of ["duration", "width", "height"]) { const v = Number(p[k]); if (Number.isFinite(v) && v > 0 && v < 1e6) out[k] = Math.round(v * 1000) / 1000; }
  return out;
}

/** The file name a saved copy gets: the upload's name without its extension, tidied, plus the tool. */
export function downloadBase(assetName: string | null | undefined, tool: string): string {
  const stem = String(assetName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const word = ({ recast: "recast", swap: "swap", restyle: "restyle", trend: "trend", character: "character", instrument: "render" } as Record<string, string>)[tool] ?? "copy";
  return `${stem || "clone8"}-${word}`;
}

export async function withPosterUrls(sb: SupabaseClient, assets: any[]) {
  const keys = assets.map((a) => a.probe?.poster_key).filter(Boolean);
  if (!keys.length) return assets.map((a) => ({ ...a, poster_url: null }));
  const signed = await sb.storage.from("studio-outputs").createSignedUrls(keys, 900);
  const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
  return assets.map((a) => ({ ...a, poster_url: a.probe?.poster_key ? urls.get(a.probe.poster_key) ?? null : null }));
}

export async function withAssetNames(sb: SupabaseClient, u: string, jobs: any[]) {
  const ids = [...new Set(jobs.map((j) => j.asset_id).filter(Boolean))];
  if (!ids.length) return jobs.map((j) => ({ ...j, asset_name: null }));
  const r = await sb.from("studio_assets").select("id,name").eq("user_id", u).in("id", ids);
  const names = new Map(((r.data ?? []) as any[]).map((a) => [a.id, a.name]));
  return jobs.map((j) => ({ ...j, asset_name: j.asset_id ? names.get(j.asset_id) ?? null : null }));
}

/** A job's progress as its owner sees it: what we pay the renderer (spend_usd, pending_spend, spend_priced) stays ours. */
export function customerProgress(p: any): Record<string, any> {
  if (!p || typeof p !== "object") return {};
  const { spend_usd: _spend, pending_spend: _pending, spend_priced: _priced, ...rest } = p;
  return rest;
}
export function publicJob(j: any) {
  return { id: j.id, tool: j.tool, status: j.status, asset_id: j.asset_id, options: j.options ?? {}, credits_reserved: j.credits_reserved, credits_charged: j.credits_charged,
    progress: customerProgress(j.progress), outputs: Array.isArray(j.outputs) ? j.outputs : [], error_code: j.error_code, created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at };
}
