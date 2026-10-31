// The AI overview of a person's performance, and what the rest of the Studio learns from it.
//
// The overview is written by Claude from three things only: the person's own numbers (analyze() facts and the top and
// weakest posts, with their thumbnails and, for the best TikToks, what is said in them), the research playbook
// (data/social-playbook.ts: what platform insiders have disclosed and what large studies measured, each with its
// source), and the Clone8 tools it can point to. Every finding has to cite their numbers; every move maps to a tool.
// The same analysis feeds the chat (a short performance brief in the system prompt) and the suggested prompts.
import { logClaudeCost } from "./studio-pricing.js";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLAYBOOK } from "./data/social-playbook.js";
import { analyze, type Analysis, type PerfDeps, type PostRow, type PostStats } from "./studio-performance.js";

export const INSIGHT_MODEL = "claude-opus-5-5";
export const MOVE_TOOLS = ["blueprint", "swap", "recast", "restyle", "trend", "publish", "chat"] as const;
export type InsightMove = { title: string; detail: string; tool: (typeof MOVE_TOOLS)[number]; post_id: string | null; prompt: string | null };
export type Insight = {
  headline: string;
  working: Array<{ title: string; evidence: string; why: string; post_ids: string[] }>;
  not_working: Array<{ title: string; evidence: string; fix: string }>;
  moves: InsightMove[];
  sources: Array<{ label: string; url: string }>;
};

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["headline", "working", "not_working", "moves", "sources"],
  properties: {
    headline: { type: "string", description: "One sentence, at most 150 characters, with a number from their data" },
    working: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "evidence", "why", "post_ids"], properties: {
      title: { type: "string", description: "What works, in five to nine words" },
      evidence: { type: "string", description: "Their numbers that show it (multiples of their usual views, rates, counts)" },
      why: { type: "string", description: "Why it works: the mechanism, tied to a disclosed ranking signal or a measured finding from the playbook, named" },
      post_ids: { type: "array", items: { type: "string" }, description: "Ids of their posts that show it" } } } },
    not_working: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "evidence", "fix"], properties: {
      title: { type: "string" }, evidence: { type: "string" }, fix: { type: "string", description: "One concrete change" } } } },
    moves: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail", "tool", "post_id", "prompt"], properties: {
      title: { type: "string", description: "An instruction, at most eight words" },
      detail: { type: "string", description: "One or two sentences: what exactly, and the number it should move" },
      tool: { type: "string", enum: [...MOVE_TOOLS] },
      post_id: { anyOf: [{ type: "string" }, { type: "null" }], description: "The post it starts from, when it starts from one" },
      prompt: { anyOf: [{ type: "string" }, { type: "null" }], description: "For tool chat: what the person would ask the assistant, in their voice, under 120 characters" } } } },
    sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "url"], properties: { label: { type: "string" }, url: { type: "string" } } }, description: "Only playbook sources actually used" },
  },
};

const SYSTEM = `You are the performance coach inside Clone8 Studio. A creator linked their own accounts; you read their numbers and tell them what is working, why, and what to do next.
Rules:
- Every claim cites THEIR numbers (posts, multiples of their usual views, rates, counts). If their data cannot support a claim (fewer than 3 posts in a group), do not make it.
- "Why" ties their result to a mechanism that a platform insider disclosed or a large study measured, from the playbook below, named briefly (who, when). Never invent a statistic or a source. Use only sources from the playbook, and list the ones you used.
- No generic advice ("be consistent", "use trending audio", "engage with your audience") unless their own data points to it and you say exactly how much.
- Look at the thumbnails and captions of the top and the weakest posts and say what differs (subject, framing, text on screen, first words, length, format) when it is visible.
- Moves map to Clone8 tools: blueprint (many originals of one video, each its own file, for more posts and accounts without reposting the same file), swap (put a character or person into their video), recast (rebuild the person on screen as a character), restyle (redraw in a style), trend (perform a trend with their character), publish (post or schedule, e.g. at their best time), chat (anything else, give the prompt). Prefer starting from their best posts. Three to five moves, most valuable first.
- Plain words, short sentences, no hype, no emoji, no markdown. Never mention Clone8's suppliers or how Blueprint changes a file.`;

