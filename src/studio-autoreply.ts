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
// Reply-only on Instagram and Facebook (the DM switched off) cannot run at the service, which always sends a DM there:
// those rules run at Clone8 (studio-reply-only.ts) and show up here side by side with the others, in the same shape.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SocialError, type SocialDeps } from "./social-provider.js";
import { zernioClient, DM_NETWORKS, REPLY_NETWORKS } from "./social-zernio.js";
import { hasPlanAccess } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import { touchSocial } from "./studio-social-upkeep.js";
import { cleanOwnRule, isOwnRuleId, ownRulesOf, publicOwnRule, replyOnlyOn, statsOf, type OwnRuleRow } from "./studio-reply-only.js";

/** Live rules a person may have at once, by plan (owner may change; the owner's own account is not limited). */
export const AUTOREPLY_LIMITS: Record<string, number> = { starter: 3, creator: 10, studio: 25 };
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
    id: String(a.id ?? a._id), name: a.name ?? "", platform: a.platform ?? platformOf(String(a.accountId)) ?? null, account_id: a.accountId ? String(a.accountId) : null, trigger: a.trigger ?? "comment",
    post: a.platformPostId ? { id: String(a.platformPostId), title: a.postTitle ?? null } : null,
    keywords: a.keywords ?? [], match: a.matchMode ?? "contains", exclude: a.excludeKeywords ?? [], typos: !!a.typoTolerance,
    dm: !!a.dmMessage, dm_message: a.dmMessage ?? null, button: b0 ? { title: b0.title, url: b0.url } : null, comment_reply: a.commentReply ?? null,
    dm_variations: a.dmMessageVariations ?? [], reply_variations: a.commentReplyVariations ?? [], also_dms: !!a.alsoMatchInDms,
    repeat: a.repeatPolicy?.mode === "every_comment" ? "every" : "once", followers: a.audience?.followerStatus ?? "any", hide_comment: !!a.actions?.hideComment,
    delay_s: a.dmDelaySeconds ?? 0, active: a.isActive !== false, created_at: a.createdAt ?? null,
    stats: { triggered: s.triggered ?? 0, sent: s.dmsSent ?? 0, failed: s.dmsFailed ?? 0, people: s.uniqueContacts ?? 0, clicks: s.linkClicks ?? 0, unique_clicks: s.uniqueClicks ?? 0,
      ctr: s.trackedSends ? Math.round(((s.uniqueClicks ?? 0) / s.trackedSends) * 1000) / 10 : null },
  };
}

/** What a linked account can do, from the permissions the person granted (comments, messages). The service sums them up
 *  per area (scopeAreas: comments / messaging "granted"); its scope lists leave some out (a TikTok business account
 *  lists no comment scope there although it has one: @alexwilltry, Nov 24 2026), so either counts. */
