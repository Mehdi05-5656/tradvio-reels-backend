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
import { getSocialProvider } from "./social-provider.js";
import { createPosts, socialSnapshot } from "./studio-social.js";
import { performanceForChat } from "./studio-insights.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANS, quote, StudioError, fetchStyles, toolsEnabled, costsFor, publicJob, withAssetNames, withPosterUrls, downloadBase, type StudioStyle } from "./studio.js";
import { buildSystemPrompt, PRESET_CHARACTERS, type KnowledgeUser } from "./studio-knowledge.js";
import { quoteInstrument, instrumentById, tableUsd, instrumentCredits, InstrumentError, inputAssetIds } from "./studio-instruments.js";
import { trendById } from "./studio-trends.js";
import { probeSeconds, makePoster } from "./studio-recast.js";
import { checkUpload, checkJobRate } from "./studio-limits.js";
import { youtubeId } from "./studio-youtube.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^\$(\d{1,2})$/;
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 5, MAX_MESSAGES = 60, LINK_LIMIT = 536_870_912;

export class AssistantError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

export type Attachment = { asset_id: string; name: string; kind: string; seconds: number | null };
/** A choice card: faces the assistant offers to generate so the person can pick one (or upload their own instead). */
export type ChoiceOption = { asset_id: string; name: string; poster_key?: string | null; object_key?: string | null; url?: string | null };
export type Choice = { id: string; kind: "characters"; prompt: string; mode: "human" | "animal"; count: number; credits: number; auto_credits: number; status: "offered" | "generating" | "ready" | "picked" | "failed"; auto?: boolean; job_id?: string | null; options?: ChoiceOption[]; existing?: ChoiceOption[]; picked?: string | null; error_code?: string | null };
/** A request card: the assistant needs a video (or picture) and asks for it with a drop zone, a link field and the library. */
export type RequestCard = { id: string; kind: "video" | "image"; reason: string; status: "open" | "done" };
/** Made characters worth offering for a described one: those sharing a word with the ask ("cat" for "a friendly tabby
 *  cat") come alone when any match; otherwise every character of that kind (human or animal), newest first, up to four. */
const CHARACTER_STOPWORDS = new Set(["the", "and", "with", "for", "from", "into", "that", "this", "his", "her", "its", "their", "who", "like", "look", "looking", "facing", "camera", "friendly", "natural", "realistic", "photo", "portrait", "character", "person", "wearing", "style", "front", "shot", "head", "face", "cute", "nice", "cool", "young", "old", "big", "small", "little", "made", "same", "one"]);
export function matchingCharacters<T extends { kind: string; name?: string; probe?: any }>(assets: T[], prompt: string, mode: "human" | "animal"): T[] {
  const pool = assets.filter((a) => a.kind === "image" && a.probe?.character && (a.probe?.mode ?? "human") === mode);
  const words = String(prompt ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !CHARACTER_STOPWORDS.has(w));
  const score = (a: T) => { const hay = new Set(`${a.name ?? ""} ${a.probe?.prompt ?? ""}`.toLowerCase().split(/[^a-z]+/)); return words.reduce((n, w) => n + (hay.has(w) || hay.has(w + "s") || (w.endsWith("s") && hay.has(w.slice(0, -1))) ? 1 : 0), 0); };
  const scored = pool.map((a) => ({ a, s: score(a) }));
  const hits = scored.filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.a);
  return (hits.length ? hits : pool).slice(0, 4);
}
/** A voice card: a few voices that fit a description, each with a sample to play; the pick names the voice. */
export type VoiceCard = { id: string; description: string; voices: Array<{ id: string; name: string; labels: Record<string, string>; preview_url: string | null }>; picked?: string | null; status: "open" | "done" };
/** A people card: the faces found in a clip, for the person to say who gets swapped (all that apply). */
export type PeopleCard = { id: string; asset_id: string; asset_name: string; reason: string; people: Array<{ index: number; label: string; url?: string | null; key?: string | null }>; status: "open" | "done" };
/** A publish card: videos to post on the person's own linked networks, now or on a schedule. Nothing is posted until they
 *  press Post or Schedule on it; with nothing linked it walks them through linking and picks up again when they are back. */
export type PublishItem = { job_id?: string | null; output_key?: string | null; asset_id?: string | null; poster_key?: string | null; url?: string | null };
export type PublishCard = {
  id: string; items: PublishItem[]; status: "open" | "sent" | "ignored"; auto?: boolean;
  suggested?: { action?: "now" | "schedule" | null; schedule_at?: string | null; platforms?: string[]; caption?: string | null; note?: string | null };
  /** networks already acknowledged in this chat, so a new link is announced once */
  linked_seen?: string[]; post_ids?: string[]; outcome?: string | null;
};
export type Message = { id: string; role: "user" | "assistant"; text: string; attachments?: Attachment[]; links?: string[]; plan_id?: string | null; at: string; interrupted?: boolean; choice?: Choice | null; request?: RequestCard | null; people?: PeopleCard | null; voices?: VoiceCard | null; publish?: PublishCard | null; context?: string | null };
export type OutputKind = "video" | "image" | "audio" | "text";
export type PlanStep = { index: number; tool: string; label: string; source: string | null; options: Record<string, any>; credits: number; estimate: boolean; output: OutputKind; seconds: number | null; summary: string };
export type Plan = { id: string; title: string; steps: PlanStep[]; total_credits: number; estimate: boolean; status: "proposed" | "confirmed" | "superseded"; created_at: string; warnings: string[] };
export type RunStep = { index: number; job_id: string | null; asset_id: string | null; status: "waiting" | "queued" | "running" | "done" | "failed" | "canceled" | "skipped"; error_code?: string | null };
export type Run = { plan_id: string; status: "running" | "done" | "failed" | "canceled"; steps: RunStep[]; started_at: string; finished_at?: string | null; note?: string | null };
export type Conversation = { id: string; user_id: string; title: string; status: string; messages: Message[]; plan: Plan | null; run: Run | null; summary?: string | null; summary_through?: number; automation_id?: string | null; created_at: string; updated_at: string };
/** What a streaming turn reports while it works: a new round of model text, a text delta, or a status line for a tool. */
export type TurnEvent = { type: "round" } | { type: "delta"; text: string } | { type: "status"; text: string };
export type MemoryNote = { id: string; note: string; created_at: string };

