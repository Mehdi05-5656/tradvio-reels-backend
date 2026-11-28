// The admin panel's Tracker tab (daily tracker step 4, owner, Nov 28 2026): the nightly numbers of
// studio_daily_metrics and the tests registry, read for the owner only (404 for anyone else, like every admin route).
// GET /api/studio/admin/tracker?from=YYYY-MM-DD  ->  { from, rows: [{ day, cut, value, metrics }], tests: [...], computed_at }
// Read-only. Rolling days into weeks and months, and the rates, are done on the page (pure sums of these rows).
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { TRACKER_START } from "./daily-metrics.js";

export type TrackerRow = { day: string; cut: string; value: string; metrics: Record<string, any> };
export async function readTracker(sb: SupabaseClient, from: string): Promise<{ rows: TrackerRow[]; tests: any[]; computed_at: string | null }> {
  const rows: any[] = [];
  for (let at = 0; at < 300_000; at += 1000) {
    const r = await sb.from("studio_daily_metrics").select("day,cut,value,metrics,computed_at").gte("day", from).order("day").order("cut").order("value").range(at, at + 999);
    if (r.error) throw r.error;
    rows.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  const t = await sb.from("studio_tests").select("id,name,status,hypothesis,what_changes,measure,audience,focus,started_at,ended_at,needed_per_side,decision,notes,result,result_at").order("started_at", { ascending: true, nullsFirst: false });
  const computed = rows.reduce((m: string | null, r) => (!m || r.computed_at > m ? r.computed_at : m), null);
  return { rows: rows.map(({ computed_at: _c, ...r }) => r), tests: t.error ? [] : (t.data ?? []), computed_at: computed };
}

export function registerTracker(app: Express, sbFn: () => SupabaseClient, deps: { env?: Record<string, string | undefined> } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/studio/admin/tracker", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const q = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : TRACKER_START;
      const from = q < TRACKER_START ? TRACKER_START : q;
      res.json({ from, ...(await readTracker(sb, from)) });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (/studio_daily_metrics/.test(m) && /does not exist|schema cache/.test(m)) return res.status(503).json({ error: "tracker_unavailable" });
      console.error("[tracker]", m.slice(0, 200)); res.status(500).json({ error: "tracker_failed" });
    }
  });
}
