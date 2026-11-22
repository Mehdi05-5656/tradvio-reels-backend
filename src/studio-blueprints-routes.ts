// Blueprints v2 on the server: the price of a version, the quote, the read step (kept per video), the edit plan written
// when a job starts, and the two routes the page calls. The planner (studio-blueprints.ts) is pure; this file does the
// storage, the calls and the checks. The Blueprint worker (tradvio-features-worker, blueprint_job.py) renders the plan.
//
//   GET  /api/studio/blueprints/config  the price of a version, the limits, the looks
//   POST /api/studio/blueprints/read    { asset_id, purpose?, fresh? } -> { seconds, hooks, purpose, suggested_purpose,
//                                       format, has_captions, looks_default, angles } (kept per video and purpose)
//   POST /api/studio/blueprints/captions { job_id, platforms } -> { captions: [{ index, caption, hashtags, youtube_title }] }
//   tool "blueprint_versions" through /api/studio/quote and /api/studio/jobs; the job's options carry plan_key, the
//   edit plan of every version, uploaded before the job is created.
// Switches: STUDIO_BLUEPRINTS_V2_ENABLED (owner only; needs the Claude and ElevenLabs keys) and
// STUDIO_BLUEPRINTS_V2_OPEN (customers). Both default off.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapWord } from "./caption-engine.js";
import { ClipsError, type ClipsDeps } from "./studio-clips.js";
import { docWords, wordsFor } from "./studio-caption-video.js";
import { recordEvent } from "./studio-events.js";
import { creditValueFloor, creditsForCost, PRICE_FLOORS, type PlanLike } from "./studio-pricing.js";
import { keyStills } from "./studio-stunts.js";
import { readSubjects } from "./studio-splitscreen.js";
import { loopById } from "./studio-splitscreen-library.js";
import type { LibraryHelpers } from "./studio-library.js";
import { BLUEPRINT_LIMITS, LOOKS, lookById, planVersion, type Edl, type Hook, type LookId } from "./studio-blueprints.js";
import { focusTrack, writeHooks } from "./studio-blueprints-read.js";
import { ANGLES, angleOk, defaultLooks, isPurpose, readLook, suggestPurpose, writeVersionCaptions, type LookRead, type Purpose, type VersionCaption } from "./studio-blueprints-purpose.js";
import { allowCaption } from "./studio-captions.js";

type Env = Record<string, string | undefined>;
export class BlueprintsError extends ClipsError {}

export const blueprintsV2Enabled = (env: Env = process.env) => env.STUDIO_BLUEPRINTS_V2_ENABLED === "true" && !!env.ANTHROPIC_API_KEY && !!env.ELEVENLABS_API_KEY;
export const blueprintsV2Open = (env: Env = process.env) => blueprintsV2Enabled(env) && env.STUDIO_BLUEPRINTS_V2_OPEN === "true";

/** What a version costs us, USD: the read (one Sonnet call for the openings, one Haiku read of the stills, words
 *  already kept by Captions or heard once at $0.22 an hour) measured at $0.0101 on a 36 s video (Nov 16 2026, local,
 *  metered tokens), spread over at least one version, plus about 1 minute of the $25/month worker and the files kept
 *  30 days: $0.012. v3 adds the set's post captions (one Sonnet call, estimated $0.02 a set, at most $0.004 a version
 *  on sets of 5+): $0.016. Still under the 12-credit floor. To be replaced by the cost ledger's rows once jobs run. */
export const BLUEPRINT_VERSION_COST_USD = 0.016;
/** Credits a version: the margin rule at the cheapest credit, never under today's Blueprint copy floor (12). */
export const blueprintVersionCredits = (plans: PlanLike[]) => Math.max(PRICE_FLOORS.blueprint_copy, creditsForCost(BLUEPRINT_VERSION_COST_USD, creditValueFloor(plans)));
export const BLUEPRINT_READ = { per_day: 20, title_max: 70, ids: /^[a-z0-9-]{1,40}$/ } as const;
/** The gameplay loop under the Split look (from the Split screen library). */
export const SPLIT_GAME = { id: "subway-official", start: 10 } as const;

