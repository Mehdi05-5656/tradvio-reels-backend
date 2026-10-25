// Expire posting windows that were held before any submission reached Publer and never resolved.
//
// A publish attempt can stop at "hold: upload_coordination_held" (the shared upload lock was busy or
// in an unknown state). Such rows have no Publer job id and no post id. If nothing happened within a
// day, the window did not post. This pass turns those rows into an auditable outcome, using only data
// already saved (publer_analytics), never a Publer call and never a resend:
//   - a Publer post for that account inside the window that no other log claims → the log becomes
//     published (the receipt was lost), and the queue row is marked posted;
//   - otherwise → the log becomes failed ("expired"), and a queue row still stuck in
//     publer_publishing is released to pending so the video is published in a later window.
// Rows that do carry a Publer job id are left alone: the publisher's own read-only reconciliation
// polls Publer for those, and an uncertain submission must never be resent.
import type { SupabaseClient } from "@supabase/supabase-js";

export const EXPIRE_AFTER_MS = 24 * 3600_000;
const WINDOW_BEFORE_MS = 30 * 60_000, WINDOW_AFTER_MS = 2 * 3600_000;

type PendingLog = { id: number; queue_id: string | null; phone_slot: string; slot_local_date: string; slot_index: number; planned_at: string; attempted_at: string; error: string | null };
type Post = { key: string; id: string; link: string | null; sched: number };

export type ReconcileResult = { examined: number; published: number; expired: number; released: number; errors: string[] };

export async function expireHeldWindows(sb: SupabaseClient, now = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { examined: 0, published: 0, expired: 0, released: 0, errors: [] };
  const cutoff = new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString();
  const pend = await sb.from("publer_publish_log")
    .select("id,queue_id,phone_slot,slot_local_date,slot_index,planned_at,attempted_at,error")
    .eq("status", "pending").is("publer_job_id", null).is("publer_post_id", null).lt("attempted_at", cutoff)
    .order("attempted_at", { ascending: true }).limit(200);
  if (pend.error) throw new Error(`publish_log_unavailable: ${pend.error.message}`);
  const rows = (pend.data ?? []) as PendingLog[];
  result.examined = rows.length;
  if (!rows.length) return result;

  // Per account: Publer posts around the pending windows, and the keys already claimed by published logs.
  const bySlot = new Map<string, PendingLog[]>();
  for (const r of rows) bySlot.set(r.phone_slot, [...(bySlot.get(r.phone_slot) ?? []), r]);

  for (const [slot, logs] of bySlot) {
    try {
      const times = logs.map((l) => Date.parse(l.planned_at));
      const fromISO = new Date(Math.min(...times) - WINDOW_BEFORE_MS).toISOString(), toISO = new Date(Math.max(...times) + WINDOW_AFTER_MS).toISOString();
      const posts = await sb.from("publer_analytics").select("publer_post_id,raw").eq("phone_slot", slot)
        .gte("raw->>scheduled_at", fromISO).lte("raw->>scheduled_at", toISO).limit(2000);
      if (posts.error) throw new Error(posts.error.message);
      const seen = new Map<string, Post>();
      for (const a of posts.data ?? []) {
        const raw = (a as any).raw ?? {};
        const sched = Date.parse(raw.scheduled_at);
        if (!Number.isFinite(sched)) continue;
        const id = String(raw.old_id ?? raw.id ?? (a as any).publer_post_id);
        const key = String((a as any).publer_post_id);
        if (!seen.has(key)) seen.set(key, { key, id, link: typeof raw.post_link === "string" ? raw.post_link : null, sched });
      }
      const days = [...new Set(logs.map((l) => l.slot_local_date))];
      const claimedRes = await sb.from("publer_publish_log").select("publer_post_id,publer_post_link").eq("phone_slot", slot).eq("status", "published").in("slot_local_date", days.flatMap((d) => [shift(d, -1), d, shift(d, 1)]));
      if (claimedRes.error) throw new Error(claimedRes.error.message);
      const claimed = new Set<string>();
      for (const c of claimedRes.data ?? []) for (const v of [(c as any).publer_post_id, (c as any).publer_post_link]) if (v) claimed.add(String(v));
      const free = [...seen.values()].filter((p) => ![p.key, p.id, p.link ?? ""].some((v) => claimed.has(v))).sort((a, b) => a.sched - b.sched);

      for (const log of logs.sort((a, b) => Date.parse(a.planned_at) - Date.parse(b.planned_at))) {
        const planned = Date.parse(log.planned_at);
        const i = free.findIndex((p) => p.sched >= planned - WINDOW_BEFORE_MS && p.sched < planned + WINDOW_AFTER_MS);
        const stamp = now.toISOString();
        if (i >= 0) {
          const p = free.splice(i, 1)[0];
          const u = await sb.from("publer_publish_log").update({ status: "published", publer_post_id: p.id, publer_post_link: p.link, error: null, updated_at: stamp }).eq("id", log.id).eq("status", "pending");
          if (u.error) throw new Error(u.error.message);
          if (log.queue_id) await sb.from("reels_manual_queue").update({ status: "posted", posted_at: stamp, posted_ig_url: p.link }).eq("id", log.queue_id).eq("status", "publer_publishing");
          result.published++;
        } else {
          const u = await sb.from("publer_publish_log").update({ status: "failed", error: `expired: held before submission, no Publer post appeared within 24 h (${(log.error ?? "").slice(0, 120)})`, updated_at: stamp }).eq("id", log.id).eq("status", "pending");
          if (u.error) throw new Error(u.error.message);
          result.expired++;
          if (log.queue_id) {
            const rel = await sb.from("reels_manual_queue").update({ status: "pending" }).eq("id", log.queue_id).eq("status", "publer_publishing").select("id");
            if (!rel.error && (rel.data ?? []).length) result.released++;
          }
        }
      }
    } catch (e: any) {
      result.errors.push(`${slot}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  return result;
}

const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
