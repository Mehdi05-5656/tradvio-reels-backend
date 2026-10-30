import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { parseTikTokPosts, parseInstagramPosts, parseYouTubeShorts, analyze, refreshPerformance, postIdFromUrl, handleFor, fromProvider, type PostRow } from "../src/studio-performance.js";
import { retentionOf, metricsOf } from "../src/social-ayrshare.js";
import { cleanInsight, suggestionsFrom, chatBrief, insightHash } from "../src/studio-insights.js";
import { registerPerformance } from "../src/studio-performance-routes.js";
import { accountAccess } from "../src/account-access.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const DAY = 86400_000, NOW = Date.parse("2026-10-30T20:00:00Z");

test("public readers: TikTok (duration in ms or s), Instagram reels only, YouTube Shorts", () => {
  const tt = parseTikTokPosts({ aweme_list: [{ aweme_id: "7517114944362499342", desc: "hi", create_time: 1761800000, statistics: { play_count: 5000, digg_count: 300, comment_count: 20, share_count: 40, collect_count: 15 }, video: { duration: 23400, cover: { url_list: ["https://img/c.jpg"] } } }, { aweme_id: "x" }] }, "ann");
  assert.equal(tt.length, 1); assert.equal(tt[0].duration_s, 23.4); assert.equal(tt[0].saves, 15); assert.equal(tt[0].url, "https://www.tiktok.com/@ann/video/7517114944362499342");
  assert.equal(parseTikTokPosts({ aweme_list: [{ aweme_id: "7517114944362499343", statistics: {}, video: { duration: 31 } }] }, "ann")[0].duration_s, 31);
  const ig = parseInstagramPosts({ items: [{ media: { code: "DKKtpqaxg0C", taken_at: 1761800000, product_type: "clips", play_count: 9000, like_count: 400, comment_count: 12, video_duration: 18.2, image_versions2: { candidates: [{ url: "https://img/i.jpg" }] } } }, { code: "PHOTO12345", media_type: 1 }] });
  assert.equal(ig.length, 1, "photos are left out"); assert.equal(ig[0].views, 9000); assert.equal(ig[0].url, "https://www.instagram.com/reel/DKKtpqaxg0C/");
  const yt = parseYouTubeShorts({ shorts: [{ id: "VREVC0wXPfs", title: "t", viewCountInt: 17066, likeCountInt: 495, commentCountInt: 2, publishDate: "2026-04-22T00:00:00Z", thumbnail: "https://img/y.jpg" }] });
  assert.equal(yt[0].url, "https://www.youtube.com/shorts/VREVC0wXPfs"); assert.equal(yt[0].views, 17066);
  assert.equal(postIdFromUrl("youtube", "https://www.youtube.com/shorts/VREVC0wXPfs"), "VREVC0wXPfs");
  assert.equal(postIdFromUrl("instagram", "https://www.instagram.com/reel/DKKtpqaxg0C/"), "DKKtpqaxg0C");
  assert.equal(handleFor({ platform: "youtube", username: "Ann Makes", display_name: null, image_url: null, profile_url: null }), null, "a display name is not a handle");
  assert.equal(handleFor({ platform: "youtube", username: "@annmakes", display_name: null, image_url: null, profile_url: null }), "annmakes");
});

