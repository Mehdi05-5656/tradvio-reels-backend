// Routes and the daily loop for the performance dashboard (studio-performance.ts collects and analyzes, studio-insights.ts
// writes the overview). Reads are cheap; refreshes cost a few public-data lookups, so they are paced: on open when the
// data is older than 6 hours, by hand at most every 15 minutes, and once a day in the background for people who opened
// the dashboard in the last week.
import { OVERHEAD } from "./studio-pricing.js";
import { recordEvent } from "./studio-events.js";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshPerformance, REFRESH_EVERY_MS, type PerfDeps } from "./studio-performance.js";
import { profileSuggestions } from "./studio-onboarding.js";
import { insightHash, latestInsight, loadPerformance, performanceForChat, suggestionsFrom, writeInsight } from "./studio-insights.js";
import { importLink, promoteOutput } from "./studio-assistant.js";
import { withPosterUrls } from "./studio.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES = [7, 28, 90];
const MANUAL_GAP_MS = 15 * 60_000, INSIGHTS_PER_DAY = 6;
const running = new Map<string, Promise<any>>();
const manual = new Map<string, number>();
/** Overview attempts per person in the last day, failed ones included (each is a paid model call), and one at a time. */
const attempts = new Map<string, number[]>();
const writing = new Set<string>();
const ATTEMPTS_PER_DAY = 10;
/** How long the first open waits for the first read before answering "still reading". */
const FIRST_WAIT_MS = 8_000;

/** One refresh at a time per person; a second caller waits for the same one. */
function refreshOnce(sb: SupabaseClient, u: string, deps: PerfDeps) {
  const cur = running.get(u);
  if (cur) return cur;
  const p = refreshPerformance(sb, u, deps).finally(() => running.delete(u));
  running.set(u, p);
  return p;
}

