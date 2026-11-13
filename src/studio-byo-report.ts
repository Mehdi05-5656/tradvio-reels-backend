// Signature written in the person's own chat: what each film really cost against what it was priced at (the owner's
// ask, Nov 13 2026: "make sure everything is logged and ideally self-optimised to make more accurate estimates").
// Every number comes from the cost ledger (studio_costs, written by the worker to the cent), never from the estimate a
// job was priced with. The grader's shadow check (source "hand-grade-shadow") is a test cost, shown on its own and left
// out of the film's cost, as the worker's cost guard leaves it out.
//
// GET /api/studio/admin/byo?days=30: the owner's account only (404 for anyone else, like the rest of the panel).
// Suggested prices are suggestions: nothing here changes a price. Prices change only by the owner's yes.
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANS } from "./studio.js";
import { creditValueFloor, creditsForCost } from "./studio-pricing.js";
import { storyByoCostUsd, storyByoMargin, storyByoMinMargin } from "./studio-stories.js";
import { creditValueFor } from "./studio-admin.js";
import { isStudioAdmin } from "./studio-admin-auth.js";

type Env = Record<string, string | undefined>;
const r2 = (x: number) => Math.round(x * 100) / 100, r3 = (x: number) => Math.round(x * 1000) / 1000, r4 = (x: number) => Math.round(x * 10000) / 10000;
const quantile = (v: number[], q: number) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };

export type ByoFilm = {
  id: string; at: string; status: string; model: string | null; credits: number; revenue_usd: number; floor_revenue_usd: number;
  cost_usd: number; shadow_usd: number; estimate_usd: number | null; cap_usd: number | null; margin: number | null; floor_margin: number | null;
  lines: { pass: number; of: number } | null; repaired: boolean; minutes: number | null; over_cap: boolean;
};
export type ByoAlert = { level: "warn" | "bad"; text: string };

/** The model the chat named on its report's first line ("Model: Claude Sonnet 5.5"), if it did. */
export function modelOf(report: unknown): string | null {
  const m = String(report ?? "").match(/^\s*model\s*:\s*(.+)$/im);
  return m ? m[1].trim().replace(/[.\s]+$/, "").slice(0, 60) : null;
}

