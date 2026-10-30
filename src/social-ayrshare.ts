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
import { SocialError, type PublishRequest, type PublishResult, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult, type SocialWebhook } from "./social-provider.js";

const BASE = "https://api.ayrshare.com/api";

type AyrError = { code?: number; message?: string; platform?: string; status?: string };

/** One network's outcome from an Ayrshare postIds / errors entry. */
function resultsOf(postIds: any[] | undefined, errors: AyrError[] | undefined, platforms: string[], scheduled: boolean): SocialResult[] {
  const out = new Map<string, SocialResult>();
  for (const p of postIds ?? []) {
    const platform = String(p?.platform ?? "");
    if (!platform) continue;
    const id = String(p?.id ?? "");
    const st = String(p?.status ?? "");
    const status: SocialResult["status"] = st === "error" || id === "failed" ? "failed" : id === "pending" || st === "pending" ? "pending" : st === "success" ? "posted" : scheduled ? "scheduled" : "pending";
    out.set(platform, { platform, status, url: p?.postUrl ? String(p.postUrl) : null, error: null });
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
  return String(e?.message ?? "The network refused the post").replace(/ayrshare/gi, "the posting service").slice(0, 240);
}

/** A post's overall status from its networks: pending ones keep it open. */
export function statusOf(results: SocialResult[], scheduled: boolean): SocialEvent["status"] {
  if (!results.length) return "failed";
  const n = results.length, ok = results.filter((r) => r.status === "posted").length, bad = results.filter((r) => r.status === "failed").length;
  if (bad === n) return "failed";
  if (ok === n) return "posted";
  if (ok + bad === n) return "partial";
  return scheduled ? "scheduled" : "sending";
}

/** Verify an Ayrshare webhook signature: HMAC-SHA256 hex of the raw body, any v1= value may match (secret rotation). */
export function verifySignature(rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean {
  const want = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
  const candidates = [h("X-Authorization-Content-SHA256"), ...String(h("X-Authorization-Content-SHA256-V2") ?? "").split(",").map((x) => x.trim().replace(/^v1=/, ""))].filter(Boolean) as string[];
  const a = Buffer.from(want, "hex");
  return candidates.some((c) => { const b = Buffer.from(c, "hex"); return b.length === a.length && timingSafeEqual(a, b); });
}

export function ayrshareProvider(deps: SocialDeps = {}): SocialProvider | null {
  const env = deps.env ?? process.env;
  const key = env.AYRSHARE_API_KEY;
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  const xHeaders: Record<string, string> = env.AYRSHARE_X_API_KEY && env.AYRSHARE_X_API_SECRET ? { "X-Twitter-OAuth1-Api-Key": env.AYRSHARE_X_API_KEY, "X-Twitter-OAuth1-Api-Secret": env.AYRSHARE_X_API_SECRET } : {};
  const call = async (method: string, path: string, opts: { profileKey?: string; body?: any } = {}): Promise<any> => {
    const r = await f(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.profileKey ? { "Profile-Key": opts.profileKey } : {}), ...xHeaders },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok && r.status !== 400) throw new SocialError(r.status === 429 ? "provider_busy" : "provider_failed", `posting service ${r.status}: ${String(j?.message ?? text).slice(0, 200)}`, r.status === 429 ? 429 : 502);
    return { status: r.status, body: j ?? {} };
  };
  const offered = (): string[] => ["tiktok", "instagram", "youtube", "facebook", "linkedin", "threads", "bluesky", ...(xHeaders["X-Twitter-OAuth1-Api-Key"] ? ["twitter"] : [])];

  return {
    name: "ayrshare",
    offered,

    async createProfile(title) {
      const r = await call("POST", "/profiles", { body: { title, hideLogo: true, topHeader: "Clone8", subHeader: "Link the accounts you want to post to from Clone8" } });
      if (r.status === 400 || !r.body?.profileKey) {
        if (Number(r.body?.code) === 146) throw new SocialError("profile_title_taken", "A profile with that title already exists", 409);
        throw new SocialError("profile_failed", String(r.body?.message ?? "Could not create a posting profile").slice(0, 200), 502);
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
      if (r.status === 400 || !r.body?.url) throw new SocialError("link_failed", String(r.body?.message ?? "Could not open the linking page").slice(0, 200), 502);
      const exp = r.body.expiresAt ? Math.max(1, Math.round((Date.parse(r.body.expiresAt) - Date.now()) / 60_000)) : 5;
      return { url: String(r.body.url), expiresInMinutes: exp };
    },

    async accounts(profileKey) {
      const r = await call("GET", "/user", { profileKey });
      if (r.status === 400) throw new SocialError("accounts_failed", String(r.body?.message ?? "Could not read the linked accounts"), 502);
      const active = new Set<string>((r.body?.activeSocialAccounts ?? []).map(String));
      return ((r.body?.displayNames ?? []) as any[]).filter((d) => active.has(String(d?.platform))).map((d): SocialAccount => ({
        platform: String(d.platform),
        username: d.platform === "youtube" ? (d.handle ?? d.channelTitle ?? d.username ?? null) : (d.username ?? null),
        display_name: d.platform === "youtube" ? (d.channelTitle ?? d.displayName ?? null) : (d.displayName ?? null),
        image_url: d.userImage ?? null,
        profile_url: d.profileUrl ?? null,
        refresh_required: d.refreshRequired === true,
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
      const r = await call("POST", "/post", { profileKey, body });
      const p = Array.isArray(r.body?.posts) ? r.body.posts[0] : r.body;
      const errors: AyrError[] = [...(p?.errors ?? []), ...(r.body?.errors ?? [])];
      const results = resultsOf(p?.postIds, errors, req.platforms, scheduled);
      const id = p?.id ? String(p.id) : null;
      if (!id) return { providerPostId: null, status: "failed", results, error: errors.length ? friendlyError(errors[0]) : String(r.body?.message ?? "The post was refused").slice(0, 240) };
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
      if (r.status === 400 && ![114, 383].includes(Number(r.body?.code))) throw new SocialError("cancel_failed", String(r.body?.message ?? "Could not cancel").slice(0, 200), 502);
    },

    async registerWebhook(profileKey, url) {
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      for (const action of ["scheduled", "social"]) {
        const r = await call("POST", "/hook/webhook", { profileKey, body: { action, url, ...(secret ? { secret } : {}) } });
        if (r.status === 400) throw new SocialError("webhook_failed", String(r.body?.message ?? "Could not register the webhook").slice(0, 200), 502);
      }
    },

    parseWebhook(headers, rawBody): SocialWebhook | null {
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      if (secret && !verifySignature(rawBody, headers, secret)) throw new SocialError("webhook_unverified", "Signature mismatch", 401);
      let b: any;
      try { b = JSON.parse(rawBody || "{}"); } catch { return null; }
      if (b?.action === "scheduled" && b?.id) {
        const platforms = ((b.postIds ?? []) as any[]).map((p) => String(p.platform)).concat(((b.errors ?? []) as any[]).map((e) => String(e.platform ?? ""))).filter(Boolean);
        const results = resultsOf(b.postIds, b.errors, [...new Set(platforms)], false);
        const status = b.status === "error" && !results.some((x) => x.status === "posted") ? "failed" : statusOf(results, false);
        return { kind: "post", event: { providerPostId: String(b.id), status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null } };
      }
      if (b?.action === "social" && b?.refId && b?.platform) return { kind: "account", refId: String(b.refId), platform: String(b.platform), change: b.type === "unlink" ? "unlink" : b.type === "refresh" ? "refresh" : "link", bySystem: b.source === "system" };
      return null;
    },
  };
}
