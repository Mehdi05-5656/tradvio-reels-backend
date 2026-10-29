// Clone8 Studio: the Character runner. A queued character job asks Higgsfield Soul for one portrait from the person's
// description (human or animal), stores it as an image asset in their library, and charges one character unit. The asset
// is then a reference for Recast, Swap and Trend like an uploaded photo. Runs as a timer loop in the web service.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANS } from "./studio.js";
import { studioCosts } from "./studio-pricing.js";
import { higgsfieldAuth, RecastError, HF_BASE } from "./studio-recast.js";

export const SOUL_ENDPOINT = "higgsfield-ai/soul/standard";
const POLL_MS = 5_000, MAX_WAIT_MS = 10 * 60_000, IMAGE_LIMIT = 33_554_432;

export type CharacterDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number };
type Job = { id: string; user_id: string; lease_token: string; options: any; credits_reserved: number; progress: any; attempts: number };

/** The portrait prompt: the person's words, framed so the result works as a Genjutsu reference (one subject, facing the camera). */
export function characterPrompt(options: any): string {
  const desc = String(options?.prompt ?? "").trim().slice(0, 600);
  return options?.mode === "animal"
    ? `Photorealistic portrait of ${desc}, sitting upright facing the camera like a person, full upper body visible, soft studio light, plain neutral background, sharp detail, no text`
    : `Photorealistic portrait of ${desc}, facing the camera, head and shoulders to waist visible, soft studio light, plain neutral background, natural skin, sharp detail, no text`;
}

