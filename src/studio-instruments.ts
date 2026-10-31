// Clone8 Studio: Instruments. Every model on Higgsfield's platform API, offered as one generic tool so a new
// model is a row in the catalog, not a new page, runner and price table.
//
//   catalog   src/data/higgsfield-catalog.json, generated from docs.higgsfield.ai (the complete JSON schema of every
//             documented endpoint, 83 of them on Oct 29, 2026). Our own first-class tools (Recast, Swap, Styles,
//             Trends, Characters) sit on three of these and stay as they are; the rest are "instruments".
//   quote     the person's parameters are validated against the model's schema, media fields are mapped from their
//             library assets, and Higgsfield's own estimate endpoint prices the exact request in USD. Credits follow
//             the same margin rule as every other tool (studio-pricing.ts). A static list-price table backs the
//             estimate up; a model with neither cannot be quoted and says so.
//   run       one runner claims `instrument` jobs, signs the inputs, submits, polls, stores the video or images, and
//             charges what was reserved. Failures refund through studio_fail like every other tool.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import catalogJson from "./data/higgsfield-catalog.json";
import elevenJson from "./data/eleven-catalog.json";
import { elevenEnabled, runElevenJob } from "./studio-eleven.js";
import { HF_BASE, higgsfieldAuth, RecastError, makePoster, probeSeconds } from "./studio-recast.js";
import { toJpeg } from "./studio-characters.js";
import { creditValueFloor, creditsForCost, higgsfieldDiscount, marginForSecond, seedanceDiscount, MARGIN_TARGET, type PlanLike } from "./studio-pricing.js";

export type InstrumentKind = "text_to_video" | "image_to_video" | "reference_to_video" | "video_edit" | "video_extend" | "motion_control" | "text_to_image" | "image_edit" | "text_to_audio" | "audio_edit" | "transcribe";
/** How an audio instrument is priced: per thousand characters of text, per minute of sound or clip, per generation, per hour. */
export type Pricing = { per: "kchars" | "minute" | "generation" | "hour"; usd: number };
export type MediaKind = "image" | "video" | "audio";
export type Instrument = {
  id: string; title: string; family: string; provider: string; kind: InstrumentKind; output: "video" | "image" | "audio" | "text";
  summary: string; notes: string[]; media_fields: Record<string, MediaKind>; required: string[]; schema: any; docs: string;
  /** audio instruments: the list price and what it is measured in; `minutes_from` says where the minutes come from */
  pricing?: Pricing; minutes_from?: "source" | "length";
  /** the vendor's path for this model when our public id differs (vendor-named ids get a clone8/ alias) */
  api_path?: string;
};
type Catalog = { generated_at: string; source: string; models: Instrument[] };
/** What each kind does, for models whose scraped summary is unusable. */
const KIND_SUMMARY: Record<InstrumentKind, string> = {
  text_to_video: "Footage from a description alone.", image_to_video: "A picture starts moving; a last frame can end it where you want.",
  reference_to_video: "New footage built from pictures, clips and words together.", video_edit: "Change what is in a clip you already have, with words and reference pictures.",
  video_extend: "Make a clip run longer; the model continues the motion.", motion_control: "A picture performs the motion of a video.",
  text_to_image: "A picture from a description.", image_edit: "Edit a picture with words.", text_to_audio: "Sound from words: a voice over, an effect or music.",
  audio_edit: "The sound of a clip changes while the picture stays.", transcribe: "What is said in a clip, written down with timings.",
};
// The catalog was scraped from the vendor's docs. Nothing that names the vendor reaches a person or the assistant:
// vendor-named ids get a clone8/ alias (calls still go to the real path), scraped boilerplate summaries are replaced,
// developer notes and doc links are dropped, and a vendor maker reads as Clone8.
const VENDOR_PATH = /^higgsfield(?:-ai)?\//;
const VENDOR_TEXT = /higgsfiel|documentation index|llms\.txt|https?:\/\//i;
const DEV_NOTE = /higgsfiel|https?:\/\/|\b(GET|POST) \/|endpoint|integration|preset\\?_id|UUID/i;
export function cleanInstrument(m: Instrument): Instrument {
  return {
    ...m, id: VENDOR_PATH.test(m.id) ? m.id.replace(VENDOR_PATH, "clone8/") : m.id, api_path: m.api_path ?? m.id,
    provider: /higgsfield/i.test(m.provider) ? "Clone8" : m.provider, summary: !m.summary || VENDOR_TEXT.test(m.summary) ? KIND_SUMMARY[m.kind] : m.summary,
    notes: m.notes.filter((n) => !DEV_NOTE.test(n)), docs: "",
  };
}
/** The vendor's path for a model: what the HTTP calls and the list prices use. */
export const apiPath = (m: Instrument) => m.api_path ?? m.id;
const RAW_CATALOG = catalogJson as unknown as Catalog;
const CATALOG: Catalog = { ...RAW_CATALOG, models: RAW_CATALOG.models.map(cleanInstrument) };
const ELEVEN = elevenJson as unknown as Catalog;

