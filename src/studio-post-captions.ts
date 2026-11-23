// Captions for many videos at once, and Smart post (owner, Nov 23 2026; plan docs/publishing/CAPTIONS_AND_SMART_POST_PLAN.md).
//
// Watching a video (frames + speech, read by Opus) costs us about $0.027, so it is paid: STUDIO_CAPTION_WATCH_COST_USD
// at the house margin on the cheapest credit (4 credits). It happens once per video: what was seen is kept
// (studio_video_notes) and every later caption, variant or per-account version is written from that note, free.
//
// A batch is a job of its own tool, "post_captions" (its own lane in studio_create_job, so writing captions never waits
// on a film): the credits for the videos not yet watched are held when it is made, the server's loop writes the videos
// a few at a time (each result saved in the job's progress as it lands, so the page fills in), and only the videos
// actually watched are charged; the rest of the hold comes back. The job is hidden from the library and sends no
// "ready" email or push (it is a step of posting, not something made).
//
// Smart post: once the videos are watched, /smart/brief reads the notes (Sonnet, text only, free) and gives what they
// are, three sample captions and two call-to-action lines; /smart/answer turns what the person typed into settings
// the Post page fills in. Nothing posts from here: the person sees every setting and confirms on the Post page.
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditsForCost, creditValueFloor, logClaudeCost, type PlanLike } from "./studio-pricing.js";
import { allowCaption, draftCaption, notedKeys, readNote, resolveVideo, videoKey, type CaptionDeps, type CaptionDraft, type VideoNote, type VideoRef } from "./studio-captions.js";
import { SocialError, isSocialPlatform } from "./social-provider.js";
import { claimJob } from "./studio-leases.js";
import { studioFail } from "./studio-fail.js";

export const POST_CAPTIONS_TOOL = "post_captions";
export const MAX_BATCH = 60;
/** What watching one video costs us: Opus 5.5 over 5 frames + the prompt (~$0.022, 9 live calls, Nov 2026) and the
 *  speech-to-text (~$0.005). */
export const watchCostUsd = (env: Record<string, string | undefined> = process.env) => { const v = Number(env.STUDIO_CAPTION_WATCH_COST_USD); return Number.isFinite(v) && v > 0 ? v : 0.027; };
export const watchCredits = (env: Record<string, string | undefined>, plans: PlanLike[]) => creditsForCost(watchCostUsd(env), creditValueFloor(plans));
const plansOf = async (): Promise<PlanLike[]> => (await import("./studio.js")).PLANS as PlanLike[];

type Job = { id: string; user_id: string; tool: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };
export type BatchResult = { ok: true; draft: CaptionDraft } | { ok: false; code: string; error: string };
export type PostCaptionsDeps = CaptionDeps & { caption?: typeof draftCaption; plans?: PlanLike[]; brief?: (body: any) => Promise<any>; retryMs?: number };

