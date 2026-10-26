import test from "node:test";
import assert from "node:assert/strict";
import { loadLearning, learningTick } from "../src/client-learning.js";

// The panel reads only the client's rows: every table query carries the org id, and the tick calls the scoped refresh.
function fakeDb(log: any[]) {
  return {
    rpc: async (fn: string, args: any) => { log.push(["rpc", fn, args]); return { data: { refreshed: [], skipped: 1 }, error: null }; },
    from(table: string) {
      const f: Record<string, any> = {};
      const q: any = {
        select(_c: string, opts?: any) { q._count = !!opts?.count; return q; }, order() { return q; }, limit() { return q; }, gte() { return q; }, range() { return q; }, not() { q._notArm = true; return q; },
        eq(k: string, v: any) { f[k] = v; return q; },
        async maybeSingle() { log.push([table, f]); return { data: table === "client_learning_runs" ? { ran_at: "2026-10-26T21:00:00Z", posts_scored: 862, posts_published: 1556, sources: 300, duration_ms: 900 } : null, error: null }; },
        then(res: any) {
          log.push([table, f]);
          if (q._count) return Promise.resolve({ data: null, error: null, count: table === "client_post_scores" && f.org_id === "org-a" ? (q._notArm ? 1200 : 1500) : 0 }).then(res);
          const rows = table === "client_post_scores" ? (f.org_id === "org-a" ? [{ arm: "A", views: 10 }, { arm: "B", views: 30 }, { arm: null, views: 20 }] : [])
            : table === "client_source_stats" ? [{ retired: false }, { retired: true }]
            : table === "client_experiments" ? [{ id: "caption-question-v1", winner_arm: null }]
            : table === "leader_accounts" ? [{ id: "l1", handle: "tradvio", active: true }] : [];
          return Promise.resolve({ data: rows, error: null }).then(res);
        },
      };
      return q;
    },
  } as any;
}

test("loadLearning scopes every query to the client and summarises posts, sources, experiments and leaders", async () => {
  const log: any[] = [];
  const s = await loadLearning(fakeDb(log), { id: "org-a", name: "A", slug: "a" });
  assert.equal(s.posts.scored, 1500, "exact count, not the capped row fetch"); assert.equal(s.posts.with_arm, 1200); assert.equal(s.posts.median_views, 20);
  assert.deepEqual({ total: s.sources.total, retired: s.sources.retired }, { total: 2, retired: 1 });
  assert.equal(s.experiments[0].id, "caption-question-v1"); assert.equal(s.leaders[0].handle, "tradvio");
  assert.equal(s.last_run?.posts_scored, 862);
  const tables = log.filter((l) => l[0] !== "rpc");
  assert.ok(tables.length >= 9);
  assert.ok(tables.every((l) => l[1].org_id === "org-a"), "every query carries the client id");
  const other = await loadLearning(fakeDb([]), { id: "org-b", name: "B", slug: "b" });
  assert.equal(other.posts.scored, 0);
});

test("learningTick calls the gated refresh and surfaces a database error", async () => {
  const log: any[] = [];
  assert.deepEqual(await learningTick(fakeDb(log)), { refreshed: [], skipped: 1 });
  assert.deepEqual(log, [["rpc", "client_learning_refresh", { p_force: false }]]);
  const bad: any = { rpc: async () => ({ data: null, error: { message: "function client_learning_refresh does not exist" } }) };
  await assert.rejects(() => learningTick(bad), /client_learning_refresh: function/);
});
