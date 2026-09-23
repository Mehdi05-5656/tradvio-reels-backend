import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin } from "./auth.js";

// Default-deny legacy/global routes. Ownership is checked on the server, never
// inferred from a client-supplied role, external user id, or slot name.
export function accountAccess(sbFn: () => SupabaseClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = req.path.replace(/\/+$/, "");
    if (!path.startsWith("/api/") || req.method === "OPTIONS") return next();
    if (path === "/api/bootstrap" && ["GET", "HEAD"].includes(req.method)) return next();
    if (path === "/api/creatorvault/webhook" && req.method === "POST") return next();
    if (!req.auth) return res.status(401).json({ error: "unauthorized" });
    if (isAdmin(req)) return next();
    if (!req.profile || !("user_id" in req.auth)) return res.status(403).json({ error: "profile_required" });

    const read = ["GET", "HEAD"].includes(req.method);
    // Fully managed service: a customer's ownership grants visibility only.
    // Never permit pause/resume, schedule changes, uploads, direct OAuth,
    // onboarding retries or publishing through a client-owned resource.
    // Public auth and signature-verified webhooks are handled above/outside /api.
    if (!read) return res.status(403).json({ error: "read_only_customer" });
    // These handlers apply their own per-user filters. All other global v2
    // control, leader and suggestion routes remain administrator-only.
    if (read && /^\/api\/(?:me|v2\/(?:accounts|devices|overview|alerts|archive|today|hashtags|templates)|v2\/analytics\/[^/]+|v2\/post\/.+|creatorvault\/(?:accounts|account-status)|onboard\/status|reels\/scheduled(?:\/[^/]+)?)$/.test(path)) return next();
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
        if (r.data?.owner_user_id === req.auth.user_id) return next();
      }
      return res.status(403).json({ error: "forbidden" });
    } catch {
      return res.status(503).json({ error: "access_check_unavailable" });
    }
  };
}
