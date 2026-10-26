// Per-client learning, phase 2: what a client's own posts taught us. The scoring runs in the database
// (client_learning_refresh, hourly from the analytics cron) and only ever reads the client's own slots; these routes
// read the results back for the admin panel and let an operator refresh one client on demand.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LearningSummary = {
  client: { id: string; name: string; slug: string };
  learning: Record<string, any>;
  settings: { optimize: boolean; exploration_share: number; retire_after_posts: number; retire_below_pct: number; winner_weight: number } | null;
  queue: { pending: number; ranked: number };
  last_run: { ran_at: string; posts_scored: number; posts_published: number; sources: number; duration_ms: number | null } | null;
  posts: { scored: number; with_arm: number; median_views: number | null; top: any[]; bottom: any[] };
  sources: { total: number; retired: number; top: any[]; weakest: any[]; retired_list: any[] };
  experiments: any[];
  leaders: any[];
};

/** Reads one client's learning state. Every query carries the client id. */
export async function loadLearning(sb: SupabaseClient, org: { id: string; name: string; slug: string }): Promise<LearningSummary> {
  const sel = "queue_id,phone_slot,publer_post_id,source_sha256,arm,published_at,latest_read_at,views,likes,comments,shares,saves,engagement_rate,composite,rank_in_org";
  const [run, top, bottom, counts, srcTop, srcWeak, srcCounts, experiments, leaders, scoredCount, armCount, orgRow, settings, retiredRows, slots] = await Promise.all([
    sb.from("client_learning_runs").select("ran_at,posts_scored,posts_published,sources,duration_ms").eq("org_id", org.id).order("ran_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("client_post_scores").select(sel).eq("org_id", org.id).order("rank_in_org", { ascending: true }).limit(10),
    sb.from("client_post_scores").select(sel).eq("org_id", org.id).order("rank_in_org", { ascending: false }).limit(5),
    sb.from("client_post_scores").select("arm,views").eq("org_id", org.id).range(0, 9999),
    sb.from("client_source_stats").select("source_sha256,posts,accounts,median_views,p75_views,avg_composite,last_posted_at,retired").eq("org_id", org.id).eq("retired", false).order("avg_composite", { ascending: false, nullsFirst: false }).limit(10),
    sb.from("client_source_stats").select("source_sha256,posts,accounts,median_views,p75_views,avg_composite,last_posted_at,retired").eq("org_id", org.id).gte("posts", 3).order("avg_composite", { ascending: true, nullsFirst: false }).limit(5),
    sb.from("client_source_stats").select("retired").eq("org_id", org.id),
    sb.from("client_experiments").select("id,hypothesis,primary_metric,minimum_per_arm,winner_arm,decided_at,evaluation,evaluated_at,registered_at").eq("org_id", org.id).order("registered_at", { ascending: false }),
    sb.from("leader_accounts").select("id,provider,handle,active,created_at").eq("org_id", org.id).order("created_at"),
    // Exact counts: a plain select is capped at 1,000 rows by the API, which under-reported bigger clients.
    sb.from("client_post_scores").select("queue_id", { count: "exact", head: true }).eq("org_id", org.id),
    sb.from("client_post_scores").select("queue_id", { count: "exact", head: true }).eq("org_id", org.id).not("arm", "is", null),
    sb.from("client_orgs").select("learning").eq("id", org.id).maybeSingle(),
    sb.rpc("client_learning_settings", { p_org: org.id }),
    sb.from("client_source_stats").select("source_sha256,posts,accounts,median_views,p75_views,avg_composite,last_posted_at,retired,retired_at,retired_reason,pinned").eq("org_id", org.id).eq("retired", true).order("retired_at", { ascending: false }).limit(20),
    sb.from("client_org_accounts").select("phone_slot").eq("org_id", org.id),
  ]);
  const slotList = ((slots.data ?? []) as any[]).map((r) => r.phone_slot);
  const [pendingCount, rankedCount] = slotList.length ? await Promise.all([
    sb.from("reels_manual_queue").select("id", { count: "exact", head: true }).in("phone_slot", slotList).eq("status", "pending"),
    sb.from("reels_manual_queue").select("id", { count: "exact", head: true }).in("phone_slot", slotList).eq("status", "pending").not("queue_rank", "is", null),
  ]) : [{ count: 0, error: null } as any, { count: 0, error: null } as any];
  for (const r of [run, top, bottom, counts, srcTop, srcWeak, srcCounts, experiments, leaders, scoredCount, armCount, orgRow, settings, retiredRows, slots, pendingCount, rankedCount]) if (r.error) throw r.error;
  const views = ((counts.data ?? []) as any[]).map((r) => Number(r.views)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = views.length ? views[Math.floor(views.length / 2)] : null;
  const srcRows = (srcCounts.data ?? []) as any[];
  return {
    client: org,
    learning: (orgRow.data as any)?.learning ?? {},
    settings: (settings.data as any) ?? null,
    queue: { pending: pendingCount.count ?? 0, ranked: rankedCount.count ?? 0 },
    last_run: run.data ?? null,
    posts: { scored: scoredCount.count ?? (counts.data ?? []).length, with_arm: armCount.count ?? ((counts.data ?? []) as any[]).filter((r) => r.arm).length, median_views: median, top: top.data ?? [], bottom: bottom.data ?? [] },
    sources: { total: srcRows.length, retired: srcRows.filter((r) => r.retired).length, top: srcTop.data ?? [], weakest: srcWeak.data ?? [], retired_list: retiredRows.data ?? [] },
    experiments: experiments.data ?? [],
    leaders: leaders.data ?? [],
  };
}

/** Hourly from the analytics cron: the database refreshes every live client at most once per 50 minutes. */
export async function learningTick(sb: SupabaseClient, force = false): Promise<any> {
  const r = await sb.rpc("client_learning_refresh", { p_force: force });
  if (r.error) throw new Error(`client_learning_refresh: ${r.error.message}`);
  return r.data;
}

export function registerClientLearning(app: Express, sbFn: () => SupabaseClient): void {
  const loadOrg = async (sb: SupabaseClient, id: string) => {
    if (!UUID_RE.test(id)) return null;
    const r = await sb.from("client_orgs").select("id,name,slug,archived_at").eq("id", id).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  };
  const fail = (res: Response, e: any) => {
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist|function .* does not exist/i.test(msg)) return res.status(503).json({ error: "learning_unavailable", detail: "The learning migration has not been applied" });
    console.error("[client-learning]", msg);
    res.status(500).json({ error: "learning_failed", detail: msg.slice(0, 200) });
  };

  app.get("/api/ops/clients/:id/learning", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      res.json(await loadLearning(sb, { id: org.id, name: org.name, slug: org.slug }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients/:id/learning/refresh", async (req: Request, res: Response) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator_required" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      if (org.archived_at) return res.status(409).json({ error: "client_archived" });
      const r = await sb.rpc("client_learning_refresh_org", { p_org: org.id });
      if (r.error) throw r.error;
      const retire = await sb.rpc("client_learning_retire", { p_org: org.id });
      if (retire.error) throw retire.error;
      const ranked = await sb.rpc("client_learning_rank_queue", { p_org: org.id });
      if (ranked.error) throw ranked.error;
      const result = { ...(r.data ?? {}), retire: retire.data, ranked: ranked.data };
      console.log("[client-learning] refreshed", JSON.stringify({ by: (req.auth as any)?.user_id, org: org.id, result }));
      res.json({ result, learning: await loadLearning(sb, { id: org.id, name: org.name, slug: org.slug }) });
    } catch (e) { fail(res, e); }
  });

  // Retire a vault video for this client, or restore one (restoring pins it against automatic retirement).
  app.post("/api/ops/clients/:id/learning/sources/:sha", async (req: Request, res: Response) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator_required" });
    if (!/^[0-9a-f]{64}$/.test(req.params.sha)) return res.status(400).json({ error: "invalid_source" });
    if (typeof req.body?.retired !== "boolean") return res.status(400).json({ error: "invalid_retired" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const owned = await sb.from("library_sources").select("sha256").eq("sha256", req.params.sha).eq("org_id", org.id).maybeSingle();
      if (owned.error) throw owned.error;
      if (!owned.data) return res.status(404).json({ error: "source_not_in_client" });
      const r = await sb.rpc("client_source_set_retired", { p_org: org.id, p_sha: req.params.sha, p_retired: req.body.retired, p_actor: String((req.auth as any)?.user_id ?? "") });
      if (r.error) throw r.error;
      console.log("[client-learning] source", JSON.stringify({ by: (req.auth as any)?.user_id, org: org.id, result: r.data }));
      res.json({ result: r.data, learning: await loadLearning(sb, { id: org.id, name: org.name, slug: org.slug }) });
    } catch (e) { fail(res, e); }
  });
}