export function capabilityOf(platform: string, health: any): { reply: boolean; dm: boolean } {
  const areas = health?.permissions?.scopeAreas ?? {};
  const scopes: Array<{ scope: string; granted: boolean }> = [...(health?.permissions?.posting ?? []), ...(health?.permissions?.analytics ?? []), ...(health?.permissions?.optional ?? [])];
  const granted = scopes.filter((x) => x?.granted).map((x) => String(x.scope).toLowerCase());
  const reply = areas.comments === "granted" || granted.some((s) => /comment|engagement|force-ssl|replies|read_user_content/.test(s));
  const dm = DM_NETWORKS.includes(platform) && (areas.messaging === "granted" || granted.some((s) => /messag/.test(s)));
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
  const pickAccount = (ctx: Awaited<ReturnType<typeof ctxOf>>, id: unknown, platform: string) =>
    (typeof id === "string" && id ? ctx.accounts.find((x) => String(x._id) === id) : ctx.accounts.find((x) => x.platform === platform)) ?? null;
  const accIds = (ctx: Awaited<ReturnType<typeof ctxOf>>) => ctx.accounts.map((x) => String(x._id));
  /** Live rules on both sides (the plan's limit counts them together). */
  const liveCount = async (sb: SupabaseClient, u: string, ctx: Awaited<ReturnType<typeof ctxOf>>) =>
    (await rulesOf(ctx.c, ctx.profileId!)).filter((x) => x.isActive !== false && ctx.accounts.some((y) => String(y._id) === String(x.accountId))).length
    + (await ownRulesOf(sb, u, accIds(ctx))).filter((r) => r.active).length;
  /** One of this person's reply-only rules, or a 404. */
  const ownOne = async (sb: SupabaseClient, u: string, ctx: Awaited<ReturnType<typeof ctxOf>>, id: string): Promise<OwnRuleRow> => {
    const r = await sb.from("studio_reply_rules").select("*").eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error || !r.data || !accIds(ctx).includes(String((r.data as any).account_id))) throw new SocialError("not_found", "No such auto-reply", 404);
    return r.data as OwnRuleRow;
  };
  /** Replying needs the comments permission on the account. */
  const canReply = async (ctx: Awaited<ReturnType<typeof ctxOf>>, a: any) => {
    const h = await ctx.c.call("GET", `/accounts/${encodeURIComponent(a._id)}/health`).catch(() => null);
    return capabilityOf(String(a.platform), h?.body).reply;
  };
  /** A reply-only rule written to our table. */
  const insertOwn = async (sb: SupabaseClient, u: string, a: any, fields: Partial<OwnRuleRow>) => {
    const r = await sb.from("studio_reply_rules").insert({ ...fields, user_id: u, account_id: String(a._id), platform: String(a.platform) }).select("*").maybeSingle();
    if (r.error || !r.data) throw new SocialError("autoreply_failed", "Could not save the auto-reply", 502);
    return r.data as OwnRuleRow;
  };

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
        return { id: String(a._id), platform: a.platform, username: a.username ?? null, display_name: a.displayName ?? null, image_url: a.profilePicture ?? null, dm: DM_NETWORKS.includes(a.platform), can_reply: can.reply, can_dm: can.dm };
      }));
      const theirs = ctx.profileId ? (await rulesOf(ctx.c, ctx.profileId)).filter((a) => ctx.accounts.some((x) => String(x._id) === String(a.accountId))).map((a) => publicRule(a, platformOf(ctx))) : [];
      const own = await ownRulesOf(sb, u, accIds(ctx)).catch(() => [] as OwnRuleRow[]);
      const stats = await statsOf(sb, own.map((r) => r.id));
      const rules = [...theirs, ...own.map((r) => publicOwnRule(r, stats.get(r.id)))].sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")));
      // reply_only: whether a rule on Instagram or Facebook may leave the DM off
      const waiting = (await waitingSummary(sb, u)).filter((w) => accounts.some((a) => a.id === w.account_id));
      res.json({ enabled: true, reply_only: replyOnlyOn(env), accounts, rules, limit: limitOf(ctx.cust), used: rules.filter((r) => r.active).length, waiting });
    } catch (e) { fail(res, e); }
  });

  // Start the auto-replies that waited for a permission (after Allow; the relink webhook does the same by itself).
  const resuming = new Map<string, number>();
  app.post("/api/studio/autoreply/resume", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    if (!client()) return res.json({ on: [], skipped: [], waiting: 0 });
    const last = resuming.get(u) ?? 0;
    if (Date.now() - last < 5000) return res.status(429).json({ error: "slow_down", detail: "One moment" });
    resuming.set(u, Date.now());
    try {
      const sb = sbFn(); await ctxOf(sb, u); // a plan and a posting profile
      const accountId = typeof req.body?.account_id === "string" && ID_RE.test(req.body.account_id) ? req.body.account_id : undefined;
      res.json(await resumeAutoReplies(sb, u, { env, log, fetch: deps.fetch, accountId }));
    } catch (e) { fail(res, e); }
  });

  // Recent posts of one linked account, to point a rule at one of them.
  app.get("/api/studio/autoreply/posts", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u);
      const a = pickAccount(ctx, req.query.account_id, String(req.query.platform ?? ""));
      if (!a) throw new SocialError("not_linked", "Link that account first", 409);
      const platform = String(a.platform);
      const r = await ctx.c.call("GET", `/analytics?accountId=${encodeURIComponent(a._id)}&limit=30`, { timeoutMs: 60_000 });
      const posts = ((r.body?.posts ?? []) as any[]).map((p) => { const t = (p.platforms ?? []).find((x: any) => x.platform === platform) ?? p; return { id: t.platformPostId ?? null, title: String(p.content ?? "").slice(0, 120), thumb_url: p.thumbnailUrl ?? null, published_at: p.publishedAt ?? null, url: t.platformPostUrl ?? null }; }).filter((p) => p.id);
      res.json({ posts });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/autoreply", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), ctx = await ctxOf(sb, u), b = req.body ?? {};
      const a = pickAccount(ctx, b.account_id, String(b.platform ?? ""));
      if (!a || !ctx.profileId) throw new SocialError("not_linked", "Link that account first", 409);
      const platform = String(a.platform);
      if (b.active !== false && (await liveCount(sb, u, ctx)) >= limitOf(ctx.cust)) throw new SocialError("autoreply_limit", `Your plan runs ${limitOf(ctx.cust)} auto-replies at once. Pause one or upgrade for more.`, 409);
      if (DM_NETWORKS.includes(platform) && b.dm === false) {
        // reply only (no DM): runs at Clone8
        if (!replyOnlyOn(env)) throw new SocialError("reply_only_off", "Replies without a DM are not available yet; switch the DM on", 409);
        const fields = cleanOwnRule(b);
        if (!(await canReply(ctx, a))) throw new SocialError("needs_permission", "Allow Clone8 to answer comments on this account first", 409);
        const row = await insertOwn(sb, u, a, fields);
        await touchSocial(sb, u);
        recordEvent({ user_id: u, kind: "feature", name: "autoreply_created", props: { platform, trigger: "comment", dm: false, reply: true, one_post: !!row.platform_post_id, button: false } });
        log(`[autoreply] ${u} made a reply-only ${platform} rule`);
        return res.status(201).json({ rule: publicOwnRule(row) });
      }
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
      const sb = sbFn(), ctx = await ctxOf(sb, u), b = req.body ?? {}, id = String(req.params.id);
      if (isOwnRuleId(id)) {
        const own = await ownOne(sb, u, ctx, id);
        if (b.dm === true) {
          // the DM switched on: the rule moves to the service (which sends the DM), then ours is removed
          // the post it answers on: one made with a post keeps the service's post id, one picked from the account its network id
          const asked: string | null = b.post_id !== undefined ? (b.post_id ? String(b.post_id) : null) : own.platform_post_id ?? own.post_id;
          const serviceId = asked && asked === own.post_id ? asked : null;
          const merged = { ...publicOwnRule(own), ...b, post_id: serviceId ? undefined : asked ?? undefined, post_title: b.post_title ?? own.post_title ?? undefined };
          const body: Record<string, any> = { ...cleanRule(merged, own.platform), profileId: ctx.profileId, accountId: own.account_id };
          if (serviceId) body.postId = serviceId;
          const r = await ctx.c.call("POST", "/comment-automations", { body });
          const made = r.body?.automation ?? r.body;
          if (r.status >= 300 || !(made?.id ?? made?._id)) {
            if (r.status === 403 || /permission|scope|not granted|reconnect/i.test(String(r.body?.error ?? ""))) throw new SocialError("needs_permission", "Allow Clone8 to answer comments and messages on this account first", 409);
            throw new SocialError("autoreply_failed", ctx.c.clean(r.body?.error, "Could not switch the DM on"), 502);
          }
          await sb.from("studio_reply_rules").delete().eq("id", own.id).eq("user_id", u);
          recordEvent({ user_id: u, kind: "feature", name: "autoreply_changed", props: { platform: own.platform, fields: ["dm_on"] } });
          return res.json({ rule: publicRule(made, platformOf(ctx)), replaced: own.id });
        }
        const patch = cleanOwnRule(b, { partial: true });
        if (patch.active === true && !own.active && (await liveCount(sb, u, ctx)) >= limitOf(ctx.cust)) throw new SocialError("autoreply_limit", `Your plan runs ${limitOf(ctx.cust)} auto-replies at once. Pause one or upgrade for more.`, 409);
        if (patch.platform_post_id !== undefined) {
          // the same post sent back unchanged keeps its binding; another post (or every post) replaces it
          if (patch.platform_post_id && (patch.platform_post_id === own.post_id || patch.platform_post_id === own.platform_post_id)) { delete patch.platform_post_id; delete patch.post_title; }
          else patch.post_id = null;
        }
        const r = await sb.from("studio_reply_rules").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", own.id).eq("user_id", u).select("*").maybeSingle();
        if (r.error || !r.data) throw new SocialError("autoreply_failed", "Could not save the change", 502);
        await touchSocial(sb, u);
        recordEvent({ user_id: u, kind: "feature", name: "autoreply_changed", props: { platform: own.platform, fields: Object.keys(patch) } });
        return res.json({ rule: publicOwnRule(r.data as OwnRuleRow, (await statsOf(sb, [own.id])).get(own.id)) });
      }
      const cur = await ownRule(ctx, id);
      const platform = platformOf(ctx)(String(cur.accountId)) ?? cur.platform;
      if (b.dm === false && DM_NETWORKS.includes(platform)) {
        // the DM switched off on Instagram or Facebook: the rule moves to Clone8 (reply only), then the service's is removed
        if (!replyOnlyOn(env)) throw new SocialError("reply_only_off", "Replies without a DM are not available yet", 409);
        if ((cur.trigger ?? "comment") !== "comment") throw new SocialError("dm_required", "Story replies and mentions are answered by DM", 400);
        const was = publicRule(cur, platformOf(ctx));
        const fields = cleanOwnRule({ ...was, post_id: was.post?.id ?? null, post_title: was.post?.title ?? null, ...b, trigger: "comment" });
        if (!was.post && cur.postId) fields.post_id = String(cur.postId);
        const acc = ctx.accounts.find((x) => String(x._id) === String(cur.accountId));
        const row = await insertOwn(sb, u, acc ?? { _id: cur.accountId, platform }, fields);
        const del = await ctx.c.call("DELETE", `/comment-automations/${encodeURIComponent(id)}`).catch(() => ({ status: 599, body: {} }));
        if (del.status >= 300 && del.status !== 404) {
          // never leave both running: pause the old one, or undo the move
          const off = await ctx.c.call("PATCH", `/comment-automations/${encodeURIComponent(id)}`, { body: { isActive: false } }).catch(() => ({ status: 599, body: {} }));
          if (off.status >= 300) { await sb.from("studio_reply_rules").delete().eq("id", row.id); throw new SocialError("autoreply_failed", "Could not switch the DM off; nothing changed", 502); }
        }
        await touchSocial(sb, u);
        recordEvent({ user_id: u, kind: "feature", name: "autoreply_changed", props: { platform, fields: ["dm_off"] } });
        return res.json({ rule: publicOwnRule(row), replaced: id });
      }
      const patch = cleanRule(b, platform, { partial: true });
      if (patch.isActive === true && cur.isActive === false && (await liveCount(sb, u, ctx)) >= limitOf(ctx.cust)) throw new SocialError("autoreply_limit", `Your plan runs ${limitOf(ctx.cust)} auto-replies at once. Pause one or upgrade for more.`, 409);
      const r = await ctx.c.call("PATCH", `/comment-automations/${encodeURIComponent(id)}`, { body: patch });
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
      if (isOwnRuleId(String(req.params.id))) {
        const own = await ownOne(sb, u, ctx, String(req.params.id));
        const d = await sb.from("studio_reply_rules").delete().eq("id", own.id).eq("user_id", u);
        if (d.error) throw new SocialError("autoreply_failed", "Could not delete", 502);
        const st = (await statsOf(sb, [own.id])).get(own.id);
        recordEvent({ user_id: u, kind: "feature", name: "autoreply_deleted", props: { platform: own.platform, sent: st?.sent ?? 0, dm: false } });
        return res.json({ ok: true });
      }
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
      const skip0 = Math.max(0, Math.floor(Number(req.query.skip) || 0));
      if (isOwnRuleId(String(req.params.id))) {
        const own = await ownOne(sb, u, ctx, String(req.params.id));
        const r = await sb.from("studio_reply_log").select("created_at,commenter,comment_text,status,error").eq("rule_id", own.id).order("created_at", { ascending: false }).range(skip0, skip0 + 50);
        const got = (r.data ?? []) as any[];
        const rows = got.slice(0, 50).map((l) => ({ at: l.created_at, who: l.commenter ?? null, text: l.comment_text ?? null, source: "comment", status: l.status, error: l.status === "failed" ? l.error ?? "Not sent" : null, clicked: false }));
        return res.json({ rows, more: got.length > 50, misses: { total: 0, days: null, samples: [] } });
      }
      await ownRule(ctx, String(req.params.id));
      const skip = Math.max(0, Math.floor(Number(req.query.skip) || 0));
      const r = await ctx.c.call("GET", `/comment-automations/${encodeURIComponent(String(req.params.id))}/logs?limit=50&skip=${skip}`);
      if (r.status >= 300) throw new SocialError("autoreply_failed", ctx.c.clean(r.body?.error, "Could not read the activity"), 502);
      const rows = ((r.body?.logs ?? []) as any[]).map((l) => ({ at: l.createdAt ?? l.at ?? null, who: l.commenterUsername ?? l.commenterName ?? null, text: l.commentText ?? null, source: l.source ?? "comment", status: l.status ?? null, error: l.status === "failed" ? ctx.c.clean(l.error ?? l.errorMessage, "Not sent") : null, clicked: !!l.clicked }));
      res.json({ rows, more: !!r.body?.pagination?.hasMore, misses: { total: r.body?.misses?.total ?? 0, days: r.body?.misses?.retentionDays ?? null, samples: ((r.body?.misses?.samples ?? []) as any[]).slice(0, 5).map((m) => ({ text: m.commentText ?? null, at: m.at ?? null })) } });
    } catch (e) { fail(res, e); }
  });
}

