import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin } from "./auth.js";
import { listAccounts } from "./publer.js";
import { loadConfig, ptNow } from "./publer-schedule.js";

// Explicit column allowlists: do not send tokens, webhook payloads or raw provider responses.
const SLOT_COLS = "phone_slot,publer_account_id,provider,handle,daily_target,paused,owner_user_id";
const CV_COLS = "cv_account_id,platform,platform_handle,is_active,external_user_id,bridge_source,local_phone_slot,connected_at,last_synced_at";
async function allRows(makeQuery: () => any) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await makeQuery().range(offset, offset + 499);
    if (r.error) throw r.error;
    rows.push(...(r.data ?? []));
    if ((r.data?.length ?? 0) < 500) return rows;
  }
}
function normalized(value: unknown) { return String(value ?? "").replace(/^@/, "").toLowerCase(); }

export function registerAccountInventory(app: Express, sbFn: () => SupabaseClient,
  providerList: typeof listAccounts = listAccounts) {
  app.get("/api/v2/accounts", async (req: Request, res: Response) => {
    if (!req.auth) return res.status(401).json({ error: "unauthorized" });
    const admin = isAdmin(req);
    if (!admin && (!req.profile?.external_user_id || !("user_id" in req.auth))) {
      return res.status(403).json({ error: "profile_required" });
    }
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      const scopedSlots = () => {
        let q = sb.from("publer_slot_config").select(SLOT_COLS).order("phone_slot");
        if (!admin) q = q.eq("owner_user_id", (req.auth as { user_id: string }).user_id);
        return q;
      };
      const scopedCv = () => {
        let q = sb.from("creatorvault_accounts").select(CV_COLS).order("cv_account_id");
        if (!admin) q = q.eq("external_user_id", req.profile!.external_user_id);
        return q;
      };
      const [slots, cv, owners, cfg] = await Promise.all([
        allRows(scopedSlots), allRows(scopedCv),
        admin ? allRows(() => sb.from("profiles").select("user_id,external_user_id,display_name").order("user_id")) : Promise.resolve([]),
        loadConfig(sb),
      ]);
      let providerAccounts: any[] | null = null;
      let providerCheck = "unavailable";
      try {
        const response = await providerList(cfg.workspaceId);
        if (!Array.isArray(response)) throw new Error("unexpected provider shape");
        providerAccounts = response;
        providerCheck = "ok";
      } catch { /* Keep inventory available, but never turn failure into healthy. */ }
      const ownerFor = (id: string | null, external = false) => {
        if (!admin) return undefined;
        const p = owners.find(p => (external ? p.external_user_id : p.user_id) === id);
        return p ? { user_id: p.user_id, label: p.display_name || p.external_user_id } : { user_id: null, label: id ? "Unmapped profile" : "Unassigned" };
      };
      const today = ptNow().ymd;
      const accounts: any[] = [];
      // Bounded concurrency avoids flooding the DB for larger inventories.
      for (const slot of slots) {
        const [logs, queue, latest, pending] = await Promise.all([
          allRows(() => sb.from("publer_publish_log").select("status,slot_index,attempted_at,error").eq("phone_slot", slot.phone_slot).eq("slot_local_date", today).order("id")),
          sb.from("reels_manual_queue").select("id", { count: "exact", head: true }).eq("phone_slot", slot.phone_slot).eq("status", "pending"),
          sb.from("publer_publish_log").select("status,attempted_at,updated_at,error").eq("phone_slot", slot.phone_slot).order("attempted_at", { ascending: false }).limit(1).maybeSingle(),
          allRows(() => sb.from("publer_publish_log").select("status,attempted_at,error").eq("phone_slot", slot.phone_slot).eq("status", "pending").order("id")),
        ]);
        if (queue.error || latest.error) throw queue.error || latest.error;
        const match = providerAccounts?.find(a => a.id === slot.publer_account_id);
        const held = pending.filter(l => l.error || Date.parse(l.attempted_at) < Date.now() - 20 * 60_000).length;
        accounts.push({
          id: `publer:${slot.phone_slot}`, source: "Publer", platform: slot.provider, handle: slot.handle,
          owner: ownerFor(slot.owner_user_id), phone_slot: slot.phone_slot,
          connection: providerAccounts === null ? "unverified" : match ? "listed" : "missing",
          publishing: slot.paused ? "paused" : "enabled", daily_target: slot.daily_target,
          schedule_times: cfg.slotTimes.slice(0, slot.daily_target), timezone: cfg.timezone,
          published_today: new Set(logs.filter(l => l.status === "published").map(l => l.slot_index)).size,
          pending_count: queue.count ?? 0, held_count: held,
          last_attempt_at: latest.data?.updated_at ?? latest.data?.attempted_at ?? null,
          last_outcome: latest.data?.status ?? null,
          // An error marker is sufficient for inventory; provider error payloads can carry private URLs.
          issue: held ? "A submission needs review; do not blindly resend." : latest.data?.status === "failed" ? "Latest publishing attempt failed." : providerAccounts && !match ? "Configured account is missing from the Publer account list." : null,
        });
      }
      // Accounts discovered at the provider but not assigned to a user are admin-only.
      if (admin && providerAccounts) for (const a of providerAccounts) {
        if (slots.some(s => s.publer_account_id === a.id)) continue;
        accounts.push({ id: `publer-unassigned:${a.id}`, source: "Publer", platform: a.provider || a.type || "unknown",
          handle: a.username || a.name || a.id, owner: ownerFor(null), connection: "listed",
          publishing: "not_configured", issue: "No publishing schedule or owner mapping.", phone_slot: null });
      }
      for (const a of cv) {
        const linked = slots.find(s => s.phone_slot === a.local_phone_slot);
        const mismatch = !!linked && (normalized(a.platform_handle) !== normalized(linked.handle) || a.platform !== linked.provider);
        accounts.push({
          id: `creatorvault:${a.cv_account_id}`, source: "CreatorVault", platform: a.platform,
          handle: a.platform_handle, owner: ownerFor(a.external_user_id, true),
          connection: a.is_active ? "stored_active" : "stored_inactive", publishing: "on_hold",
          last_synced_at: a.last_synced_at, phone_slot: a.local_phone_slot,
          issue: mismatch ? "Stored slot link does not match this handle/platform. No ownership or linking changes were made." : null,
        });
      }
      let monitored: any[] = [];
      if (admin) {
        const [leaders, sources] = await Promise.all([
          allRows(() => sb.from("leader_accounts").select("id,provider,handle,active").order("id")),
          allRows(() => sb.from("reels_source_accounts").select("handle,active").order("handle")),
        ]);
        monitored = [
          ...leaders.map(a => ({ id: `leader:${a.id}`, handle: a.handle, platform: a.provider, active: a.active, source: "Leader monitoring" })),
          ...sources.map(a => ({ id: `source:${a.handle}`, handle: a.handle, platform: "tiktok", active: a.active, source: "Content source" })),
        ];
      }
      return res.json({ scope: admin ? "all_profiles" : "own_profile", checked_at: new Date().toISOString(),
        provider_check: providerCheck, accounts, monitored });
    } catch {
      return res.status(503).json({ error: "Account inventory could not be loaded. No connection status has been inferred." });
    }
  });
}