const UUID = /^[0-9a-f-]{36}$/i;
/** A video as sent by the page: an upload or a job output (anything else is dropped). */
export function cleanRef(x: any): VideoRef | null {
  if (x && UUID.test(String(x.asset_id ?? ""))) return { asset_id: String(x.asset_id) };
  if (x && UUID.test(String(x.job_id ?? "")) && typeof x.output_key === "string" && x.output_key.length < 300) return { job_id: String(x.job_id), output_key: x.output_key };
  return null;
}
const cleanAccounts = (raw: any) => (Array.isArray(raw) ? raw : []).map((a: any) => ({ id: String(a?.id ?? "").slice(0, 80), platform: String(a?.platform ?? ""), handle: a?.handle ? String(a.handle).slice(0, 60) : null })).filter((a) => a.id && isSocialPlatform(a.platform)).slice(0, 12);
/** What a batch is asked to do, kept on the job. */
export function batchOptions(b: any) {
  const videos = (Array.isArray(b?.videos) ? b.videos : []).map(cleanRef).filter(Boolean) as VideoRef[];
  const seen = new Set<string>(); const uniq = videos.filter((v) => { const k = videoKey(v); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) throw new SocialError("no_videos", "Pick the videos to write captions for", 400);
  if (uniq.length > MAX_BATCH) throw new SocialError("too_many_videos", `Up to ${MAX_BATCH} videos at a time`, 400);
  const platforms = (Array.isArray(b?.platforms) ? b.platforms : []).map(String).filter(isSocialPlatform);
  const line = String(b?.line ?? "").trim().slice(0, 300) || null;
  const useVideo = b?.use_video !== false;
  if (!useVideo && !line) throw new SocialError("line_needed", "Give the line to work in", 400);
  return { videos: uniq, platforms, accounts: cleanAccounts(b?.accounts), line, keep_words: b?.keep_words === true, use_video: useVideo, note: b?.note ? String(b.note).slice(0, 300) : null, rewatch: b?.rewatch === true };
}

/** Run one batch: a few videos at a time, each told how the finished ones open (so no two posts read alike). Results
 *  land in progress as they come; a job taken over after a restart skips the videos already written. */
export async function runPostCaptions(sb: SupabaseClient, job: Job, deps: PostCaptionsDeps = {}, at = 3): Promise<string> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const o = job.options ?? {};
  const videos = (o.videos ?? []) as VideoRef[];
  const results: Record<string, BatchResult> = { ...(job.progress?.results ?? {}) };
  let watched = Number(job.progress?.watched) || 0;
  const write = deps.caption ?? draftCaption;
  const save = async () => {
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { stage: "writing", done: Object.keys(results).length, of: videos.length, watched, results } });
    if (r.error || r.data !== true) throw new SocialError("lease_lost", "lease lost", 409);
  };
  try {
    const todo = videos.filter((v) => !results[videoKey(v)]);
    for (let i = 0; i < todo.length; i += at) {
      const wave = todo.slice(i, i + at);
      const avoid = Object.values(results).filter((r): r is { ok: true; draft: CaptionDraft } => r.ok).map((r) => r.draft.caption).slice(-8);
      await Promise.all(wave.map(async (v) => {
        try {
          const ask = { ...v, platforms: o.platforms ?? [], line: o.line, keep_words: !!o.keep_words, use_video: o.use_video !== false, note: o.note, accounts: o.accounts ?? [], avoid, watch: (o.rewatch ? "always" : "auto") as "always" | "auto" };
          // the writer not answering (a long video read past its time limit, an overloaded model) is tried once more
          const d = await write(sb, job.user_id, ask, { ...deps, log }).catch(async (e: any) => {
            if (!(e instanceof SocialError) || !["captions_unavailable"].includes(e.code)) throw e;
            await new Promise((r) => setTimeout(r, deps.retryMs ?? 3000));
            return write(sb, job.user_id, ask, { ...deps, log });
          });
          if (d.watched) watched++;
          results[videoKey(v)] = { ok: true, draft: d };
        } catch (e: any) {
          results[videoKey(v)] = { ok: false, code: e instanceof SocialError ? e.code : "caption_failed", error: e instanceof SocialError ? e.message : "This one could not be written; try it again" };
          if (!(e instanceof SocialError)) log(`[post-captions] ${job.id} ${videoKey(v)}: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      }));
      await save();
    }
    const per = Number(o.per_watch) || 0;
    const charged = Math.min(job.credits_reserved, watched * per);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: [], p_credits_charged: charged });
    if (done.error) throw done.error;
    return `done ${Object.values(results).filter((r) => r.ok).length}/${videos.length}, watched ${watched}, charged ${charged}`;
  } catch (e: any) {
    if (e instanceof SocialError && e.code === "lease_lost") return "lease_lost";
    log(`[post-captions] ${job.id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    // (studio_fail refunds the whole hold; a retry would only re-run what is not written yet)
    await studioFail(sb, { p_job: job.id, p_token: job.lease_token, p_reason: "caption_failed", p_retry: (job.attempts ?? 1) < 3, p_detail: String(e?.message ?? e).slice(0, 300) }).catch(() => undefined);
    return "failed";
  }
}

/** The server's loop for batches: up to two at once (each writes three videos at a time, so at most six videos are
 *  downloaded and read together). Off with STUDIO_POST_CAPTIONS=off. */
export function startPostCaptionsLoop(sbFn: () => SupabaseClient, deps: PostCaptionsDeps = {}, intervalMs = 3_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (env.STUDIO_POST_CAPTIONS === "off" || !env.ANTHROPIC_API_KEY) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `post-captions-${randomUUID()}`;
  const active = new Set<string>();
  let claiming = false;
  const tick = async () => {
    if (claiming || active.size >= 2) return;
    claiming = true;
    try {
      const sb = sbFn();
      const r = await claimJob(sb, POST_CAPTIONS_TOOL, worker);
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job?.id) return;
      active.add(job.id);
      runPostCaptions(sb, job, { ...deps, log }).then((s) => log(`[post-captions] ${s} ${job.id}`)).catch((e) => log(`[post-captions] crashed ${job.id} ${e?.message ?? e}`)).finally(() => active.delete(job.id));
    } catch (e: any) {
      if (!/does not exist|violates check constraint/i.test(String(e?.message ?? e))) log(`[post-captions] claim failed ${String(e?.message ?? e).slice(0, 200)}`);
    } finally { claiming = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 15_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Smart post: what the videos are, sample captions and lines; then what the person typed, as settings
// ---------------------------------------------------------------------------------------------------
const BRIEF_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "kinds", "samples", "lines"],
  properties: {
    summary: { type: "string", description: "One short sentence on the whole batch, plain words (e.g. '21 videos: gameplay moments and podcast clips, mostly funny')" },
    kinds: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "count"], properties: { label: { type: "string" }, count: { type: "integer" } } }, description: "2 to 4 groups of what the videos are, with how many of each" },
    samples: { type: "array", items: { type: "object", additionalProperties: false, required: ["style", "caption"], properties: { style: { type: "string", description: "A two-word name for the style, e.g. 'Straight hook', 'Inside joke', 'Story'" }, caption: { type: "string" } } }, description: "Three captions for the FIRST video, each in a clearly different style, ready to post on the first network" },
    lines: { type: "array", items: { type: "string" }, description: "Two short call-to-action lines the creator could add to every post (one asking to comment a single word for a link, one asking to follow), in the creator's voice" },
  },
};
const ANSWER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["caption", "networks", "schedule", "autoreply", "trial", "unclear"],
  properties: {
    networks: { type: "object", additionalProperties: false, required: ["mode", "how"], properties: {
      mode: { type: "string", enum: ["fit", "same", "custom", "unchanged"], description: "fit: each network its own version written for it; same: the same caption everywhere; custom: they said how each network should differ; unchanged: not said" },
      how: { anyOf: [{ type: "string" }, { type: "null" }], description: "For custom: how each network's caption should differ, in their words (e.g. 'TikTok short, no hashtags; Instagram longer with the link line')" } } },
    caption: { type: "object", additionalProperties: false, required: ["mode", "line", "keep_words", "style"], properties: {
      mode: { type: "string", enum: ["video", "line", "line_video", "own", "unchanged"], description: "video: write each from its video; line: variants of their line only; line_video: their line worked into captions about each video; own: they write; unchanged: they did not say" },
      line: { anyOf: [{ type: "string" }, { type: "null" }] }, keep_words: { type: "boolean" },
      style: { anyOf: [{ type: "string" }, { type: "null" }], description: "How the captions should sound, in a few words, if they said (e.g. 'casual, lowercase, no hashtags')" } } },
    schedule: { type: "object", additionalProperties: false, required: ["per_day", "days", "start", "times", "now"], properties: {
      per_day: { anyOf: [{ type: "integer" }, { type: "null" }] },
      days: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }], description: "Weekdays to post, 0 = Sunday ... 6 = Saturday; null if not said" },
      start: { anyOf: [{ type: "string" }, { type: "null" }], description: "'today', 'tomorrow' or a date YYYY-MM-DD; null if not said" },
      times: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], description: "Times of day HH:MM (24 h) if they named any; null otherwise" },
      now: { type: "boolean", description: "true only if they want everything posted now (spaced out)" } } },
    autoreply: { type: "object", additionalProperties: false, required: ["on", "keyword", "link"], properties: { on: { anyOf: [{ type: "boolean" }, { type: "null" }] }, keyword: { anyOf: [{ type: "string" }, { type: "null" }] }, link: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    trial: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    unclear: { type: "array", items: { type: "string" }, description: "Anything they asked for that these settings cannot do, in a few words each" },
  },
};
async function askClaude(env: Record<string, string | undefined>, f: typeof fetch, schema: any, system: string, text: string, log: (s: string) => void, u: string, what: string) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new SocialError("captions_off", "Caption writing is not switched on", 503);
  const model = env.STUDIO_CAPTION_TEXT_MODEL || "claude-sonnet-5-5";
  const r = await f("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify({ model, max_tokens: 3000, system, fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema", schema } }, messages: [{ role: "user", content: [{ type: "text", text }] }] }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => { throw new SocialError("smart_unavailable", "The assistant did not answer; try again", 503); });
  if (!r.ok) { log(`[smart-post] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); throw new SocialError("smart_unavailable", "The assistant did not answer; try again", 503); }
  const body: any = await r.json();
  logClaudeCost(log, what, String(body?.model ?? model), body?.usage, u);
  const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
  try { return JSON.parse(raw); } catch { throw new SocialError("smart_unavailable", "The answer came back unreadable; try again", 502); }
}

export function registerPostCaptions(app: Express, sbFn: () => SupabaseClient, deps: PostCaptionsDeps = {}) {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof SocialError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist|violates check constraint/i.test(msg)) return res.status(503).json({ error: "captions_unavailable", detail: "Writing captions for many videos is not switched on yet" });
    console.error("[post-captions]", msg);
    res.status(500).json({ error: "captions_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  const per = async () => watchCredits(env, deps.plans ?? await plansOf());
  const resolveAll = async (sb: SupabaseClient, u: string, videos: VideoRef[]) => { for (const v of videos) await resolveVideo(sb, u, v); };

  // What a batch would cost: credits per video watched, and which of these are watched already (those are free).
  app.post("/api/studio/social/captions/quote", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const videos = (Array.isArray(req.body?.videos) ? req.body.videos : []).map(cleanRef).filter(Boolean).slice(0, MAX_BATCH) as VideoRef[];
      const noted = await notedKeys(sb, u, videos.map(videoKey));
      const each = await per();
      const unwatched = videos.filter((v) => !noted.has(videoKey(v))).map(videoKey);
      res.json({ credits_each: each, watched: videos.map(videoKey).filter((k) => noted.has(k)), unwatched, credits: unwatched.length * each });
    } catch (e) { fail(res, e); }
  });

  // Write captions for a batch of videos (from each video, from the person's line, or both). Returns the job to follow.
  app.post("/api/studio/social/captions/batch", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const o = batchOptions(req.body ?? {});
      await resolveAll(sb, u, o.videos);
      const noted = await notedKeys(sb, u, o.videos.map(videoKey));
      const each = await per();
      const toWatch = !o.use_video ? 0 : o.rewatch ? o.videos.length : o.videos.filter((v) => !noted.has(videoKey(v))).length;
      const credits = toWatch * each;
      const r = await sb.rpc("studio_create_job", { p_user: u, p_tool: POST_CAPTIONS_TOOL, p_asset: null, p_options: { ...o, per_watch: each, via: String(req.body?.via ?? "post").slice(0, 20) }, p_credits: credits });
      if (r.error) {
        const m = String(r.error.message ?? "");
        if (/insufficient_credits/.test(m)) throw new SocialError("insufficient_credits", `Writing these from the videos takes ${credits} credits (${toWatch} not watched yet, ${each} each); top up or write them from your line`, 402);
        if (/too_many_jobs/.test(m)) throw new SocialError("captions_busy", "Captions are already being written; wait for those to finish", 409);
        if (/subscription_required/.test(m)) throw new SocialError("subscription_required", "Writing captions comes with a plan", 409);
        throw r.error;
      }
      const job = r.data as { id: string };
      // a step of posting, not something made: out of the library, no "ready" email or push
      const now = new Date().toISOString();
      await sb.from("studio_jobs").update({ hidden_at: now, notified_at: now, push_notified_at: now }).eq("id", job.id).eq("user_id", u);
      res.status(201).json({ job_id: job.id, credits, to_watch: toWatch, credits_each: each, videos: o.videos.length });
    } catch (e) { fail(res, e); }
  });

  // A batch's state: each video's caption as it lands.
  app.get("/api/studio/social/captions/batch/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID.test(req.params.id)) throw new SocialError("not_found", "No such batch", 404);
      const r = await sbFn().from("studio_jobs").select("id,tool,status,progress,credits_reserved,credits_charged,error_code,options").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      const j = r.data as any;
      if (!j || j.tool !== POST_CAPTIONS_TOOL) throw new SocialError("not_found", "No such batch", 404);
      res.json({ id: j.id, status: j.status, done: Number(j.progress?.done) || 0, of: (j.options?.videos ?? []).length, results: j.progress?.results ?? {}, credits_reserved: j.credits_reserved, credits_charged: j.credits_charged, error: j.error_code ?? null });
    } catch (e) { fail(res, e); }
  });

  // Smart post, step 2: what the (watched) videos are, three sample captions for the first, two call-to-action lines.
  app.post("/api/studio/social/smart/brief", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const s = sbFn();
      const videos = (Array.isArray(req.body?.videos) ? req.body.videos : []).map(cleanRef).filter(Boolean).slice(0, MAX_BATCH) as VideoRef[];
      if (!videos.length) throw new SocialError("no_videos", "Add the videos first", 400);
      const notes = (await Promise.all(videos.map((v) => readNote(s, u, videoKey(v))))).map((n, i) => ({ n, i })).filter((x): x is { n: VideoNote; i: number } => !!x.n);
      if (!notes.length) throw new SocialError("watch_needed", "The videos have not been watched yet", 402);
      if (!allowCaption(u)) throw new SocialError("caption_rate_limited", "That is a lot for one hour; try again soon", 429);
      const platforms = (Array.isArray(req.body?.platforms) ? req.body.platforms : []).map(String).filter(isSocialPlatform);
      const text = [
        `${videos.length} videos the creator is about to post${platforms.length ? ` to ${platforms.join(", ")}` : ""}. Notes on each (from someone who watched them):`,
        ...notes.slice(0, 30).map(({ n, i }) => `Video ${i + 1}: ${n.summary} Tone: ${n.tone}. People: ${n.people}.${n.speech ? ` Said: "${n.speech.slice(0, 200)}"` : ""}`),
        notes[0].i === 0 ? `The FIRST video in full:\nIn order: ${notes[0].n.moments.join(" / ")}\nOn-screen text: ${notes[0].n.on_screen_text.join(" / ") || "none"}` : "",
      ].filter(Boolean).join("\n");
      const system = "You help a creator post a batch of short videos. Be concrete and brief. Never mention AI, editing tools or companies. Never invent facts the notes do not show. Captions: like a person posting their own video, a specific first line, no generic hashtags (#fyp, #viral), at most 3 hashtags.";
      const out = deps.brief ? await deps.brief({ text, system }) : await askClaude(env, f, BRIEF_SCHEMA, system, text, log, u, "smart_brief");
      res.json({
        summary: String(out.summary ?? "").slice(0, 300),
        kinds: (Array.isArray(out.kinds) ? out.kinds : []).map((k: any) => ({ label: String(k?.label ?? "").slice(0, 60), count: Math.max(0, Math.round(Number(k?.count) || 0)) })).filter((k: any) => k.label).slice(0, 4),
        samples: (Array.isArray(out.samples) ? out.samples : []).map((x: any) => ({ style: String(x?.style ?? "").slice(0, 40), caption: String(x?.caption ?? "").slice(0, 600) })).filter((x: any) => x.caption).slice(0, 3),
        lines: (Array.isArray(out.lines) ? out.lines : []).map((x: any) => String(x ?? "").slice(0, 200)).filter(Boolean).slice(0, 2),
        watched: notes.length,
      });
    } catch (e) { fail(res, e); }
  });

  // Smart post, step 4: what the person typed (and tapped), as settings. Only settings: the page fills them in and the
  // person confirms there.
  app.post("/api/studio/social/smart/answer", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const said = String(req.body?.text ?? "").trim().slice(0, 1500);
      if (!said) throw new SocialError("nothing_said", "Say what you would like", 400);
      if (!allowCaption(u)) throw new SocialError("caption_rate_limited", "That is a lot for one hour; try again soon", 429);
      const ctx = req.body?.context ?? {};
      const text = [
        `The creator is posting ${Number(ctx.videos) || "some"} videos. Today is ${String(ctx.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10)} (${String(ctx.timezone ?? "").slice(0, 40)}).`,
        ctx.current ? `What is set now: ${JSON.stringify(ctx.current).slice(0, 1500)}` : "",
        `What they said: """${said}"""`,
        ctx.networks ? `Networks posted to: ${String(ctx.networks).slice(0, 80)}.` : "",
        "Turn it into settings. Leave anything they did not mention as null / 'unchanged'. networks: only when they say whether captions should differ between networks (TikTok, Instagram, YouTube...) or be the same. Never invent a link or keyword they did not give; if they give a comment word without a link, keyword is that word and link null.",
      ].filter(Boolean).join("\n\n");
      const out = deps.brief ? await deps.brief({ text, answer: true }) : await askClaude(env, f, ANSWER_SCHEMA, "You turn what a creator says about how to post a batch of videos into settings. Be literal; do not add what they did not ask for.", text, log, u, "smart_answer");
      const c = out.caption ?? {}, s = out.schedule ?? {}, a = out.autoreply ?? {};
      const times = Array.isArray(s.times) ? s.times.map(String).filter((t: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t)).map((t: string) => t.padStart(5, "0")).slice(0, 8) : null;
      res.json({
        caption: { mode: ["video", "line", "line_video", "own", "unchanged"].includes(c.mode) ? c.mode : "unchanged", line: c.line ? String(c.line).slice(0, 300) : null, keep_words: c.keep_words === true, style: c.style ? String(c.style).slice(0, 200) : null },
        networks: { mode: ["fit", "same", "custom"].includes(out.networks?.mode) ? out.networks.mode : "unchanged", how: out.networks?.mode === "custom" && out.networks?.how ? String(out.networks.how).slice(0, 300) : null },
        schedule: { per_day: Number.isInteger(s.per_day) && s.per_day > 0 && s.per_day <= 8 ? s.per_day : null, days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))] : null, start: typeof s.start === "string" && /^(today|tomorrow|\d{4}-\d{2}-\d{2})$/.test(s.start) ? s.start : null, times: times && times.length ? times : null, now: s.now === true },
        autoreply: { on: typeof a.on === "boolean" ? a.on : null, keyword: a.keyword ? String(a.keyword).replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 30) || null : null, link: a.link && /^https?:\/\/\S+$/i.test(String(a.link)) ? String(a.link).slice(0, 500) : null },
        trial: typeof out.trial === "boolean" ? out.trial : null,
        unclear: (Array.isArray(out.unclear) ? out.unclear : []).map((x: any) => String(x).slice(0, 120)).filter(Boolean).slice(0, 4),
      });
    } catch (e) { fail(res, e); }
  });
}
