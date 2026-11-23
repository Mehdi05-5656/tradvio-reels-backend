// The posting plan: how many posts a day, where the audience is, which days, and the times that come out of it (in
// the audience's main time zone). The composer turns it into "Best times": each video takes the next open slot on its
// accounts. The times are proposed on the page (from the audience's waking hours and, when there are enough posts, the
// person's own best window from Performance) and saved here as the person leaves them.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPerformance } from "./studio-insights.js";

export type PostingPlan = { per_day: number; countries: string[]; timezone: string; times: string[]; days: number[]; updated_at?: string };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validZone = (z: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } };

/** A plan as stored: bounded, or null when it says nothing usable. */
export function cleanPlan(raw: any): PostingPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const timezone = typeof raw.timezone === "string" && raw.timezone.length <= 64 && validZone(raw.timezone) ? raw.timezone : null;
  const times = Array.isArray(raw.times) ? [...new Set(raw.times.map(String).filter((t: string) => TIME_RE.test(t)))].sort().slice(0, 12) as string[] : [];
  if (!timezone || !times.length) return null;
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : [0, 1, 2, 3, 4, 5, 6];
  const countries = Array.isArray(raw.countries) ? [...new Set(raw.countries.map((c: any) => String(c).toUpperCase()).filter((c: string) => /^[A-Z]{2}$/.test(c)))].slice(0, 6) as string[] : [];
  const per_day = Math.min(Math.max(Math.round(Number(raw.per_day) || times.length), 1), 12);
  return { per_day, countries, timezone, times, days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
}

export function registerPostingPlan(app: Express, sbFn: () => SupabaseClient): void {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    const msg = String(e?.message ?? e);
    if (/posting_plan|does not exist/i.test(msg)) return res.status(503).json({ error: "plan_unavailable", detail: "Posting plans are not switched on yet" });
    console.error("[plan]", msg);
    res.status(500).json({ error: "plan_failed", detail: "Something went wrong on our side; try again in a moment" });
  };

  app.get("/api/studio/social/plan", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_social_profiles").select("posting_plan").eq("user_id", u).maybeSingle();
      if (r.error) throw r.error;
      res.json({ plan: cleanPlan(r.data?.posting_plan) ? { ...cleanPlan(r.data?.posting_plan)!, updated_at: r.data?.posting_plan?.updated_at ?? null } : null });
    } catch (e) { fail(res, e); }
  });

  app.put("/api/studio/social/plan", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const plan = cleanPlan(req.body?.plan);
      if (!plan) return res.status(400).json({ error: "bad_plan", detail: "A plan needs a time zone and at least one time" });
      const sb = sbFn();
      const row = { ...plan, updated_at: new Date().toISOString() };
      const w = await sb.from("studio_social_profiles").update({ posting_plan: row }).eq("user_id", u).select("user_id");
      if (w.error) throw w.error;
      if (!(w.data ?? []).length) return res.status(409).json({ error: "not_linked", detail: "Link an account first" });
      res.json({ plan: row });
    } catch (e) { fail(res, e); }
  });

  // What their own posts say about the hour and the weekday (each post against its account's usual views, YouTube left
  // out): read from what is stored, never a fresh read, so it costs nothing.
  app.get("/api/studio/social/best-times", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz ?? 0)) || 0));
      const L = await loadPerformance(sbFn(), u, 90, null, tz);
      const scored = L.analysis.posts.filter((p) => p.multiple != null && p.published_at && Date.parse(p.published_at) > Date.now() - 90 * 86400_000).length;
      res.json({ posts: scored, by_time: L.analysis.by_time, by_weekday: L.analysis.by_weekday });
    } catch (e: any) {
      if (/relation .* does not exist/i.test(String(e?.message))) return res.json({ posts: 0, by_time: [], by_weekday: [] });
      fail(res, e);
    }
  });
}
