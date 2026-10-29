// Clone8 Studio: the self-serve, paid, credit-based product beside the managed service.
//
// Plans are sold through Stripe Checkout; Stripe's webhooks are the only thing that changes a plan or
// grants credits (studio_apply_subscription, studio_grant). Tools cost credits that are reserved when a
// job is created and settled by the worker that runs it. Every route here is for the signed-in person
// themselves; nothing is operator-only except what the access gate already enforces elsewhere.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { planFeatureLines, studioCosts, unitEconomics, type StudioCosts } from "./studio-pricing.js";
import { isAdmin } from "./auth.js";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------
// Catalog. Prices live in Stripe; the ids come from the environment so test and live keys can differ.
// ---------------------------------------------------------------------------------------------------
export type PlanId = "starter" | "creator" | "studio";
export type Interval = "month" | "year";
export type Plan = { id: PlanId; name: string; tagline: string; monthly_usd: number; annual_usd_per_month: number; credits: number; parallel: number; features: string[]; popular?: boolean };

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", tagline: "For one creator with a library to put to work", monthly_usd: 29, annual_usd_per_month: 24, credits: 1000, parallel: 1,
    features: ["1 job at a time", "Downloads in 1080×1920"] },
  { id: "creator", name: "Creator", tagline: "For creators and small teams posting daily", monthly_usd: 79, annual_usd_per_month: 66, credits: 3500, parallel: 2, popular: true,
    features: ["2 jobs at a time", "Blueprint+ hooks and captions", "Priority queue"] },
  { id: "studio", name: "Studio", tagline: "For brands and agencies running many accounts", monthly_usd: 199, annual_usd_per_month: 166, credits: 10000, parallel: 4,
    features: ["4 jobs at a time", "Blueprint+ hooks and captions", "Priority queue", "A path to managed distribution"] },
];

// What a tool costs, in credits: derived in studio-pricing.ts from Higgsfield's rates, our plan prices and the
// margin target, so a price can never drift from a cost. COSTS is the value under the process environment.
export const costsFor = (env: Record<string, string | undefined> = process.env): StudioCosts => studioCosts(env, PLANS);
export const COSTS: StudioCosts = costsFor();
/** Plans with the price-dependent feature lines filled in from the live costs. */
export function plansWithFeatures(costs: StudioCosts): Plan[] {
  return PLANS.map((p) => ({ ...p, features: [...planFeatureLines(p, costs), ...p.features] }));
}

export function planById(id: string | null | undefined): Plan | null { return PLANS.find((p) => p.id === id) ?? null; }

export function priceIdFor(plan: PlanId, interval: Interval, env: Record<string, string | undefined> = process.env): string | null {
  return env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] || null;
}
export function planForPrice(priceId: string | null | undefined, env: Record<string, string | undefined> = process.env): { plan: Plan; interval: Interval } | null {
  if (!priceId) return null;
  for (const plan of PLANS) for (const interval of ["month", "year"] as Interval[]) if (priceIdFor(plan.id, interval, env) === priceId) return { plan, interval };
  return null;
}
export function stripeConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.STRIPE_SECRET_KEY && PLANS.every((p) => priceIdFor(p.id, "month", env));
}
// Which tools accept jobs. A tool opens when its worker is deployed (and, for Recast, when the Higgsfield
// platform key exists); until then the page is visible but Generate is disabled, so no credits can be
// reserved for work nothing would run.
export function toolsEnabled(env: Record<string, string | undefined> = process.env) {
  const recast = !!env.HIGGSFIELD_API_KEY && env.STUDIO_RECAST_ENABLED !== "false";
  // The full Genjutsu model stays closed until a paid run has measured what Higgsfield bills for it.
  return { blueprint: env.STUDIO_BLUEPRINT_ENABLED === "true", blueprint_plus: env.STUDIO_BLUEPRINT_PLUS_ENABLED === "true", recast, recast_full: recast && env.STUDIO_RECAST_FULL_ENABLED === "true" };
}

