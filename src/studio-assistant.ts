// Clone8 Studio: the assistant. A creator describes what they want in words, attaches files or pastes a link, and
// the assistant turns that into a plan of Studio steps (Blueprint, Recast, Swap, Styles, Trends, Characters, any
// instrument), priced in credits. The person confirms the plan in the interface; a run then creates one job per
// step, chaining an earlier step's output into a later step's input, and the conversation records progress.
//
// The model is Claude (Anthropic Messages API, tool use). It knows only what studio-knowledge.ts tells it: the live
// tools, prices, catalog and the person's own library. It never starts work: propose_plan returns a priced plan to
// the person; confirm is a separate route the interface calls on their click.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANS, quote, StudioError, fetchStyles, toolsEnabled, costsFor, publicJob, withAssetNames, downloadBase, type StudioStyle } from "./studio.js";
import { buildSystemPrompt, PRESET_CHARACTERS, type KnowledgeUser } from "./studio-knowledge.js";
import { quoteInstrument, instrumentById, tableUsd, instrumentCredits, InstrumentError, inputAssetIds } from "./studio-instruments.js";
import { trendById } from "./studio-trends.js";
import { probeSeconds, makePoster } from "./studio-recast.js";
import { checkUpload, checkJobRate } from "./studio-limits.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^\$(\d{1,2})$/;
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 5, MAX_MESSAGES = 60, LINK_LIMIT = 536_870_912;

export class AssistantError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

export type Attachment = { asset_id: string; name: string; kind: string; seconds: number | null };
export type Message = { id: string; role: "user" | "assistant"; text: string; attachments?: Attachment[]; links?: string[]; plan_id?: string | null; at: string };
export type PlanStep = { index: number; tool: string; label: string; source: string | null; options: Record<string, any>; credits: number; estimate: boolean; output: "video" | "image"; seconds: number | null; summary: string };
export type Plan = { id: string; title: string; steps: PlanStep[]; total_credits: number; estimate: boolean; status: "proposed" | "confirmed" | "superseded"; created_at: string; warnings: string[] };
export type RunStep = { index: number; job_id: string | null; asset_id: string | null; status: "waiting" | "queued" | "running" | "done" | "failed" | "canceled" | "skipped"; error_code?: string | null };
export type Run = { plan_id: string; status: "running" | "done" | "failed" | "canceled"; steps: RunStep[]; started_at: string; finished_at?: string | null; note?: string | null };
export type Conversation = { id: string; user_id: string; title: string; status: string; messages: Message[]; plan: Plan | null; run: Run | null; created_at: string; updated_at: string };

export type AssistantDeps = {
  fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: () => number;
  styles?: (env: Record<string, string | undefined>) => Promise<StudioStyle[]>;
  probeSeconds?: (path: string) => Promise<number>; poster?: (video: string, target: string) => Promise<void>;
};

// ---------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------
export const TOOLS = [
  {
    name: "propose_plan",
    description: "Propose the steps that fulfil the person's request, in order. Call it once, only when every required input is known. Each step's source is a library asset id, or \"$N\" for the output of step N. The tool prices every step and returns the plan; the person confirms it in the interface.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string", description: "Four to eight words naming the whole job" },
        steps: {
          type: "array", minItems: 1, maxItems: 8,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              tool: { type: "string", enum: ["blueprint", "recast", "swap", "restyle", "trend", "character", "instrument"] },
              label: { type: "string", description: "What this step does, in the person's words" },
              source: { type: ["string", "null"], description: "Video (or picture) asset id, or \"$N\". Null for trend, character and text-only instruments." },
              options: {
                type: "object", additionalProperties: true,
                description: "blueprint: {copies}. recast/swap: {model: light|full, character: preset id, or character_asset_id: library image id or \"$N\" of a character step; swap also takes prompt}. restyle: {style_name or style_id, prompt?}. trend: {trend_id, model, character or character_asset_id}. character: {mode: human|animal, prompt}. instrument: {endpoint, params: {...}, inputs: {media_field: asset id or [ids] or \"$N\"}}.",
              },
            },
            required: ["tool", "label", "options"],
          },
        },
      },
      required: ["title", "steps"],
    },
  },
  {
    name: "fetch_link",
    description: "Fetch a TikTok or Instagram video link into the person's library so it can be used as a source. Returns the new asset (id, name, seconds). YouTube is not supported; ask for the file instead.",
    input_schema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } }, required: ["url"] },
  },
];

async function claude(deps: AssistantDeps, body: Record<string, any>): Promise<any> {
  const env = deps.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new AssistantError("assistant_unavailable", "The assistant is not configured", 503);
  const r = await (deps.fetch ?? fetch)("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.STUDIO_ASSISTANT_MODEL || DEFAULT_MODEL, max_tokens: 1400, temperature: 0.2, ...body }),
  }).catch(() => { throw new AssistantError("assistant_unavailable", "The assistant did not answer", 503); });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AssistantError("assistant_unavailable", `Claude ${r.status}: ${text.slice(0, 200)}`, r.status === 429 || r.status >= 500 ? 503 : 502);
  }
  return r.json();
}

