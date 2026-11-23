// Clone8 Studio: self-serve social posting. A paying person links their own networks (the provider's hosted linking
// page, opened from "Connect your socials"), then posts or schedules Studio outputs to them. Every provider call goes
// through social-provider.ts; this file never names the provider. The managed service keeps Publer and is untouched.
//
// Status flow of a post row: queued (a big batch, sent in the background) → sending → scheduled → posted | partial | failed, or canceled. The provider's webhook moves
// it; a loop reads back any post the webhook left behind, so a missed delivery never strands a row.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { SOCIAL_ACCOUNTS, SOCIAL_SEAT_USD, MAX_SOCIAL_EXTRA } from "./studio-pricing.js";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftCaption, type CaptionDraft } from "./studio-captions.js";
import { getSocialProvider, providerNamed, isSocialPlatform, SocialError, statusOf, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult, type PostTarget } from "./social-provider.js";
import { groupsOf, publicGroup, staggerTimes, varyCaptions } from "./studio-post-groups.js";
import { hasPlanAccess } from "./studio-limits.js";
import { recordEvent } from "./studio-events.js";
import { attachAutoReplies, type AutoReplySpec } from "./studio-autoreply.js";
import { CLEAR_MESSAGE, clearProfile, keepUntil, recordSocialCosts, socialUpkeep, touchSocial, upkeepFacts, upkeepSettings, type ClearReason } from "./studio-social-upkeep.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Outputs are kept 30 days after the job finishes; a post must go out a day before that. */
/** The provider needs a little lead time; anything sooner than this goes out now. */
const MIN_LEAD_MS = 5 * 60_000;
const MAX_ITEMS = 200;
/** Nothing is scheduled further out than this (the provider and the kept files both allow it). */
const MAX_AHEAD_DAYS = 90;
/** Posts a person may send in 24 hours (the provider's monthly allowance is shared by everyone). */
/** Per person, a safety net; the real limit is per account (below). */
const dailyCap = (env: Record<string, string | undefined>) => Math.max(1, Number(env.STUDIO_SOCIAL_DAILY_POSTS) || 400);
/** Per account per day: TikTok's own limit is about 15 a day, shared by every app posting to the account. */
const dailyPerAccount = (env: Record<string, string | undefined>) => Math.max(1, Number(env.STUDIO_SOCIAL_DAILY_PER_ACCOUNT) || 15);
/** What a post says when the service never answered: it may have gone out, so it is never sent again on its own. */
export const UNCONFIRMED = "We could not confirm this went out. Check the network before posting it again.";
/** Where the linking page may send the person back to: the Clone8 app only. */
export function safeReturn(v: any, env: Record<string, string | undefined>): string | undefined {
  if (typeof v !== "string") return undefined;
  let u: URL; try { u = new URL(v); } catch { return undefined; }
  const extra = (env.STUDIO_SOCIAL_RETURN_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const ok = (u.protocol === "https:" && (u.hostname === "clone8.io" || u.hostname.endsWith(".clone8.io") || u.hostname === "tradvio-reels.vercel.app"))
    || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) || extra.includes(u.origin);
  return ok ? u.toString() : undefined;
}
const sameText = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
/** A fingerprint of where and how webhooks are registered, so a changed URL or secret registers again. */
export const webhookHash = (url: string, env: Record<string, string | undefined>) => createHash("sha256").update(`${url}\n${env.STUDIO_SOCIAL_WEBHOOK_SECRET ?? ""}`).digest("hex").slice(0, 32);

export type SocialPostRow = {
  id: string; user_id: string; provider: string; provider_post_id: string | null; job_id: string | null; output_key: string | null; asset_id?: string | null; conversation_id?: string | null;
  caption: string; platforms: string[]; options: Record<string, any>; schedule_at: string | null; status: string;
  results: SocialResult[]; error: string | null; created_at: string; updated_at: string;
};

