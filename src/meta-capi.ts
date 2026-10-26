// Meta Conversions API (server events) for the clone8.io site.
//
// One outcome is sent today: a stored invite application → Lead, deduplicated against the browser
// pixel by the event_id the site generates. No value or currency: an application is not a sale.
//
// Delivery is durable. The invite_requests row itself is the outbox (meta_capi_* columns, migration
// 20261026090000): the row is written with status "pending" in the same insert as the application,
// the route tries once right after answering 201, and a 5-minute loop retries anything left behind
// (process restart, Meta outage). Meta only deduplicates a server event against a browser event, not
// against an earlier copy of itself, so a send is retried only after Meta clearly refused it (HTTP
// error). A timeout or a crash mid-send leaves the outcome unknown; those rows are marked "unknown"
// and never resent, so one application can never become two server Leads.
//
// Later outcomes (qualified lead, closed deal) can reuse buildMetaEvent/sendMetaEvents with
// action_source "system_generated" and the same user keys the Lead carries: the hashed email and
// external_id = sha256(invite_requests.id).
//
// Env (Render web service only; the token never leaves the backend):
//   META_PIXEL_ID            dataset / pixel id (same id as the browser pixel)
//   META_CAPI_ACCESS_TOKEN   Conversions API access token (secret)
//   META_TEST_EVENT_CODE     optional; routes every server event to Events Manager → Test events
//   META_GRAPH_API_VERSION   optional; default below
import { createHash } from "node:crypto";
import type { Request } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_GRAPH_VERSION = "v25.0";
export const LEAD_CUSTOM_DATA = { content_name: "Clone8 Invite Application", source: "website", status: "submitted" } as const;
export const MAX_ATTEMPTS = 8;
export const GIVE_UP_AFTER_MS = 47 * 3600_000; // inside Meta's 48 h deduplication window

export type MetaConfig = { pixelId: string; token: string; testEventCode: string | null; version: string };

export function metaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const pixelId = (env.META_PIXEL_ID ?? "").trim();
  const token = (env.META_CAPI_ACCESS_TOKEN ?? "").trim();
  if (!/^\d{5,20}$/.test(pixelId) || !token) return null;
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "") ? env.META_GRAPH_API_VERSION! : DEFAULT_GRAPH_VERSION;
  return { pixelId, token, testEventCode: validTestCode(env.META_TEST_EVENT_CODE), version };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Meta's expected format for em: trimmed, lowercased, then SHA-256 hex. */
export const hashEmail = (email: string) => sha256(email.trim().toLowerCase());

const validTestCode = (v: unknown) => (typeof v === "string" && /^TEST[A-Za-z0-9]{1,24}$/.test(v.trim()) ? v.trim() : null);
const validEventId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
const validFbCookie = (v: unknown) => (typeof v === "string" && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_.-]{1,500}$/.test(v) ? v : null);
/** Page address without query or fragment, so nothing typed into a URL is forwarded. */
const validUrl = (v: unknown) => { if (typeof v !== "string" || v.length > 1000) return null; try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:" ? u.origin + u.pathname : null; } catch { return null; } };

/**
 * Browser-side context the site sends next to the form fields. The site sends it only when tracking
 * is allowed for that visitor (production, no Global Privacy Control, outside consent-required
 * regions), so no context means no server event.
 */
export type BrowserMeta = { eventId: string | null; fbp: string | null; fbc: string | null; sourceUrl: string | null; testEventCode: string | null };

export function readBrowserMeta(body: any): BrowserMeta {
  const m = body && typeof body.meta === "object" && body.meta ? body.meta : {};
  return { eventId: validEventId(m.event_id), fbp: validFbCookie(m.fbp), fbc: validFbCookie(m.fbc), sourceUrl: validUrl(m.event_source_url), testEventCode: validTestCode(m.test_event_code) };
}

export function clientIp(req: Pick<Request, "headers" | "socket">): string | null {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  return ip && ip.length <= 45 ? ip : null;
}

/** What the outbox keeps until delivery; cleared as soon as the row is final. */
export type CapiContext = { ip: string | null; ua: string | null; fbp: string | null; fbc: string | null; url: string | null; test: string | null };

/** Columns added to the invite_requests insert. Null when the browser sent no context. */
export function outboxColumns(cfg: MetaConfig | null, b: BrowserMeta, req: Pick<Request, "headers" | "socket">) {
  if (!b.eventId) return null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 1000) : null;
  const ctx: CapiContext = { ip: clientIp(req), ua, fbp: b.fbp, fbc: b.fbc, url: b.sourceUrl, test: b.testEventCode };
  return cfg
    ? { meta_event_id: b.eventId, meta_capi_status: "pending", meta_capi_context: ctx }
    : { meta_event_id: b.eventId, meta_capi_status: "skipped", meta_capi_context: null };
}

export type MetaUser = { email?: string | null; externalId?: string | null; ip?: string | null; userAgent?: string | null; fbp?: string | null; fbc?: string | null };

