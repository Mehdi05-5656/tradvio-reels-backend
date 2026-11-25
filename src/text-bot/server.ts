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
// Channels (Nov 24 2026): Telegram and iMessage (a Sendblue line). Each is a small description below (how it sends, reads
// an incoming message, spots a connect code, builds the connect link); every table row carries its channel.
// Switches: STUDIO_TEXT_ENABLED with ANTHROPIC_API_KEY turns texting on. Telegram: TELEGRAM_BOT_TOKEN +
// TELEGRAM_WEBHOOK_SECRET, open to every customer with STUDIO_TEXT_OPEN. iMessage: STUDIO_TEXT_IMESSAGE_ENABLED +
// SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET, SENDBLUE_FROM_NUMBER, SENDBLUE_WEBHOOK_SECRET, open to every customer with
// STUDIO_TEXT_IMESSAGE_OPEN. Before a channel is open, only the owner's account may connect it.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminEmails, isStudioAdmin } from "../studio-admin-auth.js";
import { recordEvent } from "../studio-events.js";
import { isStopping, isSuperseded } from "../studio-leases.js";
import { INTERNAL_HEADER, internalPass } from "./internal.js";
import { levelOf, Clone8Error, pathOnly, type Api, type BotConfig, type Method, type Reply } from "./routes.js";
import { makeBot, HELP, type BotState } from "./bot.js";
import { think, type BrainDeps, type ChatState, type Transport } from "./brain.js";
import { telegram, parseUpdate, type Incoming } from "./telegram.js";
import { sendblue, parseSendblue, verifySendblue, handleId, contactCard, mask } from "./sendblue.js";
import { classify } from "./gate.js";
import type { Index } from "./account.js";
import { chatLines, textAdminView, type TextEventRow, type TextLinkRow } from "./admin.js";

type Env = Record<string, string | undefined>;
export type ChannelName = "telegram" | "imessage";
const baseOn = (env: Env) => env.STUDIO_TEXT_ENABLED === "true" && !!env.ANTHROPIC_API_KEY;
/** Telegram is on (the name stays: it was the only channel). */
export const textEnabled = (env: Env = process.env) => baseOn(env) && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_WEBHOOK_SECRET;
export const textOpen = (env: Env = process.env) => textEnabled(env) && env.STUDIO_TEXT_OPEN === "true";
export const imessageEnabled = (env: Env = process.env) => baseOn(env) && env.STUDIO_TEXT_IMESSAGE_ENABLED === "true" && !!env.SENDBLUE_API_KEY_ID && !!env.SENDBLUE_API_SECRET && /^\+\d{7,15}$/.test(String(env.SENDBLUE_FROM_NUMBER ?? "")) && String(env.SENDBLUE_WEBHOOK_SECRET ?? "").length >= 16;
export const imessageOpen = (env: Env = process.env) => imessageEnabled(env) && env.STUDIO_TEXT_IMESSAGE_OPEN === "true";
const anyEnabled = (env: Env) => textEnabled(env) || imessageEnabled(env);
export const WEBHOOK_PATH = "/api/studio/text/telegram/webhook";
export const IMESSAGE_WEBHOOK_PATH = "/api/studio/text/imessage/webhook";
/** "LINK <code>": what the Connect iMessage button types into Messages. */
const LINK_RE = /^\s*LINK\s+([A-Za-z0-9_-]{24})\s*[.!]?\s*$/i; // (exactly a connect code: "link instagram" is a request)
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

type Out = Transport & { answerTap?: (id: string) => Promise<unknown>; clearButtons?: (chat: string, id: number) => Promise<unknown> };
type Channel = {
  name: ChannelName; label: string; enabled: () => boolean; open: () => boolean; out: Out | null;
  /** one stored webhook body as a message, or null */ parse: (payload: any) => Incoming | null;
  /** the connect code in a first message from someone not connected yet */ startCode: (text: string) => string | null;
  /** after a chat is connected (iMessage: send the Clone8 contact card) */ onLinked?: (chat: string) => Promise<void>;
};
export type TextDeps = { env?: Env; fetch?: typeof fetch; log?: (l: string) => void; port?: number;
  /** test seam: what sends into Telegram */ out?: Out;
  /** test seam: what sends into iMessage */ imessageOut?: Out;
  /** test seam: the brain */ think?: BrainDeps["fetch"]; };

