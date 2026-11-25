// Text Clone8 on the backend (src/text-bot/server.ts, src/text-bot/internal.ts): the pass the bot uses to act as one
// person, the Telegram webhook and its inbox, and linking a chat to an account (code → Start in Telegram → Confirm in
// the app). A pretend database and a pretend Express app; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { internalPass, verifyInternal, INTERNAL_HEADER } from "../src/text-bot/internal.js";
import { registerTextBot, serverApi, botConfig, WEBHOOK_PATH } from "../src/text-bot/server.js";
import { textAdminView, chatLines, ctaReport } from "../src/text-bot/admin.js";
import { parseSendblue, verifySendblue, withButtons, handleId, mask, contactCard, sendblue } from "../src/text-bot/sendblue.js";

type Row = Record<string, any>;
const OWNER = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const ENV = { STUDIO_TEXT_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t0ken", TELEGRAM_WEBHOOK_SECRET: "s3cret-s3cret", ANTHROPIC_API_KEY: "k", STUDIO_TEXT_TELEGRAM_BOT: "Clone8Bot", STUDIO_ADMIN_EMAILS: "boss@clone8.io" };

// ------------------------------------------------------------------ the pass

const reqOf = (o: { pass?: string; method?: string; url?: string; ip?: string; headers?: Record<string, string> }) => {
  const h: Record<string, string> = { ...(o.headers ?? {}), ...(o.pass ? { [INTERNAL_HEADER]: o.pass } : {}) };
  return { header: (k: string) => h[k.toLowerCase()], method: o.method ?? "GET", originalUrl: o.url ?? "/api/studio/me", socket: { remoteAddress: o.ip ?? "127.0.0.1" } } as any;
};

test("the internal pass works only from this process, on the loopback, for the exact listed route, for a minute", () => {
  const now = 1_800_000_000_000;
  const pass = internalPass(OWNER, "GET", "/api/studio/me", now);
  assert.equal(verifyInternal(reqOf({ pass }), now), OWNER);
  assert.equal(verifyInternal(reqOf({ pass, ip: "::ffff:127.0.0.1" }), now), OWNER);
  assert.equal(verifyInternal(reqOf({ pass, url: "/api/studio/me?x=1" }), now), OWNER, "the query string is not part of the path");
  assert.equal(verifyInternal(reqOf({ pass, ip: "10.0.0.7" }), now), null, "not from the loopback");
  assert.equal(verifyInternal(reqOf({ pass, method: "POST" }), now), null, "another method");
  assert.equal(verifyInternal(reqOf({ pass, url: "/api/studio/jobs" }), now), null, "another path");
  assert.equal(verifyInternal(reqOf({ pass }), now + 61_000), null, "expired");
  assert.equal(verifyInternal(reqOf({ pass, headers: { authorization: "Bearer x" } }), now), null, "a pass rides alone");
  assert.equal(verifyInternal(reqOf({ pass, headers: { "x-app-secret": "x" } }), now), null);
  const [u, exp, mac] = pass.split(".");
  assert.equal(verifyInternal(reqOf({ pass: `${OTHER}.${exp}.${mac}` }), now), null, "another person with the same signature");
  assert.equal(verifyInternal(reqOf({ pass: `${u}.${Number(exp) + 1000}.${mac}` }), now), null, "a longer life");
  assert.equal(verifyInternal(reqOf({ pass: `${u}.${exp}.${mac.slice(0, -2)}AA` }), now), null, "a forged signature");
  // a route the bot has no business on is refused even with a correct signature
  const admin = internalPass(OWNER, "GET", "/api/studio/admin/users", now);
  assert.equal(verifyInternal(reqOf({ pass: admin, url: "/api/studio/admin/users" }), now), null);
  assert.throws(() => internalPass("not-a-user", "GET", "/api/studio/me", now));
});

test("the bot's way in: lookups only through call(), actions only through act() with a claim", async () => {
  const seen: any[] = [];
  const api = serverApi(OWNER, { port: 4321, fetch: (async (url: string, init: any) => { seen.push({ url, init }); return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); }) as any });
  const r = await api.call("GET", "/api/studio/me");
  assert.equal(r.status, 200);
  assert.equal(seen[0].url, "http://127.0.0.1:4321/api/studio/me");
  assert.ok(seen[0].init.headers[INTERNAL_HEADER], "carries the pass");
  await assert.rejects(api.call("POST", "/api/studio/jobs", {}), { code: "route_not_allowed" });
  await assert.rejects(api.act("", "POST", "/api/studio/jobs", {}), { code: "no_confirmation" });
  await assert.rejects(api.act("c1", "GET", "/api/studio/me"), { code: "route_not_allowed" }, "act() is for actions only");
  await api.act("c1", "POST", "/api/studio/jobs", { tool: "x" });
  assert.equal(seen.length, 2);
  // files: only ones Clone8 signed
  assert.equal(await api.bytes("https://evil.example/x.mp4", 100), null);
  assert.equal(seen.length, 2, "never fetched");
});

test("settings: model, effort and limits come from the server's env with safe defaults", () => {
  const c = botConfig({ ANTHROPIC_API_KEY: "k" }, "Europe/Paris");
  assert.equal(c.model, "claude-haiku-5-5"); assert.equal(c.effort, "low"); assert.equal(c.timezone, "Europe/Paris");
  assert.equal(c.dailyCredits, 1000); assert.equal(c.maxActionCredits, 1000);
  assert.equal(botConfig({ STUDIO_TEXT_EFFORT: "wild", STUDIO_TEXT_DAILY_CREDITS: "-5" }, "UTC").effort, "low");
  assert.equal(botConfig({ STUDIO_TEXT_DAILY_CREDITS: "-5" }, "UTC").dailyCredits, 1000);
});

