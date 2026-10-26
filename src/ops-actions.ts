// Operator actions: the things the owner used to do from a terminal, now buttons in the console.
// Every route is operator-only. Infrastructure actions go through the Render API with a key that lives only in the
// backend environment (RENDER_API_KEY); database actions go through the library's own SECURITY DEFINER functions as
// the signed-in operator, so the same gates apply as from the terminal. Nothing here resends a submission.
import type { Express, Request, Response } from "express";
import { isOperator } from "./auth.js";

export const FEATURES_SERVICE_ID = process.env.RENDER_FEATURES_SERVICE_ID ?? "crn-dagba90u01pc73dq0m2g";
/** Cron jobs an operator may run ahead of schedule. The publisher is deliberately absent: it runs every 5 minutes and must never be nudged by hand. */
export const RUNNABLE_CRONS: Record<string, { id: string; label: string }> = {
  analytics: { id: process.env.RENDER_ANALYTICS_CRON_ID ?? "crn-daennbf40ujc7380f3dg", label: "Platform insights and public metrics" },
  captions: { id: process.env.RENDER_CAPTIONS_CRON_ID ?? "crn-dagu505g1s2s73cmseog", label: "Caption suggestions" },
  features: { id: process.env.RENDER_FEATURES_CRON_ID ?? "crn-dagba90u01pc73dq0m2g", label: "Video features" },
  renderer: { id: process.env.RENDER_RENDERER_CRON_ID ?? "crn-dbf7fau7bikc73cfh6og", label: "Library renderer (one pass)" },
  leader: { id: process.env.RENDER_LEADER_CRON_ID ?? "crn-dbf7fb0ae00c73f2260g", label: "Research account refresh" },
};
export const RENDER_JOB_COMMAND = (maxJobs: number) => `timeout --signal=TERM --kill-after=30s 7200s env LIBRARY_RENDER_ENABLED=1 LIBRARY_MAX_JOBS=${maxJobs} python library-worker.py`;
const TIKTOK_SETTINGS = { privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: false, stitch: false, promotional: true, paid: false };
const INSTAGRAM_SETTINGS = { feed: true };

type Fetch = typeof fetch;
export const PUBLISHER_CRON_ID = process.env.RENDER_PUBLISHER_CRON_ID ?? "crn-daennav40ujc7380f1sg";
export type RenderApi = {
  createJob: (serviceId: string, startCommand: string) => Promise<{ id: string; status: string }>;
  runCron: (cronId: string) => Promise<{ id: string; status: string }>;
  /** A cron job's record: when it last finished with exit 0 (null when it never has) and whether it is suspended. */
  service: (serviceId: string) => Promise<{ lastSuccessfulRunAt: string | null; suspended: boolean }>;
};

