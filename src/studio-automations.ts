// Clone8 Studio: automations. A plan the person confirmed and liked, kept as a recipe: every step and setting stays,
// the source video(s) become open inputs. Running it drops new files into those inputs, prices the steps with the same
// quotes as the chat, and starts a run inside a new conversation, so progress and results read exactly like any chat.
// Pictures (a made character, a reference) stay fixed on purpose: "my cat, on whatever I upload next" is the point.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { StudioError, toolsEnabled } from "./studio.js";
import { InstrumentError } from "./studio-instruments.js";
import { AssistantError, advanceRun, buildCtx, hydrateJobs, pricePlan, publicConversation, startRun, type AssistantDeps, type Conversation, type Plan } from "./studio-assistant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT_RE = /^\{(video_\d+)\}$/;
export type AutomationInput = { key: string; kind: "video"; label: string; from_name?: string | null };
export type AutomationStep = { index: number; tool: string; label: string; source: string | null; options: Record<string, any> };
export type Automation = { id: string; user_id: string; name: string; description: string | null; steps: AutomationStep[]; inputs: AutomationInput[]; source_conversation: string | null; runs: number; last_run_at: string | null; created_at: string; updated_at: string };

/** The recipe from a plan: concrete video sources become {video_N} slots (the same file, the same slot); pictures stay. */
export function templateFromPlan(plan: Plan, assetNames: Map<string, string> = new Map()): { steps: AutomationStep[]; inputs: AutomationInput[] } {
  const slots = new Map<string, string>();
  const inputs: AutomationInput[] = [];
  const slot = (assetId: string) => {
    const k = assetId.toLowerCase();
    if (!slots.has(k)) { const key = `video_${slots.size + 1}`; slots.set(k, key); inputs.push({ key, kind: "video", label: inputs.length === 0 ? "The video" : `Video ${inputs.length + 1}`, from_name: assetNames.get(k) ?? null }); }
    return `{${slots.get(k)}}`;
  };
  const steps = plan.steps.map((s) => {
    const o: Record<string, any> = { ...s.options };
    // what the quote filled in is recomputed at run time from the new file
    delete o.seconds; delete o.usd; delete o.units; delete o.priced_by;
    let source = s.source;
    if (source && UUID_RE.test(source)) source = slot(source);
    if (s.tool === "instrument" && o.inputs) {
      const inst = s.options.inputs as Record<string, any>;
      const videoFields = new Set(Object.entries(inst).filter(([, v]) => ([] as any[]).concat(v).every((x) => UUID_RE.test(String(x)))).map(([k]) => k));
      // only video media fields become slots; the catalog says which fields are video, and the plan kept the kind in expectedOutput, so use the heuristic: fields named video*
      o.inputs = Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, /video/i.test(k) && videoFields.has(k) ? (Array.isArray(v) ? v.map((x: string) => slot(x)) : slot(v)) : v]));
    }
    return { index: s.index, tool: s.tool, label: s.label, source, options: o };
  });
  return { steps, inputs };
}

/** The recipe with files dropped in: the raw plan pricePlan validates and prices. */
export function instantiate(steps: AutomationStep[], inputs: AutomationInput[], given: Record<string, string>): { title?: string; steps: any[] } {
  const fill = (v: unknown): any => {
    const m = String(v ?? "").match(SLOT_RE);
    if (!m) return v;
    const id = given[m[1]];
    if (!id) throw new AssistantError("input_missing", `Add a video for "${inputs.find((i) => i.key === m[1])?.label ?? m[1]}"`);
    return id;
  };
  return { steps: steps.map((s) => ({ tool: s.tool, label: s.label, source: s.source ? fill(s.source) : s.source, options: { ...s.options, ...(s.tool === "instrument" && s.options.inputs ? { inputs: Object.fromEntries(Object.entries(s.options.inputs as Record<string, any>).map(([k, v]) => [k, Array.isArray(v) ? v.map(fill) : fill(v)])) } : {}) } })) };
}

