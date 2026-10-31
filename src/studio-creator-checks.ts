// Clone8 Studio: the Creator Program's checks, so the owner does not have to look at every video and account. Every few
// hours (with the sync in studio-creators.ts) each rule in the program terms is checked from the data we already read:
// Ayrshare (the creator's own analytics, their post history, which accounts are linked) and ScrapeCreators (the public
// bio, followers). What fails becomes an issue on the video or the account:
//   - issues the creator can fix (bio line, account unlinked, no #clone8partner, not shown to be Clone8, removed early):
//     they are told by email (once a week at most per issue) and on the Earn page, and the next check clears them;
//   - issues only the owner can judge (numbers that look bought, the same video on two accounts): they hold the money
//     on that video until the owner clears or rejects it.
// Each statement is split into what is clear to pay and what is in question. A closed month with nothing in question is
// approved on its own; one with something in question waits, and is approved on its own once a later check clears it.
// Money is never sent by this code: the owner still pays and marks statements paid.
import type { SupabaseClient } from "@supabase/supabase-js";
import { RULES } from "./studio-creator-rules.js";
import { recordEvent } from "./studio-events.js";
import { mailConfigured, renderEmail, sendMail, type MailDeps } from "./studio-mail.js";

export type IssueCode = "bio_missing" | "unlinked" | "missing_tag" | "not_proven" | "removed_early" | "views_without_likes" | "no_comments" | "engagement_far_below_usual" | "followers_jumped" | "same_video_twice";
export const ISSUES: Record<IssueCode, { who: "creator" | "review"; title: string; fix: string }> = {
  bio_missing: { who: "creator", title: "Bio line missing", fix: `Put "${RULES.bio_phrase}" back in the account's bio.` },
  unlinked: { who: "creator", title: "Account unlinked from Clone8", fix: "Link the account again on the Publish page, so its videos and views can be read." },
  missing_tag: { who: "creator", title: `No ${RULES.disclosure_tag} in the caption`, fix: `Add ${RULES.disclosure_tag} to the caption (Instagram lets you edit it after posting).` },
  not_proven: { who: "creator", title: "Not shown to be made with Clone8", fix: "On the Earn page, link the post to the Clone8 video it is." },
  removed_early: { who: "creator", title: `Taken down before ${RULES.keep_live_days} days`, fix: `Videos stay public for ${RULES.keep_live_days} days. Put it back up, or it is taken out of the statement.` },
  views_without_likes: { who: "review", title: "Views without likes", fix: "Fewer than 1 like for every 500 views." },
  no_comments: { who: "review", title: "No comments on a big video", fix: "Over 200,000 views and no comments." },
  engagement_far_below_usual: { who: "review", title: "Engagement far below this creator's usual", fix: "Likes and comments per view under a fifth of their own median." },
  followers_jumped: { who: "review", title: "Followers jumped", fix: "More than three times the followers within two weeks of joining." },
  same_video_twice: { who: "review", title: "Same video on two accounts", fix: "The same Clone8 video is linked to posts on more than one account." },
};
/** Video flags that hold the money already counted on that video until the owner looks. */
const HOLDS: IssueCode[] = ["removed_early", "views_without_likes", "no_comments", "engagement_far_below_usual", "same_video_twice"];
/** Account flags that hold everything counted on that account's videos. */
const ACCOUNT_HOLDS: IssueCode[] = ["followers_jumped"];
const MICROS_PER_VIEW = Math.round((RULES.cpm_usd * 1_000_000) / 1000);
const usd = (micros: number) => Math.round(micros / 10_000) / 100;
const flagsOf = (x: any): string[] => (Array.isArray(x?.flags) ? x.flags : []);

export type Issue = { code: IssueCode; who: "creator" | "review"; title: string; fix: string; target: "account" | "video"; ref: string; label: string; url?: string | null };

/** Every open issue of one creator, from their accounts and their videos still in the counting window or under watch. */
export function issuesFor(accounts: any[], videos: any[]): Issue[] {
  const out: Issue[] = [];
  for (const a of accounts) {
    if (a.status === "removed") continue;
    for (const f of flagsOf(a)) if (f in ISSUES) out.push({ code: f as IssueCode, ...ISSUES[f as IssueCode], target: "account", ref: a.id, label: `@${a.username} on ${a.platform === "tiktok" ? "TikTok" : "Instagram"}` });
    if (a.status === "pending_bio" && !flagsOf(a).includes("bio_missing")) out.push({ code: "bio_missing", ...ISSUES.bio_missing, target: "account", ref: a.id, label: `@${a.username} on ${a.platform === "tiktok" ? "TikTok" : "Instagram"}` });
  }
  for (const v of videos) {
    if (v.status === "rejected") continue;
    const label = (v.caption || "A video").slice(0, 60);
    for (const f of flagsOf(v)) if (f in ISSUES) out.push({ code: f as IssueCode, ...ISSUES[f as IssueCode], target: "video", ref: v.id, label, url: v.url });
    // a post from the counting window that is still not shown to be Clone8, once it has views worth paying
    if (v.proof === "none" && Number(v.views) >= RULES.min_views) out.push({ code: "not_proven", ...ISSUES.not_proven, target: "video", ref: v.id, label, url: v.url });
  }
  return out;
}

