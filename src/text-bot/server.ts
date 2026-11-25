// Text Clone8 on the backend (docs/text-bot/PLAN.md, phase 2): the same bot as the Mac test (gate, brain, actions,
// editor, watcher in src/text-bot/), run for every linked customer from this server, so it works without the owner's
// Mac. What this file adds around it:
//   - Telegram delivers each message to a webhook here (signed with a secret token); it is written to an inbox table
//     and answered at once, then worked on in order, one chat at a time, so a deploy or a restart loses nothing;
//   - linking from the app: a one-time code opens the bot in Telegram, the bot records who tapped Start, and the
//     account is connected only when the person confirms it in the app (so a code seen on a shared screen is useless);
//   - each chat's state (its talk, the action waiting for a YES, the jobs being watched) lives in the database;
//   - the bot acts as the linked person through this server's own routes, with a pass only this process can make
//     (internal.ts);
//   - every step goes to an append-only log (studio_text_events); every AI call to the cost ledger.
// Switches: STUDIO_TEXT_ENABLED (routes and webhook exist; needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and
// ANTHROPIC_API_KEY), STUDIO_TEXT_OPEN (every customer may link; otherwise only the owner's account).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminEmails, isStudioAdmin } from "../studio-admin-auth.js";
import { recordEvent } from "../studio-events.js";
import { INTERNAL_HEADER, internalPass } from "./internal.js";
import { levelOf, Clone8Error, pathOnly, type Api, type BotConfig, type Method, type Reply } from "./routes.js";
import { makeBot, HELP, type BotState } from "./bot.js";
import { think, type BrainDeps, type ChatState, type Transport } from "./brain.js";
import { telegram, parseUpdate, type Incoming } from "./telegram.js";
import { classify } from "./gate.js";
import type { Index } from "./account.js";

type Env = Record<string, string | undefined>;
export const textEnabled = (env: Env = process.env) => env.STUDIO_TEXT_ENABLED === "true" && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_WEBHOOK_SECRET && !!env.ANTHROPIC_API_KEY;
export const textOpen = (env: Env = process.env) => textEnabled(env) && env.STUDIO_TEXT_OPEN === "true";
export const WEBHOOK_PATH = "/api/studio/text/telegram/webhook";
const APP = "https://app.clone8.io";
const CONNECT = `${APP}/#studio/account?text=1`;
const CODE_TTL_MS = 10 * 60_000, CONFIRM_TTL_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const short = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function botConfig(env: Env, timezone: string): BotConfig {
  const n = (v: unknown, d: number) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
  return { anthropicKey: env.ANTHROPIC_API_KEY ?? "", model: env.STUDIO_TEXT_MODEL || "claude-haiku-5-5", effort: ["low", "medium", "high"].includes(String(env.STUDIO_TEXT_EFFORT)) ? String(env.STUDIO_TEXT_EFFORT) : "low",
    timezone, dailyCredits: n(env.STUDIO_TEXT_DAILY_CREDITS, 1000), maxActionCredits: n(env.STUDIO_TEXT_MAX_ACTION_CREDITS, 1000) };
}
const validTz = (tz: unknown): string | null => { try { if (typeof tz !== "string" || !tz || tz.length > 64) return null; new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; } };

/** The bot's way to Clone8 inside this server: the Studio's own routes on the loopback address, as one person. */
export function serverApi(userId: string, o: { port: number; fetch?: typeof fetch; onCall?: (e: Record<string, unknown>) => void }): Api {
  const f = o.fetch ?? fetch;
  const send = async (method: Method, path: string, body: unknown, t: { timeoutMs?: number } | undefined, via: string): Promise<Reply> => {
    const r = await f(`http://127.0.0.1:${o.port}${path}`, { method, headers: { [INTERNAL_HEADER]: internalPass(userId, method, path), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(t?.timeoutMs ?? 60_000) });
    const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { error: "bad_response" }; }
    o.onCall?.({ via, method, path: pathOnly(path), status: r.status, error: r.status >= 400 ? json?.error ?? null : null });
    return { status: r.status, json };
  };
  return {
    async call(method, path, body, t) { const level = levelOf(method, path); if (level !== "read" && level !== "light") throw new Clone8Error("route_not_allowed", `${method} ${pathOnly(path)}`); return send(method, path, body, t, level); },
    async act(claim, method, path, body, t) { if (!claim) throw new Clone8Error("no_confirmation"); if (levelOf(method, path) !== "act") throw new Clone8Error("route_not_allowed", `${method} ${pathOnly(path)}`); return send(method, path, body, t, `act:${claim}`); },
    async bytes(url, maxBytes) {
      try {
        // only files Clone8 itself signed: the bot never fetches an address someone typed
        const host = new URL(url).hostname;
        if (!/\.supabase\.co$/.test(host) && !/(^|\.)clone8\.io$/.test(host)) return null;
        const r = await f(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) return null;
        const len = Number(r.headers.get("content-length") ?? 0); if (len && len > maxBytes) return null;
        const b = Buffer.from(await r.arrayBuffer()); return b.length > maxBytes ? null : b;
      } catch { return null; }
    },
  };
}