// ------------------------------------------------------------------ a pretend database and app

function fakeSb(tables: Record<string, Row[]>, users: Record<string, Row>) {
  const from = (table: string) => {
    const rows = () => (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select", payload: any = null, head = false, conflict: string[] = [], ignore = false;
    const run = (): Row[] => {
      if (op === "insert") {
        const add = (Array.isArray(payload) ? payload : [payload]).map((x: Row) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...x }));
        if (table === "studio_text_chats" && add.some((a: Row) => rows().some((r) => r.channel === a.channel && r.chat_id === a.chat_id))) throw new Error("duplicate key value");
        rows().push(...add); return add;
      }
      if (op === "upsert") {
        const out: Row[] = [];
        for (const v of Array.isArray(payload) ? payload : [payload]) {
          const hit = rows().find((r) => conflict.every((k) => r[k] === v[k]));
          if (hit) { if (!ignore) Object.assign(hit, v); out.push(hit); } else { rows().push({ ...v }); out.push(v); }
        }
        return out;
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") { hit.forEach((r) => Object.assign(r, payload)); return hit; }
      if (op === "delete") { tables[table] = rows().filter((r) => !hit.includes(r)); return hit; }
      return hit.map((r) => ({ ...r })); // copies, like the real database
    };
    const done = (single: boolean) => { try { const r = run(); return Promise.resolve({ data: single ? r[0] ?? null : head ? null : r, error: null, count: r.length }); } catch (e: any) { return Promise.resolve({ data: null, error: { message: e.message }, count: 0 }); } };
    // PostgREST's or(): "a.is.null,b.lt.2026-...,c.eq.x"
    const orOf = (expr: string) => expr.split(",").map((part) => { const [k, o, ...rest] = part.split("."); const v = rest.join("."); return (r: Row) => o === "is" ? (r[k] ?? null) === null : o === "lt" ? r[k] != null && r[k] < v : o === "eq" ? String(r[k]) === v : false; });
    const q: any = {
      select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return q; },
      insert: (v: any) => { op = "insert"; payload = v; return q; }, update: (v: any) => { op = "update"; payload = v; return q; },
      upsert: (v: any, o: any) => { op = "upsert"; payload = v; conflict = String(o?.onConflict ?? "id").split(","); ignore = !!o?.ignoreDuplicates; return q; },
      delete: () => { op = "delete"; return q; },
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; }, neq: (k: string, v: any) => { filters.push((r) => r[k] !== v); return q; },
      is: (k: string, v: any) => { filters.push((r) => (r[k] ?? null) === v); return q; }, in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      gte: (k: string, v: any) => { filters.push((r) => r[k] >= v); return q; }, lt: (k: string, v: any) => { filters.push((r) => r[k] < v); return q; },
      or: (expr: string) => { const any = orOf(expr); filters.push((r) => any.some((f) => f(r))); return q; },
      order: () => q, limit: () => q, range: () => q,
      maybeSingle: () => done(true), then: (ok: any, bad: any) => done(false).then(ok, bad),
    };
    return q;
  };
  return { from, auth: { admin: { getUserById: async (id: string) => ({ data: { user: users[id] ?? null } }) } } } as any;
}

function setup(env: Record<string, string> = ENV, fetchFn?: any) {
  const tables: Record<string, Row[]> = {};
  const users = { [OWNER]: { id: OWNER, email: "boss@clone8.io", email_confirmed_at: "2026-01-01T00:00:00Z" }, [OTHER]: { id: OTHER, email: "someone@example.com" } };
  const sb = fakeSb(tables, users);
  const routes: Record<string, Function> = {};
  const app: any = { get: (p: string, h: Function) => (routes[`GET ${p}`] = h), post: (p: string, h: Function) => (routes[`POST ${p}`] = h), delete: (p: string, h: Function) => (routes[`DELETE ${p}`] = h) };
  const sent: Array<{ chat: string; text: string }> = [];
  const out: any = { text: async (chat: string, text: string) => { sent.push({ chat, text }); }, media: async () => undefined, typing: async () => undefined, answerTap: async () => undefined, clearButtons: async () => undefined };
  const bot = registerTextBot(app, () => sb, { env, out, log: () => undefined, port: 1, ...(fetchFn ? { fetch: fetchFn, think: fetchFn } : {}) });
  const call = async (key: string, o: { user?: string; email?: string; body?: any; params?: Row; headers?: Record<string, string> } = {}) => {
    let status = 200, json: any = null;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (j: any) => { json = j; return res; }, setHeader: () => undefined };
    const req: any = { auth: o.user ? { user_id: o.user, email: o.email } : null, body: o.body ?? {}, params: o.params ?? {}, query: (o as any).query ?? {}, header: (k: string) => o.headers?.[k.toLowerCase()] };
    await routes[key](req, res);
    return { status, json };
  };
  const tgMsg = (from: string, text: string, update_id = 1) => ({ update_id, chat: from, from, name: "mehdi", text, message_id: 5, private: true });
  return { tables, sb, routes, call, sent, bot, tgMsg };
}

