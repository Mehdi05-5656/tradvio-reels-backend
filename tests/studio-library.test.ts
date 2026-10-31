import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyImportLink, linksInText, quoteImport, privateAddress, safeTarget, fetchDirectVideo, sheetCsvUrl, readSheet, runImportJob, registerLibrary, linkCredits, MAX_IMPORT_LINKS } from "../src/studio-library.js";
import { ClipsError } from "../src/studio-clips.js";
import { PLANS } from "../src/studio.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENV = { SCRAPECREATORS_API_KEY: "k" };

test("links: what each one is; profiles, playlists and pages are turned away with a reason", () => {
  const ok = (u: string) => { const c = classifyImportLink(u); return "kind" in c ? c.kind : `no: ${c.reason}`; };
  assert.equal(ok("https://www.tiktok.com/@ann/video/7302469865352793358?is_from_webapp=1"), "tiktok");
  assert.equal(ok("https://vm.tiktok.com/ZMabc123/"), "tiktok");
  assert.match(ok("https://www.tiktok.com/@ann"), /profile/);
  assert.equal(ok("https://www.instagram.com/reel/C9xYz_AbCd/"), "instagram");
  assert.match(ok("https://www.instagram.com/ann.creates/"), /profile/);
  assert.equal(ok("https://youtube.com/shorts/abcdefghijk"), "youtube");
  assert.equal(ok("https://youtu.be/L_Guz73e6fw"), "youtube");
  assert.match(ok("https://www.youtube.com/@lexfridman"), /channel/);
  assert.equal(ok("https://cdn.example.com/a/clip.MP4"), "file");
  assert.match(ok("http://cdn.example.com/a/clip.mp4"), /https only/);
  assert.match(ok("https://example.com/about"), /not a TikTok/);
  const drop = classifyImportLink("https://www.dropbox.com/s/abc/clip.mp4?dl=0") as any;
  assert.equal(new URL(drop.url).searchParams.get("dl"), "1", "Dropbox share links download directly");
  const drive = classifyImportLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing") as any;
  assert.equal(drive.url, "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp&export=download&confirm=t");
  assert.deepEqual(linksInText(`url,views\n"https://www.tiktok.com/@a/video/1",3\nhttps://youtu.be/L_Guz73e6fw).\nhttps://www.tiktok.com/@a/video/1`), ["https://www.tiktok.com/@a/video/1", "https://youtu.be/L_Guz73e6fw"]);
});

test("import quotes: per link by kind, duplicates once, the reasons for the rest, at most 500", () => {
  const q = quoteImport(ENV, PLANS, { links: ["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/@a/video/1", "https://youtu.be/L_Guz73e6fw", "https://cdn.x.com/v.mp4", "https://www.tiktok.com/@a", "junk"], name: "  Spring batch " });
  assert.deepEqual(q.options.counts, { tiktok: 1, instagram: 0, youtube: 1, file: 1 });
  assert.equal(q.options.rejected.length, 2);
  assert.equal(q.options.name, "Spring batch");
  assert.equal(q.credits, linkCredits("tiktok", ENV, PLANS) + linkCredits("youtube", ENV, PLANS) + linkCredits("file", ENV, PLANS));
  assert.ok(linkCredits("youtube", { ...ENV, STUDIO_YT_PROXY: "http://p" }, PLANS) > linkCredits("youtube", ENV, PLANS), "YouTube through a proxy costs its bytes");
  assert.throws(() => quoteImport(ENV, PLANS, { links: ["junk"] }), (e: any) => e.code === "no_links");
  const many = Array.from({ length: 520 }, (_, k) => `https://www.tiktok.com/@a/video/${k}`);
  const big = quoteImport(ENV, PLANS, { links: many });
  assert.equal(big.options.links.length, MAX_IMPORT_LINKS);
  assert.equal(big.options.rejected.length, 20);
});

