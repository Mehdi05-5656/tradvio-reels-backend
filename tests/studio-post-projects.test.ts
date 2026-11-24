import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanName, projectFor, registerPostProjects } from "../src/studio-post-projects.js";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
const G1 = "99999999-0000-4000-8000-000000000001";

function fakeSb(tables: Record<string, any[]>) {
  let ids = 0;
  const sb: any = {
    tables,
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let maybe = false, single = false, pending: any = null, head = false;
      const q: any = {
        select(_f?: string, o?: any) { if (o?.head) head = true; return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { pending = { op: "insert", v }; return q; },
        update(v: any) { pending = { op: "update", v }; return q; },
        delete() { pending = { op: "delete" }; return q; },
        then(resolve: any, reject: any) {
          const rows = (tables[table] ??= []);
          let out: any[];
          if (pending?.op === "insert") { const v = { id: `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`, created_at: new Date().toISOString(), ...pending.v }; rows.push(v); out = [v]; }
          else {
            out = rows.filter((r) => filters.every((f) => f(r)));
            if (pending?.op === "update") for (const r of out) Object.assign(r, pending.v);
            if (pending?.op === "delete") tables[table] = rows.filter((r) => !out.includes(r));
          }
          if (head) return Promise.resolve({ count: out.length, data: null, error: null }).then(resolve, reject);
          return Promise.resolve({ data: maybe || single ? (out[0] ?? null) : out, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return sb;
}
async function serve(sb: any) {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) req.auth = { user_id: u }; next(); });
  registerPostProjects(app, () => sb, { log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, user = ANN) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, close: () => server.close() };
}

test("names: trimmed to one line, 1 to 60 characters", () => {
  assert.equal(cleanName("  Block   Town\nseries "), "Block Town series");
  assert.equal(cleanName("x".repeat(80)).length, 60);
  assert.throws(() => cleanName("   "), (e: any) => e.code === "name_needed");
});

test("projects: made with a Library folder, only the person's own accounts kept, the board moved in, counts, rename renames the folder, delete keeps posts and videos", async () => {
  const tables: Record<string, any[]> = {
    studio_social_profiles: [{ user_id: ANN, accounts: [{ id: "acc-ig", platform: "instagram" }, { id: "acc-tt", platform: "tiktok" }] }],
    studio_social_groups: [{ id: G1, user_id: ANN }],
    studio_post_drafts: [{ id: "t1", user_id: ANN, kind: "tray", payload: { rows: [{ key: "a:1" }, { key: "a:2" }], nets: ["acc-ig"] } }],
    studio_social_posts: [],
  };
  const sb = fakeSb(tables);
  const s = await serve(sb);
  try {
    const made = await s.call("POST", "/api/studio/post-projects", { name: "Block Town", color: "violet", account_ids: ["acc-ig", "someone-else"], group_ids: [G1, "not-a-uuid"], from_tray: true });
    assert.equal(made.status, 201);
    const p = made.body.project;
    assert.deepEqual([p.name, p.color, p.account_ids, p.group_ids, p.videos], ["Block Town", "violet", ["acc-ig"], [G1], 2]);
    const folder = tables.studio_collections.find((c) => c.id === p.collection_id);
    assert.deepEqual([folder.name, folder.kind, folder.source.project], ["Block Town", "folder", true]);
    assert.deepEqual(tables.studio_post_drafts[0].payload.rows, [], "the general board starts empty");
    assert.deepEqual(tables.studio_post_drafts[0].payload.nets, ["acc-ig"], "its other settings kept");
    assert.deepEqual([tables.studio_post_projects[0].tray.nets, tables.studio_post_projects[0].tray.gids], [["acc-ig"], [G1]], "the moved board posts to the project's accounts, not All's");

    tables.studio_social_posts.push({ user_id: ANN, project_id: p.id, status: "scheduled" }, { user_id: ANN, project_id: p.id, status: "posted" }, { user_id: ANN, project_id: null, status: "posted" });
    const list = await s.call("GET", "/api/studio/post-projects");
    assert.deepEqual([list.body.projects.length, list.body.projects[0].up_next, list.body.projects[0].posted, list.body.projects[0].videos], [1, 1, 1, 2]);
    assert.equal(list.body.projects[0].tray, undefined, "the list never carries the boards");

    assert.equal((await s.call("PUT", `/api/studio/post-projects/${p.id}/tray`, { payload: { rows: [{ key: "a:3" }] } })).status, 200);
    assert.deepEqual((await s.call("GET", `/api/studio/post-projects/${p.id}`)).body.project.tray.rows, [{ key: "a:3" }]);
    assert.equal((await s.call("GET", "/api/studio/post-projects")).body.projects[0].videos, 1, "the count follows the board");
    assert.equal((await s.call("GET", `/api/studio/post-projects/${p.id}`, undefined, BOB)).status, 404, "someone else's project");
    assert.equal((await s.call("PUT", `/api/studio/post-projects/${p.id}/tray`, { payload: {} }, BOB)).status, 404);

    const ren = await s.call("PATCH", `/api/studio/post-projects/${p.id}`, { name: "Block Town S2", account_ids: ["acc-tt", "nope"] });
    assert.deepEqual([ren.body.project.name, ren.body.project.account_ids], ["Block Town S2", ["acc-tt"]]);
    assert.equal(folder.name, "Block Town S2");

    tables.studio_assets = [{ id: "as1", user_id: ANN, collection_id: p.collection_id }];
    assert.equal((await s.call("DELETE", `/api/studio/post-projects/${p.id}`)).status, 200);
    assert.equal(tables.studio_post_projects.length, 0);
    assert.ok(tables.studio_collections.some((c) => c.id === p.collection_id), "the folder stays unless asked");
    assert.equal(folder.source.project, false, "and stops being a project's folder");
    assert.equal(tables.studio_social_posts.length, 3, "posts stay");

    const p2 = (await s.call("POST", "/api/studio/post-projects", { name: "Two" })).body.project;
    tables.studio_assets.push({ id: "as2", user_id: ANN, collection_id: p2.collection_id });
    await s.call("DELETE", `/api/studio/post-projects/${p2.id}?folder=1`);
    assert.ok(!tables.studio_collections.some((c) => c.id === p2.collection_id), "folder=1: the folder goes");
    assert.equal(tables.studio_assets.find((a) => a.id === "as2").collection_id, null, "its videos stay in the Library, loose");
    assert.equal((await s.call("POST", "/api/studio/post-projects", { name: " " })).body.error, "name_needed");
  } finally { s.close(); }
});

test("a post's project: only the person's own", async () => {
  const sb = fakeSb({ studio_post_projects: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", user_id: ANN }] });
  assert.equal(await projectFor(sb, ANN, "aaaaaaaa-0000-4000-8000-000000000001"), "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(await projectFor(sb, BOB, "aaaaaaaa-0000-4000-8000-000000000001"), null);
  assert.equal(await projectFor(sb, ANN, "nope"), null);
});