/** Endpoints our first-class tools already own; they are not offered twice. */
export const FIRST_CLASS = new Set(["higgsfield/genjutsu/motion-transfer/v1.0", "higgsfield/genjutsu/object-swap/v1.0", "higgsfield/genjutsu/restyle/v1.0"]);
/** Audio references need an asset kind the library does not keep yet; those fields are hidden until it does. */
const UNSUPPORTED_MEDIA: MediaKind[] = ["audio"];

export const KIND_LABEL: Record<InstrumentKind, string> = {
  text_to_video: "Video from words", image_to_video: "Video from a picture", reference_to_video: "Video from references", video_edit: "Edit a video",
  video_extend: "Extend a video", motion_control: "Motion onto a picture", text_to_image: "Picture from words", image_edit: "Edit a picture",
  text_to_audio: "Sound from words", audio_edit: "Change the sound of a clip", transcribe: "Words from a clip",
};

/** Every instrument we know, whatever the keys: the video models and the audio ones. */
export function allInstruments(): Instrument[] {
  return [...CATALOG.models.filter((m) => !FIRST_CLASS.has(apiPath(m))), ...ELEVEN.models];
}
/** The instruments on offer: the video models need HIGGSFIELD_API_KEY, the audio ones ELEVENLABS_API_KEY, all behind
 *  STUDIO_INSTRUMENTS_ENABLED=true, narrowed by an allow list or a hidden list. */
export function instrumentsEnabled(env: Record<string, string | undefined> = process.env): Instrument[] {
  if (env.STUDIO_INSTRUMENTS_ENABLED !== "true") return [];
  const allow = split(env.STUDIO_INSTRUMENTS_ALLOW), hide = new Set(split(env.STUDIO_INSTRUMENTS_HIDDEN));
  return allInstruments().filter((m) => (m.provider === "elevenlabs" ? elevenEnabled(env) : !!env.HIGGSFIELD_API_KEY) && (!allow.length || allow.includes(m.id) || allow.includes(apiPath(m))) && !hide.has(m.id) && !hide.has(apiPath(m)));
}
const split = (s?: string) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export const instrumentById = (id: unknown, env?: Record<string, string | undefined>): Instrument | null => instrumentsEnabled(env).find((m) => m.id === id || apiPath(m) === id) ?? null;

// ---------------------------------------------------------------------------------------------------
// Parameters: a small JSON-schema check, enough for what the catalog uses (types, enums, ranges, arrays).
// Media fields are not parameters: the person names library assets and the runner signs them into URLs.
// ---------------------------------------------------------------------------------------------------
export class InstrumentError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }
export const MAX_PROMPT = 2000;