export const readKey = (u: string, assetId: string) => `${u}/blueprints/read/${assetId}.json`;
export const planKey = (u: string) => `${u}/blueprints/plans/${randomUUID()}.json`;
/** hooks: every opening written for this video; v3 ones carry the purpose they were written for (older ones none).
 *  look: the small model's read of the stills (captions + format), v3. */
export type ReadDoc = { v: 1; at: string; seconds: number; hooks: Array<Hook & { line: string; purpose?: Purpose }>; focus: Edl["focus_track"]; has_captions?: boolean; look?: LookRead | null };
export const hooksFor = (doc: ReadDoc, purpose: Purpose | null) => (purpose ? doc.hooks.filter((h) => h.purpose === purpose) : doc.hooks.filter((h) => !h.purpose));

// ---------------------------------------------------------------------------------------------------
// Options and the quote
// ---------------------------------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
/** The openings and looks as sent by the page, made safe. Throws with a sentence the page shows. */
export function cleanOptions(raw: any, seconds: number): { hooks: Hook[]; looks: LookId[]; captions: boolean; purpose: Purpose | null } {
  const L = BLUEPRINT_LIMITS;
  const purpose = isPurpose(raw?.purpose) ? raw.purpose : null;
  const hooks: Hook[] = [];
  for (const h of Array.isArray(raw?.hooks) ? raw.hooks : []) {
    const id = String(h?.id ?? "").toLowerCase(), start = num(h?.start), end = num(h?.end);
    const title = String(h?.title ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, BLUEPRINT_READ.title_max);
    if (!BLUEPRINT_READ.ids.test(id) || hooks.some((x) => x.id === id)) throw new BlueprintsError("invalid_hooks", "An opening is not valid; read the video again");
    if (!title.replace(/\*/g, "").trim()) throw new BlueprintsError("invalid_hooks", "Every opening needs a title");
    if (!(start >= 0 && end <= seconds + 0.05 && end - start >= L.hook_min - 0.01 && end - start <= L.hook_max + 0.01)) throw new BlueprintsError("invalid_hooks", "An opening is outside the video; read it again");
    const starred = [...title.matchAll(/\*([^*]+)\*/g)].length, odd = (title.match(/\*/g) ?? []).length % 2;
    hooks.push({ id, title: starred > 2 || odd ? title.replace(/\*/g, "") : title, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000,
      ...(purpose && angleOk(purpose, h?.angle) ? { angle: String(h.angle) } : {}) });
  }
  const looks: LookId[] = [];
  for (const l of Array.isArray(raw?.looks) ? raw.looks : []) { const look = lookById(l); if (look && !looks.includes(look.id)) looks.push(look.id); }
  if (!hooks.length) throw new BlueprintsError("invalid_hooks", "Pick at least one opening");
  if (hooks.length > L.max_hooks) throw new BlueprintsError("invalid_hooks", `At most ${L.max_hooks} openings in one run`);
  if (!looks.length) throw new BlueprintsError("invalid_looks", "Pick at least one look");
  if (hooks.length * looks.length > L.max_versions) throw new BlueprintsError("too_many_versions", `At most ${L.max_versions} versions in one run`);
  // false when the video already has captions of its own: none added, the whole picture kept in every look
  return { hooks, looks, captions: raw?.captions !== false, purpose };
}

export type BlueprintsQuote = { tool: "blueprint_versions"; credits: number; options: Record<string, any>; summary: string };
export function quoteBlueprints(env: Env, plans: PlanLike[], asset: { id: string; kind: string; probe: any; name: string } | null, raw: any, who: { owner?: boolean } = {}): BlueprintsQuote {
  if (!blueprintsV2Enabled(env) || (!blueprintsV2Open(env) && !who.owner)) throw new BlueprintsError("blueprints_off", "New Blueprint versions are not open yet", 403);
  if (!asset || asset.kind !== "video") throw new BlueprintsError("asset_required", "Pick a video first");
  const seconds = Number(asset.probe?.duration) || 0;
  checkLength(seconds);
  const { hooks, looks, captions, purpose } = cleanOptions(raw, seconds);
  const per = blueprintVersionCredits(plans), versions = hooks.length * looks.length;
  return { tool: "blueprint_versions", credits: per * versions, options: { hooks, looks, captions, ...(purpose ? { purpose } : {}), versions, per_version: per, seconds, name: String(raw?.name ?? asset.name ?? "").slice(0, 120) },
    summary: `${hooks.length} ${hooks.length === 1 ? "opening" : "openings"} × ${looks.length} ${looks.length === 1 ? "look" : "looks"} × ${per}` };
}
function checkLength(seconds: number) {
  if (!(seconds >= BLUEPRINT_LIMITS.min_seconds)) throw new BlueprintsError("blueprints_too_short", `The video needs at least ${BLUEPRINT_LIMITS.min_seconds} seconds of speech`);
  if (seconds > BLUEPRINT_LIMITS.max_seconds) throw new BlueprintsError("blueprints_too_long", `Versions are made from videos up to ${BLUEPRINT_LIMITS.max_seconds / 60} minutes; make clips from this one first`);
}

