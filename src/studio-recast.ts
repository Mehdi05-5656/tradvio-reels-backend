// Clone8 Studio: the Recast runner. Takes a queued recast job, sends the person's video and a character
// reference to Higgsfield's platform API (Genjutsu motion transfer), polls until it is done, puts the
// original sound back (the full model returns silent video), stores the result in studio-outputs and
// charges the exact seconds. Runs inside the web service as a timer loop, like the intake loop: Higgsfield
// does the heavy work, we only wait. Nothing here is reachable from HTTP.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { command } from "./video-render.js";
import { targetsPrompt } from "./studio-people.js";
import { PLANS, WINDOW, billableSeconds, windowSeconds } from "./studio.js";
import { RECAST_RESOLUTION, studioCosts } from "./studio-pricing.js";
import { trendById, trendClipUrl } from "./studio-trends.js";

export const HF_BASE = "https://api.higgsfield.ai";
export const MODELS = { full: "higgsfield/genjutsu/motion-transfer/v1.0", light: "higgsfield/genjutsu-light/motion-transfer/v1.0" } as const;
/** The Genjutsu suite shares one runner. Recast and Trend are motion transfer (the reference image performs the video);
 *  Swap is object swap (the reference replaces the person or thing in the person's own video, scene kept); Restyle redraws
 *  the video in a Higgsfield preset style. Light variants use the first 15 s and keep the source audio. */
export type SuiteTool = "recast" | "swap" | "restyle" | "trend";
export const SUITE_TOOLS: SuiteTool[] = ["recast", "swap", "restyle", "trend"];
export const ENDPOINTS: Record<SuiteTool, { full: string; light: string | null }> = {
  recast: { full: "higgsfield/genjutsu/motion-transfer/v1.0", light: "higgsfield/genjutsu-light/motion-transfer/v1.0" },
  trend: { full: "higgsfield/genjutsu/motion-transfer/v1.0", light: "higgsfield/genjutsu-light/motion-transfer/v1.0" },
  swap: { full: "higgsfield/genjutsu/object-swap/v1.0", light: "higgsfield/genjutsu-light/object-swap/v1.0" },
  restyle: { full: "higgsfield/genjutsu/restyle/v1.0", light: null },
};
export function endpointFor(tool: SuiteTool, model: "full" | "light"): string {
  const e = ENDPOINTS[tool] ?? ENDPOINTS.recast;
  return (model === "light" && e.light) || e.full;
}
/** What the swap model is told when the person wrote nothing. */
export const SWAP_DEFAULT_PROMPT = "Replace the person in the video with the character in the reference image. Keep the background, camera, framing, lighting, motion and audio exactly as in the source video.";
/** What one Genjutsu request accepts: the full model trims sources to 30 s, Light 15 s; both want one continuous shot.
 *  Longer or multi-shot Light jobs go to the long path (Seedance video edit, pieces of up to PIECE_SECONDS). */
export const MAX_SECONDS = { full: 30, light: 15 } as const;
export const PIECE_SECONDS = 30;
export const LONG_ENDPOINT = "bytedance/seedance-2.5/video-edit";
export const LONG_PROMPT = "Replace the person in the video with the character from the reference image, keeping their exact pose, gestures, clothing colours, lip movements and timing. Keep the room, furniture, camera framing, camera cuts, lighting, on-screen text and everything else exactly as they are.";
export const MIN_SECONDS = 4;
const POLL_MS = 10_000, MAX_WAIT_MS = 40 * 60_000, OUTPUT_LIMIT = 268_435_456;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecastDeps = {
  /** Shot changes inside the first seconds of a file (ffmpeg in production; tests inject one). */
  sceneCuts?: (path: string, within: number) => Promise<number[]>;
  fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>;
  now?: () => number; mux?: (output: string, source: string, target: string) => Promise<void>; probeSeconds?: (path: string) => Promise<number>; poster?: (video: string, target: string) => Promise<void>;
  prescale?: (source: string, target: string, maxSeconds?: number, startSeconds?: number) => Promise<void>;
  /** Joins rendered pieces into one picture track (ffmpeg in production; tests inject one). */
  concat?: (pieces: string[], target: string) => Promise<void>;
};

/** The platform console issues "id:secret" keys (sent as `Key id:secret`); the newer SDK keys are bearer tokens. */
export function higgsfieldAuth(key: string): string {
  const k = key.trim();
  return k.includes(":") ? `Key ${k}` : `Bearer ${k}`;
}

export class RecastError extends Error { constructor(public code: string, message = code, public retry = false) { super(message); } }

