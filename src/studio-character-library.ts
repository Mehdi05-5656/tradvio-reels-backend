// Clone8 Studio: "your characters". Every picture a person has used as a character (an uploaded photo, a portrait from
// the Characters tool) is kept for them and ranked by how often they used it, so the picker opens with their regulars
// in one row instead of a search through the library. Nothing is stored twice: the pictures are the person's library
// images, the counts come from their own jobs.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type LibraryCharacter = { asset_id: string; name: string; made: boolean; uses: number; last_used_at: string | null; created_at: string; url: string | null };

/** The pictures a job used as characters: the single one, or one per person in a cast. */
export function characterIdsOf(options: any): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => { const s = String(v ?? ""); if (UUID_RE.test(s)) ids.add(s.toLowerCase()); };
  add(options?.character_asset_id);
  if (Array.isArray(options?.cast)) for (const m of options.cast) add(m?.character_asset_id);
  return [...ids];
}

/** Ranks pictures by use (most first, then most recent); made characters show even before their first use. */
export function rankCharacters(images: Array<{ id: string; name: string; created_at: string; probe?: any }>, jobs: Array<{ options: any; created_at: string }>): Omit<LibraryCharacter, "url">[] {
  const uses = new Map<string, { n: number; last: string }>();
  for (const j of jobs) for (const id of characterIdsOf(j.options)) { const u = uses.get(id); uses.set(id, { n: (u?.n ?? 0) + 1, last: !u || j.created_at > u.last ? j.created_at : u.last }); }
  return images
    .map((a) => { const u = uses.get(String(a.id).toLowerCase()); return { asset_id: a.id, name: String(a.name ?? "").replace(/^Character: /, ""), made: !!a.probe?.character, uses: u?.n ?? 0, last_used_at: u?.last ?? null, created_at: a.created_at }; })
    .filter((c) => c.uses > 0 || c.made)
    .sort((x, y) => y.uses - x.uses || String(y.last_used_at ?? "").localeCompare(String(x.last_used_at ?? "")) || String(y.created_at).localeCompare(String(x.created_at)));
}

export async function characterLibrary(sb: SupabaseClient, u: string): Promise<LibraryCharacter[]> {
  const [imgs, jobs] = await Promise.all([
    sb.from("studio_assets").select("id,name,object_key,probe,created_at").eq("user_id", u).eq("kind", "image").eq("status", "ready").order("created_at", { ascending: false }).limit(400),
    sb.from("studio_jobs").select("options,created_at").eq("user_id", u).in("tool", ["recast", "swap", "trend", "restyle"]).order("created_at", { ascending: false }).limit(1000),
  ]);
  if (imgs.error) throw imgs.error;
  if (jobs.error) throw jobs.error;
  const rows = (imgs.data ?? []) as any[];
  const ranked = rankCharacters(rows, (jobs.data ?? []) as any[]).slice(0, 120);
  const keyOf = new Map(rows.map((a) => [a.id, a.object_key as string]));
  const keys = ranked.map((c) => keyOf.get(c.asset_id)).filter(Boolean) as string[];
  const urls = new Map<string, string>();
  if (keys.length) { const s = await sb.storage.from("studio-uploads").createSignedUrls(keys, 3600); for (const x of (s.data ?? []) as any[]) if (x?.signedUrl) urls.set(x.path, x.signedUrl); }
  return ranked.map((c) => ({ ...c, url: urls.get(keyOf.get(c.asset_id) ?? "") ?? null }));
}

export function registerCharacters(app: Express, sbFn: () => SupabaseClient): void {
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  app.get("/api/studio/characters", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { res.json({ characters: await characterLibrary(sbFn(), u) }); }
    catch (e: any) { console.error("[characters]", String(e?.message ?? e)); res.status(500).json({ error: "characters_failed" }); }
  });
}
