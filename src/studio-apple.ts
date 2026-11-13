// Clone8 Studio: plans and credits bought through Apple in the iPhone app (StoreKit 2), into the same ledger the
// website (Stripe) uses. Design: docs/mobile/PLAN.md section 4a in the workspace. Off unless STUDIO_MOBILE_IAP is on.
//
// Two ways in, one apply step:
//  - POST /api/studio/apple/transaction: the app sends the signed transaction right after a purchase or a restore. The
//    purchase carries the person's account id (appAccountToken); a transaction for another account is refused.
//  - POST /api/studio/apple/notifications: Apple's server notifications (v2): renewals, cancels, lapses, refunds.
// Every signed payload is checked against Apple's root certificates (STUDIO_APPLE_ROOT_CERTS_DIR, default
// certs/apple, the .cer files Apple publishes) before anything is read from it.
//
// Credits follow the same rules as Stripe: a plan period grants its credits and replaces what was left of the last
// period's (grant refs "in_apple_<transaction>" so studio_grant treats them as plan grants, like Stripe's "in_..."
// invoices); a pack adds on top and never expires; a refund takes back what that purchase gave, never below zero.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Environment, SignedDataVerifier, type JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { planById, type Interval } from "./studio.js";
import { packById } from "./studio-pricing.js";

export const BUNDLE_ID = "io.clone8.app";
export const APP_APPLE_ID = 6834117541;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The App Store products (clone8-mobile/APPLE.md) and what each one is in our terms. */
export const APPLE_PRODUCTS: Record<string, { plan: string; interval: Interval } | { pack: string }> = {
  "io.clone8.app.starter.month": { plan: "starter", interval: "month" },
  "io.clone8.app.creator.month": { plan: "creator", interval: "month" },
  "io.clone8.app.studio.month": { plan: "studio", interval: "month" },
  "io.clone8.app.starter.year": { plan: "starter", interval: "year" },
  "io.clone8.app.creator.year": { plan: "creator", interval: "year" },
  "io.clone8.app.studio.year": { plan: "studio", interval: "year" },
  "io.clone8.app.credits.500": { pack: "pack_500" },
  "io.clone8.app.credits.2000": { pack: "pack_2000" },
  "io.clone8.app.credits.6000": { pack: "pack_6000" },
};

export const iapEnabled = (env: Record<string, string | undefined>) => /^(1|on|true|yes)$/i.test(String(env.STUDIO_MOBILE_IAP ?? ""));

export type Verifier = { transaction(jws: string): Promise<JWSTransactionDecodedPayload>; notification(payload: string): Promise<any>; renewal(jws: string): Promise<any> };

/** Production first; the sandbox only when STUDIO_APPLE_SANDBOX is on (TestFlight and review use the sandbox). */
export function makeVerifier(env: Record<string, string | undefined>): Verifier | null {
  const dir = env.STUDIO_APPLE_ROOT_CERTS_DIR || "certs/apple";
  let roots: Buffer[] = [];
  try { roots = readdirSync(dir).filter((f) => /\.(cer|der)$/i.test(f)).map((f) => readFileSync(join(dir, f))); } catch { roots = []; }
  if (!roots.length) return null;
  const prod = new SignedDataVerifier(roots, true, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID);
  const sandbox = /^(1|on|true|yes)$/i.test(String(env.STUDIO_APPLE_SANDBOX ?? "")) ? new SignedDataVerifier(roots, true, Environment.SANDBOX, BUNDLE_ID) : null;
  const both = async <T>(f: (v: SignedDataVerifier) => Promise<T>): Promise<T> => {
    try { return await f(prod); } catch (e) { if (!sandbox) throw e; return f(sandbox); }
  };
  return { transaction: (jws) => both((v) => v.verifyAndDecodeTransaction(jws)), notification: (p) => both((v) => v.verifyAndDecodeNotification(p)), renewal: (jws) => both((v) => v.verifyAndDecodeRenewalInfo(jws)) };
}

const iso = (ms: number | undefined | null) => (ms ? new Date(Number(ms)).toISOString() : null);

/** Who a transaction belongs to: the account id it was bought with, else the account that holds its original id. */
export async function ownerOf(sb: SupabaseClient, tx: Pick<JWSTransactionDecodedPayload, "appAccountToken" | "originalTransactionId">): Promise<string | null> {
  if (tx.appAccountToken && UUID_RE.test(tx.appAccountToken)) return tx.appAccountToken.toLowerCase();
  if (!tx.originalTransactionId) return null;
  const r = await sb.from("studio_customers").select("user_id").eq("apple_original_transaction_id", tx.originalTransactionId).maybeSingle();
  if (r.error) throw r.error;
  return (r.data as any)?.user_id ?? null;
}

export type Applied = { user: string; plan?: string | null; credits?: number; note: string };

/**
 * Applies one verified transaction for `user`. Idempotent: grants are unique by reference, the plan row is overwritten
 * with the same values. `renewal` says whether the credits replace the last period's (a new or renewed period).
 */