export type AssistantDeps = {
  fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: () => number;
  /** Fetches a YouTube video to a file (yt-dlp in production; tests inject one). */
  download?: (url: string, target: string, o: { maxBytes: number; maxSeconds: number }) => Promise<{ title: string | null }>;
  /** Aborted when the person stops a reply or leaves; the model request is cut and the partial text is kept. */
  signal?: AbortSignal;
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
              source: { type: ["string", "null"], description: "Video (or picture) asset id, or \"$N\". For a trend: null for a catalog trend (trend_id), or the video asset of a trend the person brought (a fetched link or an upload). Null for character and text-only instruments." },
              options: {
                type: "object", additionalProperties: true,
                description: "blueprint: {copies}. recast/swap: {model: light|full, character: preset id, or character_asset_id: library image id or \"$N\" of a character step; swap also takes prompt}. For several people, each with their own character, give cast instead: [{character or character_asset_id, label}] in left-to-right order, labels from choose_people. restyle: {style_name or style_id, prompt?}. trend: {trend_id (catalog) or a video source, trend_name?, model, character or character_asset_id, or cast as above}. character: {mode: human|animal, prompt}. instrument: {endpoint, params: {...}, inputs: {media_field: asset id or [ids] or \"$N\"}}.",
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
    description: "Fetch a TikTok, Instagram or YouTube (video or Short) link into the person's library so it can be used as a source. Returns the new asset (id, name, seconds). If it fails with link_blocked, YouTube refused our servers: ask for the file.",
    input_schema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "request_video",
    description: "Ask for the video (or picture) the person means, with a card that takes a dropped file, a pasted TikTok, Instagram or YouTube link, or a pick from their library. Use it whenever they refer to a video they have not attached (\"this\", \"it\", \"my video\") and you cannot be sure which file they mean. Never guess a library file for them.",
    input_schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["video", "image"] }, reason: { type: "string", description: "One short line: what it is for" } }, required: ["kind", "reason"] },
  },
  {
    name: "choose_people",
    description: "When a swap or recast is wanted on a clip with more than one person, show the faces found in it so the person can tick who changes (all that apply, or everyone). Use the asset id of that clip. Wait for their answer; it arrives as a message naming the chosen people, which you then pass as options.targets (the labels) in propose_plan.",
    input_schema: { type: "object", additionalProperties: false, properties: { asset_id: { type: "string" }, reason: { type: "string", description: "One short line" } }, required: ["asset_id", "reason"] },
  },
  {
    name: "preview_voices",
    description: "Show four voices that fit a description (age, gender, accent, mood), each with a sample the person can play. Their pick arrives as a message naming the voice and its id; use that id as voice_id in a voice over, voice change or dubbing instrument step. Only when the person asked for a voice.",
    input_schema: { type: "object", additionalProperties: false, properties: { description: { type: "string", description: "The voice in plain words" } }, required: ["description"] },
  },
  {
    name: "preview_characters",
    description: "Offer the person four portrait options of a character they described, to pick a face before a swap, recast or trend. Nothing is generated until they press the button on the card (it costs a few credits); they can upload their own photo instead. Call it once per description, then wait for their pick, which arrives as an attached image.",
    input_schema: { type: "object", additionalProperties: false, properties: { prompt: { type: "string", description: "The character in plain words, under 300 characters" }, mode: { type: "string", enum: ["human", "animal"] } }, required: ["prompt", "mode"] },
  },
  {
    name: "offer_post",
    description: "Show the posting card for videos the person wants on their own socials: their linked networks to tick, a caption (the card can write one from the video, or they type theirs), Post now or Schedule with a date and time, and Ignore. Use it when they ask to post, publish, upload or schedule a video, and when they say yes to posting a result. Nothing is posted until they press Post or Schedule on the card; never say something was posted or scheduled before the card reports it. With nothing linked the card asks them to connect first; you will be told when they have.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["videos"],
      properties: {
        videos: { type: "array", minItems: 1, maxItems: 25, items: { type: "string" }, description: "\"latest\" for this chat's newest finished videos, a job id from this chat's results, or a library video asset id" },
        action: { type: "string", enum: ["now", "schedule"], description: "What they asked for, when they said" },
        schedule_at: { type: "string", description: "ISO 8601 with offset, only when they gave an exact day and time" },
        platforms: { type: "array", items: { type: "string", enum: ["tiktok", "instagram", "youtube", "facebook", "linkedin", "threads", "bluesky", "twitter"] }, description: "Networks they named; leave out to let them tick" },
        caption: { type: "string", description: "Only the exact caption text they gave you" },
        note: { type: "string", description: "Their wishes for the caption (tone, a call to action, a product name), for the caption writer" },
      },
    },
  },
  {
    name: "save_automation",
    description: "Save this chat's confirmed plan as an automation: the same steps and settings with the source video as an open input, so the person can run it again from the Automations page by dropping a new file. Only after a plan was confirmed in this chat.",
    input_schema: { type: "object", additionalProperties: false, properties: { name: { type: "string", description: "Three to six words" } }, required: ["name"] },
  },
  {
    name: "remember",
    description: "Keep one short, durable note about this person for later chats: a standing preference, a fact about their brand, accounts or audience, a character they reuse. Only when they state it. Never a one-off request, a file id or anything sensitive. They can read and delete every note.",
    input_schema: { type: "object", additionalProperties: false, properties: { note: { type: "string", description: "One plain sentence, under 240 characters" } }, required: ["note"] },
  },
];
export const MEMORY_LIMIT = 30;

/** Reads Anthropic's server-sent event stream into the same shape as a plain reply, handing text deltas out as they come. */
export async function readAnthropicStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void, signal?: AbortSignal): Promise<{ content: any[]; stop_reason: string | null }> {
  const reader = body.getReader(), dec = new TextDecoder();
  const blocks: any[] = [], partial: Record<number, string> = {};
  let buf = "", stop: string | null = null;
  const handle = (evt: string, data: any) => {
    if (evt === "content_block_start") {
      const b = data.content_block ?? {};
      blocks[data.index] = b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: {} } : { type: "text", text: String(b.text ?? "") };
      if (b.type === "tool_use") partial[data.index] = "";
    } else if (evt === "content_block_delta") {
      const b = blocks[data.index]; if (!b) return;
      if (data.delta?.type === "text_delta") { b.text += data.delta.text; if (data.delta.text) onText(data.delta.text); }
      else if (data.delta?.type === "input_json_delta") partial[data.index] = (partial[data.index] ?? "") + String(data.delta.partial_json ?? "");
    } else if (evt === "content_block_stop") {
      const b = blocks[data.index];
      if (b?.type === "tool_use") { try { b.input = partial[data.index] ? JSON.parse(partial[data.index]) : {}; } catch { b.input = {}; } }
    } else if (evt === "message_delta") stop = data.delta?.stop_reason ?? stop;
    else if (evt === "error") throw new AssistantError("assistant_unavailable", `Claude stream: ${data.error?.message ?? "error"}`, 503);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let evt = "", data = "";
      for (const line of chunk.split("\n")) { if (line.startsWith("event:")) evt = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
      if (data) handle(evt, JSON.parse(data));
      if (signal?.aborted) { await reader.cancel().catch(() => undefined); throw new AssistantError("aborted", "Stopped", 499); }
    }
  }
  // a streamed round that is only tool calls still opens an empty text block; the API refuses it back, so it is dropped
  return { content: blocks.filter((b) => b && !(b.type === "text" && !String(b.text).trim())), stop_reason: stop };
}

/** One Claude request. With onText the reply streams and each text delta is handed out; the result has the same shape either way. */
export async function claude(deps: AssistantDeps, body: Record<string, any>, onText?: (text: string) => void): Promise<any> {
  const env = deps.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new AssistantError("assistant_unavailable", "The assistant is not configured", 503);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  const stop = () => ctl.abort();
  if (deps.signal?.aborted) throw new AssistantError("aborted", "Stopped", 499);
  deps.signal?.addEventListener("abort", stop, { once: true });
  const aborted = () => new AssistantError("aborted", "Stopped", 499);
  try {
    const r = await (deps.fetch ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // no temperature: the current models reject the parameter ("deprecated for this model", seen live Oct 29 2026)
      body: JSON.stringify({ model: env.STUDIO_ASSISTANT_MODEL || DEFAULT_MODEL, max_tokens: 1400, stream: !!onText, ...body }),
    }).catch(() => { throw deps.signal?.aborted ? aborted() : new AssistantError("assistant_unavailable", "The assistant did not answer", 503); });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new AssistantError("assistant_unavailable", `Claude ${r.status}: ${text.slice(0, 200)}`, r.status === 429 || r.status >= 500 ? 503 : 502);
    }
    if (!onText) return r.json();
    if (!r.body) throw new AssistantError("assistant_unavailable", "Claude sent no stream", 503);
    return await readAnthropicStream(r.body, onText, ctl.signal).catch((e) => { if (deps.signal?.aborted) throw aborted(); throw e instanceof AssistantError ? e : new AssistantError("assistant_unavailable", "The reply broke off", 503); });
  } finally { clearTimeout(timer); deps.signal?.removeEventListener("abort", stop); }
}

