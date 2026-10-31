// Clone8 Studio pricing: credits are derived from what a unit of work costs us and what a credit earns us,
// never typed in by hand. The rule: a tool may cost at most (1 - MARGIN_TARGET) of what its credits earn on
// the cheapest plan after Stripe. Change a Higgsfield rate here when their price page changes; every quote,
// plan card and runner charge follows. See docs/Clone8-Studio-unit-economics.md for the worked sheet.

export type Resolution = "480p" | "720p" | "1080p";
export type PlanLike = { id: string; monthly_usd: number; annual_usd_per_month: number; credits: number };

export const STRIPE_FEE = { rate: 0.029, fixed: 0.30 };
/** We keep at least this share of net revenue on every tool, at the cheapest plan. */
export const MARGIN_TARGET = 0.5;
/** Higgsfield list prices, USD per second of input video, rounded up to whole seconds (open.higgsfield.ai, Oct 28 2026).
 *  Light is what four paid runs measured, not what the page says: $0.20 a second whatever the input (1080p or 720p) or the
 *  requested output. The full model's rates are the page's and are unmeasured; it stays closed until a paid run prices it. */
export const HIGGSFIELD_RATES: Record<"full" | "light", Record<Resolution, number>> = {
  full: { "480p": 0.318, "720p": 0.681, "1080p": 1.632 },
  light: { "480p": 0.20, "720p": 0.20, "1080p": 0.20 },
};
/** Seedance 2.5 video edit (the long path's renderer), USD a second of source rounded up per request, by resolution.
 *  480p is Higgsfield's page; 720p is its list price ($0.4622, open.higgsfield.ai, Oct 30 2026), which our bills match
 *  with whole-second rounding ($12.51 for a 26.03 s piece = 27 s, $8.36 for 17.39 s = 18 s): no discount applies to it.
 *  1080p is the page's $1.137. */
export const SEEDANCE_EDIT_RATES: Record<Resolution, number> = { "480p": 0.174, "720p": 0.463, "1080p": 1.137 };
/** Seedance's own discount, only when the console grants one (its max-discount tier is 30%). The account's Genjutsu
 *  discount (HIGGSFIELD_DISCOUNT) does not reach Seedance: the Oct 30 bills are at list. */
export function seedanceDiscount(env: Record<string, string | undefined> = process.env): number {
  const d = Number(env.HIGGSFIELD_SEEDANCE_DISCOUNT ?? 0);
  return Number.isFinite(d) ? Math.min(0.9, Math.max(0, d)) : 0;
}
export function seedanceEditCostPerSecond(env?: Record<string, string | undefined>, resolution: Resolution = RECAST_RESOLUTION): number {
  return SEEDANCE_EDIT_RATES[resolution] * (1 - seedanceDiscount(env));
}
/** The resolution we render at; pinned on every request so a default change on their side cannot move our cost. */
export const RECAST_RESOLUTION: Resolution = "720p";
/** What a Blueprint copy costs us: about 18 s of a $25/month worker, 6 MB stored for 30 days, one download. Blueprint+ adds two Claude calls. */
export const BLUEPRINT_COPY_COST_USD = 0.001, BLUEPRINT_PLUS_COPY_COST_USD = 0.04;
/** A character image from Higgsfield Soul (standard, 2K): $0.094 an image at list (open.higgsfield.ai, Oct 29, 2026). The AI Influencer
 *  sheet ($0.05, human or animal mode) has no published request schema yet; Soul is the documented endpoint. */
export const CHARACTER_IMAGE_COST_USD = 0.094;
/** Product floors: never price below these even when the cost would allow it. */
export const PRICE_FLOORS = { blueprint_copy: 4, blueprint_plus_copy: 12, recast_second: 1, recast_light_second: 1, character_image: 4 };

/** Net USD per credit for one charge: price less Stripe's cut, divided by the credits it buys. */
export function netPerCredit(priceUsd: number, credits: number): number {
  return (priceUsd * (1 - STRIPE_FEE.rate) - STRIPE_FEE.fixed) / credits;
}
/** The least a credit earns us across every plan and billing interval: what every price must clear. */
export function creditValueFloor(plans: PlanLike[]): number {
  return Math.min(...plans.flatMap((p) => [netPerCredit(p.monthly_usd, p.credits), netPerCredit(p.annual_usd_per_month, p.credits)]));
}
/** The discount Higgsfield grants us on list prices (0 until their console shows one); HIGGSFIELD_DISCOUNT=0.5 for the max-discount tier. */
export function higgsfieldDiscount(env: Record<string, string | undefined> = process.env): number {
  const d = Number(env.HIGGSFIELD_DISCOUNT ?? 0);
  return Number.isFinite(d) ? Math.min(0.9, Math.max(0, d)) : 0;
}
/** Expensive models keep a thinner margin so credits last longer (owner's rule, Oct 30 2026): a model is "premium" when
 *  30 seconds of its output would cost a person PREMIUM_30S_USD or more at the standard margin, even on the plan with
 *  the cheapest credits. Premium models are sold at PREMIUM_MARGIN; everything else at MARGIN_TARGET. */