/** The posts the model reads closely: the best by their own baseline, and the weakest. */
function pick(a: Analysis) {
  const byId = new Map(a.posts.map((p) => [p.id, p]));
  const top = a.top.slice(0, 5).map((id) => byId.get(id)!).filter(Boolean);
  const low = a.low.slice(0, 3).map((id) => byId.get(id)!).filter(Boolean);
  return { top, low };
}
const pc = (x: number | null, d = 0) => (x == null ? "?" : `${(x * 100).toFixed(d)}%`);
const line = (p: PostStats) => `id ${p.id} · ${p.platform} · ${p.published_at?.slice(0, 16).replace("T", " ") ?? "?"} UTC · ${p.duration_s ? `${Math.round(p.duration_s)} s` : "length ?"} · ${p.views ?? "?"} views (${p.multiple ? `${p.multiple.toFixed(1)}× usual` : "?"}) · likes ${p.likes ?? "?"} · comments ${p.comments ?? "?"} · shares ${p.shares ?? "?"} · saves ${p.saves ?? "?"} · engagement ${pc(p.er, 1)} · share rate ${pc(p.share_rate, 2)}${p.reach != null ? ` · reach ${p.reach} · shares per reach ${pc(p.shares_per_reach, 2)}` : ""}${p.hold_3s != null ? ` · still watching at 3 s ${pc(p.hold_3s)}` : ""}${p.watch_pct != null ? ` · watched ${pc(p.watch_pct)} of length` : ""}${p.full_watch_rate != null ? ` · watched to the end ${pc(p.full_watch_rate)}` : ""}${p.extra?.fyp_share != null ? ` · For You share ${p.extra.fyp_share}` : ""}${p.clone8 ? " · made with Clone8" : ""} · caption: ${JSON.stringify((p.caption ?? "").slice(0, 220))}`;

export function insightHash(a: Analysis, platform: string | null): string {
  return createHash("sha256").update(JSON.stringify({ platform, facts: a.facts, top: a.top, low: a.low, v: 2 })).digest("hex").slice(0, 32);
}

export async function writeInsight(sb: SupabaseClient, u: string, a: Analysis, opts: { platform: string | null; thumbs: Map<string, string>; transcripts?: Map<string, string> }, deps: PerfDeps = {}): Promise<Insight> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("insights_unconfigured");
  const { top, low } = pick(a);
  const images: any[] = [];
  for (const p of [...top.slice(0, 3), ...low.slice(0, 2)]) {
    const url = opts.thumbs.get(p.id);
    if (url) images.push({ type: "text", text: `Thumbnail of post ${p.id} (${top.includes(p) ? "top" : "weak"}):` }, { type: "image", source: { type: "url", url } });
  }
  const said = [...(opts.transcripts?.entries() ?? [])].map(([id, t]) => `What is said in post ${id}: """${t.slice(0, 1200)}"""`).join("\n");
  const text = [
    `THEIR NUMBERS (${opts.platform ?? "all linked accounts"}, last ${a.range_days} days)`, ...a.facts.map((x) => `- ${x}`), "",
    "TOP POSTS (by their own usual views)", ...top.map((p) => `- ${line(p)}`), "",
    low.length ? "WEAKEST POSTS" : "", ...low.map((p) => `- ${line(p)}`), "",
    said, "",
    "PLAYBOOK (what insiders disclosed and studies measured; cite only these)", PLAYBOOK, "",
    "Write the overview now.",
  ].filter((x) => x !== undefined).join("\n");
  const r = await f("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify({ model: env.STUDIO_INSIGHT_MODEL || INSIGHT_MODEL, max_tokens: 16000, system: SYSTEM, fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: [...images, { type: "text", text }] }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`insights_http_${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const body: any = await r.json();
  logClaudeCost(deps.log, "overview", env.STUDIO_INSIGHT_MODEL || INSIGHT_MODEL, body?.usage);
  if (body?.stop_reason === "refusal") throw new Error("insights_refused");
  if (body?.stop_reason === "max_tokens") throw new Error("insights_cut_short");
  const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
  const parsed = JSON.parse(raw) as Insight;
  return cleanInsight(parsed, new Set(a.posts.map((p) => p.id)));
}