test("provider analytics: retention kept small with the 3-second hold; Instagram watch time in ms becomes seconds", () => {
  const r = retentionOf([{ second: 0, percentage: 100 }, { second: 1, percentage: 82 }, { second: 3, percentage: 61 }, { second: 10, percentage: 40 }, { second: 20, percentage: 22 }]);
  assert.equal(r.hold_3s, 0.61); assert.deepEqual(r.retention.find((x) => x[0] === 10), [10, 0.4]);
  const tt = metricsOf("tiktok", { videoViews: 1000, likeCount: 50, commentsCount: 4, shareCount: 9, reach: 800, averageTimeWatched: 7.5, fullVideoWatchedRate: 0.22, videoDuration: 18, videoViewRetention: [{ second: 3, percentage: 70 }], impressionSources: [{ impression_source: "For You", percentage: 0.81 }] });
  assert.equal(tt.extra.hold_3s, 0.7); assert.equal(tt.extra.fyp_share, 0.81); assert.equal(tt.duration_s, 18);
  assert.equal(metricsOf("instagram", { igReelsAvgWatchTimeCount: 6400, reachCount: 500 }).extra.avg_watch_s, 6.4);
  const p = fromProvider("tiktok", { platform: "tiktok", id: "abc", url: "https://www.tiktok.com/@ann/video/7517114944362499342", caption: "c", published_at: null, thumb_url: null, duration_s: 18, views: 1, likes: 1, comments: 1, shares: 1, saves: null, extra: { reach: 5, x: null } })!;
  assert.equal(p.platform_post_id, "7517114944362499342", "matched by the id in the link, like public reads"); assert.deepEqual(p.extra, { reach: 5, source: "provider" });
});

function post(i: number, over: Partial<PostRow> = {}): PostRow {
  return { id: `p${i}`, platform: "tiktok", platform_post_id: String(7_000_000 + i), url: `https://www.tiktok.com/@ann/video/${7_000_000 + i}`, caption: `post ${i}`, published_at: new Date(NOW - (i + 1) * DAY + 18 * 3600_000 - 20 * 3600_000).toISOString(), duration_s: 20, views: 1000, likes: 50, comments: 5, shares: 5, saves: 5, ...over };
}

test("analyze: each post against its own platform's median; facts only with 3 posts a group; Clone8 compared; watch metrics compared", () => {
  const rows: PostRow[] = [
    ...Array.from({ length: 8 }, (_, i) => post(i, { views: [1000, 1200, 800, 900, 1100, 1000, 950, 1050][i], duration_s: i < 4 ? 20 : 70, extra: { hold_3s: i < 2 ? 0.7 : 0.45 } })),
    post(8, { views: 6000, shares: 300, duration_s: 18, social_post_id: "s1", extra: { hold_3s: 0.78 } }), post(9, { views: 5000, duration_s: 22, social_post_id: "s2", extra: { hold_3s: 0.74 } }),
    { ...post(10), platform: "instagram", platform_post_id: "IGCODE1", url: "https://www.instagram.com/reel/IGCODE1/", views: 100 },
    { ...post(11), platform: "instagram", platform_post_id: "IGCODE2", url: "https://www.instagram.com/reel/IGCODE2/", views: 300 },
  ];
  const a = analyze(rows, [{ platform: "tiktok", day: "2026-10-01", followers: 1000 }, { platform: "tiktok", day: "2026-10-29", followers: 1400 }], { range_days: 28, now: NOW, offset_min: -420, platform: null });
  const p8 = a.posts.find((p) => p.id === "p8")!;
  assert.ok(p8.multiple! > 5, "6K views on a ~1K median"); assert.equal(a.top[0], "p8"); assert.ok(a.breakouts.includes("p8"));
  const ig = a.posts.find((p) => p.id === "p11")!; assert.equal(ig.multiple, 1.5, "Instagram is measured against Instagram");
  assert.equal(a.kpis.posts, 12); assert.equal(a.followers[0].delta, 400);
  assert.ok(a.facts.some((f) => /Made with Clone8: 2 posts/.test(f)), "Clone8 vs the rest");
  assert.ok(a.facts.some((f) => /^Length: Under 15 s|^Length: 15–30 s/.test(f)), "short beats long here");
  assert.ok(a.facts.some((f) => /Still watching at 3 seconds/.test(f)));
  assert.ok(a.facts.some((f) => /breakout/.test(f)));
  const few = analyze(rows.slice(0, 2), [], { range_days: 28, now: NOW, offset_min: 0, platform: null });
  assert.equal(few.facts.some((f) => /^Length|^Posting time|^Weekday/.test(f)), false, "two posts say nothing about groups");
  assert.notEqual(insightHash(a, null), insightHash(few, null));
});

