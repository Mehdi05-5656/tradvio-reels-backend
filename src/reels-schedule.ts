// Tradvio Reels scheduling routes. See WO-05 handoff:
//   POST   /api/reels/schedule                     - submit a batch of reels
//   GET    /api/reels/scheduled                    - list scheduled reels (paginated)
//   GET    /api/reels/scheduled/:id                - single row lookup
//   DELETE /api/reels/scheduled/:id                - cancel (if cancellable)
//   POST   /api/reels/upload-url                   - request a signed upload URL
//
// Publer coexists: this path is opt-in, driven by whether the account was
// connected via CreatorVault. Publer routes are untouched.

import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { cvBridge, type ReelScheduleInput } from "./cv-bridge-client.js";

const RATE_LIMIT_PER_ACCOUNT_24H = 100;
const REELS_UPLOAD_BUCKET = "reels-uploads";

// Coerce boolean-ish query params
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

// Extract auth flags in the same style as creatorvault.ts. Duplicated
// deliberately to keep this module self-contained.
function authContext(req: Request) {
  const isAdminSecret = !!(req.auth && "admin_secret" in req.auth && req.auth.admin_secret);
  const isAdminUser = req.profile?.role === "admin";
  const isUser = req.profile?.role === "user" && !!req.profile.external_user_id;
  return {
    isAdminSecret,
    isAdminUser,
    isUser,
    callerExtUid: req.profile?.external_user_id ?? null,
  };
}