export function validateParams(inst: Instrument, raw: any): Record<string, any> {
  const props: Record<string, any> = inst.schema?.properties ?? {};
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(props)) {
    if (inst.media_fields[name]) continue;
    const v = input[name];
    if (v === undefined || v === null || v === "") continue;
    out[name] = checkValue(name, def, v);
  }
  for (const name of inst.required) {
    if (inst.media_fields[name]) continue;
    if (out[name] === undefined) throw new InstrumentError("param_required", `${name} is required`);
  }
  for (const name of Object.keys(input)) if (!(name in props)) throw new InstrumentError("param_unknown", `${name} is not a setting of this model`);
  return out;
}
function checkValue(name: string, def: any, v: any): any {
  const types = ([] as string[]).concat(def.type ?? (def.enum ? typeof def.enum[0] : "string"));
  if (def.enum) { if (!def.enum.includes(v)) throw new InstrumentError("param_invalid", `${name} must be one of ${def.enum.join(", ")}`); return v; }
  if (types.includes("boolean")) { if (typeof v === "boolean") return v; if (v === "true" || v === "false") return v === "true"; throw new InstrumentError("param_invalid", `${name} must be true or false`); }
  if (types.includes("integer") || types.includes("number")) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new InstrumentError("param_invalid", `${name} must be a number`);
    if (types.includes("integer") && !types.includes("number") && !Number.isInteger(n)) throw new InstrumentError("param_invalid", `${name} must be a whole number`);
    if (def.minimum != null && n < def.minimum) throw new InstrumentError("param_invalid", `${name} must be at least ${def.minimum}`);
    if (def.maximum != null && n > def.maximum) throw new InstrumentError("param_invalid", `${name} must be at most ${def.maximum}`);
    return n;
  }
  if (types.includes("array")) {
    if (!Array.isArray(v)) throw new InstrumentError("param_invalid", `${name} must be a list`);
    if (def.minItems != null && v.length < def.minItems) throw new InstrumentError("param_invalid", `${name} needs at least ${def.minItems}`);
    if (def.maxItems != null && v.length > def.maxItems) throw new InstrumentError("param_invalid", `${name} takes at most ${def.maxItems}`);
    return v.map((x, i) => checkValue(`${name}[${i}]`, def.items ?? { type: "string" }, x));
  }
  if (types.includes("object")) { if (!v || typeof v !== "object" || Array.isArray(v)) throw new InstrumentError("param_invalid", `${name} must be an object`); return v; }
  // string
  const s = String(v);
  const max = Math.min(def.maxLength ?? MAX_PROMPT, MAX_PROMPT);
  if (def.minLength != null && s.length < def.minLength) throw new InstrumentError("param_invalid", `${name} is too short`);
  if (s.length > max) throw new InstrumentError("param_invalid", `${name} is longer than ${max} characters`);
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Which library assets fill which media fields: { image_url: "<asset id>", image_urls: ["<id>", …] }. */
export function validateInputs(inst: Instrument, raw: any): Record<string, string | string[]> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out: Record<string, string | string[]> = {};
  for (const [name, kind] of Object.entries(inst.media_fields)) {
    if (UNSUPPORTED_MEDIA.includes(kind)) continue;
    const def = inst.schema?.properties?.[name] ?? {};
    const v = input[name];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length) || v === "") continue;
    if (def.type === "array" || /s$/.test(name)) {
      const ids = ([] as any[]).concat(v).map(String);
      if (!ids.every((id) => UUID_RE.test(id))) throw new InstrumentError("input_invalid", `${name} must name files from your library`);
      if (def.maxItems != null && ids.length > def.maxItems) throw new InstrumentError("input_invalid", `${name} takes at most ${def.maxItems} files`);
      out[name] = ids;
    } else {
      if (Array.isArray(v) || !UUID_RE.test(String(v))) throw new InstrumentError("input_invalid", `${name} must name a file from your library`);
      out[name] = String(v);
    }
  }
  for (const name of inst.required) if (inst.media_fields[name] && !UNSUPPORTED_MEDIA.includes(inst.media_fields[name]) && out[name] === undefined) throw new InstrumentError("input_required", `${name} is required`);
  for (const name of Object.keys(input)) if (!inst.media_fields[name]) throw new InstrumentError("input_unknown", `${name} is not a media field of this model`);
  return out;
}
/** Every asset id an instrument job refers to, in order. */
export const inputAssetIds = (inputs: Record<string, string | string[]>): string[] => [...new Set(Object.values(inputs).flatMap((v) => ([] as string[]).concat(v)))];

