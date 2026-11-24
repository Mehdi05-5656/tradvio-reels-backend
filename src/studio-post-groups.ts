// Posting groups, drafts and the post tray (docs/publishing/PLAN.md, phase 1 + 1b; owner, Nov 22 2026).
//
// A group is a named set of the person's linked accounts ("Group A" = Instagram A + TikTok A) that they post to by
// name from every posting surface. It carries defaults: a sign-off added to captions, how far apart accounts of the
// same network go out (the same clip on two TikToks at the same minute reads as spam), light caption rewording per
// account, an auto-reply, Instagram Trial Reels, YouTube visibility, and posting times for the queue. A group is
// resolved to its accounts when a post is sent; editing it never moves posts already scheduled.
//
// Drafts keep what someone is putting together across pages and devices; the tray is the one draft that collects
// videos from anywhere ("Add to tray") until they are posted.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SocialError, type SocialAccount } from "./social-provider.js";
import { logClaudeCost } from "./studio-pricing.js";

export const MAX_GROUPS = 50;
export const GROUP_COLORS = ["teal", "violet", "amber", "rose", "sky", "lime", "orange", "fuchsia", "slate"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What posting to a group brings along. Every field is optional; the composer can change any of them per post. */
export type GroupDefaults = {
  caption_extra?: string;          // a sign-off, hashtags or a call to action added under the caption
  stagger_minutes?: number;        // accounts of the same network go out this far apart (0 = together)
  vary_captions?: boolean;         // accounts of the same network get a lightly reworded caption each
  autoreply?: { keywords: string[]; dm_message?: string; comment_reply?: string; button?: { title: string; url: string } | null; dm?: boolean } | null;
  instagram_trial?: "auto" | "manual" | null;
  youtube_visibility?: "public" | "unlisted" | "private";
  times?: string[];                // posting times for the queue ("09:00", "18:30"), in `timezone`
  days?: number[];                 // weekdays they apply to, 0 = Sunday
  timezone?: string;
  per_day?: number;                // the posting plan these times came from: posts a day per account
  countries?: string[];            // and where the audience is (zone ids from the page)
};
export type GroupRow = { id: string; user_id: string; name: string; color: string; icon: string | null; account_ids: string[]; defaults: GroupDefaults; position: number; created_at: string; updated_at: string };

/** The defaults a new group starts with (owner's choice, Nov 22 2026): same-network accounts 10 minutes apart and
 *  lightly reworded, so one clip on two TikToks never goes out identical at the same minute. */
export const NEW_GROUP_DEFAULTS: GroupDefaults = { stagger_minutes: 10, vary_captions: true };

const validZone = (z: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } };

