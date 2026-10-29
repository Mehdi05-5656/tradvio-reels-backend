import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";

// POSTs that carry their own credential instead of a session: HMAC-signed webhooks (CreatorVault), Stripe's
// signed webhook, and the rate-limited public forms of clone8.io (invite requests, funnel counters). The access
// boundary below and the mutation guard in routes.ts both consult this one list, so a route exempted from one
// can never be blocked by the other (both Stripe and the funnel endpoint were 401'd that way in production).
export function selfAuthenticatedPost(path: string, method: string): boolean {
  if (method !== "POST") return false;
  const p = path.replace(/\/+$/, "");
  return p === "/api/creatorvault/webhook" || p === "/api/public/invite-requests" || p === "/api/public/funnel-events" || p === "/api/studio/stripe/webhook";
}

// Default-deny legacy/global routes. Ownership is checked on the server, never
// inferred from a client-supplied role, external user id, or slot name.
export function accountAccess(sbFn: () => SupabaseClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = req.path.replace(/\/+$/, "");
    if (!path.startsWith("/api/") || req.method === "OPTIONS") return next();
    if (path === "/api/bootstrap" && ["GET", "HEAD"].includes(req.method)) return next();
    if (selfAuthenticatedPost(path, req.method)) return next();
    // Public site: aggregate case-study numbers. No account data (the public POST forms are in the list above).
    if (path === "/api/public/case-study" && ["GET", "HEAD"].includes(req.method)) return next();
    // Invite preview: the single-use token in the path is the credential; the handler reveals only the
    // organization name and whether the link is still valid.
    if (/^\/api\/invites\/[^/]+$/.test(path) && ["GET", "HEAD"].includes(req.method)) return next();
    // The plan catalog is public; it carries no account data.
    if (path === "/api/studio/plans" && ["GET", "HEAD"].includes(req.method)) return next();
    // So is the instrument catalog: the models on offer, their settings and price hints, nothing per person.
    if (path === "/api/studio/instruments" && ["GET", "HEAD"].includes(req.method)) return next();
    if (!req.auth) return res.status(401).json({ error: "unauthorized" });
    // Clone8 Studio: every route acts on the signed-in person's own plan, credits, uploads and jobs.
    // The handlers scope each query to that person; the database functions do the same.
    if (path.startsWith("/api/studio/") && "user_id" in req.auth && req.profile) return next();
    const read = ["GET", "HEAD"].includes(req.method);
    // All application mutations require the selected human operator. An admin
    // viewing role or the legacy shared secret must not grant write authority.
    // Scheduled workers call their services directly; machine HTTP mutations
    // require a separate, narrowly scoped design, not an implicit exception here.
    if (!read) {
      if (isOperator(req)) return next();
      // The one client-side write: joining an organization with an invite link. The handler binds the
      // membership to the signed-in user and the database function checks the token.
      if (/^\/api\/invites\/[^/]+\/accept$/.test(path) && "user_id" in req.auth) return next();
      return res.status(403).json({ error: "operator_required" });
    }
    if (isAdmin(req)) return next();
    if (!req.profile || !("user_id" in req.auth)) return res.status(403).json({ error: "profile_required" });

    // Fully managed service: a customer's ownership grants visibility only.
    // Never permit pause/resume, schedule changes, uploads, direct OAuth,
    // onboarding retries or publishing through a client-owned resource.
    // Public auth and signature-verified webhooks are handled above/outside /api.
    // These handlers apply their own per-user filters. All other global v2
    // control, leader and suggestion routes remain administrator-only.
    if (read && /^\/api\/v2\/accounts\/[^/]+\/history$/.test(path)) return next();
    if (read && path === "/api/v2/report") return next(); // Handler scopes every read to visible publishing slots.
    if (read && /^\/api\/(?:me|managed\/accounts|managed\/(?:generation|handoffs)\/[^/]+|v2\/(?:accounts|devices|overview|alerts|archive|today|hashtags|templates)|v2\/analytics\/[^/]+|v2\/post\/.+|creatorvault\/(?:accounts|account-status)|onboard\/status|reels\/scheduled(?:\/[^/]+)?)$/.test(path)) return next();
    try {
      let slot: string | null = null;
      const slotMatch = path.match(/^\/api\/(?:next|queue|publer\/timeline|publer\/analytics)\/([^/]+)$/);
      if (slotMatch) slot = decodeURIComponent(slotMatch[1]);
      const signedMatch = read ? path.match(/^\/api\/signed\/([^/]+)$/) : null;
      if (signedMatch) {
        const r = await sbFn().from("reels_manual_queue").select("phone_slot").eq("id", decodeURIComponent(signedMatch[1])).maybeSingle();
        if (r.error) throw r.error;
        slot = r.data?.phone_slot ?? null;
      }
      if (slot) {
        const r = await sbFn().from("publer_slot_config").select("owner_user_id").eq("phone_slot", slot).maybeSingle();
        if (r.error) throw r.error;
        if (r.data?.owner_user_id === req.auth.user_id || req.orgSlots?.has(slot)) return next();
      }
      return res.status(403).json({ error: "forbidden" });
    } catch {
      return res.status(503).json({ error: "access_check_unavailable" });
    }
  };
}
