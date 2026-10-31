// Clone8 Studio notices: the emails a self-serve customer expects, sent once each.
//   1. Results are ready (or a job did not finish, with the refund). One email per batch: jobs that finish together,
//      or the steps of a chat run, arrive as one message once nothing of that person's is still rendering (or after
//      15 minutes, so a long queue never holds back finished work).
//   2. Credits are low: under 10% of the period's grant, once per period.
//   3. The plan renews in three days and unused credits expire, once per period end.
// Runs as a timer in the web service; every send is recorded in the row it concerns, so a restart repeats nothing.
// The person can turn these off (Account, or the one-click link in each email); receipts are separate and always sent.
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailConfigured, renderEmail, unsubscribeUrl, type MailDeps } from "./studio-mail.js";
import { planById, jobLabel } from "./studio.js";

export type NoticeDeps = MailDeps & { now?: () => Date };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A batch is sent once its newest job has been final this long (so the next step of a chat run can start)... */
export const SETTLE_MS = 90_000;
/** ...and nothing of the person's is still rendering, or its oldest finished job has waited this long. */
export const MAX_HOLD_MS = 15 * 60_000;

async function emailOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  const admin = (sb as any).auth?.admin;
  if (!admin?.getUserById) return null;
  const r = await admin.getUserById(userId);
  const email = r?.data?.user?.email;
  return typeof email === "string" ? email : null;
}
const dashboard = (env: Record<string, string | undefined>) => (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "");
const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.round(x));
const longDate = (d: string | number | Date) => new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** What one finished job is called in a sentence ("Your Swap", "Your 12 Blueprint copies"). */
const copiesOf = (job: any) => (Array.isArray(job.outputs) && job.outputs.length ? job.outputs.length : Number(job.options?.copies) || 0);
export function jobNoun(job: any): string {
  const o = job.options ?? {}, count = copiesOf(job);
  switch (job.tool) {
    case "blueprint": return `${count || ""} Blueprint ${count === 1 ? "copy" : "copies"}`.trim();
    case "blueprint_plus": return `${count || ""} Blueprint+ ${count === 1 ? "copy" : "copies"}`.trim();
    case "recast": return "Recast";
    case "swap": return "Swap";
    case "restyle": return "styled video";
    case "trend": return "Trend video";
    case "character": return "character";
    case "instrument": return o.output === "image" ? "image" : o.output === "audio" ? "audio" : "video";
    default: return "result";
  }
}
const plural = (job: any) => (job.tool === "blueprint" || job.tool === "blueprint_plus") && copiesOf(job) !== 1;

/** The email for a batch of one person's finished jobs. Exported so the words are tested. */
export function jobsNotice(jobs: any[], env: Record<string, string | undefined>, userId?: string): { subject: string; text: string; html: string; unsubscribeUrl: string | null } {
  const done = jobs.filter((j) => j.status === "done"), failed = jobs.filter((j) => j.status !== "done");
  const library = `${dashboard(env)}/#studio/library`;
  const unsub = userId ? unsubscribeUrl(userId, env) : null;
  const refunded = failed.reduce((a, j) => a + Number(j.credits_reserved ?? 0), 0);
  let subject: string, heading: string, paragraphs: string[];
  if (jobs.length === 1 && done.length === 1) {
    const noun = jobNoun(done[0]);
    subject = `Your ${noun} ${plural(done[0]) ? "are" : "is"} ready`;
    heading = subject;
    paragraphs = [`${jobLabel(done[0])} finished rendering. It is in your library, ready to watch and download.`];
  } else if (jobs.length === 1) {
    const noun = jobNoun(failed[0]);
    subject = `Your ${noun} did not finish`;
    heading = subject;
    paragraphs = [`${jobLabel(failed[0])} stopped before it was done, so nothing was charged: the ${n(refunded)} credits it held are back on your balance.`, `You can run it again from the same page. If it stops again, reply to this email and we will look at the file with you.`];
  } else if (!failed.length) {
    subject = `${done.length} results are ready`;
    heading = `${done.length} results are ready`;
    paragraphs = ["Everything you started has finished rendering. It is all in your library, ready to watch and download."];
  } else {
    subject = done.length ? `${done.length} ready, ${failed.length} did not finish` : `${failed.length} jobs did not finish`;
    heading = subject;
    paragraphs = [...(done.length ? ["The finished ones are in your library, ready to watch and download."] : []), `What did not finish was not charged: ${n(refunded)} credits are back on your balance.`];
  }
  const rows = jobs.length > 1 ? jobs.slice(0, 12).map((j) => ({ label: jobLabel(j), value: j.status === "done" ? "Ready" : "Not finished, refunded" })) : undefined;
  const footer = [`Files stay in your library for 30 days.`, `You are getting this because you started this on Clone8 Studio. You can keep working or close the tab while things render; this email tells you when they are done.`];
  const body = renderEmail({ preheader: paragraphs[0], heading, paragraphs, rows, button: { label: done.length ? "Open your library" : "Open Clone8 Studio", url: done.length ? library : `${dashboard(env)}/#studio` }, footer, unsubscribeUrl: unsub });
  return { subject, ...body, unsubscribeUrl: unsub };
}