/** Defaults as stored: unknown keys dropped, values bounded. */
export function cleanDefaults(raw: any): GroupDefaults {
  const out: GroupDefaults = {};
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.caption_extra === "string" && raw.caption_extra.trim()) out.caption_extra = raw.caption_extra.trim().slice(0, 500);
  if (raw.stagger_minutes != null) out.stagger_minutes = Math.min(Math.max(Math.round(Number(raw.stagger_minutes) || 0), 0), 240);
  if (typeof raw.vary_captions === "boolean") out.vary_captions = raw.vary_captions;
  if (raw.autoreply && typeof raw.autoreply === "object" && Array.isArray(raw.autoreply.keywords)) {
    const keywords = raw.autoreply.keywords.map((k: any) => String(k).trim().toUpperCase().slice(0, 24)).filter(Boolean).slice(0, 10);
    if (keywords.length) out.autoreply = {
      keywords,
      ...(typeof raw.autoreply.dm_message === "string" && raw.autoreply.dm_message.trim() ? { dm_message: raw.autoreply.dm_message.trim().slice(0, 1000) } : {}),
      ...(typeof raw.autoreply.comment_reply === "string" && raw.autoreply.comment_reply.trim() ? { comment_reply: raw.autoreply.comment_reply.trim().slice(0, 500) } : {}),
      ...(raw.autoreply.dm === false ? { dm: false } : {}), // reply only on Instagram and Facebook (studio-reply-only.ts)
      button: raw.autoreply.button && /^https:\/\/.+\..+/.test(String(raw.autoreply.button.url ?? "")) && String(raw.autoreply.button.title ?? "").trim() ? { title: String(raw.autoreply.button.title).trim().slice(0, 20), url: String(raw.autoreply.button.url).trim().slice(0, 500) } : null,
    };
  } else if (raw.autoreply === null) out.autoreply = null;
  if (raw.instagram_trial === "auto" || raw.instagram_trial === "manual" || raw.instagram_trial === null) out.instagram_trial = raw.instagram_trial;
  if (["public", "unlisted", "private"].includes(raw.youtube_visibility)) out.youtube_visibility = raw.youtube_visibility;
  if (Array.isArray(raw.times)) out.times = [...new Set(raw.times.map(String).filter((t: string) => TIME_RE.test(t)))].sort().slice(0, 12) as string[];
  if (Array.isArray(raw.days)) out.days = [...new Set(raw.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[];
  if (typeof raw.timezone === "string" && raw.timezone.length <= 64 && validZone(raw.timezone)) out.timezone = raw.timezone;
  if (raw.per_day != null) out.per_day = Math.min(Math.max(Math.round(Number(raw.per_day) || 1), 1), 12);
  if (Array.isArray(raw.countries)) out.countries = [...new Set(raw.countries.map((c: any) => String(c).toUpperCase()).filter((c: string) => /^[A-Z]{2}(-[A-Z]{1,2})?$/.test(c)))].slice(0, 6) as string[];
  return out;
}

/** A person's groups, in their order. An empty list before the migration is applied. */
export async function groupsOf(sb: SupabaseClient, u: string): Promise<GroupRow[]> {
  const r = await sb.from("studio_social_groups").select("*").eq("user_id", u).order("position", { ascending: true }).order("created_at", { ascending: true });
  if (r.error) { if (/does not exist|relation/i.test(String(r.error.message ?? ""))) return []; throw r.error; }
  return (r.data ?? []) as GroupRow[];
}

/** A group as the pages see it: its accounts that are still linked, and the ones that are not any more. */
export function publicGroup(g: GroupRow, linked: SocialAccount[]) {
  const byId = new Map(linked.filter((a) => a.id).map((a) => [a.id!, a]));
  const accounts = g.account_ids.filter((id) => byId.has(id));
  return {
    id: g.id, name: g.name, color: g.color, icon: g.icon, account_ids: accounts, missing: g.account_ids.length - accounts.length,
    needs_relink: accounts.filter((id) => byId.get(id)?.refresh_required).length,
    networks: [...new Set(accounts.map((id) => byId.get(id)!.platform))], defaults: g.defaults ?? {}, position: g.position,
  };
}

/** Accounts of a network beyond the first get their own time, `stagger` minutes apart, in the order given. Accounts
 *  on different networks keep the same time: Instagram A and TikTok A going out together is fine. */
export function staggerTimes(base: Date, targets: Array<{ platform: string }>, staggerMinutes: number): Date[] {
  const seen = new Map<string, number>();
  return targets.map((t) => {
    const k = seen.get(t.platform) ?? 0;
    seen.set(t.platform, k + 1);
    return new Date(base.getTime() + k * Math.max(0, staggerMinutes) * 60_000);
  });
}

/** Light rewording of a caption for accounts of the same network: same meaning, hashtags and call to action, a
 *  different first line and word order. One model call per caption (Haiku), recorded in the cost ledger. Returns the
 *  original for every slot when the writer is off or fails: a post never waits on it. */
export async function varyCaptions(caption: string, n: number, deps: { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void; user?: string | null } = {}): Promise<string[]> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, key = env.ANTHROPIC_API_KEY;
  if (n <= 1 || !caption.trim() || !key) return Array.from({ length: Math.max(n, 1) }, () => caption);
  try {
    const r = await f("https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.STUDIO_VARY_MODEL || "claude-haiku-5-5", max_tokens: 2000,
        system: "You lightly reword a social media caption so several accounts can post the same video without identical text. Keep the meaning, the language, every hashtag, every @mention, every link and any call to action word (like 'Comment GUIDE') exactly. Change the first line's wording and the sentence order a little. Never add claims, emoji walls or quotation marks. Keep each version about the same length.",
        output_config: { format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["versions"], properties: { versions: { type: "array", items: { type: "string" } } } } } },
        messages: [{ role: "user", content: `Write ${n - 1} reworded version${n - 1 === 1 ? "" : "s"} of this caption:\n"""${caption.slice(0, 2200)}"""` }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body: any = await r.json();
    logClaudeCost(deps.log, "caption_variation", String(body?.model ?? "claude-haiku-5-5"), body?.usage, deps.user ?? null);
    const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
    const versions = (JSON.parse(raw)?.versions ?? []).map((v: any) => String(v).trim().slice(0, 5000)).filter(Boolean);
    return [caption, ...Array.from({ length: n - 1 }, (_, i) => versions[i] ?? caption)];
  } catch (e: any) {
    (deps.log ?? console.log)(`[groups] caption variation skipped: ${String(e?.message ?? e).slice(0, 120)}`);
    return Array.from({ length: n }, () => caption);
  }
}

