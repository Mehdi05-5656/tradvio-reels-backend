import test from "node:test";
import assert from "node:assert/strict";
import { failureEmail } from "../src/failure-watch.js";
import { runSourceCheck } from "../src/source-check.js";
import { resetKickPace } from "../src/live-sources.js";

test("a paying customer's failed first run leads the failure email", () => {
  const r: any = { id: 1, at: "2026-11-22T20:16:26Z", job_id: "j", user_id: "u", tool: "clips", kind: "failed", code: "kick_error", detail: "Kick answered 429", stage: "reading", attempt: 1, fix_status: "open", fix_note: null, alerted_at: null };
  const m = failureEmail([{ r, who: { email: "c@x.com", internal: false } as any, h: { thisPerson: 0, everyone: 0, fixed: null, plan: "creator", firstRun: true } }]);
  assert.match(m.subject, /^FIRST RUN FAILED \(paying customer\): /);
  assert.match(m.text, /creator plan · THEIR FIRST RUN/);
  const later = failureEmail([{ r, who: { email: "c@x.com", internal: false } as any, h: { thisPerson: 0, everyone: 0, fixed: null, plan: "creator", firstRun: false } }]);
  assert.doesNotMatch(later.subject, /FIRST RUN/);
});

test("the source check emails the owner about a failed source, and only that one", async () => {
  resetKickPace();
  const alerts: string[] = [];
  const twitchGql = (url: string, init?: any) => {
    const u = String(url);
    if (u.includes("id.twitch.tv")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    if (u.includes("/helix/users")) return new Response(JSON.stringify({ data: [{ id: "1", login: "kaicenat", display_name: "KaiCenat", profile_image_url: null }] }));
    if (u.includes("/helix/videos")) return new Response(JSON.stringify({ data: [{ id: "99", user_login: "kaicenat", user_name: "KaiCenat", user_id: "1", title: "t", created_at: "2026-11-22T00:00:00Z", duration: "2h0m0s", view_count: 1, thumbnail_url: "", type: "archive", stream_id: "s" }] }));
    if (u.includes("gql.twitch.tv")) return new Response(JSON.stringify([{ data: { video: { comments: { edges: [{ node: { contentOffsetSeconds: 5, commenter: { id: "a" }, message: { fragments: [{ text: "W" }] } } }], pageInfo: { hasNextPage: false } } } } }]));
    return new Response("{}", { status: 404 });
  };
  const deps: any = { env: { TWITCH_CLIENT_ID: "x", TWITCH_CLIENT_SECRET: "y" }, fetch: async (u: any, i: any) => twitchGql(u, i), sleep: async () => undefined, log: () => undefined,
    kickCurl: async () => ({ code: 0, so: "{}\n500", se: "" }), youtube: async () => ({ creators: [{ videos: 3 }], videos: [{}], fresh_at: "" }),
    alert: async (_k: string, subject: string) => { alerts.push(subject); return true; } };
  const r = await runSourceCheck(deps);
  const failed = r.filter((x) => !x.ok).map((x) => x.step);
  assert.ok(failed.every((s) => s.startsWith("kick")), `failed: ${failed.join(", ")}; ${r.map((x) => x.detail).join(" | ")}`);
  assert.equal(alerts.length, failed.length);
  assert.ok(alerts.every((a) => /^Clips source check failed: kick/.test(a)));
  assert.ok(r.find((x) => x.step.startsWith("youtube"))?.ok);
});
