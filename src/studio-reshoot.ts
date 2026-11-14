// Clone8 Studio: Reshoot. A person's one-camera take comes back cut like a crew filmed it from many cameras: the same
// words, voice, gestures and timing, each stretch from a new angle, with a camera move, new light, a new place or a new
// outfit. Their own sound runs untouched under the whole edit.
//
// How a run makes one (the choices were measured on the owner's clips on Nov 13-14 2026, docs/reshoot/START_HERE.md):
//   1. Plan (free, before any job): the words with their times cut the take into shots on sentence breaks (4 to 8 s),
//      and Claude, looking at a still of each, proposes a change for each shot. The person keeps, changes or clears any.
//   2. Each changed shot is cut from the take and re-filmed on the platform API:
//        - a face that stays close (new angle, light, place, outfit): Seedance 2.5 video edit. It keeps the lips on the
//          words, but hands back about 4 % less time than it was given (7.7 s for 8 s), so every result is stretched
//          back to its shot's length before the join; then blinks land on the same frame as the original.
//        - a wide or overhead shot: Wan 3.0 reference-to-video. Same body and place, a tenth of the price; its timing is
//          a few tenths of a second loose, which only shows where the mouth is small.
//        - a camera move (orbit, push-in): Seedance 2.5 reference-to-video in 4 s pieces, each piece opened on the last
//          frame of the one before (edit mode never moves the camera; unchained pieces jump at the join).
//   3. Before a shot counts it is checked: it really changed (a near copy of the source, which another engine returned
//      twice and still billed, is caught by comparing pictures), the platform did not refuse it, and a look by Claude
//      says it is the same person with the change made. A failed shot is made once more; failed again, or refused, the
//      original footage stays in that shot and the shot is not charged.
//   4. The join: shots cut together at the planned times at the take's size, the person's own sound under all of it.
//   5. Price: per changed shot, from the engine's list price per second with an allowance for the second try, at the
//      margin rule of studio-pricing.ts (Seedance sits in the premium tier). Charged only for the shots that made it.
//
// Off until STUDIO_RESHOOT_ENABLED=true; until STUDIO_RESHOOT_OPEN=true only the owner's account can use it.
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
import { creditValueFloor, creditsForCost, marginForSecond, SEEDANCE_EDIT_RATES, type PlanLike } from "./studio-pricing.js";
import { extractFrame, makePoster, probeDimensions, probeSeconds, probeStream, RecastError } from "./studio-recast.js";
import { keyStills, prepareSource, workingSize } from "./studio-stunts.js";
import type { LibraryHelpers } from "./studio-library.js";

type Env = Record<string, string | undefined>;
export class ReshootError extends ClipsError {}
const round2 = (x: number) => Math.round(x * 100) / 100;
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------------------------------
// Switches and limits
// ---------------------------------------------------------------------------------------------------
export const reshootEnabled = (env: Env = process.env) => env.STUDIO_RESHOOT_ENABLED === "true" && !!env.HIGGSFIELD_API_KEY && !!env.ANTHROPIC_API_KEY;
/** Open to every customer. Until then only the owner's account (the Studio admin) can make them. */
export const reshootOpen = (env: Env = process.env) => reshootEnabled(env) && env.STUDIO_RESHOOT_OPEN === "true";

export const RESHOOT_LIMITS = {
  min_seconds: 5, max_seconds: 60,
  /** a re-filmed shot: the platform renders at least 4 s; past 8 s a face drifts more */
  shot_min: 4, shot_max: 8, shot_target: 6,
  /** a camera move is rendered 4 s at a time, one piece after another (about 5 minutes each) */
  move_max: 12, move_piece: 4, max_moves: 2,
  max_shots: 12, text_max: 120, plans_per_day: 20, tries: 2,
  /** a result this close to its source (PSNR in dB, at the working size) is the source sent back, not a new shot */
  same_psnr: 27,
};

// ---------------------------------------------------------------------------------------------------
// The choices a shot can take (one word each on the page; the words sent to the model are below)
// ---------------------------------------------------------------------------------------------------
export const ANGLES = ["same", "closeup", "three_quarter_left", "three_quarter_right", "side_left", "side_right", "low", "high", "overhead", "wide"] as const;
export const MOVES = ["none", "orbit", "push_in"] as const;
export const LIGHTS = ["same", "golden_hour", "night", "cool", "warm", "studio", "neon"] as const;
export type Angle = typeof ANGLES[number]; export type Move = typeof MOVES[number]; export type Light = typeof LIGHTS[number];
export const PLACES = ["snowy mountain ridge", "beach at sunset", "city rooftop at night", "minimal photo studio", "forest clearing", "modern office", "neon-lit street", "desert road"];

export const ANGLE_WORDS: Record<Angle, string> = {
  same: "the same camera position and framing as the source",
  closeup: "a tight close-up of the face, head and shoulders filling the frame, straight on",
  three_quarter_left: "a three-quarter view from about 40 degrees to the person's left, at the same distance, the face and mouth clearly visible",
  three_quarter_right: "a three-quarter view from about 40 degrees to the person's right, at the same distance, the face and mouth clearly visible",
  side_left: "a side view from the person's left, close to a profile, the mouth clearly visible",
  side_right: "a side view from the person's right, close to a profile, the mouth clearly visible",
  low: "a low angle from below chest height looking up at the person, the face clearly visible",
  high: "a high angle from above eye level looking down at the person, the face clearly visible",
  overhead: "a top-down overhead shot looking straight down at the person",
  wide: "a wide shot from further back and slightly to one side, the whole person and more of the place around them in view",
};
export const LIGHT_WORDS: Record<Light, string> = {
  same: "",
  golden_hour: "Relit as golden hour: a warm low sun from one side, soft long shadows, a warm glow on the skin.",
  night: "Relit as night: dark surroundings, one soft practical lamp lighting the face from the side.",
  cool: "Relit cool: a soft blue-white key light, cool shadows, a clean modern look.",
  warm: "Relit warm: a soft warm tungsten key light from the front-left, cosy and even.",
  studio: "Relit as a studio: a large soft key light, gentle fill, a subtle rim light separating the person from the background.",
  neon: "Relit with neon: magenta and cyan coloured light from either side, darker in between.",
};
export const MOVE_WORDS: Record<Exclude<Move, "none">, (k: number, n: number) => string> = {
  // a full circle over the pieces: front, right side, behind, left side, front again
  orbit: (k, n) => { const stops = ["in front of the person", "at the person's right side", "behind the person", "at the person's left side", "in front of the person"]; const at = (i: number) => stops[Math.min(4, Math.round((i * 4) / n))]; return `the camera keeps orbiting around the person clockwise at chest height, travelling from ${at(k)} to ${at(k + 1)}, keeping them centred`; },
  push_in: (k, n) => `the camera pushes in slowly and smoothly toward the person's face, from ${k === 0 ? "the source's framing" : "where it was"} to ${k + 1 === n ? "a close-up of the face" : "closer"}`,
};

// ---------------------------------------------------------------------------------------------------
// Shots: the take cut into stretches, each kept as it is or re-filmed with a change
// ---------------------------------------------------------------------------------------------------
export type Change = { angle: Angle; move: Move; light: Light; place: string; outfit: string };
export type Shot = Change & { start: number; end: number; keep: boolean; why?: string };
export type Engine = "seedance_edit" | "wan" | "seedance_move";
export const NO_CHANGE: Change = { angle: "same", move: "none", light: "same", place: "", outfit: "" };
const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;
export function cleanChange(raw: any): Change {
  const o = raw && typeof raw === "object" ? raw : {};
  return { angle: pick(ANGLES, o.angle, "same"), move: pick(MOVES, o.move, "none"), light: pick(LIGHTS, o.light, "same"), place: text(o.place, RESHOOT_LIMITS.text_max), outfit: text(o.outfit, RESHOOT_LIMITS.text_max) };
}
export const changes = (c: Change) => c.angle !== "same" || c.move !== "none" || c.light !== "same" || !!c.place || !!c.outfit;

