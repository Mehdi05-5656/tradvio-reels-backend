// Clone8 Studio: Kage, the reference remix. A person brings a video that works (a reference) and photos of their hero
// (themselves, a product, a character); Kage reads the reference shot by shot, Claude writes a shot plan in its
// visual language with the hero in every scene, every shot renders at once on the platform, each is judged against
// the hero's photo, and the shots are cut together on the reference's own rhythm with its sound. One job on the
// queue (tool "kage"), the plan and every shot's state on the job, nothing new in the database beyond the tool name.
// Not a shot-for-shot copy: new scenes, same cuts, same energy. Switched on by STUDIO_KAGE_ENABLED=true.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { RecastError, sceneCuts, motionScores, trimClip, concatVideos, muxAudio, probeSeconds, probeDimensions, makePoster } from "./studio-recast.js";
import { hf, outputUrls, listPrice, instrumentDiscount, type InstrumentDeps } from "./studio-instruments.js";
import { claudeJson, type ClipsDeps } from "./studio-clips.js";
import { PREMIUM_MARGIN, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";
import type { LibraryHelpers } from "./studio-library.js";
import { KAGE_REFERENCES, kageReferenceById, kageReferencePosterUrl, kageReferenceVideoUrl } from "./studio-kage-references.js";

export class KageError extends Error { constructor(public code: string, message: string, public status = 400, public retry = false) { super(message); } }

/** Where the shots and the plates come from. Both on the platform API we already pay for; one price row each. */
export const SHOT_MODEL = "bytedance/seedance-2.5/reference-to-video";
export const PLATE_MODEL = "higgsfield-ai/soul/cinema";
export const KAGE_LIMITS = {
  /** a reference longer than this is read only this far */
  max_seconds: 60,
  /** more shots than this is a strobe edit, not a remix we can price */
  max_shots: 16,
  /** a shot shorter than this is folded into the one before it (a one-frame insert, a flash) */
  min_shot: 0.4,
  /** generated seconds per shot: twice its screen time, inside the renderer's floor and a cap that keeps the bill sane */
  gen_min: 4, gen_max: 10,
  hero_photos: 5,
  /** free plans a day for one person (each is a Claude call over the reference's frames) */
  plans_per_day: 30,
  /** a shot the judge rejects is rendered once more, then kept as it is and said so */
  rerolls: 1,
  /** the whole run, from the first render sent */
  max_wait_min: 45,
} as const;
const POLL_MS = 10_000, OUTPUT_LIMIT = 268_435_456;
/** Claude's work on one run (the plan and the judging), priced into the quote as a flat allowance. */
const CLAUDE_USD = 0.5;

export const kageEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_KAGE_ENABLED === "true" && !!env.HIGGSFIELD_API_KEY && !!env.ANTHROPIC_API_KEY;

export type KageDeps = ClipsDeps & InstrumentDeps & {
  sceneCuts?: (path: string, within: number) => Promise<number[]>;
  motion?: (path: string, within: number) => Promise<Array<[number, number]>>;
  /** a still of a video at `at` seconds, 512 px wide, as base64 JPEG (ffmpeg in production; tests inject one) */
  still?: (video: string, at: number) => Promise<string | null>;
  probeSeconds?: (path: string) => Promise<number>; probeDimensions?: (path: string) => Promise<{ width: number; height: number }>;
  trim?: (source: string, target: string, seconds: number) => Promise<void>; concat?: (pieces: string[], target: string) => Promise<void>;
  mux?: (output: string, source: string, target: string) => Promise<void>; poster?: (video: string, target: string) => Promise<void>;
};

// ---------------------------------------------------------------------------------------------------
// Reading the reference: its shots, one still each
// ---------------------------------------------------------------------------------------------------
export type RefShot = { i: number; start: number; end: number };
export type Analysis = { seconds: number; width: number; height: number; cuts: number[]; shots: RefShot[]; motion: number };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The reference's shots from its camera changes: a cut inside `min_shot` of the one before is a flash or an insert and
 *  folds into the shot before it; nothing shorter than that survives. */
export function shotsOf(seconds: number, cuts: number[], minShot = KAGE_LIMITS.min_shot): RefShot[] {
  const total = r2(seconds);
  const bounds = [0, ...[...new Set(cuts.map(r2))].filter((c) => c > 0 && c < total).sort((a, b) => a - b), total];
  const out: RefShot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (out.length && end - start < minShot - 1e-9) { out[out.length - 1].end = end; continue; }
    out.push({ i: out.length, start, end });
  }
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < minShot - 1e-9) { const t = out.pop()!; out[out.length - 1].end = t.end; }
  return out;
}

export async function still(video: string, at: number): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "c8-kage-still-"));
  try {
    const f = join(dir, "f.jpg");
    await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", f], undefined, 60_000);
    const b = await readFile(f).catch(() => null);
    return b && b.length ? b.toString("base64") : null;
  } catch { return null; } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** The reference read: length, size, cuts, shots, how much the picture moves, and a still from the middle of each shot. */