// ---------------------------------------------------------------------------------------------------
// The read step: openings and the face track, kept per video
// ---------------------------------------------------------------------------------------------------
export type BlueprintsDeps = ClipsDeps & {
  /** the words, kept by Captions (tests replace it) */ words?: (sb: SupabaseClient, u: string, assetId: string) => Promise<CapWord[]>;
  /** stills of the video for the face reader */ stills?: (url: string, seconds: number, dir: string) => Promise<Array<{ at: number; jpeg: Buffer }>>;
  hooks?: (words: CapWord[], n: number, userId: string, purpose?: Purpose) => Promise<Hook[]>;
  faces?: (frames: Array<{ t: number; jpg: Buffer }>, userId: string) => Promise<Edl["focus_track"]>;
  /** the small model's read of the stills: burned-in captions + format (tests replace it) */
  lookRead?: (frames: Array<{ t: number; jpg: Buffer }>, userId: string) => Promise<LookRead | null>;
  captions?: (o: Parameters<typeof writeVersionCaptions>[1], userId: string) => Promise<VersionCaption[]>;
};
/** The words said between two times, for the opening's quote on the page. */
export const lineOf = (words: CapWord[], a: number, b: number) => words.filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 <= b).map((w) => w.text).join(" ").slice(0, 240);

async function signed(sb: SupabaseClient, u: string, assetId: string) {
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new BlueprintsError("video_not_found", "That video is not in your library", 404);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 3600);
  if (s.error || !s.data?.signedUrl) throw new BlueprintsError("source_missing", "The video could not be read", 502, true);
  return { url: s.data.signedUrl, asset: a.data as { id: string; name: string; probe: any } };
}
async function kept(sb: SupabaseClient, u: string, assetId: string): Promise<ReadDoc | null> {
  const r = await sb.storage.from("studio-outputs").download(readKey(u, assetId));
  if (r.error || !r.data) return null;
  try { const d = JSON.parse(await r.data.text()); return d?.v === 1 && Array.isArray(d.hooks) ? d as ReadDoc : null; } catch { return null; }
}
async function keep(sb: SupabaseClient, u: string, assetId: string, doc: ReadDoc, log?: (l: string) => void) {
  // plain text: the bucket refuses application/json (see Stunts)
  const r = await sb.storage.from("studio-outputs").upload(readKey(u, assetId), Buffer.from(JSON.stringify(doc)), { contentType: "text/plain", upsert: true }).then((x: any) => x?.error ?? null, (e: any) => e);
  if (r) log?.(`[blueprints] read not kept for ${assetId}: ${String(r?.message ?? r).slice(0, 120)}`);
}

/** The openings, the face track and the look read for one library video: kept ones, or read now (and kept).
 *  Openings are kept per purpose: asking for a purpose that has none yet writes them (that counts as a read).
 *  With no purpose asked, the purpose is suggested from where the video came from, the sign-up role and the look read.
 *  `fresh` writes more openings for the purpose and adds the new ones (the face track and look read stay). */
