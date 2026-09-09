/**
 * Sprint 3.3 — Background ingestion worker.
 *
 * Runs inside the main backend process. Polls `ingestion_jobs` every 30s
 * for pending jobs, claims one atomically (SKIP LOCKED via
 * claim_next_ingestion_job RPC), then runs the historical video mirror
 * for that CreatorVault account.
 *
 * Progress state lives on creatorvault_accounts.{ingestion_status,
 * posts_processed, posts_total, ingestion_eta_seconds}. Dashboard polls
 * that via GET /api/onboard/status.
 *
 * On success: flips ingestion_status='complete', fires notification
 * (best-effort log), and (if a paired reels_devices slot exists for the
 * same platform_handle) leaves the scheduler alone — flipping active
 * is a separate admin action so a mis-connected account can't get
 * silently promoted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { syncVideosForAccount } from "./creatorvault.js";

const POLL_INTERVAL_MS = Number(process.env.INGESTION_POLL_MS ?? 30_000);
const WORKER_ID = process.env.RENDER_INSTANCE_ID ?? `local-${process.pid}`;
const MAX_ATTEMPTS = 3;

let running = false;
let stopped = false;

async function claimJob(sb: SupabaseClient) {
  const { data, error } = await sb.rpc("claim_next_ingestion_job", { worker_id: WORKER_ID });
  if (error) throw error;
  return (data as any[] | null)?.[0] ?? null;
}

async function markAccount(
  sb: SupabaseClient,
  cvAccountId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await sb
    .from("creatorvault_accounts")
    .update(patch)
    .eq("cv_account_id", cvAccountId);
  if (error) console.warn("[ingestion-worker] markAccount failed:", error.message);
}

async function markJob(
  sb: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await sb
    .from("ingestion_jobs")
    .update(patch)
    .eq("id", jobId);
  if (error) console.warn("[ingestion-worker] markJob failed:", error.message);
}

async function processOne(sb: SupabaseClient): Promise<boolean> {
  const job = await claimJob(sb);
  if (!job) return false;

  const jobId: string = job.job_id;
  const cvAccountId: string = job.cv_account_id;
  const attempts: number = job.attempts;
  const startedAt = new Date();

  console.log(
    `[ingestion-worker] claimed job=${jobId} account=${cvAccountId} attempt=${attempts}`,
  );

  await markJob(sb, jobId, {
    status: "processing",
    started_at: startedAt.toISOString(),
  });
  await markAccount(sb, cvAccountId, {
    ingestion_status: "processing",
    ingestion_started_at: startedAt.toISOString(),
    ingestion_error: null,
    posts_processed: 0,
    posts_total: null,
    ingestion_eta_seconds: null,
  });

  try {
    // syncVideosForAccount pages internally (50/page, up to 1000 videos).
    // For MVP we run it as one blocking call; a future revision can wrap
    // it in a per-page loop that updates posts_processed after each page.
    const { mirrored } = await syncVideosForAccount(sb, cvAccountId, {
      limit: job.page_limit ?? 50,
      since: job.since_cursor ?? undefined,
    });

    const completedAt = new Date();
    const elapsedSec = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);

    await markJob(sb, jobId, {
      status: "complete",
      completed_at: completedAt.toISOString(),
      posts_mirrored: mirrored,
    });
    await markAccount(sb, cvAccountId, {
      ingestion_status: "complete",
      ingestion_completed_at: completedAt.toISOString(),
      posts_processed: mirrored,
      posts_total: mirrored,
      ingestion_eta_seconds: 0,
      last_synced_at: completedAt.toISOString(),
    });

    console.log(
      `[ingestion-worker] complete job=${jobId} account=${cvAccountId} mirrored=${mirrored} elapsed=${elapsedSec}s`,
    );
    return true;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`[ingestion-worker] failed job=${jobId} account=${cvAccountId}:`, msg);

    const willRetry = attempts < MAX_ATTEMPTS;
    await markJob(sb, jobId, {
      status: willRetry ? "pending" : "failed",
      last_error: msg,
      claimed_by: null,
      claimed_at: null,
    });
    await markAccount(sb, cvAccountId, {
      ingestion_status: willRetry ? "pending" : "failed",
      ingestion_error: msg,
    });
    return true;
  }
}

async function tick(sbFn: () => SupabaseClient) {
  if (running || stopped) return;
  running = true;
  try {
    // Drain up to 3 jobs per tick so a burst of new connects doesn't
    // wait a full polling interval each.
    for (let i = 0; i < 3; i++) {
      const worked = await processOne(sbFn());
      if (!worked) break;
    }
  } catch (e: any) {
    console.warn("[ingestion-worker] tick error:", e?.message ?? e);
  } finally {
    running = false;
  }
}

export function startIngestionWorker(sbFn: () => SupabaseClient) {
  if (process.env.INGESTION_WORKER_DISABLED === "1") {
    console.log("[ingestion-worker] disabled via env");
    return () => {};
  }
  console.log(
    `[ingestion-worker] started worker=${WORKER_ID} poll=${POLL_INTERVAL_MS}ms`,
  );
  // Run one tick immediately so restarts don't wait a full interval.
  void tick(sbFn);
  const handle = setInterval(() => void tick(sbFn), POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Public helper — enqueue an ingestion job for an account.
 * Called from the CreatorVault webhook on `account.connected`.
 * Idempotent: the unique partial index blocks duplicates while a
 * pending/claimed/processing job already exists for the same account.
 */
export async function enqueueIngestionJob(
  sb: SupabaseClient,
  cvAccountId: string,
  opts: { since?: string; page_limit?: number } = {},
): Promise<{ enqueued: boolean; reason?: string }> {
  const row: Record<string, unknown> = { cv_account_id: cvAccountId };
  if (opts.since) row.since_cursor = opts.since;
  if (opts.page_limit) row.page_limit = opts.page_limit;

  const { error } = await sb.from("ingestion_jobs").insert(row);
  if (error) {
    // 23505 = unique_violation from ingestion_jobs_one_active_per_account
    if ((error as any).code === "23505") {
      return { enqueued: false, reason: "already_active" };
    }
    console.warn("[ingestion-worker] enqueue failed:", error.message);
    return { enqueued: false, reason: error.message };
  }
  // Reset any prior 'failed'/'skipped' status on the account so the
  // dashboard sees the new run immediately.
  await sb
    .from("creatorvault_accounts")
    .update({ ingestion_status: "pending", ingestion_error: null })
    .eq("cv_account_id", cvAccountId);
  return { enqueued: true };
}
