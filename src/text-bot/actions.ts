// Actions: what a YES releases (PLAN.md section 4). Each builder asks the real routes what the request would do,
// then stores the exact requests, the credits and the question. The question is written HERE, by code, from what the
// server said and from the account's own records; nothing in it is worded or named by the AI. The executor re-checks
// what the action depends on right before it acts, and stops if anything changed.
import { randomUUID } from "node:crypto";
import type { Api, Reply } from "./routes.js";
import { setPending, howToAnswer, spendRoom, type Check, type Pending, type PendingStore, type Spend, type Step } from "./gate.js";
import { toolName } from "./account.js";
import { REPLY_NETWORKS } from "../social-zernio.js";

export class ActionError extends Error { constructor(public code: string, message: string) { super(message); } }
export type VideoRef = { asset_id?: string; job_id?: string; output_key?: string; /** this video's own time and caption (else the post's) */ when?: string | null; caption?: string | null };
export type Ctx = { api: Api; store: PendingStore; spend: Spend | undefined; now: number; timezone: string; dailyCredits: number; maxActionCredits: number; rand?: () => number;
  /** what the person TYPED lately (taps and system notes left out), so "this is mine to use" can be checked against their own words */
  recentUserText: string[];
  /** a library file's name by its id, from the account's own records (never from the AI) */
  nameOf?: (assetId: string) => string | null;
  /** a video's title from the account's own records; null when the account has no such video */
  titleOf?: (v: VideoRef) => string | null;
  /** the library file a captioned copy (or another derived file) was made from */
  parentOf?: (assetId: string) => string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One line, cut to n characters: nothing a setting holds can add a line to a question. */
const short = (v: unknown, n: number) => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const num = (v: unknown): number | null => { const n = Number(v); return typeof v !== "boolean" && v !== null && v !== "" && Number.isFinite(n) ? n : null; };
export const today = (now: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
export function when(iso: string | number, tz: string, now = Date.now()): string {
  const d = new Date(iso), day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  const dd = day.format(d), t0 = day.format(new Date(now)), t1 = day.format(new Date(now + 86400_000));
  const label = dd === t0 ? "today" : dd === t1 ? "tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return `${label} ${t}`;
}
const refusal = (r: Reply): string => short(r.json?.detail ?? r.json?.message ?? r.json?.error ?? `Clone8 answered ${r.status}`, 300);
const BIG_POSTS = 10, BIG_CREDITS = 500;
/** The longest caption that can be read in full in a question. Longer ones are posted from the app. */
export const CAPTION_MAX = 1500;

/** Tools that need the person's own word that the video is theirs to use. */
const NEEDS_RIGHTS = new Set(["stunts", "reshoot", "import", "kage"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Their word counts when they typed it themselves and it says what it must: that the video is theirs or allowed. */
export function saidByPerson(statement: string, recent: string[]): boolean {
  const s = norm(statement);
  if (s.length < 10 || !/\b(my|mine|our|ours|own|i filmed|i made|i shot|i recorded|permission|allowed|rights?|licen[cs]ed?)\b/.test(s)) return false;
  return recent.some((t) => norm(t).includes(s));
}

export const putPending = (ctx: Ctx, p: Parameters<typeof put>[1]): Pending => put(ctx, p);
function put(ctx: Ctx, p: { kind: string; body: string; steps: Step[]; checks: Check[]; credits: number; posts: number; meta?: Record<string, any>; own?: string[] }): Pending {
  const big = p.posts > BIG_POSTS || p.credits > BIG_CREDITS;
  const pending = setPending(ctx.store, { id: randomUUID(), kind: p.kind, question: "", steps: p.steps, checks: p.checks, credits: p.credits, posts: p.posts, count: big ? (p.posts > BIG_POSTS ? p.posts : p.credits) : null, meta: p.meta, own: p.own }, ctx.now, ctx.rand);
  pending.question = `${p.body}\n${howToAnswer(pending)}`;
  return pending;
}

// ---------------------------------------------------------------------------------------------------
// Making: any job tool, priced by the same route the website uses
// ---------------------------------------------------------------------------------------------------
const SCOPES: Record<string, string> = { latest_30: "the latest 30 minutes", latest_60: "the latest hour", latest_120: "the latest 2 hours", since: "what is new since the last run", range: "the part picked", all: "the whole stream" };
const WORDS = ["length", "format", "quality", "engine", "mode", "genre", "shape", "voice", "model", "purpose", "strictness", "framing", "style_name", "trend_name", "kind", "template", "language"];

/** What a job will do, line by line, from the settings the SERVER returned for it (what will really run), with the
 *  raw request only for what the server does not echo. Only known settings are printed, each on one line. */
export function jobDetails(tool: string, assetId: string | null, o: Record<string, any>, nameOf: (id: string) => string | null = () => null): { lines: string[]; own: string[] } {
  const lines: string[] = [], own: string[] = [];
  const stem = (n: string) => n.replace(/\.[a-z0-9]{2,4}$/i, "");
  const file = (id: unknown): string => { const n = typeof id === "string" && UUID.test(id) ? nameOf(id) : null; if (!n) return "a file from your library"; const t = short(stem(n), 70); own.push(t); return `"${t}"`; };
  const said = (v: unknown, n: number) => { const t = short(v, n); own.push(t); return `"${t}"`; };
  if (assetId) lines.push(`Video: ${file(assetId)}`);
  if (typeof o.url === "string") lines.push(`From: ${short(o.url, 140)}`);
  if (o.source && typeof o.source === "object" && (o.source.title || o.source.channel)) lines.push(`Source: ${said([o.source.channel, o.source.title].filter(Boolean).join(" · "), 100)}`);
  const who = (m: any) => (m?.character_asset_id ? `your character ${file(m.character_asset_id)}` : m?.character ? `the preset ${short(m.character, 20)}` : "");
  if (Array.isArray(o.cast) && o.cast.length) lines.push(`Who plays whom: ${o.cast.slice(0, 8).map((m: any) => `${short(m?.label ?? "person", 30)} → ${who(m)}`).join("; ")}`);
  else if (who(o)) lines.push(`Played by: ${who(o)}`);
  if (Array.isArray(o.targets) && o.targets.length) lines.push(`Only these people change: ${o.targets.slice(0, 6).map((t: any) => short(t, 30)).join(", ")}`);
  if (Array.isArray(o.gags)) for (const g of o.gags.slice(0, 6)) lines.push(`Ending at ${num(g?.at) ?? "?"} s: ${said(g?.title, 50)}: ${said(g?.prompt, 200)}`);
  if (Array.isArray(o.shots)) { const changed = o.shots.filter((x: any) => !x?.keep); lines.push(`${changed.length} of ${o.shots.length} shots changed${changed.length ? `: ${changed.slice(0, 6).map((x: any) => short(x?.title ?? x?.change ?? x?.kind ?? x?.look ?? x?.move ?? "a change", 40)).join("; ")}` : ""}`); }
  if (o.look && typeof o.look === "object") { const l = ["light", "place", "outfit"].filter((k) => o.look[k]).map((k) => `${k} ${short(o.look[k], 40)}`); if (l.length) lines.push(`Look: ${l.join(", ")}`); }
  if (Array.isArray(o.items) && o.items.length) lines.push(`Videos: ${o.items.slice(0, 5).map((x: any) => file(x?.asset_id)).join(", ")}${o.items.length > 5 ? ` and ${o.items.length - 5} more` : ""}`);
  if (o.inputs && typeof o.inputs === "object") { const ids = Object.values(o.inputs).flat().filter((x) => typeof x === "string" && UUID.test(x as string)); if (ids.length) lines.push(`Files used: ${ids.slice(0, 5).map(file).join(", ")}`); }
  if (Array.isArray(o.links) && o.links.length) lines.push(`${o.links.length} link${o.links.length === 1 ? "" : "s"}: ${o.links.slice(0, 3).map((l: any) => short(l, 80)).join(", ")}${o.links.length > 3 ? ", …" : ""}`);
  const inner = o.story ?? o.motivation ?? o.longform ?? {};
  const words = o.script ?? inner.script ?? o.topic ?? inner.topic ?? o.brief ?? inner.prompt ?? o.prompt ?? o.params?.prompt;
  if (words) lines.push(`${o.script ?? inner.script ? "Script" : "Words"}: ${said(words, 300)}`);
  const bits: string[] = [];
  const minutes = num(o.minutes ?? inner.minutes), seconds = num(o.seconds ?? inner.seconds), count = num(o.count), copies = num(o.copies), speed = num(o.speed);
  if (minutes) bits.push(`${minutes} min`); if (seconds && !assetId) bits.push(`${seconds} s`);
  if (count) bits.push(`up to ${count} clips`); if (copies) bits.push(`${copies} copies`); if (speed) bits.push(`speed ${speed}`);
  const scope = o.part?.scope ?? o.scope; if (typeof scope === "string" && SCOPES[scope]) bits.push(SCOPES[scope]);
  for (const k of WORDS) { const v = o[k] ?? inner[k]; if (typeof v === "string" && v) bits.push(`${k.replace("_name", "")} ${short(v, 24)}`); }
  const style = o.style?.name ?? o.style?.id ?? (typeof o.style === "string" ? o.style : null); if (style) bits.push(`style ${short(style, 24)}`);
  if (o.captions) bits.push("captions on");
  if (Array.isArray(o.hooks) && Array.isArray(o.looks)) bits.push(`${o.hooks.length} openings × ${o.looks.length} looks`);
  if (bits.length) lines.push(bits.join(" · "));
  return { lines, own };
}

export async function prepareJob(ctx: Ctx, a: { tool: string; asset_id?: string | null; from_result?: { job_id: string; output_key: string } | null; options?: Record<string, any>; rights_in_their_words?: string | null }): Promise<Pending> {
  const tool = String(a.tool ?? ""), options = { ...(a.options ?? {}) };
  if (!/^[a-z_]{3,30}$/.test(tool)) throw new ActionError("bad_tool", "Name the job tool from the recipe");
  // a library picture named where a preset's name belongs: put it where it belongs, so a slip in which field was
  // used cannot start the wrong thing or a refused one
  const tidy = (m: any) => { if (m && typeof m === "object" && typeof m.character === "string" && UUID.test(m.character)) { m.character_asset_id = m.character_asset_id ?? m.character; delete m.character; } };
  tidy(options); if (Array.isArray(options.cast)) options.cast = options.cast.map((m: any) => { const c = { ...m }; tidy(c); return c; });
  let rights: string | null = null;
  if (NEEDS_RIGHTS.has(tool)) {
    // their word, in their words: the AI cannot supply it for them, and the question shows it back
    if (!a.rights_in_their_words || !saidByPerson(a.rights_in_their_words, ctx.recentUserText)) throw new ActionError("rights_needed", "Ask the person to say, in their own words, that this video is theirs to use (or that they have permission), in a typed message. Then pass exactly what they wrote as rights_in_their_words.");
    rights = short(a.rights_in_their_words, 160);
    options.rights = true; if (tool === "import") options.rights_confirmed = true;
  } else { delete options.rights; delete options.rights_confirmed; }
  let assetId = a.asset_id && UUID.test(a.asset_id) ? a.asset_id : null;
  // a finished result of another tool: it becomes a library file first, and the job starts on that file
  if (!assetId && a.from_result?.job_id && a.from_result.output_key) {
    if (!UUID.test(a.from_result.job_id)) throw new ActionError("result_not_usable", "Use the job id from item");
    const r = await ctx.api.call("POST", `/api/studio/jobs/${a.from_result.job_id}/asset`, { key: a.from_result.output_key }, { timeoutMs: 180_000 });
    if (r.status !== 200 || !r.json?.asset?.id) throw new ActionError("result_not_usable", refusal(r));
    assetId = r.json.asset.id;
  }
  const quoteBody = { tool, asset_id: assetId, options };
  const [q, me] = await Promise.all([ctx.api.call("POST", "/api/studio/quote", quoteBody), ctx.api.call("GET", "/api/studio/me")]);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.credits ?? q.json?.quote?.credits), summary = short(q.json?.summary ?? q.json?.quote?.summary ?? "", 160);
  if (!Number.isFinite(credits) || credits < 0) throw new ActionError("quote_unreadable", "The price did not come back; try again");
  // the server's own cleaned settings say what will really run; the request fills in only what it does not echo
  const served = q.json?.options ?? q.json?.quote?.options, real = { ...options, ...(served && typeof served === "object" ? served : {}) };
  const name = toolName({ tool: String(q.json?.tool ?? tool), options: real });
  const balance = me.status === 200 ? Number(me.json?.balance) : NaN;
  if (me.status === 200 && !me.json?.active && !me.json?.owner_pass) throw new ActionError("plan_needed", "Making videos needs a plan: https://app.clone8.io/#studio/pricing");
  if (Number.isFinite(balance) && balance < credits) throw new ActionError("not_enough_credits", `This needs ${credits} credits and the balance is ${balance}. More credits: https://app.clone8.io/#studio/pricing`);
  if (credits > ctx.maxActionCredits) throw new ActionError("over_action_limit", `This is ${credits} credits, over the ${ctx.maxActionCredits} one action may spend by text. Start it in the app.`);
  const room = spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits);
  if (credits > room) throw new ActionError("over_daily_limit", `This is ${credits} credits and ${room} are left of today's ${ctx.dailyCredits} by text. Start it in the app, or raise the limit.`);
  const d = jobDetails(tool, assetId, real, ctx.nameOf);
  const estimate = tool === "clips" ? " at most (you pay only for the clips made)" : "";
  // an auto top-up the person set up themselves fires as on the website; the question says so before they agree
  const auto = me.json?.topup?.auto, after = balance - credits;
  const topup = auto?.enabled && Number.isFinite(after) && after < Number(auto.below) ? `Your auto top-up is on: this takes the balance under ${auto.below}, so your card is charged $${auto.usd} as usual.` : "";
  return put(ctx, { kind: "job", credits, posts: 0, own: [...d.own, ...(rights ? [rights] : [])], checks: [{ kind: "price_at_most", quote: quoteBody, credits }], meta: { tool, summary: name },
    steps: [{ method: "POST", path: "/api/studio/jobs", body: quoteBody, save: "job", label: name }],
    body: [`Start ${name}${summary ? ` (${summary})` : ""}.`, ...d.lines, ...(rights ? [`You said it is yours to use: "${rights}"`] : []), `Cost: ${credits} credit${credits === 1 ? "" : "s"}${estimate}.${Number.isFinite(balance) ? ` Balance ${balance.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}.` : ""}`, topup].filter(Boolean).join("\n") });
}

// ---------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------
type Account = { id?: string; platform: string; username: string | null; refresh_required?: boolean };
const handle = (a: Account) => `${a.platform}${a.username ? ` @${a.username}` : ""}`;

export async function preparePost(ctx: Ctx, a: { videos: VideoRef[]; account_ids?: string[]; group?: string | null; platforms?: string[]; caption?: string | null; captions_by_account?: Record<string, string>;
  when?: "now" | string | null; minutes_from_yes?: number | null; spacing_minutes?: number | null; youtube_title?: string | null; youtube_visibility?: string | null; autoreply?: AutoReplyIn | null }): Promise<Pending> {
  const videos = (Array.isArray(a.videos) ? a.videos : []).filter((v) => (v.asset_id && UUID.test(v.asset_id)) || (v.job_id && UUID.test(v.job_id) && v.output_key)).slice(0, 50);
  if (!videos.length) throw new ActionError("no_video", "Say which video: a library file (asset_id) or a result (job_id and output_key) from find or item");
  // each video is named from the account's own records: a video the account does not have cannot be posted, and the
  // title in the question is the real one, whatever the AI called it
  const titles = videos.map((v) => ctx.titleOf?.(v) ?? null);
  if (titles.some((t) => !t)) throw new ActionError("video_not_found", "One of those videos is not in the account as given. Use the ids exactly as find or item returned them.");
  const s = await ctx.api.call("GET", "/api/studio/social");
  if (s.status !== 200 || !s.json?.enabled) throw new ActionError("posting_off", "Posting is not available right now");
  const linked: Account[] = (s.json.accounts ?? []).filter((x: Account) => x.id);
  if (!linked.length) throw new ActionError("nothing_linked", "No social account is linked yet. Link one on the Post page: https://app.clone8.io/#studio/publish?accounts");
  // exact accounts are stored (a group is opened into its accounts now, not when it runs)
  let ids: string[] = [], viaGroup = false;
  if (a.group) {
    const want = a.group.trim().toLowerCase(), groups: any[] = s.json.groups ?? [];
    const g = groups.find((x) => String(x.name).toLowerCase() === want) ?? groups.find((x) => String(x.name).toLowerCase().includes(want));
    if (!g) throw new ActionError("no_such_group", `No posting group is called "${short(a.group, 40)}". Groups: ${groups.map((x) => x.name).join(", ") || "none yet"}`);
    ids = [...(g.account_ids ?? [])]; viaGroup = true;
    if (g.missing) throw new ActionError("group_incomplete", `"${g.name}" has ${g.missing} account(s) that are no longer linked. Relink them on the Post page, or name the accounts.`);
  }
  for (const id of a.account_ids ?? []) if (!ids.includes(id)) ids.push(id);
  for (const p of a.platforms ?? []) { const of = linked.filter((x) => x.platform === p); if (of.length === 1 && !ids.includes(of[0].id!)) ids.push(of[0].id!); else if (of.length > 1 && !of.some((x) => ids.includes(x.id!))) throw new ActionError("which_account", `There are ${of.length} ${p} accounts linked (${of.map(handle).join(", ")}). Ask which one.`); else if (!of.length) throw new ActionError("not_linked", `No ${p} account is linked. Linked: ${linked.map(handle).join(", ")}`); }
  const accounts = ids.map((id) => linked.find((x) => x.id === id)).filter(Boolean) as Account[];
  if (!accounts.length || accounts.length !== ids.length) throw new ActionError("which_account", `Say which accounts. Linked: ${linked.map((x) => `${handle(x)} (${x.id})`).join(", ")}`);
  const relink = accounts.filter((x) => x.refresh_required);
  if (relink.length) throw new ActionError("needs_relink", `${relink.map(handle).join(", ")} must be linked again first: https://app.clone8.io/#studio/publish?accounts`);
  // what will be posted is read in full before the YES: a caption too long to show is not posted from here
  const caption = String(a.caption ?? "");
  const perAccount = Object.entries(a.captions_by_account ?? {}).filter(([id, c]) => ids.includes(id) && typeof c === "string" && c.trim());
  if (caption.length > CAPTION_MAX || perAccount.some(([, c]) => c.length > CAPTION_MAX)) throw new ActionError("caption_too_long", `A caption over ${CAPTION_MAX} characters cannot be shown in full here; post that one from the app.`);
  let at: number | null = null, rel: number | null = null;
  if (a.minutes_from_yes != null) rel = Math.max(6, Math.round(Number(a.minutes_from_yes)) || 6);
  else if (a.when && a.when !== "now") { at = Date.parse(a.when); if (!Number.isFinite(at)) throw new ActionError("bad_time", "Give the time as a full date and time with its offset (ISO 8601)"); if (at - ctx.now < 12 * 60_000) throw new ActionError("too_soon", "That time is under 12 minutes away. Post it now, or use minutes_from_yes (6 or more)."); }
  const gap = Math.min(Math.max(Math.round(Number(a.spacing_minutes ?? 0)) || 0, 0), 10080);
  // each video may carry its own time and caption ("3 today at 5:30, 6:45 and 8 pm, 2 tomorrow, each worded its own way")
  const own = videos.map((v) => {
    let t: number | null = null;
    if (v.when) { t = Date.parse(String(v.when)); if (!Number.isFinite(t)) throw new ActionError("bad_time", "Give each video's time as a full date and time with its offset (ISO 8601)"); if (t - ctx.now < 12 * 60_000) throw new ActionError("too_soon", "Each scheduled time must be at least 12 minutes from now; a video meant for now goes without a time"); }
    const c = typeof v.caption === "string" ? v.caption : null;
    if (c && c.length > CAPTION_MAX) throw new ActionError("caption_too_long", `A caption over ${CAPTION_MAX} characters cannot be shown in full here; post that one from the app.`);
    return { at: t, caption: c };
  });
  const each = own.some((x) => x.at != null || x.caption != null);
  // with some videos timed and others not, every one needs a time the question can show exactly
  if (own.some((x) => x.at != null) && own.some((x) => x.at == null)) {
    if (a.when && a.when !== "now" && Number.isFinite(Date.parse(a.when))) { const base = Date.parse(a.when); own.forEach((x, i) => { if (x.at == null) x.at = base + i * Math.min(Math.max(Math.round(Number(a.spacing_minutes ?? 0)) || 0, 0), 10080) * 60_000; }); }
    else throw new ActionError("mixed_times", "Give every video its own time (or none of them, with one time for all)");
  }
  const hasYouTube = accounts.some((x) => x.platform === "youtube");
  const ytTitle = hasYouTube && a.youtube_title ? short(a.youtube_title, 100) : null, ytSee = hasYouTube && ["public", "unlisted", "private"].includes(String(a.youtube_visibility)) ? String(a.youtube_visibility) : null;
  const body: Record<string, any> = { items: videos.map((v, i) => ({ ...(v.asset_id ? { asset_id: v.asset_id } : { job_id: v.job_id, output_key: v.output_key }), ...(own[i].at != null ? { schedule_at: new Date(own[i].at!).toISOString() } : {}), ...(own[i].caption != null ? { caption: own[i].caption } : {}) })), accounts: accounts.map((x) => x.id), caption, via: "text-test",
    ...(perAccount.length ? { captions_by_account: Object.fromEntries(perAccount) } : {}), ...(gap ? { spacing_minutes: gap } : {}),
    ...(ytTitle || ytSee ? { options: { youtube: { ...(ytTitle ? { title: ytTitle } : {}), ...(ytSee ? { visibility: ytSee } : {}) } } } : {}),
    ...(at ? { schedule_at: new Date(at).toISOString() } : {}) };
  // an auto-reply that goes with the posts (the website's own "auto-reply" on a post): set up as each one goes out
  const ar = a.autoreply ? await autoReplyFor(ctx, a.autoreply, accounts, videos.length) : null;
  if (ar) body.autoreply = ar.spec;
  // none asked for: none set (a group's own auto-reply is not added by text, as the question says)
  else body.autoreply = null;
  const whenWords = rel ? `${rel} minutes after your YES` : at ? when(at, ctx.timezone, ctx.now) : "now";
  // the wording check leaves alone only what is the person's own: titles from their account, and captions they typed
  // themselves (a caption the AI wrote is checked like any other words, so it can't carry a supplier's name out)
  const typed = (c: string) => !!c && (ctx.recentUserText ?? []).some((t) => t.replace(/\s+/g, " ").toLowerCase().includes(c.replace(/\s+/g, " ").toLowerCase()));
  const names = titles.map((t) => short(t, 60)), mine = [...names, ...[caption, ...own.map((x) => x.caption ?? ""), ...perAccount.map(([, c]) => c), ...(ytTitle ? [ytTitle] : [])].filter((c) => typed(c))].filter(Boolean);
  // with a time or caption of its own, every video is listed: what goes out when, with which words
  if (each) {
    // (no time of its own: the post's time, then the spacing, as the posting route lays them out)
    const slot = (i: number) => own[i].at != null ? when(own[i].at!, ctx.timezone, ctx.now) : at ? when(at + i * gap * 60_000, ctx.timezone, ctx.now)
      : rel ? `${rel + i * gap} minutes after your YES` : i === 0 || !gap ? "now" : `${i * gap} minutes after the first`;
    const list = videos.map((_, i) => `${i + 1}. "${names[i]}", ${slot(i)}${(own[i].caption ?? caption) ? `\n   Caption: "${own[i].caption ?? caption}"` : "\n   No caption."}`);
    const anyNow = own.every((x) => x.at == null) && !at && !rel;
    const lines2 = [`Post ${videos.length === 1 ? "this video" : `these ${videos.length} videos`} to ${accounts.map(handle).join(", ")}:`, ...list,
      ...perAccount.map(([id, c]) => `${handle(accounts.find((x) => x.id === id)!)} gets its own caption on every one: "${c}"`),
      ...(hasYouTube ? [`YouTube: ${ytTitle ? `title "${ytTitle}", ` : ""}${ytSee ?? "public"}.`] : []),
      ...(viaGroup ? ["The group's own sign-off and spacing are not added by text yet."] : []),
      ...(ar ? ar.lines : []),
      anyNow ? "It can't be pulled back once it is out." : "A time can shift a little later to keep 30 minutes between posts on one account."];
    return put(ctx, { kind: "post", credits: 0, posts: videos.length * accounts.length, own: [...mine, ...(ar?.own ?? [])], steps: [{ method: "POST", path: "/api/studio/social/posts", body, save: "posts", label: "post" }],
      checks: [{ kind: "accounts_linked", account_ids: accounts.map((x) => x.id!) }], meta: { minutes_from_yes: rel }, body: lines2.join("\n") });
  }
  const lines = [
    `${at || rel ? "Schedule" : "Post"} ${videos.length === 1 ? `"${names[0]}"` : `${videos.length} videos: ${names.slice(0, 6).map((n) => `"${n}"`).join(", ")}${names.length > 6 ? `, and ${names.length - 6} more` : ""}`}`,
    `to ${accounts.map(handle).join(", ")}`, `${at || rel ? "for " : ""}${whenWords}${videos.length > 1 && gap ? `, ${gap} minutes apart` : ""}.`,
    caption ? `Caption: "${caption}"` : "No caption.",
    ...perAccount.map(([id, c]) => `${handle(accounts.find((x) => x.id === id)!)} gets its own caption: "${c}"`),
    ...(hasYouTube ? [`YouTube: ${ytTitle ? `title "${ytTitle}", ` : ""}${ytSee ?? "public"}.`] : []),
    ...(viaGroup ? ["The group's own sign-off and spacing are not added by text yet."] : []),
    ...(ar ? ar.lines : []),
    at || rel ? "A time can shift a little later to keep 30 minutes between posts on one account." : "It can't be pulled back once it is out.",
  ];
  return put(ctx, { kind: "post", credits: 0, posts: videos.length * accounts.length, own: [...mine, ...(ar?.own ?? [])], steps: [{ method: "POST", path: "/api/studio/social/posts", body, save: "posts", label: "post" }],
    checks: [{ kind: "accounts_linked", account_ids: accounts.map((x) => x.id!) }], meta: { minutes_from_yes: rel }, body: lines.join("\n") });
}

// ---------------------------------------------------------------------------------------------------
// Auto-replies: someone comments a keyword, they get a reply (owner, Nov 26 2026: "comment GO … set auto reply, just
// reply no dm"). With posts (on those posts, as the Post page does) or on an account by itself (as the Auto-replies page
// does). The same routes and rules as the website; the question shows the exact words before anything is set.
// ---------------------------------------------------------------------------------------------------
export type AutoReplyIn = { keywords: string[]; reply?: string | null; dm_message?: string | null; dm?: boolean | null };
const DM_NETS = ["instagram", "facebook"];
function cleanAutoReply(ctx: Ctx, a: AutoReplyIn) {
  const keywords = [...new Set((Array.isArray(a?.keywords) ? a.keywords : []).map((k) => String(k ?? "").replace(/^["'“”]+|["'“”]+$/g, "").trim()).filter(Boolean))].slice(0, 10);
  if (!keywords.length) throw new ActionError("keywords_required", "Say the word people comment (for example GO)");
  if (keywords.some((k) => k.length > 40)) throw new ActionError("keyword_too_long", "A keyword can be 40 characters at most");
  const reply = String(a?.reply ?? "").trim(), dmMessage = String(a?.dm_message ?? "").trim();
  if (reply.length > 500) throw new ActionError("reply_too_long", "The public reply can be 500 characters at most");
  if (dmMessage.length > 1000) throw new ActionError("dm_too_long", "The DM can be 1,000 characters at most");
  // no DM unless a DM's words were given (the person's "just reply, no DM")
  const dm = a?.dm === false ? false : a?.dm === true ? true : !!dmMessage;
  const typed = (c: string) => !!c && (ctx.recentUserText ?? []).some((t) => t.replace(/\s+/g, " ").toLowerCase().includes(c.replace(/\s+/g, " ").toLowerCase()));
  return { keywords, reply, dmMessage, dm, own: [...keywords, reply, dmMessage].filter((x) => x && typed(x)) };
}
const what = (c: { reply: string; dmMessage: string; dm: boolean }, net: string) => DM_NETS.includes(net) && c.dm
  ? `gets the DM "${c.dmMessage}"${c.reply ? ` and the public reply "${c.reply}"` : ""}`
  : `gets the public reply "${c.reply}"${DM_NETS.includes(net) ? " (no DM)" : ""}`;
/** Whether each account can take it: the network has comment replies, Clone8 has been allowed to answer there, and
 *  the plan has room (a rule with the same keywords already on the account is reused, as the server does). */
async function autoReplyRoom(ctx: Ctx, accounts: Account[], c: { keywords: string[]; reply: string; dmMessage: string; dm: boolean }, o: { withPosts: boolean; freed?: number }) {
  const r = await ctx.api.call("GET", "/api/studio/autoreply");
  if (r.status !== 200 || !r.json?.enabled) throw new ActionError("autoreply_off", "Auto-replies are not available right now");
  const rows: any[] = r.json.accounts ?? [], rules: any[] = r.json.rules ?? [];
  const keys = c.keywords.map((k) => k.toLowerCase()).sort().join("|");
  const notes: string[] = [], reused: Account[] = [];
  for (const acc of accounts) {
    const dmNet = DM_NETS.includes(acc.platform);
    if (!REPLY_NETWORKS.includes(acc.platform)) throw new ActionError("autoreply_not_supported", `${handle(acc)}: that network doesn't allow auto-replies. They work on Instagram, Facebook, TikTok, YouTube, Threads and LinkedIn.`);
    if (dmNet && !c.dm && !r.json.reply_only) throw new ActionError("reply_only_off", "On Instagram and Facebook an auto-reply sends a DM for now; give the DM's words");
    if ((!dmNet || !c.dm) && !c.reply) throw new ActionError("reply_required", `Say what the public reply on ${handle(acc)} should say`);
    if (dmNet && c.dm && !c.dmMessage) throw new ActionError("dm_required", "Say what the DM should say");
    const row = rows.find((x) => x.id === acc.id);
    if (row && (!row.can_reply || (dmNet && c.dm && !row.can_dm))) {
      // with posts it waits on the post and starts once allowed; a rule by itself needs the permission first
      if (!o.withPosts) throw new ActionError("needs_permission", `${handle(acc)} hasn't allowed Clone8 to answer comments yet. Allow it on the Post page first: https://app.clone8.io/#studio/publish?accounts`);
      notes.push(`${handle(acc)} hasn't allowed Clone8 to answer comments yet: the auto-reply starts by itself once you allow it on the Post page (https://app.clone8.io/#studio/publish?accounts).`);
    }
    const same = rules.find((x) => String(x.account_id) === String(acc.id) && !x.post && (x.keywords ?? []).map((k: string) => String(k).toLowerCase()).sort().join("|") === keys);
    const sameKind = same && (!!same.dm_message === (DM_NETS.includes(acc.platform) && c.dm));
    if (same && o.withPosts && sameKind) { reused.push(acc); notes.push(`${handle(acc)} already has a ${c.keywords.map((k) => `"${k}"`).join("/")} auto-reply: it gets these words instead.`); }
    else if (same && o.withPosts && same.active) notes.push(`${handle(acc)} already has a ${c.keywords.map((k) => `"${k}"`).join("/")} auto-reply ${same.dm_message ? "that sends a DM" : "that replies only"}; it stays on too (ask me to pause it).`);
  }
  const limit = Number(r.json.limit ?? 0), room = limit - Number(r.json.used ?? 0);
  if (limit && room + (o.freed ?? 0) < accounts.length - reused.length) throw new ActionError("autoreply_limit", `Your plan runs ${limit} auto-replies at once and ${Math.max(0, room + (o.freed ?? 0))} ${room + (o.freed ?? 0) === 1 ? "is" : "are"} free. Pause one first (or upgrade).`);
  return { notes };
}
async function autoReplyFor(ctx: Ctx, a: AutoReplyIn, accounts: Account[], videos: number) {
  const c = cleanAutoReply(ctx, a);
  const { notes } = await autoReplyRoom(ctx, accounts, c, { withPosts: true });
  const words = c.keywords.map((k) => `"${k}"`).join(" or ");
  const where = videos === 1 ? "on this post" : `on ${accounts.length === 1 ? "the account" : "each account"} (one rule that answers on every post there, old and new)`;
  const lines = [`Auto-reply ${where}: anyone who comments ${words} ${accounts.length === 1 ? what(c, accounts[0].platform) : accounts.map((x) => `${handle(x)}: ${what(c, x.platform)}`).join("; ")}. It starts as ${videos === 1 ? "the post goes" : "the posts go"} out.`, ...notes];
  return { spec: { keywords: c.keywords, ...(c.reply ? { comment_reply: c.reply } : {}), ...(c.dm && c.dmMessage ? { dm_message: c.dmMessage } : { dm: false }) }, lines, own: c.own };
}

/** One rule in words that tell it apart from others with the same keyword: account, which posts, what it sends. */
function ruleWords(r: any, accounts: any[]): string {
  const a = accounts.find((x) => String(x.id) === String(r.account_id));
  const who = a ? `${a.platform} @${a.username ?? "?"}` : String(r.platform ?? "an account");
  const where = r.post ? `one post${r.post.title ? ` "${short(r.post.title, 40)}"` : ""}` : "every post";
  const sends = [r.dm_message ? `DM "${short(r.dm_message, 60)}"` : "", r.comment_reply ? `reply "${short(r.comment_reply, 60)}"` : ""].filter(Boolean).join(" + ") || "no message";
  return `${(r.keywords ?? []).map((k: string) => `"${k}"`).join("/") || "a keyword"} on ${who} (${where}): ${sends}`;
}

/** An auto-reply on an account by itself (every post, or one post by its id from the account's recent posts). A change
 *  of what an auto-reply says is a new rule that REPLACES the old ones: rules already on for the same keyword on that
 *  account (and any named in replace_rule_ids) are paused once the new one is set, so a comment never gets two answers. */
export async function prepareAutoReply(ctx: Ctx, a: AutoReplyIn & { account_id: string; post_id?: string | null; replace_rule_ids?: string[] | null }): Promise<Pending> {
  const s = await ctx.api.call("GET", "/api/studio/social");
  const acc = ((s.json?.accounts ?? []) as Account[]).find((x) => x.id === a.account_id);
  if (!acc) throw new ActionError("which_account", `Say which account. Linked: ${((s.json?.accounts ?? []) as Account[]).map((x) => `${handle(x)} (${x.id})`).join(", ") || "none"}`);
  const c = cleanAutoReply(ctx, a);
  // what it replaces: named rules, and every rule already on for one of these keywords on this account
  const ar = await ctx.api.call("GET", "/api/studio/autoreply");
  const rules: any[] = ar.json?.rules ?? [], arAccounts: any[] = ar.json?.accounts ?? [];
  const named = [...new Set((a.replace_rule_ids ?? []).map(String))];
  for (const id of named) if (!rules.some((r) => String(r.id) === id)) throw new ActionError("rule_not_found", "One of the auto-replies to replace isn't there; use ids from the autoreplies lookup");
  // one post: named by the account's own record of it, never by words the AI made up
  let post: { id: string; title: string | null } | null = null;
  if (a.post_id) {
    const r = await ctx.api.call("GET", `/api/studio/autoreply/posts?account_id=${encodeURIComponent(acc.id!)}`);
    const hit = ((r.json?.posts ?? []) as any[]).find((x) => x?.id && String(x.id) === String(a.post_id));
    if (!hit) throw new ActionError("post_not_found", "That post isn't among the account's recent posts; use an id from them (lookup autoreply_posts)");
    post = { id: String(hit.id), title: hit.title ? short(hit.title, 120) : null };
  }
  // the rules it replaces: the ones named, and the ones on this account that answer the same thing in the
  // same place (same keywords, comments; a new every-post rule covers one-post ones too, a new one-post rule replaces
  // only that post's); a rule with other keywords as well is left alone
  const keyset = (ks: string[]) => [...new Set(ks.map((k) => String(k).trim().toLowerCase()))].sort().join("|");
  const mine = keyset(c.keywords);
  const live = rules.filter((r) => r.active && /^[A-Za-z0-9_-]{1,64}$/.test(String(r.id)));
  // (a rule that would answer the very same comments is always replaced: leaving it on means two answers)
  const replaced = live.filter((r) => named.includes(String(r.id)) || (String(r.account_id) === String(acc.id) && keyset(r.keywords ?? []) === mine && (r.trigger ?? "comment") === "comment" && (post ? String(r.post?.id ?? "") === post.id : true)));
  await autoReplyRoom(ctx, [acc], c, { withPosts: false, freed: replaced.length });
  const words = c.keywords.map((k) => `"${k}"`).join(" or ");
  const body = { account_id: acc.id, platform: acc.platform, name: `Keyword ${c.keywords[0]}`.slice(0, 60), keywords: c.keywords, match: "word", active: true,
    ...(c.reply ? { comment_reply: c.reply } : {}), ...(DM_NETS.includes(acc.platform) ? (c.dm ? { dm_message: c.dmMessage } : { dm: false }) : {}), ...(post ? { post_id: post.id, ...(post.title ? { post_title: post.title } : {}) } : {}) };
  const set = `${replaced.length ? "New" : "Set an"} auto-reply on ${handle(acc)}, ${post ? `on the post${post.title ? ` "${short(post.title, 60)}"` : ""}` : "on every post, old and new"}: anyone who comments ${words} ${what(c, acc.platform)}.`;
  return put(ctx, { kind: "autoreply", credits: 0, posts: 0, own: [...c.own, ...(post?.title ? [short(post.title, 60)] : []), ...replaced.flatMap((r) => [...(r.keywords ?? []), r.dm_message, r.comment_reply, r.post?.title].filter(Boolean).map((x: string) => short(x, 60)))],
    // the new one first: if it can't be set, the old ones stay on
    steps: [{ method: "POST", path: "/api/studio/autoreply", body, label: "autoreply" }, ...replaced.map((r) => ({ method: "PATCH" as const, path: `/api/studio/autoreply/${r.id}`, body: { active: false }, label: "pause" }))], checks: [],
    meta: { paused: replaced.length, pause_names: replaced.map((r) => ruleWords(r, arAccounts)) },
    body: replaced.length ? [set, `It replaces ${replaced.length === 1 ? "this one, which is paused" : `these ${replaced.length}, which are paused`} (they can be turned back on):`, ...replaced.map((r) => `· ${ruleWords(r, arAccounts)}`)].join("\n") : set });
}

/** Pause or turn back on one or several auto-replies (ids from the autoreplies lookup), in ONE question, each told apart
 *  by its account, posts and words. */
export async function prepareAutoReplySwitch(ctx: Ctx, a: { rule_id?: string; rule_ids?: string[] | null; on: boolean }): Promise<Pending> {
  const ids = [...new Set([...(a.rule_ids ?? []), ...(a.rule_id ? [a.rule_id] : [])].map(String))];
  if (!ids.length) throw new ActionError("rule_not_found", "Say which auto-replies (ids from the autoreplies lookup)");
  const r = await ctx.api.call("GET", "/api/studio/autoreply");
  const rules = ids.map((id) => ((r.json?.rules ?? []) as any[]).find((x) => String(x.id) === id));
  if (rules.some((x) => !x || !/^[A-Za-z0-9_-]{1,64}$/.test(String(x.id)))) throw new ActionError("rule_not_found", "No such auto-reply; use its id from the autoreplies lookup");
  const accounts: any[] = r.json?.accounts ?? [];
  const lines = rules.map((x) => `· ${ruleWords(x, accounts)}`);
  const limit = Number(r.json?.limit ?? 0), adding = a.on ? rules.filter((x) => !x.active).length : 0;
  if (limit && adding && Number(r.json?.used ?? 0) + adding > limit) throw new ActionError("autoreply_limit", `Your plan runs ${limit} auto-replies at once; turning on ${adding} would go over. Pause others first (or upgrade).`);
  return put(ctx, { kind: "autoreply_switch", credits: 0, posts: 0, own: rules.flatMap((x) => [x.name, ...(x.keywords ?? []), x.dm_message, x.comment_reply, x.post?.title].filter(Boolean).map((y: string) => short(y, 60))),
    steps: rules.map((x) => ({ method: "PATCH" as const, path: `/api/studio/autoreply/${x.id}`, body: { active: !!a.on }, label: "autoreply" })), checks: [],
    meta: { on: !!a.on, n: rules.length }, body: [`${a.on ? "Turn back on" : "Pause"} ${rules.length === 1 ? "this auto-reply" : `these ${rules.length} auto-replies`}:`, ...lines].join("\n") });
}

/** After the YES: where the auto-reply went with the posts, and where it didn't (and why), in plain words. */
const SKIP: Record<string, string> = { needs_permission: "waits for your OK to answer comments there (Post page)", limit: "your plan's auto-replies are all in use", no_reply_text: "it needs a public reply there", not_linked: "that account isn't linked", failed: "it couldn't be set up" };
function autoReplyLine(ar: any, asked: boolean, queued: boolean): string {
  if (!asked) return "";
  if (!ar) return queued ? "The auto-reply is set as they go out." : "";
  const who = (x: any) => `${short(x.platform, 20)}${x.username ? ` @${short(x.username, 40)}` : ""}`;
  const on = (ar.on ?? []) as any[], off = (ar.skipped ?? []) as any[];
  return [on.length ? `Auto-reply on for ${on.map(who).join(", ")}.` : "", ...off.map((x) => `Auto-reply not set on ${who(x)}: ${SKIP[x.reason] ?? "it couldn't be set up"}${x.waiting ? "; it starts by itself once allowed" : ""}.`)].filter(Boolean).join(" ");
}

async function waitingPost(ctx: Ctx, id: string): Promise<any> {
  if (!UUID.test(id)) throw new ActionError("post_not_found", "Use the post's id from find (p:<id>) or the posts lookup");
  const r = await ctx.api.call("GET", "/api/studio/social/posts");
  const p = (r.json?.posts ?? []).find((x: any) => x.id === id);
  if (!p) throw new ActionError("post_not_found", "No such post");
  return p;
}
const postWho = (p: any): string => (Array.isArray(p.options?.accounts) && p.options.accounts.length ? p.options.accounts.map((x: any) => `${x.platform}${x.username ? ` @${x.username}` : ""}`).join(", ") : (p.platforms ?? []).join(", "));

export type PostChange = { post_id: string; new_time?: string | null; minutes_from_yes?: number | null; caption?: string | null; youtube_title?: string | null };
/** Change one or several waiting posts in ONE question ("put all 5 today": every post that moves, each from → to). */
export async function preparePostChange(ctx: Ctx, a: PostChange & { changes?: PostChange[] | null }): Promise<Pending> {
  const list: PostChange[] = Array.isArray(a.changes) && a.changes.length ? a.changes : a.post_id ? [a] : [];
  // one change per post: the last one said replaces any earlier one for that post
  const byPost = new Map<string, PostChange>(); for (const c of list) if (c?.post_id) { byPost.delete(String(c.post_id)); byPost.set(String(c.post_id), c); }
  const changes = [...byPost.values()];
  if (!changes.length) throw new ActionError("post_not_found", "Say which post (its id from find or the posts lookup)");
  if (changes.length > 30) throw new ActionError("too_many", "Up to 30 posts can be changed in one go; do the rest after");
  if (changes.length > 1 && changes.some((c) => c.minutes_from_yes != null)) throw new ActionError("bad_time", "With several posts, give each a full date and time (ISO 8601 with offset)");
  const typed = (c: string) => !!c && (ctx.recentUserText ?? []).some((t) => t.replace(/\s+/g, " ").toLowerCase().includes(c.replace(/\s+/g, " ").toLowerCase()));
  const r = await ctx.api.call("GET", "/api/studio/social/posts");
  const all: any[] = r.json?.posts ?? [];
  const steps: Step[] = [], checks: Check[] = [], own: string[] = [];
  const blocks: Array<{ name: string; who: string; from: string; to: string | null; rest: string[] }> = []; let rel: number | null = null;
  for (const c of changes) {
    if (!UUID.test(String(c.post_id))) throw new ActionError("post_not_found", "Use the post's id from find (p:<id>) or the posts lookup");
    const p = all.find((x) => x.id === c.post_id);
    if (!p) throw new ActionError("post_not_found", "No such post");
    if (p.status !== "scheduled" && p.status !== "queued") throw new ActionError("not_editable", `"${short(p.caption, 40)}" has already gone out; only posts that have not gone out can be changed`);
    const ownCaptions = (Array.isArray(p.options?.accounts) ? p.options.accounts : []).filter((x: any) => x?.own && x?.caption);
    const rest: string[] = [], body: Record<string, any> = {}; own.push(short(p.caption, 60));
    const from = p.schedule_at ? when(p.schedule_at, ctx.timezone, ctx.now) : "its time"; let to: string | null = null;
    if (c.minutes_from_yes != null) { rel = Math.max(6, Math.round(Number(c.minutes_from_yes)) || 6); to = `${rel} minutes after your YES`; }
    else if (c.new_time) {
      const at = Date.parse(c.new_time);
      if (!Number.isFinite(at)) throw new ActionError("bad_time", "Give each new time as a full date and time with its offset (ISO 8601)");
      if (at - ctx.now < 12 * 60_000) throw new ActionError("too_soon", "A new time must be at least 12 minutes away (one post: minutes_from_yes)");
      body.schedule_at = new Date(at).toISOString(); to = when(at, ctx.timezone, ctx.now);
    }
    // the wording check leaves alone only words the person typed themselves (an AI-written caption is checked)
    if (typeof c.caption === "string") {
      if (c.caption.length > CAPTION_MAX) throw new ActionError("caption_too_long", `A caption over ${CAPTION_MAX} characters cannot be shown in full here; change that one in the app.`);
      body.caption = c.caption; if (typed(c.caption)) own.push(c.caption); rest.push(`New caption: "${c.caption}"`);
      if (ownCaptions.length) rest.push(`${ownCaptions.map((x: any) => `${x.platform}${x.username ? ` @${x.username}` : ""}`).join(", ")} ${ownCaptions.length === 1 ? "has its" : "have their"} own caption, which stays as it is (that cannot be changed after scheduling yet).`);
    }
    if (c.youtube_title) { const t = short(c.youtube_title, 100); body.youtube_title = t; if (typed(t)) own.push(t); rest.push(`New YouTube title: "${t}"`); }
    if (!to && !rest.length) throw new ActionError("nothing_to_change", "Say what to change: the time, the caption or the YouTube title");
    steps.push({ method: "PATCH", path: `/api/studio/social/posts/${p.id}`, body, save: "post", label: short(p.caption, 40) });
    checks.push({ kind: "post_unchanged", post_id: p.id, updated_at: p.updated_at });
    blocks.push({ name: short(p.caption, 60), who: postWho(p), from, to, rest });
  }
  const text = blocks.length === 1
    ? [`Change the post to ${blocks[0].who} ("${blocks[0].name}"):`, ...(blocks[0].to ? [`Move it from ${blocks[0].from} to ${blocks[0].to}.`] : []), ...blocks[0].rest]
    : [`Change ${blocks.length} posts:`, ...blocks.map((b, i) => [`${i + 1}. "${b.name}" (${b.who})`, ...(b.to ? [`${b.from} → ${b.to}`] : []), ...b.rest].join("\n   "))];
  return put(ctx, { kind: "post_change", credits: 0, posts: blocks.length, meta: { minutes_from_yes: rel, changes }, own, steps, checks, body: text.join("\n") });
}

export async function preparePostCancel(ctx: Ctx, a: { post_ids: string[] }): Promise<Pending> {
  const ids = [...new Set((a.post_ids ?? []).filter((x) => UUID.test(x)))].slice(0, 50);
  if (!ids.length) throw new ActionError("post_not_found", "Say which posts (their ids from find or the posts lookup)");
  const r = await ctx.api.call("GET", "/api/studio/social/posts");
  const rows = ids.map((id) => (r.json?.posts ?? []).find((x: any) => x.id === id)).filter(Boolean);
  if (rows.length !== ids.length) throw new ActionError("post_not_found", "One of those posts was not found");
  if (rows.some((p: any) => p.status !== "scheduled" && p.status !== "queued")) throw new ActionError("not_cancelable", "Only posts that have not gone out can be cancelled");
  return put(ctx, { kind: "post_cancel", credits: 0, posts: rows.length, own: rows.map((p: any) => short(p.caption, 50)),
    steps: rows.map((p: any) => ({ method: "DELETE" as const, path: `/api/studio/social/posts/${p.id}`, label: "cancel" })), checks: rows.map((p: any) => ({ kind: "post_unchanged" as const, post_id: p.id, updated_at: p.updated_at })),
    body: [`Cancel ${rows.length === 1 ? "this scheduled post" : `these ${rows.length} scheduled posts`}:`, ...rows.slice(0, 12).map((p: any) => `· ${p.schedule_at ? when(p.schedule_at, ctx.timezone, ctx.now) : "queued"} · ${postWho(p)} · "${short(p.caption, 50)}"`), rows.length > 12 ? `… and ${rows.length - 12} more` : "", "The videos stay in your library."].filter(Boolean).join("\n") });
}

export async function preparePostRetry(ctx: Ctx, a: { post_id: string }): Promise<Pending> {
  const p = await waitingPost(ctx, a.post_id);
  if (p.status !== "failed" && p.status !== "partial") throw new ActionError("not_retryable", "Only a post that failed can be retried");
  const failed = (p.results ?? []).filter((x: any) => x.status === "failed");
  return put(ctx, { kind: "post_retry", credits: 0, posts: Math.max(1, failed.length), own: [short(p.caption, 60)], steps: [{ method: "POST", path: `/api/studio/social/posts/${p.id}/retry`, body: {}, label: "retry" }], checks: [{ kind: "post_unchanged", post_id: p.id, updated_at: p.updated_at }],
    body: `Send "${short(p.caption, 60)}" again to the accounts where it failed (${failed.map((x: any) => short(x.platform, 20)).join(", ") || postWho(p)}). Where it already went out it is not sent twice.` });
}

export async function prepareJobCancel(ctx: Ctx, a: { job_id: string }): Promise<Pending> {
  if (!UUID.test(a.job_id)) throw new ActionError("job_not_found", "Use the job's id");
  const r = await ctx.api.call("GET", `/api/studio/jobs/${a.job_id}`);
  if (r.status !== 200) throw new ActionError("job_not_found", "No such job");
  const j = r.json.job;
  if (j.status !== "queued") throw new ActionError("not_cancelable", j.status === "running" ? "It is already being made; a run that has started cannot be stopped from here yet." : `It is ${j.status}; there is nothing to cancel.`);
  return put(ctx, { kind: "job_cancel", credits: 0, posts: 0, steps: [{ method: "POST", path: `/api/studio/jobs/${j.id}/cancel`, body: {}, label: "cancel" }], checks: [], body: `Cancel the waiting ${toolName(j)} run? Its ${num(j.credits_reserved) ?? 0} credits come back.` });
}

export async function prepareCaptionRead(ctx: Ctx, a: { videos: VideoRef[]; platforms?: string[]; note?: string | null; line?: string | null }): Promise<Pending> {
  const videos = (a.videos ?? []).slice(0, 60);
  if (!videos.length) throw new ActionError("no_video", "Say which videos to read");
  const titles = videos.map((v) => ctx.titleOf?.(v) ?? null);
  if (titles.some((t) => !t)) throw new ActionError("video_not_found", "One of those videos is not in the account as given. Use the ids exactly as find or item returned them.");
  const body = { videos, platforms: a.platforms, note: a.note ?? undefined, line: a.line ?? undefined };
  const q = await ctx.api.call("POST", "/api/studio/social/captions/quote", body);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.credits ?? 0);
  if (!Number.isFinite(credits) || credits > Math.min(ctx.maxActionCredits, spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits))) throw new ActionError("over_daily_limit", `Reading these is ${credits} credits, over what is left for today by text.`);
  const names = titles.map((t) => short(t, 60));
  return put(ctx, { kind: "caption_read", credits, posts: 0, own: names, steps: [{ method: "POST", path: "/api/studio/social/captions/batch", body, save: "batch", label: "read" }], checks: [],
    body: `Watch ${names.slice(0, 5).map((n) => `"${n}"`).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""} once, so captions can be written from ${names.length === 1 ? "it" : "them"}.\nCost: ${credits} credits (videos already watched are free).` });
}

export async function prepareAutomationRun(ctx: Ctx, a: { automation_id: string; inputs?: Record<string, any> }): Promise<Pending> {
  if (!UUID.test(a.automation_id)) throw new ActionError("automation_not_found", "Use the automation's id from the automations lookup");
  const body = { inputs: a.inputs && typeof a.inputs === "object" ? a.inputs : {} };
  const [q, info] = await Promise.all([ctx.api.call("POST", `/api/studio/automations/${a.automation_id}/quote`, body), ctx.api.call("GET", `/api/studio/automations/${a.automation_id}`)]);
  if (q.status !== 200) throw new ActionError(String(q.json?.error ?? "quote_refused"), refusal(q));
  const credits = Number(q.json?.credits ?? 0), name = short(info.json?.automation?.name ?? "a saved automation", 60);
  if (!Number.isFinite(credits) || credits > Math.min(ctx.maxActionCredits, spendRoom(ctx.spend, today(ctx.now, ctx.timezone), ctx.dailyCredits))) throw new ActionError("over_daily_limit", `That run is ${credits} credits, over what is left for today by text.`);
  const steps: string[] = (q.json?.steps ?? []).slice(0, 8).map((s: any) => `${num(s.index) ?? "·"}. ${short(s.label, 70)} (${num(s.credits) ?? "?"} credits)`);
  const given = Object.entries(body.inputs).slice(0, 8).map(([k, v]) => { const id = typeof v === "string" && UUID.test(v) ? ctx.nameOf?.(v) : null; return `${short(k, 30)}: ${id ? `"${short(id, 60)}"` : `"${short(typeof v === "string" ? v : JSON.stringify(v), 80)}"`}`; });
  return put(ctx, { kind: "automation_run", credits, posts: 0, own: [name, ...given, ...steps], steps: [{ method: "POST", path: `/api/studio/automations/${a.automation_id}/run`, body, save: "run", label: name }], checks: [],
    body: [`Run your automation "${name}".`, ...steps, given.length ? `This time: ${given.join("; ")}` : "", `Cost: about ${credits} credits.`].filter(Boolean).join("\n") });
}

// ---------------------------------------------------------------------------------------------------
// The executor: runs a claimed action, after checking that what it depends on has not changed
// ---------------------------------------------------------------------------------------------------
export type Outcome = { ok: boolean; text: string; job_id?: string; collection_id?: string; credits?: number; post_ids?: string[]; project?: { id: string; asset_id: string | null; job_id: string | null; rev: number; name: string }; calls: Array<{ method: string; path: string; status: number }> };

/** A new auto-reply that replaces old ones: set it, then pause each old one (every pause is tried; any that could not be
 *  paused is named, since it still answers too). With the plan full, the old ones are paused first and turned back on
 *  if the new one can't be set. */
async function replaceAutoReply(api: Api, p: Pending, out: Outcome): Promise<Outcome> {
  const [make, ...pauses] = p.steps, names: string[] = p.meta?.pause_names ?? [];
  const call = async (s: Step, body = s.body) => { const r = await api.act(p.id, s.method, s.path, body, { timeoutMs: 60_000 }).catch((e: any) => ({ status: 599, json: { error: String(e?.code ?? "failed"), detail: String(e?.message ?? e).slice(0, 160) } })); out.calls.push({ method: s.method, path: s.path, status: r.status }); return r; };
  let r = await call(make), pausedFirst: Step[] = [];
  if (r.status === 409 && /limit/i.test(String(r.json?.error ?? ""))) {
    for (const s of pauses) if ((await call(s)).status < 300) pausedFirst.push(s);
    r = await call(make);
    if (r.status >= 300) { for (const s of pausedFirst) await call(s, { active: true }); return { ...out, ok: false, text: `It did not go through: ${refusal(r)} Your old auto-replies are as they were.` }; }
  } else if (r.status >= 300) return { ...out, ok: false, text: `It did not go through: ${refusal(r)} Your old auto-replies are as they were.` };
  const failed: string[] = [];
  for (const [i, s] of pauses.entries()) { if (pausedFirst.includes(s)) continue; if ((await call(s)).status >= 300) failed.push(names[i] ?? "one old auto-reply"); }
  if (failed.length) return { ...out, ok: false, text: `The new auto-reply is on, but ${failed.length === 1 ? "this old one" : `these ${failed.length} old ones`} could not be paused, so ${failed.length === 1 ? "it still answers" : "they still answer"} too:\n${failed.map((x) => `· ${x}`).join("\n")}\nAsk me to pause ${failed.length === 1 ? "it" : "them"}, or switch ${failed.length === 1 ? "it" : "them"} off on the Auto-replies page.` };
  out.text = `The auto-reply is on. The old ${pauses.length === 1 ? "one is" : `${pauses.length} are`} paused.`;
  return out;
}

export async function execute(api: Api, p: Pending, o: { now: number; timezone: string }): Promise<Outcome> {
  const calls: Outcome["calls"] = [], moved: string[] = [];
  let postsNow: any[] | null = null; // read once for every post's check
  for (const c of p.checks) {
    if (c.kind === "post_unchanged") {
      postsNow ??= ((await api.call("GET", "/api/studio/social/posts")).json?.posts ?? []) as any[];
      const row = postsNow.find((x: any) => x.id === c.post_id);
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
      if (c.account_ids.some((id) => !have.has(id))) return { ok: false, text: "One of those accounts is no longer linked, so nothing was posted. Link it again on the Post page and ask me again.", calls };
    }
  }
  const out: Outcome = { ok: true, text: "", calls };
  if (p.kind === "autoreply" && p.steps.length > 1) return replaceAutoReply(api, p, out);
  for (const s of p.steps) {
    let body = s.body;
    // "N minutes after the YES" becomes a clock time only now
    if (p.meta?.minutes_from_yes && (p.kind === "post" || p.kind === "post_change")) body = { ...body, schedule_at: new Date(o.now + Number(p.meta.minutes_from_yes) * 60_000).toISOString() };
    const r = await api.act(p.id, s.method, s.path, body, { timeoutMs: 180_000 });
    calls.push({ method: s.method, path: s.path, status: r.status });
    if (r.status >= 400) {
      const done = calls.length - 1;
      // which ones went through (by name, with their new times), so nothing is asked again for them
      const through = p.kind === "post_change" && done ? ` Done: ${p.steps.slice(0, done).map((x, i) => `"${x.label ?? "a post"}"${moved[i] ? ` (now ${moved[i]})` : ""}`).join(", ")}. Not done: "${s.label ?? "the next one"}" and any after it.` : "";
      return { ...out, ok: false, text: `${done ? `${done} of ${p.steps.length} went through, then it stopped` : "It did not go through"}: ${refusal(r)}${p.credits && !done ? " Nothing was spent." : ""}${through}` };
    }
    if (p.kind === "job") { out.job_id = r.json?.job?.id; out.collection_id = r.json?.collection_id; out.credits = Number(r.json?.quote?.credits ?? p.credits); }
    if (p.kind === "post") {
      const posts: any[] = r.json?.posts ?? [];
      out.post_ids = posts.map((x) => x.id);
      const skipped: any[] = r.json?.skipped ?? [];
      const times = posts.filter((x) => x.schedule_at).map((x) => when(x.schedule_at, o.timezone, o.now));
      const failed = posts.filter((x) => x.status === "failed");
      out.text = [posts.length ? (times.length ? `Scheduled: ${[...new Set(times)].slice(0, 8).join(", ")}${times.length > 8 ? ", …" : ""}.` : "On its way. Each network takes a minute or two.") : "Nothing was sent.",
        r.json?.queued ? `${num(r.json.queued)} more are being sent in the background.` : "", failed.length ? `${failed.length} did not go out: ${short(failed[0].error, 120)}` : "", skipped.length ? `Left out: ${skipped.map((x) => `${short(x.platform ?? x.group ?? "an account", 30)} (${short(x.reason, 30)})`).join(", ")}.` : "", autoReplyLine(r.json?.autoreply, !!s.body?.autoreply, !!r.json?.queued)].filter(Boolean).join(" ");
    }
    if (p.kind === "edit" && s.method === "POST") out.project = { id: p.meta?.project_id, asset_id: p.meta?.asset_id ?? null, job_id: p.meta?.job_id ?? null, rev: Number(p.meta?.rev) || 0, name: String(p.meta?.name ?? "your clip") };
    if (p.kind === "post_change") { const at = r.json?.post?.schedule_at; if (at) moved.push(when(at, o.timezone, o.now)); out.text = p.steps.length === 1 ? `Changed.${at ? ` It now goes out ${moved[0]}.` : ""}` : `Changed all ${p.steps.length}.${moved.length ? ` New times: ${moved.join(", ")}.` : ""}`; }
  }
  if (!out.text) out.text = p.kind === "job" ? `Started: ${p.meta?.summary ?? "your run"}. I'll send it here when it's ready.` : p.kind === "post_cancel" ? `Cancelled ${p.steps.length === 1 ? "it" : `all ${p.steps.length}`}.` : p.kind === "edit" ? "Saved. Making the edited clip now; I'll send it here when it's ready (usually under a minute)." : p.kind === "job_cancel" ? "Cancelled; the credits are back." : p.kind === "caption_read" ? "Watching now; ask me for the captions in a minute." : p.kind === "autoreply" ? `The auto-reply is on.${p.meta?.paused ? ` The old ${p.meta.paused === 1 ? "one is" : `${p.meta.paused} are`} paused.` : ""}` : p.kind === "autoreply_switch" ? (Number(p.meta?.n) > 1 ? `${p.meta?.on ? "All back on" : "Paused all"} ${p.meta?.n}.` : p.meta?.on ? "It's back on." : "Paused.") : "Done.";
  return out;
}