/** Which engine re-films a shot (section 2 of the plan): a move needs reference mode in chained pieces; a wide or
 *  overhead camera, where the mouth is small, can take the cheap engine; everything with a close face takes the edit
 *  model that keeps the lips on the words. */
export function engineFor(s: Change): Engine {
  if (s.move !== "none") return "seedance_move";
  if (s.angle === "wide" || s.angle === "overhead") return "wan";
  return "seedance_edit";
}

/** Where the take can be cut: the gaps between words (silence of a quarter second or more is a sentence break, the
 *  strongest). A take with no words is cut evenly. Shots land as close to the target length as the breaks allow. */
export function autoCuts(seconds: number, words: Array<{ start: number; end: number; text?: string }>): number[] {
  const L = RESHOOT_LIMITS, total = round2(seconds);
  if (total <= L.shot_max) return [0, total];
  const gaps: Array<{ at: number; strength: number }> = [];
  const ws = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ws.length; i++) {
    const gap = ws[i].start - ws[i - 1].end, ends = /[.!?…]["')\]]*$/.test(String(ws[i - 1].text ?? ""));
    if (gap >= 0.08 || ends) gaps.push({ at: round2(ws[i - 1].end + Math.max(0, gap) / 2), strength: gap + (ends ? 0.5 : 0) });
  }
  const cuts = [0];
  let from = 0;
  while (total - from > L.shot_max) {
    const lo = from + L.shot_min, hi = Math.min(from + L.shot_max, total - L.shot_min);
    // the strongest break in reach, nudged toward the target length
    const near = gaps.filter((g) => g.at >= lo && g.at <= hi).map((g) => ({ ...g, score: g.strength - Math.abs(g.at - (from + L.shot_target)) * 0.08 })).sort((a, b) => b.score - a.score)[0];
    const at = near ? near.at : round2(Math.min(hi, from + L.shot_target));
    if (at <= from) break;
    cuts.push(at); from = at;
  }
  cuts.push(total);
  return cuts;
}
const moveRotation: Change[] = [
  { ...NO_CHANGE, angle: "closeup" }, { ...NO_CHANGE, angle: "three_quarter_left" }, { ...NO_CHANGE, angle: "wide" },
  { ...NO_CHANGE, angle: "three_quarter_right" }, { ...NO_CHANGE, angle: "low" }, { ...NO_CHANGE, angle: "high" },
];
/** The plan with no reading at all: the first shot as filmed, then a turn of different cameras (a take short enough
 *  to be one shot gets a new camera on that shot, or there would be nothing to make). */
export function defaultShots(cuts: number[]): Shot[] {
  const n = cuts.length - 1;
  return cuts.slice(0, -1).map((start, i) => {
    const keep = i === 0 && n > 1;
    return { start, end: cuts[i + 1], ...(keep ? NO_CHANGE : moveRotation[(n > 1 ? i - 1 : 0) % moveRotation.length]), keep };
  });
}

/** A person's shots made safe to price and run: in order, covering the whole take with no gap, each changed shot long
 *  enough for the platform and short enough to keep the face, moves capped. Errors say what to fix. */
export function cleanShots(raw: unknown, seconds: number): Shot[] {
  const L = RESHOOT_LIMITS, total = round2(seconds);
  if (!Array.isArray(raw) || !raw.length) throw new ReshootError("reshoot_no_shot", "The edit needs at least one shot");
  if (raw.length > L.max_shots) throw new ReshootError("reshoot_too_many", `Up to ${L.max_shots} shots in one video`);
  const shots: Shot[] = raw.map((s: any) => {
    const start = round2(Number(s?.start)), end = round2(Number(s?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new ReshootError("reshoot_bad_shot", "A shot has no length");
    const c = cleanChange(s);
    const keep = s?.keep === true || !changes(c);
    return { start, end, ...(keep ? NO_CHANGE : c), keep, ...(s?.why ? { why: text(s.why, 80) } : {}) };
  }).sort((a, b) => a.start - b.start);
  if (Math.abs(shots[0].start) > 0.05) throw new ReshootError("reshoot_gap", "The first shot has to start at the beginning");
  if (Math.abs(shots[shots.length - 1].end - total) > 0.3) throw new ReshootError("reshoot_gap", "The last shot has to run to the end of the video");
  shots[0].start = 0; shots[shots.length - 1].end = total;
  for (let i = 1; i < shots.length; i++) {
    if (Math.abs(shots[i].start - shots[i - 1].end) > 0.05) throw new ReshootError("reshoot_gap", "Shots have to follow one another with no gap or overlap");
    shots[i].start = shots[i - 1].end;
  }
  let moves = 0;
  for (const s of shots) {
    if (s.keep) continue;
    const len = s.end - s.start;
    if (len < L.shot_min - 0.01) throw new ReshootError("reshoot_shot_short", `A changed shot needs at least ${L.shot_min} seconds; join it to the one beside it`);
    if (s.move !== "none") { moves++; if (len > L.move_max + 0.01) throw new ReshootError("reshoot_move_long", `A camera move can run up to ${L.move_max} seconds`); }
    else if (len > L.shot_max + 0.01) throw new ReshootError("reshoot_shot_long", `A changed shot can run up to ${L.shot_max} seconds; split it`);
  }
  if (moves > L.max_moves) throw new ReshootError("reshoot_too_many_moves", `Up to ${L.max_moves} camera moves in one video`);
  if (!shots.some((s) => !s.keep)) throw new ReshootError("reshoot_nothing", "Change at least one shot");
  return shots;
}

/** How many 4 s pieces a move is rendered in, and how long each is (equal, never under 4 s). */
export function movePieces(start: number, end: number): Array<{ start: number; end: number; seconds: number }> {
  const len = end - start, n = Math.max(1, Math.floor(len / RESHOOT_LIMITS.move_piece + 1e-6)), each = len / n;
  return Array.from({ length: n }, (_, k) => ({ start: round2(start + k * each), end: round2(k + 1 === n ? end : start + (k + 1) * each), seconds: Math.max(RESHOOT_LIMITS.move_piece, Math.round(each)) }));
}

// ---------------------------------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------------------------------
export const ENDPOINTS: Record<Engine, string> = { seedance_edit: "bytedance/seedance-2.5/video-edit", wan: "alibaba/wan-3.0/reference-to-video", seedance_move: "bytedance/seedance-2.5/reference-to-video" };
/** What one second costs us at 720p (list; STUDIO_RESHOOT_SEEDANCE_USD / _WAN_USD follow the platform if it changes). */
export function engineUsdPerSecond(e: Engine, env: Env = process.env): number {
  const n = Number(e === "wan" ? env.STUDIO_RESHOOT_WAN_USD : env.STUDIO_RESHOOT_SEEDANCE_USD);
  return n > 0 ? n : e === "wan" ? 0.05 : SEEDANCE_EDIT_RATES["720p"];
}
/** One shot in two of the expensive engine is made twice in the worst case seen, one in two of the cheap one. */
export const RETRY_SHARE: Record<Engine, number> = { seedance_edit: 0.25, seedance_move: 0.25, wan: 0.5 };
/** Credits a second for an engine: the list price with its retry allowance, at the margin rule's tier for that price. */
export function creditsPerSecondFor(e: Engine, plans: PlanLike[], env: Env = process.env): number {
  const usd = engineUsdPerSecond(e, env) * (1 + RETRY_SHARE[e]);
  return Math.max(1, creditsForCost(usd, creditValueFloor(plans), marginForSecond(usd, plans)));
}
/** Seconds the platform bills for a shot: the source rounded up for an edit, whole pieces for a move, the asked
 *  duration (whole seconds) for the cheap engine. */
export function billedSeconds(s: Pick<Shot, "start" | "end">, e: Engine): number {
  if (e === "seedance_move") return movePieces(s.start, s.end).reduce((t, p) => t + p.seconds, 0);
  const len = s.end - s.start;
  return e === "wan" ? Math.max(2, Math.ceil(len - 0.05)) : Math.max(4, Math.ceil(len - 0.02));
}

// ---------------------------------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------------------------------
export type PricedShot = Shot & { engine: Engine | null; seconds: number; credits: number; cost_usd: number };
export type ReshootQuote = { tool: "reshoot"; credits: number; options: Record<string, any>; summary: string };
export function priceShots(shots: Shot[], plans: PlanLike[], env: Env = process.env): PricedShot[] {
  return shots.map((s) => {
    if (s.keep) return { ...s, engine: null, seconds: 0, credits: 0, cost_usd: 0 };
    const engine = engineFor(s), seconds = billedSeconds(s, engine);
    return { ...s, engine, seconds, credits: seconds * creditsPerSecondFor(engine, plans, env), cost_usd: Math.round(seconds * engineUsdPerSecond(engine, env) * 10000) / 10000 };
  });
}
export function quoteReshoot(env: Env, plans: PlanLike[], asset: { id: string; kind: string; probe: any; name: string } | null, raw: any, who: { owner?: boolean } = {}): ReshootQuote {
  if (!reshootEnabled(env)) throw new ReshootError("reshoot_off", "Reshoot is not switched on yet", 503);
  if (!reshootOpen(env) && !who.owner) throw new ReshootError("reshoot_off", "Reshoot is not open yet", 403);
  if (!asset || asset.kind !== "video") throw new ReshootError("video_not_found", "Pick a video of yours", 404);
  const seconds = Number(asset.probe?.duration);
  if (!(seconds > 0)) throw new ReshootError("asset_not_inspected", "The video is still being checked", 409);
  if (seconds < RESHOOT_LIMITS.min_seconds) throw new ReshootError("reshoot_too_short", `The video needs to be at least ${RESHOOT_LIMITS.min_seconds} seconds`);
  if (seconds > RESHOOT_LIMITS.max_seconds + 0.5) throw new ReshootError("reshoot_too_long", `Reshoot takes videos up to ${RESHOOT_LIMITS.max_seconds} seconds; trim this one or make a clip from it first`);
  const o = raw && typeof raw === "object" ? raw : {};
  if (o.rights !== true) throw new ReshootError("reshoot_rights", "Confirm that this is you, or people who agreed to be in it");
  // "one look" is the same edit as one shot per stretch, every shot with the same change and the camera kept. The
  // stretches are the ones the page showed and priced (sent as shots); a request without them is cut evenly.
  let shots: Shot[];
  if (o.mode === "look") {
    const look = cleanChange({ ...o.look, angle: "same", move: "none" });
    if (!changes(look)) throw new ReshootError("reshoot_nothing", "Pick a light, a place or an outfit");
    const cuts = Array.isArray(o.shots) && o.shots.length ? [...o.shots.map((s: any) => round2(Number(s?.start))), round2(Number(o.shots[o.shots.length - 1]?.end))] : autoCuts(seconds, []);
    shots = cleanShots(cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1], ...look })), seconds);
  } else shots = cleanShots(o.shots, seconds);
  const priced = priceShots(shots, plans, env);
  const changed = priced.filter((s) => !s.keep);
  const credits = changed.reduce((t, s) => t + s.credits, 0);
  return { tool: "reshoot", credits,
    options: { mode: o.mode === "look" ? "look" : "multicam", rights: true, seconds: round2(seconds), name: text(asset.name, 120), shots: priced, cost_usd: round2(changed.reduce((t, s) => t + s.cost_usd, 0)) },
    summary: `${changed.length} of ${priced.length} ${priced.length === 1 ? "shot" : "shots"} re-filmed · ${Math.round(seconds)} s video` };
}