// ---------------------------------------------------------------------------------------------------
// An auto-reply attached to what was just posted (Publish, Clips scheduling, the chat card, "Post with auto-DM")
// ---------------------------------------------------------------------------------------------------
/** What the person asked for alongside a post: one keyword set, the DM (Instagram, Facebook) and the public reply. */
/** dm: false on Instagram and Facebook means a public reply only (studio-reply-only.ts); left out, a DM is sent as before. */
export type AutoReplySpec = { keywords?: string[]; dm_message?: string; button?: { title: string; url: string } | null; comment_reply?: string; name?: string; dm?: boolean };
export type AttachResult = { on: Array<{ platform: string; username?: string | null; account_id?: string; scope: "post" | "account"; reused?: boolean }>; skipped: Array<{ platform: string; username?: string | null; account_id?: string; reason: "needs_permission" | "limit" | "no_reply_text" | "not_linked" | "failed"; detail?: string; /** kept on the post; starts once the account allows it */ waiting?: boolean }> };
/** An auto-reply waiting for an account's permission, kept on the post (options.autoreply_wait) so it starts by itself
 *  once the person allows replies and DMs (the Allow button or the relink), instead of being lost (owner, Nov 24 2026). */
export type AutoReplyWait = { spec: AutoReplySpec; accounts: string[]; via?: string; since: string };
type PostIn = { id?: string; batch_id?: string | null; provider_post_id: string | null; platforms: string[]; options?: any; status: string };

