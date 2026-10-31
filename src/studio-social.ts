// Clone8 Studio: self-serve social posting. A paying person links their own networks (the provider's hosted linking
// page, opened from "Connect your socials"), then posts or schedules Studio outputs to them. Every provider call goes
// through social-provider.ts; this file never names the provider. The managed service keeps Publer and is untouched.
//
// Status flow of a post row: sending → scheduled → posted | partial | failed, or canceled. The provider's webhook moves
// it; a loop reads back any post the webhook left behind, so a missed delivery never strands a row.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftCaption, type CaptionDraft } from "./studio-captions.js";
import { getSocialProvider, isSocialPlatform, SocialError, statusOf, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult } from "./social-provider.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Outputs are kept 30 days after the job finishes; a post must go out a day before that. */
const OUTPUT_DAYS = 30;
/** The provider needs a little lead time; anything sooner than this goes out now. */
const MIN_LEAD_MS = 5 * 60_000;
const MAX_ITEMS = 25;
/** Nothing is scheduled further out than this (the provider and the kept files both allow it). */
const MAX_AHEAD_DAYS = 30;
/** Posts a person may send in 24 hours (the provider's monthly allowance is shared by everyone). */
const dailyCap = (env: Record<string, string | undefined>) => Math.max(1, Number(env.STUDIO_SOCIAL_DAILY_POSTS) || 40);
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

