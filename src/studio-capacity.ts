// How much work the Studio's video runs take on at once (Nov 2 2026).
//
// A Clips run is about half waiting (the download through the proxy, then speech-to-text and choosing, which run on
// other companies' servers) and half cutting (ffmpeg, which takes a whole CPU). So several runs are active side by
// side, and only the cutting goes through the cutter: one clip at a time per slot, first come first served, so runs
// take turns clip by clip and every run keeps moving. Captions renders use the same cutter, one video at a time, so a
// short captions job waits at most for one clip, never for a whole Clips run.
//
// A new run is only taken on while the server has room: memory under a ceiling (the container's own figure, which
// counts ffmpeg and yt-dlp too) and enough free disk for another download.
import { statfs, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export type Capacity = { runs: number; captionsRuns: number; cutSlots: number; memCeiling: number; diskFloorGb: number };
/** STUDIO_CLIPS_MAX_RUNS (Clips runs active at once, default 5), STUDIO_CAPTIONS_MAX_RUNS (default 3), STUDIO_CUT_SLOTS
 *  (clips or captions renders at once, default 1: one per CPU), STUDIO_MEM_CEILING (share of the container's memory
 *  above which no new run starts, default 0.75), STUDIO_DISK_FLOOR_GB (free disk a new run needs, default 2). */
export function capacity(env: Record<string, string | undefined> = process.env): Capacity {
  return {
    runs: clamp(Math.round(num(env.STUDIO_CLIPS_MAX_RUNS, 5)), 1, 12),
    captionsRuns: clamp(Math.round(num(env.STUDIO_CAPTIONS_MAX_RUNS, 3)), 1, 12),
    cutSlots: clamp(Math.round(num(env.STUDIO_CUT_SLOTS, 1)), 1, 16),
    memCeiling: clamp(num(env.STUDIO_MEM_CEILING, 0.75), 0.3, 0.95),
    diskFloorGb: clamp(num(env.STUDIO_DISK_FLOOR_GB, 2), 0.2, 100),
  };
}

/** A first-come-first-served gate with `slots` places. `run` waits for a place, runs the work, frees the place.
 *  `onWait` is called once when the work has to wait (to tell the person). */
export class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(public slots: number) {}
  get busy() { return this.active; }
  get queued() { return this.waiting.length; }
  async run<T>(work: () => Promise<T>, onWait?: () => void | Promise<void>): Promise<T> {
    if (this.active >= this.slots) {
      try { await onWait?.(); } catch { /* telling is best effort */ }
      await new Promise<void>((go) => this.waiting.push(go));
    } else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // the place passes straight to the next in line
      else this.active--;
    }
  }
}
let gate: Gate | null = null;
/** The one cutter of this server (clips and captions renders share it). */
export function cutGate(env: Record<string, string | undefined> = process.env): Gate {
  if (!gate) gate = new Gate(capacity(env).cutSlots);
  return gate;
}
export const resetCutGate = () => { gate = null; };

/** The container's memory that cannot be given back (processes' own memory, not the disk cache the kernel frees when
 *  it needs to) and its limit, from cgroup v2 or v1; null where it cannot be read (a laptop). */
export async function containerMemory(read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<{ used: number; limit: number } | null> {
  const stat = async (file: string, key: string) => { const m = (await read(file)).match(new RegExp(`^${key} (\\d+)$`, "m")); return m ? Number(m[1]) : NaN; };
  const read2 = async (usedFile: string, statFile: string, statKey: string, limitFile: string) => {
    const lim = (await read(limitFile)).trim();
    const limit = lim === "max" ? NaN : Number(lim);
    if (!Number.isFinite(limit) || limit <= 0 || limit >= 1e15) return null;
    let used = await stat(statFile, statKey).catch(() => NaN);
    if (!Number.isFinite(used)) used = Number((await read(usedFile)).trim());
    return Number.isFinite(used) ? { used, limit } : null;
  };
  try { return await read2("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.stat", "anon", "/sys/fs/cgroup/memory.max"); } catch { /* not cgroup v2 */ }
  try { return await read2("/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.stat", "total_rss", "/sys/fs/cgroup/memory/memory.limit_in_bytes"); } catch { /* not cgroup v1 */ }
  return null;
}
/** Free bytes on the disk the runs download to; null when it cannot be read. */
export async function freeDisk(dir = tmpdir()): Promise<number | null> {
  try { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
/** Whether this server can take on another run now. What cannot be measured does not block. */
export async function roomForAnother(env: Record<string, string | undefined> = process.env, probes: { memory?: typeof containerMemory; disk?: typeof freeDisk } = {}): Promise<{ ok: boolean; why?: string }> {
  const cap = capacity(env);
  const mem = await (probes.memory ?? containerMemory)();
  if (mem && mem.used / mem.limit >= cap.memCeiling) return { ok: false, why: `memory ${Math.round((mem.used / mem.limit) * 100)}%` };
  const disk = await (probes.disk ?? freeDisk)();
  if (disk != null && disk < cap.diskFloorGb * 1e9) return { ok: false, why: `disk ${Math.round(disk / 1e8) / 10} GB free` };
  return { ok: true };
}
