// Zernio behind the SocialProvider interface (social-provider.ts). Owner's decision Nov 21 2026: Zernio replaces
// Ayrshare. Read from Zernio's docs and tested with a real account on Nov 21 2026 (ops/zernio-test):
//   - one profile per person (POST /profiles, externalId = our user id); accounts are linked per network with
//     GET /connect/{platform} (one link per network, unlike Ayrshare's single page). Several accounts of one network
//     may sit in a profile; Clone8 keeps one per network for now.
//   - the link opens a Clone8-branded welcome screen (welcome=true + brandName/logoUrl/welcomeTheme; co-branded, a small
//     Zernio mark stays) and asks the network only for posting + analytics (scopes), so TikTok's permission list is short.
//     Coming back to clone8.io passes a one-click Zernio "continue" page (their rule for any outside redirect).
//   - a normal (personal) TikTok connects on TikTok's Business app lane without being converted; videos there post
//     public only; Zernio holds posts past 15 a day per TikTok account and sends them as the window frees.
//   - posts: POST /posts (publishNow or scheduledFor), GET /posts/{id}, DELETE /posts/{id} (cancel; published posts stay)
//   - webhooks: one endpoint for the whole workspace (POST /webhooks/settings), X-Zernio-Signature = lowercase hex
//     HMAC-SHA256 of the raw body with our secret; events carry profiles[].id
//   - analytics: GET /analytics?accountId= lists the account's posts of the last ~90 days, also ones made outside
//     Zernio, with views, likes, reach, watch time, completion, retention and traffic sources
// Billing (zernio.com/pricing, Nov 21 2026): per linked network account per month, prorated daily: 2 free, $6 each to
// 10, $3 to 100, $1 after (studio-social-upkeep.ts). X posts cost extra from a prepaid balance, so X is off unless
// ZERNIO_OFFER_X=true. Env: ZERNIO_API_KEY (required), STUDIO_SOCIAL_WEBHOOK_SECRET (signing secret).
import { createHmac, timingSafeEqual } from "node:crypto";
import { SocialError, statusOf, type ProviderAccountStats, type ProviderPost, type PublishRequest, type PublishResult, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult, type SocialWebhook } from "./social-provider.js";
import { retentionOf, safeUrl } from "./social-ayrshare.js";

const BASE = "https://zernio.com/api/v1";
/** What the person sees on the welcome screen before the network's own sign-in. Copy may use {platform}. */
export const ZERNIO_BRAND = {
  brandName: "Clone8",
  logoUrl: "https://clone8.io/brand/icon-512.png",
  theme: { primaryColor: "#14B8A6", accentColor: "#14B8A6", pageColor: "#0A0A0A", cardColor: "#141414", textColor: "#F5F5F5", cornerRadius: 16, font: "sans", bannerStyle: "solid",
    heading: "Link your {platform} to Clone8", trustLine: "Clone8 never sees your password. Unlink any time.", consentLine: "Clone8 posts only the videos you choose and reads their views." },
};
/** Networks that link through an OAuth page (Bluesky needs an app password form; not offered yet). */
const OAUTH_NETWORKS = ["tiktok", "youtube", "instagram", "facebook", "linkedin", "threads"];