/** A statement split by the checks: clear to pay, in question (held on flagged videos or accounts), and what is on hold
 *  (views on videos the creator still has to fix: they count once fixed, they are not owed yet). */
export async function reviewStatement(sb: SupabaseClient, userId: string, month: string): Promise<{ clear_micros: number; question_micros: number; on_hold_micros: number; issues: Issue[] }> {
  const [lines, st, videos, accounts] = await Promise.all([
    sb.from("studio_creator_earning_lines").select("video_id,amount_micros").eq("user_id", userId).eq("month", month).limit(5000),
    sb.from("studio_creator_earnings").select("amount_micros,carried_in_micros").eq("user_id", userId).eq("month", month).maybeSingle(),
    sb.from("studio_creator_videos").select("*").eq("user_id", userId).limit(1000),
    sb.from("studio_creator_accounts").select("*").eq("user_id", userId).limit(50),
  ]);
  for (const r of [lines, videos, accounts]) if (r.error) throw r.error;
  const vids = new Map(((videos.data ?? []) as any[]).map((v) => [v.id, v]));
  const accs = new Map(((accounts.data ?? []) as any[]).map((a) => [a.id, a]));
  const held = (v: any) => !!v && (flagsOf(v).some((f) => HOLDS.includes(f as IssueCode)) || flagsOf(accs.get(v.account_id)).some((f) => ACCOUNT_HOLDS.includes(f as IssueCode)));
  let question = 0;
  for (const l of (lines.data ?? []) as any[]) if (held(vids.get(l.video_id))) question += Number(l.amount_micros) || 0;
  const total = Number(st.data?.amount_micros ?? 0) + Number(st.data?.carried_in_micros ?? 0);
  // on hold: views a fixable video would earn now, if it were fixed (capped like any video, only inside the window)
  let onHold = 0;
  for (const v of vids.values()) {
    if (v.status !== "pending" || !v.posted_at || Date.now() - Date.parse(v.posted_at) > RULES.view_window_days * 86_400_000) continue;
    const views = Number(v.views) || 0;
    if (views >= RULES.min_views) onHold += Math.min(views, RULES.view_cap) * MICROS_PER_VIEW;
  }
  const watched = [...vids.values()].filter((v) => v.status !== "rejected" && v.posted_at && Date.now() - Date.parse(v.posted_at) <= RULES.keep_live_days * 86_400_000);
  return { clear_micros: Math.max(0, total - question), question_micros: question, on_hold_micros: onHold, issues: issuesFor([...accs.values()], watched) };
}

/** Engagement (likes and comments per view) far below the creator's own median on that account. Needs 5 videos to judge. */
export function engagementOutliers(videos: Array<{ id: string; views: number; likes: number | null; comments: number | null }>): Set<string> {
  const rate = (v: any) => ((Number(v.likes) || 0) + (Number(v.comments) || 0)) / Math.max(1, Number(v.views) || 0);
  const base = videos.filter((v) => Number(v.views) >= RULES.min_views && v.likes != null).map(rate).sort((a, b) => a - b);
  if (base.length < 5) return new Set();
  const median = base[Math.floor(base.length / 2)];
  return new Set(videos.filter((v) => Number(v.views) >= 20_000 && v.likes != null && rate(v) < median * 0.2).map((v) => v.id));
}

const setFlag = (flags: string[], code: string, on: boolean) => (on ? [...new Set([...flags, code])] : flags.filter((f) => f !== code));

/** After a sync of one account: engagement against the creator's own norm, videos taken down early, the same Clone8 video
 *  on two accounts. `present` is every post id the provider listed (null when the list may be incomplete). */
