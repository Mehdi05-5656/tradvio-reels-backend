// What someone at their plan's limit is told (Nov 20 2026). studio_create_job refuses a run with too_many_jobs when the
// person already has as many going as their plan allows: Clips, Captions and library imports each count on their own,
// every other tool shares one count (studio_customers.parallel_jobs: Starter 1, Creator 2, Studio 4). This route says
// which runs are taking the places and which plan would give more, so the app can offer "upgrade for more at once" or
// "wait for one to finish". Our servers are protected separately: a worker only takes a job when it has room.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Plan } from "./studio.js";

export const OWN_POOL = new Set(["clips", "import", "captions"]);
export const poolOf = (tool: string): string => (OWN_POOL.has(tool) ? tool : "tools");

const LABEL: Record<string, string> = {
  blueprint: "Blueprint", blueprint_plus: "Blueprint+", blueprint_versions: "Blueprint", recast: "Recast", swap: "Swap", restyle: "Styles",
  trend: "Trends", character: "Characters", instrument: "Instruments", clips: "Clips", captions: "Captions", import: "Import",
  kage: "Kage remix", kage_motion: "Kage", longform: "Films", stunts: "Stunts", splitscreen: "Split screen", reshoot: "Reshoot",
};
/** The name a person knows a run by: a Story or a Motivation film runs on the Kage worker. Pure. */
export function runLabel(tool: string, options: any): string {
  if (tool === "kage_motion" && options?.motivation) return "Motivation";
  if (tool === "kage_motion" && options?.story) return "Story";
  return LABEL[tool] ?? tool.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export type BusyRun = { id: string; tool: string; label: string; status: string; stage: string | null; created_at: string };
export type BusyAnswer = {
  pool: string; limit: number; running: BusyRun[];
  plan: { id: string; name: string } | null;
  next: { id: string; name: string; parallel: number; monthly_usd: number } | null;
  owner: boolean;
};

/** Pure: the answer for one person and the tool they tried, from their customer row and their active jobs. */
export function busyAnswer(tool: string, cust: { plan_id: string | null; parallel_jobs: number | null; owner_pass?: boolean | null } | null,
  jobs: Array<{ id: string; tool: string; status: string; options?: any; progress?: any; created_at: string }>, plans: Plan[]): BusyAnswer {
  const pool = poolOf(tool);
  const limit = Math.max(1, Number(cust?.parallel_jobs ?? 1));
  const running = jobs.filter((j) => poolOf(j.tool) === pool && (j.status === "queued" || j.status === "running"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((j) => ({ id: j.id, tool: j.tool, label: runLabel(j.tool, j.options), status: j.status, stage: j.progress?.stage ?? null, created_at: j.created_at }));
  const owner = !!cust?.owner_pass;
  const plan = plans.find((p) => p.id === cust?.plan_id) ?? null;
  const next = owner ? null : plans.filter((p) => p.parallel > limit).sort((a, b) => a.parallel - b.parallel)[0] ?? null;
  return { pool, limit, running, plan: plan ? { id: plan.id, name: plan.name } : null,
    next: next ? { id: next.id, name: next.name, parallel: next.parallel, monthly_usd: next.monthly_usd } : null, owner };
}

/** The words under the button for a client that shows `detail` as it is (the iPhone app). Pure. */
export function busyDetail(a: BusyAnswer): string {
  const what = a.pool === "tools" ? "runs" : `${runLabel(a.pool, null)} runs`;
  const room = `Your plan runs ${a.limit} ${a.limit === 1 ? what.replace(/s$/, "") : what} at a time, and ${a.running.length === 1 ? "one is" : `${a.running.length} are`} going.`;
  return a.next ? `${room} Upgrade to ${a.next.name} for ${a.next.parallel} at once, or wait for one to finish.` : `${room} This one can start when one finishes.`;
}

export async function busyFor(sb: SupabaseClient, user: string, tool: string, plans: Plan[]): Promise<BusyAnswer> {
  const [cust, jobs] = await Promise.all([
    sb.from("studio_customers").select("plan_id,parallel_jobs,owner_pass").eq("user_id", user).maybeSingle(),
    sb.from("studio_jobs").select("id,tool,status,options,progress,created_at").eq("user_id", user).in("status", ["queued", "running"]).limit(100),
  ]);
  if (cust.error) throw cust.error;
  if (jobs.error) throw jobs.error;
  return busyAnswer(tool, cust.data as any, (jobs.data ?? []) as any[], plans);
}

export function registerBusy(app: Express, d: { sbFn: () => SupabaseClient; plans: Plan[]; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => any }): void {
  app.get("/api/studio/busy", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = d.requireUser(req, res); if (!u) return;
    const tool = String(req.query.tool ?? "").trim().slice(0, 40) || "tools";
    try { res.json(await busyFor(d.sbFn(), u, tool, d.plans)); } catch (e) { d.fail(res, e); }
  });
}