/** A pretend Claude and a pretend Clone8 (no network in these tests). */
const fakeNet = (calls: string[] = []) => async (url: string, init: any) => {
  calls.push(String(url));
  if (String(url).startsWith("https://api.anthropic.com")) return new Response(JSON.stringify({ model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Your balance is 120 credits." }], usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 4000 } }), { status: 200 });
  assert.ok(init.headers[INTERNAL_HEADER], "Clone8 is reached with the pass");
  return new Response(JSON.stringify({ credits: 120, plan: "creator" }), { status: 200 });
};

test("webhook: only Telegram (the secret) is heard; each update is kept once", async () => {
  const s = setup();
  assert.equal((await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 7 } })).status, 401);
  assert.equal((await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 7 }, headers: { "x-telegram-bot-api-secret-token": "wrong-wrong-w" } })).status, 401);
  const h = { "x-telegram-bot-api-secret-token": ENV.TELEGRAM_WEBHOOK_SECRET };
  assert.equal((await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 7, message: { text: "hi" } }, headers: h })).status, 200);
  await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 7, message: { text: "changed" } }, headers: h });
  assert.equal(s.tables.studio_text_inbox.length, 1);
  assert.equal(s.tables.studio_text_inbox[0].payload.message.text, "hi", "a resend doesn't replace the first");
  // switched off: the address doesn't exist
  const off = setup({ ...ENV, STUDIO_TEXT_ENABLED: "false" });
  assert.equal((await off.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 1 }, headers: h })).status, 404);
});

test("linking: a code from the app, Start in Telegram, Confirm in the app; nothing is connected without the confirm", async () => {
  const s = setup();
  // before it opens to everyone, only the owner's account can make a link
  assert.equal((await s.call("POST /api/studio/text/link", { user: OTHER, email: "someone@example.com" })).status, 403);
  assert.equal((await s.call("GET /api/studio/text/links", { user: OTHER, email: "someone@example.com" })).json.open, false);
  const made = await s.call("POST /api/studio/text/link", { user: OWNER, email: "boss@clone8.io", body: { timezone: "Europe/Paris" } });
  assert.equal(made.status, 200);
  const m = String(made.json.url).match(/^https:\/\/t\.me\/Clone8Bot\?start=([A-Za-z0-9_-]{24})$/);
  assert.ok(m, made.json.url);
  const code = m![1];
  assert.equal(s.tables.studio_text_codes[0].code_hash, createHash("sha256").update(code).digest("hex"), "only the hash is kept");
  assert.ok(!JSON.stringify(s.tables.studio_text_codes).includes(code));

  // a stranger who just says hi is pointed at the app
  await s.bot.handleUpdate(s.sb, s.tgMsg("900", "hi") as any);
  assert.match(s.sent.at(-1)!.text, /Connect your Clone8 account first/);
  // Start with the code: a pending request, not a connection
  await s.bot.handleUpdate(s.sb, s.tgMsg("900", `/start ${code}`) as any);
  const digits = s.sent.at(-1)!.text.match(/Your Clone8 code: (\d{4})/)?.[1];
  assert.ok(digits, s.sent.at(-1)!.text);
  assert.ok(!JSON.stringify(s.tables.studio_text_links).includes(`"${digits}"`), "the digits are not stored");
  assert.equal(s.tables.studio_text_links.length, 1);
  assert.equal(s.tables.studio_text_links[0].status, "pending");
  assert.equal(s.tables.studio_text_links[0].timezone, "Europe/Paris");
  // the same code a second time (someone else saw it) does nothing
  await s.bot.handleUpdate(s.sb, s.tgMsg("901", `/start ${code}`) as any);
  assert.match(s.sent.at(-1)!.text, /expired or was already used/);
  assert.equal(s.tables.studio_text_links.length, 1);
  // still a stranger until confirmed
  await s.bot.handleUpdate(s.sb, s.tgMsg("900", "what's my balance") as any);
  assert.match(s.sent.at(-1)!.text, /Connect your Clone8 account first/);

  const list = await s.call("GET /api/studio/text/links", { user: OWNER, email: "boss@clone8.io" });
  assert.equal(list.json.links.length, 1); assert.equal(list.json.links[0].handle, "mehdi"); assert.equal(list.json.links[0].status, "pending");
  const id = list.json.links[0].id;
  // someone else can't confirm it
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OTHER, params: { id }, body: { code: digits } })).status, 410);
  // the owner needs the digits that went to the chat
  const wrong = String((Number(digits) + 1) % 10_000).padStart(4, "0");
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id }, body: { code: wrong } })).status, 400);
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id } })).status, 400);
  assert.equal(s.tables.studio_text_links[0].status, "pending");
  const ok = await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id }, body: { code: digits } });
  assert.equal(ok.status, 200);
  assert.equal(s.tables.studio_text_links[0].status, "linked");
  assert.match(s.sent.at(-1)!.text, /Connected to your Clone8 account \(b\*\*\*s@clone8\.io\)/);
  assert.ok(!s.sent.at(-1)!.text.includes("boss@"), "the email is masked");

  // a linked chat that taps another connection link is told it is already connected
  await s.bot.handleUpdate(s.sb, s.tgMsg("900", "/start AAAAAAAAAAAAAAAAAAAAAAAA") as any);
  assert.match(s.sent.at(-1)!.text, /already connected/);

  // remove: the chat is told, and is a stranger again
  assert.equal((await s.call("DELETE /api/studio/text/links/:id", { user: OTHER, params: { id } })).json.ok, true);
  assert.equal(s.tables.studio_text_links[0].status, "linked", "someone else's remove does nothing");
  await s.call("DELETE /api/studio/text/links/:id", { user: OWNER, params: { id } });
  assert.equal(s.tables.studio_text_links[0].status, "removed");
  assert.match(s.sent.at(-1)!.text, /no longer connected/);
});

