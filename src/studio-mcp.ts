// The Clone8 connector: an MCP server people add to Claude (and later ChatGPT) so they can make Clone8 videos from
// their chat. docs/mcp/PLAN.md, step 2: the owner's account only, and we run the AI (normal credit prices).
//
// One rule makes it safe: the connector never decides anything itself. Every tool calls the Studio's own routes on this
// same server, with the person's own sign-in, so prices, credit checks, rate limits, closed tools and refusals are
// exactly the website's. Sign-in is Supabase's OAuth 2.1 server, which issues the same tokens `auth.ts` already checks.
//
// Switches: STUDIO_MCP_ENABLED (the endpoint exists; otherwise 404), STUDIO_MCP_OPEN (customers may use it; otherwise
// the owner's account only). Stateless: a new server per request, nothing held between calls.
import type { Express, Request, Response } from "express";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isStudioAdmin } from "./studio-admin-auth.js";

type Env = Record<string, string | undefined>;
export const mcpEnabled = (env: Env = process.env) => env.STUDIO_MCP_ENABLED === "true";
export const mcpOpen = (env: Env = process.env) => mcpEnabled(env) && env.STUDIO_MCP_OPEN === "true";
/** Emails let in before the connector opens, for testing it with fresh accounts (STUDIO_MCP_TESTERS, comma-separated).
 *  Read from the verified sign-in token's email, never from anything the request says about itself. */
export const mcpTesters = (env: Env = process.env) => new Set(String(env.STUDIO_MCP_TESTERS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
// Under /api/studio/ on purpose: the access boundary (account-access.ts) lets a signed-in person through to the Studio's
// routes and refuses everything else to anyone but the operator, so a path outside it would be refused for customers.
export const MCP_PATH = "/api/studio/mcp";
const APP_URL = "https://app.clone8.io";

/** A call to one of the Studio's own routes, as the person. */
export type StudioCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; json: any }>;

const STORY_SECONDS = [30, 50] as const;
const MOTIVATION_SECONDS = [30, 45, 60, 90] as const;

/** What the chat's AI sees: names, what each does, what it costs, and that starting one spends credits. */
export const MCP_TOOLS = [
  { name: "clone8_account", description: "The person's Clone8 plan and credit balance, and how many videos they made in the last 30 days. Free to call.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "clone8_catalog", description: "What Clone8 can make right now from this chat, with each kind's length choices. Free to call. Use clone8_quote for a price.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: "clone8_quote", description: "The price in credits of a video before making it, and the person's balance. Free to call; spends nothing.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["story", "motivation"] }, seconds: { type: "integer", description: "story: 30 or 50; motivation: 30, 45, 60 or 90" }, engine: { type: "string", enum: ["express", "signature"], description: "story only. express: the default, faster and cheaper. signature: built from scratch for the idea, takes longer, costs more." } }, required: ["kind"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "clone8_make_story",
    description: "Make a narrated vertical 3D story video (no character) about a topic, e.g. \"How does a hot air balloon fly?\". SPENDS CREDITS. Without confirm: true it only returns the price; tell the person the price and call again with confirm: true once they agree. Takes about 15 minutes (Express) or 30 minutes (Signature); follow it with clone8_job.",
    inputSchema: { type: "object", properties: { topic: { type: "string", minLength: 6, maxLength: 600 }, seconds: { type: "integer", enum: [...STORY_SECONDS], default: 50 }, engine: { type: "string", enum: ["express", "signature"], default: "express" }, confirm: { type: "boolean", description: "true only after the person agreed to the price" } }, required: ["topic"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "clone8_make_motivation",
    description: "Make a narrated motivation video (cinematic clips, a deep voice, sound effects) about a topic, or from the person's own script. SPENDS CREDITS. Without confirm: true it only returns the price; tell the person and call again with confirm: true once they agree. Takes about 3 minutes; follow it with clone8_job.",
    inputSchema: { type: "object", properties: { topic: { type: "string", maxLength: 600 }, script: { type: "string", maxLength: 4000, description: "the person's own words, instead of a topic" }, seconds: { type: "integer", enum: [...MOTIVATION_SECONDS], default: 45 }, wide: { type: "boolean", description: "16:9 instead of vertical 9:16" }, confirm: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  { name: "clone8_job", description: "How a video is getting on: its step while it is made, then links to watch and download it (the links last 15 minutes). Free to call.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] }, annotations: { readOnlyHint: true } },
  { name: "clone8_recent", description: "The person's most recent videos (up to 10), newest first, with their state. Free to call.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
] as const;

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, data?: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });
const err = (text: string, data?: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}), isError: true });
const nearest = (v: unknown, from: readonly number[], d: number) => { const n = Number(v); return Number.isFinite(n) ? from.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), from[0]) : d; };
/** The Studio's refusal, in its own words when it gave some. */
const refusal = (r: { status: number; json: any }) => {
  const j = r.json ?? {};
  if (j.error === "insufficient_credits") return err(`Not enough credits: this needs ${j.needed}, the balance is ${j.balance}. More credits: ${APP_URL}/#studio/pricing`, { error: j.error, needed: j.needed, balance: j.balance });
  if (j.error === "subscription_required") return err(`Making videos needs a Clone8 plan. The person can pick one here: ${APP_URL}/#studio/pricing (then ask again).`, { error: j.error, pricing: `${APP_URL}/#studio/pricing` });
  if (j.error === "too_many_jobs") return err("Clone8 is already making as many videos as this plan allows at once. Try again when one has finished (clone8_recent shows them).", { error: j.error });
  return err(String(j.detail ?? j.message ?? j.error ?? `Clone8 said ${r.status}`), { error: j.error ?? `http_${r.status}` });
};

