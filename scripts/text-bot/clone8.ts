// The Mac test's way to Clone8: the Studio's public routes over the internet, as the owner signed in by login.mjs.
import { join } from "node:path";
import { readJson, writeJson, type Config } from "./config.js";
import { levelOf, pathOnly, Clone8Error, type Api, type Method, type Reply, type Session } from "../../src/text-bot/routes.js";
export { levelOf, Clone8Error, READ, LIGHT, ACT } from "../../src/text-bot/routes.js";
export type { Api, Method, Reply, Session } from "../../src/text-bot/routes.js";


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