export function buildUserData(u: MetaUser): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (u.email) d.em = [hashEmail(u.email)];
  if (u.externalId) d.external_id = [sha256(u.externalId)];
  if (u.ip) d.client_ip_address = u.ip;
  if (u.userAgent) d.client_user_agent = u.userAgent;
  if (u.fbp) d.fbp = u.fbp;
  if (u.fbc) d.fbc = u.fbc;
  return d;
}

export type MetaEvent = Record<string, unknown>;

export function buildMetaEvent(o: { name: string; eventId: string; time: Date; actionSource: "website" | "system_generated"; sourceUrl?: string | null; user: MetaUser; customData?: Record<string, unknown> }): MetaEvent {
  const e: MetaEvent = { event_name: o.name, event_time: Math.floor(o.time.getTime() / 1000), event_id: o.eventId, action_source: o.actionSource, user_data: buildUserData(o.user) };
  if (o.sourceUrl) e.event_source_url = o.sourceUrl;
  if (o.customData) e.custom_data = o.customData;
  return e;
}

/** The Lead for one stored application. Same name and event_id as the browser pixel's Lead. */
export function buildLeadEvent(o: { eventId: string; time: Date; requestId: string; email: string; ctx: CapiContext }): MetaEvent {
  return buildMetaEvent({ name: "Lead", eventId: o.eventId, time: o.time, actionSource: "website", sourceUrl: o.ctx.url, customData: { ...LEAD_CUSTOM_DATA },
    user: { email: o.email, externalId: o.requestId, ip: o.ctx.ip, userAgent: o.ctx.ua, fbp: o.ctx.fbp, fbc: o.ctx.fbc } });
}

const PRE_CONNECT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
/** sent: Meta accepted. rejected: Meta answered with an error, nothing was recorded, safe to retry. unknown: no answer. */
export type SendOutcome = { outcome: "sent" | "rejected" | "unknown"; status: number; detail: string };