export async function checkAccountVideos(sb: SupabaseClient, account: any, present: { ids: Set<string>; oldest: number } | null, now: Date = new Date()): Promise<void> {
  const vids = await sb.from("studio_creator_videos").select("*").eq("account_id", account.id).limit(500);
  if (vids.error) throw vids.error;
  const all = (vids.data ?? []) as any[];
  const low = engagementOutliers(all);
  for (const v of all) {
    let flags = setFlag(flagsOf(v), "engagement_far_below_usual", low.has(v.id));
    // gone from the account's own post list while it should still be up (only judged inside the stretch the list covers)
    if (present && v.posted_at && Date.parse(v.posted_at) >= present.oldest && now.getTime() - Date.parse(v.posted_at) <= RULES.keep_live_days * 86_400_000 && Number(v.views_counted) > 0) flags = setFlag(flags, "removed_early", !present.ids.has(v.platform_post_id));
    // the same Clone8 video linked to posts on other accounts
    if (v.job_id) {
      const twin = await sb.from("studio_creator_videos").select("id,account_id").eq("job_id", v.job_id).eq("output_key", v.output_key).neq("id", v.id).limit(5);
      flags = setFlag(flags, "same_video_twice", ((twin.data ?? []) as any[]).some((t) => t.account_id !== v.account_id));
    }
    if (flags.join(",") !== flagsOf(v).join(",")) await sb.from("studio_creator_videos").update({ flags, updated_at: now.toISOString() }).eq("id", v.id);
  }
}

/** Accounts unlinked from the person's Ayrshare profile can no longer be read: flagged until linked again. */
export function stillLinked(account: any, linked: any[]): boolean {
  return linked.some((l) => l?.platform === account.platform && String(l?.username ?? "").replace(/^@/, "").toLowerCase() === String(account.username).toLowerCase());
}

/** Statements waiting in review: approved on their own when nothing is in question any more; the note says where they stand. */
export async function settleReviews(sb: SupabaseClient, now: Date = new Date(), log: (s: string) => void = () => undefined): Promise<number> {
  const rows = await sb.from("studio_creator_earnings").select("user_id,month,status,note").eq("status", "review").limit(1000);
  if (rows.error) throw rows.error;
  let approved = 0;
  for (const e of (rows.data ?? []) as any[]) {
    const r = await reviewStatement(sb, e.user_id, e.month);
    if (r.question_micros === 0) {
      await sb.from("studio_creator_earnings").update({ status: "approved", note: `Every check passed (${now.toISOString().slice(0, 10)}); ready to pay`, updated_at: now.toISOString() }).eq("user_id", e.user_id).eq("month", e.month).eq("status", "review");
      approved++; log(`[creators] auto-approved ${e.user_id} ${e.month}`);
    } else {
      const note = `$${usd(r.question_micros).toFixed(2)} in question (${r.issues.filter((i) => i.who === "review").length} to review); $${usd(r.clear_micros).toFixed(2)} clear`;
      if (note !== e.note) await sb.from("studio_creator_earnings").update({ note, updated_at: now.toISOString() }).eq("user_id", e.user_id).eq("month", e.month).eq("status", "review");
    }
  }
  return approved;
}

/** Tell a creator what to fix (the issues they can fix), at most once a week per issue unless `force`. Returns whether sent. */
export async function notifyCreator(sb: SupabaseClient, userId: string, issues: Issue[], deps: MailDeps & { dashboard?: string; force?: boolean } = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const fixable = issues.filter((i) => i.who === "creator");
  if (!fixable.length || !mailConfigured(env)) return false;
  const keyOf = (i: Issue) => `${i.code}:${i.ref}`;
  let fresh = fixable;
  if (!deps.force) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const sent = await sb.from("studio_events").select("props").eq("kind", "email").eq("name", "creator_issue_keys").eq("user_id", userId).gte("created_at", since).limit(50);
    const told = new Set(((sent.data ?? []) as any[]).flatMap((e) => (Array.isArray(e.props?.keys) ? e.props.keys : [])));
    fresh = fixable.filter((i) => !told.has(keyOf(i)));
    if (!fresh.length) return false;
  }
  const user = await (sb as any).auth?.admin?.getUserById?.(userId).catch(() => null);
  const to = user?.data?.user?.email;
  if (!to) return false;
  const earn = `${(deps.dashboard ?? env.DASHBOARD_URL ?? "https://app.clone8.io").replace(/\/+$/, "")}/#studio/earn`;
  const body = renderEmail({
    preheader: `${fixable.length === 1 ? "One thing" : `${fixable.length} things`} to fix so your Creator Program views count.`,
    heading: fixable.length === 1 ? "One thing to fix to get paid" : `${fixable.length} things to fix to get paid`,
    paragraphs: ["Your Clone8 Creator Program check found something that stops views from counting. Fix it and the next check (every few hours) picks it up; nothing else to do."],
    rows: fixable.slice(0, 8).map((i) => ({ label: `${i.title} · ${i.label}`, value: i.fix })),
    button: { label: "Open Earn", url: earn },
    footer: ["You get this because you joined the Clone8 Creator Program. Questions: support@clone8.io"],
  });
  await sendMail({ to, subject: fixable.length === 1 ? "Fix one thing to keep earning" : `Fix ${fixable.length} things to keep earning`, ...body, kind: "creator_issues", userId }, deps);
  recordEvent({ user_id: userId, kind: "email", name: "creator_issue_keys", props: { keys: fixable.map(keyOf) } });
  return true;
}
