// How the text bot, running inside this server, acts as one person on the Studio's own routes (docs/text-bot/PLAN.md
// section 1, "Acting as the person", as tightened by the independent review). It calls this same server over the
// loopback address with a pass in the x-clone8-internal header. The pass is accepted only when ALL of these hold:
//   - it was signed with a key made at random when this process started; the key exists only in this process's memory
//     (not in an env variable, not on disk), so nothing outside the process can make one;
//   - the request came in on the loopback address itself (the socket, never a forwarded-for header): requests from
//     the internet arrive through Render's proxy, never from 127.0.0.1 or ::1;
//   - it is at most 60 seconds old and names exactly this method and this path;
//   - the route is on the bot's lists (routes.ts READ, LIGHT, ACT). Admin, billing, delete and account routes are not.
// The person it names gets an ordinary customer identity: no email and a plain "user" profile, so none of the admin
// checks can pass for it. Whether an ACT route may be called at all is decided by the bot (a confirmed YES); this only
// proves that the call came from the bot, for that person, for that one request.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { levelOf, pathOnly, type Method } from "./routes.js";

const KEY = randomBytes(32);
const TTL_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sign = (s: string) => createHmac("sha256", KEY).update(s).digest("base64url");

export const INTERNAL_HEADER = "x-clone8-internal";

/** A pass for one request, as one person. */
export function internalPass(userId: string, method: Method, path: string, now = Date.now()): string {
  if (!UUID.test(userId)) throw new Error("internal pass needs a user id");
  const body = `${userId}.${now + TTL_MS}.${method}.${pathOnly(path)}`;
  return `${userId}.${now + TTL_MS}.${sign(body)}`;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** The person a request is from, when it carries a valid pass; otherwise null (and the request is treated as having none). */
export function verifyInternal(req: Pick<Request, "header" | "method" | "originalUrl" | "socket">, now = Date.now()): string | null {
  const raw = req.header(INTERNAL_HEADER);
  if (!raw) return null;
  if (!LOOPBACK.has(String(req.socket?.remoteAddress ?? ""))) return null;
  // a pass rides alone: with a sign-in token or the admin secret beside it, it is refused
  if (req.header("authorization") || req.header("x-app-secret")) return null;
  const [userId, exp, mac, extra] = raw.split(".");
  if (extra !== undefined || !userId || !exp || !mac || !UUID.test(userId)) return null;
  const until = Number(exp);
  if (!Number.isFinite(until) || until < now || until > now + TTL_MS + 5_000) return null;
  const method = String(req.method).toUpperCase() as Method;
  // the full path as it arrived (the middleware is mounted at /api, so req.path would lack it)
  const path = pathOnly(String(req.originalUrl ?? ""));
  if (!levelOf(method, path)) return null;
  const want = Buffer.from(sign(`${userId}.${until}.${method}.${path}`)), got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? userId : null;
}
