// Public, unauthenticated endpoints for the clone8.io site.
//   GET  /api/public/case-study      aggregate numbers for the Tradvio case study (cached, no account names)
//   POST /api/public/invite-requests "request an invite" form (stored in invite_requests; no email is sent;
//                                     a stored request is reported to Meta as Lead, see src/meta-capi.ts)
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWindowSnapshots, interactions, type SnapshotRow } from "./analytics-util.js";
import { loadSlots } from "./publer-schedule.js";
import { paged } from "./reporting.js";
import { isAdmin, isOperator } from "./auth.js";
import { metaConfig, readBrowserMeta, outboxColumns, deliverLeadNow, type FetchLike, type MetaConfig } from "./meta-capi.js";

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
// Two forms write here: the homepage invite form (source "clone8.io") and the Meta-ads application page
// (source "clone8.io/apply"), which adds the qualification answers below. Values are closed lists so the
// inbox can label them; anything else is a 400, never silently coerced.
export const CONTENT_STATUSES = ["yes", "some", "not_yet"] as const;
export const LIBRARY_SIZES = ["none", "under_25", "25_100", "100_500", "500_plus"] as const;
export const OBJECTIVES = ["reach", "awareness", "distribution", "other"] as const;
export const TIMELINES = ["asap", "1_3_months", "exploring"] as const;
/** Sales stages, set from the console inbox: new → contacted → qualified → call_booked → call_attended → won; declined at any point;
 *  invited = a dashboard invitation was sent (the original flow, still used after a win). */
export const REQUEST_STATUSES = ["new", "contacted", "qualified", "call_booked", "call_attended", "won", "invited", "declined"] as const;
export const REQUEST_SOURCES = ["clone8.io", "clone8.io/apply", "studio"] as const;
export const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "landing_path", "referrer_host"] as const;
export const APPLY_COLUMNS = ["content_status", "library_size", "objective", "timeline", "phone", "attribution"] as const;
export type InviteRequestRow = {
  name: string; email: string; company: string; website: string | null; platforms: string | null; accounts: number | null; monthly_videos: number | null; library: string | null; goals: string | null; message: string | null;
  source: (typeof REQUEST_SOURCES)[number];
  content_status: (typeof CONTENT_STATUSES)[number] | null; library_size: (typeof LIBRARY_SIZES)[number] | null; objective: (typeof OBJECTIVES)[number] | null;
  timeline: (typeof TIMELINES)[number] | null; phone: string | null; attribution: Record<string, string> | null;
};
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown, max: number) => { if (v === "" || v === null || v === undefined) return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined; };
/** Empty → null; a listed value → itself; anything else → undefined (rejected). */
const pick = <T extends string>(v: unknown, list: readonly T[]): T | null | undefined => (v === "" || v === null || v === undefined ? null : typeof v === "string" && (list as readonly string[]).includes(v.trim()) ? (v.trim() as T) : undefined);
/** Phone numbers are kept as typed (digits, spaces, +, (), -, .), 5–40 characters, so the operator can dial them. */
const phoneOf = (v: unknown) => { if (v === "" || v === null || v === undefined) return null; if (typeof v !== "string") return undefined; const p = v.trim().replace(/\s+/g, " "); return /^\+?[0-9][0-9 ().-]{4,39}$/.test(p) ? p : undefined; };
/** Only the allow-listed campaign keys survive; values are short strings. Never a place for personal data. */
export function attributionOf(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const k of ATTRIBUTION_KEYS) { const x = (v as any)[k]; if (typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, 200); }
  return Object.keys(out).length ? out : null;
}
/** The hidden "fax" field is the honeypot; a real browser leaves it empty. "website" is a real, visible field. */
export function validateInviteRequest(body: any): { ok: true; row: InviteRequestRow } | { ok: false; error: string; honeypot?: boolean } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  if (typeof body.fax === "string" && body.fax.trim()) return { ok: false, error: "ok", honeypot: true };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const company = typeof body.company === "string" ? body.company.trim().slice(0, 120) : "";
  if (name.length < 1 || name.length > 120) return { ok: false, error: "invalid_name" };
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "invalid_email" };
  if (company.length < 1) return { ok: false, error: "invalid_company" };
  const accounts = int(body.accounts, 10000), monthly_videos = int(body.monthly_videos, 100000);
  if (accounts === undefined) return { ok: false, error: "invalid_accounts" };
  if (monthly_videos === undefined) return { ok: false, error: "invalid_monthly_videos" };
  const content_status = pick(body.content_status, CONTENT_STATUSES), library_size = pick(body.library_size, LIBRARY_SIZES), objective = pick(body.objective, OBJECTIVES);
  if (content_status === undefined) return { ok: false, error: "invalid_content_status" };
  if (library_size === undefined) return { ok: false, error: "invalid_library_size" };
  if (objective === undefined) return { ok: false, error: "invalid_objective" };
  const timeline = pick(body.timeline, TIMELINES);
  if (timeline === undefined) return { ok: false, error: "invalid_timeline" };
  const phone = phoneOf(body.phone);
  if (phone === undefined) return { ok: false, error: "invalid_phone" };
  const platforms = Array.isArray(body.platforms) ? body.platforms.filter((p: unknown) => typeof p === "string").map((p: string) => p.trim().toLowerCase()).filter(Boolean).slice(0, 6).join(", ") || null : text(body.platforms, 120);
  const source = pick(body.source, REQUEST_SOURCES) || "clone8.io";
  return { ok: true, row: { name, email, company, website: text(body.website, 200), platforms, accounts, monthly_videos, library: text(body.library, 200), goals: text(body.goals, 2000), message: text(body.message, 2000), source, content_status, library_size, objective, timeline, phone, attribution: attributionOf(body.attribution) } };
}

