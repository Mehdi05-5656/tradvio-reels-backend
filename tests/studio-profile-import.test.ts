import test from "node:test";
import assert from "node:assert/strict";
import { profileRef, tiktokPosts, instagramReels, browserImage, listProfilePage, PROFILE_LIMITS } from "../src/studio-profile-import.js";

test("profile links: TikTok and Instagram profiles in their forms; posts and other sites are refused with a reason", () => {
  assert.deepEqual(profileRef("https://www.tiktok.com/@Stable.Ronaldo"), { platform: "tiktok", handle: "stable.ronaldo", url: "https://www.tiktok.com/@stable.ronaldo" });
  assert.deepEqual(profileRef("tiktok.com/@core_live?lang=en"), { platform: "tiktok", handle: "core_live", url: "https://www.tiktok.com/@core_live" });
  assert.deepEqual(profileRef("https://instagram.com/tradvio/"), { platform: "instagram", handle: "tradvio", url: "https://www.instagram.com/tradvio/" });
  assert.deepEqual(profileRef("https://www.instagram.com/tradvio/reels/").handle, "tradvio");
  const code = (s: string) => { try { profileRef(s); return "ok"; } catch (e: any) { return e.code; } };
  assert.equal(code("https://www.tiktok.com/@x/video/7301000000001"), "profile_link_invalid");
  assert.equal(code("https://www.instagram.com/reel/Cxyz123/"), "profile_link_invalid");
  assert.equal(code("https://youtube.com/@tradvio"), "profile_link_invalid");
  assert.equal(code("not a link"), "profile_link_invalid");
});

test("TikTok and Instagram pages become posts with their numbers; TikTok photo posts are left out", () => {
  const tt = tiktokPosts({ has_more: true, max_cursor: "171", aweme_list: [
    { aweme_id: "7301000000001", desc: "Japan day 1", create_time: 1761000000, is_top: 1, statistics: { play_count: 120000, digg_count: 9000, comment_count: 120, share_count: 300 }, video: { duration: 27340, cover: { url_list: ["https://p16.tiktokcdn.com/c.jpg"] } } },
    { aweme_id: "7302", desc: "photo", image_post_info: { images: [] }, statistics: {} },
    { aweme_id: "bad" },
  ] }, "core_live");
  assert.equal(tt.next, "171");
  assert.equal(tt.posts.length, 1);
  assert.deepEqual(tt.posts[0], { id: "7301000000001", url: "https://www.tiktok.com/@core_live/video/7301000000001", caption: "Japan day 1", posted_at: "2025-10-20T22:40:00.000Z", views: 120000, likes: 9000, comments: 120, shares: 300, seconds: 27.3, thumbnail_url: "https://p16.tiktokcdn.com/c.jpg", pinned: true });
  const ig = instagramReels({ paging_info: { max_id: "QVFE+abc/x==", more_available: true }, items: [
    { media: { code: "Cx1_reel", media_type: 2, product_type: "clips", taken_at: 1761000000, caption: { text: "a reel" }, ig_play_count: 5000, play_count: 5000, like_count: 400, comment_count: 12, video_duration: 18.6, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/t.jpg" }] }, clips_tab_pinned_user_ids: [1] } },
    { media: { code: "bad code!" } },
  ] });
  assert.equal(ig.next, "QVFE+abc/x==");
  assert.equal(ig.posts.length, 1);
  assert.equal(ig.posts[0].url, "https://www.instagram.com/reel/Cx1_reel/");
  assert.equal(ig.posts[0].pinned, true);
  assert.equal(instagramReels({ paging_info: { max_id: "z", more_available: false }, items: [] }).next, null, "no more: no cursor");
  assert.equal(ig.posts[0].views, 5000); assert.equal(ig.posts[0].seconds, 18.6); assert.equal(ig.posts[0].thumbnail_url, "https://scontent.cdninstagram.com/t.jpg");
});

test("listing a page: the right endpoint per platform, counted per day, a private or empty account says so", async () => {
  const calls: string[] = [];
  let count = 0;
  const sb: any = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ count }) }) }) }) }) };
  const f = (async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => (url.includes("tiktok") ? { aweme_list: [{ aweme_id: "7301000000001", statistics: {}, video: {} }], has_more: false } : url.includes("/user/reels") ? { items: [], paging_info: { more_available: false } } : { items: [], more_available: false, user: { is_private: true } }) }; }) as any;
  const deps = { env: { SCRAPECREATORS_API_KEY: "k" }, fetch: f };
  const page = await listProfilePage(sb, deps, "u1", { url: "https://www.tiktok.com/@core_live" });
  assert.equal(page.profile.handle, "core_live"); assert.equal(page.posts.length, 1); assert.equal(page.next, null);
  assert.match(calls[0], /\/v3\/tiktok\/profile\/videos\?handle=core_live&sort_by=popular$/, "TikTok is read most viewed first");
  await listProfilePage(sb, deps, "u1", { url: "https://www.tiktok.com/@core_live", cursor: "171" }).catch(() => undefined);
  assert.match(calls[1], /max_cursor=171$/);
  await assert.rejects(listProfilePage(sb, deps, "u1", { url: "https://instagram.com/someone" }), (e: any) => e.code === "profile_private");
  assert.match(calls[2], /\/v1\/instagram\/user\/reels\?handle=someone$/, "Instagram is read from its Reels list");
  assert.match(calls[3], /\/v2\/instagram\/user\/posts\?handle=someone$/, "an empty Reels list looks at the profile once, to tell a private account apart");
  await listProfilePage(sb, deps, "u1", { url: "https://instagram.com/someone", cursor: "QVFE+abc/x==" }).catch(() => undefined);
  assert.match(calls[4], /\/v1\/instagram\/user\/reels\?handle=someone&max_id=QVFE%2Babc%2Fx%3D%3D$/, "the Reels cursor (base64) is passed on, encoded");
  count = PROFILE_LIMITS.pages_per_day;
  await assert.rejects(listProfilePage(sb, deps, "u1", { url: "https://www.tiktok.com/@core_live" }), (e: any) => e.code === "profile_rate_limited");
  await assert.rejects(listProfilePage(sb, { env: {}, fetch: f }, "u1", { url: "https://www.tiktok.com/@core_live" }), (e: any) => e.code === "import_unavailable");
});