export async function createAutomation(sb: SupabaseClient, u: string, p: { name: string; plan: Plan; conversation_id?: string | null; description?: string | null }): Promise<Automation> {
  const name = String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || p.plan.title.slice(0, 80) || "Automation";
  const ids = p.plan.steps.flatMap((s) => [s.source, s.options?.character_asset_id, ...Object.values(s.options?.inputs ?? {}).flat()]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
  const names = new Map<string, string>();
  if (ids.length) { const r = await sb.from("studio_assets").select("id,name").eq("user_id", u).in("id", ids); for (const a of (r.data ?? []) as any[]) names.set(String(a.id).toLowerCase(), a.name); }
  const t = templateFromPlan(p.plan, names);
  if (!t.inputs.length) throw new AssistantError("automation_no_input", "This plan has no video to swap out, so there is nothing to run it on again");
  const r = await sb.from("studio_automations").insert({ user_id: u, name, description: p.description ?? null, steps: t.steps, inputs: t.inputs, source_conversation: p.conversation_id ?? null }).select("*").single();
  if (r.error) throw r.error;
  return r.data as Automation;
}

/** Runs the recipe on the given files: a new conversation, the plan confirmed, the first step started. */
export async function runAutomation(sb: SupabaseClient, deps: AssistantDeps, a: Automation, given: Record<string, string>): Promise<Conversation> {
  const ctx = await buildCtx(sb, deps, a.user_id);
  for (const i of a.inputs) {
    const id = given[i.key];
    if (!id) throw new AssistantError("input_missing", `Add a video for "${i.label}"`);
    const asset = ctx.assets.get(id.toLowerCase());
    if (!asset || asset.kind !== "video") throw new AssistantError("input_invalid", `"${i.label}" needs a ready video from your library`);
  }
  const raw = instantiate(a.steps, a.inputs, given);
  const plan = await pricePlan(ctx, { title: a.name, steps: raw.steps });
  const first = ctx.assets.get(String(given[a.inputs[0].key]).toLowerCase());
  const now = new Date().toISOString();
  const title = `${a.name} · ${String(first?.name ?? "video").replace(/\.[a-z0-9]{2,4}$/i, "")}`.slice(0, 120);
  const c: Conversation = {
    id: randomUUID(), user_id: a.user_id, title, status: "open", plan, run: null, automation_id: a.id, created_at: now, updated_at: now,
    messages: [
      { id: randomUUID(), role: "user", text: `Run "${a.name}" on ${first?.name ?? "this video"}.`, attachments: a.inputs.map((i) => { const x = ctx.assets.get(String(given[i.key]).toLowerCase()); return { asset_id: x.id, name: x.name, kind: "video", seconds: Number(x.probe?.duration) > 0 ? Number(x.probe.duration) : null }; }), at: now },
      { id: randomUUID(), role: "assistant", text: `Running "${a.name}": ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}, ${plan.estimate ? "about " : ""}${plan.total_credits} credits.`, plan_id: plan.id, at: now },
    ],
  };
  startRun(c);
  const ins = await sb.from("studio_conversations").insert({ id: c.id, user_id: c.user_id, title: c.title, status: c.status, messages: c.messages, plan: c.plan, run: c.run, automation_id: a.id, created_at: now, updated_at: now });
  if (ins.error) throw ins.error;
  const out = await advanceRun(sb, deps, c);
  const bump = await sb.from("studio_automations").update({ runs: (a.runs ?? 0) + 1, last_run_at: now, updated_at: now }).eq("id", a.id).eq("user_id", a.user_id);
  if (bump.error) throw bump.error;
  return out;
}

export function registerAutomations(app: Express, sbFn: () => SupabaseClient, deps: AssistantDeps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof AssistantError || e instanceof StudioError || e instanceof InstrumentError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "automations_unavailable", detail: "The automations migration has not been applied" });
    console.error("[automations]", msg);
    res.status(500).json({ error: "automations_failed", detail: msg.slice(0, 200) });
  };
  const load = async (sb: SupabaseClient, u: string, id: string): Promise<Automation> => {
    if (!UUID_RE.test(id)) throw new AssistantError("automation_not_found", "No such automation", 404);
    const r = await sb.from("studio_automations").select("*").eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new AssistantError("automation_not_found", "No such automation", 404);
    return r.data as Automation;
  };
  const pub = (a: Automation) => ({ id: a.id, name: a.name, description: a.description, steps: a.steps, inputs: a.inputs, runs: a.runs, last_run_at: a.last_run_at, created_at: a.created_at, updated_at: a.updated_at });
  const given = (body: any, a: Automation): Record<string, string> => { const out: Record<string, string> = {}; for (const i of a.inputs) { const v = String(body?.inputs?.[i.key] ?? ""); if (UUID_RE.test(v)) out[i.key] = v; } return out; };

  app.get("/api/studio/automations", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_automations").select("*").eq("user_id", u).order("updated_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      res.json({ automations: ((r.data ?? []) as Automation[]).map(pub), enabled: !!toolsEnabled(env).assistant });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const cid = String(req.body?.conversation_id ?? "");
      if (!UUID_RE.test(cid)) throw new AssistantError("conversation_not_found", "Which chat?", 404);
      const c = await sb.from("studio_conversations").select("id,plan,title").eq("id", cid).eq("user_id", u).maybeSingle();
      if (c.error) throw c.error;
      if (!c.data?.plan || c.data.plan.status !== "confirmed") throw new AssistantError("no_confirmed_plan", "Only a plan that was confirmed can be saved");
      const a = await createAutomation(sb, u, { name: String(req.body?.name ?? c.data.title), plan: c.data.plan, conversation_id: cid, description: req.body?.description ? String(req.body.description).slice(0, 400) : null });
      log(`[automations] saved ${a.id} for ${u}`);
      res.status(201).json({ automation: pub(a) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/studio/automations/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const runs = await sb.from("studio_conversations").select("id,title,status,run,created_at,updated_at").eq("user_id", u).eq("automation_id", a.id).order("created_at", { ascending: false }).limit(20);
      if (runs.error) throw runs.error;
      res.json({ automation: pub(a), runs: (runs.data ?? []).map((c: any) => ({ id: c.id, title: c.title, status: c.status, run_status: c.run?.status ?? null, steps_done: (c.run?.steps ?? []).filter((s: any) => s.status === "done").length, steps: (c.run?.steps ?? []).length, created_at: c.created_at, updated_at: c.updated_at })) });
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/automations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (req.body?.name !== undefined) { const name = String(req.body.name).replace(/\s+/g, " ").trim().slice(0, 80); if (!name) throw new AssistantError("name_empty", "Give it a name"); patch.name = name; }
      if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description).slice(0, 400) : null;
      // settings a person may change without rebuilding the recipe: copies, model, prompt
      if (req.body?.steps && Array.isArray(req.body.steps)) {
        const next = a.steps.map((s) => { const edit = req.body.steps.find((x: any) => x?.index === s.index); if (!edit?.options || typeof edit.options !== "object") return s; const allowed = ["copies", "model", "prompt", "params"]; const o = { ...s.options }; for (const k of allowed) if (edit.options[k] !== undefined) o[k] = edit.options[k]; return { ...s, options: o, label: typeof edit.label === "string" && edit.label.trim() ? String(edit.label).slice(0, 120) : s.label }; });
        patch.steps = next;
      }
      const w = await sb.from("studio_automations").update(patch).eq("id", a.id).eq("user_id", u).select("*").single();
      if (w.error) throw w.error;
      res.json({ automation: pub(w.data as Automation) });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/automations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const d = await sb.from("studio_automations").delete().eq("id", a.id).eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: a.id });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations/:id/quote", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const ctx = await buildCtx(sb, { ...deps, env }, u);
      const plan = await pricePlan(ctx, { title: a.name, steps: instantiate(a.steps, a.inputs, given(req.body, a)).steps });
      res.json({ credits: plan.total_credits, estimate: plan.estimate, steps: plan.steps.map((s) => ({ index: s.index, label: s.label, credits: s.credits, estimate: s.estimate })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations/:id/run", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const out = await runAutomation(sb, { ...deps, env, log }, a, given(req.body, a));
      log(`[automations] run ${a.id} conversation ${out.id}`);
      const ids = (out.run?.steps ?? []).map((s) => s.job_id).filter(Boolean) as string[];
      res.status(201).json({ conversation: publicConversation(out, await hydrateJobs(sb, u, ids)) });
    } catch (e) { fail(res, e); }
  });
}
