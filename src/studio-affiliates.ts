// Affiliate links (owner, Nov 21 2026): a promoter's link clone8.io/?aff=CODE, and the admin panel's "Affiliate links"
// tab that makes links and shows what each one brought: clicks, sign-ups, people who tried a tool, paying customers,
// cancels and the money paid. Migration 20261128000000_studio_affiliates.sql. Gate: STUDIO_AFFILIATES_ENABLED.
//
// The path of a code, and why it is credited even when a browser forgets it:
//   1. the link lands on clone8.io (a static page: the link works even when this server does not); the site keeps the
//      code in the browser for 30 days (the latest affiliate link wins), counts the click with a beacon to
//      POST /api/public/aff-click, and carries the code on its links into the app;
//   2. the app keeps the code too, and puts it on the account at email sign-up (auth user metadata "aff"), so a
//      confirmation email opened in another browser or on another phone still carries it;
//   3. after sign-up the app asks POST /api/studio/affiliate/claim; the server credits the code from the account's
//      metadata first, then the browser's. A new account only (made at most 48 hours before), once, never moved after;
//   4. the sign-up answers also carry the code (attribution.aff): if 3 never ran, the page still credits from it.
import type { Express, Request, Response } from "express";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isInternalEmail, isStudioAdmin } from "./studio-admin-auth.js";

export const CODE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
export const CLAIM_WINDOW_MS = 48 * 3600_000;
const DAY = 86400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_FEE = { rate: 0.029, fixed: 0.3 };

export function affiliatesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.STUDIO_AFFILIATES_ENABLED === "true";
}
export function affiliateLink(code: string, env: Record<string, string | undefined> = process.env): string {
  return `${(env.AFFILIATE_SITE_URL || "https://clone8.io").replace(/\/+$/, "")}/?aff=${code}`;
}

/** A code as people type it: lower case, spaces and underscores to dashes, nothing else kept. Null when not valid. */
const slug = (raw: unknown) => String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
export function normalizeCode(raw: unknown): string | null {
  const c = slug(raw);
  return CODE_RE.test(c) ? c : null;
}
/** A code from a name ("Jake Paul" -> "jake-paul"), made unique against `taken` with a short random tail. */
export function codeFromName(name: string, taken: Set<string>, rand: () => number = Math.random): string {
  let base = slug(name).slice(0, 24).replace(/-$/, "");
  if (base.length < 3) base = `link${base}`.slice(0, 24);
  if (!taken.has(base) && CODE_RE.test(base)) return base;
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  for (let i = 0; i < 50; i++) {
    let tail = ""; for (let k = 0; k < 4; k++) tail += abc[Math.floor(rand() * abc.length)];
    const c = `${base}-${tail}`;
    if (!taken.has(c)) return c;
  }
  throw new Error("could not make a unique code");
}

/** What device and browser a click came from, from its user agent (in-app browsers named: they matter for sign-up). */
export function deviceOf(ua: string | undefined | null): { device: string; browser: string } {
  const s = String(ua ?? "");
  const device = /iPad|Tablet/i.test(s) ? "tablet" : /Mobi|iPhone|Android/i.test(s) ? "phone" : s ? "computer" : "unknown";
  const browser = /Instagram/i.test(s) ? "Instagram app" : /musical_ly|BytedanceWebview|TikTok/i.test(s) ? "TikTok app" : /FBAN|FBAV|FB_IAB/i.test(s) ? "Facebook app"
    : /Snapchat/i.test(s) ? "Snapchat app" : /Twitter/i.test(s) ? "X app" : /YouTube/i.test(s) ? "YouTube app" : /Edg\//.test(s) ? "Edge" : /CriOS|Chrome\//.test(s) ? "Chrome"
    : /Firefox|FxiOS/.test(s) ? "Firefox" : /Safari/.test(s) ? "Safari" : s ? "Other" : "Unknown";
  return { device, browser };
}

