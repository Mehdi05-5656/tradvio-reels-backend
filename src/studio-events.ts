// What the other Studio tables do not keep, for the admin panel (migrations/20261108000000_studio_events.sql): what
// each Claude call cost, calls to other paid services, plan checkouts started, emails sent, and the pages people open.
// Rows are buffered and written every few seconds in one insert. Recording never throws and never slows a request:
// before the migration, or if a write fails, the rows are dropped with one log line.
import type { SupabaseClient } from "@supabase/supabase-js";

export type EventKind = "claude" | "vendor" | "page" | "checkout" | "email" | "feature";
export type StudioEvent = { user_id?: string | null; kind: EventKind; name: string; usd?: number | null; props?: Record<string, any> };

let sink: (() => SupabaseClient) | null = null;
let buffer: Array<StudioEvent & { created_at: string }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let warned = false;
const FLUSH_MS = 4000, MAX_BUFFER = 2000;

/** Called once when the Studio routes start; until then (and in tests that do not call it) events go nowhere. */
export function initEvents(sbFn: () => SupabaseClient) { sink = sbFn; }
export function resetEventsForTests() { sink = null; buffer = []; if (timer) clearTimeout(timer); timer = null; warned = false; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Record one event. Synchronous and safe to call anywhere. */
export function recordEvent(e: StudioEvent) {
  if (!sink || !e?.kind || !e.name) return;
  if (buffer.length >= MAX_BUFFER) return;
  const usd = e.usd != null && Number.isFinite(Number(e.usd)) ? Math.round(Number(e.usd) * 1e6) / 1e6 : null;
  buffer.push({ user_id: e.user_id && UUID.test(e.user_id) ? e.user_id : null, kind: e.kind, name: String(e.name).slice(0, 80), usd, props: e.props ?? {}, created_at: new Date().toISOString() });
  if (!timer) timer = setTimeout(() => { timer = null; void flushEvents(); }, FLUSH_MS);
}

/** Write what is buffered (also called on shutdown and by tests). */
export async function flushEvents(): Promise<number> {
  if (!sink || !buffer.length) return 0;
  const rows = buffer; buffer = [];
  try {
    const r = await sink().from("studio_events").insert(rows);
    if (r.error) throw r.error;
    return rows.length;
  } catch (err: any) {
    if (!warned) { warned = true; console.log(`[events] not recorded (${String(err?.message ?? err).slice(0, 160)}); further failures are silent`); }
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------
// Pages people open (sent by the dashboard), bounded per person
// ---------------------------------------------------------------------------------------------------
export const TRACKED_PAGES = new Set(["home", "chat", "automations", "publish", "performance", "blueprint", "recast", "swap", "styles", "trends", "characters", "instruments", "instrument", "library", "pricing", "account", "onboarding", "managed", "admin"]);
const perMinute = new Map<string, { at: number; n: number }>();
/** Accept up to 30 page views a minute per person; returns how many were kept. */
export function recordPageViews(userId: string, items: unknown, now = Date.now()): number {
  if (!Array.isArray(items)) return 0;
  let kept = 0;
  for (const it of items.slice(0, 20)) {
    const page = typeof (it as any)?.page === "string" ? (it as any).page : "";
    if (!TRACKED_PAGES.has(page)) continue;
    const w = perMinute.get(userId);
    if (w && now - w.at < 60_000 && w.n >= 30) break;
    if (!w || now - w.at >= 60_000) perMinute.set(userId, { at: now, n: 1 }); else w.n++;
    const tab = typeof (it as any)?.tab === "string" ? String((it as any).tab).replace(/[^\w-]/g, "").slice(0, 40) : undefined;
    recordEvent({ user_id: userId, kind: "page", name: page, props: tab ? { tab } : {} });
    kept++;
  }
  if (perMinute.size > 5000) perMinute.clear();
  return kept;
}