test("files from the open web: public https only, checked at every redirect; an MP4 or MOV by its bytes; size-capped", async () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.1.1.1"]) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.equal(privateAddress(ip), false, ip);
  const resolve = async (h: string) => (h === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
  await assert.rejects(safeTarget("https://evil.example/x.mp4", resolve), (e: any) => e.code === "link_unsafe");
  await assert.rejects(safeTarget("https://169.254.169.254/latest", resolve), (e: any) => e.code === "link_unsafe");
  await assert.rejects(safeTarget("https://u:p@cdn.example/x.mp4", resolve), (e: any) => e.code === "link_unsafe");
  const dir = await mkdtemp(join(tmpdir(), "lib-test-"));
  try {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(100)]);
    const fetchOk: any = async (url: string) => (url.includes("/start") ? new Response(null, { status: 302, headers: { location: "https://cdn.example/final.mp4" } }) : new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }));
    assert.equal(await fetchDirectVideo("https://cdn.example/start", join(dir, "a.mp4"), { fetch: fetchOk, resolve }), mp4.length);
    const toPrivate: any = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.mp4" } });
    await assert.rejects(fetchDirectVideo("https://cdn.example/start", join(dir, "b.mp4"), { fetch: toPrivate, resolve }), (e: any) => e.code === "link_unsafe", "a redirect to a private address is refused");
    const page: any = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await assert.rejects(fetchDirectVideo("https://cdn.example/x", join(dir, "c.mp4"), { fetch: page, resolve }), (e: any) => e.code === "link_no_media");
    const notVideo: any = async () => new Response(Buffer.from("PK\u0003\u0004 not a video at all"), { status: 200, headers: { "content-type": "application/octet-stream" } });
    await assert.rejects(fetchDirectVideo("https://cdn.example/x", join(dir, "d.mp4"), { fetch: notVideo, resolve }), (e: any) => e.code === "link_no_media");
    const huge: any = async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(9e9) } });
    await assert.rejects(fetchDirectVideo("https://cdn.example/x", join(dir, "e.mp4"), { fetch: huge, resolve }), (e: any) => e.code === "link_too_large");
    await assert.rejects(fetchDirectVideo("https://cdn.example/x", join(dir, "f.mp4"), { fetch: fetchOk, resolve, maxBytes: 50 }), (e: any) => e.code === "link_too_large", "a stream without a length is cut off at the cap");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Google Sheets: read as CSV when shared; a private sheet says how to share it", async () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=42"), "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=42");
  assert.equal(sheetCsvUrl("https://example.com/sheet"), null);
  const shared: any = async () => new Response("link\nhttps://www.tiktok.com/@a/video/1\nhttps://www.tiktok.com/@a/video/2\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="Spring - Sheet1.csv"' } });
  assert.deepEqual(await readSheet("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", shared), { links: ["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/@a/video/2"], title: "Spring" });
  const login: any = async () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(readSheet("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", login), (e: any) => e.code === "sheet_private");
  const empty: any = async () => new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } });
  await assert.rejects(readSheet("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", empty), (e: any) => e.code === "no_links");
});

