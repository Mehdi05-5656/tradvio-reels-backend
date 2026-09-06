import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { registerPublerRoutes } from "./publer-routes.js";
// Node 20 lacks native WebSocket; supabase-js Realtime requires one at import time.
// We don't use realtime, but the client still instantiates it. Provide ws.
import WebSocket from "ws";
// @ts-ignore - polyfilling a global for supabase-js internals
if (typeof (globalThis as any).WebSocket === "undefined") (globalThis as any).WebSocket = WebSocket;

let sb: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!sb) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    });
  }
  return sb;
}

const BUCKET = "reels";
const VALID_SLOTS = new Set(["phone_a", "phone_b", "tiktok_tradvio"]);
function parseSlot(v: string | undefined): string | null {
  return v && VALID_SLOTS.has(v) ? v : null;
}

// Simple shared-secret guard for mutation routes.
// GETs remain public; POSTs require the header (or the guard is off if secret empty).
function requireWriteAuth(req: Request, res: Response, next: any) {
  const secret = process.env.APP_WRITE_SECRET || "";
  if (!secret) return next(); // disabled if not configured
  const provided = req.header("x-app-secret") || "";
  if (provided !== secret) return res.status(401).json({ error: "unauthorized" });
  next();
}

export async function registerRoutes(_httpServer: Server, app: Express): Promise<void> {
  // Gate every POST/PUT/PATCH/DELETE (mutations) with the shared secret.
  // GETs stay public so charts/lists load without extra plumbing.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!req.path.startsWith("/api/")) return next();
    // Exempt paths that carry their own auth (e.g. HMAC-signed webhooks).
    // Route handler MUST verify its own auth before doing anything sensitive.
    if (req.path === "/api/creatorvault/webhook") return next();
    return requireWriteAuth(req, res, next);
  });

  // Bootstrap tells the client whether a secret is required.
  // NEVER returns the secret itself. The owner enters it in the UI once.
  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      auth_required: Boolean(process.env.APP_WRITE_SECRET),
    });
  });

  // Publer routes (scheduling + publish + analytics)
  registerPublerRoutes(app, supabase);

  // Dashboard summary (per-phone counts)
  app.get("/api/summary", async (_req: Request, res: Response) => {
    try {
      const { data, error } = await supabase().from("reels_dashboard_summary").select("*");
      if (error) throw error;
      res.json(data ?? []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Next pending video for a phone (with signed URL)
  app.get("/api/next/:phone", async (req: Request, res: Response) => {
    try {
      const phone = parseSlot(req.params.phone);
      if (!phone) return res.status(400).json({ error: "invalid phone slot" });
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .select("*")
        .eq("phone_slot", phone)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.json(null);

      const { data: signed, error: se } = await supabase().storage
        .from(BUCKET).createSignedUrl(data.storage_path, 3600);
      if (se) throw se;
      res.json({ ...data, signed_url: signed?.signedUrl ?? null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Up-next queue for a phone (default 10, excludes the head)
  app.get("/api/queue/:phone", async (req: Request, res: Response) => {
    try {
      const phone = parseSlot(req.params.phone);
      if (!phone) return res.status(400).json({ error: "invalid phone slot" });
      const limit = Math.min(Number(req.query.limit ?? 10), 50);
      const status = String(req.query.status ?? "pending");
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .select("id, phone_slot, source_handle, filename, storage_path, status, posted_at, created_at")
        .eq("phone_slot", phone)
        .eq("status", status)
        .order(status === "pending" ? "created_at" : "posted_at",
              { ascending: status === "pending" })
        .limit(limit + 1);
      if (error) throw error;
      res.json(data ?? []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Signed URL for any queue item (used for archive playback)
  app.get("/api/signed/:id", async (req: Request, res: Response) => {
    try {
      const { data: row, error } = await supabase()
        .from("reels_manual_queue")
        .select("storage_path")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: "not found" });
      const { data: signed, error: se } = await supabase().storage
        .from(BUCKET).createSignedUrl(row.storage_path, 3600);
      if (se) throw se;
      res.json({ url: signed?.signedUrl ?? null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Mark posted (also accepts optional IG url + note)
  app.post("/api/mark-posted", async (req: Request, res: Response) => {
    try {
      const { id, ig_url, note } = req.body ?? {};
      if (!id) return res.status(400).json({ error: "id required" });
      const patch: Record<string, any> = {
        status: "posted",
        posted_at: new Date().toISOString(),
      };
      if (ig_url !== undefined) patch.posted_ig_url = ig_url;
      if (note !== undefined && note !== null && String(note).length > 0) patch.notes = String(note);
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .update(patch)
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(409).json({ error: "row not pending (already posted, archived, or missing)" });
      }
      res.json({ ok: true, id: data[0].id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Undo (posted -> pending)
  app.post("/api/undo/:id", async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .update({ status: "pending", posted_at: null, posted_ig_url: null })
        .eq("id", req.params.id)
        .eq("status", "posted")
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(409).json({ error: "row not posted" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Archive (skip / drop from active queue)
  app.post("/api/archive/:id", async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .update({ status: "archived" })
        .eq("id", req.params.id)
        .in("status", ["pending", "posted"])
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(409).json({ error: "row not pending or posted" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Today's per-account posted count + configurable daily target.
  // "Today" = calendar day in America/Los_Angeles (resets at 12am PST/PDT).
  app.get("/api/today", async (_req: Request, res: Response) => {
    try {
      // Compute midnight America/Los_Angeles boundaries as ISO instants.
      const now = new Date();
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
      // Compute the UTC instant for LA midnight today by working out LA's current offset.
      const laNowStr = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
      const laNowAsIfUtc = Date.parse(laNowStr + "Z");
      const offsetMs = laNowAsIfUtc - now.getTime(); // positive during PST/PDT? actually laNowAsIfUtc is LA wall clock as UTC. Real UTC = laNowAsIfUtc - offset. offset = laNowAsIfUtc - now.
      const laMidnightUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`) - offsetMs;
      const laNextMidnightUtc = laMidnightUtc + 24 * 60 * 60 * 1000;
      const startIso = new Date(laMidnightUtc).toISOString();
      const nextResetIso = new Date(laNextMidnightUtc).toISOString();

      const slots = ["phone_a", "phone_b", "tiktok_tradvio"] as const;
      const [settingsRes, ...countResults] = await Promise.all([
        supabase().from("reels_settings").select("phone_slot, daily_target"),
        ...slots.map(s =>
          supabase().from("reels_manual_queue")
            .select("id", { count: "exact", head: true })
            .eq("phone_slot", s).eq("status", "posted").gte("posted_at", startIso)
        ),
      ]);
      if (settingsRes.error) throw settingsRes.error;
      for (const r of countResults) if (r.error) throw r.error;

      const targets: Record<string, number> = {};
      for (const r of settingsRes.data ?? []) targets[r.phone_slot] = r.daily_target;

      const out: Record<string, any> = {
        window_start: startIso,
        next_reset: nextResetIso,
      };
      slots.forEach((s, i) => {
        out[s] = {
          posted_today: countResults[i].count ?? 0,
          target: targets[s] ?? 8,
        };
      });
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update daily target for a phone.
  app.post("/api/target", async (req: Request, res: Response) => {
    try {
      const { phone_slot, daily_target } = req.body ?? {};
      if (!VALID_SLOTS.has(phone_slot)) {
        return res.status(400).json({ error: "invalid phone_slot" });
      }
      const n = Number(daily_target);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: "daily_target must be 0..100" });
      }
      const { error } = await supabase()
        .from("reels_settings")
        .update({ daily_target: n, updated_at: new Date().toISOString() })
        .eq("phone_slot", phone_slot);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Full archive listing (posted + archived) with paging
  app.get("/api/archive", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      const { data, error } = await supabase()
        .from("reels_manual_queue")
        .select("*")
        .in("status", ["posted", "archived"])
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      res.json(data ?? []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
