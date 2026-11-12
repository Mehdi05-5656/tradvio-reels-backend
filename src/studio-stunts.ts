// Clone8 Studio: Stunts. A person's own clip, with impossible endings on the moments they choose: the real shot runs
// straight into a generated one (the forklift drives through the wall, they lift the car over their head), then the
// video cuts back to them as if nothing happened.
//
// How a run makes one:
//   1. Ideas (free, before any job): a still every second and the words go to Claude, which proposes the moments an
//      ending fits and three gags for each. The person picks, edits or writes their own.
//   2. For each gag the exact frame at that moment is the first frame of an image-to-video request (Wan 3.0 on the
//      platform API, 5 s, 720p, with sound). A model test on Nov 11 2026 chose it: it followed the gags best and is
//      among the cheapest (docs/stunts-test).
//   3. A vision check looks at the result beside the real frame: did something impossible happen, is it the same
//      person and place. A broken one is made once more; if that is broken too it is left out and not charged.
//   4. The join: the gag is sped up (the model is slower than a punchline), its colour brought to the real frame's,
//      its sound levelled, and the timeline is real → gag → real from where the person carries on.
//   5. Price: per gag, from the model's price with an allowance for the second try, at the standard margin. Charged
//      for the gags that made it into the video; the rest goes back.
//
// Off until STUDIO_STUNTS_ENABLED=true; until STUDIO_STUNTS_OPEN=true only the owner's account can use it.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeJson, ClipsError, ffmpeg, type ClipsDeps } from "./studio-clips.js";
import { docWords, wordsFor } from "./studio-caption-video.js";
import { cutGate, roomForAnother } from "./studio-capacity.js";
import { recordCost } from "./studio-costs.js";
import { recordEvent } from "./studio-events.js";
import { hf, outputUrls } from "./studio-instruments.js";
import { creditValueFloor, creditsForCost, MARGIN_TARGET, type PlanLike } from "./studio-pricing.js";
import { extractFrame, makePoster, probeDimensions, probeSeconds, probeStream, RecastError } from "./studio-recast.js";
import type { LibraryHelpers } from "./studio-library.js";

type Env = Record<string, string | undefined>;
export class StuntsError extends ClipsError {}

// ---------------------------------------------------------------------------------------------------
// Switches, limits, price
// ---------------------------------------------------------------------------------------------------
export const stuntsEnabled = (env: Env = process.env) => env.STUDIO_STUNTS_ENABLED === "true" && !!env.HIGGSFIELD_API_KEY && !!env.ANTHROPIC_API_KEY;
/** Open to every customer. Until then only the owner's account (the Studio admin) can make them: the test videos. */
export const stuntsOpen = (env: Env = process.env) => stuntsEnabled(env) && env.STUDIO_STUNTS_OPEN === "true";

export const STUNT_LIMITS = { min_seconds: 3, max_seconds: 60, max_gags: 6, gap: 1.5, prompt_min: 12, prompt_max: 600, ideas_per_day: 20, stills: 40, gag_seconds: 5, tries: 2 };
export const STUNT_SPEEDS = [1.5, 2, 2.5] as const;
export const STUNT_STYLE = " Shot on a phone, realistic, the same person, the same place, the same light. One continuous take with no cut; the camera follows the action handheld. Fast, physical, loud.";
export const stuntEndpoint = (env: Env = process.env) => env.STUDIO_STUNTS_ENDPOINT || "alibaba/wan-3.0/image-to-video";
/** What one second of the model costs us at 720p (the platform's quoted rate on Nov 11 2026; STUDIO_STUNTS_USD_PER_SECOND overrides). */
export const stuntUsdPerSecond = (env: Env = process.env) => { const n = Number(env.STUDIO_STUNTS_USD_PER_SECOND); return n > 0 ? n : 0.075; };
/** One generation, and what a gag is priced on: the generation, half of another (one gag in two is made twice), and
 *  the reading around it (ideas, the check; an estimate until runs are measured). */
export const STUNT_RETRY_SHARE = 0.5, STUNT_READING_USD = 0.03;
export const stuntGenerationUsd = (env: Env = process.env) => Math.round(stuntUsdPerSecond(env) * STUNT_LIMITS.gag_seconds * 10000) / 10000;
export const stuntGagCostUsd = (env: Env = process.env) => Math.round((stuntGenerationUsd(env) * (1 + STUNT_RETRY_SHARE) + STUNT_READING_USD) * 10000) / 10000;
export const stuntGagCredits = (env: Env, plans: PlanLike[]) => Math.max(1, creditsForCost(stuntGagCostUsd(env), creditValueFloor(plans), MARGIN_TARGET));