// ---------------------------------------------------------------------------------------------------
// The plan: where the cuts go and what each shot could become
// ---------------------------------------------------------------------------------------------------
export const PLAN_SYSTEM = `You are the director turning one person's single-camera talking video into a multi-camera edit, as if a small crew had filmed it with several cameras. Every shot keeps the person's exact words, voice, mouth, gestures and timing; only the camera, and sometimes the light, the place or the outfit, changes.

You get, for each shot of the take (already cut on sentence breaks), a still from its middle and the words spoken in it.

For each shot choose:
- keep: true to leave it as filmed. Keep the first shot as filmed unless there is a strong reason; it shows the real take.
- angle: one of ${ANGLES.join(", ")}. Vary it from shot to shot like an editor would: a close-up on the strongest line, a three-quarter or side view for an aside, a wide or high shot to breathe. Never the same angle twice in a row.
- move: none, orbit or push_in. At most one move in a short video, two in a long one, and only on a shot that deserves it (the hook, the punchline). Most shots have none.
- light: same unless the words or the mood ask for something else (${LIGHTS.filter((l) => l !== "same").join(", ")}).
- place and outfit: empty. Only fill them when the words themselves call for it (they talk about the beach, the cold, a suit); a few words, e.g. "snowy mountain ridge".
- why: four words or fewer for the card ("The punchline", "An aside").

Never: a change that alters who the person is, text on screen, other people, anything about a real brand or a named public figure.`;
export const PLAN_SCHEMA = { type: "object", additionalProperties: false, required: ["shots"], properties: { shots: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "keep", "angle", "move", "light", "place", "outfit", "why"],
  properties: { index: { type: "integer" }, keep: { type: "boolean" }, angle: { type: "string", enum: [...ANGLES] }, move: { type: "string", enum: [...MOVES] }, light: { type: "string", enum: [...LIGHTS] }, place: { type: "string" }, outfit: { type: "string" }, why: { type: "string" } } } } } };

/** Claude's choices laid onto the cuts: anything missing or out of bounds falls back to the default rotation, moves
 *  over the cap (or on a shot too long or too short for one) are dropped, the result always passes cleanShots. */
export function mergePlan(cuts: number[], raw: unknown): Shot[] {
  const base = defaultShots(cuts), L = RESHOOT_LIMITS;
  const byIndex = new Map<number, any>();
  for (const r of Array.isArray(raw) ? raw : []) if (Number.isInteger((r as any)?.index)) byIndex.set((r as any).index, r);
  let moves = 0;
  const out = base.map((s, i) => {
    const r = byIndex.get(i);
    if (!r) return s;
    const c = cleanChange(r), len = s.end - s.start;
    if (c.move !== "none" && (moves >= L.max_moves || len > L.move_max || len < L.move_piece)) c.move = "none";
    if (c.move !== "none") moves++;
    if (len < L.shot_min - 0.01 || r.keep === true || !changes(c)) return { ...s, ...NO_CHANGE, keep: true, why: text(r.why, 80) || undefined };
    return { ...s, ...c, keep: false, why: text(r.why, 80) || undefined };
  });
  if (!out.some((s) => !s.keep)) return base;
  return out;
}