// ---------------------------------------------------------------------------------------------------
// Knowledge for this person
// ---------------------------------------------------------------------------------------------------
async function userContext(sb: SupabaseClient, u: string): Promise<{ user: KnowledgeUser; assets: any[] }> {
  const [assets, cust, bal, jobs] = await Promise.all([
    sb.from("studio_assets").select("id,kind,name,probe,status,bytes").eq("user_id", u).eq("status", "ready").order("created_at", { ascending: false }).limit(60),
    sb.from("studio_customers").select("plan_id,status,parallel_jobs").eq("user_id", u).maybeSingle(),
    sb.rpc("studio_balance", { p_user: u }),
    sb.from("studio_jobs").select("id,tool,status,options,asset_id,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(8),
  ]);
  for (const r of [assets, cust, jobs]) if (r.error) throw r.error;
  const list = (assets.data ?? []) as any[];
  const named = await withAssetNames(sb, u, (jobs.data ?? []) as any[]);
  return {
    assets: list,
    user: {
      plan: cust.data?.plan_id ?? null, status: cust.data?.status ?? null, balance: Number(bal.data ?? 0), parallel_jobs: Number(cust.data?.parallel_jobs ?? 1),
      assets: list.map((a) => ({ id: a.id, kind: a.kind, name: a.name, seconds: Number(a.probe?.duration) > 0 ? Number(a.probe.duration) : null, character: !!a.probe?.character, prompt: a.probe?.prompt ?? null })),
      recent_jobs: named.map((j: any) => ({ id: j.id, tool: j.tool, status: j.status, label: jobLabel(j) })),
    },
  };
}
function jobLabel(j: any): string {
  const name = String(j.asset_name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "");
  if (j.tool === "character") return `Character "${String(j.options?.prompt ?? "").slice(0, 40)}"`;
  if (j.tool === "trend") return `Trend ${j.options?.trend_name ?? ""}`;
  if (j.tool === "instrument") return `${String(j.options?.endpoint ?? "")}`;
  return `${j.tool}${name ? ` on ${name}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------
// Plans: validate what the model proposed, price every step, keep "$N" references for the run.
// ---------------------------------------------------------------------------------------------------
type Ctx = { sb: SupabaseClient; u: string; env: Record<string, string | undefined>; assets: Map<string, any>; styles: StudioStyle[]; deps: AssistantDeps; tools: Record<string, boolean> };

export function expectedOutput(tool: string, options: any, sourceSeconds: number | null, instOutput?: "video" | "image"): { output: "video" | "image"; seconds: number | null } {
  if (tool === "character") return { output: "image", seconds: null };
  if (tool === "instrument") return { output: instOutput ?? "video", seconds: instOutput === "image" ? null : Number(options?.units ?? options?.params?.duration ?? sourceSeconds ?? 5) };
  if (tool === "trend") return { output: "video", seconds: trendById(options?.trend_id)?.seconds ?? null };
  return { output: "video", seconds: options?.seconds ?? sourceSeconds };
}

export async function pricePlan(ctx: Ctx, raw: any): Promise<Plan> {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps) || !raw.steps.length) throw new AssistantError("plan_invalid", "A plan needs at least one step");
  if (raw.steps.length > 8) throw new AssistantError("plan_invalid", "At most eight steps");
  const costs = costsFor(ctx.env);
  const steps: PlanStep[] = [];
  const warnings: string[] = [];
  // the asset a "$N" would be once promoted: its kind and (for video) its seconds
  const produced: Array<{ output: "video" | "image"; seconds: number | null }> = [];
  const resolveRef = (v: unknown, i: number, want: "video" | "image"): { id: string | null; ref: number | null; pseudo: { kind: string; probe: any } | null } => {
    const s = String(v ?? "");
    const m = s.match(REF_RE);
    if (m) {
      const k = Number(m[1]);
      if (!(k >= 1 && k < i)) throw new AssistantError("plan_invalid", `Step ${i} refers to step ${k}, which comes later or does not exist`);
      const p = produced[k - 1];
      if (p.output !== want) throw new AssistantError("plan_invalid", `Step ${i} needs a ${want} but step ${k} makes a ${p.output}`);
      return { id: null, ref: k, pseudo: { kind: want, probe: { duration: p.seconds ?? 5 } } };
    }
    if (UUID_RE.test(s)) {
      const a = ctx.assets.get(s.toLowerCase());
      if (!a) throw new AssistantError("plan_invalid", `Step ${i}: no file with id ${s} in the library`);
      if (a.kind !== want) throw new AssistantError("plan_invalid", `Step ${i}: "${a.name}" is a ${a.kind}, this step needs a ${want}`);
      return { id: a.id, ref: null, pseudo: null };
    }
    throw new AssistantError("plan_invalid", `Step ${i}: "${s}" is neither a library id nor "$N"`);
  };
  for (let i = 1; i <= raw.steps.length; i++) {
    const st = raw.steps[i - 1] ?? {};
    const tool = String(st.tool ?? "");
    if (!["blueprint", "recast", "swap", "restyle", "trend", "character", "instrument"].includes(tool)) throw new AssistantError("plan_invalid", `Step ${i}: unknown tool ${tool}`);
    if (!ctx.tools[tool]) throw new AssistantError("plan_invalid", `Step ${i}: ${tool} is not taking jobs right now`);
    const o = st.options && typeof st.options === "object" ? { ...st.options } : {};
    const label = String(st.label ?? tool).slice(0, 120);
    let credits = 0, estimate = false, summary = "", sourceStr: string | null = null, seconds: number | null = null, output: "video" | "image" = "video";

    if (tool === "character") {
      const q = quote("character", { mode: o.mode, prompt: o.prompt }, null, costs);
      credits = q.credits; summary = q.summary; Object.assign(o, q.options);
      output = "image";
    } else if (tool === "instrument") {
      const inst = instrumentById(o.endpoint, ctx.env);
      if (!inst) throw new AssistantError("plan_invalid", `Step ${i}: instrument ${o.endpoint} is not offered`);
      const inputs: Record<string, any> = o.inputs && typeof o.inputs === "object" ? o.inputs : {};
      const resolved: Record<string, string | string[]> = {}; let hasRef = false; let refSeconds: number | null = null;
      for (const [field, kind] of Object.entries(inst.media_fields)) {
        if (inputs[field] === undefined || inputs[field] === null) continue;
        const want = kind === "video" ? "video" : "image";
        const vals = ([] as any[]).concat(inputs[field]);
        const ids = vals.map((v) => { const r = resolveRef(v, i, want); if (r.ref) { hasRef = true; refSeconds = r.pseudo?.probe?.duration ?? refSeconds; return `$${r.ref}`; } return r.id!; });
        resolved[field] = Array.isArray(inputs[field]) ? ids : ids[0];
      }
      o.inputs = resolved;
      if (!hasRef) {
        const q = await quoteInstrument({ env: ctx.env, fetch: ctx.deps.fetch }, PLANS, { endpoint: inst.id, params: o.params ?? {}, inputs: resolved }, async (ids) => {
          const map = new Map<string, { url: string; kind: string; seconds: number | null }>();
          for (const id of ids) { const a = ctx.assets.get(id.toLowerCase()); if (!a) continue; const s = await ctx.sb.storage.from("studio-uploads").createSignedUrl(a.object_key, 600); if (s.data) map.set(id, { url: s.data.signedUrl, kind: a.kind, seconds: Number(a.probe?.duration) > 0 ? Number(a.probe.duration) : null }); }
          return map;
        });
        credits = q.credits; summary = q.summary; o.params = q.options.params; o.units = q.options.units; o.usd = q.options.usd; o.priced_by = q.options.priced_by; o.output = inst.output;
      } else {
        const usd = tableUsd(inst, o.params ?? {}, refSeconds);
        if (usd == null) { warnings.push(`Step ${i} (${inst.title}) is priced when it starts; no list price is published.`); credits = 0; }
        else credits = instrumentCredits(usd, PLANS, ctx.env);
        estimate = true; o.output = inst.output; summary = inst.output === "image" ? `priced at start` : `about ${credits} credits`;
      }
      output = inst.output;
    } else if (tool === "trend") {
      const who = resolveCharacter(ctx, o, i, resolveRef);
      const q = quote("trend", { trend_id: o.trend_id, model: o.model ?? "light", ...who.opt }, null, costs);
      credits = q.credits; summary = q.summary; Object.assign(o, q.options, who.ref ? { character_asset_id: `$${who.ref}` } : {});
      estimate = !!who.ref;
    } else {
      // blueprint, recast, swap, restyle: a video source, concrete or "$N"
      const src = resolveRef(st.source, i, "video");
      sourceStr = src.id ?? `$${src.ref}`;
      const asset = src.id ? ctx.assets.get(src.id.toLowerCase()) : src.pseudo;
      let extra: Record<string, any> = {}, whoRef: number | null = null;
      if (tool === "recast" || tool === "swap") { const who = resolveCharacter(ctx, o, i, resolveRef); extra = { ...who.opt, model: o.model ?? "light", prompt: o.prompt }; whoRef = who.ref; if (who.ref) estimate = true; }
      if (tool === "restyle") {
        let styleId = UUID_RE.test(String(o.style_id ?? "")) ? String(o.style_id) : null;
        if (!styleId && o.style_name) { const n = String(o.style_name).toLowerCase(); styleId = ctx.styles.find((s) => s.name.toLowerCase() === n)?.id ?? ctx.styles.find((s) => s.name.toLowerCase().includes(n))?.id ?? null; }
        if (!styleId) throw new AssistantError("plan_invalid", `Step ${i}: style "${o.style_name ?? o.style_id ?? ""}" not found. Styles: ${ctx.styles.map((s) => s.name).join(", ")}`);
        extra = { style_id: styleId, style_name: ctx.styles.find((s) => s.id === styleId)?.name ?? null, prompt: o.prompt, character_asset_id: o.character_asset_id };
      }
      if (tool === "blueprint") extra = { copies: o.copies };
      const q = quote(tool, extra, asset, costs);
      credits = q.credits; summary = q.summary; Object.assign(o, q.options);
      if (src.ref) estimate = true;
      if (whoRef) o.character_asset_id = `$${whoRef}`; // the placeholder passed the quote; the run fills in the made character
    }
    const ex = expectedOutput(tool, o, sourceStr && !sourceStr.startsWith("$") ? Number(ctx.assets.get(sourceStr.toLowerCase())?.probe?.duration) || null : produced[Number(sourceStr?.slice(1) ?? 0) - 1]?.seconds ?? null, output);
    seconds = ex.seconds; output = ex.output;
    produced.push({ output, seconds });
    steps.push({ index: i, tool, label, source: sourceStr, options: o, credits, estimate, output, seconds, summary });
  }
  const total = steps.reduce((n, s) => n + s.credits, 0);
  return { id: randomUUID(), title: String(raw.title ?? "Plan").slice(0, 80), steps, total_credits: total, estimate: steps.some((s) => s.estimate), status: "proposed", created_at: new Date().toISOString(), warnings };
}

