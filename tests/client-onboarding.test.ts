import test from "node:test";
import assert from "node:assert/strict";
import { classifyLink, extractFromText, pickTopPosts, tiktokMediaUrl, instagramMediaUrl, etaHours, processIntake } from "../src/client-onboarding.js";

test("links are classified: profiles, posts, short links, sheets, files; the rest is kept as a plain link", () => {
  assert.deepEqual(classifyLink("https://www.instagram.com/reel/DefvGGYDfVb/?igsh=abc"), { kind: "post_instagram", value: "https://www.instagram.com/reel/DefvGGYDfVb/", label: "DefvGGYDfVb" });
  assert.deepEqual(classifyLink("instagram.com/Tradvio"), { kind: "profile_instagram", value: "tradvio", label: "@tradvio" });
  assert.equal(classifyLink("https://www.instagram.com/explore/")?.kind, "link");
  assert.deepEqual(classifyLink("https://www.tiktok.com/@tradvio/video/7690385402015878431?utm=x"), { kind: "post_tiktok", value: "https://www.tiktok.com/@tradvio/video/7690385402015878431", label: "7690385402015878431" });
  assert.deepEqual(classifyLink("https://vm.tiktok.com/ZMabc12/"), { kind: "post_tiktok", value: "https://vm.tiktok.com/ZMabc12", label: "short link" });
  assert.deepEqual(classifyLink("tiktok.com/@Pfeiftrades"), { kind: "profile_tiktok", value: "pfeiftrades", label: "@pfeiftrades" });
  assert.equal(classifyLink("https://docs.google.com/spreadsheets/d/1AbC_dEf/edit#gid=42")?.value, "https://docs.google.com/spreadsheets/d/1AbC_dEf/export?format=csv&gid=42");
  assert.equal(classifyLink("https://cdn.example.com/clips/intro.MP4")?.kind, "video_file");
  assert.equal(classifyLink("https://example.com/list.csv")?.kind, "csv");
  assert.equal(classifyLink("https://youtube.com/watch?v=1")?.kind, "link");
  assert.equal(classifyLink("@someone")?.label, "handle without a platform");
  assert.equal(classifyLink("   "), null);
});

test("text, CSV and sheet exports give up every link once, and @handles when the line names the platform", () => {
  const csv = 'handle,platform,link\n@tradvio,instagram,https://www.instagram.com/reel/DefvGGYDfVb/\n@pfeiftrades,TikTok,\n,,"https://www.instagram.com/reel/DefvGGYDfVb/"\nnotes,,see docs.google.com/spreadsheets/d/XYZ/edit';
  const found = extractFromText(csv);
  assert.deepEqual(found.map((c) => `${c.kind}:${c.value}`), [
    "post_instagram:https://www.instagram.com/reel/DefvGGYDfVb/",
    "sheet:https://docs.google.com/spreadsheets/d/XYZ/export?format=csv",
    "profile_instagram:tradvio",
    "profile_tiktok:pfeiftrades",
  ]);
});

test("top posts: by views, deduplicated, ties by recency; media URLs come from the documented fields", () => {
  const p = (id: string, views: number | null, at: string) => ({ platform_post_id: id, post_link: `https://x/${id}`, posted_at: at, caption: null, video_views: views, likes: null, comments: null, shares: null, saves: null, pinned: false });
  const top = pickTopPosts([p("a", 10, "2026-01-01"), p("b", 500, "2026-01-02"), p("b", 500, "2026-01-02"), p("c", null, "2026-03-01"), p("d", 10, "2026-02-01")], 3);
  assert.deepEqual(top.map((t) => t.platform_post_id), ["b", "d", "a"]);
  assert.equal(tiktokMediaUrl({ aweme_detail: { video: { has_watermark: true, download_no_watermark_addr: { url_list: ["https://nw"] }, play_addr: { url_list: ["https://play"] } } } }), "https://nw");
  assert.equal(tiktokMediaUrl({ aweme_detail: { video: { has_watermark: false, play_addr: { url_list: ["https://play"] } } } }), "https://play");
  assert.equal(tiktokMediaUrl({}), null);
  assert.equal(instagramMediaUrl({ data: { xdt_shortcode_media: { video_url: "https://ig/v.mp4" } } }), "https://ig/v.mp4");
  assert.equal(instagramMediaUrl({ data: { video_url: "nope" } }), null);
  assert.equal(etaHours(0, 300), 0); assert.equal(etaHours(150, 300), 0.5); assert.equal(etaHours(150, 0), null);
});