export const PREMIUM_MARGIN = 0.2, PREMIUM_30S_USD = 10;
/** The least a person pays for a credit, before fees: the best-value plan and interval. */
export function bestGrossPerCredit(plans: PlanLike[]): number {
  return Math.min(...plans.flatMap((p) => [p.monthly_usd / p.credits, p.annual_usd_per_month / p.credits]));
}
/** The margin for a per-second video cost: premium when 30 s at the standard margin would reach PREMIUM_30S_USD. */
export function marginForSecond(usdPerSecond: number, plans: PlanLike[]): number {
  const credits30 = creditsForCost(usdPerSecond * 30, creditValueFloor(plans), MARGIN_TARGET);
  return credits30 * bestGrossPerCredit(plans) >= PREMIUM_30S_USD ? PREMIUM_MARGIN : MARGIN_TARGET;
}
/** Credits a second of a video model costing `usdPerSecond` is sold for, at its tier's margin. */
export function creditsPerSecond(usdPerSecond: number, plans: PlanLike[]): number {
  return creditsForCost(usdPerSecond, creditValueFloor(plans), marginForSecond(usdPerSecond, plans));
}
/** Credits that a unit costing `usd` must be sold for so the margin target holds at the floor. */
export function creditsForCost(usd: number, floor: number, margin = MARGIN_TARGET): number {
  return Math.max(1, Math.ceil(usd / ((1 - margin) * floor)));
}
export function higgsfieldCostPerSecond(model: "full" | "light", env?: Record<string, string | undefined>, resolution: Resolution = RECAST_RESOLUTION): number {
  return HIGGSFIELD_RATES[model][resolution] * (1 - higgsfieldDiscount(env));
}

/** Credits per unit. Swap, Restyle and Trend ride on Genjutsu at the same per-second rates as Recast (Full) and Recast Light,
 *  so they share recast_second / recast_light_second; a character image has its own unit. */
export type StudioCosts = { blueprint_copy: number; blueprint_plus_copy: number; recast_second: number; recast_light_second: number; character_image: number;
  /** For costs worked out per job (the long path): the credit value floor and the margin the Light tools are sold at. */
  credit_floor?: number; light_margin?: number };
export function studioCosts(env: Record<string, string | undefined> = process.env, plans: PlanLike[]): StudioCosts {
  const floor = creditValueFloor(plans);
  return {
    blueprint_copy: Math.max(PRICE_FLOORS.blueprint_copy, creditsForCost(BLUEPRINT_COPY_COST_USD, floor)),
    blueprint_plus_copy: Math.max(PRICE_FLOORS.blueprint_plus_copy, creditsForCost(BLUEPRINT_PLUS_COPY_COST_USD, floor)),
    recast_second: Math.max(PRICE_FLOORS.recast_second, creditsPerSecond(higgsfieldCostPerSecond("full", env), plans)),
    recast_light_second: Math.max(PRICE_FLOORS.recast_light_second, creditsPerSecond(higgsfieldCostPerSecond("light", env), plans)),
    character_image: Math.max(PRICE_FLOORS.character_image, creditsForCost(CHARACTER_IMAGE_COST_USD * (1 - higgsfieldDiscount(env)), floor)),
    credit_floor: floor, light_margin: marginForSecond(higgsfieldCostPerSecond("light", env), plans),
  };
}

/** The plan card lines that depend on prices, so they can never drift from the quote. */
export function planFeatureLines(plan: PlanLike, _costs: StudioCosts): string[] {
  // Only the credits: the owner chose (Oct 29, 2026) not to translate a plan into copies and seconds on the cards. The
  // per-tool prices stay visible on the pricing pages and on every Generate button.
  const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.floor(x));
  return [`${n(plan.credits)} credits a month`];
}