/** The report: one row per film, the summary, the alerts and the suggested price. Pure: the route reads, this counts. */
export function byoReport(jobs: any[], costs: Array<{ job_id: string; source: string; usd: number }>, customers: any[], env: Env = process.env, plans = PLANS) {
  const floor = creditValueFloor(plans); const byUser = new Map(customers.map((c) => [c.user_id, c]));
  const costOf = new Map<string, { usd: number; shadow: number }>();
  for (const c of costs) { const e = costOf.get(c.job_id) ?? { usd: 0, shadow: 0 }; if (/shadow/.test(c.source)) e.shadow += Number(c.usd) || 0; else e.usd += Number(c.usd) || 0; costOf.set(c.job_id, e); }
  const films: ByoFilm[] = jobs.map((j) => {
    const o = j.options ?? {}, out = (Array.isArray(j.outputs) ? j.outputs[0] : null) ?? {}, prem = out.premium ?? {};
    const credits = Number(j.credits_charged ?? 0) || 0; const c = costOf.get(j.id) ?? { usd: 0, shadow: 0 };
    const revenue = credits * creditValueFor(byUser.get(j.user_id)); const floorRevenue = credits * floor;
    const mins = prem.minutes && typeof prem.minutes === "object" ? Object.values(prem.minutes as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0) : null;
    return {
      id: j.id, at: j.finished_at ?? j.created_at, status: j.status, model: modelOf(prem.report), credits, revenue_usd: r2(revenue), floor_revenue_usd: r2(floorRevenue),
      cost_usd: r3(c.usd), shadow_usd: r3(c.shadow), estimate_usd: o.cost_usd != null ? Number(o.cost_usd) : null, cap_usd: o.cost_cap_usd != null ? Number(o.cost_cap_usd) : null,
      margin: revenue > 0 ? r4(1 - c.usd / revenue) : null, floor_margin: floorRevenue > 0 ? r4(1 - c.usd / floorRevenue) : null,
      lines: prem.final && Number(prem.final.of) ? { pass: Number(prem.final.pass), of: Number(prem.final.of) } : null, repaired: !!prem.repaired, minutes: mins != null ? Math.round(mins) : null,
      over_cap: o.cost_cap_usd != null && c.usd > Number(o.cost_cap_usd),
    };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const done = films.filter((f) => f.status === "done" && f.cost_usd > 0); const cost = done.map((f) => f.cost_usd);
  const estimate = storyByoCostUsd(env); const median = quantile(cost, 0.5), p90 = quantile(cost, 0.9), worst = cost.length ? Math.max(...cost) : null;
  // the price the costs say: at the house margin, from the worst film while there are few, then the 90th percentile
  const basis = done.length >= 5 ? p90 : worst; const margin = storyByoMargin(env);
  const now = creditsForCost(estimate, floor, margin), suggested = basis != null ? creditsForCost(basis, floor, 0.5) : null;
  const byModel = new Map<string, { films: number; pass: number; of: number; cost: number }>();
  for (const f of done) { const k = f.model ?? "not named"; const e = byModel.get(k) ?? { films: 0, pass: 0, of: 0, cost: 0 }; e.films++; e.pass += f.lines?.pass ?? 0; e.of += f.lines?.of ?? 0; e.cost += f.cost_usd; byModel.set(k, e); }

  const alerts: ByoAlert[] = [];
  const min = storyByoMinMargin(env);
  for (const f of done) {
    if (f.floor_margin != null && f.floor_margin < min) alerts.push({ level: "bad", text: `Film ${f.id.slice(0, 8)} ended at ${Math.round(f.floor_margin * 100)} % on the cheapest credit, under the ${Math.round(min * 100)} % floor ($${f.cost_usd.toFixed(2)})` });
    else if (f.margin != null && f.margin < 0.5) alerts.push({ level: "warn", text: `Film ${f.id.slice(0, 8)} ended at ${Math.round(f.margin * 100)} % margin, under 50 % ($${f.cost_usd.toFixed(2)})` });
    if (f.over_cap) alerts.push({ level: "bad", text: `Film ${f.id.slice(0, 8)} cost $${f.cost_usd.toFixed(2)}, over its $${(f.cap_usd ?? 0).toFixed(2)} ceiling` });
  }
  const drift = median != null && estimate > 0 ? r4((median - estimate) / estimate) : null;
  if (drift != null && done.length >= 3 && Math.abs(drift) > 0.1) alerts.push({ level: drift > 0 ? "bad" : "warn", text: `Real costs are ${Math.abs(Math.round(drift * 100))} % ${drift > 0 ? "above" : "below"} the $${estimate.toFixed(2)} the price is set from (middle film $${(median ?? 0).toFixed(2)}, ${done.length} films)` });

  return {
    films, alerts,
    summary: { films: films.length, done: done.length, estimate_usd: estimate, median_usd: median != null ? r3(median) : null, p90_usd: p90 != null ? r3(p90) : null, worst_usd: worst != null ? r3(worst) : null, drift,
      shadow_usd: r2(films.reduce((a, f) => a + f.shadow_usd, 0)), avg_margin: done.length ? r4(done.reduce((a, f) => a + (f.margin ?? 0), 0) / done.length) : null,
      lines: done.reduce((a, f) => ({ pass: a.pass + (f.lines?.pass ?? 0), of: a.of + (f.lines?.of ?? 0) }), { pass: 0, of: 0 }), repaired: done.filter((f) => f.repaired).length },
    price: { now, suggested, basis_usd: basis != null ? r3(basis) : null, basis: done.length >= 5 ? "90th percentile" : "dearest film so far", floor_credit_usd: r4(floor) },
    models: [...byModel.entries()].map(([model, e]) => ({ model, films: e.films, lines: { pass: e.pass, of: e.of }, avg_cost_usd: r3(e.cost / e.films) })).sort((a, b) => b.films - a.films),
  };
}

export function registerByoReport(app: Express, sbFn: () => SupabaseClient, deps: { env?: Env } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/studio/admin/byo", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days ?? 90)) || 90)); const since = new Date(Date.now() - days * 86400_000).toISOString();
      const j = await sb.from("studio_jobs").select("id,user_id,status,options,outputs,credits_charged,created_at,finished_at").eq("tool", "kage_motion").eq("options->story->>byo", "true").gte("created_at", since).order("created_at", { ascending: false }).limit(500);
      if (j.error) throw j.error;
      const jobs = j.data ?? []; const ids = jobs.map((x: any) => x.id);
      const [c, cu] = await Promise.all([
        ids.length ? sb.from("studio_costs").select("job_id,source,usd").in("job_id", ids) : Promise.resolve({ data: [], error: null } as any),
        sb.from("studio_customers").select("user_id,plan_id,billing_interval,status").in("user_id", [...new Set(jobs.map((x: any) => x.user_id))]),
      ]);
      if (c.error) throw c.error;
      res.json({ days, ...byoReport(jobs, c.data ?? [], cu.data ?? [], env) });
    } catch (e: any) {
      console.log(`[admin] byo: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_failed" });
    }
  });
}