/** Turn on the auto-reply for posts just made. One post: a rule bound to that post on each network (it arms itself when
 *  a scheduled post goes out). Several posts (a batch of clips): one rule per account for every post, reused when the
 *  same keywords already have one. Never throws: the posts went out either way; what could not be set up is reported. */
export async function attachAutoReplies(sb: SupabaseClient, u: string, posts: PostIn[], spec: AutoReplySpec, deps: SocialDeps & { via?: string; /** only these accounts (resuming waiting ones) */ only?: string[] } = {}): Promise<AttachResult> {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const out: AttachResult = { on: [], skipped: [] };
  try {
    const c = env.SOCIAL_PROVIDER === "zernio" ? zernioClient({ env, fetch: deps.fetch, log }) : null;
    const prof = await sb.from("studio_social_profiles").select("provider,profile_key").eq("user_id", u).maybeSingle();
    const cust = await sb.from("studio_customers").select("plan_id,owner_pass").eq("user_id", u).maybeSingle();
    const live = posts.filter((p) => p.provider_post_id && p.status !== "failed");
    const nets = [...new Set(live.flatMap((p) => p.platforms))];
    if (!c || prof.data?.provider !== "zernio" || !live.length) { for (const n of nets) out.skipped.push({ platform: n, reason: "failed", detail: "Auto-replies are not available right now" }); return out; }
    const profileId = String(prof.data.profile_key);
    const accounts = await c.rawAccounts(profileId);
    const limit = (cust.data as any)?.owner_pass ? 100 : AUTOREPLY_LIMITS[(cust.data as any)?.plan_id] ?? AUTOREPLY_LIMITS.starter;
    const listed = await c.call("GET", `/comment-automations?profileId=${encodeURIComponent(profileId)}`);
    const rules = ((listed.body?.automations ?? listed.body?.data ?? []) as any[]).filter((r) => accounts.some((a) => String(a._id) === String(r.accountId)));
    const own = await ownRulesOf(sb, u, accounts.map((a) => String(a._id))).catch(() => [] as OwnRuleRow[]);
    let room = limit - rules.filter((r) => r.isActive !== false).length - own.filter((r) => r.active).length;
    const keys = (spec.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean).sort().join("|");
    // the accounts posted to (a post names them; older rows: the network's first account)
    const sendsIn = (p: { platforms: string[]; options?: any }) => (Array.isArray(p.options?.accounts) && p.options.accounts.length ? (p.options.accounts as any[]).map((a) => ({ id: a?.id ? String(a.id) : null, platform: String(a?.platform ?? "") })) : p.platforms.map((platform) => ({ id: null as string | null, platform })));
    const accOf = (t: { id: string | null; platform: string }) => (t.id ? accounts.find((a) => String(a._id) === t.id && a.isActive !== false) : accounts.find((a) => a.platform === t.platform && a.isActive !== false)) ?? null;
    const wanted = new Map<string, { platform: string; acc: any }>();
    for (const p of live) for (const t of sendsIn(p)) { const acc = accOf(t); const k = acc ? `a:${acc._id}` : `n:${t.platform}`; if (!wanted.has(k)) wanted.set(k, { platform: t.platform, acc }); }
    const only = deps.only ? new Set(deps.only.map(String)) : null;
    for (const { platform, acc } of wanted.values()) {
      if (only && (!acc || !only.has(String(acc._id)))) continue;
      if (!acc) { out.skipped.push({ platform, reason: "not_linked" }); continue; }
      const username = acc.username ? String(acc.username) : null, account_id = String(acc._id);
      const dmNet = DM_NETWORKS.includes(platform);
      const replyOnly = dmNet && spec.dm === false;
      if ((!dmNet || replyOnly) && !spec.comment_reply?.trim()) { out.skipped.push({ platform, username, account_id, reason: "no_reply_text" }); continue; }
      if (replyOnly && !replyOnlyOn(env)) { out.skipped.push({ platform, username, account_id, reason: "failed", detail: "Replies without a DM are not available yet" }); continue; }
      const h = await c.call("GET", `/accounts/${encodeURIComponent(acc._id)}/health`).catch(() => null);
      const can = capabilityOf(platform, h?.body);
      if (dmNet && !replyOnly ? !(can.dm && can.reply) : !can.reply) { out.skipped.push({ platform, username, account_id, reason: "needs_permission", waiting: true }); continue; }
      if (replyOnly) {
        // reply only on Instagram or Facebook: our own rule (one post, or one for every post in a batch)
        let fields: Partial<OwnRuleRow>;
        try { fields = cleanOwnRule({ name: spec.name || `Keyword ${spec.keywords?.[0] ?? ""}`.trim(), keywords: spec.keywords, comment_reply: spec.comment_reply, match: "word" }); }
        catch (e: any) { out.skipped.push({ platform, username, account_id, reason: "failed", detail: e?.message }); continue; }
        const mineOwn = live.filter((p) => sendsIn(p).some((t) => accOf(t) && String(accOf(t)!._id) === String(acc._id)));
        if (mineOwn.length > 1) {
          const same = own.find((r) => r.account_id === String(acc._id) && !r.post_id && !r.platform_post_id && (r.keywords ?? []).map((k) => k.toLowerCase()).sort().join("|") === keys);
          if (same) {
            if (!same.active) { if (room <= 0) { out.skipped.push({ platform, username, account_id, reason: "limit" }); continue; } room--; }
            await sb.from("studio_reply_rules").update({ comment_reply: fields.comment_reply, active: true, updated_at: new Date().toISOString() }).eq("id", same.id).eq("user_id", u);
            out.on.push({ platform, username, account_id, scope: "account", reused: true }); continue;
          }
        }
        if (room <= 0) { out.skipped.push({ platform, username, account_id, reason: "limit" }); continue; }
        const one = mineOwn.length === 1 ? String(mineOwn[0].provider_post_id) : null;
        const ins = await sb.from("studio_reply_rules").insert({ ...fields, name: (one ? fields.name! : `${fields.name} (every post)`).slice(0, 60), post_id: one, user_id: u, account_id: String(acc._id), platform }).select("id").maybeSingle();
        if (ins.error) { out.skipped.push({ platform, username, account_id, reason: "failed", detail: "Could not set it up" }); continue; }
        room--; out.on.push({ platform, username, account_id, scope: one ? "post" : "account" });
        continue;
      }
      let fields: Record<string, any>;
      try { fields = cleanRule({ name: spec.name || `Keyword ${spec.keywords?.[0] ?? ""}`.trim(), keywords: spec.keywords, dm_message: dmNet ? spec.dm_message : undefined, button: dmNet ? spec.button ?? undefined : undefined, comment_reply: spec.comment_reply, match: "word" }, platform); }
      catch (e: any) { out.skipped.push({ platform, username, account_id, reason: "failed", detail: e?.message }); continue; }
      const mine = live.filter((p) => sendsIn(p).some((t) => accOf(t) && String(accOf(t)!._id) === String(acc._id)));
      if (mine.length > 1) {
        // a batch: one rule for every post on this account; the same keywords reuse the rule already there
        const same = rules.find((r) => String(r.accountId) === String(acc._id) && !r.platformPostId && !r.postId && (r.keywords ?? []).map((k: string) => k.toLowerCase()).sort().join("|") === keys);
        if (same) {
          if (same.isActive === false) { if (room <= 0) { out.skipped.push({ platform, username, account_id, reason: "limit" }); continue; } room--; }
          await c.call("PATCH", `/comment-automations/${encodeURIComponent(same.id ?? same._id)}`, { body: { ...fields, isActive: true } });
          out.on.push({ platform, username, account_id, scope: "account", reused: true }); continue;
        }
        if (room <= 0) { out.skipped.push({ platform, username, account_id, reason: "limit" }); continue; }
        const r = await c.call("POST", "/comment-automations", { body: { ...fields, name: `${fields.name} (every post)`.slice(0, 60), profileId, accountId: String(acc._id) } });
        if (r.status >= 300) { out.skipped.push({ platform, username, account_id, ...(r.status === 403 ? { reason: "needs_permission" as const, waiting: true } : { reason: "failed" as const, detail: c.clean(r.body?.error, "Could not set it up") }) }); continue; }
        room--; out.on.push({ platform, username, account_id, scope: "account" });
        continue;
      }
      // one post: bound to it; a scheduled post arms the rule when it goes out, a published one is bound by its network id
      if (room <= 0) { out.skipped.push({ platform, username, account_id, reason: "limit" }); continue; }
      const postId = String(mine[0].provider_post_id);
      let r = await c.call("POST", "/comment-automations", { body: { ...fields, profileId, accountId: String(acc._id), postId } });
      if (r.status >= 300 && r.status !== 403) {
        const got = await c.call("GET", `/posts/${encodeURIComponent(postId)}`);
        const pid = ((got.body?.post?.platforms ?? []) as any[]).find((x) => (x.accountId?._id ?? x.accountId) ? String(x.accountId?._id ?? x.accountId) === String(acc._id) : x.platform === platform)?.platformPostId;
        if (pid) r = await c.call("POST", "/comment-automations", { body: { ...fields, profileId, accountId: String(acc._id), platformPostId: String(pid) } });
      }
      if (r.status >= 300) { out.skipped.push({ platform, username, account_id, ...(r.status === 403 ? { reason: "needs_permission" as const, waiting: true } : { reason: "failed" as const, detail: c.clean(r.body?.error, "Could not set it up") }) }); continue; }
      room--; out.on.push({ platform, username, account_id, scope: "post" });
    }
    // what waits for a permission stays on its posts; what started (or can no longer start) is cleared
    const waitIds = new Set(out.skipped.filter((x) => x.waiting && x.account_id).map((x) => x.account_id!));
    const touched = new Set([...out.on, ...out.skipped].map((x) => x.account_id).filter(Boolean) as string[]);
    await noteWaiting(sb, u, live, (p) => sendsIn(p).map((t) => accOf(t)).filter(Boolean).map((a) => String(a._id)), waitIds, touched, spec, deps.via, log);
    for (const x of out.on) recordEvent({ user_id: u, kind: "feature", name: "autoreply_created", props: { platform: x.platform, via: deps.via ?? "post", scope: x.scope, reused: !!x.reused, dm: DM_NETWORKS.includes(x.platform) && spec.dm !== false } });
    for (const x of out.skipped) recordEvent({ user_id: u, kind: "feature", name: "autoreply_skipped", props: { platform: x.platform, via: deps.via ?? "post", reason: x.reason } });
    if (out.on.length) await touchSocial(sb, u);
  } catch (e: any) {
    log(`[autoreply] attach for ${u} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    for (const p of [...new Set(posts.flatMap((x) => x.platforms))]) if (!out.on.some((o) => o.platform === p) && !out.skipped.some((s) => s.platform === p)) out.skipped.push({ platform: p, reason: "failed" });
  }
  return out;
}

/** Keep (or clear) the waiting auto-reply on each post: the accounts of the post still waiting for a permission. */
async function noteWaiting(sb: SupabaseClient, u: string, posts: PostIn[], accountsOf: (p: PostIn) => string[], waitIds: Set<string>, touched: Set<string>, spec: AutoReplySpec, via: string | undefined, log: (s: string) => void) {
  const ids = posts.map((p) => p.id).filter(Boolean) as string[];
  if (!ids.length || (!waitIds.size && !posts.some((p) => p.options?.autoreply_wait))) return;
  const now = new Date().toISOString();
  // read the options fresh (a webhook may have written results since) and change only autoreply_wait
  const cur = await sb.from("studio_social_posts").select("id,options").eq("user_id", u).in("id", ids);
  if (cur.error) { log(`[autoreply] could not note waiting auto-replies for ${u}: ${String(cur.error.message).slice(0, 120)}`); return; }
  for (const row of (cur.data ?? []) as Array<{ id: string; options: any }>) {
    const post = posts.find((p) => p.id === row.id); if (!post) continue;
    const prev: AutoReplyWait | undefined = row.options?.autoreply_wait;
    const mine = accountsOf(post);
    // accounts not looked at this time keep waiting as they were
    const still = [...new Set([...mine.filter((a) => waitIds.has(a)), ...(prev?.accounts ?? []).filter((a) => !touched.has(a))])];
    if (!still.length && !prev) continue;
    const { autoreply_wait: _w, ...rest } = row.options ?? {};
    const next = still.length ? { ...rest, autoreply_wait: { spec: prev?.spec ?? spec, accounts: still, via: prev?.via ?? via, since: prev?.since ?? now } satisfies AutoReplyWait } : rest;
    if (prev && still.length === prev.accounts.length && still.every((a) => prev.accounts.includes(a))) continue;
    const w = await sb.from("studio_social_posts").update({ options: next }).eq("id", row.id).eq("user_id", u);
    if (w.error) log(`[autoreply] could not save the waiting auto-reply on ${row.id}: ${String(w.error.message).slice(0, 120)}`);
  }
}

const WAIT_DAYS = 30;
/** Posts of the person with an auto-reply waiting for a permission (the last 30 days, still live). */
async function waitingPosts(sb: SupabaseClient, u: string): Promise<Array<PostIn & { id: string; options: any }>> {
  const r = await sb.from("studio_social_posts").select("id,batch_id,provider_post_id,platforms,options,status,created_at")
    .eq("user_id", u).not("options->autoreply_wait", "is", null).gte("created_at", new Date(Date.now() - WAIT_DAYS * 86400_000).toISOString())
    .in("status", ["scheduled", "sending", "published", "partial"]).order("created_at", { ascending: true }).limit(500);
  if (r.error) throw r.error;
  return ((r.data ?? []) as any[]).filter((p) => Array.isArray(p.options?.autoreply_wait?.accounts) && p.options.autoreply_wait.accounts.length);
}

/** What waits, by account (the Auto-replies page and the post add-on show it with an Allow button). */
export async function waitingSummary(sb: SupabaseClient, u: string): Promise<Array<{ account_id: string; posts: number; keyword: string | null; since: string }>> {
  const by = new Map<string, { account_id: string; posts: number; keyword: string | null; since: string }>();
  for (const p of await waitingPosts(sb, u).catch(() => [])) {
    const w: AutoReplyWait = p.options.autoreply_wait;
    for (const a of w.accounts) { const x = by.get(a) ?? { account_id: a, posts: 0, keyword: w.spec?.keywords?.[0] ?? null, since: w.since }; x.posts++; if (w.since < x.since) x.since = w.since; by.set(a, x); }
  }
  return [...by.values()];
}

/** Start the auto-replies that were waiting for a permission (all, or one account's). Each send (batch) is resumed as it
 *  was asked: one post gets a rule on that post, a batch one rule for every post. What still lacks the permission keeps
 *  waiting. Never throws. */
const resumeChain = new Map<string, Promise<unknown>>();
export function resumeAutoReplies(sb: SupabaseClient, u: string, deps: SocialDeps & { accountId?: string } = {}): Promise<AttachResult & { waiting: number }> {
  // one at a time per person: the relink webhook and the app's Allow both resume, and two at once would make the same
  // rule twice (two DMs per comment); the second one runs after the first and finds nothing left waiting
  const prev = resumeChain.get(u) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => resumeOnce(sb, u, deps));
  resumeChain.set(u, run);
  void run.finally(() => { if (resumeChain.get(u) === run) resumeChain.delete(u); });
  return run;
}
async function resumeOnce(sb: SupabaseClient, u: string, deps: SocialDeps & { accountId?: string }): Promise<AttachResult & { waiting: number }> {
  const out: AttachResult & { waiting: number } = { on: [], skipped: [], waiting: 0 };
  const log = deps.log ?? ((s: string) => console.log(s));
  try {
    const rows = await waitingPosts(sb, u);
    const groups = new Map<string, typeof rows>();
    for (const p of rows) { const k = p.batch_id ?? p.id; groups.set(k, [...(groups.get(k) ?? []), p]); }
    for (const list of groups.values()) {
      const accounts = [...new Set(list.flatMap((p) => (p.options.autoreply_wait as AutoReplyWait).accounts))].filter((a) => !deps.accountId || a === deps.accountId);
      if (!accounts.length) continue;
      const w: AutoReplyWait = list[0].options.autoreply_wait;
      const r = await attachAutoReplies(sb, u, list, w.spec, { ...deps, via: "allowed", only: accounts });
      out.on.push(...r.on); out.skipped.push(...r.skipped);
    }
    out.waiting = (await waitingPosts(sb, u)).length;
    if (out.on.length) log(`[autoreply] ${u}: ${out.on.length} waiting auto-repl${out.on.length === 1 ? "y" : "ies"} started`);
  } catch (e: any) { log(`[autoreply] resume for ${u} failed: ${String(e?.message ?? e).slice(0, 160)}`); }
  return out;
}
