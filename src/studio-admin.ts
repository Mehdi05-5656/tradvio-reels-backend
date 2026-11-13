// The Studio admin panel's numbers (GET /api/studio/admin/metrics), for the owner's account only (studio-admin-auth.ts).
// Everything comes from what the Studio already keeps, read with the service role:
//   money in   live Stripe events (studio_stripe_events; sandbox events are counted apart, never as revenue) and auto
//              top-ups (ledger grants "Auto top-up $N", charged off-session without a checkout)
//   money out  per job: what Higgsfield charged (progress.spend_usd, booked when a render completes) or its estimate,
//              else our rate table; Claude and other paid services from studio_events; Stripe's fee per charge
//   usage      jobs (tool, where they came from, render time, retries and every fallback), chats, automations, posts,
//              Performance, uploads, emails, checkouts started, pages opened, sign-ups and the questions after sign-up
// computeAdmin() is pure (tests feed it rows); loadAdminData() reads the tables; registerStudioAdmin() serves it.
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANS, jobLabel, planById, toolsEnabled } from "./studio.js";
import { BLUEPRINT_COPY_COST_USD, BLUEPRINT_PLUS_COPY_COST_USD, CHARACTER_IMAGE_COST_USD, STRIPE_FEE, creditValueFloor, higgsfieldCostPerSecond, higgsfieldDiscount, netPerCredit, seedanceEditCostPerSecond } from "./studio-pricing.js";
import { signupInsights } from "./studio-onboarding.js";
import { isInternalEmail, isStudioAdmin } from "./studio-admin-auth.js";

type Env = Record<string, string | undefined>;
const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100, r4 = (x: number) => Math.round(x * 10000) / 10000;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dayOf = (iso: string) => iso.slice(0, 10);

export type AdminData = {
  users: Array<{ id: string; email: string | null; created_at: string; email_confirmed_at: string | null; last_sign_in_at: string | null }>;
  customers: any[]; jobs: any[]; ledger: any[]; stripe: any[]; conversations: any[]; automations: any[];
  posts: any[]; profiles: any[]; insights: any[]; perfAccounts: any[]; assets: any[]; events: any[]; memory: any[];
};
export type AdminOptions = { days: number | null; includeInternal: boolean; now?: Date };

export const TOOL_LABEL: Record<string, string> = { blueprint: "Blueprint", blueprint_plus: "Blueprint+", recast: "Recast", swap: "Swap", restyle: "Styles", trend: "Trends", character: "Characters", instrument: "Instruments",
  // everything that has shipped since: without a name here the panel showed the raw tool id
  clips: "Clips", captions: "Captions", kage_motion: "Kage", longform: "Films", kage: "Kage remix", import: "Import" };
const RENDER_TOOLS = new Set(["recast", "swap", "restyle", "trend"]);

// ---------------------------------------------------------------------------------------------------
// One job's cost to us, and where the figure comes from
// ---------------------------------------------------------------------------------------------------
export type CostSource = "billed" | "estimate" | "table" | "model" | "legacy" | "calls" | "none";
export function jobCost(j: any, env: Env = process.env): { usd: number; source: CostSource } {
  const p = j.progress ?? {}, o = j.options ?? {}, outs: any[] = Array.isArray(j.outputs) ? j.outputs : [];
  const done = j.status === "done";
  if (RENDER_TOOLS.has(j.tool)) {
    if (p.spend_usd != null) {
      // booked when a render completes (from Oct 31 2026): exact or Higgsfield's own estimate
      if (p.spend_priced) return { usd: num(p.spend_usd), source: p.spend_priced as CostSource };
      // older jobs booked at submission: a failed request was not billed, so a failed job's figure is not counted
      return done ? { usd: num(p.spend_usd), source: "legacy" } : { usd: 0, source: "none" };
    }
    if (!done) return { usd: 0, source: "none" };
    const seconds = outs.reduce((n, x) => n + num(x?.duration), 0) || num(o.seconds);
    const seedance = p.engine === "seedance" || outs.some((x) => x?.engine === "seedance");
    const rate = seedance ? seedanceEditCostPerSecond(env) : higgsfieldCostPerSecond(o.model === "full" ? "full" : "light", env);
    return { usd: seconds * rate, source: "model" };
  }
  if (!done) return { usd: 0, source: "none" };
  if (j.tool === "instrument") {
    if (o.cost_usd != null) return { usd: num(o.cost_usd), source: o.priced_by === "table" ? "table" : "estimate" };
    return { usd: num(o.usd), source: "legacy" };
  }
  if (j.tool === "character") return { usd: (outs.length || num(o.count) || 1) * CHARACTER_IMAGE_COST_USD * (1 - higgsfieldDiscount(env)), source: "model" };
  if (j.tool === "blueprint") return { usd: outs.length * BLUEPRINT_COPY_COST_USD, source: "model" };
  if (j.tool === "blueprint_plus") return { usd: outs.length * BLUEPRINT_PLUS_COPY_COST_USD, source: "model" };
  // Kage, Stories and Films carry what one film is budgeted to cost us (set when the job is priced). Until Nov 10 2026
  // this was not read, so every finished film counted as free.
  if ((j.tool === "kage_motion" || j.tool === "longform") && o.cost_usd != null) return { usd: num(o.cost_usd), source: "estimate" };
  return { usd: 0, source: "none" };
}

// Clips, Captions and imports run on our own workers, so the job keeps no bill. What they do cost is on record
// elsewhere: the video download (a paid proxy, logged per job), the Claude calls (logged per person and time), and the
// transcript (ElevenLabs, at our rate per hour). The servers themselves are a fixed monthly cost and are not in here.
const WORKER_TOOLS = new Set(["clips", "captions", "import"]);
const RENDER_USD_PER_CLIP = 0.004; // CPU and the stored file, per clip made (CLIP_COST)
const TRANSCRIBE_USD_PER_HOUR = 0.22; // ElevenLabs scribe with word times (studio-clips.ts CLIP_COST)
const CALL_PREFIX: Record<string, string[]> = { clips: ["clips_", "captions_"], captions: ["captions_", "caption"], import: [] };
/** What each worker job cost in recorded calls. Only the log and the per-tool table use this: the panel's totals
 *  already count every Claude and vendor event once, so adding these to a job there would count them twice. */
export function callCostByJob(d: AdminData): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, usd: number) => out.set(id, (out.get(id) ?? 0) + usd);
  const byUser = new Map<string, any[]>();
  for (const j of d.jobs) if (WORKER_TOOLS.has(j.tool)) { const l = byUser.get(j.user_id) ?? []; l.push(j); byUser.set(j.user_id, l); out.set(String(j.id), 0); }
  for (const e of d.events) {
    if (e.kind !== "vendor" && e.kind !== "claude") continue;
    const tagged = e.props?.job != null ? String(e.props.job) : null;
    if (tagged) { if (out.has(tagged)) add(tagged, num(e.usd)); continue; }
    if (e.kind !== "claude" || !e.user_id) continue;
    // a Claude call names no job: it belongs to that person's job of the same kind that was running at the time
    // (from 15 minutes before it was queued, when the page prices and previews, to when it finished)
    const t = Date.parse(e.created_at);
    const hit = (byUser.get(e.user_id) ?? []).filter((j) => (CALL_PREFIX[j.tool] ?? []).some((p) => String(e.name).startsWith(p)) && t >= Date.parse(j.created_at) - 15 * 60_000 && t <= (j.finished_at ? Date.parse(j.finished_at) : Date.parse(j.created_at) + 6 * 3_600_000))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (hit) add(String(hit.id), num(e.usd));
  }
  for (const j of d.jobs) if ((j.tool === "clips" || j.tool === "captions") && j.status === "done") add(String(j.id), (num(j.options?.seconds) / 3600) * TRANSCRIBE_USD_PER_HOUR + (j.tool === "clips" ? (Array.isArray(j.outputs) ? j.outputs.length : 0) * RENDER_USD_PER_CLIP : 0));
  return out;
}
/** A job's cost for the log: its own figure, or for a worker job what its calls cost. */
export function jobCostFull(j: any, calls: Map<string, number>, env: Env = process.env): { usd: number; source: CostSource } {
  const c = jobCost(j, env);
  if (c.source === "none" && WORKER_TOOLS.has(j.tool) && calls.has(String(j.id)) && (j.status === "done" || (calls.get(String(j.id)) ?? 0) > 0)) return { usd: calls.get(String(j.id)) ?? 0, source: "calls" };
  return c;
}

