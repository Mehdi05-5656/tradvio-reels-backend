// Emails to people who signed up and did not pick a plan. Two, then nothing more:
//   plan_30m   30 minutes after sign-up: what they set out to make, the way to a plan, an invitation to reply.
//   plan_day1  a day after the first: what a plan holds, in numbers.
// Rules, all checked again at the moment of sending:
//   - only people with no plan (status "none", never a subscription, no owner pass) who have made nothing;
//   - never to someone who turned emails off, never to our own accounts;
//   - Europe (EU, EEA, UK, Switzerland) is left out unless STUDIO_NUDGE_EUROPE=on: marketing email there wants an
//     agreement we do not collect at sign-up;
//   - a step is claimed in studio_nudges before it is sent, so it is sent once; a failed send is not retried.
// Pace: one email a tick and STUDIO_NUDGE_MAX_PER_HOUR (15) an hour, newest sign-ups first, so people who signed up
// before this existed are worked through slowly instead of in one burst (a burst is what spam filters look for).
// Off unless STUDIO_NUDGES=on (and mail is configured).
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailConfigured, renderEmail, unsubscribeUrl, type MailDeps } from "./studio-mail.js";
import { isInternalEmail } from "./studio-admin-auth.js";
import { PLANS } from "./studio.js";
import { storyCredits } from "./studio-stories.js";
import { longformCredits } from "./studio-longform.js";

export type NudgeStep = "plan_30m" | "plan_day1";
export type NudgeDeps = MailDeps & { now?: () => Date };
export const FIRST_AFTER_MS = 30 * 60_000;
export const SECOND_AFTER_MS = 24 * 3600_000;
/** People who signed up longer ago than this are left alone. */
export const MAX_AGE_MS = 60 * 86400_000;
const EUROPE = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" "));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.round(x));
const dashboard = (env: Record<string, string | undefined>) => (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "");

export const nudgesOn = (env: Record<string, string | undefined> = process.env) => env.STUDIO_NUDGES === "on" && mailConfigured(env);
export const maxPerHour = (env: Record<string, string | undefined> = process.env) => { const v = Number(env.STUDIO_NUDGE_MAX_PER_HOUR); return Number.isFinite(v) && v >= 0 ? Math.min(60, Math.floor(v)) : 15; };

/** What each sign-up goal is called, what it makes, and the page it opens. */
type Goal = { tool: string; first: string; wanted: string; makes: string; page: string };
const GOALS: Record<string, Goal> = {
  stories: { tool: "Stories", first: "first Story", wanted: "make faceless shorts from an idea", makes: "In Stories you type one sentence and get a narrated 3D short, ready to post.", page: "stories" },
  films: { tool: "Films", first: "first film", wanted: "run a faceless YouTube channel", makes: "In Films you type one prompt and get a narrated long film with its thumbnail and description.", page: "films" },
  clips: { tool: "Clips", first: "first clips", wanted: "turn long videos into shorts", makes: "In Clips you give one long video and get its best moments cut, framed and captioned for TikTok, Reels and Shorts.", page: "clips" },
  captions: { tool: "Captions", first: "first captioned video", wanted: "add captions that keep people watching", makes: "In Captions you drop a video in and get word-timed animated captions on it.", page: "captions" },
  multiply: { tool: "Blueprint", first: "first Blueprint copies", wanted: "post one video across many accounts as originals", makes: "In Blueprint you give one video and get up to 50 original versions of it, one for every account.", page: "blueprint" },
  remake: { tool: "Accounts", first: "first remake", wanted: "remake an account's videos as your own", makes: "In Accounts you bring in a profile's posts and turn them into videos that are yours.", page: "accounts" },
  swap: { tool: "Swap", first: "first swap", wanted: "put someone else in your video", makes: "In Swap you pick a video and a face, and the person in it is replaced from the first frame to the last.", page: "swap" },
  character: { tool: "AI Influencer", first: "first character", wanted: "build an AI influencer", makes: "In AI Influencer you design one character and keep the same face across every video.", page: "influencer" },
  trends: { tool: "Trends", first: "first trend video", wanted: "get on trends fast", makes: "In Trends you pick what is moving today and get your own version of it.", page: "trends" },
  ads: { tool: "Kage", first: "first ad", wanted: "make ads and product videos", makes: "In Kage you write a short brief and get a narrated motion film of your product.", page: "kage" },
  generate: { tool: "Instruments", first: "first video", wanted: "create from a prompt", makes: "Instruments holds every video, image and voice model in one place, each one a prompt away.", page: "instruments" },
  publish: { tool: "Publish", first: "first scheduled post", wanted: "post, schedule and track everything", makes: "In Publish you connect your accounts once and schedule everything you make from one page.", page: "publish" },
};
GOALS.network = GOALS.multiply; GOALS.faceless = { ...GOALS.swap, wanted: "go faceless" }; GOALS.analytics = GOALS.publish;