test("processIntake reads a CSV item into child items, pulls a profile's top posts, and downloads a post into the client's library", async () => {
  const items: any[] = [
    { id: "i1", batch_id: "b1", org_id: "org", kind: "csv", value: "https://files.example/list.csv", label: "list.csv", parent_id: null, status: "queued", meta: {}, attempts: 0, created_at: "1" },
  ];
  const sources: any[] = [], uploads: string[] = [], plans: string[] = [];
  const sb: any = {
    from(table: string) {
      const q: any = { _t: table, _f: {} as any, _in: null as any, _limit: 0, _patch: null as any, _ins: null as any, _single: false, _head: false,
        select(cols: string, opts?: any) { q._head = !!opts?.head; return q }, eq(k: string, v: any) { q._f[k] = v; return q }, lt() { return q }, in(k: string, v: any[]) { q._in = [k, v]; return q }, order() { return q }, limit(n: number) { q._limit = n; return q }, maybeSingle() { q._single = true; return q }, single() { q._single = true; return q },
        update(p: any) { q._patch = p; return q }, insert(rows: any) { q._ins = rows; return q },
        then(res: any) {
          let out: any = { data: [], error: null };
          if (table === "client_intake_items") {
            if (q._ins) { const rows = (Array.isArray(q._ins) ? q._ins : [q._ins]).map((r: any, i: number) => ({ id: `n${items.length + i}`, status: "queued", meta: {}, attempts: 0, parent_id: null, created_at: String(items.length + i), ...r })); items.push(...rows); out = { data: rows, error: null }; }
            else if (q._patch) { const it = items.find((x) => x.id === q._f.id); Object.assign(it, q._patch); out = { data: it, error: null }; }
            else { let rows = items.filter((x) => Object.entries(q._f).every(([k, v]) => x[k] === v)); if (q._in) rows = rows.filter((x) => q._in[1].includes(x[q._in[0]])); if (q._limit) rows = rows.slice(0, q._limit); out = { data: rows, error: null }; }
          } else if (table === "client_intake_batches") out = { data: { top_n: 2 }, error: null };
          else if (table === "library_sources") { if (q._ins) { sources.push(q._ins); out = { data: null, error: null }; } else out = { data: sources.find((s) => s.sha256 === q._f.sha256) ?? null, error: null }; }
          else if (table === "client_account_setup") out = { data: [{ publer_account_id: "6ac5ae5e3b21bda2e54a8eec", status: "rendering" }], error: null };
          else if (table === "publer_account_ownership") out = { data: [{ publer_account_id: "6ac5ae5e3b21bda2e54a8eec", owner_user_id: "owner" }], error: null };
          return Promise.resolve(out).then(res);
        } };
      return q;
    },
    storage: { from() { return { upload: async (key: string) => { uploads.push(key); return { data: {}, error: null }; } }; } },
    rpc: async (name: string, args: any) => { plans.push(`${name}:${args.p_account}`); return { data: 3, error: null }; },
  };
  const f: any = async (url: string) => {
    if (url.endsWith("list.csv")) return { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from("site,link\nIG,https://www.instagram.com/tradvio\n") };
    if (url.includes("/v2/instagram/user/posts")) return { ok: true, status: 200, json: async () => ({ items: [{ code: "AAAAA", product_type: "clips", play_count: 50 }, { code: "BBBBB", product_type: "clips", play_count: 900 }, { code: "CCCCC", product_type: "clips", play_count: 400 }], more_available: false }) };
    if (url.includes("/v1/instagram/post")) return { ok: true, status: 200, json: async () => ({ data: { xdt_shortcode_media: { video_url: "https://cdn/v.mp4", owner: { username: "tradvio" } } } }) };
    if (url === "https://cdn/v.mp4") return { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from("fake video bytes") };
    throw new Error("unexpected " + url);
  };
  const deps = { fetch: f, apiKey: "k", log: () => {} };
  assert.equal(await processIntake(sb, deps, 1), 1);                       // the CSV
  assert.equal(items.find((i) => i.id === "i1").status, "saved");
  assert.deepEqual(items.filter((i) => i.parent_id === "i1").map((i) => `${i.kind}:${i.value}`), ["profile_instagram:tradvio"]);
  assert.equal(await processIntake(sb, deps, 1), 1);                       // the profile -> top 2 posts
  const posts = items.filter((i) => i.kind === "post_instagram").map((i) => i.value);
  assert.deepEqual(posts, ["https://www.instagram.com/reel/BBBBB/", "https://www.instagram.com/reel/CCCCC/"]);
  assert.equal(await processIntake(sb, deps, 1), 1);                       // first post -> downloaded, hashed, stored, planned
  assert.equal(sources.length, 1); assert.equal(sources[0].org_id, "org"); assert.match(sources[0].source.object_key, /^originals\/[a-f0-9]{64}\.mp4$/);
  assert.deepEqual(uploads, [sources[0].source.object_key]);
  assert.deepEqual(plans, ["library_plan:6ac5ae5e3b21bda2e54a8eec"]);
  assert.equal(items.find((i) => i.value === posts[0]).status, "saved");
});