/** Kept for callers of the single-job form. */
export function jobNotice(job: any, env: Record<string, string | undefined>): { subject: string; text: string } {
  const m = jobsNotice([job], env);
  return { subject: m.subject, text: m.text };
}

export async function noticesTick(sb: SupabaseClient, deps: NoticeDeps = {}): Promise<{ jobs: number; low: number; renewals: number; skipped: number }> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined), now = deps.now?.() ?? new Date();
  const out = { jobs: 0, low: 0, renewals: 0, skipped: 0 };
  // 1. Finished jobs, one email per person per batch.
  const jobs = await sb.rpc("studio_jobs_to_notify", { p_limit: 200 });
  if (jobs.error) throw jobs.error;
  const byUser = new Map<string, any[]>();
  for (const job of (jobs.data ?? []) as any[]) { if (UUID_RE.test(job.user_id)) byUser.set(job.user_id, [...(byUser.get(job.user_id) ?? []), job]); }
  for (const [userId, batch] of byUser) {
    const times = batch.map((j) => Date.parse(j.finished_at ?? "") || now.getTime());
    const newest = Math.max(...times), oldest = Math.min(...times);
    if (now.getTime() - newest < SETTLE_MS && now.getTime() - oldest < MAX_HOLD_MS) continue; // the next step may be starting
    if (now.getTime() - oldest < MAX_HOLD_MS) {
      const live = await sb.from("studio_jobs").select("id").eq("user_id", userId).in("status", ["queued", "running"]).limit(1);
      if (live.error) throw live.error;
      if ((live.data ?? []).length) continue; // more is rendering: wait and send it all together
    }
    const cust = await sb.from("studio_customers").select("email_opt_out").eq("user_id", userId).maybeSingle();
    const to = cust.data?.email_opt_out ? null : await emailOf(sb, userId);
    if (to) {
      const m = jobsNotice(batch, env, userId);
      try { await sendMail({ to, subject: m.subject, text: m.text, html: m.html, unsubscribeUrl: m.unsubscribeUrl, kind: "jobs_done", userId }, deps); out.jobs += batch.length; }
      catch (e: any) { log(`[notices] jobs mail for ${userId} failed: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
    } else out.skipped += batch.length;
    for (const job of batch) { const mark = await sb.rpc("studio_mark_notified", { p_job: job.id }); if (mark.error) throw mark.error; }
  }
  // 2 and 3. Active customers: low balance and upcoming renewal.
  const custs = await sb.from("studio_customers").select("user_id,plan_id,status,period_start,period_end,credits_per_period,cancel_at_period_end,email_opt_out,low_credits_notified_at,renewal_notified_for").in("status", ["active", "trialing"]).limit(2000);
  if (custs.error) throw custs.error;
  for (const c of (custs.data ?? []) as any[]) {
    if (c.email_opt_out || !c.credits_per_period) continue;
    const periodStart = c.period_start ? Date.parse(c.period_start) : 0, periodEnd = c.period_end ? Date.parse(c.period_end) : 0;
    const lowDue = !c.low_credits_notified_at || Date.parse(c.low_credits_notified_at) < periodStart;
    const renewalDue = periodEnd > 0 && periodEnd - now.getTime() <= 3 * 86400000 && periodEnd > now.getTime() && !c.cancel_at_period_end && (!c.renewal_notified_for || Date.parse(c.renewal_notified_for) !== periodEnd);
    if (!lowDue && !renewalDue) continue;
    const bal = await sb.rpc("studio_balance", { p_user: c.user_id });
    const balance = Number(bal.data ?? 0);
    const plan = planById(c.plan_id);
    const account = `${dashboard(env)}/#studio/account`, unsub = unsubscribeUrl(c.user_id, env);
    if (lowDue && balance < c.credits_per_period * 0.1) {
      const to = await emailOf(sb, c.user_id);
      if (to) {
        try {
          const subject = `${n(balance)} credits left`, kind = "low_credits";
          const body = renderEmail({ preheader: `Your ${plan?.name ?? ""} plan has ${n(balance)} credits left.`, heading: `${n(balance)} credits left`, paragraphs: [`Your ${plan?.name ?? ""} plan has ${n(balance)} credits left${c.period_end ? `; it renews on ${longDate(c.period_end)}` : ""}.`, "Your account page shows your balance and the ways to add more when you need it."], button: { label: "See your balance", url: account }, footer: ["You are getting this because your Clone8 Studio balance ran low."], unsubscribeUrl: unsub });
          await sendMail({ to, subject, ...body, unsubscribeUrl: unsub, kind, userId: c.user_id }, deps);
          out.low++;
        } catch (e: any) { log(`[notices] low-credits mail failed for ${c.user_id}: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
      }
      const u = await sb.from("studio_customers").update({ low_credits_notified_at: now.toISOString() }).eq("user_id", c.user_id);
      if (u.error) throw u.error;
    }
    if (renewalDue) {
      const to = await emailOf(sb, c.user_id);
      if (to) {
        try {
          const subject = `Your plan renews on ${longDate(periodEnd)}`, kind = "renewal";
          const body = renderEmail({ preheader: `${n(c.credits_per_period)} new credits arrive on ${longDate(periodEnd)}.`, heading: subject, paragraphs: [`Your ${plan?.name ?? ""} plan renews on ${longDate(periodEnd)} with ${n(c.credits_per_period)} new credits.`, `You have ${n(balance)} credits left. Plan credits that are unused expire when the new ones arrive; top-up and bundle credits carry over.`, "You can change or cancel the plan from your account page."], button: { label: "Open your account", url: account }, footer: ["You are getting this because your Clone8 Studio plan renews soon."], unsubscribeUrl: unsub });
          await sendMail({ to, subject, ...body, unsubscribeUrl: unsub, kind, userId: c.user_id }, deps);
          out.renewals++;
        } catch (e: any) { log(`[notices] renewal mail failed for ${c.user_id}: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
      }
      const u = await sb.from("studio_customers").update({ renewal_notified_for: new Date(periodEnd).toISOString() }).eq("user_id", c.user_id);
      if (u.error) throw u.error;
    }
  }
  return out;
}

export function startNoticesLoop(sbFn: () => SupabaseClient, deps: NoticeDeps = {}, intervalMs = 60_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!mailConfigured(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  const tick = () => noticesTick(sbFn(), { ...deps, log }).then((r) => { if (r.jobs || r.low || r.renewals) log(`[notices] ${JSON.stringify(r)}`); }).catch((e) => log(`[notices] tick failed: ${String(e?.message ?? e).slice(0, 200)}`));
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 15_000);
  return t;
}