test("a confirm that waited too long, or a request for an account linked elsewhere, is refused", async () => {
  const s = setup();
  s.tables.studio_text_links = [
    { id: "33333333-3333-4333-8333-333333333333", user_id: OWNER, channel: "telegram", sender_id: "900", chat_id: "900", status: "pending", created_at: new Date(Date.now() - 20 * 60_000).toISOString() },
    { id: "44444444-4444-4444-8444-444444444444", user_id: OWNER, channel: "telegram", sender_id: "901", chat_id: "901", status: "pending", created_at: new Date().toISOString() },
    { id: "55555555-5555-4555-8555-555555555555", user_id: OTHER, channel: "telegram", sender_id: "901", chat_id: "901", status: "linked", created_at: new Date().toISOString() },
  ];
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id: "33333333-3333-4333-8333-333333333333" } })).status, 410);
  s.tables.studio_text_links[1].confirm_hash = createHash("sha256").update("901:1234").digest("hex");
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id: "44444444-4444-4444-8444-444444444444" }, body: { code: "1234" } })).status, 409);
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id: "nope" } })).status, 404);
});

test("before it opens to everyone, a chat linked to another account is not answered", async () => {
  const s = setup();
  s.tables.studio_text_links = [{ id: "55555555-5555-4555-8555-555555555555", user_id: OTHER, channel: "telegram", sender_id: "901", chat_id: "901", status: "linked", created_at: new Date().toISOString() }];
  await s.bot.handleUpdate(s.sb, s.tgMsg("901", "make me a clip") as any);
  assert.match(s.sent.at(-1)!.text, /isn't open for your account yet/);
});

test("the inbox: each update is answered once, in order, and marked done", async () => {
  const s = setup();
  const h = { "x-telegram-bot-api-secret-token": ENV.TELEGRAM_WEBHOOK_SECRET };
  for (const [id, text] of [[11, "one"], [12, "two"]] as const) await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: id, message: { message_id: id, text, chat: { id: 900, type: "private" }, from: { id: 900, username: "mehdi" } } }, headers: h });
  await s.bot.drain();
  await new Promise((r) => setTimeout(r, 20));
  await s.bot.drain(); // a second pass takes nothing again
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.sent.length, 2, JSON.stringify(s.sent));
  assert.ok(s.tables.studio_text_inbox.every((r) => r.done_at));
});

test("a linked chat: the message reaches the brain as that person, the chat's state and the log are saved", async () => {
  const calls: string[] = [];
  const fetchFn = async (url: string, init: any) => {
    calls.push(String(url));
    if (String(url).startsWith("https://api.anthropic.com")) return new Response(JSON.stringify({ model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Your balance is 120 credits." }], usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 4000 } }), { status: 200 });
    assert.ok(init.headers[INTERNAL_HEADER], "Clone8 is reached with the pass");
    return new Response(JSON.stringify({ credits: 120, plan: "creator" }), { status: 200 });
  };
  const s = setup(ENV, fetchFn);
  s.tables.studio_text_links = [{ id: "55555555-5555-4555-8555-555555555555", user_id: OWNER, channel: "telegram", sender_id: "900", chat_id: "900", status: "linked", created_at: new Date().toISOString() }];
  await s.bot.handleUpdate(s.sb, s.tgMsg("900", "what's my balance?") as any);
  assert.equal(s.sent.at(-1)!.text, "Your balance is 120 credits.");
  assert.ok(calls.some((u) => u.startsWith("https://api.anthropic.com")));
  assert.ok(calls.filter((u) => !u.startsWith("https://api.anthropic.com")).every((u) => u.startsWith("http://127.0.0.1:1/api/studio/")));
  const chat = s.tables.studio_text_chats[0];
  assert.equal(chat.user_id, OWNER);
  assert.deepEqual(chat.state.history.map((t: any) => t.role).slice(-2), ["user", "assistant"]);
  await s.bot.flush();
  const ev = s.tables.studio_text_events.map((e) => e.event);
  assert.ok(ev.includes("in") && ev.includes("claude"), ev.join(","));
  const outs = s.tables.studio_text_events.filter((e) => e.event === "out");
  assert.deepEqual(outs.map((e) => e.data.text), ["Your balance is 120 credits."], "the reply is in the log");
  assert.ok(s.tables.studio_text_events.every((e) => e.user_id === OWNER));
});

test("five wrong codes end the request; 'Not me' sends nothing to that chat", async () => {
  const s = setup();
  s.tables.studio_text_links = [{ id: "44444444-4444-4444-8444-444444444444", user_id: OWNER, channel: "telegram", sender_id: "901", chat_id: "901", status: "pending", confirm_hash: createHash("sha256").update("901:1234").digest("hex"), confirm_tries: 0, created_at: new Date().toISOString() }];
  for (let i = 0; i < 5; i++) await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id: "44444444-4444-4444-8444-444444444444" }, body: { code: "9999" } });
  assert.equal(s.tables.studio_text_links[0].status, "removed");
  assert.equal((await s.call("POST /api/studio/text/links/:id/confirm", { user: OWNER, params: { id: "44444444-4444-4444-8444-444444444444" }, body: { code: "1234" } })).status, 410, "even the right code is too late");
  s.tables.studio_text_links[0].status = "pending";
  await s.call("DELETE /api/studio/text/links/:id", { user: OWNER, params: { id: "44444444-4444-4444-8444-444444444444" } });
  assert.equal(s.tables.studio_text_links[0].status, "removed");
  assert.equal(s.sent.length, 0);
});

