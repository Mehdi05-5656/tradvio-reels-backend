// WO-A: Auth middleware for the Tradvio Reels backend.
// Supports two auth modes simultaneously:
//   - Legacy admin: x-app-secret header == process.env.APP_WRITE_SECRET
//   - End user:    Authorization: Bearer <supabase-jwt>, verified via JWKS
//
// Attaches:
//   req.auth = null | { admin_secret: true } | { user_id, email }
//   req.profile = null | { user_id, external_user_id, role, email, display_name }
//
// Route handlers pick their own policy from req.auth / req.profile.

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { supabase } from "./supabase.js";

// --- Types shared with route handlers -----------------------------------------
export type AuthCtx =
  | null
  | { admin_secret: true }
  | { user_id: string; email?: string };

export type ProfileCtx = null | {
  user_id: string;
  external_user_id: string;
  role: "admin" | "user";
  email: string | null;
  display_name: string | null;
};

// Extend Express Request without adding a package-wide .d.ts file.
declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthCtx;
    profile?: ProfileCtx;
  }
}

// --- JWKS setup ---------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const JWKS_URL = SUPABASE_URL
  ? new URL(`${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`)
  : null;
const jwks = JWKS_URL ? createRemoteJWKSet(JWKS_URL) : null;

async function verifySupabaseJwt(token: string): Promise<{ sub: string; email?: string } | null> {
  if (!jwks) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      // Supabase-issued JWTs use "authenticated" as the aud for logged-in users
      audience: "authenticated",
    });
    if (!payload.sub) return null;
    return { sub: String(payload.sub), email: (payload as any).email };
  } catch {
    return null;
  }
}

// --- Middleware ---------------------------------------------------------------
export async function resolveAuth(req: Request, _res: Response, next: NextFunction) {
  req.auth = null;
  req.profile = null;

  const secret = process.env.APP_WRITE_SECRET || "";
  const providedSecret = req.header("x-app-secret") || "";
  if (secret && providedSecret === secret) {
    req.auth = { admin_secret: true };
    return next();
  }

  const authHeader = req.header("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const claims = await verifySupabaseJwt(token);
    if (claims) {
      req.auth = { user_id: claims.sub, email: claims.email };
      // Hydrate profile.
      try {
        const { data, error } = await supabase()
          .from("profiles")
          .select("user_id, external_user_id, role, email, display_name")
          .eq("user_id", claims.sub)
          .maybeSingle();
        if (!error && data) {
          req.profile = data as ProfileCtx;
        }
      } catch {
        // fall through with req.profile = null
      }
      return next();
    }
  }

  return next();
}

// Convenience helpers used by handlers ---------------------------------------
export function isAdmin(req: Request): boolean {
  if (!req.auth) return false;
  if ("admin_secret" in req.auth && req.auth.admin_secret) return true;
  return req.profile?.role === "admin";
}

/**
 * Decide which external_user_id a route should query for.
 * Rules:
 *  - Admin (x-app-secret OR profile.role='admin'): honor query/body value; if omitted, null.
 *  - Regular user: forced to their own external_user_id; query/body ignored.
 *  - Unauthenticated: honor query/body value (legacy behavior for public GETs).
 */
export function resolveExternalUserId(req: Request, requested: string | null): string | null {
  if (isAdmin(req)) return requested;
  if (req.profile?.external_user_id) return req.profile.external_user_id;
  return requested; // unauth: legacy path
}

/**
 * Filter a list of slots to those the current requester is allowed to see.
 *
 *  - Admin (x-app-secret OR profile.role='admin'): sees ALL slots.
 *  - Authenticated user: sees only slots whose owner_user_id matches req.auth.user_id.
 *  - Unauthenticated: sees NONE. This is a deliberate break from the legacy public-GET
 *    behavior. Slot data is user-scoped; the only unauthenticated caller left is the
 *    background cron, which uses the x-app-secret admin path.
 */
export function filterVisibleSlots<T extends { owner_user_id: string | null }>(
  req: Request,
  slots: T[],
): T[] {
  if (isAdmin(req)) return slots;
  if (req.auth && "user_id" in req.auth) {
    const uid = req.auth.user_id;
    return slots.filter((s) => s.owner_user_id === uid);
  }
  return [];
}

/**
 * Reject the request if the specific phone_slot isn't in the requester's visible set.
 * Returns true when the caller should stop; the response has already been sent.
 */
export function assertCanReadSlot<T extends { phone_slot: string; owner_user_id: string | null }>(
  req: Request,
  res: Response,
  slots: T[],
  phone: string,
): boolean {
  const slot = slots.find((s) => s.phone_slot === phone);
  if (!slot) {
    res.status(404).json({ error: "slot not found" });
    return true;
  }
  const visible = filterVisibleSlots(req, [slot]);
  if (visible.length === 0) {
    res.status(403).json({ error: "forbidden" });
    return true;
  }
  return false;
}
