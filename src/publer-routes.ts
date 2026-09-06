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

      // Pull all logged publer posts + latest analytics snapshot
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const { data: postsRaw } = await sb()
        .from("publer_publish_log")
        .select("publer_post_id,publer_post_link,attempted_at,slot_local_date")
        .eq("phone_slot", phone)
        .eq("status", "published")
        .gte("attempted_at", since)
        .order("attempted_at", { ascending: false });

      const posts = postsRaw ?? [];
      // Join analytics by post_link (stable across /posts + /post_insights).
      // Fall back to publer_post_id when link isn't set yet (e.g. TikTok).
      const keys = Array.from(new Set(
        posts
          .flatMap((p: any) => [p.publer_post_link, p.publer_post_id])
          .filter(Boolean),
      ));

      let snaps: any[] = [];
      if (keys.length) {
        const { data } = await sb()
          .from("publer_analytics")
          .select("*")
          .in("publer_post_id", keys)
          .order("captured_at", { ascending: false });
        snaps = data ?? [];
      }

      // Latest snapshot indexed by any join key
      const latestByKey = new Map<string, any>();
      for (const s of snaps) {
        if (!latestByKey.has(s.publer_post_id)) latestByKey.set(s.publer_post_id, s);
      }
      const latestFor = (p: any) =>
        latestByKey.get(p.publer_post_link) || latestByKey.get(p.publer_post_id) || {};

      // Per-day rollup (LA date) for charts
      const perDay: Record<string, { date: string; views: number; likes: number; comments: number; shares: number; saves: number; reach: number; engagement: number; posts: number }> = {};
      for (const p of posts) {
        const d = p.slot_local_date;
        perDay[d] ||= { date: d, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: 0 };
        const a = latestFor(p);
        perDay[d].views += a.video_views || 0;
        perDay[d].likes += a.likes || 0;
        perDay[d].comments += a.comments || 0;
        perDay[d].shares += a.shares || 0;
        perDay[d].saves += a.saves || 0;
        perDay[d].reach += a.reach || 0;
        perDay[d].engagement += a.engagement || 0;
        perDay[d].posts += 1;
      }

      // Top posts by engagement
      const top = posts
        .map((p: any) => ({ ...p, ...latestFor(p) }))
        .sort((a: any, b: any) => (b.engagement || 0) - (a.engagement || 0))
        .slice(0, 10);

      // Totals
      let totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, engagement: 0, posts: posts.length };
      for (const p of posts) {
        const a = latestFor(p);
        totals.views += a.video_views || 0;
        totals.likes += a.likes || 0;
        totals.comments += a.comments || 0;
        totals.shares += a.shares || 0;
        totals.saves += a.saves || 0;
        totals.reach += a.reach || 0;
        totals.engagement += a.engagement || 0;
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