export async function applyAppleTransaction(sb: SupabaseClient, user: string, tx: JWSTransactionDecodedPayload, opts: { autoRenew?: boolean | null } = {}): Promise<Applied> {
  const kind = APPLE_PRODUCTS[String(tx.productId)];
  if (!kind) return { user, note: `unknown product ${tx.productId}` };
  const txid = String(tx.transactionId);

  // a refunded or revoked purchase: take back what it gave, end the plan if it was the plan
  if (tx.revocationDate) return revoke(sb, user, tx);

  if ("pack" in kind) {
    const pack = packById(kind.pack);
    if (!pack) return { user, note: `unknown pack ${kind.pack}` };
    const g = await sb.rpc("studio_grant", { p_user: user, p_credits: pack.credits, p_ref: `apple_${txid}`, p_expire_previous: false, p_note: `${pack.name} pack (Apple)` });
    if (g.error) throw g.error;
    return { user, credits: pack.credits, note: `pack ${g.data?.granted ? "granted" : "already granted"} ${pack.credits}` };
  }

  const plan = planById(kind.plan);
  if (!plan) return { user, note: `unknown plan ${kind.plan}` };
  const expires = Number(tx.expiresDate ?? 0);
  const active = expires > Date.now();
  // a person holds one plan: a live website (Stripe) subscription is never doubled by an Apple one
  const cur = await sb.from("studio_customers").select("stripe_subscription_id,status,billing_source").eq("user_id", user).maybeSingle();
  if (cur.error) throw cur.error;
  const c = cur.data as any;
  if (c?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(c.status) && c.billing_source !== "apple") {
    console.error(`[apple] ALERT ${user} bought ${tx.productId} through Apple while a website plan is live (${c.stripe_subscription_id}); recorded, plan left as is`);
    return { user, note: "website plan already live; not applied" };
  }
  const link = await sb.from("studio_customers").upsert({ user_id: user, billing_source: "apple", apple_original_transaction_id: String(tx.originalTransactionId), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (link.error) throw link.error;
  const s = await sb.rpc("studio_apply_subscription", {
    p_user: user, p_customer: null, p_subscription: null, p_plan: plan.id, p_interval: kind.interval,
    p_status: active ? "active" : "canceled", p_period_start: iso(tx.purchaseDate), p_period_end: iso(expires),
    p_cancel_at_period_end: opts.autoRenew === false, p_credits_per_period: plan.credits, p_parallel: plan.parallel,
  });
  if (s.error) throw s.error;
  if (!active) return { user, plan: plan.id, note: `${plan.id} ${kind.interval} lapsed` };
  // each period's transaction grants that period's credits, replacing what was left of the last one (as Stripe's invoices do)
  const credits = plan.credits * (kind.interval === "year" ? 12 : 1);
  const g = await sb.rpc("studio_grant", { p_user: user, p_credits: credits, p_ref: `in_apple_${txid}`, p_expire_previous: true, p_note: `${plan.name} ${kind.interval === "year" ? "annual " : ""}Apple period` });
  if (g.error) throw g.error;
  return { user, plan: plan.id, credits, note: `${plan.id} ${kind.interval} ${g.data?.granted ? "granted" : "already granted"} ${credits}` };
}

/** A refund or revocation: the credits that purchase granted come back off the balance (never below zero). */
async function revoke(sb: SupabaseClient, user: string, tx: JWSTransactionDecodedPayload): Promise<Applied> {
  const txid = String(tx.transactionId), ref = `apple_refund_${txid}`;
  const seen = await sb.from("studio_credit_ledger").select("id").eq("user_id", user).eq("reason", "adjust").eq("ref", ref).limit(1);
  if (seen.error) throw seen.error;
  const kind = APPLE_PRODUCTS[String(tx.productId)];
  if (kind && "plan" in kind) {
    const ended = await sb.from("studio_customers").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("user_id", user).eq("apple_original_transaction_id", String(tx.originalTransactionId));
    if (ended.error) throw ended.error;
  }
  if ((seen.data ?? []).length) return { user, note: "refund already taken back" };
  const given = await sb.from("studio_credit_ledger").select("delta").eq("user_id", user).eq("reason", "grant").in("ref", [`apple_${txid}`, `in_apple_${txid}`]);
  if (given.error) throw given.error;
  const granted = (given.data ?? []).reduce((a: number, r: any) => a + Number(r.delta ?? 0), 0);
  const bal = await sb.rpc("studio_balance", { p_user: user });
  if (bal.error) throw bal.error;
  const take = Math.min(granted, Math.max(0, Number(bal.data ?? 0)));
  if (take > 0) {
    const w = await sb.from("studio_credit_ledger").insert({ user_id: user, delta: -take, reason: "adjust", ref, note: `Apple refund of ${tx.productId}` });
    if (w.error) throw w.error;
  }
  console.error(`[apple] refund ${user} ${tx.productId} ${txid}: took back ${take} of ${granted}`);
  return { user, credits: -take, note: `refund took back ${take}` };
}

type Deps = { sbFn: () => SupabaseClient; env: Record<string, string | undefined>; requireUser: (req: Request, res: Response) => string | null; fail: (res: Response, e: any) => void; log: (m: string) => void; verifier?: Verifier | null };

export function registerApple(app: Express, d: Deps): void {
  let verifier: Verifier | null | undefined = d.verifier;
  const ready = (res: Response): Verifier | null => {
    if (!iapEnabled(d.env)) { res.status(404).json({ error: "not_found" }); return null; }
    verifier ??= makeVerifier(d.env);
    if (!verifier) { res.status(503).json({ error: "apple_unconfigured", detail: "Apple's root certificates are not installed" }); return null; }
    return verifier;
  };

  // the app, right after a purchase or a restore
  app.post("/api/studio/apple/transaction", async (req, res) => {
    const u = d.requireUser(req, res); if (!u) return;
    const v = ready(res); if (!v) return;
    const jws = String(req.body?.jws ?? "");
    if (!jws || jws.length > 20_000) return res.status(400).json({ error: "bad_request" });
    let tx: JWSTransactionDecodedPayload;
    try { tx = await v.transaction(jws); }
    catch (e: any) { d.log(`[apple] transaction not verified for ${u}: ${String(e?.message ?? e).slice(0, 120)}`); return res.status(400).json({ error: "not_verified", detail: "Apple's signature did not check out" }); }
    try {
      const sb = d.sbFn();
      const owner = await ownerOf(sb, tx);
      // bought with another account's id (or held by another account): never moved here
      if (owner && owner !== u.toLowerCase()) return res.status(403).json({ error: "other_account", detail: "This purchase belongs to another Clone8 account." });
      const out = await applyAppleTransaction(sb, u, tx);
      d.log(`[apple] transaction ${JSON.stringify({ user: u, product: tx.productId, tx: tx.transactionId, env: tx.environment, outcome: out.note })}`);
      res.json({ plan: out.plan ?? null, credits: out.credits ?? null });
    } catch (e) { d.fail(res, e); }
  });

  // Apple's server notifications (v2). Stored first (studio_apple_events, unique by notification id), applied, marked.
  app.post("/api/studio/apple/notifications", async (req, res) => {
    const v = ready(res); if (!v) return;
    const payload = String(req.body?.signedPayload ?? "");
    if (!payload) return res.status(400).json({ error: "bad_request" });
    let n: any;
    try { n = await v.notification(payload); }
    catch (e: any) { d.log(`[apple] notification not verified: ${String(e?.message ?? e).slice(0, 120)}`); return res.status(400).json({ error: "not_verified" }); }
    const sb = d.sbFn();
    const id = String(n.notificationUUID ?? "");
    try {
      const ins = await sb.from("studio_apple_events").insert({ id, type: `${n.notificationType}${n.subtype ? `/${n.subtype}` : ""}`, payload: n }).select("id").maybeSingle();
      if (ins.error) {
        if (!/duplicate|unique|23505/i.test(ins.error.message ?? "")) throw ins.error;
        const seen = await sb.from("studio_apple_events").select("processed_at").eq("id", id).maybeSingle();
        if (seen.data?.processed_at) return res.json({ received: true, duplicate: true });
      }
      let outcome = "ignored";
      const signedTx = n.data?.signedTransactionInfo;
      if (n.notificationType === "TEST") outcome = "test";
      else if (signedTx) {
        const tx = await v.transaction(signedTx);
        const renewal = n.data?.signedRenewalInfo ? await v.renewal(n.data.signedRenewalInfo).catch(() => null) : null;
        const user = await ownerOf(sb, tx);
        if (!user) outcome = `no account for ${tx.originalTransactionId}`;
        else {
          // auto-renew turned off: the plan runs to its end, then lapses (Apple sends EXPIRED then)
          const autoRenew = n.notificationType === "DID_CHANGE_RENEWAL_STATUS" ? n.subtype === "AUTO_RENEW_ENABLED" : renewal?.autoRenewStatus === undefined ? null : renewal.autoRenewStatus === 1;
          try { outcome = (await applyAppleTransaction(sb, user, tx, { autoRenew })).note; }
          catch (e: any) {
            // the account was deleted in the app; Apple keeps billing until the person cancels, and nothing is left to update
            if (/foreign key|23503/i.test(String(e?.message ?? e?.code ?? ""))) outcome = `account ${user} deleted; nothing applied`; else throw e;
          }
        }
      }
      await sb.from("studio_apple_events").update({ processed_at: new Date().toISOString(), error: null }).eq("id", id);
      d.log(`[apple] notification ${n.notificationType}${n.subtype ? `/${n.subtype}` : ""}: ${outcome}`);
      res.json({ received: true });
    } catch (e: any) {
      await sb.from("studio_apple_events").update({ error: String(e?.message ?? e).slice(0, 300) }).eq("id", id);
      console.error("[apple] notification", n?.notificationType, String(e?.message ?? e));
      res.status(500).json({ error: "notification_failed" }); // Apple retries
    }
  });
}
