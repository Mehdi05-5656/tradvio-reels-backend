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
/** True once a newer server of this service is up (watchSuccessor): no loop takes a new job; jobs held carry on until
 *  the stop signal hands them back (stopGracefully, unchanged). */
let superseded = false;
export const isSuperseded = () => superseded;
export function beginStopping() { stopping = true; }
/** For tests. */
export function resetLeases() { stopping = false; superseded = false; held.clear(); }
export const heldJobs = () => [...held.values()];

/** studio_claim for one tool, unless the server is stopping; the job is remembered until the server stops. The answer
 *  has the shape of the rpc's ({ data, error }), so every loop reads it as before. */
export async function claimJob(sb: SupabaseClient | any, tool: string, worker: string): Promise<{ data: any; error: any }> {
  if (stopping || superseded) return { data: null, error: null };
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

// ---------------------------------------------------------------------------------------------------
// The hand-over between an old server and a new one (Nov 23 2026)
// ---------------------------------------------------------------------------------------------------
// Render keeps the old server running about 60 s after the new one is live and only then sends the stop signal. In
// that minute the old server kept taking NEW jobs with the old code: during the Twitch chat fix's deploy a test run of
// the very stream the fix was for went to the old server and failed the old way, and two more runs it took were cut
// off by its stop. Now the new server, once it has been up for SERVER_MARK.announce_ms, writes its boot id to storage;
// every server reads that file every SERVER_MARK.every_ms, and one that sees a newer server stops taking jobs at once.
// Only on Render (RENDER_INSTANCE_ID), so local runs and tests never stop each other.
export const SERVER_MARK = { key: "ops/current-server.txt", announce_ms: 20_000, every_ms: 5_000 };
export type ServerMark = { boot: string; at: number; commit: string | null; instance: string | null };

/** Whether `mark` (the file's contents) says a newer server than this one (`boot`, started at `at`) is up. */
export function newerServer(mark: ServerMark | null, boot: string, at: number): boolean {
  return !!mark && mark.boot !== boot && Number(mark.at) > at;
}

export function watchSuccessor(sbFn: () => SupabaseClient | any, o: { env?: Record<string, string | undefined>; log?: (l: string) => void; boot?: string; at?: number } = {}): (() => void) | null {
  const env = o.env ?? process.env, log = o.log ?? ((l: string) => console.log(l));
  if (!env.RENDER_INSTANCE_ID || env.STUDIO_SUCCESSOR_WATCH === "off") return null;
  const boot = o.boot ?? `${env.RENDER_INSTANCE_ID}:${Date.now().toString(36)}`, at = o.at ?? Date.now();
  const bucket = () => sbFn().storage.from("studio-outputs");
  const announce = setTimeout(() => {
    if (stopping || superseded) return;
    const mark: ServerMark = { boot, at, commit: env.RENDER_GIT_COMMIT ?? null, instance: env.RENDER_INSTANCE_ID ?? null };
    void Promise.resolve().then(() => bucket().upload(SERVER_MARK.key, Buffer.from(JSON.stringify(mark)), { contentType: "text/plain", upsert: true }))
      .then((r: any) => { if (r?.error) log(`[handover] could not announce this server: ${String(r.error.message ?? r.error).slice(0, 120)}`); else log(`[handover] this server (${mark.instance}, ${String(mark.commit ?? "").slice(0, 7)}) is the newest; older ones stop taking jobs`); })
      .catch(() => undefined);
  }, SERVER_MARK.announce_ms);
  const watch = setInterval(async () => {
    if (stopping || superseded) return;
    try {
      const d = await bucket().download(SERVER_MARK.key);
      if (d?.error || !d?.data) return;
      const mark = JSON.parse(await d.data.text()) as ServerMark;
      if (newerServer(mark, boot, at)) {
        superseded = true;
        log(`[handover] a newer server (${mark.instance}, ${String(mark.commit ?? "").slice(0, 7)}) is up: this one takes no more jobs; holding ${held.size} until the stop signal hands them back`);
      }
    } catch { /* storage unreachable for a moment: look again next time */ }
  }, SERVER_MARK.every_ms);
  (announce as any).unref?.(); (watch as any).unref?.();
  return () => { clearTimeout(announce); clearInterval(watch); };
}