/** The Studio request each make/quote tool stands for. */
export function studioRequest(name: string, a: any): { tool: string; options: Record<string, unknown> } | { invalid: string } {
  if (name === "clone8_make_story" || (name === "clone8_quote" && a?.kind === "story")) {
    const topic = String(a?.topic ?? "A story, priced").trim();
    if (name === "clone8_make_story" && topic.length < 6) return { invalid: "The topic needs at least 6 characters." };
    const signature = a?.engine === "signature";
    return { tool: "story", options: { topic, seconds: nearest(a?.seconds, STORY_SECONDS, 50), kind: "explainer", format: "auto", world: "auto", captions: "auto", sidekick: "", stage: "all", ...(signature ? { engine: "premium" } : {}) } };
  }
  if (name === "clone8_make_motivation" || (name === "clone8_quote" && a?.kind === "motivation")) {
    const script = String(a?.script ?? "").trim(), topic = String(a?.topic ?? "").trim();
    if (name === "clone8_make_motivation" && !script && topic.length < 3) return { invalid: "Give a topic or the person's own script." };
    const shape = a?.wide ? "16:9" : "9:16";
    return { tool: "motivation", options: script ? { script, shape } : { topic: topic || "A video, priced", seconds: nearest(a?.seconds, MOTIVATION_SECONDS, 45), shape } };
  }
  return { invalid: "kind must be story or motivation" };
}

const pageOf = (tool: string, options: any) => (tool === "kage_motion" && options?.motivation ? "motivation" : tool === "kage_motion" && options?.story ? "stories" : tool === "story" ? "stories" : tool);

