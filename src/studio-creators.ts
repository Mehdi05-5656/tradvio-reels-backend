// Clone8 Studio: the Creator Program. Creators post videos made with Clone8 on their own TikTok and Instagram accounts
// and are paid per view. The steps, in order:
//   1. Join: accept the program terms (versioned) and say where to be paid.
//   2. Enroll an account: one of the TikTok / Instagram accounts they linked through Ayrshare (the same link the Publish
//      page uses). One person per account; the follower count at enrollment is kept for review.
//   3. Bio: "powered by @clone8.io" in the account's bio, checked on the public profile; until it is there, nothing counts.
//   4. Videos: every video posted on an enrolled account after it joined is found through Ayrshare (also ones posted in
//      the TikTok / Instagram app). A video counts once it is shown to be made with Clone8: posted through Clone8, or
//      linked by the creator to one of their Clone8 generations. Views are read every few hours.
//   5. Earnings: views count for RULES.view_window_days after posting, up to RULES.view_cap per video, at RULES.cpm_usd per
//      1,000. Each month has a statement; on the 1st it closes for review (under the minimum it carries over), the owner
//      approves or withholds it in the admin panel, pays it and marks it paid.
// Anything that looks bought (followers jumping, views without engagement) is flagged for the owner, never paid on its own.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSocialProvider, type ProviderPost, type SocialDeps, type SocialProvider } from "./social-provider.js";
import { hasPlanAccess } from "./studio-limits.js";
import { isStudioAdmin } from "./studio-admin-auth.js";