// ---------------------------------------------------------------------------------------------------
// Price. Higgsfield's estimate endpoint answers in USD for the exact request; our credits follow from the
// margin rule. The table below is the published list price (open.higgsfield.ai, Oct 29, 2026) for when the
// estimate is unavailable; a family absent from both cannot be quoted.
// ---------------------------------------------------------------------------------------------------
/** `by_resolution`: what a second costs at each output size; `usd` is used when the size is not one of them. */
export type UnitPrice = { per: "second" | "image"; usd: number; by_resolution?: Partial<Record<string, number>> };
// Seedance bills by output size. Seedance 2.5 at 720p (its default) lists at $0.4622 a second and 1080p at $1.137
// (open.higgsfield.ai, Oct 30 2026; our Oct 30 bills match); the $0.206 "from" price undercharged every 720p run by more
// than half. Video edit / reference: 480p from the pricing page; text/image-to-video 480p from the page, 720p and 1080p
// taken at the edit rates (unmeasured, on the safe side). Seedance 2.0: the page's 480p, scaled like 2.5 (estimates).
const SEEDANCE_25_EDIT = { "480p": 0.174, "720p": 0.463, "1080p": 1.137 }, SEEDANCE_25_GEN = { "480p": 0.145, "720p": 0.463, "1080p": 1.137 };
const SEEDANCE_20_REF = { "480p": 0.118, "720p": 0.314, "1080p": 0.771 }, SEEDANCE_20_GEN = { "480p": 0.099, "720p": 0.264, "1080p": 0.647 };
export const LIST_PRICES: Record<string, UnitPrice> = {
  "bytedance/seedance-2.5": { per: "second", usd: 0.463, by_resolution: SEEDANCE_25_GEN },
  "bytedance/seedance-2.5/video-edit": { per: "second", usd: 0.463, by_resolution: SEEDANCE_25_EDIT }, "bytedance/seedance-2.5/video-extend": { per: "second", usd: 0.463, by_resolution: SEEDANCE_25_EDIT },
  "bytedance/seedance-2.5/reference-to-video": { per: "second", usd: 0.463, by_resolution: SEEDANCE_25_EDIT },
  "bytedance/seedance-2.0": { per: "second", usd: 0.264, by_resolution: SEEDANCE_20_GEN }, "bytedance/seedance-2.0/reference-to-video": { per: "second", usd: 0.314, by_resolution: SEEDANCE_20_REF },
  "minimax/h3": { per: "second", usd: 0.13 }, "alibaba/wan-3.0-prime": { per: "second", usd: 0.068 }, "alibaba/wan-3.0": { per: "second", usd: 0.05 },
  "higgsfield/cinema-studio": { per: "second", usd: 0.206 }, "kling-video/v3.0": { per: "second", usd: 0.084 }, "kling-video/v3.0-turbo": { per: "second", usd: 0.084 },
  "lightricks/ltx-2.5/image-to-video/fast": { per: "second", usd: 0.09 }, "lightricks/ltx-2.5/text-to-video/fast": { per: "second", usd: 0.09 },
  "lightricks/ltx-2.5/image-to-video/pro": { per: "second", usd: 0.12 }, "lightricks/ltx-2.5/text-to-video/pro": { per: "second", usd: 0.12 },
  "xai/grok-imagine-video": { per: "second", usd: 0.08 }, "wan/v2.7": { per: "second", usd: 0.1 },
  "xai/grok-imagine-image-2.0": { per: "image", usd: 0.04 }, "marketing-studio/image": { per: "image", usd: 0.016 }, "higgsfield/ads-studio": { per: "image", usd: 0.084 },
  "higgsfield-ai/soul/standard": { per: "image", usd: 0.094 }, "higgsfield-ai/soul/v2/standard": { per: "image", usd: 0.094 }, "higgsfield-ai/soul/cinema": { per: "image", usd: 0.094 },
  "ideogram/v4.0": { per: "image", usd: 0.03 }, "recraft/v4.1": { per: "image", usd: 0.035 }, "alibaba/qwen-image-3": { per: "image", usd: 0.04 }, "z-image/turbo": { per: "image", usd: 0.015 },
};
export function listPrice(id: string): UnitPrice | null {
  const key = Object.keys(LIST_PRICES).filter((k) => id === k || id.startsWith(k + "/")).sort((a, b) => b.length - a.length)[0];
  return key ? LIST_PRICES[key] : null;
}
/** Units a request will be billed for by the table: seconds asked for (or the source's), or images. */
export function tableUnits(inst: Instrument, params: Record<string, any>, sourceSeconds: number | null): number {
  if (inst.pricing) {
    const p = inst.pricing;
    if (p.per === "kchars") return Math.max(0.1, Math.round((String(params.text ?? params.prompt ?? "").length / 1000) * 100) / 100);
    if (p.per === "generation") return 1;
    const seconds = inst.minutes_from === "length" ? Number(params.length_seconds ?? 30) : Number(sourceSeconds ?? 0);
    if (p.per === "hour") return Math.max(1 / 60, Math.round((seconds / 3600) * 1000) / 1000);
    return Math.max(0.1, Math.round((seconds / 60) * 100) / 100);
  }
  if (inst.output === "image") return Math.max(1, Math.floor(Number(params.batch_size ?? 1)) || 1);
  const asked = Number(params.duration);
  if (Number.isFinite(asked) && asked > 0) return Math.ceil(asked);
  if (sourceSeconds && sourceSeconds > 0) return Math.ceil(sourceSeconds + 0.1);
  const d = inst.schema?.properties?.duration?.default;
  return Number.isFinite(Number(d)) && Number(d) > 0 ? Math.ceil(Number(d)) : 5;
}
export function tableUsd(inst: Instrument, params: Record<string, any>, sourceSeconds: number | null): number | null {
  if (inst.pricing) return inst.pricing.usd * tableUnits(inst, params, sourceSeconds);
  const p = listPrice(apiPath(inst));
  if (!p) return null;
  const size = String(params.resolution ?? inst.schema?.properties?.resolution?.default ?? "");
  return (p.by_resolution?.[size] ?? p.usd) * tableUnits(inst, params, sourceSeconds);
}
/** What a unit is called on a card: "a second", "an image", "a minute", "1,000 characters", "a sound", "an hour". */
export function unitLabel(inst: Instrument): string {
  if (inst.pricing) return ({ kchars: "1,000 characters", minute: "a minute", generation: "a sound", hour: "an hour" } as Record<string, string>)[inst.pricing.per];
  return inst.output === "image" ? "an image" : "a second";
}

