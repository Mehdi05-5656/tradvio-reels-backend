// Actions: what a YES releases (PLAN.md section 4). Each builder asks the real routes what the request would do,
// then stores the exact requests, the credits and the question. The question is written HERE, by code, from what is
// stored; the AI never words it. The executor re-checks what the action depends on right before it acts, and stops
// if anything changed.
import { randomUUID } from "node:crypto";
import type { Api, Reply } from "./clone8.js";
import { setPending, howToAnswer, spendRoom, type Check, type Pending, type PendingStore, type Spend, type Step } from "./gate.js";
import { toolName } from "./account.js";

export class ActionError extends Error { constructor(public code: string, message: string) { super(message); } }
export type Ctx = { api: Api; store: PendingStore; spend: Spend | undefined; now: number; timezone: string; dailyCredits: number; maxActionCredits: number; rand?: () => number;
  /** a library file's name by its id, from the account's own records (never from the AI) */
  nameOf?: (assetId: string) => string | null;
  /** what the person said lately, so a "this is mine to use" can be checked against their own words */
  recentUserText: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (v: unknown, n: number) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
export const today = (now: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
export function when(iso: string | number, tz: string, now = Date.now()): string {
  const d = new Date(iso), day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  const dd = day.format(d), t0 = day.format(new Date(now)), t1 = day.format(new Date(now + 86400_000));
  const label = dd === t0 ? "today" : dd === t1 ? "tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return `${label} ${t}`;
}
const refusal = (r: Reply): string => String(r.json?.detail ?? r.json?.message ?? r.json?.error ?? `Clone8 answered ${r.status}`);
const BIG_POSTS = 10, BIG_CREDITS = 500;

/** Tools that need the person's own word that the video is theirs to use, and the words that count as that. */
const NEEDS_RIGHTS = new Set(["stunts", "reshoot", "import", "kage"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export function saidByPerson(statement: string, recent: string[]): boolean {
  const s = norm(statement);
  return s.length >= 6 && recent.some((t) => norm(t).includes(s));
}

function put(ctx: Ctx, p: { kind: string; body: string; steps: Step[]; checks: Check[]; credits: number; posts: number; meta?: Record<string, any> }): Pending {
  const big = p.posts > BIG_POSTS || p.credits > BIG_CREDITS;
  const pending = setPending(ctx.store, { id: randomUUID(), kind: p.kind, question: "", steps: p.steps, checks: p.checks, credits: p.credits, posts: p.posts, count: big ? (p.posts > BIG_POSTS ? p.posts : p.credits) : null, meta: p.meta }, ctx.now, ctx.rand);
  pending.question = `${p.body}\n${howToAnswer(pending)}`;
  return pending;
}

/** What a job will do, line by line, read from the settings that will be sent (so the person approves the real thing:
 *  which video, which ending at which second, who plays whom, which words). Written by code from the stored request. */
export function jobDetails(tool: string, assetId: string | null, o: Record<string, any>, nameOf: (id: string) => string | null = () => null): string[] {
  const lines: string[] = [], name = (id: unknown) => (typeof id === "string" && UUID.test(id) ? nameOf(id) : null);
  const stem = (n: string) => n.replace(/\.[a-z0-9]{2,4}$/i, "");
  if (assetId) lines.push(`Video: "${short(stem(name(assetId) ?? "the file you picked"), 70)}"`);
  if (typeof o.url === "string") lines.push(`From: ${short(o.url, 120)}`);
  const who = (m: any) => (m?.character_asset_id ? `your character "${short(stem(name(m.character_asset_id) ?? "the picture you picked"), 50)}"` : m?.character ? `the preset ${short(m.character, 20)}` : "");
  if (Array.isArray(o.cast) && o.cast.length) lines.push(`Who plays whom: ${o.cast.map((m: any) => `${short(m?.label ?? "person", 30)} → ${who(m)}`).join("; ")}`);
  else if (who(o)) lines.push(`Played by: ${who(o)}`);
  if (Array.isArray(o.targets) && o.targets.length) lines.push(`Only these people change: ${o.targets.map((t: any) => short(t, 30)).join(", ")}`);
  if (Array.isArray(o.gags)) for (const g of o.gags.slice(0, 6)) lines.push(`At ${Number(g?.at) || 0} s: ${short(g?.title, 50)} (${short(g?.prompt, 140)})`);
  if (Array.isArray(o.shots)) lines.push(`${o.shots.filter((x: any) => !x?.keep).length} of ${o.shots.length} shots changed`);
  if (o.look && typeof o.look === "object") lines.push(`Look: ${Object.entries(o.look).filter(([, v]) => v).map(([k, v]) => `${k} ${short(v, 30)}`).join(", ")}`);
  const words = o.script ?? o.topic ?? o.brief ?? o.prompt ?? o.params?.prompt;
  if (words) lines.push(`${o.script ? "Script" : "Words"}: "${short(words, 200)}"`);
  const bits: string[] = [];
  if (o.minutes) bits.push(`${o.minutes} min`); if (o.seconds && !assetId) bits.push(`${o.seconds} s`);
  if (o.count) bits.push(`up to ${o.count} clips`); if (o.copies) bits.push(`${o.copies} copies`);
  if (o.scope && o.scope !== "all") bits.push(String(o.scope).replace("latest_", "the latest ").replace(/(\d+)$/, "$1 min"));
  for (const k of ["length", "format", "quality", "style", "style_name", "engine", "mode", "genre", "shape", "voice", "model", "speed", "purpose", "strictness", "framing"]) if (typeof o[k] === "string" || typeof o[k] === "number") bits.push(`${k.replace("_name", "")} ${short(o[k], 24)}`);
  if (o.captions) bits.push("captions on");
  if (Array.isArray(o.hooks) && Array.isArray(o.looks)) bits.push(`${o.hooks.length} openings × ${o.looks.length} looks`);
  if (Array.isArray(o.items)) bits.push(`${o.items.length} video${o.items.length === 1 ? "" : "s"}`);
  if (Array.isArray(o.links)) bits.push(`${o.links.length} links`);
  if (bits.length) lines.push(bits.join(" · "));
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// Making: any job tool, priced by the same route the website uses
// ---------------------------------------------------------------------------------------------------
export async function prepareJob(ctx: Ctx, a: { tool: string; asset_id?: string | null; from_result?: { job_id: string; output_key: string } | null; options?: Record<string, any>; rights_in_their_words?: string | null }): Promise<Pending> {
  const tool = String(a.tool ?? ""), options = { ...(a.options ?? {}) };
  if (!/^[a-z_]{3,30}$/.test(tool)) throw new ActionError("bad_tool", "Name the job tool from the recipe");
  if (NEEDS_RIGHTS.has(tool)) {
    // their word, in their words: the AI cannot supply it for them
    if (!a.rights_in_their_words || !saidByPerson(a.rights_in_their_words, ctx.recentUserText)) throw new ActionError("rights_needed", "Ask the person to say, in their own words, that this video is theirs to use (or that they have permission). Then pass exactly what they wrote as rights_in_their_words.");
    options.rights = true; if (tool === "import") options.rights_confirmed = true;
  } else { delete options.rights; delete options.rights_confirmed; }
  let assetId = a.asset_id && UUID.test(a.asset_id) ? a.asset_id : null;
  const steps: Step[] = [];
  // a finished result of another tool: it becomes a library file first, and the job starts on that file
  if (!assetId && a.from_result?.job_id && a.from_result.output_key) {
    const r = await ctx.api.call("POST", `/api/studio/jobs/${a.from_result.job_id}/asset`, { key: a.from_result.output_key }, { timeoutMs: 180_000 });
    if (r.status !== 200 || !r.json?.asset?.id) throw new ActionError("result_not_usable", refusal(r));
    assetId = r.json.asset.id;
  }
  const quoteBody = { tool, asset_id: assetId, options };
  const [q, me] = await Promise.all([ctx.api.call("POST", "/api/studio/quote", quoteBody), ctx.api.call("GET", "/api/studio/me")]);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.credits ?? q.json?.quote?.credits), summary = String(q.json?.summary ?? q.json?.quote?.summary ?? toolName({ tool, options }));
  if (!Number.isFinite(credits)) throw new ActionError("quote_unreadable", "The price did not come back; try again");
  const balance = me.status === 200 ? Number(me.json?.balance) : NaN;
  if (me.status === 200 && !me.json?.active && !me.json?.owner_pass) throw new ActionError("plan_needed", "Making videos needs a plan: https://app.clone8.io/#studio/pricing");
  if (Number.isFinite(balance) && balance < credits) throw new ActionError("not_enough_credits", `This needs ${credits} credits and the balance is ${balance}. More credits: https://app.clone8.io/#studio/pricing`);
  if (credits > ctx.maxActionCredits) throw new ActionError("over_action_limit", `This is ${credits} credits, over the ${ctx.maxActionCredits} one action may spend by text in this test. Start it in the app, or raise the limit.`);
  const room = spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits);
  if (credits > room) throw new ActionError("over_daily_limit", `This is ${credits} credits and ${room} are left of today's ${ctx.dailyCredits} by text. Start it in the app, or raise the limit.`);
  steps.push({ method: "POST", path: "/api/studio/jobs", body: quoteBody, save: "job", label: summary });
  const estimate = tool === "clips" ? " (the most it can cost: you pay only for the clips made)" : "";
  return put(ctx, { kind: "job", steps, credits, posts: 0, checks: [{ kind: "price_at_most", quote: quoteBody, credits }], meta: { tool, summary },
    body: [`${summary}.`, ...jobDetails(tool, assetId, options, ctx.nameOf), `${credits} credits${estimate}.${Number.isFinite(balance) ? ` Balance ${balance} → ${balance - credits}.` : ""}`].join("\n") });
}

// ---------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------
type Account = { id?: string; platform: string; username: string | null; refresh_required?: boolean };
const handle = (a: Account) => `${a.platform}${a.username ? ` @${a.username}` : ""}`;

export async function preparePost(ctx: Ctx, a: { videos: Array<{ asset_id?: string; job_id?: string; output_key?: string; label?: string }>; account_ids?: string[]; group?: string | null; platforms?: string[]; caption?: string | null; captions_by_account?: Record<string, string>;
  when?: "now" | string | null; minutes_from_yes?: number | null; spacing_minutes?: number | null; youtube_title?: string | null; youtube_visibility?: string | null }): Promise<Pending> {
  const videos = (Array.isArray(a.videos) ? a.videos : []).filter((v) => (v.asset_id && UUID.test(v.asset_id)) || (v.job_id && UUID.test(v.job_id) && v.output_key)).slice(0, 50);
  if (!videos.length) throw new ActionError("no_video", "Say which video: a library file (asset_id) or a result (job_id and output_key) from find or item");
  const s = await ctx.api.call("GET", "/api/studio/social");
  if (s.status !== 200 || !s.json?.enabled) throw new ActionError("posting_off", "Posting is not available right now");
  const linked: Account[] = (s.json.accounts ?? []).filter((x: Account) => x.id);
  if (!linked.length) throw new ActionError("nothing_linked", "No social account is linked yet. Link one on the Post page: https://app.clone8.io/#studio/publish?accounts");
  // exact accounts are stored (a group is opened into its accounts now, not when it runs)
  let ids: string[] = [];
  if (a.group) {
    const want = a.group.trim().toLowerCase(), groups: any[] = s.json.groups ?? [];
    const g = groups.find((x) => String(x.name).toLowerCase() === want) ?? groups.find((x) => String(x.name).toLowerCase().includes(want));
    if (!g) throw new ActionError("no_such_group", `No posting group is called "${a.group}". Groups: ${groups.map((x) => x.name).join(", ") || "none yet"}`);
    ids = [...(g.account_ids ?? [])];
    if (g.missing) throw new ActionError("group_incomplete", `"${g.name}" has ${g.missing} account(s) that are no longer linked. Relink them on the Post page, or name the accounts.`);
  }
  for (const id of a.account_ids ?? []) if (!ids.includes(id)) ids.push(id);
  for (const p of a.platforms ?? []) { const of = linked.filter((x) => x.platform === p); if (of.length === 1 && !ids.includes(of[0].id!)) ids.push(of[0].id!); else if (of.length > 1 && !of.some((x) => ids.includes(x.id!))) throw new ActionError("which_account", `There are ${of.length} ${p} accounts linked (${of.map(handle).join(", ")}). Ask which one.`); else if (!of.length) throw new ActionError("not_linked", `No ${p} account is linked. Linked: ${linked.map(handle).join(", ")}`); }
  const accounts = ids.map((id) => linked.find((x) => x.id === id)).filter(Boolean) as Account[];
  if (!accounts.length || accounts.length !== ids.length) throw new ActionError("which_account", `Say which accounts. Linked: ${linked.map((x) => `${handle(x)} (${x.id})`).join(", ")}`);
  const relink = accounts.filter((x) => x.refresh_required);
  if (relink.length) throw new ActionError("needs_relink", `${relink.map(handle).join(", ")} must be linked again first: https://app.clone8.io/#studio/publish?accounts`);
  const caption = String(a.caption ?? "").slice(0, 5000);
  let at: number | null = null, rel: number | null = null;
  if (a.minutes_from_yes != null && Number(a.minutes_from_yes) >= 5) rel = Math.round(Number(a.minutes_from_yes));
  else if (a.when && a.when !== "now") { at = Date.parse(a.when); if (!Number.isFinite(at)) throw new ActionError("bad_time", "Give the time as a full date and time with its offset (ISO 8601)"); if (at - ctx.now < 12 * 60_000) throw new ActionError("too_soon", "That time is under 12 minutes away. Post it now, or pick a later time (a schedule must be at least 5 minutes ahead when you confirm)."); }
  const gap = Math.min(Math.max(Math.round(Number(a.spacing_minutes ?? 0)) || 0, 0), 10080);
  const body: Record<string, any> = { items: videos.map((v) => (v.asset_id ? { asset_id: v.asset_id } : { job_id: v.job_id, output_key: v.output_key })), accounts: accounts.map((x) => x.id), caption, via: "text-test",
    ...(a.captions_by_account && Object.keys(a.captions_by_account).length ? { captions_by_account: a.captions_by_account } : {}), ...(gap ? { spacing_minutes: gap } : {}),
    ...(a.youtube_title || a.youtube_visibility ? { options: { youtube: { ...(a.youtube_title ? { title: String(a.youtube_title).slice(0, 100) } : {}), ...(["public", "unlisted", "private"].includes(String(a.youtube_visibility)) ? { visibility: a.youtube_visibility } : {}) } } } : {}),
    ...(at ? { schedule_at: new Date(at).toISOString() } : {}) };
  const whenWords = rel ? `${rel} minutes after your YES` : at ? when(at, ctx.timezone, ctx.now) : "now";
  const names = videos.map((v, i) => `"${short(v.label ?? `video ${i + 1}`, 50)}"`);
  const lines = [
    `${at || rel ? "Schedule" : "Post"} ${videos.length === 1 ? names[0] : `${videos.length} videos (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""})`}`,
    `to ${accounts.map(handle).join(", ")}`, `${at || rel ? "for" : ""} ${whenWords}${videos.length > 1 && gap ? `, ${gap} minutes apart` : ""}.`.trim(),
    caption ? `Caption: "${short(caption, 300)}"` : "No caption.",
    ...Object.entries(a.captions_by_account ?? {}).map(([id, c]) => `${handle(accounts.find((x) => x.id === id) ?? { platform: id, username: null })}: "${short(c, 200)}"`),
    at || rel ? "A time can shift a little later to keep 30 minutes between posts on one account." : "It can't be pulled back once it is out.",
  ];
  return put(ctx, { kind: "post", credits: 0, posts: videos.length * accounts.length, steps: [{ method: "POST", path: "/api/studio/social/posts", body, save: "posts", label: "post" }],
    checks: [{ kind: "accounts_linked", account_ids: accounts.map((x) => x.id!) }], meta: { minutes_from_yes: rel }, body: lines.join("\n") });
}

async function waitingPost(ctx: Ctx, id: string): Promise<any> {
  if (!UUID.test(id)) throw new ActionError("post_not_found", "Use the post's id from find (p:<id>) or the posts lookup");
  const r = await ctx.api.call("GET", "/api/studio/social/posts");
  const p = (r.json?.posts ?? []).find((x: any) => x.id === id);
  if (!p) throw new ActionError("post_not_found", "No such post");
  return p;
}
const postWho = (p: any): string => (Array.isArray(p.options?.accounts) && p.options.accounts.length ? p.options.accounts.map((x: any) => `${x.platform}${x.username ? ` @${x.username}` : ""}`).join(", ") : (p.platforms ?? []).join(", "));

export async function preparePostChange(ctx: Ctx, a: { post_id: string; new_time?: string | null; minutes_from_yes?: number | null; caption?: string | null; youtube_title?: string | null }): Promise<Pending> {
  const p = await waitingPost(ctx, a.post_id);
  if (p.status !== "scheduled" && p.status !== "queued") throw new ActionError("not_editable", "Only a post that has not gone out can be changed");
  const own = (Array.isArray(p.options?.accounts) ? p.options.accounts : []).filter((x: any) => x?.own && x?.caption);
  const lines: string[] = [], body: Record<string, any> = {}; let rel: number | null = null;
  if (a.minutes_from_yes != null) { rel = Math.max(6, Math.round(Number(a.minutes_from_yes))); lines.push(`Move it from ${p.schedule_at ? when(p.schedule_at, ctx.timezone, ctx.now) : "its time"} to ${rel} minutes after your YES.`); }
  else if (a.new_time) { const at = Date.parse(a.new_time); if (!Number.isFinite(at)) throw new ActionError("bad_time", "Give the new time as a full date and time with its offset (ISO 8601)"); if (at - ctx.now < 12 * 60_000) throw new ActionError("too_soon", "That time is under 12 minutes away; the earliest a post can move to is 5 minutes after you confirm. Use minutes_from_yes instead."); body.schedule_at = new Date(at).toISOString(); lines.push(`Move it from ${p.schedule_at ? when(p.schedule_at, ctx.timezone, ctx.now) : "its time"} to ${when(at, ctx.timezone, ctx.now)}.`); }
  if (typeof a.caption === "string") {
    body.caption = a.caption.slice(0, 5000);
    lines.push(`New caption: "${short(a.caption, 400)}"`);
    if (own.length) lines.push(`${own.map((x: any) => `${x.platform}${x.username ? ` @${x.username}` : ""}`).join(", ")} ${own.length === 1 ? "has its" : "have their"} own caption, which stays as it is (that cannot be changed after scheduling yet).`);
  }
  if (a.youtube_title) { body.youtube_title = String(a.youtube_title).slice(0, 100); lines.push(`New YouTube title: "${short(a.youtube_title, 100)}"`); }
  if (!lines.length) throw new ActionError("nothing_to_change", "Say what to change: the time, the caption or the YouTube title");
  return put(ctx, { kind: "post_change", credits: 0, posts: 1, meta: { minutes_from_yes: rel },
    steps: [{ method: "PATCH", path: `/api/studio/social/posts/${p.id}`, body, save: "post", label: "change" }], checks: [{ kind: "post_unchanged", post_id: p.id, updated_at: p.updated_at }],
    body: [`Change the post to ${postWho(p)} ("${short(p.caption, 60)}"):`, ...lines].join("\n") });
}

export async function preparePostCancel(ctx: Ctx, a: { post_ids: string[] }): Promise<Pending> {
  const ids = [...new Set((a.post_ids ?? []).filter((x) => UUID.test(x)))].slice(0, 50);
  if (!ids.length) throw new ActionError("post_not_found", "Say which posts (their ids from find or the posts lookup)");
  const r = await ctx.api.call("GET", "/api/studio/social/posts");
  const rows = ids.map((id) => (r.json?.posts ?? []).find((x: any) => x.id === id)).filter(Boolean);
  if (rows.length !== ids.length) throw new ActionError("post_not_found", "One of those posts was not found");
  const bad = rows.filter((p: any) => p.status !== "scheduled" && p.status !== "queued");
  if (bad.length) throw new ActionError("not_cancelable", "Only posts that have not gone out can be cancelled");
  return put(ctx, { kind: "post_cancel", credits: 0, posts: rows.length,
    steps: rows.map((p: any) => ({ method: "DELETE" as const, path: `/api/studio/social/posts/${p.id}`, label: "cancel" })), checks: rows.map((p: any) => ({ kind: "post_unchanged" as const, post_id: p.id, updated_at: p.updated_at })),
    body: [`Cancel ${rows.length === 1 ? "this scheduled post" : `these ${rows.length} scheduled posts`}:`, ...rows.slice(0, 12).map((p: any) => `· ${p.schedule_at ? when(p.schedule_at, ctx.timezone, ctx.now) : "queued"} · ${postWho(p)} · "${short(p.caption, 50)}"`), rows.length > 12 ? `… and ${rows.length - 12} more` : "", "The videos stay in your library."].filter(Boolean).join("\n") });
}

export async function preparePostRetry(ctx: Ctx, a: { post_id: string }): Promise<Pending> {
  const p = await waitingPost(ctx, a.post_id);
  if (p.status !== "failed" && p.status !== "partial") throw new ActionError("not_retryable", "Only a post that failed can be retried");
  const failed = (p.results ?? []).filter((x: any) => x.status === "failed");
  return put(ctx, { kind: "post_retry", credits: 0, posts: Math.max(1, failed.length), steps: [{ method: "POST", path: `/api/studio/social/posts/${p.id}/retry`, body: {}, label: "retry" }], checks: [{ kind: "post_unchanged", post_id: p.id, updated_at: p.updated_at }],
    body: `Send "${short(p.caption, 60)}" again to the accounts where it failed (${failed.map((x: any) => x.platform).join(", ") || postWho(p)}). Where it already went out it is not sent twice.` });
}

export async function prepareJobCancel(ctx: Ctx, a: { job_id: string }): Promise<Pending> {
  if (!UUID.test(a.job_id)) throw new ActionError("job_not_found", "Use the job's id");
  const r = await ctx.api.call("GET", `/api/studio/jobs/${a.job_id}`);
  if (r.status !== 200) throw new ActionError("job_not_found", "No such job");
  const j = r.json.job;
  if (j.status !== "queued") throw new ActionError("not_cancelable", j.status === "running" ? "It is already being made; a run that has started cannot be stopped from here yet." : `It is ${j.status}; there is nothing to cancel.`);
  return put(ctx, { kind: "job_cancel", credits: 0, posts: 0, steps: [{ method: "POST", path: `/api/studio/jobs/${j.id}/cancel`, body: {}, label: "cancel" }], checks: [], body: `Cancel the waiting ${toolName(j)} run? Its ${j.credits_reserved ?? 0} credits come back.` });
}

export async function prepareCaptionRead(ctx: Ctx, a: { videos: Array<{ asset_id?: string; job_id?: string; output_key?: string }>; platforms?: string[]; note?: string | null; line?: string | null }): Promise<Pending> {
  const body = { videos: (a.videos ?? []).slice(0, 60), platforms: a.platforms, note: a.note ?? undefined, line: a.line ?? undefined };
  if (!body.videos.length) throw new ActionError("no_video", "Say which videos to read");
  const q = await ctx.api.call("POST", "/api/studio/social/captions/quote", body);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.credits ?? 0);
  if (credits > Math.min(ctx.maxActionCredits, spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits))) throw new ActionError("over_daily_limit", `Reading these is ${credits} credits, over what is left for today by text.`);
  return put(ctx, { kind: "caption_read", credits, posts: 0, steps: [{ method: "POST", path: "/api/studio/social/captions/batch", body, save: "batch", label: "read" }], checks: [],
    body: `Watch ${body.videos.length === 1 ? "this video" : `these ${body.videos.length} videos`} once so captions can be written from ${body.videos.length === 1 ? "it" : "them"}.\n${credits} credits (videos already watched are free).` });
}

