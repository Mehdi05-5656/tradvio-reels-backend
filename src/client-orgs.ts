// Client organizations and invite links for the Clone8 portal.
// Operator console: /api/ops/clients (list, create, assign accounts, invite, revoke, remove member, archive).
// Client side:      GET /api/invites/:token (public preview), POST /api/invites/:token/accept (signed-in user).
// Tables and the accept function live in migrations/20261024100000_client_orgs_invites.sql.
import { createHash, randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";
import { loadSlots } from "./publer-schedule.js";

type SbGetter = () => SupabaseClient;

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** 32 random bytes, URL-safe. The link carries this; the database stores only its hash. */
export const newInviteToken = () => randomBytes(32).toString("base64url");
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s-]/g, "")
    .trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

/** The link a client opens. The token travels in the URL fragment, which browsers never send to servers or logs. */
export function inviteUrl(token: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.DASHBOARD_URL ?? "https://tradvio-reels.vercel.app").replace(/\/+$/, "");
  return `${base}/#invite/${token}`;
}

export type InviteRow = { expires_at: string; accepted_at: string | null; revoked_at: string | null };
export function inviteStatus(inv: InviteRow, nowMs = Date.now()): "valid" | "expired" | "used" | "revoked" {
  if (inv.revoked_at) return "revoked";
  if (inv.accepted_at) return "used";
  if (Date.parse(inv.expires_at) <= nowMs) return "expired";
  return "valid";
}