/** Whether an account can be credited to a code now: never credited before, and made at most 48 hours ago. */
export function canCredit(c: { affiliate_code?: string | null } | null, accountCreatedAt: string | null | undefined, now: number): boolean {
  if (!c || c.affiliate_code) return false;
  const made = Date.parse(String(accountCreatedAt ?? ""));
  return Number.isFinite(made) && now - made <= CLAIM_WINDOW_MS && now - made >= -60_000;
}

/** A click as the site sends it, checked. Null when it is not one of ours. */
export function clickInput(body: any): { code: string; visitor: string | null; landing: string; referrer: string | null } | null {
  let b = body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { return null; } }
  if (!b || typeof b !== "object") return null;
  const raw = String(b.code ?? "").trim().toLowerCase(); if (!CODE_RE.test(raw)) return null; // a link's code exactly, nothing cleaned up
  const code = raw;
  const v = String(b.v ?? ""); const visitor = /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : null;
  const landing = b.landing === "app" ? "app" : "site";
  const r = String(b.ref ?? "").toLowerCase().replace(/^www\./, ""); const referrer = /^[a-z0-9.-]{3,120}$/.test(r) ? r : null;
  return { code, visitor, landing, referrer };
}

// ---------------------------------------------------------------- the page's numbers

export type LinkRow = { code: string; name: string; note: string | null; active: boolean; created_at: string };
export type ClickRow = { code: string; visitor: string | null; device: string | null; browser: string | null; referrer: string | null; landing: string | null; created_at: string };
export type PersonRow = { user_id: string; email: string | null; code: string; credited_via: "account" | "answers"; signed_up: string; plan: string | null; interval: string | null; status: string;
  cancel_at_period_end: boolean; billing_source: string | null; onboarded: boolean; jobs: number; opened_checkout: boolean; paid_usd: number; net_usd: number; first_paid_at: string | null; last_seen: string | null; internal: boolean };
export type LinkStats = {
  code: string; name: string; note: string | null; active: boolean; created_at: string; url: string;
  clicks: number; visitors: number; signups: number; onboarded: number; tried: number; opened_checkout: number; paid: number; paying_now: number; cancelling: number; ended: number;
  revenue_usd: number; net_usd: number; click_to_signup: number | null; signup_to_paid: number | null; click_to_paid: number | null; revenue_per_click: number | null; revenue_per_payer: number | null;
  median_hours_to_pay: number | null; last_click: string | null; last_signup: string | null;
  devices: Array<{ key: string; n: number }>; browsers: Array<{ key: string; n: number }>; referrers: Array<{ key: string; n: number }>; days: Array<{ day: string; clicks: number; signups: number; paid: number }>;
};
export type AffiliateSummary = { range: { days: number | null; from: string | null }; links: LinkStats[]; totals: Omit<LinkStats, "code" | "name" | "note" | "active" | "created_at" | "url" | "devices" | "browsers" | "referrers" | "days" | "last_click" | "last_signup" | "median_hours_to_pay"> & { links: number };
  people: PersonRow[]; notes: string[] };

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const top = (xs: Array<string | null>, n = 6) => { const m = new Map<string, number>(); for (const x of xs) { const k = x || "unknown"; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, v]) => ({ key, n: v })); };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayKey = (t: string | number, tzMin: number) => new Date((typeof t === "number" ? t : Date.parse(t)) + tzMin * 60_000).toISOString().slice(0, 10);