async function hf(deps: RecastDeps, path: string, init: RequestInit & { idempotency?: string } = {}): Promise<any> {
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
  if (!r.ok) throw new RecastError("recast_rejected", `Higgsfield ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

export async function submitRecast(deps: RecastDeps, p: { tool?: SuiteTool; model: "full" | "light"; videoUrl: string; imageUrls: string[]; prompt?: string; presetId?: string; resolution?: "480p" | "720p" | "1080p"; idempotencyKey: string }) {
  const tool = p.tool ?? "recast";
  const body: any = { video_url: p.videoUrl };
  // Restyle takes the style id and optional character references; the others take 1–8 ordered references.
  if (tool === "restyle") { body.preset_id = p.presetId; if (p.imageUrls.length) body.image_urls = p.imageUrls.slice(0, 5); }
  else body.image_urls = p.imageUrls.slice(0, 8);
  if (p.prompt) body.prompt = p.prompt;
  if (p.resolution) body.resolution = p.resolution;
  const r = await hf(deps, `/${endpointFor(tool, p.model)}`, { method: "POST", body: JSON.stringify(body), idempotency: p.idempotencyKey });
  if (!r?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
  return { request_id: String(r.request_id), status: String(r.status ?? "queued"), status_url: r.status_url ? String(r.status_url) : `${HF_BASE}/requests/${r.request_id}/status` };
}

/** A "failed" status whose message is about OUR account (platform balance, key) is an ops failure, not the customer's video. */
export function failureCode(raw: any): "recast_failed" | "recast_balance" | "recast_auth" {
  const text = typeof raw?.error === "string" ? raw.error : typeof raw?.message === "string" ? raw.message : JSON.stringify(raw ?? "");
  if (/credit balance|insufficient (credits|balance|funds)|top up/i.test(text)) return "recast_balance";
  if (/api key|unauthori[sz]ed|forbidden/i.test(text)) return "recast_auth";
  return "recast_failed";
}

export async function pollRecast(deps: RecastDeps, requestId: string): Promise<{ status: string; videoUrl: string | null; raw: any }> {
  const r = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
  const status = String(r?.status ?? "unknown").toLowerCase();
  const videoUrl = r?.video?.url ?? r?.videos?.[0]?.url ?? r?.output?.video?.url ?? null;
  return { status, videoUrl: typeof videoUrl === "string" ? videoUrl : null, raw: r };
}

/** Higgsfield bills by the input's resolution (a 1080×1920 source bills at the 1080p rate whatever output we ask for),
 *  and the output comes back at 720p anyway. So the source is scaled to fit 720×1280 before it leaves, sound untouched. */
export const INPUT_MAX_SHORT = 720, INPUT_MAX_LONG = 1280;
/** The renderer wants at least this many pixels a frame (its documented floor); smaller sources are scaled up to it. */
export const INPUT_MIN_PIXELS = 409_600;
/** The source's video stream as the renderer will see it: size, frame rate, whether the rate is variable. */
export async function probeStream(path: string): Promise<{ width: number; height: number; fps: number | null; vfr: boolean; hasAudio: boolean }> {
  const raw = await command("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate", "-of", "json", path], undefined, 30_000);
  const p = JSON.parse(raw.toString());
  const v = (p.streams ?? []).find((x: any) => x.codec_type === "video") ?? {};
  const rate = (f: string | undefined) => { const [n, d] = String(f ?? "0/1").split("/").map(Number); return d ? n / d : 0; };
  const avg = rate(v.avg_frame_rate), r = rate(v.r_frame_rate);
  return { width: Number(v.width) || 0, height: Number(v.height) || 0, fps: avg > 0 ? Math.round(avg * 100) / 100 : null, vfr: avg > 0 && r > 0 && Math.abs(avg - r) > 0.5, hasAudio: (p.streams ?? []).some((x: any) => x.codec_type === "audio") };
}
/** Where the picture hard-cuts to another shot inside the first `within` seconds, in order; a cut is a frame that differs
 *  from the one before it by more than `threshold` (ffmpeg's scene score, 0.3 catches camera switches, not head turns). */
export async function sceneCuts(path: string, within: number, threshold = 0.3): Promise<number[]> {
  const raw = await command("ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-t", String(within), "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], undefined, 120_000).catch((e) => { throw e; });
  const text = raw.toString();
  const out: number[] = [];
  for (const m of text.matchAll(/pts_time:([0-9.]+)/g)) { const t = Number(m[1]); if (Number.isFinite(t) && t > 0 && t < within) out.push(Math.round(t * 100) / 100); }
  return out;
}
/** The opening shot: the stretch before the first cut, when that is long enough to render (4 s); else null. */
export const openingShot = (cuts: number[], minSeconds = MIN_SECONDS) => { const first = cuts.find((t) => t >= minSeconds); return first == null ? null : Math.floor(first * 10) / 10; };
/** The ffmpeg video filter for a source of this size: down to 720x1280 when larger, up to the renderer's pixel floor
 *  when smaller (a 480x852 phone rendition is 409k pixels, right at the line), even sides always. */
export function inputScaleFilter(width: number, height: number): string {
  if (width > 0 && height > 0 && width * height < INPUT_MIN_PIXELS) {
    const portrait = height >= width;
    const short = Math.ceil(Math.sqrt(INPUT_MIN_PIXELS * (portrait ? width / height : height / width)) / 2) * 2;
    const target = Math.min(INPUT_MAX_SHORT, Math.max(short, 640));
    return portrait ? `scale=${target}:-2` : `scale=-2:${target}`;
  }
  return `scale='if(gt(iw,ih),min(${INPUT_MAX_LONG},iw),min(${INPUT_MAX_SHORT},iw))':'if(gt(iw,ih),min(${INPUT_MAX_SHORT},ih),min(${INPUT_MAX_LONG},ih))':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}
/** The copy that leaves for the renderer: sized as above, a constant frame rate of at most 30, standard H.264 and AAC,
 *  cut to the model's window. Phone and TikTok downloads often carry variable frame rates or odd rates; the renderer
 *  is told nothing about them, so the copy is made plain here. */
export async function prescaleSource(source: string, target: string, maxSeconds?: number, startSeconds = 0) {
  const st = await probeStream(source).catch(() => ({ width: 0, height: 0, fps: null as number | null, vfr: false, hasAudio: true }));
  const vf = inputScaleFilter(st.width, st.height) + (st.fps && st.fps > 30.5 ? ",fps=30" : st.vfr ? `,fps=${Math.min(30, Math.max(24, Math.round(st.fps ?? 30)))}` : "");
  // the start is placed after -i so the cut lands on the exact frame, not the previous keyframe
  const cut = [...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []), ...(maxSeconds ? ["-t", String(maxSeconds)] : [])];
  const audio = st.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"] : ["-an"];
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", source, ...cut, "-vf", vf, "-fps_mode", "cfr", "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "60", ...audio, "-movflags", "+faststart", target], undefined, 240_000);
}
/** The pieces a long clip is rendered in: at most PIECE_SECONDS each, ending on a camera change when one falls in the
 *  last stretch of a piece, never shorter than MIN_SECONDS (a short tail is folded into the piece before it). */
