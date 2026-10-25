// Public, unauthenticated endpoints for the clone8.io site.
//   GET  /api/public/case-study      aggregate numbers for the Tradvio case study (cached, no account names)
//   POST /api/public/invite-requests "request an invite" form (stored in invite_requests; no email is sent)
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWindowSnapshots, interactions, type SnapshotRow } from "./analytics-util.js";
import { loadSlots } from "./publer-schedule.js";
import { paged } from "./reporting.js";

type SbGetter = () => SupabaseClient;
export const PIPELINE_START = "2026-09-05"; // Publer coverage start; the case study counts from here
const PIPELINE_START_ISO = "2026-09-05T07:00:00.000Z";
const DAY = 86400_000;

export type CaseStudyRaw = {
  slots: { provider: string; daily_target: number; paused: boolean }[];
  published_all: number; published_30d: number; published_7d: number; first_publish: string | null;
  daily_30d: Record<string, number>;          // slot_local_date -> published count
  latest_all: SnapshotRow[];                   // newest capture per post since the pipeline started
};
export type CaseStudy = ReturnType<typeof summarizeCaseStudy>;

const publicLink = (v: any) => (typeof v === "string" && /^https:\/\/(www\.)?(instagram\.com|tiktok\.com)\/[^\s"']+$/.test(v) ? v : null);
const platformOf = (link: string | null, slot: string | undefined) => (link?.includes("tiktok.com") || slot?.startsWith("tiktok") ? "tiktok" : "instagram");
const num = (v: any) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

/** Pure: aggregate numbers only. Account handles never appear; only public post links for the top videos. */
export function summarizeCaseStudy(raw: CaseStudyRaw, now = new Date()) {
  const views = raw.latest_all.map((r) => num(r.video_views)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const median = views.length ? (views.length % 2 ? views[(views.length - 1) / 2] : (views[views.length / 2 - 1] + views[views.length / 2]) / 2) : null;
  const top = raw.latest_all
    .map((r) => ({ link: publicLink(r.raw?.post_link) ?? publicLink(r.publer_post_id), views: num(r.video_views) ?? 0, platform: platformOf(publicLink(r.raw?.post_link) ?? publicLink(r.publer_post_id), r.phone_slot) }))
    .filter((p) => p.link && p.views > 0).sort((a, b) => b.views - a.views).slice(0, 3);
  const days: { date: string; published: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    days.push({ date: d, published: raw.daily_30d[d] ?? 0 });
  }
  const firstDay = raw.first_publish ? raw.first_publish.slice(0, 10) : PIPELINE_START;
  const daysRunning = Math.max(1, Math.floor((now.getTime() - Date.parse(`${firstDay}T00:00:00Z`)) / DAY));
  return {
    updated_at: now.toISOString(),
    since: firstDay,
    days_running: daysRunning,
    accounts: { total: raw.slots.length, instagram: raw.slots.filter((s) => s.provider === "instagram").length, tiktok: raw.slots.filter((s) => s.provider === "tiktok").length, publishing: raw.slots.filter((s) => !s.paused).length, videos_per_day: raw.slots.filter((s) => !s.paused).reduce((n, s) => n + (Number(s.daily_target) || 0), 0) },
    videos: { all_time: raw.published_all, last_30_days: raw.published_30d, last_7_days: raw.published_7d, measured: views.length, over_1k_views: views.filter((v) => v >= 1000).length, over_10k_views: views.filter((v) => v >= 10000).length },
    views: { all_time: sum(views), median_per_video: median, best_video: views.length ? views[views.length - 1] : null },
    interactions: { all_time: sum(raw.latest_all.map(interactions)) },
    daily_published: days,
    top_videos: top,
    notes: ["Views and interactions are the latest reading per video from Publer's insights; unknown values are not counted as zero.", "Published counts come from the publishing log, Pacific time days.", "Numbers refresh about every 15 minutes."],
  };
}

export async function collectCaseStudy(sb: SupabaseClient, now = new Date()): Promise<CaseStudyRaw> {
  const slots = await loadSlots(sb);
  const ids = slots.map((s) => s.phone_slot);
  const iso = (ms: number) => new Date(ms).toISOString();
  const count = async (sinceISO?: string) => {
    let q = sb.from("publer_publish_log").select("id", { count: "exact", head: true }).eq("status", "published");
    if (sinceISO) q = q.gte("attempted_at", sinceISO);
    const r = await q; if (r.error) throw r.error; return r.count ?? 0;
  };
  const [published_all, published_30d, published_7d, first, logs, latest_all] = await Promise.all([
    count(), count(iso(now.getTime() - 30 * DAY)), count(iso(now.getTime() - 7 * DAY)),
    sb.from("publer_publish_log").select("attempted_at").eq("status", "published").order("attempted_at").limit(1),
    paged((a, b) => sb.from("publer_publish_log").select("slot_local_date").eq("status", "published").gte("slot_local_date", iso(now.getTime() - 30 * DAY).slice(0, 10)).order("id").range(a, b)),
    fetchWindowSnapshots((args) => sb.rpc("dashboard_report_snapshots", args), ids, PIPELINE_START_ISO, now.toISOString()),
  ]);
  if (first.error) throw first.error;
  const daily_30d: Record<string, number> = {};
  for (const l of logs) daily_30d[l.slot_local_date] = (daily_30d[l.slot_local_date] ?? 0) + 1;
  return { slots: slots.map((s) => ({ provider: s.provider, daily_target: s.daily_target, paused: s.paused })), published_all, published_30d, published_7d, first_publish: first.data?.[0]?.attempted_at ?? null, daily_30d, latest_all };
}

// ---- invite requests -------------------------------------------------------------------------
export type InviteRequestInput = { name: string; email: string; company?: string | null; message?: string | null; website?: string };
export function validateInviteRequest(body: any): { ok: true; row: { name: string; email: string; company: string | null; message: string | null } } | { ok: false; error: string; honeypot?: boolean } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  if (typeof body.website === "string" && body.website.trim()) return { ok: false, error: "ok", honeypot: true }; // bots fill the hidden field
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const company = typeof body.company === "string" && body.company.trim() ? body.company.trim().slice(0, 120) : null;
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 2000) : null;
  if (name.length < 1 || name.length > 120) return { ok: false, error: "invalid_name" };
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "invalid_email" };
  return { ok: true, row: { name, email, company, message } };
}