/** Posts events to Meta. Never throws; logs without the token or any personal data. */
export async function sendMetaEvents(cfg: MetaConfig, events: MetaEvent[], opts: { testEventCode?: string | null; fetchFn?: FetchLike; timeoutMs?: number } = {}): Promise<SendOutcome> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const test = cfg.testEventCode ?? opts.testEventCode ?? null;
  const payload: Record<string, unknown> = { data: events, access_token: cfg.token }; // token in the body, never in a URL
  if (test) payload.test_event_code = test;
  const names = events.map((e) => `${e.event_name} ${e.event_id}`).join(", ");
  let status = 0;
  try {
    const r = await fetchFn(`https://graph.facebook.com/${cfg.version}/${cfg.pixelId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    status = r.status;
    const detail = (await r.text().catch(() => "")).replaceAll(cfg.token, "***").slice(0, 300);
    if (r.ok) { console.log(`[meta-capi] sent ${names}${test ? " (test)" : ""}`); return { outcome: "sent", status, detail: "" }; }
    console.warn(`[meta-capi] ${names} rejected: HTTP ${status} ${detail}`);
    return { outcome: "rejected", status, detail: `HTTP ${status} ${detail}`.slice(0, 300) };
  } catch (e: any) {
    const code = String(e?.cause?.code ?? e?.code ?? "");
    const detail = String(e?.name === "TimeoutError" ? "timeout" : `${code} ${e?.message ?? e}`.trim()).replaceAll(cfg.token, "***").slice(0, 200);
    // Failed before a connection existed: Meta cannot have the event, so a retry is safe.
    if (PRE_CONNECT.has(code)) { console.warn(`[meta-capi] ${names} not sent: ${detail}`); return { outcome: "rejected", status, detail }; }
    console.warn(`[meta-capi] ${names} outcome unknown: ${detail}`);
    return { outcome: "unknown", status, detail };
  }
}

// ---- Outbox -------------------------------------------------------------------------------------

type OutboxRow = { id: string; email: string; created_at: string; meta_event_id: string; meta_capi_attempts: number; meta_capi_last_attempt_at: string | null; meta_capi_context: CapiContext | null };
const OUTBOX_COLUMNS = "id,email,created_at,meta_event_id,meta_capi_attempts,meta_capi_last_attempt_at,meta_capi_context";

/** Retry spacing: 0, 5, 15, 30, 60 minutes, then every 2 hours. */
export const retryDelayMs = (attempts: number) => ([0, 5, 15, 30, 60][attempts] ?? 120) * 60_000;

/**
 * Delivers one pending row. The row is claimed first (status pending → sending, attempts +1, only if
 * nobody else changed it), so the in-request attempt and the loop can never send the same row twice.
 */
export async function deliverLead(sb: SupabaseClient, cfg: MetaConfig, row: OutboxRow, opts: { fetchFn?: FetchLike; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const created = new Date(row.created_at);
  const final = (status: string, error: string | null) =>
    sb.from("invite_requests").update({ meta_capi_status: status, meta_capi_error: error, meta_capi_context: null, ...(status === "sent" ? { meta_capi_sent_at: now.toISOString() } : {}) }).eq("id", row.id).eq("meta_capi_status", "sending");
  if (!row.meta_capi_context || now.getTime() - created.getTime() > GIVE_UP_AFTER_MS || row.meta_capi_attempts >= MAX_ATTEMPTS) {
    await sb.from("invite_requests").update({ meta_capi_status: "failed", meta_capi_context: null }).eq("id", row.id).eq("meta_capi_status", "pending");
    return "failed";
  }
  const claim = await sb.from("invite_requests")
    .update({ meta_capi_status: "sending", meta_capi_attempts: row.meta_capi_attempts + 1, meta_capi_last_attempt_at: now.toISOString() })
    .eq("id", row.id).eq("meta_capi_status", "pending").eq("meta_capi_attempts", row.meta_capi_attempts).select("id").maybeSingle();
  if (claim.error || !claim.data) return "claimed_elsewhere";
  const event = buildLeadEvent({ eventId: row.meta_event_id, time: created, requestId: row.id, email: row.email, ctx: row.meta_capi_context });
  const r = await sendMetaEvents(cfg, [event], { testEventCode: row.meta_capi_context.test, fetchFn: opts.fetchFn });
  if (r.outcome === "sent") { await final("sent", null); return "sent"; }
  if (r.outcome === "unknown") { await final("unknown", r.detail); return "unknown"; }
  const giveUp = row.meta_capi_attempts + 1 >= MAX_ATTEMPTS;
  if (giveUp) await final("failed", r.detail);
  else await sb.from("invite_requests").update({ meta_capi_status: "pending", meta_capi_error: r.detail }).eq("id", row.id).eq("meta_capi_status", "sending");
  return giveUp ? "failed" : "retry";
}

/** The attempt made right after the 201. Never throws. */
export async function deliverLeadNow(sb: SupabaseClient, cfg: MetaConfig, requestId: string, opts: { fetchFn?: FetchLike } = {}): Promise<string> {
  try {
    const r = await sb.from("invite_requests").select(OUTBOX_COLUMNS).eq("id", requestId).eq("meta_capi_status", "pending").maybeSingle();
    if (r.error || !r.data) return "not_pending";
    return await deliverLead(sb, cfg, r.data as OutboxRow, opts);
  } catch (e: any) { console.warn("[meta-capi] delivery error:", String(e?.message ?? e).slice(0, 200)); return "error"; }
}

/** One pass of the loop: pending rows whose retry time has come, plus rows stuck mid-send. */
export async function metaCapiTick(sb: SupabaseClient, cfg: MetaConfig, opts: { fetchFn?: FetchLike; now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const out: Record<string, number> = {};
  const count = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
  // A row left in "sending" for 15 minutes means the process stopped mid-request: Meta may have it.
  const stuck = await sb.from("invite_requests").update({ meta_capi_status: "unknown", meta_capi_error: "process stopped during send", meta_capi_context: null })
    .eq("meta_capi_status", "sending").lt("meta_capi_last_attempt_at", new Date(now.getTime() - 15 * 60_000).toISOString()).select("id");
  if (stuck.data?.length) { out.unknown = stuck.data.length; console.warn(`[meta-capi] ${stuck.data.length} send(s) interrupted; outcome unknown, not resent`); }
  const r = await sb.from("invite_requests").select(OUTBOX_COLUMNS).eq("meta_capi_status", "pending").order("created_at", { ascending: true }).limit(opts.limit ?? 50);
  if (r.error) throw r.error;
  for (const row of (r.data ?? []) as OutboxRow[]) {
    // Fresh rows belong to the in-request attempt for the first minute.
    const since = row.meta_capi_last_attempt_at ? new Date(row.meta_capi_last_attempt_at).getTime() : new Date(row.created_at).getTime() + 60_000;
    if (now.getTime() < since + retryDelayMs(row.meta_capi_attempts)) { count("waiting"); continue; }
    count(await deliverLead(sb, cfg, row, { fetchFn: opts.fetchFn, now }));
  }
  return out;
}

/** Runs metaCapiTick every 5 minutes in the web service (a single instance), first pass 20 s after boot. */
export function startMetaCapiLoop(sbFn: () => SupabaseClient, cfg: MetaConfig | null, intervalMs = 5 * 60_000): NodeJS.Timeout | null {
  if (!cfg) return null;
  const tick = () => metaCapiTick(sbFn(), cfg).then((o) => { if (Object.keys(o).some((k) => k !== "waiting")) console.log("[meta-capi] tick", JSON.stringify(o)); }).catch((e) => console.warn("[meta-capi] tick:", String(e?.message ?? e).slice(0, 200)));
  const t = setInterval(tick, intervalMs);
  t.unref();
  setTimeout(tick, 20_000).unref();
  return t;
}