export function planPieces(window: number, cuts: number[], pieceMax = PIECE_SECONDS, min = MIN_SECONDS): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  const total = Math.round(window * 100) / 100;
  while (start < total - 0.05) {
    let end = Math.min(total, Math.round((start + pieceMax) * 100) / 100);
    if (end < total) {
      // prefer ending on a cut, as late as possible, as long as this piece and the remainder both stay renderable
      const candidates = cuts.filter((c) => c > start + min && c <= end && total - c >= min).sort((a, b) => b - a);
      if (candidates.length) end = Math.round(candidates[0] * 100) / 100;
      else if (total - end < min) end = Math.round((total - min) * 100) / 100;
    }
    out.push({ start, end });
    start = end;
  }
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < min) { const tail = out.pop()!; out[out.length - 1].end = tail.end; }
  return out;
}
/** Which renderer a Light swap or recast goes to: Genjutsu for one short continuous shot, the long path otherwise. */
export function chooseEngine(tool: SuiteTool, model: "full" | "light", window: number, cuts: number[]): "genjutsu" | "seedance" {
  if (model !== "light" || (tool !== "swap" && tool !== "recast")) return "genjutsu";
  if (window > MAX_SECONDS.light + 0.05) return "seedance";
  return cuts.some((c) => c >= 0.5 && c < window - 0.5) ? "seedance" : "genjutsu";
}
/** Rendered pieces joined into one picture track. Each piece is brought to the same size, rate and clock first (the
 *  concat filter, not the demuxer: pieces come back with differing frame rates and timebases, and the demuxer leaves
 *  gaps between them), so the result runs exactly as long as the pieces together. */
