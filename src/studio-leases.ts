// Jobs this server holds, and handing them back when it is told to stop (Nov 15 2026).
//
// Every Studio tool loop takes its jobs through claimJob (studio_claim: a 10-minute lease, renewed while it works).
// On a deploy or restart Render keeps the old server running about 60 s after the new one is live, then sends SIGTERM
// and allows 30 s before killing it. Before this, the old server kept taking jobs in that minute and a job it held
// when it was killed sat locked until its lease ran out (a Clips run on Nov 15 2026 waited 10 minutes). Now:
//   - once stopping, claimJob takes nothing (every loop at once, from this one place);
//   - releaseHeld gives every job still held back to the queue (studio_release: only with its own lease token, only
//     while running, the attempt given back), so the new server takes it within seconds.
// The Kage worker does the same on its own (kage-motion/worker/main.ts). The lease stays the safety net for a server
// that dies without the signal.
import type { SupabaseClient } from "@supabase/supabase-js";

type Held = { id: string; token: string; tool: string; at: number };
const held = new Map<string, Held>();
let stopping = false;

/** True once the server has been told to stop: no loop takes a new job. */
export const isStopping = () => stopping;
export function beginStopping() { stopping = true; }
/** For tests. */
export function resetLeases() { stopping = false; held.clear(); }
export const heldJobs = () => [...held.values()];

/** studio_claim for one tool, unless the server is stopping; the job is remembered until the server stops. The answer
 *  has the shape of the rpc's ({ data, error }), so every loop reads it as before. */
export async function claimJob(sb: SupabaseClient | any, tool: string, worker: string): Promise<{ data: any; error: any }> {
  if (stopping) return { data: null, error: null };
  const r = await sb.rpc("studio_claim", { p_tool: tool, p_worker: worker });
  if (!r.error && r.data?.id && r.data?.lease_token) {
    // (a job finished or failed long ago needs no handing back: kept a day at most, the release is a no-op anyway)
    const now = Date.now();
    for (const [k, h] of held) if (now - h.at > 24 * 3600_000) held.delete(k);
    held.set(r.data.id, { id: r.data.id, token: r.data.lease_token, tool, at: now });
  }
  return r;
}

/** Every job this server still holds goes back to the queue. A job that has finished, failed or been taken again is
 *  left alone (the release only matches its own token on a running job). Anything going wrong here (the database
 *  function missing, the database unreachable) leaves the job to its lease, as before: never failed, never charged. */
export async function releaseHeld(sb: SupabaseClient | any, reason: string, log: (l: string) => void = (l) => console.log(l)): Promise<{ released: string[]; kept: string[] }> {
  const released: string[] = [], kept: string[] = [];
  await Promise.all([...held.values()].map(async (h) => {
    try {
      const r = await sb.rpc("studio_release", { p_job: h.id, p_token: h.token, p_reason: reason });
      if (r.error) throw r.error;
      if (r.data === true) released.push(h.id); else kept.push(h.id);
      held.delete(h.id);
    } catch (e: any) {
      // (the lease still expires on its own: the job is not lost, only later)
      log(`[shutdown] could not hand back ${h.tool} job ${h.id}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }));
  return { released, kept };
}

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), ms))]);
/** The server's last seconds after SIGTERM (Render allows 30): take no more jobs; let requests in flight finish (at most
 *  `waitMs`: Render moved traffic to the new server a minute ago, so few are left); hand every job held back to the
 *  queue; write out what is buffered (events, the cost ledger); exit. The jobs are released last, just before exit,
 *  so the work on this server stops at the same moment the new server may take them. */
export async function stopGracefully(o: { signal: string; sb: () => SupabaseClient | any; server?: { close(cb?: (e?: any) => void): unknown; closeIdleConnections?: () => void } | null;
  flush?: Array<() => Promise<unknown>>; log?: (l: string) => void; waitMs?: number; exit?: (code: number) => void }): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (stopping) return; // (a second signal while stopping changes nothing)
  beginStopping();
  const began = Date.now();
  log(`[shutdown] ${o.signal}: taking no more jobs; holding ${held.size} (${heldJobs().map((h) => `${h.tool} ${h.id}`).join(", ") || "none"})`);
  if (o.server) {
    const closed = new Promise<void>((ok) => { try { o.server!.close(() => ok()); o.server!.closeIdleConnections?.(); } catch { ok(); } });
    if (!(await within(closed, o.waitMs ?? 10_000))) log("[shutdown] requests still open after the wait; going on");
  }
  let sb: any = null; try { sb = o.sb(); } catch { /* no database configured: nothing to hand back */ }
  const r = sb ? await releaseHeld(sb, `server stopping (${o.signal})`, log) : { released: [], kept: [] };
  if (r.released.length || r.kept.length) log(`[shutdown] handed back ${r.released.length} job(s) to the queue${r.released.length ? `: ${r.released.join(", ")}` : ""}${r.kept.length ? `; ${r.kept.length} had already finished or moved on` : ""}`);
  await within(Promise.allSettled((o.flush ?? []).map((f) => f())), 5_000);
  log(`[shutdown] done in ${Date.now() - began} ms`);
  (o.exit ?? ((c: number) => process.exit(c)))(0);
}