export function registerPerformance(app: Express, sbFn: () => SupabaseClient, deps: PerfDeps & { insight?: typeof writeInsight; transcripts?: (urls: string[]) => Promise<Map<string, string>> } = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "performance_unavailable", detail: "The performance migration has not been applied" });
    if (e?.status && e?.code && typeof e.status === "number") return res.status(e.status).json({ error: e.code, detail: msg });
    console.error("[performance]", msg);
    res.status(500).json({ error: "performance_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  // Refreshing and the overview spend public-data credits and model calls: they come with a plan. Reading what is
  // already stored stays open, so a lapsed person still sees their numbers.
  const hasPlan = async (sb: SupabaseClient, u: string) => {
    const c = await sb.from("studio_customers").select("status").eq("user_id", u).maybeSingle();
    return !!c.data && ["active", "trialing"].includes(c.data.status);
  };
  const needPlan = async (sb: SupabaseClient, u: string) => { if (!(await hasPlan(sb, u))) throw Object.assign(new Error("Fresh numbers and overviews come with a plan"), { status: 409, code: "subscription_required" }); };
  const params = (req: Request) => {
    const range = RANGES.includes(Number(req.query.range ?? req.body?.range)) ? Number(req.query.range ?? req.body?.range) : 28;
    const p = String(req.query.platform ?? req.body?.platform ?? "");
    const platform = ["tiktok", "instagram", "youtube"].includes(p) ? p : null;
    const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz ?? req.body?.tz ?? 0)) || 0));
    return { range, platform, tz };
  };
  const payload = async (sb: SupabaseClient, u: string, range: number, platform: string | null, tz: number, refreshing: boolean) => {
    const L = await loadPerformance(sb, u, range, platform, tz);
    const ins = await latestInsight(sb, u, platform ?? "all", range);
    const hash = insightHash(L.analysis, platform);
    const posts = L.analysis.posts.map((p) => ({ ...p, thumb_url: L.thumbs.get(p.id) ?? null }));
    return {
      enabled: true, refreshing,
      accounts: L.accounts.map((a) => ({ platform: a.platform, handle: a.handle, followers: a.followers, refreshed_at: a.refreshed_at, error: a.error })),
      analysis: { ...L.analysis, posts },
      insight: ins ? { ...ins.body, created_at: ins.created_at, stale: ins.input_hash !== hash } : null,
      suggestions: suggestionsFrom(L.analysis, ins?.body ?? null),
    };
  };

  app.get("/api/studio/performance", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), { range, platform, tz } = params(req);
      const prof = await sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle();
      const linked = ((prof.data?.accounts ?? []) as any[]).filter((a) => ["tiktok", "instagram", "youtube"].includes(a.platform));
      if (!prof.data || !linked.length) return res.json({ enabled: true, connected: false, accounts: [], analysis: null, insight: null, suggestions: [] });
      await sb.from("studio_social_profiles").update({ perf_viewed_at: new Date().toISOString(), timezone: String(tz) }).eq("user_id", u);
      const acc = await sb.from("studio_perf_accounts").select("refreshed_at").eq("user_id", u);
      const oldest = Math.min(...((acc.data ?? []) as any[]).map((a) => Date.parse(a.refreshed_at)), Number.POSITIVE_INFINITY);
      const never = !(acc.data ?? []).length;
      const plan = (never || Date.now() - oldest > REFRESH_EVERY_MS) && (await hasPlan(sb, u));
      if (plan) {
        const job = refreshOnce(sb, u, { ...deps, env });
        job.catch((e) => log(`[performance] refresh ${u}: ${String(e?.message ?? e)}`));
        // first open: wait a little so a quick read fills the page; a slow one carries on and the page polls
        if (never) await Promise.race([job.catch(() => undefined), new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
      }
      res.json({ connected: true, ...(await payload(sb, u, range, platform, tz, running.has(u))) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/performance/refresh", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), { range, platform, tz } = params(req);
      await needPlan(sb, u);
      const last = manual.get(u) ?? 0;
      if (Date.now() - last < MANUAL_GAP_MS) return res.status(429).json({ error: "refresh_too_soon", detail: "Fresh numbers arrive every few minutes at most", retry_in_s: Math.ceil((MANUAL_GAP_MS - (Date.now() - last)) / 1000) });
      manual.set(u, Date.now());
      const r = await refreshOnce(sb, u, { ...deps, env });
      res.json({ connected: true, sync: r, ...(await payload(sb, u, range, platform, tz, false)) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/performance/insights", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), { range, platform, tz } = params(req);
      await needPlan(sb, u);
      if (writing.has(u)) return res.status(409).json({ error: "insights_busy", detail: "An overview is already being written" });
      const recent = (attempts.get(u) ?? []).filter((t) => Date.now() - t < 86400_000);
      if (recent.length >= ATTEMPTS_PER_DAY) return res.status(429).json({ error: "insights_limit", detail: "A few overviews a day; the numbers do not move faster than that" });
      const day = await sb.from("studio_perf_insights").select("id").eq("user_id", u).gte("created_at", new Date(Date.now() - 86400_000).toISOString());
      if ((day.data ?? []).length >= INSIGHTS_PER_DAY) return res.status(429).json({ error: "insights_limit", detail: "A few overviews a day; the numbers do not move faster than that" });
      const L = await loadPerformance(sb, u, range, platform, tz);
      if (L.analysis.posts.filter((p) => p.published_at && Date.parse(p.published_at) > Date.now() - range * 86400_000).length < 3) return res.status(409).json({ error: "not_enough_posts", detail: "An overview needs at least 3 posts in this window" });
      const tops = L.analysis.top.slice(0, 2).map((id) => L.analysis.posts.find((p) => p.id === id)!).filter((p) => p?.platform === "tiktok");
      const transcripts = await (deps.transcripts ?? scTranscripts(env, deps.fetch))(tops.map((p) => p.url)).catch(() => new Map<string, string>());
      const byUrl = new Map(tops.map((p) => [p.url, p.id]));
      const t2 = new Map([...transcripts.entries()].filter(([url]) => byUrl.has(url)).map(([url, t]) => [byUrl.get(url)!, t]));
      attempts.set(u, [...recent, Date.now()]);
      writing.add(u);
      let body;
      try { body = await (deps.insight ?? writeInsight)(sb, u, L.analysis, { platform, thumbs: L.thumbs, transcripts: t2 }, { ...deps, env }); }
      finally { writing.delete(u); }
      const ins = await sb.from("studio_perf_insights").insert({ user_id: u, scope: platform ?? "all", range_days: range, input_hash: insightHash(L.analysis, platform), body, model: env.STUDIO_INSIGHT_MODEL || "claude-opus-5-5" }).select("created_at").single();
      if (ins.error) throw ins.error;
      log(`[performance] overview for ${u} (${platform ?? "all"}, ${range} d)`);
      res.json({ insight: { ...body, created_at: ins.data.created_at, stale: false }, suggestions: suggestionsFrom(L.analysis, body) });
    } catch (e: any) {
      if (/insights_unconfigured/.test(String(e?.message))) return res.status(503).json({ error: "insights_off" });
      fail(res, e);
    }
  });

  // Use a post with the Studio tools: bring it into the library (the file Clone8 made, or the post itself by its link).
  app.post("/api/studio/performance/posts/:id/use", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "post_not_found" });
      await needPlan(sb, u);
      const r = await sb.from("studio_perf_posts").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      const post = r.data as any;
      if (!post) return res.status(404).json({ error: "post_not_found" });
      let assetId: string | null = null;
      if (post.asset_id) { const a = await sb.from("studio_assets").select("id,status").eq("id", post.asset_id).eq("user_id", u).maybeSingle(); if (a.data?.status === "ready") assetId = a.data.id; }
      if (!assetId && post.social_post_id) {
        const sp = await sb.from("studio_social_posts").select("asset_id,job_id,output_key").eq("id", post.social_post_id).eq("user_id", u).maybeSingle();
        if (sp.data?.asset_id) assetId = sp.data.asset_id;
        else if (sp.data?.job_id && sp.data.output_key) {
          const j = await sb.from("studio_jobs").select("id,tool,outputs,options").eq("id", sp.data.job_id).eq("user_id", u).maybeSingle();
          const out = ((j.data?.outputs ?? []) as any[]).find((o) => o.key === sp.data!.output_key);
          if (j.data && out) assetId = await promoteOutput(sb, { env, fetch: deps.fetch, log } as any, u, { ...j.data, outputs: [out] }, (post.caption ?? "Posted video").slice(0, 40));
        }
      }
      if (!assetId) assetId = (await importLink(sb, { env, fetch: deps.fetch, log } as any, u, post.url)).asset_id;
      await sb.from("studio_perf_posts").update({ asset_id: assetId }).eq("id", post.id);
      const a = await sb.from("studio_assets").select("*").eq("id", assetId).eq("user_id", u).maybeSingle();
      res.json({ asset: (await withPosterUrls(sb, [a.data]))[0] });
    } catch (e: any) {
      const code = String(e?.code ?? "");
      if (["link_blocked", "link_unsupported", "link_failed", "link_too_long"].includes(code)) return res.status(422).json({ error: code, detail: String(e?.message ?? "") });
      fail(res, e);
    }
  });

  app.get("/api/studio/assistant/suggestions", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      // their own numbers first, then what they told us at sign-up (their first idea, then their goals)
      const sb = sbFn();
      const [perf, cust] = await Promise.all([performanceForChat(sb, u), sb.from("studio_customers").select("onboarding").eq("user_id", u).maybeSingle()]);
      const seen = new Set<string>();
      const suggestions = [...perf.suggestions, ...profileSuggestions(cust.data?.onboarding)].filter((s) => { const k = s.prompt.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
      res.json({ suggestions });
    } catch (e) { fail(res, e); }
  });
}

