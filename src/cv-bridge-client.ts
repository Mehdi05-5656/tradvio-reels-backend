// CreatorVault WO-05 bridge client.
//
// When CV_STUB_MODE=1 the client runs a local in-memory stub so we can develop
// the Tradvio-side end-to-end before CV's real routes are live.
//
// When CV_STUB_MODE=0 the client calls CV's v5 /bridge/reels/* routes.
//
// CV v5 contract (as of 2026-09-07):
//   POST /v1/bridge/reels/schedule
//     body { connected_account_id, video_url, scheduled_for, caption?, cover_url?, share_to_feed?, client_ref? }
//     201 -> reel DTO
//   GET  /v1/bridge/reels/:id                                 -> reel DTO (404 not_found)
//   GET  /v1/bridge/reels?connected_account_id&status&limit&cursor  -> { reels[], next_cursor }
//   POST /v1/bridge/reels/:id/cancel                          -> {}  (409 already_terminal)
//   Auth: Authorization: Bearer <bridge-scoped api key>
//   Errors: { error, message, request_id }

export type ReelScheduleInput = {
  client_ref: string;
  connected_account_id: string;
  video_url: string;
  scheduled_for: string; // ISO 8601 UTC
  caption?: string;
  cover_url?: string;
  share_to_feed?: boolean;
};

export type ReelScheduleAccepted = {
  client_ref: string;
  cv_reel_id: string;
  status: string;
};

export type ReelScheduleRejected = {
  client_ref: string;
  error: string;
  detail?: string;
};

export type ReelScheduleResponse = {
  accepted: ReelScheduleAccepted[];
  rejected: ReelScheduleRejected[];
};

export type ReelStatus = {
  cv_reel_id: string;
  client_ref?: string | null;
  connected_account_id?: string | null;
  external_user_id?: string | null;
  status: "pending" | "submitted" | "container_created" | "container_ready" | "published" | "failed" | "cancelled";
  scheduled_for?: string | null;
  ig_media_id?: string | null;
  permalink?: string | null;
  published_at?: string | null;
  last_error?: string | null;
  failure_reason?: string | null;
  attempts?: number;
};

// ---------- Config ----------

const CV_BASE = (process.env.CREATORVAULT_BRIDGE_API_URL ?? "https://txoojazdivnmgstunpic.supabase.co/functions/v1/cv-api/v1").replace(/\/+$/, "");
const CV_KEY = process.env.CREATORVAULT_BRIDGE_API_KEY ?? "";
const CV_STUB = (process.env.CV_STUB_MODE ?? "1") === "1";

// ---------- Stub state ----------

type StubRow = {
  cv_reel_id: string;
  client_ref: string;
  external_user_id: string;
  connected_account_id: string;
  status: ReelStatus["status"];
  scheduled_for: string;
  video_url: string;
  caption?: string;
  ig_media_id: string | null;
  permalink: string | null;
  published_at: string | null;
  last_error: string | null;
  attempts: number;
};

const stubStore = new Map<string, StubRow>();

function newCvReelId(): string {
  // Stub uses ULID-shaped ids so downstream code that already stored these still works.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let s = "";
  for (let i = 0; i < 26; i++) s += alphabet[Math.floor(Math.random() * 32)];
  return s;
}

// ---------- HTTP ----------

