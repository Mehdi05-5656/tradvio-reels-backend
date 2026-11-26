// Clone8 Studio: how a product's hooks and ads did once posted (docs/model-features/PRODUCT_ADS_PLAN.md, phase 4; owner
// Nov 26 2026). Nobody closes this loop (research): which hook won, then more like it.
//
// A posted video is traced back to the product piece it came from, whatever the route to posting:
//   the piece's own job  →  the library copy of it (probe.derived_from_job)  →  a Captions run on that copy and its
//   captioned file (the run's items / probe.captions.from)  →  posts and their numbers (studio_perf_posts, read by the
//   Performance dashboard from the person's linked accounts).
// Read-only. Owner-only with the rest of Products.
import type { SupabaseClient } from "@supabase/supabase-js";

export type PieceResult = {
  job_id: string; kind: "hook" | "ad" | "clip" | "shot"; title: string; line: string | null; language: string | null; cast: string | null;
  posts: Array<{ platform: string; url: string | null; published_at: string | null; views: number; likes: number; comments: number; shares: number }>;
  views: number; likes: number; shares: number;
};

const kindOf = (o: any): PieceResult["kind"] | null => (o?.ad ? "ad" : o?.hook ? "hook" : o?.look ? (String(o.look).startsWith("move-") ? "clip" : "shot") : null);

/** Every posted video traced back to the product piece it came from, best first (by views). */
export async function productResults(sb: SupabaseClient, u: string, productId: string): Promise<PieceResult[]> {
  const jobs = await sb.from("studio_jobs").select("id,options,created_at").eq("user_id", u).eq("tool", "instrument").eq("status", "done").eq("options->>product", productId).limit(500);
  if (jobs.error) throw jobs.error;
  const pieces = (jobs.data ?? []).filter((j: any) => kindOf(j.options));
  if (!pieces.length) return [];
  const origin = new Map<string, string>(); // any job or asset id → the product piece's job id
  for (const j of pieces) origin.set(j.id, j.id);
  // the library copies of the pieces
  const copies = await sb.from("studio_assets").select("id,probe").eq("user_id", u).in("probe->>derived_from_job", pieces.map((j: any) => j.id));
  if (copies.error) throw copies.error;
  for (const a of copies.data ?? []) origin.set(a.id, String((a as any).probe.derived_from_job));
  const copyIds = (copies.data ?? []).map((a: any) => a.id);
  if (copyIds.length) {
    // Captions runs on those copies, and the captioned files they left in the library
    const caps = await sb.from("studio_jobs").select("id,options").eq("user_id", u).eq("tool", "captions").gte("created_at", pieces.reduce((m: string, j: any) => (j.created_at < m ? j.created_at : m), pieces[0].created_at)).limit(500);
    if (caps.error) throw caps.error;
    for (const c of caps.data ?? []) {
      const src = ((c as any).options?.items ?? []).map((i: any) => String(i?.asset_id ?? "")).find((id: string) => origin.has(id));
      if (src) origin.set(c.id, origin.get(src)!);
    }
    const captioned = await sb.from("studio_assets").select("id,probe").eq("user_id", u).in("probe->captions->>from", copyIds);
    if (captioned.error) throw captioned.error;
    for (const a of captioned.data ?? []) origin.set(a.id, origin.get(String((a as any).probe.captions.from))!);
  }
  // the posts and their latest numbers
  const ids = [...origin.keys()];
  const [byJob, byAsset] = await Promise.all([
    sb.from("studio_perf_posts").select("platform,url,published_at,views,likes,comments,shares,job_id,asset_id").eq("user_id", u).in("job_id", ids),
    sb.from("studio_perf_posts").select("platform,url,published_at,views,likes,comments,shares,job_id,asset_id").eq("user_id", u).in("asset_id", ids),
  ]);
  if (byJob.error) throw byJob.error;
  if (byAsset.error) throw byAsset.error;
  const seen = new Set<string>(), out = new Map<string, PieceResult>();
  for (const p of [...(byJob.data ?? []), ...(byAsset.data ?? [])] as any[]) {
    const key = `${p.platform}:${p.url}`; if (seen.has(key)) continue; seen.add(key);
    const from = origin.get(p.job_id) ?? origin.get(p.asset_id); if (!from) continue;
    const j: any = pieces.find((x: any) => x.id === from); if (!j) continue;
    const r = out.get(from) ?? { job_id: from, kind: kindOf(j.options)!, title: String(j.options?.look_title ?? "Piece"), line: j.options?.hook?.line ?? null, language: j.options?.hook?.language ?? null, cast: j.options?.hook?.cast ?? j.options?.cast ?? null, posts: [], views: 0, likes: 0, shares: 0 };
    const n = (v: any) => Number(v) || 0;
    r.posts.push({ platform: p.platform, url: p.url ?? null, published_at: p.published_at ?? null, views: n(p.views), likes: n(p.likes), comments: n(p.comments), shares: n(p.shares) });
    r.views += n(p.views); r.likes += n(p.likes); r.shares += n(p.shares);
    out.set(from, r);
  }
  return [...out.values()].sort((a, b) => b.views - a.views);
}