export async function readFor(sb: SupabaseClient, deps: BlueprintsDeps, u: string, assetId: string, o: { fresh?: boolean; allowNew?: boolean; n?: number; purpose?: Purpose | null; role?: string | null } = {}): Promise<{ doc: ReadDoc; added: ReadDoc["hooks"]; cached: boolean; purpose: Purpose; suggested: Purpose }> {
  const { url, asset } = await signed(sb, u, assetId);
  const seconds = Number(asset.probe?.duration) || 0;
  checkLength(seconds);
  const old = await kept(sb, u, assetId);
  const dir = await mkdtemp(join(tmpdir(), "studio-bp-read-"));
  try {
    // the stills, read once and shared by the face reader and the look read
    let shots: Promise<Array<{ t: number; jpg: Buffer }>> | null = null;
    const stills = () => (shots ??= (deps.stills ?? keyStills)(url, seconds, dir).then((s) => s.filter((x) => x.jpeg?.length).map((x) => ({ t: x.at, jpg: x.jpeg })), () => []));
    const lookNow = async (): Promise<LookRead | null> => {
      const frames = await stills();
      if (!frames.length) return null;
      return (deps.lookRead ? deps.lookRead(frames, u) : readLook(deps, frames, u)).catch((e) => { deps.log?.(`[blueprints] no look read for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); return null; });
    };
    // the look read is cheap ($0.0004) and kept: a read kept before it existed gets it once
    const look = old?.look !== undefined && old.look !== null ? old.look : await lookNow();
    // captioned by Clone8 Captions or Clips, or seen in the stills
    const has_captions = !!asset.probe?.captions || (look ? look.captions : old?.has_captions === true);
    const suggested = suggestPurpose({ probe: asset.probe, role: o.role, look });
    const purpose: Purpose = o.purpose ?? suggested;
    const have = old ? hooksFor(old, purpose) : [];
    const lookChanged = !old || old.look !== look || old.has_captions !== has_captions;
    if (old && have.length && !o.fresh) {
      const doc: ReadDoc = { ...old, look, has_captions };
      if (lookChanged) await keep(sb, u, assetId, doc, deps.log);
      return { doc, added: have, cached: true, purpose, suggested };
    }
    if (o.allowNew === false) throw new BlueprintsError("blueprints_rate_limited", "That is a lot of reading for one day; try again tomorrow", 429);
    const t0 = Date.now();
    const words = deps.words ? await deps.words(sb, u, assetId) : docWords(await wordsFor(sb, deps, u, assetId));
    if (words.length < 6) throw new BlueprintsError("blueprints_no_speech", "There is not enough speech in this video to write openings", 422);
    const n = o.n ?? 5;
    const write = deps.hooks ? deps.hooks(words, n, u, purpose) : writeHooks(deps, words, { n, userId: u, purpose });
    const faces = old?.focus ? Promise.resolve(old.focus) : (async () => {
      const frames = await stills();
      if (!frames.length) return [];
      return deps.faces ? deps.faces(frames, u) : focusTrack(await readSubjects(deps, frames, u));
    })().catch((e) => { deps.log?.(`[blueprints] no face read for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); return []; });
    const [hooks, focus] = await Promise.all([write, faces]);
    const seen = new Set(have.map((h) => `${h.start}-${h.end}`));
    const ids = new Set((old?.hooks ?? []).map((h) => h.id));
    const stamp = Date.now().toString(36);
    const added = hooks.filter((h) => !seen.has(`${h.start}-${h.end}`)).map((h, i) => {
      const id = ids.has(h.id) || old ? `${h.id}-${purpose}-${stamp}-${i}`.slice(0, 40) : h.id;
      return { ...h, id, purpose, line: lineOf(words, h.start ?? 0, h.end ?? 0) };
    }) as ReadDoc["hooks"];
    if (!added.length && !have.length) throw new BlueprintsError("blueprints_no_hooks", "No line in this video works as an opening; try a video with more speech", 422);
    // the newest 30 per purpose are kept, older purposes' openings stay
    const mine = [...have, ...added].slice(-30);
    const doc: ReadDoc = { v: 1, at: new Date().toISOString(), seconds, hooks: [...(old?.hooks ?? []).filter((h) => h.purpose !== purpose), ...mine], focus: focus ?? [], has_captions, look };
    await keep(sb, u, assetId, doc, deps.log);
    deps.log?.(`[blueprints] read ${JSON.stringify({ asset: assetId, seconds: Math.round(seconds), words: words.length, purpose, suggested, format: look?.format ?? null, hooks: added.length, faces: doc.focus.length, has_captions, fresh: !!o.fresh, ms: Date.now() - t0 })}`);
    return { doc, added, cached: false, purpose, suggested };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// The edit plan: every version's EDL, uploaded before the job exists (the job carries its key)
// ---------------------------------------------------------------------------------------------------
export type Plan = { v: 1; asset_id: string; seconds: number; versions: Array<{ index: number; hook_id: string; look_id: LookId; edl: Edl }> };
export function buildPlan(assetId: string, seconds: number, words: CapWord[], focus: Edl["focus_track"], hooks: Hook[], looks: LookId[], env: Env = process.env, captions = true): Plan {
  const versions: Plan["versions"] = [];
  const game = loopById(SPLIT_GAME.id) ? { key: SPLIT_GAME.id, start: SPLIT_GAME.start } : null;
  for (const h of hooks) for (const id of looks) {
    const look = lookById(id)!;
    versions.push({ index: versions.length + 1, hook_id: h.id, look_id: id, edl: planVersion({ words, duration: seconds, hook: h, look, focusTrack: focus, game, env, captions }) });
  }
  return { v: 1, asset_id: assetId, seconds, versions };
}
export async function writePlan(sb: SupabaseClient, deps: BlueprintsDeps, u: string, asset: { id: string; probe: any }, options: { hooks: Hook[]; looks: LookId[]; captions?: boolean }): Promise<string> {
  const seconds = Number(asset.probe?.duration) || 0;
  const words = deps.words ? await deps.words(sb, u, asset.id) : docWords(await wordsFor(sb, deps, u, asset.id));
  const read = await kept(sb, u, asset.id);
  const plan = buildPlan(asset.id, seconds, words, read?.focus ?? [], options.hooks, options.looks, deps.env, options.captions !== false);
  const key = planKey(u);
  const r = await sb.storage.from("studio-outputs").upload(key, Buffer.from(JSON.stringify(plan)), { contentType: "text/plain", upsert: false });
  if (r.error) throw new BlueprintsError("plan_not_saved", "The versions could not be planned; try again", 502, true);
  return key;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
export function registerBlueprints(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log" | "plans"> & { isOwner: (req: any, sb: SupabaseClient) => Promise<boolean> }, deps: BlueprintsDeps = {}): void {
  const gate = async (req: any, sb: SupabaseClient) => {
    const owner = await h.isOwner(req, sb);
    if (!blueprintsV2Enabled(h.env) || (!blueprintsV2Open(h.env) && !owner)) throw new BlueprintsError("blueprints_off", "New Blueprint versions are not open yet", 403);
    return owner;
  };
  app.get("/api/studio/blueprints/config", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      await gate(req, h.sbFn());
      const L = BLUEPRINT_LIMITS;
      res.json({ per_version: blueprintVersionCredits(h.plans), limits: { min_seconds: L.min_seconds, max_seconds: L.max_seconds, max_versions: L.max_versions, max_hooks: L.max_hooks, max_looks: L.max_looks, title_max: BLUEPRINT_READ.title_max }, looks: LOOKS.map((l) => ({ id: l.id, name: l.name, blurb: l.blurb })) });
    } catch (e) { h.fail(res, e); }
  });
  app.post("/api/studio/blueprints/read", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      const owner = await gate(req, sb);
      const assetId = String(req.body?.asset_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new BlueprintsError("video_not_found", "Pick a video", 404);
      const c = await sb.from("studio_customers").select("status,owner_pass,onboarding").eq("user_id", u).maybeSingle();
      if (!(owner || (c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass)))) throw new BlueprintsError("subscription_required", "Blueprint versions come with a plan", 409);
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "blueprints_read").gte("created_at", since);
      const purpose = isPurpose(req.body?.purpose) ? req.body.purpose : null;
      const role = typeof (c.data as any)?.onboarding?.role === "string" ? (c.data as any).onboarding.role : null;
      const out = await readFor(sb, { ...deps, env: h.env, log: h.log }, u, assetId, { fresh: req.body?.fresh === true, purpose, role, allowNew: owner || (n.count ?? 0) < BLUEPRINT_READ.per_day });
      if (!out.cached) recordEvent({ user_id: u, kind: "feature", name: "blueprints_read", props: { asset: assetId, hooks: out.added.length, seconds: out.doc.seconds, purpose: out.purpose, suggested: out.suggested, format: out.doc.look?.format ?? null } });
      // a fresh read answers with the new openings only (the page adds them to the ones on screen)
      const strip = (x: ReadDoc["hooks"]) => x.map(({ purpose: _p, ...rest }) => rest);
      res.json({ seconds: out.doc.seconds, hooks: strip(req.body?.fresh === true ? out.added : hooksFor(out.doc, out.purpose)), has_captions: out.doc.has_captions === true,
        purpose: out.purpose, suggested_purpose: out.suggested, format: out.doc.look?.format ?? null, looks_default: defaultLooks(out.purpose, out.doc.look), angles: ANGLES[out.purpose] });
    } catch (e) { h.fail(res, e); }
  });
  // A different post caption for every version of a finished set (kept per job and networks: asking again is free)
  app.post("/api/studio/blueprints/captions", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      await gate(req, sb);
      const jobId = String(req.body?.job_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new BlueprintsError("job_not_found", "Pick a set of versions", 404);
      const platforms = [...new Set<string>((Array.isArray(req.body?.platforms) ? req.body.platforms : []).map(String))].filter((x) => /^[a-z]{1,12}$/.test(x)).slice(0, 8).sort();
      const out = await versionCaptionsFor(sb, { ...deps, env: h.env, log: h.log }, u, jobId, platforms, { fresh: req.body?.fresh === true });
      res.json({ captions: out });
    } catch (e) { h.fail(res, e); }
  });
}

