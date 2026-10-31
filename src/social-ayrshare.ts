// Ayrshare behind the SocialProvider interface (social-provider.ts). Read from Ayrshare's docs on Oct 30, 2026:
//   - one User Profile per person (POST /profiles); its profileKey goes in the Profile-Key header and cannot be read back
//   - linking happens on Ayrshare's hosted page from a link session (POST /profiles/link-sessions, valid 5 minutes);
//     the older generateJWT is deprecated and the integration package's private key is no longer used
//   - posts: POST /post (scheduleDate in UTC, idempotencyKey per profile), GET /post/:id, DELETE /post
//   - webhooks: POST /hook/webhook per profile, signed with HMAC-SHA256 (hex) of the raw body using our secret
//   - X needs the account's own X API credentials since March 31, 2026; without them X is not offered
// Env: AYRSHARE_API_KEY (required), AYRSHARE_DOMAIN (optional), STUDIO_SOCIAL_WEBHOOK_SECRET (signing secret),
// AYRSHARE_X_API_KEY / AYRSHARE_X_API_SECRET (optional, to offer X).
import { createHmac, timingSafeEqual } from "node:crypto";
import { SocialError, statusOf, type ProviderAccountStats, type ProviderPost, type PublishRequest, type PublishResult, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult, type SocialWebhook } from "./social-provider.js";

const BASE = "https://api.ayrshare.com/api";