type ReshootDeps = ClipsDeps & {
  stills?: (video: string, times: number[], dir: string) => Promise<Buffer[]>;
  plan?: (stills: Array<{ index: number; jpeg: Buffer | null; words: string; start: number; end: number }>, seconds: number, userId: string) => Promise<unknown>;
  /** one shot re-filmed: the cut piece (and for a move, the picture it opens on) in, the result file out */
  render?: (ctx: ShotCtx) => Promise<{ file: string; requestId: string }>;
  check?: (ctx: { source: string; result: string; asked: string; user: string }) => Promise<{ verdict: Verdict; note?: string }>;
  /** how alike a result is to its source (PSNR, dB); tests replace the ffmpeg measure */
  likeness?: (source: string, result: string) => Promise<number | null>;
  join?: (ctx: JoinCtx) => Promise<void>;
  prepare?: (url: string, target: string) => Promise<void>;
  cut?: (source: string, from: number, to: number, target: string) => Promise<void>;
  retime?: (file: string, seconds: number, size: { w: number; h: number }, target: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  room?: (env: Env) => Promise<{ ok: boolean; why?: string }>;
};
const planKey = (u: string, assetId: string) => `${u}/reshoot/${assetId}.json`;
async function signed(sb: SupabaseClient, u: string, assetId: string) {
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "video") throw new ReshootError("video_not_found", "That video is not in your library", 404);
  const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 3 * 3600);
  if (s.error || !s.data?.signedUrl) throw new ReshootError("source_missing", "The video could not be read", 502, true);
  return { url: s.data.signedUrl, asset: a.data as { id: string; name: string; probe: any } };
}
async function defaultPlan(deps: ReshootDeps, shots: Array<{ index: number; jpeg: Buffer | null; words: string; start: number; end: number }>, seconds: number, userId: string): Promise<unknown> {
  const env = deps.env ?? process.env;
  const content: any[] = [];
  for (const s of shots) {
    content.push({ type: "text", text: `Shot ${s.index}: ${s.start.toFixed(1)} to ${s.end.toFixed(1)} s. Words: ${s.words || "(none)"}` });
    if (s.jpeg?.length) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.jpeg.toString("base64") } });
  }
  content.push({ type: "text", text: `The take is ${seconds.toFixed(1)} seconds long. Give one entry per shot, by index. Be brief: the person is waiting.` });
  const out = await claudeJson(deps, { model: env.STUDIO_RESHOOT_MODEL || "claude-sonnet-5-5", max_tokens: 2500, system: PLAN_SYSTEM, output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } }, messages: [{ role: "user", content }] }, "reshoot_plan", userId);
  return out?.shots;
}
/** The proposed edit for one library video: a kept one, or made now (and kept). */
export async function planFor(sb: SupabaseClient, deps: ReshootDeps, u: string, assetId: string, o: { fresh?: boolean; allowNew?: boolean } = {}): Promise<{ shots: Shot[]; seconds: number; words: Array<{ text: string; start: number; end: number }>; cached: boolean }> {
  const fresh = o.fresh === true && o.allowNew !== false;
  const { url, asset } = await signed(sb, u, assetId);
  const seconds = Number(asset.probe?.duration) || 0;
  if (!(seconds >= RESHOOT_LIMITS.min_seconds)) throw new ReshootError("reshoot_too_short", `The video needs to be at least ${RESHOOT_LIMITS.min_seconds} seconds`);
  if (seconds > RESHOOT_LIMITS.max_seconds + 0.5) throw new ReshootError("reshoot_too_long", `Reshoot takes videos up to ${RESHOOT_LIMITS.max_seconds} seconds; trim this one or make a clip from it first`);
  if (!fresh) {
    const kept = await sb.storage.from("studio-outputs").download(planKey(u, assetId));
    if (!kept.error && kept.data) { try { const d = JSON.parse(await kept.data.text()); if (Array.isArray(d?.shots) && d.shots.length) return { shots: cleanShots(d.shots, seconds), seconds, words: Array.isArray(d.words) ? d.words : [], cached: true }; } catch { /* planned again */ } }
  }
  if (o.allowNew === false) throw new ReshootError("reshoot_rate_limited", "That is a lot of new plans for one day; try again tomorrow", 429);
  // the words decide the cuts, so they are waited for here (a silent take is cut evenly)
  const words = await wordsFor(sb, deps, u, assetId).then((d) => docWords(d).map((w) => ({ text: w.text, start: w.start, end: w.end })), (e: any) => { deps.log?.(`[reshoot] no words for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); return [] as Array<{ text: string; start: number; end: number }>; });
  const cuts = autoCuts(seconds, words);
  const dir = await mkdtemp(join(tmpdir(), "studio-reshoot-plan-"));
  try {
    const mids = cuts.slice(0, -1).map((s, i) => round2((s + cuts[i + 1]) / 2));
    let jpegs: Array<Buffer | null> = mids.map(() => null);
    try {
      if (deps.stills) jpegs = await deps.stills(url, mids, dir);
      else { const ks = await keyStills(url, seconds, dir); jpegs = mids.map((t) => ks.reduce<{ at: number; jpeg: Buffer } | null>((b, k) => (!b || Math.abs(k.at - t) < Math.abs(b.at - t) ? k : b), null)?.jpeg ?? null); }
    } catch (e: any) { deps.log?.(`[reshoot] no stills for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); }
    const said = (a: number, b: number) => words.filter((w) => w.start >= a - 0.05 && w.start < b).map((w) => w.text).join(" ");
    const input = cuts.slice(0, -1).map((start, i) => ({ index: i, jpeg: jpegs[i] ?? null, words: said(start, cuts[i + 1]), start, end: cuts[i + 1] }));
    let raw: unknown = null;
    try { raw = deps.plan ? await deps.plan(input, seconds, u) : await defaultPlan(deps, input, seconds, u); }
    catch (e: any) { deps.log?.(`[reshoot] plan fell back to the default for ${assetId}: ${String(e?.message ?? e).slice(0, 120)}`); }
    const shots = cleanShots(mergePlan(cuts, raw), seconds);
    // kept as plain text: the bucket refuses JSON uploads (see Stunts)
    const keep = await sb.storage.from("studio-outputs").upload(planKey(u, assetId), Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), shots, words })), { contentType: "text/plain", upsert: true }).then((r: any) => r?.error ?? null, (e: any) => e);
    if (keep) deps.log?.(`[reshoot] plan not kept for ${assetId}: ${String(keep?.message ?? keep).slice(0, 120)}`);
    return { shots, seconds, words, cached: false };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// One shot on the platform
// ---------------------------------------------------------------------------------------------------
const KEEP_TAIL = "Keep the person's face, hair, body and clothes exactly the same, and their lip movements, mouth shapes, words, expressions, gestures and head movements in exactly the same timing as the source.";
/** Said when a still from an earlier shot of the same look is sent along, so every shot shows the same place and outfit. */
export const ANCHOR_WORDS = "The reference image is a still from another shot of this same video: match its place, its light and the person's outfit exactly.";
/** What the model is told for one shot (or one piece of a move). `anchored`: a still of an earlier shot with the same
 *  look is sent as the reference image. */