// ---------------------------------------------------------------------------------------------------
// The gags a person asked for: clean, in order, apart from each other, inside the video
// ---------------------------------------------------------------------------------------------------
export type Gag = { at: number; resume: number; title: string; prompt: string };
const round2 = (x: number) => Math.round(x * 100) / 100;
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanGags(raw: unknown, seconds: number): Gag[] {
  if (!Array.isArray(raw) || !raw.length) throw new StuntsError("stunts_no_gag", "Pick at least one moment");
  if (raw.length > STUNT_LIMITS.max_gags) throw new StuntsError("stunts_too_many", `Up to ${STUNT_LIMITS.max_gags} stunts in one video`);
  const out: Gag[] = [];
  for (const g of raw) {
    const at = Number((g as any)?.at), prompt = text((g as any)?.prompt, STUNT_LIMITS.prompt_max);
    if (!Number.isFinite(at) || at < 1 || at > seconds - 0.05) throw new StuntsError("stunts_bad_moment", "A stunt has to start inside the video, after its first second");
    if (prompt.length < STUNT_LIMITS.prompt_min) throw new StuntsError("stunts_bad_prompt", "Say what happens in each stunt, in a sentence");
    const r = Number((g as any)?.resume);
    out.push({ at: round2(at), resume: round2(Number.isFinite(r) && r >= at ? Math.min(r, seconds) : at), title: text((g as any)?.title, 60) || prompt.slice(0, 60), prompt });
  }
  out.sort((a, b) => a.at - b.at);
  for (let i = 1; i < out.length; i++) {
    if (out[i].at - out[i - 1].at < STUNT_LIMITS.gap) throw new StuntsError("stunts_too_close", "Two stunts are too close together; leave a second or two of real video between them");
    // real video between two gags never runs backwards: the one before hands over at this one's start at the latest
    if (out[i - 1].resume > out[i].at - 0.5) out[i - 1].resume = out[i - 1].at;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------------------------------
export type StuntsQuote = { tool: "stunts"; credits: number; options: Record<string, any>; summary: string };
export function quoteStunts(env: Env, plans: PlanLike[], asset: { id: string; kind: string; probe: any; name: string } | null, raw: any, who: { owner?: boolean } = {}): StuntsQuote {
  if (!stuntsEnabled(env)) throw new StuntsError("stunts_off", "Stunts are not switched on yet", 503);
  if (!stuntsOpen(env) && !who.owner) throw new StuntsError("stunts_off", "Stunts are not open yet", 403);
  if (!asset || asset.kind !== "video") throw new StuntsError("video_not_found", "Pick a video of yours", 404);
  const seconds = Number(asset.probe?.duration);
  if (!(seconds > 0)) throw new StuntsError("asset_not_inspected", "The video is still being checked", 409);
  if (seconds < STUNT_LIMITS.min_seconds) throw new StuntsError("stunts_too_short", `The video needs to be at least ${STUNT_LIMITS.min_seconds} seconds`);
  if (seconds > STUNT_LIMITS.max_seconds) throw new StuntsError("stunts_too_long", `Stunts take videos up to ${STUNT_LIMITS.max_seconds} seconds; trim this one or make a clip from it first`);
  const o = raw && typeof raw === "object" ? raw : {};
  if (o.rights !== true) throw new StuntsError("stunts_rights", "Confirm that this is you, or people who agreed to be in it");
  const gags = cleanGags(o.gags, seconds);
  const speed = (STUNT_SPEEDS as readonly number[]).includes(Number(o.speed)) ? Number(o.speed) : 2;
  const each = stuntGagCredits(env, plans);
  return { tool: "stunts", credits: each * gags.length,
    options: { gags, speed, rights: true, seconds: round2(seconds), name: text(asset.name, 120), credits_per_gag: each, cost_usd: round2(stuntGagCostUsd(env) * gags.length), endpoint: stuntEndpoint(env) },
    summary: `${gags.length} ${gags.length === 1 ? "stunt" : "stunts"} · ${Math.round(seconds)} s video` };
}

// ---------------------------------------------------------------------------------------------------
// Ideas: where an ending fits, and three gags for each
// ---------------------------------------------------------------------------------------------------
export type Idea = { title: string; prompt: string };
export type Moment = { at: number; resume: number; why: string; ideas: Idea[] };
export const IDEAS_SYSTEM = `You write visual gags for short vertical videos. A person filmed a normal clip of themselves. At a few moments the real shot will run, with no cut, into a generated continuation where something physically impossible happens to them or to something in the frame; then the video cuts back to them as if nothing happened. That contrast is the joke.

You get stills of the clip (one about every second, each labelled with its time) and the words spoken with their times.

Pick the moments where an ending fits: the end of a sentence or a thought, a pause, a gesture, the instant they touch or point at something. Never in the middle of a word. Never in the first second. Leave at least 4 seconds between moments. Fewer strong moments beat many weak ones.

For each moment give:
- at: the time in seconds the real shot hands over (the generated shot starts from the frame at exactly this time).
- resume: the time the real video carries on from afterwards. Use the start of their next sentence when there is dead air after "at"; otherwise the same time as "at".
- why: a few words on why this moment.
- ideas: three different gags. Each has a short title (2 to 5 words) and a prompt.

A good prompt is one or two sentences in the present tense that say exactly what happens, physically and in order, starting from what is in that frame: who moves, what they touch, what it does, how the camera follows. Use what is really in the picture (the chair, the car, the dog, the coffee) and what they just said. Big, fast, physical, absurd: things launch, explode, get lifted, get yanked away, fall from the sky, drive through walls. The three ideas must differ in kind, not in detail.

Never: injury shown in detail, blood, weapons aimed at people, anything sexual, anything about a real brand or a named public figure, anything that changes who the person is or what they look like, text on screen, a second person who is not in the frame.`;
export const IDEAS_SCHEMA = { type: "object", additionalProperties: false, required: ["moments"], properties: { moments: { type: "array", items: { type: "object", additionalProperties: false, required: ["at", "resume", "why", "ideas"],
  properties: { at: { type: "number" }, resume: { type: "number" }, why: { type: "string" }, ideas: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "prompt"], properties: { title: { type: "string" }, prompt: { type: "string" } } } } } } } } };