export function goalOf(onboarding: any): Goal | null {
  const ob = onboarding && typeof onboarding === "object" ? onboarding : {};
  const order = [ob.goal, ...(Array.isArray(ob.goals) ? ob.goals : [])].filter((g) => typeof g === "string");
  for (const g of order) if (GOALS[g]) return GOALS[g];
  return null;
}

export type NudgeMail = { subject: string; text: string; html: string; unsubscribeUrl: string | null };
/** The words of one step for one person. Exported so they are tested and previewed. */
export function nudgeEmail(step: NudgeStep, who: { userId: string; onboarding?: any }, env: Record<string, string | undefined> = process.env): NudgeMail {
  const goal = goalOf(who.onboarding);
  // the link says which email it came from (?e=), so the admin panel can count who pressed it; nothing else is tracked
  const app = dashboard(env), plans = `${app}/#studio/pricing?e=${step}`;
  const unsub = unsubscribeUrl(who.userId, env);
  const signoff = (env.STUDIO_MAIL_SIGNER || "The Clone8 team").trim();
  const footer = ["You are getting this because you created a Clone8 account and have not picked a plan.", ...(env.STUDIO_MAIL_ADDRESS ? [env.STUDIO_MAIL_ADDRESS.trim()] : [])];
  if (step === "plan_30m") {
    const subject = `Your ${goal?.first ?? "first video"} is one step away`;
    const body = renderEmail({
      preheader: "Your account is set up. Pick a plan and make it.",
      heading: subject,
      paragraphs: [
        "You set up your Clone8 account but have not picked a plan yet, so nothing has been made.",
        goal ? `You told us you want to ${goal.wanted}. ${goal.makes}` : "Clone8 turns one idea or one video into finished shorts, clips and films, ready to post.",
        "Every plan opens every tool, and you can cancel any time.",
      ],
      button: { label: "Pick a plan", url: plans },
      after: ["If something stopped you, a question, the price, or something that looked broken, reply to this email. A person reads every reply."],
      signoff, footer, unsubscribeUrl: unsub,
    });
    return { subject, ...body, unsubscribeUrl: unsub };
  }
  // a day later: what a plan holds, in numbers, with the person's own tool worked out where its price is fixed
  const worked = goal?.tool === "Stories" ? (() => { const c = storyCredits(env, PLANS, 45); return c > 0 ? `A 45-second Story costs ${n(c)} credits.` : null; })()
    : goal?.tool === "Films" ? (() => { const c = longformCredits(env, PLANS, 2); return c > 0 ? `A 2-minute film costs ${n(c)} credits. Longer films cost more, and the price shows before you press Generate.` : null; })()
    : null;
  const subject = goal ? `What a plan gets you in ${goal.tool}` : "What a Clone8 plan gets you";
  const body = renderEmail({
    preheader: "Every tool on every plan. The numbers, side by side.",
    heading: subject,
    paragraphs: [
      "You have a Clone8 account without a plan. Here is what each plan holds, so you can pick with the numbers in front of you.",
      ...(worked ? [worked] : []),
    ],
    rows: PLANS.map((p) => ({ label: `${p.name} · $${p.monthly_usd} a month`, value: `${n(p.credits)} credits` })),
    button: { label: "Compare the plans", url: plans },
    after: ["Every plan has every tool and every model. Credits are what you spend to make things, and each tool shows its price before you press Generate. Paying yearly costs less per month, and you can cancel any time.", "Not sure which one fits? Reply with what you want to make and we will tell you."],
    signoff, footer, unsubscribeUrl: unsub,
  });
  return { subject, ...body, unsubscribeUrl: unsub };
}

