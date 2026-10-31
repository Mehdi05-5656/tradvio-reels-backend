// Who may open the Studio admin panel: the owner's Studio account only (support@clone8.io, owner's decision Oct 31
// 2026), never the operator console's admins and never anyone else. STUDIO_ADMIN_EMAILS overrides the list (comma
// separated). The email in the signed sign-in token must match, and the account's email must be confirmed: checked
// with Supabase's admin API and remembered for ten minutes.
import type { Request } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_ADMIN_EMAILS = ["support@clone8.io"];
export function adminEmails(env: Record<string, string | undefined> = process.env): string[] {
  const list = (env.STUDIO_ADMIN_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_ADMIN_EMAILS;
}

/** Our own accounts (the owner's, the test accounts): left out of the admin panel's numbers unless asked. */
export function isInternalEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const e = String(email ?? "").toLowerCase();
  if (!e) return false;
  if (adminEmails(env).includes(e)) return true;
  const extra = (env.STUDIO_INTERNAL_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(e)) return true;
  return /@(tradvio\.com|clone8\.io)$/.test(e);
}

const cache = new Map<string, { ok: boolean; at: number }>();
const TTL = 10 * 60_000;
export function clearAdminCacheForTests() { cache.clear(); }

export async function isStudioAdmin(req: Request, sb: SupabaseClient, env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<boolean> {
  const a = req.auth as any;
  const user = typeof a?.user_id === "string" ? a.user_id : null;
  const claimed = typeof a?.email === "string" ? a.email.toLowerCase() : "";
  if (!user || !claimed || !adminEmails(env).includes(claimed)) return false;
  const hit = cache.get(user);
  if (hit && now - hit.at < TTL) return hit.ok;
  let ok = false;
  try {
    const r = await (sb as any).auth.admin.getUserById(user);
    const u = r?.data?.user;
    ok = !!u && String(u.email ?? "").toLowerCase() === claimed && !!u.email_confirmed_at;
  } catch { ok = false; }
  cache.set(user, { ok, at: now });
  return ok;
}