// ---------------------------------------------------------------------------------------------------
// Quotes: the credits a job will reserve, computed from validated options before anything is queued.
// ---------------------------------------------------------------------------------------------------
export type Quote = { tool: "blueprint" | "blueprint_plus" | "recast"; credits: number; options: Record<string, any>; summary: string };

export function quote(tool: string, options: any, asset: { kind: string; probe?: any } | null, costs: StudioCosts = COSTS): Quote {
  const o = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  if (tool === "blueprint" || tool === "blueprint_plus") {
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const copies = Math.floor(Number(o.copies));
    if (!(copies >= 1 && copies <= 50)) throw new StudioError("invalid_copies", "Between 1 and 50 copies");
    const per = tool === "blueprint" ? costs.blueprint_copy : costs.blueprint_plus_copy;
    return { tool, credits: copies * per, options: { copies }, summary: `${copies} ${copies === 1 ? "copy" : "copies"} × ${per}` };
  }
  if (tool === "recast") {
    if (!asset || asset.kind !== "video") throw new StudioError("asset_required", "Pick a video first");
    const duration = Number(asset.probe?.duration);
    if (!(duration > 0)) throw new StudioError("asset_not_inspected", "The video is still being checked");
    const model = o.model === "light" ? "light" : "full";
    // Higgsfield's limits: the full model trims a source to 30 s, Light uses the first 15 s. Priced on what it will render.
    const seconds = Math.ceil(Math.min(duration, model === "light" ? 15 : 30));
    if (!UUID_RE.test(String(o.character_asset_id ?? "")) && !/^[a-z0-9_-]{2,40}$/.test(String(o.character ?? ""))) throw new StudioError("character_required", "Pick a character or upload a photo");
    const per = model === "light" ? costs.recast_light_second : costs.recast_second;
    return { tool, credits: seconds * per, options: { model, seconds, character: o.character ?? null, character_asset_id: o.character_asset_id ?? null }, summary: `${seconds} s × ${per}` };
  }
  throw new StudioError("unknown_tool", "Unknown tool");
}

export class StudioError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

// ---------------------------------------------------------------------------------------------------
// Stripe shapes. API 2026-09-30 moved the billing period onto subscription items and the subscription
// reference of an invoice under invoice.parent; older shapes are still read for safety.
// ---------------------------------------------------------------------------------------------------
const iso = (unix: any) => (Number.isFinite(Number(unix)) && Number(unix) > 0 ? new Date(Number(unix) * 1000).toISOString() : null);

export function subscriptionSnapshot(sub: any) {
  const item = sub?.items?.data?.[0] ?? null;
  const priceId: string | null = item?.price?.id ?? item?.plan?.id ?? null;
  const match = planForPrice(priceId);
  return {
    id: String(sub?.id ?? ""),
    customer: typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id ?? null,
    status: String(sub?.status ?? "none"),
    price_id: priceId,
    plan: match?.plan ?? null,
    interval: match?.interval ?? ((item?.price?.recurring?.interval === "year" ? "year" : "month") as Interval),
    period_start: iso(item?.current_period_start ?? sub?.current_period_start),
    period_end: iso(item?.current_period_end ?? sub?.current_period_end),
    cancel_at_period_end: !!sub?.cancel_at_period_end,
    user_id: (sub?.metadata?.user_id as string | undefined) ?? null,
  };
}
export function invoiceSubscriptionId(inv: any): string | null {
  const p = inv?.parent?.subscription_details?.subscription ?? inv?.subscription ?? null;
  return typeof p === "string" ? p : p?.id ?? null;
}