export async function prepareAutomationRun(ctx: Ctx, a: { automation_id: string; inputs?: Record<string, any> }): Promise<Pending> {
  if (!UUID.test(a.automation_id)) throw new ActionError("automation_not_found", "Use the automation's id from the automations lookup");
  const body = { inputs: a.inputs ?? {} };
  const q = await ctx.api.call("POST", `/api/studio/automations/${a.automation_id}/quote`, body);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.total_credits ?? q.json?.credits ?? 0), name = String(q.json?.name ?? q.json?.automation?.name ?? "the automation");
  if (credits > Math.min(ctx.maxActionCredits, spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits))) throw new ActionError("over_daily_limit", `That run is ${credits} credits, over what is left for today by text.`);
  return put(ctx, { kind: "automation_run", credits, posts: 0, steps: [{ method: "POST", path: `/api/studio/automations/${a.automation_id}/run`, body, save: "run", label: name }], checks: [], body: `Run "${short(name, 60)}".\nAbout ${credits} credits.` });
}

// ---------------------------------------------------------------------------------------------------
// The executor: runs a claimed action, after checking that what it depends on has not changed
// ---------------------------------------------------------------------------------------------------
export type Outcome = { ok: boolean; text: string; job_id?: string; collection_id?: string; credits?: number; post_ids?: string[]; calls: Array<{ method: string; path: string; status: number }> };