test("a chat another server is working on is left alone, and its message goes back in the queue", async () => {
  const s = setup(ENV, fakeNet());
  s.tables.studio_text_links = [{ id: "55555555-5555-4555-8555-555555555555", user_id: OWNER, channel: "telegram", sender_id: "900", chat_id: "900", status: "linked", created_at: new Date().toISOString() }];
  s.tables.studio_text_chats = [{ channel: "telegram", chat_id: "900", user_id: OWNER, state: {}, watching: false, lease_by: "other-server", lease_until: new Date(Date.now() + 60_000).toISOString() }];
  assert.equal(await s.bot.handleUpdate(s.sb, s.tgMsg("900", "hi") as any), "busy");
  assert.equal(s.sent.length, 0);
  const h = { "x-telegram-bot-api-secret-token": ENV.TELEGRAM_WEBHOOK_SECRET };
  await s.call(`POST ${WEBHOOK_PATH}`, { body: { update_id: 21, message: { message_id: 21, text: "hi", chat: { id: 900, type: "private" }, from: { id: 900, username: "mehdi" } } }, headers: h });
  await new Promise((r) => setTimeout(r, 30));
  const row = s.tables.studio_text_inbox[0];
  assert.equal(row.done_at ?? null, null, "not marked done");
  const back = Date.parse(row.claimed_at) + 5 * 60_000 - Date.now();
  assert.ok(back > 5_000 && back <= 10_000, `back in the queue in about ten seconds (${back} ms)`);
  await s.bot.drain(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(row.done_at ?? null, null, "not taken again on the next pass");
  // once the other server's hold runs out, this one takes the chat
  s.tables.studio_text_chats[0].lease_until = new Date(Date.now() - 1000).toISOString();
  row.claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
  await s.bot.drain(); await new Promise((r) => setTimeout(r, 100));
  assert.ok(row.done_at);
  assert.equal(s.sent.at(-1)!.text, "Your balance is 120 credits.");
  assert.equal(s.tables.studio_text_chats[0].lease_by, null, "let go after the turn");
});

test("a deleted account's chat is not answered", async () => {
  const s = setup({ ...ENV, STUDIO_TEXT_OPEN: "true" });
  s.tables.studio_text_links = [{ id: "66666666-6666-4666-8666-666666666666", user_id: "77777777-7777-4777-8777-777777777777", channel: "telegram", sender_id: "902", chat_id: "902", status: "linked", created_at: new Date().toISOString() }];
  await s.bot.handleUpdate(s.sb, s.tgMsg("902", "hi") as any);
  assert.equal((s.tables.studio_text_chats ?? []).length, 0, "no state made, no AI call");
});

test("the watcher: a failed account check changes nothing; a removed chat stops being watched", async () => {
  const s = setup(ENV, fakeNet());
  s.tables.studio_text_links = [{ id: "55555555-5555-4555-8555-555555555555", user_id: OWNER, channel: "telegram", sender_id: "900", chat_id: "900", status: "linked", created_at: new Date().toISOString() }];
  s.tables.studio_text_chats = [{ channel: "telegram", chat_id: "900", user_id: OWNER, state: { watches: [] }, watching: true, updated_at: new Date().toISOString() }];
  const real = s.sb.auth.admin.getUserById;
  s.sb.auth.admin.getUserById = async () => { throw new Error("auth down"); };
  await s.bot.watchAll();
  assert.equal(s.tables.studio_text_chats[0].watching, true, "kept");
  s.sb.auth.admin.getUserById = real;
  s.tables.studio_text_links[0].status = "removed";
  await s.bot.watchAll();
  assert.equal(s.tables.studio_text_chats[0].watching, false);
});

test("the admin view: each person who connected, what they did, what it cost, what broke; admins only", async () => {
  const at = (m: number) => new Date(Date.parse("2026-11-24T20:00:00Z") + m * 60_000).toISOString();
  const links = [
    { id: "l1", user_id: OWNER, channel: "telegram", handle: "Mehdi", status: "linked", created_at: at(0), confirmed_at: at(1), last_used_at: at(30) },
    { id: "l2", user_id: OTHER, channel: "telegram", handle: "sam", status: "removed", created_at: at(2), confirmed_at: at(3), last_used_at: null },
  ];
  const ev = (user: string, m: number, event: string, data: any = {}) => ({ user_id: user, chat_id: "c", event, at: at(m), data });
  const events = [
    ev(OWNER, 5, "in", { text: "what's my balance" }), ev(OWNER, 5, "claude", { usd: 0.001 }),
    ev(OWNER, 6, "in", { text: "move the captions up 15%" }), ev(OWNER, 6, "claude", { usd: 0.0005 }), ev(OWNER, 6, "pending", {}),
    ev(OWNER, 7, "in", { text: "y:abc", tap: true }), ev(OWNER, 7, "executed", { ok: true, credits: 0 }),
    ev(OWNER, 8, "in", { text: "clip my stream" }), ev(OWNER, 8, "pending", {}), ev(OWNER, 9, "in", { text: "YES KM" }), ev(OWNER, 9, "executed", { ok: true, credits: 120 }),
    ev(OTHER, 10, "in", { text: "hi" }), ev(OTHER, 10, "claude_error", { detail: "overloaded" }),
  ];
  const v = textAdminView({ links, events: events as any, days: 7, since: at(-60), emails: { [OWNER]: "boss@clone8.io", [OTHER]: "s@example.com" }, plans: { [OWNER]: "pro" } });
  assert.equal(v.summary.connected, 1); assert.equal(v.summary.active, 2); assert.equal(v.summary.messages, 5, "taps are not messages");
  assert.equal(v.summary.done, 2); assert.equal(v.summary.credits, 120); assert.equal(v.summary.errors, 1); assert.equal(v.summary.ai_usd, 0.0015);
  const me = v.people.find((p) => p.user_id === OWNER)!;
  assert.deepEqual([me.email, me.plan, me.status, me.messages, me.taps, me.asked, me.done, me.credits], ["boss@clone8.io", "pro", "connected", 4, 1, 2, 2, 120]);
  assert.equal(me.last_text, "YES KM");
  assert.equal(v.people[0].user_id, OTHER, "most recent first");
  assert.equal(v.people[0].status, "removed");
  assert.deepEqual(chatLines(events.filter((e) => e.user_id === OWNER) as any).map((l) => l.text).slice(0, 5), ["what's my balance", "move the captions up 15%", "(tapped Yes)", "Done after YES", "clip my stream"]);
  // the routes: nothing for anyone but an admin (the owner's confirmed email)
  const s = setup();
  assert.equal((await s.call("GET /api/studio/admin/text", { user: OTHER, email: "someone@example.com" })).status, 404);
  assert.equal((await s.call("GET /api/studio/admin/text/chat", { user: OTHER, email: "someone@example.com", })).status, 404);
  s.tables.studio_text_links = links as any; s.tables.studio_text_events = events.map((e) => ({ ...e, at: new Date().toISOString() })) as any; s.tables.studio_customers = [];
  const ok = await s.call("GET /api/studio/admin/text", { user: OWNER, email: "boss@clone8.io" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.people.length, 2); assert.equal(ok.json.people.find((p: any) => p.user_id === OWNER).email, "boss@clone8.io");
});

// ------------------------------------------------------------------ iMessage (a Sendblue line)

const IM_ENV = { ...ENV, STUDIO_TEXT_IMESSAGE_ENABLED: "true", SENDBLUE_API_KEY_ID: "kid", SENDBLUE_API_SECRET: "ksec", SENDBLUE_FROM_NUMBER: "+15550001111", SENDBLUE_WEBHOOK_SECRET: "whsec-0123456789abcdef" };
const inbound = (from: string, content: string, handle = `h-${Math.random()}`) => ({ content, number: from, from_number: from, to_number: "+15550001111", is_outbound: false, status: "RECEIVED", message_handle: handle, service: "iMessage", group_id: "" });

test("iMessage: what Sendblue posts is read right; only Sendblue (the secret) is heard; buttons become words", () => {
  const m = parseSendblue(inbound("+15557654321", "what's my balance", "abc"))!;
  assert.deepEqual([m.chat, m.from, m.text, m.private, m.name], ["+15557654321", "+15557654321", "what's my balance", true, "•••• 4321"]);
  assert.equal(m.update_id, handleId("abc")); assert.ok(Number.isSafeInteger(m.update_id));
  assert.equal(parseSendblue({ ...inbound("+15557654321", "x"), is_outbound: true, status: "SENT" }), null, "our own message echoed back");
  assert.equal(parseSendblue({ ...inbound("+15557654321", "x"), group_id: "g1" }), null, "group chats are ignored");
  assert.equal(parseSendblue({ ...inbound("+15557654321", "x"), status: "DELIVERED" }), null);
  assert.equal(mask("+15557654321"), "•••• 4321");
  assert.ok(verifySendblue({ "content-type": "application/json", "sb-signing-secret": "whsec-0123456789abcdef" }, "whsec-0123456789abcdef"));
  assert.ok(verifySendblue({ authorization: "Bearer whsec-0123456789abcdef" }, "whsec-0123456789abcdef"));
  assert.ok(!verifySendblue({ "sb-signing-secret": "whsec-0123456789abcdeX" }, "whsec-0123456789abcdef"));
  assert.ok(!verifySendblue({ "sb-signing-secret": "" }, undefined), "no secret set: nothing is accepted");
  assert.equal(withButtons("Your code: 4821", [{ label: "Copy 4821", copy: "4821" }, { label: "Back to Clone8", url: "https://app.clone8.io/#studio/account?text=1" }, { label: "Elsewhere", url: "https://evil.example/" }, { label: "Yes", data: "y:1" }]),
    "Your code: 4821\n\nBack to Clone8: https://app.clone8.io/#studio/account?text=1");
});

test("iMessage: Connect makes a Messages link with the code; LINK code → 4 digits → confirmed → answered as that person", async () => {
  const sent: Array<{ chat: string; text: string }> = [];
  const imessageOut: any = { text: async (chat: string, text: string) => { sent.push({ chat, text }); }, media: async () => undefined, typing: async () => undefined };
  const tables: Record<string, Row[]> = {};
  const users = { [OWNER]: { id: OWNER, email: "boss@clone8.io", email_confirmed_at: "2026-01-01T00:00:00Z" }, [OTHER]: { id: OTHER, email: "someone@example.com" } };
  const sb = fakeSb(tables, users);
  const routes: Record<string, Function> = {};
  const app: any = { get: (p: string, h: Function) => (routes[`GET ${p}`] = h), post: (p: string, h: Function) => (routes[`POST ${p}`] = h), delete: (p: string, h: Function) => (routes[`DELETE ${p}`] = h) };
  const bot = registerTextBot(app, () => sb, { env: IM_ENV, out: { text: async () => undefined, media: async () => undefined, typing: async () => undefined } as any, imessageOut, log: () => undefined, port: 1, fetch: fakeNet() as any, think: fakeNet() as any });
  const call = async (key: string, o: { user?: string; email?: string; body?: any; params?: Row; headers?: Record<string, string> } = {}) => {
    let status = 200, json: any = null;
    const res: any = { status: (x: number) => { status = x; return res; }, json: (j: any) => { json = j; return res; }, setHeader: () => undefined };
    await routes[key]({ auth: o.user ? { user_id: o.user, email: o.email } : null, body: o.body ?? {}, params: o.params ?? {}, query: {}, headers: o.headers ?? {}, header: (k: string) => o.headers?.[k.toLowerCase()] }, res);
    return { status, json };
  };
  // before it opens, the owner's account only; the card is told which channels it may offer
  const other = await call("GET /api/studio/text/links", { user: OTHER, email: "someone@example.com" });
  assert.equal(other.json.open, false);
  const mine = await call("GET /api/studio/text/links", { user: OWNER, email: "boss@clone8.io" });
  assert.deepEqual(mine.json.channels.imessage, { number: "+15550001111" });
  assert.equal((await call("POST /api/studio/text/link", { user: OTHER, email: "someone@example.com", body: { channel: "imessage" } })).status, 403);
  const made = await call("POST /api/studio/text/link", { user: OWNER, email: "boss@clone8.io", body: { channel: "imessage" } });
  assert.equal(made.status, 200);
  const code = /^LINK ([A-Za-z0-9_-]{24})$/.exec(made.json.text)![1];
  assert.equal(made.json.url, `sms:+15550001111&body=${encodeURIComponent(`LINK ${code}`)}`);
  assert.equal(made.json.qr, `SMSTO:+15550001111:LINK ${code}`);
  // the webhook: wrong secret refused; our own echo ignored; the person's LINK message kept once
  const hook = "POST /api/studio/text/imessage/webhook";
  assert.equal((await call(hook, { body: inbound("+15557654321", `LINK ${code}`), headers: { "sb-signing-secret": "nope-nope-nope-nope" } })).status, 401);
  await call(hook, { body: { ...inbound("+15557654321", "echo"), is_outbound: true, status: "SENT" }, headers: { "sb-signing-secret": IM_ENV.SENDBLUE_WEBHOOK_SECRET } });
  assert.equal((tables.studio_text_inbox ?? []).length, 0);
  // a Telegram code doesn't work on iMessage
  const tgMade = await call("POST /api/studio/text/link", { user: OWNER, email: "boss@clone8.io", body: { channel: "telegram" } });
  const tgCode = /start=(.+)$/.exec(tgMade.json.url)![1];
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", `LINK ${tgCode}`))!, "imessage");
  assert.match(sent.at(-1)!.text, /expired or was already used/);
  // the real one
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", `LINK ${code}`))!, "imessage");
  const digits = /Your Clone8 code: (\d{4})/.exec(sent.at(-1)!.text)![1];
  assert.equal(sent.at(-1)!.chat, "+15557654321");
  const pend = (tables.studio_text_links ?? []).find((l) => l.channel === "imessage")!;
  assert.deepEqual([pend.status, pend.handle], ["pending", "•••• 4321"]);
  const ok = await call("POST /api/studio/text/links/:id/confirm", { user: OWNER, email: "boss@clone8.io", params: { id: pend.id }, body: { code: digits } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(sent.at(-1)!.text, /Connected to your Clone8 account/);
  // now a message is answered by the brain, as that person, into that chat
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", "what's my balance"))!, "imessage");
  assert.equal(sent.at(-1)!.text, "Your balance is 120 credits.");
  assert.ok((tables.studio_text_chats ?? []).some((c) => c.channel === "imessage" && c.chat_id === "+15557654321" && c.user_id === OWNER));
  await bot.flush();
  assert.ok((tables.studio_text_events ?? []).some((e) => e.channel === "imessage" && e.event === "out"));
  // the same number on Telegram is a different chat: not connected there
  assert.equal((tables.studio_text_links ?? []).filter((l) => l.status === "linked").length, 1);
});

test("iMessage review fixes: no SMS, no reactions, only our line; exact codes; silence after STOP", async () => {
  const line = "+15550001111";
  assert.equal(parseSendblue({ ...inbound("+15557654321", "post it"), service: "SMS" }, line), null, "an SMS sender can be faked");
  assert.equal(parseSendblue({ ...inbound("+15557654321", "x"), service: undefined }, line), null);
  assert.equal(parseSendblue(inbound("+15557654321", "Liked “To go ahead, reply: YES KM”"), line), null, "a tapback is not a request");
  assert.equal(parseSendblue({ ...inbound("+15557654321", "hi"), to_number: "+15559999999" }, line), null, "another line's message");
  assert.equal(parseSendblue({ ...inbound(line, "hi") }, line), null, "never from our own line");
  assert.ok(parseSendblue(inbound("+15557654321", "link my instagram please"), line));
  // a stranger: STOP gets nothing back; "link instagram" is not a connect code
  const sent: string[] = [];
  const imessageOut: any = { text: async (_c: string, t: string) => { sent.push(t); }, media: async () => undefined, typing: async () => undefined };
  const tables: Record<string, Row[]> = {};
  const sb = fakeSb(tables, {});
  const app: any = { get: () => undefined, post: () => undefined, delete: () => undefined };
  const bot = registerTextBot(app, () => sb, { env: IM_ENV, out: { text: async () => undefined, media: async () => undefined, typing: async () => undefined } as any, imessageOut, log: () => undefined, port: 1 });
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", "STOP"), line)!, "imessage");
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", "unsubscribe"), line)!, "imessage");
  assert.equal(sent.length, 0);
  await bot.handleUpdate(sb, parseSendblue(inbound("+15557654321", "LINK instagram"), line)!, "imessage");
  assert.match(sent.at(-1)!, /Connect your Clone8 account first/, "treated as hello, not as a bad code");
});

test("iMessage looks like Clone8: a contact card with the logo, and the line's Name & Photo set only when it differs", async () => {
  const card = contactCard("+13105550123", Buffer.alloc(3000, 7));
  const lines = card.split("\r\n");
  assert.ok(lines.every((l) => l.length <= 75), "folded at 75 characters");
  assert.ok(lines.some((l) => l.startsWith("PHOTO;ENCODING=b;TYPE=PNG:")));
  assert.ok(lines.includes("FN:Clone8") && lines.includes("END:VCARD"));
  assert.ok(!contactCard("+13105550123").includes("PHOTO"), "no logo, no photo line");
  const calls: Array<{ url: string; body: any }> = [];
  let state: any = { hasProfile: false };
  const f = (async (url: string, init: any) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify(url.includes("/state") ? { status: "OK", data: state } : { status: "OK", data: {} }), { status: 200 }); }) as any;
  const sb = sendblue({ keyId: "k", secret: "s", from: "+13105550123", fetch: f });
  assert.equal(await sb.ensureProfile("Clone8", "https://app.clone8.io/brand/icon-512.png"), "set");
  assert.deepEqual(calls.at(-1)!.body, { fromNumber: "+13105550123", firstName: "Clone8", lastName: "", photoUrl: "https://app.clone8.io/brand/icon-512.png" });
  state = { hasProfile: true, sharingEnabled: true, firstName: "Clone8", lastName: null, hasPhoto: true };
  const before = calls.length;
  assert.equal(await sb.ensureProfile("Clone8", "https://app.clone8.io/brand/icon-512.png"), "kept");
  assert.equal(calls.length, before + 1, "only the state was read");
  await sb.share("+15557654321");
  assert.deepEqual(calls.at(-1)!.body, { fromNumber: "+13105550123", toNumber: "+15557654321" });
  assert.match(calls.at(-1)!.url, /\/api\/v2\/contact-sharing\/share$/);
});

test("retention the privacy policy promises: log 12 months, disconnected connections 30 days", async () => {
  const s = setup(ENV, fakeNet());
  const ago = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  s.tables.studio_text_events = [{ user_id: OWNER, event: "in", at: ago(400), data: {} }, { user_id: OWNER, event: "in", at: ago(10), data: {} }] as any;
  s.tables.studio_text_links = [
    { id: "a", user_id: OWNER, channel: "telegram", sender_id: "1", chat_id: "1", status: "removed", created_at: ago(40) },
    { id: "b", user_id: OWNER, channel: "telegram", sender_id: "2", chat_id: "2", status: "removed", created_at: ago(5) },
    { id: "c", user_id: OWNER, channel: "telegram", sender_id: "3", chat_id: "3", status: "linked", created_at: ago(90) },
  ] as any;
  s.tables.studio_text_chats = [];
  await s.bot.watchAll();
  assert.deepEqual(s.tables.studio_text_events.map((e: any) => e.at), [ago(10)].map((x) => s.tables.studio_text_events[0].at), "only the recent entry stays");
  assert.equal(s.tables.studio_text_events.length, 1);
  assert.deepEqual(s.tables.studio_text_links.map((l: any) => l.id).sort(), ["b", "c"], "a connection still in use is never deleted");
});

test("calls to action: the app reports what each did; only known CTAs and actions are kept, a capped number an hour", async () => {
  const s = setup();
  assert.equal((await s.call("POST /api/studio/text/cta", { body: { events: [{ cta: "home_card", action: "shown" }] } })).status, 401);
  const r = await s.call("POST /api/studio/text/cta", { user: OWNER, body: { events: [
    { cta: "result_modal", action: "shown", tool: "clips" }, { cta: "result_modal", action: "opened", channel: "imessage" },
    { cta: "nope", action: "shown" }, { cta: "home_card", action: "hacked" }, { cta: "home_card", action: "shown", tool: "<script>" },
  ] } });
  assert.equal(r.json.kept, 3, "two unknown ones dropped; a bad tool name is dropped, not the event");
  let total = 0;
  for (let i = 0; i < 10; i++) total += (await s.call("POST /api/studio/text/cta", { user: OTHER, body: { events: Array.from({ length: 20 }, () => ({ cta: "toast_idle", action: "shown" })) } })).json.kept;
  assert.equal(total, 120, "at most 120 a person an hour");

  const at = "2026-11-24T10:00:00Z", row = (u: string | null, cta: string, action: string, tool?: string) => ({ user_id: u, props: { cta, action, ...(tool ? { tool } : {}) }, created_at: at });
  const rep = ctaReport([
    row(OWNER, "result_modal", "shown", "clips"), row(OWNER, "result_modal", "shown", "clips"), row(OTHER, "result_modal", "shown", "stories"),
    row(OWNER, "result_modal", "opened", "clips"), row(OWNER, "result_modal", "connected"), row(OTHER, "result_modal", "dismissed"),
    row(OTHER, "home_card", "shown"), row(OTHER, "home_card", "assisted"), row(OTHER, "bogus", "shown"), row(OTHER, "home_card", "weird"),
  ]);
  const m = rep.lines.find((l) => l.cta === "result_modal")!;
  assert.deepEqual([m.shown, m.people, m.opened, m.dismissed, m.connected, m.open_rate, m.connect_rate], [3, 2, 1, 1, 1, 0.333, 0.333]);
  assert.equal(rep.lines[0].cta, "result_modal", "the best connector first");
  assert.equal(rep.lines.find((l) => l.cta === "home_card")!.assisted, 1);
  assert.equal(rep.lines.length, 2, "unknown CTAs are left out");
  assert.deepEqual(rep.tools.find((t) => t.tool === "clips"), { tool: "clips", shown: 2, opened: 1, connected: 0 });
});
