// Shared Publer request budget. Every Publer call goes through takeSlot() before it is sent.
// The budget lives in Supabase (publer_rate_acquire) so the web service and both cron jobs
// share one counter. If the database is unreachable we fall back to local spacing rather
// than stopping publishing.

export type Lane = "publish" | "analytics";

export class RateBudgetDeferred extends Error {
  constructor(public waitMs: number) {
    super(`publer_rate_budget_deferred: wait ${waitMs}ms`);
  }
}

interface Backend {
  acquire(lane: Lane): Promise<number>;
  block(untilMs: number, reason: string): Promise<void>;
}

let backend: Backend | null = null;
let lane: Lane = "publish";
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const realNow = () => Date.now();
let sleep = realSleep;
let now = realNow;
let lastLocal = 0;
let warned = false;

const LOCAL_SPACING_MS = 1500;      // ~80 requests per 2 minutes if the database is unavailable
const PUBLISH_MAX_WAIT_MS = 180_000; // publishing waits for room; analytics never waits

/** `client` may be a Supabase client or a getter (the web server creates its client lazily). */
export function configurePublerRate(client: any, processLane: Lane) {
  lane = processLane;
  const db = () => (typeof client === "function" ? client() : client);
  backend = {
    async acquire(l) {
      const r = await db().rpc("publer_rate_acquire", { p_lane: l });
      if (r.error) throw new Error(r.error.message || "publer_rate_acquire_failed");
      return Number(r.data) || 0;
    },
    async block(untilMs, reason) {
      const r = await db().rpc("publer_rate_block", { p_until: new Date(untilMs).toISOString(), p_reason: reason });
      if (r.error) throw new Error(r.error.message || "publer_rate_block_failed");
    },
  };
}

/** Test hook. Pass null to restore the unconfigured (no-op) state. */
export function _setPublerRateForTest(b: Backend | null, opts: { lane?: Lane; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  backend = b;
  lane = opts.lane ?? "publish";
  sleep = opts.sleep ?? realSleep;
  now = opts.now ?? realNow;
  lastLocal = 0;
  warned = false;
}

export function currentLane(): Lane {
  return lane;
}

async function localSpacing() {
  const wait = lastLocal + LOCAL_SPACING_MS - now();
  if (wait > 0) await sleep(wait);
  lastLocal = now();
}

/** Wait for room in the shared budget. Analytics defers instead of waiting. */
export async function takeSlot(): Promise<void> {
  if (!backend) return;
  let waited = 0;
  for (;;) {
    let wait: number;
    try {
      wait = await backend.acquire(lane);
    } catch (e: any) {
      if (!warned) console.warn("[publer-rate] budget unavailable, using local spacing:", e?.message || e);
      warned = true;
      await localSpacing();
      return;
    }
    if (wait <= 0) return;
    if (lane === "analytics" || waited + wait > PUBLISH_MAX_WAIT_MS) throw new RateBudgetDeferred(wait);
    await sleep(wait);
    waited += wait;
  }
}

/** Pause every process until Publer's window resets. Never throws. */
export async function blockUntil(untilMs: number, reason: string) {
  if (!backend) return;
  try {
    await backend.block(untilMs, reason);
  } catch (e: any) {
    console.warn("[publer-rate] could not record block:", e?.message || e);
  }
}

/** Reset time from Publer headers (UNIX seconds), bounded to a sane range. */
export function resetFromHeaders(h: { get(name: string): string | null }, fallbackMs: number): number {
  const t = now();
  const raw = Number(h.get("x-ratelimit-reset"));
  if (Number.isFinite(raw) && raw > 0) {
    const ms = raw * 1000;
    if (ms > t && ms <= t + 150_000) return ms;
  }
  return t + fallbackMs;
}

export async function pause(ms: number) {
  await sleep(ms);
}
