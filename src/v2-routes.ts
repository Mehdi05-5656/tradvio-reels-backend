// v2 routes: devices, alerts, overview.
// Additive only. Reads from same Supabase tables + new v2 tables.
// Old /api/* endpoints untouched.

import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

type SbGetter = () => SupabaseClient;

const VALID_SLOTS = new Set(["phone_a", "phone_b", "tiktok_tradvio"]);

export function registerV2Routes(app: Express, sbFn: SbGetter): void {
  // ==================== DEVICES ====================

  // List all devices with derived health metrics
  app.get("/api/v2/devices", async (_req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const sevenAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [devicesRes, summaryRes, settingsRes, logRes, analyticsRes] = await Promise.all([
        sb.from("reels_devices").select("*").eq("active", true).order("created_at"),
        sb.from("reels_dashboard_summary").select("*"),
        sb.from("reels_settings").select("*"),
        sb
          .from("publer_publish_log")
          .select("phone_slot,status,attempted_at,error")
          .gte("attempted_at", sevenAgoIso)
          .order("attempted_at", { ascending: false }),
        sb
          .from("publer_analytics")
          .select("phone_slot,captured_at,video_views,reach,engagement,publer_post_id")
          .gte("captured_at", sevenAgoIso),
      ]);
      if (devicesRes.error) throw devicesRes.error;

      const summary = new Map((summaryRes.data ?? []).map((r) => [r.phone_slot, r]));
      const settings = new Map((settingsRes.data ?? []).map((r) => [r.phone_slot, r]));
      const logsBySlot = new Map<string, any[]>();
      (logRes.data ?? []).forEach((row) => {
        const arr = logsBySlot.get(row.phone_slot) ?? [];
        arr.push(row);
        logsBySlot.set(row.phone_slot, arr);
      });

      // For each (phone_slot, post) keep the latest snapshot to avoid double-counting.
      // publer_analytics rows are per-capture; the last capture per post is the current metric.
      const latestByPost = new Map<string, any>();
      (analyticsRes.data ?? []).forEach((row: any) => {
        const key = `${row.phone_slot}::${row.publer_post_id ?? row.captured_at}`;
        const prev = latestByPost.get(key);
        if (!prev || new Date(row.captured_at) > new Date(prev.captured_at)) latestByPost.set(key, row);
      });
      const analyticsBySlot = new Map<string, { views: number; reach: number; engagement: number }>();
      for (const row of latestByPost.values()) {
        const cur = analyticsBySlot.get(row.phone_slot) ?? { views: 0, reach: 0, engagement: 0 };
        cur.views += Number(row.video_views ?? 0);
        cur.reach += Number(row.reach ?? 0);
        cur.engagement += Number(row.engagement ?? 0);
        analyticsBySlot.set(row.phone_slot, cur);
      }

      const devices = (devicesRes.data ?? []).map((d: any) => {
        const s = summary.get(d.phone_slot) ?? {};
        const setting = settings.get(d.phone_slot) ?? {};
        const logs = logsBySlot.get(d.phone_slot) ?? [];
        const total = logs.length;
        const failed = logs.filter((l) => l.status === "failed").length;
        const lastAttempt = logs[0];
        const an = analyticsBySlot.get(d.phone_slot) ?? { views: 0, reach: 0, engagement: 0 };
        const status = d.paused ? "paused" : d.active ? "active" : "inactive";
        return {
          ...d,
          status,
          daily_target: setting.daily_target ?? 8,
          pending_count: Number(s.pending_count ?? 0),
          posted_count: Number(s.posted_count ?? 0),
          archived_count: Number(s.archived_count ?? 0),
          skipped_count: Number(s.skipped_count ?? 0),
          last_posted_at: s.last_posted_at ?? null,
          publish_success_rate_7d: total === 0 ? null : 1 - failed / total,
          publish_attempts_7d: total,
          publish_failures_7d: failed,
          last_publish_attempt_at: lastAttempt?.attempted_at ?? null,
          last_publish_error: lastAttempt?.error ?? null,
          views_7d: an.views,
          reach_7d: an.reach,
          engagement_7d: an.engagement,
        };
      });

      res.json({ devices });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update device (rename, tags, pause, group). Auth-gated via main middleware.
  app.post("/api/v2/devices/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const { display_name, tags, paused, device_group, notes } = req.body ?? {};
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (typeof display_name === "string") patch.display_name = display_name;
      if (Array.isArray(tags)) patch.tags = tags;
      if (typeof paused === "boolean") patch.paused = paused;
      if (typeof device_group === "string") patch.device_group = device_group;
      if (typeof notes === "string") patch.notes = notes;
      const { error } = await sbFn().from("reels_devices").update(patch).eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== ALERTS ====================

  // List alerts (active by default; ?all=1 for full history; ?limit=N)
  app.get("/api/v2/alerts", async (req: Request, res: Response) => {
    try {
      const showAll = req.query.all === "1";
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      let q = sbFn()
        .from("reels_alerts")
        .select("*")
        .order("fired_at", { ascending: false })
        .limit(limit);
      if (!showAll) q = q.is("dismissed_at", null);
      const { data, error } = await q;
      if (error) throw error;
      res.json({ alerts: data ?? [] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dismiss single alert
  app.post("/api/v2/alerts/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const { error } = await sbFn()
        .from("reels_alerts")
        .update({ dismissed_at: new Date().toISOString(), dismissed_by: "owner" })
        .eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dismiss all active alerts
  app.post("/api/v2/alerts/dismiss-all", async (_req: Request, res: Response) => {
    try {
      const { error } = await sbFn()
        .from("reels_alerts")
        .update({ dismissed_at: new Date().toISOString(), dismissed_by: "owner" })
        .is("dismissed_at", null);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manually trigger alert evaluator (also runs on cron)
  app.post("/api/v2/alerts/evaluate", async (_req: Request, res: Response) => {
    try {
      const result = await evaluateAlerts(sbFn());
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== OVERVIEW ====================

  // Overview KPIs: aggregate rollup for hero header
  app.get("/api/v2/overview", async (_req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400_000).toISOString();

      const [summaryRes, alertRes, publishRes, analytics7Res, analytics14Res, devicesRes] =
        await Promise.all([
          sb.from("reels_dashboard_summary").select("*"),
          sb
            .from("reels_alerts")
            .select("type,severity,fired_at")
            .is("dismissed_at", null),
          sb
            .from("publer_publish_log")
            .select("status,attempted_at")
            .gte("attempted_at", sevenDaysAgo),
          sb
            .from("publer_analytics")
            .select("phone_slot,captured_at,video_views,reach,engagement,likes,comments,shares")
            .gte("captured_at", sevenDaysAgo),
          sb
            .from("publer_analytics")
            .select("phone_slot,captured_at,video_views,reach,engagement")
            .gte("captured_at", fourteenDaysAgo)
            .lt("captured_at", sevenDaysAgo),
          sb.from("reels_devices").select("phone_slot,display_name,paused").eq("active", true),
        ]);

      const totalPending = (summaryRes.data ?? []).reduce(
        (a: number, r: any) => a + Number(r.pending_count ?? 0),
        0
      );
      const postedToday = (summaryRes.data ?? []).reduce((a: number, r: any) => {
        const last = r.last_posted_at ? new Date(r.last_posted_at) : null;
        return a + Number(r.posted_count ?? 0);
      }, 0);

      const publishLogs = publishRes.data ?? [];
      const publishTotal = publishLogs.length;
      const publishFailed = publishLogs.filter((l: any) => l.status === "failed").length;
      const publishSuccessRate = publishTotal === 0 ? null : 1 - publishFailed / publishTotal;

      // Reach in last 7d vs prior 7d
      const sum = (rows: any[], k: string) =>
        rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
      const cur7 = analytics7Res.data ?? [];
      const prev7 = analytics14Res.data ?? [];
      const reach7 = sum(cur7, "reach");
      const reachPrev7 = sum(prev7, "reach");
      const views7 = sum(cur7, "video_views");
      const viewsPrev7 = sum(prev7, "video_views");
      const eng7 = sum(cur7, "engagement");
      const engPrev7 = sum(prev7, "engagement");

      const pctChange = (cur: number, prev: number) =>
        prev === 0 ? null : ((cur - prev) / prev) * 100;

      // Alerts by severity
      const alerts = alertRes.data ?? [];
      const alertsBySeverity = alerts.reduce((acc: Record<string, number>, a: any) => {
        acc[a.severity] = (acc[a.severity] ?? 0) + 1;
        return acc;
      }, {});

      // Queue runway (days at current 8/day/device pace)
      const devices = devicesRes.data ?? [];
      const activeDevices = devices.filter((d: any) => !d.paused).length;
      const daysRunway =
        activeDevices === 0 || totalPending === 0
          ? null
          : Math.floor(totalPending / (activeDevices * 8));

      res.json({
        as_of: now.toISOString(),
        total_pending: totalPending,
        posted_today: postedToday,
        active_devices: activeDevices,
        total_devices: devices.length,
        publish_success_rate_7d: publishSuccessRate,
        publish_attempts_7d: publishTotal,
        days_of_runway: daysRunway,
        views_7d: views7,
        views_prev_7d: viewsPrev7,
        views_change_pct: pctChange(views7, viewsPrev7),
        reach_7d: reach7,
        reach_prev_7d: reachPrev7,
        reach_change_pct: pctChange(reach7, reachPrev7),
        engagement_7d: eng7,
        engagement_prev_7d: engPrev7,
        engagement_change_pct: pctChange(eng7, engPrev7),
        alerts: {
          total: alerts.length,
          critical: alertsBySeverity.critical ?? 0,
          warning: alertsBySeverity.warning ?? 0,
          info: alertsBySeverity.info ?? 0,
          success: alertsBySeverity.success ?? 0,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== ENHANCED ANALYTICS ====================

  // Per-device analytics with time-of-day heatmap + retention indicators
  app.get("/api/v2/analytics/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) {
        return res.status(400).json({ error: "invalid phone slot" });
      }
      const days = Math.min(Number(req.query.days ?? 30), 90);
      const since = new Date(Date.now() - days * 86400_000).toISOString();

      const sb = sbFn();
      const { data, error } = await sb
        .from("publer_analytics")
        .select("*")
        .eq("phone_slot", phone)
        .gte("captured_at", since)
        .order("captured_at", { ascending: false });
      if (error) throw error;

      // Group by publer_post_id, keep latest snapshot per post
      const byPost = new Map<string, any>();
      for (const row of data ?? []) {
        const cur = byPost.get(row.publer_post_id);
        if (!cur || new Date(row.captured_at) > new Date(cur.captured_at)) {
          byPost.set(row.publer_post_id, row);
        }
      }
      const posts = Array.from(byPost.values());

      // Best time-of-day heatmap: 7 days x 24 hours = engagement rate median
      const heatmap: Record<string, { total: number; count: number; avg: number }> = {};
      for (const p of posts) {
        const scheduledAt = p.raw?.scheduled_at || p.raw?.updated_at;
        if (!scheduledAt) continue;
        const d = new Date(scheduledAt);
        const dow = d.getDay(); // 0=Sun
        const hour = d.getHours();
        const key = `${dow}-${hour}`;
        const engRate = Number(p.engagement_rate ?? 0);
        const cur = heatmap[key] ?? { total: 0, count: 0, avg: 0 };
        cur.total += engRate;
        cur.count += 1;
        cur.avg = cur.total / cur.count;
        heatmap[key] = cur;
      }

      // Top 5 performers
      const topPerformers = [...posts]
        .filter((p) => (p.video_views ?? 0) > 0)
        .sort((a, b) => Number(b.video_views ?? 0) - Number(a.video_views ?? 0))
        .slice(0, 5);

      // Underperformers (lowest views in posts >= 6h old)
      const now = Date.now();
      const matureUnderperformers = posts
        .filter((p) => {
          const sched = p.raw?.scheduled_at;
          if (!sched) return false;
          return now - new Date(sched).getTime() > 6 * 3600_000;
        })
        .sort((a, b) => Number(a.video_views ?? 0) - Number(b.video_views ?? 0))
        .slice(0, 5);

      const totalViews = posts.reduce((a, p) => a + Number(p.video_views ?? 0), 0);
      const totalReach = posts.reduce((a, p) => a + Number(p.reach ?? 0), 0);
      const totalLikes = posts.reduce((a, p) => a + Number(p.likes ?? 0), 0);
      const totalEng = posts.reduce((a, p) => a + Number(p.engagement ?? 0), 0);
      const medianViews = median(posts.map((p) => Number(p.video_views ?? 0)));

      res.json({
        phone_slot: phone,
        window_days: days,
        posts_count: posts.length,
        totals: {
          views: totalViews,
          reach: totalReach,
          likes: totalLikes,
          engagement: totalEng,
          median_views_per_post: medianViews,
        },
        heatmap,
        top_performers: topPerformers.map(publicPost),
        underperformers: matureUnderperformers.map(publicPost),
        posts_time_series: posts
          .filter((p) => p.raw?.scheduled_at)
          .map((p) => ({
            id: p.publer_post_id,
            scheduled_at: p.raw?.scheduled_at,
            video_views: Number(p.video_views ?? 0),
            reach: Number(p.reach ?? 0),
            engagement_rate: Number(p.engagement_rate ?? 0),
            post_link: p.raw?.post_link ?? null,
          })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ==================== HELPERS ====================

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function publicPost(p: any) {
  return {
    id: p.publer_post_id,
    video_views: Number(p.video_views ?? 0),
    reach: Number(p.reach ?? 0),
    likes: Number(p.likes ?? 0),
    comments: Number(p.comments ?? 0),
    shares: Number(p.shares ?? 0),
    engagement: Number(p.engagement ?? 0),
    engagement_rate: Number(p.engagement_rate ?? 0),
    scheduled_at: p.raw?.scheduled_at ?? null,
    post_link: p.raw?.post_link ?? null,
    thumbnail: p.raw?.medias?.[0]?.thumbnail ?? p.raw?.medias?.[0]?.path ?? null,
  };
}

// ==================== ALERT EVALUATOR ====================

export async function evaluateAlerts(sb: SupabaseClient): Promise<any> {
  const fired: any[] = [];

  const { data: rules } = await sb.from("reels_alert_rules").select("*").eq("enabled", true);
  const { data: devices } = await sb.from("reels_devices").select("*").eq("active", true);
  if (!rules || !devices) return { fired: 0 };

  const ruleByType = new Map<string, any>();
  for (const r of rules) if (!r.phone_slot) ruleByType.set(r.rule_type, r);

  // ---- 1. Viral velocity ----
  const viralRule = ruleByType.get("viral_velocity");
  if (viralRule) {
    const cfg = viralRule.config;
    const minViewsLastHour = Number(cfg.min_views_last_hour ?? 500);
    const baselineMultiplier = Number(cfg.baseline_multiplier ?? 3.0);
    const minBaseline = Number(cfg.min_baseline ?? 20);

    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString();
    const twentyFourHoursAgo = new Date(now - 24 * 3600_000).toISOString();

    const { data: recent } = await sb
      .from("publer_analytics")
      .select("publer_post_id,phone_slot,captured_at,video_views,reach")
      .gte("captured_at", twentyFourHoursAgo)
      .order("captured_at", { ascending: false });

    if (recent) {
      // Group by post; find latest and 1-hour-prior snapshot
      const byPost = new Map<string, any[]>();
      for (const row of recent) {
        const arr = byPost.get(row.publer_post_id) ?? [];
        arr.push(row);
        byPost.set(row.publer_post_id, arr);
      }

      for (const [postId, snapshots] of byPost.entries()) {
        snapshots.sort(
          (a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
        );
        const latest = snapshots[0];
        // Find snapshot ~1h older
        const oneHourAgo = new Date(new Date(latest.captured_at).getTime() - 3600_000).getTime();
        const prior = snapshots.find(
          (s) => new Date(s.captured_at).getTime() <= oneHourAgo + 300_000
        );
        if (!prior) continue;

        const viewsLastHour = Number(latest.video_views ?? 0) - Number(prior.video_views ?? 0);
        if (viewsLastHour < minViewsLastHour) continue;

        // Baseline: earliest snapshot in the 24h window
        const earliest = snapshots[snapshots.length - 1];
        const baselineHours =
          (new Date(latest.captured_at).getTime() - new Date(earliest.captured_at).getTime()) /
          3600_000;
        if (baselineHours < 1) continue;
        const baselineViewsPerHour = Number(earliest.video_views ?? 0) / baselineHours;
        if (baselineViewsPerHour < minBaseline) continue;
        if (viewsLastHour < baselineViewsPerHour * baselineMultiplier) continue;

        // Check we haven't already fired for this post in the last 6h
        const { data: existing } = await sb
          .from("reels_alerts")
          .select("id")
          .eq("type", "viral_velocity")
          .contains("payload", { post_id: postId })
          .gte("fired_at", new Date(now - 6 * 3600_000).toISOString())
          .limit(1);
        if (existing && existing.length > 0) continue;

        fired.push({
          type: "viral_velocity",
          severity: "success",
          phone_slot: latest.phone_slot,
          title: `Viral: ${viewsLastHour.toLocaleString()} views in the last hour`,
          body: `Post is running at ${(viewsLastHour / baselineViewsPerHour).toFixed(1)}x its baseline rate.`,
          payload: {
            post_id: postId,
            views_last_hour: viewsLastHour,
            total_views: Number(latest.video_views ?? 0),
            baseline_views_per_hour: baselineViewsPerHour,
            multiplier: viewsLastHour / baselineViewsPerHour,
          },
          metric_value: viewsLastHour,
          threshold_value: minViewsLastHour,
        });
      }
    }
  }

  // ---- 2. Underperformer detection ----
  const underRule = ruleByType.get("underperformer");
  if (underRule) {
    const cfg = underRule.config;
    const hoursAfterPost = Number(cfg.hours_after_post ?? 6);
    const pctOfMedian = Number(cfg.pct_of_median ?? 0.10);
    const minMedianViews = Number(cfg.min_median_views ?? 10);

    for (const d of devices) {
      const { data: recent } = await sb
        .from("publer_analytics")
        .select("publer_post_id,captured_at,video_views,raw")
        .eq("phone_slot", d.phone_slot)
        .gte("captured_at", new Date(Date.now() - 7 * 86400_000).toISOString());

      if (!recent || recent.length === 0) continue;

      // Latest snapshot per post
      const byPost = new Map<string, any>();
      for (const row of recent) {
        const cur = byPost.get(row.publer_post_id);
        if (!cur || new Date(row.captured_at) > new Date(cur.captured_at)) {
          byPost.set(row.publer_post_id, row);
        }
      }
      const posts = Array.from(byPost.values());
      const viewsArr = posts.map((p) => Number(p.video_views ?? 0));
      const med = median(viewsArr);
      if (med < minMedianViews) continue;

      const now = Date.now();
      for (const p of posts) {
        const sched = p.raw?.scheduled_at;
        if (!sched) continue;
        const ageHours = (now - new Date(sched).getTime()) / 3600_000;
        if (ageHours < hoursAfterPost) continue;
        // Only fresh dud alerts (post is ≤ 30h old — after that it's history)
        if (ageHours > 30) continue;

        const v = Number(p.video_views ?? 0);
        if (v > med * pctOfMedian) continue;

        // Dedupe: don't fire again for same post
        const { data: existing } = await sb
          .from("reels_alerts")
          .select("id")
          .eq("type", "underperformer")
          .contains("payload", { post_id: p.publer_post_id })
          .limit(1);
        if (existing && existing.length > 0) continue;

        fired.push({
          type: "underperformer",
          severity: "warning",
          phone_slot: d.phone_slot,
          title: `Underperforming: ${v} views (median ${Math.round(med)})`,
          body: `Post is at ${((v / med) * 100).toFixed(0)}% of ${d.display_name}'s ${posts.length}-post median after ${ageHours.toFixed(1)}h.`,
          payload: {
            post_id: p.publer_post_id,
            views: v,
            median_views: med,
            pct_of_median: v / med,
            age_hours: ageHours,
            post_link: p.raw?.post_link ?? null,
          },
          metric_value: v,
          threshold_value: med * pctOfMedian,
        });
      }
    }
  }

  // ---- 3. System health: cron staleness ----
  const cronRule = ruleByType.get("cron_health");
  if (cronRule) {
    const maxMinutes = Number(cronRule.config.max_minutes_stale ?? 30);

    const { data: latestAnalytics } = await sb
      .from("publer_analytics")
      .select("captured_at")
      .order("captured_at", { ascending: false })
      .limit(1);

    if (latestAnalytics && latestAnalytics.length > 0) {
      const staleness =
        (Date.now() - new Date(latestAnalytics[0].captured_at).getTime()) / 60_000;
      if (staleness > maxMinutes) {
        const { data: existing } = await sb
          .from("reels_alerts")
          .select("id")
          .eq("type", "system_health")
          .contains("payload", { check: "analytics_stale" })
          .is("dismissed_at", null)
          .limit(1);
        if (!existing || existing.length === 0) {
          fired.push({
            type: "system_health",
            severity: "critical",
            phone_slot: null,
            title: "Analytics cron is stale",
            body: `No analytics captured in the last ${Math.round(staleness)} minutes (threshold ${maxMinutes}m).`,
            payload: {
              check: "analytics_stale",
              staleness_minutes: staleness,
            },
            metric_value: staleness,
            threshold_value: maxMinutes,
          });
        }
      }
    }
  }

  // ---- 4. Queue runway ----
  const runwayRule = ruleByType.get("queue_runway");
  if (runwayRule) {
    const minDays = Number(runwayRule.config.min_days ?? 3);
    const { data: summary } = await sb
      .from("reels_dashboard_summary")
      .select("phone_slot,pending_count");
    if (summary) {
      const bySlot = new Map(summary.map((s: any) => [s.phone_slot, Number(s.pending_count)]));
      for (const d of devices) {
        if (d.paused) continue;
        const pending = bySlot.get(d.phone_slot) ?? 0;
        const days = Math.floor(pending / 8);
        if (days > minDays) continue;
        const { data: existing } = await sb
          .from("reels_alerts")
          .select("id")
          .eq("type", "system_health")
          .contains("payload", { check: "queue_runway", phone_slot: d.phone_slot })
          .is("dismissed_at", null)
          .limit(1);
        if (existing && existing.length > 0) continue;
        fired.push({
          type: "system_health",
          severity: days === 0 ? "critical" : "warning",
          phone_slot: d.phone_slot,
          title: `${d.display_name}: ${days} days of runway left`,
          body: `${pending} pending posts / 8 per day = ${days} days. Add more content soon.`,
          payload: {
            check: "queue_runway",
            phone_slot: d.phone_slot,
            pending,
            days_left: days,
          },
          metric_value: days,
          threshold_value: minDays,
        });
      }
    }
  }

  // ---- 5. Top performer daily digest ----
  // Fire once per day per device, in the evening (>= digest_hour_pt)
  const topRule = ruleByType.get("top_performer");
  if (topRule) {
    const digestHourPt = Number(topRule.config.digest_hour_pt ?? 20);
    const nowPt = new Date();
    // Rough PT hour (America/Los_Angeles is UTC-7 or -8; use -7 as a safe threshold)
    const utcHour = nowPt.getUTCHours();
    const ptHour = (utcHour + 24 - 7) % 24;
    if (ptHour >= digestHourPt) {
      const todayStart = new Date();
      todayStart.setUTCHours(digestHourPt + 7, 0, 0, 0);
      // If it's before today's digest hour in UTC, shift back
      if (todayStart.getTime() > Date.now()) todayStart.setDate(todayStart.getDate() - 1);

      for (const d of devices) {
        const { data: existing } = await sb
          .from("reels_alerts")
          .select("id")
          .eq("type", "top_performer")
          .eq("phone_slot", d.phone_slot)
          .gte("fired_at", todayStart.toISOString())
          .limit(1);
        if (existing && existing.length > 0) continue;

        const { data: todayPosts } = await sb
          .from("publer_analytics")
          .select("publer_post_id,video_views,engagement_rate,raw")
          .eq("phone_slot", d.phone_slot)
          .gte("captured_at", new Date(Date.now() - 30 * 3600_000).toISOString());
        if (!todayPosts || todayPosts.length === 0) continue;

        const byPost = new Map<string, any>();
        for (const p of todayPosts) {
          const cur = byPost.get(p.publer_post_id);
          if (
            !cur ||
            Number(p.video_views ?? 0) > Number(cur.video_views ?? 0)
          ) {
            byPost.set(p.publer_post_id, p);
          }
        }
        const posts = Array.from(byPost.values());
        posts.sort((a, b) => Number(b.video_views ?? 0) - Number(a.video_views ?? 0));
        const top = posts[0];
        if (!top || Number(top.video_views ?? 0) === 0) continue;

        fired.push({
          type: "top_performer",
          severity: "info",
          phone_slot: d.phone_slot,
          title: `${d.display_name} top post: ${Number(top.video_views).toLocaleString()} views`,
          body: `Best-performing post today with ${(Number(top.engagement_rate ?? 0) * 100).toFixed(1)}% engagement rate.`,
          payload: {
            post_id: top.publer_post_id,
            video_views: Number(top.video_views ?? 0),
            engagement_rate: Number(top.engagement_rate ?? 0),
            post_link: top.raw?.post_link ?? null,
          },
          metric_value: Number(top.video_views ?? 0),
        });
      }
    }
  }

  // Insert all fired alerts
  if (fired.length > 0) {
    const { error } = await sb.from("reels_alerts").insert(fired);
    if (error) throw error;
  }

  return { fired: fired.length, alerts: fired };
}
