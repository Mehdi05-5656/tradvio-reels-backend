// Server-side product events for PostHog: the steps of the funnel the browser cannot report reliably (a film started,
// a purchase completed, a feature used, a checkout begun). Off unless POSTHOG_KEY (the project's public key) is set.
// People are identified by account id only, the same id the dashboard uses, so server and browser events join up.
// Batched every few seconds; never throws and never slows a request.
type Ev = { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let warned = false;
let fetchFn: typeof fetch = (input, init) => fetch(input, init);
const FLUSH_MS = 3000, MAX = 1000;

const key = () => process.env.POSTHOG_KEY || '';
const host = () => (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

export function setPosthogFetchForTests(f: typeof fetch) { fetchFn = f; }
export function resetPosthogForTests() { queue = []; if (timer) clearTimeout(timer); timer = null; warned = false; fetchFn = (input, init) => fetch(input, init); }

/** Queue one event for a signed-in person. Synchronous and safe anywhere. */
export function phCapture(userId: string | null | undefined, event: string, properties: Record<string, unknown> = {}) {
  if (!key() || !userId || !UUID.test(userId) || !event || queue.length >= MAX) return;
  queue.push({ event: String(event).slice(0, 80), distinct_id: userId, properties: { ...properties, $lib: 'clone8-backend' }, timestamp: new Date().toISOString() });
  if (!timer) timer = setTimeout(() => { timer = null; void flushPosthog(); }, FLUSH_MS);
}

/** Send what is queued (also called on shutdown and by tests). Returns how many were sent. */
export async function flushPosthog(): Promise<number> {
  if (!key() || !queue.length) return 0;
  const batch = queue; queue = [];
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetchFn(`${host()}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key(), batch }), signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error(`${r.status}`);
    return batch.length;
  } catch (e: any) {
    if (!warned) { warned = true; console.log(`[posthog] not sent (${String(e?.message ?? e).slice(0, 120)}); further failures are silent`); }
    return 0;
  }
}
