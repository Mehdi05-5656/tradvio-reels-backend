// One-shot analytics tick, invoked by Render Cron every 15 minutes.
import { createClient } from "@supabase/supabase-js";
import { analyticsTick } from "./publer-schedule.js";
import { configurePublerRate } from "./publer-rate.js";
import { collectLiveMetrics } from "./live-metrics.js";
import { expireHeldWindows } from "./publish-reconcile.js";
import { learningTick } from "./client-learning.js";
import { purgeTick } from "./library-archive.js";
import { evaluateAlerts } from "./v2-routes.js";

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
  // Per-client learning: the database scores each client's own posts at most once an hour. Never blocks analytics.
  try {
    console.log("[cron:learning]", JSON.stringify(await learningTick(sb)));
  } catch (e: any) {
    console.error("[cron:learning] failed:", e?.message || e);
  }
  // Storage stewardship: archive and remove rendered files whose post is done (off until purge_enabled).
  try {
    const r = await purgeTick(sb, { limit: 40 });
    console.log("[cron:archive]", JSON.stringify({ ...r, failed: r.failed.length }));
  } catch (e: any) {
    console.error("[cron:archive] failed:", e?.message || e);
  }
  // Alerts: nothing else runs the evaluator on a schedule (dist/alert-tick.cjs exists but no Render job calls it), so the
  // viral, underperformer, cron-health, queue-runway and Studio rules fire from here, every 15 minutes, deduped by the rules.
  try {
    const r = await evaluateAlerts(sb);
    console.log("[cron:alerts]", JSON.stringify({ fired: r.fired, types: (r.alerts ?? []).map((a: any) => a.type) }));
  } catch (e: any) {
    console.error("[cron:alerts] failed:", e?.message || e);
  }
}

main().catch((e) => {
  console.error("[cron:analytics] failed:", e);
  process.exit(1);
});
