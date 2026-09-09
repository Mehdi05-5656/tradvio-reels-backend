/**
 * Sprint 3.4 — Onboarding progress endpoints.
 *
 * GET  /api/onboard/status   — dashboard progress polling
 * POST /api/onboard/retry    — reset a failed job so worker picks it up again
 * POST /api/onboard/enqueue  — admin-only manual enqueue (smoke tests, backfill)
 */

import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueIngestionJob } from "./ingestion-worker.js";

export function registerOnboardingRoutes(app: Express, sbFn: () => SupabaseClient) {
  // -----------------------------------------------------------------
  // GET /api/onboard/status?cv_account_id=<uuid>
  // Returns { status, posts_processed, posts_total, eta_seconds,
  //           started_at?, completed_at?, error? }
  // -----------------------------------------------------------------
  app.get("/api/onboard/status", async (req: Request, res: Response) => {
    try {
      const cvAccountId =
        typeof req.query.cv_account_id === "string" ? req.query.cv_account_id : "";
      if (!cvAccountId) {
        return res.status(400).json({ error: "cv_account_id required" });
      }

      const isAdminSecret = !!(req.auth && "admin_secret" in req.auth && req.auth.admin_secret);
      const isAdminUser = req.profile?.role === "admin";
      const isUser = req.profile?.role === "user" && !!req.profile.external_user_id;
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const sb = sbFn();
      const { data: rowRaw, error } = await sb
        .from("creatorvault_accounts")
        .select(
          "external_user_id, platform, platform_handle, " +
            "ingestion_status, ingestion_started_at, ingestion_completed_at, " +
            "posts_processed, posts_total, ingestion_eta_seconds, ingestion_error",
        )
        .eq("cv_account_id", cvAccountId)
        .maybeSingle();
      if (error) throw error;
      if (!rowRaw) return res.status(404).json({ error: "not_found" });
      // Fields added by 2026_09_08_onboarding_ingestion.sql; Supabase
      // generated types haven't been regenerated yet.
      const row = rowRaw as any;

      // Ownership check: non-admin callers only see their own accounts.
      const callerExtUid = req.profile?.external_user_id ?? null;
      if (!isAdminSecret && !isAdminUser) {
        if (!row.external_user_id || row.external_user_id !== callerExtUid) {
          return res.status(403).json({ error: "not_your_account" });
        }
      }

      // Compute a rolling ETA when processing. If posts_total is known,
      // eta = (elapsed / processed) * (total - processed). Otherwise return
      // the stored ingestion_eta_seconds (worker may update it in future).
      let etaSeconds: number | null = row.ingestion_eta_seconds ?? null;
      if (
        row.ingestion_status === "processing" &&
        row.posts_total &&
        row.posts_processed &&
        row.ingestion_started_at
      ) {
        const elapsedMs = Date.now() - new Date(row.ingestion_started_at).getTime();
        const rate = row.posts_processed / (elapsedMs / 1000);
        const remaining = row.posts_total - row.posts_processed;
        if (rate > 0 && remaining > 0) etaSeconds = Math.round(remaining / rate);
      }

      return res.json({
        status: row.ingestion_status ?? "unknown",
        platform: row.platform,
        platform_handle: row.platform_handle,
        posts_processed: row.posts_processed ?? 0,
        posts_total: row.posts_total ?? null,
        eta_seconds: etaSeconds,
        started_at: row.ingestion_started_at,
        completed_at: row.ingestion_completed_at,
        error: row.ingestion_error,
      });
    } catch (e: any) {
      console.error("[onboard/status] error:", e?.message ?? e);
      return res.status(500).json({ error: e?.message ?? "internal_error" });
    }
  });

  // -----------------------------------------------------------------
  // POST /api/onboard/retry  { cv_account_id }
  // Resets a failed / skipped account to pending and enqueues a fresh job.
  // Also usable to re-run ingestion for an existing account.
  // -----------------------------------------------------------------
  app.post("/api/onboard/retry", async (req: Request, res: Response) => {
    try {
      const cvAccountId = req.body?.cv_account_id;
      if (typeof cvAccountId !== "string" || !cvAccountId) {
        return res.status(400).json({ error: "cv_account_id required" });
      }

      const isAdminSecret = !!(req.auth && "admin_secret" in req.auth && req.auth.admin_secret);
      const isAdminUser = req.profile?.role === "admin";
      const isUser = req.profile?.role === "user" && !!req.profile.external_user_id;
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const sb = sbFn();

      // Ownership guard for user role
      if (!isAdminSecret && !isAdminUser) {
        const { data: rowRaw } = await sb
          .from("creatorvault_accounts")
          .select("external_user_id")
          .eq("cv_account_id", cvAccountId)
          .maybeSingle();
        const row = rowRaw as { external_user_id?: string } | null;
        if (!row || row.external_user_id !== req.profile?.external_user_id) {
          return res.status(403).json({ error: "not_your_account" });
        }
      }

      const result = await enqueueIngestionJob(sb, cvAccountId);
      if (!result.enqueued) {
        return res.status(409).json({ error: result.reason ?? "not_enqueued" });
      }
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[onboard/retry] error:", e?.message ?? e);
      return res.status(500).json({ error: e?.message ?? "internal_error" });
    }
  });

  // -----------------------------------------------------------------
  // POST /api/onboard/enqueue  { cv_account_id }
  // Admin-only manual enqueue. Used by CLI / smoke tests. Same body as
  // /retry but does not require ownership; requires admin secret.
  // -----------------------------------------------------------------
  app.post("/api/onboard/enqueue", async (req: Request, res: Response) => {
    try {
      const isAdminSecret = !!(req.auth && "admin_secret" in req.auth && req.auth.admin_secret);
      const isAdminUser = req.profile?.role === "admin";
      if (!isAdminSecret && !isAdminUser) {
        return res.status(401).json({ error: "admin_only" });
      }

      const cvAccountId = req.body?.cv_account_id;
      if (typeof cvAccountId !== "string" || !cvAccountId) {
        return res.status(400).json({ error: "cv_account_id required" });
      }

      const sb = sbFn();
      const result = await enqueueIngestionJob(sb, cvAccountId, {
        since: req.body?.since,
        page_limit: req.body?.page_limit,
      });
      if (!result.enqueued) {
        return res.status(409).json({ error: result.reason ?? "not_enqueued" });
      }
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[onboard/enqueue] error:", e?.message ?? e);
      return res.status(500).json({ error: e?.message ?? "internal_error" });
    }
  });
}
