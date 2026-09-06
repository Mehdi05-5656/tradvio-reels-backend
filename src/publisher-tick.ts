// One-shot publisher tick, invoked by Render Cron every 5 minutes.
import { createClient } from "@supabase/supabase-js";
import { publisherTick } from "./publer-schedule.js";

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    },
  );
  const result = await publisherTick(sb);
  console.log("[cron:publisher] ok", JSON.stringify(result));
}

main().catch((e) => {
  console.error("[cron:publisher] failed:", e);
  process.exit(1);
});