// ---------------------------------------------------------------------------------------------------
// Knowledge for this person
// ---------------------------------------------------------------------------------------------------
async function userContext(sb: SupabaseClient, u: string): Promise<{ user: KnowledgeUser; assets: any[]; memory: MemoryNote[] }> {
  const [assets, cust, bal, jobs, mem] = await Promise.all([
    sb.from("studio_assets").select("id,kind,name,object_key,probe,status,bytes").eq("user_id", u).eq("status", "ready").order("created_at", { ascending: false }).limit(60),
    sb.from("studio_customers").select("plan_id,status,parallel_jobs").eq("user_id", u).maybeSingle(),
    sb.rpc("studio_balance", { p_user: u }),
    sb.from("studio_jobs").select("id,tool,status,options,asset_id,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(8),
    sb.from("studio_assistant_memory").select("id,note,created_at").eq("user_id", u).order("created_at", { ascending: true }).limit(MEMORY_LIMIT),
  ]);
  for (const r of [assets, cust, jobs]) if (r.error) throw r.error;
  // memory is optional: before its migration the table is missing and the assistant simply has no notes
  const memory = (mem.error ? [] : (mem.data ?? [])) as MemoryNote[];
  const list = (assets.data ?? []) as any[];
  const named = await withAssetNames(sb, u, (jobs.data ?? []) as any[]);
  return {
    assets: list, memory,
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
export type Ctx = { sb: SupabaseClient; u: string; env: Record<string, string | undefined>; assets: Map<string, any>; styles: StudioStyle[]; deps: AssistantDeps; tools: Record<string, boolean> };
/** Everything pricePlan needs for one person: their ready assets, the styles, the open tools. */
export async function buildCtx(sb: SupabaseClient, deps: AssistantDeps, u: string): Promise<Ctx> {
  const env = deps.env ?? process.env;
  const [assets, styles] = await Promise.all([
    sb.from("studio_assets").select("id,kind,name,object_key,probe,status").eq("user_id", u).eq("status", "ready").limit(400),
    (deps.styles ?? fetchStyles)(env).catch(() => [] as StudioStyle[]),
  ]);
  if (assets.error) throw assets.error;
  return { sb, u, env, assets: new Map(((assets.data ?? []) as any[]).map((a) => [String(a.id).toLowerCase(), a])), styles, deps, tools: toolsEnabled(env) };
}

export function expectedOutput(tool: string, options: any, sourceSeconds: number | null, instOutput?: OutputKind): { output: OutputKind; seconds: number | null } {
  if (tool === "character") return { output: "image", seconds: null };
  if (tool === "instrument") return { output: instOutput ?? "video", seconds: instOutput === "video" ? Number(options?.units ?? options?.params?.duration ?? sourceSeconds ?? 5) : null };
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
  const produced: Array<{ output: OutputKind; seconds: number | null }> = [];
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
    let credits = 0, estimate = false, summary = "", sourceStr: string | null = null, seconds: number | null = null, output: OutputKind = "video";

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
      const cast = resolveCast(ctx, o, i, resolveRef);
      const who = cast ? { opt: { cast: cast.members }, ref: cast.refs[0] ?? null } : resolveCharacter(ctx, o, i, resolveRef);
      let asset: any = null;
      if (st.source != null && st.source !== "") { const src = resolveRef(st.source, i, "video"); sourceStr = src.id ?? `$${src.ref}`; asset = src.id ? ctx.assets.get(src.id.toLowerCase()) : src.pseudo; if (src.ref) estimate = true; }
      const q = quote("trend", { trend_id: o.trend_id, trend_name: o.trend_name, model: o.model ?? "light", max_seconds: o.max_seconds, ...who.opt }, asset, costs);
      credits = q.credits; summary = q.summary; Object.assign(o, q.options, !cast && who.ref ? { character_asset_id: `$${who.ref}` } : {});
      if (cast) o.cast = cast.restore(o.cast);
      if (who.ref) estimate = true;
    } else {
      // blueprint, recast, swap, restyle: a video source, concrete or "$N"
      const src = resolveRef(st.source, i, "video");
      sourceStr = src.id ?? `$${src.ref}`;
      const asset = src.id ? ctx.assets.get(src.id.toLowerCase()) : src.pseudo;
      let extra: Record<string, any> = {}, whoRef: number | null = null;
      let cast: ReturnType<typeof resolveCast> = null;
      if (tool === "recast" || tool === "swap") {
        cast = resolveCast(ctx, o, i, resolveRef);
        const who = cast ? { opt: { cast: cast.members }, ref: cast.refs[0] ?? null } : resolveCharacter(ctx, o, i, resolveRef);
        extra = { ...who.opt, model: o.model ?? "light", prompt: o.prompt, max_seconds: o.max_seconds, targets: o.targets }; whoRef = cast ? null : who.ref; if (who.ref) estimate = true;
      }
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
      if (cast) o.cast = cast.restore(o.cast);
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
/** A character per person (2 to 8, left to right): each member resolved like a single character; "$N" members are
 *  quoted with a placeholder and put back after, so the run fills in the made character. */
function resolveCast(ctx: Ctx, o: any, i: number, resolveRef: (v: unknown, i: number, want: "video" | "image") => { id: string | null; ref: number | null }) {
  if (!Array.isArray(o.cast) || o.cast.length < 2) return null;
  if (o.cast.length > 8) throw new AssistantError("plan_invalid", `Step ${i}: up to 8 people can be cast`);
  const refs: number[] = [], refAt = new Map<number, number>();
  const members = o.cast.map((m: any, k: number) => {
    const r = resolveCharacter(ctx, m ?? {}, i, resolveRef);
    if (r.ref) { refs.push(r.ref); refAt.set(k, r.ref); }
    return { ...r.opt, label: typeof m?.label === "string" ? m.label : null };
  });
  return { members, refs, restore: (quoted: any[]) => (Array.isArray(quoted) ? quoted.map((m, k) => (refAt.has(k) ? { ...m, character: null, character_asset_id: `$${refAt.get(k)}` } : m)) : quoted) };
}
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
// Links: TikTok and Instagram through ScrapeCreators (download_media); YouTube through yt-dlp. Stored as a library asset.
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
/** The longest video a link may bring in, in seconds (uploads say 10 minutes; STUDIO_LINK_MAX_SECONDS raises it). */
export const linkMaxSeconds = (env: Record<string, string | undefined>) => Math.max(60, Number(env.STUDIO_LINK_MAX_SECONDS) || 600);
export async function importLink(sb: SupabaseClient, deps: AssistantDeps, u: string, url: string): Promise<Attachment> {
  const env = deps.env ?? process.env, fetchFn = deps.fetch ?? fetch;
  const platform = linkPlatform(url);
  if (!platform) throw new AssistantError("unsupported_link", "Only TikTok, Instagram and YouTube links can be fetched");
  const key = env.SCRAPECREATORS_API_KEY;
  if (!key) throw new AssistantError("link_fetch_failed", "Link fetching is not configured", 503);
  const dir = await mkdtemp(join(tmpdir(), "studio-link-"));
  try {
  let bytes: Buffer, body: any = null, ytTitle: string | null = null;
  const file = join(dir, "v.mp4"), still = join(dir, "v.jpg");
  if (platform === "youtube") {
    // metadata first (title, length) so an over-long video is refused before anything is downloaded
    const meta = await fetchFn(`https://api.scrapecreators.com/v1/youtube/video?url=${encodeURIComponent(url)}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    body = meta && meta.ok ? await meta.json().catch(() => null) : null;
    const ms = Number(body?.durationMs ?? body?.lengthSeconds * 1000);
    const maxSeconds = linkMaxSeconds(env);
    if (ms > 0 && ms / 1000 > maxSeconds) throw new AssistantError("link_too_long", `That video is ${Math.round(ms / 60000)} minutes by its listing (${String(body?.title ?? "").slice(0, 60) || "no title"}); links can be up to ${Math.round(maxSeconds / 60)} minutes`);
    try {
      const got = await (deps.download ?? ((a, b, o) => import("./studio-youtube.js").then((m) => m.downloadYouTube(a, b, { ...o, fetch: fetchFn, env }))))(url, file, { maxBytes: LINK_LIMIT, maxSeconds });
      ytTitle = got.title;
    } catch (e: any) {
      if (e && typeof e.code === "string" && /^link_/.test(e.code)) throw new AssistantError(e.code, e.message, e.code === "link_fetch_failed" ? 502 : 400);
      throw new AssistantError("link_fetch_failed", `The video could not be downloaded: ${String(e?.message ?? e).slice(0, 160)}`, 502);
    }
    bytes = await readFile(file);
  } else {
    const path = platform === "tiktok" ? `/v2/tiktok/video?url=${encodeURIComponent(url)}&download_media=true&trim=true` : `/v1/instagram/post?url=${encodeURIComponent(url)}&download_media=true&trim=true`;
    const r = await fetchFn(`https://api.scrapecreators.com${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new AssistantError("link_fetch_failed", `The link could not be read (${r.status})`, 502);
    body = await r.json().catch(() => null);
    const media = findMediaUrl(body);
    if (!media) throw new AssistantError("link_no_media", "No video was found at that link");
    const dl = await fetchFn(media, { signal: AbortSignal.timeout(300_000) });
    if (!dl.ok) throw new AssistantError("link_fetch_failed", `The video could not be downloaded (${dl.status})`, 502);
    bytes = Buffer.from(await dl.arrayBuffer());
    await writeFile(file, bytes);
  }
  if (!bytes.length) throw new AssistantError("link_no_media", "The video was empty");
  if (bytes.length > LINK_LIMIT) throw new AssistantError("link_too_large", "That video is over 512 MB");
  const limit = await checkUpload(sb, u, bytes.length);
  if (limit) throw new AssistantError(limit.code, limit.message, limit.status);
  const id = randomUUID(), objectKey = `${u}/${id}.mp4`;
  {
    const seconds = await (deps.probeSeconds ?? probeSeconds)(file).catch(() => 0);
    let poster = false; try { await (deps.poster ?? makePoster)(file, still); poster = true; } catch { poster = false; }
    const up = await sb.storage.from("studio-uploads").upload(objectKey, bytes, { contentType: "video/mp4", upsert: false });
    if (up.error) throw up.error;
    let posterKey: string | undefined;
    if (poster) { const jpg = await readFile(still).catch(() => null); if (jpg) { const p = await sb.storage.from("studio-outputs").upload(`${u}/assets/${id}.jpg`, jpg, { contentType: "image/jpeg", upsert: true }); if (!p.error) posterKey = `${u}/assets/${id}.jpg`; } }
    const title = String(ytTitle ?? body?.title ?? body?.desc ?? body?.aweme_detail?.desc ?? body?.caption?.text ?? body?.data?.caption?.text ?? body?.text ?? "").replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    const handle = url.match(/\/@([A-Za-z0-9_.]+)/)?.[1] ?? (platform === "instagram" ? url.match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:reel|p)\//)?.[1] : null);
    const label = platform === "tiktok" ? "TikTok" : platform === "instagram" ? "Instagram" : /\/shorts\//.test(url) ? "YouTube Short" : "YouTube";
    const name = `${title || `${label}${handle ? ` @${handle}` : platform === "youtube" ? ` ${youtubeId(url) ?? "video"}` : " video"}`}.mp4`;
    const ins = await sb.from("studio_assets").insert({ id, user_id: u, kind: "video", name, object_key: objectKey, bytes: bytes.length, status: "ready", probe: { duration: seconds || undefined, poster_key: posterKey, source_url: url, source: platform } });
    if (ins.error) throw ins.error;
    return { asset_id: id, name, kind: "video", seconds: seconds || null };
  }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------
// A turn: the person's message in, the assistant's reply (and maybe a priced plan) out.
// ---------------------------------------------------------------------------------------------------
function modelMessages(msgs: Message[], from = 0): any[] {
  const out: any[] = [];
  for (const m of msgs.slice(Math.max(from, msgs.length - MAX_MESSAGES))) {
    if (m.role === "user") {
      const parts = [m.text.trim()];
      for (const a of m.attachments ?? []) parts.push(`[Attached: "${a.name}" (${a.kind}${a.seconds ? `, ${Math.round(a.seconds)} s` : ""}) id ${a.asset_id}]`);
      for (const l of m.links ?? []) parts.push(`[Link: ${l}]`);
      if (m.context) parts.push(m.context);
      out.push({ role: "user", content: parts.filter(Boolean).join("\n") || "(no text)" });
    } else out.push({ role: "assistant", content: m.text || "(plan proposed)" });
  }
  // Claude needs alternating roles starting with user; merge any run of same-role messages.
  const merged: any[] = [];
  for (const m of out) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += `\n\n${m.content}`; else merged.push({ ...m }); }
  if (merged[0]?.role !== "user") merged.unshift({ role: "user", content: "(conversation start)" });
  return merged;
}

export async function runTurn(sb: SupabaseClient, deps: AssistantDeps, convo: Conversation, input: { text: string; attachments: Attachment[]; links: string[] }, events?: (e: TurnEvent) => void): Promise<Conversation> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined);
  const now = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const user: Message = { id: randomUUID(), role: "user", text: input.text.slice(0, 4000), attachments: input.attachments, links: input.links, at: now() };
  convo.messages = [...convo.messages, user];
  if (convo.title === "New chat" && input.text.trim()) convo.title = input.text.trim().replace(/\s+/g, " ").slice(0, 60);
  const [{ user: ku, assets, memory }, styles, social, perf] = await Promise.all([userContext(sb, convo.user_id), (deps.styles ?? fetchStyles)(env).catch(() => [] as StudioStyle[]), socialSnapshot(sb, convo.user_id, env).catch(() => ({ enabled: false, linked: [] as string[], quiet: false })), performanceForChat(sb, convo.user_id).catch(() => ({ brief: [] as string[], suggestions: [] }))]);
  const tools = toolsEnabled(env);
  const ctx: Ctx = { sb, u: convo.user_id, env, assets: new Map(assets.map((a) => [String(a.id).toLowerCase(), a])), styles, deps, tools };
  const system = buildSystemPrompt({ tools, costs: costsFor(env), plans: PLANS, env, styles, user: ku, memory: memory.map((m) => m.note), summary: convo.summary ?? null, social, performance: perf.brief });
  const messages = modelMessages(convo.messages, convo.summary_through ?? 0);
  let plan: Plan | null = null, choice: Choice | null = null, request: RequestCard | null = null, people: PeopleCard | null = null, voices: VoiceCard | null = null, saved: { id: string; name: string } | null = null, publish: PublishCard | null = null;
  // who is in a newly attached clip: found once (cached on the asset) and told to the model, so it can ask who changes
  const peopleNotes: string[] = [];
  for (const a of input.attachments.filter((x) => x.kind === "video").slice(0, 2)) {
    try {
      const { detectPeople } = await import("./studio-people.js");
      const found = await Promise.race([detectPeople(sb, deps, convo.user_id, a.asset_id), new Promise<null>((r) => setTimeout(() => r(null), 25_000))]);
      if (found) peopleNotes.push(`[People seen in "${a.name}" (asset ${a.asset_id}): ${found.length ? found.map((p) => `${p.index}: ${p.label}${p.speaking ? ", speaking" : ""}`).join("; ") : "nobody with a visible face"}]`);
    } catch (e: any) { log(`[assistant] people ${a.asset_id} ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  if (peopleNotes.length) user.context = peopleNotes.join("\n").slice(0, 1200);
  let text = "", streamed = "", interrupted = false;
  const costs = costsFor(env);
  try {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    events?.({ type: "round" }); streamed = "";
    const reply = await claude(deps, { system, tools: TOOLS, messages }, events ? (t) => { streamed += t; events({ type: "delta", text: t }); } : undefined);
    const blocks: any[] = Array.isArray(reply?.content) ? reply.content : [];
    text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n").trim() || text;
    const uses = blocks.filter((b) => b.type === "tool_use");
    if (!uses.length || reply.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: blocks.filter((b) => !(b.type === "text" && !String(b.text ?? "").trim())) });
    const results: any[] = [];
    for (const use of uses) {
      let result: any;
      try {
        if (use.name === "propose_plan") events?.({ type: "status", text: "Pricing the plan" });
        else if (use.name === "fetch_link") events?.({ type: "status", text: "Fetching the link" });
        else if (use.name === "remember") events?.({ type: "status", text: "Saving a note" });
        else if (use.name === "preview_characters") events?.({ type: "status", text: "Preparing options" });
        else if (use.name === "choose_people") events?.({ type: "status", text: "Finding the faces" });
        else if (use.name === "preview_voices") events?.({ type: "status", text: "Picking voices" });
        else if (use.name === "save_automation") events?.({ type: "status", text: "Saving the automation" });
        else if (use.name === "offer_post") events?.({ type: "status", text: "Getting the post ready" });
        if (use.name === "offer_post") {
          if (!social.enabled) throw new AssistantError("plan_invalid", "Posting to socials is not switched on yet");
          const items = await publishItems(sb, convo, ctx, (Array.isArray(use.input?.videos) ? use.input.videos : []).map(String));
          if (!items.length) throw new AssistantError("plan_invalid", "No finished video matches; use \"latest\", a job id from this chat or a library video asset id");
          const named = (Array.isArray(use.input?.platforms) ? use.input.platforms : []).map(String);
          publish = { id: randomUUID(), items, status: "open", linked_seen: social.linked, suggested: { action: use.input?.action === "schedule" ? "schedule" : use.input?.action === "now" ? "now" : null, schedule_at: typeof use.input?.schedule_at === "string" && !Number.isNaN(Date.parse(use.input.schedule_at)) ? new Date(use.input.schedule_at).toISOString() : null, platforms: named, caption: use.input?.caption ? String(use.input.caption).slice(0, 2200) : null, note: use.input?.note ? String(use.input.note).slice(0, 300) : null } };
          const unlinked = named.filter((n: string) => !social.linked.includes(n));
          result = { ok: true, videos: items.length, linked: social.linked, note: social.linked.length ? `The card is shown with ${social.linked.join(", ")} to tick${unlinked.length ? `; ${unlinked.join(", ")} ${unlinked.length === 1 ? "is" : "are"} not linked, the card lets them link it` : ""}. In one short line, say what happens next (pick, caption, Post or Schedule). Do not list the card's contents.` : "Nothing is linked yet: the card asks them to connect their socials first, on a secure page in a new tab. Say that in one line; you will be told when something is linked." };
        } else if (use.name === "preview_voices") {
          const { listVoices, matchVoices, elevenEnabled } = await import("./studio-eleven.js");
          if (!elevenEnabled(env)) throw new AssistantError("plan_invalid", "Voices are not switched on");
          const found = matchVoices(await listVoices({ env, fetch: deps.fetch }), String(use.input?.description ?? ""), 4);
          voices = { id: randomUUID(), description: String(use.input?.description ?? "").slice(0, 160), voices: found.map((v) => ({ id: v.id, name: v.name, labels: v.labels, preview_url: v.preview_url })), status: "open" };
          result = { ok: true, voices: found.map((v) => ({ id: v.id, name: v.name, labels: v.labels })), note: "The card is shown with samples; wait for their pick, then use the voice id." };
        } else if (use.name === "choose_people") {
          const aid = String(use.input?.asset_id ?? "").toLowerCase();
          const asset = ctx.assets.get(aid);
          if (!asset || asset.kind !== "video") throw new AssistantError("plan_invalid", "choose_people needs a video asset id from the library");
          const { detectPeople } = await import("./studio-people.js");
          const found = await detectPeople(sb, deps, convo.user_id, asset.id);
          people = { id: randomUUID(), asset_id: asset.id, asset_name: asset.name, reason: String(use.input?.reason ?? "").slice(0, 160), people: found.map((p) => ({ index: p.index, label: p.label, key: p.key ?? null })), status: "open" };
          result = { ok: true, people: found.map((p) => ({ index: p.index, label: p.label })), note: found.length > 1 ? "The card is shown; wait for their choice, then put the chosen labels in options.targets." : found.length === 1 ? "Only one face: no need to ask, go ahead with that person." : "No face was found; ask them which person in words or go ahead with the whole clip." };
        } else if (use.name === "request_video") {
          request = { id: randomUUID(), kind: use.input?.kind === "image" ? "image" : "video", reason: String(use.input?.reason ?? "").slice(0, 160), status: "open" };
          result = { ok: true, note: "The card is shown. Say in one line what you will do once it arrives; do not propose a plan yet." };
        } else if (use.name === "preview_characters") {
          if (!tools.character) throw new AssistantError("plan_invalid", "Characters are not taking jobs right now");
          const q = quote("character", { mode: use.input?.mode, prompt: use.input?.prompt, count: 4 }, null, costs);
          const existing: ChoiceOption[] = matchingCharacters([...ctx.assets.values()], q.options.prompt, q.options.mode).map((a) => ({ asset_id: a.id, name: a.name, poster_key: a.probe?.poster_key ?? null, object_key: a.object_key ?? null }));
          choice = { id: randomUUID(), kind: "characters", prompt: q.options.prompt, mode: q.options.mode, count: 4, credits: q.credits, auto_credits: costs.character_image, status: "offered", existing };
          result = { ok: true, offered: { options: 4, credits: q.credits, existing: existing.map((e) => e.name), note: "The card is shown: existing characters to pick for free, Show options for four new ones, Let Clone8 decide, or a photo upload. Nothing runs until they press a button. Wait for their pick." } };
        } else if (use.name === "save_automation") {
          if (!convo.plan || convo.plan.status !== "confirmed") result = { ok: false, error: "no_confirmed_plan", detail: "Only a plan that was confirmed in this chat can be saved" };
          else {
            const { createAutomation } = await import("./studio-automations.js");
            const a = await createAutomation(sb, convo.user_id, { name: String(use.input?.name ?? convo.title), plan: convo.plan, conversation_id: convo.id });
            saved = { id: a.id, name: a.name };
            result = { ok: true, automation: { id: a.id, name: a.name, inputs: a.inputs.map((i: any) => i.label) }, note: "Tell the person it is on the Automations page and what it takes as input." };
          }
        } else if (use.name === "remember") {
          const note = String(use.input?.note ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
          if (note.length < 3) result = { ok: false, error: "note_empty" };
          else if (memory.length >= MEMORY_LIMIT) result = { ok: false, error: "memory_full", detail: `${MEMORY_LIMIT} notes already; the person can clear some under Memory` };
          else {
            const ins = await sb.from("studio_assistant_memory").insert({ user_id: convo.user_id, note, conversation_id: convo.id }).select("id,note,created_at").single();
            if (ins.error && /duplicate|unique/i.test(String(ins.error.message))) result = { ok: true, already: true };
            else if (ins.error) throw ins.error;
            else { memory.push(ins.data as MemoryNote); result = { ok: true }; }
          }
        } else if (use.name === "propose_plan") { plan = await pricePlan(ctx, use.input); result = { ok: true, plan: { title: plan.title, total_credits: plan.total_credits, estimate: plan.estimate, balance: ku.balance, warnings: plan.warnings, steps: plan.steps.map((s) => ({ index: s.index, tool: s.tool, label: s.label, credits: s.credits, estimate: s.estimate, summary: s.summary })) } }; }
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
  } catch (e: any) {
    // The person stopped the reply (or left): keep what was said so far, marked, and let the chat go on from there.
    if (!(e instanceof AssistantError && e.code === "aborted")) throw e;
    interrupted = true; text = streamed.trim() || text;
    log(`[assistant] turn ${convo.id} stopped by the person`);
  }
  if (!text) text = interrupted ? "(stopped before answering)" : plan ? `Here is the plan: ${plan.title}, ${plan.total_credits} credits in ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}. Confirm it in the card to start.` : "I did not get that. Could you say it another way?";
  if (!text && choice) text = "Pick a face below, or upload a photo instead.";
  if (!text && request) text = request.kind === "image" ? "Drop the picture below, or pick it from your library." : "Drop the video below, paste a TikTok or Instagram link, or pick one from your library.";
  if (!text && people) text = "Tick who gets swapped, or choose everyone.";
  if (!text && voices) text = "Play the samples and pick a voice.";
  if (!text && saved) text = `Saved as "${saved.name}". Find it under Automations and drop a new video to run it again.`;
  if (!text && publish) text = social.linked.length ? "Pick where it goes, then post it now or schedule it." : "Connect your socials below and I will post it from here.";
  const assistant: Message = { id: randomUUID(), role: "assistant", text, plan_id: plan?.id ?? null, at: now(), ...(interrupted ? { interrupted: true } : {}), ...(choice ? { choice } : {}), ...(request ? { request } : {}), ...(people ? { people } : {}), ...(voices ? { voices } : {}), ...(publish ? { publish } : {}) };
  const voicePick = input.text.match(/^Use the voice .* \(voice ([A-Za-z0-9]+)\)/);
  if (voicePick) for (const m of convo.messages) if (m.voices?.status === "open") { m.voices.status = "done"; m.voices.picked = voicePick[1]; }
  if (/^(swap|change) (only|these|everyone)/i.test(input.text)) for (const m of convo.messages) if (m.people?.status === "open") m.people.status = "done";
  // a new attachment or link answers any open request card
  if (input.attachments.length || input.links.length) for (const m of convo.messages) if (m.request?.status === "open") m.request.status = "done";
  convo.messages = [...convo.messages, assistant];
  if (plan) { if (convo.plan && convo.plan.status === "proposed") convo.plan.status = "superseded"; convo.plan = plan; convo.title = plan.title; }
  convo.updated_at = now();
  const w = await sb.from("studio_conversations").update({ title: convo.title, messages: convo.messages, plan: convo.plan, updated_at: convo.updated_at }).eq("id", convo.id).eq("user_id", convo.user_id);
  if (w.error) throw w.error;
  return convo;
}

// ---------------------------------------------------------------------------------------------------
// Long chats: once enough has been said, the older part is folded into a running summary the model reads in its
// system prompt, and only the recent messages travel raw. The person sees where the fold happened and can read it.
// ---------------------------------------------------------------------------------------------------
export const COMPACT_AFTER = 24, KEEP_RAW = 12, COMPACT_CHARS = 24_000;
const SUMMARY_PROMPT = "You write the Clone8 Studio assistant's own notes on a chat with one creator, so the assistant can keep the thread without the earlier messages. Keep what the person wants, decisions made, files and characters named (with any ids), plans proposed and what happened to them (steps, credits, outcomes, failures), preferences stated, and open questions. Plain text, under 250 words, no headers, no advice, nothing that was not said. If a summary so far is given, merge it with the new part into one summary.";
export function needsCompaction(convo: Pick<Conversation, "messages" | "summary_through">): boolean {
  const raw = convo.messages.slice(convo.summary_through ?? 0);
  return raw.length >= COMPACT_AFTER || raw.reduce((n, m) => n + m.text.length, 0) >= COMPACT_CHARS;
}
/** A short name for a chat that still carries its first message as a title, like any chat app; false when nothing changed. */
export async function titleIfNeeded(sb: SupabaseClient, deps: AssistantDeps, convo: Conversation): Promise<boolean> {
  const first = convo.messages.find((m) => m.role === "user")?.text?.trim() ?? "";
  const raw = convo.title === "New chat" || (first && convo.title === first.replace(/\s+/g, " ").slice(0, 60));
  if (!raw || convo.messages.length < 2 || !first) return false;
  const reply = await claude({ ...deps, signal: undefined }, { system: "Name this chat in three to six words, sentence case (capital only on the first word and names), plain, no quotes, no period, no emoji. It is a chat between a creator and a video assistant; name it by what the person wants.", max_tokens: 24, messages: [{ role: "user", content: convo.messages.slice(0, 4).map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${m.text.slice(0, 300)}`).join("\n") }] });
  const text = (Array.isArray(reply?.content) ? reply.content : []).filter((b: any) => b.type === "text").map((b: any) => String(b.text)).join(" ").replace(/["\n]+/g, " ").replace(/[.\s]+$/, "").trim().slice(0, 60);
  if (!text) return false;
  convo.title = text;
  const w = await sb.from("studio_conversations").update({ title: text }).eq("id", convo.id).eq("user_id", convo.user_id);
  if (w.error) throw w.error;
  return true;
}

/** Folds the older messages into the summary when the chat has grown; false when nothing was done. */
export async function compactIfNeeded(sb: SupabaseClient, deps: AssistantDeps, convo: Conversation): Promise<boolean> {
  if (!needsCompaction(convo)) return false;
  const from = convo.summary_through ?? 0, to = convo.messages.length - KEEP_RAW;
  if (to <= from) return false;
  const part = convo.messages.slice(from, to).map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${m.text}${m.attachments?.length ? ` [attached: ${m.attachments.map((a) => `${a.name} id ${a.asset_id}`).join(", ")}]` : ""}${m.links?.length ? ` [links: ${m.links.join(", ")}]` : ""}`).join("\n");
  const reply = await claude({ ...deps, signal: undefined }, { system: SUMMARY_PROMPT, max_tokens: 700, messages: [{ role: "user", content: `${convo.summary ? `Summary so far:\n${convo.summary}\n\n` : ""}New part of the chat:\n${part}` }] });
  const text = (Array.isArray(reply?.content) ? reply.content : []).filter((b: any) => b.type === "text").map((b: any) => String(b.text)).join("\n").trim();
  if (!text) return false;
  convo.summary = text.slice(0, 6000); convo.summary_through = to;
  const w = await sb.from("studio_conversations").update({ summary: convo.summary, summary_through: to }).eq("id", convo.id).eq("user_id", convo.user_id);
  if (w.error) throw w.error;
  (deps.log ?? (() => undefined))(`[assistant] compacted ${convo.id} through ${to} (${convo.summary.length} chars)`);
  return true;
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
  if (Array.isArray(s.options?.cast)) for (const m of s.options.cast) add(m?.character_asset_id);
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
        if (Array.isArray(o.cast)) o.cast = o.cast.map((m: any) => (m?.character_asset_id && REF_RE.test(String(m.character_asset_id)) ? { ...m, character_asset_id: resolve(m.character_asset_id) } : m));
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
    if (run.status === "running" && run.steps.every((s) => s.status === "done")) {
      finish("done", `All ${run.steps.length === 1 ? "done" : `${run.steps.length} steps are done`}. The results are in the cards above and in your library.`);
      // Finished videos: offer to post them (or, with nothing linked and no recent "not now", to link first).
      try {
        const social = await socialSnapshot(sb, convo.user_id, env);
        const finals = run.steps.filter((st) => !run.steps.some((o) => o.index > st.index && refsOf(plan.steps[o.index - 1]).includes(st.index)));
        const items: PublishItem[] = finals.flatMap((st) => ((jobs.get(st.job_id ?? "")?.outputs ?? []) as any[]).filter(isVideoOutput).map((o) => ({ job_id: st.job_id, output_key: o.key, poster_key: o.poster_key ?? null }))).slice(0, 25);
        if (social.enabled && items.length && !social.quiet) {
          const last = convo.messages[convo.messages.length - 1];
          last.publish = { id: randomUUID(), items, status: "open", auto: true, linked_seen: social.linked };
          last.text = social.linked.length
            ? `All done. Want ${items.length > 1 ? "these" : "it"} on your socials? Pick where, let me write the caption from the video or write your own, then post now or schedule.`
            : `All done. The results are in the cards above and in your library. Want ${items.length > 1 ? "these" : "it"} on TikTok, Instagram or YouTube? Connect your socials once and I can post or schedule from here.`;
        }
      } catch (e: any) { log(`[assistant] publish offer ${convo.id}: ${String(e?.message ?? e).slice(0, 160)}`); }
    }
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
export async function hydrateJobs(sb: SupabaseClient, u: string, ids: string[]) {
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
export const publicConversation = (c: any, jobs: any[] = []) => ({ id: c.id, title: c.title, status: c.status, messages: c.messages ?? [], plan: c.plan ?? null, run: c.run ?? null, jobs, summary: c.summary ?? null, summary_through: c.summary_through ?? 0, automation_id: c.automation_id ?? null, created_at: c.created_at, updated_at: c.updated_at });
const escapeLike = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Choice cards whose job finished become ready (options = the character assets) or failed; option posters are signed. Persists when something changed. */
export async function hydrateChoices(sb: SupabaseClient, u: string, c: Conversation): Promise<Conversation> {
  const pending = c.messages.filter((m) => m.choice?.status === "generating" && m.choice.job_id);
  let changed = false;
  if (pending.length) {
    const r = await sb.from("studio_jobs").select("id,status,outputs,error_code").in("id", pending.map((m) => m.choice!.job_id!)).eq("user_id", u);
    if (r.error) throw r.error;
    for (const m of pending) {
      const j = (r.data ?? []).find((x: any) => x.id === m.choice!.job_id);
      if (!j) continue;
      if (j.status === "done") { m.choice!.status = "ready"; m.choice!.options = (j.outputs ?? []).filter((o: any) => o.asset_id).map((o: any, i: number) => ({ asset_id: o.asset_id, name: `Option ${i + 1}`, poster_key: o.poster_key ?? o.key ?? null })); changed = true; }
      else if (j.status === "failed" || j.status === "canceled") { m.choice!.status = "failed"; m.choice!.error_code = j.error_code ?? j.status; changed = true; }
    }
  }
  if (changed) { const w = await sb.from("studio_conversations").update({ messages: c.messages }).eq("id", c.id).eq("user_id", u); if (w.error) throw w.error; }
  const keys = c.messages.flatMap((m) => [...[...(m.choice?.options ?? []), ...(m.choice?.existing ?? [])].map((o) => o.poster_key), ...(m.people?.people ?? []).map((p) => p.key), ...(m.publish?.items ?? []).map((i) => i.poster_key)].filter(Boolean) as string[]);
  if (keys.length) {
    const signed = await sb.storage.from("studio-outputs").createSignedUrls([...new Set(keys)], 900);
    const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
    for (const m of c.messages) {
      for (const o of [...(m.choice?.options ?? []), ...(m.choice?.existing ?? [])]) o.url = o.poster_key ? urls.get(o.poster_key) ?? null : null;
      for (const p of m.people?.people ?? []) p.url = p.key ? urls.get(p.key) ?? null : null;
      for (const i of m.publish?.items ?? []) i.url = i.poster_key ? urls.get(i.poster_key) ?? null : null;
    }
  }
  // a made character without a poster file shows its own picture from the uploads bucket
  const own = c.messages.flatMap((m) => (m.choice?.existing ?? []).filter((o) => !o.url && o.object_key).map((o) => o.object_key!));
  if (own.length) {
    const signed = await sb.storage.from("studio-uploads").createSignedUrls([...new Set(own)], 900);
    const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
    for (const m of c.messages) for (const o of m.choice?.existing ?? []) if (!o.url && o.object_key) o.url = urls.get(o.object_key) ?? null;
  }
  return c;
}

const isVideoOutput = (o: any) => !!o && (o.kind ? o.kind === "video" : /\.mp4$/i.test(String(o.key ?? "")));
const NETWORK_NAMES: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", twitter: "X", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky" };
const listNames = (xs: string[]) => { const n = xs.map((x) => NETWORK_NAMES[x] ?? x); return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`; };

/** The videos an offer_post call points at: "latest" (this chat's finished results, else the newest finished video),
 *  a job id (its videos) or a library video. Only the person's own, finished, at most 25. */
export async function publishItems(sb: SupabaseClient, convo: Conversation, ctx: Ctx, refs: string[]): Promise<PublishItem[]> {
  const out: PublishItem[] = [], jobIds = new Set<string>();
  for (const raw of refs) {
    const v = raw.trim().toLowerCase();
    if (v === "latest") {
      const steps = convo.run?.steps ?? [], plan = convo.plan;
      const finals = steps.filter((st) => st.job_id && !steps.some((o) => o.index > st.index && plan && refsOf(plan.steps[o.index - 1]).includes(st.index)));
      if (finals.length) for (const st of finals) jobIds.add(st.job_id!);
      else {
        const r = await sb.from("studio_jobs").select("id,status,outputs").eq("user_id", convo.user_id).eq("status", "done").order("created_at", { ascending: false }).limit(10);
        const j = ((r.data ?? []) as any[]).find((x) => (x.outputs ?? []).some(isVideoOutput));
        if (j) jobIds.add(j.id);
      }
    } else if (UUID_RE.test(v)) {
      const a = ctx.assets.get(v);
      if (a) { if (a.kind === "video") out.push({ asset_id: a.id, poster_key: a.probe?.poster_key ?? null }); }
      else jobIds.add(v);
    }
  }
  if (jobIds.size) {
    const r = await sb.from("studio_jobs").select("id,status,outputs").eq("user_id", convo.user_id).in("id", [...jobIds]);
    if (r.error) throw r.error;
    for (const j of (r.data ?? []) as any[]) if (j.status === "done") for (const o of (j.outputs ?? []).filter(isVideoOutput)) out.push({ job_id: j.id, output_key: o.key, poster_key: o.poster_key ?? null });
  }
  const seen = new Set<string>();
  return out.filter((i) => { const k = i.asset_id ?? `${i.job_id}:${i.output_key}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
}

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
    await hydrateChoices(sb, u, c);
    const ids = (c.run?.steps ?? []).map((s) => s.job_id).filter(Boolean) as string[];
    res.status(status).json({ conversation: publicConversation(c, await hydrateJobs(sb, u, ids)), assistant: toolsEnabled(env).assistant });
  };
  // Publish cards: Post now / Schedule sends through the same path as the Publish page; Ignore closes the card (and,
  // with nothing linked, quiets the unasked offer for a while); social-linked is called by the interface when it sees
  // new networks after the linking page, so the chat can say so and carry on, like a connector coming back.
  const publishCard = (c: Conversation, id: string) => { const m = c.messages.find((x) => x.publish?.id === id); if (!m?.publish) throw new AssistantError("card_not_found", "No such card", 404); return m.publish; };
  const save = async (sb: SupabaseClient, u: string, c: Conversation) => { c.updated_at = new Date().toISOString(); const w = await sb.from("studio_conversations").update({ messages: c.messages, updated_at: c.updated_at }).eq("id", c.id).eq("user_id", u); if (w.error) throw w.error; };
  const say = (c: Conversation, text: string) => { c.messages = [...c.messages, { id: randomUUID(), role: "assistant", text, at: new Date().toISOString() }]; };
  app.post("/api/studio/assistant/conversations/:id/publish/:cardId", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), c = await load(sb, u, req.params.id), card = publishCard(c, req.params.cardId);
      if (card.status !== "open") throw new AssistantError("card_closed", "That card was already used", 409);
      const p = getSocialProvider({ env, fetch: deps.fetch, log });
      if (!p) throw new AssistantError("social_off", "Posting to socials is not switched on yet", 503);
      const b = req.body ?? {}, schedule = b.action === "schedule";
      const items = card.items.map((i) => (i.asset_id ? { asset_id: i.asset_id } : { job_id: i.job_id, output_key: i.output_key }));
      let posts: any[];
      try { posts = await createPosts(sb, p, u, { items, platforms: b.platforms, caption: b.caption, schedule_at: schedule ? b.schedule_at : null, spacing_minutes: b.spacing_minutes, options: b.options }, { conversationId: c.id, log }); }
      catch (e: any) { if (e?.code) throw new AssistantError(e.code, e.message, e.status ?? 400); throw e; }
      const ok = posts.filter((x) => x.status !== "failed"), nets = listNames([...new Set(posts.flatMap((x) => x.platforms as string[]))]);
      const when = typeof b.when_label === "string" ? b.when_label.replace(/[^\w ,:.'-]/g, "").slice(0, 60) : "";
      if (!ok.length) { say(c, `That did not go out: ${posts[0]?.error ?? "the networks refused it"}. Fix it on the card and try again.`); }
      else {
        card.status = "sent"; card.post_ids = posts.map((x) => x.id);
        card.outcome = schedule ? `Scheduled${when ? ` for ${when}` : ""} on ${nets}` : `Sent to ${nets}`;
        const n = ok.length > 1 ? `${ok.length} videos` : "it";
        say(c, schedule
          ? `Scheduled: ${n} go${ok.length > 1 ? "" : "es"} out${when ? ` ${when}` : ""} on ${nets}${ok.length > 1 && b.spacing_minutes ? `, ${b.spacing_minutes >= 60 ? `${Math.round(b.spacing_minutes / 60)} h` : `${b.spacing_minutes} min`} apart` : ""}. You can change or cancel ${ok.length > 1 ? "them" : "it"} on the Publish page.${posts.length > ok.length ? ` ${posts.length - ok.length} failed; see Publish.` : ""}`
          : `On its way to ${nets}. The links show on the card as each network finishes; TikTok takes a minute or two.${posts.length > ok.length ? ` ${posts.length - ok.length} failed; see Publish.` : ""}`);
      }
      await save(sb, u, c);
      log(`[assistant] publish card ${card.id} ${schedule ? "scheduled" : "sent"} ${ok.length}/${posts.length}`);
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/publish/:cardId/ignore", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), c = await load(sb, u, req.params.id), card = publishCard(c, req.params.cardId);
      if (card.status === "open") {
        card.status = "ignored";
        const social = await socialSnapshot(sb, u, env).catch(() => null);
        if (social && !social.linked.length) {
          const prev = await sb.from("studio_social_prefs").select("connect_dismissals").eq("user_id", u).maybeSingle();
          await sb.from("studio_social_prefs").upsert({ user_id: u, connect_dismissed_at: new Date().toISOString(), connect_dismissals: Number(prev.data?.connect_dismissals ?? 0) + 1, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        }
        await save(sb, u, c);
      }
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/social-linked", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), c = await load(sb, u, req.params.id);
      const p = getSocialProvider({ env, fetch: deps.fetch, log });
      const prof = p ? await sb.from("studio_social_profiles").select("profile_key").eq("user_id", u).maybeSingle() : null;
      let linked: string[] = [];
      if (p && prof?.data?.profile_key) {
        const accounts = await p.accounts(prof.data.profile_key);
        await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", u);
        linked = accounts.map((a) => a.platform);
      }
      const card = [...c.messages].reverse().find((m) => m.publish?.status === "open")?.publish;
      const fresh = card ? linked.filter((x) => !(card.linked_seen ?? []).includes(x)) : [];
      if (card && fresh.length) {
        card.linked_seen = linked;
        const n = card.items.length > 1 ? "these" : "it";
        say(c, `${listNames(fresh)} ${fresh.length === 1 ? "is" : "are"} linked. Want me to post ${n} now or schedule ${n}? I can write the caption from the video, or use yours.`);
        await save(sb, u, c);
      }
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });

  // Choice cards: the person presses Show options (a character job for four portraits, credits reserved like any job),
  // then picks one; the pick is recorded on the card and the interface sends the picked image as the next message.
  app.post("/api/studio/assistant/conversations/:id/choices/:choiceId/generate", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      const m = c.messages.find((x) => x.choice?.id === req.params.choiceId);
      if (!m?.choice) throw new AssistantError("choice_not_found", "No such card", 404);
      if (m.choice.status !== "offered" && m.choice.status !== "failed" && !(m.choice.status === "ready" && req.body?.again)) throw new AssistantError("choice_done", "Those options were already made", 409);
      const limit = await checkJobRate(sb, u);
      if (limit) throw new AssistantError(limit.code, limit.message, limit.status);
      // "Let Clone8 decide" draws one portrait and picks it for them; otherwise four to choose from
      const auto = req.body?.mode === "auto";
      const q = quote("character", { mode: m.choice.mode, prompt: m.choice.prompt, count: auto ? 1 : 4 }, null, costsFor(env));
      const r = await sb.rpc("studio_create_job", { p_user: u, p_tool: "character", p_asset: null, p_options: q.options, p_credits: q.credits });
      if (r.error) { const msg = String(r.error.message ?? r.error); if (/insufficient_credits/.test(msg)) throw new AssistantError("insufficient_credits", "Not enough credits for the options", 402); if (/too_many_jobs/.test(msg)) throw new AssistantError("too_many_jobs", "Your jobs are all busy; try again in a moment", 429); throw r.error; }
      m.choice.status = "generating"; m.choice.job_id = r.data.id; m.choice.credits = q.credits; m.choice.error_code = null; m.choice.auto = auto; m.choice.count = auto ? 1 : 4;
      const w = await sb.from("studio_conversations").update({ messages: c.messages, updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", u);
      if (w.error) throw w.error;
      log(`[assistant] choice ${m.choice.id} job ${r.data.id}`);
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/assistant/conversations/:id/choices/:choiceId/pick", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      await hydrateChoices(sb, u, c);
      const m = c.messages.find((x) => x.choice?.id === req.params.choiceId);
      if (!m?.choice) throw new AssistantError("choice_not_found", "No such card", 404);
      const id = String(req.body?.asset_id ?? "");
      if (![...(m.choice.options ?? []), ...(m.choice.existing ?? [])].some((o) => o.asset_id === id)) throw new AssistantError("choice_invalid", "Pick one of the options");
      m.choice.status = "picked"; m.choice.picked = id;
      const w = await sb.from("studio_conversations").update({ messages: c.messages, updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", u);
      if (w.error) throw w.error;
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/assistant/conversations", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const q = String(req.query.q ?? "").trim().slice(0, 80);
      let query = sbFn().from("studio_conversations").select("id,title,status,created_at,updated_at").eq("user_id", u).order("updated_at", { ascending: false }).limit(100);
      if (q) query = query.ilike("title", `%${escapeLike(q)}%`);
      const r = await query;
      if (r.error) throw r.error;
      res.json({ conversations: r.data ?? [], assistant: toolsEnabled(env).assistant });
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/assistant/conversations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      const title = String(req.body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!title) throw new AssistantError("title_empty", "Give the chat a name");
      c.title = title; c.updated_at = new Date().toISOString();
      const w = await sb.from("studio_conversations").update({ title, updated_at: c.updated_at }).eq("id", c.id).eq("user_id", u);
      if (w.error) throw w.error;
      await respond(sb, u, c, res);
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/assistant/conversations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await load(sb, u, req.params.id);
      // queued steps of a live run are canceled (and refunded) first; a rendering job finishes on its own and stays in the library
      if (c.run?.status === "running") for (const s of c.run.steps) if (s.status === "queued" && s.job_id) { const r = await sb.rpc("studio_cancel", { p_user: u, p_job: s.job_id }); if (r.error) log(`[assistant] cancel ${s.job_id} ${r.error.message}`); }
      const d = await sb.from("studio_conversations").delete().eq("id", c.id).eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: c.id });
    } catch (e) { fail(res, e); }
  });
  // Memory: the notes the assistant keeps across chats, in the open. Read them, drop one, or drop them all.
  app.get("/api/studio/assistant/memory", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_assistant_memory").select("id,note,created_at").eq("user_id", u).order("created_at", { ascending: true }).limit(MEMORY_LIMIT);
      if (r.error) { if (/relation .* does not exist/i.test(String(r.error.message))) return res.json({ notes: [], limit: MEMORY_LIMIT }); throw r.error; }
      res.json({ notes: r.data ?? [], limit: MEMORY_LIMIT });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/assistant/memory/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new AssistantError("note_not_found", "No such note", 404);
      const d = await sbFn().from("studio_assistant_memory").delete().eq("id", req.params.id).eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: req.params.id });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/assistant/memory", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const d = await sbFn().from("studio_assistant_memory").delete().eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: "all" });
    } catch (e) { fail(res, e); }
  });
  /** A TikTok, Instagram or YouTube link brought into the library outside a chat (the Automations page, the tool pages). */
  app.post("/api/studio/links", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const url = String(req.body?.url ?? "").trim().slice(0, 2000);
      if (!url) throw new AssistantError("message_empty", "Paste a link");
      const a = await importLink(sbFn(), deps, u, url);
      const row = await sbFn().from("studio_assets").select("id,kind,name,bytes,status,probe,created_at").eq("id", a.asset_id).eq("user_id", u).maybeSingle();
      if (row.error) throw row.error;
      const assets = await withPosterUrls(sbFn(), [row.data]);
      res.status(201).json({ asset: assets[0] ?? row.data });
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
      const stream = req.query.stream === "1" || String(req.headers.accept ?? "").includes("text/event-stream");
      const ctl = new AbortController();
      const turnDeps = { ...deps, env, log, signal: ctl.signal };
      const afterwards = async (out: Conversation) => {
        await titleIfNeeded(sb, { ...deps, env, log }, out).catch((e) => log(`[assistant] title ${out.id} ${String(e?.message ?? e).slice(0, 200)}`));
        await compactIfNeeded(sb, { ...deps, env, log }, out).catch((e) => log(`[assistant] compact ${out.id} ${String(e?.message ?? e).slice(0, 200)}`));
      };
      if (!stream) {
        const out = await runTurn(sb, turnDeps, c, { text, attachments, links });
        await respond(sb, u, out, res);
        void afterwards(out);
        return;
      }
      // Server-sent events: text as it is written, a status line per tool, then the whole conversation. If the
      // person leaves or presses Stop, the model request is cut and the partial reply is kept.
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      let finished = false;
      const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      req.on("close", () => { if (!finished) ctl.abort(); });
      const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
      try {
        const out = await runTurn(sb, turnDeps, c, { text, attachments, links }, (e) => send(e.type, e));
        finished = true;
        await hydrateChoices(sb, u, out); // signed pictures on the cards, same as a plain read
        const ids2 = (out.run?.steps ?? []).map((s) => s.job_id).filter(Boolean) as string[];
        send("done", { conversation: publicConversation(out, await hydrateJobs(sb, u, ids2)), assistant: toolsEnabled(env).assistant });
        void afterwards(out);
      } catch (e: any) {
        finished = true;
        const code = e instanceof AssistantError || e instanceof StudioError || e instanceof InstrumentError ? e.code : "assistant_failed";
        if (code !== "aborted") log(`[assistant] stream ${code}: ${String(e?.message ?? e).slice(0, 200)}`);
        send("error", { error: code, detail: String(e?.message ?? e).slice(0, 200) });
      } finally { clearInterval(keepAlive); res.end(); }
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