/** Everything the tab shows, from rows already loaded. Pure (tested). `days` null = all time; tz in minutes (PT = -480). */
export function summarizeAffiliates(input: { links: LinkRow[]; clicks: ClickRow[]; people: PersonRow[]; days: number | null; tz: number; now: number; includeInternal?: boolean; env?: Record<string, string | undefined> }): AffiliateSummary {
  const from = input.days ? input.now - input.days * DAY : null;
  const inRange = (t: string | null) => !!t && (from == null || Date.parse(t) >= from);
  const people = input.people.filter((p) => input.includeInternal || !p.internal);
  const stat = (l: LinkRow): LinkStats => {
    const clicks = input.clicks.filter((c) => c.code === l.code && inRange(c.created_at));
    const ps = people.filter((p) => p.code === l.code && inRange(p.signed_up));
    const payers = ps.filter((p) => p.paid_usd > 0 || (p.billing_source === "apple" && ["active", "trialing", "past_due"].includes(p.status)));
    const visitors = new Set(clicks.map((c) => c.visitor ?? `anon-${c.created_at}`)).size;
    const revenue = payers.reduce((s, p) => s + p.paid_usd, 0), net = payers.reduce((s, p) => s + p.net_usd, 0);
    const span = input.days ?? Math.max(1, Math.ceil((input.now - Date.parse(l.created_at)) / DAY));
    const days: LinkStats["days"] = [];
    for (let i = Math.min(span, 90) - 1; i >= 0; i--) {
      const d = dayKey(input.now - i * DAY, input.tz);
      days.push({ day: d, clicks: clicks.filter((c) => dayKey(c.created_at, input.tz) === d).length, signups: ps.filter((p) => dayKey(p.signed_up, input.tz) === d).length, paid: payers.filter((p) => p.first_paid_at && dayKey(p.first_paid_at, input.tz) === d).length });
    }
    const hoursToPay = payers.filter((p) => p.first_paid_at).map((p) => (Date.parse(p.first_paid_at!) - Date.parse(p.signed_up)) / 3600_000).filter((h) => h >= 0);
    return {
      code: l.code, name: l.name, note: l.note, active: l.active, created_at: l.created_at, url: affiliateLink(l.code, input.env),
      clicks: clicks.length, visitors, signups: ps.length, onboarded: ps.filter((p) => p.onboarded).length, tried: ps.filter((p) => p.jobs > 0).length, opened_checkout: ps.filter((p) => p.opened_checkout).length,
      paid: payers.length, paying_now: ps.filter((p) => ["active", "trialing", "past_due"].includes(p.status) && !p.cancel_at_period_end).length, cancelling: ps.filter((p) => p.status === "active" && p.cancel_at_period_end).length,
      ended: payers.filter((p) => p.status === "canceled").length, revenue_usd: revenue, net_usd: net,
      click_to_signup: ratio(ps.length, visitors), signup_to_paid: ratio(payers.length, ps.length), click_to_paid: ratio(payers.length, visitors),
      revenue_per_click: visitors ? revenue / visitors : null, revenue_per_payer: payers.length ? revenue / payers.length : null, median_hours_to_pay: median(hoursToPay),
      last_click: clicks.map((c) => c.created_at).sort().pop() ?? null, last_signup: ps.map((p) => p.signed_up).sort().pop() ?? null,
      devices: top(clicks.map((c) => c.device)), browsers: top(clicks.map((c) => c.browser)), referrers: top(clicks.map((c) => c.referrer)), days,
    };
  };
  const links = input.links.map(stat).sort((a, b) => b.paid - a.paid || b.signups - a.signups || b.clicks - a.clicks || a.name.localeCompare(b.name));
  const sum = (k: keyof LinkStats) => links.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const t = { links: links.length, clicks: sum("clicks"), visitors: sum("visitors"), signups: sum("signups"), onboarded: sum("onboarded"), tried: sum("tried"), opened_checkout: sum("opened_checkout"), paid: sum("paid"), paying_now: sum("paying_now"),
    cancelling: sum("cancelling"), ended: sum("ended"), revenue_usd: sum("revenue_usd"), net_usd: sum("net_usd") };
  const totals = { ...t, click_to_signup: ratio(t.signups, t.visitors), signup_to_paid: ratio(t.paid, t.signups), click_to_paid: ratio(t.paid, t.visitors), revenue_per_click: t.visitors ? t.revenue_usd / t.visitors : null, revenue_per_payer: t.paid ? t.revenue_usd / t.paid : null };
  const notes: string[] = [];
  const byAnswers = people.filter((p) => p.credited_via === "answers" && inRange(p.signed_up)).length;
  if (byAnswers) notes.push(`${byAnswers} sign-up${byAnswers === 1 ? "" : "s"} credited from the code in the sign-up answers (the app did not claim it on the account).`);
  return { range: { days: input.days, from: from ? new Date(from).toISOString() : null }, links, totals, people: people.filter((p) => inRange(p.signed_up)).sort((a, b) => b.signed_up.localeCompare(a.signed_up)), notes };
}

