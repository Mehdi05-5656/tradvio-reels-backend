import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerScheduleAi, spaceOut, zonedToUtc } from "../src/studio-schedule-ai.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const P = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("local times to instants: daylight saving both ways; a skipped time lands after the jump", () => {
  assert.equal(new Date(zonedToUtc("2026-11-24 18:00", "America/Los_Angeles")!).toISOString(), "2026-11-25T02:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-07-01 09:00", "America/New_York")!).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-03-08 02:30", "America/New_York")!).toISOString(), "2026-03-08T07:30:00.000Z", "02:30 does not exist: 03:30 EDT");
  assert.equal(new Date(zonedToUtc("2026-11-01 01:30", "America/New_York")!).toISOString(), "2026-11-01T05:30:00.000Z", "the repeated hour: the first one");
  assert.equal(zonedToUtc("tomorrow 9", "UTC"), null);
});

test("spacing per account uses each account's own time, and nudges later in steps", () => {
  const t0 = Date.parse("2026-12-01T17:00:00Z");
  const other = { id: "o", schedule_at: new Date(t0).toISOString(), status: "scheduled", caption: "", platforms: ["instagram", "tiktok"], options: { accounts: [{ id: "A", platform: "instagram", at: new Date(t0).toISOString() }, { id: "B", platform: "tiktok", at: new Date(t0 + 30 * 60_000).toISOString() }] } };
  const mover = { id: "m", schedule_at: new Date(t0 + 5 * 3600_000).toISOString(), status: "scheduled", caption: "", platforms: ["tiktok"], options: { accounts: [{ id: "B", platform: "tiktok" }] } };
  const [r] = spaceOut([{ post: mover as any, at: t0 + 40 * 60_000 }], [other as any, mover as any], Date.now());
  assert.equal(new Date(r.at).toISOString(), new Date(t0 + 70 * 60_000).toISOString(), "B posts at 9:30 (its own time), so 9:40 moves to 10:10");
});

async function serve(rows: any[], ask: (b: any) => Promise<any>, customer: any = { status: "active" }) {
  const sb: any = { from(table: string) { const f: any[] = []; const q: any = { select() { return q; }, limit() { return q; }, eq(k: string, v: any) { f.push((r: any) => r[k] === v); return q; }, in(k: string, v: any[]) { f.push((r: any) => v.includes(r[k])); return q; }, maybeSingle() { q.one = true; return q; },
    then(res: any) { const src = table === "studio_customers" ? (customer ? [{ user_id: ANN, ...customer }] : []) : rows; const out = src.filter((r) => f.every((x: any) => x(r))); return Promise.resolve({ data: q.one ? out[0] ?? null : out, error: null }).then(res); } }; return q; } };
  const app = express(); app.use(express.json()); app.use((req: any, _r, next) => { req.auth = { user_id: ANN }; next(); });
  registerScheduleAi(app, () => sb, { env: {}, ask, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const call = async (body: any) => { const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/studio/social/schedule/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { call, close: () => server.close() };
}

test("the AI route: whole captions in, only listed posts, past times refused with a reason, own per-account captions protected, a plan needed", async () => {
  const soon = Date.now() + 2 * 86400_000;
  const rows = [
    { id: P(1), user_id: ANN, status: "scheduled", schedule_at: new Date(soon).toISOString(), caption: "first line\nsecond line #tag", platforms: ["instagram"], options: { accounts: [{ id: "A", platform: "instagram", username: "a" }] } },
    { id: P(2), user_id: ANN, status: "scheduled", schedule_at: new Date(soon + 3600_000).toISOString(), caption: "two", platforms: ["instagram"], options: { accounts: [{ id: "A", platform: "instagram", own: true, caption: "mine" }] } },
  ];
  const seen: any[] = [];
  const s = await serve(rows, async (b) => { seen.push(b); return { summary: "x", changes: [{ n: 1, action: "caption", when: null, caption: "first line\nsecond line #tag 50% off" }, { n: 2, action: "caption", when: null, caption: "new" }, { n: 2, action: "move", when: "2020-01-01 09:00", caption: null }, { n: 9, action: "cancel", when: null, caption: null }], unclear: [] }; });
  try {
    const r = await s.call({ text: "add 50% off", post_ids: [P(1), P(2)], timezone: "America/Los_Angeles" });
    assert.equal(r.status, 200);
    assert.match(seen[0].prompt, /"first line\\nsecond line #tag"/, "the whole caption, line breaks kept");
    assert.deepEqual(r.body.changes.map((c: any) => [c.post_id, c.action]), [[P(1), "caption"]], "the own-caption post and the past move are left out; post 9 does not exist");
    assert.equal(r.body.changes[0].caption, "first line\nsecond line #tag 50% off");
    assert.ok(r.body.unclear.some((u: string) => /its own caption/.test(u)));
    assert.ok(r.body.unclear.some((u: string) => /has passed/.test(u)));
  } finally { s.close(); }
  const noPlan = await serve(rows, async () => ({ summary: "", changes: [], unclear: [] }), null);
  try { assert.equal((await noPlan.call({ text: "x", post_ids: [P(1)], timezone: "UTC" })).body.error, "subscription_required"); } finally { noPlan.close(); }
});
