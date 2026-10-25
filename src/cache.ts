// Small in-process memo for read-only computations that are expensive against the database (window snapshots,
// pipeline counts). One value per key with a time-to-live; concurrent callers share the in-flight promise, so a
// burst of page loads costs one database round trip. Failures are not cached.
type Entry<T> = { at: number; ttl: number; value: T };
const values = new Map<string, Entry<any>>();
const inflight = new Map<string, Promise<any>>();

export async function memo<T>(key: string, ttlMs: number, compute: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = values.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = compute().then((value) => { values.set(key, { at: Date.now(), ttl: ttlMs, value }); return value; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
/** The cached value if it is still fresh, else undefined; never computes. */
export function peek<T>(key: string, now = Date.now()): T | undefined {
  const hit = values.get(key);
  return hit && now - hit.at < hit.ttl ? (hit.value as T) : undefined;
}
export function memoClear() { values.clear(); inflight.clear(); }
