// A pretend Clone8 account for trying the bot with no sign-in and nothing real at stake (run.ts --mock) and for the
// tests. It answers the same routes in the same shapes as the live server, and records every action it was asked to
// take so a test can prove what did and did not happen.
import { levelOf, Clone8Error, type Api, type Method, type Reply } from "./clone8.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDS = { cat: id(1), podcast: id(2), clipA: id(3), clipB: id(4), col: id(5), swapJob: id(6), post: id(7), tiktok: "acc-tiktok-1", insta: "acc-insta-1", newJob: id(8), swapAsset: id(9), storyJob: id(10), projA: id(11), capJob: id(12), capAsset: id(13) };
const iso = (minsFromNow: number, now: number) => new Date(now + minsFromNow * 60_000).toISOString();

export type MockApi = Api & { acts: Array<{ method: Method; path: string; body: any; claim: string }>; calls: Array<{ method: Method; path: string }>; data: any };

export function mockApi(now: () => number = Date.now): MockApi {
  const t = now();
  const data: any = {
    balance: 1840, quote: { swap: 86, stunts: 40, clips: 70, story: 120, captions: 9, longform: 900, recast: 86, splitscreen: 50, blueprint: 60 } as Record<string, number>,
    accounts: [{ id: IDS.tiktok, platform: "tiktok", username: "clone8test", display_name: "Clone8 test", image_url: null, profile_url: null }, { id: IDS.insta, platform: "instagram", username: "clone8test", display_name: "Clone8 test", image_url: null, profile_url: null, followers: 38 }],
    assets: [
      { id: IDS.cat, kind: "image", name: "tabby cat.jpg", status: "ready", created_at: iso(-9000, t), collection_id: null, probe: { character: true, mode: "animal", prompt: "a friendly orange tabby cat, facing the camera" }, poster_url: null },
      { id: IDS.podcast, kind: "video", name: "Podcast clip 3.mp4", status: "ready", created_at: iso(-9100, t), collection_id: null, probe: { duration: 43, people: [{ label: "the host" }] }, poster_url: null },
      { id: IDS.clipA, kind: "video", name: "clip-01.mp4", status: "ready", created_at: iso(-1500, t), collection_id: IDS.col, probe: { duration: 28, title: "He bet $800 on one hand", hook: "If I die, I die", transcript: "eight hundred dollars if I die I die let's go", score: 91, tags: ["stakes", "casino"], clip: { rank: 1 } }, poster_url: null },
      { id: IDS.clipB, kind: "video", name: "clip-02.mp4", status: "ready", created_at: iso(-1499, t), collection_id: IDS.col, probe: { duration: 34, title: "The cashier starts singing", hook: "Wait, is she singing?", transcript: "is she singing right now no way", score: 84, tags: ["funny", "irl"], clip: { rank: 2 } }, poster_url: null },
    ],
    collections: [{ id: IDS.col, name: "Friday night stream", kind: "clips", status: "ready", count: 2, created_at: iso(-1500, t), source: { title: "Friday night stream", channel: "somestreamer" } }],
    jobs: [
      { id: IDS.swapJob, tool: "swap", status: "done", asset_id: IDS.podcast, asset_name: "Podcast clip 3.mp4", options: { model: "light", character_asset_id: IDS.cat, prompt: "keep the microphone" }, credits_charged: 86, outputs: [{ key: `u/${IDS.swapJob}/out-01.mp4`, kind: "video", duration: 43, url: null, poster_url: null }], created_at: iso(-8000, t), finished_at: iso(-7990, t) },
      { id: IDS.storyJob, tool: "kage_motion", status: "done", asset_id: null, options: { story: { topic: "Want a pool in your backyard?" } }, credits_charged: 120, outputs: [{ key: `u/${IDS.storyJob}/out-01.mp4`, kind: "video", duration: 50, title: "Want a pool in your backyard?", url: null, poster_url: null }], created_at: iso(-4000, t), finished_at: iso(-3980, t) },
    ],
    // the editor's file for clip A: a stacked stream clip whose top panel takes 32% of the height
    projects: { [IDS.projA]: { id: IDS.projA, asset_id: IDS.clipA, job_id: null, rev: 3, rendered_rev: 3, render_state: "done", source: { kept: true },
      doc: { kind: "clip", source: { seconds: 60 }, trim: { in: 10, out: 38, keep: null }, layout: { type: "stacked", divider: 0.32, panes: [], path: [] }, captions: { on: false, style: null, keywords: true, fillers: true, censor: false, fixes: [] }, extras: { title: null, punch_in: null, pause_trim: false, bottom_loop: null }, sound: { level: -14, limiter: true, muted: [], bleep: "off" } } } } as Record<string, any>,
    words: ["eight", "hundred", "dollars", "if", "I", "die", "I", "die", "clone", "eight"].map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 })),
    posts: [{ id: IDS.post, job_id: null, output_key: null, asset_id: IDS.clipA, caption: "Desert well, one hand, $800", platforms: ["tiktok"], options: { accounts: [{ id: IDS.tiktok, platform: "tiktok", username: "clone8test" }] }, schedule_at: iso(180, t), status: "scheduled", results: [], error: null, created_at: iso(-60, t), updated_at: iso(-60, t), poster_url: null }],
  };
  const acts: MockApi["acts"] = [], calls: MockApi["calls"] = [];
  const ok = (json: any, status = 200): Reply => ({ status, json });
  const route = (method: Method, path: string, body: any, claim: string | null): Reply => {
    const p = path.split("?")[0], S = "/api/studio";
    if (method === "GET" && p === `${S}/me`) return ok({ subscription: { plan: { name: "Creator" }, status: "active", parallel_jobs: 2 }, active: true, balance: data.balance, usage_30d: { jobs: 12, credits: 640 }, ledger: [], connector: { url: "https://mcp.clone8.io/api/studio/mcp" } });
    if (method === "GET" && p === `${S}/social`) return ok({ enabled: true, connected: true, accounts: data.accounts, groups: [{ id: "g1", name: "Group A", account_ids: [IDS.tiktok, IDS.insta], missing: 0, networks: ["tiktok", "instagram"] }], usage_today: {}, per_account_daily: 15 });
    if (method === "GET" && p === `${S}/social/posts`) return ok({ posts: data.posts });
    if (method === "GET" && p === `${S}/jobs`) return ok({ jobs: data.jobs });
    if (method === "GET" && /\/jobs\/[0-9a-f-]{36}$/.test(p)) { const j = data.jobs.find((x: any) => p.endsWith(x.id)); return j ? ok({ job: j }) : ok({ error: "job_not_found" }, 404); }
    if (method === "GET" && p === `${S}/assets`) return ok({ assets: data.assets, next_before: null });
    if (method === "GET" && p === `${S}/collections`) return ok({ collections: data.collections });
    if (method === "GET" && /\/collections\//.test(p)) return ok({ collection: data.collections[0], assets: data.assets.filter((a: any) => a.collection_id === IDS.col) });
    if (method === "POST" && p === `${S}/quote`) { const tool = String(body?.tool ?? ""); if (tool === "captions" && !(Array.isArray(body?.options?.items) && body.options.items.length)) return ok({ error: "captions_no_items", detail: "Pick at least one video (options.items: [{asset_id}])" }, 400); const credits = data.quote[tool]; return credits == null ? ok({ error: "tool_not_open", detail: "This tool is not taking jobs yet" }, 503) : ok({ tool, credits, options: body?.options ?? {}, summary: tool === "stunts" ? `${(body?.options?.gags ?? []).length || 1} ending × 40` : "43 s × 2" }); }
    if (method === "POST" && p === `${S}/stunts/ideas`) return ok({ seconds: 43, moments: [{ at: 12.4, resume: 13.1, why: "he points at the camera", ideas: [{ title: "Launches into the sky", prompt: "He shoots straight up through the ceiling like a rocket, leaving a hole" }, { title: "Turns to sand", prompt: "He crumbles into a pile of sand that spills across the desk" }] }, { at: 31.0, resume: 31.8, why: "end of a sentence", ideas: [{ title: "Melts", prompt: "He melts into a puddle on the chair" }] }] });
    if (method === "POST" && /\/jobs\/[0-9a-f-]{36}\/asset$/.test(p)) { if (!data.assets.some((a: any) => a.id === IDS.swapAsset)) data.assets.push({ id: IDS.swapAsset, kind: "video", name: "Swap · result.mp4", status: "ready", created_at: iso(0, now()), collection_id: null, probe: { duration: 43, derived_from_job: IDS.swapJob }, poster_url: null }); return ok({ asset: data.assets.find((a: any) => a.id === IDS.swapAsset), copied: true }); }
    if (method === "POST" && p === `${S}/jobs`) { const credits = data.quote[String(body?.tool ?? "")] ?? 10; data.balance -= credits; data.jobs.unshift({ id: IDS.newJob, tool: body.tool, status: "queued", asset_id: body.asset_id, options: body.options, credits_reserved: credits, outputs: [], created_at: iso(0, now()) }); return ok({ job: { id: IDS.newJob }, quote: { credits } }, 201); }
    if (method === "POST" && p === `${S}/social/posts`) { const made = (body?.accounts ?? []).length ? [{ id: id(20 + data.posts.length), status: body.schedule_at ? "scheduled" : "sending", schedule_at: body.schedule_at ?? null, platforms: ["tiktok"], caption: body.caption }] : []; data.posts.push(...made.map((x: any) => ({ ...x, options: { accounts: (body.accounts ?? []).map((a: string) => ({ id: a, platform: a === IDS.tiktok ? "tiktok" : "instagram", username: "clone8test" })) }, updated_at: iso(0, now()), results: [] }))); return ok({ posts: made, skipped: [], queued: 0 }, 201); }
    if (method === "PATCH" && /\/social\/posts\//.test(p)) { const row = data.posts.find((x: any) => p.endsWith(x.id)); if (!row) return ok({ error: "post_not_found" }, 404); if (body?.schedule_at) row.schedule_at = body.schedule_at; if (typeof body?.caption === "string") row.caption = body.caption; row.updated_at = iso(0, now()); return ok({ post: row }); }
    if (method === "DELETE" && /\/social\/posts\//.test(p)) { const row = data.posts.find((x: any) => p.endsWith(x.id)); if (!row) return ok({ error: "post_not_found" }, 404); row.status = "canceled"; return ok({ post: row }); }
    if (method === "GET" && p === `${S}/live/lookup`) return ok({ platform: "twitch", channel: { login: "somestreamer", channel: "SomeStreamer", url: "https://www.twitch.tv/somestreamer", live: true, viewers: 18400, title: "FRIDAY NIGHT RANKED", permission: "open" }, broadcasts: [{ url: "https://www.twitch.tv/videos/2990011223", title: "FRIDAY NIGHT RANKED", live: true, seconds: 5400, started_at: iso(-90, now()) }], live_mode: true });
    if (method === "GET" && /\/projects\/by-asset\//.test(p)) { const pr = Object.values(data.projects).find((x: any) => p.endsWith(x.asset_id)); return pr ? ok(pr) : ok({ error: "project_not_found", detail: "No project for that clip" }, 404); }
    if (method === "GET" && /\/projects\/[0-9a-f-]{36}\/words$/.test(p)) return ok({ words: data.words });
    if (method === "GET" && /\/projects\/[0-9a-f-]{36}$/.test(p)) { const pr = data.projects[p.split("/").pop()!]; return pr ? ok(pr) : ok({ error: "project_not_found" }, 404); }
    if (method === "PUT" && /\/projects\/[0-9a-f-]{36}$/.test(p)) { const pr = data.projects[p.split("/").pop()!]; if (!pr) return ok({ error: "project_not_found" }, 404); if (Number(body?.rev) !== pr.rev) return ok({ error: "stale_revision", detail: "This clip was changed somewhere else" }, 409); pr.doc = body.doc; pr.rev += 1; data.lastOps = body.ops; return ok(pr); }
    if (method === "POST" && /\/projects\/[0-9a-f-]{36}\/render$/.test(p)) { const pr = data.projects[p.split("/")[p.split("/").length - 2]]; pr.render_state = "queued"; data.renderLater = () => { pr.render_state = "done"; pr.rendered_rev = pr.rev; }; return ok(pr, 202); }
    if (method === "GET" && /\/assets\/[0-9a-f-]{36}\/url$/.test(p)) return ok({ url: `https://mock.clone8.test/file/${p.split("/")[4]}.mp4`, expires_in: 900 });
    if (method === "GET" && p === `${S}/characters`) return ok({ characters: [{ asset_id: IDS.cat, name: "tabby cat", url: null }] });
    if (method === "GET") return ok({});
    return ok({ error: "not_in_mock", detail: `${method} ${p}` }, 501);
  };
  return {
    acts, calls, data,
    async call(method, path, body) { const level = levelOf(method, path); if (level !== "read" && level !== "light") throw new Clone8Error("route_not_allowed", `${method} ${path}`); calls.push({ method, path }); return route(method, path, body, null); },
    async act(claim, method, path, body) { if (!claim) throw new Clone8Error("no_confirmation"); if (levelOf(method, path) !== "act") throw new Clone8Error("route_not_allowed", `${method} ${path}`); acts.push({ method, path, body, claim }); return route(method, path, body, claim); },
    async bytes(url: string) { return /^https:\/\/mock\.clone8\.test\//.test(url) ? Buffer.from("video") : null; },
  };
}
