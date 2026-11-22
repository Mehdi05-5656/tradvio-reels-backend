// Clone8 Studio: auto-replies (owner, Nov 21 2026: "if a user types in a keyword it DMs them their message
// automatically"). A rule watches one linked account (one post, or every post): when someone comments a keyword,
//   - Instagram and Facebook: they get a DM (text, an optional link button), plus an optional public reply;
//   - TikTok, YouTube, Threads and LinkedIn: a public reply under their comment (those networks have no private reply).
// Instagram also answers story replies and story mentions, and the same keywords can answer a plain DM.
//
// The rules run at the posting service (Zernio's comment automations, zernio.com docs "Comments to DM", read Nov 21
// 2026): it receives the comments and sends within seconds, so Clone8 runs no worker. This module keeps people to their
// own accounts (every rule is checked against the person's profile), limits rules per plan, cleans what is sent, and
// translates both ways so the service is never named. Turning a rule on needs the network's permission to read
// comments and send messages; the page asks for it (POST /api/studio/social/connect with engage: true).
// Cost: included per linked account; DMs are free up to 10,000 a month across Clone8, then $1 per 10,000.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SocialError, type SocialDeps } from "./social-provider.js";
import { zernioClient } from "./social-zernio.js";
import { hasPlanAccess } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import { touchSocial } from "./studio-social-upkeep.js";