/** Tiny fixed-window limiter per client address: enough to stop a script, invisible to people. */
export function makeLimiter(limit = 10, windowMs = 3600_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now = Date.now()) => {
    const cur = hits.get(key);
    if (!cur || cur.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    cur.n += 1; return cur.n <= limit;
  };
}

export function registerPublicRoutes(app: Express, sbFn: SbGetter, opts: { ttlMs?: number; now?: () => Date } = {}): void {
  const ttl = opts.ttlMs ?? 15 * 60_000;
  const nowFn = opts.now ?? (() => new Date());
  let cache: { at: number; data: CaseStudy } | null = null;
  let inflight: Promise<CaseStudy> | null = null;
  const publicHeaders = (res: Response) => {
    if (!res.getHeader("Access-Control-Allow-Origin")) res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
  };

  app.get("/api/public/case-study", async (_req: Request, res: Response) => {
    publicHeaders(res);
    const now = nowFn();
    if (cache && now.getTime() - cache.at < ttl) return res.json(cache.data);
    try {
      inflight ??= collectCaseStudy(sbFn(), now).then((raw) => summarizeCaseStudy(raw, now)).finally(() => { inflight = null; });
      const data = await inflight;
      cache = { at: now.getTime(), data };
      res.json(data);
    } catch (e: any) {
      if (cache) return res.json({ ...cache.data, stale: true }); // serve the last good numbers
      console.warn("[public] case study unavailable:", e?.message ?? e);
      res.status(503).json({ error: "case_study_unavailable" });
    }
  });

  const allow = makeLimiter();
  app.post("/api/public/invite-requests", async (req: Request, res: Response) => {
    publicHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    const key = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
    if (!allow(key)) return res.status(429).json({ error: "too_many_requests" });
    const v = validateInviteRequest(req.body);
    if (v.ok === false) {
      if (v.honeypot) return res.status(202).json({ received: true }); // looks accepted to the bot, nothing stored
      return res.status(400).json({ error: v.error });
    }
    try {
      const r = await sbFn().from("invite_requests").insert({ ...v.row, source: "clone8.io" }).select("id,created_at").single();
      if (r.error) throw r.error;
      res.status(201).json({ received: true, id: r.data.id });
    } catch (e: any) {
      console.warn("[public] invite request not stored:", e?.message ?? e);
      res.status(503).json({ error: "request_not_stored" });
    }
  });
}
