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
import { COSTS } from "./studio.js";

export const HF_BASE = "https://api.higgsfield.ai";
export const MODELS = { full: "higgsfield/genjutsu/motion-transfer/v1.0", light: "higgsfield/genjutsu-light/motion-transfer/v1.0" } as const;
/** What the models accept: the full model trims sources to 30 s, Light uses the first 15 s and keeps audio. */
export const MAX_SECONDS = { full: 30, light: 15 } as const;
export const MIN_SECONDS = 4;
const POLL_MS = 10_000, MAX_WAIT_MS = 40 * 60_000, OUTPUT_LIMIT = 268_435_456;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecastDeps = {
  fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>;
  now?: () => number; mux?: (output: string, source: string, target: string) => Promise<void>; probeSeconds?: (path: string) => Promise<number>; poster?: (video: string, target: string) => Promise<void>;
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

export async function submitRecast(deps: RecastDeps, p: { model: "full" | "light"; videoUrl: string; imageUrls: string[]; prompt?: string; resolution?: "480p" | "720p" | "1080p"; idempotencyKey: string }) {
  const body: any = { video_url: p.videoUrl, image_urls: p.imageUrls.slice(0, 8) };
  if (p.prompt) body.prompt = p.prompt;
  if (p.resolution) body.resolution = p.resolution;
  const r = await hf(deps, `/${MODELS[p.model]}`, { method: "POST", body: JSON.stringify(body), idempotency: p.idempotencyKey });
  if (!r?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
  return { request_id: String(r.request_id), status: String(r.status ?? "queued"), status_url: r.status_url ? String(r.status_url) : `${HF_BASE}/requests/${r.request_id}/status` };
}

export async function pollRecast(deps: RecastDeps, requestId: string): Promise<{ status: string; videoUrl: string | null; raw: any }> {
  const r = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
  const status = String(r?.status ?? "unknown").toLowerCase();
  const videoUrl = r?.video?.url ?? r?.videos?.[0]?.url ?? r?.output?.video?.url ?? null;
  return { status, videoUrl: typeof videoUrl === "string" ? videoUrl : null, raw: r };
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

type Job = { id: string; user_id: string; lease_token: string; asset_id: string | null; options: any; credits_reserved: number; progress: any; attempts: number };

async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new RecastError("lease_lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}

/** Where the character comes from: the person's own photo (signed) or a preset served by the dashboard. */
async function characterUrls(sb: SupabaseClient, deps: RecastDeps, job: Job): Promise<string[]> {
  const o = job.options ?? {};
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
    const model: "full" | "light" = job.options?.model === "light" ? "light" : "full";
    if (!job.asset_id) throw new RecastError("source_missing");
    const asset = await sb.from("studio_assets").select("id,object_key,kind,status,probe,name").eq("id", job.asset_id).eq("user_id", job.user_id).maybeSingle();
    if (asset.error) throw asset.error;
    if (!asset.data || asset.data.kind !== "video" || asset.data.status !== "ready") throw new RecastError("source_not_ready");
    const sourceSeconds = Number(asset.data.probe?.duration ?? 0);
    if (sourceSeconds && sourceSeconds < MIN_SECONDS) throw new RecastError("source_too_short_recast");

    // 1. Submit (or pick up a request we already made before a restart).
    let requestId: string | null = job.progress?.request_id ?? null;
    if (!requestId) {
      await renew(sb, job, { done: 0, total: 1, note: "Sending your video to the renderer" });
      const video = await sb.storage.from("studio-uploads").createSignedUrl(asset.data.object_key, 7200);
      if (video.error || !video.data) throw video.error ?? new RecastError("source_missing");
      const images = await characterUrls(sb, deps, job);
      const sub = await submitRecast(deps, { model, videoUrl: video.data.signedUrl, imageUrls: images, idempotencyKey: job.id });
      requestId = sub.request_id;
      await renew(sb, job, { request_id: requestId, submitted_at: new Date(now()).toISOString(), note: "In Higgsfield's queue" });
      log(`[recast] submitted ${JSON.stringify({ job: job.id, model, request: requestId })}`);
    }

    // 2. Wait. Every poll renews the lease; the job stays ours as long as we are alive.
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
        throw new RecastError(st.status === "nsfw" ? "recast_nsfw" : st.status === "failed" ? "recast_failed" : "recast_canceled");
      }
      await renew(sb, job, { note: st.status === "in_progress" || st.status === "processing" ? "Rendering your recast" : "In Higgsfield's queue" });
      await sleep(POLL_MS);
    }
    if (!result?.videoUrl) throw new RecastError("recast_bad_output", "completed without a video url");

    // 3. Fetch the result, put the sound back, make a poster, store everything.
    await renew(sb, job, { note: "Fetching the result" });
    dir = await mkdtemp(join(tmpdir(), "studio-recast-"));
    const raw = join(dir, "raw.mp4"), source = join(dir, "source.mp4"), out = join(dir, "out.mp4"), still = join(dir, "out.jpg");
    const dl = await (deps.fetch ?? fetch)(result.videoUrl, { signal: AbortSignal.timeout(300_000) });
    if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (!bytes.length || bytes.length > OUTPUT_LIMIT) throw new RecastError("output_too_large");
    await writeFile(raw, bytes);
    let final = raw;
    if (model === "full") {
      await renew(sb, job, { note: "Putting your sound back" });
      const src = await sb.storage.from("studio-uploads").download(asset.data.object_key);
      if (src.error || !src.data) throw src.error ?? new RecastError("source_missing");
      await writeFile(source, Buffer.from(await src.data.arrayBuffer()));
      await (deps.mux ?? muxAudio)(raw, source, out);
      final = out;
    }
    const seconds = await (deps.probeSeconds ?? probeSeconds)(final);
    await (deps.poster ?? makePoster)(final, still);
    const key = `${job.user_id}/${job.id}/${job.lease_token}/1.mp4`;
    const video = await readFile(final), image = await readFile(still);
    const up1 = await sb.storage.from("studio-outputs").upload(key, video, { contentType: "video/mp4", upsert: false });
    if (up1.error) throw up1.error;
    const up2 = await sb.storage.from("studio-outputs").upload(key.replace(/\.mp4$/, ".jpg"), image, { contentType: "image/jpeg", upsert: false });
    if (up2.error) log(`[recast] poster upload failed ${JSON.stringify({ job: job.id, error: up2.error.message })}`);
    const per = model === "light" ? COSTS.recast_light_second : COSTS.recast_second;
    const charged = Math.min(job.credits_reserved, Math.ceil(seconds) * per);
    const outputs = [{ index: 1, key, poster_key: up2.error ? undefined : key.replace(/\.mp4$/, ".jpg"), bytes: video.length, duration: Math.round(seconds * 1000) / 1000, model, request_id: requestId, audio: model === "full" ? "muxed_from_source" : "native" }];
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
      const r = await sb.rpc("studio_claim", { p_tool: "recast", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running++;
      runRecastJob(sb, deps, job).then((s) => log(`[recast] ${s} ${job.id}`)).catch((e) => log(`[recast] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { running--; });
    } catch (e: any) { log(`[recast] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 8_000);
  return t;
}