export const CONTENT_STATUS_LABEL: Record<(typeof CONTENT_STATUSES)[number], string> = { yes: "yes, regularly", some: "a few", not_yet: "not yet" };
export const LIBRARY_SIZE_LABEL: Record<(typeof LIBRARY_SIZES)[number], string> = { none: "no videos yet", under_25: "1 to 24 videos", "25_100": "25 to 99 videos", "100_500": "100 to 499 videos", "500_plus": "500 or more videos" };
export const OBJECTIVE_LABEL: Record<(typeof OBJECTIVES)[number], string> = { reach: "reach", awareness: "product awareness", distribution: "consistent distribution", other: "other" };
export const TIMELINE_LABEL: Record<(typeof TIMELINES)[number], string> = { asap: "as soon as possible", "1_3_months": "in the next 1 to 3 months", exploring: "just exploring" };
const APPLY_LINE: Record<(typeof APPLY_COLUMNS)[number], (row: InviteRequestRow) => string | null> = {
  content_status: (r) => (r.content_status ? `Published short-form videos: ${CONTENT_STATUS_LABEL[r.content_status]}` : null),
  library_size: (r) => (r.library_size ? `Existing videos: ${LIBRARY_SIZE_LABEL[r.library_size]}` : null),
  objective: (r) => (r.objective ? `Objective: ${OBJECTIVE_LABEL[r.objective]}` : null),
  timeline: (r) => (r.timeline ? `Wants to start: ${TIMELINE_LABEL[r.timeline]}` : null),
  phone: (r) => (r.phone ? `Phone (callback requested): ${r.phone}` : null),
  attribution: (r) => (r.attribution ? `Attribution: ${Object.entries(r.attribution).map(([k, v]) => `${k}=${v}`).join(" ")}` : null),
};
/** Before an apply-fields migration is applied its columns do not exist: keep those answers by writing them into the
 *  message text instead, so nothing the applicant said is lost. `only` names the missing columns (default: all of
 *  them); the others stay as columns. The warning in the log says to apply the migration. */
export function foldApplyFields(row: InviteRequestRow, only: readonly (typeof APPLY_COLUMNS)[number][] = APPLY_COLUMNS): Partial<InviteRequestRow> & Omit<InviteRequestRow, (typeof APPLY_COLUMNS)[number]> {
  const out: any = { ...row };
  const lines: string[] = [];
  for (const k of APPLY_COLUMNS) { if (!only.includes(k)) continue; const line = APPLY_LINE[k](row); if (line) lines.push(line); delete out[k]; }
  const already = typeof row.message === "string" && row.message.includes("[apply fields, migration pending]");
  out.message = [row.message, lines.length ? `${already ? "" : "[apply fields, migration pending]\n"}${lines.join("\n")}` : null].filter(Boolean).join(already ? "\n" : "\n\n").slice(0, 2000) || null;
  return out;
}
/** PostgREST reports an unknown column as PGRST204 ("Could not find the 'x' column ... in the schema cache"). */
const missingColumn = (err: any, names: readonly string[]) => { const m = String(err?.message ?? ""); return (err?.code === "PGRST204" || /column/i.test(m)) && names.some((n) => m.includes(`'${n}'`) || m.includes(` ${n} `) || m.includes(`.${n}`)); };
/** Which of `names` the error complains about (PostgREST names one column per error). */
const missingColumns = <T extends string>(err: any, names: readonly T[]): T[] => { const m = String(err?.message ?? ""); return names.filter((n) => m.includes(`'${n}'`) || m.includes(` ${n} `) || m.includes(`.${n}`)); };

