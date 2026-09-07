// Reconciliation cron for WO-05 CV bridge scheduled reels.
//
// Every 15 minutes on Render Cron. Safety net for missed webhooks:
//   1. Find scheduled_reels rows in submitted/pending/container_created/container_ready
//      whose updated_at > 30 min ago.
//   2. Group by external_user_id and page through GET /v1/bridge/reels for each.
//   3. Reconcile local status/ig_media_id/permalink/failure fields to CV's
//      authoritative row.
//
// In CV_STUB_MODE=1 (default until CV ships), this reads from the same
// in-memory stub. Safe to run — no-op if nothing to reconcile.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cvBridge, type ReelStatus } from "./cv-bridge-client.js";

const IN_FLIGHT = ["submitted", "pending", "container_created", "container_ready"] as const;
const STALE_MIN = 30;

export async function reelsReconcileTick(sb: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_MIN * 60 * 1000).toISOString();
  const { data: stale, error } = await sb
    .from("scheduled_reels")
    .select("id, cv_reel_id, external_user_id, status")
    .in("status", IN_FLIGHT as unknown as string[])
    .lt("updated_at", cutoff)
    .not("cv_reel_id", "is", null);
  if (error) throw error;
  if (!stale || stale.length === 0) {
    return { checked: 0, reconciled: 0, missing: 0 };
  }

  // Group by external_user_id so we minimize CV calls.
  const byUser = new Map<string, string[]>();
  const idByCvId = new Map<string, string>();
  for (const row of stale) {
    if (!row.cv_reel_id) continue;
    idByCvId.set(row.cv_reel_id, row.id);
    const arr = byUser.get(row.external_user_id) ?? [];
    arr.push(row.cv_reel_id);
    byUser.set(row.external_user_id, arr);
  }

  let reconciled = 0;
  let missing = 0;

  for (const [extUid, cvIds] of byUser) {
    let cursor: string | null | undefined = undefined;
    const seen = new Set<string>();
    // Page through in-flight reels for this user.
    while (true) {
      const listArgs: {
        external_user_id: string;
        status: string;
        limit: number;
        cursor?: string;
      } = {
        external_user_id: extUid,
        status: IN_FLIGHT.join(",") + ",published,failed,cancelled",
        limit: 100,
      };
      if (cursor) listArgs.cursor = cursor;
      let page: { items: ReelStatus[]; next_cursor?: string | null };
      try {
        page = await cvBridge.listReels(listArgs);
      } catch (e: any) {
        console.warn("[cron:reels-reconcile] list failed", extUid, e.message);
        break;
      }
      for (const item of page.items) {
        seen.add(item.cv_reel_id);
        if (!idByCvId.has(item.cv_reel_id)) continue;

        const patch: Record<string, unknown> = { status: item.status };
        if (item.status === "published") {
          patch.ig_media_id = item.ig_media_id ?? null;
          patch.published_at = item.published_at ?? null;
        } else if (item.status === "failed") {
          patch.last_error = item.last_error ?? "unknown";
        }
        patch.attempts = item.attempts;

        const { error: uErr } = await sb
          .from("scheduled_reels")
          .update(patch)
          .eq("cv_reel_id", item.cv_reel_id);
        if (!uErr) reconciled++;
      }
      cursor = page.next_cursor ?? null;
      if (!cursor) break;
    }

    // Any local cv_reel_ids CV didn't return -> they've fallen out of the
    // in-flight window, log for follow-up.
    for (const cvId of cvIds) {
      if (!seen.has(cvId)) missing++;
    }
  }

  return { checked: stale.length, reconciled, missing };
}

// Standalone entrypoint for Render Cron.
if (import.meta.url === `file://${process.argv[1]}`) {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    },
  );
  reelsReconcileTick(sb)
    .then((r) => {
      console.log("[cron:reels-reconcile] ok", JSON.stringify(r));
    })
    .catch((e) => {
      console.error("[cron:reels-reconcile] failed:", e);
      process.exit(1);
    });
}
