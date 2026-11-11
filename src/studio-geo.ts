// Which country a person is in, for the admin panel's People list. Render's edge (Cloudflare) names the visitor's
// country on every request in the CF-IPCountry header; we keep the two-letter code on the person's studio_customers
// row (migrations/20261114000000_studio_customer_country.sql) the first time we see it and when it changes. No IP
// address is stored. Never throws and never slows a request: before the migration the write fails once, quietly.
import type { SupabaseClient } from "@supabase/supabase-js";

/** The two-letter country of a request, or null (unknown "XX", Tor "T1", or no header at all, as on a laptop). */
export function countryFromRequest(req: { headers: Record<string, unknown> }): string | null {
  for (const h of ["cf-ipcountry", "x-vercel-ip-country"]) {
    const v = String(req.headers?.[h] ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== "XX") return v;
  }
  return null;
}

const seen = new Map<string, string>();
let warned = false;
export function resetGeoForTests() { seen.clear(); warned = false; }

/** Keep the person's country if this server has not already written the same one. Fire and forget. */
export function noteCountry(sb: SupabaseClient, userId: string, req: { headers: Record<string, unknown> }): Promise<boolean> {
  const cc = countryFromRequest(req);
  if (!cc || seen.get(userId) === cc) return Promise.resolve(false);
  if (seen.size > 20_000) seen.clear();
  // an update, never an insert: someone with no Studio row yet gets their country once the row exists
  return Promise.resolve(sb.from("studio_customers").update({ country: cc, country_at: new Date().toISOString() }).eq("user_id", userId).select("user_id"))
    .then((r: any) => {
      if (r?.error) throw r.error;
      if ((r?.data ?? []).length) { seen.set(userId, cc); return true; }
      return false;
    })
    .catch((e: any) => { if (!warned) { warned = true; console.log(`[geo] country not kept (${String(e?.message ?? e).slice(0, 120)}); further failures are silent`); } return false; });
}
