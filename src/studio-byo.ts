// Signature written by the person's own AI (docs/mcp/PLAN.md, step 3): the routes the connector's scene tools call.
// The film is a normal Signature job (options.story.byo); the worker (kage-motion worker/hand-byo.ts) makes it and,
// where our model would write the scene, takes each step from the person's chat instead. The two meet on one table,
// studio_byo_calls (service role only): the worker posts the brief and each round's opening ("brief", "message" rows);
// these routes post the chat's tool calls ("call" rows, one at a time) and hand back the worker's answers, pictures
// included (downloaded from the job's work folder and passed on as JPEG data).
//
// Every route: the signed-in person's own job, a Signature job asked to be written in their chat, and nothing else.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export const BYO_TOOLS = ["write_scene", "edit_scene", "typecheck", "render_stills", "render_preview", "finish"] as const;
/** The brief is long (the kit is its manual): it is read in parts small enough for a chat app's tool results. */
export const BRIEF_PART_CHARS = 60_000;
const MAX_INPUT_CHARS = 400_000;
const LOST_AFTER_MS = 10 * 60_000; // a call taken this long ago and never answered: the worker that took it is gone

type Row = { id: number; kind: string; tool: string; status: string; result: any; created_at: string; started_at: string | null; done_at: string | null; delivered_at: string | null };
export type ByoAnswer = { text: string; image?: string | null; images?: string[] };

/** The brief in parts, cut at line ends so no part splits a line of code. */
export function briefParts(text: string, size = BRIEF_PART_CHARS): string[] {
  const out: string[] = []; let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > at + size / 2) end = nl + 1; }
    out.push(text.slice(at, end)); at = end;
  }
  return out.length ? out : [""];
}