export type NudgeCustomer = { user_id: string; status: string | null; created_at: string; onboarding?: any; country?: string | null; email_opt_out?: boolean | null; owner_pass?: boolean | null; stripe_subscription_id?: string | null };
export type NudgeRow = { user_id: string; step: NudgeStep; status: string; created_at: string; sent_at?: string | null };
export const eligible = (c: NudgeCustomer, env: Record<string, string | undefined> = process.env) =>
  UUID_RE.test(c.user_id) && (c.status ?? "none") === "none" && !c.stripe_subscription_id && !c.owner_pass && !c.email_opt_out && (env.STUDIO_NUDGE_EUROPE === "on" || !c.country || !EUROPE.has(String(c.country).toUpperCase()));

/** Who is due which step now, newest sign-ups first. Pure: the tick does the reading and the sending. */
export function dueNudges(customers: NudgeCustomer[], sent: NudgeRow[], now: Date, env: Record<string, string | undefined> = process.env): Array<{ customer: NudgeCustomer; step: NudgeStep }> {
  const by = new Map<string, Map<string, NudgeRow>>();
  for (const r of sent) by.set(r.user_id, (by.get(r.user_id) ?? new Map()).set(r.step, r));
  const out: Array<{ customer: NudgeCustomer; step: NudgeStep; at: number }> = [];
  for (const c of customers) {
    if (!eligible(c, env)) continue;
    const made = Date.parse(c.created_at); if (!Number.isFinite(made)) continue;
    const age = now.getTime() - made; if (age < FIRST_AFTER_MS || age > MAX_AGE_MS) continue;
    const mine = by.get(c.user_id), first = mine?.get("plan_30m");
    if (!first) { out.push({ customer: c, step: "plan_30m", at: made }); continue; }
    if (first.status !== "sent" || mine?.get("plan_day1")) continue; // the second only follows a first that went out
    const firstAt = Date.parse(first.sent_at ?? first.created_at);
    if (now.getTime() - firstAt >= SECOND_AFTER_MS) out.push({ customer: c, step: "plan_day1", at: made });
  }
  return out.sort((a, b) => b.at - a.at).map(({ customer, step }) => ({ customer, step }));
}

async function emailOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  const r = await (sb as any).auth?.admin?.getUserById?.(userId);
  const email = r?.data?.user?.email;
  return typeof email === "string" ? email : null;
}

