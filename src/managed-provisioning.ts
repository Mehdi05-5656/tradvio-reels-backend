import type { SupabaseClient } from "@supabase/supabase-js";

export function managedEnabled(): boolean {
  return process.env.MANAGED_PROVISIONING_ENABLED === "1";
}

// This stage only prepares durable records. It never generates, schedules or
// publishes media. The SQL RPC fails closed at the unimplemented renderer gate.
export async function provisionManagedAccounts(sb: SupabaseClient, enabled = managedEnabled()) {
  if (!enabled) return { enabled: false, processed: 0 };
  const r = await sb.rpc("managed_provision_pending", { p_limit: 5 });
  if (r.error) throw new Error("managed_provisioning_unavailable");
  if (!Number.isInteger(r.data) || r.data < 0 || r.data > 5) throw new Error("invalid_provisioning_result");
  return { enabled: true, processed: r.data as number };
}

export function startManagedProvisioningWorker(sbFn: () => SupabaseClient): () => void {
  if (!managedEnabled()) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await provisionManagedAccounts(sbFn()); }
    catch { console.error("[managed/provisioning] recovery sweep unavailable"); }
    finally { running = false; }
  };
  // Restart recovery plus bounded periodic sweeps. Database locks make multiple
  // web replicas safe; network/provider work never occurs inside this stage.
  void tick();
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