/** Where a job was started: the tool page, a chat, a chat an automation opened, or the person's own AI through the
 *  connector (Claude). Older jobs: from the chats' runs. */
export function jobVia(j: any, chatJobs: Set<string>, autoJobs: Set<string>): "tool" | "chat" | "automation" | "connector" | "unknown" {
  const v = j.options?.via;
  if (v === "tool" || v === "chat" || v === "automation" || v === "connector") return v;
  if (autoJobs.has(j.id)) return "automation";
  if (chatJobs.has(j.id)) return "chat";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------
// Money in: live Stripe events and auto top-ups
// ---------------------------------------------------------------------------------------------------
export type Payment = { at: string; user_id: string | null; kind: "new_plan" | "renewal" | "upgrade" | "pack" | "topup" | "auto_topup" | "seat" | "other"; usd: number; plan?: string | null; interval?: string | null; ref: string };
export const PAYMENT_LABEL: Record<Payment["kind"], string> = { new_plan: "New plans", renewal: "Renewals", upgrade: "Upgrades", pack: "Credit packs", topup: "Top-ups", auto_topup: "Auto top-ups", seat: "Extra social accounts", other: "Other" };

/** Which plan and interval a Stripe price id is, from the STRIPE_PRICE_* settings. */
export function priceMap(env: Env = process.env): Map<string, { kind: "plan" | "seat" | "pack"; plan?: string; interval?: string }> {
  const m = new Map<string, { kind: "plan" | "seat" | "pack"; plan?: string; interval?: string }>();
  for (const p of PLANS) for (const i of ["month", "year"]) { const id = env[`STRIPE_PRICE_${p.id.toUpperCase()}_${i.toUpperCase()}`]; if (id) m.set(id, { kind: "plan", plan: p.id, interval: i }); }
  for (const i of ["month", "year"]) { const id = env[`STRIPE_PRICE_SOCIAL_ACCOUNT_${i.toUpperCase()}`]; if (id) m.set(id, { kind: "seat", interval: i }); }
  for (const k of ["PACK_500", "PACK_2000", "PACK_6000"]) { const id = env[`STRIPE_PRICE_${k}`]; if (id) m.set(id, { kind: "pack" }); }
  return m;
}

export function paymentsFrom(stripe: any[], ledger: any[], customers: any[], env: Env = process.env): { payments: Payment[]; sandbox: number } {
  const byCustomer = new Map<string, string>(customers.filter((c) => c.stripe_customer_id).map((c) => [String(c.stripe_customer_id), c.user_id]));
  const prices = priceMap(env);
  const out: Payment[] = [];
  let sandbox = 0;
  for (const e of stripe) {
    const obj = e.payload?.data?.object ?? {};
    if (e.type !== "checkout.session.completed" && e.type !== "invoice.paid") continue;
    if (e.payload?.livemode !== true) { sandbox++; continue; }
    const at = String(e.received_at ?? e.payload?.created ?? "");
    const user = obj.metadata?.user_id ?? byCustomer.get(String(obj.customer ?? "")) ?? null;
    if (e.type === "checkout.session.completed") {
      if (obj.mode !== "payment") continue; // a plan's first payment arrives as invoice.paid
      const usd = num(obj.amount_total) / 100;
      if (usd <= 0) continue;
      out.push({ at, user_id: user, kind: obj.metadata?.topup ? "topup" : obj.metadata?.pack ? "pack" : "other", usd, ref: String(obj.id ?? e.id) });
      continue;
    }
    const paid = num(obj.amount_paid) / 100;
    if (paid <= 0) continue;
    const reason = String(obj.billing_reason ?? "");
    const kind: Payment["kind"] = reason === "subscription_create" ? "new_plan" : reason === "subscription_cycle" ? "renewal" : reason === "subscription_update" ? "upgrade" : "other";
    // split the invoice by its lines: the plan, extra social accounts
    const lines: any[] = obj.lines?.data ?? [];
    let assigned = 0;
    for (const l of lines) {
      const priceId = l.pricing?.price_details?.price ?? l.price?.id ?? l.plan?.id ?? null;
      const info = priceId ? prices.get(String(priceId)) : undefined;
      const usd = num(l.amount) / 100;
      if (usd <= 0) continue;
      assigned += usd;
      out.push({ at, user_id: user, kind: info?.kind === "seat" ? "seat" : kind, usd, plan: info?.plan ?? null, interval: info?.interval ?? null, ref: String(obj.id ?? e.id) });
    }
    // discounts and tax make lines and the total differ: the total paid is what counts
    const rest = r2(paid - assigned);
    if (!lines.length || Math.abs(rest) >= 0.01) {
      if (!lines.length) out.push({ at, user_id: user, kind, usd: paid, ref: String(obj.id ?? e.id) });
      else { const last = out[out.length - 1]; last.usd = r2(last.usd + rest); }
    }
  }
  for (const l of ledger) {
    if (l.reason !== "grant" || !String(l.ref ?? "").startsWith("pi_")) continue;
    const m = String(l.note ?? "").match(/Auto top-up \$(\d+(?:\.\d+)?)/);
    if (m) out.push({ at: l.created_at, user_id: l.user_id, kind: "auto_topup", usd: Number(m[1]), ref: String(l.ref) });
  }
  return { payments: out.sort((a, b) => b.at.localeCompare(a.at)), sandbox };
}
export const stripeFee = (usd: number) => (usd > 0 ? usd * STRIPE_FEE.rate + STRIPE_FEE.fixed : 0);

/** What one credit earns us for this customer: their plan after Stripe's fee, else the cheapest plan's (packs, promos). */
export function creditValueFor(c: any | undefined): number {
  const p = planById(c?.plan_id);
  if (!p || !["active", "trialing", "past_due"].includes(String(c?.status))) return creditValueFloor(PLANS);
  return netPerCredit(c.billing_interval === "year" ? p.annual_usd_per_month : p.monthly_usd, p.credits);
}
export function mrrOf(c: any): number {
  const p = planById(c?.plan_id);
  if (!p || !["active", "trialing", "past_due"].includes(String(c?.status))) return 0;
  return (c.billing_interval === "year" ? p.annual_usd_per_month : p.monthly_usd) + (num(c.social_extra) * (c.billing_interval === "year" ? 17 : 19));
}

const quant = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
const inRange = (iso: string | null | undefined, since: number | null, until: number) => !!iso && (since == null || Date.parse(iso) >= since) && Date.parse(iso) < until;

// ---------------------------------------------------------------------------------------------------
// Everything, for one window
// ---------------------------------------------------------------------------------------------------
export const SIGNUP_EMAIL_STEPS: Array<{ id: string; event: string; label: string }> = [
  { id: "plan_30m", event: "plan_nudge_30m", label: "30 minutes after sign-up" },
  { id: "plan_day1", event: "plan_nudge_day1", label: "The next day" },
];
/** Emails sent in the range, and what the people who got them did afterwards (up to now, not only inside the range).
 *  A payment is counted for the last email the person got before paying, so nobody is counted twice. "Pressed the
 *  button" is the page the email's link opens, reported by the app; "paid after" does not prove the email was why. */
export function signupEmailStats(events: any[], pays: Payment[], since: number | null, until: number) {
  const sentAt = new Map<string, Map<string, string>>(); // step → user → when
  for (const st of SIGNUP_EMAIL_STEPS) sentAt.set(st.id, new Map());
  for (const e of events) {
    if (e.kind !== "email" || !e.user_id || e.props?.ok === false) continue;
    const st = SIGNUP_EMAIL_STEPS.find((x) => x.event === e.name);
    if (st && inRange(e.created_at, since, until) && !sentAt.get(st.id)!.has(e.user_id)) sentAt.get(st.id)!.set(e.user_id, e.created_at);
  }
  const pressed = new Map<string, Set<string>>(SIGNUP_EMAIL_STEPS.map((st) => [st.id, new Set<string>()]));
  for (const e of events) {
    if (e.kind !== "page" || !e.user_id) continue;
    const m = /^email-(\w+)$/.exec(String(e.props?.tab ?? ""));
    const at = m ? sentAt.get(m[1])?.get(e.user_id) : undefined;
    if (at && e.created_at >= at) pressed.get(m![1])!.add(e.user_id);
  }
  const payBy = new Map<string, Payment[]>();
  for (const p of pays) if (p.user_id) payBy.set(p.user_id, [...(payBy.get(p.user_id) ?? []), p]);
  const steps = SIGNUP_EMAIL_STEPS.map((st) => ({ id: st.id, label: st.label, sent: sentAt.get(st.id)!.size, pressed: pressed.get(st.id)!.size, paid: 0, paid_pressed: 0, revenue_usd: 0 }));
  const people = new Set<string>(), paidPeople = new Set<string>(), pressedPeople = new Set<string>();
  for (const st of SIGNUP_EMAIL_STEPS) { for (const u of sentAt.get(st.id)!.keys()) people.add(u); for (const u of pressed.get(st.id)!) pressedPeople.add(u); }
  for (const u of people) {
    const mine = SIGNUP_EMAIL_STEPS.map((st) => ({ id: st.id, at: sentAt.get(st.id)!.get(u) })).filter((x): x is { id: string; at: string } => !!x.at);
    const first = mine.reduce((a, b) => (a.at < b.at ? a : b));
    const after = (payBy.get(u) ?? []).filter((p) => p.at > first.at).sort((a, b) => a.at.localeCompare(b.at));
    if (!after.length) continue;
    // the last email they had before the first payment gets it
    const credit = mine.filter((x) => x.at < after[0].at).reduce((a, b) => (a.at > b.at ? a : b));
    const row = steps.find((s) => s.id === credit.id)!;
    row.paid++; row.revenue_usd += after.reduce((n, p) => n + p.usd, 0); paidPeople.add(u);
    if (pressed.get(credit.id)!.has(u)) row.paid_pressed++;
  }
  for (const s of steps) s.revenue_usd = r2(s.revenue_usd);
  return { steps, people: people.size, pressed: pressedPeople.size, paid: paidPeople.size, revenue_usd: r2(steps.reduce((n, s) => n + s.revenue_usd, 0)), rate_pct: people.size ? r2(paidPeople.size / people.size * 100) : null };
}

export function computeAdmin(d: AdminData, opt: AdminOptions, env: Env = process.env) {
  const now = opt.now ?? new Date();
  const until = now.getTime();
  const since = opt.days ? until - opt.days * DAY : null;
  const prevSince = opt.days ? until - 2 * opt.days * DAY : null;
  const email = new Map(d.users.map((u) => [u.id, u.email]));
  const internal = new Set(d.users.filter((u) => isInternalEmail(u.email, env)).map((u) => u.id));
  const keep = (uid: string | null | undefined) => opt.includeInternal || !uid || !internal.has(uid);
  const cust = new Map<string, any>(d.customers.map((c) => [c.user_id, c]));
  const users = d.users.filter((u) => keep(u.id));
  const jobsAll = d.jobs.filter((j) => keep(j.user_id));
  const jobs = jobsAll.filter((j) => inRange(j.created_at, since, until));
  const jobsPrev = prevSince != null ? jobsAll.filter((j) => inRange(j.created_at, prevSince, since!)) : [];
  const events = d.events.filter((e) => keep(e.user_id));
  const evIn = events.filter((e) => inRange(e.created_at, since, until));

  // chats: the jobs each chat started (older jobs carry no tag; their chat's run still names them)
  const chatJobs = new Set<string>(), autoJobs = new Set<string>();
  for (const c of d.conversations) for (const st of (c.run?.steps ?? []) as any[]) if (st?.job_id) (c.automation_id ? autoJobs : chatJobs).add(String(st.job_id));
  for (const c of d.conversations) for (const m of (c.messages ?? []) as any[]) if (m?.choice?.job_id) chatJobs.add(String(m.choice.job_id));

  // ---- money in
  const { payments: payAll, sandbox } = paymentsFrom(d.stripe, d.ledger, d.customers, env);
  const pays = payAll.filter((p) => keep(p.user_id));
  const payIn = pays.filter((p) => inRange(p.at, since, until)), payPrev = prevSince != null ? pays.filter((p) => inRange(p.at, prevSince, since!)) : [];
  const sum = (xs: Payment[]) => xs.reduce((n, p) => n + p.usd, 0);
  const fees = (xs: Payment[]) => xs.reduce((n, p) => n + stripeFee(p.usd), 0);

  // ---- money out
  const costed = jobs.map((j) => ({ j, c: jobCost(j, env) }));
  const costedPrev = jobsPrev.map((j) => ({ j, c: jobCost(j, env) }));
  const genUsd = costed.reduce((n, x) => n + x.c.usd, 0), genPrev = costedPrev.reduce((n, x) => n + x.c.usd, 0);
  const claudeEv = evIn.filter((e) => e.kind === "claude"), vendorEv = evIn.filter((e) => e.kind === "vendor");
  const claudeUsd = claudeEv.reduce((n, e) => n + num(e.usd), 0), vendorUsd = vendorEv.reduce((n, e) => n + num(e.usd), 0);
  const evPrev = prevSince != null ? events.filter((e) => inRange(e.created_at, prevSince, since!)) : [];
  const overheadPrev = evPrev.filter((e) => e.kind === "claude" || e.kind === "vendor").reduce((n, e) => n + num(e.usd), 0);
  const cash = sum(payIn), cashPrev = sum(payPrev), fee = fees(payIn), feePrev = fees(payPrev);
  const cost = genUsd + claudeUsd + vendorUsd + fee, costPrev = genPrev + overheadPrev + feePrev;
  const profit = cash - cost, profitPrev = cashPrev - costPrev;

  // ---- per tool
  const toolNames = [...new Set([...Object.keys(TOOL_LABEL), ...jobs.map((j) => j.tool)])];
  const toolCalls = callCostByJob(d);
  const tools = toolNames.map((tool) => {
    const js = costed.filter((x) => x.j.tool === tool);
    const doneJs = js.filter((x) => x.j.status === "done");
    const credits = js.reduce((n, x) => n + num(x.j.credits_charged), 0);
    const value = js.reduce((n, x) => n + num(x.j.credits_charged) * creditValueFor(cust.get(x.j.user_id)), 0);
    // worker tools (Clips, Captions) show what their calls cost; the totals above count those calls once already
    const costUsd = js.reduce((n, x) => n + jobCostFull(x.j, toolCalls, env).usd, 0);
    const times = doneJs.map((x) => x.j.started_at && x.j.finished_at ? (Date.parse(x.j.finished_at) - Date.parse(x.j.started_at)) / 1000 : null).filter((x): x is number => x != null && x >= 0);
    const via = { tool: 0, chat: 0, automation: 0, connector: 0, unknown: 0 };
    for (const x of js) via[jobVia(x.j, chatJobs, autoJobs)]++;
    return {
      tool, label: TOOL_LABEL[tool] ?? tool, jobs: js.length, done: doneJs.length, failed: js.filter((x) => x.j.status === "failed").length, canceled: js.filter((x) => x.j.status === "canceled").length,
      live: js.filter((x) => x.j.status === "queued" || x.j.status === "running").length,
      users: new Set(js.map((x) => x.j.user_id)).size, credits, refunded_credits: js.filter((x) => x.j.status === "failed" || x.j.status === "canceled").reduce((n, x) => n + Math.max(0, num(x.j.credits_reserved) - num(x.j.credits_charged)), 0),
      value_usd: r2(value), cost_usd: r2(costUsd), profit_usd: r2(value - costUsd), margin: value > 0 ? r4((value - costUsd) / value) : null,
      outputs: doneJs.reduce((n, x) => n + (Array.isArray(x.j.outputs) ? x.j.outputs.length : 0), 0),
      seconds: RENDER_TOOLS.has(tool) ? r2(doneJs.reduce((n, x) => n + (x.j.outputs ?? []).reduce((m: number, o: any) => m + num(o?.duration), 0), 0)) : null,
      avg_render_s: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null, p50_render_s: quant(times, 0.5), p90_render_s: quant(times, 0.9),
      via, open: (toolsEnabled(env) as any)[tool] !== false,
    };
  }).filter((t) => t.jobs > 0 || Object.keys(TOOL_LABEL).includes(t.tool)).sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));

  // ---- reliability and fallbacks
  const finished = jobs.filter((j) => j.status === "done" || j.status === "failed");
  const okRate = (xs: any[]) => { const f = xs.filter((j) => j.status === "done" || j.status === "failed"); return f.length ? f.filter((j) => j.status === "done").length / f.length : null; };
  const failures = new Map<string, { jobs: number; credits_refunded: number; tools: Set<string> }>();
  for (const j of jobs.filter((x) => x.status === "failed" || x.status === "canceled")) {
    const code = j.status === "canceled" ? "canceled" : String(j.error_code ?? "unknown");
    const f = failures.get(code) ?? { jobs: 0, credits_refunded: 0, tools: new Set<string>() };
    f.jobs++; f.credits_refunded += Math.max(0, num(j.credits_reserved) - num(j.credits_charged)); f.tools.add(j.tool); failures.set(code, f);
  }
  const renders = jobs.filter((j) => RENDER_TOOLS.has(j.tool));
  const hasCut = (j: any) => !!j.progress?.cut_at || (j.outputs ?? []).some((o: any) => o?.cut_at);
  const fallbacks = {
    renders: renders.length,
    retried: renders.filter((j) => num(j.attempts) > 1).length,
    retry_spend_usd: r2(costed.filter((x) => RENDER_TOOLS.has(x.j.tool) && num(x.j.attempts) > 1).reduce((n, x) => n + x.c.usd, 0)),
    long_path: renders.filter((j) => j.progress?.engine === "seedance" && !j.progress?.seedance_only && j.options?.engine !== "seedance").length,
    escalated: renders.filter((j) => j.progress?.seedance_only).length,
    opening_shot: renders.filter(hasCut).length,
    pieces: renders.filter((j) => Array.isArray(j.progress?.pieces) && j.progress.pieces.length > 1).length,
    high_capacity_offered: renders.filter((j) => j.progress?.offer).length,
    high_capacity_chosen: renders.filter((j) => j.options?.engine === "seedance").length,
    renderer_busy: renders.filter((j) => j.error_code === "renderer_busy").length,
    light_refused: renders.filter((j) => j.error_code === "light_refused").length,
  };
  const sources = new Map<string, { jobs: number; usd: number }>();
  for (const x of costed) { if (x.c.source === "none") continue; const s = sources.get(x.c.source) ?? { jobs: 0, usd: 0 }; s.jobs++; s.usd += x.c.usd; sources.set(x.c.source, s); }
  const engines = new Map<string, { jobs: number; usd: number }>();
  for (const x of costed) {
    if (!x.c.usd) continue;
    const e = x.j.tool === "instrument" ? String(x.j.options?.endpoint ?? "instrument").split("/")[0] : RENDER_TOOLS.has(x.j.tool) ? (x.j.progress?.engine === "seedance" || x.j.options?.engine === "seedance" ? "Seedance 2.5 (edit)" : x.j.options?.model === "full" ? "Genjutsu" : "Genjutsu Light") : x.j.tool === "character" ? "Character images" : "Blueprint worker";
    const s = engines.get(e) ?? { jobs: 0, usd: 0 }; s.jobs++; s.usd += x.c.usd; engines.set(e, s);
  }
  const models = new Map<string, { jobs: number; usd: number; credits: number }>();
  for (const x of costed.filter((y) => y.j.tool === "instrument")) { const m = String(x.j.options?.endpoint ?? "?"); const s = models.get(m) ?? { jobs: 0, usd: 0, credits: 0 }; s.jobs++; s.usd += x.c.usd; s.credits += num(x.j.credits_charged); models.set(m, s); }

  // ---- chats
  const convIn = d.conversations.filter((c) => keep(c.user_id) && (inRange(c.created_at, since, until) || inRange(c.updated_at, since, until)));
  const msgs = convIn.flatMap((c) => ((c.messages ?? []) as any[]).filter((m) => inRange(m?.at, since, until)).map((m) => ({ c, m })));
  const planIds = new Set(msgs.filter((x) => x.m.role === "assistant" && x.m.plan_id).map((x) => x.m.plan_id));
  const chatJobsIn = jobs.filter((j) => { const v = jobVia(j, chatJobs, autoJobs); return v === "chat" || v === "automation"; });
  const runs = convIn.filter((c) => c.run && inRange(c.run.started_at, since, until));
  const chat = {
    conversations: convIn.length, new_conversations: convIn.filter((c) => inRange(c.created_at, since, until)).length, users: new Set(convIn.map((c) => c.user_id)).size,
    user_messages: msgs.filter((x) => x.m.role === "user").length, assistant_messages: msgs.filter((x) => x.m.role === "assistant").length,
    plans_proposed: planIds.size, runs: runs.length, runs_done: runs.filter((c) => c.run.status === "done").length, runs_failed: runs.filter((c) => c.run.status === "failed").length,
    jobs_from_chat: chatJobsIn.length, credits_from_chat: chatJobsIn.reduce((n, j) => n + num(j.credits_charged), 0),
    share_jobs: jobs.length ? r4(chatJobsIn.length / jobs.length) : null, share_credits: (() => { const t = jobs.reduce((n, j) => n + num(j.credits_charged), 0); return t ? r4(chatJobsIn.reduce((n, j) => n + num(j.credits_charged), 0) / t) : null; })(),
    links: msgs.filter((x) => x.m.role === "user" && (x.m.links ?? []).length).length, attachments: msgs.filter((x) => x.m.role === "user" && (x.m.attachments ?? []).length).length,
    characters_offered: msgs.filter((x) => x.m.choice).length, publish_cards: msgs.filter((x) => x.m.publish).length, stopped: msgs.filter((x) => x.m.interrupted).length,
    automations: d.automations.filter((a) => keep(a.user_id)).length, automation_runs: d.automations.filter((a) => keep(a.user_id)).reduce((n, a) => n + num(a.runs), 0),
    memory_notes: d.memory.filter((m) => keep(m.user_id) && inRange(m.created_at, since, until)).length,
    claude_usd: r4(claudeEv.filter((e) => ["assistant", "chat_title", "chat_summary", "people"].includes(e.name)).reduce((n, e) => n + num(e.usd), 0)),
  };

  // ---- the emails to sign-ups without a plan: who got one, who pressed its button, who paid afterwards
  const signupEmails = signupEmailStats(events, pays, since, until);

  // ---- usage elsewhere
  const pages = new Map<string, { views: number; users: Set<string> }>();
  for (const e of evIn.filter((x) => x.kind === "page")) { const p = pages.get(e.name) ?? { views: 0, users: new Set<string>() }; p.views++; if (e.user_id) p.users.add(e.user_id); pages.set(e.name, p); }
  const group = (xs: any[], key: (e: any) => string) => { const m = new Map<string, { n: number; usd: number; ok: number; failed: number }>(); for (const e of xs) { const k = key(e); const s = m.get(k) ?? { n: 0, usd: 0, ok: 0, failed: 0 }; s.n++; s.usd += num(e.usd); if (e.props?.ok === false) s.failed++; else s.ok++; m.set(k, s); } return [...m.entries()].map(([name, s]) => ({ name, ...s, usd: r4(s.usd) })).sort((a, b) => b.n - a.n); };
  const postsIn = d.posts.filter((p) => keep(p.user_id) && inRange(p.created_at, since, until));
  const byPlatform = new Map<string, number>();
  for (const p of postsIn) for (const n of (p.platforms ?? []) as string[]) byPlatform.set(n, (byPlatform.get(n) ?? 0) + 1);
  const assetsIn = d.assets.filter((a) => keep(a.user_id) && inRange(a.created_at, since, until));
  const usage = {
    pages: [...pages.entries()].map(([page, p]) => ({ page, views: p.views, users: p.users.size })).sort((a, b) => b.views - a.views),
    uploads: { videos: assetsIn.filter((a) => a.kind === "video").length, images: assetsIn.filter((a) => a.kind === "image").length, audio: assetsIn.filter((a) => a.kind === "audio").length, gb: r2(assetsIn.reduce((n, a) => n + num(a.bytes), 0) / 1e9), users: new Set(assetsIn.map((a) => a.user_id)).size },
    social: { linked_users: d.profiles.filter((p) => keep(p.user_id) && Array.isArray(p.accounts) && p.accounts.length).length, posts: postsIn.length, sent: postsIn.filter((p) => ["posted", "sent", "success", "published"].includes(String(p.status))).length, scheduled: postsIn.filter((p) => p.status === "scheduled").length, failed: postsIn.filter((p) => ["failed", "error"].includes(String(p.status))).length, from_chat: postsIn.filter((p) => p.conversation_id).length, by_platform: [...byPlatform.entries()].map(([platform, n]) => ({ platform, n })).sort((a, b) => b.n - a.n) },
    performance: { connected_users: new Set(d.perfAccounts.filter((a) => keep(a.user_id)).map((a) => a.user_id)).size, accounts: d.perfAccounts.filter((a) => keep(a.user_id)).length, insights: d.insights.filter((i) => keep(i.user_id) && inRange(i.created_at, since, until)).length },
    emails: group(evIn.filter((e) => e.kind === "email"), (e) => e.name),
    signup_emails: signupEmails,
    checkouts: group(evIn.filter((e) => e.kind === "checkout"), (e) => e.name),
    tracked_since: events.length ? events.reduce((m, e) => (e.created_at < m ? e.created_at : m), events[0].created_at) : null,
  };

  // ---- people
  const firstPay = new Map<string, string>();
  for (const p of [...pays].reverse()) if (p.user_id && !firstPay.has(p.user_id)) firstPay.set(p.user_id, p.at);
  const jobsBy = new Map<string, any[]>();
  for (const j of jobsAll) { const l = jobsBy.get(j.user_id) ?? []; l.push(j); jobsBy.set(j.user_id, l); }
  const checkoutUsers = new Set(events.filter((e) => e.kind === "checkout").map((e) => e.user_id));
  const cohort = users.filter((u) => inRange(u.created_at, since, until));
  const funnel = [
    { step: "Signed up", users: cohort.length },
    { step: "Confirmed email", users: cohort.filter((u) => u.email_confirmed_at).length },
    { step: "Answered the questions", users: cohort.filter((u) => cust.get(u.id)?.onboarding?.completed_at).length },
    { step: "Opened checkout", users: cohort.filter((u) => checkoutUsers.has(u.id) || firstPay.has(u.id)).length },
    { step: "Paid", users: cohort.filter((u) => firstPay.has(u.id) || ["active", "trialing", "past_due", "canceled"].includes(String(cust.get(u.id)?.status))).length },
    { step: "Made something", users: cohort.filter((u) => (jobsBy.get(u.id) ?? []).some((j) => j.status === "done")).length },
    { step: "Made 5 or more", users: cohort.filter((u) => (jobsBy.get(u.id) ?? []).filter((j) => j.status === "done").length >= 5).length },
  ];
  const paidBy = new Map<string, number>();
  for (const p of pays) if (p.user_id) paidBy.set(p.user_id, (paidBy.get(p.user_id) ?? 0) + p.usd);
  const countries = countryByUser(d);
  // when each person was last here: the latest of a page they opened, a thing they made and a sign-in (a sign-in alone
  // is not enough: people stay signed in for weeks)
  const lastPage = new Map<string, string>();
  for (const e of events) if (e.kind === "page" && e.user_id && (lastPage.get(e.user_id) ?? "") < e.created_at) lastPage.set(e.user_id, e.created_at);
  const latest = (...xs: Array<string | null | undefined>) => xs.reduce((m: string | null, x) => (x && Number.isFinite(Date.parse(x)) && (!m || Date.parse(x) > Date.parse(m)) ? x : m), null);
  const people = d.users.filter((u) => keep(u.id)).map((u) => {
    const js = jobsBy.get(u.id) ?? [], c = cust.get(u.id);
    const costU = js.reduce((n, j) => n + jobCost(j, env).usd, 0) + events.filter((e) => e.user_id === u.id && (e.kind === "claude" || e.kind === "vendor")).reduce((n, e) => n + num(e.usd), 0);
    const paid = paidBy.get(u.id) ?? 0;
    const last = js.reduce((m: string | null, j) => (!m || j.created_at > m ? j.created_at : m), null);
    return {
      user_id: u.id, email: u.email, country: countries.get(u.id) ?? null, internal: internal.has(u.id), created_at: u.created_at, confirmed: !!u.email_confirmed_at, last_sign_in_at: u.last_sign_in_at,
      plan: c?.plan_id ?? null, interval: c?.billing_interval ?? null, status: c?.status ?? "none", mrr_usd: mrrOf(c),
      onboarding: c?.onboarding && Object.keys(c.onboarding).length ? c.onboarding : null,
      jobs: js.length, done: js.filter((j) => j.status === "done").length, failed: js.filter((j) => j.status === "failed").length,
      credits: js.reduce((n, j) => n + num(j.credits_charged), 0), via_chat: js.filter((j) => { const v = jobVia(j, chatJobs, autoJobs); return v === "chat" || v === "automation"; }).length,
      tools: [...new Set(js.map((j) => j.tool))], paid_usd: r2(paid), cost_usd: r2(costU), profit_usd: r2(paid - stripeFeeTotal(pays.filter((p) => p.user_id === u.id)) - costU), last_job_at: last,
      last_seen_at: latest(lastPage.get(u.id), last, u.last_sign_in_at),
    };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));

  // ---- daily series
  const start = since ?? Math.min(until - 30 * DAY, ...[...d.users.map((u) => Date.parse(u.created_at)), ...d.jobs.map((j) => Date.parse(j.created_at))].filter(Number.isFinite));
  const nDays = Math.min(400, Math.max(1, Math.ceil((until - start) / DAY)));
  const daily = Array.from({ length: nDays }, (_, i) => { const day = dayOf(new Date(until - (nDays - 1 - i) * DAY).toISOString()); return { day, cash_usd: 0, cost_usd: 0, profit_usd: 0, jobs: 0, failed: 0, signups: 0, active_users: 0, credits: 0 }; });
  const at = new Map(daily.map((x) => [x.day, x]));
  const actives = new Map<string, Set<string>>();
  for (const p of payIn) { const x = at.get(dayOf(p.at)); if (x) { x.cash_usd += p.usd; x.cost_usd += stripeFee(p.usd); } }
  for (const y of costed) { const x = at.get(dayOf(y.j.created_at)); if (x) { x.cost_usd += y.c.usd; x.jobs++; if (y.j.status === "failed") x.failed++; x.credits += num(y.j.credits_charged); const s = actives.get(x.day) ?? new Set(); s.add(y.j.user_id); actives.set(x.day, s); } }
  for (const e of evIn) if (e.kind === "claude" || e.kind === "vendor") { const x = at.get(dayOf(e.created_at)); if (x) x.cost_usd += num(e.usd); }
  for (const e of evIn) if (e.kind === "page" && e.user_id) { const s = actives.get(dayOf(e.created_at)) ?? new Set(); s.add(e.user_id); actives.set(dayOf(e.created_at), s); }
  for (const u of cohort) { const x = at.get(dayOf(u.created_at)); if (x) x.signups++; }
  for (const x of daily) { x.active_users = actives.get(x.day)?.size ?? 0; x.cash_usd = r2(x.cash_usd); x.cost_usd = r2(x.cost_usd); x.profit_usd = r2(x.cash_usd - x.cost_usd); }

  // ---- totals
  const paying = d.customers.filter((c) => keep(c.user_id) && mrrOf(c) > 0);
  const activeIn = new Set([...jobs.map((j) => j.user_id), ...evIn.filter((e) => e.kind === "page" && e.user_id).map((e) => e.user_id)]);
  const activePrev = new Set([...jobsPrev.map((j) => j.user_id), ...evPrev.filter((e) => e.kind === "page" && e.user_id).map((e) => e.user_id)]);
  const credits = jobs.reduce((n, j) => n + num(j.credits_charged), 0), creditsPrev = jobsPrev.reduce((n, j) => n + num(j.credits_charged), 0);
  const ledgerIn = d.ledger.filter((l) => keep(l.user_id) && inRange(l.created_at, since, until));
  const notes: string[] = [];
  if (sandbox) notes.push(`${sandbox} Stripe sandbox payment${sandbox === 1 ? "" : "s"} left out of revenue.`);
  if (!usage.tracked_since) notes.push("Claude costs, other paid services, emails, checkouts and page views are recorded from the moment the event table is live; until then they show as zero.");
  else if (since == null || Date.parse(usage.tracked_since) > since) notes.push(`Claude costs, emails, checkouts and page views are recorded since ${usage.tracked_since.slice(0, 10)}.`);
  if ((sources.get("legacy")?.jobs ?? 0) > 0) notes.push(`${sources.get("legacy")!.jobs} older job${sources.get("legacy")!.jobs === 1 ? "" : "s"} carry the cost booked when sent (before Oct 31 2026), which can include a retry Higgsfield did not bill.`);
  if ((sources.get("model")?.jobs ?? 0) > 0) notes.push("Blueprint, character images and jobs without a recorded charge are costed from our rate table.");
  notes.push("Stripe fees are worked out at 2.9% + $0.30 per charge. Fixed monthly costs (Render, Supabase, Vercel, Ayrshare, Resend) are not in profit.");

  return {
    generated_at: now.toISOString(),
    range: { days: opt.days, since: since != null ? new Date(since).toISOString() : null, until: now.toISOString() },
    include_internal: opt.includeInternal, internal_users: internal.size, sandbox_events: sandbox, notes,
    kpis: {
      cash_usd: r2(cash), cash_prev: opt.days ? r2(cashPrev) : null, cost_usd: r2(cost), cost_prev: opt.days ? r2(costPrev) : null,
      profit_usd: r2(profit), profit_prev: opt.days ? r2(profitPrev) : null, margin: cash > 0 ? r4(profit / cash) : null, margin_prev: opt.days && cashPrev > 0 ? r4(profitPrev / cashPrev) : null,
      mrr_usd: r2(paying.reduce((n, c) => n + mrrOf(c), 0)), paying: paying.length,
      signups: cohort.length, signups_prev: prevSince != null ? users.filter((u) => inRange(u.created_at, prevSince, since!)).length : null,
      active_users: activeIn.size, active_prev: opt.days ? activePrev.size : null,
      jobs: jobs.length, jobs_prev: opt.days ? jobsPrev.length : null, success_rate: okRate(jobs) != null ? r4(okRate(jobs)!) : null, success_prev: opt.days && okRate(jobsPrev) != null ? r4(okRate(jobsPrev)!) : null,
      credits_charged: credits, credits_prev: opt.days ? creditsPrev : null,
      live_jobs: jobsAll.filter((j) => j.status === "queued" || j.status === "running").length,
    },
    daily,
    revenue: {
      total_usd: r2(cash), fees_usd: r2(fee), net_usd: r2(cash - fee), payments: payIn.length, payers: new Set(payIn.map((p) => p.user_id)).size,
      by_kind: (Object.keys(PAYMENT_LABEL) as Payment["kind"][]).map((k) => ({ kind: k, label: PAYMENT_LABEL[k], usd: r2(sum(payIn.filter((p) => p.kind === k))), count: payIn.filter((p) => p.kind === k).length })).filter((x) => x.count),
      mrr_by_plan: PLANS.flatMap((p) => (["month", "year"] as const).map((i) => { const cs = paying.filter((c) => c.plan_id === p.id && c.billing_interval === i); return { plan: p.id, name: p.name, interval: i, customers: cs.length, mrr_usd: r2(cs.reduce((n, c) => n + mrrOf(c), 0)) }; })).filter((x) => x.customers),
      recent: payIn.slice(0, 25).map((p) => ({ at: p.at, email: p.user_id ? email.get(p.user_id) ?? null : null, kind: p.kind, label: PAYMENT_LABEL[p.kind], usd: r2(p.usd), plan: p.plan ?? null, interval: p.interval ?? null })),
    },
    costs: {
      total_usd: r2(cost), generation_usd: r2(genUsd), claude_usd: r4(claudeUsd), vendors_usd: r4(vendorUsd), stripe_fees_usd: r2(fee),
      by_engine: [...engines.entries()].map(([engine, s]) => ({ engine, jobs: s.jobs, usd: r2(s.usd) })).sort((a, b) => b.usd - a.usd),
      by_source: [...sources.entries()].map(([source, s]) => ({ source, jobs: s.jobs, usd: r2(s.usd) })).sort((a, b) => b.usd - a.usd),
      claude: group(claudeEv, (e) => e.name).map((x) => ({ feature: x.name, calls: x.n, usd: x.usd, model: claudeEv.find((e) => e.name === x.name)?.props?.model ?? null, input: claudeEv.filter((e) => e.name === x.name).reduce((n, e) => n + num(e.props?.input) + num(e.props?.cache_read) + num(e.props?.cache_write), 0), output: claudeEv.filter((e) => e.name === x.name).reduce((n, e) => n + num(e.props?.output), 0) })),
      vendors: group(vendorEv, (e) => `${e.name}${e.props?.use ? ` · ${e.props.use}` : ""}`).map((x) => ({ name: x.name, calls: x.n, usd: x.usd })),
      instruments: [...models.entries()].map(([model, s]) => ({ model, jobs: s.jobs, usd: r2(s.usd), credits: s.credits })).sort((a, b) => b.jobs - a.jobs).slice(0, 20),
    },
    tools,
    reliability: {
      success_rate: okRate(jobs) != null ? r4(okRate(jobs)!) : null, finished: finished.length,
      failures: [...failures.entries()].map(([code, f]) => ({ code, jobs: f.jobs, credits_refunded: f.credits_refunded, tools: [...f.tools] })).sort((a, b) => b.jobs - a.jobs),
      fallbacks,
    },
    chat, usage, funnel,
    credits: {
      granted: ledgerIn.filter((l) => l.reason === "grant").reduce((n, l) => n + num(l.delta), 0), promo: ledgerIn.filter((l) => l.reason === "promo").reduce((n, l) => n + num(l.delta), 0),
      spent: credits, refunded: ledgerIn.filter((l) => l.reason === "refund").reduce((n, l) => n + num(l.delta), 0), expired: -ledgerIn.filter((l) => l.reason === "expire").reduce((n, l) => n + num(l.delta), 0),
      outstanding: d.ledger.filter((l) => keep(l.user_id)).reduce((n, l) => n + num(l.delta), 0),
    },
    users: people,
    onboarding: signupInsights(d.customers.filter((c) => keep(c.user_id)).map((c) => ({ onboarding: c.onboarding, status: c.status }))),
  };
}
/** Where each person is: the country their browser last reached us from (studio_customers.country, kept by
 *  studio-geo.ts), else the billing country Stripe holds for a payer. Two-letter codes. */