/** Runs one tool for the person. Exported for the tests. */
export async function runTool(name: string, a: any, call: StudioCall): Promise<Result> {
  if (name === "clone8_account") {
    const r = await call("GET", "/api/studio/me"); if (r.status !== 200) return refusal(r);
    const s = r.json.subscription; const plan = s?.plan?.name ?? null; const pass = !!r.json.owner_pass;
    // (the Studio counts at most 200 of the last 30 days' jobs, so 200 means "200 or more")
    const n = Number(r.json.usage_30d?.jobs ?? 0); const count = n >= 200 ? "200 or more" : String(n);
    return ok(`${pass ? "Owner pass" : plan ? `${plan} plan${r.json.active ? "" : " (not active)"}` : "No plan"} · ${r.json.balance} credits · ${count} videos in the last 30 days.`, { plan, owner_pass: pass, active: !!r.json.active || pass, balance: r.json.balance, videos_30d: count });
  }
  if (name === "clone8_catalog") {
    const r = await call("GET", "/api/studio/plans"); if (r.status !== 200) return refusal(r);
    const t = r.json.tools ?? {}; const kinds: Record<string, unknown>[] = [];
    if (t.story_explainer) kinds.push({ kind: "story", what: "a narrated vertical 3D story (no character) about any topic", seconds: [...STORY_SECONDS], engines: t.story_premium ? ["express", "signature"] : ["express"] });
    if (t.motivation) kinds.push({ kind: "motivation", what: "a narrated motivation video with cinematic clips and sound effects", seconds: [...MOTIVATION_SECONDS] });
    return ok(kinds.length ? kinds.map((k) => `${k.kind}: ${k.what} (${(k.seconds as number[]).join(" / ")} s${k.engines ? `; ${(k.engines as string[]).join(" or ")}` : ""})`).join("\n") : "Nothing can be made from chat right now.", { kinds });
  }
  if (name === "clone8_quote" || name === "clone8_make_story" || name === "clone8_make_motivation") {
    const q = studioRequest(name, a); if ("invalid" in q) return err(q.invalid);
    const body = { tool: q.tool, asset_id: null, options: q.options };
    const [quote, me] = await Promise.all([call("POST", "/api/studio/quote", body), call("GET", "/api/studio/me")]);
    if (quote.status !== 200) return refusal(quote);
    const credits = Number(quote.json.credits ?? quote.json.quote?.credits); const balance = me.status === 200 ? Number(me.json.balance) : null; const summary = String(quote.json.summary ?? quote.json.quote?.summary ?? "");
    // no plan: say so with the price, before anyone agrees to something that cannot start
    const planless = me.status === 200 && !me.json.active && !me.json.owner_pass;
    if (planless && (name === "clone8_quote" || a?.confirm !== true)) return ok(`${summary}: ${credits} credits. Making videos needs a Clone8 plan first; the person can pick one here: ${APP_URL}/#studio/pricing. Nothing has been spent.`, { credits, balance, summary, started: false, plan_needed: true, pricing: `${APP_URL}/#studio/pricing` });
    if (name === "clone8_quote" || a?.confirm !== true) {
      const short = balance != null && balance < credits;
      return ok(`${summary}: ${credits} credits${balance != null ? ` (balance ${balance}${short ? `, not enough: ${APP_URL}/#studio/pricing` : ""})` : ""}.${name === "clone8_quote" ? "" : " Nothing has been spent: ask the person, then call again with confirm: true."}`, { credits, balance, summary, started: false });
    }
    const r = await call("POST", "/api/studio/jobs", body); if (r.status !== 201) return refusal(r);
    const job = r.json.job ?? {};
    return ok(`Started: ${summary}, ${credits} credits. Job ${job.id}. Check it with clone8_job; it also appears in ${APP_URL}/#studio/${pageOf(q.tool, q.options)}.`, { started: true, job_id: job.id, credits, summary });
  }
  if (name === "clone8_job") {
    const id = String(a?.job_id ?? ""); if (!/^[0-9a-f-]{36}$/i.test(id)) return err("job_id is the id clone8_make_* returned.");
    const r = await call("GET", `/api/studio/jobs/${id}`); if (r.status !== 200) return refusal(r);
    const j = r.json.job ?? {}; const outs = (Array.isArray(j.outputs) ? j.outputs : []).map((o: any) => ({ url: o.url ?? null, poster_url: o.poster_url ?? null }));
    const step = j.progress?.step ?? j.progress?.stage ?? null;
    const text = j.status === "done" ? `Done. ${outs.map((o: any, i: number) => `Video${outs.length > 1 ? ` ${i + 1}` : ""}: ${o.url}`).join("\n")}\n(Links last 15 minutes; it is kept in ${APP_URL}/#studio/${pageOf(j.tool, j.options)}.)` : j.status === "failed" || j.status === "canceled" ? `${j.status === "failed" ? "It failed" : "It was canceled"}${j.error_code ? ` (${j.error_code})` : ""}; the credits it held were returned.` : `${j.status === "queued" ? "Waiting to start" : "Being made"}${step ? `: ${step}` : ""}. Check again in a minute or two.`;
    return ok(text, { status: j.status, step, outputs: outs, error: j.error_code ?? null });
  }
  if (name === "clone8_recent") {
    const r = await call("GET", "/api/studio/jobs?limit=10"); if (r.status !== 200) return refusal(r);
    const jobs = (r.json.jobs ?? []).slice(0, 10).map((j: any) => ({ job_id: j.id, kind: pageOf(j.tool, j.options), status: j.status, created_at: j.created_at }));
    return ok(jobs.length ? jobs.map((j: any) => `${j.created_at?.slice(0, 16).replace("T", " ")} · ${j.kind} · ${j.status} · ${j.job_id}`).join("\n") : "No videos yet.", { jobs });
  }
  return err(`No tool called ${name}`);
}

