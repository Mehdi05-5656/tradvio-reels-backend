import test from "node:test";
import assert from "node:assert/strict";
import { failureDigest, failureEmail, failureTick, worthEmail, THEIRS, type FailureRow } from "../src/failure-watch.js";
import { resetAlertsForTests } from "../src/vendor-alerts.js";

const row = (o: Partial<FailureRow> = {}): FailureRow => ({ id: 1, at: "2026-11-16T18:14:03Z", job_id: "6d35170f", user_id: "u1", tool: "kage_motion", kind: "failed",
  code: "hand_render", detail: "Error while downloading .../public/story-sfx/story-rumble.wav: 403", stage: "render", attempt: 3, fix_status: "open", fix_note: null, alerted_at: null, ...o });
const customer = { email: "jake@example.com", internal: false };

test("what is emailed at the time: a customer's final failure, a lost job, a delivery without a part; not retries, their side or our own accounts", () => {
  assert.equal(worthEmail(row(), customer), true);
  assert.equal(worthEmail(row({ kind: "lost", code: "worker_lost" }), customer), true);
  assert.equal(worthEmail(row({ kind: "degraded", code: "sfx_stand_in" }), customer), true);
  assert.equal(worthEmail(row({ kind: "retry" }), customer), false);
  assert.equal(worthEmail(row({ code: "recast_nsfw" }), customer), false);
  assert.ok(THEIRS.has("clips_no_speech"), "the Clips list of the person's own failures is reused");
  assert.equal(worthEmail(row(), { email: "support@clone8.io", internal: true }), false);
});

test("the email carries the reason, the step, the person, the history and a regression mark", () => {
  const m = failureEmail([
    { r: row(), who: customer, h: { thisPerson: 1, everyone: 2, fixed: null } },
    { r: row({ id: 2, code: "worker_lost", kind: "lost", tool: "clips" }), who: customer, h: { thisPerson: 0, everyone: 0, fixed: row({ id: 0, fix_status: "fixed", fix_note: "lease cap, Nov 16" }) } },
  ]);
  assert.match(m.subject, /^REGRESSION: Clone8: 2 customer problems/);
  assert.match(m.text, /story-rumble\.wav: 403/); assert.match(m.text, /step: render · attempt 3/); assert.match(m.text, /jake@example\.com/);
  assert.match(m.text, /1 time\(s\) for this person, 2 time\(s\) for anyone/); assert.match(m.text, /first time for this person/);
  assert.match(m.text, /"worker_lost" was marked fixed \(lease cap, Nov 16\) and happened again/);
  assert.match(m.text, /credits were refunded/);
  const d = failureEmail([{ r: row({ kind: "degraded", code: "sfx_stand_in" }), who: customer, h: { thisPerson: 0, everyone: 0, fixed: null } }]);
  assert.match(d.text, /The video was delivered; only the part named above was left out/); assert.doesNotMatch(d.subject, /REGRESSION/);
});

test("the daily summary: customers only, by tool and code, with open and their-side marks", () => {
  const d = failureDigest([row(), row({ id: 2, kind: "retry" }), row({ id: 3, code: "recast_nsfw", tool: "swap", user_id: "u2" }), row({ id: 4, user_id: "me" })], new Set(["me"]));
  assert.equal(d.counts.failed, 2); assert.equal(d.counts.retries, 1); assert.equal(d.counts.ours_internal, 1);
  assert.match(d.text, /kage_motion · hand_render: 2 \(failed\/retry, 1 people\) · OPEN/); assert.match(d.text, /swap · recast_nsfw: 1 .* · their side/);
  assert.match(failureDigest([], new Set()).text, /No customer failures/);
});

test("a look: new rows are emailed once, then marked so they are never emailed again", async () => {
  resetAlertsForTests();
  const table: FailureRow[] = [row({ id: 10 }), row({ id: 11, kind: "retry" }), row({ id: 12, user_id: "me" })];
  const sent: any[] = [];
  const q = (rows: FailureRow[]) => {
    let r = rows; const b: any = {
      select: () => b, order: () => b, limit: () => b, gte: () => b,
      is: (k: string, v: any) => { r = r.filter((x: any) => x[k] === v); return b; },
      eq: (k: string, v: any) => { r = r.filter((x: any) => x[k] === v); return b; },
      neq: (k: string, v: any) => { r = r.filter((x: any) => x[k] !== v); return b; },
      lt: (k: string, v: any) => { r = r.filter((x: any) => x[k] < v); return b; },
      in: (k: string, v: any[]) => { r = r.filter((x: any) => v.includes(x[k])); return b; },
      update: (patch: any) => ({ in: (_k: string, ids: number[]) => { for (const x of table) if (ids.includes(x.id)) Object.assign(x, patch); return Promise.resolve({ error: null }); } }),
      then: (f: any) => f({ data: r, error: null }),
    }; return b;
  };
  const sb: any = { from: () => q(table), auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: id === "me" ? "support@clone8.io" : "jake@example.com" } } }) } } };
  const env = { RESEND_API_KEY: "k" };
  const fetchFn: any = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); };
  const r1 = await failureTick(sb, { env, fetch: fetchFn, log: () => undefined, now: () => Date.parse("2026-11-16T19:00:00Z") } as any);
  assert.deepEqual(r1, { looked: 3, emailed: 1 });
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /1 customer problem \(kage_motion hand_render\)/);
  assert.ok(table.every((x) => x.alerted_at), "every row looked at is marked, emailed or not");
  const r2 = await failureTick(sb, { env, fetch: fetchFn, log: () => undefined } as any);
  assert.deepEqual(r2, { looked: 0, emailed: 0 }); assert.equal(sent.length, 1);
});