test("an import quoted from an account keeps the account as its source; a post link names its TikTok account", async () => {
  const { quoteImport } = await import("../src/studio-library.js");
  const { profileOfPost } = await import("../src/studio-profile-import.js");
  const PLANS = [{ id: "starter", monthly_usd: 29, annual_usd_per_month: 24, credits: 1000 }];
  const q = quoteImport({ SCRAPECREATORS_API_KEY: "k" }, PLANS as any, { links: ["https://www.tiktok.com/@Core_Live/video/7301000000001"], account: { platform: "tiktok", handle: "Core_Live" } });
  assert.deepEqual(q.options.account, { platform: "tiktok", handle: "core_live", url: "https://www.tiktok.com/@core_live" });
  assert.equal(quoteImport({}, PLANS as any, { links: ["https://www.instagram.com/reel/Cx1_reel/"], account: { platform: "x", handle: "no" } }).options.account, null);
  assert.deepEqual(profileOfPost("https://www.tiktok.com/@core_live/video/7301000000001"), { platform: "tiktok", handle: "core_live" });
  assert.equal(profileOfPost("https://www.instagram.com/reel/Cx1_reel/"), null);
});

test("TikTok covers: the JPEG is picked, never the HEIC or .image variants a browser cannot draw", () => {
  const heic = "https://p16-common-sign.tiktokcdn-us.com/obj/abc~tplv-tiktokx-cropcenter-q:300:400:q70.heic?x-expires=1&x-signature=s";
  const jpeg = "https://p16-common-sign.tiktokcdn-us.com/obj/abc~tplv-tiktokx-cropcenter-q:300:400:q70.jpeg?x-expires=1&x-signature=s";
  const img = "https://p16-common-sign.tiktokcdn-us.com/obj/abc~tplv-tiktokx-origin.image?x-expires=1";
  assert.equal(browserImage([heic, heic, jpeg]), jpeg);
  assert.equal(browserImage([heic, heic], [img, img, jpeg]), jpeg, "found in a later list");
  assert.equal(browserImage([heic]), null, "nothing drawable: no picture rather than a dark tile");
  const t = tiktokPosts({ aweme_list: [{ aweme_id: "7301000000009", statistics: {}, video: { cover: { url_list: [heic, heic, jpeg] } } }] }, "x");
  assert.equal(t.posts[0].thumbnail_url, jpeg);
});
