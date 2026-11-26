import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { SOCIAL_TOOLS, registerConnectorsMe, runSocialTool } from "../src/studio-mcp-social.ts";
import { MCP_TOOLS } from "../src/studio-mcp.ts";
import { MODEL_TOOLS } from "../src/studio-mcp-models.ts";
import { SKILL_TOOLS } from "../src/studio-mcp-skills.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const studio = (o: { posting?: boolean; job?: any } = {}) => {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const answers: Record<string, { status: number; json: any }> = {
    "GET /api/studio/connectors/me": { status: 200, json: { chat_posting: o.posting ?? true } },
    "GET /api/studio/social": { status: 200, json: { enabled: true, accounts: [{ id: "acc-tt", platform: "tiktok", username: "maya" }, { id: "acc-ig", platform: "instagram", username: "@maya.ig", refresh_required: true }, { platform: "x", username: "old" }] } },
    "GET /api/studio/social/groups": { status: 200, json: { groups: [{ id: "g-1", name: "Main", account_ids: ["acc-tt", "acc-ig"] }] } },
    [`GET /api/studio/jobs/${JOB}`]: { status: 200, json: { job: o.job ?? { status: "done", outputs: [{ key: "u/a.jpg", kind: "image" }, { key: "u/one.mp4" }, { key: "u/two.mp4", kind: "video" }] } } },
    "POST /api/studio/social/posts": { status: 201, json: { posts: [{ id: "p1", status: "scheduled", platforms: ["tiktok"] }, { id: "p2", status: "failed", platforms: ["instagram"], error: "relink instagram" }] } },
    "GET /api/studio/social/posts": { status: 200, json: { posts: [{ id: "p1", status: "scheduled", schedule_at: "2026-11-28T02:00:00.000Z", platforms: ["tiktok"], caption: "Hello" }] } },
  };
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => { calls.push({ method, path, body }); return answers[`${method} ${path.split("?")[0]}`] ?? { status: 404, json: { error: "nope" } }; };
  return { call, calls, posted: () => calls.filter((c) => c.method === "POST" && c.path === "/api/studio/social/posts") };
};

test("the posting tools have unique names among all the connector's, and the post tool is the only one that changes anything", () => {
  const names = [...MCP_TOOLS, ...MODEL_TOOLS, ...SKILL_TOOLS, ...SOCIAL_TOOLS].map((t) => t.name); assert.equal(new Set(names).size, names.length);
  assert.deepEqual(SOCIAL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ["clone8_post"]);
});

test("accounts are listed by network and handle with their ids; groups too; one needing relinking says so", async () => {
  const s = studio(); const r = await runSocialTool("clone8_accounts", {}, s.call);
  assert.match(r!.content[0].text, /tiktok @maya: acc-tt/); assert.match(r!.content[0].text, /instagram @maya\.ig \(needs relinking\): acc-ig/);
  assert.doesNotMatch(r!.content[0].text, /@old/, "an account without an id cannot be posted to by id");
  assert.match(r!.content[0].text, /Main \(2 accounts\): g-1/);
});

test("a post without confirm sends nothing and says exactly what would go where and when; the file comes from the job", async () => {
  const s = studio();
  const r = await runSocialTool("clone8_post", { job_id: JOB, part: 2, accounts: ["acc-tt", "acc-zz"], caption: "New drop", at: "2099-01-01T18:00:00-08:00" }, s.call);
  assert.equal(s.posted().length, 0, "nothing posted without confirm");
  assert.match(r!.content[0].text, /Video: video 2 of job/); assert.match(r!.content[0].text, /To: tiktok @maya, account acc-zz \(not linked/);
  assert.match(r!.content[0].text, /When: 2099-01-02T02:00:00\.000Z \(UTC\)/); assert.match(r!.content[0].text, /Caption: "New drop"/);
  const go = await runSocialTool("clone8_post", { job_id: JOB, part: 2, accounts: ["acc-tt"], caption: "New drop", at: "2099-01-01T18:00:00-08:00", confirm: true }, s.call);
  assert.deepEqual(s.posted()[0].body, { items: [{ job_id: JOB, output_key: "u/two.mp4" }], accounts: ["acc-tt"], caption: "New drop", schedule_at: "2099-01-02T02:00:00.000Z", via: "claude" }, "only video outputs count; the key is the job's");
  assert.match(go!.content[0].text, /Scheduled for 2099-01-02T02:00:00\.000Z \(UTC\) to tiktok\. 1 did not go: relink instagram/);
});

test("posting from a chat waits for its switch; bad input is refused before anything is sent", async () => {
  const closed = studio({ posting: false });
  const r = await runSocialTool("clone8_post", { job_id: JOB, accounts: ["acc-tt"], confirm: true }, closed.call);
  assert.equal(r!.isError, true); assert.match(r!.content[0].text, /not open on this account yet/); assert.equal(closed.posted().length, 0);
  const s = studio();
  assert.match((await runSocialTool("clone8_post", { job_id: JOB, confirm: true }, s.call))!.content[0].text, /Which accounts/);
  assert.match((await runSocialTool("clone8_post", { job_id: JOB, accounts: ["acc-tt"], at: "2099-01-01 18:00", confirm: true }, s.call))!.content[0].text, /time zone/);
  assert.match((await runSocialTool("clone8_post", { job_id: JOB, accounts: ["acc-tt"], at: "2020-01-01T00:00:00Z", confirm: true }, s.call))!.content[0].text, /has passed/);
  assert.match((await runSocialTool("clone8_post", { job_id: JOB, part: 5, accounts: ["acc-tt"], confirm: true }, s.call))!.content[0].text, /made 2 videos/);
  const running = studio({ job: { status: "running", outputs: [] } });
  assert.match((await runSocialTool("clone8_post", { job_id: JOB, accounts: ["acc-tt"], confirm: true }, running.call))!.content[0].text, /not finished yet/);
  assert.equal(s.posted().length + running.posted().length, 0);
  assert.match((await runSocialTool("clone8_posts", {}, s.call))!.content[0].text, /scheduled · 2026-11-28T02:00:00\.000Z · tiktok · "Hello"/);
  assert.equal(await runSocialTool("clone8_models", {}, s.call), null);
});

test("GET /api/studio/connectors/me: posting from a chat is open with the switch, or for the owner's admin accounts", async () => {
  for (const [env, user, want] of [[{}, "someone", false], [{}, "admin", true], [{ STUDIO_MCP_POSTING_OPEN: "true" }, "someone", true]] as const) {
    const app = express();
    registerConnectorsMe(app, { sbFn: () => ({}) as any, env, requireUser: (req, res) => { const u = req.header("x-user"); if (!u) { res.status(401).end(); return null; } return u; }, isOwner: async (req) => req.header("x-user") === "admin" });
    const srv = app.listen(0); const port = (srv.address() as AddressInfo).port;
    try { const r = await fetch(`http://127.0.0.1:${port}/api/studio/connectors/me`, { headers: { "x-user": user } }); assert.deepEqual(await r.json(), { chat_posting: want }); }
    finally { srv.close(); }
  }
});