/** j***@example.com: enough for the invitee to recognise the address, not enough to leak it. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain) return null;
  return `${user.slice(0, 1)}***@${domain}`;
}

const ACCEPT_ERRORS: Record<string, number> = { invite_invalid: 404, invite_expired: 410, invite_revoked: 410, invite_used: 409, invite_email_mismatch: 403 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseStringArray = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 128) ? [...new Set(v as string[])] : null;

export function registerClientOrgRoutes(app: Express, sbFn: SbGetter): void {
  const requireAdmin = (req: Request, res: Response) => { if (isAdmin(req)) return false; res.status(403).json({ error: "forbidden" }); return true; };
  const requireOperator = (req: Request, res: Response) => { if (isOperator(req)) return false; res.status(403).json({ error: "operator_required" }); return true; };
  const actor = (req: Request) => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => res.status(503).json({ error: "clients_unavailable", detail: String(e?.message ?? e).slice(0, 200) });

  async function loadOrg(sb: SupabaseClient, id: string) {
    if (!UUID_RE.test(id)) return null;
    const r = await sb.from("client_orgs").select("*").eq("id", id).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }

  // ---- Operator console ----------------------------------------------------------------
  app.get("/api/ops/clients", async (req, res) => {
    if (requireAdmin(req, res)) return;
    try {
      const sb = sbFn();
      const [orgs, members, accounts, invites, slots] = await Promise.all([
        sb.from("client_orgs").select("id,name,slug,created_at,archived_at").order("created_at"),
        sb.from("client_org_members").select("org_id,user_id,added_at"),
        sb.from("client_org_accounts").select("org_id,phone_slot,added_at"),
        sb.from("client_invites").select("id,org_id,email,created_at,expires_at,accepted_at,accepted_by,revoked_at").order("created_at", { ascending: false }),
        loadSlots(sb),
      ]);
      for (const r of [orgs, members, accounts, invites]) if (r.error) throw r.error;
      const userIds = [...new Set([...(members.data ?? []).map((m: any) => m.user_id), ...(invites.data ?? []).map((i: any) => i.accepted_by).filter(Boolean)])];
      const profiles = userIds.length ? await sb.from("profiles").select("user_id,email,display_name").in("user_id", userIds) : { data: [], error: null };
      if (profiles.error) throw profiles.error;
      const person = new Map((profiles.data ?? []).map((p: any) => [p.user_id, { user_id: p.user_id, email: p.email, display_name: p.display_name }]));
      const slotInfo = new Map(slots.map((s) => [s.phone_slot, { phone_slot: s.phone_slot, handle: s.handle, provider: s.provider, paused: s.paused }]));
      const now = Date.now();
      const clients = (orgs.data ?? []).map((o: any) => ({
        ...o,
        members: (members.data ?? []).filter((m: any) => m.org_id === o.id).map((m: any) => ({ ...(person.get(m.user_id) ?? { user_id: m.user_id, email: null, display_name: null }), added_at: m.added_at })),
        accounts: (accounts.data ?? []).filter((a: any) => a.org_id === o.id).map((a: any) => slotInfo.get(a.phone_slot) ?? { phone_slot: a.phone_slot, handle: null, provider: null, paused: null }),
        invites: (invites.data ?? []).filter((i: any) => i.org_id === o.id).map((i: any) => ({
          id: i.id, email: i.email, created_at: i.created_at, expires_at: i.expires_at, accepted_at: i.accepted_at, revoked_at: i.revoked_at,
          accepted_by: i.accepted_by ? person.get(i.accepted_by) ?? null : null, status: inviteStatus(i, now),
        })),
      }));
      res.set("Cache-Control", "private, no-store").json({ clients, accounts: [...slotInfo.values()] });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients", async (req, res) => {
    if (requireOperator(req, res)) return;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name.length < 1 || name.length > 80) return res.status(400).json({ error: "invalid_name" });
    const slug = typeof req.body?.slug === "string" && req.body.slug ? String(req.body.slug) : slugify(name);
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "invalid_slug" });
    try {
      const r = await sbFn().from("client_orgs").insert({ name, slug, created_by: actor(req) }).select("id,name,slug,created_at,archived_at").single();
      if (r.error) return /duplicate|unique/i.test(r.error.message) ? res.status(409).json({ error: "slug_taken" }) : fail(res, r.error);
      res.status(201).json({ client: r.data });
    } catch (e) { fail(res, e); }
  });

  // Replace the set of accounts an organization may see.
  app.post("/api/ops/clients/:id/accounts", async (req, res) => {
    if (requireOperator(req, res)) return;
    const wanted = parseStringArray(req.body?.phone_slots, 100);
    if (!wanted) return res.status(400).json({ error: "invalid_phone_slots" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const known = new Set((await loadSlots(sb)).map((s) => s.phone_slot));
      const unknown = wanted.filter((s) => !known.has(s));
      if (unknown.length) return res.status(400).json({ error: "unknown_accounts", accounts: unknown });
      const current = await sb.from("client_org_accounts").select("phone_slot").eq("org_id", org.id);
      if (current.error) throw current.error;
      const have = new Set((current.data ?? []).map((a: any) => a.phone_slot));
      const add = wanted.filter((s) => !have.has(s));
      const remove = [...have].filter((s) => !wanted.includes(s));
      if (remove.length) { const d = await sb.from("client_org_accounts").delete().eq("org_id", org.id).in("phone_slot", remove); if (d.error) throw d.error; }
      if (add.length) { const i = await sb.from("client_org_accounts").insert(add.map((phone_slot) => ({ org_id: org.id, phone_slot }))); if (i.error) throw i.error; }
      res.json({ client_id: org.id, phone_slots: wanted, added: add, removed: remove });
    } catch (e) { fail(res, e); }
  });

  // Create an invite link. The full link is returned once and never stored.
  app.post("/api/ops/clients/:id/invites", async (req, res) => {
    if (requireOperator(req, res)) return;
    const email = typeof req.body?.email === "string" && req.body.email.trim() ? req.body.email.trim().toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid_email" });
    const days = Number(req.body?.expires_in_days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) return res.status(400).json({ error: "invalid_expiry" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      if (org.archived_at) return res.status(409).json({ error: "client_archived" });
      const token = newInviteToken();
      const expires_at = new Date(Date.now() + days * 86400_000).toISOString();
      const r = await sb.from("client_invites").insert({ org_id: org.id, token_hash: sha256Hex(token), email, created_by: actor(req), expires_at })
        .select("id,org_id,email,created_at,expires_at,accepted_at,revoked_at").single();
      if (r.error) throw r.error;
      res.status(201).json({ invite: { ...r.data, status: "valid" }, invite_url: inviteUrl(token) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients/:id/invites/:inviteId/revoke", async (req, res) => {
    if (requireOperator(req, res)) return;
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.inviteId)) return res.status(404).json({ error: "invite_not_found" });
    try {
      const r = await sbFn().from("client_invites").update({ revoked_at: new Date().toISOString() })
        .eq("id", req.params.inviteId).eq("org_id", req.params.id).is("revoked_at", null).is("accepted_at", null).select("id").maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "invite_not_found" });
      res.json({ revoked: r.data.id });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients/:id/members/:userId/remove", async (req, res) => {
    if (requireOperator(req, res)) return;
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId)) return res.status(404).json({ error: "member_not_found" });
    try {
      const r = await sbFn().from("client_org_members").delete().eq("org_id", req.params.id).eq("user_id", req.params.userId).select("user_id");
      if (r.error) throw r.error;
      if (!r.data?.length) return res.status(404).json({ error: "member_not_found" });
      res.json({ removed: req.params.userId });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients/:id/archive", async (req, res) => {
    if (requireOperator(req, res)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "client_not_found" });
    try {
      const r = await sbFn().from("client_orgs").update({ archived_at: new Date().toISOString() }).eq("id", req.params.id).is("archived_at", null).select("id").maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "client_not_found" });
      res.json({ archived: r.data.id });
    } catch (e) { fail(res, e); }
  });

  // ---- Client side -----------------------------------------------------------------------
  // Public preview: organization name and whether the link still works. No account data.
  app.get("/api/invites/:token", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!INVITE_TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: "invite_invalid" });
    try {
      const sb = sbFn();
      const r = await sb.from("client_invites").select("org_id,email,expires_at,accepted_at,revoked_at").eq("token_hash", sha256Hex(req.params.token)).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "invite_invalid" });
      const org = await sb.from("client_orgs").select("name,archived_at").eq("id", r.data.org_id).maybeSingle();
      if (org.error) throw org.error;
      if (!org.data || org.data.archived_at) return res.status(404).json({ error: "invite_invalid" });
      res.json({ org_name: org.data.name, status: inviteStatus(r.data), expires_at: r.data.expires_at, email_hint: maskEmail(r.data.email) });
    } catch (e) { fail(res, e); }
  });

  // Join: binds the signed-in user to the organization; the database function validates the token.
  app.post("/api/invites/:token/accept", async (req, res) => {
    const uid = actor(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });
    if (!INVITE_TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: "invite_invalid" });
    try {
      const r = await sbFn().rpc("client_accept_invite", { p_user: uid, p_token_hash: sha256Hex(req.params.token) });
      if (r.error) {
        const code = Object.keys(ACCEPT_ERRORS).find((k) => r.error!.message.includes(k));
        return code ? res.status(ACCEPT_ERRORS[code]).json({ error: code }) : fail(res, r.error);
      }
      res.json({ joined: r.data });
    } catch (e) { fail(res, e); }
  });
}