/** What is said in TikTok posts (one public-data lookup each), for the overview of the best ones. */
function scTranscripts(env: Record<string, string | undefined>, f: typeof fetch = fetch) {
  return async (urls: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const key = env.SCRAPECREATORS_API_KEY; if (!key) return out;
    for (const url of urls.slice(0, 2)) {
      try {
        const r = await f(`https://api.scrapecreators.com/v1/tiktok/video/transcript?url=${encodeURIComponent(url)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(45_000) });
        recordEvent({ kind: "vendor", name: "scrapecreators", usd: OVERHEAD.scrapecreators_usd_per_call, props: { path: "/v1/tiktok/video/transcript", status: r.status, use: "transcript" } });
        const b: any = r.ok ? await r.json() : null;
        const text = String(b?.transcript ?? "").replace(/WEBVTT|\d\d:\d\d:\d\d\.\d+ --> \d\d:\d\d:\d\d\.\d+/g, " ").replace(/\s+/g, " ").trim();
        if (text) out.set(url, text);
      } catch { /* the overview goes on without it */ }
    }
    return out;
  };
}

/** Once a day: refresh the people who opened the dashboard in the last 7 days. */
export function startPerformanceLoop(sbFn: () => SupabaseClient, deps: PerfDeps = {}): void {
  const env = deps.env ?? process.env;
  if (env.STUDIO_SOCIAL_ENABLED !== "true" || !(env.SCRAPECREATORS_API_KEY || env.AYRSHARE_API_KEY)) return;
  let busy = false;
  const tick = async () => {
    const sb = sbFn();
    const r = await sb.from("studio_social_profiles").select("user_id").gte("perf_viewed_at", new Date(Date.now() - 7 * 86400_000).toISOString()).limit(500);
    for (const row of (r.data ?? []) as any[]) {
      const a = await sb.from("studio_perf_accounts").select("refreshed_at").eq("user_id", row.user_id);
      const oldest = Math.min(...((a.data ?? []) as any[]).map((x) => Date.parse(x.refreshed_at)), Number.POSITIVE_INFINITY);
      if (Date.now() - oldest > 20 * 3600_000) await refreshOnce(sb, row.user_id, { ...deps, env }).catch(() => undefined);
    }
  };
  setInterval(() => {
    if (busy) return; // the last pass is still going
    busy = true;
    tick().catch((e) => console.error("[performance] tick", String(e?.message ?? e))).finally(() => { busy = false; });
  }, 3600_000).unref?.();
}
