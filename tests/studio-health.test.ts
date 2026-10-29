import test from "node:test";
import assert from "node:assert/strict";
import { collectStudioHealth, studioJobCards, studioAlerts, failureRate, type StudioHealthCounts } from "../src/studio-health.js";

const now = new Date("2026-10-29T04:00:00Z");
const min = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const quiet = (): StudioHealthCounts => ({
  tools: { blueprint: { queued: 0, running: 0, stale_running: 0, oldest_queued_at: null, latest_finished_at: min(90), done_24h: 6, failed_24h: 0, total: 7 },
    recast: { queued: 0, running: 1, stale_running: 0, oldest_queued_at: null, latest_finished_at: min(400), done_24h: 3, failed_24h: 0, total: 4 } },
  webhook: { total: 12, latest_received_at: min(30), unprocessed_old: 0, errors_24h: 0 },
});

test("studio health: cards read healthy when queues move and the webhook keeps up", () => {
  const cards = Object.fromEntries(studioJobCards(quiet(), now).map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(cards), ["studio_blueprint", "studio_recast", "studio_stripe"]);
  assert.equal(cards.studio_blueprint.health, "ok"); assert.match(cards.studio_blueprint.note, /idle; last finished 2 h ago/);
  assert.equal(cards.studio_recast.health, "ok"); assert.match(cards.studio_recast.note, /1 running, 0 queued; 3 done, 0 failed in 24 h/);
  assert.equal(cards.studio_stripe.health, "ok"); assert.match(cards.studio_stripe.note, /last event 30 min ago/);
  assert.equal(studioAlerts(quiet(), now).length, 0);
});

test("studio health: a tool with no jobs is off, not broken; one recast failure out of three is noted, not alarmed", () => {
  const c = quiet(); c.tools.blueprint = { ...c.tools.blueprint, total: 0, done_24h: 0, latest_finished_at: null }; c.tools.recast = { ...c.tools.recast, done_24h: 2, failed_24h: 1 };
  const cards = Object.fromEntries(studioJobCards(c, now).map((x) => [x.id, x]));
  assert.equal(cards.studio_blueprint.health, "off"); assert.equal(cards.studio_blueprint.note, "no jobs yet");
  assert.equal(failureRate(c.tools.recast), 1 / 3); assert.equal(cards.studio_recast.health, "warn", "a third failing is worth a look on the card");
  assert.equal(studioAlerts(c, now).length, 0, "but with fewer than 5 finished no alert fires");
});

test("studio health: a stalled queue goes warn, then down, and alerts once past the threshold", () => {
  const c = quiet(); c.tools.blueprint = { ...c.tools.blueprint, queued: 2, oldest_queued_at: min(12) };
  assert.equal(studioJobCards(c, now)[0].health, "warn");
  assert.match(studioJobCards(c, now)[0].note, /oldest waiting 12 min.*moving slowly/);
  assert.equal(studioAlerts(c, now).length, 0, "12 minutes is slow, not stalled");
  c.tools.blueprint.oldest_queued_at = min(45);
  const card = studioJobCards(c, now)[0];
  assert.equal(card.health, "down"); assert.match(card.note, /check the worker in Render/);
  const alerts = studioAlerts(c, now);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].type, "studio_queue_stalled"); assert.equal(alerts[0].severity, "critical"); assert.equal(alerts[0].payload.tool, "blueprint");
  c.tools.blueprint.running = 1;
  assert.equal(studioJobCards(c, now)[0].health, "warn", "something running means the worker is alive, just behind");
  assert.equal(studioAlerts(c, now).length, 0);
  assert.equal(studioAlerts(c, now, { queue_minutes: 5 }).length, 0, "config cannot alert while a job runs");
  c.tools.blueprint.running = 0;
  assert.equal(studioAlerts(c, now, { queue_minutes: 60 }).length, 0, "a rule row can loosen the threshold");
});

test("studio health: failure rate and webhook lag", () => {
  const c = quiet(); c.tools.recast = { ...c.tools.recast, done_24h: 4, failed_24h: 3 };
  const a = studioAlerts(c, now);
  assert.equal(a.length, 1); assert.equal(a[0].type, "studio_failure_rate"); assert.equal(a[0].severity, "warning"); assert.match(a[0].title, /43%/);
  const w = quiet(); w.webhook = { ...w.webhook, unprocessed_old: 1 };
  const cards = Object.fromEntries(studioJobCards(w, now).map((x) => [x.id, x]));
  assert.equal(cards.studio_stripe.health, "warn"); assert.match(cards.studio_stripe.note, /1 event unprocessed for over 10 min/);
  assert.equal(studioAlerts(w, now)[0].type, "studio_webhook_lag");
  const none = quiet(); none.webhook = { total: 0, latest_received_at: null, unprocessed_old: 0, errors_24h: 0 };
  assert.equal(studioJobCards(none, now)[2].health, "off");
  const stale = quiet(); stale.tools.recast.stale_running = 1;
  assert.equal(studioJobCards(stale, now)[1].health, "warn"); assert.match(studioJobCards(stale, now)[1].note, /1 lease expired/);
});