// Modelled on Higgsfield Earn (creators.higgsfield.ai/terms and its Platform Creator Agreement, read Oct 31 2026): organic
// views only, a disclosure tag on every video (theirs is #higgsfieldpartner), videos kept public 90 days, one appeal per
// rejection, clawback within 12 months when over 15% of views prove non-organic, 18+. The per-video minimum and the
// monthly minimum payout follow comparable pay-per-view funds (AKOOL, Whop content rewards).
export const RULES = {
  terms_version: "2026-10-31",
  cpm_usd: 1,
  view_cap: 1_000_000,
  view_window_days: 30,
  // a video earns once it passes this many views (then every view up to the cap counts)
  min_views: 1_000,
  min_payout_usd: 50,
  min_age: 18,
  disclosure_tag: "#clone8partner",
  keep_live_days: 90,
  clawback_months: 12,
  clawback_share: 0.15,
  platforms: ["tiktok", "instagram"] as const,
  bio_phrase: "powered by @clone8.io",
  // the bio check accepts the handle or the domain, any case, with or without the "powered by"
  bio_match: /@?clone8(\.io)?/i,
  // a video's views are re-read for this long after posting (a little past the window so late counts settle)
  sync_days: 35,
};
export type CreatorPlatform = (typeof RULES.platforms)[number];
const MICROS_PER_VIEW = Math.round((RULES.cpm_usd * 1_000_000) / 1000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const monthOf = (d: Date = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
export const nextPayout = (d: Date = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
export const usd = (micros: number) => Math.round(micros / 10_000) / 100;

/** A video's views that can count, never more than the cap. The window is applied where views are added (accrueVideo):
 *  views read after view_window_days are not added, so growth after the window never pays. */
export function countable(v: { views: number; posted_at: string | null }): number {
  if (!v.posted_at || !Number.isFinite(Date.parse(v.posted_at))) return 0;
  const views = Number(v.views) || 0;
  if (views < RULES.min_views) return 0;
  return Math.max(0, Math.min(views, RULES.view_cap));
}
/** The disclosure tag in the caption (any case). Without it a video is found but does not earn. */
export const hasDisclosure = (caption: string | null | undefined) => new RegExp(RULES.disclosure_tag.replace("#", "#\\s?"), "i").test(String(caption ?? ""));
export const inWindow = (posted_at: string | null, now: Date = new Date()) => !!posted_at && now.getTime() - Date.parse(posted_at) <= RULES.view_window_days * 86_400_000;

/** A TikTok or Instagram post id from its URL (TikTok /video/123…, Instagram /reel/ABC or /p/ABC). */
export function postIdOf(url: string | null | undefined): string | null {
  const s = String(url ?? "");
  return s.match(/\/video\/(\d{6,})/)?.[1] ?? s.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/)?.[1] ?? null;
}

/** Things worth a human look before money moves. Never decides on its own. */
export function videoFlags(p: { views: number | null; likes: number | null; comments: number | null }): string[] {
  const views = Number(p.views) || 0, likes = Number(p.likes) || 0, comments = Number(p.comments) || 0;
  const flags: string[] = [];
  if (views >= 50_000 && likes / views < 0.002) flags.push("views_without_likes");
  if (views >= 200_000 && comments === 0) flags.push("no_comments");
  return flags;
}
export function accountFlags(a: { followers_at_enroll: number | null; followers: number | null; days: number }): string[] {
  const start = Number(a.followers_at_enroll) || 0, now = Number(a.followers) || 0;
  if (start >= 100 && now > start * 3 && a.days <= 14) return ["followers_jumped"];
  return [];
}

type Deps = SocialDeps & { provider?: SocialProvider | null; scrape?: (platform: CreatorPlatform, handle: string) => Promise<{ bio: string | null; followers: number | null } | null> };

/** The bio and followers on the public profile (ScrapeCreators); null when it could not be read. */
async function publicProfile(deps: Deps, platform: CreatorPlatform, handle: string): Promise<{ bio: string | null; followers: number | null } | null> {
  if (deps.scrape) return deps.scrape(platform, handle);
  const key = (deps.env ?? process.env).SCRAPECREATORS_API_KEY;
  if (!key) return null;
  const h = encodeURIComponent(handle.replace(/^@/, ""));
  const path = platform === "tiktok" ? `/v1/tiktok/profile?handle=${h}` : `/v1/instagram/profile?handle=${h}`;
  try {
    const r = await (deps.fetch ?? fetch)(`https://api.scrapecreators.com${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const b: any = await r.json();
    if (platform === "tiktok") return { bio: b?.user?.signature ?? null, followers: Number(b?.stats?.followerCount ?? b?.statsV2?.followerCount) || null };
    return { bio: b?.data?.user?.biography ?? null, followers: Number(b?.data?.user?.edge_followed_by?.count) || null };
  } catch { return null; }
}

export async function checkBio(sb: SupabaseClient, deps: Deps, account: any): Promise<{ ok: boolean; read: boolean }> {
  const prof = await publicProfile(deps, account.platform, account.username);
  if (!prof) { await sb.from("studio_creator_accounts").update({ bio_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", account.id); return { ok: !!account.bio_ok, read: false }; }
  const ok = RULES.bio_match.test(prof.bio ?? "");
  const days = Math.max(0, (Date.now() - Date.parse(account.enrolled_at ?? new Date().toISOString())) / 86_400_000);
  const flags = [...new Set([...(Array.isArray(account.flags) ? account.flags : []).filter((f: string) => f !== "bio_missing"), ...accountFlags({ followers_at_enroll: account.followers_at_enroll ?? prof.followers, followers: prof.followers, days }), ...(ok ? [] : account.status === "active" ? ["bio_missing"] : [])])];
  const status = account.status === "suspended" || account.status === "removed" ? account.status : ok ? "active" : "pending_bio";
  await sb.from("studio_creator_accounts").update({ bio_ok: ok, bio_checked_at: new Date().toISOString(), bio_excerpt: (prof.bio ?? "").slice(0, 160), followers: prof.followers, followers_checked_at: new Date().toISOString(), followers_at_enroll: account.followers_at_enroll ?? prof.followers, flags, status, updated_at: new Date().toISOString() }).eq("id", account.id);
  return { ok, read: true };
}

/** One video's new views into this month's statement (atomic, never twice). Views after the window are not added. */
async function accrueVideo(sb: SupabaseClient, v: any, now: Date = new Date()): Promise<number> {
  if (v.status !== "eligible" || !inWindow(v.posted_at, now)) return 0;
  const r = await sb.rpc("studio_creator_accrue", { p_video: v.id, p_counted: countable(v), p_month: monthOf(now), p_micros_per_view: MICROS_PER_VIEW });
  if (r.error) throw r.error;
  return Number(r.data?.added ?? 0);
}

/** Posts on an enrolled account since it joined: stored, matched to Clone8 posts, views counted. */
export async function syncAccount(sb: SupabaseClient, deps: Deps, account: any, profileKey: string, now: Date = new Date()): Promise<{ found: number; added_views: number }> {
  const p = deps.provider ?? getSocialProvider(deps);
  if (!p?.recentPosts) return { found: 0, added_views: 0 };
  const posts: ProviderPost[] = await p.recentPosts(profileKey, account.platform, 50);
  const since = Date.parse(account.enrolled_at) - 60_000;
  const fresh = posts.filter((x) => x.published_at && Date.parse(x.published_at) >= since && now.getTime() - Date.parse(x.published_at) <= RULES.sync_days * 86_400_000);
  // what this person posted through Clone8, by post id, so those videos count without a link
  const viaClone8 = new Map<string, { job_id: string | null; output_key: string | null }>();
  const sent = await sb.from("studio_social_posts").select("job_id,output_key,results").eq("user_id", account.user_id).gte("created_at", new Date(since - 86_400_000).toISOString()).limit(500);
  for (const row of (sent.data ?? []) as any[]) for (const r of (row.results ?? []) as any[]) { const id = postIdOf(r?.url); if (id && r?.platform === account.platform) viaClone8.set(id, { job_id: row.job_id ?? null, output_key: row.output_key ?? null }); }
  let added = 0;
  for (const x of fresh) {
    const pid = postIdOf(x.url) ?? String(x.id);
    const existing = await sb.from("studio_creator_videos").select("*").eq("platform", account.platform).eq("platform_post_id", pid).maybeSingle();
    const clone8 = viaClone8.get(pid);
    const flags = videoFlags(x);
    const metrics = { views: Number(x.views) || 0, likes: x.likes, comments: x.comments, shares: x.shares, views_at: now.toISOString(), url: x.url, caption: (x.caption ?? "").slice(0, 500), thumb_url: x.thumb_url, updated_at: now.toISOString() };
    let row: any = existing.data;
    if (!row) {
      const tagged = hasDisclosure(x.caption);
      const ins = await sb.from("studio_creator_videos").insert({ account_id: account.id, user_id: account.user_id, platform: account.platform, platform_post_id: pid, posted_at: x.published_at, ...metrics, flags: [...flags, ...(tagged ? [] : ["missing_tag"])],
        ...(clone8 ? { proof: "posted_via_clone8", job_id: clone8.job_id, output_key: clone8.output_key, status: account.status === "active" && tagged ? "eligible" : "pending" } : {}) }).select("*").single();
      if (ins.error) { if (/duplicate|unique/i.test(String(ins.error.message))) continue; throw ins.error; }
      row = ins.data;
    } else {
      if (row.user_id !== account.user_id) continue; // someone else's video (an account enrolled before): never re-owned
      const upgrade = clone8 && row.proof === "none" ? { proof: "posted_via_clone8", job_id: clone8.job_id, output_key: clone8.output_key } : {};
      // the tag can be added to a caption later (Instagram allows edits): the video then starts earning
      const tagged = hasDisclosure(x.caption);
      const status = row.status === "pending" && (row.proof !== "none" || clone8) && account.status === "active" && tagged ? "eligible" : row.status;
      const kept = (row.flags ?? []).filter((f: string) => f !== "missing_tag");
      const w = await sb.from("studio_creator_videos").update({ ...metrics, ...upgrade, status, flags: [...new Set([...kept, ...flags, ...(tagged ? [] : ["missing_tag"])])] }).eq("id", row.id).select("*").single();
      if (w.error) throw w.error;
      row = w.data;
    }
    if (account.status === "active") added += await accrueVideo(sb, row, now);
  }
  await sb.from("studio_creator_accounts").update({ synced_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", account.id);
  return { found: fresh.length, added_views: added };
}

/** On the 1st: last month's open statements close. Under the minimum they carry into this month; the rest wait for review. */
export async function closeMonths(sb: SupabaseClient, now: Date = new Date()): Promise<number> {
  const current = monthOf(now);
  const open = await sb.from("studio_creator_earnings").select("*").eq("status", "open").lt("month", current).limit(1000);
  if (open.error) throw open.error;
  let n = 0;
  for (const e of (open.data ?? []) as any[]) {
    const total = Number(e.amount_micros) + Number(e.carried_in_micros);
    if (total < RULES.min_payout_usd * 1_000_000) {
      await sb.from("studio_creator_earnings").upsert({ user_id: e.user_id, month: current }, { onConflict: "user_id,month", ignoreDuplicates: true });
      const next = await sb.from("studio_creator_earnings").select("carried_in_micros,status").eq("user_id", e.user_id).eq("month", current).maybeSingle();
      if (next.data?.status === "open") await sb.from("studio_creator_earnings").update({ carried_in_micros: Number(next.data.carried_in_micros) + total, updated_at: now.toISOString() }).eq("user_id", e.user_id).eq("month", current);
      await sb.from("studio_creator_earnings").update({ status: "carried", note: `Under the $${RULES.min_payout_usd} minimum: carried into ${current.slice(0, 7)}`, updated_at: now.toISOString() }).eq("user_id", e.user_id).eq("month", e.month).eq("status", "open");
    } else await sb.from("studio_creator_earnings").update({ status: "review", updated_at: now.toISOString() }).eq("user_id", e.user_id).eq("month", e.month).eq("status", "open");
    n++;
  }
  return n;
}

/** Every few hours: re-check bios once a day, read new posts and views on every enrolled account, close past months. */
export async function creatorTick(sb: SupabaseClient, deps: Deps = {}, now: Date = new Date()): Promise<{ accounts: number; views: number }> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const accs = await sb.from("studio_creator_accounts").select("*").in("status", ["pending_bio", "active"]).limit(500);
  if (accs.error) throw accs.error;
  let views = 0, n = 0;
  for (const a of (accs.data ?? []) as any[]) {
    try {
      const member = await sb.from("studio_creator_members").select("status").eq("user_id", a.user_id).maybeSingle();
      if (member.data?.status !== "active") continue;
      if (!a.bio_checked_at || now.getTime() - Date.parse(a.bio_checked_at) > 86_400_000) await checkBio(sb, deps, a);
      const fresh = await sb.from("studio_creator_accounts").select("*").eq("id", a.id).single();
      const prof = await sb.from("studio_social_profiles").select("profile_key").eq("user_id", a.user_id).maybeSingle();
      if (!prof.data?.profile_key) continue;
      const r = await syncAccount(sb, deps, fresh.data ?? a, prof.data.profile_key, now);
      views += r.added_views; n++;
    } catch (e: any) { log(`[creators] sync ${a.id}: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  // closing only touches months before this one, so it is safe on every pass (and catches a missed 1st)
  const closed = await closeMonths(sb, now).catch((e) => { log(`[creators] close: ${String(e?.message ?? e).slice(0, 120)}`); return 0; });
  if (closed) log(`[creators] closed ${closed} statements`);
  return { accounts: n, views };
}

export function startCreatorLoop(sbFn: () => SupabaseClient, deps: Deps = {}): void {
  const env = deps.env ?? process.env;
  if (env.STUDIO_CREATORS_ENABLED !== "true") return;
  const every = Math.max(30, Number(env.STUDIO_CREATORS_SYNC_MINUTES) || 180) * 60_000;
  const run = () => creatorTick(sbFn(), deps).then((r) => { if (r.accounts) console.log(`[creators] synced ${r.accounts} accounts, ${r.views} new views counted`); }).catch((e) => console.error(`[creators] tick: ${String(e?.message ?? e).slice(0, 160)}`));
  setTimeout(run, 60_000).unref?.();
  setInterval(run, every).unref?.();
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------
export class CreatorError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** Everything the Earn page shows for one person. */
export async function creatorState(sb: SupabaseClient, u: string, env: Record<string, string | undefined> = process.env) {
  const [cust, member, accounts, videos, earnings, profile] = await Promise.all([
    sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle(),
    sb.from("studio_creator_members").select("*").eq("user_id", u).maybeSingle(),
    sb.from("studio_creator_accounts").select("*").eq("user_id", u).neq("status", "removed").order("enrolled_at", { ascending: true }),
    sb.from("studio_creator_videos").select("*").eq("user_id", u).order("posted_at", { ascending: false }).limit(100),
    sb.from("studio_creator_earnings").select("*").eq("user_id", u).order("month", { ascending: false }).limit(24),
    sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle(),
  ]);
  for (const r of [member, accounts, videos, earnings]) if (r.error) throw r.error;
  const linked = ((profile.data?.accounts ?? []) as any[]).filter((a) => (RULES.platforms as readonly string[]).includes(a?.platform)).map((a) => ({ platform: a.platform, username: a.username, display_name: a.display_name ?? null, image_url: a.image_url ?? null }));
  const month = monthOf();
  const statements = ((earnings.data ?? []) as any[]).map((e) => ({ month: e.month, views: Number(e.views), amount_usd: usd(Number(e.amount_micros)), carried_in_usd: usd(Number(e.carried_in_micros)), total_usd: usd(Number(e.amount_micros) + Number(e.carried_in_micros)), status: e.status, paid_at: e.paid_at, note: e.note }));
  const member0: any = member.data;
  return {
    enabled: env.STUDIO_CREATORS_ENABLED === "true",
    social_enabled: env.STUDIO_SOCIAL_ENABLED === "true",
    plan: hasPlanAccess(cust.data as any),
    rules: { terms_version: RULES.terms_version, cpm_usd: RULES.cpm_usd, view_cap: RULES.view_cap, view_window_days: RULES.view_window_days, min_views: RULES.min_views, min_payout_usd: RULES.min_payout_usd, min_age: RULES.min_age, platforms: RULES.platforms, bio_phrase: RULES.bio_phrase, disclosure_tag: RULES.disclosure_tag, keep_live_days: RULES.keep_live_days, clawback_months: RULES.clawback_months, clawback_share: RULES.clawback_share },
    member: member0 ? { status: member0.status, terms_version: member0.terms_version, terms_current: member0.terms_version === RULES.terms_version, payout_method: member0.payout_method, payout_email: member0.payout_email, legal_name: member0.legal_name, country: member0.country, joined_at: member0.created_at } : null,
    linked,
    accounts: ((accounts.data ?? []) as any[]).map((a) => ({ id: a.id, platform: a.platform, username: a.username, status: a.status, bio_ok: a.bio_ok, bio_checked_at: a.bio_checked_at, followers: a.followers, enrolled_at: a.enrolled_at, synced_at: a.synced_at, flagged: (a.flags ?? []).length > 0 })),
    videos: ((videos.data ?? []) as any[]).map((v) => ({ id: v.id, platform: v.platform, url: v.url, caption: v.caption, thumb_url: v.thumb_url, posted_at: v.posted_at, views: Number(v.views), views_counted: Number(v.views_counted), earned_usd: usd(Number(v.views_counted) * MICROS_PER_VIEW), proof: v.proof, status: v.status, reject_reason: v.reject_reason, in_window: inWindow(v.posted_at), tagged: hasDisclosure(v.caption), below_min: Number(v.views) < RULES.min_views })),
    this_month: statements.find((s) => s.month === month) ?? { month, views: 0, amount_usd: 0, carried_in_usd: 0, total_usd: 0, status: "open", paid_at: null, note: null },
    statements,
    next_payout: nextPayout(),
    lifetime_paid_usd: statements.filter((s) => s.status === "paid").reduce((n, s) => n + s.total_usd, 0),
  };
}

export function registerCreators(app: Express, sbFn: () => SupabaseClient, deps: Deps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof CreatorError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist|function .* does not exist/i.test(msg)) return res.status(503).json({ error: "creators_unavailable", detail: "The Creator Program is not switched on yet" });
    if (/studio_creator_accounts_one_owner|duplicate key/i.test(msg)) return res.status(409).json({ error: "account_taken", detail: "That account is already in the program under another Clone8 account" });
    console.error("[creators]", msg);
    res.status(500).json({ error: "creators_failed", detail: msg.slice(0, 200) });
  };
  const on = (res: Response) => { if (env.STUDIO_CREATORS_ENABLED !== "true") { res.status(503).json({ error: "creators_off", detail: "The Creator Program opens soon" }); return false; } return true; };
  const member = async (sb: SupabaseClient, u: string) => { const m = await sb.from("studio_creator_members").select("*").eq("user_id", u).maybeSingle(); if (m.error) throw m.error; if (!m.data || m.data.status !== "active") throw new CreatorError("not_a_member", "Join the Creator Program first", 409); if (m.data.terms_version !== RULES.terms_version) throw new CreatorError("terms_updated", "The program terms changed; read and accept them again", 409); return m.data; };
  const sync = new Map<string, number>();

  app.get("/api/studio/creators", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try { res.json(await creatorState(sbFn(), u, env)); } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/creators/join", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn();
      const b = req.body ?? {};
      if (b.accept !== true || b.terms_version !== RULES.terms_version) throw new CreatorError("terms_required", "Read and accept the program terms");
      if (b.age_confirmed !== true) throw new CreatorError("age_required", `The program is for people ${RULES.min_age} or older`);
      const method = ["paypal", "wise"].includes(b.payout_method) ? b.payout_method : null;
      const email = String(b.payout_email ?? "").trim().toLowerCase();
      if (!method || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) throw new CreatorError("payout_required", "Add the PayPal or Wise email we pay you at");
      const row = { user_id: u, status: "active", terms_version: RULES.terms_version, terms_accepted_at: new Date().toISOString(), terms_ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].slice(0, 64) || null, payout_method: method, payout_email: email, legal_name: String(b.legal_name ?? "").trim().slice(0, 120) || null, country: String(b.country ?? "").trim().slice(0, 60) || null, updated_at: new Date().toISOString() };
      const prev = await sb.from("studio_creator_members").select("status").eq("user_id", u).maybeSingle();
      if (prev.data?.status === "removed") throw new CreatorError("removed", "This account was removed from the program; write to support@clone8.io", 403);
      const w = await sb.from("studio_creator_members").upsert(row, { onConflict: "user_id" });
      if (w.error) throw w.error;
      log(`[creators] joined ${u} (terms ${RULES.terms_version})`);
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/creators/payout", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn(); await member(sb, u);
      const method = ["paypal", "wise"].includes(req.body?.payout_method) ? req.body.payout_method : null;
      const email = String(req.body?.payout_email ?? "").trim().toLowerCase();
      if (!method || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new CreatorError("payout_required", "Add the PayPal or Wise email we pay you at");
      const w = await sb.from("studio_creator_members").update({ payout_method: method, payout_email: email, legal_name: String(req.body?.legal_name ?? "").trim().slice(0, 120) || null, country: String(req.body?.country ?? "").trim().slice(0, 60) || null, updated_at: new Date().toISOString() }).eq("user_id", u);
      if (w.error) throw w.error;
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  // enroll one of the person's linked TikTok / Instagram accounts
  app.post("/api/studio/creators/accounts", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn(); await member(sb, u);
      const platform = String(req.body?.platform ?? "") as CreatorPlatform;
      if (!(RULES.platforms as readonly string[]).includes(platform)) throw new CreatorError("platform_not_in_program", "TikTok and Instagram are in the program for now");
      const prof = await sb.from("studio_social_profiles").select("accounts").eq("user_id", u).maybeSingle();
      const linked = ((prof.data?.accounts ?? []) as any[]).find((a) => a?.platform === platform && a?.username);
      if (!linked) throw new CreatorError("not_linked", `Link your ${platform === "tiktok" ? "TikTok" : "Instagram"} account first`, 409);
      const username = String(linked.username).replace(/^@/, "");
      const mine = await sb.from("studio_creator_accounts").select("*").eq("user_id", u).eq("platform", platform).neq("status", "removed").maybeSingle();
      if (mine.data && mine.data.username.toLowerCase() === username.toLowerCase()) { await checkBio(sb, deps, mine.data); return res.json(await creatorState(sb, u, env)); }
      if (mine.data) await sb.from("studio_creator_accounts").update({ status: "removed", note: "replaced by another linked account", updated_at: new Date().toISOString() }).eq("id", mine.data.id);
      const ins = await sb.from("studio_creator_accounts").insert({ user_id: u, platform, username, profile_url: linked.profile_url ?? null }).select("*").single();
      if (ins.error) throw ins.error;
      await checkBio(sb, deps, ins.data);
      log(`[creators] enrolled ${platform}/${username} for ${u}`);
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/creators/accounts/:id/check-bio", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn(); await member(sb, u);
      if (!UUID_RE.test(req.params.id)) throw new CreatorError("account_not_found", "No such account", 404);
      const a = await sb.from("studio_creator_accounts").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (!a.data) throw new CreatorError("account_not_found", "No such account", 404);
      const r = await checkBio(sb, deps, a.data);
      res.json({ ...(await creatorState(sb, u, env)), bio: r });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/creators/accounts/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new CreatorError("account_not_found", "No such account", 404);
      const w = await sb.from("studio_creator_accounts").update({ status: "removed", note: "left by the creator", updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", u);
      if (w.error) throw w.error;
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  // "this video was made with Clone8": linked to one of the person's own finished generations
  app.post("/api/studio/creators/videos/:id/link", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn(); await member(sb, u);
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(String(req.body?.job_id ?? ""))) throw new CreatorError("video_not_found", "No such video", 404);
      const v = await sb.from("studio_creator_videos").select("*").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (!v.data) throw new CreatorError("video_not_found", "No such video", 404);
      if (v.data.status === "rejected") throw new CreatorError("video_rejected", v.data.reject_reason ?? "This video does not qualify", 409);
      const j = await sb.from("studio_jobs").select("id,status,outputs,finished_at").eq("id", req.body.job_id).eq("user_id", u).maybeSingle();
      if (!j.data || j.data.status !== "done") throw new CreatorError("generation_not_found", "Pick one of your finished Clone8 videos", 404);
      const key = String(req.body?.output_key ?? "") || (j.data.outputs?.[0]?.key ?? null);
      if (key && !((j.data.outputs ?? []) as any[]).some((o) => o?.key === key)) throw new CreatorError("generation_not_found", "Pick one of your finished Clone8 videos", 404);
      // made before it was posted
      if (j.data.finished_at && v.data.posted_at && Date.parse(j.data.finished_at) > Date.parse(v.data.posted_at) + 3_600_000) throw new CreatorError("generation_after_post", "That Clone8 video was made after this post went up; pick the one you posted");
      const acc = await sb.from("studio_creator_accounts").select("*").eq("id", v.data.account_id).maybeSingle();
      const status = acc.data?.status === "active" && hasDisclosure(v.data.caption) ? "eligible" : "pending";
      const w = await sb.from("studio_creator_videos").update({ proof: "linked", job_id: j.data.id, output_key: key, status, updated_at: new Date().toISOString() }).eq("id", v.data.id).select("*").single();
      if (w.error) throw w.error;
      if (status === "eligible") await accrueVideo(sb, w.data);
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/creators/sync", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" }); if (!on(res)) return;
    try {
      const sb = sbFn(); await member(sb, u);
      const last = sync.get(u) ?? 0;
      if (Date.now() - last < 10 * 60_000) throw new CreatorError("sync_too_soon", "Videos were read a few minutes ago; they refresh every few hours on their own", 429);
      sync.set(u, Date.now());
      const prof = await sb.from("studio_social_profiles").select("profile_key").eq("user_id", u).maybeSingle();
      const accs = await sb.from("studio_creator_accounts").select("*").eq("user_id", u).in("status", ["pending_bio", "active"]);
      for (const a of (accs.data ?? []) as any[]) { await checkBio(sb, deps, a); const fresh = await sb.from("studio_creator_accounts").select("*").eq("id", a.id).single(); if (prof.data?.profile_key) await syncAccount(sb, deps, fresh.data, prof.data.profile_key); }
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/creators/leave", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      await sb.from("studio_creator_accounts").update({ status: "removed", note: "left the program", updated_at: new Date().toISOString() }).eq("user_id", u).neq("status", "removed");
      const w = await sb.from("studio_creator_members").update({ status: "paused", updated_at: new Date().toISOString() }).eq("user_id", u).eq("status", "active");
      if (w.error) throw w.error;
      res.json(await creatorState(sb, u, env));
    } catch (e) { fail(res, e); }
  });

  // ---- the owner's side: every creator, every month, and the decisions ----
  const admin = async (req: Request, res: Response) => { const sb = sbFn(); if (!(await isStudioAdmin(req, sb, env))) { res.status(404).json({ error: "not_found" }); return null; } return sb; };
  app.get("/api/studio/admin/creators", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = await admin(req, res); if (!sb) return;
      const [members, accounts, earnings, flagged] = await Promise.all([
        sb.from("studio_creator_members").select("*").limit(2000),
        sb.from("studio_creator_accounts").select("*").neq("status", "removed").limit(5000),
        sb.from("studio_creator_earnings").select("*").order("month", { ascending: false }).limit(5000),
        sb.from("studio_creator_videos").select("id,user_id,platform,url,caption,views,likes,comments,views_counted,status,proof,flags,posted_at,job_id").in("status", ["pending", "eligible"]).order("views", { ascending: false }).limit(500),
      ]);
      for (const r of [members, accounts, earnings]) if (r.error) throw r.error;
      const emails = new Map<string, string>();
      const ids = ((members.data ?? []) as any[]).map((m) => m.user_id);
      for (const id of ids.slice(0, 500)) { const g = await (sb as any).auth?.admin?.getUserById?.(id).catch(() => null); if (g?.data?.user?.email) emails.set(id, g.data.user.email); }
      const byMonth = new Map<string, { month: string; creators: number; views: number; earned_usd: number; due_usd: number; paid_usd: number; withheld_usd: number }>();
      for (const e of (earnings.data ?? []) as any[]) {
        const m = byMonth.get(e.month) ?? { month: e.month, creators: 0, views: 0, earned_usd: 0, due_usd: 0, paid_usd: 0, withheld_usd: 0 };
        const total = usd(Number(e.amount_micros) + Number(e.carried_in_micros));
        m.creators++; m.views += Number(e.views); m.earned_usd += usd(Number(e.amount_micros));
        if (e.status === "paid") m.paid_usd += total; else if (e.status === "withheld") m.withheld_usd += total; else if (e.status === "review" || e.status === "approved") m.due_usd += total;
        byMonth.set(e.month, m);
      }
      res.json({
        rules: RULES,
        months: [...byMonth.values()].map((m) => ({ ...m, earned_usd: Math.round(m.earned_usd * 100) / 100, due_usd: Math.round(m.due_usd * 100) / 100, paid_usd: Math.round(m.paid_usd * 100) / 100, withheld_usd: Math.round(m.withheld_usd * 100) / 100 })).sort((a, b) => b.month.localeCompare(a.month)),
        creators: ((members.data ?? []) as any[]).map((m) => ({
          user_id: m.user_id, email: emails.get(m.user_id) ?? null, status: m.status, joined_at: m.created_at, payout_method: m.payout_method, payout_email: m.payout_email, legal_name: m.legal_name, country: m.country,
          accounts: ((accounts.data ?? []) as any[]).filter((a) => a.user_id === m.user_id).map((a) => ({ id: a.id, platform: a.platform, username: a.username, status: a.status, bio_ok: a.bio_ok, followers: a.followers, followers_at_enroll: a.followers_at_enroll, flags: a.flags })),
          statements: ((earnings.data ?? []) as any[]).filter((e) => e.user_id === m.user_id).map((e) => ({ month: e.month, views: Number(e.views), amount_usd: usd(Number(e.amount_micros)), total_usd: usd(Number(e.amount_micros) + Number(e.carried_in_micros)), status: e.status, paid_at: e.paid_at, payout_ref: e.payout_ref, note: e.note })),
        })),
        // what needs a look: flagged videos (counting or not), then the biggest ones still waiting for proof
        review: ((flagged.data ?? []) as any[]).filter((v) => (v.flags ?? []).length > 0 || v.status === "pending").slice(0, 200).map((v) => ({ ...v, views: Number(v.views), views_counted: Number(v.views_counted), email: emails.get(v.user_id) ?? null })),
      });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/admin/creators/statements", async (req, res) => {
    try {
      const sb = await admin(req, res); if (!sb) return;
      const u = String(req.body?.user_id ?? ""), month = String(req.body?.month ?? ""), action = String(req.body?.action ?? "");
      if (!UUID_RE.test(u) || !/^\d{4}-\d{2}-01$/.test(month)) throw new CreatorError("bad_request", "Which statement?");
      const to: Record<string, { from: string[]; status: string }> = { approve: { from: ["review"], status: "approved" }, withhold: { from: ["open", "review", "approved"], status: "withheld" }, paid: { from: ["approved"], status: "paid" }, reopen: { from: ["withheld"], status: "review" } };
      const t = to[action]; if (!t) throw new CreatorError("bad_request", "approve, withhold, paid or reopen");
      const w = await sb.from("studio_creator_earnings").update({ status: t.status, ...(action === "paid" ? { paid_at: new Date().toISOString(), payout_ref: String(req.body?.payout_ref ?? "").slice(0, 120) || null } : {}), ...(req.body?.note ? { note: String(req.body.note).slice(0, 300) } : {}), updated_at: new Date().toISOString() }).eq("user_id", u).eq("month", month).in("status", t.from).select("*");
      if (w.error) throw w.error;
      if (!(w.data ?? []).length) throw new CreatorError("wrong_state", "That statement is not in a state for that", 409);
      log(`[creators] statement ${u} ${month} → ${t.status}`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/admin/creators/videos/:id", async (req, res) => {
    try {
      const sb = await admin(req, res); if (!sb) return;
      if (!UUID_RE.test(req.params.id)) throw new CreatorError("video_not_found", "No such video", 404);
      const action = String(req.body?.action ?? "");
      const patch = action === "reject" ? { status: "rejected", reject_reason: String(req.body?.reason ?? "Does not meet the program rules").slice(0, 200) } : action === "approve" ? { status: "eligible", reject_reason: null, flags: [] } : null;
      if (!patch) throw new CreatorError("bad_request", "reject or approve");
      const w = await sb.from("studio_creator_videos").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", req.params.id).select("*").single();
      if (w.error) throw w.error;
      if (action === "approve") await accrueVideo(sb, w.data);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/admin/creators/accounts/:id", async (req, res) => {
    try {
      const sb = await admin(req, res); if (!sb) return;
      if (!UUID_RE.test(req.params.id)) throw new CreatorError("account_not_found", "No such account", 404);
      const action = String(req.body?.action ?? "");
      const status = action === "suspend" ? "suspended" : action === "restore" ? "pending_bio" : action === "remove" ? "removed" : null;
      if (!status) throw new CreatorError("bad_request", "suspend, restore or remove");
      const w = await sb.from("studio_creator_accounts").update({ status, note: String(req.body?.note ?? "").slice(0, 300) || null, ...(action === "restore" ? { flags: [] } : {}), updated_at: new Date().toISOString() }).eq("id", req.params.id).select("*").single();
      if (w.error) throw w.error;
      if (action === "restore") await checkBio(sb, deps, w.data);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}