test("insight cleaning keeps only real posts and tools; suggestions and the chat brief come from their data", () => {
  const a = analyze([post(1, { views: 9000 }), post(2), post(3), post(4)], [], { range_days: 28, now: NOW, offset_min: 0, platform: null });
  const ins = cleanInsight({ headline: "x".repeat(400), working: [{ title: "Short hooks", evidence: "e", why: "w", post_ids: ["p1", "nope"] }], not_working: [], moves: [{ title: "Make originals", detail: "d", tool: "blueprint", post_id: "p1", prompt: null }, { title: "Bad", detail: "d", tool: "hack" as any, post_id: null, prompt: null }, { title: "Ask", detail: "d", tool: "chat", post_id: "ghost", prompt: "Plan my week" }], sources: [{ label: "Mosseri", url: "https://x.example" }, { label: "bad", url: "javascript:alert(1)" }] }, new Set(a.posts.map((p) => p.id)));
  assert.equal(ins.headline.length, 180); assert.deepEqual(ins.working[0].post_ids, ["p1"]);
  assert.deepEqual(ins.moves.map((m) => m.tool), ["blueprint", "chat"]); assert.equal(ins.moves[1].post_id, null); assert.equal(ins.sources.length, 1);
  const sug = suggestionsFrom(a, ins);
  assert.match(sug[0].prompt, /Make 10 originals of my TikTok "post 1" \(https:\/\/www\.tiktok\.com/);
  assert.ok(sug.some((s) => s.prompt === "Plan my week"));
  assert.ok(chatBrief(a, ins).some((l) => /Their best recent posts/.test(l)));
  assert.deepEqual(suggestionsFrom(null, null), []);
});

// ---------------------------------------------------------------------------------------------------
function fakeSb(tables: Record<string, any[]>) {
  const uploads: string[] = [];
  const keyOf: Record<string, string[]> = { studio_perf_posts: ["user_id", "platform", "platform_post_id"], studio_perf_accounts: ["user_id", "platform"], studio_perf_snapshots: ["user_id", "platform", "day"] };
  const sb: any = {
    tables, uploads,
    storage: { from: () => ({
      upload: async (k: string) => { uploads.push(k); return { data: { path: k }, error: null }; },
      createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }),
      createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }),
    }) },
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let op: any = null, single = false, maybe = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] != null && r[k] >= v); return q; },
        maybeSingle() { maybe = true; return q; }, single() { single = true; return q; },
        insert(v: any) { op = { kind: "insert", v }; return q; }, update(v: any) { op = { kind: "update", v }; return q; }, upsert(v: any) { op = { kind: "upsert", v }; return q; },
        then(res: any, rej: any) {
          const t = (tables[table] ??= []);
          let out: any[] = [];
          if (op?.kind === "insert") { const v = { id: `ins${t.length + 1}`, created_at: new Date().toISOString(), ...op.v }; t.push(v); out = [v]; }
          else if (op?.kind === "upsert") { for (const v of [].concat(op.v)) { const ks = keyOf[table] ?? ["user_id"]; const hit = t.find((r) => ks.every((k) => r[k] === (v as any)[k])); if (hit) Object.assign(hit, v); else t.push({ id: `${String(t.length + 1).padStart(8, "0")}-0000-4000-8000-000000000000`, ...(v as any) }); } }
          else if (op?.kind === "update") { out = t.filter((r) => filters.every((f) => f(r))); for (const r of out) Object.assign(r, op.v); }
          else out = t.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: single || maybe ? out[0] ?? null : out, error: single && !out.length ? { message: "no rows" } : null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return sb;
}
const ENV = { STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "ayr", SCRAPECREATORS_API_KEY: "sc", ANTHROPIC_API_KEY: "sk" } as Record<string, string>;
function fakeNet(opts: { providerFails?: boolean } = {}) {
  const calls: string[] = [];
  const f: any = async (url: string, init: any = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (url.startsWith("https://api.ayrshare.com/api/history/tiktok")) return opts.providerFails ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ status: "success", posts: [
      { id: "tt-1", postUrl: "https://www.tiktok.com/@ann/video/7500000000000000001", post: "best one", created: "2026-10-28T18:00:00Z", thumbnailUrl: "https://img/t1.jpg", videoViews: 9000, likeCount: 600, commentsCount: 30, shareCount: 120, reach: 7000, averageTimeWatched: 9, videoDuration: 18, fullVideoWatchedRate: 0.3, videoViewRetention: [{ second: 3, percentage: 72 }] },
      { id: "tt-2", postUrl: "https://www.tiktok.com/@ann/video/7500000000000000002", post: "other", created: "2026-10-25T18:00:00Z", videoViews: 1000, likeCount: 40, commentsCount: 2, shareCount: 3 },
    ] }));
    if (url.startsWith("https://api.ayrshare.com/api/analytics/social")) return new Response(JSON.stringify({ tiktok: { analytics: { followerCount: 1234 } } }));
    if (url.startsWith("https://api.scrapecreators.com/v1/tiktok/profile")) return new Response(JSON.stringify({ stats: { followerCount: 1200 } }));
    if (url.startsWith("https://api.scrapecreators.com/v3/tiktok/profile/videos")) return new Response(JSON.stringify({ aweme_list: [{ aweme_id: "7500000000000000003", desc: "public", create_time: Math.floor(NOW / 1000) - 86400, statistics: { play_count: 500 }, video: { duration: 15000 } }] }));
    if (url.startsWith("https://img/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    return new Response("{}", { status: 404 });
  };
  return { f, calls };
}