// A query stand-in that answers by table and by the filters applied, enough to exercise the collector's grouping.
function fakeSb(rows: Record<string, any[]>, fail = false) {
  return { from(table: string) {
    const f: ((r: any) => boolean)[] = []; let head = false, sort: { k: string; asc: boolean } | null = null, lim = Infinity;
    const q: any = {
      select(_c: string, o?: any) { head = !!o?.head; return q; }, order(k: string, o?: any) { sort = { k, asc: o?.ascending !== false }; return q; }, limit(n: number) { lim = n; return q; },
      in(k: string, v: any[]) { f.push((r) => v.includes(r[k])); return q; }, gte(k: string, v: any) { f.push((r) => r[k] != null && r[k] >= v); return q; },
      lt(k: string, v: any) { f.push((r) => r[k] != null && r[k] < v); return q; }, is(k: string, v: any) { f.push((r) => r[k] == v); return q; },
      not(k: string, _op: string, v: any) { f.push((r) => !(r[k] == v)); return q; },
      then(res: any) { if (fail) return res({ data: null, error: { message: "relation missing" } }); let out = (rows[table] ?? []).filter((r) => f.every((x) => x(r))); if (sort) out = [...out].sort((a, b) => (a[sort!.k] < b[sort!.k] ? -1 : a[sort!.k] > b[sort!.k] ? 1 : 0) * (sort!.asc ? 1 : -1)); out = out.slice(0, lim); return res({ data: head ? null : out, count: head ? out.length : null, error: null }); },
    };
    return q;
  } };
}
test("studio health: a provider-side failure (our balance or key) is a critical alert and takes the recast card down", () => {
  const c = quiet(); c.provider = { failures_1h: 1, latest_code: "recast_balance", latest_at: min(4), tools: ["trend"] };
  const a = studioAlerts(c, now);
  assert.equal(a.length, 1); assert.equal(a[0].type, "studio_provider_refused"); assert.equal(a[0].severity, "critical"); assert.match(a[0].body, /open\.higgsfield\.ai/);
  const cards = Object.fromEntries(studioJobCards(c, now).map((x) => [x.id, x]));
  assert.equal(cards.studio_recast.health, "down"); assert.match(cards.studio_recast.note, /refused our account 1 time/);
  const old = quiet(); old.provider = { failures_1h: 0, latest_code: null, latest_at: null, tools: [] };
  assert.equal(studioAlerts(old, now).length, 0);
});

test("studio health: the collector groups by tool and reads the webhook table; a missing table yields null", async () => {
  const rows = {
    studio_jobs: [
      { tool: "blueprint", status: "queued", created_at: min(3), lease_until: null },
      { tool: "blueprint", status: "running", created_at: min(20), lease_until: min(-5) },
      { tool: "recast", status: "running", created_at: min(30), lease_until: min(2) },
      { tool: "blueprint", status: "done", finished_at: min(60) }, { tool: "blueprint", status: "failed", finished_at: min(30) }, { tool: "recast", status: "done", finished_at: min(2000) },
      { tool: "trend", status: "failed", finished_at: min(10), error_code: "recast_balance" }, { tool: "swap", status: "failed", finished_at: min(90), error_code: "recast_balance" },
    ],
    studio_stripe_events: [
      { id: "evt_1", received_at: min(50), processed_at: min(50), error: null },
      { id: "evt_2", received_at: min(20), processed_at: null, error: null },
      { id: "evt_3", received_at: min(5), processed_at: null, error: null },
      { id: "evt_4", received_at: min(10), processed_at: min(10), error: "boom" },
    ],
  };
  const c = (await collectStudioHealth(fakeSb(rows), now))!;
  assert.deepEqual(c.tools.blueprint, { queued: 1, running: 1, stale_running: 0, oldest_queued_at: min(3), latest_finished_at: min(30), done_24h: 1, failed_24h: 1, total: 4 });
  assert.deepEqual(c.tools.recast, { queued: 0, running: 1, stale_running: 1, oldest_queued_at: null, latest_finished_at: null, done_24h: 0, failed_24h: 0, total: 2 }, "a finish older than a day does not count; an expired lease does");
  assert.deepEqual(c.webhook, { total: 4, latest_received_at: min(5), unprocessed_old: 1, errors_24h: 1 }, "only the event unprocessed for over 10 min counts as lagging");
  assert.deepEqual(c.provider, { failures_1h: 1, latest_code: "recast_balance", latest_at: min(10), tools: ["trend"] }, "only the last hour's provider refusals count");
  assert.equal(await collectStudioHealth(fakeSb(rows, true), now), null);
});
