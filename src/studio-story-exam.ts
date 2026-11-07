// The Stories practice exam (docs/stories/STORY_MASTER_PLAN.md, phase 0): the same eight topics made after every change
// to the story engine, so a change is kept only when the numbers go up. Admin only (the Studio admin, support@clone8.io).
//   POST /api/studio/admin/story-exam            start a run for the admin's own account: the first film is queued with
//                                                 options.exam = { run, index: 0, topics }; the Kage Motion worker queues
//                                                 each next film when one ends (kage-motion/worker/exam.ts), one at a time
//   GET  /api/studio/admin/story-exam            the runs, newest first
//   GET  /api/studio/admin/story-exam?run=<id>   one run: a row per film with the watcher's score, the animatic's, the
//                                                 scoreboard numbers, the joke devices, the cost and the worker commit
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { quoteStory } from "./studio-stories.js";
import type { PlanLike } from "./studio-pricing.js";

type Env = Record<string, string | undefined>;

/** The fixed topics (titles kept word for word so runs compare). */
export const EXAM_TOPICS = [
  "Building a bridge across a river with one plank",
  "Folding a piece of paper 42 times",
  "Surviving a night in the jungle",
  "Digging a hole straight down for a year",
  "Building a go-kart out of a lawnmower",
  "Never cleaning your gutters for 20 years",
  "Drinking 12 cups of coffee every day for a year",
  "Building a skyscraper one floor a day until it reaches space",
] as const;

export const examRunId = (now = new Date()) => `exam-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2")}`;

/** A film of a run, as the report reads it. */
export function examRow(j: any) {
  const o = Array.isArray(j.outputs) ? j.outputs[0] ?? {} : {};
  const judge = o.judge ?? {}; const watch = judge.watch ?? {}; const an = judge.animatic ?? {};
  return {
    index: Number(j.options?.exam?.index ?? 0) + 1, topic: String(j.options?.story?.topic ?? ""), job: j.id, status: j.status,
    title: o.title ?? null, world: o.world ?? null, seconds: o.duration ?? null,
    watch: Number.isFinite(watch.score) ? watch.score : null, first_watch: judge.first_watch ?? null, remade: !!judge.remade,
    animatic_first: an.first?.score ?? null, animatic_final: an.final?.score ?? null, animatic_revised: !!an.revised,
    animatic_no: an.final?.no?.length ?? null, watch_no: Array.isArray(watch.beats) ? watch.beats.filter((b: any) => b.shown === "no").length : null,
    judge_overall: judge.scores?.overall ?? null, metrics: o.metrics ?? null, ending_device: o.devices?.ending ?? null, devices: o.devices?.counts ?? null,
    render_cost_usd: o.render_cost_usd ?? null, minutes: o.minutes ?? null, worker_commit: o.worker_commit ?? null,
    created_at: j.created_at, finished_at: j.finished_at ?? null,
  };
}

export function registerStoryExam(app: Express, sbFn: () => SupabaseClient, deps: { env?: Env; plans: PlanLike[] }) {
  const env = deps.env ?? process.env;
  app.post("/api/studio/admin/story-exam", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const user = (req.auth as any).user_id as string;
      // one run at a time (a second would double the queue in front of customers' stories)
      const going = await sb.from("studio_jobs").select("id, options").eq("tool", "kage_motion").in("status", ["queued", "running"]).not("options->exam", "is", null).limit(1);
      if (going.error) throw going.error;
      if (going.data?.length && req.body?.force !== true) return res.status(409).json({ error: "exam_running", run: going.data[0].options?.exam?.run ?? null });
      const topics = Array.isArray(req.body?.topics) && req.body.topics.length ? req.body.topics.map((t: unknown) => String(t).slice(0, 200)).slice(0, 12) : [...EXAM_TOPICS];
      const q = quoteStory(env, deps.plans, { topic: topics[0], seconds: Number(req.body?.seconds) || 65 });
      const run = examRunId();
      const options = { ...q.options, via: "admin", exam: { run, index: 0, topics } };
      const r = await sb.rpc("studio_create_job", { p_user: user, p_tool: "kage_motion", p_asset: null, p_options: options, p_credits: q.credits });
      if (r.error) throw r.error;
      console.log(`[exam] ${run} started: ${topics.length} films, ${q.credits} credits each`);
      res.json({ run, topics, credits_per_film: q.credits, job: (r.data as any)?.id ?? r.data });
    } catch (e: any) {
      console.log(`[exam] ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(e?.code === "story_off" ? 403 : 500).json({ error: e?.code ?? "exam_failed" });
    }
  });
  app.get("/api/studio/admin/story-exam", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const run = typeof req.query.run === "string" ? req.query.run.slice(0, 40) : null;
      let q = sb.from("studio_jobs").select("id, status, options, outputs, created_at, finished_at").eq("tool", "kage_motion").not("options->exam", "is", null).order("created_at", { ascending: true }).limit(400);
      if (run) q = q.contains("options", { exam: { run } });
      const r = await q; if (r.error) throw r.error;
      const rows = (r.data ?? []).map(examRow);
      if (run) return res.json({ run, films: rows });
      const runs = new Map<string, { run: string; films: number; done: number; started: string }>();
      for (const j of r.data ?? []) { const id = String((j as any).options?.exam?.run ?? ""); const x = runs.get(id) ?? { run: id, films: 0, done: 0, started: (j as any).created_at }; x.films++; if ((j as any).status === "done") x.done++; runs.set(id, x); }
      res.json({ runs: [...runs.values()].reverse() });
    } catch (e: any) {
      console.log(`[exam] ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "exam_failed" });
    }
  });
}