export function registerByo(app: Express, sbFn: () => SupabaseClient, o: { pollMs?: number } = {}) {
  const pollMs = o.pollMs ?? 1500; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = (req: Request) => Math.max(0, Math.min(45, Number(req.query.wait ?? 40) || 0)) * 1000;

  /** The person's own job, written in their chat; else the answer has been sent. */
  const jobOf = async (req: Request, res: Response): Promise<{ sb: SupabaseClient; job: any } | null> => {
    const u = (req.auth as any)?.user_id; if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    const id = String(req.params.id ?? ""); if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "bad_job", detail: "job_id is the id the start tool gave" }); return null; }
    const sb = sbFn(); const q = await sb.from("studio_jobs").select("id,user_id,status,tool,options,progress,error_code").eq("id", id).maybeSingle();
    if (q.error) { res.status(500).json({ error: "db" }); return null; }
    const job = q.data as any;
    if (!job || job.user_id !== u || job.options?.story?.byo !== true) { res.status(404).json({ error: "not_found", detail: "No film of yours with that job_id is being written in a chat" }); return null; }
    return { sb, job };
  };
  /** A row's answer as the chat gets it: its text and its pictures as base64 JPEG. */
  const answer = async (sb: SupabaseClient, r: ByoAnswer): Promise<{ text: string; images: string[] }> => {
    const keys = [...(r.image ? [r.image] : []), ...(Array.isArray(r.images) ? r.images : [])]; const images: string[] = [];
    for (const k of keys) { const d = await sb.storage.from("studio-outputs").download(k); if (!d.error && d.data) images.push(Buffer.from(await d.data.arrayBuffer()).toString("base64")); }
    return { text: String(r.text ?? ""), images };
  };
  const deliver = (sb: SupabaseClient, id: number) => sb.from("studio_byo_calls").update({ delivered_at: new Date().toISOString() }).eq("id", id);
  const state = (job: any) => ({ status: job.status, note: job.progress?.note ?? null, error: job.error_code ?? null });

  // the brief, part by part (posted by the worker once the script and the voice are ready)
  app.get("/api/studio/byo/:id/brief", async (req, res) => {
    const j = await jobOf(req, res); if (!j) return;
    const q = await j.sb.from("studio_byo_calls").select("result").eq("job_id", j.job.id).eq("kind", "brief").order("id", { ascending: false }).limit(1);
    const text = String((q.data ?? [])[0]?.result?.text ?? "");
    if (!text) return res.json({ ready: false, ...state(j.job) });
    const parts = briefParts(text); const part = Math.max(1, Math.min(parts.length, Math.floor(Number(req.query.part ?? 1)) || 1));
    res.json({ ready: true, part, parts: parts.length, text: parts[part - 1] });
  });

  // a tool call from the chat: queued, then answered within the wait if the worker is quick enough
  app.post("/api/studio/byo/:id/calls", async (req, res) => {
    const j = await jobOf(req, res); if (!j) return;
    const tool = String(req.body?.tool ?? ""); const input = req.body?.input && typeof req.body.input === "object" ? req.body.input : {};
    if (!(BYO_TOOLS as readonly string[]).includes(tool)) return res.status(400).json({ error: "bad_tool" });
    if (JSON.stringify(input).length > MAX_INPUT_CHARS) return res.status(413).json({ error: "too_long", detail: "That is too long for one call: write the scene once, then change it with edit_scene" });
    if (j.job.status !== "running" && j.job.status !== "queued") return res.status(409).json({ error: "not_running", detail: j.job.status === "done" ? "This film is finished." : `This film is no longer being made (${j.job.status}${j.job.error_code ? `: ${j.job.error_code}` : ""}).`, ...state(j.job) });
    // one call at a time: the worker runs them in order, and a chat that sends two at once would race its own edits
    const busy = await j.sb.from("studio_byo_calls").select("id,started_at,status").eq("job_id", j.job.id).eq("kind", "call").in("status", ["pending", "running"]).limit(1);
    const b = (busy.data ?? [])[0] as Row | undefined;
    if (b && !(b.status === "running" && b.started_at && Date.now() - Date.parse(b.started_at) > LOST_AFTER_MS)) return res.status(409).json({ error: "busy", detail: "The previous call is still being worked on: call clone8_scene_wait to get its answer first." });
    const ins = await j.sb.from("studio_byo_calls").insert({ job_id: j.job.id, user_id: j.job.user_id, kind: "call", tool, input, status: "pending" }).select("id").single();
    if (ins.error || !ins.data) return res.status(500).json({ error: "db" });
    const id = (ins.data as any).id as number; const until = Date.now() + waitFor(req);
    for (;;) {
      const r = await j.sb.from("studio_byo_calls").select("id,status,result").eq("id", id).maybeSingle();
      const row = r.data as Row | null;
      if (row?.status === "done") { await deliver(j.sb, id); return res.json({ done: true, call_id: id, ...(await answer(j.sb, row.result ?? {})) }); }
      if (Date.now() >= until) return res.json({ done: false, call_id: id, text: row?.status === "running" ? "Clone8 is working on it (renders take a minute or two). Call clone8_scene_wait with this job_id for the answer." : "Queued: Clone8 picks it up in a moment. Call clone8_scene_wait with this job_id for the answer.", ...state(j.job) });
      await sleep(pollMs);
    }
  });

  // what is waiting for the chat: an answer it has not had yet, else the next round's opening (the script; the lines to
  // repair), else, after waiting, where the film is (being checked, rendering, done)
  app.get("/api/studio/byo/:id/wait", async (req, res) => {
    const j = await jobOf(req, res); if (!j) return;
    const until = Date.now() + waitFor(req);
    for (;;) {
      const q = await j.sb.from("studio_byo_calls").select("id,kind,tool,status,result,started_at").eq("job_id", j.job.id).is("delivered_at", null).in("kind", ["call", "message"]).order("id", { ascending: true }).limit(20);
      const rows = (q.data ?? []) as Row[];
      const ready = rows.find((r) => r.status === "done");
      if (ready) { await deliver(j.sb, ready.id); return res.json({ kind: ready.kind, tool: ready.kind === "call" ? ready.tool : null, call_id: ready.kind === "call" ? ready.id : null, ...(await answer(j.sb, ready.result ?? {})) }); }
      const lost = rows.find((r) => r.kind === "call" && r.status === "running" && r.started_at && Date.now() - Date.parse(r.started_at) > LOST_AFTER_MS);
      if (lost) { await deliver(j.sb, lost.id); return res.json({ kind: "call", tool: lost.tool, call_id: lost.id, text: "That call was lost on Clone8's side (its worker restarted). Call the same tool again.", images: [] }); }
      const now = await j.sb.from("studio_jobs").select("status,progress,error_code").eq("id", j.job.id).maybeSingle(); const job = { ...j.job, ...(now.data ?? {}) };
      if (job.status === "done" || job.status === "failed" || job.status === "canceled") return res.json({ kind: "state", ...state(job), text: job.status === "done" ? "The film is finished." : `The film ${job.status === "failed" ? "failed" : "was canceled"}${job.error_code ? ` (${job.error_code})` : ""}; the credits it held were returned.`, images: [] });
      const waiting = rows.some((r) => r.kind === "call");
      if (Date.now() >= until) return res.json({ kind: "state", ...state(job), text: waiting ? "Still working on your last call. Call clone8_scene_wait again." : `Nothing new yet: ${job.progress?.note ?? "the film is being made"}. Call clone8_scene_wait again in a minute.`, images: [] });
      await sleep(pollMs);
    }
  });
}
