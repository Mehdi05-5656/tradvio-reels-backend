// Clone8 Studio: self-serve social posting. A paying person links their own networks (the provider's hosted linking
// page, opened from "Connect your socials"), then posts or schedules Studio outputs to them. Every provider call goes
// through social-provider.ts; this file never names the provider. The managed service keeps Publer and is untouched.
//
// Status flow of a post row: sending → scheduled → posted | partial | failed, or canceled. The provider's webhook moves
// it; a loop reads back any post the webhook left behind, so a missed delivery never strands a row.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSocialProvider, isSocialPlatform, SocialError, type SocialAccount, type SocialDeps, type SocialEvent, type SocialProvider, type SocialResult } from "./social-provider.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Outputs are kept 30 days after the job finishes; a post must go out a day before that. */
const OUTPUT_DAYS = 30;
/** The provider needs a little lead time; anything sooner than this goes out now. */
const MIN_LEAD_MS = 5 * 60_000;
const MAX_ITEMS = 25;

export type SocialPostRow = {
  id: string; user_id: string; provider: string; provider_post_id: string | null; job_id: string | null; output_key: string;
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

export function registerSocial(app: Express, sbFn: () => SupabaseClient, deps: SocialDeps & { provider?: SocialProvider | null } = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const provider = () => (deps.provider !== undefined ? deps.provider : getSocialProvider({ ...deps, env }));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof SocialError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "social_unavailable", detail: "The social posting migration has not been applied" });
    console.error("[social]", msg);
    res.status(500).json({ error: "social_failed", detail: msg.slice(0, 200) });
  };
  const need = (): SocialProvider => { const p = provider(); if (!p) throw new SocialError("social_off", "Social posting is not switched on yet", 503); return p; };
  const profileOf = async (sb: SupabaseClient, u: string) => {
    const r = await sb.from("studio_social_profiles").select("*").eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    return r.data as { user_id: string; profile_key: string; accounts: SocialAccount[]; webhook_registered_at: string | null } | null;
  };
  const requirePlan = async (sb: SupabaseClient, u: string) => {
    const c = await sb.from("studio_customers").select("status").eq("user_id", u).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data || !["active", "trialing"].includes(c.data.status)) throw new SocialError("subscription_required", "Posting to your socials comes with a plan", 409);
  };
  const ensureWebhook = async (sb: SupabaseClient, p: SocialProvider, u: string, profileKey: string, registeredAt: string | null) => {
    const url = webhookUrl(env);
    if (!url || registeredAt) return;
    try { await p.registerWebhook(profileKey, url); await sb.from("studio_social_profiles").update({ webhook_registered_at: new Date().toISOString() }).eq("user_id", u); }
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
      res.json({ enabled: true, connected: accounts.length > 0, accounts, stale, platforms: p.offered() });
    } catch (e) { fail(res, e); }
  });

  // "Connect your socials": a profile on first use, then a fresh linking link every time.
  app.post("/api/studio/social/connect", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn();
      await requirePlan(sb, u);
      let prof = await profileOf(sb, u);
      if (!prof) {
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
      await ensureWebhook(sb, p, u, prof!.profile_key, prof!.webhook_registered_at);
      const redirect = typeof req.body?.return_to === "string" && /^https:\/\//.test(req.body.return_to) ? req.body.return_to : env.STUDIO_SOCIAL_RETURN_URL;
      let origin: string | undefined;
      try { origin = redirect ? new URL(redirect).origin : undefined; } catch { origin = undefined; }
      const link = await p.connectUrl(prof!.profile_key, { redirect, origin });
      res.json({ url: link.url, expires_in_minutes: link.expiresInMinutes });
    } catch (e) { fail(res, e); }
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
      const rows = (r.data ?? []) as SocialPostRow[];
      const posters = rows.map((x) => x.output_key.replace(/\.mp4$/i, ".jpg"));
      const signed = posters.length ? await sb.storage.from("studio-outputs").createSignedUrls([...new Set(posters)], 900) : { data: [] as any[] };
      const urls = new Map(((signed.data ?? []) as any[]).filter((x) => !x.error).map((x) => [x.path, x.signedUrl]));
      res.json({ posts: rows.map((x) => publicPost(x, urls.get(x.output_key.replace(/\.mp4$/i, ".jpg")) ?? null)) });
    } catch (e) { fail(res, e); }
  });

  // Post or schedule one or more outputs. Several videos can be spread out: the first at `schedule_at` (or now),
  // each next one `spacing_minutes` later.
  app.post("/api/studio/social/posts", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const p = need(), sb = sbFn();
      await requirePlan(sb, u);
      const prof = await profileOf(sb, u);
      if (!prof) throw new SocialError("not_connected", "Connect your socials first", 409);
      const b = req.body ?? {};
      const items: Array<{ job_id: string; output_key: string }> = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS + 1) : [];
      if (!items.length) throw new SocialError("no_videos", "Pick at least one video");
      if (items.length > MAX_ITEMS) throw new SocialError("too_many_videos", `Up to ${MAX_ITEMS} videos at a time`);
      const offered = new Set(p.offered());
      const platforms = [...new Set((Array.isArray(b.platforms) ? b.platforms : []).map(String))].filter((x) => isSocialPlatform(x) && offered.has(x)) as any[];
      if (!platforms.length) throw new SocialError("no_platforms", "Pick at least one network");
      const linked = new Set((prof.accounts ?? []).map((a) => a.platform));
      const missing = platforms.filter((x) => !linked.has(x));
      if (missing.length) throw new SocialError("platform_not_linked", `Link ${missing.join(", ")} first`, 409);
      const caption = String(b.caption ?? "").slice(0, 5000);
      const options = cleanOptions(platforms, b.options, caption);
      const spacing = Math.min(Math.max(Number(b.spacing_minutes ?? 0) || 0, 0), 7 * 24 * 60);
      const first = b.schedule_at ? new Date(String(b.schedule_at)) : null;
      if (first && Number.isNaN(first.getTime())) throw new SocialError("bad_schedule", "That date is not readable");

      // The outputs must be the person's own, finished, and still kept on the scheduled day.
      const jobIds = [...new Set(items.map((i) => String(i.job_id)).filter((x) => UUID_RE.test(x)))];
      const jr = jobIds.length ? await sb.from("studio_jobs").select("id,status,outputs,finished_at").eq("user_id", u).in("id", jobIds) : { data: [], error: null };
      if (jr.error) throw jr.error;
      const jobs = new Map(((jr.data ?? []) as any[]).map((j) => [j.id, j]));
      const now = Date.now();
      const plan = items.map((it, i) => {
        const j = jobs.get(String(it.job_id));
        const out = j?.status === "done" ? (j.outputs ?? []).find((o: any) => o.key === it.output_key) : null;
        if (!out) throw new SocialError("video_not_found", "One of those videos is gone");
        if (out.kind && out.kind !== "video") throw new SocialError("not_a_video", "Only videos can be posted for now");
        const at = first ? new Date(first.getTime() + i * spacing * 60_000) : spacing ? new Date(now + MIN_LEAD_MS + i * spacing * 60_000) : null;
        const keptUntil = Date.parse(j.finished_at ?? new Date().toISOString()) + (OUTPUT_DAYS - 1) * 86400_000;
        if (at && at.getTime() > keptUntil) throw new SocialError("too_late", "A video is kept 30 days; schedule it before then");
        return { job: j, out, at: at && at.getTime() - now < MIN_LEAD_MS ? null : at };
      });

      const made: any[] = [];
      for (const x of plan) {
        const ins = await sb.from("studio_social_posts").insert({ user_id: u, provider: p.name, job_id: x.job.id, output_key: x.out.key, caption, platforms, options, schedule_at: x.at?.toISOString() ?? null, status: "sending" }).select("*").single();
        if (ins.error) throw ins.error;
        const row = ins.data as SocialPostRow;
        try {
          // The provider fetches the file when it posts, so the link has to outlive the scheduled time.
          // The provider checks the link with a HEAD request and fetches it at publish time; it asks for 7 days at least.
          const ttl = Math.ceil(Math.max(7 * 86400_000, (x.at ? x.at.getTime() - now : 0) + 2 * 86400_000) / 1000);
          const s = await sb.storage.from("studio-outputs").createSignedUrl(x.out.key, ttl);
          if (s.error || !s.data?.signedUrl) throw new SocialError("video_unavailable", "That video could not be read", 502);
          const r = await p.publish(prof.profile_key, { text: caption, platforms, mediaUrl: s.data.signedUrl, scheduleAt: x.at, options, idempotencyKey: row.id });
          const upd = await sb.from("studio_social_posts").update({ provider_post_id: r.providerPostId, status: r.status, results: r.results, error: r.error, updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
          made.push(publicPost((upd.data ?? row) as SocialPostRow, null));
        } catch (e: any) {
          const msg = e instanceof SocialError ? e.message : String(e?.message ?? e).slice(0, 300);
          await sb.from("studio_social_posts").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", row.id);
          made.push(publicPost({ ...row, status: "failed", error: msg }, null));
        }
      }
      log(`[social] ${u} sent ${made.length} post(s) to ${platforms.join(",")}: ${made.map((m) => m.status).join(",")}`);
      res.status(201).json({ posts: made });
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
    if (String(req.query.token ?? "") !== token) return res.status(401).json({ error: "unauthorized" });
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

/** Apply one status change to the matching post row; returns how many rows moved. Canceled rows stay canceled. */
export async function applyEvent(sb: SupabaseClient, ev: SocialEvent): Promise<number> {
  const r = await sb.from("studio_social_posts").update({ status: ev.status, results: ev.results, error: ev.error, updated_at: new Date().toISOString() })
    .eq("provider_post_id", ev.providerPostId).neq("status", "canceled").select("id");
  if (r.error) throw r.error;
  return (r.data ?? []).length;
}

export function publicPost(x: SocialPostRow, posterUrl: string | null) {
  return { id: x.id, job_id: x.job_id, output_key: x.output_key, caption: x.caption, platforms: x.platforms, options: x.options, schedule_at: x.schedule_at, status: x.status, results: x.results ?? [], error: x.error, created_at: x.created_at, updated_at: x.updated_at, poster_url: posterUrl };
}

/** Reads back posts the webhook has not settled: scheduled ones past their time, sends that never got an answer. */
export async function socialTick(sb: SupabaseClient, deps: SocialDeps & { provider?: SocialProvider | null } = {}): Promise<number> {
  const p = deps.provider !== undefined ? deps.provider : getSocialProvider(deps);
  if (!p) return 0;
  const log = deps.log ?? ((s: string) => console.log(s));
  const due = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await sb.from("studio_social_posts").select("id,user_id,provider_post_id,status,schedule_at,updated_at")
    .in("status", ["scheduled", "sending"]).not("provider_post_id", "is", null).or(`schedule_at.is.null,schedule_at.lt.${due}`).lt("updated_at", due).limit(50);
  if (r.error) throw r.error;
  let moved = 0;
  const keys = new Map<string, string | null>();
  for (const row of (r.data ?? []) as any[]) {
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
  setInterval(() => { socialTick(sbFn(), deps).catch((e) => console.error("[social] tick", String(e?.message ?? e))); }, every).unref?.();
}