/** The sheet, for the owner: per plan and tool, what a unit earns, what it costs, the margin. */
export function unitEconomics(env: Record<string, string | undefined> = process.env, plans: PlanLike[]) {
  const costs = studioCosts(env, plans), discount = higgsfieldDiscount(env);
  const units = [
    { tool: "blueprint_copy", credits: costs.blueprint_copy, cost_usd: BLUEPRINT_COPY_COST_USD },
    { tool: "blueprint_plus_copy", credits: costs.blueprint_plus_copy, cost_usd: BLUEPRINT_PLUS_COPY_COST_USD },
    { tool: "recast_second", credits: costs.recast_second, cost_usd: higgsfieldCostPerSecond("full", env), tier_margin: marginForSecond(higgsfieldCostPerSecond("full", env), plans) },
    { tool: "recast_light_second", credits: costs.recast_light_second, cost_usd: higgsfieldCostPerSecond("light", env), tier_margin: marginForSecond(higgsfieldCostPerSecond("light", env), plans) },
    { tool: "long_path_seedance_second", credits: creditsPerSecond(seedanceEditCostPerSecond(env), plans), cost_usd: seedanceEditCostPerSecond(env), tier_margin: marginForSecond(seedanceEditCostPerSecond(env), plans) },
    { tool: "character_image", credits: costs.character_image, cost_usd: CHARACTER_IMAGE_COST_USD * (1 - discount) },
  ];
  const rows = plans.flatMap((p) => (["month", "year"] as const).map((interval) => {
    const net = netPerCredit(interval === "month" ? p.monthly_usd : p.annual_usd_per_month, p.credits);
    return { plan: p.id, interval, net_per_credit: round(net, 5), tools: units.map((u) => { const rev = u.credits * net; return { tool: u.tool, credits: u.credits, revenue_usd: round(rev, 4), cost_usd: round(u.cost_usd, 4), margin: round((rev - u.cost_usd) / rev, 3), tier_margin: (u as any).tier_margin ?? MARGIN_TARGET }; }) };
  }));
  return { margin_target: MARGIN_TARGET, premium_margin: PREMIUM_MARGIN, premium_30s_usd: PREMIUM_30S_USD, overhead: OVERHEAD, higgsfield_discount: discount, resolution: RECAST_RESOLUTION, credit_value_floor: round(creditValueFloor(plans), 5), costs, rates: HIGGSFIELD_RATES, rows };
}
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** What Clone8 pays for itself, never charged to people (owner's decision, Oct 30 2026): the assistant and the writing
 *  helpers (Claude), public-data lookups (ScrapeCreators) and the posting service (Ayrshare). Vendor prices checked
 *  Oct 30 2026; per-use figures are estimates from the prompts' sizes, to be replaced by the logged usage. The plans
 *  carry these: they are why a credit's value is taken at the cheapest plan after fees. */
export const OVERHEAD = {
  claude_usd_per_mtok: { "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 }, "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 } },
  chat_reply_usd: 0.03, caption_usd: 0.08, overview_usd: 0.25, blueprint_plus_copy_claude_usd: 0.04,
  scrapecreators_usd_per_call: 0.0019, performance_refresh_usd: 0.017, link_import_usd: 0.004,
  /** Ayrshare: one profile per person who links. Launch $299/month for up to 10; Business $599 for 30, then $8.99 each. */
  ayrshare_profile_usd_month: { launch_10: 29.9, business_100: 12.28, business_extra: 8.99 },
} as const;

/** One-off credit packs: a single Stripe payment, credits added on top of the plan's, never expired by a renewal.
 *  Priced above the plans' per-credit value on purpose (the plan is the better deal; packs are for a busy month). */
export type Pack = { id: "pack_500" | "pack_2000" | "pack_6000"; credits: number; usd: number; name: string };
export const PACKS: Pack[] = [
  { id: "pack_500", credits: 500, usd: 19, name: "500 credits" },
  { id: "pack_2000", credits: 2000, usd: 59, name: "2,000 credits" },
  { id: "pack_6000", credits: 6000, usd: 149, name: "6,000 credits" },
];
export const packById = (id: unknown): Pack | null => PACKS.find((p) => p.id === id) ?? null;
/** Every pack must earn at least the credit-value floor, or a pack would undercut the margin the plans are priced on. */
export function packsClearFloor(plans: PlanLike[]): boolean {
  const floor = creditValueFloor(plans);
  return PACKS.every((p) => netPerCredit(p.usd, p.credits) >= floor);
}

/** Every Claude call's cost in the log ("[cost] claude ..."): Clone8 pays these itself, so they are watched, not charged. */
export function logClaudeCost(log: ((l: string) => void) | undefined, feature: string, model: string, usage: any) {
  if (!usage || !log) return;
  const rates: Record<string, { input: number; output: number; cache_read: number }> = { "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 }, "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 } };
  const r = rates[model] ?? rates["claude-opus-5-5"];
  const inp = Number(usage.input_tokens ?? 0), outp = Number(usage.output_tokens ?? 0), read = Number(usage.cache_read_input_tokens ?? 0), write = Number(usage.cache_creation_input_tokens ?? 0);
  const usd = (inp * r.input + write * r.input * 1.25 + read * r.cache_read + outp * r.output) / 1e6;
  log(`[cost] claude ${JSON.stringify({ feature, model, input: inp, cache_write: write, cache_read: read, output: outp, usd: Math.round(usd * 10000) / 10000 })}`);
}

/** Social accounts a plan posts to (owner's decision, Oct 30 2026), and the price of each extra one added to a plan.
 *  Our cost is the posting service's profile: $8.99 a month each on its Business tier ($7.99 on annual billing). At
 *  the 50% margin after Stripe's 2.9%: $8.99 x 2 / 0.971 = $18.52, so $19 a month; $7.99 x 2 / 0.971 = $16.46, so $17 a
 *  month on annual plans. Included accounts are Clone8's own cost. */
export const SOCIAL_ACCOUNTS: Record<string, number> = { starter: 1, creator: 3, studio: 10 };
export const SOCIAL_SEAT_USD = { month: 19, year_per_month: 17 } as const;
export const MAX_SOCIAL_EXTRA = 50;