/** Claude's moments made safe to show: inside the video, apart, three clean ideas each, best-first order kept by time. */
export function cleanMoments(raw: unknown, seconds: number): Moment[] {
  const out: Moment[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    const at = Number((m as any)?.at);
    if (!Number.isFinite(at) || at < 1 || at > seconds - 0.05) continue;
    const ideas = (Array.isArray((m as any)?.ideas) ? (m as any).ideas : []).map((i: any) => ({ title: text(i?.title, 60), prompt: text(i?.prompt, STUNT_LIMITS.prompt_max) })).filter((i: Idea) => i.title && i.prompt.length >= STUNT_LIMITS.prompt_min).slice(0, 3);
    if (!ideas.length) continue;
    const r = Number((m as any)?.resume);
    out.push({ at: round2(at), resume: round2(Number.isFinite(r) && r >= at ? Math.min(r, seconds) : at), why: text((m as any)?.why, 120), ideas });
  }
  out.sort((a, b) => a.at - b.at);
  const kept: Moment[] = [];
  for (const m of out) if (!kept.length || m.at - kept[kept.length - 1].at >= STUNT_LIMITS.gap) kept.push(m);
  return kept.slice(0, STUNT_LIMITS.max_gags);
}
/** The times stills are taken at: about one a second, never more than the limit, none in the first half second. */
export function stillTimes(seconds: number): number[] {
  const n = Math.max(2, Math.min(STUNT_LIMITS.stills, Math.round(seconds)));
  return Array.from({ length: n }, (_, i) => round2(0.5 + (i * (seconds - 1)) / (n - 1)));
}
const ideasKey = (u: string, assetId: string) => `${u}/stunts/${assetId}.json`;