export function promptFor(s: Change, e: Engine, piece?: { k: number; n: number; chained: boolean }, anchored = false): string {
  const look = [LIGHT_WORDS[s.light], s.place ? `The place is now: ${s.place}, with the person in the same pose in it.` : "", s.outfit ? `The person now wears: ${s.outfit}.` : ""].filter(Boolean).join(" ");
  const keepAlso = `${s.light === "same" ? " Keep the same light." : ""}${s.place ? "" : " Keep the same place."}${s.outfit ? "" : " Keep the same clothes."}`;
  if (e === "seedance_move") {
    const k = piece?.k ?? 0, n = piece?.n ?? 1;
    // a first piece gets one picture (how the person looks); a later one opens on the last picture of the one before
    // (image 1) and is told how the person looks with image 2
    // Worded as a new shot whose only difference is the camera (the wording that orbited in the Nov 14 test). Long
    // "keep everything the same" lists read to the platform as an edit: it then refuses the duration and shape, or
    // renders the source's own camera path (the first live orbit, job 161c4b44).
    const move = MOVE_WORDS[s.move as Exclude<Move, "none">](k, n), also = look ? ` Also: ${look}` : "";
    if (piece?.chained) return `The video opens exactly on <<<image_1>>>. From that first frame, ${move}. The person does exactly the same movements with exactly the same timing as in <<<video_1>>>; only the camera differs from <<<video_1>>>. The same person, clothes, place and light throughout, as in <<<image_2>>>.${also}`.replace(/\s+/g, " ").trim();
    return `Recreate <<<video_1>>> exactly: the same person doing exactly the same movements with exactly the same timing as in <<<video_1>>>. The only difference is the camera: ${move}. <<<image_1>>> shows how the person looks.${also}`.replace(/\s+/g, " ").trim();
  }
  const anchor = anchored ? ` ${ANCHOR_WORDS}` : "";
  if (e === "wan") return `Recreate the reference video <<<video_1>>> shot for shot, filmed from a new camera position: ${ANGLE_WORDS[s.angle]}. ${look} ${KEEP_TAIL}${keepAlso} Only what is asked changes.${anchor}`.replace(/\s+/g, " ").trim();
  const camera = s.angle === "same" ? "Keep the same camera position and framing." : `Re-film it from a new camera angle: ${ANGLE_WORDS[s.angle]}.`;
  return `Re-film this exact clip. ${camera} ${look} ${KEEP_TAIL}${keepAlso} Only what is asked changes.${anchor}`.replace(/\s+/g, " ").trim();
}
/** The platform's nearest aspect ratio to the take (reference modes ask for one; edit mode follows the source). */
export function aspectFor(w: number, h: number): string {
  const r = w / h, options: Array<[string, number]> = [["9:16", 9 / 16], ["3:4", 3 / 4], ["1:1", 1], ["4:3", 4 / 3], ["16:9", 16 / 9]];
  return options.reduce((b, o) => (Math.abs(Math.log(o[1] / r)) < Math.abs(Math.log(b[1] / r)) ? o : b))[0];
}
type ShotCtx = { job: string; user: string; engine: Engine; key: string; prompt: string; videoUrl: string; imageUrls: string[]; seconds: number; aspect: string; requestId?: string | null; onSubmit?: (id: string) => Promise<void>; dir: string };
const POLL_MS = 8000, MAX_WAIT_MS = 25 * 60_000;
/** The request body for one shot (or one piece of a move), exactly as sent. */
export function bodyFor(c: Pick<ShotCtx, "engine" | "prompt" | "videoUrl" | "imageUrls" | "seconds" | "aspect">): Record<string, any> {
  const images = c.imageUrls.length ? { image_urls: c.imageUrls } : {};
  if (c.engine === "seedance_edit") return { prompt: c.prompt, video_url: c.videoUrl, ...images, resolution: "720p", generate_audio: false };
  if (c.engine === "wan") return { prompt: c.prompt, video_urls: [c.videoUrl], ...images, duration: c.seconds, resolution: "720p", aspect_ratio: c.aspect, generate_audio: false };
  return { prompt: c.prompt, video_urls: [c.videoUrl], image_urls: c.imageUrls, duration: c.seconds, resolution: "720p", aspect_ratio: c.aspect, generate_audio: false };
}
async function defaultRender(deps: ReshootDeps, c: ShotCtx): Promise<{ file: string; requestId: string }> {
  const env = deps.env ?? process.env, sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let requestId = c.requestId ?? null;
  if (!requestId) {
    const r = await hf(deps, `/${ENDPOINTS[c.engine]}`, { method: "POST", body: JSON.stringify(bodyFor(c)), idempotency: c.key });
    if (![200, 201, 202].includes(r.status) || !r.body?.request_id) throw new RecastError("recast_rejected", `Higgsfield ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    requestId = String(r.body.request_id);
    await c.onSubmit?.(requestId);
  }
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
    let st: { status: number; body: any };
    try { st = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }); }
    catch (e: any) { if (e instanceof RecastError && e.retry) { await sleep(POLL_MS); continue; } throw e; }
    const status = String(st.body?.status ?? "unknown").toLowerCase();
    if (status === "completed") {
      // the cost is written when a render is delivered, at the list rate: a failed or refused one is refunded by the
      // platform (the first live jobs wrote it when sent, which counted a refused render as paid)
      recordCost({ job_id: c.job, user_id: c.user, tool: "reshoot", provider: "higgsfield", product: ENDPOINTS[c.engine], source: `reshoot_${c.engine}`, units: { seconds: c.seconds }, usd: Math.round(c.seconds * engineUsdPerSecond(c.engine, env) * 10000) / 10000, basis: "list", ref: requestId });
      const url = outputUrls(st.body).videos[0];
      if (!url) throw new RecastError("recast_bad_output", "completed without a video");
      const dl = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(300_000) });
      if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
      const file = join(c.dir, `${requestId}.mp4`);
      await writeFile(file, Buffer.from(await dl.arrayBuffer()));
      return { file, requestId };
    }
    if (["failed", "nsfw", "canceled", "cancelled"].includes(status)) throw new RecastError(status === "nsfw" ? "recast_nsfw" : "recast_failed", JSON.stringify(st.body).slice(0, 200));
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------------
// Checks: did it change, is it the same person with the change made
// ---------------------------------------------------------------------------------------------------
export type Verdict = "good" | "weak" | "broken";
/** The average PSNR line ffmpeg prints, or null. */
export const parsePsnr = (log: string): number | null => { const m = log.match(/PSNR.*average:([0-9.]+|inf)/); return m ? (m[1] === "inf" ? 99 : Number(m[1])) : null; };
/** A result is a copy of its source when the two pictures are nearly the same; a real new angle, light or place is
 *  far below (13 to 18 dB measured on Nov 14 2026; the copies another engine sent back measured 29 and 31). */
export const isCopy = (psnr: number | null) => psnr != null && psnr >= RESHOOT_LIMITS.same_psnr;
async function defaultLikeness(source: string, result: string): Promise<number | null> {
  try {
    const log = await ffmpeg(["-v", "info", "-nostdin", "-i", source, "-i", result, "-filter_complex", "[0:v]fps=10,scale=180:-2,setsar=1,format=yuv420p[a];[1:v]fps=10,scale=180:-2,setsar=1,format=yuv420p[b];[a][b]psnr", "-f", "null", "-"], { timeoutMs: 120_000 });
    return parsePsnr(log);
  } catch { return null; }
}
const CHECK_SYSTEM = `You check one re-filmed shot of a person's video. You see a still from the real shot, then three stills from the re-filmed one in order, and what was asked to change.

- "good": clearly the same person (face, hair, build), and the asked change is visible (a different camera position, light, place or outfit as asked). Small differences in the background are normal.
- "weak": the same person, but the change is small or only partly there.
- "broken": a different-looking person, a badly malformed face or body, extra people, or nothing at all changed.
- A new camera angle was asked and the re-filmed stills show the person from the same side and distance as the real shot: "broken".
- A camera move was asked (orbit, push in) and no re-filmed still shows the camera clearly somewhere else than in the real shot (for an orbit, at least one still shows the person from a clearly different side; for a push in, the last still is clearly closer): "broken". A full orbit can end where it started, so judge all the stills. Following the real shot's own camera path is not a move.
When unsure between "good" and "weak", pick "good". The note is one short sentence, under 20 words.`;
const CHECK_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict", "note"], properties: { verdict: { type: "string", enum: ["good", "weak", "broken"] }, note: { type: "string" } } };
async function stillsOf(video: string, fractions: number[], dir: string): Promise<Buffer[]> {
  const len = await probeSeconds(video), out: Buffer[] = [], tag = randomUUID().slice(0, 8);
  for (let i = 0; i < fractions.length; i++) {
    const f = join(dir, `c${tag}-${i}.jpg`);
    await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", Math.max(0, len * fractions[i]).toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=384:-2,format=yuvj420p", "-q:v", "6", f], { timeoutMs: 60_000 });
    out.push(await readFile(f));
  }
  return out;
}
async function defaultCheck(deps: ReshootDeps, ctx: { source: string; result: string; asked: string; user: string }, dir: string): Promise<{ verdict: Verdict; note: string }> {
  const env = deps.env ?? process.env;
  if (env.STUDIO_RESHOOT_CHECK === "off") return { verdict: "good", note: "not checked" };
  try {
    const [real] = await stillsOf(ctx.source, [0.5], dir);
    const made = await stillsOf(ctx.result, [0.2, 0.5, 0.85], dir);
    const img = (b: Buffer) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } });
    const content = [{ type: "text", text: "The real shot:" }, img(real), { type: "text", text: "The re-filmed shot, in order:" }, ...made.map(img), { type: "text", text: `Asked to change: ${ctx.asked}` }];
    const out = await claudeJson(deps, { model: env.STUDIO_RESHOOT_CHECK_MODEL || "claude-haiku-5-5", max_tokens: 1200, system: CHECK_SYSTEM, output_config: { format: { type: "json_schema", schema: CHECK_SCHEMA } }, messages: [{ role: "user", content }] }, "reshoot_check", ctx.user);
    return { verdict: out?.verdict === "broken" ? "broken" : out?.verdict === "weak" ? "weak" : "good", note: text(out?.note, 200) };
  } catch (e: any) { deps.log?.(`[reshoot] check skipped: ${String(e?.message ?? e).slice(0, 120)}`); return { verdict: "good", note: "check skipped" }; } // a check that cannot run never costs the person their shot
}
/** A short label of what a shot asks for, for the check, the page and the report. */
export function describe(s: Change): string {
  const parts: string[] = [];
  if (s.angle !== "same") parts.push(s.angle.replace(/_/g, " "));
  if (s.move !== "none") parts.push(s.move.replace(/_/g, " "));
  if (s.light !== "same") parts.push(`${s.light.replace(/_/g, " ")} light`);
  if (s.place) parts.push(s.place);
  if (s.outfit) parts.push(`wearing ${s.outfit}`);
  return parts.join(", ") || "as filmed";
}

// ---------------------------------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------------------------------
type JoinCtx = { source: string; parts: Array<{ kind: "real"; from: number; to: number } | { kind: "made"; file: string; seconds: number }>; w: number; h: number; sourceAudio: boolean; seconds: number; target: string };
/** The ffmpeg graph for the edit. Input 0 is the take at the working size; inputs 1..n are the re-filmed shots, already
 *  retimed, in the order they appear. Every picture is brought to the take's size; the take's own sound runs under all. */
export function joinGraph(parts: JoinCtx["parts"], o: { w: number; h: number; sourceAudio: boolean; seconds: number }): string {
  const g: string[] = [], labels: string[] = [];
  const reals = parts.filter((p) => p.kind === "real").length;
  if (reals > 1) g.push(`[0:v]split=${reals}${Array.from({ length: reals }, (_, k) => `[sv${k}]`).join("")}`);
  let r = 0, m = 0;
  parts.forEach((p, i) => {
    if (p.kind === "real") {
      const sv = reals > 1 ? `[sv${r}]` : "[0:v]"; r++;
      g.push(`${sv}trim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p[v${i}]`);
    } else {
      m++;
      g.push(`[${m}:v]scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h},fps=30,setsar=1,format=yuv420p,trim=duration=${p.seconds.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    }
    labels.push(`[v${i}]`);
  });
  g.push(`${labels.join("")}concat=n=${parts.length}:v=1:a=0[v]`);
  g.push(o.sourceAudio ? `[0:a]atrim=duration=${o.seconds.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a]` : `anullsrc=r=44100:cl=stereo,atrim=duration=${o.seconds.toFixed(3)}[a]`);
  return g.join(";");
}
async function defaultJoin(c: JoinCtx): Promise<void> {
  const made = c.parts.filter((p): p is { kind: "made"; file: string; seconds: number } => p.kind === "made");
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-i", c.source, ...made.flatMap((p) => ["-i", p.file]), "-filter_complex", joinGraph(c.parts, c), "-map", "[v]", "-map", "[a]", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", c.target], { timeoutMs: 15 * 60_000 });
}
/** The stretch of the take one shot covers, with its sound (the platform reads timing from it). */
async function defaultCut(source: string, from: number, to: number, target: string): Promise<void> {
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", from.toFixed(3), "-i", source, "-t", (to - from).toFixed(3), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", target], { timeoutMs: 5 * 60_000 });
}
/** The factor a result is stretched by to fill its shot exactly (Seedance hands back about 4 % less time). */
export const retimeFactor = (shotSeconds: number, resultSeconds: number) => (resultSeconds > 0 ? Math.round((shotSeconds / resultSeconds) * 100000) / 100000 : 1);
async function defaultRetime(file: string, seconds: number, size: { w: number; h: number }, target: string): Promise<void> {
  const got = await probeSeconds(file), f = retimeFactor(seconds, got);
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-i", file, "-an", "-vf", `setpts=PTS*${f},scale=${size.w}:${size.h}:force_original_aspect_ratio=increase,crop=${size.w}:${size.h},fps=30,setsar=1,format=yuv420p`, "-t", seconds.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-movflags", "+faststart", target], { timeoutMs: 5 * 60_000 });
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };
type ShotState = "original" | "waiting" | "making" | "checking" | "again" | "made" | "kept";
export async function runReshootJob(sb: SupabaseClient, deps: ReshootDeps, job: Job): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const o = job.options ?? {}, u = job.user_id;
  const shots: PricedShot[] = Array.isArray(o.shots) ? o.shots : [];
  // shots run side by side and each reports its state; the reports are written one after another, each on top of the
  // one before, so an older one can never land last and undo a newer one (a lost request id would be sent again
  // after a restart: seen as a stale "waiting" on the first live job, Nov 14 2026)
  let queue: Promise<unknown> = Promise.resolve();
  const renew = (p: Record<string, any>): Promise<void> => {
    const next = queue.then(async () => {
      const merged = { ...(job.progress ?? {}), ...p };
      const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: merged });
      if (r.error) throw r.error;
      if (r.data !== true) throw new ReshootError("lease_lost", "lease lost");
      job.progress = merged;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  let dir: string | null = null;
  try {
    const todo = shots.map((s, i) => ({ s, i })).filter((x) => !x.s.keep && x.s.engine);
    if (!job.asset_id || !todo.length) throw new ReshootError("reshoot_nothing", "nothing to make");
    dir = await mkdtemp(join(tmpdir(), "studio-reshoot-"));
    const d = dir;
    const states: ShotState[] = shots.map((s) => (s.keep ? "original" : "waiting"));
    const say = (i: number, s: ShotState) => { states[i] = s; return renew({ states: [...states] }).catch(() => undefined); };
    await renew({ stage: "reading", done: 0, total: todo.length, states: [...states], message: "Reading your video", stage_at: new Date().toISOString() });
    const { url, asset } = await signed(sb, u, job.asset_id);
    const source = join(d, "source.mp4");
    await cutGate(env).run(() => (deps.prepare ? deps.prepare(url, source) : prepareSource(url, source)), () => renew({ message: "Next in line for the cutter" }).then(() => undefined));
    const test = !!deps.join;
    const dims = test ? { width: Number(asset.probe?.width) || 0, height: Number(asset.probe?.height) || 0 } : await probeDimensions(source);
    const size = workingSize(dims.width, dims.height), aspect = aspectFor(size.w, size.h);
    const info = test ? { hasAudio: true } : await probeStream(source);
    const seconds = test ? Number(o.seconds) : await probeSeconds(source);

    // every piece the platform reads is put where it can fetch it: the job's own work folder, signed for three hours
    const publish = async (file: string, name: string, type: "video/mp4" | "image/jpeg") => {
      const key = `${u}/${job.id}/work/${name}`;
      const up = await sb.storage.from("studio-outputs").upload(key, await readFile(file), { contentType: type, upsert: true });
      if (up.error) throw new ReshootError("reshoot_store_failed", String(up.error.message ?? up.error), 502, true);
      const s = await sb.storage.from("studio-outputs").createSignedUrl(key, 3 * 3600);
      if (s.error || !s.data?.signedUrl) throw new ReshootError("reshoot_store_failed", "could not sign a piece", 502, true);
      return s.data.signedUrl as string;
    };
    const requests: Record<string, string> = { ...(job.progress?.requests ?? {}) };
    const remember = async (key: string, id: string) => { requests[key] = id; await renew({ requests: { ...requests } }).catch(() => undefined); };
    const render = (c: ShotCtx) => (deps.render ? deps.render(c) : defaultRender(deps, c));
    const cut = (from: number, to: number, target: string) => (deps.cut ? deps.cut(source, from, to, target) : defaultCut(source, from, to, target));
    const retime = (file: string, secs: number, target: string) => (deps.retime ? deps.retime(file, secs, size, target) : defaultRetime(file, secs, size, target));

    /** One try at one shot: the re-filmed file, retimed to the shot's length. */
    const attempt = async (s: PricedShot, i: number, t: number, piece: string, anchorUrl: string | null): Promise<string> => {
      const len = round2(s.end - s.start), engine = s.engine as Engine;
      if (engine !== "seedance_move") {
        const pieceUrl = await publish(piece, `shot-${i}.mp4`, "video/mp4");
        const key = `${job.id}:${i}:${t}`;
        const got = await render({ job: job.id, user: u, engine, key, prompt: promptFor(s, engine, undefined, !!anchorUrl), videoUrl: pieceUrl, imageUrls: anchorUrl ? [anchorUrl] : [], seconds: s.seconds, aspect, requestId: requests[key] ?? null, onSubmit: (id) => remember(key, id), dir: d });
        const out = join(d, `shot-${i}-${t}.mp4`);
        await retime(got.file, len, out);
        return out;
      }
      // a move: 4 s pieces one after another, each opened on the last picture of the one before
      const parts = movePieces(s.start, s.end), files: string[] = [];
      const firstStill = join(d, `shot-${i}-look.jpg`);
      if (!test) await extractFrame(source, firstStill, s.start + 0.1); else await writeFile(firstStill, "");
      const lookUrl = await publish(firstStill, `shot-${i}-look.jpg`, "image/jpeg");
      let opener: string | null = null;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k], pc = join(d, `shot-${i}-p${k}.mp4`);
        await cut(p.start, p.end, pc);
        const pcUrl = await publish(pc, `shot-${i}-p${k}.mp4`, "video/mp4");
        const key = `${job.id}:${i}:${t}:${k}`;
        const got = await render({ job: job.id, user: u, engine, key, prompt: promptFor(s, engine, { k, n: parts.length, chained: k > 0 }), videoUrl: pcUrl, imageUrls: opener ? [opener, lookUrl] : [lookUrl], seconds: p.seconds, aspect, requestId: requests[key] ?? null, onSubmit: (id) => remember(key, id), dir: d });
        const out = join(d, `shot-${i}-${t}-p${k}.mp4`);
        await retime(got.file, round2(p.end - p.start), out);
        files.push(out);
        if (k + 1 < parts.length) {
          const last = join(d, `shot-${i}-${t}-p${k}-last.jpg`);
          if (!test) await ffmpeg(["-v", "error", "-nostdin", "-y", "-sseof", "-0.1", "-i", got.file, "-frames:v", "1", "-q:v", "2", last], { timeoutMs: 60_000 }); else await writeFile(last, "");
          opener = await publish(last, `shot-${i}-${t}-p${k}-last.jpg`, "image/jpeg");
        }
      }
      if (files.length === 1) return files[0];
      const joined = join(d, `shot-${i}-${t}.mp4`);
      if (test) await writeFile(joined, files.join("|"));
      else await ffmpeg(["-v", "error", "-nostdin", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, k) => `[${k}:v]`).join("")}concat=n=${files.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", joined], { timeoutMs: 5 * 60_000 });
      return joined;
    };

    const report: Array<{ state: ShotState; tries: number; verdict: Verdict | null; note: string; engine: Engine | null; file: string | null }> = shots.map((s) => ({ state: s.keep ? "original" : "waiting", tries: 0, verdict: null, note: "", engine: s.engine, file: null }));
    let finished = 0;
    await renew({ stage: "making", states: [...states], message: todo.length > 1 ? `Re-filming ${todo.length} shots` : "Re-filming the shot", stage_at: new Date().toISOString() });
    // Shots that share a look (the same new light, place or outfit) are matched to the first of them: it is made first,
    // and a still of it goes with the others as their reference picture. Made one by one, two shots of the same place
    // and outfit came back different (daylight and grey trousers, sunset and blue: the first live look, job 817b5481).
    // A move is never anchored (its pieces already carry pictures).
    const anchors = new Map<string, Promise<string | null>>(), settle = new Map<string, (url: string | null) => void>();
    const lookKey = (s: Shot) => (s.move === "none" && (s.place || s.outfit || s.light !== "same") ? `${s.light}|${s.place.toLowerCase()}|${s.outfit.toLowerCase()}` : null);
    const leaderOf = new Map<number, boolean>();
    for (const { s, i } of todo) { const k = lookKey(s); if (k && !anchors.has(k)) { anchors.set(k, new Promise((r) => settle.set(k, r))); leaderOf.set(i, true); } }
    const stillOf = async (file: string, i: number): Promise<string | null> => {
      try {
        const jpg = join(d, `anchor-${i}.jpg`);
        if (test) await writeFile(jpg, ""); else await extractFrame(file, jpg, Math.max(0, (await probeSeconds(file)) / 2));
        return await publish(jpg, `anchor-${i}.jpg`, "image/jpeg");
      } catch { return null; }
    };
    await Promise.all(todo.map(async ({ s, i }) => {
      const k = lookKey(s), leads = leaderOf.get(i) === true;
      try {
        // a shot of a shared look that is not the first waits for the first one's still (none if that one failed)
        const anchorUrl = k && !leads ? await anchors.get(k)! : null;
        await say(i, "making");
        const piece = join(d, `shot-${i}.mp4`);
        await cut(s.start, s.end, piece);
        for (let t = 1; t <= RESHOOT_LIMITS.tries; t++) {
          let file: string;
          try { file = await attempt(s, i, t, piece, anchorUrl); }
          catch (e: any) {
            if (e instanceof RecastError && ["recast_auth", "recast_balance", "recast_not_configured"].includes(e.code)) throw e; // ours to fix, not this shot's fault
            report[i].tries = t; report[i].note = e instanceof RecastError ? e.code : "error";
            log(`[reshoot] shot ${i + 1} try ${t} of ${job.id}: ${String(e?.message ?? e).slice(0, 160)}`);
            if (e instanceof RecastError && e.code === "recast_nsfw") break; // refused: the platform will refuse it again
            if (t < RESHOOT_LIMITS.tries) await say(i, "again");
            continue;
          }
          report[i].tries = t;
          await say(i, "checking");
          const psnr = deps.likeness ? await deps.likeness(piece, file) : test ? null : await defaultLikeness(piece, file);
          if (isCopy(psnr)) { report[i].note = `unchanged (${psnr} dB)`; log(`[reshoot] shot ${i + 1} try ${t} of ${job.id}: unchanged copy, ${psnr} dB`); if (t < RESHOOT_LIMITS.tries) await say(i, "again"); continue; }
          const looked = deps.check ? await deps.check({ source: piece, result: file, asked: describe(s), user: u }) : await defaultCheck(deps, { source: piece, result: file, asked: describe(s), user: u }, d);
          log(`[reshoot] shot ${i + 1} try ${t} of ${job.id}: ${looked.verdict}${looked.note ? ` (${looked.note})` : ""}`);
          report[i].verdict = looked.verdict; report[i].note = looked.note ?? "";
          if (looked.verdict !== "broken") { report[i].file = file; break; }
          if (t < RESHOOT_LIMITS.tries) await say(i, "again");
        }
      } finally {
        if (k && leads) settle.get(k)!(report[i].file ? await stillOf(report[i].file!, i) : null);
        finished++;
        report[i].state = report[i].file ? "made" : "kept";
        states[i] = report[i].state;
        await renew({ done: finished, states: [...states], message: finished < todo.length ? `${finished} of ${todo.length} shots re-filmed` : "Cutting your edit together" }).catch(() => undefined);
      }
    }));
    const made = todo.filter(({ i }) => report[i].file);
    if (!made.length) throw new ReshootError(todo.some(({ i }) => report[i].note === "recast_nsfw") ? "reshoot_refused" : "reshoot_failed", "None of the shots could be re-filmed", 502, false);

    await renew({ stage: "joining", message: "Cutting your edit together", stage_at: new Date().toISOString() });
    // the edit: each shot either the take as filmed or its re-filmed file; neighbouring kept shots run as one stretch
    const parts: JoinCtx["parts"] = [];
    shots.forEach((s, i) => {
      const f = report[i].file;
      if (f) parts.push({ kind: "made", file: f, seconds: round2(s.end - s.start) });
      else { const last = parts[parts.length - 1]; if (last?.kind === "real" && Math.abs(last.to - s.start) < 0.02) last.to = s.end; else parts.push({ kind: "real", from: s.start, to: s.end }); }
    });
    const out = join(d, "out.mp4"), still = join(d, "out.jpg");
    const jc: JoinCtx = { source, parts, w: size.w, h: size.h, sourceAudio: info.hasAudio, seconds, target: out };
    await cutGate(env).run(() => (deps.join ? deps.join(jc) : defaultJoin(jc)), () => renew({ message: "Next in line for the cutter" }).then(() => undefined));
    let posterOk = true;
    try { if (!test) await makePoster(out, still); else posterOk = false; } catch { posterOk = false; }
    const bytes = (await stat(out)).size, base = `${u}/${job.id}/${job.lease_token}/1`;
    const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, await readFile(out), { contentType: "video/mp4", upsert: false });
    if (up.error) throw new ReshootError("reshoot_store_failed", String(up.error.message ?? up.error), 502, true);
    if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (p.error) posterOk = false; }
    const shotReport = shots.map((s, i) => ({ start: s.start, end: s.end, change: describe(s), keep: s.keep, engine: s.engine, made: !!report[i].file, verdict: report[i].verdict, tries: report[i].tries, credits: report[i].file ? s.credits : 0 }));
    const outputs = [{ index: 1, key: `${base}.mp4`, poster_key: posterOk ? `${base}.jpg` : undefined, kind: "video", bytes, duration: round2(seconds), tool: "reshoot", shots: shotReport }];
    const charged = Math.min(job.credits_reserved, shotReport.reduce((t, s) => t + s.credits, 0));
    const outcome = made.length < todo.length ? "partial" : "done";
    await renew({ stage: "done", outcome, made_count: made.length, charged, shots: shotReport }).catch(() => undefined);
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
    if (done.error) throw done.error;
    const tries = report.reduce((t, r) => t + r.tries, 0);
    recordEvent({ user_id: u, kind: "feature", name: "reshoot_done", props: { job: job.id, asked: todo.length, made: made.length, tries, credits: charged, seconds: round2(seconds), moves: todo.filter(({ s }) => s.engine === "seedance_move").length } });
    log(`[reshoot] made ${JSON.stringify({ job: job.id, asked: todo.length, made: made.length, tries, seconds: round2(seconds), charged })}`);
    return outcome;
  } catch (e: any) {
    const code = e instanceof ClipsError || e instanceof RecastError ? e.code : "reshoot_failed";
    if (code === "lease_lost") return code;
    const retry = e instanceof ClipsError || e instanceof RecastError ? e.retry : true;
    log(`[reshoot] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    const f = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry });
    if (f.error) log(`[reshoot] could not record the failure of ${job.id}: ${f.error.message}`);
    return code;
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** One run at a time by default (STUDIO_RESHOOT_PARALLEL, 1 to 4): the waiting is on the platform, the cutting goes
 *  through the server's cutter shared with Clips, Captions and Stunts. */
export function startReshootLoop(sbFn: () => SupabaseClient, deps: ReshootDeps = {}, intervalMs = 10_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!reshootEnabled(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `reshoot-${randomUUID()}`, max = Math.max(1, Math.min(4, Number(env.STUDIO_RESHOOT_PARALLEL) || 1));
  const active = new Set<string>();
  let claiming = false;
  const tick = async () => {
    if (claiming || active.size >= max) return;
    claiming = true;
    try {
      const sb = sbFn();
      const room = await (deps.room ?? roomForAnother)(env);
      if (!room.ok) return;
      const r = await sb.rpc("studio_claim", { p_tool: "reshoot", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      active.add(job.id);
      const keep = setInterval(() => { sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: job.progress ?? {} }).then(() => undefined, () => undefined); }, 4 * 60_000);
      runReshootJob(sb, { ...deps, log }, job).then((s) => log(`[reshoot] ${s} ${job.id}`)).catch((e) => log(`[reshoot] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { clearInterval(keep); active.delete(job.id); });
    } catch (e: any) { log(`[reshoot] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { claiming = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 31_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
/** What the page needs before anything is picked: limits, the choices, and the price a second per engine. */
export function reshootConfig(env: Env, plans: PlanLike[]) {
  const L = RESHOOT_LIMITS;
  return {
    limits: { min_seconds: L.min_seconds, max_seconds: L.max_seconds, shot_min: L.shot_min, shot_max: L.shot_max, move_max: L.move_max, max_moves: L.max_moves, max_shots: L.max_shots, text_max: L.text_max },
    angles: ANGLES, moves: MOVES, lights: LIGHTS, places: PLACES,
    credits_per_second: { seedance_edit: creditsPerSecondFor("seedance_edit", plans, env), seedance_move: creditsPerSecondFor("seedance_move", plans, env), wan: creditsPerSecondFor("wan", plans, env) },
  };
}
export function registerReshoot(app: Express, h: Pick<LibraryHelpers, "sbFn" | "env" | "requireUser" | "fail" | "log" | "plans"> & { isOwner: (req: any, sb: SupabaseClient) => Promise<boolean> }, deps: ReshootDeps = {}): void {
  app.get("/api/studio/reshoot/config", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      if (!reshootEnabled(h.env) || (!reshootOpen(h.env) && !(await h.isOwner(req, sb)))) throw new ReshootError("reshoot_off", "Reshoot is not open yet", 403);
      res.json(reshootConfig(h.env, h.plans));
    } catch (e) { h.fail(res, e); }
  });
  // The proposed edit: cuts on the words, a change per shot. Needs a plan; a fresh one 20 times a day (a kept one is free).
  app.post("/api/studio/reshoot/plan", async (req, res) => {
    const u = h.requireUser(req, res); if (!u) return;
    try {
      const sb = h.sbFn();
      const owner = await h.isOwner(req, sb);
      if (!reshootEnabled(h.env) || (!reshootOpen(h.env) && !owner)) throw new ReshootError("reshoot_off", "Reshoot is not open yet", 403);
      const assetId = String(req.body?.asset_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new ReshootError("video_not_found", "Pick a video", 404);
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(owner || (c.data && (["active", "trialing"].includes(c.data.status) || c.data.owner_pass)))) throw new ReshootError("subscription_required", "Reshoot comes with a plan", 409);
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_events").select("id", { count: "exact", head: true }).eq("user_id", u).eq("name", "reshoot_plan").gte("created_at", since);
      const out = await planFor(sb, { ...deps, env: h.env, log: h.log }, u, assetId, { fresh: req.body?.fresh === true, allowNew: (n.count ?? 0) < RESHOOT_LIMITS.plans_per_day });
      if (!out.cached) recordEvent({ user_id: u, kind: "feature", name: "reshoot_plan", props: { asset: assetId, shots: out.shots.length, seconds: out.seconds } });
      res.json({ shots: priceShots(out.shots, h.plans, h.env), seconds: out.seconds, words: out.words });
    } catch (e) { h.fail(res, e); }
  });
}
