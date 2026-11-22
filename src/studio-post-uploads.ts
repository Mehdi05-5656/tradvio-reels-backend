// Bringing your own videos to post (docs/publishing/PLAN.md §3, phase 3; owner, Nov 22 2026).
//   GET  /api/studio/library/usage        what the person's library holds against the plan (the card shown before a
//                                         big upload: "38 videos · 6.2 GB · uses 6.2 of your 30 GB")
//   POST /api/studio/social/media-check   each video's file checked by the posting service against every network's
//                                         size limit (its own figures, kept current by it), before it is posted
// Length and shape rules are checked in the browser from the probe; the size limits come from the service because
// the networks' published figures disagree with each other (docs/publishing/RESEARCH.md).
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { limitsFor } from "./studio-limits.js";
import { zernioClient } from "./social-zernio.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MEDIA_CHECK_MAX = 50;

export type MediaCheck = { asset_id: string; ok: boolean; size: number | null; format: string | null; error: string | null; over: Array<{ platform: string; limit: number }> };

/** The provider's answer for one file, as the page needs it: which networks it is too large for. */
export function readMediaCheck(assetId: string, body: any): MediaCheck {
  const limits = body?.platformLimits && typeof body.platformLimits === "object" ? body.platformLimits : {};
  const over = Object.entries(limits).filter(([, v]: [string, any]) => v && (v.withinLimit === false || v.exceedsLimit === true || (Number.isFinite(Number(v.limit)) && Number(body?.size) > Number(v.limit)))).map(([platform, v]: [string, any]) => ({ platform, limit: Number(v.limit) || 0 }));
  return { asset_id: assetId, ok: body?.valid !== false, size: Number.isFinite(Number(body?.size)) ? Number(body.size) : null, format: body?.format ? String(body.format) : null, error: body?.valid === false ? String(body?.code ?? "MEDIA_UNDECODABLE") : null, over };
}

export function registerPostUploads(app: Express, sbFn: () => SupabaseClient, deps: { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void } = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => { console.error("[post-uploads]", String(e?.message ?? e)); res.status(500).json({ error: "failed", detail: "Something went wrong on our side; try again in a moment" }); };

  app.get("/api/studio/library/usage", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const [cust, usage] = await Promise.all([
        sb.from("studio_customers").select("plan_id,status,owner_pass").eq("user_id", u).maybeSingle(),
        sb.rpc("studio_library_usage", { p_user: u }),
      ]);
      if (cust.error) throw cust.error;
      const row = !usage.error && usage.data ? (Array.isArray(usage.data) ? usage.data[0] : usage.data) : null;
      let files = Number(row?.files ?? NaN), bytes = Number(row?.bytes ?? NaN);
      if (!Number.isFinite(files)) {
        const a = await sb.from("studio_assets").select("bytes").eq("user_id", u).neq("status", "deleted").limit(5000);
        files = (a.data ?? []).length; bytes = (a.data ?? []).reduce((n: number, x: any) => n + Number(x.bytes ?? 0), 0);
      }
      const lim = limitsFor(cust.data);
      res.json({ files, bytes, max_files: lim.assets, max_bytes: lim.storage_bytes });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/social/media-check", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    const ids = [...new Set((Array.isArray(req.body?.asset_ids) ? req.body.asset_ids : []).map(String).filter((x: string) => UUID_RE.test(x)))].slice(0, MEDIA_CHECK_MAX) as string[];
    if (!ids.length) return res.json({ checks: [] });
    const c = env.STUDIO_SOCIAL_ENABLED === "true" && env.SOCIAL_PROVIDER === "zernio" ? zernioClient({ env, fetch: deps.fetch, log }) : null;
    if (!c) return res.json({ checks: [] }); // the page still checks length and shape itself
    try {
      const sb = sbFn();
      const a = await sb.from("studio_assets").select("id,kind,status,object_key").eq("user_id", u).in("id", ids);
      if (a.error) throw a.error;
      const mine = ((a.data ?? []) as any[]).filter((x) => x.status === "ready" && x.kind === "video");
      const checks: MediaCheck[] = [];
      // a few at a time: each is one request to the service, which reads the file's header
      const queue = [...mine];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const x = queue.shift()!;
          try {
            const s = await sb.storage.from("studio-uploads").createSignedUrl(x.object_key, 600);
            if (s.error || !s.data?.signedUrl) continue;
            const r = await c.call("POST", "/tools/validate/media", { body: { url: s.data.signedUrl }, timeoutMs: 45_000 });
            if (r.status < 300) checks.push(readMediaCheck(x.id, r.body));
          } catch { /* that one is left unchecked; posting still validates */ }
        }
      }));
      res.json({ checks });
    } catch (e) { fail(res, e); }
  });
}