type Link = { id: string; user_id: string; channel: string; sender_id: string; chat_id: string; handle: string | null; status: string; timezone: string | null; created_at: string; confirmed_at: string | null };
const emptyChat = (chat: string): ChatState => ({ chat, history: [], table: [], notes: [], pending: { live: null, past: [] }, watches: [] });

export type TextDeps = { env?: Env; fetch?: typeof fetch; log?: (l: string) => void; port?: number;
  /** test seam: what sends into Telegram */ out?: Transport & { answerTap?: (id: string) => Promise<unknown>; clearButtons?: (chat: string, id: number) => Promise<unknown> };
  /** test seam: the brain */ think?: BrainDeps["fetch"]; };

export function registerTextBot(app: Express, sbFn: () => SupabaseClient, deps: TextDeps = {}) {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const port = deps.port ?? Number(env.PORT || 10000);
  const tg = env.TELEGRAM_BOT_TOKEN ? telegram(env.TELEGRAM_BOT_TOKEN, { fetch: deps.fetch, onGuard: (hit) => log(`[text] guard: ${hit}`) }) : null;
  const out = deps.out ?? tg?.out ?? null;
  let botName: string | null = env.STUDIO_TEXT_TELEGRAM_BOT ?? null;
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth && !(req.auth as any).via ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => { log(`[text] ${String(e?.message ?? e).slice(0, 200)}`); res.status(e?.status ?? 500).json({ error: e?.code ?? "text_failed", detail: e?.status ? String(e.message) : "Something went wrong on our side" }); };

  // ---- the append-only log: buffered, written every couple of seconds; AI calls also go to the cost ledger ----
  let buf: any[] = [], flushing = false;
  const flush = async () => { if (flushing || !buf.length) return; flushing = true; const rows = buf.splice(0, 500); try { const r = await sbFn().from("studio_text_events").insert(rows); if (r.error) log(`[text] log write failed: ${r.error.message}`); } catch (e: any) { log(`[text] log write failed: ${e?.message ?? e}`); } finally { flushing = false; } };
  const ticker = setInterval(() => { void flush(); }, 2000); (ticker as any).unref?.();
  const logFor = (user: string | null, chat: string | null) => (event: string, data: Record<string, unknown> = {}) => {
    buf.push({ user_id: user, channel: "telegram", chat_id: chat, event: event.slice(0, 40), data, at: new Date().toISOString() });
    if (event === "claude" && user) recordEvent({ user_id: user, kind: "claude", name: "text_bot", usd: Number(data.usd) || 0, props: { model: data.model, tool: "text", input: (data.usage as any)?.input_tokens, output: (data.usage as any)?.output_tokens, cache_write: (data.usage as any)?.cache_creation_input_tokens, cache_read: (data.usage as any)?.cache_read_input_tokens } });
    if (["error", "claude_error", "watch_error", "save_failed", "execute_unconfirmed"].includes(event)) log(`[text] ${event} ${user ?? "-"} ${JSON.stringify(data).slice(0, 200)}`);
  };

  // ---- per-person caches the brain uses (the account index, plan and balance), a few minutes each ----
  const indexes = new Map<string, { current: Index | null }>(), basics = new Map<string, BrainDeps["basics"]>();
  const rate = new Map<string, number[]>(), strangers = new Map<string, { day: string; n: number; bad: number }>();

  /** Before it opens to everyone, only the owner's account is answered, even if another one was linked earlier. */
  const allowed = new Map<string, { at: number; ok: boolean }>();
  async function mayUse(sb: SupabaseClient, user: string): Promise<boolean> {
    if (textOpen(env)) return true;
    const hit = allowed.get(user); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
    let ok = false;
    try { const r: any = await (sb as any).auth.admin.getUserById(user); const who = r?.data?.user; ok = !!who?.email_confirmed_at && adminEmails(env).includes(String(who?.email ?? "").toLowerCase()); } catch { ok = false; }
    allowed.set(user, { at: Date.now(), ok }); return ok;
  }
  async function linkOf(sb: SupabaseClient, sender: string): Promise<Link | null> {
    const r = await sb.from("studio_text_links").select("*").eq("channel", "telegram").eq("sender_id", sender).eq("status", "linked").maybeSingle();
    if (r.error) throw r.error;
    return (r.data as Link) ?? null;
  }
  async function timezoneOf(sb: SupabaseClient, link: Link): Promise<string> {
    const p = await sb.from("studio_social_profiles").select("timezone,posting_plan").eq("user_id", link.user_id).maybeSingle();
    return validTz((p.data as any)?.posting_plan?.timezone) ?? validTz((p.data as any)?.timezone) ?? validTz(link.timezone) ?? "America/Los_Angeles";
  }
  async function loadChat(sb: SupabaseClient, link: Link, chat: string): Promise<{ st: ChatState; stamp: string | null }> {
    const r = await sb.from("studio_text_chats").select("state,updated_at,user_id").eq("channel", "telegram").eq("chat_id", chat).maybeSingle();
    if (r.error) throw r.error;
    // a chat that changed hands (relinked to another account) starts clean: nothing of the last account carries over
    if (!r.data || (r.data as any).user_id !== link.user_id) return { st: emptyChat(chat), stamp: null };
    return { st: { ...emptyChat(chat), ...((r.data as any).state ?? {}), chat }, stamp: (r.data as any).updated_at };
  }
  async function saveChat(sb: SupabaseClient, link: Link, st: ChatState) {
    const now = new Date().toISOString();
    const row = { channel: "telegram", chat_id: st.chat, user_id: link.user_id, state: { ...st, history: st.history.slice(-60) }, watching: st.watches.length > 0, updated_at: now };
    const w = await sb.from("studio_text_chats").upsert(row, { onConflict: "channel,chat_id" });
    if (w.error) throw w.error;
    await sb.from("studio_text_links").update({ last_used_at: now }).eq("id", link.id);
  }

  /** One person's bot for one chat, with its state loaded; `run` handles a message or looks at running jobs. */
  async function withBot(sb: SupabaseClient, link: Link, chat: string, run: (bot: ReturnType<typeof makeBot>) => Promise<void>) {
    if (!out) return;
    const { st } = await loadChat(sb, link, chat);
    const cfg = botConfig(env, await timezoneOf(sb, link));
    const log2 = logFor(link.user_id, chat);
    const api = serverApi(link.user_id, { port, fetch: deps.fetch, onCall: (e) => log2("route", e) });
    if (!indexes.has(link.user_id)) indexes.set(link.user_id, { current: null });
    const brain: BrainDeps = { cfg, api, out, index: indexes.get(link.user_id)!, log: log2, basics: basics.get(link.user_id) ?? null, ...(deps.think ? { fetch: deps.think } : {}) };
    const state: BotState = { owner: link.sender_id, pair_code: null, offset: 0, chats: { [chat]: st }, strangers: {}, rate: { [link.sender_id]: rate.get(link.sender_id) ?? [] } };
    const bot = makeBot({ cfg, api, out, state, log: log2, save: () => saveChat(sb, link, st), think: (s, text, o) => think(brain, s, text, o), forget: () => { indexes.get(link.user_id)!.current = null; brain.basics = null; } });
    try { await run(bot); }
    finally { rate.set(link.sender_id, state.rate[link.sender_id] ?? []); basics.set(link.user_id, brain.basics ?? null); }
  }

  // ---- linking: /start <code> from someone not linked yet ----
  async function stranger(sb: SupabaseClient, u: Incoming) {
    // replies to people who aren't connected are capped a day; so are wrong connection links (guessing is pointless
    // with 24 random characters, but there is no reason to let anyone try)
    const day = new Date().toISOString().slice(0, 10), k0 = strangers.get(u.from), k = k0 && k0.day === day ? k0 : { day, n: 0, bad: 0 };
    const n = k.n; k.n++; strangers.set(u.from, k);
    const g = classify(u.text);
    if (g.kind === "start" && g.code && k.bad < 10) {
      const c = await sb.from("studio_text_codes").select("*").eq("code_hash", hash(g.code)).maybeSingle();
      const code: any = c.data;
      if (code && !code.used_at && Date.parse(code.expires_at) > Date.now()) {
        const used = await sb.from("studio_text_codes").update({ used_at: new Date().toISOString(), sender_id: u.from }).eq("code_hash", code.code_hash).is("used_at", null).select("code_hash");
        if (!(used.data ?? []).length) return; // two taps at once: the first one won
        const other = await sb.from("studio_text_links").select("user_id").eq("channel", "telegram").eq("sender_id", u.from).eq("status", "linked").maybeSingle();
        if (other.data && (other.data as any).user_id !== code.user_id) { await out!.text(u.chat, "This Telegram account is already connected to a different Clone8 account. Remove it there first (Account → Text Clone8), then try again."); return; }
        // any older unconfirmed request from this sender for this account is replaced
        await sb.from("studio_text_links").update({ status: "removed" }).eq("channel", "telegram").eq("sender_id", u.from).eq("status", "pending");
        const ins = await sb.from("studio_text_links").insert({ user_id: code.user_id, channel: "telegram", sender_id: u.from, chat_id: u.chat, handle: u.name ? short(u.name, 60) : null, status: "pending", timezone: code.timezone });
        if (ins.error) throw ins.error;
        logFor(code.user_id, u.chat)("link_requested", { sender: u.from });
        await out!.text(u.chat, `Almost done. Go back to Clone8 and tap Confirm next to "Telegram${u.name ? ` @${short(u.name, 40)}` : ""}" to connect this chat to your account.\n${CONNECT}`);
        return;
      }
      k.bad++;
      logFor(null, u.chat)("link_code_bad", { sender: u.from });
      if (k.bad <= 3) await out!.text(u.chat, `That link has expired or was already used. Make a new one in the Clone8 app: ${CONNECT}`);
      return;
    }
    if (n < 3) await out!.text(u.chat, `Hi, I'm Clone8. Connect your Clone8 account first, then text me what you want to make, post or check.\nOpen the app: Account → Text Clone8.\n${CONNECT}`);
  }

  async function handleUpdate(sb: SupabaseClient, u: Incoming) {
    if (!u.private || !out) return;
    const link = await linkOf(sb, u.from);
    if (u.callback_id) { void (deps.out?.answerTap ?? tg?.answerTap)?.(u.callback_id); if (u.message_id && /^(y|n):/.test(u.text)) void (deps.out?.clearButtons ?? tg?.clearButtons)?.(u.chat, u.message_id); }
    if (!link) return stranger(sb, u);
    if (link.chat_id !== u.chat) return; // a person's linked chat is the private chat with the bot; anything else is ignored
    if (!(await mayUse(sb, link.user_id))) { if (!u.callback_id) await out.text(u.chat, "Texting Clone8 isn't open for your account yet. We'll let you know when it is."); return; }
    const g = classify(u.text);
    if (g.kind === "start" && g.code) { await out.text(u.chat, "This chat is already connected to your Clone8 account. To connect a different account, remove this one first in the app (Account → Text Clone8)."); return; }
    await withBot(sb, link, u.chat, (bot) => bot.handle({ chat: u.chat, from: u.from, text: u.text, private: u.private, tap: !!u.callback_id, has_file: u.has_file }));
  }

  // ---- the inbox: written by the webhook, worked on in order, one chat at a time ----
  const me = randomBytes(6).toString("hex");
  const chains = new Map<string, Promise<void>>();
  /** updates this process is working on: never taken twice, however long one takes */
  const inflight = new Set<number>();
  let draining = false;
  async function drain() {
    if (draining || !textEnabled(env)) return; draining = true;
    try {
      const sb = sbFn();
      const stale = Date.now() - 5 * 60_000;
      const r = await sb.from("studio_text_inbox").select("update_id,payload,claimed_at").eq("channel", "telegram").is("done_at", null).order("update_id", { ascending: true }).limit(25);
      if (r.error) throw r.error;
      for (const row of (r.data ?? []) as any[]) {
        if (inflight.has(Number(row.update_id))) continue;
        if (row.claimed_at && Date.parse(row.claimed_at) > stale) continue;
        const c = await sb.from("studio_text_inbox").update({ claimed_at: new Date().toISOString(), claimed_by: me }).eq("channel", "telegram").eq("update_id", row.update_id).is("done_at", null)
          [row.claimed_at ? "eq" : "is"]("claimed_at", row.claimed_at ?? null).select("update_id");
        if (!(c.data ?? []).length) continue; // another server took it (during a deploy two run for a minute)
        inflight.add(Number(row.update_id));
        const u = parseUpdate(row.payload);
        const chat = u?.chat ?? "none";
        const prev = chains.get(chat) ?? Promise.resolve();
        const next = prev.then(async () => {
          try { if (u) await handleUpdate(sb, u); }
          catch (e: any) { log(`[text] update ${row.update_id} failed: ${String(e?.message ?? e).slice(0, 200)}`); }
          finally { await sb.from("studio_text_inbox").update({ done_at: new Date().toISOString() }).eq("channel", "telegram").eq("update_id", row.update_id).then(() => undefined, () => undefined); inflight.delete(Number(row.update_id)); }
        });
        chains.set(chat, next.finally(() => { if (chains.get(chat) === next) chains.delete(chat); }));
      }
    } catch (e: any) { log(`[text] inbox: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { draining = false; }
  }

  // ---- the watcher: jobs and edits started by text, their results sent when ready ----
  let watching = false, swept = 0;
  async function watchAll() {
    if (watching || !textEnabled(env)) return; watching = true;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_text_chats").select("chat_id,user_id").eq("channel", "telegram").eq("watching", true).limit(200);
      for (const row of (r.data ?? []) as any[]) {
        const l = await sb.from("studio_text_links").select("*").eq("channel", "telegram").eq("chat_id", row.chat_id).eq("user_id", row.user_id).eq("status", "linked").maybeSingle();
        if (!l.data || !(await mayUse(sb, row.user_id))) continue;
        const prev = chains.get(row.chat_id) ?? Promise.resolve();
        const next = prev.then(() => withBot(sb, l.data as Link, row.chat_id, (bot) => bot.watch()).catch((e) => log(`[text] watch ${row.chat_id}: ${String(e?.message ?? e).slice(0, 160)}`)));
        chains.set(row.chat_id, next);
        await next;
      }
      // housekeeping, about once an hour: answered messages after 7 days, used or expired codes after a day
      if (Date.now() - swept > 3600_000) {
        swept = Date.now();
        await sb.from("studio_text_inbox").delete().eq("channel", "telegram").lt("done_at", new Date(Date.now() - 7 * 86400_000).toISOString());
        await sb.from("studio_text_codes").delete().lt("expires_at", new Date(Date.now() - 86400_000).toISOString());
      }
    } catch (e: any) { log(`[text] watcher: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { watching = false; }
  }

  if (textEnabled(env) && !deps.out) {
    const a = setInterval(() => { void drain(); }, 1500); (a as any).unref?.();
    const b = setInterval(() => { void watchAll(); }, 20_000); (b as any).unref?.();
    // Telegram is told where to deliver (idempotent; done at every start so a changed address or secret takes effect)
    const base = (env.STUDIO_TEXT_PUBLIC_URL || "https://tradvio-reels-backend.onrender.com").replace(/\/+$/, "");
    setTimeout(() => { void (async () => {
      try {
        const r = await (deps.fetch ?? fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${base}${WEBHOOK_PATH}`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], max_connections: 20 }) });
        const j: any = await r.json().catch(() => null);
        log(`[text] telegram webhook ${j?.ok ? "set" : `NOT set: ${String(j?.description ?? r.status).slice(0, 120)}`}`);
        if (!botName && tg) botName = (await tg.me()).username;
      } catch (e: any) { log(`[text] telegram webhook not set: ${String(e?.message ?? e).replace(String(env.TELEGRAM_BOT_TOKEN), "<token>").slice(0, 160)}`); }
    })(); }, 5000);
  }

  // ---- routes ----
  app.post(WEBHOOK_PATH, async (req, res) => {
    if (!textEnabled(env)) return res.status(404).json({ error: "not_found" });
    const want = Buffer.from(String(env.TELEGRAM_WEBHOOK_SECRET)), got = Buffer.from(String(req.header("x-telegram-bot-api-secret-token") ?? ""));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return res.status(401).json({ error: "unauthorized" });
    const id = Number(req.body?.update_id);
    if (!Number.isSafeInteger(id)) return res.json({ ok: true });
    try {
      const w = await sbFn().from("studio_text_inbox").upsert({ channel: "telegram", update_id: id, payload: req.body, received_at: new Date().toISOString() }, { onConflict: "channel,update_id", ignoreDuplicates: true });
      if (w.error) throw w.error;
      res.json({ ok: true });
      void drain();
    } catch (e: any) { log(`[text] webhook write failed: ${String(e?.message ?? e).slice(0, 160)}`); res.status(500).json({ error: "retry" }); } // Telegram retries a non-200
  });

  /** Who may link: everyone once open; before that, the owner's account only. */
  const mayLink = async (req: Request) => textOpen(env) || (textEnabled(env) && (await isStudioAdmin(req, sbFn(), env)));

  app.get("/api/studio/text/links", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const open = await mayLink(req);
      if (!open) return res.json({ open: false, links: [] });
      const r = await sbFn().from("studio_text_links").select("id,channel,handle,status,created_at,confirmed_at,last_used_at").eq("user_id", u).in("status", ["pending", "linked"]).order("created_at", { ascending: false }).limit(10);
      if (r.error) throw r.error;
      const fresh = (l: any) => l.status === "linked" || Date.now() - Date.parse(l.created_at) < CONFIRM_TTL_MS;
      res.json({ open: true, bot: botName, links: ((r.data ?? []) as any[]).filter(fresh) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/text/link", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!(await mayLink(req))) return res.status(403).json({ error: "text_not_open", detail: "Texting Clone8 opens soon" });
      if (!botName && tg) botName = (await tg.me()).username;
      const sb = sbFn();
      // a few codes a day per person: each opens the bot for ten minutes and works once
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_text_codes").select("code_hash", { count: "exact", head: true }).eq("user_id", u).gte("created_at", since);
      if ((n.count ?? 0) >= 20) return res.status(429).json({ error: "too_many", detail: "That is a lot of connection links for one day; try again tomorrow" });
      const code = randomBytes(18).toString("base64url");
      const w = await sb.from("studio_text_codes").insert({ code_hash: hash(code), user_id: u, channel: "telegram", timezone: validTz(req.body?.timezone), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
      if (w.error) throw w.error;
      res.json({ url: `https://t.me/${botName}?start=${code}`, expires_in: CODE_TTL_MS / 1000, bot: botName });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/text/links/:id/confirm", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const sb = sbFn();
      const r = await sb.from("studio_text_links").select("*").eq("id", req.params.id).eq("user_id", u).eq("status", "pending").maybeSingle();
      const l = r.data as Link | null;
      if (!l || Date.now() - Date.parse(l.created_at) > CONFIRM_TTL_MS) return res.status(410).json({ error: "expired", detail: "That request ran out of time. Start again from Text Clone8." });
      const taken = await sb.from("studio_text_links").select("id,user_id").eq("channel", "telegram").eq("sender_id", l.sender_id).eq("status", "linked").maybeSingle();
      if (taken.data && (taken.data as any).user_id !== u) return res.status(409).json({ error: "taken", detail: "That Telegram account is connected to a different Clone8 account" });
      if (taken.data) await sb.from("studio_text_links").update({ status: "removed" }).eq("id", (taken.data as any).id);
      const w = await sb.from("studio_text_links").update({ status: "linked", confirmed_at: new Date().toISOString() }).eq("id", l.id).eq("status", "pending").select("id");
      if (w.error) throw w.error;
      if (!(w.data ?? []).length) return res.status(409).json({ error: "changed", detail: "That request changed; refresh" });
      // a fresh start for this chat: nothing from an earlier account carries over
      await sb.from("studio_text_chats").delete().eq("channel", "telegram").eq("chat_id", l.chat_id).neq("user_id", u);
      logFor(u, l.chat_id)("linked", { sender: l.sender_id });
      const who = await (sb as any).auth?.admin?.getUserById?.(u).catch?.(() => null);
      const email = String(who?.data?.user?.email ?? "");
      const masked = email.includes("@") ? `${email[0]}***${email.slice(email.indexOf("@") - 1)}` : "your account";
      if (out) await out.text(l.chat_id, `Connected to your Clone8 account (${masked}).\n\n${HELP}`).catch(() => undefined);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/text/links/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const sb = sbFn();
      const r = await sb.from("studio_text_links").update({ status: "removed" }).eq("id", req.params.id).eq("user_id", u).in("status", ["pending", "linked"]).select("chat_id,status");
      if (r.error) throw r.error;
      const row: any = (r.data ?? [])[0];
      if (row) { logFor(u, row.chat_id)("unlinked", {}); if (out) await out.text(row.chat_id, `This chat is no longer connected to Clone8. To connect again: ${CONNECT}`).catch(() => undefined); }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return { drain, watchAll, handleUpdate, flush };
}