/** The MCP server for one request, acting as one person. */
/** `base`: the connector's own public address (where its logo is served). */
export function mcpServer(call: StudioCall, o: { base: string } = { base: "https://mcp.clone8.io" }) {
  const server = new Server({ name: "clone8", title: "Clone8", version: "1.0.0", websiteUrl: "https://clone8.io", icons: [{ src: `${o.base}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }, { src: `${o.base}/favicon-64.png`, mimeType: "image/png", sizes: ["64x64"] }] } as any, { capabilities: { tools: {} }, instructions: "Clone8 makes short videos from an idea. Always give the person the price (clone8_quote, or a make tool without confirm) and wait for their agreement before calling a make tool with confirm: true. Then follow the job with clone8_job and give them the link." });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS as any }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try { return (await runTool(req.params.name, req.params.arguments ?? {}, call)) as any; }
    catch (e: any) { return err(`Clone8 could not do that just now (${String(e?.message ?? e).slice(0, 120)}).`) as any; }
  });
  return server;
}

/** The answer to a connector that is not signed in yet: where to learn how to sign in (RFC 9728). The access boundary
 *  sends it, because it answers signed-out requests before the connector's own handler runs. */
export function mcpChallenge(req: Request, env: Env = process.env): string | null {
  return mcpEnabled(env) ? `Bearer resource_metadata="${baseUrl(req, env)}/.well-known/oauth-protected-resource${MCP_PATH}"` : null;
}

const baseUrl = (req: Request, env: Env) => env.STUDIO_MCP_BASE_URL || `${String(req.header("x-forwarded-proto") ?? req.protocol).split(",")[0]}://${req.get("host")}`;

/** The routes. `loopback` is where the Studio's own routes answer (this same server). */
export function registerMcp(app: Express, sbFn: () => SupabaseClient, o: { env?: Env; loopback?: string; fetchFn?: typeof fetch } = {}) {
  const env = o.env ?? process.env; const fetchFn = o.fetchFn ?? fetch;
  // RFC 9728: where a connector learns which server signs people in (Supabase's OAuth 2.1 server)
  const metadata = (req: Request, res: Response) => {
    if (!mcpEnabled(env)) return res.status(404).json({ error: "not_found" });
    const supa = String(env.SUPABASE_URL ?? "").replace(/\/$/, "");
    res.json({ resource: `${baseUrl(req, env)}${MCP_PATH}`, authorization_servers: [`${supa}/auth/v1`], bearer_methods_supported: ["header"], resource_name: "Clone8", resource_documentation: "https://clone8.io" });
  };
  app.get("/.well-known/oauth-protected-resource", metadata);
  // the Clone8 logo at the connector's address: chat apps show the icon of the server's own domain beside its name
  const brand = (file: string, type: string) => (_req: Request, res: Response) => { res.setHeader("Cache-Control", "public, max-age=86400"); res.type(type).sendFile(resolve(process.cwd(), "assets/brand", file)); };
  app.get("/favicon.ico", brand("favicon.ico", "image/x-icon"));
  app.get("/favicon-64.png", brand("favicon-64.png", "image/png"));
  app.get("/apple-touch-icon.png", brand("apple-touch-icon.png", "image/png"));
  app.get("/icon.png", brand("icon-512.png", "image/png"));
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, metadata);

  app.all(MCP_PATH, async (req, res) => {
    if (!mcpEnabled(env)) return res.status(404).json({ error: "not_found" });
    const a = req.auth as any;
    if (!a?.user_id) {
      res.setHeader("WWW-Authenticate", mcpChallenge(req, env)!);
      return res.status(401).json({ error: "unauthorized", detail: "Sign in to Clone8 to use the connector" });
    }
    if (req.method !== "POST") return res.status(405).setHeader("Allow", "POST").json({ error: "method_not_allowed" });
    const tester = typeof a.email === "string" && mcpTesters(env).has(a.email.toLowerCase());
    if (!mcpOpen(env) && !tester && !(await isStudioAdmin(req, sbFn(), env))) return res.status(403).json({ error: "connector_not_open", detail: "The Clone8 connector is not open yet" });
    const auth = String(req.header("authorization") ?? ""); const loop = o.loopback ?? `http://127.0.0.1:${Number(env.PORT || 10000)}`;
    const call: StudioCall = async (method, path, body) => {
      const r = await fetchFn(`${loop}${path}`, { method, headers: { authorization: auth, "content-type": "application/json", "x-clone8-via": "mcp" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
      const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { error: "bad_response" }; }
      return { status: r.status, json };
    };
    const server = mcpServer(call, { base: baseUrl(req, env) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req as any, res as any, req.body); }
    catch (e: any) { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }); }
  });
}