export function registerPostGroups(app: Express, sbFn: () => SupabaseClient, deps: { log?: (s: string) => void } = {}): void {
  const log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof SocialError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/does not exist|relation/i.test(msg)) return res.status(503).json({ error: "groups_unavailable", detail: "Groups are not switched on yet" });
    if (/duplicate key|unique/i.test(msg)) return res.status(409).json({ error: "group_name_taken", detail: "You already have a group with that name" });
    console.error("[groups]", msg);
    res.status(500).json({ error: "groups_failed", detail: "Something went wrong on our side; try again in a moment" });
  };
  const linkedOf = async (sb: SupabaseClient, u: string): Promise<SocialAccount[]> => {
    const r = await sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    return ((r.data?.accounts ?? []) as SocialAccount[]);
  };
  /** Only the person's own linked accounts can be in a group. */
  const ownIds = (raw: any, linked: SocialAccount[]): string[] => {
    const ids = [...new Set((Array.isArray(raw) ? raw : []).map(String))];
    const mine = new Set(linked.map((a) => a.id).filter(Boolean));
    const bad = ids.filter((id) => !mine.has(id));
    if (bad.length) throw new SocialError("account_not_linked", "One of those accounts is not linked any more. Refresh and pick again.", 409);
    return ids;
  };
  const cleanName = (v: any) => { const n = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 40); if (!n) throw new SocialError("group_name_needed", "Give the group a name"); return n; };
  const cleanColor = (v: any) => (GROUP_COLORS as readonly string[]).includes(String(v)) ? String(v) : "teal";
  const cleanIcon = (v: any) => (typeof v === "string" && v.trim() ? Array.from(v.trim()).slice(0, 2).join("") : null);

  app.get("/api/studio/social/groups", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const [groups, linked] = await Promise.all([groupsOf(sb, u), linkedOf(sb, u)]);
      res.json({ groups: groups.map((g) => publicGroup(g, linked)), colors: GROUP_COLORS });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/social/groups", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), b = req.body ?? {};
      const [groups, linked] = await Promise.all([groupsOf(sb, u), linkedOf(sb, u)]);
      if (groups.length >= MAX_GROUPS) throw new SocialError("group_limit", `Up to ${MAX_GROUPS} groups`, 409);
      if (groups.some((g) => g.name.trim().toLowerCase() === cleanName(b.name).toLowerCase())) throw new SocialError("group_name_taken", "You already have a group with that name", 409);
      const row = {
        user_id: u, name: cleanName(b.name), color: cleanColor(b.color ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]), icon: cleanIcon(b.icon),
        account_ids: ownIds(b.account_ids, linked), defaults: { ...NEW_GROUP_DEFAULTS, ...cleanDefaults(b.defaults) }, position: groups.length,
      };
      const ins = await sb.from("studio_social_groups").insert(row).select("*").single();
      if (ins.error) throw ins.error;
      log(`[groups] ${u} made "${row.name}" with ${row.account_ids.length} account(s)`);
      res.status(201).json({ group: publicGroup(ins.data as GroupRow, linked) });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/studio/social/groups/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new SocialError("group_not_found", "No such group", 404);
      const sb = sbFn(), b = req.body ?? {};
      const cur = await sb.from("studio_social_groups").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) throw new SocialError("group_not_found", "No such group", 404);
      const linked = await linkedOf(sb, u);
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (b.name !== undefined) {
        patch.name = cleanName(b.name);
        if ((await groupsOf(sb, u)).some((g) => g.id !== req.params.id && g.name.trim().toLowerCase() === patch.name.toLowerCase())) throw new SocialError("group_name_taken", "You already have a group with that name", 409);
      }
      if (b.color !== undefined) patch.color = cleanColor(b.color);
      if (b.icon !== undefined) patch.icon = cleanIcon(b.icon);
      if (b.account_ids !== undefined) patch.account_ids = ownIds(b.account_ids, linked);
      // add or take out one account without sending the whole list (linking straight into a group)
      if (typeof b.add_account === "string") patch.account_ids = [...new Set([...(patch.account_ids ?? (cur.data as GroupRow).account_ids), ...ownIds([b.add_account], linked)])];
      if (typeof b.remove_account === "string") patch.account_ids = (patch.account_ids ?? (cur.data as GroupRow).account_ids).filter((x: string) => x !== b.remove_account);
      if (b.defaults !== undefined) patch.defaults = { ...((cur.data as GroupRow).defaults ?? {}), ...cleanDefaults(b.defaults) };
      if (b.position !== undefined) patch.position = Math.max(0, Math.min(Math.round(Number(b.position) || 0), 1000));
      const upd = await sb.from("studio_social_groups").update(patch).eq("id", req.params.id).eq("user_id", u).select("*").single();
      if (upd.error) throw upd.error;
      res.json({ group: publicGroup(upd.data as GroupRow, linked) });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/social/groups/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new SocialError("group_not_found", "No such group", 404);
      const sb = sbFn();
      // posts that went out through it keep their accounts; only the link to the group is cleared (ON DELETE SET NULL)
      const del = await sb.from("studio_social_groups").delete().eq("id", req.params.id).eq("user_id", u).select("id");
      if (del.error) throw del.error;
      if (!(del.data ?? []).length) throw new SocialError("group_not_found", "No such group", 404);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Drafts: what someone is putting together. The tray (kind "tray") is one per person: videos added from anywhere.
  const cleanPayload = (v: any) => {
    const s = JSON.stringify(v ?? {});
    if (s.length > 400_000) throw new SocialError("draft_too_large", "That draft is too large to save");
    return JSON.parse(s);
  };
  app.get("/api/studio/post-drafts", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await sbFn().from("studio_post_drafts").select("id,kind,title,payload,updated_at,created_at").eq("user_id", u).order("updated_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      const rows = (r.data ?? []) as any[];
      res.json({ drafts: rows.filter((d) => d.kind === "draft"), tray: rows.find((d) => d.kind === "tray") ?? null });
    } catch (e) { fail(res, e); }
  });
  app.put("/api/studio/post-drafts/tray", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn(), payload = cleanPayload(req.body?.payload);
      const cur = await sb.from("studio_post_drafts").select("id").eq("user_id", u).eq("kind", "tray").maybeSingle();
      if (cur.error) throw cur.error;
      const now = new Date().toISOString();
      const w = cur.data
        ? await sb.from("studio_post_drafts").update({ payload, updated_at: now }).eq("id", cur.data.id).select("id,kind,title,payload,updated_at").single()
        : await sb.from("studio_post_drafts").insert({ user_id: u, kind: "tray", payload }).select("id,kind,title,payload,updated_at").single();
      if (w.error) throw w.error;
      res.json({ tray: w.data });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/post-drafts", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const n = await sb.from("studio_post_drafts").select("id", { count: "exact", head: true }).eq("user_id", u).eq("kind", "draft");
      if ((n.count ?? 0) >= 100) throw new SocialError("draft_limit", "Up to 100 drafts; post or delete some first", 409);
      const ins = await sb.from("studio_post_drafts").insert({ user_id: u, kind: "draft", title: typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : null, payload: cleanPayload(req.body?.payload) }).select("id,kind,title,payload,updated_at").single();
      if (ins.error) throw ins.error;
      res.status(201).json({ draft: ins.data });
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/post-drafts/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new SocialError("draft_not_found", "No such draft", 404);
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (req.body?.payload !== undefined) patch.payload = cleanPayload(req.body.payload);
      if (typeof req.body?.title === "string") patch.title = req.body.title.slice(0, 120);
      const upd = await sbFn().from("studio_post_drafts").update(patch).eq("id", req.params.id).eq("user_id", u).eq("kind", "draft").select("id,kind,title,payload,updated_at").maybeSingle();
      if (upd.error) throw upd.error;
      if (!upd.data) throw new SocialError("draft_not_found", "No such draft", 404);
      res.json({ draft: upd.data });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/post-drafts/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID_RE.test(req.params.id)) throw new SocialError("draft_not_found", "No such draft", 404);
      const del = await sbFn().from("studio_post_drafts").delete().eq("id", req.params.id).eq("user_id", u).select("id");
      if (del.error) throw del.error;
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}
