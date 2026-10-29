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
/** The resolution we render at; pinned on every request so a default change on their side cannot move our cost. */
export const RECAST_RESOLUTION: Resolution = "720p";
/** What a Blueprint copy costs us: about 18 s of a $25/month worker, 6 MB stored for 30 days, one download. Blueprint+ adds two Claude calls. */
export const BLUEPRINT_COPY_COST_USD = 0.001, BLUEPRINT_PLUS_COPY_COST_USD = 0.04;
/** Product floors: never price below these even when the cost would allow it. */
export const PRICE_FLOORS = { blueprint_copy: 4, blueprint_plus_copy: 12, recast_second: 1, recast_light_second: 1 };

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
/** Credits that a unit costing `usd` must be sold for so the margin target holds at the floor. */
export function creditsForCost(usd: number, floor: number, margin = MARGIN_TARGET): number {
  return Math.max(1, Math.ceil(usd / ((1 - margin) * floor)));
}
export function higgsfieldCostPerSecond(model: "full" | "light", env?: Record<string, string | undefined>, resolution: Resolution = RECAST_RESOLUTION): number {
  return HIGGSFIELD_RATES[model][resolution] * (1 - higgsfieldDiscount(env));
}

export type StudioCosts = { blueprint_copy: number; blueprint_plus_copy: number; recast_second: number; recast_light_second: number };
export function studioCosts(env: Record<string, string | undefined> = process.env, plans: PlanLike[]): StudioCosts {
  const floor = creditValueFloor(plans);
  return {
    blueprint_copy: Math.max(PRICE_FLOORS.blueprint_copy, creditsForCost(BLUEPRINT_COPY_COST_USD, floor)),
    blueprint_plus_copy: Math.max(PRICE_FLOORS.blueprint_plus_copy, creditsForCost(BLUEPRINT_PLUS_COPY_COST_USD, floor)),
    recast_second: Math.max(PRICE_FLOORS.recast_second, creditsForCost(higgsfieldCostPerSecond("full", env), floor)),
    recast_light_second: Math.max(PRICE_FLOORS.recast_light_second, creditsForCost(higgsfieldCostPerSecond("light", env), floor)),
  };
}

/** The plan card lines that depend on prices, so they can never drift from the quote. */
export function planFeatureLines(plan: PlanLike, costs: StudioCosts): string[] {
  const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.floor(x));
  return [`${n(plan.credits)} credits a month`, `Blueprint: about ${n(plan.credits / costs.blueprint_copy)} copies a month`, `Recast: about ${n(plan.credits / costs.recast_second)} seconds a month (${n(plan.credits / costs.recast_light_second)} on Light)`];
}

/** The sheet, for the owner: per plan and tool, what a unit earns, what it costs, the margin. */
export function unitEconomics(env: Record<string, string | undefined> = process.env, plans: PlanLike[]) {
  const costs = studioCosts(env, plans), discount = higgsfieldDiscount(env);
  const units = [
    { tool: "blueprint_copy", credits: costs.blueprint_copy, cost_usd: BLUEPRINT_COPY_COST_USD },
    { tool: "blueprint_plus_copy", credits: costs.blueprint_plus_copy, cost_usd: BLUEPRINT_PLUS_COPY_COST_USD },
    { tool: "recast_second", credits: costs.recast_second, cost_usd: higgsfieldCostPerSecond("full", env) },
    { tool: "recast_light_second", credits: costs.recast_light_second, cost_usd: higgsfieldCostPerSecond("light", env) },
  ];
  const rows = plans.flatMap((p) => (["month", "year"] as const).map((interval) => {
    const net = netPerCredit(interval === "month" ? p.monthly_usd : p.annual_usd_per_month, p.credits);
    return { plan: p.id, interval, net_per_credit: round(net, 5), tools: units.map((u) => { const rev = u.credits * net; return { tool: u.tool, credits: u.credits, revenue_usd: round(rev, 4), cost_usd: round(u.cost_usd, 4), margin: round((rev - u.cost_usd) / rev, 3) }; }) };
  }));
  return { margin_target: MARGIN_TARGET, higgsfield_discount: discount, resolution: RECAST_RESOLUTION, credit_value_floor: round(creditValueFloor(plans), 5), costs, rates: HIGGSFIELD_RATES, rows };
}
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

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
