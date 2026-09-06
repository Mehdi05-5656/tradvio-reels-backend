// Alert evaluator tick — runs on cron alongside analytics.
// Fires alerts into reels_alerts table when thresholds cross.

import { createClient } from "@supabase/supabase-js";
import { evaluateAlerts } from "./v2-routes.js";
import WebSocket from "ws";
if (typeof (globalThis as any).WebSocket === "undefined")
  (globalThis as any).WebSocket = WebSocket;

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[alert-tick] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 0 } },
  });
  try {
    const result = await evaluateAlerts(sb);
    console.log(`[alert-tick] fired ${result.fired} alerts`);
    if (result.fired > 0) {
      console.log(JSON.stringify(result.alerts, null, 2));
    }
    process.exit(0);
  } catch (e: any) {
    console.error("[alert-tick] error:", e.message);
    process.exit(1);
  }
}

main();