/** Live rules a person may have at once, by plan (owner may change; the owner's own account is not limited). */
export const AUTOREPLY_LIMITS: Record<string, number> = { starter: 3, creator: 10, studio: 25 };
const DM_NETWORKS = ["instagram", "facebook"];
const REPLY_NETWORKS = ["instagram", "facebook", "tiktok", "youtube", "threads", "linkedin"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Env = Record<string, string | undefined>;
const str = (v: any, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
const list = (v: any, n: number, max: number) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean))].slice(0, n);
const https = (v: any): string | null => { const s = str(v, 2000); try { const u = new URL(s); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };

/** What the person asked for, cleaned and checked for the network, as the service takes it. Throws SocialError. */
export function cleanRule(b: any, platform: string, opts: { partial?: boolean } = {}): Record<string, any> {
  const out: Record<string, any> = {};
  const has = (k: string) => !opts.partial || b?.[k] !== undefined;
  const dmNet = DM_NETWORKS.includes(platform);
  if (has("name")) { out.name = str(b?.name, 60) || "Auto-reply"; }
  if (has("trigger")) {
    const t = ["comment", "story_reply", "story_mention"].includes(b?.trigger) ? b.trigger : "comment";
    if (t !== "comment" && platform !== "instagram") throw new SocialError("trigger_not_supported", "Story replies and mentions are Instagram only");
    out.trigger = t;
  }
  if (has("post_id")) { const id = b?.post_id ? str(b.post_id, 64) : ""; if (id && !ID_RE.test(id)) throw new SocialError("bad_post", "That post could not be read"); if (id) out.platformPostId = id; else if (opts.partial) out.platformPostId = null; }
  if (has("post_title")) { const t = str(b?.post_title, 120); if (t) out.postTitle = t; }
  if (has("keywords")) out.keywords = list(b?.keywords, 10, 40);
  if (has("match")) out.matchMode = ["word", "contains", "exact"].includes(b?.match) ? b.match : "word";
  if (has("exclude")) out.excludeKeywords = list(b?.exclude, 10, 40);
  if (has("typos")) out.typoTolerance = b?.typos === true;
  const button = b?.button && typeof b.button === "object" ? { title: str(b.button.title, 20), url: https(b.button.url) } : null;
  if (b?.button && (!button?.title || !button?.url)) throw new SocialError("bad_button", "A link button needs a label (20 characters at most) and an https link");
  if (has("dm_message")) {
    const dm = str(b?.dm_message, button ? 640 : 1000);
    if (dmNet) { if (!dm && !opts.partial) throw new SocialError("dm_required", "Write the message to send"); if (dm) out.dmMessage = dm; }
    else if (dm) throw new SocialError("dm_not_supported", "This network does not allow private replies; use a public reply");
  }
  if (has("button") && dmNet) out.buttons = button ? [{ type: "url", title: button.title, url: button.url }] : [];
  if (has("dm_variations") && dmNet) out.dmMessageVariations = list(b?.dm_variations, 5, button ? 640 : 1000);
  if (has("comment_reply")) {
    const r = str(b?.comment_reply, 500);
    if (!dmNet && !r && !opts.partial) throw new SocialError("reply_required", "Write the public reply to post");
    out.commentReply = r || undefined;
  }
  if (has("reply_variations")) out.commentReplyVariations = list(b?.reply_variations, 5, 500);
  if (has("also_dms") && dmNet) out.alsoMatchInDms = b?.also_dms === true;
  if (has("repeat")) out.repeatPolicy = b?.repeat === "every" ? { mode: "every_comment", cooldownHours: 24 } : { mode: "once" };
  if (has("followers") && platform === "instagram") out.audience = { followerStatus: ["follower", "non_follower"].includes(b?.followers) ? b.followers : "any", whenUnknown: "send" };
  if (has("hide_comment") && dmNet) out.actions = { hideComment: b?.hide_comment === true };
  if (has("delay_s")) out.dmDelaySeconds = Math.min(Math.max(Math.floor(Number(b?.delay_s) || 0), 0), 3600);
  if (has("active")) out.isActive = b?.active !== false;
  if (!opts.partial) {
    if (!out.keywords?.length && out.trigger !== "story_mention") throw new SocialError("keywords_required", "Add at least one keyword");
    out.linkTracking = true;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** A rule as the page shows it (the service's own field names never leave the server). */
export function publicRule(a: any, platformOf: (accountId: string) => string | null) {
  const s = a?.stats ?? {};
  const b0 = Array.isArray(a?.buttons) ? a.buttons.find((x: any) => x?.type === "url") : null;
  return {
    id: String(a.id ?? a._id), name: a.name ?? "", platform: a.platform ?? platformOf(String(a.accountId)) ?? null, trigger: a.trigger ?? "comment",
    post: a.platformPostId ? { id: String(a.platformPostId), title: a.postTitle ?? null } : null,
    keywords: a.keywords ?? [], match: a.matchMode ?? "contains", exclude: a.excludeKeywords ?? [], typos: !!a.typoTolerance,
    dm_message: a.dmMessage ?? null, button: b0 ? { title: b0.title, url: b0.url } : null, comment_reply: a.commentReply ?? null,
    dm_variations: a.dmMessageVariations ?? [], reply_variations: a.commentReplyVariations ?? [], also_dms: !!a.alsoMatchInDms,
    repeat: a.repeatPolicy?.mode === "every_comment" ? "every" : "once", followers: a.audience?.followerStatus ?? "any", hide_comment: !!a.actions?.hideComment,
    delay_s: a.dmDelaySeconds ?? 0, active: a.isActive !== false, created_at: a.createdAt ?? null,
    stats: { triggered: s.triggered ?? 0, sent: s.dmsSent ?? 0, failed: s.dmsFailed ?? 0, people: s.uniqueContacts ?? 0, clicks: s.linkClicks ?? 0, unique_clicks: s.uniqueClicks ?? 0,
      ctr: s.trackedSends ? Math.round(((s.uniqueClicks ?? 0) / s.trackedSends) * 1000) / 10 : null },
  };
}

/** What a linked account can do, from the permissions the person granted (comments, messages). */
export function capabilityOf(platform: string, health: any): { reply: boolean; dm: boolean } {
  const scopes: Array<{ scope: string; granted: boolean }> = [...(health?.permissions?.posting ?? []), ...(health?.permissions?.analytics ?? []), ...(health?.permissions?.optional ?? [])];
  const granted = scopes.filter((x) => x?.granted).map((x) => String(x.scope).toLowerCase());
  const reply = granted.some((s) => /comment|engagement|force-ssl|replies|read_user_content/.test(s));
  const dm = DM_NETWORKS.includes(platform) && granted.some((s) => /messag/.test(s));
  return { reply: REPLY_NETWORKS.includes(platform) && reply, dm };
}

export function registerAutoReplies(app: Express, sbFn: () => SupabaseClient, deps: SocialDeps = {}): void {
  const env: Env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof SocialError) return res.status(e.status).json({ error: e.code, detail: e.message });
    console.error("[autoreply]", String(e?.message ?? e).slice(0, 200));
    res.status(500).json({ error: "autoreply_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  const client = () => (env.STUDIO_SOCIAL_ENABLED === "true" && env.SOCIAL_PROVIDER === "zernio" ? zernioClient({ env, fetch: deps.fetch, log }) : null);
  const need = () => { const c = client(); if (!c) throw new SocialError("autoreply_off", "Auto-replies are not switched on yet", 503); return c; };
  /** The person's plan, posting profile and linked accounts (by network). */
  const ctxOf = async (sb: SupabaseClient, u: string) => {
    const c = need();
    const cust = await sb.from("studio_customers").select("plan_id,status,owner_pass").eq("user_id", u).maybeSingle();
    if (cust.error) throw cust.error;
    if (!hasPlanAccess(cust.data)) throw new SocialError("subscription_required", "Auto-replies come with a plan", 409);
    const prof = await sb.from("studio_social_profiles").select("provider,profile_key").eq("user_id", u).maybeSingle();
    if (prof.error) throw prof.error;
    if (!prof.data || prof.data.provider !== "zernio") return { c, cust: cust.data as any, profileId: null as string | null, accounts: [] as any[] };
    const accounts = (await c.rawAccounts(prof.data.profile_key)).filter((a) => REPLY_NETWORKS.includes(a.platform) && a.isActive !== false);
    return { c, cust: cust.data as any, profileId: String(prof.data.profile_key), accounts };
  };
  const limitOf = (cust: any) => (cust?.owner_pass ? 100 : AUTOREPLY_LIMITS[cust?.plan_id] ?? AUTOREPLY_LIMITS.starter);
  const rulesOf = async (c: NonNullable<ReturnType<typeof client>>, profileId: string) => {
    const r = await c.call("GET", `/comment-automations?profileId=${encodeURIComponent(profileId)}`);
    if (r.status >= 300) throw new SocialError("autoreply_failed", c.clean(r.body?.error, "Could not read your auto-replies"), 502);
    return (Array.isArray(r.body?.automations) ? r.body.automations : Array.isArray(r.body?.data) ? r.body.data : []) as any[];
  };
  /** A rule of this person's, or a 404. */
  const ownRule = async (ctx: Awaited<ReturnType<typeof ctxOf>>, id: string) => {
    if (!ID_RE.test(id) || !ctx.profileId) throw new SocialError("not_found", "No such auto-reply", 404);
    const r = await ctx.c.call("GET", `/comment-automations/${encodeURIComponent(id)}`);
    const a = r.body?.automation ?? r.body;
    if (r.status >= 300 || !a || !ctx.accounts.some((x) => String(x._id) === String(a.accountId))) throw new SocialError("not_found", "No such auto-reply", 404);
    return a;
  };
  const platformOf = (ctx: Awaited<ReturnType<typeof ctxOf>>) => (accountId: string) => ctx.accounts.find((x) => String(x._id) === accountId)?.platform ?? null;

  // The page: linked accounts with what each can do, the rules with their numbers, and the plan's room.
  app.get("/api/studio/autoreply", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    if (!client()) return res.json({ enabled: false, accounts: [], rules: [], limit: 0 });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      const accounts = await Promise.all(ctx.accounts.map(async (a) => {
        const h = await ctx.c.call("GET", `/accounts/${encodeURIComponent(a._id)}/health`).catch(() => null);
        const can = capabilityOf(a.platform, h?.body);
        return { platform: a.platform, username: a.username ?? null, display_name: a.displayName ?? null, image_url: a.profilePicture ?? null, dm: DM_NETWORKS.includes(a.platform), can_reply: can.reply, can_dm: can.dm };
      }));
      const rules = ctx.profileId ? (await rulesOf(ctx.c, ctx.profileId)).filter((a) => ctx.accounts.some((x) => String(x._id) === String(a.accountId))).map((a) => publicRule(a, platformOf(ctx))) : [];
      res.json({ enabled: true, accounts, rules, limit: limitOf(ctx.cust), used: rules.filter((r) => r.active).length });
    } catch (e) { fail(res, e); }
  });

  // Recent posts of one linked account, to point a rule at one of them.
  app.get("/api/studio/autoreply/posts", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      const platform = String(req.query.platform ?? "");
      const a = ctx.accounts.find((x) => x.platform === platform);
      if (!a) throw new SocialError("not_linked", "Link that account first", 409);
      const r = await ctx.c.call("GET", `/analytics?accountId=${encodeURIComponent(a._id)}&limit=30`, { timeoutMs: 60_000 });
      const posts = ((r.body?.posts ?? []) as any[]).map((p) => { const t = (p.platforms ?? []).find((x: any) => x.platform === platform) ?? p; return { id: t.platformPostId ?? null, title: String(p.content ?? "").slice(0, 120), thumb_url: p.thumbnailUrl ?? null, published_at: p.publishedAt ?? null, url: t.platformPostUrl ?? null }; }).filter((p) => p.id);
      res.json({ posts });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/autoreply", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u), b = req.body ?? {};
      const platform = String(b.platform ?? "");
      const a = ctx.accounts.find((x) => x.platform === platform);
      if (!a || !ctx.profileId) throw new SocialError("not_linked", "Link that account first", 409);
      const live = (await rulesOf(ctx.c, ctx.profileId)).filter((x) => x.isActive !== false && ctx.accounts.some((y) => String(y._id) === String(x.accountId))).length;
      if (b.active !== false && live >= limitOf(ctx.cust)) throw new SocialError("autoreply_limit", `Your plan runs ${limitOf(ctx.cust)} auto-replies at once. Pause one or upgrade for more.`, 409);
      const body: Record<string, any> = { ...cleanRule(b, platform), profileId: ctx.profileId, accountId: String(a._id) };
      const r = await ctx.c.call("POST", "/comment-automations", { body });
      const made = r.body?.automation ?? r.body;
      if (r.status >= 300 || !(made?.id ?? made?._id)) {
        const msg = String(r.body?.error ?? r.body?.message ?? "");
        if (/permission|scope|not granted|reconnect/i.test(msg) || r.status === 403) throw new SocialError("needs_permission", "Allow Clone8 to answer comments and messages on this account first", 409);
        throw new SocialError("autoreply_failed", ctx.c.clean(msg, "Could not save the auto-reply"), 502);
      }
      await touchSocial(sb, u);
      recordEvent({ user_id: u, kind: "feature", name: "autoreply_created", props: { platform, trigger: body.trigger, dm: !!body.dmMessage, reply: !!body.commentReply, one_post: !!body.platformPostId, button: !!body.buttons?.length } });
      log(`[autoreply] ${u} made a ${platform} rule`);
      res.status(201).json({ rule: publicRule(made, platformOf(ctx)) });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/studio/autoreply/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      const cur = await ownRule(ctx, String(req.params.id));
      const platform = platformOf(ctx)(String(cur.accountId)) ?? cur.platform;
      const patch = cleanRule(req.body ?? {}, platform, { partial: true });
      if (patch.isActive === true && cur.isActive === false) {
        const live = (await rulesOf(ctx.c, ctx.profileId!)).filter((x) => x.isActive !== false && ctx.accounts.some((y) => String(y._id) === String(x.accountId))).length;
        if (live >= limitOf(ctx.cust)) throw new SocialError("autoreply_limit", `Your plan runs ${limitOf(ctx.cust)} auto-replies at once. Pause one or upgrade for more.`, 409);
      }
      const r = await ctx.c.call("PATCH", `/comment-automations/${encodeURIComponent(String(req.params.id))}`, { body: patch });
      if (r.status >= 300) throw new SocialError("autoreply_failed", ctx.c.clean(r.body?.error, "Could not save the change"), 502);
      await touchSocial(sb, u);
      recordEvent({ user_id: u, kind: "feature", name: "autoreply_changed", props: { platform, fields: Object.keys(patch) } });
      res.json({ rule: publicRule(r.body?.automation ?? { ...cur, ...patch }, platformOf(ctx)) });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/autoreply/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      const cur = await ownRule(ctx, String(req.params.id));
      const r = await ctx.c.call("DELETE", `/comment-automations/${encodeURIComponent(String(req.params.id))}`);
      if (r.status >= 300 && r.status !== 404) throw new SocialError("autoreply_failed", ctx.c.clean(r.body?.error, "Could not delete"), 502);
      recordEvent({ user_id: u, kind: "feature", name: "autoreply_deleted", props: { platform: platformOf(ctx)(String(cur.accountId)), sent: cur.stats?.dmsSent ?? 0 } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Who triggered a rule, what was sent, and comments that matched no keyword (to fix a keyword that catches nothing).
  app.get("/api/studio/autoreply/:id/activity", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      await ownRule(ctx, String(req.params.id));
      const skip = Math.max(0, Math.floor(Number(req.query.skip) || 0));
      const r = await ctx.c.call("GET", `/comment-automations/${encodeURIComponent(String(req.params.id))}/logs?limit=50&skip=${skip}`);
      if (r.status >= 300) throw new SocialError("autoreply_failed", ctx.c.clean(r.body?.error, "Could not read the activity"), 502);
      const rows = ((r.body?.logs ?? []) as any[]).map((l) => ({ at: l.createdAt ?? l.at ?? null, who: l.commenterUsername ?? l.commenterName ?? null, text: l.commentText ?? null, source: l.source ?? "comment", status: l.status ?? null, error: l.status === "failed" ? ctx.c.clean(l.error ?? l.errorMessage, "Not sent") : null, clicked: !!l.clicked }));
      res.json({ rows, more: !!r.body?.pagination?.hasMore, misses: { total: r.body?.misses?.total ?? 0, days: r.body?.misses?.retentionDays ?? null, samples: ((r.body?.misses?.samples ?? []) as any[]).slice(0, 5).map((m) => ({ text: m.commentText ?? null, at: m.at ?? null })) } });
    } catch (e) { fail(res, e); }
  });
}
