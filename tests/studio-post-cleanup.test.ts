import test from "node:test";
import assert from "node:assert/strict";
import { resetCursor, sweepPosted } from "../src/studio-post-cleanup.js";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
function fakeSb(tables: Record<string, any[]>) {
  const removed: string[] = [];
  const sb: any = {
    tables, removed,
    storage: { from: () => ({ remove: async (keys: string[]) => { removed.push(...keys); return { error: null }; } }) },
    from(table: string) {
      const f: ((r: any) => boolean)[] = []; let maybe = false, pending: any = null;
      const q: any = {
        select() { return q; }, limit() { return q; }, order() { return q; },
        eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { f.push((r) => r[k] !== v); return q; },
        in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; }, gte(k: string, v: any) { f.push((r) => r[k] >= v); return q; },
        not(k: string, _o: string, _v: any) { f.push((r) => r[k] != null); return q; }, maybeSingle() { maybe = true; return q; },
        update(v: any) { pending = v; return q; },
        then(res: any, rej: any) { const rows = (tables[table] ?? []).filter((r) => f.every((x) => x(r))); if (pending) for (const r of rows) Object.assign(r, pending); return Promise.resolve({ data: maybe ? rows[0] ?? null : rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
  return sb;
}

test("delete after posting: an upload whose posts all went out goes; one still waited on, failed, in a Clips set, or with the setting off stays", async () => {
  const now = Date.now(), at = new Date(now - 3600_000).toISOString();
  const asset = (id: string, user = ANN, col: string | null = null) => ({ id, user_id: user, status: "ready", object_key: `${user}/${id}.mp4`, probe: {}, collection_id: col });
  const tables: Record<string, any[]> = {
    studio_social_posts: [
      { user_id: ANN, asset_id: "a1", status: "posted", updated_at: at },
      { user_id: ANN, asset_id: "a2", status: "posted", updated_at: at }, { user_id: ANN, asset_id: "a2", status: "scheduled", updated_at: at },
      { user_id: ANN, asset_id: "a3", status: "posted", updated_at: at }, { user_id: ANN, asset_id: "a3", status: "failed", updated_at: at },
      { user_id: ANN, asset_id: "a4", status: "posted", updated_at: at },
      { user_id: ANN, asset_id: "old", status: "posted", updated_at: new Date(now - 10 * 86400_000).toISOString() },
      { user_id: BOB, asset_id: "b1", status: "posted", updated_at: at },
      { user_id: ANN, asset_id: "onboard", status: "posted", updated_at: at },
    ],
    studio_assets: [asset("a1"), asset("a2"), asset("a3"), asset("a4", ANN, "clipset"), asset("old"), asset("b1", BOB), asset("onboard")],
    studio_post_drafts: [{ user_id: ANN, kind: "draft", payload: { rows: [{ pick: { asset_id: "onboard" } }] } }],
    studio_post_projects: [],
    studio_collections: [{ id: "clipset", user_id: ANN, kind: "clips" }],
    studio_social_prefs: [{ user_id: BOB, delete_after_post: false }],
    studio_jobs: [], studio_projects: [],
  };
  const sb = fakeSb(tables);
  resetCursor();
  assert.equal(await sweepPosted(sb, () => {}, now, {}), 0, "off until switched on");
  const ENV = { STUDIO_DELETE_AFTER_POST_FROM: new Date(now - 2 * 86400_000).toISOString() };
  const n = await sweepPosted(sb, () => {}, now, ENV);
  assert.equal(n, 1);
  const st = (id: string) => tables.studio_assets.find((a) => a.id === id).status;
  assert.equal(st("a1"), "deleted", "posted everywhere: deleted (the setting is on by default)");
  assert.equal(st("a2"), "ready", "still scheduled on another post");
  assert.equal(st("a3"), "ready", "a failed post may be retried");
  assert.equal(st("a4"), "ready", "a Clips set keeps its videos");
  assert.equal(st("old"), "ready", "only recent posts are looked at");
  assert.equal(st("b1"), "ready", "turned off");
  assert.equal(st("onboard"), "ready", "a draft (or the tray, or a project board) still holds it");
  assert.deepEqual(sb.removed, [`${ANN}/a1.mp4`]);
  assert.equal(await sweepPosted(sb, () => {}, now, ENV), 0, "nothing twice");
});
