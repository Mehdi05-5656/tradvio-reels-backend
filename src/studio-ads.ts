// Clone8 Studio: the full ad (docs/model-features/PRODUCT_ADS_PLAN.md, phase 2b, owner Nov 26 2026). The pieces a
// person already made for one product (a hook, product clips, product shots) cut together into one 9:16 ad:
//   hook (the character's line, lip-synced) → product clips / shots → an end card with the product, their line and
//   their offer → optional licensed music under it all, ducked under the voice.
// Assembled here with ffmpeg (our compute, no model), then the person adds word captions and tweaks it in the existing
// Captions tool and editor. A job of the instrument runner (no migration): options.ad.
//
// Never generated: the price, the offer and the claims are the person's own words, set as text (the leaders' rule).
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./video-render.js";
import { composeMusic } from "./studio-eleven.js";
import { recordCost } from "./studio-costs.js";
import { assFilter } from "./studio-caption-video.js";
import { creditValueFloor, creditsForCost, type PlanLike } from "./studio-pricing.js";
import { normalFacts } from "./studio-products.js";
import { CATEGORY_LABEL } from "./studio-product-looks.js";

type Deps = { env?: Record<string, string | undefined>; log?: (line: string) => void; fetch?: typeof fetch; music?: typeof composeMusic; run?: (args: string[]) => Promise<unknown>; probe?: (file: string) => Promise<{ seconds: number; audio: boolean }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const W = 1080, H = 1920, FPS = 30;
export const AD_LIMITS = { parts: 6, seconds: 60, end_seconds: 2.5, shot_seconds: 2.2, music_usd_per_minute: 0.15 };
export class AdError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩{}\\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export type AdPart = { job: string; kind: "hook" | "clip" | "shot" };
export type AdRequest = { product: string; parts: AdPart[]; end: { line: string | null; offer: string | null } | null; music: boolean };

/** The person's request, cleaned: at most one hook (first), clips and shots after it, an optional end card and music. */
export function cleanAdRequest(raw: any): AdRequest {
  const product = String(raw?.product ?? "");
  if (!UUID_RE.test(product)) throw new AdError("ad_input_required", "Pick the product first");
  const parts: AdPart[] = [];
  for (const p of Array.isArray(raw?.parts) ? raw.parts : []) {
    const job = String(p?.job ?? ""), kind = p?.kind;
    if (!UUID_RE.test(job) || !["hook", "clip", "shot"].includes(kind) || parts.some((x) => x.job === job)) continue;
    parts.push({ job, kind });
  }
  const hooks = parts.filter((p) => p.kind === "hook");
  if (hooks.length > 1) throw new AdError("ad_one_hook", "An ad opens with one hook");
  const ordered = [...hooks, ...parts.filter((p) => p.kind !== "hook")].slice(0, AD_LIMITS.parts);
  if (!ordered.some((p) => p.kind !== "shot")) throw new AdError("ad_needs_video", "Add a hook or a product clip");
  const line = clean(raw?.end?.line, 40) || null, offer = clean(raw?.end?.offer, 40) || null;
  return { product, parts: ordered, end: raw?.end === null ? null : { line, offer }, music: raw?.music === true };
}

/** The parts' finished files, checked: done, this person's, made for this product, the right kind. */
async function loadParts(sb: SupabaseClient, u: string, req: AdRequest) {
  const ids = req.parts.map((p) => p.job);
  const r = await sb.from("studio_jobs").select("id,status,options,outputs").eq("user_id", u).in("id", ids);
  if (r.error) throw r.error;
  return req.parts.map((p) => {
    const j = (r.data ?? []).find((x: any) => x.id === p.job);
    const out = j?.outputs?.[0];
    if (!j || j.status !== "done" || !out?.key) throw new AdError("ad_part_missing", "One of the pieces isn't finished or isn't yours", 404);
    if (j.options?.product !== req.product) throw new AdError("ad_part_other_product", "Every piece has to be made for this product");
    const isVideo = out.kind === "video" || /\.mp4$/i.test(out.key);
    if (p.kind === "hook" && !(j.options?.hook && isVideo)) throw new AdError("ad_part_kind", "The hook has to be a finished hook video");
    if (p.kind === "clip" && !isVideo) throw new AdError("ad_part_kind", "A product clip has to be a video");
    if (p.kind === "shot" && isVideo) throw new AdError("ad_part_kind", "A product shot has to be a picture");
    return { ...p, key: String(out.key), seconds: Number(out.duration) || (p.kind === "shot" ? AD_LIMITS.shot_seconds : 5) };
  });
}

/** Seconds the ad will run (the end card included), before anything is made. */
export const adSeconds = (parts: Array<{ kind: AdPart["kind"]; seconds: number }>, end: boolean) =>
  Math.round((parts.reduce((s, p) => s + (p.kind === "shot" ? AD_LIMITS.shot_seconds : p.seconds), 0) + (end ? AD_LIMITS.end_seconds : 0)) * 10) / 10;

/** The quote: cutting is ours (free); only the music costs, priced from its cost by the margin rule. */
export async function quoteAd(sb: SupabaseClient, u: string, raw: any, plans: PlanLike[], o: { admin: boolean }) {
  if (!o.admin) throw new AdError("ad_unknown", "Ads are not open yet", 404);
  const req = cleanAdRequest(raw);
  const a = await sb.from("studio_assets").select("id,probe").eq("id", req.product).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data?.probe?.product) throw new AdError("product_not_found", "That product is not in your library", 404);
  const parts = await loadParts(sb, u, req);
  const seconds = adSeconds(parts, !!req.end);
  if (seconds > AD_LIMITS.seconds) throw new AdError("ad_too_long", `Keep the ad under ${AD_LIMITS.seconds} seconds`);
  const musicUsd = req.music ? Math.round((seconds / 60) * AD_LIMITS.music_usd_per_minute * 10000) / 10000 : 0;
  const credits = req.music ? creditsForCost(musicUsd, creditValueFloor(plans)) : 0;
  const name = normalFacts(a.data.probe.product).name;
  return { tool: "instrument" as const, credits,
    options: { endpoint: "clone8/ad", ad: req, product: req.product, look_title: `Full ad · ${seconds} s`, usd: musicUsd, cost_usd: musicUsd, priced_by: "table" as const, units: seconds, output: "video" as const, params: {}, inputs: {} },
    summary: `Full ad · ${name} · ${seconds} s${req.music ? " · with music" : ""}` };
}