export type InstrumentDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number;
  toJpeg?: (bytes: Buffer) => Promise<Buffer>; poster?: (video: string, target: string) => Promise<void>; probeSeconds?: (path: string) => Promise<number> };

async function hf(deps: InstrumentDeps, path: string, init: RequestInit & { idempotency?: string } = {}): Promise<{ status: number; body: any }> {
  const key = deps.env?.HIGGSFIELD_API_KEY ?? process.env.HIGGSFIELD_API_KEY;
  if (!key) throw new RecastError("recast_not_configured");
  const headers: Record<string, string> = { authorization: higgsfieldAuth(key), "content-type": "application/json", accept: "application/json" };
  if (init.idempotency) headers["idempotency-key"] = init.idempotency;
  const r = await (deps.fetch ?? fetch)(path.startsWith("http") ? path : `${HF_BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  if (r.status === 401 || r.status === 403) throw new RecastError("recast_auth", `Higgsfield refused the key (${r.status})`);
  if (r.status === 402) throw new RecastError("recast_balance", "Higgsfield balance exhausted");
  if (r.status === 429 || r.status >= 500) throw new RecastError("recast_unavailable", `Higgsfield ${r.status}`, true);
  return { status: r.status, body };
}

/** USD for this exact request from Higgsfield's estimate endpoint, or null when it has no answer. Never throws for a 4xx. */
export async function estimateUsd(deps: InstrumentDeps, endpoint: string, body: Record<string, any>): Promise<number | null> {
  try {
    const r = await hf(deps, `/estimate/${endpoint}`, { method: "POST", body: JSON.stringify(body) });
    if (r.status !== 200) return null;
    const usd = Number(r.body?.usd ?? r.body?.cost?.usd);
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch (e) { if (e instanceof RecastError && (e.code === "recast_auth" || e.code === "recast_balance" || e.code === "recast_not_configured")) throw e; return null; }
}

/** The discount we get on a model's list price: none on ElevenLabs (its own account, list prices), Seedance's own
 *  (it is billed at list on the platform), the platform's discount on everything else. */
export function instrumentDiscount(inst: Pick<Instrument, "provider" | "id"> & { api_path?: string } | null | undefined, env: Record<string, string | undefined> = process.env): number {
  if (!inst) return higgsfieldDiscount(env);
  if (inst.provider === "elevenlabs" || String(inst.id).startsWith("audio/")) return 0;
  if (/^bytedance\/seedance/.test(String(inst.api_path ?? inst.id))) return seedanceDiscount(env);
  return higgsfieldDiscount(env);
}
/** Credits for a cost, by the margin rule at the cheapest plan's credit value. Video sold by the second takes the premium
 *  margin when it is expensive (30 s would reach $10 at the standard margin); pictures and sound keep the standard one. */
export function instrumentCredits(usd: number, plans: PlanLike[], env: Record<string, string | undefined> = process.env, opts: { inst?: (Pick<Instrument, "provider" | "id" | "output"> & { api_path?: string }) | null; seconds?: number | null } = {}): number {
  const floor = creditValueFloor(plans);
  // list price: a discount we get is our margin, not the person's (instrumentDiscount is for the economics sheet only)
  const cost = usd;
  const perSecond = opts.inst?.output === "video" && opts.seconds && opts.seconds > 0 ? cost / opts.seconds : null;
  return Math.max(1, creditsForCost(cost, floor, perSecond != null ? marginForSecond(perSecond, plans) : MARGIN_TARGET));
}

export type InstrumentQuote = { tool: "instrument"; credits: number; options: { endpoint: string; params: Record<string, any>; inputs: Record<string, string | string[]>; usd: number; cost_usd?: number | null; priced_by: "estimate" | "table"; units: number; output: "video" | "image" | "audio" | "text" }; summary: string };

/** Validate, price and describe one instrument request. `signInputs` turns the person's assets into URLs for the estimate. */
export async function quoteInstrument(deps: InstrumentDeps, plans: PlanLike[], raw: any, resolveAssets: (ids: string[]) => Promise<Map<string, { url: string; kind: string; seconds: number | null }>>): Promise<InstrumentQuote> {
  const env = deps.env ?? process.env;
  const inst = instrumentById(raw?.endpoint, env);
  if (!inst) throw new InstrumentError("instrument_unknown", "That model is not offered", 404);
  const params = validateParams(inst, raw?.params);
  const inputs = validateInputs(inst, raw?.inputs);
  const ids = inputAssetIds(inputs);
  const assets = ids.length ? await resolveAssets(ids) : new Map();
  for (const [field, kind] of Object.entries(inst.media_fields)) {
    for (const id of ([] as string[]).concat(inputs[field] ?? [])) {
      const a = assets.get(id);
      if (!a) throw new InstrumentError("input_missing", `A file for ${field} is not in your library`, 404);
      if (a.kind !== kind) throw new InstrumentError("input_kind", `${field} needs ${kind === "image" ? "a picture" : "a video"}`);
    }
  }
  const body = buildBody(params, inputs, (id) => assets.get(id)?.url ?? "");
  const sourceSeconds = Math.max(0, ...ids.map((id) => assets.get(id)?.seconds ?? 0)) || null;
  const units = tableUnits(inst, params, sourceSeconds);
  // audio instruments price from their own table; the video models ask the platform's estimate first
  let usd = inst.provider === "elevenlabs" ? null : await estimateUsd(deps, apiPath(inst), body), priced_by: "estimate" | "table" = "estimate";
  if (usd == null) { usd = tableUsd(inst, params, sourceSeconds); priced_by = "table"; }
  // what the job will really cost us (the platform's estimate for our account, else the table), kept for the admin panel
  const costUsd = usd;
  // the estimate may already carry our account's discount: never price under the list table
  if (priced_by === "estimate" && usd != null) { const list = tableUsd(inst, params, sourceSeconds); if (list != null && list > usd) usd = list; }
  if (usd == null) throw new InstrumentError("price_unavailable", "This model cannot be priced right now; try again in a moment", 503);
  // the premium tier is judged per second of generated video; per-minute audio tools (dubbing) keep the standard margin
  const credits = instrumentCredits(usd, plans, env, { inst, seconds: inst.output === "video" && !inst.pricing ? units : null });
  const summary = inst.pricing ? `${inst.pricing.per === "kchars" ? `${Math.round(units * 1000)} characters` : inst.pricing.per === "minute" ? `${units} min` : inst.pricing.per === "hour" ? `${Math.round(units * 60)} min` : "1 sound"} · ${credits}` : inst.output === "image" ? `${units} ${units === 1 ? "image" : "images"} · ${credits}` : `${units} s · ${credits}`;
  return { tool: "instrument", credits, options: { endpoint: inst.id, params, inputs, usd: Math.round(usd * 1000) / 1000, cost_usd: costUsd != null ? Math.round(costUsd * 10000) / 10000 : null, priced_by, units, output: inst.output }, summary };
}

/** The request body: validated parameters plus the signed URL of every named asset. */
export function buildBody(params: Record<string, any>, inputs: Record<string, string | string[]>, urlFor: (assetId: string) => string): Record<string, any> {
  const body: Record<string, any> = { ...params };
  for (const [field, v] of Object.entries(inputs)) body[field] = Array.isArray(v) ? v.map(urlFor) : urlFor(v);
  return body;
}

// ---------------------------------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------------------------------
type Job = { id: string; user_id: string; tool: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };
const POLL_MS = 10_000, MAX_WAIT_MS = 40 * 60_000, VIDEO_LIMIT = 268_435_456, IMAGE_LIMIT = 33_554_432;

async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new RecastError("lease_lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}

/** What a finished request handed back: the video url, or every image url. */
export function outputUrls(raw: any): { videos: string[]; images: string[] } {
  const videos: string[] = [], images: string[] = [];
  const push = (list: string[], u: any) => { if (typeof u === "string" && /^https?:/.test(u)) list.push(u); };
  push(videos, raw?.video?.url); for (const v of raw?.videos ?? []) push(videos, v?.url);
  push(images, raw?.image?.url); for (const i of raw?.images ?? raw?.output?.images ?? []) push(images, i?.url);
  return { videos, images };
}

export async function runInstrumentJob(sb: SupabaseClient, deps: InstrumentDeps, job: Job): Promise<string> {
  const log = deps.log ?? (() => undefined), sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), now = deps.now ?? Date.now;
  const fail = async (code: string, retry: boolean) => {
    try { const r = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry }); if (r.error) throw r.error; }
    catch { return "failure_unconfirmed"; }
    return retry && job.attempts < 3 ? "requeued" : "failed";
  };
  let dir: string | null = null;
  try {
    const o = job.options ?? {};
    const inst = allInstruments().find((m) => m.id === o.endpoint || apiPath(m) === o.endpoint) ?? null;
    if (!inst) throw new RecastError("instrument_unknown");
    if (inst.provider === "elevenlabs") return await runElevenJob(sb, deps, job, inst);
    let requestId: string | null = job.progress?.request_id ?? null;
    if (!requestId) {
      await renew(sb, job, { done: 0, total: 1, note: "Preparing your files" });
      const ids = inputAssetIds(o.inputs ?? {});
      const urls = new Map<string, string>();
      if (ids.length) {
        const a = await sb.from("studio_assets").select("id,object_key,kind,status").eq("user_id", job.user_id).in("id", ids);
        if (a.error) throw a.error;
        for (const id of ids) {
          const row = (a.data ?? []).find((x: any) => x.id === id);
          if (!row || row.status !== "ready") throw new RecastError("source_missing");
          const s = await sb.storage.from("studio-uploads").createSignedUrl(row.object_key, 7200);
          if (s.error || !s.data) throw s.error ?? new RecastError("source_missing");
          urls.set(id, s.data.signedUrl);
        }
      }
      const body = buildBody(o.params ?? {}, o.inputs ?? {}, (id) => urls.get(id) ?? "");
      await renew(sb, job, { note: "Sending the request to the renderer" });
      const r = await hf(deps, `/${apiPath(inst)}`, { method: "POST", body: JSON.stringify(body), idempotency: job.id });
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) throw new RecastError("recast_rejected", `Higgsfield ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      if (!r.body?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
      requestId = String(r.body.request_id);
      await renew(sb, job, { request_id: requestId, submitted_at: new Date(now()).toISOString(), note: "In Higgsfield's queue" });
      log(`[instrument] submitted ${JSON.stringify({ job: job.id, endpoint: inst.id, request: requestId })}`);
    }
    const started = Date.parse(job.progress?.submitted_at ?? "") || now();
    let result: any = null;
    for (;;) {
      if (now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
      let st: { status: number; body: any };
      try { st = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }); }
      catch (e: any) { if (e instanceof RecastError && e.retry) { await renew(sb, job, { note: "Waiting for the renderer" }); await sleep(POLL_MS); continue; } throw e; }
      const status = String(st.body?.status ?? "unknown").toLowerCase();
      if (status === "completed") { result = st.body; break; }
      if (status === "failed" || status === "nsfw" || status === "canceled" || status === "cancelled") {
        log(`[instrument] ${status} ${JSON.stringify({ job: job.id, request: requestId, detail: JSON.stringify(st.body).slice(0, 300) })}`);
        throw new RecastError(status === "nsfw" ? "recast_nsfw" : status === "failed" ? "recast_failed" : "recast_canceled");
      }
      await renew(sb, job, { note: inst.output === "image" ? "Drawing" : "Rendering" });
      await sleep(POLL_MS);
    }
    const found = outputUrls(result);
    const urls = inst.output === "image" ? (found.images.length ? found.images : found.videos) : (found.videos.length ? found.videos : found.images);
    if (!urls.length) throw new RecastError("recast_bad_output", "completed without an output url");
    await renew(sb, job, { note: "Fetching the result", total: urls.length });
    dir = await mkdtemp(join(tmpdir(), "studio-instrument-"));
    const outputs: any[] = [];
    for (let i = 0; i < urls.length; i++) {
      const dl = await (deps.fetch ?? fetch)(urls[i], { signal: AbortSignal.timeout(300_000) });
      if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
      let bytes: Buffer = Buffer.from(await dl.arrayBuffer());
      const isVideo = /video/.test(String(dl.headers.get("content-type") ?? "")) || /\.(mp4|mov|webm)(\?|$)/i.test(urls[i]) || (inst.output === "video" && !/image/.test(String(dl.headers.get("content-type") ?? "")));
      if (!bytes.length || bytes.length > (isVideo ? VIDEO_LIMIT : IMAGE_LIMIT)) throw new RecastError("output_too_large");
      const n = i + 1, base = `${job.user_id}/${job.id}/${job.lease_token}/${n}`;
      if (isVideo) {
        const file = join(dir, `${n}.mp4`), still = join(dir, `${n}.jpg`);
        await writeFile(file, bytes);
        const seconds = await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 0);
        let posterOk = true;
        try { await (deps.poster ?? makePoster)(file, still); } catch { posterOk = false; }
        const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, bytes, { contentType: "video/mp4", upsert: false });
        if (up.error) throw up.error;
        if (posterOk) { const p = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(still), { contentType: "image/jpeg", upsert: false }); if (p.error) posterOk = false; }
        outputs.push({ index: n, key: `${base}.mp4`, poster_key: posterOk ? `${base}.jpg` : undefined, kind: "video", bytes: bytes.length, duration: Math.round(seconds * 1000) / 1000, request_id: requestId, tool: "instrument", endpoint: inst.id });
      } else {
        const ct = String(dl.headers.get("content-type") ?? "");
        if (/png|webp/.test(ct) || bytes[0] === 0x89) bytes = await (deps.toJpeg ?? toJpeg)(bytes);
        const up = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, bytes, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw up.error;
        outputs.push({ index: n, key: `${base}.jpg`, poster_key: `${base}.jpg`, kind: "image", bytes: bytes.length, request_id: requestId, tool: "instrument", endpoint: inst.id });
      }
      await renew(sb, job, { done: n, total: urls.length, note: "Storing the result" });
    }
    // What was reserved is what the estimate priced; Higgsfield bills that request, so it is what we charge.
    const charged = Math.min(job.credits_reserved, Math.max(1, Number(job.credits_reserved)));
    try {
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
      if (done.error) throw done.error;
    } catch { return "completion_unconfirmed"; }
    log(`[instrument] done ${JSON.stringify({ job: job.id, endpoint: inst.id, outputs: outputs.length, charged })}`);
    return "done";
  } catch (e: any) {
    if (e instanceof RecastError && e.code === "lease_lost") return "lease_lost";
    const code = e instanceof RecastError ? e.code : "worker_error";
    const retry = e instanceof RecastError ? e.retry : true;
    log(`[instrument] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    return fail(code, retry);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function startInstrumentLoop(sbFn: () => SupabaseClient, deps: InstrumentDeps = {}, intervalMs = 15_000, maxParallel = 4): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!instrumentsEnabled(env).length) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `instrument-${randomUUID()}`;
  let running = 0;
  const tick = async () => {
    if (running >= maxParallel) return;
    try {
      const sb = sbFn();
      const r = await sb.rpc("studio_claim", { p_tool: "instrument", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running++;
      runInstrumentJob(sb, { ...deps, log }, job).then((s) => log(`[instrument] ${s} ${job.id}`)).catch((e) => log(`[instrument] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { running--; });
    } catch (e: any) { log(`[instrument] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 13_000);
  return t;
}

/** What the dashboard needs to draw a form: the schema's fields, in a flat shape, plus the price hint. */
export function publicInstrument(inst: Instrument, env: Record<string, string | undefined> = process.env, plans: PlanLike[] = []) {
  const props: Record<string, any> = inst.schema?.properties ?? {};
  const fields = Object.entries(props).filter(([n]) => !inst.media_fields[n]).map(([name, d]) => ({
    name, type: Array.isArray(d.type) ? d.type[0] : d.type ?? (d.enum ? typeof d.enum[0] : "string"), description: String(d.description ?? "").slice(0, 300), default: d.default ?? null,
    enum: d.enum ?? null, minimum: d.minimum ?? null, maximum: d.maximum ?? null, minItems: d.minItems ?? null, maxItems: d.maxItems ?? null, required: inst.required.includes(name),
    format: d.format ?? null, maxLength: d.maxLength ?? null,
  }));
  const media = Object.entries(inst.media_fields).filter(([, k]) => !UNSUPPORTED_MEDIA.includes(k)).map(([name, kind]) => {
    const d = props[name] ?? {};
    return { name, kind, multiple: d.type === "array", maxItems: d.maxItems ?? null, description: String(d.description ?? "").slice(0, 300), required: inst.required.includes(name) };
  });
  const price = inst.pricing ?? listPrice(apiPath(inst));
  const unitUsd = price ? ((price as any).by_resolution?.[String(inst.schema?.properties?.resolution?.default ?? "")] ?? price.usd) : 0;
  const hint = price && plans.length ? { per: price.per, credits: instrumentCredits(unitUsd, plans, env, { inst, seconds: inst.output === "video" && !inst.pricing ? 1 : null }), unit: unitLabel(inst) } : null;
  // the provider is ours to know; the person sees a Clone8 family
  return { id: inst.id, title: inst.title, family: inst.family, provider: inst.provider === "elevenlabs" ? "Clone8" : inst.provider, kind: inst.kind, kind_label: KIND_LABEL[inst.kind], output: inst.output, summary: inst.summary, notes: inst.notes.slice(0, 6), fields, media, docs: null, price_hint: hint };
}