type AyrError = { code?: number; message?: string; platform?: string; status?: string };
/** A link we show the person: https only, nothing else (a forged or odd value never becomes a clickable link). */
export const safeUrl = (v: any): string | null => { if (typeof v !== "string" || v.length > 2048) return null; try { const u = new URL(v); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };
/** The vendor never reaches a person: its name is replaced in anything it says. */
const clean = (v: any, fallback: string) => String(v ?? fallback).replace(/ayrshare/gi, "the posting service").slice(0, 240);

/** One network's outcome from an Ayrshare postIds / errors entry. */
function resultsOf(postIds: any[] | undefined, errors: AyrError[] | undefined, platforms: string[], scheduled: boolean): SocialResult[] {
  const out = new Map<string, SocialResult>();
  for (const p of postIds ?? []) {
    const platform = String(p?.platform ?? "");
    if (!platform) continue;
    const id = String(p?.id ?? "");
    const st = String(p?.status ?? "");
    const status: SocialResult["status"] = st === "error" || id === "failed" ? "failed" : id === "pending" || st === "pending" ? "pending" : st === "success" ? "posted" : scheduled ? "scheduled" : "pending";
    out.set(platform, { platform, status, url: safeUrl(p?.postUrl), error: null });
  }
  for (const e of errors ?? []) {
    const platform = String(e?.platform ?? "");
    if (!platform) continue;
    out.set(platform, { platform, status: "failed", url: null, error: friendlyError(e) });
  }
  for (const p of platforms) if (!out.has(p)) out.set(p, { platform: p, status: scheduled ? "scheduled" : "pending", url: null, error: null });
  return [...out.values()];
}

/** What a person reads when a network refuses: relink cases say so, the rest keep the network's own words. */
export function friendlyError(e: AyrError): string {
  const code = Number(e?.code);
  const name = e?.platform ? e.platform.charAt(0).toUpperCase() + e.platform.slice(1) : "That network";
  if (code === 156) return `${name} is not linked. Link it in Accounts.`;
  if ([161, 250, 272].includes(code)) return `${name} needs to be linked again. Relink it in Accounts, then retry.`;
  if (code === 106) return "The monthly post limit is used up; it resets on the 1st.";
  if (code === 176) return "The YouTube title is too long (100 characters at most).";
  return clean(e?.message, "The network refused the post");
}

/** A post's overall status from its networks (kept in social-provider.ts, re-exported for the tests). */
export { statusOf };

/** Verify an Ayrshare webhook signature: HMAC-SHA256 hex of the raw body, any v1= value may match (secret rotation). */
export function verifySignature(rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean {
  const want = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
  const candidates = [h("X-Authorization-Content-SHA256"), ...String(h("X-Authorization-Content-SHA256-V2") ?? "").split(",").map((x) => x.trim().replace(/^v1=/, ""))].filter(Boolean) as string[];
  const a = Buffer.from(want, "hex");
  return candidates.some((c) => { const b = Buffer.from(c, "hex"); return b.length === a.length && timingSafeEqual(a, b); });
}


// ---------------------------------------------------------------------------------------------------
// Analytics (docs Oct 30, 2026): GET /history/:platform lists every post on the account, also those published natively;
// TikTok items carry their analytics, others are read with POST /analytics/post {postIds, platforms:[one],
// searchPlatformId:true}; POST /analytics/social gives followers. Metrics settle 24-48 h after posting.
// ---------------------------------------------------------------------------------------------------
const nn = (v: any) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const isoOf = (v: any) => { if (!v) return null; const t = typeof v === "number" ? (v > 1e12 ? v : v * 1000) : Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
/** The retention curve kept small: the share still watching at a few seconds that matter, and the share at 3 s. */
export function retentionOf(curve: any): { retention: Array<[number, number]>; hold_3s: number | null } {
  const pts = (Array.isArray(curve) ? curve : []).map((p: any) => [nn(p?.second), nn(p?.percentage)] as [number | null, number | null]).filter((p): p is [number, number] => p[0] != null && p[1] != null).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return { retention: [], hold_3s: null };
  const scale = pts.some((p) => p[1] > 1.5) ? 1 / 100 : 1;
  const at = (s: number) => { const p = pts.filter((x) => x[0] <= s).at(-1); return p ? p[1] * scale : null; };
  const keep = [1, 2, 3, 5, 10, 15, 30, 60].filter((s) => s <= pts.at(-1)![0]).map((s) => [s, Math.round((at(s) ?? 0) * 1000) / 1000] as [number, number]);
  const h = at(3);
  return { retention: keep, hold_3s: h == null ? null : Math.round(h * 1000) / 1000 };
}
/** Every object in a response that carries an `analytics` block, with its id. */
function analyticsEntries(body: any): Array<{ id: string | null; postUrl: string | null; a: any }> {
  const out: Array<{ id: string | null; postUrl: string | null; a: any }> = [];
  const walk = (x: any) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } if (x.analytics && typeof x.analytics === "object") out.push({ id: x.id ? String(x.id) : null, postUrl: x.postUrl ?? null, a: x.analytics }); else for (const v of Object.values(x)) walk(v); };
  walk(body);
  return out;
}
/** Network analytics mapped onto one shape. */
export function metricsOf(platform: string, a: any): Omit<ProviderPost, "platform" | "id" | "url" | "caption" | "published_at" | "thumb_url"> {
  if (platform === "tiktok") {
    const r = retentionOf(a.videoViewRetention);
    const fyp = (Array.isArray(a.impressionSources) ? a.impressionSources : []).find((s: any) => /for_you|fyp|for you/i.test(String(s?.impression_source ?? "")));
    return { duration_s: nn(a.videoDuration), views: nn(a.videoViews), likes: nn(a.likeCount), comments: nn(a.commentsCount), shares: nn(a.shareCount), saves: null,
      extra: { reach: nn(a.reach), avg_watch_s: nn(a.averageTimeWatched), full_watch_rate: nn(a.fullVideoWatchedRate), ...r, fyp_share: fyp ? nn(fyp.percentage) : null } };
  }
  if (platform === "instagram") {
    const avg = nn(a.igReelsAvgWatchTimeCount);
    return { duration_s: null, views: nn(a.viewsCount ?? a.playsCount ?? a.igReelsAggregatedAllPlaysCount), likes: nn(a.likeCount), comments: nn(a.commentsCount), shares: nn(a.sharesCount), saves: nn(a.savedCount),
      extra: { reach: nn(a.reachCount), avg_watch_s: avg == null ? null : avg > 600 ? avg / 1000 : avg, replays: nn(a.clipsReplaysCount), follows: nn(a.followsCount) } };
  }
  if (platform === "youtube") {
    return { duration_s: null, views: nn(a.views), likes: nn(a.likes), comments: nn(a.comments), shares: nn(a.shares), saves: null,
      extra: { engaged_views: nn(a.engagedViews), avg_watch_s: nn(a.averageViewDuration), avg_view_pct: nn(a.averageViewPercentage), subscribers_gained: nn(a.subscribersGained) } };
  }
  return { duration_s: null, views: nn(a.views ?? a.videoViews ?? a.impressionCount), likes: nn(a.likeCount ?? a.likes), comments: nn(a.commentsCount ?? a.commentCount ?? a.replies), shares: nn(a.sharesCount ?? a.shareCount ?? a.reposts), saves: null, extra: {} };
}

export function ayrshareProvider(deps: SocialDeps = {}): SocialProvider | null {
  const env = deps.env ?? process.env;
  const key = env.AYRSHARE_API_KEY;
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  const xHeaders: Record<string, string> = env.AYRSHARE_X_API_KEY && env.AYRSHARE_X_API_SECRET ? { "X-Twitter-OAuth1-Api-Key": env.AYRSHARE_X_API_KEY, "X-Twitter-OAuth1-Api-Secret": env.AYRSHARE_X_API_SECRET } : {};
  // Every call has a time limit. A failure where the service may still have acted (no answer, a timeout, a 5xx) is
  // "unknown", never "refused": a post with an unknown outcome must not be sent again as if it never went.
  const call = async (method: string, path: string, opts: { profileKey?: string; body?: any; timeoutMs?: number; any?: boolean } = {}): Promise<any> => {
    let r: Response;
    try {
      r = await f(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.profileKey ? { "Profile-Key": opts.profileKey } : {}), ...xHeaders },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e: any) {
      throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true });
    }
    let text = "";
    try { text = await r.text(); } catch { throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true }); }
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (opts.any || r.ok || r.status === 400) return { status: r.status, body: j ?? {} };
    const first: AyrError | undefined = Array.isArray(j?.errors) ? j.errors[0] : j?.code ? j : undefined;
    const msg = first ? friendlyError(first) : clean(j?.message, `The posting service answered ${r.status}`);
    if (r.status >= 500) throw Object.assign(new SocialError("provider_failed", msg, 502), { unknown: true });
    throw new SocialError(r.status === 429 ? "provider_busy" : "provider_refused", msg, r.status === 429 ? 429 : 502);
  };
  const offered = (): string[] => ["tiktok", "instagram", "youtube", "facebook", "linkedin", "threads", "bluesky", ...(xHeaders["X-Twitter-OAuth1-Api-Key"] ? ["twitter"] : [])];

  return {
    name: "ayrshare",
    offered,

    async createProfile(title) {
      const r = await call("POST", "/profiles", { body: { title, hideLogo: true, topHeader: "Clone8", subHeader: "Link the accounts you want to post to from Clone8" } });
      if (r.status === 400 || !r.body?.profileKey) {
        if (Number(r.body?.code) === 146) throw new SocialError("profile_title_taken", "A profile with that title already exists", 409);
        throw new SocialError("profile_failed", clean(r.body?.message, "Could not create a posting profile"), 502);
      }
      return { profileKey: String(r.body.profileKey), refId: r.body.refId ? String(r.body.refId) : null };
    },

    async deleteProfile(profileKey) { await call("DELETE", "/profiles", { profileKey }); },

    async connectUrl(profileKey, opts = {}) {
      const body: Record<string, any> = { allowedSocial: offered() };
      if (opts.redirect) body.redirect = opts.redirect;
      if (opts.origin) body.origin = opts.origin;
      if (env.AYRSHARE_DOMAIN) body.domain = env.AYRSHARE_DOMAIN;
      const r = await call("POST", "/profiles/link-sessions", { profileKey, body });
      if (r.status === 400 || !r.body?.url) throw new SocialError("link_failed", clean(r.body?.message, "Could not open the linking page"), 502);
      const exp = r.body.expiresAt ? Math.max(1, Math.round((Date.parse(r.body.expiresAt) - Date.now()) / 60_000)) : 5;
      return { url: String(r.body.url), expiresInMinutes: exp };
    },

    async accounts(profileKey) {
      const r = await call("GET", "/user", { profileKey });
      if (r.status === 400) throw new SocialError("accounts_failed", clean(r.body?.message, "Could not read the linked accounts"), 502);
      const active = new Set<string>((r.body?.activeSocialAccounts ?? []).map(String));
      return ((r.body?.displayNames ?? []) as any[]).filter((d) => active.has(String(d?.platform))).map((d): SocialAccount => ({
        platform: String(d.platform),
        username: d.platform === "youtube" ? (d.handle ?? d.channelTitle ?? d.username ?? null) : (d.username ?? null),
        display_name: d.platform === "youtube" ? (d.channelTitle ?? d.displayName ?? null) : (d.displayName ?? null),
        image_url: safeUrl(d.userImage),
        profile_url: safeUrl(d.profileUrl),
        // a date (or true) once the network wants the link renewed; due when it has passed or no days remain
        refresh_required: d.refreshRequired === true || (typeof d.refreshRequired === "string" && Date.parse(d.refreshRequired) <= Date.now()) || (d.refreshDaysRemaining != null && Number(d.refreshDaysRemaining) <= 0),
      }));
    },

    async disconnect(profileKey, platform) {
      // Without Profile-Key Ayrshare unlinks the account's own network, so the key is always sent.
      if (!profileKey) throw new SocialError("not_connected", "No profile", 404);
      await call("DELETE", "/profiles/social", { profileKey, body: { platform } });
    },

    async publish(profileKey, req: PublishRequest): Promise<PublishResult> {
      const scheduled = !!req.scheduleAt;
      const body: Record<string, any> = { post: req.text, platforms: req.platforms, mediaUrls: [req.mediaUrl], isVideo: true };
      if (req.idempotencyKey) body.idempotencyKey = req.idempotencyKey;
      if (req.scheduleAt) body.scheduleDate = req.scheduleAt.toISOString().replace(/\.\d{3}Z$/, "Z");
      if (req.platforms.includes("youtube")) {
        const yt = req.options?.youtube ?? {};
        // YouTube refuses titles over 100 code points (error 176) and defaults to private.
        body.youTubeOptions = { title: Array.from(String(yt.title || req.text || "New video")).slice(0, 100).join(""), visibility: yt.visibility ?? "public", shorts: true };
      }
      if (req.platforms.includes("instagram")) body.instagramOptions = { shareReelsFeed: true };
      if (req.platforms.includes("tiktok")) body.tikTokOptions = { visibility: "public", isAIGenerated: true };
      // A video post can take a while (the service checks the file; some networks answer slowly).
      const r = await call("POST", "/post", { profileKey, body, timeoutMs: 150_000, any: true });
      const p = Array.isArray(r.body?.posts) ? r.body.posts[0] : r.body;
      if (r.status >= 500 && !p?.id) throw Object.assign(new SocialError("provider_failed", "The posting service had a problem", 502), { unknown: true });
      if ((r.status < 200 || r.status >= 300) && r.status !== 400 && r.status < 500 && !p?.id) {
        const e0: AyrError | undefined = (p?.errors ?? r.body?.errors ?? [])[0] ?? (r.body?.code ? r.body : undefined);
        return { providerPostId: null, status: "failed", results: resultsOf([], [], req.platforms, scheduled).map((x) => ({ ...x, status: "failed" as const })), error: e0 ? friendlyError(e0) : clean(r.body?.message, "The post was refused") };
      }
      const errors: AyrError[] = p === r.body ? [...(p?.errors ?? [])] : [...(p?.errors ?? []), ...(r.body?.errors ?? [])];
      const results = resultsOf(p?.postIds, errors, req.platforms, scheduled);
      const id = p?.id ? String(p.id) : null;
      if (!id) return { providerPostId: null, status: "failed", results, error: errors.length ? friendlyError(errors[0]) : clean(r.body?.message, "The post was refused") };
      const status = scheduled && p?.status === "scheduled" ? "scheduled" : statusOf(results, scheduled);
      return { providerPostId: id, status, results, error: status === "failed" && errors.length ? friendlyError(errors[0]) : null };
    },

    async status(profileKey, providerPostId) {
      const r = await call("GET", `/post/${encodeURIComponent(providerPostId)}`, { profileKey });
      if (r.status === 400) return null;
      const b = r.body ?? {};
      const platforms: string[] = (b.platforms ?? []).map(String);
      const future = b.scheduleDate && Date.parse(b.scheduleDate) > Date.now();
      if (b.status === "deleted") return { providerPostId, status: "canceled", results: resultsOf(b.postIds, b.errors, platforms, false), error: null };
      if (b.status === "pending" && future) return { providerPostId, status: "scheduled", results: resultsOf(b.postIds, b.errors, platforms, true), error: null };
      const results = resultsOf(b.postIds, b.errors, platforms, false);
      const status = b.status === "error" && !results.some((x) => x.status === "posted") ? "failed" : statusOf(results, false);
      return { providerPostId, status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null };
    },

    async cancel(profileKey, providerPostId) {
      const r = await call("DELETE", "/post", { profileKey, body: { id: providerPostId } });
      if (r.status === 400 && ![114, 383].includes(Number(r.body?.code))) throw new SocialError("cancel_failed", clean(r.body?.message, "Could not cancel"), 502);
    },

    async registerWebhook(profileKey, url) {
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      for (const action of ["scheduled", "social"]) {
        const r = await call("POST", "/hook/webhook", { profileKey, body: { action, url, ...(secret ? { secret } : {}) } });
        if (r.status === 400) throw new SocialError("webhook_failed", clean(r.body?.message, "Could not register the webhook"), 502);
      }
    },

    async recentPosts(profileKey, platform, limit): Promise<ProviderPost[]> {
      const r = await call("GET", `/history/${encodeURIComponent(platform)}?limit=${Math.min(Math.max(limit, 1), 100)}`, { profileKey });
      if (r.status === 400) throw new SocialError("history_failed", clean(r.body?.message, "Could not read the posts"), 502);
      const items: any[] = Array.isArray(r.body?.posts) ? r.body.posts : [];
      const posts: ProviderPost[] = items.filter((x) => x?.id).map((x) => ({
        platform, id: String(x.id), url: safeUrl(x.postUrl ?? x.permalink ?? x.url), caption: x.post ?? x.caption ?? x.title ?? null,
        published_at: isoOf(x.created ?? x.published ?? x.publishedAt), thumb_url: safeUrl(x.thumbnailUrl ?? x.thumbnail_url ?? x.coverImageUrl) ,
        ...metricsOf(platform, x),
      }));
      // only TikTok's list carries its analytics; the rest are read in one batch by their network ids
      if (platform !== "tiktok" && posts.length) {
        const a = await call("POST", "/analytics/post", { profileKey, body: { postIds: posts.map((p) => p.id), platforms: [platform], searchPlatformId: true } }).catch(() => null);
        const byId = new Map(analyticsEntries(a?.body).map((e) => [e.id, e]));
        for (const p of posts) {
          const e = byId.get(p.id); if (!e) continue;
          const m = metricsOf(platform, e.a);
          Object.assign(p, { views: m.views ?? p.views, likes: m.likes ?? p.likes, comments: m.comments ?? p.comments, shares: m.shares ?? p.shares, saves: m.saves ?? p.saves, duration_s: m.duration_s ?? p.duration_s, extra: { ...p.extra, ...Object.fromEntries(Object.entries(m.extra).filter(([, v]) => v != null)) }, url: p.url ?? safeUrl(e.postUrl) });
          if (e.a?.thumbnailUrl && !p.thumb_url) p.thumb_url = safeUrl(e.a.thumbnailUrl);
        }
      }
      return posts.filter((p) => p.url);
    },

    async accountStats(profileKey, platforms): Promise<ProviderAccountStats[]> {
      const r = await call("POST", "/analytics/social", { profileKey, body: { platforms } });
      return platforms.map((platform) => {
        const blk = r.body?.[platform]; const a = blk?.analytics ?? blk ?? {};
        const followers = nn(a.followerCount ?? a.followersCount ?? a.subscriberCount ?? a.followers?.totalFollowerCount);
        return { platform, followers, extra: { profile_views: nn(a.profileViews), views_total: nn(a.viewCountTotal ?? a.viewCount ?? a.viewsCount), reach: nn(a.reachCount) } };
      });
    },

    parseWebhook(headers, rawBody): SocialWebhook | null {
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      // fail closed: without our signing secret no delivery is trusted
      if (!secret) throw new SocialError("webhook_unconfigured", "No signing secret", 401);
      if (!verifySignature(rawBody, headers, secret)) throw new SocialError("webhook_unverified", "Signature mismatch", 401);
      let b: any;
      try { b = JSON.parse(rawBody || "{}"); } catch { return null; }
      if (b?.action === "scheduled" && b?.id) {
        const platforms = ((b.postIds ?? []) as any[]).map((p) => String(p.platform)).concat(((b.errors ?? []) as any[]).map((e) => String(e.platform ?? ""))).filter(Boolean);
        const results = resultsOf(b.postIds, b.errors, [...new Set(platforms)], false);
        const status = b.status === "error" && !results.some((x) => x.status === "posted") ? "failed" : statusOf(results, false);
        // a delivery can carry only some of the networks (TikTok reports on its own): the row merges by network
        return { kind: "post", event: { providerPostId: String(b.id), status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null, partial: true } };
      }
      if (b?.action === "social" && b?.refId && b?.platform) return { kind: "account", refId: String(b.refId), platform: String(b.platform), change: b.type === "unlink" ? "unlink" : b.type === "refresh" ? "refresh" : "link", bySystem: b.source === "system" };
      return null;
    },
  };
}