/** Where the provider should deliver post-status webhooks; the token in the query is checked on every delivery. */
export function webhookUrl(env: Record<string, string | undefined>): string | null {
  const base = (env.STUDIO_PUBLIC_API_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const token = env.STUDIO_SOCIAL_WEBHOOK_TOKEN;
  return base && token ? `${base}/api/studio/social/webhook?token=${encodeURIComponent(token)}` : null;
}

/** How many social accounts a person may post to: the plan's own plus the extra ones they added. One account per
 *  network (the person's one posting profile holds one of each), so extras stop at the networks offered: `networks` is
 *  how many are offered today, and max_extra never sells an account that could not be linked. */
export type Allowance = { plan: string | null; included: number; extra: number; total: number; price_usd_month: number; interval: "month" | "year"; max_extra: number };
export async function allowanceOf(sb: SupabaseClient, u: string, networks?: number): Promise<Allowance> {
  let c = await sb.from("studio_customers").select("plan_id,status,billing_interval,social_extra,owner_pass").eq("user_id", u).maybeSingle();
  if (c.error && /social_extra|owner_pass/.test(String(c.error.message ?? ""))) c = await sb.from("studio_customers").select("plan_id,status,billing_interval").eq("user_id", u).maybeSingle() as any;
  if (c.error) throw c.error;
  const d: any = c.data ?? {};
  const live = hasPlanAccess(d);
  // the owner pass posts to as many accounts as the largest plan
  const included = d.owner_pass && !SOCIAL_ACCOUNTS[d.plan_id] ? SOCIAL_ACCOUNTS.studio : live ? SOCIAL_ACCOUNTS[d.plan_id] ?? 1 : 0, extra = live ? Math.max(0, Number(d.social_extra ?? 0)) : 0;
  const interval = d.billing_interval === "year" ? "year" : "month";
  return { plan: d.plan_id ?? null, included, extra, total: included + extra, price_usd_month: interval === "year" ? SOCIAL_SEAT_USD.year_per_month : SOCIAL_SEAT_USD.month, interval, max_extra: usableExtra(included, networks) };
}
/** Extra accounts worth buying: up to one per network offered beyond the plan's own (never fewer than none). */
export function usableExtra(included: number, networks?: number): number {
  return networks == null ? MAX_SOCIAL_EXTRA : Math.max(0, Math.min(MAX_SOCIAL_EXTRA, networks - included));
}
/** Network options the person may set, cleaned: a YouTube title (required there) and its visibility; on Instagram a
 *  Trial Reel ("auto": Instagram shares a good one with followers, "manual": the person does it in the app) and a
 *  first comment posted under the post (the place for "Comment GUIDE" that an auto-reply answers). */
export const MAX_TRIAL_COPIES = 5;
/** Captions in one Trial Reel caption test (each its own Trial Reel of the same video). */
export const MAX_TEST_CAPTIONS = 3;
export function cleanOptions(platforms: string[], raw: any, caption: string): Record<string, any> {
  const out: Record<string, any> = {};
  if (platforms.includes("instagram")) {
    const ig: Record<string, any> = {};
    if (raw?.instagram?.trial === "auto" || raw?.instagram?.trial === "manual") ig.trial = raw.instagram.trial;
    const fc = typeof raw?.instagram?.first_comment === "string" ? raw.instagram.first_comment.trim().slice(0, 2200) : "";
    if (fc) ig.first_comment = fc;
    if (Object.keys(ig).length) out.instagram = ig;
  }
  if (platforms.includes("youtube")) {
    const title = String(raw?.youtube?.title ?? "").trim() || caption.split("\n")[0].slice(0, 100) || "New video";
    const visibility = ["public", "unlisted", "private"].includes(raw?.youtube?.visibility) ? raw.youtube.visibility : "public";
    out.youtube = { title: title.slice(0, 100), visibility };
  }
  return out;
}

export function registerSocial(app: Express, sbFn: () => SupabaseClient, deps: SocialDeps & { provider?: SocialProvider | null; caption?: (sb: SupabaseClient, u: string, req: any, d: any) => Promise<CaptionDraft> } = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const provider = () => (deps.provider !== undefined ? deps.provider : getSocialProvider({ ...deps, env }));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof SocialError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "social_unavailable", detail: "The social posting migration has not been applied" });
    console.error("[social]", msg);
    res.status(500).json({ error: "social_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  const need = (): SocialProvider => { const p = provider(); if (!p) throw new SocialError("social_off", "Social posting is not switched on yet", 503); return p; };
  // A row made with another provider (Ayrshare before the Nov 21 2026 move to Zernio) counts as not connected here;
  // it is retired when the person links again, or by the hourly upkeep.
  const profileOf = async (sb: SupabaseClient, u: string) => {
    const r = await sb.from("studio_social_profiles").select("*").eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    const row = r.data as { user_id: string; provider?: string; profile_key: string; accounts: SocialAccount[]; webhook_registered_at: string | null; webhook_hash?: string | null; created_at?: string } | null;
    const p = provider();
    return row && p && row.provider && row.provider !== p.name ? null : row;
  };
  const retireForeign = async (sb: SupabaseClient, p: SocialProvider, u: string) => {
    const r = await sb.from("studio_social_profiles").select("user_id,provider,profile_key,accounts,created_at").eq("user_id", u).maybeSingle();
    const row = r.data as any;
    if (!row || !row.provider || row.provider === p.name) return;
    await clearProfile(sb, providerNamed(row.provider, { env, fetch: deps.fetch, log }), row, "provider_moved", log, { from: row.provider, to: p.name, on: "connect" });
  };
  const requirePlan = async (sb: SupabaseClient, u: string) => {
    const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
    if (c.error) throw c.error;
    if (!hasPlanAccess(c.data)) throw new SocialError("subscription_required", "Posting to your socials comes with a plan", 409);
  };
  // Why the person's accounts were unlinked, shown on the Publish page for 30 days (until they connect again).
  const clearedNote = async (sb: SupabaseClient, u: string): Promise<{ at: string; reason: ClearReason; message: string } | null> => {
    try {
      const r = await sb.from("studio_social_prefs").select("cleared_at,cleared_reason").eq("user_id", u).maybeSingle();
      const d = r.data as { cleared_at: string | null; cleared_reason: ClearReason | null } | null;
      if (r.error || !d?.cleared_at || !d.cleared_reason || Date.now() - Date.parse(d.cleared_at) > 30 * 86400_000) return null;
      return { at: d.cleared_at, reason: d.cleared_reason, message: CLEAR_MESSAGE[d.cleared_reason] ?? CLEAR_MESSAGE.idle };
    } catch { return null; }
  };
  const ensureWebhook = async (sb: SupabaseClient, p: SocialProvider, u: string, profileKey: string, registeredHash: string | null | undefined) => {
    const url = webhookUrl(env);
    if (!url || !env.STUDIO_SOCIAL_WEBHOOK_SECRET) return;
    const hash = webhookHash(url, env);
    if (registeredHash === hash) return;
    try { await p.registerWebhook(profileKey, url); await sb.from("studio_social_profiles").update({ webhook_registered_at: new Date().toISOString(), webhook_hash: hash }).eq("user_id", u); }
    catch (e: any) { log(`[social] webhook registration failed for ${u}: ${String(e?.message ?? e).slice(0, 160)}`); } // the loop still reads statuses back
  };

  // What the person has linked. The provider is the truth; the stored list is a cache for when it is slow.
  app.get("/api/studio/social", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    const p = provider();
    if (!p) return res.json({ enabled: false, connected: false, accounts: [], platforms: [] });
    try {
      const sb = sbFn();
      const [prof, allowance] = await Promise.all([profileOf(sb, u), allowanceOf(sb, u)]);
      if (!prof) return res.json({ enabled: true, connected: false, accounts: [], platforms: p.offered(), linking: p.linking ?? "page", allowance, cleared: await clearedNote(sb, u) });
      let accounts = prof.accounts ?? [], stale = false;
      try {
        accounts = await p.accounts(prof.profile_key);
        await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", u);
      } catch (e: any) { stale = true; log(`[social] accounts read failed for ${u}: ${String(e?.message ?? e).slice(0, 160)}`); }
      if (!stale) void ensureWebhook(sb, p, u, prof.profile_key, prof.webhook_hash); // re-registers after a URL or secret change
      // when the accounts are unlinked for lack of use (null: kept regardless, or nothing linked)
      const s = upkeepSettings(env);
      const f = (await upkeepFacts(sb, [u], s.idleDays).catch(() => null))?.get(u);
      const keep_until = s.mode === "on" && f ? keepUntil({ ...(prof as any), accounts }, f.lastPostAt, { idleDays: s.idleDays, held: f.held }) : null;
      const extra = await postingFacts(sb, u, accounts, env).catch((e) => { log(`[social] posting facts failed for ${u}: ${String(e?.message ?? e).slice(0, 120)}`); return {}; });
      res.json({ enabled: true, connected: accounts.length > 0, accounts, stale, platforms: p.offered(), linking: p.linking ?? "page", allowance, keep_until, idle_days: s.idleDays, ...extra });
    } catch (e) { fail(res, e); }
  });

  // "Connect your socials": a profile on first use, then a fresh linking link every time. One at a time per person, so
  // several tabs pressing it together make one provider profile, not several (each counts against the plan's cap).
  const connecting = new Map<string, Promise<unknown>>();
  app.post("/api/studio/social/connect", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    const before = connecting.get(u) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const chain = before.then(() => mine);
    connecting.set(u, chain);
    await before.catch(() => undefined);
    try {
      const p = need(), sb = sbFn();
      await requirePlan(sb, u);
      // one link per network with some providers: the page sends which network to link
      const platform = typeof req.body?.platform === "string" ? String(req.body.platform) : undefined;
      if (p.linking === "per_network" && (!platform || !p.offered().includes(platform))) throw new SocialError("pick_network", "Pick the network to link", 400);
      let prof = await profileOf(sb, u);
      if (!prof) {
        await retireForeign(sb, p, u);
        // The provider plan holds a fixed number of profiles; stop cleanly (and say so in the log) before it is full.
        const cap = Number(env.STUDIO_SOCIAL_PROFILE_CAP) || 0;
        if (cap) {
          const n = await sb.from("studio_social_profiles").select("user_id", { count: "exact", head: true });
          const used = n.count ?? 0;
          if (used >= cap) { log(`[social] ALERT profile cap reached (${used}/${cap}); linking refused for ${u}`); recordEvent({ user_id: u, kind: "feature", name: "social_linking_full", props: { used, cap } }); throw new SocialError("linking_full", "Linking is paused for a moment while we add room. Try again soon.", 503); }
          if (used + 1 >= Math.ceil(cap * 0.8)) log(`[social] ALERT profiles at ${used + 1}/${cap}; raise the posting plan soon`);
        }
        // The title shows on the linking page and must be unique in the provider account.
        const email = req.auth && "email" in req.auth ? String((req.auth as any).email ?? "") : "";
        let title = `Clone8 · ${email || u.slice(0, 8)}`;
        let made;
        try { made = await p.createProfile(title, u); }
        catch (e) {
          if (!(e instanceof SocialError && e.code === "profile_title_taken")) throw e;
          title = `Clone8 · ${email || u.slice(0, 8)} · ${Date.now().toString(36)}`; // an orphan from an earlier failed save
          log(`[social] profile title taken for ${u}; using ${title}`);
          made = await p.createProfile(title, u);
        }
        const ins = await sb.from("studio_social_profiles").insert({ user_id: u, provider: p.name, profile_key: made.profileKey, ref_id: made.refId, title }).select("*").single();
        if (ins.error) {
          // Two tabs raced: keep the stored profile, drop the one just made so it does not count against the plan.
          await p.deleteProfile(made.profileKey).catch(() => undefined);
          prof = await profileOf(sb, u);
          if (!prof) throw ins.error;
        } else prof = ins.data as any;
        log(`[social] profile created for ${u}`);
        const count = await sb.from("studio_social_profiles").select("user_id", { count: "exact", head: true });
        recordEvent({ user_id: u, kind: "feature", name: "social_profile_created", props: { profiles_now: count.count ?? null } });
      }
      await touchSocial(sb, u); // pressing Connect counts as use: the linking page gets its full time
      await ensureWebhook(sb, p, u, prof!.profile_key, prof!.webhook_hash);
      const redirect = safeReturn(req.body?.return_to, env) ?? env.STUDIO_SOCIAL_RETURN_URL;
      let origin: string | undefined;
      try { origin = redirect ? new URL(redirect).origin : undefined; } catch { origin = undefined; }
      // at the plan's account limit the linking page only relinks what is there (more accounts are added to the plan first)
      const allowance = await allowanceOf(sb, u);
      const linkedAccs = prof!.accounts ?? [];
      const linkedNow = linkedAccs.map((a) => a.platform);
      const full = linkedNow.length >= allowance.total;
      if (full && !linkedNow.length) throw new SocialError("account_limit", "Your plan has no social accounts yet; add one to link it", 409);
      // relink one account (account_id), or add another account of a network already linked (mode "add")
      const accountId = typeof req.body?.account_id === "string" && req.body.account_id ? String(req.body.account_id) : undefined;
      if (accountId && !linkedAccs.some((a) => a.id === accountId)) throw new SocialError("not_linked", "That account is not linked any more", 404);
      const add = req.body?.mode === "add" && !accountId;
      if (add && full) throw new SocialError("account_limit", `All ${allowance.total} account${allowance.total === 1 ? "" : "s"} on your plan are in use. Add one to your plan to link another.`, 409);
      // engage: ask the linked network for comments and messages too (auto-replies), refreshing that account in place
      const engage = req.body?.engage === true && !!platform && linkedNow.includes(platform);
      const link = await p.connectUrl(prof!.profile_key, { redirect, origin, platform, engage, add, accountId, ...(full && !engage && !accountId ? { only: linkedNow } : {}) });
      recordEvent({ user_id: u, kind: "feature", name: "social_connect_opened", props: { platform: platform ?? null, mode: accountId ? "relink" : add ? "add" : linkedNow.includes(platform ?? "") ? "same_network" : "new", engage, full, linked: linkedNow.length } });
      res.json({ url: link.url, expires_in_minutes: link.expiresInMinutes, relink_only: full });
    } catch (e) { fail(res, e); }
    finally { release(); if (connecting.get(u) === chain) connecting.delete(u); }
  });

  app.delete("/api/studio/social/accounts/:platform", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn();
      const platform = String(req.params.platform);
      if (!isSocialPlatform(platform) && platform !== "twitter") throw new SocialError("unknown_platform", "Not a network we post to");
      const prof = await profileOf(sb, u);
      if (!prof) throw new SocialError("not_connected", "Nothing is linked yet", 404);
      const account = typeof req.query.account === "string" && req.query.account ? String(req.query.account) : undefined;
      await p.disconnect(prof.profile_key, platform, account);
      const accounts = await p.accounts(prof.profile_key).catch(() => (prof.accounts ?? []).filter((a) => (account ? a.id !== account : a.platform !== platform)));
      await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", u);
      await touchSocial(sb, u);
      recordEvent({ user_id: u, kind: "feature", name: "social_network_changed", props: { platform, change: "unlinked", by: "person_in_clone8", one_account: !!account, left_on_network: accounts.filter((a) => a.platform === platform).length } });
      res.json({ accounts });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/studio/social/posts", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_social_posts").select("*").eq("user_id", u).order("created_at", { ascending: false }).limit(200);
      if (r.error) throw r.error;
      res.json({ posts: await withPostPosters(sb, u, (r.data ?? []) as SocialPostRow[]) });
    } catch (e) { fail(res, e); }
  });

  // Post or schedule one or more videos (Studio outputs or uploads). Several can be spread out: the first at
  // `schedule_at` (or now), each next one `spacing_minutes` later.
  app.post("/api/studio/social/posts", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const posts = await createPosts(sbFn(), need(), u, req.body ?? {}, { log, env, fetch: deps.fetch, via: typeof req.body?.via === "string" ? req.body.via.slice(0, 20) : "publish" });
      res.status(201).json({ posts, autoreply: posts.autoreply ?? null, queued: posts.queued, batch_id: posts.batch_id, skipped: posts.skipped });
    } catch (e) { fail(res, e); }
  });

  // "Write it for me": a caption drafted from the video's frames and speech. Needs a plan, not linked networks.
  app.post("/api/studio/social/caption", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      await requirePlan(sb, u);
      const b = req.body ?? {};
      const item = UUID_RE.test(String(b.asset_id ?? "")) ? { asset_id: String(b.asset_id) } : await resolveItem(sb, u, b);
      const platforms = (Array.isArray(b.platforms) ? b.platforms : []).map(String).filter(isSocialPlatform);
      const draft = await (deps.caption ?? draftCaption)(sb, u, { ...item, platforms, note: b.note ? String(b.note) : null, variants: Number(b.variants) || undefined }, { env, fetch: deps.fetch, log });
      await touchSocial(sb, u);
      res.json({ draft });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/social/posts/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new SocialError("post_not_found", "No such post", 404);
      const r = await sb.from("studio_social_posts").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      const row = r.data as SocialPostRow | null;
      if (!row) throw new SocialError("post_not_found", "No such post", 404);
      if (row.status === "queued") {
        // not sent yet: taken out of its batch before the sender reaches it
        const c = await sb.from("studio_social_posts").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "queued").select("*");
        if ((c.data ?? []).length) { await touchSocial(sb, u); return res.json({ post: publicPost(c.data![0] as SocialPostRow, null) }); }
        throw new SocialError("not_cancelable", "It is being sent right now; cancel it in a moment", 409);
      }
      if (row.status !== "scheduled") throw new SocialError("not_cancelable", "Only a scheduled post can be canceled", 409);
      // past its time it may already be live; canceling then would delete a published post
      if (!row.schedule_at || Date.parse(row.schedule_at) - Date.now() < 60_000) throw new SocialError("not_cancelable", "It is going out now and can no longer be canceled", 409);
      const prof = await profileOf(sb, u);
      if (row.provider_post_id && prof) await p.cancel(prof.profile_key, row.provider_post_id);
      const upd = await sb.from("studio_social_posts").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
      await touchSocial(sb, u);
      res.json({ post: publicPost((upd.data ?? row) as SocialPostRow, null) });
    } catch (e) { fail(res, e); }
  });

  // Change a post that has not gone out: a new time (every account moves by the same amount, so accounts of one network
  // stay spaced apart), a new caption (each account's sign-off kept), a new YouTube title. In place on the provider.
  app.patch("/api/studio/social/posts/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn(), b = req.body ?? {};
      if (!UUID_RE.test(req.params.id)) throw new SocialError("post_not_found", "No such post", 404);
      const r = await sb.from("studio_social_posts").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      const row = r.data as SocialPostRow | null;
      if (!row) throw new SocialError("post_not_found", "No such post", 404);
      if (row.status !== "scheduled" && row.status !== "queued") throw new SocialError("not_editable", "Only a post that has not gone out can be changed", 409);
      const stored = (Array.isArray(row.options?.accounts) ? row.options.accounts : []) as StoredTarget[];
      const now = Date.now();
      const firstOut = Math.min(...[row.schedule_at, ...stored.map((t) => t.at)].filter(Boolean).map((x) => Date.parse(String(x))));
      if (row.status === "scheduled" && (!Number.isFinite(firstOut) || firstOut - now < 2 * 60_000)) throw new SocialError("not_editable", "It is going out now and can no longer be changed", 409);
      let newAt: Date | null = null;
      if (b.schedule_at != null) {
        newAt = new Date(String(b.schedule_at));
        if (Number.isNaN(newAt.getTime())) throw new SocialError("bad_schedule", "That date is not readable");
        if (newAt.getTime() - now < MIN_LEAD_MS - 30_000) throw new SocialError("too_soon", "Pick a time at least 5 minutes from now");
        if (newAt.getTime() > now + MAX_AHEAD_DAYS * 86400_000) throw new SocialError("too_late", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead`);
      }
      const newCaption = typeof b.caption === "string" ? String(b.caption).slice(0, 5000) : null;
      const newTitle = typeof b.youtube_title === "string" && b.youtube_title.trim() ? Array.from(String(b.youtube_title).trim()).slice(0, 100).join("") : null;
      if (!newAt && newCaption == null && !newTitle) throw new SocialError("nothing_to_change", "Nothing to change");
      const base = row.schedule_at ? Date.parse(row.schedule_at) : now;
      const delta = newAt ? newAt.getTime() - base : 0;
      const groups = newCaption != null && stored.some((t) => t.group) ? new Map((await groupsOf(sb, u)).map((g) => [g.id, g])) : new Map();
      const accounts: StoredTarget[] = stored.map((t) => {
        const at = t.at ? new Date(Date.parse(t.at) + delta).toISOString() : newAt ? newAt.toISOString() : null;
        if (newCaption == null) return { ...t, at };
        const extra = t.group ? groups.get(t.group)?.defaults?.caption_extra : undefined;
        return { ...t, at, caption: extra && !newCaption.includes(extra) ? `${newCaption.trim()}\n\n${extra}`.slice(0, 5000) : null };
      });
      if (accounts.some((t) => t.at && Date.parse(t.at) > now + MAX_AHEAD_DAYS * 86400_000)) throw new SocialError("too_late", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead`);
      // the new day's allowance, per account, not counting this post where it was
      if (newAt) {
        const DAY = 86400_000, dayOf = (ms: number) => Math.floor(ms / DAY);
        const targetDays = new Set(accounts.map((t) => dayOf(t.at ? Date.parse(t.at) : newAt!.getTime())));
        const from = new Date(Math.min(...[...targetDays]) * DAY).toISOString();
        const others = await sb.from("studio_social_posts").select("id,platforms,options,status,error,schedule_at,created_at").eq("user_id", u).neq("status", "canceled").neq("id", row.id).gte("schedule_at", from).limit(5000);
        if (others.error) throw others.error;
        const per = new Map<string, number>(), cap = dailyPerAccount(env);
        const tok = (t: { id: string | null; platform: string }) => (t.id ? `acct:${t.id}` : `net:${t.platform}`);
        for (const o of (others.data ?? []) as any[]) {
          if (o.status === "failed" && o.error !== UNCONFIRMED) continue;
          const st = (Array.isArray(o.options?.accounts) ? o.options.accounts : []) as StoredTarget[];
          for (const t of sendsOf(o)) { const s2 = st.find((x) => x.id && x.id === t.id); const k = `${tok(t)}|${dayOf(Date.parse(s2?.at ?? o.schedule_at))}`; per.set(k, (per.get(k) ?? 0) + 1); }
        }
        for (const t of accounts) {
          const k = `${tok(t)}|${dayOf(t.at ? Date.parse(t.at) : newAt.getTime())}`;
          if ((per.get(k) ?? 0) + 1 > cap) throw new SocialError("daily_limit", `${t.username ? `@${t.username}` : t.platform} already has ${cap} posts that day, its daily limit. Pick another day.`, 429);
        }
      }
      const options: Record<string, any> = { ...(row.options ?? {}), accounts };
      if (newTitle && options.youtube) options.youtube = { ...options.youtube, title: newTitle };
      if (row.status === "scheduled" && row.provider_post_id) {
        const prof = await profileOf(sb, u);
        if (!prof || !p.update) throw new SocialError("not_editable", "This post can't be changed right now; cancel it and schedule it again", 409);
        const targets = accounts.length && accounts.every((t) => t.id) ? accounts.map((t) => ({ accountId: t.id!, platform: t.platform, at: t.at ? new Date(t.at) : newAt, text: t.caption ?? newCaption ?? row.caption })) : undefined;
        await p.update(prof.profile_key, row.provider_post_id, { ...(newAt ? { scheduleAt: newAt } : {}), ...(newCaption != null ? { text: newCaption } : {}), ...(targets ? { targets } : {}), ...(newTitle ? { options: { youtube: { title: newTitle } } } : {}) });
      }
      const patch: Record<string, any> = { options, updated_at: new Date().toISOString() };
      if (newAt) patch.schedule_at = newAt.toISOString();
      if (newCaption != null) patch.caption = newCaption;
      const upd = await sb.from("studio_social_posts").update(patch).eq("id", row.id).eq("user_id", u).select("*").single();
      if (upd.error) throw upd.error;
      await touchSocial(sb, u);
      recordEvent({ user_id: u, kind: "feature", name: "social_post_edited", props: { moved: !!newAt, caption: newCaption != null, title: !!newTitle, status: row.status } });
      res.json({ post: (await withPostPosters(sb, u, [upd.data as SocialPostRow]))[0] });
    } catch (e) { fail(res, e); }
  });

  // Send again only the accounts that failed (relinked, or the network's refusal passed). Never where it went out,
  // never a send we could not confirm (it may be live).
  app.post("/api/studio/social/posts/:id/retry", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new SocialError("post_not_found", "No such post", 404);
      const r = await sb.from("studio_social_posts").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      const row = r.data as SocialPostRow | null;
      if (!row) throw new SocialError("post_not_found", "No such post", 404);
      if (row.error === UNCONFIRMED) throw new SocialError("not_retryable", "We could not confirm whether this went out. Check the network first; if it is not there, post it again.", 409);
      if (row.status !== "failed" && row.status !== "partial") throw new SocialError("not_retryable", "Only a post that failed can be retried", 409);
      if (!row.provider_post_id) throw new SocialError("not_retryable", "This one never reached the posting service; post it again from the composer", 409);
      const last = Date.parse(String(row.options?.retried_at ?? 0));
      if (Number.isFinite(last) && Date.now() - last < 2 * 60_000) throw new SocialError("retry_too_soon", "It was just retried; give it a minute", 429);
      const ask = Array.isArray(req.body?.account_ids) ? req.body.account_ids.map(String) : null;
      const failed = ((row.results ?? []) as SocialResult[]).filter((x) => x.status === "failed" && (!ask || (x.account_id && ask.includes(x.account_id))));
      if (!failed.length) throw new SocialError("not_retryable", "Nothing failed on that post", 409);
      const prof = await profileOf(sb, u);
      if (!prof || !p.retry) throw new SocialError("not_retryable", "Retrying is not available right now", 409);
      const ev = await p.retry(prof.profile_key, row.provider_post_id, failed.map((x) => ({ platform: x.platform, accountId: x.account_id ?? null })));
      const options = { ...(row.options ?? {}), retried_at: new Date().toISOString() };
      await sb.from("studio_social_posts").update({ options, updated_at: new Date().toISOString() }).eq("id", row.id);
      if (ev) await applyEvent(sb, { ...ev, partial: true });
      const now = await sb.from("studio_social_posts").select("*").eq("id", row.id).single();
      await touchSocial(sb, u);
      recordEvent({ user_id: u, kind: "feature", name: "social_post_retried", props: { accounts: failed.length, platforms: [...new Set(failed.map((x) => x.platform))] } });
      res.json({ post: (await withPostPosters(sb, u, [(now.data ?? row) as SocialPostRow]))[0] });
    } catch (e) { fail(res, e); }
  });

  // The provider's post-status webhook. The token in the URL (set when we registered it) and the provider's own
  // verification both have to pass; then the row moves. Always 200 for a verified delivery we cannot match, so the
  // provider does not retry forever.
  app.post("/api/studio/social/webhook", async (req, res) => {
    const token = env.STUDIO_SOCIAL_WEBHOOK_TOKEN;
    if (!token) return res.status(503).json({ error: "webhook_unconfigured" });
    if (!sameText(String(req.query.token ?? ""), token)) return res.status(401).json({ error: "unauthorized" });
    const p = provider();
    if (!p) return res.status(503).json({ error: "social_off" });
    let hook;
    try { hook = p.parseWebhook(req.headers as any, String((req as any).rawBody ?? "")); }
    catch (e: any) { log(`[social] webhook rejected: ${String(e?.message ?? e).slice(0, 120)}`); return res.status(401).json({ error: "unverified" }); }
    if (!hook) return res.json({ ok: true, ignored: true });
    try {
      const sb = sbFn();
      if (hook.kind === "post") return res.json({ ok: true, updated: await applyEvent(sb, hook.event) });
      // A network linked, unlinked (by the person or by the network) or due for relinking: refresh the cached list.
      const prof = await sb.from("studio_social_profiles").select("user_id,profile_key").eq("ref_id", hook.refId).maybeSingle();
      if (prof.data) {
        const accounts = await p.accounts(prof.data.profile_key).catch(() => null);
        if (accounts) await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", prof.data.user_id);
        log(`[social] ${hook.platform} ${hook.change}${hook.bySystem ? " (by the network)" : ""} for ${prof.data.user_id}`);
        if (!hook.bySystem) await touchSocial(sb, prof.data.user_id); // linking or relinking is use; a network dropping a link is not
        recordEvent({ user_id: prof.data.user_id, kind: "feature", name: "social_network_changed", props: { platform: hook.platform, change: hook.change, by: hook.bySystem ? "network" : "person" } });
      }
      res.json({ ok: true });
    } catch (e: any) { console.error("[social] webhook", String(e?.message ?? e)); res.status(500).json({ error: "webhook_failed" }); }
  });
}

