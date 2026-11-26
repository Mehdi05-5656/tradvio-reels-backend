// Telegram files over the Bot API's 20 MB download limit (owner, Nov 26 2026: "5-10 videos of face content, no
// issues"). The same bot, signed in over Telegram's own protocol (MTProto, through GramJS), may download files up to
// 2 GB; we take up to the chat cap (intake.ts CHAT_MAX). It needs the app id and hash from my.telegram.org
// (TELEGRAM_API_ID, TELEGRAM_API_HASH); without them only the 20 MB path exists and a bigger file gets the upload page.
//
// The bot's normal messages keep coming through the Bot API webhook. So that this second sign-in never competes for
// them (Telegram sends updates to sessions that ask for them), the session here never asks:
//   - no GramJS start(): the sign-in is ours, inside invokeWithoutUpdates; so is the opening request (help.getConfig)
//     and the message lookup; file downloads never subscribe;
//   - one short connection per file, destroyed afterwards (GramJS's background loop asks for updates after 30 minutes
//     of quiet; it never lives that long). The sign-in itself is kept in memory, so later files don't sign in again.
// Everything for one file has one deadline; past it the connection is destroyed (which stops a download still
// running) and the person gets the upload page. One file at a time.
import type { TelegramClient } from "telegram";

export type BigDownload = (messageId: number, max: number) => Promise<Buffer | "too_big" | null>;
export type BigClient = Pick<TelegramClient, "invoke" | "downloadMedia" | "destroy"> & { connect(): Promise<boolean>; session: { save(): any } };
/** the Telegram requests used, built by GramJS (tests give plain objects) */
export type BigTl = { quiet(q: unknown): unknown; signIn(apiId: number, apiHash: string, token: string): unknown; getMessage(id: number): unknown };

/** The size Telegram reports for a message's video, file or largest photo (0 when it can't be read). */
export function mediaSize(media: any): number {
  const doc = media?.document;
  if (doc?.size != null) return Number(String(doc.size));
  const sizes: any[] = media?.photo?.sizes ?? [];
  return sizes.reduce((m, s) => Math.max(m, Number(s?.size ?? 0), ...(Array.isArray(s?.sizes) ? s.sizes.map(Number) : [0])), 0);
}

export const BIG_DEADLINE_MS = 6 * 60_000;

export function telegramBig(o: { apiId: number; apiHash: string; botToken: string; log?: (l: string) => void;
  /** test seams: the client (given the saved sign-in), the requests, the deadline */
  client?: (session: string) => Promise<BigClient>; tl?: BigTl; deadlineMs?: number }): BigDownload {
  let session = "", tl: BigTl | null = o.tl ?? null, chain: Promise<unknown> = Promise.resolve();
  const say = (what: string, e: any) => o.log?.(`[text] telegram large file: ${what}: ${String(e?.message ?? e).replace(o.botToken, "<token>").slice(0, 160)}`);
  const make = async (saved: string): Promise<BigClient> => {
    if (o.client) return o.client(saved);
    const g = await import("telegram"), s = await import("telegram/sessions/index.js"), l = await import("telegram/extensions/Logger.js");
    tl ??= {
      quiet: (q) => new g.Api.InvokeWithoutUpdates({ query: q as any }),
      signIn: (apiId, apiHash, token) => new g.Api.auth.ImportBotAuthorization({ flags: 0, apiId, apiHash, botAuthToken: token }),
      getMessage: (id) => new g.Api.messages.GetMessages({ id: [new g.Api.InputMessageID({ id })] }),
    };
    const c = new g.TelegramClient(new s.StringSession(saved), o.apiId, o.apiHash, { connectionRetries: 2, autoReconnect: false, baseLogger: new l.Logger(l.LogLevel.NONE) });
    // the opening request GramJS sends on connect (help.getConfig) goes out without asking for updates too
    const init: any = (c as any)._initRequest, q = tl.quiet;
    if (init) { let v: unknown; Object.defineProperty(init, "query", { configurable: true, enumerable: true, get: () => v, set: (x) => { v = x == null ? x : q(x); } }); }
    return c as unknown as BigClient;
  };
  const once = async (messageId: number, max: number): Promise<Buffer | "too_big" | null> => {
    let c: BigClient | null = null, timer: ReturnType<typeof setTimeout> | null = null, late = false;
    const work = (async () => {
      c = await make(session);
      if (!(await c.connect())) throw new Error("could not connect");
      if (!session) { await c.invoke(tl!.quiet(tl!.signIn(o.apiId, o.apiHash, o.botToken)) as any); session = String(c.session.save() ?? ""); }
      const r: any = await c.invoke(tl!.quiet(tl!.getMessage(messageId)) as any);
      const msg = (r?.messages ?? []).find((m: any) => m?.id === messageId);
      if (!msg?.media) return null;
      if (mediaSize(msg.media) > max) return "too_big" as const;
      if (late) return null;
      const got = await c.downloadMedia(msg, {});
      if (!got || typeof got === "string") return null;
      const buf = Buffer.isBuffer(got) ? got : Buffer.from(got as any);
      return buf.length > max ? ("too_big" as const) : buf.length ? buf : null;
    })();
    try {
      return await Promise.race([work, new Promise<null>((res) => { timer = setTimeout(() => { late = true; say("gave up", "deadline"); res(null); }, o.deadlineMs ?? BIG_DEADLINE_MS); })]);
    } catch (e: any) {
      // a sign-in that no longer works is made again next time
      if (/AUTH_KEY|SESSION_REVOKED|UNAUTHORIZED/i.test(String(e?.message ?? e))) session = "";
      say("failed", e); return null;
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => undefined);
      // destroyed whatever happened: stops a download still running and GramJS's background loop
      const cc = c as BigClient | null;
      if (cc) await Promise.race([cc.destroy().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
    }
  };
  return (messageId, max) => {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return Promise.resolve(null);
    const run = chain.then(() => once(messageId, max));
    chain = run.catch(() => undefined);
    return run;
  };
}