/** Reads the links, their clicks and every credited person with their plan, jobs and money. */
export async function loadAffiliates(sb: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<{ links: LinkRow[]; clicks: ClickRow[]; people: PersonRow[] }> {
  const links = await sb.from("studio_affiliate_links").select("code,name,note,active,created_at").order("created_at", { ascending: false });
  if (links.error) throw links.error;
  const clicks: ClickRow[] = [];
  for (let from = 0; from < 500_000; from += 1000) {
    const r = await sb.from("studio_affiliate_clicks").select("code,visitor,device,browser,referrer,landing,created_at").order("id").range(from, from + 999);
    if (r.error) throw r.error;
    clicks.push(...((r.data ?? []) as ClickRow[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const codes = new Set(((links.data ?? []) as LinkRow[]).map((l) => l.code));
  // credited on the account, or (fallback) the code in the sign-up answers
  const cols = "user_id,created_at,onboarding,plan_id,billing_interval,status,cancel_at_period_end,billing_source,stripe_customer_id,owner_pass,affiliate_code,affiliate_at";
  const [byCol, byAnswer] = await Promise.all([
    sb.from("studio_customers").select(cols).not("affiliate_code", "is", null).limit(20000),
    sb.from("studio_customers").select(cols).is("affiliate_code", null).not("onboarding->attribution->>aff", "is", null).limit(20000),
  ]);
  for (const r of [byCol, byAnswer]) if (r.error) throw r.error;
  const rows = [...((byCol.data ?? []) as any[]).map((c) => ({ c, code: c.affiliate_code as string, via: "account" as const })),
    ...((byAnswer.data ?? []) as any[]).map((c) => ({ c, code: normalizeCode(c.onboarding?.attribution?.aff) ?? "", via: "answers" as const }))].filter((x) => codes.has(x.code));
  const ids = rows.map((x) => x.c.user_id);
  const users = new Map<string, { email: string | null; created_at: string; last: string | null }>();
  const admin: any = (sb as any).auth?.admin;
  for (const id of ids) { try { const r = await admin?.getUserById?.(id); const u = r?.data?.user; if (u) users.set(id, { email: u.email ?? null, created_at: u.created_at, last: u.last_sign_in_at ?? null }); } catch { /* fine */ } }
  const jobs = new Map<string, number>(), checkout = new Set<string>(), seen = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const [j, e] = await Promise.all([
      sb.from("studio_jobs").select("user_id").in("user_id", part).limit(50000),
      sb.from("studio_events").select("user_id,kind,created_at").in("user_id", part).in("kind", ["checkout", "page"]).order("created_at", { ascending: false }).limit(50000),
    ]);
    for (const r of (j.data ?? []) as any[]) jobs.set(r.user_id, (jobs.get(r.user_id) ?? 0) + 1);
    for (const r of (e.data ?? []) as any[]) { if (r.kind === "checkout") checkout.add(r.user_id); if (!seen.has(r.user_id)) seen.set(r.user_id, r.created_at); }
  }
  // money: live invoices paid (plans) and one-off payments (top-ups, packs), by Stripe customer
  const cus = new Set(rows.map((x) => x.c.stripe_customer_id).filter(Boolean));
  const paid = new Map<string, number>(), payments = new Map<string, number>(), firstPaid = new Map<string, string>();
  if (cus.size) for (let from = 0; from < 200_000; from += 1000) {
    const r = await sb.from("studio_stripe_events").select("type,received_at,payload").in("type", ["invoice.paid", "checkout.session.completed"]).order("received_at").range(from, from + 999);
    if (r.error) throw r.error;
    for (const ev of (r.data ?? []) as any[]) {
      const o = ev.payload?.data?.object ?? {}; const c = typeof o.customer === "string" ? o.customer : o.customer?.id;
      if (!c || !cus.has(c) || o.livemode === false) continue;
      const usd = ev.type === "invoice.paid" ? Number(o.amount_paid ?? 0) / 100 : o.mode === "payment" && o.payment_status === "paid" ? Number(o.amount_total ?? 0) / 100 : 0;
      if (!(usd > 0)) continue;
      paid.set(c, (paid.get(c) ?? 0) + usd); payments.set(c, (payments.get(c) ?? 0) + 1); if (!firstPaid.has(c)) firstPaid.set(c, ev.received_at);
    }
    if ((r.data ?? []).length < 1000) break;
  }
  const people: PersonRow[] = rows.map(({ c, code, via }) => {
    const u = users.get(c.user_id); const gross = c.stripe_customer_id ? paid.get(c.stripe_customer_id) ?? 0 : 0; const n = c.stripe_customer_id ? payments.get(c.stripe_customer_id) ?? 0 : 0;
    return { user_id: c.user_id, email: u?.email ?? null, code, credited_via: via, signed_up: u?.created_at ?? c.created_at, plan: c.plan_id ?? null, interval: c.billing_interval ?? null, status: String(c.status ?? "none"),
      cancel_at_period_end: !!c.cancel_at_period_end, billing_source: c.billing_source ?? null, onboarded: !!c.onboarding?.completed_at, jobs: jobs.get(c.user_id) ?? 0, opened_checkout: checkout.has(c.user_id),
      paid_usd: gross, net_usd: gross ? gross * (1 - STRIPE_FEE.rate) - STRIPE_FEE.fixed * n : 0, first_paid_at: c.stripe_customer_id ? firstPaid.get(c.stripe_customer_id) ?? null : null,
      last_seen: seen.get(c.user_id) ?? u?.last ?? null, internal: !!c.owner_pass || isInternalEmail(u?.email, env) };
  });
  return { links: (links.data ?? []) as LinkRow[], clicks, people };
}

/** Credits a new account to a code, once: the code on the account's metadata (set at sign-up) wins over the browser's. */
export async function creditAffiliate(sb: SupabaseClient, userId: string, browserCode: string | null, now = Date.now()): Promise<{ credited: boolean; code?: string; reason?: string }> {
  let cust = await sb.from("studio_customers").select("user_id,affiliate_code").eq("user_id", userId).maybeSingle();
  if (cust.error) throw cust.error;
  if (!cust.data) {
    // a brand-new person: their Studio row is written by the first sign-up answer, which can come after this claim.
    // Make the empty row here (the answers then fill it), so the claim never has to wait for them.
    const got0 = await (sb as any).auth?.admin?.getUserById?.(userId);
    if (!got0?.data?.user) return { credited: false, reason: "no_account" };
    const made = await sb.from("studio_customers").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
    if (made.error) throw made.error;
    cust = await sb.from("studio_customers").select("user_id,affiliate_code").eq("user_id", userId).maybeSingle();
    if (cust.error) throw cust.error;
    if (!cust.data) return { credited: false, reason: "no_account" };
  }
  if (cust.data.affiliate_code) return { credited: false, reason: "already_credited", code: cust.data.affiliate_code };
  const got = await (sb as any).auth?.admin?.getUserById?.(userId);
  const user = got?.data?.user;
  const code = normalizeCode(user?.user_metadata?.aff) ?? normalizeCode(browserCode);
  if (!code) return { credited: false, reason: "no_code" };
  if (!canCredit(cust.data, user?.created_at, now)) return { credited: false, reason: "not_new" };
  const link = await sb.from("studio_affiliate_links").select("code,active").eq("code", code).maybeSingle();
  if (link.error) throw link.error;
  if (!link.data) return { credited: false, reason: "unknown_code" };
  if (!link.data.active) return { credited: false, reason: "paused" }; // a paused link (the deal ended) credits no one new
  const w = await sb.from("studio_customers").update({ affiliate_code: code, affiliate_at: new Date(now).toISOString() }).eq("user_id", userId).is("affiliate_code", null).select("user_id");
  if (w.error) throw w.error;
  if (!(w.data ?? []).length) return { credited: false, reason: "already_credited" };
  console.log(`[affiliate] credited ${JSON.stringify({ user: userId, code })}`);
  return { credited: true, code };
}

// ---------------------------------------------------------------- routes

export function registerAffiliates(app: Express, sbFn: () => SupabaseClient, deps: { env?: Record<string, string | undefined>; now?: () => number } = {}): void {
  const env = deps.env ?? process.env, now = () => deps.now?.() ?? Date.now();
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any, where: string) => {
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist|column .*affiliate/i.test(msg)) return res.status(503).json({ error: "affiliates_unavailable", detail: "The affiliate links migration has not been applied" });
    console.log(`[affiliate] ${where}: ${msg.slice(0, 200)}`);
    res.status(500).json({ error: "affiliates_failed" });
  };
  const admin = async (req: Request, res: Response, sb: SupabaseClient): Promise<boolean> => {
    if (!affiliatesEnabled(env) || !(await isStudioAdmin(req, sb, env))) { res.status(404).json({ error: "not_found" }); return false; }
    return true;
  };

  // A click, from the site's beacon. Public (no account), small, rate-limited per address; always 204 so a page never
  // waits on it or learns whether a code exists. The same visitor on the same link within 30 minutes counts once; a
  // paused link counts nothing (its visitors still land on the site as usual).
  const perIp = new Map<string, { at: number; n: number }>(), recent = new Map<string, number>();
  const knownCodes = { at: 0, set: new Set<string>() };
  app.post("/api/public/aff-click", express.text({ type: "*/*", limit: "2kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
    try {
      if (!affiliatesEnabled(env)) return;
      const t = now(), ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
      const w = perIp.get(ip); if (!w || t - w.at > 60_000) perIp.set(ip, { at: t, n: 1 }); else if (++w.n > 30) return;
      if (perIp.size > 20000) perIp.clear();
      const c = clickInput(req.body); if (!c) return;
      const key = `${c.code}:${c.visitor ?? ip}`; const last = recent.get(key);
      if (last && t - last < 30 * 60_000) return;
      recent.set(key, t); if (recent.size > 50000) recent.clear();
      const sb = sbFn();
      if (t - knownCodes.at > 60_000) { const r = await sb.from("studio_affiliate_links").select("code").eq("active", true); if (!r.error) { knownCodes.set = new Set(((r.data ?? []) as any[]).map((x) => x.code)); knownCodes.at = t; } }
      if (!knownCodes.set.has(c.code)) return;
      const d = deviceOf(String(req.headers["user-agent"] ?? ""));
      const ins = await sb.from("studio_affiliate_clicks").insert({ code: c.code, visitor: c.visitor, device: d.device, browser: d.browser, referrer: c.referrer, landing: c.landing });
      if (ins.error) console.log(`[affiliate] click not saved: ${String(ins.error.message).slice(0, 160)}`);
    } catch (e: any) { console.log(`[affiliate] click: ${String(e?.message ?? e).slice(0, 160)}`); }
  });

  /** POST /api/studio/affiliate/claim {code?}: the signed-in person's new account credited to the link that brought them. */
  app.post("/api/studio/affiliate/claim", async (req, res) => {
    try {
      const u = userId(req); if (!u || !UUID_RE.test(u)) return res.status(401).json({ error: "unauthorized" });
      if (!affiliatesEnabled(env)) return res.json({ credited: false, reason: "off" });
      const r = await creditAffiliate(sbFn(), u, typeof req.body?.code === "string" ? req.body.code : null, now());
      res.json({ credited: r.credited, reason: r.reason ?? null });
    } catch (e) { fail(res, e, "claim"); }
  });

  /** GET /api/studio/admin/affiliates?days=7|30|90|all&tz=-480&internal=1: the tab's numbers. */
  app.get("/api/studio/admin/affiliates", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn(); if (!(await admin(req, res, sb))) return;
      const raw = String(req.query.days ?? "all");
      const days = raw === "all" ? null : Math.min(365, Math.max(1, Math.round(Number(raw)) || 30));
      const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz ?? -480)) || 0));
      const data = await loadAffiliates(sb, env);
      res.json(summarizeAffiliates({ ...data, days, tz, now: now(), includeInternal: req.query.internal === "1", env }));
    } catch (e) { fail(res, e, "summary"); }
  });

  /** POST /api/studio/admin/affiliates {name, code?, note?}: a new link. The code is checked for shape and uniqueness. */
  app.post("/api/studio/admin/affiliates", async (req, res) => {
    try {
      const sb = sbFn(); if (!(await admin(req, res, sb))) return;
      const name = String(req.body?.name ?? "").trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "name_required", detail: "Give the link a name (who it is for)" });
      const note = req.body?.note == null ? null : String(req.body.note).trim().slice(0, 500) || null;
      const existing = await sb.from("studio_affiliate_links").select("code");
      if (existing.error) throw existing.error;
      const taken = new Set(((existing.data ?? []) as any[]).map((x) => x.code));
      let code: string;
      if (req.body?.code != null && String(req.body.code).trim()) {
        const c = normalizeCode(req.body.code);
        if (!c) return res.status(400).json({ error: "invalid_code", detail: "3 to 32 letters, numbers or dashes" });
        if (taken.has(c)) return res.status(409).json({ error: "code_taken", detail: `"${c}" is already a link` });
        code = c;
      } else code = codeFromName(name, taken);
      const ins = await sb.from("studio_affiliate_links").insert({ code, name, note, created_by: userId(req) }).select("code,name,note,active,created_at").single();
      if (ins.error) { if (/duplicate key/i.test(ins.error.message)) return res.status(409).json({ error: "code_taken", detail: `"${code}" is already a link` }); throw ins.error; }
      knownCodes.at = 0;
      res.status(201).json({ link: { ...ins.data, url: affiliateLink(code, env) } });
    } catch (e) { fail(res, e, "create"); }
  });

  /** PATCH /api/studio/admin/affiliates/:code {name?, note?, active?}: rename, note, pause or resume. The code never changes. */
  app.patch("/api/studio/admin/affiliates/:code", async (req, res) => {
    try {
      const sb = sbFn(); if (!(await admin(req, res, sb))) return;
      const code = normalizeCode(req.params.code); if (!code) return res.status(404).json({ error: "not_found" });
      const patch: Record<string, any> = {};
      if (req.body?.name != null) { const n = String(req.body.name).trim().slice(0, 80); if (!n) return res.status(400).json({ error: "name_required" }); patch.name = n; }
      if (req.body?.note !== undefined) patch.note = req.body.note == null ? null : String(req.body.note).trim().slice(0, 500) || null;
      if (typeof req.body?.active === "boolean") patch.active = req.body.active;
      if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_change" });
      const r = await sb.from("studio_affiliate_links").update(patch).eq("code", code).select("code,name,note,active,created_at");
      if (r.error) throw r.error;
      if (!(r.data ?? []).length) return res.status(404).json({ error: "not_found" });
      res.json({ link: { ...(r.data as any[])[0], url: affiliateLink(code, env) } });
    } catch (e) { fail(res, e, "update"); }
  });
}
