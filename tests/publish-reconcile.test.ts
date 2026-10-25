import test from "node:test";
import assert from "node:assert/strict";
import { expireHeldWindows } from "../src/publish-reconcile.js";

// In-memory stand-in for the few supabase-js calls the pass makes, including the raw->>scheduled_at path filter.
function fakeSb(tables: Record<string, any[]>) {
  const get = (r: any, k: string) => (k.startsWith("raw->>") ? r.raw?.[k.slice(6)] : r[k]);
  return {
    tables,
    from(name: string) {
      const rows = (tables[name] ??= []);
      const filters: ((r: any) => boolean)[] = []; let mode = "select", patch: any = null, order: [string, boolean] | null = null, lim: number | null = null, selecting = false;
      const q: any = {
        select() { selecting = true; return q; },
        eq(k: string, v: any) { filters.push((r) => get(r, k) === v); return q; },
        is(k: string, v: any) { filters.push((r) => (v === null ? get(r, k) == null : get(r, k) === v)); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(get(r, k))); return q; },
        lt(k: string, v: any) { filters.push((r) => String(get(r, k)) < String(v)); return q; },
        gte(k: string, v: any) { filters.push((r) => String(get(r, k)) >= String(v)); return q; },
        lte(k: string, v: any) { filters.push((r) => String(get(r, k)) <= String(v)); return q; },
        order(k: string, o: any) { order = [k, o?.ascending !== false]; return q; },
        limit(n: number) { lim = n; return q; },
        update(p: any) { mode = "update"; patch = p; return q; },
        then(res: any, rej: any) {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update") { hit.forEach((r) => Object.assign(r, patch)); return Promise.resolve({ data: selecting ? hit.map((r) => ({ ...r })) : null, error: null }).then(res, rej); }
          if (order) { const [k, asc] = order; hit.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (asc ? 1 : -1)); }
          return Promise.resolve({ data: (lim === null ? hit : hit.slice(0, lim)).map((r) => ({ ...r })), error: null }).then(res, rej);
        },
      };
      return q;
    },
  } as any;
}

const now = new Date("2026-10-25T03:00:00Z");
const hold = "hold: upload_coordination_held";

test("held windows older than a day are closed: lost receipts become published, the rest expire and release their video", async () => {
  const sb = fakeSb({
    publer_publish_log: [
      // Oct 18, 8 AM PT window, held; Publer shows a post at 8:03 AM that nobody claims → lost receipt.
      { id: 1, queue_id: "q1", phone_slot: "a", slot_local_date: "2026-10-18", slot_index: 0, planned_at: "2026-10-18T15:00:00Z", attempted_at: "2026-10-18T15:00:19Z", status: "pending", error: hold, publer_job_id: null, publer_post_id: null },
      // Oct 18, 10 AM PT window, held; no post → expires, video released.
      { id: 2, queue_id: "q2", phone_slot: "a", slot_local_date: "2026-10-18", slot_index: 1, planned_at: "2026-10-18T17:00:00Z", attempted_at: "2026-10-18T17:00:20Z", status: "pending", error: hold, publer_job_id: null, publer_post_id: null },
      // Oct 18, 2 PM PT published normally; its post must not be stolen by the 12 PM window below.
      { id: 3, queue_id: "q3", phone_slot: "a", slot_local_date: "2026-10-18", slot_index: 3, planned_at: "2026-10-18T21:00:00Z", attempted_at: "2026-10-18T21:00:05Z", status: "published", error: null, publer_job_id: "j3", publer_post_id: "P3", publer_post_link: "https://www.instagram.com/reel/P3/" },
      { id: 4, queue_id: "q4", phone_slot: "a", slot_local_date: "2026-10-18", slot_index: 2, planned_at: "2026-10-18T19:00:00Z", attempted_at: "2026-10-18T19:00:20Z", status: "pending", error: hold, publer_job_id: null, publer_post_id: null },
      // Recent hold (2 hours old): left alone.
      { id: 5, queue_id: "q5", phone_slot: "a", slot_local_date: "2026-10-24", slot_index: 7, planned_at: "2026-10-25T01:00:00Z", attempted_at: "2026-10-25T01:00:20Z", status: "pending", error: hold, publer_job_id: null, publer_post_id: null },
      // Pending with a Publer job id (uncertain submission): never touched here.
      { id: 6, queue_id: "q6", phone_slot: "a", slot_local_date: "2026-10-18", slot_index: 4, planned_at: "2026-10-18T23:00:00Z", attempted_at: "2026-10-18T23:00:20Z", status: "pending", error: "uncertain", publer_job_id: "job6", publer_post_id: null },
    ],
    publer_analytics: [
      { phone_slot: "a", publer_post_id: "https://www.instagram.com/reel/LOST/", raw: { id: "pub1", old_id: "P1", post_link: "https://www.instagram.com/reel/LOST/", scheduled_at: "2026-10-18T15:03:00Z" } },
      { phone_slot: "a", publer_post_id: "https://www.instagram.com/reel/P3/", raw: { id: "pub3", old_id: "P3", post_link: "https://www.instagram.com/reel/P3/", scheduled_at: "2026-10-18T21:02:00Z" } },
    ],
    reels_manual_queue: [
      { id: "q1", status: "publer_publishing" }, { id: "q2", status: "publer_publishing" }, { id: "q4", status: "pending" }, { id: "q3", status: "posted" },
    ],
  });
  const r = await expireHeldWindows(sb, now);
  assert.deepEqual(r, { examined: 4, published: 1, expired: 3, released: 1, errors: [] });
  const log = (id: number) => sb.tables.publer_publish_log.find((l: any) => l.id === id);
  assert.equal(log(1).status, "published"); assert.equal(log(1).publer_post_id, "P1"); assert.equal(log(1).publer_post_link, "https://www.instagram.com/reel/LOST/");
  assert.equal(log(2).status, "failed"); assert.match(log(2).error, /^expired: held before submission/);
  assert.equal(log(4).status, "failed", "the 2 PM post belongs to the published window, not the held noon one");
  assert.equal(log(5).status, "pending", "younger than 24 h, still in flight");
  assert.equal(log(6).status, "failed"); assert.match(log(6).error, /^expired: submitted as job job6 but no Publer post appeared/);
  const queue = (id: string) => sb.tables.reels_manual_queue.find((q: any) => q.id === id);
  assert.equal(queue("q1").status, "posted");
  assert.equal(queue("q2").status, "pending", "released for a later window");
  assert.equal(queue("q4").status, "pending");
  // Second run: nothing left to examine.
  assert.equal((await expireHeldWindows(sb, now)).examined, 0);
});
