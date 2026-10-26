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

/** Columns on client_orgs beyond name/slug. Every one is optional; empty strings clear the field. */
export const PROFILE_COLUMNS = "logo_url,description,industry,website,contact_name,contact_email,target_accounts,contract_value,signed_at,term_months,renews_at,notes,learning,updated_at";
const TEXT_LIMITS: Record<string, number> = { description: 2000, industry: 80, website: 200, contact_name: 120, contact_email: 254, target_accounts: 2000, contract_value: 120, notes: 4000 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export function addMonths(ymd: string, months: number): string {
  const d = new Date(ymd + "T00:00:00Z"); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
/** Validates a profile patch from the console. Returns the columns to write, or the first problem. Unknown keys are ignored.
 *  renews_at follows signed_at + term_months unless given explicitly. */
export function parseProfile(body: any): { patch: Record<string, string | number | null>; error?: string } {
  const patch: Record<string, string | number | null> = {};
  if (!body || typeof body !== "object") return { patch };
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === "") { patch[k] = null; continue; }
    if (typeof v !== "string") return { patch, error: `invalid_${k}` };
    const t = v.trim(); if (t.length > max) return { patch, error: `invalid_${k}` };
    if (k === "contact_email" && t && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { patch, error: "invalid_contact_email" };
    if (k === "website" && t && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}([/?#].*)?$/i.test(t)) return { patch, error: "invalid_website" };
    patch[k] = t || null;
  }
  for (const k of ["signed_at", "renews_at"]) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === "") { patch[k] = null; continue; }
    if (typeof v !== "string" || !validDate(v)) return { patch, error: `invalid_${k}` };
    patch[k] = v;
  }
  if ("term_months" in body) {
    const v = body.term_months;
    if (v === null || v === "") patch.term_months = null;
    else { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 120) return { patch, error: "invalid_term_months" }; patch.term_months = n; }
  }
  if ("learning" in body) {
    const l = parseLearning(body.learning);
    if (l.error) return { patch, error: l.error };
    (patch as any).learning = l.value;
  }
  return { patch };
}

