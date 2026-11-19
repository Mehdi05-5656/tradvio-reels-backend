// Routes and the loop for content performance (studio-content-perf.ts). The admin routes answer the owner's account
// only (404 to anyone else, like the rest of the admin panel); the one open route lists the tracked accounts for the
// question after sign-up ("Which account did you see?") to any signed-in person. Gate: STUDIO_CONTENT_PERF_ENABLED.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isInternalEmail, isStudioAdmin } from "./studio-admin-auth.js";
import { accountForSignup, loadContent, parseProfileLink, pullContent, rangeFor, sanitizeAccountInput, summarize, FEATURE_IDS, FEATURES, type Deps, type Loaded } from "./studio-content-perf.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PULL_GAP_MS = 10 * 60_000, SIGN_TTL_S = 3600;

export function contentPerfEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.STUDIO_CONTENT_PERF_ENABLED === "true";
}

export function registerContentPerf(app: Express, sbFn: () => SupabaseClient, deps: Deps & { load?: typeof loadContent; pull?: typeof pullContent } = {}): void {
  const env = deps.env ?? process.env;
  const load = deps.load ?? loadContent, pull = deps.pull ?? pullContent;
  let cache: { at: number; data: Loaded } | null = null;
  let lastManualPull = 0;
  let pulling: Promise<any> | null = null;
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any, where: string) => {
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "content_unavailable", detail: "The content performance migration has not been applied" });
    console.log(`[content] ${where}: ${msg.slice(0, 200)}`);
    res.status(500).json({ error: "content_failed" });
  };
  const admin = async (req: Request, res: Response, sb: SupabaseClient): Promise<boolean> => {
    if (!contentPerfEnabled(env) || !(await isStudioAdmin(req, sb, env))) { res.status(404).json({ error: "not_found" }); return false; }
    return true;
  };
  const signAll = async (sb: SupabaseClient, keys: string[]): Promise<Map<string, string>> => {
    const uniq = [...new Set(keys.filter(Boolean))];
    if (!uniq.length) return new Map();
    try {
      const r = await sb.storage.from("studio-outputs").createSignedUrls(uniq, SIGN_TTL_S);
      return new Map(((r.data ?? []) as any[]).filter((x) => x?.signedUrl && x?.path).map((x) => [x.path, x.signedUrl]));
    } catch { return new Map(); }
  };
  const runPull = (sb: SupabaseClient, opts: { force?: boolean; accountIds?: string[] }) => {
    if (pulling) return pulling;
    pulling = pull(sb, deps, opts).finally(() => { pulling = null; cache = null; });
    return pulling;
  };

  /** GET /api/studio/admin/content?days=7|30|90|all&tz=-480&pre=1&internal=1: the page's numbers. */
  app.get("/api/studio/admin/content", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await admin(req, res, sb))) return;
      const raw = String(req.query.days ?? "7");
      const days = raw === "all" ? null : Math.min(365, Math.max(1, Math.round(Number(raw)) || 7));
      const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz ?? 0)) || 0));
      const now = deps.now?.() ?? Date.now();
      if (!cache || now - cache.at > 60_000 || req.query.fresh === "1") cache = { at: now, data: await load(sb, { since: now - 400 * 86400_000, isInternal: (e) => isInternalEmail(e, env) }) };
      const tracking = cache.data.accounts.map((a) => a.tracking_since).filter(Boolean).sort()[0] ?? null;
      const summary = summarize({ ...cache.data, range: rangeFor(days, tz, now, tracking), include_pre: req.query.pre === "1", include_internal: req.query.internal === "1" });
      const signed = await signAll(sb, [...summary.videos.map((v) => v.thumb_key!), ...summary.accounts.map((a) => a.avatar_key!)]);
      for (const v of summary.videos) v.thumb_url = v.thumb_key ? signed.get(v.thumb_key) ?? null : null;
      for (const v of summary.now) v.thumb_url = v.thumb_key ? signed.get(v.thumb_key) ?? null : null;
      for (const a of summary.accounts) a.avatar_url = a.avatar_key ? signed.get(a.avatar_key) ?? null : null;
      res.json({ ...summary, features: FEATURES, pulling: !!pulling, generated_at: new Date(now).toISOString() });
    } catch (e) { fail(res, e, "metrics"); }
  });

  /** POST /api/studio/admin/content/accounts: add or change an account (a handle and platform, or a pasted profile link). */
  app.post("/api/studio/admin/content/accounts", async (req, res) => {
    try {
      const sb = sbFn();
      if (!(await admin(req, res, sb))) return;
      const body = req.body ?? {};
      const fromLink = typeof body.link === "string" ? parseProfileLink(body.link) : null;
      if (typeof body.link === "string" && !fromLink) return res.status(400).json({ error: "invalid_link", detail: "Paste a TikTok, Instagram or YouTube profile link" });
      const patch = sanitizeAccountInput({ ...body, ...(fromLink ?? {}), ...(fromLink && body.url == null ? { url: String(body.link).split("?")[0] } : {}) });
      if ("error" in patch) return res.status(400).json(patch);
      const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
      const now = new Date(deps.now?.() ?? Date.now()).toISOString();
      let row: any;
      if (id) {
        const r = await sb.from("content_accounts").update({ ...patch, updated_at: now }).eq("id", id).select("*").maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ error: "account_not_found" });
        row = r.data;
      } else {
        if (!patch.platform || !patch.handle) return res.status(400).json({ error: "handle_required", detail: "A platform and a handle, or a profile link" });
        const r = await sb.from("content_accounts").upsert({ enabled: true, owner_kind: "creator", ...patch, updated_at: now }, { onConflict: "platform,handle" }).select("*").single();
        if (r.error) throw r.error;
        row = r.data;
        // a new account is read right away so the page shows it within a minute
        void runPull(sb, { force: true, accountIds: [row.id] }).catch(() => undefined);
      }
      cache = null;
      res.json({ account: row });
    } catch (e) { fail(res, e, "account"); }
  });

  /** POST /api/studio/admin/content/videos/:id: the owner's own tag, cost, or hiding a video. */
  app.post("/api/studio/admin/content/videos/:id", async (req, res) => {
    try {
      const sb = sbFn();
      if (!(await admin(req, res, sb))) return;
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid_id" });
      const b = req.body ?? {}, patch: Record<string, any> = { updated_at: new Date(deps.now?.() ?? Date.now()).toISOString() };
      if ("feature" in b) {
        const cur = await sb.from("content_videos").select("tags,tag_source").eq("id", id).maybeSingle();
        if (cur.error) throw cur.error;
        if (!cur.data) return res.status(404).json({ error: "video_not_found" });
        if (b.feature === null || b.feature === "") { const { feature: _f, ...rest } = cur.data.tags ?? {}; patch.tags = rest; patch.tag_source = Object.keys(rest).length ? cur.data.tag_source : null; }
        else if (FEATURE_IDS.has(String(b.feature))) { patch.tags = { ...(cur.data.tags ?? {}), feature: String(b.feature) }; patch.tag_source = "owner"; }
        else return res.status(400).json({ error: "invalid_feature" });
      }
      if ("hidden" in b) patch.hidden = !!b.hidden;
      if ("pre_tracking" in b) patch.pre_tracking = !!b.pre_tracking;
      if ("cost_usd" in b) { const v = b.cost_usd; if (v === null || v === "") patch.cost_usd = null; else { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: "invalid_cost" }); patch.cost_usd = Math.round(n * 100) / 100; } }
      const r = await sb.from("content_videos").update(patch).eq("id", id).select("id,tags,tag_source,hidden,pre_tracking,cost_usd").maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "video_not_found" });
      cache = null;
      res.json({ video: r.data });
    } catch (e) { fail(res, e, "video"); }
  });

  /** POST /api/studio/admin/content/pull: read every account now (at most once every 10 minutes; a named account any time). */
  app.post("/api/studio/admin/content/pull", async (req, res) => {
    try {
      const sb = sbFn();
      if (!(await admin(req, res, sb))) return;
      const now = deps.now?.() ?? Date.now();
      const one = typeof req.body?.account_id === "string" && UUID_RE.test(req.body.account_id) ? req.body.account_id : null;
      if (!one && now - lastManualPull < PULL_GAP_MS) return res.status(429).json({ error: "pulled_recently", detail: `Read again in ${Math.ceil((PULL_GAP_MS - (now - lastManualPull)) / 60_000)} min` });
      if (!one) lastManualPull = now;
      const r = await runPull(sb, { force: true, ...(one ? { accountIds: [one] } : {}) });
      res.json({ result: r });
    } catch (e) { fail(res, e, "pull"); }
  });

  /** GET /api/studio/content/accounts: the tracked accounts, for the question after sign-up. Any signed-in person. */
  app.get("/api/studio/content/accounts", async (req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    try {
      if (!userId(req)) return res.status(401).json({ error: "unauthorized" });
      if (!contentPerfEnabled(env)) return res.json({ accounts: [] });
      const sb = sbFn();
      const r = await sb.from("content_accounts").select("id,platform,handle,display_name,avatar_key,enabled,owner_kind,tracking_since,followers,latest_posted_at,last_pulled_at,last_profile_at,last_status,last_error,url,cost_usd_per_video,cost_usd_per_month,default_feature").eq("enabled", true).order("created_at");
      if (r.error) throw r.error;
      const rows = ((r.data ?? []) as any[]).map(accountForSignup);
      const signed = await signAll(sb, rows.map((a) => a.avatar_key!));
      res.json({ accounts: rows.map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, display_name: a.display_name, avatar_url: a.avatar_key ? signed.get(a.avatar_key) ?? null : null })) });
    } catch (e: any) {
      if (/relation .* does not exist/i.test(String(e?.message ?? e))) return res.json({ accounts: [] });
      fail(res, e, "accounts");
    }
  });
}

/** Every 5 minutes: read the accounts that are due (hourly with a fresh video, every 4 hours otherwise). */
export function startContentPerfLoop(sbFn: () => SupabaseClient, deps: Deps = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env;
  if (!contentPerfEnabled(env) || !env.SCRAPECREATORS_API_KEY) return null;
  let busy = false;
  const tick = async () => {
    const r = await pullContent(sbFn(), deps);
    if (r.accounts || r.errors.length) (deps.log ?? console.log)(`[content] pulled ${r.accounts} accounts, ${r.videos_new} new videos, ${r.snapshots} readings${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`);
  };
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch((e) => console.log(`[content] tick: ${String(e?.message ?? e).slice(0, 200)}`)).finally(() => { busy = false; });
  }, 5 * 60_000);
  t.unref?.();
  setTimeout(() => { if (!busy) { busy = true; tick().catch(() => undefined).finally(() => { busy = false; }); } }, 20_000).unref?.();
  return t;
}