// ---------------------------------------------------------------------------------------------------
// A small Supabase stand-in for the routes and the run
// ---------------------------------------------------------------------------------------------------
function fakeSb(t: Record<string, any[]>) {
  const calls: any[] = [], removed: string[] = [];
  const sb: any = {
    calls, removed,
    rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return fn === "studio_create_job" ? { data: { id: "newjob", status: "queued" }, error: null } : { data: true, error: null }; },
    storage: { from: (bucket: string) => ({
      remove: async (keys: string[]) => { removed.push(...keys.map((k) => `${bucket}/${k}`)); return { data: [], error: null }; },
      createSignedUrls: async (keys: string[]) => ({ data: keys.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
      download: async (k: string) => (k.endsWith("plan.txt") && t.__plans?.some((p: any) => p.key === k) ? { data: new Blob([JSON.stringify(t.__plans.find((p: any) => p.key === k).plan)]), error: null } : { data: null, error: { message: "nf" } }),
    }) },
    from(table: string) {
      const rows = () => (t[table] ??= []);
      const f: Array<(r: any) => boolean> = []; let op: any = null, one = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { f.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { f.push((r) => r[k] !== v); return q; },
        in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; }, is(k: string, v: any) { f.push((r) => (r[k] ?? null) === v); return q; },
        maybeSingle() { one = true; return q; }, single() { one = true; return q; },
        insert(v: any) { op = { k: "insert", v }; return q; }, update(v: any) { op = { k: "update", v }; return q; }, delete() { op = { k: "delete" }; return q; },
        then(res: any, rej: any) {
          let out: any[] = [];
          if (op?.k === "insert") { const v = { id: `c${rows().length + 1}000000-0000-4000-8000-000000000000`.slice(0, 36), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: {}, note: null, job_id: null, ...op.v }; rows().push(v); out = [v]; }
          else if (op?.k === "update") { out = rows().filter((r) => f.every((x) => x(r))); for (const r of out) Object.assign(r, op.v); }
          else if (op?.k === "delete") { t[table] = rows().filter((r) => !f.every((x) => x(r))); }
          else out = rows().filter((r) => f.every((x) => x(r)));
          return Promise.resolve({ data: one ? out[0] ?? null : out, error: null }).then(res, rej);
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
  registerLibrary(app, {
    sbFn: () => sb, env: ENV, plans: PLANS, log: () => {},
    requireUser: (req: any, res: any) => req.auth?.user_id ?? (res.status(401).json({ error: "unauthorized" }), null),
    fail: (res: any, e: any) => res.status(e instanceof ClipsError ? e.status : 500).json({ error: e?.code ?? "x", detail: e?.message }),
    withPosterUrls: async (_sb: any, a: any[]) => a.map((x) => ({ ...x, poster_url: null })),
  });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, user = U) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  return { server, call };
}
const A1 = "11111111-1111-4111-8111-111111111111", A2 = "22222222-2222-4222-8222-222222222222", A3 = "33333333-3333-4333-8333-333333333333";

test("collections: make a folder, move files in, list with counts and posters, rename; only your own; delete keeps or removes the files", async () => {
  const t: Record<string, any[]> = {
    studio_collections: [], studio_jobs: [],
    studio_assets: [
      { id: A1, user_id: U, kind: "video", name: "a.mp4", object_key: `${U}/${A1}.mp4`, status: "ready", probe: { poster_key: `${U}/assets/${A1}.jpg` }, collection_id: null, created_at: "2026-10-01" },
      { id: A2, user_id: U, kind: "video", name: "b.mp4", object_key: `${U}/${A2}.mp4`, status: "ready", probe: {}, collection_id: null, created_at: "2026-10-02" },
      { id: A3, user_id: OTHER, kind: "video", name: "theirs.mp4", object_key: `${OTHER}/${A3}.mp4`, status: "ready", probe: {}, collection_id: null, created_at: "2026-10-03" },
    ],
  };
  const sb = fakeSb(t);
  const { server, call } = await serve(sb);
  try {
    const made = await call("POST", "/api/studio/collections", { name: "  Spring   drops " });
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.collection.name, made.body.collection.kind, made.body.collection.asset_count], ["Spring drops", "folder", 0]);
    const id = made.body.collection.id;
    assert.equal((await call("POST", "/api/studio/assets/move", { ids: [A1, A2, A3], collection_id: id })).body.moved, 2, "someone else's file is not moved");
    const list = await call("GET", "/api/studio/collections");
    assert.equal(list.body.collections[0].asset_count, 2);
    assert.equal(list.body.collections[0].poster_url, `https://signed/${U}/assets/${A1}.jpg`);
    assert.equal((await call("GET", `/api/studio/collections/${id}`, undefined, OTHER)).status, 404, "not visible to anyone else");
    assert.equal((await call("PATCH", `/api/studio/collections/${id}`, { name: "Summer" })).body.collection.name, "Summer");
    const one = await call("GET", `/api/studio/collections/${id}`);
    assert.deepEqual(one.body.assets.map((a: any) => a.id), [A1, A2]);
    assert.equal((await call("PATCH", `/api/studio/assets/${A2}`, { collection_id: null, name: "renamed/clip?.mp4" })).body.asset.name, "renamed clip .mp4");
    assert.equal((await call("DELETE", `/api/studio/collections/${id}`)).body.files_deleted, 0);
    assert.equal(t.studio_assets.find((a) => a.id === A1)!.collection_id, null, "without with_files the files become loose");
    const again = (await call("POST", "/api/studio/collections", { name: "Bin" })).body.collection.id;
    await call("POST", "/api/studio/assets/move", { ids: [A1], collection_id: again });
    assert.equal((await call("DELETE", `/api/studio/collections/${again}?with_files=1`)).body.files_deleted, 1);
    assert.equal(t.studio_assets.find((a) => a.id === A1)!.status, "deleted");
    assert.ok(sb.removed.includes(`studio-uploads/${U}/${A1}.mp4`) && sb.removed.includes(`studio-outputs/${U}/assets/${A1}.jpg`));
    assert.equal((await call("POST", "/api/studio/assets/delete", { ids: [] })).body.error, "ids_required");
  } finally { server.close(); }
});

test("a run in progress cannot be deleted; a stale processing state is settled from its job; a YouTube run waiting for the file takes the upload", async () => {
  const COL = "c1000000-0000-4000-8000-000000000000", UP = "44444444-4444-4444-8444-444444444444";
  const t: Record<string, any[]> = {
    studio_jobs: [{ id: "j1", status: "running", progress: { stage: "cutting", done: 3, total: 9, message: "Cutting clip 4 of 9" } }],
    studio_collections: [{ id: COL, user_id: U, name: "Show", kind: "clips", status: "processing", source: { platform: "youtube", seconds: 1200, format: "vertical", length: "standard" }, job_id: "j1", note: null, created_at: "x", updated_at: "x" }],
    studio_assets: [{ id: UP, user_id: U, kind: "video", status: "ready", probe: { duration: 1201 } }],
    __plans: [{ key: `${U}/clips/${COL}/plan.txt`, plan: { seconds: 1200, moments: [{ rank: 1 }, { rank: 2 }, { rank: 3 }] } }],
  };
  const sb = fakeSb(t);
  const { server, call } = await serve(sb);
  try {
    const c = (await call("GET", `/api/studio/collections/${COL}`)).body.collection;
    assert.deepEqual(c.progress, { stage: "cutting", done: 3, total: 9, message: "Cutting clip 4 of 9" });
    assert.equal((await call("DELETE", `/api/studio/collections/${COL}`)).body.error, "collection_busy");
    t.studio_jobs[0].status = "failed";
    assert.equal((await call("GET", "/api/studio/collections")).body.collections[0].status, "failed", "a job that died without saying so is settled");
    assert.equal((await call("POST", `/api/studio/collections/${COL}/source`, { asset_id: UP })).body.error, "collection_not_waiting");
    t.studio_collections[0].status = "needs_file";
    t.studio_assets[0].probe.duration = 900;
    assert.equal((await call("POST", `/api/studio/collections/${COL}/source`, { asset_id: UP })).body.error, "source_mismatch", "a different video is refused");
    t.studio_assets[0].probe.duration = 1201;
    const r = await call("POST", `/api/studio/collections/${COL}/source`, { asset_id: UP });
    assert.equal(r.status, 201);
    const job = sb.calls.find((x: any) => x.fn === "studio_create_job").args;
    assert.deepEqual([job.p_tool, job.p_asset, job.p_options.plan_from, job.p_options.platform], ["clips", UP, COL, "upload"]);
    assert.equal(t.studio_collections[0].status, "processing");
  } finally { server.close(); }
});

test("an import run: each link into the collection, charged per link brought in, failures listed and refunded, a full library stops it", async () => {
  const t: Record<string, any[]> = { studio_collections: [{ id: "col", user_id: U, status: "processing" }] };
  const sb = fakeSb(t);
  const links = [{ url: "https://www.tiktok.com/@a/video/1", kind: "tiktok" }, { url: "https://www.tiktok.com/@a/video/2", kind: "tiktok" }, { url: "https://youtu.be/L_Guz73e6fw", kind: "youtube" }, { url: "https://cdn.x/v.mp4", kind: "file" }];
  const got: string[] = [];
  const deps: any = { env: ENV, plans: PLANS, log: () => {},
    social: async (_sb: any, _u: string, url: string, col: string) => { assert.equal(col, "col"); if (url.endsWith("/2")) throw new Error("private video"); got.push(url); return { asset_id: "x", seconds: 40 }; },
    file: async (_sb: any, _u: string, url: string) => { got.push(url); return { asset_id: "y" }; } };
  const job: any = { id: "j", user_id: U, lease_token: "t", credits_reserved: 100, progress: {}, attempts: 1, options: { collection_id: "col", links } };
  assert.equal(await runImportJob(sb, deps, job), "done");
  assert.equal(got.length, 3);
  const charged = sb.calls.find((c: any) => c.fn === "studio_complete").args.p_credits_charged;
  assert.equal(charged, linkCredits("tiktok", ENV, PLANS) + linkCredits("youtube", ENV, PLANS, 40) + linkCredits("file", ENV, PLANS));
  assert.match(t.studio_collections[0].note, /1 of 4 could not be brought in.*private video/);
  assert.equal(t.studio_collections[0].status, "ready");
  // storage full: stops, keeps what came in
  const t2: Record<string, any[]> = { studio_collections: [{ id: "col", user_id: U, status: "processing" }] };
  const sb2 = fakeSb(t2);
  let n = 0;
  const deps2: any = { ...deps, social: async () => { n++; if (n > 1) throw Object.assign(new Error("Your plan stores up to 10 GB"), { code: "storage_full" }); return { asset_id: "x", seconds: null }; } };
  assert.equal(await runImportJob(sb2, deps2, { ...job, options: { collection_id: "col", links: links.slice(0, 2) } }), "done");
  assert.match(t2.studio_collections[0].note, /Stopped early: Your plan stores up to 10 GB/);
});
