// The connector's tools for posting (docs/higgsfield-parity/PLAN.md, phase 4: Higgsfield's "post to TikTok from chat"
// connector workflow): see the person's linked accounts and posting groups, post or schedule a finished video, and
// check what went out. Same rule as every connector tool: the Studio's own routes, as the person, so plan checks,
// account caps, group defaults and every refusal are exactly the Post page's (studio-social.ts createPosts).
// Posting is public and hard to undo, so clone8_post never sends without confirm: true, and its first answer says
// exactly which video goes to which accounts, when, with which caption. Until STUDIO_MCP_POSTING_OPEN=true only the
// owner's admin accounts can post from a chat (GET /api/studio/connectors/me says which).
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StudioCall } from "./studio-mcp.js";

const APP_URL = "https://app.clone8.io";
type Env = Record<string, string | undefined>;
type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, data?: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });
const err = (r: { status: number; json: any }): Result => { const j = r.json ?? {}; return { content: [{ type: "text", text: String(j.message ?? j.detail ?? j.error ?? `Clone8 said ${r.status}`) }], structuredContent: { error: j.error ?? `http_${r.status}` }, isError: true }; };
const say = (text: string, error: string): Result => ({ content: [{ type: "text", text }], structuredContent: { error }, isError: true });
export const chatPostingOpen = (env: Env = process.env) => env.STUDIO_MCP_POSTING_OPEN === "true";