/** Learning settings: what the caption prompt knows about the client and the hashtags its library posts carry. */
export type ClientLearning = { brand?: string; niche?: string; voice?: string; hashtags?: string[] };
const HASHTAG_RE = /^[\p{L}\p{N}_]{1,60}$/u;
export function parseLearning(input: any): { value: ClientLearning; error?: string } {
  if (input === null || input === undefined) return { value: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { value: {}, error: "invalid_learning" };
  const out: ClientLearning = {};
  for (const k of ["brand", "niche", "voice"] as const) {
    if (!(k in input) || input[k] === null || input[k] === "") continue;
    if (typeof input[k] !== "string") return { value: {}, error: `invalid_learning_${k}` };
    const t = String(input[k]).trim().slice(0, k === "voice" ? 600 : 120);
    if (t) out[k] = t;
  }
  if ("hashtags" in input && input.hashtags !== null) {
    const raw = Array.isArray(input.hashtags) ? input.hashtags : typeof input.hashtags === "string" ? input.hashtags.split(/[\s,]+/) : null;
    if (!raw) return { value: {}, error: "invalid_learning_hashtags" };
    const tags: string[] = [];
    for (const r of raw) {
      const t = String(r ?? "").trim().replace(/^#/, "");
      if (!t) continue;
      if (!HASHTAG_RE.test(t)) return { value: {}, error: "invalid_learning_hashtags" };
      if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      if (tags.length > 30) return { value: {}, error: "invalid_learning_hashtags" };
    }
    out.hashtags = tags;
  }
  return { value: out };
}
/** Fills renews_at from signed_at + term_months when the caller did not set it. Needs the row's current values for a partial patch. */
export function withRenewal(patch: Record<string, any>, current: { signed_at?: string | null; term_months?: number | null } = {}): Record<string, any> {
  if ("renews_at" in patch && patch.renews_at) return patch;
  if (!("signed_at" in patch) && !("term_months" in patch)) return patch; // an unrelated edit never moves a date the operator set by hand
  const signed = "signed_at" in patch ? patch.signed_at : current.signed_at ?? null;
  const term = "term_months" in patch ? patch.term_months : current.term_months ?? null;
  if (signed && term) return { ...patch, renews_at: addMonths(signed, term) };
  if (("signed_at" in patch && !patch.signed_at) || ("term_months" in patch && !patch.term_months)) return { ...patch, renews_at: null };
  return patch;
}
/** Days until renewal (negative when overdue), or null without a date. */
export function renewalDays(renews_at: string | null | undefined, now = new Date()): number | null {
  if (!renews_at) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(renews_at + "T00:00:00Z") - today) / 86400_000);
}
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
export const LOGO_MAX_BYTES = 400 * 1024;
/** Decodes a logo data URL from the console. Only png/jpeg/webp, at most 400 KB decoded. */
export function parseLogo(dataUrl: unknown): { mime: string; bytes: Buffer } | null {
  if (typeof dataUrl !== "string" || dataUrl.length > LOGO_MAX_BYTES * 1.4 + 64) return null;
  const m = DATA_URL_RE.exec(dataUrl); if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length || bytes.length > LOGO_MAX_BYTES) return null;
  return { mime: m[1], bytes };
}
/** Creates one renewal alert per client per renewal date, 30 days ahead and while overdue (up to 60 days). Idempotent. */
export async function ensureRenewalAlerts(sb: SupabaseClient, now = new Date()): Promise<number> {
  const orgs = await sb.from("client_orgs").select("id,name,slug,renews_at,contract_value").is("archived_at", null).not("renews_at", "is", null);
  if (orgs.error) throw orgs.error;
  const due = (orgs.data ?? []).filter((o: any) => { const d = renewalDays(o.renews_at, now); return d !== null && d <= 30 && d >= -60; });
  if (!due.length) return 0;
  const existing = await sb.from("reels_alerts").select("payload").eq("type", "client_renewal").in("payload->>org_id", due.map((o: any) => o.id));
  if (existing.error) throw existing.error;
  const have = new Set((existing.data ?? []).map((a: any) => `${a.payload?.org_id}|${a.payload?.renews_at}`));
  const rows = due.filter((o: any) => !have.has(`${o.id}|${o.renews_at}`)).map((o: any) => {
    const d = renewalDays(o.renews_at, now)!;
    return { type: "client_renewal", severity: d < 0 ? "critical" : d <= 7 ? "warning" : "info", phone_slot: null, device_id: null,
      title: d < 0 ? `${o.name}: renewal overdue by ${-d} day${d === -1 ? "" : "s"}` : d === 0 ? `${o.name} renews today` : `${o.name} renews in ${d} day${d === 1 ? "" : "s"}`,
      body: [o.contract_value ? `Signed for ${o.contract_value}.` : null, `Renewal date ${o.renews_at}. Open Clients to update the contract.`].filter(Boolean).join(" "),
      payload: { org_id: o.id, slug: o.slug, renews_at: o.renews_at, days: d } };
  });
  if (!rows.length) return 0;
  const ins = await sb.from("reels_alerts").insert(rows);
  if (ins.error) throw ins.error;
  return rows.length;
}
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
        sb.from("client_orgs").select(`id,name,slug,created_at,archived_at,${PROFILE_COLUMNS}`).order("created_at"),
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
        renewal_days: renewalDays(o.renews_at),
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
    const profile = parseProfile(req.body);
    if (profile.error) return res.status(400).json({ error: profile.error });
    try {
      const r = await sbFn().from("client_orgs").insert({ name, slug, created_by: actor(req), ...withRenewal(profile.patch) }).select(`id,name,slug,created_at,archived_at,${PROFILE_COLUMNS}`).single();
      if (r.error) return /duplicate|unique/i.test(r.error.message) ? res.status(409).json({ error: "slug_taken" }) : fail(res, r.error);
      res.status(201).json({ client: { ...r.data, renewal_days: renewalDays(r.data.renews_at), members: [], accounts: [], invites: [] } });
    } catch (e) { fail(res, e); }
  });

  // Profile: who they are, what they signed for, when it renews. Name changes too; the slug stays.
  app.patch("/api/ops/clients/:id", async (req, res) => {
    if (requireOperator(req, res)) return;
    const profile = parseProfile(req.body);
    if (profile.error) return res.status(400).json({ error: profile.error });
    const patch: Record<string, any> = { ...profile.patch };
    if ("name" in (req.body ?? {})) {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (name.length < 1 || name.length > 80) return res.status(400).json({ error: "invalid_name" });
      patch.name = name;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_update" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const r = await sb.from("client_orgs").update({ ...withRenewal(patch, org), updated_at: new Date().toISOString() }).eq("id", org.id)
        .select(`id,name,slug,created_at,archived_at,${PROFILE_COLUMNS}`).single();
      if (r.error) throw r.error;
      res.json({ client: { ...r.data, renewal_days: renewalDays(r.data.renews_at) } });
    } catch (e) { fail(res, e); }
  });

  // Logo: a small image from the console, stored in the public client-logos bucket; the row keeps the public URL.
  app.post("/api/ops/clients/:id/logo", async (req, res) => {
    if (requireOperator(req, res)) return;
    const logo = parseLogo(req.body?.data_url);
    if (!logo) return res.status(400).json({ error: "invalid_logo", detail: "png, jpeg or webp, at most 400 KB" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const ext = logo.mime === "image/png" ? "png" : logo.mime === "image/webp" ? "webp" : "jpg";
      const path = `${org.id}/${Date.now().toString(36)}.${ext}`;
      const up = await sb.storage.from("client-logos").upload(path, logo.bytes, { contentType: logo.mime, upsert: true, cacheControl: "31536000" });
      if (up.error) throw up.error;
      const url = sb.storage.from("client-logos").getPublicUrl(path).data.publicUrl;
      const r = await sb.from("client_orgs").update({ logo_url: url, updated_at: new Date().toISOString() }).eq("id", org.id).select("id,logo_url").single();
      if (r.error) throw r.error;
      res.json({ client_id: org.id, logo_url: r.data.logo_url });
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
  // The organization(s) the signed-in person belongs to: name, slug and logo for their dashboard. No contract fields.
  app.get("/api/client/orgs", async (req, res) => {
    const uid = actor(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });
    res.set("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      const m = await sb.from("client_org_members").select("org_id").eq("user_id", uid);
      if (m.error) throw m.error;
      const ids = (m.data ?? []).map((x: any) => x.org_id);
      if (!ids.length) return res.json({ orgs: [] });
      const o = await sb.from("client_orgs").select("id,name,slug,logo_url,website,industry").in("id", ids).is("archived_at", null).order("created_at");
      if (o.error) throw o.error;
      res.json({ orgs: o.data ?? [] });
    } catch (e) { fail(res, e); }
  });

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
