import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { EXAM_TOPICS, examRow, examRunId, registerStoryExam } from "../src/studio-story-exam.js";
import { PLANS } from "../src/studio.js";

test("story exam: eight fixed topics, a run id per start, a report row per film", () => {
  assert.equal(EXAM_TOPICS.length, 8);
  assert.match(examRunId(new Date("2026-11-07T22:41:09Z")), /^exam-20261107-2241$/);
  const row = examRow({ id: "j1", status: "done", created_at: "t", options: { story: { topic: "Folding a piece of paper 42 times" }, exam: { run: "exam-x", index: 1 } },
    outputs: [{ title: "Paper", world: "cosmos", duration: 80, render_cost_usd: 0.4, minutes: 14, worker_commit: "abc1234",
      judge: { watch: { score: 58, beats: [{ shown: "no" }, { shown: "yes" }] }, first_watch: 50, remade: true, scores: { overall: 87 }, animatic: { first: { score: 40 }, final: { score: 62, no: [[1, "x"]] }, revised: true } },
      metrics: { fill_median: 0.1 }, devices: { ending: "invoice_or_bill", counts: { simile: 2 } } }] });
  assert.equal(row.index, 2); assert.equal(row.watch, 58); assert.equal(row.first_watch, 50); assert.equal(row.remade, true);
  assert.equal(row.animatic_first, 40); assert.equal(row.animatic_final, 62); assert.equal(row.animatic_no, 1); assert.equal(row.watch_no, 1);
  assert.equal(row.ending_device, "invoice_or_bill"); assert.equal(row.worker_commit, "abc1234");
  const empty = examRow({ id: "j2", status: "queued", options: { story: { topic: "t" }, exam: { run: "r", index: 0 } }, outputs: null });
  assert.equal(empty.watch, null); assert.equal(empty.status, "queued");
});

test("story exam: only the Studio admin may start or read a run; a second run is refused while one is going", async () => {
  const calls: any[] = []; let going: any[] = [];
  const q: any = { select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, contains: () => q, limit: async () => ({ data: going, error: null }), then: (r: any) => Promise.resolve({ data: [], error: null }).then(r) };
  const sb: any = { from: () => q, rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: { id: "job-1" }, error: null }; },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: "support@clone8.io", email_confirmed_at: "x" } } }) } } };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = req.headers["x-who"] === "admin" ? { user_id: "u-admin", email: "support@clone8.io" } : { user_id: "u2", email: "someone@x.com" }; next(); });
  registerStoryExam(app, () => sb, { env: { STUDIO_STORIES_ENABLED: "true" }, plans: PLANS as any });
  const srv = app.listen(0); const port = (srv.address() as any).port;
  try {
    const post = (who: string) => fetch(`http://127.0.0.1:${port}/api/studio/admin/story-exam`, { method: "POST", headers: { "content-type": "application/json", "x-who": who }, body: "{}" });
    assert.equal((await post("someone")).status, 404, "not the admin: nothing there");
    const ok = await post("admin"); assert.equal(ok.status, 200); const body: any = await ok.json();
    assert.match(body.run, /^exam-/); assert.equal(body.topics.length, 8); assert.equal(body.mode, "full"); assert.equal(body.jobs.length, 3, "three lanes start at once");
    assert.equal(calls[0].fn, "studio_create_job"); assert.equal(calls[0].args.p_user, "u-admin"); assert.equal(calls[0].args.p_options.exam.index, 0); assert.equal(calls[0].args.p_options.story.topic, EXAM_TOPICS[0]);
    assert.deepEqual(calls.map((c) => c.args.p_options.story.topic), [EXAM_TOPICS[0], EXAM_TOPICS[1], EXAM_TOPICS[2]]); assert.equal(calls[2].args.p_options.exam.lanes, 3);
    assert.ok(!calls[0].args.p_options.story.stage, "a full exam makes the films");
    calls.length = 0;
    const quick = await fetch(`http://127.0.0.1:${port}/api/studio/admin/story-exam`, { method: "POST", headers: { "content-type": "application/json", "x-who": "admin" }, body: JSON.stringify({ mode: "quick", lanes: 4 }) });
    assert.equal(quick.status, 200); assert.equal(calls.length, 4); assert.equal(calls[0].args.p_options.story.stage, "animatic", "a quick exam stops at the animatic"); assert.equal(calls[0].args.p_options.exam.mode, "quick");
    // at the account's job limit after the first film: what fits is started, nothing fails (exam-20261108-0013)
    calls.length = 0; let n = 0; const rpc = sb.rpc; sb.rpc = async (fn: string, args: any) => (++n > 1 ? { data: null, error: { message: "too_many_jobs", code: "P0001" } } : rpc(fn, args));
    const short = await post("admin"); assert.equal(short.status, 200); const sj: any = await short.json(); assert.equal(sj.started, 1); assert.equal(sj.jobs.length, 1);
    n = 0; sb.rpc = async () => ({ data: null, error: { message: "too_many_jobs", code: "P0001" } });
    assert.equal((await post("admin")).status, 500, "nothing could start: an error, not an empty run"); sb.rpc = rpc;
    going = [{ id: "j", options: { exam: { run: "exam-old" } } }];
    const busy = await post("admin"); assert.equal(busy.status, 409); assert.equal(((await busy.json()) as any).run, "exam-old");
  } finally { srv.close(); }
});
