// One-shot analytics tick, invoked by Render Cron every 15 minutes.
import { createClient } from "@supabase/supabase-js";
import { analyticsTick } from "./publer-schedule.js";

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    },
  );
  const result = await analyticsTick(sb);
  console.log("[cron:analytics] ok", JSON.stringify(result));
}

main().catch((e) => {
  console.error("[cron:analytics] failed:", e);
  process.exit(1);
});