/** Who appears: a preset id, a library image id, a "$N" of a character step, or a name the model used for either. */
function resolveCharacter(ctx: Ctx, o: any, i: number, resolveRef: (v: unknown, i: number, want: "video" | "image") => { id: string | null; ref: number | null }): { opt: Record<string, any>; ref: number | null } {
  const preset = PRESET_CHARACTERS.find((p) => p.id === String(o.character ?? "").toLowerCase() || p.name.toLowerCase() === String(o.character ?? o.character_name ?? "").toLowerCase());
  if (preset) return { opt: { character: preset.id, character_asset_id: null }, ref: null };
  const raw = o.character_asset_id ?? o.character ?? o.character_name;
  if (raw == null || raw === "") throw new AssistantError("plan_invalid", `Step ${i}: pick who appears (a preset such as ${PRESET_CHARACTERS.map((p) => p.name).join(", ")}, a made character, or "$N" of a character step)`);
  const s = String(raw);
  if (REF_RE.test(s) || UUID_RE.test(s)) { const r = resolveRef(s, i, "image"); return r.ref ? { opt: { character: null, character_asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, ref: r.ref } : { opt: { character: null, character_asset_id: r.id }, ref: null }; }
  // a name of a made character in the library
  const n = s.toLowerCase();
  const made = [...ctx.assets.values()].find((a) => a.kind === "image" && a.probe?.character && String(a.name ?? "").toLowerCase().includes(n));
  if (made) return { opt: { character: null, character_asset_id: made.id }, ref: null };
  throw new AssistantError("plan_invalid", `Step ${i}: no character called "${s}". Presets: ${PRESET_CHARACTERS.map((p) => p.name).join(", ")}; or make one with a character step and refer to it as "$N".`);
}

// ---------------------------------------------------------------------------------------------------
// Links: TikTok and Instagram through ScrapeCreators (download_media), stored as a library asset.
// ---------------------------------------------------------------------------------------------------
export function linkPlatform(url: string): "tiktok" | "instagram" | "youtube" | null {
  let h = ""; try { h = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return "youtube";
  return null;
}
/** The first downloadable video URL in a ScrapeCreators reply, preferring fields that name a download. */
export function findMediaUrl(body: any): string | null {
  const hits: Array<{ key: string; url: string }> = [];
  const walk = (v: any, key: string, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") { if (/^https?:\/\//.test(v) && (/\.(mp4|mov)(\?|$)/i.test(v) || /download|video_url|playAddr|play_url/i.test(key))) hits.push({ key, url: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, key, depth + 1)); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(body, "", 0);
  const score = (h: { key: string; url: string }) => (/download/i.test(h.key) ? 3 : 0) + (/video_url|play/i.test(h.key) ? 2 : 0) + (/\.mp4(\?|$)/i.test(h.url) ? 1 : 0);
  hits.sort((a, b) => score(b) - score(a));
  return hits[0]?.url ?? null;
}
export async function importLink(sb: SupabaseClient, deps: AssistantDeps, u: string, url: string): Promise<Attachment> {
  const env = deps.env ?? process.env, fetchFn = deps.fetch ?? fetch;
  const platform = linkPlatform(url);
  if (!platform) throw new AssistantError("unsupported_link", "Only TikTok and Instagram links can be fetched");
  if (platform === "youtube") throw new AssistantError("unsupported_link", "YouTube links cannot be fetched yet; upload the file instead");
  const key = env.SCRAPECREATORS_API_KEY;
  if (!key) throw new AssistantError("link_fetch_failed", "Link fetching is not configured", 503);
  const path = platform === "tiktok" ? `/v2/tiktok/video?url=${encodeURIComponent(url)}&download_media=true&trim=true` : `/v1/instagram/post?url=${encodeURIComponent(url)}&download_media=true&trim=true`;
  const r = await fetchFn(`https://api.scrapecreators.com${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new AssistantError("link_fetch_failed", `The link could not be read (${r.status})`, 502);
  const body: any = await r.json().catch(() => null);
  const media = findMediaUrl(body);
  if (!media) throw new AssistantError("link_no_media", "No video was found at that link");
  const dl = await fetchFn(media, { signal: AbortSignal.timeout(300_000) });
  if (!dl.ok) throw new AssistantError("link_fetch_failed", `The video could not be downloaded (${dl.status})`, 502);
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (!bytes.length) throw new AssistantError("link_no_media", "The video was empty");
  if (bytes.length > LINK_LIMIT) throw new AssistantError("link_too_large", "That video is over 512 MB");
  const limit = await checkUpload(sb, u, bytes.length);
  if (limit) throw new AssistantError(limit.code, limit.message, limit.status);
  const id = randomUUID(), objectKey = `${u}/${id}.mp4`;
  const dir = await mkdtemp(join(tmpdir(), "studio-link-"));
  try {
    const file = join(dir, "v.mp4"), still = join(dir, "v.jpg");
    await writeFile(file, bytes);
    const seconds = await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 0);
    let poster = false; try { await (deps.poster ?? makePoster)(file, still); poster = true; } catch { poster = false; }
    const up = await sb.storage.from("studio-uploads").upload(objectKey, bytes, { contentType: "video/mp4", upsert: false });
    if (up.error) throw up.error;
    let posterKey: string | undefined;
    if (poster) { const jpg = await readFile(still).catch(() => null); if (jpg) { const p = await sb.storage.from("studio-outputs").upload(`${u}/assets/${id}.jpg`, jpg, { contentType: "image/jpeg", upsert: true }); if (!p.error) posterKey = `${u}/assets/${id}.jpg`; } }
    const title = String(body?.title ?? body?.desc ?? body?.caption?.text ?? body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const name = `${title || (platform === "tiktok" ? "TikTok video" : "Instagram video")}.mp4`;
    const ins = await sb.from("studio_assets").insert({ id, user_id: u, kind: "video", name, object_key: objectKey, bytes: bytes.length, status: "ready", probe: { duration: seconds || undefined, poster_key: posterKey, source_url: url, source: platform } });
    if (ins.error) throw ins.error;
    return { asset_id: id, name, kind: "video", seconds: seconds || null };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// A turn: the person's message in, the assistant's reply (and maybe a priced plan) out.
// ---------------------------------------------------------------------------------------------------
function modelMessages(msgs: Message[]): any[] {
  const out: any[] = [];
  for (const m of msgs.slice(-MAX_MESSAGES)) {
    if (m.role === "user") {
      const parts = [m.text.trim()];
      for (const a of m.attachments ?? []) parts.push(`[Attached: "${a.name}" (${a.kind}${a.seconds ? `, ${Math.round(a.seconds)} s` : ""}) id ${a.asset_id}]`);
      for (const l of m.links ?? []) parts.push(`[Link: ${l}]`);
      out.push({ role: "user", content: parts.filter(Boolean).join("\n") || "(no text)" });
    } else out.push({ role: "assistant", content: m.text || "(plan proposed)" });
  }
  // Claude needs alternating roles starting with user; merge any run of same-role messages.
  const merged: any[] = [];
  for (const m of out) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += `\n\n${m.content}`; else merged.push({ ...m }); }
  if (merged[0]?.role !== "user") merged.unshift({ role: "user", content: "(conversation start)" });
  return merged;
}

export async function runTurn(sb: SupabaseClient, deps: AssistantDeps, convo: Conversation, input: { text: string; attachments: Attachment[]; links: string[] }): Promise<Conversation> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined);
  const now = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const user: Message = { id: randomUUID(), role: "user", text: input.text.slice(0, 4000), attachments: input.attachments, links: input.links, at: now() };
  convo.messages = [...convo.messages, user];
  if (convo.title === "New chat" && input.text.trim()) convo.title = input.text.trim().replace(/\s+/g, " ").slice(0, 60);
  const [{ user: ku, assets }, styles] = await Promise.all([userContext(sb, convo.user_id), (deps.styles ?? fetchStyles)(env).catch(() => [] as StudioStyle[])]);
  const tools = toolsEnabled(env);
  const ctx: Ctx = { sb, u: convo.user_id, env, assets: new Map(assets.map((a) => [String(a.id).toLowerCase(), a])), styles, deps, tools };
  const system = buildSystemPrompt({ tools, costs: costsFor(env), plans: PLANS, env, styles, user: ku });
  const messages = modelMessages(convo.messages);
  let plan: Plan | null = null;
  let text = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await claude(deps, { system, tools: TOOLS, messages });
    const blocks: any[] = Array.isArray(reply?.content) ? reply.content : [];
    text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n").trim() || text;
    const uses = blocks.filter((b) => b.type === "tool_use");
    if (!uses.length || reply.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: blocks });
    const results: any[] = [];
    for (const use of uses) {
      let result: any;
      try {
        if (use.name === "propose_plan") { plan = await pricePlan(ctx, use.input); result = { ok: true, plan: { title: plan.title, total_credits: plan.total_credits, estimate: plan.estimate, balance: ku.balance, warnings: plan.warnings, steps: plan.steps.map((s) => ({ index: s.index, tool: s.tool, label: s.label, credits: s.credits, estimate: s.estimate, summary: s.summary })) } }; }
        else if (use.name === "fetch_link") {
          const a = await importLink(sb, deps, convo.user_id, String(use.input?.url ?? ""));
          ctx.assets.set(a.asset_id, { id: a.asset_id, kind: "video", name: a.name, probe: { duration: a.seconds }, object_key: `${convo.user_id}/${a.asset_id}.mp4` });
          user.attachments = [...(user.attachments ?? []), a];
          result = { ok: true, asset: a };
        } else result = { ok: false, error: "unknown_tool" };
      } catch (e: any) {
        const code = e instanceof AssistantError || e instanceof StudioError || e instanceof InstrumentError ? e.code : "tool_failed";
        result = { ok: false, error: code, detail: String(e?.message ?? e).slice(0, 300) };
        log(`[assistant] tool ${use.name} ${code}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }
  if (!text) text = plan ? `Here is the plan: ${plan.title}, ${plan.total_credits} credits in ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}. Confirm it in the card to start.` : "I did not get that. Could you say it another way?";
  const assistant: Message = { id: randomUUID(), role: "assistant", text, plan_id: plan?.id ?? null, at: now() };
  convo.messages = [...convo.messages, assistant];
  if (plan) { if (convo.plan && convo.plan.status === "proposed") convo.plan.status = "superseded"; convo.plan = plan; convo.title = plan.title; }
  convo.updated_at = now();
  const w = await sb.from("studio_conversations").update({ title: convo.title, messages: convo.messages, plan: convo.plan, updated_at: convo.updated_at }).eq("id", convo.id).eq("user_id", convo.user_id);
  if (w.error) throw w.error;
  return convo;
}

// ---------------------------------------------------------------------------------------------------
// Runs: one job per step, in dependency order; outputs promoted into the library for the next step.
// ---------------------------------------------------------------------------------------------------
export function startRun(convo: Conversation): Run {
  if (!convo.plan || convo.plan.status !== "proposed") throw new AssistantError("no_plan", "There is no plan to confirm", 409);
  if (convo.run && convo.run.status === "running") throw new AssistantError("run_active", "A run is already in progress", 409);
  convo.plan.status = "confirmed";
  const run: Run = { plan_id: convo.plan.id, status: "running", started_at: new Date().toISOString(), steps: convo.plan.steps.map((s) => ({ index: s.index, job_id: null, asset_id: null, status: "waiting" })) };
  convo.run = run; convo.status = "running";
  return run;
}

const refsOf = (s: PlanStep): number[] => {
  const out: number[] = [];
  const add = (v: unknown) => { const m = String(v ?? "").match(REF_RE); if (m) out.push(Number(m[1])); };
  add(s.source); add(s.options?.character_asset_id);
  if (s.tool === "instrument") for (const v of Object.values(s.options?.inputs ?? {})) ([] as any[]).concat(v).forEach(add);
  return [...new Set(out)];
};

/** Copies a finished job's first output into the library as a ready asset, so a later step can use it. */
export async function promoteOutput(sb: SupabaseClient, deps: AssistantDeps, u: string, job: any, label: string): Promise<string> {
  const out = (job.outputs ?? [])[0];
  if (!out?.key) throw new AssistantError("promote_failed", "The step finished without a file");
  const isImage = out.kind === "image" || /\.(jpe?g|png)$/i.test(out.key);
  const dl = await sb.storage.from("studio-outputs").download(out.key);
  if (dl.error || !dl.data) throw dl.error ?? new AssistantError("promote_failed", "The output could not be read");
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const id = randomUUID(), objectKey = `${u}/${id}.${isImage ? "jpg" : "mp4"}`;
  const up = await sb.storage.from("studio-uploads").upload(objectKey, bytes, { contentType: isImage ? "image/jpeg" : "video/mp4", upsert: false });
  if (up.error) throw up.error;
  let seconds = Number(out.duration) || 0, posterKey: string | undefined;
  if (!isImage && !seconds) {
    const dir = await mkdtemp(join(tmpdir(), "studio-promote-"));
    try { const f = join(dir, "v.mp4"); await writeFile(f, bytes); seconds = await (deps.probeSeconds ?? probeSeconds)(f).catch(() => 0); } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  }
  const posterSrc = out.poster_key ?? (isImage ? out.key : null);
  if (posterSrc) { const p = await sb.storage.from("studio-outputs").download(posterSrc); if (!p.error && p.data) { const pb = Buffer.from(await p.data.arrayBuffer()); const pu = await sb.storage.from("studio-outputs").upload(`${u}/assets/${id}.jpg`, pb, { contentType: "image/jpeg", upsert: true }); if (!pu.error) posterKey = `${u}/assets/${id}.jpg`; } }
  const name = `${label.replace(/[^\w .()-]+/g, " ").trim().slice(0, 50) || "Step"} · result.${isImage ? "jpg" : "mp4"}`;
  const ins = await sb.from("studio_assets").insert({ id, user_id: u, kind: isImage ? "image" : "video", name, object_key: objectKey, bytes: bytes.length, status: "ready", probe: { duration: seconds || undefined, poster_key: posterKey, derived_from_job: job.id, character: job.tool === "character" || undefined, prompt: job.tool === "character" ? job.options?.prompt : undefined } });
  if (ins.error) throw ins.error;
  return id;
}

/** One pass over a running conversation: start what can start, finish what finished. */
export async function advanceRun(sb: SupabaseClient, deps: AssistantDeps, convo: Conversation): Promise<Conversation> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined);
  const run = convo.run, plan = convo.plan;
  if (!run || !plan || run.status !== "running") return convo;
  // Two advancers (the confirm route and the loop) must not both create a step's job: a compare-and-swap on updated_at
  // lets exactly one proceed; the other hands back the row as it stands.
  const stamp = new Date().toISOString();
  const claim = await sb.from("studio_conversations").update({ updated_at: stamp }).eq("id", convo.id).eq("updated_at", convo.updated_at).select("id");
  if (claim.error) throw claim.error;
  if (!(claim.data ?? []).length) { const fresh = await sb.from("studio_conversations").select("*").eq("id", convo.id).maybeSingle(); return (fresh.data as Conversation) ?? convo; }
  convo.updated_at = stamp;
  const ids = run.steps.map((s) => s.job_id).filter(Boolean) as string[];
  const jobs = new Map<string, any>();
  if (ids.length) { const r = await sb.from("studio_jobs").select("id,tool,status,options,outputs,error_code,progress").in("id", ids).eq("user_id", convo.user_id); if (r.error) throw r.error; for (const j of r.data ?? []) jobs.set(j.id, j); }
  const say = (text: string) => { convo.messages = [...convo.messages, { id: randomUUID(), role: "assistant", text, at: new Date().toISOString() }]; };
  const finish = (status: Run["status"], note: string) => { run.status = status; run.finished_at = new Date().toISOString(); run.note = note; convo.status = status; for (const s of run.steps) if (s.status === "waiting") s.status = "skipped"; say(note); };
  try {
    // 1. Steps with jobs: reflect their state; promote finished outputs when a later step needs them.
    for (const st of run.steps) {
      if (!st.job_id) continue;
      const j = jobs.get(st.job_id); if (!j) continue;
      if (j.status === "done" && st.status !== "done") {
        const needed = run.steps.some((o) => o.status === "waiting" && refsOf(plan.steps[o.index - 1]).includes(st.index));
        if (needed && !st.asset_id) st.asset_id = await promoteOutput(sb, deps, convo.user_id, j, plan.steps[st.index - 1].label);
        st.status = "done";
      } else if ((j.status === "failed" || j.status === "canceled") && st.status !== j.status) {
        st.status = j.status; st.error_code = j.error_code ?? null;
        finish(j.status === "failed" ? "failed" : "canceled", j.status === "failed" ? `Step ${st.index} (${plan.steps[st.index - 1].label}) failed: ${j.error_code ?? "unknown"}. Its credits were refunded and the later steps did not run.` : `Step ${st.index} was canceled, so the later steps did not run.`);
        break;
      } else if (j.status === "running" || j.status === "queued") st.status = j.status;
    }
    // 2. Waiting steps whose references are all promoted: create their jobs.
    if (run.status === "running") {
      const costs = costsFor(env);
      for (const st of run.steps) {
        if (st.status !== "waiting") continue;
        const ps = plan.steps[st.index - 1];
        const deps_ = refsOf(ps);
        if (!deps_.every((k) => run.steps[k - 1]?.status === "done" && run.steps[k - 1]?.asset_id)) continue;
        const resolve = (v: unknown): string => { const m = String(v ?? "").match(REF_RE); return m ? run.steps[Number(m[1]) - 1].asset_id! : String(v); };
        const o = { ...ps.options };
        let assetId: string | null = ps.source ? resolve(ps.source) : null;
        if (o.character_asset_id && REF_RE.test(String(o.character_asset_id))) o.character_asset_id = resolve(o.character_asset_id);
        if (ps.tool === "instrument" && o.inputs) o.inputs = Object.fromEntries(Object.entries(o.inputs).map(([k, v]) => [k, Array.isArray(v) ? v.map(resolve) : resolve(v)]));
        let credits = ps.credits, options: Record<string, any> = o;
        if (ps.tool === "instrument") {
          const q = await quoteInstrument({ env, fetch: deps.fetch }, PLANS, { endpoint: o.endpoint, params: o.params ?? {}, inputs: o.inputs ?? {} }, async (ids2) => {
            const r = await sb.from("studio_assets").select("id,kind,object_key,probe,status").eq("user_id", convo.user_id).in("id", ids2);
            const map = new Map<string, { url: string; kind: string; seconds: number | null }>();
            for (const a of (r.data ?? []) as any[]) { if (a.status !== "ready") continue; const s = await sb.storage.from("studio-uploads").createSignedUrl(a.object_key, 600); if (s.data) map.set(a.id, { url: s.data.signedUrl, kind: a.kind, seconds: Number(a.probe?.duration) > 0 ? Number(a.probe.duration) : null }); }
            return map;
          });
          credits = q.credits; options = q.options; assetId = null;
        } else if (ps.tool !== "character") {
          const a = assetId ? await sb.from("studio_assets").select("id,kind,status,probe").eq("id", assetId).eq("user_id", convo.user_id).maybeSingle() : { data: null, error: null };
          if (a.error) throw a.error;
          const q = quote(ps.tool, o, a.data ? { kind: a.data.kind, probe: a.data.probe } : null, costs);
          credits = q.credits; options = q.options;
        }
        const limit = await checkJobRate(sb, convo.user_id);
        if (limit) { if (limit.code === "rate_limited") continue; throw new AssistantError(limit.code, limit.message, limit.status); }
        const r = await sb.rpc("studio_create_job", { p_user: convo.user_id, p_tool: ps.tool, p_asset: assetId, p_options: options, p_credits: credits });
        if (r.error) {
          const msg = String(r.error.message ?? r.error);
          if (/too_many_jobs/.test(msg)) continue; // a slot frees up later
          if (/insufficient_credits/.test(msg)) { finish("failed", `Step ${st.index} needs ${credits} credits and the balance is short. Add credits and ask me to run it again.`); break; }
          throw r.error;
        }
        st.job_id = r.data.id; st.status = "queued";
        log(`[assistant] step ${st.index} job ${r.data.id} ${ps.tool} ${credits}`);
      }
    }
    if (run.status === "running" && run.steps.every((s) => s.status === "done")) finish("done", `All ${run.steps.length === 1 ? "done" : `${run.steps.length} steps are done`}. The results are in the cards above and in your library.`);
  } catch (e: any) {
    const code = e instanceof AssistantError || e instanceof StudioError ? e.code : "run_failed";
    log(`[assistant] run ${convo.id} ${code}: ${String(e?.message ?? e).slice(0, 200)}`);
    finish("failed", `The run stopped: ${code}. Any reserved credits were refunded.`);
  }
  convo.updated_at = new Date().toISOString();
  const w = await sb.from("studio_conversations").update({ status: convo.status, messages: convo.messages, plan: convo.plan, run: convo.run, updated_at: convo.updated_at }).eq("id", convo.id);
  if (w.error) throw w.error;
  return convo;
}

export function startAssistantLoop(sbFn: () => SupabaseClient, deps: AssistantDeps = {}, intervalMs = 10_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!toolsEnabled(env).assistant) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_conversations").select("*").eq("status", "running").order("updated_at", { ascending: true }).limit(20);
      if (r.error) throw r.error;
      for (const c of (r.data ?? []) as Conversation[]) await advanceRun(sb, { ...deps, log }, c).catch((e) => log(`[assistant] advance ${c.id} ${String(e?.message ?? e).slice(0, 200)}`));
    } catch (e: any) { log(`[assistant] loop ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { busy = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 9_000);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
async function hydrateJobs(sb: SupabaseClient, u: string, ids: string[]) {
  if (!ids.length) return [];
  const r = await sb.from("studio_jobs").select("id,tool,status,asset_id,options,credits_reserved,credits_charged,progress,outputs,error_code,created_at,started_at,finished_at").in("id", ids).eq("user_id", u);
  if (r.error) throw r.error;
  const jobs = await withAssetNames(sb, u, (r.data ?? []).map(publicJob));
  for (const j of jobs) {
    if (j.status !== "done" || !j.outputs.length) continue;
    const posters = j.outputs.map((o: any) => o.poster_key).filter(Boolean);
    const signed = posters.length ? await sb.storage.from("studio-outputs").createSignedUrls(posters, 900) : { data: [], error: null };
    const urls = new Map(((signed.data ?? []) as any[]).map((s) => [s.path, s.signedUrl]));
    const base = downloadBase(j.asset_name, j.tool);
    const files = await Promise.all(j.outputs.map((o: any, i: number) => sb.storage.from("studio-outputs").createSignedUrl(o.key, 900, { download: `${base}-${String(o.index ?? i + 1).padStart(2, "0")}.${String(o.key).split(".").pop()}` })));
    j.outputs = j.outputs.map((o: any, i: number) => ({ ...o, url: files[i].data?.signedUrl ?? null, poster_url: o.poster_key ? urls.get(o.poster_key) ?? null : null }));
  }
  return jobs;
}
const publicConversation = (c: any, jobs: any[] = []) => ({ id: c.id, title: c.title, status: c.status, messages: c.messages ?? [], plan: c.plan ?? null, run: c.run ?? null, jobs, created_at: c.created_at, updated_at: c.updated_at });

export function registerAssistant(app: Express, sbFn: () => SupabaseClient, deps: AssistantDeps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof AssistantError || e instanceof StudioError || e instanceof InstrumentError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "assistant_unavailable", detail: "The assistant migration has not been applied" });
    console.error("[assistant]", msg);
    res.status(500).json({ error: "assistant_failed", detail: msg.slice(0, 200) });
  };
  const load = async (sb: SupabaseClient, u: string, id: string): Promise<Conversation> => {
    if (!UUID_RE.test(id)) throw new AssistantError("conversation_not_found", "No such conversation", 404);
    const r = await sb.from("studio_conversations").select("*").eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new AssistantError("conversation_not_found", "No such conversation", 404);
    return r.data as Conversation;
  };
  const respond = async (sb: SupabaseClient, u: string, c: Conversation, res: Response, status = 200) => {
    const ids = (c.run?.steps ?? []).map((s) => s.job_id).filter(Boolean) as string[];
    res.status(status).json({ conversation: publicConversation(c, await hydrateJobs(sb, u, ids)), assistant: toolsEnabled(env).assistant });
  };

  app.get("/api/studio/assistant/conversations", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_conversations").select("id,title,status,created_at,updated_at").eq("user_id", u).order("updated_at", { ascending: false }).limit(30);
      if (r.error) throw r.error;
      res.json({ conversations: r.data ?? [], assistant: toolsEnabled(env).assistant });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_conversations").insert({ user_id: u }).select("*").single();
      if (r.error) throw r.error;
      res.status(201).json({ conversation: publicConversation(r.data), assistant: toolsEnabled(env).assistant });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/studio/assistant/conversations/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { const sb = sbFn(); await respond(sb, u, await load(sb, u, req.params.id), res); } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/messages", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!toolsEnabled(env).assistant) throw new AssistantError("assistant_unavailable", "The assistant is not switched on", 503);
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      const text = String(req.body?.text ?? "").trim();
      const ids: string[] = Array.isArray(req.body?.attachments) ? req.body.attachments.map(String).filter((x: string) => UUID_RE.test(x)).slice(0, 20) : [];
      const links: string[] = Array.isArray(req.body?.links) ? req.body.links.map(String).filter((x: string) => /^https?:\/\//.test(x)).slice(0, 5) : [];
      if (!text && !ids.length && !links.length) throw new AssistantError("message_empty", "Say something, attach a file or paste a link");
      let attachments: Attachment[] = [];
      if (ids.length) {
        const a = await sb.from("studio_assets").select("id,kind,name,probe,status").eq("user_id", u).in("id", ids);
        if (a.error) throw a.error;
        attachments = ((a.data ?? []) as any[]).filter((x) => x.status === "ready").map((x) => ({ asset_id: x.id, name: x.name, kind: x.kind, seconds: Number(x.probe?.duration) > 0 ? Number(x.probe.duration) : null }));
      }
      const out = await runTurn(sb, { ...deps, env, log }, c, { text, attachments, links });
      await respond(sb, u, out, res);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/confirm", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      if (req.body?.plan_id && c.plan?.id !== req.body.plan_id) throw new AssistantError("plan_stale", "That plan was replaced; confirm the latest one", 409);
      startRun(c);
      c.updated_at = new Date().toISOString();
      const w = await sb.from("studio_conversations").update({ status: c.status, plan: c.plan, run: c.run, updated_at: c.updated_at }).eq("id", c.id).eq("user_id", u);
      if (w.error) throw w.error;
      const out = await advanceRun(sb, { ...deps, env, log }, c);
      await respond(sb, u, out, res);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/cancel", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      if (c.run && c.run.status === "running") {
        for (const s of c.run.steps) {
          if (s.status === "queued" && s.job_id) { const c2 = await sb.rpc("studio_cancel", { p_user: u, p_job: s.job_id }); if (c2.error) log(`[assistant] cancel ${s.job_id} ${c2.error.message}`); s.status = "canceled"; }
          else if (s.status === "waiting") s.status = "skipped";
        }
        c.run.status = "canceled"; c.run.finished_at = new Date().toISOString(); c.status = "canceled";
        c.messages = [...c.messages, { id: randomUUID(), role: "assistant", text: "Stopped. Queued steps were canceled and refunded; anything already rendering finishes on its own.", at: new Date().toISOString() }];
      } else if (c.plan && c.plan.status === "proposed") { c.plan.status = "superseded"; }
      const w = await sb.from("studio_conversations").update({ status: c.status, plan: c.plan, run: c.run, messages: c.messages, updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", u);
      if (w.error) throw w.error;
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });
}
