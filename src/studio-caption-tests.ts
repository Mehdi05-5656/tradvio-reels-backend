// Instagram caption tests (docs/publishing/AI_CAPTIONS_PLAN.md, step D1): one video posted as 2 or 3 Trial Reels, each
// with its own caption. Trial Reels go to non-followers first, so each caption gets a comparable first audience; this
// is the one fully causal signal we get. Results compare trials only with each other (trials get less reach than
// normal posts), at the same age: the 24-hour snapshot when every variant has one, the 3-day one when all have that.
import type { SupabaseClient } from "@supabase/supabase-js";

export type TestVariant = { variant: number; post_id: string; caption: string; status: string; url: string | null; posted_at: string | null; views: number | null; views_24h: number | null; views_3d: number | null; likes: number | null; shares: number | null; thumb_key: string | null };
export type CaptionTest = {
  id: string; created_at: string; account: string | null;
  /** waiting: not out yet or under a day old; leading: one is ahead but it's early; winner: clear at the same age; tie: too close */
  state: "waiting" | "leading" | "winner" | "tie";
  at: "24h" | "3d" | "now" | null; winner: number | null; lead: number | null; variants: TestVariant[];
};

/** How far ahead the best must be for a call (views at the same age). */
export const WIN_RATIO = 1.3;

export function judgeTest(vs: TestVariant[], now = Date.now()): Pick<CaptionTest, "state" | "at" | "winner" | "lead"> {
  const live = vs.filter((v) => v.status === "posted" || v.views != null);
  if (live.length < vs.length || live.length < 2) return { state: "waiting", at: null, winner: null, lead: null };
  // the same age for all: 3 days when every variant has it, else 24 hours, else (all older than a day) their numbers now
  const all = (k: "views_3d" | "views_24h") => vs.every((v) => v[k] != null);
  const at: CaptionTest["at"] = all("views_3d") ? "3d" : all("views_24h") ? "24h" : vs.every((v) => v.posted_at && now - Date.parse(v.posted_at) > 24 * 3600_000 && v.views != null) ? "now" : null;
  if (!at) return { state: "waiting", at: null, winner: null, lead: null };
  const val = (v: TestVariant) => Number((at === "3d" ? v.views_3d : at === "24h" ? v.views_24h : v.views) ?? 0);
  const ranked = [...vs].sort((a, b) => val(b) - val(a));
  const lead = val(ranked[1]) > 0 ? val(ranked[0]) / val(ranked[1]) : val(ranked[0]) > 0 ? Infinity : 1;
  const ahead = lead >= WIN_RATIO;
  return { state: ahead ? (at === "24h" ? "leading" : "winner") : at === "3d" ? "tie" : "leading", at, winner: ahead ? ranked[0].variant : null, lead: Number.isFinite(lead) ? Math.round(lead * 100) / 100 : null };
}

/** The person's caption tests of the last 60 days, newest first, each with its variants' numbers. */
export async function captionTests(sb: SupabaseClient, u: string, now = Date.now()): Promise<CaptionTest[]> {
  const r = await sb.from("studio_social_posts").select("id,caption,status,results,options,schedule_at,created_at").eq("user_id", u)
    .not("options->caption_test", "is", null).gte("created_at", new Date(now - 60 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(150);
  if (r.error) throw r.error;
  const rows = (r.data ?? []) as any[];
  if (!rows.length) return [];
  const ids = rows.map((x) => x.id);
  const perf = await sb.from("studio_perf_posts").select("social_post_id,platform,platform_post_id,views,likes,shares,thumb_key,published_at").eq("user_id", u).in("social_post_id", ids);
  const byPost = new Map(((perf.data ?? []) as any[]).map((p) => [p.social_post_id, p]));
  const pids = ((perf.data ?? []) as any[]).map((p) => p.platform_post_id);
  const snaps = pids.length ? await sb.from("studio_perf_post_snapshots").select("platform_post_id,age,views").eq("user_id", u).in("platform_post_id", pids) : { data: [] as any[] };
  const snapOf = (pid: string, age: string) => ((snaps.data ?? []) as any[]).find((s) => s.platform_post_id === pid && s.age === age)?.views ?? null;
  const tests = new Map<string, CaptionTest>();
  for (const x of rows) {
    const t = x.options?.caption_test; if (!t?.id) continue;
    const p = byPost.get(x.id);
    const res = ((x.results ?? []) as any[])[0] ?? null;
    const acct = ((x.options?.accounts ?? []) as any[])[0];
    const cur = tests.get(t.id) ?? { id: t.id, created_at: x.created_at, account: acct?.username ?? null, state: "waiting", at: null, winner: null, lead: null, variants: [] };
    cur.variants.push({
      variant: Number(t.variant) || 0, post_id: x.id, caption: String(x.caption ?? ""), status: x.status, url: res?.url ?? null,
      posted_at: p?.published_at ?? (x.status === "posted" ? x.schedule_at ?? x.created_at : null),
      views: p?.views ?? null, views_24h: p ? snapOf(p.platform_post_id, "24h") : null, views_3d: p ? snapOf(p.platform_post_id, "3d") : null,
      likes: p?.likes ?? null, shares: p?.shares ?? null, thumb_key: p?.thumb_key ?? null,
    });
    if (x.created_at < cur.created_at) cur.created_at = x.created_at;
    tests.set(t.id, cur);
  }
  return [...tests.values()].map((t) => { t.variants.sort((a, b) => a.variant - b.variant); return { ...t, ...judgeTest(t.variants, now) }; });
}

/** Captions that won a test: the strongest voice evidence there is (fed to caption drafting). */
export async function testWinners(sb: SupabaseClient, u: string): Promise<Array<{ caption: string; beat: string; lead: number | null }>> {
  try {
    const ts = await captionTests(sb, u);
    return ts.filter((t) => t.state === "winner" && t.winner != null).slice(0, 5).map((t) => {
      const w = t.variants.find((v) => v.variant === t.winner)!, other = t.variants.find((v) => v.variant !== t.winner)!;
      return { caption: w.caption.slice(0, 300), beat: other.caption.slice(0, 200), lead: t.lead };
    });
  } catch { return []; }
}