export const captionsKey = (u: string, jobId: string, platforms: string[]) => `${u}/blueprints/captions/${jobId}-${platforms.join("_") || "default"}.json`;
/** The captions of a finished set: kept ones, or written now in one call from the video's words and each version's
 *  opening (line, title, angle) and look. */
export async function versionCaptionsFor(sb: SupabaseClient, deps: BlueprintsDeps, u: string, jobId: string, platforms: string[], o: { fresh?: boolean } = {}): Promise<VersionCaption[]> {
  const j = await sb.from("studio_jobs").select("id,user_id,tool,status,asset_id,options,outputs").eq("id", jobId).eq("user_id", u).maybeSingle();
  if (j.error) throw j.error;
  const job = j.data as any;
  if (!job || job.tool !== "blueprint_versions") throw new BlueprintsError("job_not_found", "That set of versions is not in your account", 404);
  const outs: any[] = Array.isArray(job.outputs) ? job.outputs : [];
  if (!outs.length) throw new BlueprintsError("job_not_ready", "Captions come once the versions are made", 409);
  const key = captionsKey(u, jobId, platforms);
  if (!o.fresh) {
    const r = await sb.storage.from("studio-outputs").download(key);
    if (!r.error && r.data) { try { const d = JSON.parse(await r.data.text()); if (Array.isArray(d?.captions) && d.captions.length) return d.captions; } catch { /* write again */ } }
  }
  if (!allowCaption(u)) throw new BlueprintsError("caption_rate_limited", "That is a lot of captions for one hour; try again soon", 429);
  const words = job.asset_id ? (deps.words ? await deps.words(sb, u, job.asset_id) : docWords(await wordsFor(sb, deps, u, job.asset_id))) : [];
  const hooks: Hook[] = Array.isArray(job.options?.hooks) ? job.options.hooks : [];
  const purpose: Purpose = isPurpose(job.options?.purpose) ? job.options.purpose : "own";
  const versions = outs.map((x) => {
    const hk = hooks.find((y) => y.id === x.hook_id);
    return { index: Number(x.index), title: hk?.title ?? "", line: hk ? lineOf(words, hk.start ?? 0, hk.end ?? 0) : "", angle: hk?.angle ?? null, look: lookById(x.look_id)?.name ?? String(x.look_id ?? "") };
  }).filter((v) => Number.isInteger(v.index));
  const input = { purpose, words, versions, platforms };
  const captions = deps.captions ? await deps.captions(input, u) : await writeVersionCaptions(deps, input, u);
  if (!captions.length) throw new BlueprintsError("captions_failed", "The captions could not be written; try again", 502, true);
  const w = await sb.storage.from("studio-outputs").upload(key, Buffer.from(JSON.stringify({ at: new Date().toISOString(), captions })), { contentType: "text/plain", upsert: true }).then((x: any) => x?.error ?? null, (e: any) => e);
  if (w) deps.log?.(`[blueprints] captions not kept for ${jobId}: ${String(w?.message ?? w).slice(0, 120)}`);
  return captions;
}
