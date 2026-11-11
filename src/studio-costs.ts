// The cost ledger (migrations/20261115000000_studio_costs.sql): one row for every paid thing done on Clone8's behalf,
// with who was paid, for which product, which step asked for it, how much was used, the dollars, and how sure the
// figure is. The owner's rule (Nov 11 2026): track every cost as close to the cent as we can, and where it comes from.
//
// Who writes it: this backend (recordCost, and every "claude" and "vendor" event the code already records is copied
// here by studio-events.ts), the Kage/Stories worker (kage-motion worker/costs.ts) and, later, the Films worker.
// Who reads it: the admin panel's Money tab (GET /api/studio/admin/costs), the owner's account only.
// Rows are buffered and written every few seconds in one insert. Recording never throws and never slows a request.
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStudioAdmin } from "./studio-admin-auth.js";

export type CostBasis = "metered" | "list" | "estimated" | "invoice";
export type CostRow = { spent_at?: string; job_id?: string | null; user_id?: string | null; tool?: string | null; provider: string; product: string; source: string; units?: Record<string, number>; usd: number; basis: CostBasis; note?: string | null; writer?: string; ref?: string | null };

let sink: (() => SupabaseClient) | null = null;
let buffer: CostRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let warned = false;
const FLUSH_MS = 4000, MAX_BUFFER = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Called once when the Studio routes start; until then (and in tests that do not call it) rows go nowhere. */
export function initCosts(sbFn: () => SupabaseClient) { sink = sbFn; }
export function resetCostsForTests() { sink = null; buffer = []; if (timer) clearTimeout(timer); timer = null; warned = false; }
export const bufferedCostsForTests = () => buffer;

/** The row as the table takes it: lengths kept, ids checked, dollars to six places and never negative. */
export function cleanCost(c: CostRow, now = new Date()): Required<Omit<CostRow, "job_id" | "user_id" | "tool" | "note" | "ref">> & { job_id: string | null; user_id: string | null; tool: string | null; note: string | null; ref: string | null } {
  const usd = Number(c.usd);
  return { spent_at: c.spent_at && Number.isFinite(Date.parse(c.spent_at)) ? new Date(Date.parse(c.spent_at)).toISOString() : now.toISOString(),
    job_id: c.job_id && UUID.test(c.job_id) ? c.job_id : null, user_id: c.user_id && UUID.test(c.user_id) ? c.user_id : null, tool: c.tool ? String(c.tool).slice(0, 40) : null,
    provider: String(c.provider || "unknown").slice(0, 40), product: String(c.product || "unknown").slice(0, 120), source: String(c.source || "unlabelled").slice(0, 120),
    units: c.units ?? {}, usd: Number.isFinite(usd) && usd > 0 ? r6(usd) : 0, basis: c.basis, note: c.note ? String(c.note).slice(0, 300) : null, writer: String(c.writer ?? "backend").slice(0, 40), ref: c.ref ? String(c.ref).slice(0, 120) : null };
}

/** Record one cost. Synchronous and safe to call anywhere. */
export function recordCost(c: CostRow) {
  if (!sink || !c?.provider || buffer.length >= MAX_BUFFER) return;
  buffer.push(cleanCost(c));
  if (!timer) timer = setTimeout(() => { timer = null; void flushCosts(); }, FLUSH_MS);
}
/** Write what is buffered (also called on shutdown and by tests). */
export async function flushCosts(): Promise<number> {
  if (!sink || !buffer.length) return 0;
  const rows = buffer; buffer = [];
  try { const r = await sink().from("studio_costs").insert(rows); if (r.error) throw r.error; return rows.length; }
  catch (err: any) { if (!warned) { warned = true; console.log(`[costs] not recorded (${String(err?.message ?? err).slice(0, 160)}); further failures are silent`); } return 0; }
}

/** The cost row of an event the code already records (studio-events.ts): a Claude call with its tokens, or a call to
 *  another paid service at its assumed price. Null for events that carry no dollars. */
export function costFromEvent(e: { user_id?: string | null; kind: string; name: string; usd?: number | null; props?: Record<string, any> }): CostRow | null {
  if ((e.kind !== "claude" && e.kind !== "vendor") || e.usd == null || !Number.isFinite(Number(e.usd))) return null;
  const p = e.props ?? {}; const job = typeof p.job === "string" ? p.job : typeof p.job_id === "string" ? p.job_id : null;
  if (e.kind === "claude") return { user_id: e.user_id ?? null, job_id: job, tool: typeof p.tool === "string" ? p.tool : null, provider: "anthropic", product: String(p.model ?? "claude"), source: e.name,
    units: { input_tokens: Number(p.input) || 0, output_tokens: Number(p.output) || 0, cache_write_tokens: Number(p.cache_write) || 0, cache_read_tokens: Number(p.cache_read) || 0, calls: 1 }, usd: Number(e.usd), basis: "metered" };
  // (other services: the dollars are a price per call or per gigabyte that we assumed, so the row is an estimate)
  const units: Record<string, number> = { calls: 1 }; for (const k of ["bytes", "seconds", "credits", "characters"]) if (Number.isFinite(Number(p[k])) && p[k] != null) units[k] = Number(p[k]);
  return { user_id: e.user_id ?? null, job_id: job, tool: typeof p.tool === "string" ? p.tool : null, provider: e.name, product: String(p.path ?? e.name), source: String(p.use ?? e.name), units, usd: Number(e.usd), basis: "estimated", note: "priced at an assumed rate per call or per gigabyte" };
}

