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
      // days=0 means lifetime (no time filter); otherwise clamp 1..3650.
      const rawDays = parseInt(String(req.query.days ?? "30"), 10);
      const days = rawDays === 0 ? 0 : Math.max(1, Math.min(3650, rawDays));

      const slots = await loadSlots(sb());
      const slot = slots.find((s) => s.phone_slot === phone);
      if (!slot) return res.status(404).json({ error: "slot not found" });

      const isTikTok = slot.provider === "tiktok";
      // days=0 means lifetime (no time filter).
      const isLifetime = days === 0;

      // Hard lower bound: 2026-09-05 (pipeline / Publer coverage start).
      // Pre-pipeline data is intentionally hidden across IG and TikTok.
      const MIN_DATE_ISO = "2026-09-05T00:00:00-07:00";
      const rolling = new Date(Date.now() - (days || 3650) * 86400_000).toISOString();
      const since = rolling < MIN_DATE_ISO ? MIN_DATE_ISO : rolling;

      // Data source: publer_analytics for BOTH IG and TikTok.
      // TikTok's video_views is populated in the ingest layer by mirroring
      // Publer's analytics.reach (see publer-schedule.ts). This also naturally
      // clips pre-pipeline data since publer_analytics starts 2026-09-05.
      let posts: any[] = [];
      const dataSource = "publer_analytics";

      {
        const { data: snapsRaw } = await sb()
          .from("publer_analytics")
          .select("*")
          .eq("phone_slot", phone)
          .gte("captured_at", since)
          .order("captured_at", { ascending: false });
        const snaps = snapsRaw ?? [];
        const latestByPost = new Map<string, any>();
        for (const s of snaps) {
          if (!latestByPost.has(s.publer_post_id)) latestByPost.set(s.publer_post_id, s);
        }
        posts = Array.from(latestByPost.values()).map((a: any) => ({
          post_id: a.publer_post_id,
          post_link: a.publer_post_id, // Publer stores the post URL here
          posted_at: a?.raw?.scheduled_at || a.captured_at,
          date_key: (a?.raw?.scheduled_at || a.captured_at || "").slice(0, 10),
          views: a.video_views || 0,
          likes: a.likes || 0,
          comments: a.comments || 0,
          shares: a.shares || 0,
          saves: a.saves || 0,
          reach: a.reach || 0,
        }));
      }

      const engagementOf = (p: any) =>
        (p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.saves || 0);

      // Per-day rollup by post date.
      const perDay: Record<string, { date: string; views: number; likes: number; comments: number; shares: number; saves: number; reach: number; engagement: number; posts: number }> = {};
      for (const p of posts) {
        const d = p.date_key;
        if (!d) continue;
        perDay[d] ||= { date: d, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: 0 };
        perDay[d].views += p.views;
        perDay[d].likes += p.likes;
        perDay[d].comments += p.comments;
        perDay[d].shares += p.shares;
        perDay[d].saves += p.saves;
        perDay[d].reach += p.reach;
        perDay[d].engagement += engagementOf(p);
        perDay[d].posts += 1;
      }

      const top = posts
        .map((p: any) => ({
          publer_post_id: p.post_id,
          publer_post_link: p.post_link,
          slot_local_date: p.date_key,
          attempted_at: p.posted_at,
          video_views: p.views,
          likes: p.likes,
          comments: p.comments,
          shares: p.shares,
          saves: p.saves,
          reach: p.reach,
          engagement: engagementOf(p),
        }))
        .sort((a: any, b: any) => (b.engagement || 0) - (a.engagement || 0))
        .slice(0, 10);

      const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: posts.length };
      for (const p of posts) {
        totals.views += p.views;
        totals.likes += p.likes;
        totals.comments += p.comments;
        totals.shares += p.shares;
        totals.saves += p.saves;
        totals.reach += p.reach;
        totals.engagement += engagementOf(p);
      }

      res.json({
        phone_slot: phone,
        handle: slot.handle,
        provider: slot.provider,
        days,
        data_source: dataSource,
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