/** Network options the person may set, cleaned: today a YouTube title (required there) and its visibility. */
export function cleanOptions(platforms: string[], raw: any, caption: string): Record<string, any> {
  const out: Record<string, any> = {};
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
  const profileOf = async (sb: SupabaseClient, u: string) => {
    const r = await sb.from("studio_social_profiles").select("*").eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    return r.data as { user_id: string; profile_key: string; accounts: SocialAccount[]; webhook_registered_at: string | null; webhook_hash?: string | null } | null;
  };
  const requirePlan = async (sb: SupabaseClient, u: string) => {
    const c = await sb.from("studio_customers").select("status").eq("user_id", u).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data || !["active", "trialing"].includes(c.data.status)) throw new SocialError("subscription_required", "Posting to your socials comes with a plan", 409);
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
      const prof = await profileOf(sb, u);
      if (!prof) return res.json({ enabled: true, connected: false, accounts: [], platforms: p.offered() });
      let accounts = prof.accounts ?? [], stale = false;
      try {
        accounts = await p.accounts(prof.profile_key);
        await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", u);
      } catch (e: any) { stale = true; log(`[social] accounts read failed for ${u}: ${String(e?.message ?? e).slice(0, 160)}`); }
      if (!stale) void ensureWebhook(sb, p, u, prof.profile_key, prof.webhook_hash); // re-registers after a URL or secret change
      res.json({ enabled: true, connected: accounts.length > 0, accounts, stale, platforms: p.offered() });
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
      let prof = await profileOf(sb, u);
      if (!prof) {
        // The provider plan holds a fixed number of profiles; stop cleanly (and say so in the log) before it is full.
        const cap = Number(env.STUDIO_SOCIAL_PROFILE_CAP) || 0;
        if (cap) {
          const n = await sb.from("studio_social_profiles").select("user_id", { count: "exact", head: true });
          const used = n.count ?? 0;
          if (used >= cap) { log(`[social] ALERT profile cap reached (${used}/${cap}); linking refused for ${u}`); throw new SocialError("linking_full", "Linking is paused for a moment while we add room. Try again soon.", 503); }
          if (used + 1 >= Math.ceil(cap * 0.8)) log(`[social] ALERT profiles at ${used + 1}/${cap}; raise the posting plan soon`);
        }
        // The title shows on the linking page and must be unique in the provider account.
        const email = req.auth && "email" in req.auth ? String((req.auth as any).email ?? "") : "";
        let title = `Clone8 · ${email || u.slice(0, 8)}`;
        let made;
        try { made = await p.createProfile(title); }
        catch (e) {
          if (!(e instanceof SocialError && e.code === "profile_title_taken")) throw e;
          title = `Clone8 · ${email || u.slice(0, 8)} · ${Date.now().toString(36)}`; // an orphan from an earlier failed save
          log(`[social] profile title taken for ${u}; using ${title}`);
          made = await p.createProfile(title);
        }
        const ins = await sb.from("studio_social_profiles").insert({ user_id: u, provider: p.name, profile_key: made.profileKey, ref_id: made.refId, title }).select("*").single();
        if (ins.error) {
          // Two tabs raced: keep the stored profile, drop the one just made so it does not count against the plan.
          await p.deleteProfile(made.profileKey).catch(() => undefined);
          prof = await profileOf(sb, u);
          if (!prof) throw ins.error;
        } else prof = ins.data as any;
        log(`[social] profile created for ${u}`);
      }
      await ensureWebhook(sb, p, u, prof!.profile_key, prof!.webhook_hash);
      const redirect = safeReturn(req.body?.return_to, env) ?? env.STUDIO_SOCIAL_RETURN_URL;
      let origin: string | undefined;
      try { origin = redirect ? new URL(redirect).origin : undefined; } catch { origin = undefined; }
      const link = await p.connectUrl(prof!.profile_key, { redirect, origin });
      res.json({ url: link.url, expires_in_minutes: link.expiresInMinutes });
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
      await p.disconnect(prof.profile_key, platform);
      const accounts = await p.accounts(prof.profile_key).catch(() => (prof.accounts ?? []).filter((a) => a.platform !== platform));
      await sb.from("studio_social_profiles").update({ accounts, updated_at: new Date().toISOString() }).eq("user_id", u);
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
      const posts = await createPosts(sbFn(), need(), u, req.body ?? {}, { log, env });
      res.status(201).json({ posts });
    } catch (e) { fail(res, e); }
  });

  // "Write it for me": a caption drafted from the video's frames and speech. Needs a plan, not linked networks.
  app.post("/api/studio/social/caption", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      await requirePlan(sb, u);
      const b = req.body ?? {};
      const item = await resolveItem(sb, u, b);
      const platforms = (Array.isArray(b.platforms) ? b.platforms : []).map(String).filter(isSocialPlatform);
      const draft = await (deps.caption ?? draftCaption)(sb, u, { ...item, platforms, note: b.note ? String(b.note) : null }, { env, fetch: deps.fetch, log });
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
      if (row.status !== "scheduled") throw new SocialError("not_cancelable", "Only a scheduled post can be canceled", 409);
      // past its time it may already be live; canceling then would delete a published post
      if (!row.schedule_at || Date.parse(row.schedule_at) - Date.now() < 60_000) throw new SocialError("not_cancelable", "It is going out now and can no longer be canceled", 409);
      const prof = await profileOf(sb, u);
      if (row.provider_post_id && prof) await p.cancel(prof.profile_key, row.provider_post_id);
      const upd = await sb.from("studio_social_posts").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
      res.json({ post: publicPost((upd.data ?? row) as SocialPostRow, null) });
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
    return { job_id: j.id, output_key: out.key, asset_id: null, bucket: "studio-outputs" as const, key: out.key, keptUntil: Date.parse(j.finished_at ?? new Date().toISOString()) + (OUTPUT_DAYS - 1) * 86400_000 };
  });
}