// ---------------------------------------------------------------------------------------------------
// The admin panel's view
// ---------------------------------------------------------------------------------------------------
export type CostsView = { days: number | null; from: string | null; rows: number; total_usd: number; first_row_at: string | null; last_row_at: string | null;
  by_provider: Array<{ key: string; usd: number; rows: number }>; by_tool: Array<{ key: string; usd: number; rows: number }>; by_source: Array<{ key: string; usd: number; rows: number }>; by_product: Array<{ key: string; usd: number; rows: number }>;
  by_basis: Array<{ key: string; usd: number; rows: number }>; by_writer: Array<{ key: string; usd: number; rows: number }>; by_day: Array<{ day: string; usd: number }>;
  jobs: { count: number; avg_usd: number; median_usd: number; max_usd: number; top: Array<{ job_id: string; tool: string | null; usd: number; rows: number; spent_at: string }> }; truncated: boolean };

/** Add the rows up every way the panel shows them. Pure: the route reads, this counts. */
export function summarizeCosts(rows: Array<{ spent_at: string; job_id: string | null; tool: string | null; provider: string; product: string; source: string; usd: number | string; basis: string; writer: string }>, o: { days: number | null; from: string | null; truncated?: boolean }): CostsView {
  const group = (key: (r: any) => string, limit = 40) => { const m = new Map<string, { usd: number; rows: number }>(); for (const r of rows) { const k = key(r), g = m.get(k) ?? { usd: 0, rows: 0 }; g.usd += Number(r.usd) || 0; g.rows++; m.set(k, g); } return [...m.entries()].map(([k, g]) => ({ key: k, usd: r6(g.usd), rows: g.rows })).sort((a, b) => b.usd - a.usd).slice(0, limit); };
  const days = new Map<string, number>(); for (const r of rows) { const d = String(r.spent_at).slice(0, 10); days.set(d, (days.get(d) ?? 0) + (Number(r.usd) || 0)); }
  const jobs = new Map<string, { tool: string | null; usd: number; rows: number; spent_at: string }>(); for (const r of rows) { if (!r.job_id) continue; const j = jobs.get(r.job_id) ?? { tool: r.tool, usd: 0, rows: 0, spent_at: r.spent_at }; j.usd += Number(r.usd) || 0; j.rows++; if (r.spent_at > j.spent_at) j.spent_at = r.spent_at; jobs.set(r.job_id, j); }
  const per = [...jobs.values()].map((j) => j.usd).sort((a, b) => a - b); const times = rows.map((r) => r.spent_at).sort();
  return { days: o.days, from: o.from, rows: rows.length, total_usd: r6(rows.reduce((a, r) => a + (Number(r.usd) || 0), 0)), first_row_at: times[0] ?? null, last_row_at: times[times.length - 1] ?? null,
    by_provider: group((r) => r.provider), by_tool: group((r) => r.tool ?? "(no tool)"), by_source: group((r) => `${r.provider}: ${r.source}`), by_product: group((r) => `${r.provider}: ${r.product}`), by_basis: group((r) => r.basis), by_writer: group((r) => r.writer),
    by_day: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, usd]) => ({ day, usd: r6(usd) })),
    jobs: { count: per.length, avg_usd: per.length ? r6(per.reduce((a, v) => a + v, 0) / per.length) : 0, median_usd: per.length ? r6(per[Math.floor((per.length - 1) / 2)]) : 0, max_usd: per.length ? r6(per[per.length - 1]) : 0,
      top: [...jobs.entries()].map(([job_id, j]) => ({ job_id, tool: j.tool, usd: r6(j.usd), rows: j.rows, spent_at: j.spent_at })).sort((a, b) => b.usd - a.usd).slice(0, 25) }, truncated: !!o.truncated };
}

const PAGE = 1000, MAX_ROWS = 100_000;
/** GET /api/studio/admin/costs?days=30 (or days=all): the owner's account only; 404 for anyone else, like the rest of
 *  the admin panel. &job=<id> returns that one job's lines instead. */
export function registerStudioCosts(app: Express, sbFn: () => SupabaseClient, deps: { env?: Record<string, string | undefined>; now?: () => number } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/studio/admin/costs", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const job = typeof req.query.job === "string" && UUID.test(req.query.job) ? req.query.job : null;
      if (job) { const r = await sb.from("studio_costs").select("spent_at,provider,product,source,units,usd,basis,note,writer,ref").eq("job_id", job).order("spent_at", { ascending: true }).limit(2000); if (r.error) throw r.error;
        const lines = r.data ?? []; return res.json({ job_id: job, total_usd: r6(lines.reduce((a: number, x: any) => a + (Number(x.usd) || 0), 0)), lines }); }
      const raw = String(req.query.days ?? "30"); const days = raw === "all" ? null : Math.min(365, Math.max(1, Math.round(Number(raw)) || 30));
      const from = days === null ? null : new Date((deps.now ?? Date.now)() - days * 86400_000).toISOString();
      const rows: any[] = []; let truncated = false;
      for (let at = 0; ; at += PAGE) {
        let q = sb.from("studio_costs").select("spent_at,job_id,tool,provider,product,source,usd,basis,writer").order("spent_at", { ascending: false }).range(at, at + PAGE - 1); if (from) q = q.gte("spent_at", from);
        const r = await q; if (r.error) throw r.error; rows.push(...(r.data ?? []));
        if ((r.data ?? []).length < PAGE) break; if (rows.length >= MAX_ROWS) { truncated = true; break; }
      }
      res.json(summarizeCosts(rows, { days, from, truncated }));
    } catch (e: any) {
      console.log(`[admin] costs ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_costs_failed" });
    }
  });
}