test("refresh: the provider's private analytics first, matched to what Clone8 posted, thumbnails kept; public numbers when the provider fails", async () => {
  const tables: Record<string, any[]> = { studio_social_profiles: [{ user_id: ANN, profile_key: "pk", accounts: [{ platform: "tiktok", username: "ann" }] }], studio_social_posts: [{ id: "sp1", user_id: ANN, job_id: "job-9", status: "posted", results: [{ platform: "tiktok", url: "https://www.tiktok.com/@ann/video/7500000000000000001", status: "posted" }] }] };
  const sb = fakeSb(tables); const net = fakeNet();
  const r = await refreshPerformance(sb, ANN, { env: ENV, fetch: net.f, log: () => {}, now: () => NOW });
  assert.deepEqual(r.platforms, ["tiktok"]); assert.equal(r.posts, 2);
  const best = tables.studio_perf_posts.find((p) => p.platform_post_id === "7500000000000000001");
  assert.equal(best.views, 9000); assert.equal(best.extra.hold_3s, 0.72); assert.equal(best.extra.source, "provider");
  assert.equal(best.social_post_id, "sp1", "made with Clone8 is recognised"); assert.equal(best.job_id, "job-9");
  assert.equal(best.thumb_key, `${ANN}/perf/tiktok/7500000000000000001.jpg`);
  assert.equal(tables.studio_perf_accounts[0].followers, 1234); assert.equal(tables.studio_perf_snapshots.length, 1);
  assert.ok(!net.calls.some((c) => c.includes("scrapecreators")), "no public lookups when the provider answers");
  const t2: Record<string, any[]> = { studio_social_profiles: [{ user_id: ANN, profile_key: "pk", accounts: [{ platform: "tiktok", username: "ann" }] }], studio_social_posts: [] };
  const net2 = fakeNet({ providerFails: true });
  const r2 = await refreshPerformance(fakeSb(t2), ANN, { env: ENV, fetch: net2.f, log: () => {}, now: () => NOW });
  assert.equal(r2.posts, 1); assert.equal(t2.studio_perf_posts[0].platform_post_id, "7500000000000000003");
  assert.equal(t2.studio_perf_accounts[0].followers, 1234, "followers still from the provider's account stats");
});

