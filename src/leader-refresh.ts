// leader-refresh.ts
// Backfill + daily refresh for leader-account ML seed.
// - Enumerates every post on each active leader via ScrapeCreators
// - Enriches each shortcode with detail (real view/like counts)
// - Upserts to leader_posts
// - Recomputes leader_post_scores (z-normalized composite)
// - Recomputes leader_hashtag_stats
//
// Runs as:
//   npx tsx src/leader-refresh.ts                # refresh all active leaders
//   npx tsx src/leader-refresh.ts --full         # full re-enrich even for stable posts
//   npx tsx src/leader-refresh.ts --leader <id>  # single leader by uuid
//
// Requires env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SCRAPECREATORS_API_KEY

import { createClient } from "@supabase/supabase-js";

type LeaderRow = {
  id: string;
  phone_slot: string;
  provider: "instagram" | "tiktok";
  handle: string;
  active: boolean;
};

type ScListingPost = {
  node: {
    id: string;
    shortcode: string;
    taken_at_timestamp: number | null;
    created_at?: number;
    thumbnail_src?: string;
    display_url?: string;
    video_url?: string;
    video_play_count?: number;
    video_duration?: number;
    product_type?: string;
    is_video?: boolean;
    edge_media_to_caption?: { edges?: Array<{ node: { text: string } }> };
    edge_media_preview_like?: { count: number };
    comment_count?: number;
  };
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SC_KEY = process.env.SCRAPECREATORS_API_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY || !SC_KEY) {
  console.error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SCRAPECREATORS_API_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function scGet(path: string): Promise<any> {
  const url = `https://api.scrapecreators.com${path}`;
  const r = await fetch(url, { headers: { "x-api-key": SC_KEY } });
  if (!r.ok) throw new Error(`ScrapeCreators ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const tags = caption.match(/#[\p{L}0-9_]+/gu) || [];
  return Array.from(new Set(tags.map((t) => t.toLowerCase())));
}

async function enumerateIGListing(handle: string): Promise<ScListingPost[]> {
  const all: ScListingPost[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 40; i++) {
    const qs = cursor
      ? `?handle=${encodeURIComponent(handle)}&cursor=${encodeURIComponent(cursor)}`
      : `?handle=${encodeURIComponent(handle)}`;
    const resp = await scGet(`/v1/instagram/user/posts${qs}`);
    const posts: ScListingPost[] = resp.posts || [];
    all.push(...posts);
    cursor = resp.cursor || null;
    console.log(
      `  listing page ${i + 1}: +${posts.length} posts (total ${all.length}), credits_remaining=${resp.credits_remaining}`,
    );
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return all;
}

async function enrichIGPost(shortcode: string): Promise<any | null> {
  const url = `/v1/instagram/post?url=${encodeURIComponent(`https://www.instagram.com/reel/${shortcode}/`)}`;
  const resp = await scGet(url);
  const m = resp?.data?.xdt_shortcode_media;
  return m || null;
}

async function refreshLeaderInstagram(leader: LeaderRow, opts: { full: boolean }): Promise<void> {
  console.log(`\n[refresh IG @${leader.handle}] leader_id=${leader.id}`);
  const listing = await enumerateIGListing(leader.handle);
  console.log(`  enumerated ${listing.length} posts on IG`);

  // Which shortcodes do we need to enrich?
  const existing = await sb
    .from("leader_posts")
    .select("external_post_id, shortcode, posted_at, last_refreshed_at")
    .eq("leader_id", leader.id);
  const existingByShortcode = new Map<string, any>();
  for (const row of existing.data || []) {
    if (row.shortcode) existingByShortcode.set(row.shortcode, row);
  }

  const now = Date.now();
  const shortcodesToEnrich: string[] = [];
  const listingByShortcode = new Map<string, any>();

  for (const item of listing) {
    const n = item.node;
    if (!n?.shortcode) continue;
    listingByShortcode.set(n.shortcode, n);
    const prev = existingByShortcode.get(n.shortcode);
    if (opts.full || !prev) {
      shortcodesToEnrich.push(n.shortcode);
      continue;
    }
    // Refresh anything posted in the last 90 days on every run (metrics still moving).
    const postedAt = prev.posted_at ? new Date(prev.posted_at).getTime() : 0;
    const ageDays = (now - postedAt) / 86400000;
    if (ageDays < 90) shortcodesToEnrich.push(n.shortcode);
  }
  console.log(`  will enrich ${shortcodesToEnrich.length}/${listing.length} posts`);

  let enriched = 0;
  for (const sc of shortcodesToEnrich) {
    try {
      const detail = await enrichIGPost(sc);
      const listNode = listingByShortcode.get(sc) || {};
      const source = detail || listNode; // detail is preferred, fall back to listing
      const caption =
        source?.edge_media_to_caption?.edges?.[0]?.node?.text ??
        listNode?.edge_media_to_caption?.edges?.[0]?.node?.text ??
        null;
      const hashtags = extractHashtags(caption);
      const takenTs: number | null =
        source?.taken_at_timestamp ?? listNode?.taken_at_timestamp ?? source?.created_at ?? listNode?.created_at ?? null;
      const postedAt = takenTs ? new Date(takenTs * 1000).toISOString() : null;

      const row = {
        leader_id: leader.id,
        provider: "instagram" as const,
        handle: leader.handle,
        external_post_id: String(source?.id || listNode?.id || sc),
        shortcode: sc,
        post_url: `https://www.instagram.com/reel/${sc}/`,
        posted_at: postedAt,
        caption,
        hashtags,
        media_type: source?.is_video ? "video" : "image",
        product_type: source?.product_type ?? listNode?.product_type ?? null,
        video_duration: source?.video_duration ?? listNode?.video_duration ?? null,
        thumbnail_url: source?.thumbnail_src ?? listNode?.thumbnail_src ?? null,
        media_url: source?.video_url ?? listNode?.video_url ?? source?.display_url ?? listNode?.display_url ?? null,
        video_views: source?.video_play_count ?? 0,
        likes: source?.edge_media_preview_like?.count ?? 0,
        comments: source?.comment_count ?? 0,
        saves: null,
        shares: null,
        reach: null,
        raw: detail || null,
        last_refreshed_at: new Date().toISOString(),
      };

      const up = await sb
        .from("leader_posts")
        .upsert(row, { onConflict: "leader_id,external_post_id" });
      if (up.error) {
        console.warn(`  [warn] upsert ${sc}: ${up.error.message}`);
      } else {
        enriched++;
      }
    } catch (e: any) {
      console.warn(`  [warn] enrich ${sc}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  upserted ${enriched} posts`);
}

async function recomputeScores(leaderId: string): Promise<void> {
  console.log(`\n[scores] leader_id=${leaderId}`);
  const { data: posts, error } = await sb
    .from("leader_posts")
    .select("id, posted_at, video_views, likes, comments, saves, shares")
    .eq("leader_id", leaderId);
  if (error) throw error;
  if (!posts || posts.length === 0) {
    console.log("  no posts");
    return;
  }

  const now = Date.now();
  const metrics = posts.map((p) => {
    const postedAt = p.posted_at ? new Date(p.posted_at).getTime() : now;
    const ageDays = Math.max(1, (now - postedAt) / 86400000);
    const v = Number(p.video_views || 0);
    const l = Number(p.likes || 0);
    const c = Number(p.comments || 0);
    const s = p.saves != null ? Number(p.saves) : null;
    const sh = p.shares != null ? Number(p.shares) : null;
    return {
      id: p.id,
      views_per_day: v / ageDays,
      log_views: Math.log(1 + v),
      engagement_rate: v > 0 ? (l + c) / v : 0,
      saves_per_view: s != null && v > 0 ? s / v : null,
      shares_per_view: sh != null && v > 0 ? sh / v : null,
    };
  });

  // Z-normalize each metric (missing values excluded from that dimension's stats).
  const zscore = (values: (number | null)[]) => {
    const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
    if (nums.length === 0) return values.map(() => 0);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
    const std = Math.sqrt(variance);
    if (std === 0) return values.map(() => 0);
    return values.map((v) => (v == null || !Number.isFinite(v) ? 0 : (v - mean) / std));
  };

  // Log-compressed total views is a better signal than views/day: a 5000-view
  // 6-month post is a stronger content pattern than a 300-view yesterday post,
  // and log() keeps a single 20k viral post from dominating the whole ranking.
  const zLogViews = zscore(metrics.map((m) => m.log_views));
  const zEng = zscore(metrics.map((m) => m.engagement_rate));
  const zSaves = zscore(metrics.map((m) => m.saves_per_view));
  const zShares = zscore(metrics.map((m) => m.shares_per_view));

  const anySaves = metrics.some((m) => m.saves_per_view != null);
  const anyShares = metrics.some((m) => m.shares_per_view != null);

  const scored = metrics.map((m, i) => {
    let composite: number;
    if (anySaves && anyShares) {
      composite = 0.5 * zLogViews[i] + 0.2 * zEng[i] + 0.2 * zSaves[i] + 0.1 * zShares[i];
    } else {
      composite = 0.7 * zLogViews[i] + 0.3 * zEng[i];
    }
    return { ...m, composite_score: composite };
  });

  // Rank
  const ranked = [...scored].sort((a, b) => b.composite_score - a.composite_score);
  const rankMap = new Map<string, number>();
  ranked.forEach((r, i) => rankMap.set(r.id, i + 1));

  // Upsert
  const rows = scored.map((s) => ({
    leader_post_id: s.id,
    views_per_day: s.views_per_day,
    engagement_rate: s.engagement_rate,
    saves_per_view: s.saves_per_view,
    shares_per_view: s.shares_per_view,
    composite_score: s.composite_score,
    rank_overall: rankMap.get(s.id) || null,
    computed_at: new Date().toISOString(),
  }));
  const { error: upErr } = await sb.from("leader_post_scores").upsert(rows, { onConflict: "leader_post_id" });
  if (upErr) throw upErr;
  console.log(`  scored ${rows.length} posts; top composite=${ranked[0]?.composite_score.toFixed(3)}`);
}

async function recomputeHashtagStats(leaderId: string): Promise<void> {
  console.log(`\n[hashtag stats] leader_id=${leaderId}`);
  const { data, error } = await sb
    .from("leader_posts")
    .select("id, hashtags, video_views, leader_post_scores(composite_score)")
    .eq("leader_id", leaderId);
  if (error) throw error;
  if (!data || data.length === 0) return;

  type Agg = { post_count: number; views: number[]; scores: number[]; best_post_id: string; best_score: number };
  const map = new Map<string, Agg>();

  for (const post of data as any[]) {
    const tags: string[] = post.hashtags || [];
    const views = Number(post.video_views || 0);
    const scoreRow = Array.isArray(post.leader_post_scores)
      ? post.leader_post_scores[0]
      : post.leader_post_scores;
    const score = Number(scoreRow?.composite_score ?? 0);
    for (const raw of tags) {
      const tag = raw.toLowerCase();
      if (!map.has(tag)) {
        map.set(tag, { post_count: 0, views: [], scores: [], best_post_id: post.id, best_score: -Infinity });
      }
      const a = map.get(tag)!;
      a.post_count += 1;
      a.views.push(views);
      a.scores.push(score);
      if (score > a.best_score) {
        a.best_score = score;
        a.best_post_id = post.id;
      }
    }
  }

  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const rows = Array.from(map.entries()).map(([hashtag, a]) => ({
    leader_id: leaderId,
    hashtag,
    post_count: a.post_count,
    avg_views: mean(a.views),
    median_views: median(a.views),
    avg_composite_score: mean(a.scores),
    best_post_id: a.best_post_id,
    computed_at: new Date().toISOString(),
  }));

  // Wipe and reload for this leader (simpler than diffing)
  const del = await sb.from("leader_hashtag_stats").delete().eq("leader_id", leaderId);
  if (del.error) console.warn(`  delete warn: ${del.error.message}`);
  if (rows.length > 0) {
    const { error: upErr } = await sb.from("leader_hashtag_stats").insert(rows);
    if (upErr) throw upErr;
  }
  console.log(`  wrote ${rows.length} hashtag rows`);
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const leaderIdx = args.indexOf("--leader");
  const explicitLeaderId = leaderIdx >= 0 ? args[leaderIdx + 1] : null;

  let query = sb.from("leader_accounts").select("*").eq("active", true);
  if (explicitLeaderId) query = sb.from("leader_accounts").select("*").eq("id", explicitLeaderId);
  const { data: leaders, error } = await query;
  if (error) throw error;
  if (!leaders || leaders.length === 0) {
    console.log("no active leaders");
    return;
  }

  for (const l of leaders as LeaderRow[]) {
    if (l.provider === "instagram") {
      await refreshLeaderInstagram(l, { full });
    } else {
      console.log(`\n[skip] leader ${l.handle} (${l.provider}) — TikTok backfill deferred until API approval`);
      continue;
    }
    await recomputeScores(l.id);
    await recomputeHashtagStats(l.id);
  }

  console.log("\ndone");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