// ---- First-party funnel events from clone8.io/apply: counts only, never personal data. ----
export const FUNNEL_EVENTS = ["landing", "cta_click", "form_view", "form_start", "step_2", "form_submit", "form_complete", "success_view", "booking_click"] as const;
export const DEVICE_CLASSES = ["in_app", "mobile", "desktop"] as const;
export type FunnelEventRow = { event: (typeof FUNNEL_EVENTS)[number]; path: string; visit_id: string; device: (typeof DEVICE_CLASSES)[number] | null; attribution: Record<string, string> | null; request_id: string | null };
export function validateFunnelEvent(body: any): { ok: true; row: FunnelEventRow } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const event = pick(body.event, FUNNEL_EVENTS); if (!event) return { ok: false, error: "invalid_event" };
  const path = typeof body.path === "string" && /^\/[A-Za-z0-9/_.-]{0,79}$/.test(body.path) ? body.path : null; if (!path) return { ok: false, error: "invalid_path" };
  const visit_id = typeof body.visit_id === "string" && /^[0-9a-f]{16,32}$/.test(body.visit_id) ? body.visit_id : null; if (!visit_id) return { ok: false, error: "invalid_visit_id" };
  const device = pick(body.device, DEVICE_CLASSES); if (device === undefined) return { ok: false, error: "invalid_device" };
  const request_id = body.request_id === undefined || body.request_id === null || body.request_id === "" ? null : typeof body.request_id === "string" && /^[0-9a-f-]{36}$/i.test(body.request_id) ? body.request_id : undefined;
  if (request_id === undefined) return { ok: false, error: "invalid_request_id" };
  return { ok: true, row: { event, path, visit_id, device, attribution: attributionOf(body.attribution), request_id } };
}

export const INBOX_FIELDS = ["id", "name", "email", "company", "website", "platforms", "accounts", "monthly_videos", "library", "goals", "message", "status", "created_at", "source", ...APPLY_COLUMNS] as const;
/** What the operator inbox gets: the application, never the Meta delivery context (IP, user agent, cookies). */
export function inboxRow(r: Record<string, unknown>): Record<string, unknown> { const o: Record<string, unknown> = {}; for (const k of INBOX_FIELDS) o[k] = r[k] ?? null; return o; }

/** Tiny fixed-window limiter per client address: enough to stop a script, invisible to people. */
export function makeLimiter(limit = 10, windowMs = 3600_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now = Date.now()) => {
    const cur = hits.get(key);
    if (!cur || cur.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    cur.n += 1; return cur.n <= limit;
  };
}

/** Operator inbox: newest invite requests. Admin-read through the global gate; re-checked here. */
export function registerInviteRequestInbox(app: Express, sbFn: SbGetter): void {
  app.get("/api/ops/invite-requests", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try {
      const r = await sbFn().from("invite_requests").select("*").order("created_at", { ascending: false }).limit(200);
      if (r.error) throw r.error;
      res.set("Cache-Control", "private, no-store").json({ requests: (r.data ?? []).map(inboxRow) });
    } catch (e: any) { res.status(503).json({ error: "requests_unavailable", detail: String(e?.message ?? e).slice(0, 200) }); }
  });
  app.post("/api/ops/invite-requests/:id/status", async (req: Request, res: Response) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator_required" });
    const status = String(req.body?.status ?? "");
    if (!(REQUEST_STATUSES as readonly string[]).includes(status)) return res.status(400).json({ error: "invalid_status" });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "request_not_found" });
    try {
      const r = await sbFn().from("invite_requests").update({ status }).eq("id", req.params.id).select("id,status").maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "request_not_found" });
      res.json({ request: r.data });
    } catch (e: any) { res.status(503).json({ error: "requests_unavailable" }); }
  });
}

