// Publer API client + helpers.
// Docs: https://publer.com/docs/api-reference/introduction.md
//
// Auth: header "Authorization: Bearer-API <API_KEY>" + "Publer-Workspace-Id: <WS>"
// Rate limit: 100 requests / 2 minutes / user. We stay well under.

const BASE = "https://app.publer.com/api/v1";

function apiKey(): string {
  const k = process.env.PUBLER_API_KEY;
  if (!k) throw new Error("PUBLER_API_KEY not set");
  return k;
}

async function pubFetch(
  path: string,
  init: RequestInit & { workspaceId?: string } = {},
): Promise<any> {
  const { workspaceId, headers, ...rest } = init;
  const h: Record<string, string> = {
    Authorization: `Bearer-API ${apiKey()}`,
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (workspaceId) h["Publer-Workspace-Id"] = workspaceId;
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const resp = await fetch(url, { ...rest, headers: h });
  const text = await resp.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) {
    const err = new Error(
      `publer ${rest.method || "GET"} ${path} -> ${resp.status}: ${
        typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)
      }`,
    );
    (err as any).status = resp.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

export interface PublerAccount {
  id: string;
  provider: string;
  name: string;
  type: string;
  username?: string;
}

export async function listAccounts(workspaceId: string): Promise<PublerAccount[]> {
  return await pubFetch("/accounts", { workspaceId });
}

export async function me(): Promise<any> {
  return await pubFetch("/users/me");
}

// --- Media -------------------------------------------------------------------

/**
 * Upload media from URL. Async; returns { job_id }.
 * We wait on job_status to get the persisted media id + path.
 */
export async function uploadFromUrl(
  workspaceId: string,
  url: string,
  name: string,
): Promise<{ jobId: string }> {
  const body = {
    media: [{ url, name }],
    type: "single",
    direct_upload: true,   // stores in Publer's own S3 so publish is reliable
    in_library: false,
  };
  const r = await pubFetch("/media/from-url", {
    method: "POST",
    workspaceId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { jobId: r.job_id };
}

export interface JobStatus {
  status: string;              // "working" | "complete" | "failed"
  payload?: any;
}

export async function jobStatus(jobId: string, workspaceId?: string): Promise<JobStatus> {
  return await pubFetch(`/job_status/${jobId}`, { workspaceId });
}

/** Poll a job until complete or timeout. Returns final payload. */
export async function waitForJob(
  jobId: string,
  { timeoutMs = 120_000, intervalMs = 2000, workspaceId }: { timeoutMs?: number; intervalMs?: number; workspaceId?: string } = {},
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await jobStatus(jobId, workspaceId);
    const s = String(j.status || "").toLowerCase();
    if (s === "complete" || s === "completed") return j.payload;
    if (s === "failed") throw new Error(`publer job ${jobId} failed: ${JSON.stringify(j.payload)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`publer job ${jobId} timed out after ${timeoutMs}ms`);
}

// --- Publish -----------------------------------------------------------------

export interface PublishInput {
  workspaceId: string;
  accountId: string;
  provider: "instagram" | "tiktok";
  text: string;
  mediaId: string;
  mediaPath: string;      // URL to the video Publer stored
  thumbnailPath?: string; // real thumb URL (optional but recommended)
}

/**
 * Immediate publish. Returns { job_id }.
 * On success, poll job_status; payload contains created post ids.
 */
export async function publishNow(input: PublishInput): Promise<{ jobId: string }> {
  const { workspaceId, accountId, provider, text, mediaId, mediaPath, thumbnailPath } = input;

  const media: any = {
    id: mediaId,
    path: mediaPath,
    type: "video",
  };
  if (thumbnailPath) {
    media.thumbnails = [{ real: thumbnailPath, small: thumbnailPath }];
    media.default_thumbnail = 0;
  }

  let network: any;
  if (provider === "instagram") {
    network = {
      instagram: {
        type: "video",
        text,
        media: [media],
        details: { type: "reel", feed: false },
      },
    };
  } else if (provider === "tiktok") {
    network = {
      tiktok: {
        type: "video",
        text,
        media: [media],
        details: {
          privacy: "PUBLIC_TO_EVERYONE",
          comment: true,
          duet: true,
          stitch: true,
          promotional: false,
          paid: false,
        },
      },
    };
  } else {
    throw new Error(`unsupported provider: ${provider}`);
  }

  const body = {
    bulk: {
      state: "scheduled",
      posts: [
        {
          networks: network,
          accounts: [{ id: accountId }], // no scheduled_at => immediate
        },
      ],
    },
  };

  const r = await pubFetch("/posts/schedule/publish", {
    method: "POST",
    workspaceId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { jobId: r.job_id };
}

// --- Posts / analytics -------------------------------------------------------

export async function listPosts(
  workspaceId: string,
  params: { state?: string; accountId?: string; from?: string; to?: string; page?: number } = {},
): Promise<any> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.accountId) qs.append("account_ids[]", params.accountId);
  return await pubFetch(`/posts?${qs.toString()}`, { workspaceId });
}

export interface PostInsight {
  id: string;
  text?: string;
  scheduled_at?: string;
  post_type?: string;
  account_id?: string;
  post_link?: string;
  analytics?: {
    reach?: number;
    engagement?: number;
    engagement_rate?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    video_views?: number;
    link_clicks?: number;
    post_clicks?: number;
    click_through_rate?: number;
    reach_rate?: number;
  };
}

/**
 * Post insights for an account within a window.
 * Endpoint: GET /analytics/:account_id/post_insights?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function postInsights(
  workspaceId: string,
  accountId: string,
  fromISODate: string,
  toISODate: string,
  opts: { page?: number; sortBy?: string; sortType?: "ASC" | "DESC" } = {},
): Promise<{ posts: PostInsight[]; total: number }> {
  const qs = new URLSearchParams({ from: fromISODate, to: toISODate });
  if (opts.page !== undefined) qs.set("page", String(opts.page));
  if (opts.sortBy) qs.set("sort_by", opts.sortBy);
  if (opts.sortType) qs.set("sort_type", opts.sortType);
  return await pubFetch(`/analytics/${accountId}/post_insights?${qs.toString()}`, { workspaceId });
}
