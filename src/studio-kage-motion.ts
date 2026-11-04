// Kage Motion: a narrated motion-graphics film from a brief, written as code by Claude and rendered deterministically.
// The backend only quotes and queues: it validates the brief, checks that any images belong to the person (and that they
// have the rights to use them), prices the film from its real cost at the house margin, and hands the options to
// studio_create_job with tool 'kage_motion'. The film itself is made by the kage-motion worker (a separate Render
// service) that claims 'kage_motion' jobs: script → Naomi's voice → author loop → render → studio-outputs.
import type { SupabaseClient } from "@supabase/supabase-js";
import { MARGIN_TARGET, creditsForCost, studioCosts, type PlanLike } from "./studio-pricing.js";

export class KageMotionError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const kageMotionEnabled = (env: Record<string, string | undefined> = process.env) => env.STUDIO_KAGE_MOTION_ENABLED === "true";

export const KAGE_MOTION_LOOKS = ["auto", "swiss", "brutalist", "neon", "paper", "editorial"] as const;
export const KAGE_MOTION_STYLES = ["narrator", "creator"] as const;
export const KAGE_MOTION_VOICES = ["naomi", "male"] as const; // naomi: KAGE_VOICE_ID on the worker; male: KAGE_VOICE_ID_MALE
/** The name a person sees for each narrator. Jesse is the default: the only voice set up on the worker so far. */
export const KAGE_MOTION_VOICE_NAMES: Record<(typeof KAGE_MOTION_VOICES)[number], string> = { naomi: "Naomi", male: "Jesse" };
export const KAGE_MOTION_IMAGE_KINDS = ["product", "logo", "screenshot", "photo"] as const;
export const KAGE_MOTION_LIMITS = { briefMin: 10, briefMax: 1200, secondsMin: 12, secondsMax: 20, secondsDefault: 16, images: 6, noteMax: 120 };

/** Our cost for one film, in USD: Claude writing the script and authoring the film over several look-and-fix rounds
 *  (the bulk), the narration, and the render. Measured runs set the default; KAGE_MOTION_COST_USD overrides it. */
export function kageMotionCostUsd(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.KAGE_MOTION_COST_USD);
  return Number.isFinite(v) && v > 0 ? v : 4.5;
}

export function kageMotionCredits(env: Record<string, string | undefined>, plans: PlanLike[]): number {
  const usd = kageMotionCostUsd(env);
  const costs = studioCosts(env, plans);
  return Math.max(1, costs.credit_floor ? creditsForCost(usd, costs.credit_floor, MARGIN_TARGET) : Math.ceil(usd * 100));
}

export type KageMotionImage = { asset_id: string; kind: (typeof KAGE_MOTION_IMAGE_KINDS)[number]; note: string | null };
export type KageMotionOptions = { brief: string; look: (typeof KAGE_MOTION_LOOKS)[number]; seconds: number; style: (typeof KAGE_MOTION_STYLES)[number]; voice: (typeof KAGE_MOTION_VOICES)[number]; images: KageMotionImage[]; rights_confirmed: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pick = <T extends readonly string[]>(xs: T, v: unknown, d: T[number]): T[number] => (xs as readonly string[]).includes(String(v ?? "")) ? (String(v) as T[number]) : d;

/** Validates and normalises what the dashboard sends. Throws KageMotionError with a person-readable message. */
export function parseKageMotionOptions(raw: any): KageMotionOptions {
  const brief = String(raw?.brief ?? "").replace(/\s+/g, " ").trim();
  if (brief.length < KAGE_MOTION_LIMITS.briefMin) throw new KageMotionError("kage_motion_brief", "Say in a sentence or two what the film is about");
  if (brief.length > KAGE_MOTION_LIMITS.briefMax) throw new KageMotionError("kage_motion_brief", `Keep the brief under ${KAGE_MOTION_LIMITS.briefMax} characters`);
  const s = Number(raw?.seconds);
  const seconds = Number.isFinite(s) ? Math.round(Math.min(KAGE_MOTION_LIMITS.secondsMax, Math.max(KAGE_MOTION_LIMITS.secondsMin, s))) : KAGE_MOTION_LIMITS.secondsDefault;
  const list = Array.isArray(raw?.images) ? raw.images : [];
  if (list.length > KAGE_MOTION_LIMITS.images) throw new KageMotionError("kage_motion_images", `Up to ${KAGE_MOTION_LIMITS.images} images`);
  const images: KageMotionImage[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    const id = String(it?.asset_id ?? "");
    if (!UUID_RE.test(id)) throw new KageMotionError("kage_motion_images", "One of the images is not in your library");
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const note = String(it?.note ?? "").replace(/\s+/g, " ").trim().slice(0, KAGE_MOTION_LIMITS.noteMax);
    images.push({ asset_id: id, kind: pick(KAGE_MOTION_IMAGE_KINDS, it?.kind, "photo"), note: note || null });
  }
  const rights = raw?.rights_confirmed === true;
  if (images.length && !rights) throw new KageMotionError("kage_motion_rights", "Confirm you own these images or have permission to use them", 400);
  return { brief, look: pick(KAGE_MOTION_LOOKS, raw?.look, "auto"), seconds, style: pick(KAGE_MOTION_STYLES, raw?.style, "narrator"), voice: pick(KAGE_MOTION_VOICES, raw?.voice, "male"), images, rights_confirmed: rights };
}

export type KageMotionQuote = { tool: "kage_motion"; credits: number; options: KageMotionOptions & { cost_usd: number }; summary: string };

export async function quoteKageMotion(sb: SupabaseClient, u: string, env: Record<string, string | undefined>, plans: PlanLike[], raw: any): Promise<KageMotionQuote> {
  if (!kageMotionEnabled(env)) throw new KageMotionError("kage_motion_unavailable", "Kage Motion is not switched on yet", 503);
  const options = parseKageMotionOptions(raw);
  if (options.images.length) {
    const ids = options.images.map((i) => i.asset_id);
    const r = await sb.from("studio_assets").select("id,kind,status").eq("user_id", u).in("id", ids);
    if (r.error) throw r.error;
    const rows = new Map((r.data ?? []).map((a: any) => [String(a.id).toLowerCase(), a]));
    for (const id of ids) {
      const a: any = rows.get(id.toLowerCase());
      if (!a) throw new KageMotionError("kage_motion_images", "One of the images is not in your library", 404);
      if (a.kind !== "image") throw new KageMotionError("kage_motion_images", "Kage Motion takes pictures; use a still from that video instead");
      if (a.status && a.status !== "ready") throw new KageMotionError("kage_motion_images", "One of the images is still uploading");
    }
  }
  const credits = kageMotionCredits(env, plans);
  const look = options.look === "auto" ? "a look chosen for the brief" : `${options.look} look`;
  return { tool: "kage_motion", credits, options: { ...options, cost_usd: kageMotionCostUsd(env) }, summary: `${options.seconds} s film · ${look} · narrated by ${KAGE_MOTION_VOICE_NAMES[options.voice]}${options.images.length ? ` · ${options.images.length} image${options.images.length > 1 ? "s" : ""}` : ""}` };
}
