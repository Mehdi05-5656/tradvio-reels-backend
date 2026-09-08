// v2 routes: devices, alerts, overview.
// Additive only. Reads from same Supabase tables + new v2 tables.
// Old /api/* endpoints untouched.

import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSlots } from "./publer-schedule";
import { filterVisibleSlots, assertCanReadSlot, isAdmin } from "./auth.js";

type SbGetter = () => SupabaseClient;

const VALID_SLOTS = new Set(["phone_a", "phone_b", "tiktok_tradvio"]);

// Load slots the current requester is allowed to see. Admin -> all, user -> owned,
// unauth -> empty. All slot-scoped read routes should filter through this.
async function visibleSlots(req: Request, sb: SupabaseClient) {
  const slots = await loadSlots(sb);
  return { all: slots, visible: filterVisibleSlots(req, slots) };
}

export function registerV2Routes(app: Express, sbFn: SbGetter): void {
  // ==================== DEVICES ====================

  // List all devices with derived health metrics
  app.get("/api/v2/devices", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) return res.json({ devices: [] });
      const scoped = <T>(builder: T): T => {
        if (admin) return builder;
        return (builder as any).in("phone_slot", visibleIds) as T;
      };
      const sevenAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [devicesRes, summaryRes, settingsRes, logRes, analyticsRes] = await Promise.all([
        scoped(sb.from("reels_devices").select("*").eq("active", true).order("created_at")),
        scoped(sb.from("reels_dashboard_summary").select("*")),
        scoped(sb.from("reels_settings").select("*")),
        scoped(
          sb
            .from("publer_publish_log")
            .select("phone_slot,status,attempted_at,error")
            .gte("attempted_at", sevenAgoIso)
            .order("attempted_at", { ascending: false }),
        ),
        scoped(
          sb
            .from("publer_analytics")
            .select("phone_slot,captured_at,video_views,reach,engagement,publer_post_id")
            .gte("captured_at", sevenAgoIso),
        ),
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
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) return res.json({ alerts: [] });
      const showAll = req.query.all === "1";
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      let q = sb
        .from("reels_alerts")
        .select("*")
        .order("fired_at", { ascending: false })
        .limit(limit);
      if (!admin) q = q.in("phone_slot", visibleIds);
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
  app.get("/api/v2/overview", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      // Non-admin with no owned slots: return an empty overview instead of leaking totals.
      if (visibleIds.length === 0 && !isAdmin(req)) {
        return res.json({
          as_of: new Date().toISOString(),
          total_pending: 0,
          posted_today: 0,
          active_devices: 0,
          total_devices: 0,
          publish_success_rate_7d: null,
          publish_attempts_7d: 0,
          days_of_runway: null,
          views_7d: 0,
          views_prev_7d: 0,
          views_change_pct: null,
          reach_7d: 0,
          reach_prev_7d: 0,
          reach_change_pct: null,
          engagement_7d: 0,
          engagement_prev_7d: 0,
          engagement_change_pct: null,
          alerts: { total: 0, critical: 0, warning: 0, info: 0, success: 0 },
        });
      }
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400_000).toISOString();
      const admin = isAdmin(req);

      // Build scoped query helper: admin sees all rows; user sees only visible slot rows.
      const scoped = <T>(builder: T): T => {
        if (admin) return builder;
        return (builder as any).in("phone_slot", visibleIds) as T;
      };

      const [summaryRes, alertRes, publishRes, analytics7Res, analytics14Res, devicesRes] =
        await Promise.all([
          scoped(sb.from("reels_dashboard_summary").select("*")),
          admin
            ? sb.from("reels_alerts").select("type,severity,fired_at").is("dismissed_at", null)
            : sb
                .from("reels_alerts")
                .select("type,severity,fired_at,phone_slot")
                .is("dismissed_at", null)
                .in("phone_slot", visibleIds),
          scoped(
            sb
              .from("publer_publish_log")
              .select("status,attempted_at,phone_slot")
              .gte("attempted_at", sevenDaysAgo),
          ),
          scoped(
            sb
              .from("publer_analytics")
              .select("phone_slot,captured_at,video_views,reach,engagement,likes,comments,shares")
              .gte("captured_at", sevenDaysAgo),
          ),
          scoped(
            sb
              .from("publer_analytics")
              .select("phone_slot,captured_at,video_views,reach,engagement")
              .gte("captured_at", fourteenDaysAgo)
              .lt("captured_at", sevenDaysAgo),
          ),
          scoped(sb.from("reels_devices").select("phone_slot,display_name,paused").eq("active", true)),
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

  // Per-device analytics with time-of-day heatmap + retention indicators.
  //
  // Data source is provider-specific:
  //   IG:     publer_analytics (Publer /post_insights returns real IG data)
  //   TikTok: own_video_stats  (Publer returns 0 views for TT; SC is real data)
  //
  // Range: ?days=N (0 = lifetime, clamped 1..3650 otherwise) OR
  //        ?from=YYYY-MM-DD&to=YYYY-MM-DD (min 2026-09-05, IG lower bound only).
  app.get("/api/v2/analytics/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) {
        return res.status(400).json({ error: "invalid phone slot" });
      }

      const sb = sbFn();
      const slots = await loadSlots(sb);
      if (assertCanReadSlot(req, res, slots, phone)) return;
      const slot = slots.find((s) => s.phone_slot === phone)!;
      const isTikTok = slot.provider === "tiktok";

      // Window resolution.
      // IG has a hard lower bound of 2026-09-05 (Publer coverage start).
      // TikTok has none — own_video_stats spans back to 2025.
      const MIN_DATE = "2026-09-05";
      const rawDays = parseInt(String(req.query.days ?? "30"), 10);
      const isLifetime = rawDays === 0;
      const days = isLifetime ? 0 : Math.max(1, Math.min(3650, rawDays));
      let sinceISO: string;
      let untilISO: string | null = null;
      let windowLabel: string;
      if (req.query.from) {
        let from = String(req.query.from);
        if (!isTikTok && from < MIN_DATE) from = MIN_DATE;
        const to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
        sinceISO = `${from}T00:00:00-07:00`;
        untilISO = `${to}T23:59:59-07:00`;
        windowLabel = `${from} to ${to}`;
      } else if (isLifetime) {
        // Lifetime: no lower bound. Use 20-year floor to avoid null-timestamp
        // gotchas but effectively "everything".
        sinceISO = new Date(Date.now() - 3650 * 86400_000).toISOString();
        windowLabel = "lifetime";
      } else {
        sinceISO = new Date(Date.now() - days * 86400_000).toISOString();
        windowLabel = `last ${days} days`;
      }

      // Normalized post shape used by aggregation below.
      type NormPost = {
        post_id: string;
        post_link: string | null;
        scheduled_at: string; // ISO — drives heatmap + daily_series
        posted_at: string; // ISO — used for maturity filter (underperformers)
        video_views: number;
        reach: number;
        likes: number;
        comments: number;
        shares: number;
        saves: number;
        engagement: number; // likes+comments+shares+saves
        engagement_rate: number; // percent; 0 for TikTok (no reach)
        thumbnail_url: string | null;
        caption: string | null;
      };

      let posts: NormPost[] = [];
      let dataSource: string;

      if (isTikTok) {
        dataSource = "own_video_stats";
        // Case-insensitive: slot handle may be "Tradvio", TT canonical is "tradvio".
        let q = sb
          .from("own_video_stats")
          .select("*")
          .eq("platform", "tiktok")
          .ilike("own_handle", slot.handle)
          .gte("posted_at", sinceISO);
        if (untilISO) q = q.lte("posted_at", untilISO);
        const { data: rows, error } = await q.order("captured_at", {
          ascending: false,
        });
        if (error) throw error;
        // Keep only the most-recent snapshot per post.
        const latestByPost = new Map<string, any>();
        for (const r of rows ?? []) {
          const key = r.post_aweme_id || String(r.id);
          if (!latestByPost.has(key)) latestByPost.set(key, r);
        }
        posts = Array.from(latestByPost.values()).map((r: any) => {
          const likes = Number(r.like_count ?? 0);
          const comments = Number(r.comment_count ?? 0);
          const shares = Number(r.share_count ?? 0);
          const saves = Number(r.save_count ?? 0);
          const eng = likes + comments + shares + saves;
          const posted = r.posted_at || r.captured_at;
          return {
            post_id: r.post_aweme_id ?? String(r.id),
            post_link: r.post_aweme_id
              ? `https://www.tiktok.com/@${slot.handle}/video/${r.post_aweme_id}`
              : null,
            scheduled_at: posted,
            posted_at: posted,
            video_views: Number(r.play_count ?? r.view_count ?? 0),
            reach: 0,
            likes,
            comments,
            shares,
            saves,
            engagement: eng,
            engagement_rate: 0,
            thumbnail_url: r.thumbnail_url ?? null,
            caption: r.caption ?? null,
          };
        });
      } else {
        dataSource = "publer_analytics";
        let q = sb
          .from("publer_analytics")
          .select("*")
          .eq("phone_slot", phone)
          .gte("captured_at", sinceISO);
        if (untilISO) q = q.lte("captured_at", untilISO);
        const { data: rows, error } = await q.order("captured_at", {
          ascending: false,
        });
        if (error) throw error;
        const latestByPost = new Map<string, any>();
        for (const r of rows ?? []) {
          const cur = latestByPost.get(r.publer_post_id);
          if (!cur || new Date(r.captured_at) > new Date(cur.captured_at)) {
            latestByPost.set(r.publer_post_id, r);
          }
        }
        posts = Array.from(latestByPost.values()).map((r: any) => {
          const posted = r?.raw?.scheduled_at || r.captured_at;
          return {
            post_id: r.publer_post_id,
            post_link: r?.raw?.post_link ?? r.publer_post_id ?? null,
            scheduled_at: posted,
            posted_at: posted,
            video_views: Number(r.video_views ?? 0),
            reach: Number(r.reach ?? 0),
            likes: Number(r.likes ?? 0),
            comments: Number(r.comments ?? 0),
            shares: Number(r.shares ?? 0),
            saves: Number(r.saves ?? 0),
            engagement: Number(r.engagement ?? 0),
            engagement_rate: Number(r.engagement_rate ?? 0),
            thumbnail_url: r?.raw?.thumbnail ?? null,
            caption: r?.raw?.caption ?? null,
          };
        });
      }

      // Best time-of-day heatmap. IG: avg engagement_rate. TikTok: avg views
      // (TT doesn't expose reach so engagement_rate is 0, use views instead).
      const heatmap: Record<string, number> = {};
      const heatmapAgg: Record<string, { total: number; count: number }> = {};
      for (const p of posts) {
        if (!p.scheduled_at) continue;
        const d = new Date(p.scheduled_at);
        const key = `${d.getDay()}-${d.getHours()}`;
        const val = isTikTok ? p.video_views : p.engagement_rate;
        const cur = heatmapAgg[key] ?? { total: 0, count: 0 };
        cur.total += val;
        cur.count += 1;
        heatmapAgg[key] = cur;
      }
      for (const [k, v] of Object.entries(heatmapAgg)) {
        heatmap[k] = v.count > 0 ? v.total / v.count : 0;
      }

      // Top 5 by views.
      const topPerformers = [...posts]
        .filter((p) => p.video_views > 0)
        .sort((a, b) => b.video_views - a.video_views)
        .slice(0, 5);

      // Underperformers: lowest views among posts >= 6h old with any views (so
      // brand-new posts don't dominate the list).
      const now = Date.now();
      const matureUnderperformers = posts
        .filter((p) => {
          if (!p.posted_at) return false;
          return now - new Date(p.posted_at).getTime() > 6 * 3600_000;
        })
        .sort((a, b) => a.video_views - b.video_views)
        .slice(0, 5);

      const sum = (k: keyof NormPost) =>
        posts.reduce((a, p) => a + Number(p[k] ?? 0), 0);
      const medianViews = median(posts.map((p) => p.video_views));

      // Daily rollup for the trend chart (frontend also has its own rollup that
      // reads posts_time_series; keep both so either code path renders).
      const perDay: Record<string, { date: string; views: number; reach: number; posts: number }> = {};
      for (const p of posts) {
        const dk = (p.scheduled_at || "").slice(0, 10);
        if (!dk) continue;
        perDay[dk] ||= { date: dk, views: 0, reach: 0, posts: 0 };
        perDay[dk].views += p.video_views;
        perDay[dk].reach += p.reach;
        perDay[dk].posts += 1;
      }
      const dailySeries = Object.values(perDay).sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      const mapPerformer = (p: NormPost) => ({
        post_link: p.post_link,
        video_views: p.video_views,
        views: p.video_views,
        reach: p.reach,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        saves: p.saves,
        engagement: p.engagement,
        engagement_rate: p.engagement_rate,
        thumbnail: p.thumbnail_url,
        thumbnail_url: p.thumbnail_url,
        posted_at: p.posted_at,
        scheduled_at: p.scheduled_at,
        caption: p.caption,
      });

      res.json({
        phone_slot: phone,
        provider: slot.provider,
        handle: slot.handle,
        data_source: dataSource,
        window: windowLabel,
        window_days: isLifetime ? 0 : days,
        min_date: MIN_DATE,
        posts_count: posts.length,
        totals: {
          views: sum("video_views"),
          reach: sum("reach"),
          likes: sum("likes"),
          comments: sum("comments"),
          shares: sum("shares"),
          saves: sum("saves"),
          engagement: sum("engagement"),
          median_views_per_post: medianViews,
        },
        heatmap,
        daily_series: dailySeries,
        top_performers: topPerformers.map(mapPerformer),
        underperformers: matureUnderperformers.map(mapPerformer),
        posts_time_series: posts.map((p) => ({
          id: p.post_id,
          scheduled_at: p.scheduled_at,
          video_views: p.video_views,
          reach: p.reach,
          engagement_rate: p.engagement_rate,
          post_link: p.post_link,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== ARCHIVE (enriched) ====================

  app.get("/api/v2/archive", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) return res.json({ items: [], total: 0 });
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const offset = Number(req.query.offset ?? 0);
      const phoneFilter = req.query.phone ? String(req.query.phone) : null;
      if (phoneFilter && !admin && !visibleIds.includes(phoneFilter)) {
        return res.status(403).json({ error: "forbidden" });
      }

      let q = sb
        .from("reels_manual_queue")
        .select("*")
        .in("status", ["posted", "archived"])
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
      if (phoneFilter) q = q.eq("phone_slot", phoneFilter);
      else if (!admin) q = q.in("phone_slot", visibleIds);
      const { data: archiveRows, error: err1 } = await q;
      if (err1) throw err1;
      const rows = archiveRows ?? [];

      const phoneSlots = Array.from(new Set(rows.map((r: any) => r.phone_slot).filter(Boolean)));
      const analyticsByPostLink = new Map<string, any>();
      const analyticsByFilename = new Map<string, any>();
      if (phoneSlots.length > 0) {
        const { data: analytics } = await sbFn()
          .from("publer_analytics")
          .select("publer_post_id, phone_slot, video_views, reach, likes, comments, engagement_rate, captured_at, raw")
          .in("phone_slot", phoneSlots as string[])
          .order("captured_at", { ascending: false })
          .limit(2000);
        for (const a of analytics ?? []) {
          const raw = (a as any).raw || {};
          const link = raw.post_link || raw.postLink || null;
          if (link && !analyticsByPostLink.has(link)) analyticsByPostLink.set(link, a);
          const media = raw.medias?.[0];
          const path = media?.path || media?.thumbnail || "";
          if (path) {
            const parts = String(path).split("/");
            const fname = parts[parts.length - 1] || "";
            if (fname && !analyticsByFilename.has(fname)) analyticsByFilename.set(fname, a);
          }
        }
      }

      const enriched = rows.map((r: any) => {
        const link = r.posted_ig_url || null;
        let a: any = link ? analyticsByPostLink.get(link) : null;
        if (!a && r.filename) a = analyticsByFilename.get(r.filename);
        return {
          ...r,
          post_link: r.posted_ig_url ?? null,
          caption: r.notes ?? null,
          views: a ? Number(a.video_views ?? 0) : null,
          reach: a ? Number(a.reach ?? 0) : null,
          likes: a ? Number(a.likes ?? 0) : null,
          engagement_rate: a ? Number(a.engagement_rate ?? 0) : null,
          thumbnail_url: a?.raw?.medias?.[0]?.thumbnail ?? null,
        };
      });

      res.json({ items: enriched, total: enriched.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== TODAY ====================
  // Every post published today (or in a custom date range) with all snapshots

  app.get("/api/v2/today", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) {
        return res.json({ from: "", to: "", min_date: "2026-09-05", slots: [], total_posts: 0 });
      }
      // ?date=YYYY-MM-DD (default: today PT). ?from=YYYY-MM-DD&to=YYYY-MM-DD for range.
      // Minimum start date is 2026-09-05.
      const MIN_DATE = "2026-09-05";
      const now = new Date();
      const ptToday = new Date(now.getTime() - 7 * 3600_000).toISOString().slice(0, 10);
      let from = String(req.query.from ?? req.query.date ?? ptToday);
      let to = String(req.query.to ?? req.query.date ?? ptToday);
      if (from < MIN_DATE) from = MIN_DATE;
      if (to < from) to = from;

      const fromISO = `${from}T00:00:00-07:00`;
      const toISO = `${to}T23:59:59-07:00`;

      // Get all publish log entries in range that succeeded
      let logsQ = sb
        .from("publer_publish_log")
        .select("id, phone_slot, planned_at, attempted_at, publer_post_id, publer_post_link, status, caption_used, hashtags_used")
        .gte("attempted_at", fromISO)
        .lte("attempted_at", toISO)
        .order("attempted_at", { ascending: false });
      if (!admin) logsQ = logsQ.in("phone_slot", visibleIds);
      const { data: logs, error: logsErr } = await logsQ;
      if (logsErr) throw logsErr;

      // Bulk-fetch analytics for these posts
      const postIds = (logs ?? []).map((l: any) => l.publer_post_link).filter(Boolean);
      let latestByPost: Record<string, any> = {};
      let historyByPost: Record<string, any[]> = {};
      if (postIds.length) {
        const { data: snaps } = await sbFn()
          .from("publer_analytics")
          .select("publer_post_id, captured_at, reach, engagement, engagement_rate, likes, comments, shares, saves, video_views, link_clicks, post_clicks, click_through_rate, reach_rate, raw")
          .in("publer_post_id", postIds)
          .order("captured_at", { ascending: true });
        for (const s of snaps ?? []) {
          historyByPost[s.publer_post_id] = historyByPost[s.publer_post_id] || [];
          historyByPost[s.publer_post_id].push(s);
          latestByPost[s.publer_post_id] = s; // last wins due to asc order
        }
      }

      // Group by phone_slot
      const bySlot: Record<string, any> = {};
      for (const l of logs ?? []) {
        const key = l.phone_slot;
        if (!bySlot[key]) bySlot[key] = { phone_slot: key, posts: [] };
        const link = l.publer_post_link;
        const latest = link ? latestByPost[link] : null;
        const history = link ? historyByPost[link] || [] : [];
        const raw = latest?.raw ?? {};
        const captionSource = raw.text ?? l.caption_used ?? null;
        bySlot[key].posts.push({
          id: l.id,
          publer_post_id: l.publer_post_id,
          post_link: l.publer_post_link,
          status: l.status,
          planned_at: l.planned_at,
          attempted_at: l.attempted_at,
          caption: captionSource,
          hashtags: l.hashtags_used ?? extractHashtags(captionSource || ""),
          source_handle: raw?.notes ? extractHandle(raw.notes) : null,
          thumbnail: raw?.media?.[0]?.thumbnails?.[0]?.real ?? raw?.medias?.[0]?.thumbnail ?? null,
          metrics: latest ? {
            video_views: latest.video_views,
            reach: latest.reach,
            likes: latest.likes,
            comments: latest.comments,
            shares: latest.shares,
            saves: latest.saves,
            engagement: latest.engagement,
            engagement_rate: Number(latest.engagement_rate ?? 0),
            link_clicks: latest.link_clicks,
            post_clicks: latest.post_clicks,
            click_through_rate: Number(latest.click_through_rate ?? 0),
            reach_rate: Number(latest.reach_rate ?? 0),
            captured_at: latest.captured_at,
          } : null,
          sparkline: history.map((s: any) => ({
            t: s.captured_at,
            views: Number(s.video_views ?? 0),
            reach: Number(s.reach ?? 0),
            likes: Number(s.likes ?? 0),
          })),
        });
      }

      res.json({
        from,
        to,
        min_date: MIN_DATE,
        slots: Object.values(bySlot),
        total_posts: (logs ?? []).length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== POST DETAIL ====================

  app.get("/api/v2/post/:postLink(*)", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      // Route param is URL-encoded post link (URL) OR raw publer_post_id
      const paramValue = decodeURIComponent(req.params.postLink);

      // Look up the publish log row first — accept either the URL or the internal ID.
      // Try URL first (most common from /today), then fall back to internal id.
      let { data: log } = await sbFn()
        .from("publer_publish_log")
        .select("phone_slot, planned_at, attempted_at, caption_used, hashtags_used, status, publer_post_id, publer_post_link")
        .eq("publer_post_link", paramValue)
        .order("attempted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!log) {
        const r = await sbFn()
          .from("publer_publish_log")
          .select("phone_slot, planned_at, attempted_at, caption_used, hashtags_used, status, publer_post_id, publer_post_link")
          .eq("publer_post_id", paramValue)
          .order("attempted_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        log = r.data;
      }

      // Resolve the internal id used by publer_analytics
      const internalId = log?.publer_post_id ?? paramValue;

      const { data: snaps, error } = await sbFn()
        .from("publer_analytics")
        .select("*")
        .eq("publer_post_id", internalId)
        .order("captured_at", { ascending: true });
      if (error) throw error;

      // If we have neither snapshots nor a log record, this post is unknown
      if ((!snaps || !snaps.length) && !log) {
        return res.status(404).json({ error: "not found", tried_id: internalId, tried_link: paramValue });
      }

      const latest = snaps && snaps.length ? snaps[snaps.length - 1] : null;
      const raw = latest?.raw ?? {};

      // Slot-scope: block cross-user post lookup by publer_post_link/id.
      const owningSlot = log?.phone_slot ?? latest?.phone_slot ?? null;
      if (!admin && owningSlot && !visibleIds.includes(owningSlot)) {
        return res.status(403).json({ error: "forbidden" });
      }

      const captionText = raw.text ?? log?.caption_used ?? "";
      const postLink = log?.publer_post_link ?? paramValue;
      res.json({
        post_link: postLink,
        publer_post_id: internalId,
        phone_slot: owningSlot,
        planned_at: log?.planned_at ?? null,
        attempted_at: log?.attempted_at ?? null,
        status: log?.status ?? "unknown",
        caption: captionText,
        hashtags: log?.hashtags_used ?? extractHashtags(captionText),
        source_handle: raw?.notes ? extractHandle(raw.notes) : null,
        thumbnail: raw?.media?.[0]?.thumbnails?.[0]?.real ?? raw?.medias?.[0]?.thumbnail ?? null,
        media_url: raw?.media?.[0]?.path ?? raw?.medias?.[0]?.path ?? null,
        latest_metrics: latest ? {
          video_views: latest.video_views,
          reach: latest.reach,
          likes: latest.likes,
          comments: latest.comments,
          shares: latest.shares,
          saves: latest.saves,
          engagement: latest.engagement,
          engagement_rate: Number(latest.engagement_rate ?? 0),
          link_clicks: latest.link_clicks,
          post_clicks: latest.post_clicks,
          click_through_rate: Number(latest.click_through_rate ?? 0),
          reach_rate: Number(latest.reach_rate ?? 0),
        } : null,
        timeline: (snaps ?? []).map((s: any) => ({
          t: s.captured_at,
          video_views: s.video_views,
          reach: s.reach,
          likes: s.likes,
          comments: s.comments,
          shares: s.shares,
          saves: s.saves,
          engagement: s.engagement,
          engagement_rate: Number(s.engagement_rate ?? 0),
        })),
        snapshot_count: snaps?.length ?? 0,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== HASHTAG ANALYTICS ====================

  app.get("/api/v2/hashtags", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) return res.json({ from: "", total_hashtags: 0, items: [] });
      const phoneFilter = req.query.phone ? String(req.query.phone) : null;
      if (phoneFilter && !admin && !visibleIds.includes(phoneFilter)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const MIN_DATE = "2026-09-05";
      const from = String(req.query.from ?? MIN_DATE);
      const fromISO = `${from < MIN_DATE ? MIN_DATE : from}T00:00:00-07:00`;

      // Get latest snapshot per post so we don't double-count
      let q = sb
        .from("publer_analytics")
        .select("publer_post_id, phone_slot, video_views, reach, likes, engagement_rate, captured_at, raw")
        .gte("captured_at", fromISO);
      if (phoneFilter) q = q.eq("phone_slot", phoneFilter);
      else if (!admin) q = q.in("phone_slot", visibleIds);
      const { data: snaps, error } = await q;
      if (error) throw error;

      // Reduce to latest per publer_post_id
      const latestByPost: Record<string, any> = {};
      for (const s of snaps ?? []) {
        const prev = latestByPost[s.publer_post_id];
        if (!prev || new Date(s.captured_at) > new Date(prev.captured_at)) {
          latestByPost[s.publer_post_id] = s;
        }
      }

      // Extract hashtags per post and aggregate
      const tagStats: Record<string, { count: number; total_views: number; total_reach: number; total_likes: number; er_sum: number; er_n: number; posts: string[] }> = {};
      for (const s of Object.values(latestByPost)) {
        const text = s.raw?.text ?? "";
        const tags = extractHashtags(text);
        for (const tag of tags) {
          if (!tagStats[tag]) tagStats[tag] = { count: 0, total_views: 0, total_reach: 0, total_likes: 0, er_sum: 0, er_n: 0, posts: [] };
          tagStats[tag].count++;
          tagStats[tag].total_views += Number(s.video_views ?? 0);
          tagStats[tag].total_reach += Number(s.reach ?? 0);
          tagStats[tag].total_likes += Number(s.likes ?? 0);
          const er = Number(s.engagement_rate ?? 0);
          if (er > 0) { tagStats[tag].er_sum += er; tagStats[tag].er_n++; }
          if (tagStats[tag].posts.length < 5) tagStats[tag].posts.push(s.publer_post_id);
        }
      }

      const items = Object.entries(tagStats).map(([tag, s]) => ({
        hashtag: tag,
        posts_count: s.count,
        avg_views: s.count ? Math.round(s.total_views / s.count) : 0,
        avg_reach: s.count ? Math.round(s.total_reach / s.count) : 0,
        avg_likes: s.count ? Math.round(s.total_likes / s.count) : 0,
        avg_engagement_rate: s.er_n ? Number((s.er_sum / s.er_n).toFixed(2)) : 0,
        total_views: s.total_views,
        sample_posts: s.posts,
      }));
      items.sort((a, b) => b.avg_views - a.avg_views);

      res.json({ from, total_hashtags: items.length, items });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== CAPTION TEMPLATES ====================

  app.get("/api/v2/templates", async (req: Request, res: Response) => {
    try {
      const sb = sbFn();
      const { visible } = await visibleSlots(req, sb);
      const visibleIds = visible.map((s) => s.phone_slot);
      const admin = isAdmin(req);
      if (visibleIds.length === 0 && !admin) return res.json({ templates: [] });
      let q = sb.from("device_content_templates").select("*").order("phone_slot");
      if (!admin) q = q.in("phone_slot", visibleIds);
      const { data, error } = await q;
      if (error) throw error;
      res.json({ templates: data ?? [] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/v2/templates/:phone", async (req: Request, res: Response) => {
    try {
      // Requires APP_WRITE_SECRET (uses same x-app-secret header as other mutations)
      const secret = process.env.APP_WRITE_SECRET || "";
      if (secret && req.header("x-app-secret") !== secret) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const phone = req.params.phone;
      const body = req.body ?? {};
      const patch: any = { updated_at: new Date().toISOString() };
      if (Array.isArray(body.caption_hooks)) patch.caption_hooks = body.caption_hooks;
      if (Array.isArray(body.hashtag_pool)) patch.hashtag_pool = body.hashtag_pool.map((t: string) => t.replace(/^#/, ""));
      if (typeof body.hashtag_count_per_post === "number") patch.hashtag_count_per_post = body.hashtag_count_per_post;
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

      const { data, error } = await sbFn()
        .from("device_content_templates")
        .upsert({ phone_slot: phone, ...patch }, { onConflict: "phone_slot" })
        .select()
        .single();
      if (error) throw error;
      res.json({ template: data });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== HARVEST FROM PUBLER HISTORY ====================
  // Mine existing captions/hashtags from a Publer account and seed template

  app.post("/api/v2/harvest/:phone", async (req: Request, res: Response) => {
    try {
      const secret = process.env.APP_WRITE_SECRET || "";
      if (secret && req.header("x-app-secret") !== secret) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const phone = req.params.phone;
      const { harvestCaptions } = await import("./publer-schedule.js");
      const result = await harvestCaptions(sbFn(), phone);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


}

// ==================== HELPERS ====================

function extractHashtags(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/#[a-z0-9_]+/gi) || [];
  return [...new Set(matches.map((t) => t.slice(1).toLowerCase()))];
}

function extractHandle(notes: string): string | null {
  if (!notes) return null;
  const m = notes.match(/@?([a-z0-9_.]+)/i);
  return m ? m[1] : null;
}

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