export async function analyzeReference(file: string, deps: KageDeps = {}): Promise<{ analysis: Analysis; frames: string[] }> {
  const seconds = await (deps.probeSeconds ?? probeSeconds)(file);
  if (!(seconds > 0.5)) throw new KageError("reference_unreadable", "That video could not be read", 422);
  const { width, height } = await (deps.probeDimensions ?? probeDimensions)(file).catch(() => ({ width: 0, height: 0 }));
  const within = Math.min(seconds, KAGE_LIMITS.max_seconds);
  const cuts = await (deps.sceneCuts ?? sceneCuts)(file, within).catch(() => [] as number[]);
  const shots = shotsOf(within, cuts);
  if (shots.length > KAGE_LIMITS.max_shots) throw new KageError("reference_too_busy", `That reference has ${shots.length} shots in ${Math.round(within)} seconds; Kage remixes up to ${KAGE_LIMITS.max_shots}. Pick a calmer one, or a shorter part of it.`, 422);
  const motion = await (deps.motion ?? motionScores)(file, within).catch(() => [] as Array<[number, number]>);
  const frames: string[] = [];
  for (const s of shots) {
    const f = await (deps.still ?? still)(file, (s.start + s.end) / 2);
    if (!f) throw new KageError("reference_unreadable", "No frames could be read from that video", 422);
    frames.push(f);
  }
  return { analysis: { seconds: r2(seconds), width, height, cuts: cuts.map(r2), shots, motion: motion.length ? r2(motion.reduce((n, [, v]) => n + v, 0) / motion.length) : 0 }, frames };
}

// ---------------------------------------------------------------------------------------------------
// The plan: Claude writes one shot per reference shot, in its language, with the hero in it
// ---------------------------------------------------------------------------------------------------
export type PlanShot = { ref: number; role: string; hero: boolean; location: string | null; prompt: string; camera: string; text: string | null };
export type Plan = { concept: string; look: "photoreal" | "stylised"; keep_music: boolean; locations: Array<{ id: string; prompt: string }>; shots: PlanShot[] };
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["concept", "look", "keep_music", "locations", "shots"],
  properties: {
    concept: { type: "string" }, look: { type: "string", enum: ["photoreal", "stylised"] }, keep_music: { type: "boolean" },
    locations: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "prompt"], properties: { id: { type: "string" }, prompt: { type: "string" } } } },
    shots: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "role", "hero", "location", "prompt", "camera", "text"], properties: {
      ref: { type: "integer" }, role: { type: "string" }, hero: { type: "boolean" }, location: { type: ["string", "null"] }, prompt: { type: "string" }, camera: { type: "string" }, text: { type: ["string", "null"] } } } },
  },
};
const PLAN_SYSTEM = `You plan a remix: a new short video for a creator in the visual language of a reference video they admire, with their own hero (the person, product or character in the photos) in every scene that has a subject. You see one still per shot of the reference, in order, with its timing, and the hero's photos.

Rules:
- One output shot per reference shot, in the same order, with the same screen time: the cuts, the rhythm and the energy come from the reference. Say which reference shot each output shot answers ("ref").
- New scenes in the reference's language, never a copy of its footage: keep its shot sizes, camera moves, pacing, lighting feel, palette and mood; invent the location, the action and the staging to suit the hero.
- The hero appears in every shot that has a person or subject in the reference, wearing exactly what the photos show. Never the reference performer's clothes, face, hair or accessories. A shot with no subject (a landscape, a title, a product-only insert) has hero false.
- Each shot gets a prompt a video model renders from: concrete and observable, in this order: the place and light; the hero's starting state; ONE main action; the camera (shot size, move and how far); materials, lighting and continuity locks (the clothing from the photo). 40 to 90 words. No adjectives piled up, no metaphors, no text or lettering in the picture (words go in "text", to be laid over afterwards), no mention of the reference.
- "camera": the shot size and move in a few words (for example "medium, slow push in").
- "location": one id per distinct place across the shots, from "locations", each with a prompt that describes only the place (no people), so one plate can serve every shot there. null for a shot that needs no place (a product on plain colour, a title).
- "look": photoreal unless the reference is drawn or animated. "keep_music": true unless the reference's sound is speech that will not fit the new scenes.
- "concept": one or two sentences on what the remix is about.
- Honour the creator's brief and any lock it states.`;