const STATUS_OK = new Set(["none", "incomplete", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);
const toStatus = (s: string) => (STATUS_OK.has(s) ? s : s === "incomplete_expired" ? "canceled" : "none");

type StripeLike = {
  checkout: { sessions: { create: (p: any) => Promise<{ url: string | null; id: string }> } };
  billingPortal: { sessions: { create: (p: any) => Promise<{ url: string }> } };
  subscriptions: { retrieve: (id: string) => Promise<any> };
  webhooks: { constructEvent: (raw: string, sig: string, secret: string) => any };
};

async function userForCustomer(sb: SupabaseClient, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const r = await sb.from("studio_customers").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  if (r.error) throw r.error;
  return r.data?.user_id ?? null;
}

async function applySubscription(sb: SupabaseClient, userId: string, sub: any) {
  const s = subscriptionSnapshot(sub);
  const r = await sb.rpc("studio_apply_subscription", {
    p_user: userId, p_customer: s.customer, p_subscription: s.id || null, p_plan: s.plan?.id ?? null, p_interval: s.plan ? s.interval : null,
    p_status: toStatus(s.status), p_period_start: s.period_start, p_period_end: s.period_end, p_cancel_at_period_end: s.cancel_at_period_end,
    p_credits_per_period: s.plan?.credits ?? 0, p_parallel: s.plan?.parallel ?? 1,
  });
  if (r.error) throw r.error;
  return s;
}

/** Apply one Stripe event. Returns a short description for the log. Idempotency is the caller's job. */
export async function applyStripeEvent(sb: SupabaseClient, stripe: StripeLike, event: any): Promise<string> {
  const type = String(event?.type ?? ""), obj = event?.data?.object ?? {};
  if (type === "checkout.session.completed") {
    const userId = (obj.metadata?.user_id as string | undefined) ?? (obj.client_reference_id as string | undefined) ?? null;
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id ?? null;
    if (!userId || !UUID_RE.test(userId)) return "checkout without user";
    if (customer) {
      const link = await sb.from("studio_customers").upsert({ user_id: userId, stripe_customer_id: customer, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (link.error) throw link.error;
    }
    if (subId) { const sub = await stripe.subscriptions.retrieve(subId); const s = await applySubscription(sb, userId, { ...sub, metadata: { ...(sub.metadata ?? {}), user_id: userId } }); return `checkout → ${s.plan?.id ?? "unknown plan"} ${s.status}`; }
    return "checkout linked customer";
  }
  if (type.startsWith("customer.subscription.")) {
    const s = subscriptionSnapshot(obj);
    const userId = (s.user_id && UUID_RE.test(s.user_id) ? s.user_id : null) ?? (await userForCustomer(sb, s.customer));
    if (!userId) return "subscription for unknown customer";
    await applySubscription(sb, userId, obj);
    return `${type} → ${s.plan?.id ?? "unknown plan"} ${s.status}`;
  }
  if (type === "invoice.paid") {
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    const subId = invoiceSubscriptionId(obj);
    if (!subId) return "invoice without subscription";
    const userId = await userForCustomer(sb, customer);
    if (!userId) return "invoice for unknown customer";
    const sub = await stripe.subscriptions.retrieve(subId);
    const s = await applySubscription(sb, userId, sub);
    if (!s.plan) return "invoice for unknown plan";
    const reason = String(obj.billing_reason ?? "");
    // A new period replaces what was left; a mid-cycle upgrade adds its credits on top.
    const expire = reason === "subscription_cycle" || reason === "subscription_create" || reason === "";
    // Credits are priced per month. An annual invoice pays for twelve of them at once, so it grants the
    // year's credits in one go; they last until the next annual invoice replaces them.
    const credits = s.plan.credits * (s.interval === "year" ? 12 : 1);
    const g = await sb.rpc("studio_grant", { p_user: userId, p_credits: credits, p_ref: String(obj.id), p_expire_previous: expire, p_note: `${s.plan.name} ${s.interval === "year" ? "annual " : ""}${reason || "invoice"}` });
    if (g.error) throw g.error;
    return `invoice.paid → ${g.data?.granted ? "granted" : "already granted"} ${credits} (${reason || "invoice"})`;
  }
  return "ignored";
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
const safeName = (s: any) => String(s ?? "").replace(/[^\w.() -]+/g, "_").slice(0, 120) || "upload";
function kindFor(name: string, type: string): { kind: "video" | "image"; ext: "mp4" | "mov" | "jpg" | "png" } | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (type === "video/mp4" || ext === "mp4") return { kind: "video", ext: "mp4" };
  if (type === "video/quicktime" || ext === "mov") return { kind: "video", ext: "mov" };
  if (type === "image/jpeg" || ext === "jpg" || ext === "jpeg") return { kind: "image", ext: "jpg" };
  if (type === "image/png" || ext === "png") return { kind: "image", ext: "png" };
  return null;
}

export function registerStudio(app: Express, sbFn: () => SupabaseClient, deps: { stripe?: StripeLike | null; env?: Record<string, string | undefined>; log?: (s: string) => void } = {}): void {
  const env = deps.env ?? process.env;
  const costs = studioCosts(env, PLANS);
  const log = deps.log ?? ((s: string) => console.log(s));
  let stripeClient: StripeLike | null | undefined = deps.stripe;
  const stripe = (): StripeLike => {
    if (stripeClient === undefined) stripeClient = env.STRIPE_SECRET_KEY ? (new Stripe(env.STRIPE_SECRET_KEY) as unknown as StripeLike) : null;
    if (!stripeClient) throw new StudioError("billing_unavailable", "Billing is not configured yet", 503);
    return stripeClient;
  };
  const dashboard = () => (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, "");
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof StudioError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    const named = msg.match(/\b(subscription_required|insufficient_credits|too_many_jobs|asset_not_ready|job_not_found|job_not_cancelable|promo_unknown|promo_expired|promo_exhausted|promo_already_used|invalid_credits)\b/);
    if (named) return res.status(named[1] === "job_not_found" ? 404 : 409).json({ error: named[1] });
    if (/relation .* does not exist|function .* does not exist/i.test(msg)) return res.status(503).json({ error: "studio_unavailable", detail: "The Studio migration has not been applied" });
    console.error("[studio]", msg);
    res.status(500).json({ error: "studio_failed", detail: msg.slice(0, 200) });
  };
  const requireUser = (req: Request, res: Response): string | null => {
    const u = userId(req);
    if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    return u;
  };

  app.get("/api/studio/plans", (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ plans: plansWithFeatures(costs), costs, billing_ready: stripeConfigured(env), tools: toolsEnabled(env) });
  });

  // The owner's sheet: what each unit earns, costs and yields on every plan. Admin only; nothing a customer needs.
  app.get("/api/studio/economics", (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    res.json(unitEconomics(env, PLANS));
  });

  app.get("/api/studio/me", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const [cust, bal, jobs, ledger] = await Promise.all([
        sb.from("studio_customers").select("plan_id,billing_interval,status,period_start,period_end,cancel_at_period_end,credits_per_period,parallel_jobs,onboarding,stripe_customer_id").eq("user_id", u).maybeSingle(),
        sb.rpc("studio_balance", { p_user: u }),
        sb.from("studio_jobs").select("id,tool,status,credits_reserved,credits_charged,created_at").eq("user_id", u).gte("created_at", since).order("created_at", { ascending: false }).limit(200),
        sb.from("studio_credit_ledger").select("delta,reason,job_id,ref,note,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(50),
      ]);
      for (const r of [cust, bal, jobs, ledger]) if (r.error) throw r.error;
      const c: any = cust.data ?? null;
      const plan = planById(c?.plan_id);
      const spent = ((jobs.data ?? []) as any[]).reduce((n, j) => n + (j.credits_charged ?? (j.status === "queued" || j.status === "running" ? j.credits_reserved : 0)), 0);
      res.json({
        subscription: c ? { plan, interval: c.billing_interval, status: c.status, period_start: c.period_start, period_end: c.period_end, cancel_at_period_end: c.cancel_at_period_end, credits_per_period: c.credits_per_period, parallel_jobs: c.parallel_jobs, has_billing: !!c.stripe_customer_id } : null,
        active: !!c && (c.status === "active" || c.status === "trialing"),
        balance: Number(bal.data ?? 0),
        onboarding: c?.onboarding ?? {},
        usage_30d: { jobs: (jobs.data ?? []).length, credits: spent },
        ledger: ledger.data ?? [],
        costs,
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/onboarding", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const a = req.body?.answers;
    if (!a || typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > 4000) return res.status(400).json({ error: "invalid_answers" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_customers").upsert({ user_id: u, onboarding: { ...a, completed_at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select("onboarding").single();
      if (r.error) throw r.error;
      res.json({ onboarding: r.data.onboarding });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/checkout", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const plan = planById(req.body?.plan), interval: Interval = req.body?.interval === "year" ? "year" : "month";
    if (!plan) return res.status(400).json({ error: "unknown_plan" });
    const price = priceIdFor(plan.id, interval, env);
    if (!price) return res.status(503).json({ error: "billing_unavailable", detail: "That plan is not configured in Stripe yet" });
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id,status").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (cust.data?.status === "active" || cust.data?.status === "trialing") return res.status(409).json({ error: "already_subscribed", detail: "Change plans from the billing portal" });
      const email = req.auth && "email" in req.auth ? req.auth.email : undefined;
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        // Subscription mode always creates a customer; customer_creation is only valid in payment mode.
        ...(cust.data?.stripe_customer_id ? { customer: cust.data.stripe_customer_id } : { customer_email: email }),
        client_reference_id: u,
        metadata: { user_id: u, plan_id: plan.id, interval },
        subscription_data: { metadata: { user_id: u, plan_id: plan.id } },
        allow_promotion_codes: true,
        success_url: `${dashboard()}/#studio/account?checkout=success`,
        cancel_url: `${dashboard()}/#studio/pricing?checkout=canceled`,
      });
      log(`[studio] checkout ${JSON.stringify({ user: u, plan: plan.id, interval, session: session.id })}`);
      res.json({ url: session.url });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/portal", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const cust = await sb.from("studio_customers").select("stripe_customer_id").eq("user_id", u).maybeSingle();
      if (cust.error) throw cust.error;
      if (!cust.data?.stripe_customer_id) return res.status(409).json({ error: "no_billing_account" });
      const session = await stripe().billingPortal.sessions.create({ customer: cust.data.stripe_customer_id, return_url: `${dashboard()}/#studio/account` });
      res.json({ url: session.url });
    } catch (e) { fail(res, e); }
  });

  // Stripe → us. Signature-verified; the raw body is captured by the express.json verify hook in index.ts.
  app.post("/api/studio/stripe/webhook", async (req, res) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "webhook_unconfigured" });
    let event: any;
    try { event = stripe().webhooks.constructEvent(String((req as any).rawBody ?? ""), String(req.header("stripe-signature") ?? ""), secret); }
    catch (e: any) { return res.status(400).json({ error: "bad_signature", detail: String(e?.message ?? e).slice(0, 120) }); }
    try {
      const sb = sbFn();
      const ins = await sb.from("studio_stripe_events").insert({ id: event.id, type: event.type, payload: event }).select("id").maybeSingle();
      if (ins.error) {
        if (/duplicate|unique|23505/i.test(ins.error.message ?? "") || (ins.error as any).code === "23505") return res.json({ received: true, duplicate: true });
        throw ins.error;
      }
      let outcome = "";
      try { outcome = await applyStripeEvent(sb, stripe(), event); }
      catch (e: any) {
        await sb.from("studio_stripe_events").update({ error: String(e?.message ?? e).slice(0, 300) }).eq("id", event.id);
        console.error("[studio] webhook", event.type, String(e?.message ?? e));
        return res.status(500).json({ error: "webhook_failed" }); // Stripe retries; the event row keeps the error.
      }
      await sb.from("studio_stripe_events").update({ processed_at: new Date().toISOString() }).eq("id", event.id);
      log(`[studio] webhook ${event.type}: ${outcome}`);
      res.json({ received: true });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/promo", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,24}$/.test(code)) return res.status(400).json({ error: "invalid_code" });
    try {
      const r = await sbFn().rpc("studio_redeem_promo", { p_user: u, p_code: code });
      if (r.error) throw r.error;
      log(`[studio] promo ${JSON.stringify({ user: u, code })}`);
      res.json(r.data);
    } catch (e) { fail(res, e); }
  });

  // Uploads: the browser PUTs straight to storage with a signed URL, then confirms.
  app.post("/api/studio/assets/upload-url", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const name = safeName(req.body?.name), size = Number(req.body?.size ?? 0), k = kindFor(name, String(req.body?.type ?? ""));
    if (!k) return res.status(400).json({ error: "invalid_file", detail: "MP4, MOV, JPG or PNG" });
    if (!(size > 0 && size <= 536870912)) return res.status(400).json({ error: "file_too_large", detail: "at most 512 MB" });
    try {
      const sb = sbFn();
      const id = randomUUID(), key = `${u}/${id}.${k.ext}`;
      const row = await sb.from("studio_assets").insert({ id, user_id: u, kind: k.kind, name, object_key: key, bytes: size, status: "uploading" }).select("id").single();
      if (row.error) throw row.error;
      const signed = await sb.storage.from("studio-uploads").createSignedUploadUrl(key);
      if (signed.error || !signed.data) throw signed.error ?? new Error("signing_failed");
      res.json({ asset_id: id, key, token: signed.data.token, path: signed.data.path, bucket: "studio-uploads" });
    } catch (e) { fail(res, e); }
  });

  // The browser may also upload a poster frame for the thumbnail grids: one signed PUT into studio-outputs.
  app.post("/api/studio/assets/:id/poster-url", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id").eq("id", req.params.id).eq("user_id", u).neq("status", "deleted").maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const key = assetPosterKey(u, a.data.id);
      const signed = await sb.storage.from("studio-outputs").createSignedUploadUrl(key, { upsert: true });
      if (signed.error || !signed.data) throw signed.error ?? new Error("signing_failed");
      res.json({ key, token: signed.data.token, path: signed.data.path, bucket: "studio-outputs" });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/assets/:id/complete", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id,object_key,bytes,status,probe").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const dir = a.data.object_key.split("/")[0], file = a.data.object_key.split("/")[1];
      const listed = await sb.storage.from("studio-uploads").list(dir, { search: file, limit: 5 });
      if (listed.error) throw listed.error;
      const obj = (listed.data ?? []).find((o: any) => o.name === file);
      if (!obj) return res.status(409).json({ error: "upload_missing" });
      const bytes = Number(obj.metadata?.size ?? a.data.bytes) || a.data.bytes;
      // What the browser measured (duration, size) and whether it stored a poster. A worker's ffprobe later
      // replaces the numbers; the poster is kept unless the worker writes its own.
      const probe = { ...(a.data.probe ?? {}), ...clientProbe(req.body?.probe) };
      if (req.body?.poster === true) {
        const posters = await sb.storage.from("studio-outputs").list(`${u}/assets`, { search: `${a.data.id}.jpg`, limit: 5 });
        if (!posters.error && (posters.data ?? []).some((o: any) => o.name === `${a.data.id}.jpg`)) probe.poster_key = assetPosterKey(u, a.data.id);
      }
      const r = await sb.from("studio_assets").update({ status: "ready", bytes, probe, updated_at: new Date().toISOString() }).eq("id", a.data.id).select("id,kind,name,bytes,status,probe,created_at").single();
      if (r.error) throw r.error;
      res.json({ asset: (await withPosterUrls(sb, [r.data]))[0] });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/assets", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_assets").select("id,kind,name,bytes,status,probe,created_at").eq("user_id", u).neq("status", "deleted").order("created_at", { ascending: false }).limit(200);
      if (r.error) throw r.error;
      res.json({ assets: await withPosterUrls(sb, r.data ?? []) });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/assets/:id/url", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("object_key,status").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.status === "deleted") return res.status(404).json({ error: "asset_not_found" });
      const s = await sb.storage.from("studio-uploads").createSignedUrl(a.data.object_key, 900);
      if (s.error || !s.data) throw s.error ?? new Error("signing_failed");
      res.json({ url: s.data.signedUrl, expires_in: 900 });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/assets/:id", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "asset_not_found" });
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id,object_key").eq("id", req.params.id).eq("user_id", u).neq("status", "deleted").maybeSingle();
      if (a.error) throw a.error;
      if (!a.data) return res.status(404).json({ error: "asset_not_found" });
      const busy = await sb.from("studio_jobs").select("id", { count: "exact", head: true }).eq("asset_id", a.data.id).in("status", ["queued", "running"]);
      if (busy.error) throw busy.error;
      if ((busy.count ?? 0) > 0) return res.status(409).json({ error: "asset_in_use" });
      const rm = await sb.storage.from("studio-uploads").remove([a.data.object_key]);
      if (rm.error) throw rm.error;
      const r = await sb.from("studio_assets").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("id", a.data.id);
      if (r.error) throw r.error;
      res.json({ deleted: a.data.id });
    } catch (e) { fail(res, e); }
  });

  // Jobs
  app.post("/api/studio/quote", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const asset = await loadAsset(sbFn(), u, req.body?.asset_id);
      const q = quote(String(req.body?.tool ?? ""), req.body?.options, asset, costs);
      res.json(q);
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/jobs", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const asset = await loadAsset(sb, u, req.body?.asset_id);
      const q = quote(String(req.body?.tool ?? ""), req.body?.options, asset, costs);
      const tools = toolsEnabled(env);
      if (!(tools as any)[q.tool]) throw new StudioError("tool_not_open", "This tool is not taking jobs yet", 503);
      if (q.tool === "recast" && q.options.model === "full" && !tools.recast_full) throw new StudioError("model_not_open", "The full model is not taking jobs yet", 503);
      const r = await sb.rpc("studio_create_job", { p_user: u, p_tool: q.tool, p_asset: asset?.id ?? null, p_options: q.options, p_credits: q.credits });
      if (r.error) throw r.error;
      log(`[studio] job ${JSON.stringify({ user: u, tool: q.tool, credits: q.credits, job: r.data?.id })}`);
      res.status(201).json({ job: r.data, quote: q });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/jobs", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_jobs").select("id,tool,status,asset_id,options,credits_reserved,credits_charged,progress,outputs,error_code,created_at,started_at,finished_at").eq("user_id", u).order("created_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      const jobs = await withAssetNames(sb, u, (r.data ?? []).map(publicJob));
      // Posters for the grids: the first few of each finished job in one signing call. Videos are signed per job.
      const keys = jobs.flatMap((j) => (j.status === "done" ? j.outputs.slice(0, LIST_POSTERS).map((o: any) => o.poster_key).filter(Boolean) : []));
      if (keys.length) {
        const signed = await sb.storage.from("studio-outputs").createSignedUrls(keys, 900);
        if (signed.error) throw signed.error;
        const urls = new Map((signed.data ?? []).map((x: any) => [x.path, x.signedUrl]));
        for (const j of jobs) if (j.status === "done") j.outputs = j.outputs.map((o: any, i: number) => (i < LIST_POSTERS && o.poster_key ? { ...o, poster_url: urls.get(o.poster_key) ?? null } : o));
      }
      res.json({ jobs });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/jobs/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "job_not_found" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_jobs").select("id,tool,status,asset_id,options,credits_reserved,credits_charged,progress,outputs,error_code,created_at,started_at,finished_at").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "job_not_found" });
      const job = (await withAssetNames(sb, u, [publicJob(r.data)]))[0];
      if (job.status === "done" && Array.isArray(job.outputs) && job.outputs.length) {
        const posters = job.outputs.map((o: any) => o.poster_key).filter(Boolean);
        const signed = posters.length ? await sb.storage.from("studio-outputs").createSignedUrls(posters, 900) : { data: [], error: null };
        if (signed.error) throw signed.error;
        const urls = new Map((signed.data ?? []).map((s: any) => [s.path, s.signedUrl]));
        // Each video is signed on its own so the browser saves it under a readable name.
        const base = downloadBase(job.asset_name, job.tool);
        const videos = await Promise.all(job.outputs.map((o: any, i: number) => sb.storage.from("studio-outputs").createSignedUrl(o.key, 900, { download: `${base}-${String(o.index ?? i + 1).padStart(2, "0")}.mp4` })));
        job.outputs = job.outputs.map((o: any, i: number) => ({ ...o, url: videos[i].data?.signedUrl ?? null, poster_url: o.poster_key ? urls.get(o.poster_key) ?? null : null }));
      }
      res.json({ job });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/jobs/:id/cancel", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "job_not_found" });
    try {
      const r = await sbFn().rpc("studio_cancel", { p_user: u, p_job: req.params.id });
      if (r.error) throw r.error;
      res.json({ job: publicJob(r.data) });
    } catch (e) { fail(res, e); }
  });
}

