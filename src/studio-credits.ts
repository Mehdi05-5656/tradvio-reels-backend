// Credit grants that need more than studio_grant: a yearly plan's credits, all at once, lasting until the end of the year
// paid for (owner, Nov 15 2026; migrations/20261122000200_studio_grant_until.sql). Every other batch of plan credits lasts
// 60 days (migrations/20261122000000_studio_credit_expiry.sql), which would take most of a year's credits away.
import type { SupabaseClient } from "@supabase/supabase-js";

/** A year's credits now, lasting until `until`. Falls back to a plain grant (the default 60 days) only if the database
 *  does not have studio_grant_until yet, so a yearly purchase never fails for want of it. */
export async function grantForYear(sb: SupabaseClient, a: { user: string; credits: number; ref: string; until: string | null; note: string }) {
  const r = await sb.rpc("studio_grant_until", { p_user: a.user, p_credits: a.credits, p_ref: a.ref, p_until: a.until, p_note: a.note });
  const missing = r.error && /studio_grant_until|PGRST202|42883/.test(`${(r.error as any).code ?? ""} ${r.error.message ?? ""}`);
  if (!missing) return r;
  console.error("[studio] studio_grant_until is not in the database yet: a plain grant instead");
  return sb.rpc("studio_grant", { p_user: a.user, p_credits: a.credits, p_ref: a.ref, p_expire_previous: true, p_note: a.note });
}
