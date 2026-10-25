// One-shot analytics tick, invoked by Render Cron every 15 minutes.
import { createClient } from "@supabase/supabase-js";
import { analyticsTick } from "./publer-schedule.js";
import { configurePublerRate } from "./publer-rate.js";
import { collectLiveMetrics } from "./live-metrics.js";
import { expireHeldWindows } from "./publish-reconcile.js";

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    },
  );
  // Live public metrics (ScrapeCreators) run first and independently: they never use Publer's
  // request budget, so they also run during posting windows. A failure here never blocks Publer.
  try {
    console.log("[cron:live-metrics]", JSON.stringify(await collectLiveMetrics(sb)));
  } catch (e: any) {
    console.error("[cron:live-metrics] failed:", e?.message || e);
  }
  // Windows held before any submission and still pending after a day are closed out from saved data (no Publer calls).
  try {
    console.log("[cron:expire-held]", JSON.stringify(await expireHeldWindows(sb)));
  } catch (e: any) {
    console.error("[cron:expire-held] failed:", e?.message || e);
  }
  configurePublerRate(sb, "analytics");
  const result = await analyticsTick(sb);
  console.log("[cron:analytics] ok", JSON.stringify(result));
}

main().catch((e) => {
  console.error("[cron:analytics] failed:", e);
  process.exit(1);
});