const PLAYBOOK_URLS = new Set(PLAYBOOK.match(/https:\/\/\S+/g) ?? []);
/** Keep only what the page can act on: known post ids, known tools, short text, at most a handful of each. */
export function cleanInsight(x: Insight, ids: Set<string>): Insight {
  const s = (v: any, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return {
    headline: s(x.headline, 180),
    working: (x.working ?? []).slice(0, 4).map((w) => ({ title: s(w.title, 90), evidence: s(w.evidence, 300), why: s(w.why, 400), post_ids: (w.post_ids ?? []).filter((id) => ids.has(id)).slice(0, 3) })),
    not_working: (x.not_working ?? []).slice(0, 2).map((w) => ({ title: s(w.title, 90), evidence: s(w.evidence, 300), fix: s(w.fix, 300) })),
    moves: (x.moves ?? []).filter((m) => (MOVE_TOOLS as readonly string[]).includes(m.tool)).slice(0, 5).map((m) => ({ title: s(m.title, 70), detail: s(m.detail, 300), tool: m.tool, post_id: m.post_id && ids.has(m.post_id) ? m.post_id : null, prompt: m.prompt ? s(m.prompt, 160) : null })),
    sources: (x.sources ?? []).filter((y) => /^https:\/\//.test(String(y.url)) && PLAYBOOK_URLS.has(String(y.url).trim())).slice(0, 8).map((y) => ({ label: s(y.label, 120), url: s(y.url, 400) })),
  };
}

// ---------------------------------------------------------------------------------------------------
// What the rest of the Studio learns from it
// ---------------------------------------------------------------------------------------------------
export type Suggestion = { label: string; prompt: string };
const short = (c: string | null, n = 40) => { const t = String(c ?? "").replace(/#[\p{L}0-9_]+/gu, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t || "untitled"; };
const NAME: Record<string, string> = { tiktok: "TikTok", instagram: "Reel", youtube: "Short" };

/** Prompts for the chat and the home, from their own results; empty when there is nothing of theirs to go on. */
export function suggestionsFrom(a: Analysis | null, insight: Insight | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (a) {
    const byId = new Map(a.posts.map((p) => [p.id, p]));
    const best = a.top.map((id) => byId.get(id)).find((p) => p && p.url);
    if (best) out.push({ label: `Make 10 originals of your best ${NAME[best.platform] ?? "post"}`, prompt: `Make 10 originals of my ${NAME[best.platform] ?? "post"} "${short(best.caption)}" (${best.url})` });
    const t = a.by_time.filter((b) => b.n >= 3 && b.median_multiple != null).sort((p, q) => q.median_multiple! - p.median_multiple!)[0];
    if (t && (t.median_multiple ?? 0) > 1.2) out.push({ label: `Schedule my next videos for ${t.label}`, prompt: `Schedule my latest videos for ${t.label}, my best posting window` });
    const shared = [...a.posts].filter((p) => p.share_rate != null).sort((p, q) => q.share_rate! - p.share_rate!)[0];
    if (shared && shared.id !== best?.id && shared.url) out.push({ label: "Turn my most shared video into a cat version", prompt: `Swap a character into my most shared video "${short(shared.caption)}" (${shared.url})` });
  }
  for (const m of insight?.moves ?? []) if (m.tool === "chat" && m.prompt && out.length < 4) out.push({ label: m.title, prompt: m.prompt });
  return out.slice(0, 4);
}

/** A few lines for the assistant's system prompt: how this person's posts do, what works, the move list. */
export function chatBrief(a: Analysis | null, insight: Insight | null): string[] {
  if (!a || !a.posts.length) return [];
  const byId = new Map(a.posts.map((p) => [p.id, p]));
  const lines = [...a.facts.slice(0, 6)];
  const top = a.top.slice(0, 3).map((id) => byId.get(id)!).filter(Boolean);
  if (top.length) lines.push(`Their best recent posts: ${top.map((p) => `${p.platform} "${short(p.caption, 50)}" ${p.multiple ? `${p.multiple.toFixed(1)}× usual` : ""} (${p.url})`).join("; ")}.`);
  if (insight) { lines.push(`Overview: ${insight.headline}`); for (const w of insight.working.slice(0, 2)) lines.push(`Works: ${w.title}: ${w.evidence}`); for (const m of insight.moves.slice(0, 3)) lines.push(`Suggested move (${m.tool}): ${m.title}: ${m.detail}`); }
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// Loading what the dashboard and the chat read
// ---------------------------------------------------------------------------------------------------
export type PerfLoad = { analysis: Analysis; rows: PostRow[]; accounts: any[]; snapshots: any[]; thumbs: Map<string, string> };

/** Everything the dashboard shows for one person, one range and one network (or all). */
export async function loadPerformance(sb: SupabaseClient, u: string, range: number, platform: string | null, offsetMin: number, now = Date.now()): Promise<PerfLoad> {
  const since = new Date(now - Math.max(range * 2, 90) * 86400_000).toISOString();
  const [posts, accounts, snaps] = await Promise.all([
    sb.from("studio_perf_posts").select("*").eq("user_id", u).gte("published_at", since).order("published_at", { ascending: false }).limit(400),
    sb.from("studio_perf_accounts").select("*").eq("user_id", u),
    sb.from("studio_perf_snapshots").select("platform,day,followers,views_total").eq("user_id", u).gte("day", new Date(now - (range + 2) * 86400_000).toISOString().slice(0, 10)),
  ]);
  if (posts.error) throw posts.error;
  const rows = (posts.data ?? []) as any[];
  const analysis = analyze(rows, (snaps.data ?? []) as any[], { range_days: range, now, offset_min: offsetMin, platform });
  const keys = rows.map((r) => r.thumb_key).filter(Boolean);
  const signed = keys.length ? await sb.storage.from("studio-outputs").createSignedUrls([...new Set(keys)] as string[], 3600) : { data: [] as any[] };
  const byKey = new Map(((signed.data ?? []) as any[]).filter((x) => !x.error).map((x) => [x.path, x.signedUrl]));
  const thumbs = new Map(rows.filter((r) => r.thumb_key && byKey.has(r.thumb_key)).map((r) => [r.id, byKey.get(r.thumb_key)!]));
  return { analysis, rows, accounts: (accounts.data ?? []) as any[], snapshots: (snaps.data ?? []) as any[], thumbs };
}

export async function latestInsight(sb: SupabaseClient, u: string, scope: string, range: number): Promise<{ body: Insight; created_at: string; input_hash: string } | null> {
  const r = await sb.from("studio_perf_insights").select("body,created_at,input_hash").eq("user_id", u).eq("scope", scope).eq("range_days", range).order("created_at", { ascending: false }).limit(1);
  return ((r.data ?? []) as any[])[0] ?? null;
}

/** The brief and the prompts the chat uses, from the last 28 days across every linked network. */
const chatCache = new Map<string, { at: number; v: { brief: string[]; suggestions: Array<{ label: string; prompt: string }> } }>();
export async function performanceForChat(sb: SupabaseClient, u: string): Promise<{ brief: string[]; suggestions: Array<{ label: string; prompt: string }> }> {
  const hit = chatCache.get(u);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const v = await performanceForChatUncached(sb, u);
  chatCache.set(u, { at: Date.now(), v });
  return v;
}
async function performanceForChatUncached(sb: SupabaseClient, u: string): Promise<{ brief: string[]; suggestions: Array<{ label: string; prompt: string }> }> {
  try {
    const prof = await sb.from("studio_social_profiles").select("timezone").eq("user_id", u).maybeSingle();
    const offset = Number(prof.data?.timezone ?? 0) || 0;
    const { analysis } = await loadPerformance(sb, u, 28, null, offset);
    if (!analysis.posts.length) return { brief: [], suggestions: [] };
    const ins = await latestInsight(sb, u, "all", 28);
    return { brief: chatBrief(analysis, ins?.body ?? null), suggestions: suggestionsFrom(analysis, ins?.body ?? null) };
  } catch { return { brief: [], suggestions: [] }; }
}