type StuntDeps = ClipsDeps & {
  /** stills of a video as JPEG bytes (tests) */
  stills?: (video: string, times: number[], dir: string) => Promise<Buffer[]>;
  ideas?: (stills: Array<{ at: number; jpeg: Buffer }>, words: Array<{ text: string; start: number }>, seconds: number, userId: string) => Promise<unknown>;
  generate?: (ctx: { job: string; user: string; frame: string; prompt: string; key: string; requestId?: string | null; onSubmit?: (id: string) => Promise<void>; /** where the frame already sits on the platform, and a way to remember it: a resend is then the same request, which the platform answers with the first one instead of refusing or billing twice */ frameUrl?: string | null; onFrame?: (url: string) => Promise<void> }) => Promise<{ file: string; requestId: string }>;
  check?: (ctx: { frame: string; clip: string; prompt: string; user: string }) => Promise<Verdict | { verdict: Verdict; note?: string }>;
  /** told about every try once it has been looked at (a local proof keeps the clips; nothing in production listens) */
  onTry?: (info: { index: number; attempt: number; file: string; verdict: Verdict; note: string }) => Promise<void> | void;
  render?: (ctx: RenderCtx) => Promise<void>;
  prepare?: (url: string, target: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};
async function defaultStills(video: string, times: number[], dir: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let i = 0; i < times.length; i++) {
    const f = join(dir, `s${i}.jpg`);
    await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", times[i].toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "6", f], { timeoutMs: 60_000 });
    out.push(await readFile(f));
  }
  return out;
}
async function defaultIdeas(deps: StuntDeps, stills: Array<{ at: number; jpeg: Buffer }>, words: Array<{ text: string; start: number }>, seconds: number, userId: string): Promise<unknown> {
  const env = deps.env ?? process.env;
  const content: any[] = [];
  for (const s of stills) { content.push({ type: "text", text: `Still at ${s.at.toFixed(1)} s` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.jpeg.toString("base64") } }); }
  const said = words.length ? words.map((w) => `[${w.start.toFixed(1)}] ${w.text}`).join(" ") : "(nobody speaks)";
  content.push({ type: "text", text: `The clip is ${seconds.toFixed(1)} seconds long.\n\nWords with their start times:\n${said}\n\nGive up to ${STUNT_LIMITS.max_gags} moments.` });
  const out = await claudeJson(deps, { model: env.STUDIO_STUNTS_MODEL || "claude-sonnet-5-5", max_tokens: 6000, system: IDEAS_SYSTEM, output_config: { format: { type: "json_schema", schema: IDEAS_SCHEMA } }, messages: [{ role: "user", content }] }, "stunts_ideas", userId);
  return out?.moments;
}
async function signed(sb: SupabaseClient, u: string, assetId: string) {
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new StuntsError("video_not_found", "That video is not in your library", 404);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 3 * 3600);
  if (s.error || !s.data?.signedUrl) throw new StuntsError("source_missing", "The video could not be read", 502, true);
  return { url: s.data.signedUrl, asset: a.data as { id: string; name: string; probe: any } };
}
/** The moments and ideas for one library video: kept ones, or thought up now (and kept). */
export async function ideasFor(sb: SupabaseClient, deps: StuntDeps, u: string, assetId: string, o: { fresh?: boolean; allowNew?: boolean } = {}): Promise<{ moments: Moment[]; seconds: number; cached: boolean }> {
  const fresh = o.fresh === true && o.allowNew !== false;
  const { url, asset } = await signed(sb, u, assetId);
  const seconds = Number(asset.probe?.duration) || 0;
  if (!(seconds >= STUNT_LIMITS.min_seconds)) throw new StuntsError("stunts_too_short", `The video needs to be at least ${STUNT_LIMITS.min_seconds} seconds`);
  if (seconds > STUNT_LIMITS.max_seconds) throw new StuntsError("stunts_too_long", `Stunts take videos up to ${STUNT_LIMITS.max_seconds} seconds; trim this one or make a clip from it first`);
  if (!fresh) {
    const kept = await sb.storage.from("studio-outputs").download(ideasKey(u, assetId));
    if (!kept.error && kept.data) { try { const d = JSON.parse(await kept.data.text()); if (Array.isArray(d?.moments) && d.moments.length) return { moments: cleanMoments(d.moments, seconds), seconds, cached: true }; } catch { /* thought up again */ } }
  }
  if (o.allowNew === false) throw new StuntsError("stunts_rate_limited", "That is a lot of new ideas for one day; try again tomorrow", 429);
  const dir = await mkdtemp(join(tmpdir(), "studio-stunt-ideas-"));
  try {
    const times = stillTimes(seconds);
    const jpegs = await (deps.stills ?? defaultStills)(url, times, dir);
    // the words help (a gag lands on the end of a sentence), but a silent clip or a deaf service is not a reason to stop
    let words: Array<{ text: string; start: number }> = [];
    try { words = docWords(await wordsFor(sb, deps, u, assetId)).map((w) => ({ text: w.text, start: w.start })); } catch (e: any) { deps.log?.(`[stunts] no words for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); }
    const stills = times.map((at, i) => ({ at, jpeg: jpegs[i] })).filter((s) => s.jpeg?.length);
    const raw = deps.ideas ? await deps.ideas(stills, words, seconds, u) : await defaultIdeas(deps, stills, words, seconds, u);
    const moments = cleanMoments(raw, seconds);
    if (!moments.length) throw new StuntsError("stunts_no_ideas", "No good moment was found in this video; pick one yourself", 422);
    await sb.storage.from("studio-outputs").upload(ideasKey(u, assetId), Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), moments })), { contentType: "application/json", upsert: true }).catch(() => undefined);
    return { moments, seconds, cached: false };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// One gag: the real frame in, a generated clip out; then a look at it
// ---------------------------------------------------------------------------------------------------
const POLL_MS = 6000, MAX_WAIT_MS = 15 * 60_000;
/** The frame goes to the platform's temporary store (it wants a public address), then the request is sent and awaited.
 *  A request already sent (its id kept in the job's progress) is only awaited, never sent twice. */
async function defaultGenerate(deps: StuntDeps, ctx: { job: string; user: string; frame: string; prompt: string; key: string; requestId?: string | null; onSubmit?: (id: string) => Promise<void>; /** where the frame already sits on the platform, and a way to remember it: a resend is then the same request, which the platform answers with the first one instead of refusing or billing twice */ frameUrl?: string | null; onFrame?: (url: string) => Promise<void> }, dir: string): Promise<{ file: string; requestId: string }> {
  const env = deps.env ?? process.env, sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let requestId = ctx.requestId ?? null;
  if (!requestId) {
    let frameUrl = ctx.frameUrl ?? null;
    if (!frameUrl) {
      const up = await hf(deps, "/files/generate-upload-url", { method: "POST", body: JSON.stringify({ content_type: "image/jpeg" }) });
      if (up.status !== 200 || !up.body?.upload_url || !up.body?.public_url) throw new RecastError("recast_rejected", `no upload address (${up.status})`, true);
      const put = await (deps.fetch ?? fetch)(String(up.body.upload_url), { method: "PUT", headers: { "Content-Type": "image/jpeg", ...(up.body.upload_headers ?? {}) }, body: await readFile(ctx.frame), signal: AbortSignal.timeout(120_000) });
      if (!put.ok) throw new RecastError("recast_rejected", `frame upload ${put.status}`, true);
      frameUrl = String(up.body.public_url);
      await ctx.onFrame?.(frameUrl); // remembered before anything is sent
    }
    const body = { prompt: ctx.prompt + STUNT_STYLE, image_url: frameUrl, duration: STUNT_LIMITS.gag_seconds, resolution: "720p", generate_audio: true };
    const r = await hf(deps, `/${stuntEndpoint(env)}`, { method: "POST", body: JSON.stringify(body), idempotency: ctx.key });
    if (![200, 201, 202].includes(r.status) || !r.body?.request_id) throw new RecastError("recast_rejected", `Higgsfield ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    requestId = String(r.body.request_id);
    // billed from here whatever comes back: the cost is written when the request is taken, at the quoted rate
    recordCost({ job_id: ctx.job, user_id: ctx.user, tool: "stunts", provider: "higgsfield", product: stuntEndpoint(env), source: "stunts_gag", units: { seconds: STUNT_LIMITS.gag_seconds }, usd: stuntGenerationUsd(env), basis: "list", ref: requestId });
    await ctx.onSubmit?.(requestId);
  }
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
    let st: { status: number; body: any };
    try { st = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }); }
    catch (e: any) { if (e instanceof RecastError && e.retry) { await sleep(POLL_MS); continue; } throw e; }
    const status = String(st.body?.status ?? "unknown").toLowerCase();
    if (status === "completed") {
      const url = outputUrls(st.body).videos[0];
      if (!url) throw new RecastError("recast_bad_output", "completed without a video");
      const dl = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(300_000) });
      if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
      const file = join(dir, `${requestId}.mp4`);
      await writeFile(file, Buffer.from(await dl.arrayBuffer()));
      return { file, requestId };
    }
    if (["failed", "nsfw", "canceled", "cancelled"].includes(status)) throw new RecastError(status === "nsfw" ? "recast_nsfw" : "recast_failed", JSON.stringify(st.body).slice(0, 200));
    await sleep(POLL_MS);
  }
}