async function cvFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${CV_KEY}`,
    "content-type": "application/json",
    "accept": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(`${CV_BASE}${path}`, { ...init, headers });
}

async function readCvError(res: Response): Promise<{ error: string; message: string; request_id?: string; raw: string }> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    return {
      error: String(j.error ?? `http_${res.status}`),
      message: String(j.message ?? raw.slice(0, 300)),
      request_id: j.request_id,
      raw,
    };
  } catch {
    return { error: `http_${res.status}`, message: raw.slice(0, 300), raw };
  }
}

// ---------- Public API ----------

export const cvBridge = {
  isStub: () => CV_STUB,

  /**
   * Schedule N reels. CV v5 exposes single-reel POST, so we loop client-side
   * and build our own {accepted, rejected} envelope so the Tradvio route
   * contract stays stable regardless of CV's fan-out shape.
   */
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
          connected_account_id: r.connected_account_id,
          status: "pending",
          scheduled_for: r.scheduled_for,
          ig_media_id: null,
          permalink: null,
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

    // Real mode: CV v5 accepts one reel per POST. Loop and collect results.
    const accepted: ReelScheduleAccepted[] = [];
    const rejected: ReelScheduleRejected[] = [];
    for (const r of reels) {
      const body = {
        connected_account_id: r.connected_account_id,
        video_url: r.video_url,
        scheduled_for: r.scheduled_for,
        caption: r.caption ?? "",
        cover_url: r.cover_url,
        share_to_feed: r.share_to_feed ?? true,
        client_ref: r.client_ref,
      };
      let res: Response;
      try {
        res = await cvFetch("/bridge/reels/schedule", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (e: any) {
        rejected.push({ client_ref: r.client_ref, error: "network_error", detail: String(e?.message ?? e) });
        continue;
      }
      if (res.status === 201 || res.status === 200) {
        const dto = (await res.json().catch(() => ({}))) as Partial<ReelStatus>;
        const id = String(dto.cv_reel_id ?? "");
        if (!id) {
          rejected.push({ client_ref: r.client_ref, error: "bad_response", detail: "missing cv_reel_id" });
          continue;
        }
        accepted.push({ client_ref: r.client_ref, cv_reel_id: id, status: String(dto.status ?? "pending") });
      } else {
        const err = await readCvError(res);
        rejected.push({
          client_ref: r.client_ref,
          error: err.error,
          detail: err.request_id ? `${err.message} (request_id=${err.request_id})` : err.message,
        });
      }
    }
    return { accepted, rejected };
  },

  async getReel(cvReelId: string): Promise<ReelStatus | null> {
    if (CV_STUB) {
      const row = stubStore.get(cvReelId);
      if (!row) return null;
      return {
        cv_reel_id: row.cv_reel_id,
        client_ref: row.client_ref,
        external_user_id: row.external_user_id,
        connected_account_id: row.connected_account_id,
        status: row.status,
        scheduled_for: row.scheduled_for,
        ig_media_id: row.ig_media_id,
        permalink: row.permalink,
        published_at: row.published_at,
        last_error: row.last_error,
        attempts: row.attempts,
      };
    }
    const res = await cvFetch(`/bridge/reels/${encodeURIComponent(cvReelId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = await readCvError(res);
      throw new Error(`cv_bridge_get_failed status=${res.status} error=${err.error} msg=${err.message}`);
    }
    return (await res.json()) as ReelStatus;
  },

  /**
   * List reels. CV v5 filters by connected_account_id (per IG), NOT external_user_id.
   * We resolve external_user_id -> a set of account ids at the call site (reconcile
   * tick), then loop this per account and merge.
   */
  async listReels(params: {
    connected_account_id?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: ReelStatus[]; next_cursor?: string | null }> {
    if (CV_STUB) {
      const items = Array.from(stubStore.values())
        .filter((r) => !params.connected_account_id || r.connected_account_id === params.connected_account_id)
        .filter((r) => {
          if (!params.status) return true;
          const wanted = params.status.split(",");
          return wanted.includes(r.status);
        })
        .map((r) => ({
          cv_reel_id: r.cv_reel_id,
          client_ref: r.client_ref,
          external_user_id: r.external_user_id,
          connected_account_id: r.connected_account_id,
          status: r.status,
          scheduled_for: r.scheduled_for,
          ig_media_id: r.ig_media_id,
          permalink: r.permalink,
          published_at: r.published_at,
          last_error: r.last_error,
          attempts: r.attempts,
        }));
      return { items, next_cursor: null };
    }
    const qs = new URLSearchParams();
    if (params.connected_account_id) qs.set("connected_account_id", params.connected_account_id);
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const res = await cvFetch(`/bridge/reels?${qs.toString()}`);
    if (!res.ok) {
      const err = await readCvError(res);
      throw new Error(`cv_bridge_list_failed status=${res.status} error=${err.error} msg=${err.message}`);
    }
    // CV v5 returns { reels, next_cursor }. Map to our internal {items, next_cursor}.
    const json = (await res.json()) as { reels?: ReelStatus[]; items?: ReelStatus[]; next_cursor?: string | null };
    const items = json.reels ?? json.items ?? [];
    return { items, next_cursor: json.next_cursor ?? null };
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
    // CV v5 uses POST /:id/cancel, not DELETE.
    const res = await cvFetch(`/bridge/reels/${encodeURIComponent(cvReelId)}/cancel`, {
      method: "POST",
    });
    if (res.status === 409) return { ok: false, reason: "already_terminal" };
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) {
      const err = await readCvError(res);
      throw new Error(`cv_bridge_cancel_failed status=${res.status} error=${err.error} msg=${err.message}`);
    }
    return { ok: true };
  },

  // Test helper: force-advance a stubbed reel to a terminal status. No-op when CV_STUB=0.
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