/** A video to post: a Studio output, or one of the person's uploads (it is posted from its stored file). */
export type PostItem = { job_id: string; output_key: string } | { asset_id: string };
type Resolved = { job_id: string | null; output_key: string | null; asset_id: string | null; bucket: "studio-outputs" | "studio-uploads"; key: string; keptUntil: number };

/** The person's own video, finished and still kept, with where its file is. For a caption, an output reference only. */
export async function resolveItem(sb: SupabaseClient, u: string, it: any): Promise<{ job_id: string; output_key: string }> {
  const job = String(it?.job_id ?? ""), key = String(it?.output_key ?? "");
  if (!UUID_RE.test(job) || !key) throw new SocialError("video_not_found", "That video is gone", 404);
  return { job_id: job, output_key: key };
}

async function resolveItems(sb: SupabaseClient, u: string, items: any[]): Promise<Resolved[]> {
  const jobIds = [...new Set(items.map((i) => String(i?.job_id ?? "")).filter((x) => UUID_RE.test(x)))];
  const assetIds = [...new Set(items.map((i) => String(i?.asset_id ?? "")).filter((x) => UUID_RE.test(x)))];
  const [jr, ar] = await Promise.all([
    jobIds.length ? sb.from("studio_jobs").select("id,status,outputs,finished_at").eq("user_id", u).in("id", jobIds) : Promise.resolve({ data: [], error: null } as any),
    assetIds.length ? sb.from("studio_assets").select("id,kind,status,object_key").eq("user_id", u).in("id", assetIds) : Promise.resolve({ data: [], error: null } as any),
  ]);
  if (jr.error) throw jr.error;
  if (ar.error) throw ar.error;
  const jobs = new Map(((jr.data ?? []) as any[]).map((j) => [j.id, j]));
  const assets = new Map(((ar.data ?? []) as any[]).map((a) => [a.id, a]));
  return items.map((it) => {
    if (it?.asset_id) {
      const a = assets.get(String(it.asset_id));
      if (!a || a.status !== "ready") throw new SocialError("video_not_found", "One of those videos is gone");
      if (a.kind !== "video") throw new SocialError("not_a_video", "Only videos can be posted for now");
      return { job_id: null, output_key: null, asset_id: a.id, bucket: "studio-uploads" as const, key: a.object_key, keptUntil: Number.POSITIVE_INFINITY };
    }
    const j = jobs.get(String(it?.job_id ?? ""));
    const out = j?.status === "done" ? (j.outputs ?? []).find((o: any) => o.key === it.output_key) : null;
    if (!out) throw new SocialError("video_not_found", "One of those videos is gone");
    if (out.kind && out.kind !== "video") throw new SocialError("not_a_video", "Only videos can be posted for now");
    // Made videos are not deleted (checked Nov 22 2026: no cleanup exists). If one is ever added, it must skip files a
    // queued or scheduled post still points at.
    return { job_id: j.id, output_key: out.key, asset_id: null, bucket: "studio-outputs" as const, key: out.key, keptUntil: Number.POSITIVE_INFINITY };
  });
}

