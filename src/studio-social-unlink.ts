// When a person removes an account in Clone8, the posts still waiting for it are taken off it.
//
// Before (until Nov 26 2026) the account was removed at the posting service and its scheduled posts kept aiming at it:
// at their time each failed on that account ("Account … was disconnected"), so a post to it alone landed in Failed and a
// post to several accounts came back "partial". The remove dialog already says those posts "will not go out" there;
// this makes that true without the failures: a post that went only to the removed account(s) is canceled, a post with
// other accounts is changed in place to skip it (each remaining account keeps its own time and caption).
//
// Left alone (counted as `left`): a post within 2 minutes of going out (it may be on its way), a post already being
// sent, an old post that names networks but not accounts while the network still has an account, and any post the
// posting service refused to change. Those behave as before: the removed account fails at its time.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SocialProvider, SocialResult } from "./social-provider.js";
import type { SocialPostRow } from "./studio-social.js";

type Stored = { id: string | null; platform: string; at?: string | null; caption?: string | null; [k: string]: any };
export type Removed = { platform: string; ids: string[]; leftOnNetwork: number };
export type TakenOff = { changed: number; canceled: number; left: number };

const SOON_MS = 2 * 60_000;

/** Which of a post's sends go to a removed account. Sends that name no account (older posts) count when the network
 *  has no account left, since the service would have used the network's first account. */
export function removedSends(row: Pick<SocialPostRow, "platforms" | "options">, gone: Removed): { keep: Stored[]; hit: Stored[]; legacy: boolean } {
  const stored = (Array.isArray(row.options?.accounts) ? row.options.accounts : []).filter((a: any) => a && a.platform) as Stored[];
  const legacy = !stored.length;
  const sends: Stored[] = legacy ? (row.platforms ?? []).map((platform) => ({ id: null, platform })) : stored;
  const isHit = (t: Stored) => (t.id ? gone.ids.includes(t.id) : t.platform === gone.platform && gone.leftOnNetwork === 0);
  return { keep: sends.filter((t) => !isHit(t)), hit: sends.filter(isHit), legacy };
}

/** The earliest moment any of the post's sends goes out. */
const firstOut = (row: SocialPostRow) => Math.min(...[row.schedule_at, ...((row.options?.accounts ?? []) as Stored[]).map((t) => t.at)].filter(Boolean).map((x) => Date.parse(String(x))));

export async function takeOffWaitingPosts(sb: SupabaseClient, p: SocialProvider, profileKey: string, u: string, gone: Removed, now = Date.now()): Promise<TakenOff> {
  const out: TakenOff = { changed: 0, canceled: 0, left: 0 };
  if (!gone.ids.length && gone.leftOnNetwork > 0) return out;
  const r = await sb.from("studio_social_posts").select("*").eq("user_id", u).in("status", ["scheduled", "queued"]).limit(2000);
  if (r.error) throw r.error;
  for (const row of (r.data ?? []) as SocialPostRow[]) {
    const { keep, hit, legacy } = removedSends(row, gone);
    if (!hit.length) continue;
    try {
      const stamp = new Date().toISOString();
      if (row.status === "scheduled") {
        const t0 = firstOut(row);
        if (!Number.isFinite(t0) || t0 - now < SOON_MS) { out.left++; continue; }
      }
      if (!keep.length) {
        // it went only to the removed account(s): canceled, as the Cancel button does
        if (row.status === "queued") {
          const c = await sb.from("studio_social_posts").update({ status: "canceled", updated_at: stamp }).eq("id", row.id).eq("status", "queued").select("id");
          if ((c.data ?? []).length) out.canceled++; else out.left++;
          continue;
        }
        if (row.provider_post_id) await p.cancel(profileKey, row.provider_post_id);
        await sb.from("studio_social_posts").update({ status: "canceled", updated_at: stamp }).eq("id", row.id).eq("status", "scheduled");
        out.canceled++;
        continue;
      }
      // other accounts remain: the post skips the removed one
      if (legacy) { out.left++; continue; } // a networks-only post can't name which account to keep
      const options = { ...(row.options ?? {}), accounts: keep };
      const platforms = [...new Set(keep.map((t) => t.platform))];
      const hitKeys = new Set(hit.map((t) => (t.id ? `a:${t.id}` : `n:${t.platform}`)));
      const results = ((row.results ?? []) as SocialResult[]).filter((x) => !hitKeys.has(x.account_id ? `a:${x.account_id}` : `n:${x.platform}`));
      if (row.status === "scheduled" && row.provider_post_id) {
        if (!p.update || keep.some((t) => !t.id)) { out.left++; continue; }
        const at = row.schedule_at ? new Date(row.schedule_at) : undefined;
        // the post's own time is passed so each remaining account's own time (spacing between accounts) is kept
        await p.update(profileKey, row.provider_post_id, {
          ...(at ? { scheduleAt: at } : {}),
          targets: keep.map((t) => ({ accountId: t.id!, platform: t.platform, at: t.at ? new Date(t.at) : at ?? null, text: t.caption ?? row.caption })),
        });
      }
      const q = sb.from("studio_social_posts").update({ options, platforms, results, updated_at: stamp }).eq("id", row.id).eq("status", row.status).select("id");
      const w = await q;
      if ((w.data ?? []).length) out.changed++; else out.left++;
    } catch (e) {
      console.warn(`[social] could not take a removed account off post ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      out.left++;
    }
  }
  return out;
}

/** Waiting posts aimed at accounts that are no longer linked at the posting service: taken off them as a removal in
 *  Clone8 does (Nov 26 2026: a customer removed TikTok at 01:55 PT, before takeOffWaitingPosts existed, and 4 posts
 *  scheduled for Nov 27-30 still aimed at it; an account removed on the network itself is the same case). Asks the
 *  service for the live list and does nothing when it cannot be read or comes back empty: an empty answer is never
 *  taken to mean every account is gone. Run from the hourly social upkeep. */
export async function takeOffGoneAccounts(sb: SupabaseClient, p: SocialProvider, profileKey: string, u: string, now = Date.now()): Promise<TakenOff & { gone: string[] }> {
  const out = { changed: 0, canceled: 0, left: 0, gone: [] as string[] };
  const r = await sb.from("studio_social_posts").select("options").eq("user_id", u).in("status", ["scheduled", "queued"]).limit(2000);
  if (r.error) throw r.error;
  const named = new Map<string, string>(); // account id -> platform
  for (const row of (r.data ?? []) as Array<Pick<SocialPostRow, "options">>) for (const a of (Array.isArray(row.options?.accounts) ? row.options.accounts : []) as Stored[]) if (a?.id && a.platform) named.set(a.id, a.platform);
  if (!named.size) return out;
  const live = await p.accounts(profileKey);
  const liveIds = new Set(live.map((a) => a.id).filter(Boolean) as string[]);
  if (!liveIds.size) return out;
  const byPlatform = new Map<string, string[]>();
  for (const [id, platform] of named) if (!liveIds.has(id)) byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), id]);
  for (const [platform, ids] of byPlatform) {
    out.gone.push(...ids);
    const t = await takeOffWaitingPosts(sb, p, profileKey, u, { platform, ids, leftOnNetwork: live.filter((a) => a.platform === platform).length }, now);
    out.changed += t.changed; out.canceled += t.canceled; out.left += t.left;
  }
  return out;
}
