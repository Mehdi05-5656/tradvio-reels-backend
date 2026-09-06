// Publer HTTP routes. Mounted from routes.ts.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadConfig,
  loadSlots,
  ptDateTimeToUtc,
  ptNow,
  publishOne,
  reconcileSlotAccounts,
} from "./publer-schedule.js";
import { listAccounts, postInsights } from "./publer.js";

const VALID_SLOTS = new Set(["phone_a", "phone_b", "tiktok_tradvio"]);

export function registerPublerRoutes(app: Express, sb: () => SupabaseClient) {
  // ---- Config ---------------------------------------------------------------

  app.get("/api/publer/config", async (_req: Request, res: Response) => {
    try {
      const cfg = await loadConfig(sb());
      const slots = await loadSlots(sb());
      res.json({ cfg, slots });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update per-slot daily_target (ramp slider) or paused
  app.post("/api/publer/slot/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) return res.status(400).json({ error: "invalid slot" });
      const body = req.body || {};
      const patch: any = { updated_at: new Date().toISOString() };
      if (typeof body.daily_target === "number") {
        patch.daily_target = Math.max(1, Math.min(8, Math.floor(body.daily_target)));
      }
      if (typeof body.paused === "boolean") patch.paused = body.paused;
      const { data, error } = await sb()
        .from("publer_slot_config")
        .update(patch)
        .eq("phone_slot", phone)
        .select("*")
        .single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Today's timeline (per slot) -----------------------------------------

  app.get("/api/publer/timeline/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) return res.status(400).json({ error: "invalid slot" });

      const cfg = await loadConfig(sb());
      const slots = await loadSlots(sb());
      const slot = slots.find((s) => s.phone_slot === phone);
      if (!slot) return res.status(404).json({ error: "slot not found" });

      const now = ptNow();
      const { data: logs } = await sb()
        .from("publer_publish_log")
        .select("slot_index,status,publer_post_id,publer_post_link,attempted_at,planned_at,error")
        .eq("phone_slot", phone)
        .eq("slot_local_date", now.ymd)
        .order("slot_index", { ascending: true });

      const timeline = cfg.slotTimes.slice(0, slot.daily_target).map((hhmm, i) => {
        const log = (logs ?? []).find((l: any) => l.slot_index === i);
        const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
        const plannedUtc = ptDateTimeToUtc(now.ymd, hhmm).toISOString();
        return {
          slot_index: i,
          local_time: hhmm,
          planned_utc: plannedUtc,
          due: h * 60 + m <= now.minutes,
          status: log?.status ?? "waiting",
          publer_post_id: log?.publer_post_id ?? null,
          publer_post_link: log?.publer_post_link ?? null,
          error: log?.error ?? null,
        };
      });

      res.json({
        phone_slot: phone,
        handle: slot.handle,
        provider: slot.provider,
        daily_target: slot.daily_target,
        paused: slot.paused,
        pt_now: now.hhmm,
        pt_date: now.ymd,
        timeline,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Manual publish-now (bypass schedule) ---------------------------------

  app.post("/api/publer/publish-now/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) return res.status(400).json({ error: "invalid slot" });

      const cfg = await loadConfig(sb());
      const slots = await loadSlots(sb());
      const slot = slots.find((s) => s.phone_slot === phone);
      if (!slot) return res.status(404).json({ error: "slot not found" });

      // Take the next unused slot index today >=1 so we don't collide with the
      // cron-owned slot times. If all today's target slots are used, borrow one
      // beyond target and log accordingly.
      const now = ptNow();
      const { data: logs } = await sb()
        .from("publer_publish_log")
        .select("slot_index")
        .eq("phone_slot", phone)
        .eq("slot_local_date", now.ymd)
        .in("status", ["pending", "published"]);
      const taken = new Set((logs ?? []).map((l: any) => l.slot_index as number));
      let slotIndex = 0;
      while (taken.has(slotIndex) && slotIndex < cfg.slotTimes.length) slotIndex++;
      if (slotIndex >= cfg.slotTimes.length) slotIndex = cfg.slotTimes.length; // synthetic

      const r = await publishOne(sb(), cfg, slot, slotIndex, now.ymd);
      if (r.status === "failed") return res.status(500).json({ error: r.error });
      if (r.status === "no_queue") return res.status(409).json({ error: "no pending videos in queue" });
      res.json({ ok: true, ...r, slotIndex });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Reconcile accounts (rerun after reconnecting anything in Publer) -----

  app.post("/api/publer/reconcile", async (_req: Request, res: Response) => {
    try {
      const r = await reconcileSlotAccounts(sb());
      const cfg = await loadConfig(sb());
      const accounts = await listAccounts(cfg.workspaceId);
      res.json({ ...r, accounts });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Analytics ------------------------------------------------------------
  // Aggregated per-slot performance for the last N days.

  app.get("/api/publer/analytics/:phone", async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      if (!VALID_SLOTS.has(phone)) return res.status(400).json({ error: "invalid slot" });
      const days = Math.max(1, Math.min(90, parseInt(String(req.query.days ?? "30"), 10)));

      const slots = await loadSlots(sb());
      const slot = slots.find((s) => s.phone_slot === phone);
      if (!slot) return res.status(404).json({ error: "slot not found" });

      // Source of truth: publer_analytics (populated by the analytics cron
      // from Publer's /post_insights endpoint). This includes EVERY post on
      // the account that Publer knows about, not just posts our pipeline
      // published. Rationale: the dashboard should reflect real account
      // performance, not just our pipeline's slice.
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const { data: snapsRaw } = await sb()
        .from("publer_analytics")
        .select("*")
        .eq("phone_slot", phone)
        .gte("captured_at", since)
        .order("captured_at", { ascending: false });
      const snaps = snapsRaw ?? [];

      // For each unique post (keyed by publer_post_id, which stores the
      // post_link URL), keep only the most recent snapshot.
      const latestByPost = new Map<string, any>();
      for (const s of snaps) {
        if (!latestByPost.has(s.publer_post_id)) latestByPost.set(s.publer_post_id, s);
      }
      const posts = Array.from(latestByPost.values());

      // Metric normalization:
      // - IG returns video_views; TikTok doesn't. For TikTok, use reach as
      //   the view proxy (TikTok's reach is view-based for videos).
      // - Publer doesn't return a scalar `engagement` field, only
      //   engagement_rate. Compute engagement = likes+comments+shares+saves.
      const isTikTok = slot.provider === "tiktok";
      const viewsOf = (a: any) => (isTikTok ? (a.reach || 0) : (a.video_views || 0));
      const engagementOf = (a: any) =>
        (a.likes || 0) + (a.comments || 0) + (a.shares || 0) + (a.saves || 0);

      // Per-day rollup by LA date. Extract from raw.scheduled_at
      // (format: '2026-09-06T06:03:57.000-07:00' — already LA offset).
      const perDay: Record<string, { date: string; views: number; likes: number; comments: number; shares: number; saves: number; reach: number; engagement: number; posts: number }> = {};
      for (const a of posts) {
        const sched: string | undefined = a?.raw?.scheduled_at;
        const d = sched ? sched.slice(0, 10) : (a.captured_at || "").slice(0, 10);
        if (!d) continue;
        perDay[d] ||= { date: d, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: 0 };
        perDay[d].views += viewsOf(a);
        perDay[d].likes += a.likes || 0;
        perDay[d].comments += a.comments || 0;
        perDay[d].shares += a.shares || 0;
        perDay[d].saves += a.saves || 0;
        perDay[d].reach += a.reach || 0;
        perDay[d].engagement += engagementOf(a);
        perDay[d].posts += 1;
      }

      // Top posts by computed engagement. Include convenience fields so
      // the UI can render "YYYY-MM-DD · N views" and open the post link.
      const top = posts
        .map((a: any) => {
          const sched: string | undefined = a?.raw?.scheduled_at;
          return {
            publer_post_id: a.publer_post_id,
            publer_post_link: a.publer_post_id,
            slot_local_date: sched ? sched.slice(0, 10) : (a.captured_at || "").slice(0, 10),
            attempted_at: sched || a.captured_at,
            video_views: viewsOf(a),
            likes: a.likes || 0,
            comments: a.comments || 0,
            shares: a.shares || 0,
            saves: a.saves || 0,
            reach: a.reach || 0,
            engagement: engagementOf(a),
          };
        })
        .sort((a: any, b: any) => (b.engagement || 0) - (a.engagement || 0))
        .slice(0, 10);

      // Totals across the whole window.
      const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: posts.length };
      for (const a of posts) {
        totals.views += viewsOf(a);
        totals.likes += a.likes || 0;
        totals.comments += a.comments || 0;
        totals.shares += a.shares || 0;
        totals.saves += a.saves || 0;
        totals.reach += a.reach || 0;
        totals.engagement += engagementOf(a);
      }

      res.json({
        phone_slot: phone,
        handle: slot.handle,
        provider: slot.provider,
        days,
        totals,
        per_day: Object.values(perDay).sort((a, b) => a.date.localeCompare(b.date)),
        top_posts: top,
        posts_count: posts.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