export type Verdict = "good" | "weak" | "broken";
const CHECK_SYSTEM = `You check one generated video clip that continues a real phone video, for a comedy edit. You see the real frame it started from, then four stills from the generated clip in order, and the gag that was asked for.

Judge the spirit, not the wording. The clip is good when something big, physical and impossible clearly happens to the person or to the thing in the frame, starting from the real frame. It does not have to match the gag's details: a different impossible thing is as good as the one asked for, and a missing small gesture does not matter. The camera is meant to move and follow the action, so seeing other parts of the same room, a new angle, or the person small, far away or hidden by what they ride is normal and is not a different place or a different person.

- "good": something impossible clearly happens, and the first stills are recognisably the same person and place as the real frame.
- "weak": something impossible does happen, but it is small or only starts in the last still.
- "broken": nothing impossible happens in any still (it looks like ordinary footage throughout: this is always "broken", never "weak"); or the very first still is already a different place or person; or a face close to the camera is clearly someone else; or bodies and objects are badly malformed for most of the clip (melted faces, extra limbs, things turning into other things).
When unsure between "good" and "weak", pick "good". The note is one short sentence, under 20 words.`;
const CHECK_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict", "note"], properties: { verdict: { type: "string", enum: ["good", "weak", "broken"] }, note: { type: "string" } } };
async function defaultCheck(deps: StuntDeps, ctx: { frame: string; clip: string; prompt: string; user: string }, dir: string): Promise<{ verdict: Verdict; note: string }> {
  const env = deps.env ?? process.env;
  if (env.STUDIO_STUNTS_CHECK === "off") return { verdict: "good", note: "not checked" };
  try {
    const len = await probeSeconds(ctx.clip);
    const id = randomUUID().slice(0, 8);
    const jpegs = await defaultStills(ctx.clip, [0.2, 0.4, 0.65, 0.92].map((f) => round2(len * f)), dir);
    const img = (b: Buffer) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } });
    const small = join(dir, `real-${id}.jpg`);
    await ffmpeg(["-v", "error", "-nostdin", "-y", "-i", ctx.frame, "-vf", "scale=384:-2", "-q:v", "6", small], { timeoutMs: 60_000 });
    const content = [{ type: "text", text: "The real frame:" }, img(await readFile(small)), { type: "text", text: "The generated clip, in order:" }, ...jpegs.map(img), { type: "text", text: `The gag asked for: ${ctx.prompt}` }];
    const out = await claudeJson(deps, { model: env.STUDIO_STUNTS_CHECK_MODEL || "claude-haiku-5-5", max_tokens: 1500, system: CHECK_SYSTEM, output_config: { format: { type: "json_schema", schema: CHECK_SCHEMA } }, messages: [{ role: "user", content }] }, "stunts_check", ctx.user);
    return { verdict: out?.verdict === "broken" ? "broken" : out?.verdict === "weak" ? "weak" : "good", note: text(out?.note, 200) };
  } catch (e: any) { deps.log?.(`[stunts] check skipped: ${String(e?.message ?? e).slice(0, 120)}`); return { verdict: "good", note: "check skipped" }; } // a check that cannot run never costs the person their gag
}

// ---------------------------------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------------------------------
export type Made = { index: number; at: number; resume: number; file: string; seconds: number; fix?: { y: number; u: number; v: number } | null };
export type Segment = { kind: "real"; from: number; to: number } | { kind: "gag"; index: number; seconds: number };
/** The finished video's order: real up to each gag, the gag, real again from where the person carries on. */
export function planTimeline(seconds: number, made: Array<Pick<Made, "index" | "at" | "resume" | "seconds">>, speed: number): { segments: Segment[]; total: number } {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const g of [...made].sort((a, b) => a.at - b.at)) {
    if (g.at - cursor > 0.04) segments.push({ kind: "real", from: round2(cursor), to: g.at });
    segments.push({ kind: "gag", index: g.index, seconds: round2(g.seconds / speed) });
    cursor = Math.max(g.at, g.resume);
  }
  if (seconds - cursor > 0.2) segments.push({ kind: "real", from: round2(cursor), to: round2(seconds) });
  return { segments, total: round2(segments.reduce((s, x) => s + (x.kind === "real" ? x.to - x.from : x.seconds), 0)) };
}
/** The small colour correction that brings a generated clip's first frame to the real frame's (average brightness and
 *  the two colour channels), never more than a nudge: a big difference means the model changed the scene, not the grade. */
export function colourFix(real: { y: number; u: number; v: number }, gag: { y: number; u: number; v: number }, cap = 14): { y: number; u: number; v: number } | null {
  const d = (a: number, b: number) => Math.max(-cap, Math.min(cap, Math.round(a - b)));
  const fix = { y: d(real.y, gag.y), u: d(real.u, gag.u), v: d(real.v, gag.v) };
  return Math.abs(fix.y) + Math.abs(fix.u) + Math.abs(fix.v) < 2 ? null : fix;
}
const atempo = (speed: number) => (speed > 2 ? `atempo=2,atempo=${(speed / 2).toFixed(3)}` : `atempo=${speed.toFixed(3)}`);
/** The ffmpeg graph for the whole video. Input 0 is the person's video (already at the working size and rate); inputs
 *  1..n are the gags in the order of `made`. Gags without sound get silence; so does a silent source. */
