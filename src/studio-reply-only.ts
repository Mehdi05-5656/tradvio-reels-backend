// Clone8 Studio: reply-only auto-replies on Instagram and Facebook (owner, Nov 24 2026: "an option that allows only for
// reply without sending a DM, and having a DM as an option to toggle on").
//
// Why Clone8 runs these itself: the posting service's comment rules (studio-autoreply.ts) must send a DM on Instagram
// and Facebook (zernio.com/openapi.json, POST /v1/comment-automations: dmMessage "Required on Instagram and Facebook"),
// and there is no switch to leave it out. So a rule with the DM off lives in our own table (studio_reply_rules):
//   1. the service tells us about every new comment on a linked account (webhook event comment.received);
//   2. we look for an active rule on that account (and that post) whose keyword is in the comment;
//   3. we write a log row first (one per rule and comment, so a comment is never answered twice), then post the
//      public reply under the comment (POST /v1/inbox/comments/{postId} with commentId and an Idempotency-Key).
// A send that fails, or whose outcome is unknown, is recorded and never retried. Rules with the DM on, and every
// TikTok, YouTube, Threads and LinkedIn rule (those take a reply-only rule natively), stay with the service unchanged.
// Off until STUDIO_AUTOREPLY_REPLY_ONLY=true (after migrations/20261207000000_studio_reply_rules.sql is applied).
import type { SupabaseClient } from "@supabase/supabase-js";
import { SocialError, type SocialDeps } from "./social-provider.js";
import { zernioClient } from "./social-zernio.js";
import { hasPlanAccess } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";

type Env = Record<string, string | undefined>;
/** Instagram and Facebook: the networks where the service's rule would force a DM. */
export const REPLY_ONLY_NETWORKS = ["instagram", "facebook"];
export const replyOnlyOn = (env: Env) => env.STUDIO_AUTOREPLY_REPLY_ONLY === "true";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Our rule ids are uuids; the service's are not, so one id says which side a rule lives on. */
export const isOwnRuleId = (id: string) => UUID_RE.test(id);
/** "every" answers the same person again at most once a day, like the service's every-comment rule. */
const EVERY_COOLDOWN_MS = 24 * 3600_000;

const str = (v: any, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
const list = (v: any, n: number, max: number) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean))].slice(0, n);
const POST_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type OwnRuleRow = {
  id: string; user_id: string; account_id: string; platform: string; name: string; keywords: string[]; match: string; exclude: string[];
  comment_reply: string; reply_variations: string[]; post_id: string | null; platform_post_id: string | null; post_title: string | null;
  repeat: string; active: boolean; created_at: string; updated_at?: string;
};

/** A reply-only rule as the person asked for it, cleaned to our table's columns. Throws SocialError. */
export function cleanOwnRule(b: any, opts: { partial?: boolean } = {}): Partial<OwnRuleRow> {
  const out: Partial<OwnRuleRow> = {};
  const has = (k: string) => !opts.partial || b?.[k] !== undefined;
  if (has("trigger") && b?.trigger && b.trigger !== "comment") throw new SocialError("dm_required", "Story replies and mentions are answered by DM; switch the DM on", 400);
  if (has("name")) out.name = str(b?.name, 60) || "Auto-reply";
  if (has("keywords")) out.keywords = list(b?.keywords, 10, 40);
  if (has("match")) out.match = ["word", "contains", "exact"].includes(b?.match) ? b.match : "word";
  if (has("exclude")) out.exclude = list(b?.exclude, 10, 40);
  if (has("comment_reply")) {
    const r = str(b?.comment_reply, 500);
    if (!r) throw new SocialError("reply_required", "Write the public reply to post", 400);
    out.comment_reply = r;
  }
  if (has("reply_variations")) out.reply_variations = list(b?.reply_variations, 5, 500);
  if (has("post_id")) {
    const id = b?.post_id ? str(b.post_id, 64) : "";
    if (id && !POST_RE.test(id)) throw new SocialError("bad_post", "That post could not be read", 400);
    out.platform_post_id = id || null;
    if (!id) out.post_title = null;
  }
  if (has("post_title") && out.platform_post_id !== null) { const t = str(b?.post_title, 120); if (t) out.post_title = t; }
  if (has("repeat")) out.repeat = b?.repeat === "every" ? "every" : "once";
  if (has("active")) out.active = b?.active !== false;
  if (!opts.partial && !out.keywords?.length) throw new SocialError("keywords_required", "Add at least one keyword", 400);
  if (opts.partial && out.keywords && !out.keywords.length) throw new SocialError("keywords_required", "Add at least one keyword", 400);
  return out;
}

