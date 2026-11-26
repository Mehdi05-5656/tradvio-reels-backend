import test from "node:test";
import assert from "node:assert/strict";
import { productResults } from "../src/studio-product-results.js";

// a tiny in-memory stand-in for the query builder: eq / in / gte / limit on plain and JSON paths
function fakeDb(tables: Record<string, any[]>) {
  const get = (row: any, path: string) => path.split(/->>?/).reduce((v: any, k) => (v == null ? undefined : v[k]), row);
  return { from(t: string) {
    const f: Array<(r: any) => boolean> = [];
    const q: any = { select: () => q, limit: () => q,
      eq: (c: string, v: any) => (f.push((r) => String(get(r, c)) === String(v)), q),
      in: (c: string, vs: any[]) => (f.push((r) => vs.map(String).includes(String(get(r, c)))), q),
      gte: (c: string, v: any) => (f.push((r) => String(get(r, c)) >= String(v)), q),
      then: (ok: any) => ok({ data: (tables[t] ?? []).filter((r) => f.every((x) => x(r))), error: null }) };
    return q;
  } } as any;
}
const U = "u1", P = "pppppppp-pppp-4ppp-8ppp-pppppppppppp", T = "2026-11-26T10:00:00Z";

test("posts are traced to the product piece they came from, whatever the route to posting, best first", async () => {
  const db = fakeDb({
    studio_jobs: [
      { id: "hookA", user_id: U, tool: "instrument", status: "done", created_at: T, options: { product: P, hook: { line: "Everyone thinks energy drinks need sugar.", cast: "lena" }, look_title: "Hook · Standard" } },
      { id: "hookB", user_id: U, tool: "instrument", status: "done", created_at: T, options: { product: P, hook: { line: "Todos creen que...", language: "es" }, look_title: "Hook · Standard · Spanish" } },
      { id: "ad1", user_id: U, tool: "instrument", status: "done", created_at: T, options: { product: P, ad: {}, look_title: "Full ad · 15 s" } },
      { id: "other", user_id: U, tool: "instrument", status: "done", created_at: T, options: { product: "another", hook: { line: "x" } } },
      { id: "cap1", user_id: U, tool: "captions", status: "done", created_at: "2026-11-27T00:00:00Z", options: { items: [{ asset_id: "adCopy" }] } },
    ],
    studio_assets: [
      { id: "adCopy", user_id: U, probe: { derived_from_job: "ad1" } },
      { id: "adCaptioned", user_id: U, probe: { captions: { from: "adCopy", job_id: "cap1" } } },
    ],
    studio_perf_posts: [
      { user_id: U, platform: "tiktok", url: "t/1", views: 1200, likes: 80, shares: 4, job_id: "hookA", asset_id: null },
      { user_id: U, platform: "tiktok", url: "t/2", views: 9000, likes: 700, shares: 50, job_id: "cap1", asset_id: null },
      { user_id: U, platform: "instagram", url: "i/3", views: 3000, likes: 90, shares: 2, job_id: null, asset_id: "adCaptioned" },
      { user_id: U, platform: "tiktok", url: "t/4", views: 50, likes: 1, shares: 0, job_id: null, asset_id: "adCopy" },
      { user_id: U, platform: "tiktok", url: "t/5", views: 99999, likes: 1, shares: 0, job_id: "other", asset_id: null },
      { user_id: "someone-else", platform: "tiktok", url: "t/6", views: 99999, job_id: "hookA", asset_id: null },
    ],
  });
  const r = await productResults(db, U, P);
  assert.deepEqual(r.map((x) => [x.job_id, x.views, x.posts.length]), [["ad1", 12050, 3], ["hookA", 1200, 1]]);
  assert.equal(r[0].kind, "ad"); assert.equal(r[1].line, "Everyone thinks energy drinks need sugar."); assert.equal(r[1].cast, "lena");
  assert.ok(!r.some((x) => x.job_id === "hookB"), "a piece never posted has no results");
  assert.deepEqual(await productResults(fakeDb({ studio_jobs: [] }), U, P), []);
});