export function registerTextBot(app: Express, sbFn: () => SupabaseClient, deps: TextDeps = {}) {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const port = deps.port ?? Number(env.PORT || 10000);
  const tg = env.TELEGRAM_BOT_TOKEN ? telegram(env.TELEGRAM_BOT_TOKEN, { fetch: deps.fetch, onGuard: (hit) => log(`[text] guard: ${hit}`) }) : null;
  const sbl = env.SENDBLUE_API_KEY_ID && env.SENDBLUE_API_SECRET && env.SENDBLUE_FROM_NUMBER ? sendblue({ keyId: env.SENDBLUE_API_KEY_ID, secret: env.SENDBLUE_API_SECRET, from: env.SENDBLUE_FROM_NUMBER, fetch: deps.fetch, onGuard: (hit) => log(`[text] guard: ${hit}`) }) : null;
  let card: string | null = null; // the contact card's upload, made once
  const LOGO = `${APP}/brand/icon-512.png`, CARD_LOGO = `${APP}/brand/apple-touch-icon.png`;
  /** chats the line's Name & Photo was shared into today (Sendblue ignores repeats for 24 h anyway) */
  const sharedDay = new Map<string, string>();
  const shareProfile = (chat: string) => {
    if (!sbl || deps.imessageOut) return;
    const day = new Date().toISOString().slice(0, 10);
    if (sharedDay.get(chat) === day) return;
    sharedDay.set(chat, day); if (sharedDay.size > 20_000) sharedDay.clear();
    void sbl.share(chat).catch((e: any) => log(`[text] name & photo not shared: ${String(e?.message ?? e).slice(0, 120)}`));
  };
  const channels: Record<ChannelName, Channel> = {
    telegram: { name: "telegram", label: "Telegram", enabled: () => textEnabled(env), open: () => textOpen(env), out: deps.out ?? tg?.out ?? null, parse: parseUpdate,
      startCode: (t) => { const g = classify(t); return g.kind === "start" && g.code ? g.code : null; } },
    imessage: { name: "imessage", label: "iMessage", enabled: () => imessageEnabled(env), open: () => imessageOpen(env), out: deps.imessageOut ?? sbl?.out ?? null, parse: (p) => parseSendblue(p, env.SENDBLUE_FROM_NUMBER),
      startCode: (t) => LINK_RE.exec(t)?.[1] ?? null,
      onLinked: async (chat) => {
        if (!sbl || deps.imessageOut) return;
        const make = async () => {
          let logo: Buffer | null = null;
          try { const r = await (deps.fetch ?? fetch)(CARD_LOGO, { signal: AbortSignal.timeout(15_000) }); if (r.ok) logo = Buffer.from(await r.arrayBuffer()); } catch { /* a card without the logo still works */ }
          return (card = await sbl.upload({ kind: "photo", bytes: Buffer.from(contactCard(String(env.SENDBLUE_FROM_NUMBER), logo)), name: "Clone8.vcf" } as any));
        };
        if (!card) await make();
        // (an upload kept from earlier may have expired at Sendblue: made again once)
        try { await sbl.sendUrl(chat, card!); } catch { await make(); await sbl.sendUrl(chat, card!); }
        shareProfile(chat);
      } },
  };
  const chOf = (name: unknown): Channel | null => (name === "telegram" || name === "imessage" ? channels[name] : null);
  const live = () => (Object.values(channels) as Channel[]).filter((c) => c.enabled()).map((c) => c.name);
  const out = channels.telegram.out; // (Telegram's, for the few places that are Telegram's alone)
  // files: one turn at a time across the whole server moves files (each can be tens of megabytes in memory). A turn
  // takes the lock at its first download and keeps it until it ends, so its downloads and sends all fit in one slot
  let fileLock: Promise<void> = Promise.resolve();
  const takeFileLock = async (): Promise<() => void> => { let free!: () => void; const mine = new Promise<void>((r) => (free = r)); const before = fileLock; fileLock = before.then(() => mine); await before; return free; };
  let botName: string | null = env.STUDIO_TEXT_TELEGRAM_BOT ?? null;
  const me = randomBytes(6).toString("hex"), LEASE_MS = 6 * 60_000; // longer than the longest single step (a link import may take 5 minutes)
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth && !(req.auth as any).via ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => { log(`[text] ${String(e?.message ?? e).slice(0, 200)}`); res.status(e?.status ?? 500).json({ error: e?.code ?? "text_failed", detail: e?.status ? String(e.message) : "Something went wrong on our side" }); };

  // ---- the append-only log: buffered, written every couple of seconds; AI calls also go to the cost ledger ----
  let buf: any[] = [], flushing = false;
  // (a failed write keeps its rows for the next try, up to 5,000 waiting; past that the oldest go)
  const flush = async () => { if (flushing || !buf.length) return; flushing = true; const rows = buf.splice(0, 500); let ok = false;
    try {
      const r = await sbFn().from("studio_text_events").insert(rows);
      if (!r.error) ok = true;
      else {
        // the database refused the batch: write them one by one and drop only the rows it refuses (one bad row must not
        // hold up the log)
        log(`[text] log write failed: ${r.error.message}`); ok = true;
        for (const row of rows) { const one = await sbFn().from("studio_text_events").insert(row); if (one.error) log(`[text] log row dropped: ${one.error.message}`); }
      }
    } catch (e: any) { log(`[text] log write failed: ${e?.message ?? e}`); }
    finally { if (!ok) buf = [...rows, ...buf].slice(-5000); flushing = false; } };
  const ticker = setInterval(() => { void flush(); }, 2000); (ticker as any).unref?.();
  const logFor = (user: string | null, chat: string | null, channel: ChannelName = "telegram") => (event: string, data: Record<string, unknown> = {}) => {
    buf.push({ user_id: user, channel, chat_id: chat, event: event.slice(0, 40), data, at: new Date().toISOString() });
    if (event === "claude" && user) recordEvent({ user_id: user, kind: "claude", name: "text_bot", usd: Number(data.usd) || 0, props: { model: data.model, tool: "text", input: (data.usage as any)?.input_tokens, output: (data.usage as any)?.output_tokens, cache_write: (data.usage as any)?.cache_creation_input_tokens, cache_read: (data.usage as any)?.cache_read_input_tokens } });
    if (["error", "claude_error", "watch_error", "save_failed", "execute_unconfirmed"].includes(event)) log(`[text] ${event} ${user ?? "-"} ${JSON.stringify(data).slice(0, 200)}`);
  };

  // ---- per-person caches the brain uses (the account index, plan and balance), a few minutes each ----
  const indexes = new Map<string, { current: Index | null }>(), basics = new Map<string, BrainDeps["basics"]>();
  const rate = new Map<string, number[]>(), strangers = new Map<string, { day: string; n: number; bad: number }>();

  /** A linked account is answered only while it exists; before texting opens to everyone, only the owner's account. */
  // ("unknown": the check itself failed; not answered now, but nothing is undone and nothing is remembered)
  const allowed = new Map<string, { at: number; ok: boolean }>();
  async function access(sb: SupabaseClient, user: string, ch: ChannelName = "telegram"): Promise<"yes" | "no" | "unknown"> {
    const key = `${ch}:${user}`;
    const hit = allowed.get(key); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok ? "yes" : "no";
    let ok: boolean;
    try {
      const r: any = await (sb as any).auth.admin.getUserById(user);
      const who = r?.data?.user;
      if (!who && r?.error && !/not.?found/i.test(String(r.error.message ?? r.error.code ?? ""))) return "unknown";
      ok = !!who && channels[ch].enabled() && (channels[ch].open() || (!!who.email_confirmed_at && adminEmails(env).includes(String(who.email ?? "").toLowerCase())));
    } catch { return "unknown"; }
    if (allowed.size > 5000) allowed.clear();
    allowed.set(key, { at: Date.now(), ok }); return ok ? "yes" : "no";
  }
  const mayUse = async (sb: SupabaseClient, user: string, ch: ChannelName) => (await access(sb, user, ch)) === "yes";
  async function linkOf(sb: SupabaseClient, ch: ChannelName, sender: string): Promise<Link | null> {
    const r = await sb.from("studio_text_links").select("*").eq("channel", ch).eq("sender_id", sender).eq("status", "linked").maybeSingle();
    if (r.error) throw r.error;
    return (r.data as Link) ?? null;
  }
  async function timezoneOf(sb: SupabaseClient, link: Link): Promise<string> {
    const p = await sb.from("studio_social_profiles").select("timezone,posting_plan").eq("user_id", link.user_id).maybeSingle();
    return validTz((p.data as any)?.posting_plan?.timezone) ?? validTz((p.data as any)?.timezone) ?? validTz(link.timezone) ?? "America/Los_Angeles";
  }
  async function loadChat(sb: SupabaseClient, link: Link, chat: string): Promise<{ st: ChatState; stamp: string | null }> {
    const r = await sb.from("studio_text_chats").select("state,updated_at,user_id").eq("channel", link.channel).eq("chat_id", chat).maybeSingle();
    if (r.error) throw r.error;
    // a chat that changed hands (relinked to another account) starts clean: nothing of the last account carries over
    if (!r.data || (r.data as any).user_id !== link.user_id) return { st: emptyChat(chat), stamp: null };
    return { st: { ...emptyChat(chat), ...((r.data as any).state ?? {}), chat }, stamp: (r.data as any).updated_at };
  }
  /** Only the server holding a chat writes it: a save from one that lost the chat fails, and with it the turn (the
   *  bot saves a claimed action BEFORE running it, so a YES can never run on two servers). */
  async function saveChat(sb: SupabaseClient, link: Link, st: ChatState) {
    const now = new Date().toISOString();
    const w = await sb.from("studio_text_chats").update({ user_id: link.user_id, state: { ...st, history: st.history.slice(-60) }, watching: st.watches.length > 0, updated_at: now, lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq("channel", link.channel).eq("chat_id", st.chat).eq("lease_by", me).select("chat_id");
    if (w.error) throw w.error;
    if (!(w.data ?? []).length) throw Object.assign(new Error("chat_lease_lost"), { code: "chat_lease_lost" });
    await sb.from("studio_text_links").update({ last_used_at: now }).eq("id", link.id);
  }
  /** Take a chat for this server for a few minutes; false when another server is working on it. */
  async function lease(sb: SupabaseClient, link: Link, chat: string): Promise<boolean> {
    const now = new Date().toISOString(), until = new Date(Date.now() + LEASE_MS).toISOString();
    const r = await sb.from("studio_text_chats").update({ lease_by: me, lease_until: until }).eq("channel", link.channel).eq("chat_id", chat)
      .or(`lease_until.is.null,lease_until.lt.${now},lease_by.eq.${me}`).select("chat_id");
    if (r.error) throw r.error;
    if ((r.data ?? []).length) return true;
    const ex = await sb.from("studio_text_chats").select("chat_id").eq("channel", link.channel).eq("chat_id", chat).maybeSingle();
    if (ex.error) throw ex.error;
    if (ex.data) return false;
    const ins = await sb.from("studio_text_chats").insert({ channel: link.channel, chat_id: chat, user_id: link.user_id, state: {}, lease_by: me, lease_until: until });
    if (!ins.error) return true;
    if ((ins.error as any).code === "23505" || /duplicate key/i.test(ins.error.message)) return false; // another server made the row a moment ago: it has the chat
    throw ins.error;
  }
  const unlease = (sb: SupabaseClient, ch: string, chat: string) => sb.from("studio_text_chats").update({ lease_by: null, lease_until: null }).eq("channel", ch).eq("chat_id", chat).eq("lease_by", me).then(() => undefined, () => undefined);

  /** One person's bot for one chat, with its state loaded; `run` handles a message or looks at running jobs.
   *  False when another server holds the chat (the caller tries again later). */
  async function withBot(sb: SupabaseClient, link: Link, chat: string, run: (bot: ReturnType<typeof makeBot>) => Promise<void>): Promise<boolean> {
    if (!chOf(link.channel)?.out) return true;
    if (!(await lease(sb, link, chat))) return false;
    // a long turn keeps the chat: the hold is renewed every two minutes while it runs
    const renew = setInterval(() => { void sb.from("studio_text_chats").update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString() }).eq("channel", link.channel).eq("chat_id", chat).eq("lease_by", me).then(() => undefined, () => undefined); }, 2 * 60_000);
    (renew as any).unref?.();
    try { await withLoaded(sb, link, chat, run); } finally { clearInterval(renew); await unlease(sb, link.channel, chat); }
    return true;
  }
  async function withLoaded(sb: SupabaseClient, link: Link, chat: string, run: (bot: ReturnType<typeof makeBot>) => Promise<void>) {
    const out0 = chOf(link.channel)!.out;
    const { st } = await loadChat(sb, link, chat);
    const cfg = botConfig(env, await timezoneOf(sb, link));
    const log2 = logFor(link.user_id, chat, link.channel as ChannelName);
    const api0 = serverApi(link.user_id, { port, fetch: deps.fetch, onCall: (e) => log2("route", e) });
    // every reply and file that reaches the chat is in the log, so whole conversations can be read back (the weekly
    // review reads them); a send that fails is logged as such and still fails
    const said = (fn: () => Promise<void>, data: Record<string, unknown>) => fn().then(() => log2("out", data), (e) => { log2("send_failed", { ...data, detail: String(e?.message ?? e).slice(0, 200) }); throw e; });
    const out: Transport = {
      ...out0!,
      text: (chat, text, buttons, own) => said(() => out0!.text(chat, text, buttons, own), { text: text.slice(0, 4000), ...(buttons?.length ? { buttons: buttons.map((b) => b.label) } : {}) }),
      media: (chat, items, caption, buttons, own) => said(() => out0!.media(chat, items, caption, buttons, own), { text: (caption ?? "").slice(0, 2000), media: items.map((m) => ({ kind: m.kind, name: m.name, bytes: m.bytes.length, caption: m.caption ?? null })) }),
    };
    let freeFiles: (() => void) | null = null;
    const api: Api = { ...api0, bytes: async (url, max) => { if (!freeFiles) freeFiles = await takeFileLock(); return api0.bytes(url, max); } };
    if (!indexes.has(link.user_id)) indexes.set(link.user_id, { current: null });
    const brain: BrainDeps = { cfg, api, out, index: indexes.get(link.user_id)!, log: log2, basics: basics.get(link.user_id) ?? null, ...(deps.think ? { fetch: deps.think } : {}) };
    const toldKey = `${link.sender_id}:told`;
    const state: BotState = { owner: link.sender_id, pair_code: null, offset: 0, chats: { [chat]: st }, strangers: {}, rate: { [link.sender_id]: rate.get(link.sender_id) ?? [], [toldKey]: rate.get(toldKey) ?? [] } };
    const bot = makeBot({ cfg, api, out, state, log: log2, save: () => saveChat(sb, link, st), think: (s, text, o) => think(brain, s, text, o), forget: () => { indexes.get(link.user_id)!.current = null; brain.basics = null; } });
    try { await run(bot); }
    finally { (freeFiles as (() => void) | null)?.(); rate.set(link.sender_id, state.rate[link.sender_id] ?? []); rate.set(toldKey, state.rate[toldKey] ?? []); basics.set(link.user_id, brain.basics ?? null); }
  }

  // ---- linking: a first message carrying a connect code, from someone not connected yet ----
  async function stranger(sb: SupabaseClient, ch: Channel, u: Incoming) {
    const say = ch.out!;
    // replies to people who aren't connected are capped a day; so are wrong connection links (guessing is pointless
    // with 24 random characters, but there is no reason to let anyone try)
    const key = `${ch.name}:${u.from}`, day = new Date().toISOString().slice(0, 10), k0 = strangers.get(key), k = k0 && k0.day === day ? k0 : { day, n: 0, bad: 0 };
    const n = k.n; k.n++; strangers.set(key, k);
    // STOP and the like from someone not connected: nothing is sent back, ever (a phone line must honour it)
    if (["stop", "pause"].includes(classify(u.text).kind) || /^\s*(unsubscribe|cancel|end|quit|stopall)\s*$/i.test(u.text)) { logFor(null, u.chat, ch.name)("stranger_stop", {}); return; }
    const start = ch.startCode(u.text);
    if (start && k.bad < 10) {
      const c = await sb.from("studio_text_codes").select("*").eq("code_hash", hash(start)).maybeSingle();
      const code: any = c.data;
      if (code && !code.used_at && Date.parse(code.expires_at) > Date.now() && (code.channel ?? "telegram") === ch.name) {
        const used = await sb.from("studio_text_codes").update({ used_at: new Date().toISOString(), sender_id: u.from }).eq("code_hash", code.code_hash).is("used_at", null).select("code_hash");
        if (!(used.data ?? []).length) return; // two taps at once: the first one won
        // any older unconfirmed request from this sender is replaced
        await sb.from("studio_text_links").update({ status: "removed" }).eq("channel", ch.name).eq("sender_id", u.from).eq("status", "pending");
        // the four digits go only to this chat; the account's owner types them in the app. Someone who saw or tapped
        // the link first can't finish it: the digits land in their chat, not the owner's
        const digits = String(randomInt(0, 10_000)).padStart(4, "0");
        const ins = await sb.from("studio_text_links").insert({ user_id: code.user_id, channel: ch.name, sender_id: u.from, chat_id: u.chat, handle: u.name ? short(u.name, 60) : null, status: "pending", timezone: code.timezone, confirm_hash: hash(`${u.from}:${digits}`) });
        if (ins.error) throw ins.error;
        logFor(code.user_id, u.chat, ch.name)("link_requested", { sender: ch.name === "imessage" ? mask(u.from) : u.from });
        await say.text(u.chat, `Your Clone8 code: ${digits}\n\nType it in the Clone8 app to finish connecting. It works for 15 minutes.\nDidn't ask for this? Just ignore it.`, [{ label: `Copy ${digits}`, copy: digits }, { label: "Back to Clone8", url: CONNECT }]);
        return;
      }
      k.bad++;
      logFor(null, u.chat, ch.name)("link_code_bad", { sender: ch.name === "imessage" ? mask(u.from) : u.from });
      if (k.bad <= 3) await say.text(u.chat, `That link has expired or was already used. Make a new one in the Clone8 app: ${CONNECT}`);
      return;
    }
    if (n < 3) await say.text(u.chat, `Hi, I'm Clone8. Connect your Clone8 account first, then text me what you want to make, post or check.\nOpen the app: Account → Text Clone8.\n${CONNECT}`);
  }

  async function handleUpdate(sb: SupabaseClient, u: Incoming, chName: ChannelName = "telegram"): Promise<void | "busy"> {
    const ch = channels[chName], say = ch.out;
    if (!u.private || !say) return;
    const link = await linkOf(sb, ch.name, u.from);
    if (u.callback_id && ch.name === "telegram") { void (deps.out?.answerTap ?? tg?.answerTap)?.(u.callback_id); if (u.message_id && /^(y|n):/.test(u.text)) void (deps.out?.clearButtons ?? tg?.clearButtons)?.(u.chat, u.message_id); }
    if (!link) return stranger(sb, ch, u);
    if (link.chat_id !== u.chat) return; // a person's linked chat is the private chat with the bot; anything else is ignored
    if (!(await mayUse(sb, link.user_id, ch.name))) { if (!u.callback_id) await say.text(u.chat, `Texting Clone8 on ${ch.label} isn't open for your account yet.`); return; }
    if (ch.startCode(u.text)) { await say.text(u.chat, "This chat is already connected to your Clone8 account. To connect a different account, remove this one first in the app (Account → Text Clone8)."); return; }
    if (ch.name === "imessage") shareProfile(u.chat);
    if (!(await withBot(sb, link, u.chat, (bot) => bot.handle({ chat: u.chat, from: u.from, text: u.text, private: u.private, tap: !!u.callback_id, has_file: u.has_file })))) return "busy";
  }

  // ---- the inbox: written by the webhook, worked on in order, one chat at a time ----
  const chains = new Map<string, Promise<void>>();
  /** updates this process is working on: never taken twice, however long one takes */
  const inflight = new Set<string>();
  let draining = false;
  async function drain() {
    if (draining || !anyEnabled(env) || isStopping() || isSuperseded()) return; draining = true;
    try {
      const sb = sbFn();
      const stale = Date.now() - 5 * 60_000;
      const r = await sb.from("studio_text_inbox").select("channel,update_id,payload,claimed_at,attempts").in("channel", live()).is("done_at", null)
        .or(`claimed_at.is.null,claimed_at.lt.${new Date(stale).toISOString()}`).order("received_at", { ascending: true }).order("update_id", { ascending: true }).limit(50);
      if (r.error) throw r.error;
      for (const row of (r.data ?? []) as any[]) {
        const ch = chOf(row.channel); if (!ch) continue;
        const id = `${ch.name}:${row.update_id}`;
        if (inflight.has(id)) continue;
        if (row.claimed_at && Date.parse(row.claimed_at) > stale) continue;
        const attempts = Number(row.attempts) || 0;
        const c = await sb.from("studio_text_inbox").update({ claimed_at: new Date().toISOString(), claimed_by: me, attempts: attempts + 1 }).eq("channel", ch.name).eq("update_id", row.update_id).is("done_at", null)
          [row.claimed_at ? "eq" : "is"]("claimed_at", row.claimed_at ?? null).select("update_id");
        if (!(c.data ?? []).length) continue; // another server took it (during a deploy two run for a minute)
        const u = ch.parse(row.payload);
        // (a connect code is not kept once used)
        const finish = (extra: Record<string, unknown> = {}) => sb.from("studio_text_inbox").update({ done_at: new Date().toISOString(), ...extra, ...(u && ch.startCode(u.text) ? { payload: { update_id: row.update_id, redacted: "start" } } : {}) }).eq("channel", ch.name).eq("update_id", row.update_id).then(() => undefined, () => undefined);
        // a message that already failed three times (it crashed the server, say) is put aside, not tried forever
        if (attempts >= 3) { log(`[text] update ${row.update_id} given up after ${attempts} tries`); await finish({ claimed_by: `gave_up:${me}` }); continue; }
        inflight.add(id);
        const chat = `${ch.name}:${u?.chat ?? "none"}`;
        const next: Promise<void> = (chains.get(chat) ?? Promise.resolve()).then(async () => {
          let busy = false;
          try { if (u) busy = (await handleUpdate(sb, u, ch.name)) === "busy"; }
          catch (e: any) { log(`[text] update ${row.update_id} failed: ${String(e?.message ?? e).slice(0, 200)}`); }
          finally {
            // another server is still on this chat (a deploy): the message goes back in the queue, untouched
            // (it is looked at again in about ten seconds, not on every pass)
            if (busy) await sb.from("studio_text_inbox").update({ claimed_at: new Date(Date.now() - 5 * 60_000 + 10_000).toISOString(), claimed_by: null, attempts }).eq("channel", ch.name).eq("update_id", row.update_id).then(() => undefined, () => undefined);
            else await finish();
            inflight.delete(id);
            if (chains.get(chat) === next) chains.delete(chat);
          }
        });
        chains.set(chat, next);
      }
    } catch (e: any) { log(`[text] inbox: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { draining = false; }
  }

  // ---- the watcher: jobs and edits started by text, their results sent when ready ----
  let watching = false, swept = 0;
  async function watchAll() {
    if (watching || !anyEnabled(env) || isStopping() || isSuperseded()) return; watching = true;
    try {
      const sb = sbFn();
      const r = await sb.from("studio_text_chats").select("channel,chat_id,user_id").in("channel", live()).eq("watching", true).order("updated_at", { ascending: true }).limit(200);
      for (const row of (r.data ?? []) as any[]) {
        if (isStopping() || isSuperseded()) break;
        const l = await sb.from("studio_text_links").select("*").eq("channel", row.channel).eq("chat_id", row.chat_id).eq("user_id", row.user_id).eq("status", "linked").maybeSingle();
        if (l.error) continue; // a failed read changes nothing: looked at again next time
        const can = l.data ? await access(sb, row.user_id, row.channel) : "no";
        if (can === "unknown") continue;
        // a chat no longer connected (removed, relinked, account gone, not open to it) is not watched again
        if (can === "no") { await sb.from("studio_text_chats").update({ watching: false }).eq("channel", row.channel).eq("chat_id", row.chat_id).eq("user_id", row.user_id); continue; }
        const key = `${row.channel}:${row.chat_id}`;
        const next: Promise<void> = (chains.get(key) ?? Promise.resolve()).then(() => withBot(sb, l.data as Link, row.chat_id, (bot) => bot.watch()).then(() => undefined))
          .catch((e) => log(`[text] watch ${row.channel} ${String(e?.message ?? e).slice(0, 160)}`))
          .finally(() => { if (chains.get(key) === next) chains.delete(key); });
        chains.set(key, next);
        await next;
      }
      // housekeeping, about once an hour: answered messages after 7 days, used or expired codes after a day
      if (Date.now() - swept > 3600_000) {
        swept = Date.now();
        await sb.from("studio_text_inbox").delete().in("channel", ["telegram", "imessage"]).lt("done_at", new Date(Date.now() - 7 * 86400_000).toISOString());
        await sb.from("studio_text_codes").delete().lt("expires_at", new Date(Date.now() - 86400_000).toISOString());
        // what the privacy policy (section 2C) promises: the message log is kept 12 months; a disconnected or unfinished
        // connection (with its phone number or Telegram id) is deleted after 30 days
        await sb.from("studio_text_events").delete().lt("at", new Date(Date.now() - 365 * 86400_000).toISOString());
        await sb.from("studio_text_links").delete().in("status", ["removed", "pending"]).lt("created_at", new Date(Date.now() - 30 * 86400_000).toISOString());
      }
    } catch (e: any) { log(`[text] watcher: ${String(e?.message ?? e).slice(0, 200)}`); }
    finally { watching = false; }
  }

  if (anyEnabled(env) && !deps.out && !deps.imessageOut) {
    const a = setInterval(() => { void drain(); }, 1500); (a as any).unref?.();
    const b = setInterval(() => { void watchAll(); }, 20_000); (b as any).unref?.();
    if (imessageEnabled(env)) {
      log(`[text] imessage on (${imessageOpen(env) ? "open to everyone" : "owner only"})`);
      // the line's iMessage Name & Photo: Clone8 and its logo (written only if it differs)
      setTimeout(() => { void sbl?.ensureProfile("Clone8", LOGO).then((r) => log(`[text] imessage name & photo ${r}`), (e: any) => log(`[text] imessage name & photo not set: ${String(e?.message ?? e).slice(0, 120)}`)); }, 8000);
    }
  }
  if (textEnabled(env) && !deps.out) {
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

  // iMessage: Sendblue posts every message on the line here ("receive"); our own messages echoed back are ignored
  app.post(IMESSAGE_WEBHOOK_PATH, async (req, res) => {
    if (!imessageEnabled(env)) return res.status(404).json({ error: "not_found" });
    if (!verifySendblue(req.headers as any, env.SENDBLUE_WEBHOOK_SECRET)) { log(`[text] imessage webhook refused (headers: ${Object.keys(req.headers).join(",").slice(0, 300)})`); return res.status(401).json({ error: "unauthorized" }); }
    const b = req.body ?? {};
    if (b.is_outbound === true || typeof b.message_handle !== "string" || !parseSendblue(b, env.SENDBLUE_FROM_NUMBER)) {
      // (a person whose Mac sends from an email address, or a plain SMS, can't be answered: noted for the review)
      if (b.is_outbound !== true && b.message_handle && !b.group_id) logFor(null, null, "imessage")("imessage_ignored", { service: String(b.service ?? "").slice(0, 20), from: /@/.test(String(b.from_number ?? "")) ? "email" : /^\+\d/.test(String(b.from_number ?? "")) ? "number" : "other", reaction: !!b.message_type && b.message_type !== "message" });
      return res.json({ ok: true });
    }
    try {
      const w = await sbFn().from("studio_text_inbox").upsert({ channel: "imessage", update_id: handleId(b.message_handle), payload: b, received_at: new Date().toISOString() }, { onConflict: "channel,update_id", ignoreDuplicates: true });
      if (w.error) throw w.error;
      res.json({ ok: true });
      void drain();
    } catch (e: any) { log(`[text] imessage webhook write failed: ${String(e?.message ?? e).slice(0, 160)}`); res.status(500).json({ error: "retry" }); } // Sendblue retries a 5xx
  });

  /** Who may connect a channel: everyone once it is open; before that, the owner's account only. */
  const mayLink = async (req: Request, ch: Channel = channels.telegram) => ch.enabled() && (ch.open() || (await isStudioAdmin(req, sbFn(), env)));

  app.get("/api/studio/text/links", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const tgOk = await mayLink(req, channels.telegram), imOk = await mayLink(req, channels.imessage);
      if (!tgOk && !imOk) return res.json({ open: false, links: [] });
      const r = await sbFn().from("studio_text_links").select("id,channel,handle,status,created_at,confirmed_at,last_used_at").eq("user_id", u).in("status", ["pending", "linked"]).order("created_at", { ascending: false }).limit(10);
      if (r.error) throw r.error;
      const fresh = (l: any) => l.status === "linked" || Date.now() - Date.parse(l.created_at) < CONFIRM_TTL_MS;
      res.json({ open: true, bot: botName, links: ((r.data ?? []) as any[]).filter(fresh).filter((l) => (l.channel === "imessage" ? imOk : tgOk) || l.status === "linked"),
        channels: { telegram: tgOk ? { bot: botName } : null, imessage: imOk ? { number: env.SENDBLUE_FROM_NUMBER } : null } });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/studio/text/link", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const ch = chOf(req.body?.channel ?? "telegram");
      if (!ch || !(await mayLink(req, ch))) return res.status(403).json({ error: "text_not_open", detail: "Texting Clone8 opens soon" });
      if (ch.name === "telegram") {
        if (!botName && tg) botName = (await tg.me()).username;
        if (!botName || !/^[A-Za-z0-9_]{5,32}$/.test(botName)) return res.status(503).json({ error: "starting", detail: "Texting is starting up. Try again in a moment." });
      }
      const sb = sbFn();
      // a few codes a day per person: each opens the bot for ten minutes and works once
      const since = new Date(Date.now() - 86400_000).toISOString();
      const n = await sb.from("studio_text_codes").select("code_hash", { count: "exact", head: true }).eq("user_id", u).gte("created_at", since);
      if ((n.count ?? 0) >= 20) return res.status(429).json({ error: "too_many", detail: "That is a lot of connection links for one day; try again tomorrow" });
      const code = randomBytes(18).toString("base64url");
      const w = await sb.from("studio_text_codes").insert({ code_hash: hash(code), user_id: u, channel: ch.name, timezone: validTz(req.body?.timezone), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
      if (w.error) throw w.error;
      if (ch.name === "imessage") {
        // Messages opens addressed to the line with the code typed in; a phone's camera reads the same from the QR code
        const number = String(env.SENDBLUE_FROM_NUMBER), body = `LINK ${code}`;
        return res.json({ channel: "imessage", number, text: body, url: `sms:${number}&body=${encodeURIComponent(body)}`, qr: `SMSTO:${number}:${body}`, expires_in: CODE_TTL_MS / 1000 });
      }
      res.json({ channel: "telegram", url: `https://t.me/${botName}?start=${code}`, expires_in: CODE_TTL_MS / 1000, bot: botName });
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
      const ch = chOf(l.channel) ?? channels.telegram;
      // the four digits the bot sent to that chat: proof that the person confirming is the person in the chat
      const typed = String(req.body?.code ?? "").replace(/\D/g, "");
      const want = Buffer.from(String((l as any).confirm_hash ?? "")), got = Buffer.from(hash(`${l.sender_id}:${typed}`));
      if (typed.length !== 4 || want.length !== got.length || !timingSafeEqual(want, got)) {
        const tries = Number((l as any).confirm_tries ?? 0) + 1;
        await sb.from("studio_text_links").update({ confirm_tries: tries, ...(tries >= 5 ? { status: "removed" } : {}) }).eq("id", l.id).eq("status", "pending");
        return res.status(400).json({ error: "wrong_code", detail: tries >= 5 ? "Too many wrong codes. Start again from Text Clone8." : `That code doesn't match. Use the 4 digits Clone8 sent you in ${ch.label}.` });
      }
      const taken = await sb.from("studio_text_links").select("id,user_id").eq("channel", ch.name).eq("sender_id", l.sender_id).eq("status", "linked").maybeSingle();
      if (taken.data && (taken.data as any).user_id !== u) return res.status(409).json({ error: "taken", detail: `That ${ch.label} account is connected to a different Clone8 account` });
      if (taken.data) await sb.from("studio_text_links").update({ status: "removed" }).eq("id", (taken.data as any).id);
      const w = await sb.from("studio_text_links").update({ status: "linked", confirmed_at: new Date().toISOString() }).eq("id", l.id).eq("status", "pending").select("id");
      if (w.error) throw w.error;
      if (!(w.data ?? []).length) return res.status(409).json({ error: "changed", detail: "That request changed; refresh" });
      // a fresh start for this chat: nothing from an earlier account carries over
      await sb.from("studio_text_chats").delete().eq("channel", ch.name).eq("chat_id", l.chat_id).neq("user_id", u);
      logFor(u, l.chat_id, ch.name)("linked", { sender: ch.name === "imessage" ? mask(l.sender_id) : l.sender_id });
      const who = await (sb as any).auth?.admin?.getUserById?.(u).catch?.(() => null);
      const email = String(who?.data?.user?.email ?? "");
      const masked = email.includes("@") ? `${email[0]}***${email.slice(email.indexOf("@") - 1)}` : "your account";
      if (ch.out) await ch.out.text(l.chat_id, `Connected to your Clone8 account (${masked}).\n\n${HELP}`).catch(() => undefined);
      if (ch.onLinked) await ch.onLinked(l.chat_id).catch((e: any) => log(`[text] contact card not sent: ${String(e?.message ?? e).slice(0, 120)}`));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/studio/text/links/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const sb = sbFn();
      const before = await sb.from("studio_text_links").select("chat_id,status,channel").eq("id", req.params.id).eq("user_id", u).in("status", ["pending", "linked"]).maybeSingle();
      if (before.error) throw before.error;
      const row: any = before.data;
      if (row) {
        const r = await sb.from("studio_text_links").update({ status: "removed" }).eq("id", req.params.id).eq("user_id", u).eq("status", row.status).select("id");
        if (r.error) throw r.error;
        const ch = chOf(row.channel) ?? channels.telegram;
        logFor(u, row.chat_id, ch.name)(row.status === "linked" ? "unlinked" : "link_refused", {});
        if (row.status === "linked") {
          // the conversation kept for the assistant goes with the connection (the message log stays, as the policy says)
          await sb.from("studio_text_chats").delete().eq("channel", ch.name).eq("chat_id", row.chat_id).eq("user_id", u);
          if (ch.out) await ch.out.text(row.chat_id, `This chat is no longer connected to Clone8. To connect again: ${CONNECT}`).catch(() => undefined);
        }
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- the admin panel's Text Clone8 tab: everyone who connected, and one person's chat (admins only) ----
  const pages = async <T,>(q: (from: number) => PromiseLike<{ data: any; error: any }>, max = 50_000): Promise<T[]> => {
    const out: T[] = [];
    for (let from = 0; from < max; from += 1000) { const r = await q(from); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; }
    return out;
  };
  app.get("/api/studio/admin/text", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days ?? 30)) || 30)), since = new Date(Date.now() - days * 86400_000).toISOString();
      const links = await pages<TextLinkRow>((f) => sb.from("studio_text_links").select("id,user_id,channel,handle,status,created_at,confirmed_at,last_used_at").order("created_at").range(f, f + 999));
      const events = await pages<TextEventRow>((f) => sb.from("studio_text_events").select("user_id,chat_id,event,at,data").in("event", ["in", "claude", "pending", "executed", "declined", "error", "claude_error", "send_failed", "watch_error", "execute_unconfirmed"]).gte("at", since).order("at").range(f, f + 999));
      const ids = [...new Set([...links.map((l) => l.user_id), ...events.map((e) => e.user_id).filter((x): x is string => !!x)])].slice(0, 2000);
      const emails: Record<string, string | null> = {}, plans: Record<string, string | null> = {};
      for (let i = 0; i < ids.length; i += 20) await Promise.all(ids.slice(i, i + 20).map(async (u) => { try { const r: any = await (sb as any).auth.admin.getUserById(u); emails[u] = r?.data?.user?.email ?? null; } catch { emails[u] = null; } }));
      for (let i = 0; i < ids.length; i += 200) { const c = await sb.from("studio_customers").select("user_id,plan_id,status").in("user_id", ids.slice(i, i + 200)); for (const r of (c.data ?? []) as any[]) plans[r.user_id] = r.plan_id && ["active", "trialing", "past_due"].includes(r.status) ? r.plan_id : null; }
      res.json({ ...textAdminView({ links, events, days, since, emails, plans }), open: textOpen(env), bot: botName, imessage: imessageEnabled(env) ? { open: imessageOpen(env), number: env.SENDBLUE_FROM_NUMBER } : null });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/studio/admin/text/chat", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const u = String(req.query.user ?? ""); if (!UUID.test(u)) return res.status(400).json({ error: "user" });
      const r = await sb.from("studio_text_events").select("user_id,chat_id,channel,event,at,data").eq("user_id", u).in("event", ["in", "out", "executed", "declined", "linked", "unlinked", "error", "claude_error", "send_failed", "watch_error", "execute_unconfirmed"]).order("at", { ascending: false }).limit(300);
      if (r.error) throw r.error;
      res.json({ lines: chatLines(((r.data ?? []) as TextEventRow[]).reverse()) });
    } catch (e) { fail(res, e); }
  });

  return { drain, watchAll, handleUpdate, flush };
}