export async function execute(api: Api, p: Pending, o: { now: number; timezone: string }): Promise<Outcome> {
  const calls: Outcome["calls"] = [];
  for (const c of p.checks) {
    if (c.kind === "post_unchanged") {
      const r = await api.call("GET", "/api/studio/social/posts");
      const row = (r.json?.posts ?? []).find((x: any) => x.id === c.post_id);
      if (!row) return { ok: false, text: "That post is no longer there, so nothing was changed.", calls };
      if (row.updated_at !== c.updated_at) return { ok: false, text: "That post was changed somewhere else since I asked, so I left it alone. Ask me again and I'll show it as it is now.", calls };
    } else if (c.kind === "price_at_most") {
      const r = await api.call("POST", "/api/studio/quote", c.quote);
      const now = Number(r.json?.credits ?? r.json?.quote?.credits);
      if (r.status !== 200) return { ok: false, text: `It can't start any more: ${refusal(r)}. Nothing was spent.`, calls };
      if (!(now <= c.credits)) return { ok: false, text: `The price is now ${now} credits, more than the ${c.credits} you agreed to, so I did not start it. Ask again to see the new price.`, calls };
    } else if (c.kind === "accounts_linked") {
      const r = await api.call("GET", "/api/studio/social");
      const have = new Set((r.json?.accounts ?? []).filter((x: any) => !x.refresh_required).map((x: any) => x.id));
      const gone = c.account_ids.filter((id) => !have.has(id));
      if (gone.length) return { ok: false, text: "One of those accounts is no longer linked, so nothing was posted. Link it again on the Post page and ask me again.", calls };
    }
  }
  const out: Outcome = { ok: true, text: "", calls };
  for (const s of p.steps) {
    let body = s.body;
    // "N minutes after the YES" becomes a clock time only now
    if (p.meta?.minutes_from_yes && (p.kind === "post" || p.kind === "post_change")) body = { ...body, schedule_at: new Date(o.now + Number(p.meta.minutes_from_yes) * 60_000).toISOString() };
    const r = await api.act(p.id, s.method, s.path, body, { timeoutMs: 180_000 });
    calls.push({ method: s.method, path: s.path, status: r.status });
    if (r.status >= 400) {
      const done = calls.length - 1;
      return { ...out, ok: false, text: `${done ? `${done} of ${p.steps.length} went through, then it stopped` : "It did not go through"}: ${refusal(r)}${p.credits && !done ? " Nothing was spent." : ""}` };
    }
    if (p.kind === "job") { out.job_id = r.json?.job?.id; out.collection_id = r.json?.collection_id; out.credits = Number(r.json?.quote?.credits ?? p.credits); }
    if (p.kind === "post") {
      const posts: any[] = r.json?.posts ?? [];
      out.post_ids = posts.map((x) => x.id);
      const skipped: any[] = r.json?.skipped ?? [];
      const times = posts.filter((x) => x.schedule_at).map((x) => when(x.schedule_at, o.timezone, o.now));
      const failed = posts.filter((x) => x.status === "failed");
      out.text = [posts.length ? (times.length ? `Scheduled: ${[...new Set(times)].slice(0, 8).join(", ")}${times.length > 8 ? ", …" : ""}.` : "On its way. Each network takes a minute or two; I'll tell you when it's up.") : "Nothing was sent.",
        r.json?.queued ? `${r.json.queued} more are being sent in the background.` : "", failed.length ? `${failed.length} did not go out: ${short(failed[0].error, 120)}` : "", skipped.length ? `Left out: ${skipped.map((x) => `${x.platform ?? x.group ?? "an account"} (${x.reason})`).join(", ")}.` : ""].filter(Boolean).join(" ");
    }
    if (p.kind === "post_change") { const at = r.json?.post?.schedule_at; out.text = `Changed.${at ? ` It now goes out ${when(at, o.timezone, o.now)}.` : ""}`; }
  }
  if (!out.text) out.text = p.kind === "job" ? `Started: ${p.meta?.summary ?? "your run"}. I'll send it here when it's ready.` : p.kind === "post_cancel" ? `Cancelled ${p.steps.length === 1 ? "it" : `all ${p.steps.length}`}.` : p.kind === "job_cancel" ? "Cancelled; the credits are back." : p.kind === "caption_read" ? "Watching now; ask me for the captions in a minute." : "Done.";
  return out;
}
