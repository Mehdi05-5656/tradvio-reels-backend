// Meta Conversions API (server events) for the clone8.io site.
//
// Today one outcome is sent: a stored invite application → Lead + Clone8ApplicationSubmitted,
// deduplicated against the browser pixel by the shared event_id. No value or currency is sent:
// an application is not a sale.
//
// Later outcomes (qualified lead, closed deal) can reuse buildMetaEvent/sendMetaEvents with
// action_source "system_generated" and the same user keys: the hashed email and
// external_id = sha256(invite_requests.id), both of which the Lead already carries.
//
// Env (Render web service):
//   META_PIXEL_ID            dataset / pixel id (same id as the browser pixel)
//   META_CAPI_ACCESS_TOKEN   Conversions API access token (secret)
//   META_TEST_EVENT_CODE     optional; routes every server event to Events Manager → Test events
//   META_GRAPH_API_VERSION   optional; default below
import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";

export const DEFAULT_GRAPH_VERSION = "v25.0";
export const LEAD_CUSTOM_DATA = { content_name: "Clone8 Invite Application", source: "website", status: "submitted" } as const;

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
const validUrl = (v: unknown) => { if (typeof v !== "string" || v.length > 1000) return null; try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch { return null; } };

/** Browser-side context the site sends next to the form fields (all optional, all validated). */
export type BrowserMeta = { eventId: string | null; fbp: string | null; fbc: string | null; sourceUrl: string | null; testEventCode: string | null };

export function readBrowserMeta(body: any, req?: Pick<Request, "headers">): BrowserMeta {
  const m = body && typeof body.meta === "object" && body.meta ? body.meta : {};
  return {
    eventId: validEventId(m.event_id),
    fbp: validFbCookie(m.fbp),
    fbc: validFbCookie(m.fbc),
    sourceUrl: validUrl(m.event_source_url) ?? validUrl(req?.headers?.referer),
    testEventCode: validTestCode(m.test_event_code),
  };
}

export function clientIp(req: Pick<Request, "headers" | "socket">): string | null {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  return ip && ip.length <= 45 ? ip : null;
}

export type MetaUser = { email?: string | null; externalId?: string | null; ip?: string | null; userAgent?: string | null; fbp?: string | null; fbc?: string | null };

export function buildUserData(u: MetaUser): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (u.email) d.em = [hashEmail(u.email)];
  if (u.externalId) d.external_id = [sha256(u.externalId)];
  if (u.ip) d.client_ip_address = u.ip;
  if (u.userAgent) d.client_user_agent = u.userAgent.slice(0, 1000);
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

/** The two events for one stored application. Same event_id as the browser pixel, so Meta keeps one of each. */
export function buildApplicationEvents(o: { eventId: string; time: Date; sourceUrl: string | null; user: MetaUser }): MetaEvent[] {
  return ["Lead", "Clone8ApplicationSubmitted"].map((name) => buildMetaEvent({ name, eventId: o.eventId, time: o.time, actionSource: "website", sourceUrl: o.sourceUrl, user: o.user, customData: { ...LEAD_CUSTOM_DATA } }));
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Posts events to Meta. Never throws; logs the outcome without the token or any personal data. */
export async function sendMetaEvents(cfg: MetaConfig, events: MetaEvent[], opts: { testEventCode?: string | null; fetchFn?: FetchLike; timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; detail?: string }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const test = cfg.testEventCode ?? opts.testEventCode ?? null;
  const payload: Record<string, unknown> = { data: events, access_token: cfg.token };
  if (test) payload.test_event_code = test;
  const url = `https://graph.facebook.com/${cfg.version}/${cfg.pixelId}/events`; // token travels in the body, never in a URL
  const names = events.map((e) => e.event_name).join("+");
  try {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    if (r.ok) console.log(`[meta-capi] sent ${names} event_id=${events[0]?.event_id}${test ? " (test)" : ""}`);
    else console.warn(`[meta-capi] ${names} rejected: HTTP ${r.status} ${detail}`);
    return { ok: r.ok, status: r.status, detail };
  } catch (e: any) {
    console.warn(`[meta-capi] ${names} not sent:`, String(e?.message ?? e).replace(cfg.token, "***").slice(0, 200));
    return { ok: false, status: 0 };
  }
}

/** Called once an application row exists. Fire-and-forget from the route: the visitor never waits on Meta. */
export function reportApplicationSubmitted(o: { cfg: MetaConfig | null; requestId: string; email: string; browser: BrowserMeta; ip: string | null; userAgent: string | null; time: Date; fetchFn?: FetchLike }): Promise<unknown> | null {
  if (!o.cfg) return null;
  const events = buildApplicationEvents({
    eventId: o.browser.eventId ?? `srv-${randomUUID()}`,
    time: o.time,
    sourceUrl: o.browser.sourceUrl,
    user: { email: o.email, externalId: o.requestId, ip: o.ip, userAgent: o.userAgent, fbp: o.browser.fbp, fbc: o.browser.fbc },
  });
  return sendMetaEvents(o.cfg, events, { testEventCode: o.browser.testEventCode, fetchFn: o.fetchFn });
}