export function registerReelsScheduleRoutes(app: Express, sbFn: () => SupabaseClient) {
  // -------------------- POST /api/reels/schedule --------------------
  //
  // Body: { external_user_id, reels: [{ video_url, caption, scheduled_for, cover_url?, share_to_feed?, client_ref }] }
  //
  // Behavior:
  //   1. Validate shape.
  //   2. Resolve target external_user_id based on caller.
  //   3. Look up the CV account for the target to attach cv_account_id and platform_handle.
  //   4. Enforce 100/24h rate limit per cv_account_id (rolling window).
  //   5. Call cvBridge.scheduleReels (stub or live).
  //   6. Persist each returned accepted/rejected result to scheduled_reels.
  //   7. Return the passthrough response.
  app.post("/api/reels/schedule", async (req: Request, res: Response) => {
    try {
      const { isAdminSecret, isAdminUser, isUser, callerExtUid } = authContext(req);
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const body = req.body ?? {};
      let targetExtUid = typeof body.external_user_id === "string" ? body.external_user_id : "";

      // Regular users are always forced to their own external_user_id.
      if (isUser && !isAdminUser && !isAdminSecret) {
        targetExtUid = callerExtUid!;
      }
      if (!targetExtUid) {
        return res.status(400).json({ error: "missing_external_user_id" });
      }

      const reels = Array.isArray(body.reels) ? body.reels : null;
      if (!reels || reels.length === 0) {
        return res.status(400).json({ error: "reels_empty" });
      }
      if (reels.length > 100) {
        return res.status(400).json({ error: "too_many_reels", detail: "max 100 per request" });
      }

      // Basic per-reel validation.
      const normalized: ReelScheduleInput[] = [];
      for (const r of reels) {
        if (!r || typeof r !== "object") return res.status(400).json({ error: "bad_reel" });
        if (typeof r.video_url !== "string" || !/^https:\/\//i.test(r.video_url)) {
          return res.status(400).json({ error: "bad_video_url", detail: "https URL required" });
        }
        if (typeof r.caption !== "string") {
          return res.status(400).json({ error: "bad_caption" });
        }
        if (r.caption.length > 2200) {
          return res.status(400).json({ error: "caption_too_long", detail: "max 2200 chars" });
        }
        if (typeof r.scheduled_for !== "string" || Number.isNaN(Date.parse(r.scheduled_for))) {
          return res.status(400).json({ error: "bad_scheduled_for", detail: "ISO 8601 UTC required" });
        }
        if (r.cover_url && (typeof r.cover_url !== "string" || !/^https:\/\//i.test(r.cover_url))) {
          return res.status(400).json({ error: "bad_cover_url" });
        }
        if (typeof r.client_ref !== "string" || !r.client_ref) {
          return res.status(400).json({ error: "missing_client_ref" });
        }
        normalized.push({
          video_url: r.video_url,
          caption: r.caption,
          scheduled_for: new Date(r.scheduled_for).toISOString(),
          cover_url: r.cover_url ?? null,
          share_to_feed: r.share_to_feed !== false,
          client_ref: r.client_ref,
        });
      }

      const sb = sbFn();

      // Resolve account for target external_user_id.
      const { data: accountRows, error: accErr } = await sb
        .from("creatorvault_accounts")
        .select("cv_account_id, platform, platform_handle, is_active")
        .eq("external_user_id", targetExtUid)
        .eq("is_active", true);
      if (accErr) throw accErr;
      const account = (accountRows ?? []).find((a: any) => a.platform === "instagram");
      if (!account) {
        return res.status(404).json({
          error: "no_connected_instagram_account",
          detail: `external_user_id=${targetExtUid} has no active Instagram account`,
        });
      }

      // Rate limit check per account for the rolling 24h window.
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: recentCount, error: cntErr } = await sb
        .from("scheduled_reels")
        .select("id", { count: "exact", head: true })
        .eq("cv_account_id", account.cv_account_id)
        .in("status", ["submitted", "pending", "container_created", "container_ready", "published"])
        .gte("scheduled_for", windowStart);
      if (cntErr) throw cntErr;
      const wouldBe = (recentCount ?? 0) + normalized.length;
      if (wouldBe > RATE_LIMIT_PER_ACCOUNT_24H) {
        return res.status(429).json({
          error: "rate_limit_exhausted",
          detail: `Instagram allows 100 reels per 24h per account; current window has ${recentCount}, request would push to ${wouldBe}`,
        });
      }

      // Call CV (stub or live).
      let cvResponse;
      try {
        cvResponse = await cvBridge.scheduleReels(targetExtUid, normalized);
      } catch (e: any) {
        return res.status(502).json({ error: "cv_bridge_error", detail: e.message });
      }

      // Persist locally. Accepted rows -> status='submitted'. Rejected rows -> status='failed' with reason.
      const acceptedById = new Map<string, typeof cvResponse.accepted[number]>();
      for (const a of cvResponse.accepted) acceptedById.set(a.client_ref, a);
      const rejectedById = new Map<string, typeof cvResponse.rejected[number]>();
      for (const r of cvResponse.rejected) rejectedById.set(r.client_ref, r);

      const insertRows = normalized.map((r) => {
        const acc = acceptedById.get(r.client_ref);
        const rej = rejectedById.get(r.client_ref);
        const base = {
          external_user_id: targetExtUid,
          cv_account_id: account.cv_account_id,
          platform_handle: account.platform_handle,
          client_ref: r.client_ref,
          video_url: r.video_url,
          cover_url: r.cover_url,
          caption: r.caption,
          scheduled_for: r.scheduled_for,
          share_to_feed: r.share_to_feed ?? true,
          created_by_user_id: req.profile?.user_id ?? null,
        };
        if (acc) {
          return { ...base, cv_reel_id: acc.cv_reel_id, status: "submitted" as const };
        }
        return {
          ...base,
          cv_reel_id: null,
          status: "failed" as const,
          failure_reason: rej?.reason ?? "unknown_rejection",
          last_error: rej?.reason ?? "unknown_rejection",
        };
      });

      const { error: insErr } = await sb.from("scheduled_reels").insert(insertRows);
      if (insErr) throw insErr;

      res.status(202).json({
        stub_mode: cvBridge.isStub(),
        accepted: cvResponse.accepted,
        rejected: cvResponse.rejected,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // -------------------- GET /api/reels/scheduled --------------------
  app.get("/api/reels/scheduled", async (req: Request, res: Response) => {
    try {
      const { isAdminSecret, isAdminUser, isUser, callerExtUid } = authContext(req);
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      let externalUserId =
        typeof req.query.external_user_id === "string" ? req.query.external_user_id : null;
      if (isUser && !isAdminUser && !isAdminSecret) {
        externalUserId = callerExtUid!;
      }

      const status =
        typeof req.query.status === "string" ? req.query.status.split(",") : null;
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);

      const sb = sbFn();
      let q = sb
        .from("scheduled_reels")
        .select(
          "id, cv_reel_id, client_ref, external_user_id, platform_handle, cv_account_id, video_url, cover_url, caption, scheduled_for, share_to_feed, status, ig_media_id, permalink, last_error, failure_reason, attempts, published_at, created_at, updated_at",
        )
        .order("scheduled_for", { ascending: true })
        .limit(limit);
      if (externalUserId) q = q.eq("external_user_id", externalUserId);
      if (status) q = q.in("status", status);

      const { data, error } = await q;
      if (error) throw error;
      res.json({ items: data ?? [], stub_mode: cvBridge.isStub() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // -------------------- GET /api/reels/scheduled/:id --------------------
  app.get("/api/reels/scheduled/:id", async (req: Request, res: Response) => {
    try {
      const { isAdminSecret, isAdminUser, isUser, callerExtUid } = authContext(req);
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const sb = sbFn();
      const { data, error } = await sb
        .from("scheduled_reels")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "not_found" });

      // Regular users can only see their own rows.
      if (isUser && !isAdminUser && !isAdminSecret && data.external_user_id !== callerExtUid) {
        return res.status(404).json({ error: "not_found" });
      }
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // -------------------- DELETE /api/reels/scheduled/:id --------------------
  app.delete("/api/reels/scheduled/:id", async (req: Request, res: Response) => {
    try {
      const { isAdminSecret, isAdminUser, isUser, callerExtUid } = authContext(req);
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const sb = sbFn();
      const { data: row, error } = await sb
        .from("scheduled_reels")
        .select("id, external_user_id, cv_reel_id, status")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: "not_found" });

      if (isUser && !isAdminUser && !isAdminSecret && row.external_user_id !== callerExtUid) {
        return res.status(404).json({ error: "not_found" });
      }

      const cancellable = ["draft", "submitted", "pending", "container_created", "container_ready"];
      if (!cancellable.includes(row.status)) {
        return res.status(409).json({ error: "not_cancellable", detail: `status=${row.status}` });
      }

      // Ask CV to cancel too, if we already submitted.
      if (row.cv_reel_id) {
        try {
          const cvRes = await cvBridge.cancelReel(row.cv_reel_id);
          if (cvRes.ok === false && cvRes.reason === "already_terminal") {
            return res.status(409).json({ error: "already_published_or_failed" });
          }
        } catch (e: any) {
          // If CV can't be reached, keep local row as-is; the reconcile cron will retry.
          return res.status(502).json({ error: "cv_bridge_error", detail: e.message });
        }
      }

      const { error: updErr } = await sb
        .from("scheduled_reels")
        .update({ status: "cancelled" })
        .eq("id", row.id);
      if (updErr) throw updErr;

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // -------------------- POST /api/reels/upload-url --------------------
  //
  // Returns a signed upload URL for a temporary object under the reels
  // storage bucket. Caller-side flow:
  //   1. Client validates the MP4 locally (see src/lib/mediaValidate.ts)
  //   2. Calls this endpoint to get { upload_url, public_url, object_path }
  //   3. Uploads via signed URL directly to Supabase Storage
  //   4. Submits public_url to /api/reels/schedule
  app.post("/api/reels/upload-url", async (req: Request, res: Response) => {
    try {
      const { isAdminSecret, isAdminUser, isUser, callerExtUid } = authContext(req);
      if (!isAdminSecret && !isAdminUser && !isUser) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const body = req.body ?? {};
      const fileName =
        typeof body.file_name === "string" ? body.file_name.replace(/[^A-Za-z0-9._-]/g, "_") : "reel.mp4";
      const ext = fileName.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? ".mp4";

      let targetExtUid = typeof body.external_user_id === "string" ? body.external_user_id : "";
      if (isUser && !isAdminUser && !isAdminSecret) {
        targetExtUid = callerExtUid!;
      }
      if (!targetExtUid) {
        return res.status(400).json({ error: "missing_external_user_id" });
      }

      const uuid = crypto.randomUUID();
      const objectPath = `${targetExtUid}/${uuid}${ext}`;

      const sb = sbFn();
      // Supabase Storage signed upload URL. Requires the bucket to exist.
      const { data: signed, error: signErr } = await sb.storage
        .from(REELS_UPLOAD_BUCKET)
        .createSignedUploadUrl(objectPath);
      if (signErr) {
        return res.status(500).json({ error: "signed_url_failed", detail: signErr.message });
      }
      const publicUrl = sb.storage.from(REELS_UPLOAD_BUCKET).getPublicUrl(objectPath).data.publicUrl;

      res.json({
        upload_url: signed.signedUrl,
        upload_token: signed.token,
        public_url: publicUrl,
        object_path: objectPath,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
