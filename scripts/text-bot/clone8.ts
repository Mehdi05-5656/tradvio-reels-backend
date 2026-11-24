// The test bot's only way to Clone8: the Studio's own public routes, as the signed-in owner, like the Claude connector
// (src/studio-mcp.ts). Three lists decide what may be called at all:
//   READ   routes that change nothing (some POSTs are reads: a quote, the faces in a clip, stunt ideas);
//   LIGHT  two small writes the app also does without a confirm (bring a link in; turn a result into a library file);
//   ACT    everything that posts, spends, changes or cancels. Only the executor may call these, and only with a
//          pending action the person confirmed (actions.ts). The brain has no way to reach them.
// Anything else, including every admin, billing, delete and account route, is refused here before it leaves the Mac.
import { join } from "node:path";
import { readJson, writeJson, type Config } from "./config.js";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type Reply = { status: number; json: any };
const ID = "[0-9a-f-]{36}";
const S = "/api/studio";
const rx = (p: string) => new RegExp(`^${S}${p}$`, "i");

export const READ: Array<[Method, RegExp]> = [
  ["GET", rx("/me")], ["GET", rx("/plans")], ["GET", rx("/busy")],
  ["GET", rx("/jobs")], ["GET", rx(`/jobs/${ID}`)],
  ["GET", rx("/assets")], ["GET", rx(`/assets/${ID}/url`)], ["GET", rx("/collections")], ["GET", rx(`/collections/${ID}`)], ["GET", rx("/characters")],
  ["GET", rx("/social")], ["GET", rx("/social/posts")], ["GET", rx("/social/plan")], ["GET", rx("/social/best-times")], ["GET", rx("/social/groups")],
  ["GET", rx("/post-drafts")], ["GET", rx("/post-projects")], ["GET", rx(`/post-projects/${ID}`)],
  ["GET", rx("/performance")], ["GET", rx("/performance/caption-tests")],
  ["GET", rx("/live/lookup")], ["GET", rx("/live/search")], ["GET", rx("/live/streams")],
  ["GET", rx("/instruments")], ["GET", rx("/styles")], ["GET", rx("/trends")], ["GET", rx("/voices")], ["GET", rx("/kage-motion/presets")],
  ["GET", rx("/stunts/config")], ["GET", rx("/reshoot/config")], ["GET", rx("/splitscreen/config")], ["GET", rx("/blueprints/config")],
  ["GET", rx("/autoreply")], ["GET", rx("/automations")], ["GET", rx(`/automations/${ID}`)],
  // reads that happen to be POSTs
  ["POST", rx("/quote")], ["POST", rx(`/assets/${ID}/people`)], ["POST", rx("/stunts/ideas")], ["POST", rx("/reshoot/plan")],
  ["POST", rx("/splitscreen/frame")], ["POST", rx("/blueprints/read")], ["POST", rx("/social/caption")], ["POST", rx("/social/captions/quote")],
  ["POST", rx("/social/media-check")], ["POST", rx(`/automations/${ID}/quote`)],
];
export const LIGHT: Array<[Method, RegExp]> = [["POST", rx("/links")], ["POST", rx(`/jobs/${ID}/asset`)]];
export const ACT: Array<[Method, RegExp]> = [
  ["POST", rx("/jobs")], ["POST", rx(`/jobs/${ID}/cancel`)],
  ["POST", rx("/social/posts")], ["PATCH", rx(`/social/posts/${ID}`)], ["DELETE", rx(`/social/posts/${ID}`)], ["POST", rx(`/social/posts/${ID}/retry`)],
  ["POST", rx("/social/captions/batch")], ["POST", rx(`/automations/${ID}/run`)],
];
export type Level = "read" | "light" | "act";
const pathOnly = (p: string) => p.split("?")[0].replace(/\/+$/, "");
/** Which list a call is on; null when it is on none (and is refused). */
export function levelOf(method: Method, path: string): Level | null {
  const p = pathOnly(path);
  if (READ.some(([m, r]) => m === method && r.test(p))) return "read";
  if (LIGHT.some(([m, r]) => m === method && r.test(p))) return "light";
  if (ACT.some(([m, r]) => m === method && r.test(p))) return "act";
  return null;
}

export class Clone8Error extends Error { constructor(public code: string, message = code) { super(message); } }

export type Session = { access_token: string; refresh_token: string; expires_at: number };
export type Api = {
  /** READ and LIGHT routes: what the brain's tools may use. */
  call(method: Method, path: string, body?: unknown, o?: { timeoutMs?: number }): Promise<Reply>;
  /** ACT routes: the executor only. `claim` is the id of the confirmed pending action, recorded with the call. */
  act(claim: string, method: Method, path: string, body?: unknown, o?: { timeoutMs?: number }): Promise<Reply>;
  /** A file behind a signed link, as bytes (results and pictures sent into the chat). */
  bytes(url: string, maxBytes: number): Promise<Buffer | null>;
};

export function makeApi(cfg: Config, deps: { fetch?: typeof fetch; now?: () => number; onCall?: (e: Record<string, unknown>) => void } = {}): Api {
  const f = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  const file = join(cfg.home, "session.json");
  let refreshing: Promise<string> | null = null;
  const token = async (): Promise<string> => {
    const s = readJson<Session | null>(file, null);
    if (!s?.refresh_token) throw new Clone8Error("not_signed_in", "The test bot is not signed in to Clone8. Run: node ops/text-bot/login.mjs");
    if (s.access_token && s.expires_at - now() > 90_000) return s.access_token;
    // Supabase hands out a new refresh token each time; the new one is saved before anything else can use the old one
    refreshing ??= (async () => {
      const r = await f(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: cfg.supabaseAnon, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: s.refresh_token }), signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j?.access_token) throw new Clone8Error("sign_in_expired", "The Clone8 sign-in for the test bot ended. Run: node ops/text-bot/login.mjs");
      writeJson(file, { access_token: j.access_token, refresh_token: j.refresh_token ?? s.refresh_token, expires_at: now() + Number(j.expires_in ?? 3600) * 1000 } satisfies Session);
      return j.access_token as string;
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const send = async (method: Method, path: string, body: unknown, o: { timeoutMs?: number } | undefined, via: string): Promise<Reply> => {
    const r = await f(`${cfg.apiBase}${path}`, { method, headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", "x-clone8-via": "text-test" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(o?.timeoutMs ?? 60_000) });
    const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { error: "bad_response" }; }
    deps.onCall?.({ via, method, path: pathOnly(path), status: r.status, error: r.status >= 400 ? json?.error ?? null : null });
    return { status: r.status, json };
  };
  return {
    async call(method, path, body, o) {
      const level = levelOf(method, path);
      if (level !== "read" && level !== "light") throw new Clone8Error("route_not_allowed", `${method} ${pathOnly(path)} is not something the test bot may call directly`);
      return send(method, path, body, o, level);
    },
    async act(claim, method, path, body, o) {
      if (!claim) throw new Clone8Error("no_confirmation", "An action needs a confirmed pending action");
      if (levelOf(method, path) !== "act") throw new Clone8Error("route_not_allowed", `${method} ${pathOnly(path)} is not an action the test bot may take`);
      return send(method, path, body, o, `act:${claim}`);
    },
    async bytes(url, maxBytes) {
      try {
        const r = await f(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) return null;
        const len = Number(r.headers.get("content-length") ?? 0);
        if (len && len > maxBytes) return null;
        const b = Buffer.from(await r.arrayBuffer());
        return b.length > maxBytes ? null : b;
      } catch { return null; }
    },
  };
}