/** Up to this many sends (video x account) go out while the page waits; a bigger batch is saved as queued and sent in
 *  the background, in order, so a 200-post batch is never one long, fragile request. */
const SYNC_SENDS = 12;
/** A send to one account: who, when, and its own caption when it differs. */
type Target = SocialAccount & { at?: Date | null; caption?: string | null; group?: string | null };
/** The accounts a stored row goes to, with their own time and caption (options.accounts). */
type StoredTarget = { id: string | null; platform: string; username: string | null; at?: string | null; caption?: string | null; group?: string | null; vary?: boolean };

/** Post or schedule videos for a person; every path that posts (the Post page, the Clips sheet, the chat's card,
 *  Blueprint sets) comes through here. A send names, per video or for all of them: accounts, posting groups, or
 *  networks (older pages: the first account of each). Groups bring their defaults: a sign-off under the caption,
 *  accounts of one network spaced apart, light caption rewording per account, an auto-reply, Trial Reels, YouTube
 *  visibility. Several videos can be spaced out, or each can carry its own time. */
export async function createPosts(sb: SupabaseClient, p: SocialProvider, u: string, b: any, opts: { conversationId?: string | null; log?: (s: string) => void; env?: Record<string, string | undefined>; via?: string; fetch?: typeof fetch } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s)), env = opts.env ?? process.env;
  const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
  if (c.error) throw c.error;
  if (!hasPlanAccess(c.data)) throw new SocialError("subscription_required", "Posting to your socials comes with a plan", 409);
  const pr = await sb.from("studio_social_profiles").select("provider,profile_key,accounts").eq("user_id", u).maybeSingle();
  if (pr.error) throw pr.error;
  const prof = pr.data as { provider?: string; profile_key: string; accounts: SocialAccount[] } | null;
  if (!prof) throw new SocialError("not_connected", "Connect your socials first", 409);
  if (prof.provider && prof.provider !== p.name) throw new SocialError("not_connected", "Posting moved to a new connection. Link your accounts again (it takes a minute), then post.", 409);
  // more linked than the plan covers (linked several at once on the linking page): posting waits for a fix
  const allowance = await allowanceOf(sb, u);
  const linkedCount = (prof.accounts ?? []).length;
  if (linkedCount > allowance.total) throw new SocialError("over_account_limit", `Your plan covers ${allowance.total} social account${allowance.total === 1 ? "" : "s"} and ${linkedCount} are linked. Add ${linkedCount - allowance.total} to your plan or unlink ${linkedCount - allowance.total === 1 ? "one" : "some"} to post.`, 409);
  let items: any[] = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS + 1) : [];
  if (!items.length) throw new SocialError("no_videos", "Pick at least one video");
  if (items.length > MAX_ITEMS) throw new SocialError("too_many_videos", `Up to ${MAX_ITEMS} videos at a time`);
  const offered = new Set(p.offered());
  const linkedAccs = prof.accounts ?? [];
  const wantsGroups = (Array.isArray(b.group_ids) && b.group_ids.length > 0) || items.some((it) => Array.isArray(it?.group_ids) && it.group_ids.length > 0);
  const groupById = new Map((wantsGroups ? await groupsOf(sb, u) : []).map((g) => [g.id, g]));
  const skipped: Array<{ group: string; platform: string | null; username: string | null; reason: "not_linked" | "unavailable" }> = [];

  /** The accounts one video goes to: its own pick, else the send's. Groups open into their linked accounts; an
   *  account reached twice (picked and in a group, or in two groups) is posted to once. */
  const targetsFor = (spec: any): { targets: Target[]; legacy: boolean } => {
    const ids = [...new Set((Array.isArray(spec?.accounts) ? spec.accounts : []).map(String).filter(Boolean))] as string[];
    const gids = [...new Set((Array.isArray(spec?.group_ids) ? spec.group_ids : []).map(String).filter(Boolean))] as string[];
    const out: Target[] = [], seen = new Set<string>();
    const add = (a: SocialAccount, group: string | null) => { const k = a.id ?? `net:${a.platform}`; if (!seen.has(k)) { seen.add(k); out.push({ ...a, group }); } };
    for (const gid of gids) {
      const g = groupById.get(gid);
      if (!g) throw new SocialError("group_not_found", "One of those groups is gone. Refresh the page and pick again.", 404);
      if (!g.account_ids.length) throw new SocialError("group_empty", `${g.name} has no accounts yet. Add accounts to it first.`, 409);
      for (const id of g.account_ids) {
        const a = linkedAccs.find((x) => x.id === id);
        if (!a) { skipped.push({ group: g.name, platform: null, username: null, reason: "not_linked" }); continue; }
        if (!offered.has(a.platform)) { skipped.push({ group: g.name, platform: a.platform, username: a.username ?? null, reason: "unavailable" }); continue; }
        add(a, g.id);
      }
    }
    if (ids.length) {
      const picked = ids.map((id) => linkedAccs.find((a) => a.id === id));
      if (picked.some((a) => !a)) throw new SocialError("account_not_linked", "One of the accounts you picked is not linked any more. Refresh the page and pick again.", 409);
      const off = (picked as SocialAccount[]).filter((a) => !offered.has(a.platform));
      if (off.length) throw new SocialError("platform_unavailable", `${[...new Set(off.map((a) => a.platform))].join(", ")} is not available right now`);
      for (const a of picked as SocialAccount[]) add(a, null);
    }
    if (!ids.length && !gids.length) {
      const asked = [...new Set((Array.isArray(spec?.platforms) ? spec.platforms : []).map(String))] as string[];
      const nets = asked.filter((x) => isSocialPlatform(x) && offered.has(x));
      if (asked.length && nets.length < asked.length) throw new SocialError("platform_unavailable", `${asked.filter((x) => !nets.includes(x)).join(", ")} is not available right now`);
      const missing = nets.filter((x) => !linkedAccs.some((a) => a.platform === x));
      if (missing.length) throw new SocialError("platform_not_linked", `Link ${missing.join(", ")} first`, 409);
      for (const x of nets) add(linkedAccs.find((a) => a.platform === x)!, null);
      return { targets: out, legacy: true };
    }
    if (!out.length) throw new SocialError("group_empty", "None of that group's accounts can be posted to right now. Relink them in Accounts.", 409);
    return { targets: out, legacy: false };
  };
  const own = (it: any) => (Array.isArray(it?.accounts) && it.accounts.length) || (Array.isArray(it?.group_ids) && it.group_ids.length) ? it : b;
  const groupsIn = (ts: Target[]) => [...new Set(ts.map((t) => t.group).filter(Boolean))].map((id) => groupById.get(id!)!).filter(Boolean);

  // Trial Reels go to non-followers first, so the same video may go out more than once (up to 5 copies, Instagram only)
  const askedTrial = b.options?.instagram?.trial === "auto" || b.options?.instagram?.trial === "manual" ? b.options.instagram.trial : null;
  type Item = { it: any; targets: Target[]; trial: "auto" | "manual" | null; test?: { id: string; variant: number; of: number; caption: string } };
  const expanded: Item[] = [];
  // A caption test: 2 or 3 captions, one Trial Reel each (non-followers first), to see which one people watch
  const testCaps = Array.isArray(b.caption_test?.captions) ? (b.caption_test.captions as unknown[]).map((c) => String(c ?? "").trim().slice(0, 2200)).filter(Boolean) : null;
  if (testCaps && (testCaps.length < 2 || testCaps.length > MAX_TEST_CAPTIONS)) throw new SocialError("caption_test_size", `A caption test takes 2 to ${MAX_TEST_CAPTIONS} captions`);
  if (testCaps && new Set(testCaps.map((c) => c.toLowerCase())).size !== testCaps.length) throw new SocialError("caption_test_same", "Each caption in a test has to be different");
  for (const it of items) {
    const { targets, legacy } = targetsFor(own(it));
    if (!targets.length) throw new SocialError("no_platforms", "Pick at least one account");
    const allIg = targets.every((t) => t.platform === "instagram");
    const groupTrial = groupsIn(targets).map((g) => g.defaults?.instagram_trial).find((x) => x === "auto" || x === "manual") ?? null;
    let trial: "auto" | "manual" | null = null;
    if (askedTrial) {
      if (allIg) trial = askedTrial;
      // older pages sent the option with other networks too: it was ignored there, and still is
      else if (!legacy) throw new SocialError("trial_instagram_only", "Trial Reels post to Instagram only. Pick only Instagram accounts, or turn Trial Reels off.");
    } else if (b.options?.instagram?.trial === undefined && groupTrial && allIg) trial = groupTrial;
    if (testCaps) {
      if (!trial) throw new SocialError("caption_test_trial_only", "Caption tests post as Instagram Trial Reels. Pick only Instagram accounts and turn Trial Reels on.");
      const id = randomUUID();
      testCaps.forEach((c, k) => expanded.push({ it, targets, trial, test: { id, variant: k, of: testCaps.length, caption: c } }));
      continue;
    }
    const copies = trial ? Math.min(Math.max(Math.floor(Number(b.trial_copies) || 1), 1), MAX_TRIAL_COPIES) : 1;
    for (let k = 0; k < copies; k++) expanded.push({ it, targets, trial });
  }
  if (expanded.length > MAX_ITEMS) throw new SocialError("too_many_videos", `Up to ${MAX_ITEMS} posts at a time (videos x copies)`);
  const anyTrial = expanded.some((e) => e.trial);

  /** One send per account: `acct:<id>`, or `net:<platform>` for rows from before accounts were named. */
  const tokenOf = (a: { id?: string | null; platform: string }) => (a.id ? `acct:${a.id}` : `net:${a.platform}`);
  const caption = String(b.caption ?? "").slice(0, 5000);
  // each video may bring its own caption and YouTube title (a batch of clips, each about something else)
  const captionOf = (e: Item) => (e.test ? e.test.caption : typeof e.it?.caption === "string" ? String(e.it.caption).slice(0, 5000) : caption);
  const optionsOf = (e: Item) => {
    const nets = [...new Set(e.targets.map((t) => t.platform))];
    const groupYt = groupsIn(e.targets).map((g) => g.defaults?.youtube_visibility).find(Boolean);
    const raw = { ...(b.options ?? {}), ...(typeof e.it?.youtube_title === "string" ? { youtube: { ...(b.options?.youtube ?? {}), title: e.it.youtube_title } } : {}) };
    if (groupYt && !raw.youtube?.visibility) raw.youtube = { ...(raw.youtube ?? {}), visibility: groupYt };
    const o = cleanOptions(nets, raw, captionOf(e));
    if (o.instagram) { delete o.instagram.trial; if (!Object.keys(o.instagram).length) delete o.instagram; }
    if (e.trial) o.instagram = { ...(o.instagram ?? {}), trial: e.trial };
    return o;
  };
  const spacing = Math.min(Math.max(Number(b.spacing_minutes ?? 0) || 0, 0), 7 * 24 * 60);
  const now = Date.now();
  const readTime = (v: any) => {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new SocialError("bad_schedule", "That date is not readable");
    // An asked-for time is kept or refused, never quietly turned into "now" (a card left open past its time).
    if (d.getTime() - now < MIN_LEAD_MS - 30_000) throw new SocialError("too_soon", "Pick a time at least 5 minutes from now");
    return d;
  };
  const first = b.schedule_at ? readTime(b.schedule_at) : null;
  const since = new Date(now - 86400_000).toISOString();
  const recent = await sb.from("studio_social_posts").select("job_id,output_key,asset_id,platforms,options,status,results,error").eq("user_id", u).gte("created_at", since).limit(2000);
  if (recent.error) throw recent.error;
  const rows24 = (recent.data ?? []) as Array<Pick<SocialPostRow, "job_id" | "output_key" | "asset_id" | "platforms" | "options" | "status" | "results" | "error">>;
  const resolved = await resolveItems(sb, u, expanded.map((e) => e.it));
  // The same video to the same account twice in a day is refused: networks treat it as a duplicate, and a send whose
  // outcome is unknown may already be live. Another account of the same network is fine.
  const keyOf = (x: { job_id: string | null; output_key: string | null; asset_id?: string | null }) => (x.asset_id ? `a:${x.asset_id}` : `o:${x.job_id}:${x.output_key}`);
  const taken = new Map<string, Set<string>>();
  for (const r of rows24) {
    const sent = new Set<string>();
    for (const t of sendsOf(r)) {
      const res = (r.results ?? []).find((x) => (t.id && x.account_id ? x.account_id === t.id : x.platform === t.platform));
      const live = ["queued", "sending", "scheduled", "posted"].includes(r.status) || r.error === UNCONFIRMED || (res ? ["posted", "pending", "scheduled"].includes(res.status) : r.status === "partial");
      if (live && r.status !== "canceled") sent.add(tokenOf(t));
    }
    const k = keyOf(r); taken.set(k, new Set([...(taken.get(k) ?? []), ...sent]));
  }
  resolved.forEach((x, i) => {
    if (expanded[i].trial) return;
    const t = taken.get(keyOf(x));
    const again = expanded[i].targets.filter((a) => t?.has(tokenOf(a)) || t?.has(`net:${a.platform}`));
    if (again.length) throw new SocialError("already_posted", `That video already went to ${again.map((a) => (a.username ? `@${a.username}` : a.platform)).join(", ")} today (or is on its way). Pick a different video or account.`, 409);
  });
  if (!anyTrial) {
    const seen = new Map<string, Set<string>>();
    resolved.forEach((x, i) => {
      const k = keyOf(x), s = seen.get(k) ?? new Set<string>();
      for (const a of expanded[i].targets) { if (s.has(tokenOf(a))) throw new SocialError("same_video_twice", "The same video is picked twice for the same account"); s.add(tokenOf(a)); }
      seen.set(k, s);
    });
  }
  const latest = now + MAX_AHEAD_DAYS * 86400_000;
  const natural = b.natural_timing === true;
  const plan = resolved.map((x, i) => {
    const e = expanded[i];
    let at = e.it?.schedule_at ? readTime(e.it.schedule_at) : first ? new Date(first.getTime() + i * spacing * 60_000) : spacing ? new Date(now + MIN_LEAD_MS + i * spacing * 60_000) : null;
    if (at && (at.getTime() > x.keptUntil || at.getTime() > latest)) throw new SocialError("too_late", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead`);
    // accounts of one network spaced apart (a group's default, or asked for); other networks keep the same time
    const groups = groupsIn(e.targets);
    const stagger = b.stagger_minutes != null ? Math.min(Math.max(Math.round(Number(b.stagger_minutes) || 0), 0), 240) : Math.max(0, ...groups.map((g) => Number(g.defaults?.stagger_minutes ?? 0)));
    const sameNet = e.targets.some((t, k) => e.targets.findIndex((o) => o.platform === t.platform) !== k);
    if (stagger > 0 && sameNet && !at) at = new Date(now + 2 * 60_000); // "now", then the rest of the network after it
    const times = at ? (stagger > 0 && sameNet ? staggerTimes(at, e.targets, stagger) : e.targets.map(() => at!)) : e.targets.map(() => null);
    // natural timing: a few minutes either side, so a schedule does not look automated (only well ahead of time)
    const jittered = times.map((d) => (d && natural && d.getTime() - now > 15 * 60_000 ? new Date(d.getTime() + Math.round((Math.random() * 8 - 4) * 60_000)) : d));
    if (jittered.some((d) => d && d.getTime() > latest)) throw new SocialError("too_late", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead`);
    const base = captionOf(e);
    // one caption per network when the composer sends them (TikTok short, Instagram fuller)
    const perNet = (e.test ? {} : e.it?.captions_by_network && typeof e.it.captions_by_network === "object" ? e.it.captions_by_network : b.captions_by_network && typeof b.captions_by_network === "object" ? b.captions_by_network : {}) as Record<string, unknown>;
    const baseFor = (platform: string) => (typeof perNet[platform] === "string" && String(perNet[platform]).trim() ? String(perNet[platform]).slice(0, 5000) : base);
    const vary = b.vary_captions != null ? b.vary_captions === true : groups.some((g) => g.defaults?.vary_captions === true);
    const targets: Target[] = e.targets.map((t, k) => {
      const extra = t.group ? groupById.get(t.group)?.defaults?.caption_extra : undefined;
      const own = baseFor(t.platform);
      const text = extra && !own.includes(extra) ? `${own.trim()}${own.trim() ? "\n\n" : ""}${extra}`.slice(0, 5000) : own;
      return { ...t, at: jittered[k], caption: text };
    });
    const groupId = groups.length === 1 ? groups[0].id : null;
    const meta = e.it?.caption_meta ?? b.caption_meta;
    const captionMeta = meta && typeof meta === "object" && ["ai", "edited", "own"].includes(meta.source) ? { source: meta.source, keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String).slice(0, 3) : undefined, per_network: Object.keys(perNet).length > 0 || undefined } : undefined;
    const test = e.test ? { caption_test: { id: e.test.id, variant: e.test.variant, of: e.test.of } } : {};
    // the captions of a test are the point of it: never reworded per account
    return { x, at, caption: base, options: { ...optionsOf(e), ...(captionMeta ? { caption_meta: captionMeta } : {}), ...test }, targets, vary: vary && sameNet && !e.test, groupId, groups };
  });
  // Daily allowance, counted on the day a post goes out (UTC): per account (TikTok's own limit is about 15 a day,
  // shared by every app posting to it) and, as a safety net, per person.
  const DAY = 86400_000, dayOf = (ms: number) => Math.floor(ms / DAY);
  const allTimes = plan.flatMap((r) => r.targets.map((t) => (t.at ?? r.at)?.getTime() ?? now));
  const fromDay = dayOf(Math.min(...allTimes)) * DAY;
  const out = await sb.from("studio_social_posts").select("platforms,options,status,error,schedule_at,created_at").eq("user_id", u).neq("status", "canceled")
    .or(`schedule_at.gte.${new Date(fromDay).toISOString()},and(schedule_at.is.null,created_at.gte.${new Date(fromDay).toISOString()})`).limit(5000);
  if (out.error) throw out.error;
  const perDay = new Map<number, number>(), perAcct = new Map<string, number>();
  const bump = (tok: string, ms: number) => { const d = dayOf(ms); perDay.set(d, (perDay.get(d) ?? 0) + 1); const k = `${tok}|${d}`; perAcct.set(k, (perAcct.get(k) ?? 0) + 1); };
  for (const r of (out.data ?? []) as any[]) {
    if (r.status === "failed" && r.error !== UNCONFIRMED) continue;
    const stored = (Array.isArray(r.options?.accounts) ? r.options.accounts : []) as StoredTarget[];
    for (const t of sendsOf(r)) { const own = stored.find((s) => s.id && s.id === t.id); bump(tokenOf(t), Date.parse(own?.at ?? r.schedule_at ?? r.created_at)); }
  }
  for (const r of plan) for (const t of r.targets) bump(tokenOf(t), (t.at ?? r.at)?.getTime() ?? now);
  const cap = dailyCap(env), perAccountCap = dailyPerAccount(env);
  const days = new Set(allTimes.map(dayOf));
  const dayName = (d: number) => new Date(d * DAY).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const overDay = [...perDay.entries()].find(([d, n]) => n > cap && days.has(d));
  if (overDay) throw new SocialError("daily_limit", `That is over the limit of ${cap} posts a day on ${dayName(overDay[0])}. Spread the posts over more days or pick fewer accounts.`, 429);
  const overAcct = [...perAcct.entries()].find(([k, n]) => n > perAccountCap && days.has(Number(k.split("|")[1])));
  if (overAcct) {
    const [tok, d] = overAcct[0].split("|");
    const a = linkedAccs.find((x) => tokenOf(x) === tok);
    const who = a ? `${a.username ? `@${a.username} on ` : ""}${a.platform.charAt(0).toUpperCase() + a.platform.slice(1)}` : "One account";
    throw new SocialError("daily_limit", `${who} would get ${overAcct[1]} posts on ${dayName(Number(d))}, over its limit of ${perAccountCap} a day. Spread them over more days.`, 429);
  }
  // an auto-reply asked for with the post, or the group's own
  const spec: AutoReplySpec | null = b.autoreply && typeof b.autoreply === "object"
    ? { keywords: Array.isArray(b.autoreply.keywords) ? b.autoreply.keywords.map(String) : [], dm_message: typeof b.autoreply.dm_message === "string" ? b.autoreply.dm_message : undefined, button: b.autoreply.button ?? null, comment_reply: typeof b.autoreply.comment_reply === "string" ? b.autoreply.comment_reply : undefined }
    : b.autoreply === null ? null : ((plan.flatMap((r) => r.groups).map((g) => g.defaults?.autoreply).find(Boolean) as AutoReplySpec | undefined) ?? null);
  const sends = plan.reduce((n, r) => n + r.targets.length, 0);
  const background = sends > SYNC_SENDS || b.background === true;
  const batchId = randomUUID();
  const via = typeof opts.via === "string" ? opts.via : opts.conversationId ? "chat" : "publish";
  const made: SocialPostRow[] = [];
  for (const r of plan) {
    const accounts: StoredTarget[] = r.targets.map((t) => ({ id: t.id ?? null, platform: t.platform, username: t.username ?? null, at: t.at ? t.at.toISOString() : null, caption: t.caption && t.caption !== r.caption ? t.caption : null, group: t.group ?? null, ...(r.vary ? { vary: true } : {}) }));
    const row = { user_id: u, provider: p.name, job_id: r.x.job_id, output_key: r.x.output_key, asset_id: r.x.asset_id, conversation_id: opts.conversationId ?? null, caption: r.caption, platforms: [...new Set(r.targets.map((t) => t.platform))], options: { ...r.options, accounts, ...(spec && background ? { autoreply_spec: spec, via } : {}) }, schedule_at: r.at?.toISOString() ?? null, status: background ? "queued" : "sending", batch_id: batchId, group_id: r.groupId };
    let ins = await sb.from("studio_social_posts").insert(row).select("*").single();
    // before the groups migration: the same row without the new columns
    if (ins.error && /batch_id|group_id|queued|status_check/i.test(String(ins.error.message ?? ""))) {
      if (background) throw new SocialError("batch_unavailable", `Up to ${SYNC_SENDS} posts at a time for now; send the rest after these`, 409);
      const { batch_id: _b, group_id: _g, ...older } = row as any;
      ins = await sb.from("studio_social_posts").insert(older).select("*").single();
    }
    if (ins.error) {
      // the ones already sent stay sent; stop here and report what went (never fail the whole call after a send)
      log(`[social] ${u} insert failed after ${made.length} post(s): ${String(ins.error.message ?? ins.error).slice(0, 160)}`);
      if (!made.length) throw ins.error;
      break;
    }
    if (background) { made.push(ins.data as SocialPostRow); continue; }
    made.push(await sendRow(sb, p, prof.profile_key, ins.data as SocialPostRow, { env, log, fetch: opts.fetch, resolved: r.x }));
  }
  const nets = [...new Set(plan.flatMap((r) => r.targets.map((t) => t.platform)))];
  log(`[social] ${u} ${background ? "queued" : "sent"} ${made.length} post(s), ${sends} send(s) on ${nets.join(",")}${wantsGroups ? ` via ${groupById.size} group(s)` : ""}: ${made.map((m) => m.status).join(",")}`);
  await touchSocial(sb, u);
  let autoreply: Awaited<ReturnType<typeof attachAutoReplies>> | null = null;
  if (!background && spec && made.some((m) => m.provider_post_id && m.status !== "failed")) autoreply = await attachAutoReplies(sb, u, made, spec, { env, log, via });
  recordEvent({ user_id: u, kind: "feature", name: "social_post_sent", props: { videos: made.length, networks: nets, accounts: new Set(plan.flatMap((r) => r.targets.map((t) => tokenOf(t)))).size, sends, groups: [...new Set(plan.flatMap((r) => r.groups.map((g) => g.id)))].length, staggered: plan.some((r) => r.targets.some((t) => t.at && r.at && t.at.getTime() !== r.at.getTime())), vary: plan.some((r) => r.vary), background, scheduled: made.filter((m) => m.status === "scheduled").length, failed: made.filter((m) => m.status === "failed").length, from_chat: !!opts.conversationId, via } });
  if (background) void drainBatch(sb, p, u, batchId, { env, log, fetch: opts.fetch });
  const sent = await withPostPosters(sb, u, made);
  return Object.assign(sent, { autoreply, queued: background, batch_id: batchId, skipped });
}

