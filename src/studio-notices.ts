// Clone8 Studio notices: the three emails a self-serve customer expects, sent once each.
//   1. A job finished (or failed, with the refund), as soon as it is final.
//   2. Credits are low: under 10% of the period's grant, once per period.
//   3. The plan renews in three days and unused credits expire, once per period end.
// Runs as a timer in the web service; every send is recorded in the row it concerns, so a restart repeats nothing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailConfigured, type MailDeps } from "./studio-mail.js";
import { planById } from "./studio.js";

export type NoticeDeps = MailDeps & { now?: () => Date };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function emailOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  const admin = (sb as any).auth?.admin;
  if (!admin?.getUserById) return null;
  const r = await admin.getUserById(userId);
  const email = r?.data?.user?.email;
  return typeof email === "string" ? email : null;
}
const dashboard = (env: Record<string, string | undefined>) => (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "");
const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.round(x));

/** What the job-finished mail says, from the job alone. Exported so the words are tested. */
export function jobNotice(job: any, env: Record<string, string | undefined>): { subject: string; text: string } {
  const tool = job.tool === "recast" ? "Recast" : job.tool === "blueprint_plus" ? "Blueprint+" : "Blueprint";
  const link = `${dashboard(env)}/#studio/${job.tool === "recast" ? "recast" : "blueprint"}`;
  if (job.status === "failed") {
    return { subject: `Your ${tool} job could not be completed`, text: `Your ${tool} job did not finish (${job.error_code ?? "unknown"}). Every credit it reserved (${n(job.credits_reserved)}) is back on your balance.\n\nTry again, or a different video: ${link}\n\nReply to this email if it keeps happening and we will look at the file with you.` };
  }
  const count = Array.isArray(job.outputs) ? job.outputs.length : 0;
  const what = job.tool === "recast" ? "Your recast is ready" : `${count} ${count === 1 ? "copy is" : "copies are"} ready`;
  return { subject: `${what} · Clone8 Studio`, text: `${what}. ${job.tool === "recast" ? "The character says every word you recorded." : "Each one is a rebuilt original with its own crop, timing and signature."}\n\nSee and download them: ${link}\n\nCharged ${n(job.credits_charged ?? job.credits_reserved)} credits. Files stay in your library for 30 days.` };
}

export async function noticesTick(sb: SupabaseClient, deps: NoticeDeps = {}): Promise<{ jobs: number; low: number; renewals: number; skipped: number }> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined), now = deps.now?.() ?? new Date();
  const out = { jobs: 0, low: 0, renewals: 0, skipped: 0 };
  // 1. Finished jobs.
  const jobs = await sb.rpc("studio_jobs_to_notify", { p_limit: 50 });
  if (jobs.error) throw jobs.error;
  for (const job of (jobs.data ?? []) as any[]) {
    if (!UUID_RE.test(job.user_id)) continue;
    const cust = await sb.from("studio_customers").select("email_opt_out").eq("user_id", job.user_id).maybeSingle();
    const to = cust.data?.email_opt_out ? null : await emailOf(sb, job.user_id);
    if (to) {
      const m = jobNotice(job, env);
      try { await sendMail({ to, ...m }, deps); out.jobs++; } catch (e: any) { log(`[notices] job ${job.id} mail failed: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
    } else out.skipped++;
    const mark = await sb.rpc("studio_mark_notified", { p_job: job.id });
    if (mark.error) throw mark.error;
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
    if (lowDue && balance < c.credits_per_period * 0.1) {
      const to = await emailOf(sb, c.user_id);
      if (to) {
        try {
          await sendMail({ to, subject: `${n(balance)} credits left · Clone8 Studio`, text: `You have ${n(balance)} credits left on your ${plan?.name ?? ""} plan${c.period_end ? `, which renews on ${new Date(c.period_end).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}` : ""}.\n\nAdd a pack for a busy month, or move up a plan: ${dashboard(env)}/#studio/account` }, deps);
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
          await sendMail({ to, subject: `Your plan renews on ${new Date(periodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })} · Clone8 Studio`, text: `Your ${plan?.name ?? ""} plan renews on ${new Date(periodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })} and you will receive ${n(c.credits_per_period)} fresh credits.\n\nYou have ${n(balance)} credits left; what is unused expires when the new ones arrive (pack credits do not). Use them: ${dashboard(env)}/#studio\n\nChange or cancel the plan any time from billing: ${dashboard(env)}/#studio/account` }, deps);
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