export async function concatVideos(pieces: string[], target: string) {
  const inputs = pieces.flatMap((f) => ["-i", f]);
  const chains = pieces.map((_, i) => `[${i}:v]scale=720:-2:force_divisible_by=2,fps=30,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`).join(";");
  const graph = `${chains};${pieces.map((_, i) => `[v${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0[v]`;
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", ...inputs, "-filter_complex", graph, "-map", "[v]", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", target], undefined, 600_000);
}
export async function probeDimensions(path: string): Promise<{ width: number; height: number }> {
  const raw = await command("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], undefined, 30_000);
  const [w, h] = raw.toString().trim().split(",").map(Number);
  return { width: w, height: h };
}

/** The full model returns picture only: put the person's own sound back, cut to the output's length. */
export async function muxAudio(output: string, source: string, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", output, "-i", source, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", target], undefined, 240_000);
}
export async function probeSeconds(path: string): Promise<number> {
  const raw = await command("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], undefined, 30_000);
  const s = Number(raw.toString().trim());
  if (!(s > 0)) throw new RecastError("recast_bad_output", "unreadable output");
  return s;
}
export async function makePoster(video: string, target: string) {
  await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", "0.5", "-i", video, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", target], undefined, 60_000);
}

type Job = { id: string; user_id: string; tool?: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };

async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new RecastError("lease_lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}

/** Where the character comes from: the person's own photo (signed) or a preset served by the dashboard. */
async function characterUrls(sb: SupabaseClient, deps: RecastDeps, job: Job, optional = false): Promise<string[]> {
  const o = job.options ?? {};
  if (optional && !o.character_asset_id && !o.character) return [];
  if (o.character_asset_id) {
    if (!UUID_RE.test(String(o.character_asset_id))) throw new RecastError("character_invalid");
    const a = await sb.from("studio_assets").select("object_key,kind,status").eq("id", o.character_asset_id).eq("user_id", job.user_id).maybeSingle();
    if (a.error) throw a.error;
    if (!a.data || a.data.kind !== "image" || a.data.status !== "ready") throw new RecastError("character_missing");
    const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 7200);
    if (s.error || !s.data) throw s.error ?? new RecastError("character_missing");
    return [s.data.signedUrl];
  }
  const id = String(o.character ?? "");
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) throw new RecastError("character_invalid");
  const base = (deps.env?.STUDIO_PRESET_BASE ?? deps.env?.DASHBOARD_URL ?? process.env.STUDIO_PRESET_BASE ?? process.env.DASHBOARD_URL ?? "https://app.clone8.io").replace(/\/+$/, "");
  const url = `${base}/presets/${id}.jpg`;
  const head = await (deps.fetch ?? fetch)(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!head || !head.ok) throw new RecastError("character_unavailable", `preset ${id} is not published`);
  return [url];
}

/** One claimed job, start to finish. Returns a status word; a lost lease or an uncertain completion never becomes a refund. */
export async function runRecastJob(sb: SupabaseClient, deps: RecastDeps, job: Job): Promise<string> {
  const log = deps.log ?? (() => undefined), sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), now = deps.now ?? Date.now;
  const fail = async (code: string, retry: boolean) => {
    try { const r = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry }); if (r.error) throw r.error; }
    catch { return "failure_unconfirmed"; }
    return retry && job.attempts < 3 ? "requeued" : "failed";
  };
  let dir: string | null = null;
  try {
    const tool: SuiteTool = (SUITE_TOOLS as string[]).includes(String(job.tool)) ? (job.tool as SuiteTool) : "recast";
    const model: "full" | "light" = tool !== "restyle" && job.options?.model === "light" ? "light" : "full";
    // The source: the person's own video, or for a Trend one of our driving clips served by the dashboard host.
    const trend = tool === "trend" ? trendById(job.options?.trend_id) : null;
    if (tool === "trend" && !trend) throw new RecastError("trend_unavailable");
    let sourceKey: string | null = null, sourceSeconds = 0, drivingUrl: string | null = null;
    if (trend) {
      const base = (deps.env?.STUDIO_PRESET_BASE ?? deps.env?.DASHBOARD_URL ?? process.env.STUDIO_PRESET_BASE ?? process.env.DASHBOARD_URL ?? "https://app.clone8.io");
      drivingUrl = trendClipUrl(base, trend.id); sourceSeconds = trend.seconds;
      const head = await (deps.fetch ?? fetch)(drivingUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!head || !head.ok) throw new RecastError("trend_unavailable", `trend ${trend.id} is not published`);
    } else {
      if (!job.asset_id) throw new RecastError("source_missing");
      const asset = await sb.from("studio_assets").select("id,object_key,kind,status,probe,name").eq("id", job.asset_id).eq("user_id", job.user_id).maybeSingle();
      if (asset.error) throw asset.error;
      if (!asset.data || asset.data.kind !== "video" || asset.data.status !== "ready") throw new RecastError("source_not_ready");
      sourceKey = asset.data.object_key; sourceSeconds = Number(asset.data.probe?.duration ?? 0);
      if (sourceSeconds && sourceSeconds < MIN_SECONDS) throw new RecastError("source_too_short_recast");
    }

    // 1. The source as a file, and the renderer for it. Trends drive from a published clip and always go to Genjutsu.
    let requestId: string | null = job.progress?.request_id ?? null;
    let engine: "genjutsu" | "seedance" = job.progress?.engine === "seedance" ? "seedance" : "genjutsu";
    let original: string | null = null;
    // the stretch a Light job covers: the cap, the person's max_seconds, or the whole clip when it is shorter
    const lightWindow = Math.min(windowSeconds(job.options, WINDOW.light), sourceSeconds > 0 ? Math.round(sourceSeconds * 100) / 100 : Infinity);
    if (!drivingUrl && !requestId && !Array.isArray(job.progress?.pieces)) {
      await renew(sb, job, { done: 0, total: 1, note: "Preparing your video" });
      dir = await mkdtemp(join(tmpdir(), "studio-recast-"));
      original = join(dir, "original.mp4");
      const src = await sb.storage.from("studio-uploads").download(sourceKey!);
      if (src.error || !src.data) throw src.error ?? new RecastError("source_missing");
      await writeFile(original, Buffer.from(await src.data.arrayBuffer()));
      if (engine === "genjutsu" && model === "light" && (tool === "swap" || tool === "recast")) {
        const cuts = lightWindow > MAX_SECONDS.light ? [] : await (deps.sceneCuts ?? sceneCuts)(original, lightWindow).catch(() => [] as number[]);
        engine = chooseEngine(tool, model, lightWindow, cuts);
        if (engine === "seedance") { await renew(sb, job, { engine: "seedance" }); log(`[recast] long path ${JSON.stringify({ job: job.id, window: lightWindow, cuts: cuts.length })}`); }
      }
    }

    let final: string;
    if (engine === "seedance") {
      // 2a. The long path: the clip in pieces of up to PIECE_SECONDS, cut at camera changes, rendered together.
      dir = dir ?? await mkdtemp(join(tmpdir(), "studio-recast-"));
      if (!original) { original = join(dir, "original.mp4"); const src = await sb.storage.from("studio-uploads").download(sourceKey!); if (src.error || !src.data) throw src.error ?? new RecastError("source_missing"); await writeFile(original, Buffer.from(await src.data.arrayBuffer())); }
      let pieces: Array<{ start: number; end: number; request_id: string | null; input_key: string }> = Array.isArray(job.progress?.pieces) ? job.progress.pieces : [];
      if (!pieces.length) {
        const cuts = await (deps.sceneCuts ?? sceneCuts)(original, lightWindow).catch(() => [] as number[]);
        const plan = planPieces(lightWindow, cuts);
        await renew(sb, job, { done: 0, total: plan.length, note: plan.length > 1 ? `Preparing ${plan.length} pieces` : "Preparing your video" });
        const images = await characterUrls(sb, deps, job, false);
        const prompt = targetsPrompt(String(job.options?.prompt ?? "").trim() || LONG_PROMPT, Array.isArray(job.options?.targets) ? job.options.targets : null);
        for (const [i, p] of plan.entries()) {
          const file = join(dir, `piece-${i + 1}.mp4`);
          await (deps.prescale ?? prescaleSource)(original, file, Math.round((p.end - p.start) * 100) / 100, p.start);
          const inputKey = `${job.user_id}/${job.id}/${job.lease_token}/input-${i + 1}.mp4`;
          const put = await sb.storage.from("studio-outputs").upload(inputKey, await readFile(file), { contentType: "video/mp4", upsert: true });
          if (put.error) throw put.error;
          const signed = await sb.storage.from("studio-outputs").createSignedUrl(inputKey, 7200);
          if (signed.error || !signed.data) throw signed.error ?? new RecastError("source_missing");
          await renew(sb, job, { note: plan.length > 1 ? `Sending piece ${i + 1} of ${plan.length} to the renderer` : "Sending your video to the renderer" });
          const r = await hf(deps, `/${LONG_ENDPOINT}`, { method: "POST", body: JSON.stringify({ video_url: signed.data.signedUrl, image_urls: images.slice(0, 8), prompt, resolution: RECAST_RESOLUTION, generate_audio: false }), idempotency: `${job.id}:${job.attempts}:${i + 1}` });
          if (!r?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
          pieces.push({ start: p.start, end: p.end, request_id: String(r.request_id), input_key: inputKey });
          await renew(sb, job, { pieces, submitted_at: job.progress?.submitted_at ?? new Date(now()).toISOString() });
          log(`[recast] submitted ${JSON.stringify({ job: job.id, tool, model, engine, piece: i + 1, of: plan.length, request: r.request_id })}`);
        }
      }
      // wait for every piece; one refusal fails the job (the long path has no shorter fallback)
      const started = Date.parse(job.progress?.submitted_at ?? "") || now();
      const urls: Array<string | null> = pieces.map(() => null);
      for (;;) {
        if (now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
        let pending = 0;
        for (const [i, p] of pieces.entries()) {
          if (urls[i]) continue;
          let st: { status: string; videoUrl: string | null; raw: any };
          try { st = await pollRecast(deps, p.request_id!); }
          catch (e: any) { if (e instanceof RecastError && e.retry) { pending++; continue; } throw e; }
          if (st.status === "completed") { if (!st.videoUrl) throw new RecastError("recast_bad_output", "completed without a video url"); urls[i] = st.videoUrl; continue; }
          if (st.status === "failed" || st.status === "nsfw" || st.status === "canceled" || st.status === "cancelled") {
            log(`[recast] ${st.status} ${JSON.stringify({ job: job.id, piece: i + 1, request: p.request_id, detail: JSON.stringify(st.raw).slice(0, 300) })}`);
            throw new RecastError(st.status === "nsfw" ? "recast_nsfw" : st.status === "failed" ? failureCode(st.raw) : "recast_canceled");
          }
          pending++;
        }
        const done = urls.filter(Boolean).length;
        await renew(sb, job, { done, total: pieces.length, note: pieces.length > 1 ? `Rendering piece ${Math.min(done + 1, pieces.length)} of ${pieces.length}` : ({ recast: "Rendering your recast", swap: "Rendering your swap" } as Record<string, string>)[tool] ?? "Rendering" });
        if (!pending) break;
        await sleep(POLL_MS);
      }
      // 3a. Fetch the pieces, join them, put the person's own sound back.
      await renew(sb, job, { note: pieces.length > 1 ? "Joining the pieces" : "Fetching the result" });
      const files: string[] = [];
      for (const [i, u] of urls.entries()) {
        const dl = await (deps.fetch ?? fetch)(u!, { signal: AbortSignal.timeout(300_000) });
        if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
        const bytes = Buffer.from(await dl.arrayBuffer());
        if (!bytes.length || bytes.length > OUTPUT_LIMIT) throw new RecastError("output_too_large");
        const f = join(dir, `out-${i + 1}.mp4`); await writeFile(f, bytes); files.push(f);
      }
      const joined = join(dir, "joined.mp4"), out = join(dir, "out.mp4");
      if (files.length > 1) await (deps.concat ?? concatVideos)(files, joined); else await writeFile(joined, await readFile(files[0]));
      await renew(sb, job, { note: "Putting your sound back" });
      await (deps.mux ?? muxAudio)(joined, original, out);
      final = out;
      requestId = pieces.map((p) => p.request_id).join(",");
    } else {
      // 2b. Genjutsu: one request (or the one we already made before a restart).
      if (!requestId) {
        let videoUrl = drivingUrl;
        if (!videoUrl) {
          // Scale the source to 720p first: Higgsfield bills by the input's resolution, and renders 720p regardless.
          const scaled = join(dir!, "scaled.mp4");
          const cutAt = Number(job.progress?.cut_at) || null;
          const window = cutAt ? Math.min(cutAt, windowSeconds(job.options, MAX_SECONDS[model])) : windowSeconds(job.options, MAX_SECONDS[model]);
          await (deps.prescale ?? prescaleSource)(original!, scaled, window);
          const inputKey = `${job.user_id}/${job.id}/${job.lease_token}/input-720p.mp4`;
          const put = await sb.storage.from("studio-outputs").upload(inputKey, await readFile(scaled), { contentType: "video/mp4", upsert: true });
          if (put.error) throw put.error;
          const video = await sb.storage.from("studio-outputs").createSignedUrl(inputKey, 7200);
          if (video.error || !video.data) throw video.error ?? new RecastError("source_missing");
          videoUrl = video.data.signedUrl;
          await renew(sb, job, { note: "Sending your video to the renderer", input_key: inputKey });
        } else await renew(sb, job, { done: 0, total: 1, note: "Sending the clip to the renderer" });
        const images = await characterUrls(sb, deps, job, tool === "restyle");
        const prompt = tool === "swap" ? targetsPrompt(String(job.options?.prompt ?? "").trim() || SWAP_DEFAULT_PROMPT, Array.isArray(job.options?.targets) ? job.options.targets : null) : tool === "restyle" ? String(job.options?.prompt ?? "").trim() || undefined : undefined;
        const sub = await submitRecast(deps, { tool, model, videoUrl, imageUrls: images, prompt, presetId: tool === "restyle" ? String(job.options?.style_id ?? "") : undefined, idempotencyKey: job.attempts ? `${job.id}:${job.attempts}` : job.id, resolution: RECAST_RESOLUTION });
        requestId = sub.request_id;
        await renew(sb, job, { request_id: requestId, submitted_at: new Date(now()).toISOString(), note: "In Higgsfield's queue" });
        log(`[recast] submitted ${JSON.stringify({ job: job.id, tool, model, request: requestId })}`);
      }

      // Wait. Every poll renews the lease; the job stays ours as long as we are alive.
      const started = Date.parse(job.progress?.submitted_at ?? "") || now();
      let result: { status: string; videoUrl: string | null; raw: any } | null = null;
      for (;;) {
        if (now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
        let st: { status: string; videoUrl: string | null; raw: any };
        try { st = await pollRecast(deps, requestId); }
        catch (e: any) { if (e instanceof RecastError && e.retry) { await renew(sb, job, { note: "Waiting for the renderer" }); await sleep(POLL_MS); continue; } throw e; }
        if (st.status === "completed") { result = st; break; }
        if (st.status === "failed" || st.status === "nsfw" || st.status === "canceled" || st.status === "cancelled") {
          log(`[recast] ${st.status} ${JSON.stringify({ job: job.id, request: requestId, detail: JSON.stringify(st.raw).slice(0, 300) })}`);
          const code = st.status === "nsfw" ? "recast_nsfw" : st.status === "failed" ? failureCode(st.raw) : "recast_canceled";
          // "Generation failed" with no reason: Genjutsu refuses clips whose shot changes inside the window it uses. A Light
          // swap or recast is retried on the long path, which takes cuts; a Full one is retried on the opening shot only, up
          // to the first cut. Attempts count claims, this one included, so 1 is the first run and 2 the retry.
          if (code === "recast_failed" && job.attempts < 2) {
            if (model === "light" && (tool === "swap" || tool === "recast") && !drivingUrl) {
              await renew(sb, job, { request_id: null, submitted_at: null, engine: "seedance", note: "The renderer gave up once; trying again on the long path" });
              throw new RecastError(code, "generation failed once, retrying on the long path", true);
            }
            let cutAt: number | null = null;
            if (!drivingUrl && original) {
              const window = windowSeconds(job.options, MAX_SECONDS[model]);
              const cuts = await (deps.sceneCuts ?? sceneCuts)(original, window).catch(() => [] as number[]);
              cutAt = openingShot(cuts);
              if (cutAt != null && cutAt >= window) cutAt = null;
            }
            await renew(sb, job, { request_id: null, submitted_at: null, cut_at: cutAt, note: cutAt ? `The renderer gave up once; trying again with the opening shot only (${cutAt} s)` : "The renderer gave up once; trying again" });
            throw new RecastError(code, cutAt ? `generation failed once, retrying on the first ${cutAt} s` : "generation failed once, retrying", true);
          }
          throw new RecastError(code);
        }
        await renew(sb, job, { note: st.status === "in_progress" || st.status === "processing" ? ({ recast: "Rendering your recast", swap: "Rendering your swap", restyle: "Redrawing your video", trend: "Performing the trend" } as Record<string, string>)[tool] : "In Higgsfield's queue" });
        await sleep(POLL_MS);
      }
      if (!result?.videoUrl) throw new RecastError("recast_bad_output", "completed without a video url");

      // 3b. Fetch the result, put the sound back (Full renders picture only), make a poster, store everything.
      await renew(sb, job, { note: "Fetching the result" });
      dir = dir ?? await mkdtemp(join(tmpdir(), "studio-recast-"));
      const raw = join(dir, "raw.mp4"), source = join(dir, "source.mp4"), out = join(dir, "out.mp4");
      const dl = await (deps.fetch ?? fetch)(result.videoUrl, { signal: AbortSignal.timeout(300_000) });
      if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
      const bytes = Buffer.from(await dl.arrayBuffer());
      if (!bytes.length || bytes.length > OUTPUT_LIMIT) throw new RecastError("output_too_large");
      await writeFile(raw, bytes);
      final = raw;
      if (model === "full") {
        await renew(sb, job, { note: drivingUrl ? "Putting the sound back" : "Putting your sound back" });
        if (drivingUrl) {
          const dv = await (deps.fetch ?? fetch)(drivingUrl, { signal: AbortSignal.timeout(120_000) });
          if (!dv.ok) throw new RecastError("trend_unavailable", `clip ${dv.status}`, true);
          await writeFile(source, Buffer.from(await dv.arrayBuffer()));
        } else if (original) await writeFile(source, await readFile(original));
        else {
          const src = await sb.storage.from("studio-uploads").download(sourceKey!);
          if (src.error || !src.data) throw src.error ?? new RecastError("source_missing");
          await writeFile(source, Buffer.from(await src.data.arrayBuffer()));
        }
        await (deps.mux ?? muxAudio)(raw, source, out);
        final = out;
      }
    }
    const still = join(dir!, "out.jpg");
    const seconds = await (deps.probeSeconds ?? probeSeconds)(final);
    await (deps.poster ?? makePoster)(final, still);
    const key = `${job.user_id}/${job.id}/${job.lease_token}/1.mp4`;
    const video = await readFile(final), image = await readFile(still);
    const up1 = await sb.storage.from("studio-outputs").upload(key, video, { contentType: "video/mp4", upsert: false });
    if (up1.error) throw up1.error;
    const up2 = await sb.storage.from("studio-outputs").upload(key.replace(/\.mp4$/, ".jpg"), image, { contentType: "image/jpeg", upsert: false });
    if (up2.error) log(`[recast] poster upload failed ${JSON.stringify({ job: job.id, error: up2.error.message })}`);
    const costs = studioCosts(deps.env ?? process.env, PLANS);
    const per = model === "light" ? costs.recast_light_second : costs.recast_second;
    // Higgsfield bills the input's seconds (rounded up), and the output can come back a little shorter: charge the larger.
    const cutAt = engine === "genjutsu" ? Number(job.progress?.cut_at) || null : null;
    const window = engine === "seedance" ? lightWindow : cutAt ? Math.min(cutAt, windowSeconds(job.options, MAX_SECONDS[model])) : windowSeconds(job.options, MAX_SECONDS[model]);
    const billed = Math.max(Math.ceil(seconds), billableSeconds(sourceSeconds || seconds, window));
    const charged = Math.min(job.credits_reserved, billed * per);
    const pieceCount = Array.isArray(job.progress?.pieces) ? job.progress.pieces.length : 1;
    const outputs = [{ index: 1, key, poster_key: up2.error ? undefined : key.replace(/\.mp4$/, ".jpg"), bytes: video.length, duration: Math.round(seconds * 1000) / 1000, model, tool, engine, request_id: requestId, audio: model === "full" || engine === "seedance" ? "muxed_from_source" : "native", input_key: job.progress?.input_key ?? null, ...(engine === "seedance" && pieceCount > 1 ? { pieces: pieceCount, note: `Rendered in ${pieceCount} pieces at the camera changes and joined` } : {}), ...(cutAt ? { cut_at: cutAt, note: `Cut at the first shot change (${cutAt} s): the renderer takes one continuous shot` } : {}) }];
    try {
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
      if (done.error) throw done.error;
    } catch { return "completion_unconfirmed"; }
    log(`[recast] done ${JSON.stringify({ job: job.id, seconds: Math.round(seconds * 10) / 10, charged })}`);
    return "done";
  } catch (e: any) {
    if (e instanceof RecastError && e.code === "lease_lost") return "lease_lost";
    const code = e instanceof RecastError ? e.code : "worker_error";
    const retry = e instanceof RecastError ? e.retry : true;
    log(`[recast] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    return fail(code, retry);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Claim one recast job if a slot is free. Several can wait on Higgsfield at once; the cap is small on purpose. */
export function startRecastLoop(sbFn: () => SupabaseClient, deps: RecastDeps = {}, intervalMs = 15_000, maxParallel = 3): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!env.HIGGSFIELD_API_KEY || env.STUDIO_RECAST_ENABLED === "false") return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `recast-${randomUUID()}`;
  let running = 0;
  const tick = async () => {
    if (running >= maxParallel) return;
    try {
      const sb = sbFn();
      // One claim per tick, trying each tool of the suite in turn so a busy Recast queue never starves a Swap.
      let job: Job | null = null;
      for (const tool of SUITE_TOOLS) {
        if (tool !== "recast" && env[`STUDIO_${tool.toUpperCase()}_ENABLED`] === "false") continue;
        const r = await sb.rpc("studio_claim", { p_tool: tool, p_worker: worker });
        if (r.error) throw r.error;
        const j = r.data as Job | null;
        if (j && j.id) { job = { ...j, tool: j.tool ?? tool }; break; }
      }
      if (!job) return;
      running++;
      runRecastJob(sb, { ...deps, log }, job).then((s) => log(`[recast] ${s} ${job.id}`)).catch((e) => log(`[recast] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { running--; });
    } catch (e: any) { log(`[recast] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 8_000);
  return t;
}