/** Send one saved row: its file signed for the provider, captions reworded where asked, one target per account. A
 *  failure where the provider may still have acted is kept open and marked, never sent again as new. */
async function sendRow(sb: SupabaseClient, p: SocialProvider, profileKey: string, row: SocialPostRow, ctx: { env: Record<string, string | undefined>; log: (s: string) => void; fetch?: typeof fetch; resolved?: Resolved }): Promise<SocialPostRow> {
  const now = Date.now();
  try {
    const x = ctx.resolved ?? (await resolveItems(sb, row.user_id, [row.asset_id ? { asset_id: row.asset_id } : { job_id: row.job_id, output_key: row.output_key }]))[0];
    const stored = (Array.isArray(row.options?.accounts) ? row.options.accounts : []) as StoredTarget[];
    // light rewording for accounts of the same network (the first keeps the caption), done once and kept on the row
    if (stored.some((t) => t.vary)) {
      const byNet = new Map<string, number[]>();
      stored.forEach((t, k) => byNet.set(t.platform, [...(byNet.get(t.platform) ?? []), k]));
      for (const ks of byNet.values()) {
        if (ks.length < 2) continue;
        const versions = await varyCaptions(row.caption, ks.length, { env: ctx.env, fetch: ctx.fetch, log: ctx.log, user: row.user_id });
        ks.forEach((k, n) => {
          if (n === 0) return;
          const extra = stored[k].caption && stored[k].caption!.startsWith(row.caption.trim()) ? stored[k].caption!.slice(row.caption.trim().length) : "";
          stored[k] = { ...stored[k], caption: `${versions[n]}${extra}`.slice(0, 5000) };
        });
      }
      for (const t of stored) delete t.vary;
      await sb.from("studio_social_posts").update({ options: { ...row.options, accounts: stored } }).eq("id", row.id);
      row = { ...row, options: { ...row.options, accounts: stored } };
    }
    const at = row.schedule_at ? new Date(row.schedule_at) : null;
    const lastAt = Math.max(at?.getTime() ?? now, ...stored.map((t) => (t.at ? Date.parse(t.at) : 0)));
    // The provider checks the link with a HEAD request and fetches it at publish time; it asks for 7 days at least.
    const ttl = Math.ceil(Math.min(Math.max(7 * 86400_000, lastAt - now + 2 * 86400_000), (MAX_AHEAD_DAYS + 2) * 86400_000) / 1000);
    const s = await sb.storage.from(x.bucket).createSignedUrl(x.key, ttl);
    if (s.error || !s.data?.signedUrl) throw new SocialError("video_unavailable", "That video could not be read", 502);
    const targets: PostTarget[] | undefined = stored.length && stored.every((t) => t.id) ? stored.map((t) => ({ accountId: t.id!, platform: t.platform, at: t.at ? new Date(t.at) : at, text: t.caption ?? null })) : undefined;
    const { accounts: _a, autoreply_spec: _s, via: _v, ...options } = row.options ?? {};
    const r = await p.publish(profileKey, { text: row.caption, platforms: row.platforms as any, ...(targets ? { targets, accounts: targets.map((t) => t.accountId) } : {}), mediaUrl: s.data.signedUrl, scheduleAt: at, options, idempotencyKey: row.id });
    const patch = { provider_post_id: r.providerPostId, status: r.status, results: r.results, error: r.error, updated_at: new Date().toISOString() };
    let upd = await sb.from("studio_social_posts").update(patch).eq("id", row.id).select("*").single();
    if (upd.error) upd = await sb.from("studio_social_posts").update(patch).eq("id", row.id).select("*").single();
    if (upd.error) ctx.log(`[social] ALERT post ${row.id} went out as ${r.providerPostId} but could not be saved: ${String(upd.error.message ?? upd.error).slice(0, 160)}`);
    return (upd.data ?? { ...row, ...patch }) as SocialPostRow;
  } catch (e: any) {
    if (e?.unknown) {
      // It may have gone out: keep it open and marked, so nothing (person or loop) sends it again as new.
      await sb.from("studio_social_posts").update({ status: "sending", error: UNCONFIRMED, updated_at: new Date().toISOString() }).eq("id", row.id);
      ctx.log(`[social] ${row.user_id} post ${row.id} outcome unknown: ${String(e?.message ?? e).slice(0, 160)}`);
      return { ...row, status: "sending", error: UNCONFIRMED };
    }
    const msg = e instanceof SocialError ? e.message : "The post could not be sent";
    if (!(e instanceof SocialError)) ctx.log(`[social] ${row.user_id} post ${row.id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    await sb.from("studio_social_posts").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { ...row, status: "failed", error: msg };
  }
}

/** Batches being sent by this process (the loop leaves them alone). */
const draining = new Set<string>();
/** Send a queued batch in order. Each row is claimed (queued to sending) before it goes, so two senders never send
 *  the same row; the provider's idempotency key is the row id, so a crash mid-send cannot post twice either. */
export async function drainBatch(sb: SupabaseClient, p: SocialProvider, u: string, batchId: string, ctx: { env?: Record<string, string | undefined>; log?: (s: string) => void; fetch?: typeof fetch } = {}): Promise<number> {
  if (draining.has(batchId)) return 0;
  draining.add(batchId);
  const env = ctx.env ?? process.env, log = ctx.log ?? ((s: string) => console.log(s));
  let n = 0;
  try {
    const prof = await sb.from("studio_social_profiles").select("profile_key,provider").eq("user_id", u).maybeSingle();
    if (!prof.data?.profile_key) { log(`[social] batch ${batchId}: no posting profile; left queued`); return 0; }
    const done: SocialPostRow[] = [];
    for (;;) {
      const next = await sb.from("studio_social_posts").select("id").eq("batch_id", batchId).eq("status", "queued").order("created_at", { ascending: true }).limit(1);
      const id = (next.data ?? [])[0]?.id;
      if (next.error || !id) break;
      const claim = await sb.from("studio_social_posts").update({ status: "sending", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "queued").select("*");
      const row = (claim.data ?? [])[0] as SocialPostRow | undefined;
      if (!row) continue; // someone else took it
      done.push(await sendRow(sb, p, prof.data.profile_key, row, { env, log, fetch: ctx.fetch }));
      n++;
    }
    const spec = done.map((r) => r.options?.autoreply_spec).find(Boolean) as AutoReplySpec | undefined;
    if (spec && done.some((m) => m.provider_post_id && m.status !== "failed")) await attachAutoReplies(sb, u, done, spec, { env, log, via: String(done[0]?.options?.via ?? "publish") });
    if (n) { log(`[social] batch ${batchId}: sent ${n} queued post(s) for ${u}`); recordEvent({ user_id: u, kind: "feature", name: "social_batch_sent", props: { posts: n, failed: done.filter((d) => d.status === "failed").length } }); }
  } catch (e: any) { log(`[social] batch ${batchId} stopped: ${String(e?.message ?? e).slice(0, 160)}`); }
  finally { draining.delete(batchId); }
  return n;
}

/** What the posting pages show beside the accounts: the person's groups, how many posts each account has today (its
 *  daily allowance is per account), and posts that failed while an account needed relinking, now that it is relinked
 *  (offered for one-click retry: no tool we compared does this). */
export async function postingFacts(sb: SupabaseClient, u: string, accounts: SocialAccount[], env: Record<string, string | undefined>) {
  const DAY = 86400_000, today = Math.floor(Date.now() / DAY);
  const [groups, near, bad] = await Promise.all([
    groupsOf(sb, u),
    sb.from("studio_social_posts").select("platforms,options,status,error,schedule_at,created_at").eq("user_id", u).neq("status", "canceled").gte("created_at", new Date(Date.now() - 2 * DAY).toISOString()).limit(2000),
    sb.from("studio_social_posts").select("id,provider_post_id,results,status,error,created_at").eq("user_id", u).in("status", ["failed", "partial"]).gte("created_at", new Date(Date.now() - 14 * DAY).toISOString()).not("provider_post_id", "is", null).limit(500),
  ]);
  const usage: Record<string, number> = {};
  for (const r of (near.data ?? []) as any[]) {
    if (r.status === "failed" && r.error !== UNCONFIRMED) continue;
    const st = (Array.isArray(r.options?.accounts) ? r.options.accounts : []) as StoredTarget[];
    for (const t of sendsOf(r)) {
      const s2 = st.find((x) => x.id && x.id === t.id);
      if (Math.floor(Date.parse(s2?.at ?? r.schedule_at ?? r.created_at) / DAY) !== today) continue;
      const k = t.id ?? t.platform; usage[k] = (usage[k] ?? 0) + 1;
    }
  }
  const healthy = new Map(accounts.filter((a) => a.id && !a.refresh_required).map((a) => [a.id!, a]));
  const relink = new Map<string, { account_id: string; platform: string; username: string | null; post_ids: string[] }>();
  for (const r of (bad.data ?? []) as any[]) for (const x of (r.results ?? []) as SocialResult[]) {
    if (x.status !== "failed" || !x.account_id || !healthy.has(x.account_id) || !/link(ed)? again|relink/i.test(String(x.error ?? ""))) continue;
    const a = healthy.get(x.account_id)!;
    const e = relink.get(x.account_id) ?? { account_id: x.account_id, platform: a.platform, username: a.username ?? null, post_ids: [] };
    if (!e.post_ids.includes(r.id)) e.post_ids.push(r.id);
    relink.set(x.account_id, e);
  }
  return { groups: groups.map((g) => publicGroup(g, accounts)), usage_today: usage, per_account_daily: dailyPerAccount(env), max_posts: MAX_ITEMS, max_ahead_days: MAX_AHEAD_DAYS, relink_failures: [...relink.values()] };
}

/** The sends a post row made: one per account (rows from before accounts were named: one per network). */
export function sendsOf(r: { platforms?: string[] | null; options?: any }): Array<{ id: string | null; platform: string }> {
  const accs = Array.isArray(r.options?.accounts) ? (r.options.accounts as any[]).filter((a) => a && a.platform) : [];
  return accs.length ? accs.map((a) => ({ id: a.id ? String(a.id) : null, platform: String(a.platform) })) : (r.platforms ?? []).map((platform) => ({ id: null, platform }));
}
/** A result's place in a row: its account, or its network for results that name none. */
const resultKey = (r: { platform: string; account_id?: string | null }) => (r.account_id ? `acct:${r.account_id}` : `net:${r.platform}`);

/** Post rows for the page, each with its video's poster (output posters sit next to the file; uploads keep theirs). */
export async function withPostPosters(sb: SupabaseClient, u: string, rows: SocialPostRow[]) {
  const assetIds = [...new Set(rows.map((x) => x.asset_id).filter(Boolean))] as string[];
  const ar = assetIds.length ? await sb.from("studio_assets").select("id,probe").eq("user_id", u).in("id", assetIds) : { data: [] as any[] };
  const assetPoster = new Map(((ar.data ?? []) as any[]).map((a) => [a.id, a.probe?.poster_key ?? null]));
  const posterOf = (x: SocialPostRow) => (x.output_key ? x.output_key.replace(/\.mp4$/i, ".jpg") : x.asset_id ? assetPoster.get(x.asset_id) ?? null : null);
  const keys = [...new Set(rows.map(posterOf).filter(Boolean))] as string[];
  const signed = keys.length ? await sb.storage.from("studio-outputs").createSignedUrls(keys, 900) : { data: [] as any[] };
  const urls = new Map(((signed.data ?? []) as any[]).filter((x) => !x.error).map((x) => [x.path, x.signedUrl]));
  return rows.map((x) => publicPost(x, posterOf(x) ? urls.get(posterOf(x)!) ?? null : null));
}

/** What the chat and the pages need to know about a person's posting: on or off, and what is linked. */
export async function socialSnapshot(sb: SupabaseClient, u: string, env: Record<string, string | undefined>): Promise<{ enabled: boolean; linked: string[]; quiet: boolean; allowance?: Allowance; groups?: Array<{ id: string; name: string; networks: string[] }> }> {
  if (!getSocialProvider({ env })) return { enabled: false, linked: [], quiet: false };
  const [pr, pf] = await Promise.all([
    sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle(),
    sb.from("studio_social_prefs").select("connect_dismissed_at,connect_dismissals").eq("user_id", u).maybeSingle(),
  ]);
  const linked = [...new Set(((pr.data?.accounts ?? []) as SocialAccount[]).map((a) => a.platform))];
  // "Not now" to linking quiets the unasked offer for two weeks; three of them, for good (asking still works).
  const d = pf.data as { connect_dismissed_at: string | null; connect_dismissals: number } | null;
  const quiet = !linked.length && !!d && (d.connect_dismissals >= 3 || (!!d.connect_dismissed_at && Date.now() - Date.parse(d.connect_dismissed_at) < 14 * 86400_000));
  const allowance = await allowanceOf(sb, u).catch(() => undefined);
  const groups = await groupsOf(sb, u).then((gs) => gs.map((g) => publicGroup(g, (pr.data?.accounts ?? []) as SocialAccount[])).map((g) => ({ id: g.id, name: g.name, networks: g.networks }))).catch(() => []);
  return { enabled: true, linked, quiet, allowance, groups };
}

/** Apply one status change to the matching post rows; returns how many rows moved. Canceled rows stay canceled. A
 *  delivery that names only some networks (TikTok reports on its own) is merged by network, and the overall status is
 *  worked out again from all of them. */
export async function applyEvent(sb: SupabaseClient, ev: SocialEvent): Promise<number> {
  const cur = await sb.from("studio_social_posts").select("id,status,results,platforms,options,schedule_at").eq("provider_post_id", ev.providerPostId).neq("status", "canceled");
  if (cur.error) throw cur.error;
  let moved = 0;
  for (const row of (cur.data ?? []) as any[]) {
    let results = ev.results, status = ev.status, error = ev.error;
    if (ev.partial && ev.status !== "canceled") {
      const by = new Map<string, SocialResult>(((row.results ?? []) as SocialResult[]).map((r) => [resultKey(r), r]));
      for (const r of ev.results) { if (r.account_id) by.delete(`net:${r.platform}`); by.set(resultKey(r), r); }
      for (const t of sendsOf(row)) {
        const k = resultKey({ platform: t.platform, account_id: t.id });
        if (!by.has(k) && !(t.id && by.has(`net:${t.platform}`)) && ![...by.values()].some((r) => !t.id && r.platform === t.platform)) by.set(k, { platform: t.platform, account_id: t.id, status: "pending", url: null, error: null });
      }
      results = [...by.values()];
      const future = !!row.schedule_at && Date.parse(row.schedule_at) > Date.now();
      status = statusOf(results, future);
      error = status === "failed" ? (results.find((x) => x.error)?.error ?? ev.error ?? "The post did not go out") : null;
    }
    const w = await sb.from("studio_social_posts").update({ status, results, error, updated_at: new Date().toISOString() }).eq("id", row.id).neq("status", "canceled").select("id");
    if (w.error) throw w.error;
    moved += (w.data ?? []).length;
  }
  return moved;
}

export function publicPost(x: SocialPostRow, posterUrl: string | null) {
  return { id: x.id, job_id: x.job_id, output_key: x.output_key, asset_id: x.asset_id ?? null, conversation_id: x.conversation_id ?? null, caption: x.caption, platforms: x.platforms, options: x.options, schedule_at: x.schedule_at, status: x.status, results: x.results ?? [], error: x.error, created_at: x.created_at, updated_at: x.updated_at, poster_url: posterUrl };
}

/** Reads back posts the webhook has not settled: scheduled ones past their time, sends that never got an answer. A
 *  send the service never answered (no post id) is closed as "could not confirm" after 30 minutes, never sent again. */
export async function socialTick(sb: SupabaseClient, deps: SocialDeps & { provider?: SocialProvider | null } = {}): Promise<number> {
  const p = deps.provider !== undefined ? deps.provider : getSocialProvider(deps);
  if (!p) return 0;
  const log = deps.log ?? ((s: string) => console.log(s));
  const waiting = await sb.from("studio_social_posts").select("batch_id,user_id").eq("status", "queued").eq("provider", p.name).lt("created_at", new Date(Date.now() - 2 * 60_000).toISOString()).limit(200);
  for (const [batch, user] of new Map(((waiting.data ?? []) as any[]).filter((w) => w.batch_id).map((w) => [w.batch_id, w.user_id]))) {
    if (draining.has(batch)) continue;
    log(`[social] resuming queued batch ${batch}`);
    void drainBatch(sb, p, user, batch, deps);
  }
  const lost = await sb.from("studio_social_posts").update({ status: "failed", error: UNCONFIRMED, updated_at: new Date().toISOString() })
    .eq("status", "sending").is("provider_post_id", null).lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString()).select("id");
  if (lost.error) log(`[social] closing unanswered sends failed: ${lost.error.message}`);
  else if ((lost.data ?? []).length) log(`[social] ${(lost.data ?? []).length} send(s) closed as unconfirmed`);
  const due = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await sb.from("studio_social_posts").select("id,user_id,provider_post_id,status,schedule_at,created_at,updated_at")
    .eq("provider", p.name).in("status", ["scheduled", "sending"]).not("provider_post_id", "is", null).or(`schedule_at.is.null,schedule_at.lt.${due}`).lt("updated_at", due).order("updated_at", { ascending: true }).limit(50);
  if (r.error) throw r.error;
  let moved = 0;
  const keys = new Map<string, string | null>();
  for (const row of (r.data ?? []) as any[]) {
    // a week past its time with no answer: stop asking and say so
    const since = Date.parse(row.schedule_at ?? row.created_at);
    if (Date.now() - since > 7 * 86400_000) { await sb.from("studio_social_posts").update({ status: "failed", error: UNCONFIRMED, updated_at: new Date().toISOString() }).eq("id", row.id).neq("status", "canceled"); continue; }
    if (!keys.has(row.user_id)) { const k = await sb.from("studio_social_profiles").select("profile_key").eq("user_id", row.user_id).maybeSingle(); keys.set(row.user_id, k.data?.profile_key ?? null); }
    const key = keys.get(row.user_id);
    if (!key) continue;
    try {
      const ev = await p.status(key, row.provider_post_id);
      if (ev && ev.status !== row.status) moved += await applyEvent(sb, ev);
      else await sb.from("studio_social_posts").update({ updated_at: new Date().toISOString() }).eq("id", row.id); // checked; look again later
    } catch (e: any) { log(`[social] status read failed for ${row.id}: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  return moved;
}

export function startSocialLoop(sbFn: () => SupabaseClient, deps: SocialDeps = {}): void {
  if (!getSocialProvider(deps)) return;
  const every = 5 * 60_000, HOUR = 3600_000;
  let busy = false, lastUpkeep = Date.now() - HOUR + 10 * 60_000; // first sweep ~10 minutes after start, then hourly
  setInterval(() => {
    if (busy) return;
    busy = true;
    const sb = sbFn();
    (async () => {
      await socialTick(sb, deps).catch((e) => console.error("[social] tick", String(e?.message ?? e)));
      if (Date.now() - lastUpkeep < HOUR) return;
      lastUpkeep = Date.now();
      // unused profiles go first, then today's bill is shared out over the ones left
      await socialUpkeep(sb, deps).catch((e) => console.error("[social] upkeep", String(e?.message ?? e)));
      await recordSocialCosts(sb, deps).catch((e) => console.error("[social] costs", String(e?.message ?? e)));
    })().finally(() => { busy = false; });
  }, every).unref?.();
}

/** When a plan ends: the person's provider profile is removed (it holds their linked tokens and takes a slot on the
 *  provider plan). Their post history stays; linking again later makes a fresh profile. */
export async function releaseSocialProfile(sb: SupabaseClient, u: string, deps: SocialDeps = {}): Promise<boolean> {
  const p = getSocialProvider(deps);
  if (!p) return false;
  const r = await sb.from("studio_social_profiles").select("user_id,provider,profile_key,accounts,created_at").eq("user_id", u).maybeSingle();
  if (r.error || !r.data) return false;
  const row = r.data as any;
  const owner = row.provider && row.provider !== p.name ? providerNamed(row.provider, deps) : p;
  // a refusal keeps the row; the hourly upkeep removes it later (no plan), so it never stays billed unnoticed
  return clearProfile(sb, owner, row, "plan_ended", deps.log ?? ((s: string) => console.log(s)), owner === p ? {} : { retired: true });
}