/** One pass: at most `perTick` emails, never more than the hour's allowance. */
export async function nudgesTick(sb: SupabaseClient, deps: NudgeDeps = {}, perTick = 1): Promise<{ sent: number; skipped: number; failed: number; waiting: number }> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined), now = deps.now?.() ?? new Date();
  const out = { sent: 0, skipped: 0, failed: 0, waiting: 0 };
  if (!nudgesOn(env)) return out;
  const hour = await sb.from("studio_nudges").select("id", { count: "exact", head: true }).in("status", ["sent", "sending"]).gte("created_at", new Date(now.getTime() - 3600_000).toISOString());
  if (hour.error) throw hour.error;
  let room = Math.min(perTick, maxPerHour(env) - (hour.count ?? 0));
  const custs = await sb.from("studio_customers").select("user_id,status,created_at,onboarding,country,email_opt_out,owner_pass,stripe_subscription_id").eq("status", "none").gte("created_at", new Date(now.getTime() - MAX_AGE_MS).toISOString()).order("created_at", { ascending: false }).limit(1000);
  if (custs.error) throw custs.error;
  const rows = await sb.from("studio_nudges").select("user_id,step,status,created_at,sent_at").gte("created_at", new Date(now.getTime() - MAX_AGE_MS - 2 * 86400_000).toISOString()).limit(5000);
  if (rows.error) throw rows.error;
  const due = dueNudges((custs.data ?? []) as NudgeCustomer[], (rows.data ?? []) as NudgeRow[], now, env);
  out.waiting = due.length;
  for (const d of due) {
    if (room <= 0) break;
    const u = d.customer.user_id;
    // the claim: whoever inserts the row sends the step (a duplicate key means another pass has it)
    const claim = await sb.from("studio_nudges").insert({ user_id: u, step: d.step, status: "sending" }).select("id").maybeSingle();
    if (claim.error) { if (String((claim.error as any).code) === "23505") continue; throw claim.error; }
    const id = claim.data?.id;
    const close = async (status: "sent" | "failed" | "skipped", extra: Record<string, unknown> = {}) => { const r = await sb.from("studio_nudges").update({ status, ...extra }).eq("id", id); if (r.error) throw r.error; };
    // read the person again, now: a plan bought a minute ago stops the email
    const fresh = await sb.from("studio_customers").select("user_id,status,created_at,onboarding,country,email_opt_out,owner_pass,stripe_subscription_id").eq("user_id", u).maybeSingle();
    if (fresh.error) throw fresh.error;
    if (!fresh.data || !eligible(fresh.data as NudgeCustomer, env)) { await close("skipped", { reason: "no_longer_eligible" }); out.skipped++; continue; }
    const jobs = await sb.from("studio_jobs").select("id").eq("user_id", u).limit(1);
    if (jobs.error) throw jobs.error;
    if ((jobs.data ?? []).length) { await close("skipped", { reason: "has_made_something" }); out.skipped++; continue; }
    const to = await emailOf(sb, u);
    if (!to || isInternalEmail(to, env)) { await close("skipped", { reason: to ? "internal" : "no_email" }); out.skipped++; continue; }
    const m = nudgeEmail(d.step, { userId: u, onboarding: (fresh.data as any).onboarding }, env);
    if (!m.unsubscribeUrl) { await close("skipped", { reason: "no_unsubscribe_link" }); out.skipped++; continue; } // never without a way out
    try {
      const messageId = await sendMail({ to, subject: m.subject, text: m.text, html: m.html, unsubscribeUrl: m.unsubscribeUrl, kind: d.step === "plan_30m" ? "plan_nudge_30m" : "plan_nudge_day1", userId: u }, deps);
      await close("sent", { message_id: messageId, sent_at: now.toISOString() });
      out.sent++; room--;
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 160);
      log(`[nudges] ${d.step} for ${u} failed: ${reason}`);
      await close("failed", { reason });
      out.failed++; room--; // a refused send still counts against the pace
    }
  }
  return out;
}

export function startNudgesLoop(sbFn: () => SupabaseClient, deps: NudgeDeps = {}, intervalMs = 60_000): NodeJS.Timeout | null {
  const env = deps.env ?? process.env;
  if (!nudgesOn(env)) return null;
  const log = deps.log ?? ((l: string) => console.log(l));
  log(`[nudges] on: up to ${maxPerHour(env)} an hour${env.STUDIO_NUDGE_EUROPE === "on" ? "" : ", Europe left out"}`);
  const tick = () => nudgesTick(sbFn(), { ...deps, log }).then((r) => { if (r.sent || r.failed || r.skipped) log(`[nudges] ${JSON.stringify(r)}`); }).catch((e) => log(`[nudges] tick failed: ${String(e?.message ?? e).slice(0, 200)}`));
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 45_000);
  return t;
}
