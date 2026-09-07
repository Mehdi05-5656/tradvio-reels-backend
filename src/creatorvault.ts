// CreatorVault integration for Tradvio Reels
//
// Two responsibilities:
//   1) Outbound: HTTP client for cv-api/v1 (accounts, videos, snapshots).
//   2) Inbound: webhook receiver for CreatorVault -> us events (account.matched, etc).
//
// Cache strategy: cache-through into public.creatorvault_* tables. Dashboard
// reads local; the client refreshes on TTLs or on webhook signal.

import type { Request, Response, Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

// ---------- Config ----------

const CV_BASE = process.env.CREATORVAULT_API_BASE ||
  "https://txoojazdivnmgstunpic.supabase.co/functions/v1/cv-api/v1";
const CV_API_KEY = process.env.CREATORVAULT_API_KEY || "";
const CV_WEBHOOK_SECRET = process.env.CREATORVAULT_WEBHOOK_SECRET || "";

function assertKey() {
  if (!CV_API_KEY) throw new Error("CREATORVAULT_API_KEY env not set");
}

// ---------- HTTP client ----------

async function cvFetch<T>(path: string, opts: { qs?: Record<string, string | number | undefined> } = {}): Promise<T> {
  assertKey();
  const url = new URL(CV_BASE + path);
  for (const [k, v] of Object.entries(opts.qs ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${CV_API_KEY}` },
  });
  const body = await r.text();
  if (!r.ok) {
    throw new Error(`cv-api ${r.status} ${path}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`cv-api ${path}: non-JSON response`);
  }
}

// ---------- Type shapes matching cv-api/v1 ----------

export type CvAccount = {
  id: string;
  platform: "tiktok" | "instagram";
  platform_handle: string;
  platform_user_id: string;
  connected_at: string;
  last_synced_at: string | null;
  is_active: boolean;
  token_expires_at: string | null;
};

export type CvVideo = {
  id: string;
  platform: string;
  video_id: string;
  url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  publish_time: string | null;
  thumbnail_url: string | null;
  is_public: boolean;
  latest_snapshot: {
    taken_at: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    engagement_rate: number | null;
    favorite_count: number | null;
  } | null;
};

export type CvSnapshot = {
  taken_at: string;
  hours_after_publish: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagement_rate: number | null;
  velocity: number | null;
  favorite_count: number | null;
};

// ---------- High-level sync helpers ----------

export async function syncAccounts(sb: SupabaseClient): Promise<{ mirrored: number; from_cv: number }> {
  const { accounts } = await cvFetch<{ accounts: CvAccount[] }>("/accounts");
  if (!accounts?.length) {
    return { mirrored: 0, from_cv: 0 };
  }
  const rows = accounts.map((a) => ({
    cv_account_id: a.id,
    platform: a.platform,
    platform_user_id: a.platform_user_id,
    platform_handle: a.platform_handle,
    connected_at: a.connected_at,
    last_synced_at: a.last_synced_at,
    is_active: a.is_active,
    last_seen_at: new Date().toISOString(),
  }));
  const { error } = await sb.from("creatorvault_accounts").upsert(rows, { onConflict: "cv_account_id" });
  if (error) throw error;
  await sb.from("creatorvault_config").update({ last_account_sync_at: new Date().toISOString() }).eq("id", 1);
  return { mirrored: rows.length, from_cv: accounts.length };
}

export async function syncVideosForAccount(
  sb: SupabaseClient,
  cvAccountId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<{ mirrored: number }> {
  let cursor: string | null | undefined = undefined;
  let mirrored = 0;
  const pageLimit = opts.limit ?? 50;
  const maxPages = 20; // safety cap: 20 * 50 = 1000 videos max per run
  for (let page = 0; page < maxPages; page++) {
    const resp: { videos: CvVideo[]; next_cursor: string | null } = await cvFetch("/videos", {
      qs: { account_id: cvAccountId, since: opts.since, limit: pageLimit, cursor: cursor ?? undefined },
    });
    if (!resp.videos?.length) break;
    const rows = resp.videos.map((v) => ({
      cv_video_id: v.id,
      cv_account_id: cvAccountId,
      platform: v.platform,
      platform_video_id: v.video_id,
      url: v.url,
      caption: v.caption,
      hashtags: v.hashtags ?? [],
      publish_time: v.publish_time,
      thumbnail_url: v.thumbnail_url,
      latest_snapshot: v.latest_snapshot,
      last_refreshed_at: new Date().toISOString(),
    }));
    const { error } = await sb.from("creatorvault_videos").upsert(rows, { onConflict: "cv_video_id" });
    if (error) throw error;
    mirrored += rows.length;
    cursor = resp.next_cursor;
    if (!cursor) break;
  }
  return { mirrored };
}

export async function syncSnapshotsForVideo(
  sb: SupabaseClient,
  cvVideoId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<{ mirrored: number }> {
  const resp: { snapshots: CvSnapshot[] } = await cvFetch(`/videos/${cvVideoId}/snapshots`, {
    qs: { since: opts.since, limit: opts.limit ?? 200 },
  });
  if (!resp.snapshots?.length) return { mirrored: 0 };
  const rows = resp.snapshots.map((s) => ({
    cv_video_id: cvVideoId,
    taken_at: s.taken_at,
    hours_after_publish: s.hours_after_publish,
    views: s.views,
    likes: s.likes,
    comments: s.comments,
    shares: s.shares,
    engagement_rate: s.engagement_rate,
    velocity: s.velocity,
    favorite_count: s.favorite_count,
  }));
  const { error } = await sb.from("creatorvault_video_snapshots").upsert(rows, { onConflict: "cv_video_id,taken_at" });
  if (error) throw error;
  return { mirrored: rows.length };
}

// ---------- Reconciliation with Publer ----------

// Extract platform_video_id from a publer_post_link.
// TikTok: https://www.tiktok.com/@handle/video/7555076841187347743?...
// Instagram: https://www.instagram.com/reel/Dc8sGK1jUwa/
export function extractPlatformVideoId(url: string | null | undefined): { platform: string; id: string } | null {
  if (!url) return null;
  const tt = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (tt) return { platform: "tiktok", id: tt[1] };
  const igReel = url.match(/instagram\.com\/reel\/([^/?#]+)/);
  if (igReel) return { platform: "instagram", id: igReel[1] };
  const igP = url.match(/instagram\.com\/p\/([^/?#]+)/);
  if (igP) return { platform: "instagram", id: igP[1] };
  return null;
}

export async function reconcilePublerToCreatorVault(sb: SupabaseClient): Promise<{ matched: number; scanned: number }> {
  // Pull all Publer publish log rows that don't yet have a reconciliation.
  const { data: logs, error } = await sb
    .from("publer_publish_log")
    .select("publer_post_id, publer_post_link")
    .not("publer_post_link", "is", null)
    .limit(500);
  if (error) throw error;
  if (!logs?.length) return { matched: 0, scanned: 0 };

  let matched = 0;
  for (const log of logs) {
    const parsed = extractPlatformVideoId(log.publer_post_link);
    if (!parsed) continue;
    // Note: for IG, Publer's short-code (Dc8sGK1jUwa) may differ from the ig_media_id we get from CV.
    // We match by exact platform_video_id first; if that fails we skip and log.
    const { data: hit } = await sb
      .from("creatorvault_videos")
      .select("cv_video_id, publer_post_id")
      .eq("platform", parsed.platform)
      .eq("platform_video_id", parsed.id)
      .maybeSingle();
    if (hit && hit.publer_post_id !== log.publer_post_id) {
      await sb
        .from("creatorvault_videos")
        .update({ publer_post_id: log.publer_post_id })
        .eq("cv_video_id", hit.cv_video_id);
      matched++;
    }
  }
  return { matched, scanned: logs.length };
}

// ---------- Webhook verification ----------

function verifySignature(rawBody: string, headerValue: string | undefined): boolean {
  if (!CV_WEBHOOK_SECRET || !headerValue) return false;
  const cleaned = headerValue.replace(/^sha256=/, "");
  const expected = createHmac("sha256", CV_WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(cleaned, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---------- Route registration ----------

export function registerCreatorVaultRoutes(app: Express, sbFn: () => SupabaseClient) {
  // Inbound webhook. HMAC verification needs the raw request body, which is
  // captured globally by the express.json verify fn in index.ts (req.rawBody).
  app.post(
    "/api/creatorvault/webhook",
    async (req: Request, res: Response) => {
      const raw = ((req as any).rawBody as string) || "";
      const sig = req.header("x-creatorvault-signature");
      const valid = verifySignature(raw, sig);

      const payload: any = req.body ?? null;

      const sb = sbFn();
      const { data: eventRow } = await sb
        .from("creatorvault_webhook_events")
        .insert({
          event: payload?.event ?? "unknown",
          bridge_id: payload?.bridge_id ?? null,
          bridge_name: payload?.bridge_name ?? null,
          signature_valid: valid,
          payload: payload ?? {},
          processing_status: valid ? "received" : "failed",
          processing_error: valid ? null : "invalid_signature",
        })
        .select("id")
        .single();

      if (!valid) {
        console.warn("[creatorvault] webhook rejected: invalid signature");
        return res.status(401).json({ error: "invalid_signature" });
      }

      // Process known events. Unknown events are logged as 'ignored'.
      try {
        // CV bridge (WO-04) emits `account.connected` on new connects.
        // Legacy `account.matched` is kept for backward compat.
        if (payload?.event === "account.connected" || payload?.event === "account.matched") {
          const ca = payload.connected_account;
          // Bridge-flow payloads include external_user_id + bridge_name at
          // the top level of the payload. Real CV payload confirmed as:
          //   { event, bridge_id, bridge_name, external_user_id, connected_account: {...} }
          const externalUserId: string | null =
            (typeof payload.external_user_id === "string" && payload.external_user_id) || null;
          const bridgeSource: string | null =
            (typeof payload.bridge_name === "string" && payload.bridge_name) ||
            (typeof payload.bridge === "string" && payload.bridge) ||
            null;
          await sb.from("creatorvault_accounts").upsert({
            cv_account_id: ca.id,
            platform: ca.platform,
            platform_user_id: ca.platform_user_id,
            platform_handle: ca.platform_handle,
            connected_at: ca.connected_at,
            is_active: true,
            last_seen_at: new Date().toISOString(),
            external_user_id: externalUserId,
            bridge_source: bridgeSource,
          }, { onConflict: "cv_account_id" });

          if (eventRow?.id) {
            await sb.from("creatorvault_webhook_events")
              .update({ processing_status: "processed", processed_at: new Date().toISOString() })
              .eq("id", eventRow.id);
          }
          console.log("[creatorvault]", payload.event, ca.platform, ca.platform_handle,
            "external_user_id=", externalUserId, "bridge_source=", bridgeSource);
        } else {
          if (eventRow?.id) {
            await sb.from("creatorvault_webhook_events")
              .update({ processing_status: "ignored", processed_at: new Date().toISOString() })
              .eq("id", eventRow.id);
          }
        }
      } catch (e: any) {
        if (eventRow?.id) {
          await sb.from("creatorvault_webhook_events")
            .update({
              processing_status: "failed",
              processing_error: e.message,
              processed_at: new Date().toISOString(),
            })
            .eq("id", eventRow.id);
        }
        console.error("[creatorvault] webhook processing error:", e.message);
        return res.status(500).json({ error: "processing_failed" });
      }

      return res.json({ ok: true });
    },
  );

  // Admin: manual sync trigger. Requires x-app-secret (same auth as other write endpoints).
  // Note: sync + reconcile endpoints are POSTs to /api/* and inherit the blanket
  // x-app-secret guard installed by registerRoutes(). No per-route auth needed here.
  app.post("/api/creatorvault/sync/accounts", async (_req: Request, res: Response) => {
    try {
      const r = await syncAccounts(sbFn());
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/creatorvault/sync/videos/:cvAccountId", async (req: Request, res: Response) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const r = await syncVideosForAccount(sbFn(), req.params.cvAccountId, { since });
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/creatorvault/reconcile", async (_req: Request, res: Response) => {
    try {
      const r = await reconcilePublerToCreatorVault(sbFn());
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: read state of the integration
  app.get("/api/creatorvault/status", async (_req: Request, res: Response) => {
    const sb = sbFn();
    const { data: cfg } = await sb.from("creatorvault_config").select("*").eq("id", 1).maybeSingle();
    const { count: accounts } = await sb.from("creatorvault_accounts").select("*", { count: "exact", head: true });
    const { count: videos } = await sb.from("creatorvault_videos").select("*", { count: "exact", head: true });
    const { data: recentEvents } = await sb
      .from("creatorvault_webhook_events")
      .select("received_at, event, signature_valid, processing_status, bridge_name")
      .order("received_at", { ascending: false })
      .limit(10);
    res.json({
      configured: !!CV_API_KEY,
      base_url: CV_BASE,
      webhook_secret_set: !!CV_WEBHOOK_SECRET,
      config: cfg,
      counts: { accounts, videos },
      recent_webhook_events: recentEvents ?? [],
    });
  });

  // ---------- Bridge OAuth (WO-04) ----------

  // Start a bridge OAuth flow for a Tradvio-side user.
  // POST body: { platform: 'instagram' | 'tiktok', external_user_id?: string }
  // Returns { authorize_url, state } from CV's cv-api/v1/bridge/oauth/start.
  //
  // The redirect_back_url is fixed to the Tradvio Reels dashboard's
  // /oauth-return page. We never expose the CV bridge key to the browser.
  app.post(
    "/api/creatorvault/bridge/oauth/start",
    async (req: Request, res: Response) => {
      try {
        const platform = String(req.body?.platform || "").toLowerCase();
        if (platform !== "instagram" && platform !== "tiktok") {
          return res.status(400).json({ error: "invalid_platform", detail: "platform must be 'instagram' or 'tiktok'" });
        }
        // WO-A: derive external_user_id from auth. Admins can pass any value
        // (or omit and default to 'tradvio-brand' for backward-compat with the
        // existing admin-secret Settings flow). Regular users are forced to
        // their own external_user_id regardless of what the body says.
        const requested = typeof req.body?.external_user_id === "string" ? req.body.external_user_id : null;
        let externalUserId: string;
        if (req.profile?.role === "user" && req.profile.external_user_id) {
          externalUserId = req.profile.external_user_id;
        } else {
          // admin_secret, admin JWT, or unauthenticated legacy path
          externalUserId = requested || "tradvio-brand";
        }

        const dashboardOrigin =
          process.env.TRADVIO_DASHBOARD_ORIGIN ||
          "https://tradvio-reels-dashboard.onrender.com";
        const redirectBackUrl = `${dashboardOrigin}/oauth-return`;

        assertKey();
        const url = new URL(CV_BASE + "/bridge/oauth/start");
        const r = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CV_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            platform,
            external_user_id: externalUserId,
            redirect_back_url: redirectBackUrl,
          }),
        });
        const body = await r.text();
        if (!r.ok) {
          console.error("[creatorvault] bridge/oauth/start failed:", r.status, body.slice(0, 500));
          return res.status(502).json({ error: "cv_start_failed", status: r.status, detail: body.slice(0, 500) });
        }
        try {
          const parsed = JSON.parse(body);
          return res.json(parsed);
        } catch {
          return res.status(502).json({ error: "cv_start_non_json", detail: body.slice(0, 500) });
        }
      } catch (e: any) {
        console.error("[creatorvault] bridge/oauth/start exception:", e.message);
        return res.status(500).json({ error: e.message });
      }
    },
  );

  // Lookup connected accounts for a given external_user_id.
  // GET /api/creatorvault/accounts?external_user_id=tradvio-brand
  //   -> [{ cv_account_id, platform, platform_handle, connected_at, is_active,
  //         external_user_id, bridge_source, last_seen_at }, ...]
  //
  // Public GET (matches the rest of the read surface). Used by /oauth-return
  // for polling after a callback, and by the Accounts page for listing.
  app.get("/api/creatorvault/accounts", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      // WO-A: Same rule as OAuth start. Admins can query any external_user_id
      // (or omit to see all rows). Regular users are locked to their own.
      const requested = typeof req.query.external_user_id === "string" ? req.query.external_user_id : "";
      let externalUserId: string;
      if (req.profile?.role === "user" && req.profile.external_user_id) {
        externalUserId = req.profile.external_user_id;
      } else {
        // admin_secret, admin JWT, or unauthenticated legacy path
        externalUserId = requested;
      }
      let q = sb
        .from("creatorvault_accounts")
        .select("cv_account_id, platform, platform_user_id, platform_handle, connected_at, last_seen_at, is_active, external_user_id, bridge_source")
        .order("last_seen_at", { ascending: false })
        .limit(200);
      if (externalUserId) {
        q = q.eq("external_user_id", externalUserId);
      }
      const { data, error } = await q;
      if (error) throw error;
      res.json(data ?? []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ---------- helpers ----------