export function countryByUser(d: AdminData): Map<string, string> {
  const ok = (v: unknown) => (typeof v === "string" && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null);
  const out = new Map<string, string>();
  const byCustomer = new Map<string, string>(d.customers.filter((c) => c.stripe_customer_id).map((c) => [String(c.stripe_customer_id), c.user_id]));
  for (const e of d.stripe) {
    const obj = e.payload?.data?.object ?? {};
    const user = obj.metadata?.user_id ?? byCustomer.get(String(obj.customer ?? ""));
    const cc = ok(obj.customer_details?.address?.country) ?? ok(obj.customer_address?.country);
    if (user && cc) out.set(user, cc);
  }
  for (const c of d.customers) { const cc = ok(c.country); if (cc) out.set(c.user_id, cc); }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The activity log: one row per thing made, with what it was charged, what it cost us and what is left
// ---------------------------------------------------------------------------------------------------
export const LOG_PAGE = 50;
export type LogQuery = { user?: string | null; from?: string | null; to?: string | null; includeInternal?: boolean; page?: number; per?: number };
/** The feature as the person saw it: Stories run on the Kage worker, so the tool id alone would call them Kage. */
export function featureOf(j: any): string {
  if (j.tool === "kage_motion" && j.options?.story) return "Stories";
  if (j.tool === "kage_motion" && j.options?.motivation) return "Motivation";
  return TOOL_LABEL[j.tool] ?? String(j.tool);
}
function logRows(d: AdminData, q: LogQuery, env: Env) {
  const email = new Map(d.users.map((u) => [u.id, u.email]));
  const internal = new Set(d.users.filter((u) => isInternalEmail(u.email, env)).map((u) => u.id));
  const cust = new Map<string, any>(d.customers.map((c) => [c.user_id, c]));
  const countries = countryByUser(d);
  const chatJobs = new Set<string>(), autoJobs = new Set<string>();
  for (const c of d.conversations) for (const st of (c.run?.steps ?? []) as any[]) if (st?.job_id) (c.automation_id ? autoJobs : chatJobs).add(String(st.job_id));
  for (const c of d.conversations) for (const m of (c.messages ?? []) as any[]) if (m?.choice?.job_id) chatJobs.add(String(m.choice.job_id));
  const calls = callCostByJob(d);
  const from = q.from && Number.isFinite(Date.parse(q.from)) ? Date.parse(q.from) : null, to = q.to && Number.isFinite(Date.parse(q.to)) ? Date.parse(q.to) : null;
  return d.jobs
    // one person's log shows that person whoever they are; the full log leaves our own accounts out unless asked
    .filter((j) => (q.user ? j.user_id === q.user : q.includeInternal || !internal.has(j.user_id)))
    .filter((j) => { const t = Date.parse(j.created_at); return (from == null || t >= from) && (to == null || t < to); })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((j) => {
      const c = jobCostFull(j, calls, env), credits = num(j.credits_charged);
      const worth = credits * creditValueFor(cust.get(j.user_id));
      // a finished job with no cost on record at all has no honest profit figure
      const known = c.source !== "none" || j.status !== "done";
      let label = String(j.tool);
      try { label = jobLabel(j); } catch { /* the tool's own name */ }
      return {
        id: String(j.id), at: String(j.created_at), user_id: String(j.user_id), email: email.get(j.user_id) ?? null, country: countries.get(j.user_id) ?? null,
        tool: String(j.tool), feature: featureOf(j), detail: label, status: String(j.status), via: jobVia(j, chatJobs, autoJobs),
        credits, worth_usd: r4(worth), cost_usd: known ? r4(c.usd) : null, cost_source: c.source,
        profit_usd: known ? r4(worth - c.usd) : null, margin: known && worth > 0 ? r4((worth - c.usd) / worth) : null,
        render_s: j.started_at && j.finished_at ? Math.max(0, Math.round((Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000)) : null,
      };
    });
}
export type LogRow = ReturnType<typeof logRows>[number];
export function adminLog(d: AdminData, q: LogQuery = {}, env: Env = process.env) {
  const rows = logRows(d, q, env);
  const per = Math.min(200, Math.max(1, Math.round(q.per ?? LOG_PAGE)));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(pages, Math.max(1, Math.round(q.page ?? 1) || 1));
  const priced = rows.filter((r) => r.cost_usd != null);
  const worth = rows.reduce((n, r) => n + r.worth_usd, 0), cost = priced.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const pricedWorth = priced.reduce((n, r) => n + r.worth_usd, 0);
  const who = q.user ? d.users.find((u) => u.id === q.user) : null;
  return {
    user: q.user ? { user_id: q.user, email: who?.email ?? null } : null, from: q.from ?? null, to: q.to ?? null,
    page, pages, per, total: rows.length,
    totals: { jobs: rows.length, done: rows.filter((r) => r.status === "done").length, failed: rows.filter((r) => r.status === "failed").length, credits: rows.reduce((n, r) => n + r.credits, 0), worth_usd: r2(worth), cost_usd: r2(cost), profit_usd: r2(pricedWorth - cost), margin: pricedWorth > 0 ? r4((pricedWorth - cost) / pricedWorth) : null, unpriced: rows.length - priced.length },
    rows: rows.slice((page - 1) * per, page * per),
  };
}
export type AdminLog = ReturnType<typeof adminLog>;
/** Every matching row as a spreadsheet. Cells that a spreadsheet would run as a formula are made plain text. */
export function adminLogCsv(d: AdminData, q: LogQuery = {}, env: Env = process.env): string {
  const cell = (v: unknown) => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["time_utc", "email", "country", "feature", "detail", "status", "started_from", "credits_charged", "worth_usd", "our_cost_usd", "cost_basis", "profit_usd", "margin_pct", "render_seconds", "job_id"];
  const lines = logRows(d, q, env).slice(0, 50_000).map((r) => [r.at, r.email, r.country, r.feature, r.detail, r.status, r.via, r.credits, r.worth_usd, r.cost_usd, r.cost_source === "none" ? (r.cost_usd == null ? "not recorded" : "") : r.cost_source, r.profit_usd, r.margin != null ? Math.round(r.margin * 1000) / 10 : null, r.render_s, r.id].map(cell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

function stripeFeeTotal(ps: Payment[]) { return ps.reduce((n, p) => n + stripeFee(p.usd), 0); }
export type AdminMetrics = ReturnType<typeof computeAdmin>;

// ---------------------------------------------------------------------------------------------------
// Reading the tables
// ---------------------------------------------------------------------------------------------------
async function all(q: any, page = 1000, max = 50_000): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < max; from += page) {
    const r = await q().range(from, from + page - 1);
    if (r.error) { if (/does not exist|relation/.test(String(r.error.message))) return out; throw r.error; }
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < page) break;
  }
  return out;
}
const CUSTOMER_COLS = "user_id,stripe_customer_id,plan_id,billing_interval,status,period_end,cancel_at_period_end,credits_per_period,onboarding,created_at,referred_by,social_extra,auto_topup_enabled";
export async function loadAdminData(sb: SupabaseClient): Promise<AdminData> {
  const admin = (sb as any).auth?.admin;
  const users: AdminData["users"] = [];
  if (admin?.listUsers) for (let page = 1; page <= 20; page++) {
    const r = await admin.listUsers({ page, perPage: 1000 });
    const list = (r?.data?.users ?? []) as any[];
    users.push(...list.map((u) => ({ id: u.id, email: u.email ?? null, created_at: u.created_at, email_confirmed_at: u.email_confirmed_at ?? null, last_sign_in_at: u.last_sign_in_at ?? null })));
    if (list.length < 1000) break;
  }
  const [customers, jobs, ledger, stripe, conversations, automations, posts, profiles, insights, perfAccounts, assets, events, memory] = await Promise.all([
    // before the country migration the column is missing: read the row without it
    all(() => sb.from("studio_customers").select(`${CUSTOMER_COLS},country`).order("created_at")).catch((e: any) => { if (!/country/.test(String(e?.message ?? ""))) throw e; return all(() => sb.from("studio_customers").select(CUSTOMER_COLS).order("created_at")); }),
    all(() => sb.from("studio_jobs").select("id,user_id,tool,status,options,credits_reserved,credits_charged,attempts,progress,outputs,error_code,created_at,started_at,finished_at").order("created_at")),
    all(() => sb.from("studio_credit_ledger").select("user_id,delta,reason,ref,note,created_at").order("id")),
    all(() => sb.from("studio_stripe_events").select("id,type,received_at,payload").in("type", ["checkout.session.completed", "invoice.paid"]).order("received_at"), 500, 20_000),
    all(() => sb.from("studio_conversations").select("id,user_id,status,messages,run,automation_id,created_at,updated_at").order("created_at"), 200, 10_000),
    all(() => sb.from("studio_automations").select("id,user_id,runs,created_at,last_run_at").order("created_at")),
    all(() => sb.from("studio_social_posts").select("id,user_id,status,platforms,conversation_id,job_id,created_at").order("created_at")),
    all(() => sb.from("studio_social_profiles").select("user_id,accounts,created_at")),
    all(() => sb.from("studio_perf_insights").select("user_id,created_at").order("created_at")),
    all(() => sb.from("studio_perf_accounts").select("user_id,platform")),
    all(() => sb.from("studio_assets").select("user_id,kind,bytes,created_at").order("created_at")),
    all(() => sb.from("studio_events").select("user_id,kind,name,usd,props,created_at").order("created_at"), 1000, 200_000),
    all(() => sb.from("studio_assistant_memory").select("user_id,created_at")),
  ]);
  return { users, customers, jobs, ledger, stripe, conversations, automations, posts, profiles, insights, perfAccounts, assets, events, memory };
}

/** GET /api/studio/admin/metrics?days=30&internal=0: the owner's account only; 404 for anyone else (the panel stays unannounced).
 *  GET /api/studio/admin/log?user=&from=&to=&internal=0&page=1: the activity log, 50 rows a page; &format=csv downloads
 *  every matching row. from/to are instants (the page sends the start and end of the chosen days in its own time zone). */
export function registerStudioAdmin(app: Express, sbFn: () => SupabaseClient, deps: { env?: Env; load?: (sb: SupabaseClient) => Promise<AdminData> } = {}) {
  const env = deps.env ?? process.env;
  let cache: { at: number; data: AdminData } | null = null;
  app.get("/api/studio/admin/metrics", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const raw = String(req.query.days ?? "30");
      const days = raw === "all" ? null : Math.min(365, Math.max(1, Math.round(Number(raw)) || 30));
      // one read of every table serves a minute of period and filter changes; ?fresh=1 reads again
      if (!cache || Date.now() - cache.at > 60_000 || req.query.fresh === "1") cache = { at: Date.now(), data: await (deps.load ?? loadAdminData)(sb) };
      res.json(computeAdmin(cache.data, { days, includeInternal: req.query.internal === "1" }, env));
    } catch (e: any) {
      console.log(`[admin] ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_failed" });
    }
  });
  app.get("/api/studio/admin/log", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const str = (v: unknown) => (typeof v === "string" && v.length <= 64 ? v : null);
      const when = (v: unknown) => { const s = str(v); return s && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null; };
      const user = str(req.query.user);
      if (user && !/^[0-9a-f-]{36}$/i.test(user)) return res.status(400).json({ error: "invalid_user" });
      if (!cache || Date.now() - cache.at > 60_000 || req.query.fresh === "1") cache = { at: Date.now(), data: await (deps.load ?? loadAdminData)(sb) };
      const q: LogQuery = { user, from: when(req.query.from), to: when(req.query.to), includeInternal: req.query.internal === "1", page: Number(req.query.page) || 1 };
      if (req.query.format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="clone8-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(adminLogCsv(cache.data, q, env));
      }
      res.json(adminLog(cache.data, q, env));
    } catch (e: any) {
      console.log(`[admin] log: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_failed" });
    }
  });
}