/** Claude's plan for the remix, one shot per reference shot. Image inputs are base64 JPEGs (the stills and the hero photos). */
export async function planRemix(deps: KageDeps, analysis: Analysis, frames: string[], hero: Array<{ data: string; media_type: string }>, brief: string | null, userId?: string): Promise<Plan> {
  const env = deps.env ?? process.env;
  const content: any[] = [];
  analysis.shots.forEach((s, i) => { content.push({ type: "text", text: `Reference shot ${s.i + 1} of ${analysis.shots.length}: ${s.start.toFixed(2)} to ${s.end.toFixed(2)} s (${r2(s.end - s.start)} s on screen)` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frames[i] } }); });
  content.push({ type: "text", text: `The hero's photo${hero.length > 1 ? "s" : ""}:` });
  for (const h of hero) content.push({ type: "image", source: { type: "base64", media_type: h.media_type, data: h.data } });
  content.push({ type: "text", text: `The reference is ${analysis.seconds} s, ${analysis.width}x${analysis.height}, ${analysis.shots.length} shots, picture motion ${analysis.motion} (0 still, 1 frantic).${brief ? `\n\nThe creator's brief: """${brief.slice(0, 600)}"""` : "\n\nThe creator gave no brief."}\n\nWrite the plan.` });
  const out = await claudeJson(deps, {
    model: env.STUDIO_KAGE_MODEL || "claude-sonnet-5-5", max_tokens: 6000, system: PLAN_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    messages: [{ role: "user", content }],
  }, "kage_plan", userId);
  return cleanPlan(out, analysis);
}

/** The plan as the renderer needs it: one shot per reference shot (a missing one becomes a hold on its place), prompts
 *  bounded, locations that exist. */
export function cleanPlan(raw: any, analysis: Analysis): Plan {
  const locs = (Array.isArray(raw?.locations) ? raw.locations : []).map((l: any) => ({ id: String(l?.id ?? "").trim().slice(0, 40), prompt: String(l?.prompt ?? "").trim().slice(0, 600) })).filter((l: any) => l.id && l.prompt);
  const ids = new Set(locs.map((l: any) => l.id));
  const given = new Map<number, any>();
  for (const s of Array.isArray(raw?.shots) ? raw.shots : []) { const ref = Number(s?.ref) - 1; if (Number.isInteger(ref) && ref >= 0 && ref < analysis.shots.length && !given.has(ref)) given.set(ref, s); }
  const shots: PlanShot[] = analysis.shots.map((s) => {
    const g = given.get(s.i);
    const location = g && typeof g.location === "string" && ids.has(g.location.trim()) ? g.location.trim() : null;
    const prompt = String(g?.prompt ?? "").trim().slice(0, 900);
    return { ref: s.i, role: String(g?.role ?? "hold").trim().slice(0, 40) || "hold", hero: !!g?.hero && !!prompt, location, prompt: prompt || (location ? `${locs.find((l: any) => l.id === location)!.prompt} Still camera, nothing moves but the light.` : "A plain dark background, soft light, nothing moves."), camera: String(g?.camera ?? "").trim().slice(0, 80), text: typeof g?.text === "string" && g.text.trim() ? g.text.trim().slice(0, 120) : null };
  });
  const used = new Set(shots.map((s) => s.location).filter(Boolean));
  return { concept: String(raw?.concept ?? "").trim().slice(0, 400), look: raw?.look === "stylised" ? "stylised" : "photoreal", keep_music: raw?.keep_music !== false, locations: locs.filter((l: any) => used.has(l.id)), shots };
}

// ---------------------------------------------------------------------------------------------------
// The price: seconds rendered, plates drawn, Claude's share
// ---------------------------------------------------------------------------------------------------
/** Seconds rendered for a shot: twice its screen time (the usable part lands in the middle), inside the floor and cap. */
export const genSeconds = (screen: number) => Math.min(KAGE_LIMITS.gen_max, Math.max(KAGE_LIMITS.gen_min, Math.ceil(2 * screen - 1e-6)));
export function kagePlanCost(plan: Plan, analysis: Analysis, env: Record<string, string | undefined> = process.env) {
  const shot = listPrice(SHOT_MODEL), plate = listPrice(PLATE_MODEL);
  if (!shot || !plate) throw new KageError("kage_unpriced", "Kage is not priced yet", 503);
  const perSecond = shot.by_resolution?.["720p"] ?? shot.usd;
  const gen = analysis.shots.reduce((n, s) => n + genSeconds(s.end - s.start), 0);
  const list = gen * perSecond + plan.locations.length * plate.usd + CLAUDE_USD;
  const cost = gen * perSecond * (1 - instrumentDiscount({ provider: "bytedance", id: SHOT_MODEL, api_path: SHOT_MODEL }, env)) + plan.locations.length * plate.usd * (1 - instrumentDiscount({ provider: "higgsfield", id: PLATE_MODEL, api_path: PLATE_MODEL }, env)) + CLAUDE_USD;
  return { gen_seconds: gen, plates: plan.locations.length, list_usd: Math.round(list * 1000) / 1000, usd: Math.round(cost * 1000) / 1000 };
}
export function kageCredits(listUsd: number, env: Record<string, string | undefined>, plans: PlanLike[]): number {
  const costs = studioCosts(env, plans);
  return Math.max(1, costs.credit_floor ? creditsForCost(listUsd, costs.credit_floor, PREMIUM_MARGIN) : Math.ceil(listUsd * 100));
}

// ---------------------------------------------------------------------------------------------------
// Stored plans (the free step), the quote and the job
// ---------------------------------------------------------------------------------------------------
/** The reference is the person's own video (reference_asset_id) or one of our presets (reference_id); never both. */
export type StoredPlan = { v: 1; reference_asset_id: string | null; reference_id?: string | null; hero_asset_ids: string[]; brief: string | null; analysis: Analysis; plan: Plan; created_at: string };
export const planKey = (u: string, id: string) => `${u}/kage/plans/${id}.json`;
export async function readPlan(sb: SupabaseClient, u: string, key: string): Promise<StoredPlan | null> {
  if (!key.startsWith(`${u}/kage/plans/`)) return null;
  const r = await sb.storage.from("studio-outputs").download(key);
  if (r.error || !r.data) return null;
  try { const d = JSON.parse(Buffer.from(await r.data.arrayBuffer()).toString("utf8")); return d?.v === 1 && d.plan && d.analysis ? d : null; } catch { return null; }
}
export type KageQuote = { tool: "kage"; credits: number; options: Record<string, any>; summary: string };
export async function quoteKage(sb: SupabaseClient, u: string, env: Record<string, string | undefined>, plans: PlanLike[], options: any, asset: { id: string; kind: string } | null): Promise<KageQuote> {
  if (!kageEnabled(env)) throw new KageError("kage_unavailable", "Kage is not switched on yet", 503);
  const key = String(options?.plan_key ?? "");
  const stored = key ? await readPlan(sb, u, key) : null;
  if (!stored) throw new KageError("kage_plan_missing", "Plan the remix first", 404);
  if (stored.reference_id ? !!asset || !kageReferenceById(stored.reference_id) : !asset || asset.id !== stored.reference_asset_id) throw new KageError("kage_reference_mismatch", "That plan was made for another reference", 409);
  const cost = kagePlanCost(stored.plan, stored.analysis, env);
  const credits = kageCredits(cost.list_usd, env, plans);
  return { tool: "kage", credits, options: { plan_key: key, reference_asset_id: stored.reference_asset_id, reference_id: stored.reference_id ?? null, hero_asset_ids: stored.hero_asset_ids, concept: stored.plan.concept, shots: stored.plan.shots.length, seconds: stored.analysis.seconds, ...cost },
    summary: `${stored.plan.shots.length} shots · ${Math.round(stored.analysis.seconds)} s` };
}

type Job = { id: string; user_id: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };
async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new RecastError("lease_lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}
const aspectOf = (w: number, h: number) => (!(w > 0 && h > 0) ? "9:16" : w > h * 1.6 ? "16:9" : w > h * 1.15 ? "4:3" : h > w * 1.6 ? "9:16" : h > w * 1.15 ? "3:4" : "1:1");

// ---------------------------------------------------------------------------------------------------
// Judging a shot against the hero's photo
// ---------------------------------------------------------------------------------------------------
const JUDGE_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["match", "reroll"] }, reason: { type: "string" } } };
export async function judgeShot(deps: KageDeps, file: string, hero: Array<{ data: string; media_type: string }>, shot: PlanShot, userId?: string): Promise<{ verdict: "match" | "reroll"; reason: string }> {
  const env = deps.env ?? process.env;
  const seconds = await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 0);
  const frames: string[] = [];
  for (const at of [0.2, 0.5, 0.8]) { const f = await (deps.still ?? still)(file, Math.max(0, seconds * at)); if (f) frames.push(f); }
  if (!frames.length) return { verdict: "reroll", reason: "no frames could be read" };
  const content: any[] = [{ type: "text", text: "The hero's photo(s):" }, ...hero.map((h) => ({ type: "image", source: { type: "base64", media_type: h.media_type, data: h.data } })), { type: "text", text: `Three frames of a generated shot (start, middle, end). The shot was asked for: """${shot.prompt}"""` }, ...frames.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })), { type: "text", text: shot.hero ? "Does the person in the frames read as the hero in the photo (face shape, hair, skin tone, build, the clothing from the photo), with sound hands and no stray lettering, merging or a second face? match or reroll, with the reason in one sentence." : "Is the shot clean (no stray lettering, no extra people, nothing merging or broken) and does it show what was asked? match or reroll, with the reason in one sentence." }];
  const out = await claudeJson(deps, { model: env.STUDIO_KAGE_JUDGE_MODEL || "claude-sonnet-5-5", max_tokens: 400, thinking: { type: "disabled" }, output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } }, messages: [{ role: "user", content }] }, "kage_judge", userId).catch(() => ({ verdict: "match", reason: "the judge did not answer; kept" }));
  return { verdict: out?.verdict === "reroll" ? "reroll" : "match", reason: String(out?.reason ?? "").slice(0, 200) };
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type ShotState = { i: number; request_id: string | null; key: string | null; verdict: "match" | "reroll" | "kept" | null; reason: string | null; rerolls: number };
const mediaTypeOf = (b: Buffer) => (b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0x52 && b[8] === 0x57 ? "image/webp" : "image/jpeg");