async function loadAsset(sb: SupabaseClient, u: string, assetId: any) {
  if (assetId == null) return null;
  if (!UUID_RE.test(String(assetId))) throw new StudioError("asset_not_found", "Unknown video", 404);
  const r = await sb.from("studio_assets").select("id,kind,status,probe").eq("id", assetId).eq("user_id", u).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data || r.data.status === "deleted") throw new StudioError("asset_not_found", "Unknown video", 404);
  if (r.data.status !== "ready") throw new StudioError("asset_not_ready", "The upload has not finished", 409);
  return r.data as { id: string; kind: string; status: string; probe: any };
}

const LIST_POSTERS = 8;
const assetPosterKey = (u: string, id: string) => `${u}/assets/${id}.jpg`;

/** Numbers the browser measured on its own video element; anything else is ignored. */
function clientProbe(p: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!p || typeof p !== "object") return out;
  for (const k of ["duration", "width", "height"]) { const v = Number(p[k]); if (Number.isFinite(v) && v > 0 && v < 1e6) out[k] = Math.round(v * 1000) / 1000; }
  return out;
}

/** The file name a saved copy gets: the upload's name without its extension, tidied, plus the tool. */
export function downloadBase(assetName: string | null | undefined, tool: string): string {
  const stem = String(assetName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${stem || "clone8"}-${tool === "recast" ? "recast" : "copy"}`;
}

async function withPosterUrls(sb: SupabaseClient, assets: any[]) {
  const keys = assets.map((a) => a.probe?.poster_key).filter(Boolean);
  if (!keys.length) return assets.map((a) => ({ ...a, poster_url: null }));
  const signed = await sb.storage.from("studio-outputs").createSignedUrls(keys, 900);
  const urls = new Map(((signed.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
  return assets.map((a) => ({ ...a, poster_url: a.probe?.poster_key ? urls.get(a.probe.poster_key) ?? null : null }));
}

async function withAssetNames(sb: SupabaseClient, u: string, jobs: any[]) {
  const ids = [...new Set(jobs.map((j) => j.asset_id).filter(Boolean))];
  if (!ids.length) return jobs.map((j) => ({ ...j, asset_name: null }));
  const r = await sb.from("studio_assets").select("id,name").eq("user_id", u).in("id", ids);
  const names = new Map(((r.data ?? []) as any[]).map((a) => [a.id, a.name]));
  return jobs.map((j) => ({ ...j, asset_name: j.asset_id ? names.get(j.asset_id) ?? null : null }));
}

function publicJob(j: any) {
  return { id: j.id, tool: j.tool, status: j.status, asset_id: j.asset_id, options: j.options ?? {}, credits_reserved: j.credits_reserved, credits_charged: j.credits_charged,
    progress: j.progress ?? {}, outputs: Array.isArray(j.outputs) ? j.outputs : [], error_code: j.error_code, created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at };
}