export type RuleStats = { triggered: number; sent: number; failed: number; people: number };
/** Our rule in the page's own shape (the same as a service rule, with no DM). */
export function publicOwnRule(r: OwnRuleRow, s?: RuleStats) {
  return {
    id: r.id, name: r.name, platform: r.platform, account_id: r.account_id, trigger: "comment",
    post: r.post_id || r.platform_post_id ? { id: String(r.platform_post_id ?? r.post_id), title: r.post_title ?? null } : null,
    keywords: r.keywords ?? [], match: r.match ?? "word", exclude: r.exclude ?? [], typos: false,
    dm: false, dm_message: null, button: null, comment_reply: r.comment_reply, dm_variations: [], reply_variations: r.reply_variations ?? [], also_dms: false,
    repeat: r.repeat === "every" ? "every" : "once", followers: "any", hide_comment: false, delay_s: 0, active: r.active !== false, created_at: r.created_at ?? null,
    stats: { triggered: s?.triggered ?? 0, sent: s?.sent ?? 0, failed: s?.failed ?? 0, people: s?.people ?? 0, clicks: 0, unique_clicks: 0, ctr: null },
  };
}

/** A person's reply-only rules on the given accounts (none when the table is not there yet). */
export async function ownRulesOf(sb: SupabaseClient, u: string, accountIds: string[]): Promise<OwnRuleRow[]> {
  if (!accountIds.length) return [];
  const r = await sb.from("studio_reply_rules").select("*").eq("user_id", u).in("account_id", accountIds).order("created_at", { ascending: true });
  if (r.error) { if (/studio_reply_rules|does not exist|schema cache/i.test(String(r.error.message ?? ""))) return []; throw r.error; }
  return (r.data ?? []) as OwnRuleRow[];
}
/** Counts per rule from the log (at most the last 20,000 rows across them). */
export async function statsOf(sb: SupabaseClient, ruleIds: string[]): Promise<Map<string, RuleStats>> {
  const out = new Map<string, RuleStats>();
  if (!ruleIds.length) return out;
  const r = await sb.from("studio_reply_log").select("rule_id,status,commenter_id").in("rule_id", ruleIds).order("created_at", { ascending: false }).limit(20_000);
  if (r.error) return out;
  const people = new Map<string, Set<string>>();
  for (const x of (r.data ?? []) as any[]) {
    const s = out.get(x.rule_id) ?? { triggered: 0, sent: 0, failed: 0, people: 0 };
    s.triggered++; if (x.status === "sent") s.sent++; if (x.status === "failed") s.failed++;
    out.set(x.rule_id, s);
    if (x.commenter_id && x.status === "sent") { const p = people.get(x.rule_id) ?? new Set(); p.add(String(x.commenter_id)); people.set(x.rule_id, p); }
  }
  for (const [id, p] of people) out.get(id)!.people = p.size;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// A comment arrives
// ---------------------------------------------------------------------------------------------------
export type CommentEvent = {
  eventId: string; platform: string; accountId: string; postId: string | null; platformPostId: string | null; commentId: string;
  text: string; authorId: string | null; authorName: string | null; authorUsername: string | null; own: boolean; isReply: boolean;
};
/** The service's comment.received payload, read defensively (null when it is not one we can answer). */
export function parseCommentEvent(b: any): CommentEvent | null {
  if (!b || b.test || b.event !== "comment.received") return null;
  const c = b.comment ?? {}, a = b.account ?? {};
  const accountId = String(a.accountId ?? a.id ?? "");
  const commentId = String(c.id ?? "");
  const platform = String(c.platform ?? a.platform ?? "");
  if (!accountId || !commentId || !platform) return null;
  return {
    eventId: String(b.id ?? ""), platform, accountId, commentId,
    postId: b.post?.id ? String(b.post.id) : c.postId ? String(c.postId) : null,
    platformPostId: c.platformPostId ? String(c.platformPostId) : b.post?.platformPostId ? String(b.post.platformPostId) : null,
    text: typeof c.text === "string" ? c.text.slice(0, 2200) : "",
    authorId: c.author?.id ? String(c.author.id) : null, authorName: c.author?.name ? String(c.author.name) : null, authorUsername: c.author?.username ? String(c.author.username) : null,
    own: c.author?.isOwnAccount === true, isReply: c.isReply === true || !!c.parentCommentId,
  };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a comment says one of the rule's keywords (and none of its excluded words). Matching ignores case.
 *  word: the keyword as a whole word or phrase ("guide pls" yes, "guidebook" no); contains: anywhere; exact: the whole
 *  comment, apart from spaces, punctuation and emoji around it. */
export function keywordHit(rule: Pick<OwnRuleRow, "keywords" | "match" | "exclude">, text: string): boolean {
  const t = norm(text ?? "");
  if (!t.trim()) return false;
  const has = (k: string, mode: string) => {
    const kw = norm(k).trim();
    if (!kw) return false;
    if (mode === "contains") return t.includes(kw);
    if (mode === "exact") return t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") === kw;
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(kw)}($|[^\\p{L}\\p{N}_])`, "u").test(t);
  };
  if ((rule.exclude ?? []).some((x) => has(x, "contains"))) return false;
  return (rule.keywords ?? []).some((k) => has(k, rule.match ?? "word"));
}
/** {{first_name}} (and {{name}}, {{username}}) filled from the commenter; an unknown name leaves no gap behind. */
export function fillReply(text: string, ev: Pick<CommentEvent, "authorName" | "authorUsername">): string {
  const first = (ev.authorName ?? "").trim().split(/\s+/)[0] || (ev.authorUsername ?? "").trim();
  return text
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, (ev.authorName ?? "").trim() || first)
    .replace(/\{\{\s*username\s*\}\}/gi, ev.authorUsername ? `@${ev.authorUsername}` : "")
    .replace(/[ \t]{2,}/g, " ").replace(/\s+([!?.,])/g, "$1").trim();
}

export type CommentOutcome = { status: "ignored" | "no_rule" | "duplicate" | "already_answered" | "no_plan" | "sent" | "failed"; rule_id?: string; detail?: string };

/** Answer one comment if a reply-only rule asks for it. Never throws, never retries. */
export async function handleComment(sb: SupabaseClient, ev: CommentEvent, deps: SocialDeps & { random?: () => number; now?: () => number } = {}): Promise<CommentOutcome> {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  try {
    // the account's own comments (our replies come back as comments) and replies inside a thread are never answered
    if (ev.own || ev.isReply || !REPLY_ONLY_NETWORKS.includes(ev.platform) || !replyOnlyOn(env)) return { status: "ignored" };
    const r = await sb.from("studio_reply_rules").select("*").eq("account_id", ev.accountId).eq("active", true).order("created_at", { ascending: true });
    if (r.error) { log(`[reply-only] rules read failed: ${String(r.error.message ?? "").slice(0, 120)}`); return { status: "failed", detail: "rules" }; }
    const rules = ((r.data ?? []) as OwnRuleRow[]).filter((x) => (x.post_id ? x.post_id === ev.postId : x.platform_post_id ? x.platform_post_id === ev.platformPostId : true) && keywordHit(x, ev.text));
    if (!rules.length) return { status: "no_rule" };
    // one answer per comment: a rule for this post comes before one for every post
    const rule = rules.find((x) => x.post_id || x.platform_post_id) ?? rules[0];
    const cust = await sb.from("studio_customers").select("plan_id,status,owner_pass").eq("user_id", rule.user_id).maybeSingle();
    if (cust.error || !hasPlanAccess(cust.data)) return { status: "no_plan", rule_id: rule.id };
    if (ev.authorId) {
      let q = sb.from("studio_reply_log").select("id").eq("rule_id", rule.id).eq("commenter_id", ev.authorId).eq("status", "sent");
      if (rule.repeat === "every") q = q.gte("created_at", new Date((deps.now?.() ?? Date.now()) - EVERY_COOLDOWN_MS).toISOString());
      const seen = await q.limit(1);
      if (!seen.error && (seen.data ?? []).length) return { status: "already_answered", rule_id: rule.id };
    }
    const c = zernioClient({ env, fetch: deps.fetch, log });
    if (!c) return { status: "failed", rule_id: rule.id, detail: "off" };
    const options = [rule.comment_reply, ...(rule.reply_variations ?? [])].filter(Boolean);
    const message = fillReply(options[Math.floor((deps.random?.() ?? Math.random()) * options.length)] ?? rule.comment_reply, ev).slice(0, 500);
    if (!message) return { status: "failed", rule_id: rule.id, detail: "empty" };
    // the row first: the unique (rule, comment) pair stops a second delivery of the same event from answering twice
    const ins = await sb.from("studio_reply_log").insert({ rule_id: rule.id, user_id: rule.user_id, comment_id: ev.commentId, commenter_id: ev.authorId, commenter: ev.authorUsername ?? ev.authorName, comment_text: ev.text.slice(0, 500), reply_text: message, status: "sending" }).select("id").maybeSingle();
    if (ins.error) return { status: String((ins.error as any).code) === "23505" || /duplicate/i.test(String(ins.error.message)) ? "duplicate" : "failed", rule_id: rule.id };
    const rowId = (ins.data as any)?.id;
    const postRef = ev.postId ?? ev.platformPostId;
    let status: "sent" | "failed" = "failed", error: string | null = null;
    if (!postRef) error = "The post could not be found";
    else {
      try {
        const res = await c.call("POST", `/inbox/comments/${encodeURIComponent(postRef)}`, { body: { accountId: ev.accountId, message, commentId: ev.commentId }, headers: { "Idempotency-Key": `c8-reply-${rule.id}-${ev.commentId}`.slice(0, 200) }, timeoutMs: 20_000 });
        if (res.status < 300) status = "sent";
        else error = res.status === 403 || res.status === 401 ? "Clone8 is not allowed to reply on this account; allow it again in Auto-replies" : c.clean(res.body?.error ?? res.body?.message, "The network did not take the reply");
      } catch (e: any) { error = "No answer from the network; not sent again in case it went through"; void e; }
    }
    await sb.from("studio_reply_log").update({ status, error }).eq("id", rowId);
    recordEvent({ user_id: rule.user_id, kind: "feature", name: status === "sent" ? "autoreply_reply_sent" : "autoreply_reply_failed", props: { platform: ev.platform, one_post: !!(rule.post_id || rule.platform_post_id) } });
    if (status === "failed") log(`[reply-only] rule ${rule.id} reply failed: ${String(error).slice(0, 120)}`);
    return status === "sent" ? { status, rule_id: rule.id } : { status, rule_id: rule.id, detail: error ?? undefined };
  } catch (e: any) {
    log(`[reply-only] comment ${ev.commentId} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    return { status: "failed" };
  }
}
