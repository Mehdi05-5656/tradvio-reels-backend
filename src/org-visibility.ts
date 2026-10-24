// Accounts a signed-in person may see through client organizations (see
// migrations/20261024100000_client_orgs_invites.sql). Kept free of auth imports so auth.ts can use it.
import type { SupabaseClient } from "@supabase/supabase-js";

let warned = false;
/** Slots granted through organization membership. Empty when the person has none or the tables are not installed yet. */
export async function loadOrgSlots(sb: SupabaseClient, userId: string): Promise<Set<string>> {
  try {
    const r = await sb.from("client_visible_accounts").select("phone_slot").eq("user_id", userId);
    if (r.error) throw r.error;
    return new Set((r.data ?? []).map((x: any) => String(x.phone_slot)));
  } catch (e: any) {
    if (!warned) { warned = true; console.warn("[auth] organization visibility unavailable:", e?.message ?? e); }
    return new Set();
  }
}