/** Post or schedule videos for a person; every path that posts (the Publish page, the chat's card) comes through here. */
export async function createPosts(sb: SupabaseClient, p: SocialProvider, u: string, b: any, opts: { conversationId?: string | null; log?: (s: string) => void; env?: Record<string, string | undefined> } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s)), env = opts.env ?? process.env;
  const c = await sb.from("studio_customers").select("status").eq("user_id", u).maybeSingle();
  if (c.error) throw c.error;
  if (!c.data || !["active", "trialing"].includes(c.data.status)) throw new SocialError("subscription_required", "Posting to your socials comes with a plan", 409);
  const pr = await sb.from("studio_social_profiles").select("profile_key,accounts").eq("user_id", u).maybeSingle();
  if (pr.error) throw pr.error;
  const prof = pr.data as { profile_key: string; accounts: SocialAccount[] } | null;
  if (!prof) throw new SocialError("not_connected", "Connect your socials first", 409);
  const items: any[] = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS + 1) : [];
  if (!items.length) throw new SocialError("no_videos", "Pick at least one video");
  if (items.length > MAX_ITEMS) throw new SocialError("too_many_videos", `Up to ${MAX_ITEMS} videos at a time`);
  const offered = new Set(p.offered());
  const asked = [...new Set((Array.isArray(b.platforms) ? b.platforms : []).map(String))] as string[];
  const platforms = asked.filter((x) => isSocialPlatform(x) && offered.has(x)) as any[];
  if (asked.length && platforms.length < asked.length) throw new SocialError("platform_unavailable", `${asked.filter((x) => !platforms.includes(x)).join(", ")} is not available right now`);
  if (!platforms.length) throw new SocialError("no_platforms", "Pick at least one network");
  const linked = new Set((prof.accounts ?? []).map((a) => a.platform));
  const missing = platforms.filter((x: string) => !linked.has(x));
  if (missing.length) throw new SocialError("platform_not_linked", `Link ${missing.join(", ")} first`, 409);
  const caption = String(b.caption ?? "").slice(0, 5000);
  const options = cleanOptions(platforms, b.options, caption);
  const spacing = Math.min(Math.max(Number(b.spacing_minutes ?? 0) || 0, 0), 7 * 24 * 60);
  const now = Date.now();
  const first = b.schedule_at ? new Date(String(b.schedule_at)) : null;
  if (first && Number.isNaN(first.getTime())) throw new SocialError("bad_schedule", "That date is not readable");
  // An asked-for time is kept or refused, never quietly turned into "now" (a card left open past its time).
  if (first && first.getTime() - now < MIN_LEAD_MS - 30_000) throw new SocialError("too_soon", "Pick a time at least 5 minutes from now");
  // 24-hour allowance per person, counted by network sends.
  const since = new Date(now - 86400_000).toISOString();
  const recent = await sb.from("studio_social_posts").select("job_id,output_key,asset_id,platforms,status,results,error").eq("user_id", u).gte("created_at", since).limit(1000);
  if (recent.error) throw recent.error;
  const rows24 = (recent.data ?? []) as Array<Pick<SocialPostRow, "job_id" | "output_key" | "asset_id" | "platforms" | "status" | "results" | "error">>;
  const used = rows24.reduce((n, r) => n + (r.status === "failed" && r.error !== UNCONFIRMED ? 0 : (r.platforms ?? []).length), 0);
  const cap = dailyCap(env);
  if (used + items.length * platforms.length > cap) throw new SocialError("daily_limit", `That is over today's limit of ${cap} posts (${Math.max(0, cap - used)} left). It resets over the next 24 hours.`, 429);
  const resolved = await resolveItems(sb, u, items);
  // The same video to the same network twice in a day is refused: platforms treat it as a duplicate, and a send whose
  // outcome is unknown may already be live.
  const keyOf = (x: { job_id: string | null; output_key: string | null; asset_id?: string | null }) => (x.asset_id ? `a:${x.asset_id}` : `o:${x.job_id}:${x.output_key}`);
  const taken = new Map<string, Set<string>>();
  for (const r of rows24) {
    const nets = new Set<string>();
    for (const n of r.platforms ?? []) {
      const res = (r.results ?? []).find((x) => x.platform === n);
      const live = ["sending", "scheduled", "posted"].includes(r.status) || r.error === UNCONFIRMED || (res ? ["posted", "pending", "scheduled"].includes(res.status) : r.status === "partial");
      if (live && r.status !== "canceled") nets.add(n);
    }
    const k = keyOf(r); taken.set(k, new Set([...(taken.get(k) ?? []), ...nets]));
  }
  for (const x of resolved) {
    const again = platforms.filter((n: string) => taken.get(keyOf(x))?.has(n));
    if (again.length) throw new SocialError("already_posted", `That video already went to ${again.join(", ")} today (or is on its way). Pick a different video or network.`, 409);
  }
  const seen = new Set<string>();
  for (const x of resolved) { if (seen.has(keyOf(x))) throw new SocialError("same_video_twice", "The same video is picked twice"); seen.add(keyOf(x)); }
  const latest = now + MAX_AHEAD_DAYS * 86400_000;
  const plan = resolved.map((x, i) => {
    const at = first ? new Date(first.getTime() + i * spacing * 60_000) : spacing ? new Date(now + MIN_LEAD_MS + i * spacing * 60_000) : null;
    if (at && (at.getTime() > x.keptUntil || at.getTime() > latest)) throw new SocialError("too_late", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead, and a Studio video is kept 30 days`);
    return { x, at };
  });
  const made: SocialPostRow[] = [];
  for (const { x, at } of plan) {
    const ins = await sb.from("studio_social_posts").insert({ user_id: u, provider: p.name, job_id: x.job_id, output_key: x.output_key, asset_id: x.asset_id, conversation_id: opts.conversationId ?? null, caption, platforms, options, schedule_at: at?.toISOString() ?? null, status: "sending" }).select("*").single();
    if (ins.error) {
      // the ones already sent stay sent; stop here and report what went (never fail the whole call after a send)
      log(`[social] ${u} insert failed after ${made.length} post(s): ${String(ins.error.message ?? ins.error).slice(0, 160)}`);
      if (!made.length) throw ins.error;
      break;
    }
    const row = ins.data as SocialPostRow;
    try {
      // The provider checks the link with a HEAD request and fetches it at publish time; it asks for 7 days at least.
      const ttl = Math.ceil(Math.min(Math.max(7 * 86400_000, (at ? at.getTime() - now : 0) + 2 * 86400_000), (MAX_AHEAD_DAYS + 2) * 86400_000) / 1000);
      const s = await sb.storage.from(x.bucket).createSignedUrl(x.key, ttl);
      if (s.error || !s.data?.signedUrl) throw new SocialError("video_unavailable", "That video could not be read", 502);
      const r = await p.publish(prof.profile_key, { text: caption, platforms, mediaUrl: s.data.signedUrl, scheduleAt: at, options, idempotencyKey: row.id });
      const patch = { provider_post_id: r.providerPostId, status: r.status, results: r.results, error: r.error, updated_at: new Date().toISOString() };
      let upd = await sb.from("studio_social_posts").update(patch).eq("id", row.id).select("*").single();
      if (upd.error) upd = await sb.from("studio_social_posts").update(patch).eq("id", row.id).select("*").single();
      if (upd.error) log(`[social] ALERT post ${row.id} went out as ${r.providerPostId} but could not be saved: ${String(upd.error.message ?? upd.error).slice(0, 160)}`);
      made.push((upd.data ?? { ...row, ...patch }) as SocialPostRow);
    } catch (e: any) {
      if (e?.unknown) {
        // It may have gone out: keep it open and marked, so nothing (person or loop) sends it again as new.
        await sb.from("studio_social_posts").update({ error: UNCONFIRMED, updated_at: new Date().toISOString() }).eq("id", row.id);
        log(`[social] ${u} post ${row.id} outcome unknown: ${String(e?.message ?? e).slice(0, 160)}`);
        made.push({ ...row, error: UNCONFIRMED });
        continue;
      }
      const msg = e instanceof SocialError ? e.message : "The post could not be sent";
      if (!(e instanceof SocialError)) log(`[social] ${u} post ${row.id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      await sb.from("studio_social_posts").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", row.id);
      made.push({ ...row, status: "failed", error: msg });
    }
  }
  log(`[social] ${u} sent ${made.length} post(s) to ${platforms.join(",")}: ${made.map((m) => m.status).join(",")}`);
  return withPostPosters(sb, u, made);
}

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
export async function socialSnapshot(sb: SupabaseClient, u: string, env: Record<string, string | undefined>): Promise<{ enabled: boolean; linked: string[]; quiet: boolean }> {
  if (!getSocialProvider({ env })) return { enabled: false, linked: [], quiet: false };
  const [pr, pf] = await Promise.all([
    sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle(),
    sb.from("studio_social_prefs").select("connect_dismissed_at,connect_dismissals").eq("user_id", u).maybeSingle(),
  ]);
  const linked = ((pr.data?.accounts ?? []) as SocialAccount[]).map((a) => a.platform);
  // "Not now" to linking quiets the unasked offer for two weeks; three of them, for good (asking still works).
  const d = pf.data as { connect_dismissed_at: string | null; connect_dismissals: number } | null;
  const quiet = !linked.length && !!d && (d.connect_dismissals >= 3 || (!!d.connect_dismissed_at && Date.now() - Date.parse(d.connect_dismissed_at) < 14 * 86400_000));
  return { enabled: true, linked, quiet };
}

/** Apply one status change to the matching post rows; returns how many rows moved. Canceled rows stay canceled. A
 *  delivery that names only some networks (TikTok reports on its own) is merged by network, and the overall status is
 *  worked out again from all of them. */
export async function applyEvent(sb: SupabaseClient, ev: SocialEvent): Promise<number> {
  const cur = await sb.from("studio_social_posts").select("id,status,results,platforms,schedule_at").eq("provider_post_id", ev.providerPostId).neq("status", "canceled");
  if (cur.error) throw cur.error;
  let moved = 0;
  for (const row of (cur.data ?? []) as any[]) {
    let results = ev.results, status = ev.status, error = ev.error;
    if (ev.partial && ev.status !== "canceled") {
      const by = new Map<string, SocialResult>(((row.results ?? []) as SocialResult[]).map((r) => [r.platform, r]));
      for (const r of ev.results) by.set(r.platform, r);
      for (const n of (row.platforms ?? []) as string[]) if (!by.has(n)) by.set(n, { platform: n, status: "pending", url: null, error: null });
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
  const lost = await sb.from("studio_social_posts").update({ status: "failed", error: UNCONFIRMED, updated_at: new Date().toISOString() })
    .eq("status", "sending").is("provider_post_id", null).lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString()).select("id");
  if (lost.error) log(`[social] closing unanswered sends failed: ${lost.error.message}`);
  else if ((lost.data ?? []).length) log(`[social] ${(lost.data ?? []).length} send(s) closed as unconfirmed`);
  const due = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await sb.from("studio_social_posts").select("id,user_id,provider_post_id,status,schedule_at,created_at,updated_at")
    .in("status", ["scheduled", "sending"]).not("provider_post_id", "is", null).or(`schedule_at.is.null,schedule_at.lt.${due}`).lt("updated_at", due).order("updated_at", { ascending: true }).limit(50);
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
  const every = 5 * 60_000;
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    socialTick(sbFn(), deps).catch((e) => console.error("[social] tick", String(e?.message ?? e))).finally(() => { busy = false; });
  }, every).unref?.();
}

/** When a plan ends: the person's provider profile is removed (it holds their linked tokens and takes a slot on the
 *  provider plan). Their post history stays; linking again later makes a fresh profile. */
export async function releaseSocialProfile(sb: SupabaseClient, u: string, deps: SocialDeps = {}): Promise<boolean> {
  const p = getSocialProvider(deps);
  if (!p) return false;
  const r = await sb.from("studio_social_profiles").select("profile_key").eq("user_id", u).maybeSingle();
  if (r.error || !r.data) return false;
  await p.deleteProfile(r.data.profile_key);
  const d = await sb.from("studio_social_profiles").delete().eq("user_id", u);
  if (d.error) throw d.error;
  return true;
}
