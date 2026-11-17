// Blueprints v2 on the server: the price of a version, the quote, the read step (kept per video), the edit plan written
// when a job starts, and the two routes the page calls. The planner (studio-blueprints.ts) is pure; this file does the
// storage, the calls and the checks. The Blueprint worker (tradvio-features-worker, blueprint_job.py) renders the plan.
//
//   GET  /api/studio/blueprints/config  the price of a version, the limits, the looks
//   POST /api/studio/blueprints/read    { asset_id, fresh? } -> { seconds, hooks } (kept; fresh writes more openings)
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

type Env = Record<string, string | undefined>;
export class BlueprintsError extends ClipsError {}

export const blueprintsV2Enabled = (env: Env = process.env) => env.STUDIO_BLUEPRINTS_V2_ENABLED === "true" && !!env.ANTHROPIC_API_KEY && !!env.ELEVENLABS_API_KEY;
export const blueprintsV2Open = (env: Env = process.env) => blueprintsV2Enabled(env) && env.STUDIO_BLUEPRINTS_V2_OPEN === "true";

/** What a version costs us, USD: the read (one Sonnet call for the openings, one Haiku read of the stills, words
 *  already kept by Captions or heard once at $0.22 an hour) measured at $0.0101 on a 36 s video (Nov 16 2026, local,
 *  metered tokens), spread over at least one version, plus about 1 minute of the $25/month worker and the files kept
 *  30 days. Rounded up to $0.012. To be replaced by the cost ledger's rows once jobs run. */
export const BLUEPRINT_VERSION_COST_USD = 0.012;
/** Credits a version: the margin rule at the cheapest credit, never under today's Blueprint copy floor (12). */
export const blueprintVersionCredits = (plans: PlanLike[]) => Math.max(PRICE_FLOORS.blueprint_copy, creditsForCost(BLUEPRINT_VERSION_COST_USD, creditValueFloor(plans)));
export const BLUEPRINT_READ = { per_day: 20, title_max: 70, ids: /^[a-z0-9-]{1,40}$/ } as const;
/** The gameplay loop under the Split look (from the Split screen library). */
export const SPLIT_GAME = { id: "subway-official", start: 10 } as const;

export const readKey = (u: string, assetId: string) => `${u}/blueprints/read/${assetId}.json`;
export const planKey = (u: string) => `${u}/blueprints/plans/${randomUUID()}.json`;
export type ReadDoc = { v: 1; at: string; seconds: number; hooks: Array<Hook & { line: string }>; focus: Edl["focus_track"] };