export function registerPublicRoutes(app: Express, sbFn: SbGetter, opts: { ttlMs?: number; now?: () => Date; meta?: MetaConfig | null; metaFetch?: FetchLike } = {}): void {
  const meta = opts.meta === undefined ? metaConfig() : opts.meta;
  if (!meta) console.log("[public] Meta Conversions API off (META_PIXEL_ID / META_CAPI_ACCESS_TOKEN not set)");
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
    const outbox = outboxColumns(meta, readBrowserMeta(req.body), req);
    try {
      const sb = sbFn();
      let row: Record<string, unknown> = { ...v.row };
      let withOutbox = !!outbox;
      let r = await sb.from("invite_requests").insert(withOutbox ? { ...row, ...outbox } : row).select("id,created_at").single();
      // Same event id again = the browser retried a submit whose answer it never got: confirm the stored row, store nothing new.
      if (r.error?.code === "23505" && outbox) {
        const prior = await sb.from("invite_requests").select("id").eq("meta_event_id", outbox.meta_event_id).maybeSingle();
        if (prior.data) return res.status(201).json({ received: true, id: prior.data.id, duplicate: true });
      }
      // Apply-page columns not migrated yet: keep those answers in the message text, so nothing is lost. PostgREST names
      // one missing column per error, so fold and retry until the insert gets past them (at most one retry per column).
      for (let i = 0; r.error && missingColumn(r.error, APPLY_COLUMNS) && i < APPLY_COLUMNS.length; i++) {
        const missing = missingColumns(r.error, APPLY_COLUMNS);
        console.warn(`[public] invite_requests is missing column(s) ${missing.join(", ") || "(apply fields)"} (apply migrations 20261027120000 / 20261028090000); answers folded into message`);
        row = foldApplyFields(row as InviteRequestRow, missing.length ? missing : APPLY_COLUMNS);
        r = await sb.from("invite_requests").insert(withOutbox ? { ...row, ...outbox } : row).select("id,created_at").single();
      }
      // Meta columns not migrated yet: store the application exactly as before, without a server event.
      if (r.error && withOutbox && /meta_(event_id|capi)/.test(String(r.error.message ?? ""))) {
        console.warn("[public] invite_requests has no meta_capi columns yet; stored without a server event");
        withOutbox = false;
        r = await sb.from("invite_requests").insert(row).select("id,created_at").single();
        if (r.error) throw r.error;
        return res.status(201).json({ received: true, id: r.data.id });
      }
      if (r.error) throw r.error;
      res.status(201).json({ received: true, id: r.data.id });
      // The application is stored and confirmed; Meta delivery can only succeed, wait for a retry, or be logged.
      if (meta && outbox?.meta_capi_status === "pending") void deliverLeadNow(sb, meta, String(r.data.id), { fetchFn: opts.metaFetch });
    } catch (e: any) {
      console.warn("[public] invite request not stored:", e?.message ?? e);
      res.status(503).json({ error: "request_not_stored" });
    }
  });

  // Funnel events: fire-and-forget counters from the application page. Always 204 to a well-formed event, even when
  // the table is not migrated yet (logged once), so the page never waits on or reacts to measurement.
  const allowEvents = makeLimiter(240);
  let funnelTableMissingLogged = false;
  app.post("/api/public/funnel-events", async (req: Request, res: Response) => {
    publicHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    const key = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
    if (!allowEvents(key)) return res.status(429).json({ error: "too_many_requests" });
    const v = validateFunnelEvent(req.body);
    if (v.ok === false) return res.status(400).json({ error: v.error });
    try {
      const r = await sbFn().from("funnel_events").insert(v.row);
      if (r.error) {
        if (/funnel_events/.test(String(r.error.message ?? "")) || r.error.code === "42P01" || r.error.code === "PGRST205") { if (!funnelTableMissingLogged) { funnelTableMissingLogged = true; console.warn("[public] funnel_events table missing (migration 20261028090100); events dropped"); } }
        else console.warn("[public] funnel event not stored:", r.error.message);
      }
    } catch (e: any) { console.warn("[public] funnel event not stored:", e?.message ?? e); }
    res.status(204).end();
  });
}