export function joinGraph(segments: Segment[], made: Array<Pick<Made, "index" | "fix"> & { hasAudio: boolean }>, o: { w: number; h: number; speed: number; sourceAudio: boolean }): { graph: string; inputs: number[] } {
  const parts: string[] = [], labels: string[] = [];
  const A = "aformat=sample_rates=44100:channel_layouts=stereo";
  // an input can be read by one filter only: the person's video is split once for each real stretch
  const reals = segments.filter((s) => s.kind === "real").length;
  if (reals > 1) { parts.push(`[0:v]split=${reals}${Array.from({ length: reals }, (_, k) => `[sv${k}]`).join("")}`); if (o.sourceAudio) parts.push(`[0:a]asplit=${reals}${Array.from({ length: reals }, (_, k) => `[sa${k}]`).join("")}`); }
  let r = 0;
  segments.forEach((s, i) => {
    if (s.kind === "real") {
      const sv = reals > 1 ? `[sv${r}]` : "[0:v]", sa = reals > 1 ? `[sa${r}]` : "[0:a]"; r++;
      parts.push(`${sv}trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p[v${i}]`);
      parts.push(o.sourceAudio ? `${sa}atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS,${A}[a${i}]` : `anullsrc=r=44100:cl=stereo,atrim=duration=${(s.to - s.from).toFixed(3)}[a${i}]`);
    } else {
      const n = made.findIndex((m) => m.index === s.index), m = made[n], input = n + 1;
      const fix = m.fix ? `,lutyuv=y=clip(val+${m.fix.y}\\,16\\,235):u=clip(val+${m.fix.u}\\,16\\,240):v=clip(val+${m.fix.v}\\,16\\,240)` : "";
      parts.push(`[${input}:v]setpts=(PTS-STARTPTS)/${o.speed},scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h},fps=30,setsar=1,format=yuv420p${fix},trim=duration=${s.seconds.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(m.hasAudio ? `[${input}:a]${atempo(o.speed)},loudnorm=I=-15:TP=-1.5:LRA=11,${A},atrim=duration=${s.seconds.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]` : `anullsrc=r=44100:cl=stereo,atrim=duration=${s.seconds.toFixed(3)}[a${i}]`);
    }
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`);
  return { graph: parts.join(";"), inputs: made.map((m) => m.index) };
}
type RenderCtx = { source: string; made: Array<Made & { hasAudio: boolean }>; segments: Segment[]; w: number; h: number; speed: number; sourceAudio: boolean; target: string };
async function defaultRender(c: RenderCtx): Promise<void> {
  const { graph } = joinGraph(c.segments, c.made, { w: c.w, h: c.h, speed: c.speed, sourceAudio: c.sourceAudio });
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-i", c.source, ...c.made.flatMap((m) => ["-i", m.file]), "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", c.target], { timeoutMs: 15 * 60_000 });
}
/** The person's video brought to the size the model works at (720 on the short side at most), 30 frames a second. */
export function workingSize(w: number, h: number): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (!(w > 0 && h > 0)) return { w: 720, h: 1280 };
  const s = Math.min(1, 720 / Math.min(w, h));
  return { w: even(w * s), h: even(h * s) };
}
async function defaultPrepare(url: string, target: string): Promise<void> {
  await ffmpeg(["-v", "error", "-nostdin", "-y", ...(/^https?:/.test(url) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"] : []), "-i", url, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='if(lt(iw,ih),min(720,iw),-2)':'if(lt(iw,ih),-2,min(720,ih))':force_divisible_by=2,fps=30,setsar=1,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-g", "15", "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", target], { timeoutMs: 10 * 60_000 });
}
/** Average brightness and colour of one picture (ffmpeg signalstats). */
async function frameStats(file: string): Promise<{ y: number; u: number; v: number } | null> {
  try {
    const out = await ffmpeg(["-v", "info", "-nostdin", "-i", file, "-frames:v", "1", "-vf", "scale=160:-2,format=yuv420p,signalstats,metadata=print", "-f", "null", "-"], { timeoutMs: 60_000 });
    const g = (k: string) => Number((out.match(new RegExp(`signalstats\\.${k}=([0-9.]+)`)) ?? [])[1]);
    const s = { y: g("YAVG"), u: g("UAVG"), v: g("VAVG") };
    return [s.y, s.u, s.v].every(Number.isFinite) ? s : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };
export async function runStuntsJob(sb: SupabaseClient, deps: StuntDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id;
  const gags: Gag[] = Array.isArray(o.gags) ? o.gags : [];
  const speed = Number(o.speed) > 0 ? Number(o.speed) : 2;
  const each = Number(o.credits_per_gag) > 0 ? Number(o.credits_per_gag) : Math.floor(job.credits_reserved / Math.max(1, gags.length));
  const renew = async (p: Record<string, any>) => {
    const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...p } });
    if (r.error) throw r.error;
    if (r.data !== true) throw new StuntsError("lease_lost", "lease lost");
    job.progress = { ...(job.progress ?? {}), ...p };
  };
  let dir: string | null = null;
  try {
    if (!job.asset_id || !gags.length) throw new StuntsError("stunts_no_gag", "nothing to make");
    dir = await mkdtemp(join(tmpdir(), "studio-stunts-"));
    const d = dir;
    await renew({ stage: "reading", done: 0, total: gags.length, message: "Reading your video", stage_at: new Date().toISOString() });
    const { url, asset } = await signed(sb, u, job.asset_id);
    const source = join(d, "source.mp4");
    await cutGate(env).run(() => (deps.prepare ? deps.prepare(url, source) : defaultPrepare(url, source)), () => renew({ message: "Next in line for the cutter" }).then(() => undefined));
    // the size is read from the prepared file, not the upload's notes: phone videos carry a rotation the notes may not show
    const dims = deps.render ? { width: Number(asset.probe?.width) || 0, height: Number(asset.probe?.height) || 0 } : await probeDimensions(source);
    const size = workingSize(dims.width, dims.height);
    const info = deps.render ? { hasAudio: true } : await probeStream(source);
    const seconds = deps.render ? Number(o.seconds) : await probeSeconds(source);

    // every gag at once: the model takes two to three minutes each, and they do not depend on one another
    const requests: Record<string, string> = { ...(job.progress?.requests ?? {}) };
    const frames: Record<string, string> = { ...(job.progress?.frames ?? {}) };
    const state: Array<{ verdict: Verdict | "failed"; tries: number; note?: string }> = gags.map(() => ({ verdict: "failed", tries: 0 }));
    const made: Array<Made & { hasAudio: boolean }> = [];
    let finished = 0;
    await renew({ stage: "making", message: gags.length > 1 ? `Making ${gags.length} stunts` : "Making the stunt", stage_at: new Date().toISOString() });
    await Promise.all(gags.map(async (g, i) => {
      const frame = join(d, `frame-${i}.jpg`);
      try {
        if (deps.generate) await writeFile(frame, ""); else await extractFrame(source, frame, Math.max(0, g.at - 1 / 30));
        let best: { file: string; verdict: Verdict } | null = null;
        for (let t = 1; t <= STUNT_LIMITS.tries; t++) {
          const key = `${job.id}:${i}:${t}`;
          const ctx = { job: job.id, user: u, frame, prompt: g.prompt, key, requestId: requests[key] ?? null, onSubmit: async (id: string) => { requests[key] = id; await renew({ requests: { ...requests } }).catch(() => undefined); },
            frameUrl: frames[String(i)] ?? null, onFrame: async (url: string) => { frames[String(i)] = url; await renew({ frames: { ...frames } }); } };
          let got: { file: string; requestId: string };
          try { got = deps.generate ? await deps.generate(ctx) : await defaultGenerate(deps, ctx, d); }
          catch (e: any) {
            if (e instanceof RecastError && ["recast_auth", "recast_balance", "recast_not_configured"].includes(e.code)) throw e; // ours to fix, not this gag's fault
            state[i].note = e instanceof RecastError ? e.code : "error"; state[i].tries = t;
            log(`[stunts] gag ${i + 1} try ${t} of ${job.id}: ${String(e?.message ?? e).slice(0, 160)}`);
            continue;
          }
          state[i].tries = t;
          const looked = deps.check ? await deps.check({ frame, clip: got.file, prompt: g.prompt, user: u }) : await defaultCheck(deps, { frame, clip: got.file, prompt: g.prompt, user: u }, d);
          const verdict: Verdict = typeof looked === "string" ? looked : looked.verdict, why = typeof looked === "string" ? "" : looked.note ?? "";
          log(`[stunts] gag ${i + 1} try ${t} of ${job.id}: ${verdict}${why ? ` (${why})` : ""}`);
          await Promise.resolve(deps.onTry?.({ index: i, attempt: t, file: got.file, verdict, note: why })).catch(() => undefined);
          // a good or a weak one is used as it is; only a broken one is worth paying for again (the check erred on
          // the strict side in the first live runs: every clip it called weak was one a person would keep)
          if (verdict !== "broken") { best = { file: got.file, verdict }; break; }
        }
        if (best) {
          state[i].verdict = best.verdict;
          const gagInfo = deps.render ? { hasAudio: true } : await probeStream(best.file);
          const len = deps.render ? STUNT_LIMITS.gag_seconds : await probeSeconds(best.file);
          let fix = null;
          if (!deps.render) { const first = join(d, `first-${i}.jpg`); await extractFrame(best.file, first, 0); const [a, b] = await Promise.all([frameStats(frame), frameStats(first)]); fix = a && b ? colourFix(a, b) : null; }
          made.push({ index: i, at: g.at, resume: g.resume, file: best.file, seconds: len, fix, hasAudio: gagInfo.hasAudio });
        }
      } finally { finished++; await renew({ done: finished, message: finished < gags.length ? `${finished} of ${gags.length} stunts made` : "Joining them into your video" }).catch(() => undefined); }
    }));
    if (!made.length) throw new StuntsError(state.some((s) => s.note === "recast_nsfw") ? "stunts_refused" : "stunts_failed", "None of the stunts could be made", 502, false);
    made.sort((a, b) => a.at - b.at);

    await renew({ stage: "joining", message: "Joining them into your video", stage_at: new Date().toISOString() });
    const { segments, total } = planTimeline(seconds, made, speed);
    const out = join(d, "out.mp4"), still = join(d, "out.jpg");
    const ctx: RenderCtx = { source, made, segments, w: size.w, h: size.h, speed, sourceAudio: info.hasAudio, target: out };
    await cutGate(env).run(() => (deps.render ? deps.render(ctx) : defaultRender(ctx)), () => renew({ message: "Next in line for the cutter" }).then(() => undefined));
    let posterOk = true;
    try { if (!deps.render) await makePoster(out, still); else posterOk = false; } catch { posterOk = false; }
    const bytes = (await stat(out)).size, base = `${u}/${job.id}/${job.lease_token}/1`;
    const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, await readFile(out), { contentType: "video/mp4", upsert: false });
    if (up.error) throw new StuntsError("stunts_store_failed", String(up.error.message ?? up.error), 502, true);
    if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (p.error) posterOk = false; }
    const report = gags.map((g, i) => ({ title: g.title, at: g.at, made: made.some((m) => m.index === i), verdict: state[i].verdict, tries: state[i].tries }));
    const outputs = [{ index: 1, key: `${base}.mp4`, poster_key: posterOk ? `${base}.jpg` : undefined, kind: "video", bytes, duration: total, tool: "stunts", gags: report }];
    const charged = Math.min(job.credits_reserved, made.length * each);
    await renew({ stage: "done", outcome: made.length < gags.length ? "partial" : "done", made_count: made.length, charged, gags: report }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
    if (done.error) throw done.error;
    const tries = state.reduce((s, x) => s + x.tries, 0);
    recordEvent({ user_id: u, kind: "feature", name: "stunts_done", props: { job: job.id, asked: gags.length, made: made.length, tries, weak: state.filter((s) => s.verdict === "weak").length, credits: charged, seconds: total } });
    log(`[stunts] made ${JSON.stringify({ job: job.id, asked: gags.length, made: made.length, tries, seconds: total, charged })}`);
    return made.length < gags.length ? "partial" : "done";
  } catch (e: any) {
    const code = e instanceof ClipsError || e instanceof RecastError ? e.code : "stunts_failed";
    if (code === "lease_lost") return code;
    const retry = e instanceof ClipsError || e instanceof RecastError ? e.retry : true;
    log(`[stunts] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    const f = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry });
    if (f.error) log(`[stunts] could not record the failure of ${job.id}: ${f.error.message}`);
    return code;
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** One run at a time by default (STUDIO_STUNTS_PARALLEL, 1 to 4): the waiting is on the model, the cutting goes through
 *  the server's cutter shared with Clips and Captions. */
export function startStuntsLoop(sbFn: () => SupabaseClient, deps: StuntDeps = {}, intervalMs = 10_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!stuntsEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `stunts-${randomUUID()}`, max = Math.max(1, Math.min(4, Number(env.STUDIO_STUNTS_PARALLEL) || 1));
  const active = new Set<string>();
  let claiming = false;
  const tick = async () => {
    if (claiming || active.size >= max) return;
    claiming = true;
    try {
      const sb = sbFn();
      const room = await (deps.room ?? roomForAnother)(env);
      if (!room.ok) return;
      const r = await sb.rpc("studio_claim", { p_tool: "stunts", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      active.add(job.id);
      const keep = setInterval(() => { sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }).then(() => undefined, () => undefined); }, 4 * 60_000);
      runStuntsJob(sb, { ...deps, log }, job).then((s) => log(`[stunts] ${s} ${job.id}`)).catch((e) => log(`[stunts] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { clearInterval(keep); active.delete(job.id); });
    } catch (e: any) { log(`[stunts] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { claiming = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 29_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
export function registerStunts(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log" | "plans"> & { isOwner: (req: any, sb: SupabaseClient) => Promise<boolean> }, deps: StuntDeps = {}): void {
  // What the page needs before anything is picked: the limits and the price of one stunt.
  app.get("/api/studio/stunts/config", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      if (!stuntsEnabled(h.env) || (!stuntsOpen(h.env) && !(await h.isOwner(req, sb)))) throw new StuntsError("stunts_off", "Stunts are not open yet", 403);
      res.json({ limits: { min_seconds: STUNT_LIMITS.min_seconds, max_seconds: STUNT_LIMITS.max_seconds, max_gags: STUNT_LIMITS.max_gags, gap: STUNT_LIMITS.gap, prompt_min: STUNT_LIMITS.prompt_min, prompt_max: STUNT_LIMITS.prompt_max }, speeds: STUNT_SPEEDS, credits_per_gag: stuntGagCredits(h.env, h.plans) });
    } catch (e) { h.fail(res, e); }
  });
  // The moments and three ideas for each. Needs a plan; a fresh set 20 times a day (a kept set is free to read again).
  app.post("/api/studio/stunts/ideas", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      const owner = await h.isOwner(req, sb);
      if (!stuntsEnabled(h.env) || (!stuntsOpen(h.env) && !owner)) throw new StuntsError("stunts_off", "Stunts are not open yet", 403);
      const assetId = String(req.body?.asset_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new StuntsError("video_not_found", "Pick a video", 404);
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(owner || (c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass)))) throw new StuntsError("subscription_required", "Stunts come with a plan", 409);
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "stunts_ideas").gte("created_at", since);
      // a kept set is always free to read; a new one (a new video, or "other ideas") counts toward the day
      const out = await ideasFor(sb, { ...deps, env: h.env, log: h.log }, u, assetId, { fresh: req.body?.fresh === true, allowNew: (n.count ?? 0) < STUNT_LIMITS.ideas_per_day });
      if (!out.cached) recordEvent({ user_id: u, kind: "feature", name: "stunts_ideas", props: { asset: assetId, moments: out.moments.length, seconds: out.seconds } });
      res.json({ moments: out.moments, seconds: out.seconds });
    } catch (e) { h.fail(res, e); }
  });
}
/** The cutter's own steps, for a local proof of the join outside a job. */
export { defaultPrepare as prepareSource, defaultRender as renderJoin, defaultCheck as checkGag, frameStats };
