// Shared Supabase service-role client. Extracted from routes.ts so auth
// middleware and route handlers can both import the same singleton.
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// Node 20 lacks native WebSocket; supabase-js Realtime requires one at import time.
// @ts-ignore - polyfilling a global for supabase-js internals
if (typeof (globalThis as any).WebSocket === "undefined") (globalThis as any).WebSocket = WebSocket;

let sb: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!sb) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    });
  }
  return sb;
}