// ---------------------------------------------------------------------------------------------------
// Making it
// ---------------------------------------------------------------------------------------------------
const FILL = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:4,eq=brightness=-0.08`;
const FIT = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
/** One piece onto the 9:16 frame: fills when it already is 9:16, otherwise sits on a blurred copy of itself. */
export function partArgs(input: string, out: string, o: { still: boolean; seconds: number; audio: boolean }): string[] {
  const src = o.still ? ["-loop", "1", "-t", o.seconds.toFixed(2), "-i", input] : ["-i", input];
  const zoom = o.still ? `,zoompan=z='min(zoom+0.0009,1.06)':d=${Math.round(o.seconds * FPS)}:s=${W}x${H}:fps=${FPS}` : "";
  const v = `[0:v]split=2[a][b];[a]${FILL}[bg];[b]${FIT}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS}${zoom},format=yuv420p[v]`;
  const silence = ["-f", "lavfi", "-t", o.seconds.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo"];
  return ["-v", "error", "-nostdin", "-y", ...src, ...(o.audio ? [] : silence), "-filter_complex", v, "-map", "[v]", "-map", o.audio ? "0:a:0" : "1:a:0",
    "-t", o.seconds.toFixed(2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k", out];
}
/** The end card's words as an ASS file: the line large, the offer under it, lower third, in our caption fonts. */
export function endCardAss(line: string | null, offer: string | null, seconds: number): string {
  const t = (s: number) => `0:00:${s.toFixed(2).padStart(5, "0")}`;
  const esc = (s: string) => s.replace(/[{}\\]/g, "");
  const ev = [line ? `Dialogue: 0,${t(0)},${t(seconds)},Line,,0,0,0,,{\\fad(250,0)}${esc(line)}` : null, offer ? `Dialogue: 0,${t(0.25)},${t(seconds)},Offer,,0,0,0,,{\\fad(250,0)}${esc(offer)}` : null].filter(Boolean);
  return ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "",
    "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Line,Montserrat Black,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,0,6,2,90,90,430,1",
    "Style: Offer,Montserrat ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,0,5,2,90,90,320,1", "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...ev, ""].join("\n");
}
async function probeFile(file: string): Promise<{ seconds: number; audio: boolean }> {
  const out = (await command("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], undefined, 60_000)).toString();
  const j = JSON.parse(out || "{}");
  return { seconds: Number(j?.format?.duration) || 0, audio: (j?.streams ?? []).some((s: any) => s.codec_type === "audio") };
}

/** Runs an ad job from the instrument runner: fetch the pieces, frame them, end card, music, join, store, complete. */
export async function runAdJob(sb: SupabaseClient, deps: Deps, job: any, h: { renew: (p: Record<string, any>) => Promise<void>; fail: (code: string, retry: boolean, detail?: unknown) => Promise<string> }): Promise<string> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined), run = deps.run ?? ((args: string[]) => command("ffmpeg", args, undefined, 300_000));
  const probe = deps.probe ?? probeFile;
  const dir = await mkdtemp(join(tmpdir(), "studio-ad-"));
  try {
    const req = cleanAdRequest(job.options?.ad);
    const parts = await loadParts(sb, job.user_id, req);
    await h.renew({ done: 0, total: parts.length + 2, note: "Gathering your pieces" });
    const pieces: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const dl = await sb.storage.from("studio-outputs").download(p.key);
      if (dl.error || !dl.data) throw new AdError("ad_part_missing", "A piece could not be read");
      const src = join(dir, `src-${i}${p.kind === "shot" ? ".jpg" : ".mp4"}`), out = join(dir, `part-${i}.mp4`);
      await writeFile(src, Buffer.from(await dl.data.arrayBuffer()));
      const info = p.kind === "shot" ? { seconds: AD_LIMITS.shot_seconds, audio: false } : await probe(src);
      await run(partArgs(src, out, { still: p.kind === "shot", seconds: Math.min(info.seconds || p.seconds, 15), audio: info.audio }));
      pieces.push(out);
      await h.renew({ done: i + 1, note: "Framing the pieces" });
    }
    // the end card: the product picture on its own blurred copy, the person's words on it
    if (req.end) {
      const a = await sb.from("studio_assets").select("object_key").eq("id", req.product).eq("user_id", job.user_id).maybeSingle();
      if (a.error || !a.data) throw new AdError("product_not_found", "The product picture is gone");
      const dl = await sb.storage.from("studio-uploads").download(a.data.object_key);
      if (dl.error || !dl.data) throw new AdError("product_not_found", "The product picture could not be read");
      const pic = join(dir, "product.jpg"), card = join(dir, "card.mp4"), ass = join(dir, "end.ass");
      await writeFile(pic, Buffer.from(await dl.data.arrayBuffer()));
      const base = join(dir, "card-base.mp4");
      await run(partArgs(pic, base, { still: true, seconds: AD_LIMITS.end_seconds, audio: false }));
      if (req.end.line || req.end.offer) {
        await writeFile(ass, endCardAss(req.end.line, req.end.offer, AD_LIMITS.end_seconds));
        await run(["-v", "error", "-nostdin", "-y", "-i", base, "-vf", assFilter(ass, env), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", card]);
        pieces.push(card);
      } else pieces.push(base);
    }
    await h.renew({ done: parts.length + 1, note: "Joining it into one ad" });
    const joined = join(dir, "joined.mp4");
    const ins = pieces.flatMap((p) => ["-i", p]);
    const chain = pieces.map((_, i) => `[${i}:v][${i}:a]`).join("") + `concat=n=${pieces.length}:v=1:a=1[v][a]`;
    await run(["-v", "error", "-nostdin", "-y", ...ins, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", joined]);
    let final = joined;
    const total = (await probe(joined)).seconds;
    if (req.music && total > 0) {
      try {
        const a = await sb.from("studio_assets").select("probe").eq("id", req.product).eq("user_id", job.user_id).maybeSingle();
        const facts = normalFacts(a.data?.probe?.product ?? {});
        const mp3 = await (deps.music ?? composeMusic)({ env, log, fetch: deps.fetch } as any, { prompt: `Upbeat modern instrumental bed for a short ${CATEGORY_LABEL[facts.category].toLowerCase()} product ad on TikTok, clean punchy beat, no vocals`, length_seconds: Math.ceil(total) });
        const m = join(dir, "music.mp3"), mixed = join(dir, "mixed.mp4");
        await writeFile(m, mp3);
        // the voice stays on top: the music sits low and ducks further whenever someone speaks
        await run(["-v", "error", "-nostdin", "-y", "-i", joined, "-i", m, "-filter_complex", "[1:a]volume=0.22,afade=t=out:st=" + Math.max(0, total - 1).toFixed(2) + ":d=1[mu];[mu][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duck];[0:a][duck]amix=inputs=2:duration=first:normalize=0[a]",
          "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", mixed]);
        final = mixed;
        recordCost({ job_id: job.id, user_id: job.user_id ?? null, tool: "instrument", provider: "elevenlabs", product: "music", source: "ad_music", units: { seconds: Math.ceil(total) }, usd: Math.round((total / 60) * AD_LIMITS.music_usd_per_minute * 10000) / 10000, basis: "estimated", note: "ElevenLabs Music list $0.15/min" });
      } catch (e: any) { log(`[ads] music left out ${JSON.stringify({ job: job.id, error: String(e?.message ?? e).slice(0, 160) })}`); }
    }
    const bytes = await readFile(final), base = `${job.user_id}/${job.id}/${job.lease_token}/1`;
    const poster = join(dir, "poster.jpg");
    await run(["-v", "error", "-nostdin", "-y", "-ss", "0.5", "-i", final, "-frames:v", "1", "-q:v", "3", poster]);
    const up = await sb.storage.from("studio-outputs").upload(`${base}.mp4`, bytes, { contentType: "video/mp4", upsert: false });
    if (up.error) throw up.error;
    const pu = await sb.storage.from("studio-outputs").upload(`${base}.jpg`, await readFile(poster), { contentType: "image/jpeg", upsert: false });
    const outputs = [{ index: 1, key: `${base}.mp4`, poster_key: pu.error ? undefined : `${base}.jpg`, kind: "video", bytes: bytes.length, duration: Math.round((await probe(final)).seconds * 1000) / 1000, tool: "instrument", endpoint: "clone8/ad", ...(req.music && final === joined ? { left_out: ["music"] } : {}) }];
    // music that didn't make it isn't charged
    const charged = req.music && final === joined ? 0 : job.credits_reserved;
    const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
    if (done.error) return "completion_unconfirmed";
    log(`[ads] done ${JSON.stringify({ job: job.id, parts: parts.length, end: !!req.end, music: final !== joined, seconds: outputs[0].duration })}`);
    return "done";
  } catch (e: any) {
    log(`[ads] failed ${JSON.stringify({ job: job.id, error: String(e?.message ?? e).slice(0, 300) })}`);
    return await h.fail(e instanceof AdError ? e.code : "ad_failed", false, e);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