/** Thin Render API client. The key is read per call so a rotation needs no restart. */
export function renderApi(env: Record<string, string | undefined> = process.env, f: Fetch = fetch): RenderApi | null {
  const key = env.RENDER_API_KEY;
  if (!key) return null;
  const call = async (path: string, body?: unknown, method: "POST" | "GET" = "POST") => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await f(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw new Error(`render_api_${r.status}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : {};
    } finally { clearTimeout(t); }
  };
  return {
    createJob: async (serviceId, startCommand) => { const j = await call(`/services/${serviceId}/jobs`, { startCommand }); return { id: String(j.id ?? ""), status: String(j.status ?? "created") }; },
    runCron: async (cronId) => { const j = await call(`/cron-jobs/${cronId}/runs`); return { id: String(j.id ?? ""), status: String(j.status ?? "triggered") }; },
    service: async (serviceId) => { const s = await call(`/services/${serviceId}`, undefined, "GET"); return { lastSuccessfulRunAt: typeof s?.serviceDetails?.lastSuccessfulRunAt === "string" ? s.serviceDetails.lastSuccessfulRunAt : null, suspended: s?.suspended === "suspended" }; },
  };
}

/** When each scheduled job last finished successfully, keyed by pipeline job id. A cron the API did not answer for is left out
 *  (unknown, not "never"); without a Render key the whole thing is undefined and the pipeline falls back to table timestamps. */
export async function cronRuns(api: RenderApi | null = renderApi()): Promise<Record<string, string | null> | undefined> {
  if (!api) return undefined;
  const ids: Record<string, string> = { publisher: PUBLISHER_CRON_ID, analytics: RUNNABLE_CRONS.analytics.id, captions: RUNNABLE_CRONS.captions.id, features: RUNNABLE_CRONS.features.id, render: RUNNABLE_CRONS.renderer.id, leader: RUNNABLE_CRONS.leader.id };
  const out: Record<string, string | null> = {};
  await Promise.all(Object.entries(ids).map(async ([job, id]) => { try { out[job] = (await api.service(id)).lastSuccessfulRunAt; } catch { /* unknown this time */ } }));
  return out;
}

/** Where the renderer stands: variant states, live leases and the recent claim rate. */
export async function rendererStatus(sb: any, now = new Date()) {
  const states: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("library_variants").select("state,lease_until").range(from, from + 999);
    if (r.error) throw r.error;
    for (const row of r.data ?? []) {
      const live = row.state === "running" && row.lease_until && Date.parse(row.lease_until) > now.getTime();
      const k = row.state === "running" && !live ? "stale_running" : row.state;
      states[k] = (states[k] ?? 0) + 1;
    }
    if ((r.data ?? []).length < 1000) break;
  }
  const since = new Date(now.getTime() - 30 * 60_000).toISOString();
  const a = await sb.from("library_attempts").select("created_at", { count: "exact", head: true }).gte("created_at", since);
  if (a.error) throw a.error;
  const last = await sb.from("library_attempts").select("created_at").order("created_at", { ascending: false }).limit(1);
  if (last.error) throw last.error;
  return { pending: states.pending ?? 0, running: states.running ?? 0, stale_running: states.stale_running ?? 0, rendered: states.rendered_private ?? 0, blocked: states.blocked ?? 0,
    claims_last_30min: a.count ?? 0, rate_per_hour: (a.count ?? 0) * 2, last_claim_at: last.data?.[0]?.created_at ?? null };
}

export type ScheduleInput = { publer_account_id: string; platform: "instagram" | "tiktok"; label: string; label_is_username?: boolean; daily_target?: number; start: string; workspace_id?: string };
export function validateSchedule(body: any, now = new Date()): { ok: true; value: Required<ScheduleInput> } | { ok: false; error: string } {
  const id = String(body?.publer_account_id ?? "");
  if (!/^[a-f0-9]{24}$/.test(id)) return { ok: false, error: "invalid_account_id" };
  const platform = body?.platform;
  if (platform !== "instagram" && platform !== "tiktok") return { ok: false, error: "invalid_platform" };
  const label = String(body?.label ?? "").trim();
  if (label.length < 1 || label.length > 128) return { ok: false, error: "invalid_label" };
  const daily = Number(body?.daily_target ?? 8);
  if (!Number.isInteger(daily) || daily < 1 || daily > 8) return { ok: false, error: "invalid_daily_target" };
  const startMs = Date.parse(String(body?.start ?? ""));
  if (!Number.isFinite(startMs) || startMs < now.getTime() + 3600_000 || startMs > now.getTime() + 7 * 86400_000) return { ok: false, error: "start_must_be_1h_to_7d_ahead" };
  const workspace = String(body?.workspace_id ?? process.env.PUBLER_WORKSPACE_ID ?? "6a9d66c38c98536b8f9babf2");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) return { ok: false, error: "invalid_workspace" };
  return { ok: true, value: { publer_account_id: id, platform, label, label_is_username: body?.label_is_username !== false, daily_target: daily, start: new Date(startMs).toISOString(), workspace_id: workspace } };
}

/** Record ownership, plan one variant per library source, arm the publishing policy. Same functions, same gates as the terminal path. */
export async function scheduleAccount(sb: any, actor: string, v: Required<ScheduleInput>, gate: string | null, now = new Date()) {
  const own = await sb.rpc("publer_assign_operator_ownership", { p_actor: actor, p_owner: actor, p_workspace: v.workspace_id, p_observed_at: now.toISOString(),
    p_accounts: [{ id: v.publer_account_id, platform: v.platform, label: v.label, label_is_username: v.label_is_username }] });
  if (own.error) throw new Error(`ownership: ${own.error.message}`);
  const plan = await sb.rpc("library_plan", { p_actor: actor, p_account: v.publer_account_id });
  if (plan.error) throw new Error(`plan: ${plan.error.message}`);
  const arm = await sb.rpc("library_arm_publishing", { p_actor: actor, p_account: v.publer_account_id, p_start: v.start, p_daily: v.daily_target, p_min_ready: 8,
    p_settings: v.platform === "tiktok" ? TIKTOK_SETTINGS : INSTAGRAM_SETTINGS,
    p_approval: `Scheduled from the Clone8 console by operator ${actor} at ${now.toISOString()}; ${v.daily_target}/day from ${v.start}; same library, caption-question-v1`, p_gate: gate });
  if (arm.error) throw new Error(`arm: ${arm.error.message}`);
  return { ownership: own.data ?? 1, planned: plan.data ?? 0, armed: true, start: v.start, daily_target: v.daily_target };
}

/** The launch gate every new account inherits: the first account that published, if any policy still names one. */
async function defaultGate(sb: any): Promise<string | null> {
  const r = await sb.from("library_publishing_policy").select("gate_account").not("gate_account", "is", null).limit(1);
  if (r.error) throw r.error;
  return r.data?.[0]?.gate_account ?? null;
}

export function registerOpsActions(app: Express, sbFn: () => any, deps: { render?: () => RenderApi | null; now?: () => Date } = {}) {
  const getRender = deps.render ?? (() => renderApi());
  const now = deps.now ?? (() => new Date());
  const cooldown = new Map<string, number>();
  const guard = (req: Request, res: Response): boolean => {
    if (!req.auth) { res.status(401).json({ error: "unauthorized" }); return false; }
    if (!isOperator(req)) { res.status(403).json({ error: "operator_required" }); return false; }
    return true;
  };
  const tooSoon = (key: string, ms: number, res: Response): boolean => {
    const last = cooldown.get(key) ?? 0, t = now().getTime();
    if (t - last < ms) { res.status(429).json({ error: "too_soon", retry_in_seconds: Math.ceil((ms - (t - last)) / 1000) }); return true; }
    cooldown.set(key, t); return false;
  };
  const noRender = (res: Response) => res.status(503).json({ error: "render_api_unavailable", detail: "RENDER_API_KEY is not set on the backend service." });

  app.get("/api/ops/actions/renderer", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try { res.set("Cache-Control", "private, no-store").json(await rendererStatus(sbFn(), now())); }
    catch (e: any) { res.status(503).json({ error: "renderer_status_unavailable", detail: String(e?.message ?? e).slice(0, 200) }); }
  });

  app.post("/api/ops/actions/render", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const jobs = Math.min(4, Math.max(1, Number(req.body?.jobs ?? 1) | 0)), maxJobs = Math.min(500, Math.max(10, Number(req.body?.max_jobs ?? 100) | 0));
    const api = getRender(); if (!api) return noRender(res);
    if (tooSoon("render", 120_000, res)) return;
    try {
      const created = [] as { id: string; status: string }[];
      for (let i = 0; i < jobs; i++) created.push(await api.createJob(FEATURES_SERVICE_ID, RENDER_JOB_COMMAND(maxJobs)));
      console.log("[ops/actions] render jobs", JSON.stringify({ by: (req.auth as any)?.user_id, jobs: created.map((j) => j.id), max_jobs: maxJobs }));
      res.json({ jobs: created, max_jobs: maxJobs, renderer: await rendererStatus(sbFn(), now()).catch(() => null) });
    } catch (e: any) { res.status(502).json({ error: "render_api_failed", detail: String(e?.message ?? e).slice(0, 200) }); }
  });

  app.post("/api/ops/actions/run/:job", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const job = RUNNABLE_CRONS[String(req.params.job)];
    if (!job) return res.status(404).json({ error: "unknown_job", runnable: Object.keys(RUNNABLE_CRONS) });
    const api = getRender(); if (!api) return noRender(res);
    if (tooSoon(`run:${req.params.job}`, 60_000, res)) return;
    try {
      const run = await api.runCron(job.id);
      console.log("[ops/actions] run cron", JSON.stringify({ by: (req.auth as any)?.user_id, job: req.params.job, run: run.id }));
      res.json({ job: req.params.job, label: job.label, run });
    } catch (e: any) { res.status(502).json({ error: "render_api_failed", detail: String(e?.message ?? e).slice(0, 200) }); }
  });

  app.post("/api/ops/actions/schedule-account", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const v = validateSchedule(req.body, now());
    if (v.ok === false) return res.status(400).json({ error: v.error });
    const actor = (req.auth as any).user_id as string;
    try {
      const sb = sbFn();
      const result = await scheduleAccount(sb, actor, v.value, await defaultGate(sb), now());
      console.log("[ops/actions] schedule account", JSON.stringify({ by: actor, account: v.value.publer_account_id, ...result }));
      res.json(result);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /account_not_owned|account_not_eligible|ownership_conflict|policy_conflict|invalid_/.test(msg) ? 409 : 503;
      res.status(status).json({ error: "schedule_failed", detail: msg.slice(0, 240) });
    }
  });
}