test("routes: not linked, first open reads the accounts, the overview is stored and limited, a post is used through the library", async () => {
  const tables: Record<string, any[]> = { studio_social_profiles: [], studio_social_posts: [], studio_perf_insights: [], studio_assets: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: ANN, kind: "video", status: "ready", probe: {} }] };
  const sb = fakeSb(tables); const net = fakeNet();
  let wrote = 0;
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: ANN }; req.profile = { role: "user", user_id: ANN }; next(); });
  app.use(accountAccess(() => sb));
  registerPerformance(app, () => sb, { env: ENV, fetch: net.f, log: () => {}, insight: async () => { wrote++; return { headline: "Short wins", working: [], not_working: [], moves: [{ title: "Make originals", detail: "d", tool: "blueprint", post_id: null, prompt: null }], sources: [] }; }, transcripts: async () => new Map() });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/studio/performance`;
  const get = async (q = "") => (await fetch(base + q)).json();
  const post = async (path: string, body: any = {}) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await get()).connected, false);
    tables.studio_social_profiles.push({ user_id: ANN, profile_key: "pk", accounts: [{ platform: "tiktok", username: "ann" }] });
    const first: any = await get("?range=90&tz=-420");
    assert.equal(first.connected, true); assert.equal(first.analysis.posts.length, 2, "first open reads the accounts now");
    assert.ok(first.analysis.posts[0].thumb_url?.startsWith("https://signed/"));
    assert.equal(tables.studio_social_profiles[0].timezone, "-420");
    assert.equal((await post("/insights", { range: 90 })).status, 409, "two posts are not enough for an overview");
    tables.studio_perf_posts.push({ id: "p3", user_id: ANN, platform: "tiktok", platform_post_id: "1", url: "https://www.tiktok.com/@ann/video/1", published_at: new Date(Date.now() - 2 * DAY).toISOString(), views: 300, extra: {} });
    const ins = await post("/insights", { range: 90 });
    assert.equal(ins.status, 200); assert.equal(ins.body.insight.headline, "Short wins"); assert.equal(wrote, 1); assert.equal(tables.studio_perf_insights.length, 1);
    const again: any = await get("?range=90");
    assert.equal(again.insight.headline, "Short wins"); assert.equal(again.insight.stale, false);
    for (let i = 0; i < 5; i++) await post("/insights", { range: 90 });
    assert.equal((await post("/insights", { range: 90 })).status, 429, "a few overviews a day");
    const pid = tables.studio_perf_posts[0].id;
    tables.studio_perf_posts[0].asset_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const used = await post(`/posts/${tables.studio_perf_posts[0].id}/use`);
    assert.equal(used.status, 200, JSON.stringify(used.body)); assert.equal(used.body.asset.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); void pid;
    const r = await fetch(base.replace("/performance", "/assistant/suggestions")); const sj: any = await r.json();
    assert.ok(Array.isArray(sj.suggestions));
  } finally { await new Promise((r) => server.close(r)); }
});

test("overview request: their numbers, post pictures by link, the sourced playbook, a JSON schema (no forced tool), cleaned answer", async () => {
  const { writeInsight } = await import("../src/studio-insights.js");
  const a = analyze([post(1, { views: 9000 }), post(2), post(3), post(4, { views: 200 })], [], { range_days: 28, now: NOW, offset_min: 0, platform: null });
  let body: any = null;
  const f: any = async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ headline: "Your 20 s posts win", working: [{ title: "t", evidence: "9× usual", why: "watch time (Mosseri 2025)", post_ids: ["p1"] }], not_working: [], moves: [{ title: "Make originals", detail: "d", tool: "blueprint", post_id: "p1", prompt: null }], sources: [{ label: "Mosseri 2025", url: "https://www.socialmediatoday.com/x" }] }) }] })); };
  const ins = await writeInsight(null as any, ANN, a, { platform: null, thumbs: new Map([["p1", "https://signed/t1.jpg"]]), transcripts: new Map([["p1", "welcome back"]]) }, { env: { ANTHROPIC_API_KEY: "sk" }, fetch: f });
  assert.equal(ins.moves[0].post_id, "p1");
  assert.equal(body.model, "claude-opus-5-5"); assert.equal(body.tool_choice, undefined); assert.equal(body.output_config.format.type, "json_schema");
  const content = body.messages[0].content;
  assert.ok(content.some((c: any) => c.type === "image" && c.source.type === "url" && c.source.url === "https://signed/t1.jpg"));
  const text = content.at(-1).text;
  assert.match(text, /THEIR NUMBERS/); assert.match(text, /A1 Instagram, Adam Mosseri/); assert.match(text, /DO NOT SAY/); assert.match(text, /welcome back/);
});