const clean = (v: any, fallback: string) => String(v ?? fallback).replace(/zernio|late\.dev|getlate/gi, "the posting service").slice(0, 240);
const nn = (v: any): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (v: any): string | null => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** An account id as Zernio sends it: a string, or the account itself on a read-back. */
export const idOf = (v: any): string | null => (typeof v === "string" && v ? v : v && typeof v === "object" && (v._id ?? v.id) ? String(v._id ?? v.id) : null);
/** Zernio's per-account status as ours (one entry per account posted to; two TikToks are two entries). */
function resultOf(p: any, scheduled: boolean): SocialResult {
  const st = String(p?.status ?? "").toLowerCase();
  const url = safeUrl(p?.platformPostUrl ?? p?.publishedUrl);
  const account_id = idOf(p?.accountId);
  if (st === "published") return { platform: String(p.platform), account_id, status: "posted", url, error: null };
  if (st === "failed" || st === "cancelled") return { platform: String(p.platform), account_id, status: "failed", url: null, error: friendlyError(p) };
  return { platform: String(p.platform), account_id, status: scheduled ? "scheduled" : "pending", url, error: null };
}
/** What a person reads when a network refuses: relink cases say so, the rest keep the network's own words. */
export function friendlyError(p: any): string {
  const cat = String(p?.errorCategory ?? "").toLowerCase();
  const name = p?.platform ? String(p.platform).charAt(0).toUpperCase() + String(p.platform).slice(1) : "That network";
  if (/auth|token|reconnect|permission/.test(cat)) return `${name} needs to be linked again. Relink it in Accounts, then retry.`;
  if (/rate|limit|quota|capacity/.test(cat)) return `${name} is not taking more posts from this account right now. It goes out when the network allows; try again later if it does not.`;
  return clean(p?.error ?? p?.errorMessage, "The network refused the post");
}
/** Verify a Zernio delivery: lowercase hex HMAC-SHA256 of the raw body. */
export function verifyZernio(rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean {
  const got = String(headers["x-zernio-signature"] ?? headers["X-Zernio-Signature"] ?? "").trim().toLowerCase().replace(/^sha256=/, "");
  const want = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** One post's metrics as the app reads them (studio-performance.ts). */
function metricsOf(a: any): Pick<ProviderPost, "views" | "likes" | "comments" | "shares" | "saves" | "duration_s" | "extra"> {
  a = a ?? {};
  const curve = a.retentionCurve && typeof a.retentionCurve === "object" ? Object.entries(a.retentionCurve).map(([s, v]) => ({ second: Number(s), percentage: Number(v) })) : [];
  const r = retentionOf(curve);
  const avg = nn(a.igReelsAvgWatchTime);
  return { views: nn(a.views), likes: nn(a.likes), comments: nn(a.comments), shares: nn(a.shares), saves: nn(a.saves), duration_s: nn(a.videoDurationSeconds),
    extra: { reach: nn(a.reach), avg_watch_s: avg == null ? null : Math.round(avg / 100) / 10, full_watch_rate: nn(a.completionRate), ...r, fyp_share: nn(a.impressionSources?.forYou), follows: nn(a.follows), replays: nn(a.replays) } };
}

let webhookReady: string | null = null; // the URL registered in this process (one workspace endpoint)

/** The bare HTTP client (also used by studio-autoreply.ts), or null without a key. */
export function zernioClient(deps: SocialDeps = {}) {
  const env = deps.env ?? process.env;
  const key = env.ZERNIO_API_KEY;
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  const call = async (method: string, path: string, opts: { body?: any; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> => {
    let r: Response;
    try {
      r = await f(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers ?? {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch { throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true }); }
    let text = "";
    try { text = await r.text(); } catch { throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true }); }
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    return { status: r.status, body: j ?? {} };
  };
  const rawAccounts = async (profileId: string): Promise<any[]> => {
    const r = await call("GET", `/accounts?profileId=${encodeURIComponent(profileId)}`);
    if (r.status >= 300) throw new SocialError("accounts_failed", clean(r.body?.error ?? r.body?.message, "Could not read the linked accounts"), 502);
    return (Array.isArray(r.body?.accounts) ? r.body.accounts : []).filter((a: any) => a && a.enabled !== false && a.notificationOnly !== true);
  };
  return { call, rawAccounts, clean };
}

export function zernioProvider(deps: SocialDeps = {}): SocialProvider | null {
  const env = deps.env ?? process.env;
  const key = env.ZERNIO_API_KEY;
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  // A failure where the service may still have acted (no answer, a timeout) is "unknown", never "refused".
  const call = async (method: string, path: string, opts: { body?: any; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> => {
    let r: Response;
    try {
      r = await f(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers ?? {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch { throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true }); }
    let text = "";
    try { text = await r.text(); } catch { throw Object.assign(new SocialError("provider_unreachable", "The posting service did not answer", 504), { unknown: true }); }
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    return { status: r.status, body: j ?? {} };
  };
  const fail = (r: { status: number; body: any }, code: string, fallback: string): never => {
    if (r.status === 429) throw new SocialError("provider_busy", "The posting service is busy; try again in a minute", 429);
    throw new SocialError(code, clean(r.body?.error ?? r.body?.message, fallback), r.status >= 500 ? 502 : 502);
  };
  const rawAccounts = async (profileId: string): Promise<any[]> => {
    const r = await call("GET", `/accounts?profileId=${encodeURIComponent(profileId)}`);
    if (r.status >= 300) fail(r, "accounts_failed", "Could not read the linked accounts");
    return (Array.isArray(r.body?.accounts) ? r.body.accounts : []).filter((a: any) => a && a.enabled !== false && a.notificationOnly !== true);
  };
  /** That account when it is on this profile and network; otherwise the network's first active account. */
  const accountFor = async (profileId: string, platform: string, id?: string) => {
    const all = await rawAccounts(profileId);
    if (id) return all.find((a) => String(a._id) === id && a.platform === platform) ?? null;
    return all.find((a) => a.platform === platform && a.isActive !== false) ?? null;
  };
  const offered = (): string[] => [...OAUTH_NETWORKS, ...(env.ZERNIO_OFFER_X === "true" ? ["twitter"] : [])];

  return {
    name: "zernio",
    linking: "per_network",
    offered,

    async createProfile(title, externalId) {
      const r = await call("POST", "/profiles", { body: { name: String(title).slice(0, 100), description: "Clone8 customer", ...(externalId ? { externalId } : {}) } });
      // an orphan from an earlier failed save: take it over
      if (r.status === 409 && r.body?.details?.existingProfileId) return { profileKey: String(r.body.details.existingProfileId), refId: String(r.body.details.existingProfileId) };
      const id = r.body?.profile?._id;
      if (r.status >= 300 || !id) fail(r, "profile_failed", "Could not set up posting");
      return { profileKey: String(id), refId: String(id) };
    },

    async deleteProfile(profileKey) {
      // the accounts are what is billed: remove each, then the (free) profile; already gone counts as done
      for (const a of await rawAccounts(profileKey).catch(() => [])) {
        const d = await call("DELETE", `/accounts/${encodeURIComponent(a._id)}`);
        if (d.status >= 300 && d.status !== 404) fail(d, "profile_delete_failed", "Could not remove a linked account");
      }
      const r = await call("DELETE", `/profiles/${encodeURIComponent(profileKey)}`);
      // a profile whose accounts are in their 1-hour grace may refuse; it holds nothing billed, so this is not an error
      if (r.status >= 500) fail(r, "profile_delete_failed", "Could not remove the posting profile");
    },

    async connectUrl(profileKey, opts = {}) {
      const platform = opts.platform;
      if (!platform || !offered().includes(platform)) throw new SocialError("pick_network", "Pick the network to link", 400);
      // posting + analytics by default; auto-replies add comments + messages (asked only when someone turns them on)
      const q = new URLSearchParams({ profileId: profileKey, welcome: "true", brandName: ZERNIO_BRAND.brandName, logoUrl: ZERNIO_BRAND.logoUrl, welcomeTheme: JSON.stringify(ZERNIO_BRAND.theme), scopes: opts.engage ? "posting,analytics,comments,messaging" : "posting,analytics" });
      if (opts.redirect) q.set("redirect_url", opts.redirect);
      // relinking (or asking an account for comments and messages): that account refreshes in place, nothing is added
      if (opts.accountId || opts.engage) {
        const acc = await accountFor(profileKey, platform, opts.accountId);
        if (opts.accountId && !acc) throw new SocialError("not_linked", "That account is not linked any more", 404);
        if (acc) q.set("reconnectAccountId", String(acc._id));
      } else if (opts.only) {
        // at the plan's limit only a network already linked may be linked again (it refreshes in place)
        if (!opts.only.includes(platform)) throw new SocialError("account_limit", "Your plan's accounts are all in use; add one to your plan to link another", 409);
        const acc = await accountFor(profileKey, platform);
        if (acc) q.set("reconnectAccountId", String(acc._id));
      } else if (opts.add && platform === "instagram") {
        // another Instagram: Instagram would sign in with the account already open on the device; ask for the login
        q.set("forceReauth", "true");
      }
      const r = await call("GET", `/connect/${encodeURIComponent(platform)}?${q}`);
      if (r.status === 402) throw new SocialError("linking_full", "Linking is paused for a moment while we add room. Try again soon.", 503);
      if (r.status >= 300 || !r.body?.authUrl) fail(r, "link_failed", "Could not open the linking page");
      return { url: String(r.body.authUrl), expiresInMinutes: 30 };
    },

    async accounts(profileKey): Promise<SocialAccount[]> {
      return (await rawAccounts(profileKey)).filter((a) => offered().includes(a.platform)).map((a) => ({
        id: String(a._id), platform: String(a.platform), username: a.username ? String(a.username) : null, display_name: a.displayName ? String(a.displayName) : null,
        image_url: safeUrl(a.profilePicture), profile_url: safeUrl(a.profileUrl), refresh_required: a.needsReconnection === true || a.isActive === false,
      }));
    },

    async disconnect(profileKey, platform, accountId) {
      const all = (await rawAccounts(profileKey)).filter((x) => x.platform === platform);
      if (accountId && !all.some((x) => String(x._id) === accountId)) return; // already gone
      for (const a of all.filter((x) => !accountId || String(x._id) === accountId)) {
        const d = await call("DELETE", `/accounts/${encodeURIComponent(a._id)}`);
        if (d.status >= 300 && d.status !== 404) fail(d, "unlink_failed", "Could not unlink");
      }
    },

    async publish(profileKey, req: PublishRequest): Promise<PublishResult> {
      const scheduled = !!req.scheduleAt;
      const accs = await rawAccounts(profileKey);
      const targets: any[] = [], missing: SocialResult[] = [];
      const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
      // the accounts asked for (two TikToks are two targets), or the first account of each network
      const own = (id: string) => { const a = accs.find((x) => String(x._id) === id && x.isActive !== false); return { platform: String(a?.platform ?? accs.find((x) => String(x._id) === id)?.platform ?? ""), a, id }; };
      const picks: Array<{ platform: string; a: any; id?: string; at?: Date | null; text?: string | null }> = req.targets?.length
        ? req.targets.map((t) => ({ ...own(t.accountId), at: t.at ?? null, text: t.text ?? null }))
        : req.accounts?.length ? req.accounts.map(own)
        : req.platforms.map((platform) => ({ platform, a: accs.find((x) => x.platform === platform && x.isActive !== false) }));
      for (const { platform, a, id, at, text } of picks) {
        if (!a) { missing.push({ platform: platform || "unknown", account_id: id ?? null, status: "failed", url: null, error: platform ? `That ${label(platform)} account is not linked any more. Link it again in Accounts.` : "That account is not linked any more. Link it again in Accounts." }); continue; }
        const t: any = { platform, accountId: String(a._id) };
        // its own time (accounts of one network spaced apart) and caption (a group's sign-off, a reworded caption)
        if (scheduled && at && req.scheduleAt && at.getTime() !== req.scheduleAt.getTime()) t.scheduledFor = at.toISOString();
        if (typeof text === "string" && text.trim() && text !== req.text) t.customContent = text.slice(0, 5000);
        if (platform === "instagram") {
          const ig = req.options?.instagram ?? {};
          const d: Record<string, any> = {};
          // Trial Reels: shown to non-followers first; SS_PERFORMANCE lets Instagram share a good one with followers
          if (ig.trial === "auto" || ig.trial === "manual") d.trialParams = { graduationStrategy: ig.trial === "auto" ? "SS_PERFORMANCE" : "MANUAL" };
          if (typeof ig.first_comment === "string" && ig.first_comment.trim()) d.firstComment = ig.first_comment.trim().slice(0, 2200);
          if (Object.keys(d).length) t.platformSpecificData = d;
        }
        if (platform === "youtube") {
          const yt = req.options?.youtube ?? {};
          t.platformSpecificData = { title: Array.from(String(yt.title || req.text || "New video")).slice(0, 100).join(""), visibility: yt.visibility ?? "public" };
        }
        targets.push(t);
      }
      if (!targets.length) return { providerPostId: null, status: "failed", results: missing, error: missing[0]?.error ?? "Nothing to post to" };
      const body: Record<string, any> = { content: req.text, mediaItems: [{ type: "video", url: req.mediaUrl }], platforms: targets, profileId: profileKey, timezone: "UTC" };
      if (scheduled) body.scheduledFor = req.scheduleAt!.toISOString(); else body.publishNow = true;
      // TikTok's rules: the person saw the video and agreed to post it (the Publish page says so); public is the only
      // level on TikTok's Business app lane; duets and stitches off, comments on
      if (targets.some((t) => t.platform === "tiktok")) body.tiktokSettings = { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: false, allow_stitch: false, content_preview_confirmed: true, express_consent_given: true };
      const r = await call("POST", "/posts", { body, timeoutMs: 150_000, headers: req.idempotencyKey ? { "Idempotency-Key": req.idempotencyKey } : {} });
      const p = r.body?.post;
      if (r.status >= 500 && !p?._id) throw Object.assign(new SocialError("provider_failed", "The posting service had a problem", 502), { unknown: true });
      if (!p?._id) return { providerPostId: null, status: "failed", results: [...missing, ...targets.map((t) => ({ platform: t.platform, account_id: t.accountId, status: "failed" as const, url: null, error: clean(r.body?.error ?? r.body?.message, "The post was refused") }))], error: clean(r.body?.error ?? r.body?.message, "The post was refused") };
      const results = [...((p.platforms ?? []) as any[]).map((x) => resultOf(x, scheduled)), ...missing];
      const status = scheduled && String(p.status) === "scheduled" ? "scheduled" : statusOf(results, scheduled);
      return { providerPostId: String(p._id), status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null };
    },

    async status(_profileKey, providerPostId): Promise<SocialEvent | null> {
      const r = await call("GET", `/posts/${encodeURIComponent(providerPostId)}`);
      if (r.status === 404 || (r.status < 300 && !r.body?.post)) return { providerPostId, status: "canceled", results: [], error: null };
      if (r.status >= 300) return null;
      const p = r.body.post;
      const future = !!p.scheduledFor && Date.parse(p.scheduledFor) > Date.now();
      const results = ((p.platforms ?? []) as any[]).map((x) => resultOf(x, future));
      if (String(p.status) === "cancelled") return { providerPostId, status: "canceled", results, error: null };
      const status = future && String(p.status) === "scheduled" ? "scheduled" : statusOf(results, false);
      return { providerPostId, status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null };
    },

    async update(profileKey, providerPostId, change) {
      const body: Record<string, any> = {};
      if (change.scheduleAt) body.scheduledFor = change.scheduleAt.toISOString();
      if (typeof change.text === "string") body.content = change.text;
      if (change.targets?.length) {
        // the post's accounts with their own times and captions; options (Instagram, YouTube) kept per network
        const cur = await call("GET", `/posts/${encodeURIComponent(providerPostId)}`);
        const was = ((cur.body?.post?.platforms ?? []) as any[]);
        body.platforms = change.targets.map((t) => {
          const prev = was.find((x) => idOf(x.accountId) === t.accountId) ?? {};
          const o: any = { platform: t.platform, accountId: t.accountId };
          if (prev.platformSpecificData) o.platformSpecificData = prev.platformSpecificData;
          if (t.platform === "youtube" && change.options?.youtube?.title) o.platformSpecificData = { ...(o.platformSpecificData ?? {}), title: String(change.options.youtube.title).slice(0, 100) };
          if (t.at && change.scheduleAt && t.at.getTime() !== change.scheduleAt.getTime()) o.scheduledFor = t.at.toISOString();
          const text = t.text ?? null;
          if (text && text !== (change.text ?? cur.body?.post?.content)) o.customContent = text.slice(0, 5000);
          return o;
        });
      }
      const r = await call("PUT", `/posts/${encodeURIComponent(providerPostId)}`, { body });
      if (r.status === 404) throw new SocialError("post_gone", "That post is no longer on the posting service", 404);
      if (r.status >= 300) throw new SocialError("update_failed", clean(r.body?.error ?? r.body?.message, "Could not change the post"), r.status === 400 ? 400 : 502);
      const p = r.body?.post;
      if (!p) return null;
      const future = !!p.scheduledFor && Date.parse(p.scheduledFor) > Date.now();
      const results = ((p.platforms ?? []) as any[]).map((x) => resultOf(x, future));
      return { providerPostId, status: future ? "scheduled" : statusOf(results, false), results, error: null };
    },

    async retry(_profileKey, providerPostId, targets) {
      const body = targets?.length ? { platforms: targets.map((t) => ({ platform: t.platform, ...(t.accountId ? { accountId: t.accountId } : {}) })) } : undefined;
      const r = await call("POST", `/posts/${encodeURIComponent(providerPostId)}/retry`, { body, timeoutMs: 150_000 });
      if (r.status === 404) throw new SocialError("post_gone", "That post is no longer on the posting service", 404);
      if (r.status >= 300) throw new SocialError("retry_failed", clean(r.body?.error ?? r.body?.message, "Could not retry the post"), r.status === 429 ? 429 : 502);
      const p = r.body?.post;
      if (!p) return null;
      const results = ((p.platforms ?? []) as any[]).map((x) => resultOf(x, false));
      const status = statusOf(results, false);
      return { providerPostId, status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null };
    },

    async cancel(_profileKey, providerPostId) {
      const r = await call("DELETE", `/posts/${encodeURIComponent(providerPostId)}`);
      if (r.status === 404) return;
      if (r.status >= 300) throw new SocialError("cancel_failed", clean(r.body?.error ?? r.body?.message, "Could not cancel"), 502);
    },

    async registerWebhook(_profileKey, url) {
      // one endpoint for the whole workspace: made once, events kept up to date
      if (webhookReady === url) return;
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      if (!secret) throw new SocialError("webhook_failed", "No signing secret", 502);
      const events = ["post.published", "post.failed", "post.partial", "post.cancelled", "post.platform.published", "post.platform.failed", "post.tiktok.url.resolved", "account.connected", "account.disconnected"];
      const list = await call("GET", "/webhooks/settings");
      const same = (Array.isArray(list.body?.webhooks) ? list.body.webhooks : []).find((w: any) => w?.url === url);
      const r = same ? await call("PUT", "/webhooks/settings", { body: { _id: same._id, url, secret, events, isActive: true } }) : await call("POST", "/webhooks/settings", { body: { name: "Clone8", url, secret, events } });
      if (r.status >= 300) fail(r, "webhook_failed", "Could not register the webhook");
      webhookReady = url;
    },

    parseWebhook(headers, rawBody): SocialWebhook | null {
      const secret = env.STUDIO_SOCIAL_WEBHOOK_SECRET;
      if (!secret) throw new SocialError("webhook_unconfigured", "No signing secret", 401);
      if (!verifyZernio(rawBody, headers, secret)) throw new SocialError("webhook_unverified", "Signature mismatch", 401);
      let b: any; try { b = JSON.parse(rawBody || "{}"); } catch { return null; }
      if (b?.test) return null;
      const ev = String(b?.event ?? "");
      if (ev.startsWith("post.") && b.post?.id) {
        const p = b.post;
        if (ev === "post.cancelled") return { kind: "post", event: { providerPostId: String(p.id), status: "canceled", results: [], error: null } };
        if (ev === "post.scheduled" || ev === "post.recycled") return null;
        // a platform event (or a TikTok link arriving later) names one account: the row merges by account
        const one = ev.startsWith("post.platform.") || ev.startsWith("post.tiktok.url");
        const acc = idOf(b.account);
        const results = ((p.platforms ?? []) as any[]).filter((x) => !one || (acc && idOf(x.accountId) ? idOf(x.accountId) === acc : !b.platform || x.platform === b.platform)).map((x) => resultOf(x, false));
        const status = statusOf(results, false);
        return { kind: "post", event: { providerPostId: String(p.id), status, results, error: status === "failed" ? (results.find((x) => x.error)?.error ?? "The post did not go out") : null, partial: true } };
      }
      if ((ev === "account.connected" || ev === "account.disconnected") && b.account?.profileId) {
        return { kind: "account", refId: String(b.account.profileId), platform: String(b.account.platform ?? ""), accountId: idOf(b.account), change: ev === "account.connected" ? "link" : "unlink", bySystem: ev === "account.disconnected" && b.account?.disconnectionType !== "intentional" && b.disconnectionType !== "intentional" };
      }
      return null;
    },

    async recentPosts(profileKey, platform, limit, accountId): Promise<ProviderPost[]> {
      const a = await accountFor(profileKey, platform, accountId);
      if (!a) return [];
      const r = await call("GET", `/analytics?accountId=${encodeURIComponent(a._id)}&limit=${Math.min(Math.max(limit, 1), 100)}`, { timeoutMs: 60_000 });
      if (r.status >= 300) fail(r, "history_failed", "Could not read the posts");
      const out: ProviderPost[] = [];
      for (const p of (Array.isArray(r.body?.posts) ? r.body.posts : []) as any[]) {
        const t = ((p.platforms ?? []) as any[]).find((x) => x.platform === platform) ?? p;
        const id = t.platformPostId ?? p.platformPostId;
        const url = safeUrl(t.platformPostUrl ?? p.platformPostUrl);
        if (!id || !url) continue;
        out.push({ platform, id: String(id), url, caption: p.content ?? null, published_at: iso(p.publishedAt), thumb_url: safeUrl(p.thumbnailUrl), ...metricsOf(t.analytics ?? p.analytics) });
      }
      return out;
    },

    async accountStats(profileKey, platforms): Promise<ProviderAccountStats[]> {
      const accs = await rawAccounts(profileKey);
      // every account of those networks (two TikToks are two entries), each with its id
      const one = (platform: string, a: any): ProviderAccountStats => { const extra = a?.metadata?.profileData?.extraData ?? {}; return { platform, account_id: a ? String(a._id) : null, followers: nn(a?.followersCount), extra: { views_total: nn(extra.totalViews), videos: nn(extra.videoCount), likes_total: nn(extra.likesCount) } }; };
      return platforms.flatMap((platform) => { const mine = accs.filter((x) => x.platform === platform); return mine.length ? mine.map((a) => one(platform, a)) : [one(platform, null)]; });
    },
  };
}

export const resetZernioForTests = () => { webhookReady = null; };
