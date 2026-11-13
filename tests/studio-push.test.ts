import test from "node:test";
import assert from "node:assert/strict";
import { message, pushReady, pushTick } from "../src/studio-push.js";

test("push: off without the Apple key settings", () => {
  assert.equal(pushReady({}), false);
  assert.equal(pushReady({ APNS_KEY: "k", APNS_KEY_ID: "ABC", APNS_TEAM_ID: "YZP4MFJ47H" }), true);
});

test("push: the notice names the tool and the idea; a failure says credits came back", () => {
  assert.deepEqual(message({ tool: "story", status: "done", options: { prompt: "Want a fireplace in your house?" } }), { title: "Your video is ready", body: "Story · Want a fireplace in your house?" });
  assert.match(message({ tool: "longform", status: "failed" }).body, /credits came back/);
});

test("push: each finished job is claimed once, sent to phones registered before it ended, dead tokens removed", async () => {
  const deleted: string[] = [], sent: string[] = [];
  let claimed = 0;
  const jobs = [{ id: "j1", user_id: "u", tool: "story", status: "done", options: {}, finished_at: "2026-11-13T10:00:00Z" }];
  const devices = [
    { token: "aa", sandbox: false, created_at: "2026-11-13T09:00:00Z" },
    { token: "bb", sandbox: true, created_at: "2026-11-13T09:30:00Z" },
    { token: "cc", sandbox: false, created_at: "2026-11-13T11:00:00Z" },
  ];
  const sb: any = {
    from(t: string) {
      let op = "select";
      const q: any = { select: () => q, in: () => q, gte: () => q, is: () => q, limit: () => q, eq: () => q,
        update: () => { op = "update"; return q; }, delete: () => { op = "delete"; return q; },
        then(res: any) {
          if (t === "studio_jobs" && op === "update") { claimed++; return res({ data: claimed === 1 ? [{ id: "j1" }] : [], error: null }); }
          if (t === "studio_jobs") return res({ data: jobs, error: null });
          if (t === "studio_devices" && op === "delete") { deleted.push("bb"); return res({ error: null }); }
          return res({ data: devices, error: null });
        } };
      return q;
    },
  };
  const n = await pushTick(sb, {}, () => {}, async (_e, d) => { sent.push(d.token); return d.token === "bb" ? { status: 410, reason: "Unregistered" } : { status: 200, reason: null }; });
  assert.deepEqual(sent, ["aa", "bb"], "cc registered after the job ended");
  assert.equal(n, 1);
  assert.deepEqual(deleted, ["bb"]);
});
