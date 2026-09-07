// CreatorVault bridge write-side client. Wraps /v1/bridge/reels/* endpoints.
//
// When CV_STUB_MODE=1 (default while CV's WO-05 endpoints are not live),
// the client returns canned success responses and schedules fake webhook
// events on a delay so the Tradvio side can be developed and tested end
// to end. When CV_STUB_MODE=0, it calls the real endpoints.
//
// Both modes share the same public surface, so switching is a single env var flip.

import crypto from "node:crypto";

export type ReelScheduleInput = {
  video_url: string;
  caption: string;
  scheduled_for: string;
  cover_url?: string | null;
  share_to_feed?: boolean;
  client_ref: string;
};

export type ReelScheduleAccepted = {
  client_ref: string;
  cv_reel_id: string;
  status: "pending";
};

export type ReelScheduleRejected = {
  client_ref: string;
  reason: string;
};

export type ReelScheduleResponse = {
  accepted: ReelScheduleAccepted[];
  rejected: ReelScheduleRejected[];
};

export type ReelStatus = {
  cv_reel_id: string;
  client_ref?: string | null;
  external_user_id: string;
  status:
    | "pending"
    | "container_created"
    | "container_ready"
    | "published"
    | "failed"
    | "cancelled";
  ig_media_id?: string | null;
  scheduled_for: string;
  published_at?: string | null;
  last_error?: string | null;
  attempts: number;
};

const CV_BASE = process.env.CREATORVAULT_BRIDGE_API_URL ?? "https://txoojazdivnmgstunpic.supabase.co/functions/v1/cv-api/v1";
const CV_KEY = process.env.CREATORVAULT_BRIDGE_API_KEY ?? "";
const CV_STUB = (process.env.CV_STUB_MODE ?? "1") === "1";

// In-memory stub store: cv_reel_id -> row. Only used when CV_STUB=1.
type StubRow = {
  cv_reel_id: string;
  client_ref: string;
  external_user_id: string;
  status: ReelStatus["status"];
  scheduled_for: string;
  ig_media_id: string | null;
  published_at: string | null;
  last_error: string | null;
  attempts: number;
  video_url: string;
  caption: string;
};
const stubStore = new Map<string, StubRow>();

function newCvReelId(): string {
  // ULID-like: 26 chars. Not a real ULID, but visually similar for logs.
  const t = Date.now().toString(36).padStart(10, "0");
  const r = crypto.randomBytes(9).toString("base64url").slice(0, 16);
  return `${t}${r}`.slice(0, 26).toUpperCase();
}

async function cvFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${CV_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${CV_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export const cvBridge = {
  isStub: () => CV_STUB,

  async scheduleReels(
    externalUserId: string,
    reels: ReelScheduleInput[],
  ): Promise<ReelScheduleResponse> {
    if (CV_STUB) {
      const accepted: ReelScheduleAccepted[] = [];
      for (const r of reels) {
        const id = newCvReelId();
        stubStore.set(id, {
          cv_reel_id: id,
          client_ref: r.client_ref,
          external_user_id: externalUserId,
          status: "pending",
          scheduled_for: r.scheduled_for,
          ig_media_id: null,
          published_at: null,
          last_error: null,
          attempts: 0,
          video_url: r.video_url,
          caption: r.caption,
        });
        accepted.push({ client_ref: r.client_ref, cv_reel_id: id, status: "pending" });
      }
      return { accepted, rejected: [] };
    }

    const res = await cvFetch("/bridge/reels/schedule", {
      method: "POST",
      body: JSON.stringify({ external_user_id: externalUserId, reels }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cv_bridge_schedule_failed status=${res.status} body=${body.slice(0, 400)}`);
    }
    return (await res.json()) as ReelScheduleResponse;
  },

  async getReel(cvReelId: string): Promise<ReelStatus | null> {
    if (CV_STUB) {
      const row = stubStore.get(cvReelId);
      if (!row) return null;
      return {
        cv_reel_id: row.cv_reel_id,
        client_ref: row.client_ref,
        external_user_id: row.external_user_id,
        status: row.status,
        scheduled_for: row.scheduled_for,
        ig_media_id: row.ig_media_id,
        published_at: row.published_at,
        last_error: row.last_error,
        attempts: row.attempts,
      };
    }
    const res = await cvFetch(`/bridge/reels/${encodeURIComponent(cvReelId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cv_bridge_get_failed status=${res.status} body=${body.slice(0, 400)}`);
    }
    return (await res.json()) as ReelStatus;
  },

  async listReels(params: {
    external_user_id?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: ReelStatus[]; next_cursor?: string | null }> {
    if (CV_STUB) {
      const items = Array.from(stubStore.values())
        .filter((r) => !params.external_user_id || r.external_user_id === params.external_user_id)
        .filter((r) => {
          if (!params.status) return true;
          const wanted = params.status.split(",");
          return wanted.includes(r.status);
        })
        .map((r) => ({
          cv_reel_id: r.cv_reel_id,
          client_ref: r.client_ref,
          external_user_id: r.external_user_id,
          status: r.status,
          scheduled_for: r.scheduled_for,
          ig_media_id: r.ig_media_id,
          published_at: r.published_at,
          last_error: r.last_error,
          attempts: r.attempts,
        }));
      return { items, next_cursor: null };
    }
    const qs = new URLSearchParams();
    if (params.external_user_id) qs.set("external_user_id", params.external_user_id);
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const res = await cvFetch(`/bridge/reels?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cv_bridge_list_failed status=${res.status} body=${body.slice(0, 400)}`);
    }
    return (await res.json()) as { items: ReelStatus[]; next_cursor?: string | null };
  },

  async cancelReel(cvReelId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (CV_STUB) {
      const row = stubStore.get(cvReelId);
      if (!row) return { ok: false, reason: "not_found" };
      if (["published", "failed", "cancelled"].includes(row.status)) {
        return { ok: false, reason: "already_terminal" };
      }
      row.status = "cancelled";
      return { ok: true };
    }
    const res = await cvFetch(`/bridge/reels/${encodeURIComponent(cvReelId)}`, {
      method: "DELETE",
    });
    if (res.status === 409) return { ok: false, reason: "already_terminal" };
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cv_bridge_cancel_failed status=${res.status} body=${body.slice(0, 400)}`);
    }
    return { ok: true };
  },

  // Test helper: force-advance a stubbed reel to a terminal status. No-op when CV_STUB=0.
  // Used by scheduled_reels reconcile cron + admin debug endpoints.
  _stubAdvance(cvReelId: string, to: ReelStatus["status"], extra?: Partial<StubRow>): boolean {
    if (!CV_STUB) return false;
    const row = stubStore.get(cvReelId);
    if (!row) return false;
    row.status = to;
    if (extra) Object.assign(row, extra);
    if (to === "published" && !row.ig_media_id) {
      row.ig_media_id = "179" + Math.floor(Math.random() * 1e17).toString();
      row.published_at = new Date().toISOString();
    }
    return true;
  },
};