async function hf(deps: CharacterDeps, path: string, init: RequestInit & { idempotency?: string } = {}): Promise<any> {
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

export async function submitCharacter(deps: CharacterDeps, p: { prompt: string; idempotencyKey: string }) {
  const r = await hf(deps, `/${SOUL_ENDPOINT}`, { method: "POST", body: JSON.stringify({ prompt: p.prompt, num_images: 1, resolution: "2K", aspect_ratio: "3:4" }), idempotency: p.idempotencyKey });
  if (!r?.request_id) throw new RecastError("recast_rejected", "no request id in the reply");
  return { request_id: String(r.request_id) };
}
export async function pollCharacter(deps: CharacterDeps, requestId: string): Promise<{ status: string; imageUrl: string | null; raw: any }> {
  const r = await hf(deps, `/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
  const status = String(r?.status ?? "unknown").toLowerCase();
  const url = r?.images?.[0]?.url ?? r?.image?.url ?? r?.output?.images?.[0]?.url ?? null;
  return { status, imageUrl: typeof url === "string" ? url : null, raw: r };
}

async function renew(sb: SupabaseClient, job: Job, progress: Record<string, any>) {
  const r = await sb.rpc("studio_renew", { p_job: job.id, p_token: job.lease_token, p_progress: { ...(job.progress ?? {}), ...progress } });
  if (r.error) throw r.error;
  if (r.data !== true) throw new RecastError("lease_lost");
  job.progress = { ...(job.progress ?? {}), ...progress };
}

export async function runCharacterJob(sb: SupabaseClient, deps: CharacterDeps, job: Job): Promise<string> {
  const log = deps.log ?? (() => undefined), sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), now = deps.now ?? Date.now;
  const fail = async (code: string, retry: boolean) => {
    try { const r = await sb.rpc("studio_fail", { p_job: job.id, p_token: job.lease_token, p_reason: code, p_retry: retry }); if (r.error) throw r.error; }
    catch { return "failure_unconfirmed"; }
    return retry && job.attempts < 3 ? "requeued" : "failed";
  };
  try {
    let requestId: string | null = job.progress?.request_id ?? null;
    if (!requestId) {
      await renew(sb, job, { done: 0, total: 1, note: "Describing your character to the renderer" });
      const sub = await submitCharacter(deps, { prompt: characterPrompt(job.options), idempotencyKey: job.id });
      requestId = sub.request_id;
      await renew(sb, job, { request_id: requestId, submitted_at: new Date(now()).toISOString(), note: "Drawing your character" });
      log(`[character] submitted ${JSON.stringify({ job: job.id, request: requestId })}`);
    }
    const started = Date.parse(job.progress?.submitted_at ?? "") || now();
    let result: { imageUrl: string | null } | null = null;
    for (;;) {
      if (now() - started > MAX_WAIT_MS) throw new RecastError("recast_timeout");
      let st: { status: string; imageUrl: string | null; raw: any };
      try { st = await pollCharacter(deps, requestId); }
      catch (e: any) { if (e instanceof RecastError && e.retry) { await renew(sb, job, { note: "Waiting for the renderer" }); await sleep(POLL_MS); continue; } throw e; }
      if (st.status === "completed") { result = st; break; }
      if (st.status === "failed" || st.status === "nsfw" || st.status === "canceled" || st.status === "cancelled") throw new RecastError(st.status === "nsfw" ? "recast_nsfw" : st.status === "failed" ? "recast_failed" : "recast_canceled");
      await renew(sb, job, { note: "Drawing your character" });
      await sleep(POLL_MS);
    }
    if (!result?.imageUrl) throw new RecastError("recast_bad_output", "completed without an image url");
    const dl = await (deps.fetch ?? fetch)(result.imageUrl, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) throw new RecastError("recast_bad_output", `download ${dl.status}`, true);
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new RecastError("output_too_large");
    const ct = String(dl.headers.get("content-type") ?? ""), ext = /png/.test(ct) ? "png" : "jpg";
    // The character joins the library as a ready image asset, so every tool can pick it like an uploaded photo.
    const assetId = randomUUID(), key = `${job.user_id}/${assetId}.${ext}`;
    const name = `Character: ${String(job.options?.prompt ?? "").trim().slice(0, 60) || "untitled"}`;
    const up = await sb.storage.from("studio-uploads").upload(key, bytes, { contentType: ext === "png" ? "image/png" : "image/jpeg", upsert: false });
    if (up.error) throw up.error;
    const ins = await sb.from("studio_assets").insert({ id: assetId, user_id: job.user_id, kind: "image", name, object_key: key, bytes: bytes.length, status: "ready", probe: { character: true, mode: job.options?.mode ?? "human" } });
    if (ins.error) throw ins.error;
    // A copy in studio-outputs is what the job panel shows and signs, like every other tool's output.
    const outKey = `${job.user_id}/${job.id}/${job.lease_token}/1.${ext}`;
    const out = await sb.storage.from("studio-outputs").upload(outKey, bytes, { contentType: ext === "png" ? "image/png" : "image/jpeg", upsert: false });
    if (out.error) log(`[character] output copy failed ${JSON.stringify({ job: job.id, error: out.error.message })}`);
    const costs = studioCosts(deps.env ?? process.env, PLANS);
    const charged = Math.min(job.credits_reserved, costs.character_image);
    const outputs = [{ index: 1, key: out.error ? key : outKey, poster_key: out.error ? undefined : outKey, kind: "image", asset_id: assetId, bytes: bytes.length, request_id: requestId, tool: "character" }];
    try {
      const done = await sb.rpc("studio_complete", { p_job: job.id, p_token: job.lease_token, p_outputs: outputs, p_credits_charged: charged });
      if (done.error) throw done.error;
    } catch { return "completion_unconfirmed"; }
    log(`[character] done ${JSON.stringify({ job: job.id, asset: assetId, charged })}`);
    return "done";
  } catch (e: any) {
    if (e instanceof RecastError && e.code === "lease_lost") return "lease_lost";
    const code = e instanceof RecastError ? e.code : "worker_error";
    const retry = e instanceof RecastError ? e.retry : true;
    log(`[character] ${code} ${JSON.stringify({ job: job.id, detail: String(e?.message ?? e).slice(0, 200) })}`);
    return fail(code, retry);
  }
}

export function startCharacterLoop(sbFn: () => SupabaseClient, deps: CharacterDeps = {}, intervalMs = 15_000, maxParallel = 2): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!env.HIGGSFIELD_API_KEY || env.STUDIO_CHARACTER_ENABLED === "false") return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = `character-${randomUUID()}`;
  let running = 0;
  const tick = async () => {
    if (running >= maxParallel) return;
    try {
      const sb = sbFn();
      const r = await sb.rpc("studio_claim", { p_tool: "character", p_worker: worker });
      if (r.error) throw r.error;
      const job = r.data as Job | null;
      if (!job || !job.id) return;
      running++;
      runCharacterJob(sb, { ...deps, log }, job).then((s) => log(`[character] ${s} ${job.id}`)).catch((e) => log(`[character] crashed ${job.id} ${e?.message ?? e}`)).finally(() => { running--; });
    } catch (e: any) { log(`[character] claim failed ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 11_000);
  return t;
}
