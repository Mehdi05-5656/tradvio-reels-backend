// The bot's only way to Clone8: the Studio's own public routes, as the signed-in owner, like the Claude connector
// (src/studio-mcp.ts). Three lists decide what may be called at all:
//   READ   routes that change nothing (some POSTs are reads: a quote, the faces in a clip, stunt ideas);
//   LIGHT  two small writes the app also does without a confirm (bring a link in; turn a result into a library file);
//   ACT    everything that posts, spends, changes or cancels. Only the executor may call these, and only with a
//          pending action the person confirmed (actions.ts). The brain has no way to reach them.
// Anything else, including every admin, billing, delete and account route, is refused here before it leaves the Mac.

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
  // the editor: opening a clip's edit file (it is made the first time a captioned copy or a split screen is opened, as in the app)
  ["GET", rx(`/projects/by-asset/${ID}`)], ["GET", rx(`/projects/by-job/${ID}`)], ["GET", rx(`/projects/${ID}`)], ["GET", rx(`/projects/${ID}/words`)],
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
  ["PUT", rx(`/projects/${ID}`)], ["POST", rx(`/projects/${ID}/render`)],
];
export type Level = "read" | "light" | "act";
export const pathOnly = (p: string) => p.split("?")[0].replace(/\/+$/, "");
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
/** What the brain and the bot need to know, wherever they run (this Mac's test, or the backend). */
export type BotConfig = { anthropicKey: string; model: string; effort: string; timezone: string; dailyCredits: number; maxActionCredits: number };