// ---------------------------------------------------------------------------------------------------
// Options and the quote
// ---------------------------------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
/** The openings and looks as sent by the page, made safe. Throws with a sentence the page shows. */
export function cleanOptions(raw: any, seconds: number): { hooks: Hook[]; looks: LookId[] } {
  const L = BLUEPRINT_LIMITS;
  const hooks: Hook[] = [];
  for (const h of Array.isArray(raw?.hooks) ? raw.hooks : []) {
    const id = String(h?.id ?? "").toLowerCase(), start = num(h?.start), end = num(h?.end);
    const title = String(h?.title ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, BLUEPRINT_READ.title_max);
    if (!BLUEPRINT_READ.ids.test(id) || hooks.some((x) => x.id === id)) throw new BlueprintsError("invalid_hooks", "An opening is not valid; read the video again");
    if (!title.replace(/\*/g, "").trim()) throw new BlueprintsError("invalid_hooks", "Every opening needs a title");
    if (!(start >= 0 && end <= seconds + 0.05 && end - start >= L.hook_min - 0.01 && end - start <= L.hook_max + 0.01)) throw new BlueprintsError("invalid_hooks", "An opening is outside the video; read it again");
    const starred = [...title.matchAll(/\*([^*]+)\*/g)].length, odd = (title.match(/\*/g) ?? []).length % 2;
    hooks.push({ id, title: starred > 2 || odd ? title.replace(/\*/g, "") : title, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  }
  const looks: LookId[] = [];
  for (const l of Array.isArray(raw?.looks) ? raw.looks : []) { const look = lookById(l); if (look && !looks.includes(look.id)) looks.push(look.id); }
  if (!hooks.length) throw new BlueprintsError("invalid_hooks", "Pick at least one opening");
  if (hooks.length > L.max_hooks) throw new BlueprintsError("invalid_hooks", `At most ${L.max_hooks} openings in one run`);
  if (!looks.length) throw new BlueprintsError("invalid_looks", "Pick at least one look");
  if (hooks.length * looks.length > L.max_versions) throw new BlueprintsError("too_many_versions", `At most ${L.max_versions} versions in one run`);
  return { hooks, looks };
}

export type BlueprintsQuote = { tool: "blueprint_versions"; credits: number; options: Record<string, any>; summary: string };
export function quoteBlueprints(env: Env, plans: PlanLike[], asset: { id: string; kind: string; probe: any; name: string } | null, raw: any, who: { owner?: boolean } = {}): BlueprintsQuote {
  if (!blueprintsV2Enabled(env) || (!blueprintsV2Open(env) && !who.owner)) throw new BlueprintsError("blueprints_off", "New Blueprint versions are not open yet", 403);
  if (!asset || asset.kind !== "video") throw new BlueprintsError("asset_required", "Pick a video first");
  const seconds = Number(asset.probe?.duration) || 0;
  checkLength(seconds);
  const { hooks, looks } = cleanOptions(raw, seconds);
  const per = blueprintVersionCredits(plans), versions = hooks.length * looks.length;
  return { tool: "blueprint_versions", credits: per * versions, options: { hooks, looks, versions, per_version: per, seconds, name: String(raw?.name ?? asset.name ?? "").slice(0, 120) },
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
  hooks?: (words: CapWord[], n: number, userId: string) => Promise<Hook[]>;
  faces?: (frames: Array<{ t: number; jpg: Buffer }>, userId: string) => Promise<Edl["focus_track"]>;
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

/** The openings and the face track for one library video: kept ones, or read now (and kept). `fresh` writes more
 *  openings and adds the new ones to the kept set (the face track is kept as it was). */
export async function readFor(sb: SupabaseClient, deps: BlueprintsDeps, u: string, assetId: string, o: { fresh?: boolean; allowNew?: boolean; n?: number } = {}): Promise<{ doc: ReadDoc; added: ReadDoc["hooks"]; cached: boolean }> {
  const { url, asset } = await signed(sb, u, assetId);
  const seconds = Number(asset.probe?.duration) || 0;
  checkLength(seconds);
  const old = await kept(sb, u, assetId);
  if (old && !o.fresh) return { doc: old, added: old.hooks, cached: true };
  if (o.allowNew === false) throw new BlueprintsError("blueprints_rate_limited", "That is a lot of reading for one day; try again tomorrow", 429);
  const t0 = Date.now();
  const words = deps.words ? await deps.words(sb, u, assetId) : docWords(await wordsFor(sb, deps, u, assetId));
  if (words.length < 6) throw new BlueprintsError("blueprints_no_speech", "There is not enough speech in this video to write openings", 422);
  const n = o.n ?? 5;
  const write = deps.hooks ? deps.hooks(words, n, u) : writeHooks(deps, words, { n, userId: u });
  let focus = old?.focus ?? null;
  const dir = await mkdtemp(join(tmpdir(), "studio-bp-read-"));
  try {
    const faces = focus ? Promise.resolve(focus) : (async () => {
      const stills = await (deps.stills ?? keyStills)(url, seconds, dir).catch(() => []);
      const frames = stills.filter((s) => s.jpeg?.length).map((s) => ({ t: s.at, jpg: s.jpeg }));
      if (!frames.length) return [];
      return deps.faces ? deps.faces(frames, u) : focusTrack(await readSubjects(deps, frames, u));
    })().catch((e) => { deps.log?.(`[blueprints] no face read for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); return []; });
    const [hooks, track] = await Promise.all([write, faces]);
    focus = track;
    const seen = new Set((old?.hooks ?? []).map((h) => `${h.start}-${h.end}`));
    const stamp = Date.now().toString(36);
    const added = hooks.filter((h) => !seen.has(`${h.start}-${h.end}`)).map((h, i) => ({ ...h, id: old ? `${h.id}-${stamp}-${i}`.slice(0, 40) : h.id, line: lineOf(words, h.start ?? 0, h.end ?? 0) })) as ReadDoc["hooks"];
    if (!added.length && !old) throw new BlueprintsError("blueprints_no_hooks", "No line in this video works as an opening; try a video with more speech", 422);
    const doc: ReadDoc = { v: 1, at: new Date().toISOString(), seconds, hooks: [...(old?.hooks ?? []), ...added].slice(0, 30), focus: focus ?? [] };
    await keep(sb, u, assetId, doc, deps.log);
    deps.log?.(`[blueprints] read ${JSON.stringify({ asset: assetId, seconds: Math.round(seconds), words: words.length, hooks: added.length, faces: doc.focus.length, fresh: !!o.fresh, ms: Date.now() - t0 })}`);
    return { doc, added, cached: false };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// The edit plan: every version's EDL, uploaded before the job exists (the job carries its key)
// ---------------------------------------------------------------------------------------------------
export type Plan = { v: 1; asset_id: string; seconds: number; versions: Array<{ index: number; hook_id: string; look_id: LookId; edl: Edl }> };
export function buildPlan(assetId: string, seconds: number, words: CapWord[], focus: Edl["focus_track"], hooks: Hook[], looks: LookId[], env: Env = process.env): Plan {
  const versions: Plan["versions"] = [];
  const game = loopById(SPLIT_GAME.id) ? { key: SPLIT_GAME.id, start: SPLIT_GAME.start } : null;
  for (const h of hooks) for (const id of looks) {
    const look = lookById(id)!;
    versions.push({ index: versions.length + 1, hook_id: h.id, look_id: id, edl: planVersion({ words, duration: seconds, hook: h, look, focusTrack: focus, game, env }) });
  }
  return { v: 1, asset_id: assetId, seconds, versions };
}
export async function writePlan(sb: SupabaseClient, deps: BlueprintsDeps, u: string, asset: { id: string; probe: any }, options: { hooks: Hook[]; looks: LookId[] }): Promise<string> {
  const seconds = Number(asset.probe?.duration) || 0;
  const words = deps.words ? await deps.words(sb, u, asset.id) : docWords(await wordsFor(sb, deps, u, asset.id));
  const read = await kept(sb, u, asset.id);
  const plan = buildPlan(asset.id, seconds, words, read?.focus ?? [], options.hooks, options.looks, deps.env);
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
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(owner || (c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass)))) throw new BlueprintsError("subscription_required", "Blueprint versions come with a plan", 409);
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "blueprints_read").gte("created_at", since);
      const out = await readFor(sb, { ...deps, env: h.env, log: h.log }, u, assetId, { fresh: req.body?.fresh === true, allowNew: owner || (n.count ?? 0) < BLUEPRINT_READ.per_day });
      if (!out.cached) recordEvent({ user_id: u, kind: "feature", name: "blueprints_read", props: { asset: assetId, hooks: out.added.length, seconds: out.doc.seconds } });
      // a fresh read answers with the new openings only (the page adds them to the ones on screen)
      res.json({ seconds: out.doc.seconds, hooks: req.body?.fresh === true ? out.added : out.doc.hooks });
    } catch (e) { h.fail(res, e); }
  });
}