export async function runKageJob(sb: SupabaseClient, deps: KageDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), now = deps.now ?? Date.now;
  const fail = async (code: string, retry: boolean) => {
    try { const r = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry }); if (r.error) throw r.error; }
    catch { return "failure_unconfirmed"; }
    return retry && job.attempts < 3 ? "requeued" : "failed";
  };
  let dir: string | null = null;
  try {
    const stored = await readPlan(sb, job.user_id, String(job.options?.plan_key ?? ""));
    if (!stored) throw new RecastError("kage_plan_missing");
    const { plan, analysis } = stored;
    const base = `${job.user_id}/${job.id}/${job.lease_token}`;
    dir = await mkdtemp(join(tmpdir(), "studio-kage-"));
    // the hero's photos: signed for the renderer, read for the judge
    const heroRows = await sb.from("studio_assets").select("id,object_key,kind,status").eq("user_id", job.user_id).in("id", stored.hero_asset_ids);
    if (heroRows.error) throw heroRows.error;
    const heroUrls: string[] = [], heroImages: Array<{ data: string; media_type: string }> = [];
    for (const id of stored.hero_asset_ids) {
      const row = (heroRows.data ?? []).find((x: any) => x.id === id);
      if (!row || row.status !== "ready" || row.kind !== "image") throw new RecastError("source_missing");
      const s = await sb.storage.from("studio-uploads").createSignedUrl(row.object_key, 4 * 3600);
      if (s.error || !s.data) throw s.error ?? new RecastError("source_missing");
      heroUrls.push(s.data.signedUrl);
      const d = await sb.storage.from("studio-uploads").download(row.object_key);
      if (d.error || !d.data) throw new RecastError("source_missing");
      const b = Buffer.from(await d.data.arrayBuffer()); heroImages.push({ data: b.toString("base64"), media_type: mediaTypeOf(b) });
    }
    const aspect = aspectOf(analysis.width, analysis.height);
    const started = Date.parse(job.progress?.started_at ?? "") || now();
    if (!job.progress?.started_at) await renew(sb, job, { started_at: new Date(started).toISOString(), total: plan.shots.length, done: 0 });
    const overdue = () => { if (now() - started > KAGE_LIMITS.max_wait_min * 60_000) throw new RecastError("recast_timeout"); };
    const waitFor = async (requestId: string, what: string): Promise<any> => {
      for (;;) {
        overdue();
        let st: { status: number; body: any };
        try { st = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }); }
        catch (e: any) { if (e instanceof RecastError && e.retry) { await sleep(POLL_MS); continue; } throw e; }
        const status = String(st.body?.status ?? "unknown").toLowerCase();
        if (status === "completed") return st.body;
        if (status === "failed" || status === "nsfw" || status === "canceled" || status === "cancelled") {
          log(`[kage] ${status} ${JSON.stringify({ job: job.id, what, request: requestId, detail: JSON.stringify(st.body).slice(0, 300) })}`);
          throw new RecastError(status === "nsfw" ? "recast_nsfw" : status === "failed" ? "recast_failed" : "recast_canceled");
        }
        await sleep(POLL_MS);
      }
    };
    const submit = async (path: string, body: Record<string, any>, idem: string): Promise<string> => {
      const r = await hf(deps, `/${path}`, { method: "POST", body: JSON.stringify(body), idempotency: idem });
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) throw new RecastError("recast_rejected", `Higgsfield ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      if (!r.body?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
      return String(r.body.request_id);
    };
    const fetchTo = async (url: string, file: string): Promise<Buffer> => {
      const dl = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(300_000) });
      if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
      const bytes = Buffer.from(await dl.arrayBuffer());
      if (!bytes.length || bytes.length > OUTPUT_LIMIT) throw new RecastError("output_too_large");
      await writeFile(file, bytes);
      return bytes;
    };

    // 1. Plates: one empty picture of each place, so every shot there is built on the same geometry and light.
    const plates: Record<string, { request_id: string | null; key: string | null }> = job.progress?.plates ?? {};
    for (const loc of plan.locations) {
      if (plates[loc.id]?.key) continue;
      if (!plates[loc.id]?.request_id) {
        await renew(sb, job, { note: `Drawing the place: ${loc.id}` });
        const requestId = await submit(PLATE_MODEL, { prompt: `${loc.prompt}. Empty: no people, no animals, no text or lettering anywhere.`, aspect_ratio: aspect, resolution: "720p", enhance_prompt: false }, `${job.id}:${job.attempts}:plate:${loc.id}`);
        plates[loc.id] = { request_id: requestId, key: null };
        await renew(sb, job, { plates });
        log(`[kage] submitted ${JSON.stringify({ job: job.id, plate: loc.id, request: requestId })}`);
      }
      const raw = await waitFor(plates[loc.id].request_id!, `plate ${loc.id}`);
      const url = outputUrls(raw).images[0] ?? outputUrls(raw).videos[0];
      if (!url) throw new RecastError("recast_bad_output", "a plate completed without a url");
      const file = join(dir, `plate-${loc.id}.jpg`);
      const bytes = await fetchTo(url, file);
      const key = `${base}/plate-${loc.id}.jpg`;
      const up = await sb.storage.from("studio-outputs").upload(key, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      plates[loc.id] = { request_id: plates[loc.id].request_id, key };
      await renew(sb, job, { plates });
    }
    const plateUrl = async (id: string | null): Promise<string | null> => { const k = id ? plates[id]?.key : null; if (!k) return null; const s = await sb.storage.from("studio-outputs").createSignedUrl(k, 4 * 3600); return s.error || !s.data ? null : s.data.signedUrl; };

    // 2. Shots: the first hero shot alone (the canary: a cheap place to stop when the hero does not land), then every
    //    other shot at once. Each is judged as it arrives; a rejected one goes once more, then is kept and said so.
    const shots: ShotState[] = Array.isArray(job.progress?.shots) && job.progress.shots.length === plan.shots.length ? job.progress.shots : plan.shots.map((s) => ({ i: s.ref, request_id: null, key: null, verdict: null, reason: null, rerolls: 0 }));
    const bodyFor = async (s: PlanShot, ref: RefShot) => {
      const pl = await plateUrl(s.location);
      const images = [...(s.hero ? heroUrls : []), ...(pl ? [pl] : [])];
      const prompt = `${s.prompt}${s.hero ? ` The person is the one in the first reference image${heroUrls.length > 1 ? "s" : ""}: same face, hair, build and exactly the clothing shown there.` : ""}${pl ? ` The place is the last reference image: keep its layout, materials and light.` : ""} No text or lettering anywhere.`;
      return { prompt, ...(images.length ? { image_urls: images } : {}), duration: genSeconds(ref.end - ref.start), resolution: "720p", aspect_ratio: aspect, generate_audio: false, bitrate_mode: "high" };
    };
    const send = async (i: number) => {
      const body = await bodyFor(plan.shots[i], analysis.shots[i]);
      const requestId = await submit(SHOT_MODEL, body, `${job.id}:${job.attempts}:shot:${i}:${shots[i].rerolls}`);
      shots[i] = { ...shots[i], request_id: requestId, key: null, verdict: null, reason: null };
      await renew(sb, job, { shots, note: `Rendering shot ${i + 1} of ${shots.length}` });
      log(`[kage] submitted ${JSON.stringify({ job: job.id, shot: i + 1, of: shots.length, reroll: shots[i].rerolls, request: requestId, seconds: body.duration })}`);
    };
    const land = async (i: number): Promise<"done" | "again"> => {
      const raw = await waitFor(shots[i].request_id!, `shot ${i + 1}`);
      const url = outputUrls(raw).videos[0];
      if (!url) throw new RecastError("recast_bad_output", "a shot completed without a url");
      const file = join(dir!, `shot-${i + 1}-${shots[i].rerolls}.mp4`);
      const bytes = await fetchTo(url, file);
      const judged = await judgeShot(deps, file, heroImages, plan.shots[i], job.user_id);
      if (judged.verdict === "reroll" && shots[i].rerolls < KAGE_LIMITS.rerolls) {
        log(`[kage] reroll ${JSON.stringify({ job: job.id, shot: i + 1, reason: judged.reason })}`);
        shots[i] = { ...shots[i], request_id: null, rerolls: shots[i].rerolls + 1, reason: judged.reason };
        await renew(sb, job, { shots });
        return "again";
      }
      const key = `${base}/shot-${i + 1}.mp4`;
      const up = await sb.storage.from("studio-outputs").upload(key, bytes, { contentType: "video/mp4", upsert: true });
      if (up.error) throw up.error;
      shots[i] = { ...shots[i], key, verdict: judged.verdict === "match" ? "match" : "kept", reason: judged.reason };
      await renew(sb, job, { shots, done: shots.filter((s) => s.key).length, note: `Rendering your remix: ${shots.filter((s) => s.key).length} of ${shots.length} shots done` });
      return "done";
    };
    const canary = plan.shots.findIndex((s) => s.hero);
    if (canary >= 0 && !shots[canary].key) {
      for (;;) { if (!shots[canary].request_id) await send(canary); await renew(sb, job, { note: "Rendering the first shot: it sets the hero for the rest" }); if ((await land(canary)) === "done") break; }
      if (shots[canary].verdict === "kept") { await renew(sb, job, { note: "The hero did not land in the first shot", stopped: shots[canary].reason }); throw new RecastError("kage_hero_lost", shots[canary].reason ?? "the hero did not land"); }
    }
    for (const [i, s] of shots.entries()) if (!s.key && !s.request_id) await send(i);
    for (;;) {
      const open = shots.filter((s) => !s.key);
      if (!open.length) break;
      // the one sent longest ago lands first; a reroll goes straight back out
      const i = open[0].i;
      if (!shots[i].request_id) await send(i);
      await land(i);
    }

    // 3. The cut: each shot trimmed to its screen time, in the reference's order, with the reference's sound back on.
    await renew(sb, job, { note: "Cutting your remix" });
    const files: string[] = [];
    for (const [i, s] of shots.entries()) {
      const d = await sb.storage.from("studio-outputs").download(s.key!);
      if (d.error || !d.data) throw new RecastError("recast_bad_output", "a shot is missing from storage", true);
      const raw = join(dir, `cut-${i + 1}-raw.mp4`), cut = join(dir, `cut-${i + 1}.mp4`);
      await writeFile(raw, Buffer.from(await d.data.arrayBuffer()));
      await (deps.trim ?? trimClip)(raw, cut, r2(analysis.shots[i].end - analysis.shots[i].start));
      files.push(cut);
    }
    const joined = join(dir, "joined.mp4"), out = join(dir, "out.mp4"), still0 = join(dir, "out.jpg");
    if (files.length > 1) await (deps.concat ?? concatVideos)(files, joined); else await writeFile(joined, await readFile(files[0]));
    if (plan.keep_music) {
      // the reference's sound: from the person's upload, or from our preset's clip
      let bytes: Buffer | null = null;
      const preset = stored.reference_id ? kageReferenceById(stored.reference_id) : null;
      if (preset) {
        const base = env.STUDIO_PRESET_BASE ?? env.DASHBOARD_URL ?? "https://app.clone8.io";
        const dl = await (deps.fetch ?? fetch)(kageReferenceVideoUrl(base, preset), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
        if (dl?.ok) bytes = Buffer.from(await dl.arrayBuffer());
      } else if (stored.reference_asset_id) {
        const refRow = await sb.from("studio_assets").select("object_key").eq("id", stored.reference_asset_id).eq("user_id", job.user_id).maybeSingle();
        const ref = refRow.data?.object_key ? await sb.storage.from("studio-uploads").download(refRow.data.object_key) : null;
        if (ref && !ref.error && ref.data) bytes = Buffer.from(await ref.data.arrayBuffer());
      }
      if (bytes) { const rf = join(dir, "reference.mp4"); await writeFile(rf, bytes); await (deps.mux ?? muxAudio)(joined, rf, out); }
      else await writeFile(out, await readFile(joined));
    } else await writeFile(out, await readFile(joined));
    const video = await readFile(out);
    const seconds = await (deps.probeSeconds ?? probeSeconds)(out).catch(() => analysis.seconds);
    let posterOk = true; try { await (deps.poster ?? makePoster)(out, still0); } catch { posterOk = false; }
    const key = `${base}/1.mp4`;
    const up = await sb.storage.from("studio-outputs").upload(key, video, { contentType: "video/mp4", upsert: true });
    if (up.error) throw up.error;
    if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}/1.jpg`, await readFile(still0), { contentType: "image/jpeg", upsert: true }); if (p.error) posterOk = false; }
    const kept = shots.filter((s) => s.verdict === "kept").length;
    const outputs = [{ index: 1, key, poster_key: posterOk ? `${base}/1.jpg` : undefined, kind: "video", bytes: video.length, duration: Math.round(seconds * 1000) / 1000, tool: "kage", shots: shots.length, plates: plan.locations.length, concept: plan.concept, audio: plan.keep_music ? "muxed_from_reference" : "none", ...(kept ? { note: `${kept} shot${kept > 1 ? "s" : ""} did not pass the hero check and ${kept > 1 ? "were" : "was"} kept as rendered` } : {}) }];
    const charged = Math.min(job.credits_reserved, Math.max(1, Number(job.credits_reserved)));
    try { const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged }); if (done.error) throw done.error; }
    catch { return "completion_unconfirmed"; }
    log(`[kage] done ${JSON.stringify({ job: job.id, shots: shots.length, kept, plates: plan.locations.length, charged })}`);
    return "done";
  } catch (e: any) {
    if (e instanceof RecastError && e.code === "lease_lost") return "lease_lost";
    const code = e instanceof RecastError ? e.code : "worker_error";
    const retry = e instanceof RecastError ? e.retry : true;
    log(`[kage] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    return fail(code, retry);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function startKageLoop(sbFn: () => SupabaseClient, deps: KageDeps = {}, intervalMs = 15_000, maxParallel = 2): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!kageEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `kage-${randomUUID()}`;
  let running = 0;
  const tick = async () => {
    if (running >= maxParallel) return;
    try {
      const sb = sbFn();
      const r = await sb.rpc("studio_claim", { p_tool: "kage", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running++;
      const keep = setInterval(() => { sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }).then(() => undefined, () => undefined); /* (sent only when then-ed: a bare void never went out until Nov 7 2026) */ }, 4 * 60_000);
      runKageJob(sb, { ...deps, log }, job).then((s) => log(`[kage] ${s} ${job.id}`)).catch((e) => log(`[kage] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { clearInterval(keep); running--; });
    } catch (e: any) { log(`[kage] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 17_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes: the free plan
// ---------------------------------------------------------------------------------------------------
export function registerKage(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log">, deps: KageDeps = {}): void {
  // Our reference presets for the gallery, with their clip and poster addresses.
  app.get("/api/studio/kage/references", (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    const base = h.env.STUDIO_PRESET_BASE ?? h.env.DASHBOARD_URL ?? "https://app.clone8.io";
    res.json({ references: KAGE_REFERENCES.map((r) => ({ id: r.id, name: r.name, lede: r.lede, seconds: r.seconds, tags: r.tags, video_url: kageReferenceVideoUrl(base, r), poster_url: kageReferencePosterUrl(base, r) })) });
  });
  // The plan: the reference read and Claude's shot list, stored so the quote and the job price and render exactly it.
  // Free, counted per day. With their own video the person confirms they own it or have permission; a preset is ours.
  app.post("/api/studio/kage/plan", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    const sb = h.sbFn();
    let dir: string | null = null;
    try {
      if (!kageEnabled(h.env)) throw new KageError("kage_unavailable", "Kage is not switched on yet", 503);
      const b = req.body ?? {};
      const preset = b.reference_id != null ? kageReferenceById(String(b.reference_id)) : null;
      if (b.reference_id != null && !preset) throw new KageError("kage_no_reference", "That reference is not in the gallery", 404);
      if (!preset && b.rights !== true) throw new KageError("rights_required", "Confirm you own the reference, manage its account, or have the creator's permission");
      const refId = preset ? "" : String(b.reference_asset_id ?? "");
      const heroIds: string[] = [...new Set<string>((Array.isArray(b.hero_asset_ids) ? b.hero_asset_ids : []).map((x: any) => String(x)))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      if (!preset && !/^[0-9a-f-]{36}$/i.test(refId)) throw new KageError("kage_no_reference", "Pick a reference video");
      if (!heroIds.length || heroIds.length > KAGE_LIMITS.hero_photos) throw new KageError("kage_no_hero", `Add 1 to ${KAGE_LIMITS.hero_photos} photos of your hero`);
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const used = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "kage_plan").gte("created_at", since);
      if (!used.error && (used.count ?? 0) >= KAGE_LIMITS.plans_per_day) throw new KageError("kage_rate_limited", "That is a lot of plans for one day; come back tomorrow", 429);
      const rows = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("user_id", u).in("id", [...(refId ? [refId] : []), ...heroIds]);
      if (rows.error) throw rows.error;
      const ref = refId ? (rows.data ?? []).find((x: any) => x.id === refId) : null;
      if (!preset && (!ref || ref.status !== "ready" || ref.kind !== "video")) throw new KageError("video_not_found", "That reference is not in your library", 404);
      if (ref && Number(ref.probe?.duration) > KAGE_LIMITS.max_seconds * 2) throw new KageError("kage_reference_long", `Kage reads up to ${KAGE_LIMITS.max_seconds} seconds; make a clip of the part you want first`);
      const heroes = heroIds.map((id) => { const x = (rows.data ?? []).find((r: any) => r.id === id); if (!x || x.status !== "ready" || x.kind !== "image") throw new KageError("kage_hero_missing", "One of the hero photos is not in your library", 404); return x; });
      dir = await mkdtemp(join(tmpdir(), "c8-kage-plan-"));
      const file = join(dir, "ref.mp4");
      if (preset) {
        const base = h.env.STUDIO_PRESET_BASE ?? h.env.DASHBOARD_URL ?? "https://app.clone8.io";
        const dl = await (deps.fetch ?? fetch)(kageReferenceVideoUrl(base, preset), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
        if (!dl?.ok) throw new KageError("source_missing", "The reference could not be read", 502, true);
        await writeFile(file, Buffer.from(await dl.arrayBuffer()));
      } else {
        const d = await sb.storage.from("studio-uploads").download(ref!.object_key);
        if (d.error || !d.data) throw new KageError("source_missing", "The reference could not be read", 502, true);
        await writeFile(file, Buffer.from(await d.data.arrayBuffer()));
      }
      const heroImages: Array<{ data: string; media_type: string }> = [];
      for (const x of heroes) { const hd = await sb.storage.from("studio-uploads").download(x.object_key); if (hd.error || !hd.data) throw new KageError("kage_hero_missing", "A hero photo could not be read", 502, true); const buf = Buffer.from(await hd.data.arrayBuffer()); heroImages.push({ data: buf.toString("base64"), media_type: mediaTypeOf(buf) }); }
      const { analysis, frames } = await analyzeReference(file, { ...deps, env: h.env });
      const brief = typeof b.brief === "string" && b.brief.trim() ? b.brief.trim().slice(0, 600) : null;
      const plan = await planRemix({ ...deps, env: h.env, log: h.log }, analysis, frames, heroImages, brief, u);
      const id = randomUUID(), key = planKey(u, id);
      const stored: StoredPlan = { v: 1, reference_asset_id: preset ? null : refId, reference_id: preset?.id ?? null, hero_asset_ids: heroIds, brief, analysis, plan, created_at: new Date().toISOString() };
      const up = await sb.storage.from("studio-outputs").upload(key, Buffer.from(JSON.stringify(stored)), { contentType: "application/json", upsert: false });
      if (up.error) throw up.error;
      await sb.from("studio_events").insert({ user_id: u, kind: "kage", name: "kage_plan", usd: 0, props: { reference: preset?.id ?? refId, shots: plan.shots.length } }).then(() => undefined, () => undefined);
      const cost = kagePlanCost(plan, analysis, h.env);
      res.json({ plan_key: key, analysis: { seconds: analysis.seconds, width: analysis.width, height: analysis.height, shots: analysis.shots, motion: analysis.motion }, plan, ...cost });
    } catch (e) { h.fail(res, e); }
    finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  });
}