export const SOCIAL_TOOLS = [
  { name: "clone8_accounts", title: "Linked social accounts", description: "The person's social accounts linked to Clone8 (TikTok, Instagram, YouTube…) with the id of each, and their posting groups. Free to call. Use the ids with clone8_post.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "clone8_post", title: "Post or schedule a video", description: "Post one of the person's finished Clone8 videos (or a video they uploaded) to their linked accounts, now or at a time. Without confirm it changes nothing and returns exactly what would be posted where and when: show that to the person. Only after they say yes to that exact post, call again with confirm: true. Posting is public.",
    inputSchema: { type: "object", properties: {
      job_id: { type: "string", description: "a finished video's job id (clone8_recent, clone8_job)" }, part: { type: "integer", minimum: 1, description: "which video of that job, when it made several (1 = the first)" },
      asset_id: { type: "string", description: "or a video from the person's library (clone8_library)" },
      accounts: { type: "array", items: { type: "string" }, description: "account ids from clone8_accounts" }, groups: { type: "array", items: { type: "string" }, description: "posting group ids from clone8_accounts" },
      caption: { type: "string", maxLength: 2200 }, at: { type: "string", description: "when to post, ISO 8601 with its time zone (e.g. 2026-11-27T18:00:00-08:00); left out: now" },
      confirm: { type: "boolean", description: "true only after the person agreed to this exact post" },
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "clone8_posts", title: "Posts", description: "The person's posts still to go out and the latest ones sent, with their state on each network. Free to call.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
] as const;
export const SOCIAL_TOOL_NAMES = new Set<string>(SOCIAL_TOOLS.map((t) => t.name));

const at = (a: any) => `${a.platform}${a.username ? ` @${String(a.username).replace(/^@/, "")}` : ""}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runSocialTool(name: string, a: any, call: StudioCall): Promise<Result | null> {
  if (!SOCIAL_TOOL_NAMES.has(name)) return null;
  if (name === "clone8_accounts") {
    const [s, g] = await Promise.all([call("GET", "/api/studio/social"), call("GET", "/api/studio/social/groups")]);
    if (s.status !== 200) return err(s);
    const accounts = ((s.json.accounts ?? []) as any[]).filter((x) => x.id);
    if (!s.json.enabled) return ok("Posting is not available on this account yet.", { accounts: [] });
    if (!accounts.length) return ok(`No social accounts are linked yet. The person links them once at ${APP_URL}/#studio/publish (Connect your socials), then ask again.`, { accounts: [] });
    const groups = g.status === 200 ? ((g.json.groups ?? []) as any[]) : [];
    const lines = accounts.map((x) => `${at(x)}${x.refresh_required ? " (needs relinking)" : ""}: ${x.id}`);
    const glines = groups.map((x) => `${x.name} (${(x.account_ids ?? []).length} accounts): ${x.id}`);
    return ok(`Linked accounts:\n${lines.join("\n")}${glines.length ? `\n\nPosting groups:\n${glines.join("\n")}` : ""}`, { accounts: accounts.map((x) => ({ id: x.id, platform: x.platform, username: x.username ?? null })), groups: groups.map((x) => ({ id: x.id, name: x.name })) });
  }
  if (name === "clone8_posts") {
    const r = await call("GET", "/api/studio/social/posts"); if (r.status !== 200) return err(r);
    const posts = ((r.json.posts ?? []) as any[]).slice(0, 15);
    if (!posts.length) return ok("Nothing posted or scheduled yet.", { posts: [] });
    const lines = posts.map((p) => `${p.status}${p.schedule_at ? ` · ${p.schedule_at}` : ""} · ${(p.platforms ?? []).join(", ")} · "${String(p.caption ?? "").slice(0, 60)}"${p.error ? ` · ${p.error}` : ""}`);
    return ok(lines.join("\n"), { posts: posts.map((p) => ({ id: p.id, status: p.status, schedule_at: p.schedule_at ?? null, platforms: p.platforms ?? [] })) });
  }
  // clone8_post
  const gate = await call("GET", "/api/studio/connectors/me");
  if (gate.status !== 200) return err(gate);
  if (!gate.json.chat_posting) return say(`Posting from a chat is not open on this account yet. The person can post this video at ${APP_URL}/#studio/publish.`, "chat_posting_closed");
  const accounts = Array.isArray(a?.accounts) ? a.accounts.map(String).filter(Boolean).slice(0, 50) : [];
  const groups = Array.isArray(a?.groups) ? a.groups.map(String).filter(Boolean).slice(0, 20) : [];
  if (!accounts.length && !groups.length) return say("Which accounts? Call clone8_accounts and pass their ids (or a posting group's id).", "no_accounts");
  // the video: a job's output (its file key comes from the job, never from the chat) or a library upload
  let item: Record<string, string>, label: string;
  if (a?.asset_id) {
    if (!UUID.test(String(a.asset_id))) return say("That library id is not right. clone8_library lists them.", "video_not_found");
    item = { asset_id: String(a.asset_id) }; label = `library video ${a.asset_id}`;
  } else {
    const id = String(a?.job_id ?? ""); if (!UUID.test(id)) return say("Which video? Give a finished video's job_id (clone8_recent) or a library asset_id.", "video_not_found");
    const j = await call("GET", `/api/studio/jobs/${id}`); if (j.status !== 200) return err(j);
    const job = j.json.job ?? {};
    if (job.status !== "done") return say("That video is not finished yet. Follow it with clone8_job, then post it.", "not_finished");
    const vids = ((job.outputs ?? []) as any[]).filter((o) => typeof o?.key === "string" && (o.kind ? o.kind === "video" : /\.mp4$/i.test(o.key)));
    const n = Math.max(1, Math.floor(Number(a?.part ?? 1)) || 1);
    if (!vids.length) return say("That job has no video to post (pictures cannot be posted from a chat yet).", "not_a_video");
    if (n > vids.length) return say(`That job made ${vids.length} video${vids.length === 1 ? "" : "s"}. Pick part 1${vids.length > 1 ? `-${vids.length}` : ""}.`, "video_not_found");
    item = { job_id: id, output_key: vids[n - 1].key }; label = `video ${n} of job ${id}`;
  }
  let when: string | null = null;
  if (a?.at) {
    const t = Date.parse(String(a.at)); if (!Number.isFinite(t) || !/([zZ]|[+-]\d\d:?\d\d)$/.test(String(a.at).trim())) return say("Give the time with its time zone, e.g. 2026-11-27T18:00:00-08:00.", "bad_time");
    if (t < Date.now() - 60_000) return say("That time has passed. Pick a time ahead, or leave it out to post now.", "bad_time");
    when = new Date(t).toISOString();
  }
  const caption = String(a?.caption ?? "").slice(0, 2200);
  if (!a?.confirm) {
    // what would go out, named in the person's own account words
    const s = await call("GET", "/api/studio/social"); const linked = s.status === 200 ? ((s.json.accounts ?? []) as any[]) : [];
    const names = accounts.map((id: string) => { const x = linked.find((l) => l.id === id); return x ? at(x) : `account ${id} (not linked: check clone8_accounts)`; });
    const text = `Ready to post, nothing sent yet:\n- Video: ${label}\n- To: ${[...names, ...groups.map((g: string) => `posting group ${g}`)].join(", ")}\n- When: ${when ? `${when} (UTC)` : "now"}\n- Caption: ${caption ? `"${caption}"` : "(none)"}\n\nShow this to the person. Post it only if they say yes to exactly this, by calling clone8_post again with confirm: true.`;
    return ok(text, { confirm_needed: true });
  }
  const r = await call("POST", "/api/studio/social/posts", { items: [item], ...(accounts.length ? { accounts } : {}), ...(groups.length ? { group_ids: groups } : {}), caption, ...(when ? { schedule_at: when } : {}), via: "claude" });
  if (r.status !== 201) return err(r);
  const posts = (r.json.posts ?? []) as any[];
  const failed = posts.filter((p) => p.status === "failed"), sent = posts.filter((p) => p.status !== "failed");
  const nets = [...new Set(sent.flatMap((p) => p.platforms ?? []))].join(", ");
  const text = `${when ? `Scheduled for ${when} (UTC)` : r.json.queued ? "Queued: it goes out in the next minutes" : "Sent"}${nets ? ` to ${nets}` : ""}.${failed.length ? ` ${failed.length} did not go: ${failed.map((p) => p.error ?? "failed").join("; ")}.` : ""} Follow it with clone8_posts, or at ${APP_URL}/#studio/publish.`;
  return ok(text, { posts: posts.map((p) => ({ id: p.id, status: p.status, platforms: p.platforms ?? [] })) });
}

/** GET /api/studio/connectors/me: what this person's connectors may do (the posting switch above). */
export function registerConnectorsMe(app: Express, h: { sbFn: () => SupabaseClient; requireUser: (req: Request, res: Response) => string | null; isOwner: (req: Request, sb: SupabaseClient) => Promise<boolean>; env?: Env }): void {
  app.get("/api/studio/connectors/me", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = h.requireUser(req, res); if (!u) return;
    const admin = await h.isOwner(req, h.sbFn()).catch(() => false);
    res.json({ chat_posting: chatPostingOpen(h.env ?? process.env) || admin });
  });
}
