// The cost-ledger audit fixes (Nov 24 2026, docs/costs/AUDIT_2026-11-24.md): every run's costs carry the run, the
// daily Stripe-fee and fixed-bill rows, the Claude rate fixes, Scribe outside Live Clips.
import test from "node:test";
import assert from "node:assert/strict";
import { bufferedCostsForTests, initCosts, recordCost, resetCostsForTests, withCostRun } from "../src/studio-costs.js";
import { initEvents, resetEventsForTests } from "../src/studio-events.js";
import { logClaudeCost } from "../src/studio-pricing.js";
import { recordScribe, STT_RATES } from "../src/studio-stt.js";
import { DEFAULT_FIXED_BILLS, fixedBillRows, fixedBills, stripeFeeRows } from "../src/cost-overheads.js";

const JOB = "11111111-1111-4111-8111-111111111111", USER = "22222222-2222-4222-8222-222222222222";
const fakeSb = () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) as any;
function fresh() { resetCostsForTests(); resetEventsForTests(); initCosts(fakeSb); initEvents(fakeSb); }

test("inside a run, every cost carries the job, its person and its tool: a direct row, a Claude call and a vendor event", async () => {
  fresh();
  await withCostRun({ job_id: JOB, user_id: USER, tool: "reshoot" }, async () => {
    await Promise.resolve();
    recordCost({ provider: "higgsfield", product: "x", source: "render", usd: 1, basis: "list" });
    logClaudeCost(undefined, "reshoot_check", "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 100 }, USER);
    recordScribe({ userId: USER, seconds: 3600, use: "captions" });
  });
  recordCost({ provider: "higgsfield", product: "outside", source: "x", usd: 1, basis: "list" });
  const rows = bufferedCostsForTests();
  assert.equal(rows.length, 4);
  for (const r of rows.slice(0, 3)) assert.deepEqual([r.job_id, r.user_id, r.tool], [JOB, USER, "reshoot"], r.source);
  assert.equal(rows[3].job_id, null, "outside a run: no job");
  const scribe = rows.find((r) => r.provider === "elevenlabs_scribe")!;
  assert.equal(scribe.usd, STT_RATES.scribe, "an hour of sound at the one Scribe rate");
  assert.equal(STT_RATES.scribe, 0.22, "the rate prices are built on");
  resetCostsForTests(); resetEventsForTests();
});

test("Claude rates: Sonnet 5.5 cache reads at $0.10 (they were counted at $0.20), Haiku 5.5 over 100K tokens at 5x, fallback models as themselves", () => {
  fresh();
  logClaudeCost(undefined, "t", "claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  logClaudeCost(undefined, "t", "claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1000 });
  logClaudeCost(undefined, "t", "claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1000 });
  logClaudeCost(undefined, "t", "claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 });
  logClaudeCost(undefined, "t", "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 });
  const usd = bufferedCostsForTests().map((r) => r.usd);
  assert.equal(usd[0], 0.1);
  assert.equal(usd[1], 0.0055, "50K in at $0.10 + 1K out at $0.50");
  assert.equal(usd[2], 0.0775, "150K in at $0.50 + 1K out at $2.50");
  assert.equal(usd[3], 5, "Opus 5 is $5 in, not Opus 5.5's $4");
  assert.equal(usd[4], 4);
  resetCostsForTests(); resetEventsForTests();
});

test("fixed bills: a day's share of each monthly bill, less what that day's runs already booked against it, never below zero", () => {
  const share = (m: number) => Math.round(((m * 12) / 365) * 1e6) / 1e6;
  const rows = fixedBillRows("2026-11-23", DEFAULT_FIXED_BILLS, (b) => (b.id === "render-kage" ? 1.5 : b.id === "elevenlabs-plan" ? 99 : 0));
  const by = Object.fromEntries(rows.map((r) => [r.ref, r]));
  assert.equal(by["fixed:render-backend:2026-11-23"].usd, share(85));
  assert.equal(by["fixed:render-kage:2026-11-23"].usd, Math.round((share(175) - 1.5) * 1e6) / 1e6, "idle time only");
  assert.equal(by["fixed:elevenlabs-plan:2026-11-23"].usd, 0, "runs used more than the day's share: nothing more");
  assert.ok(rows.every((r) => r.writer === "cost-overheads" && r.source === "fixed monthly bill"));
  assert.equal(by["fixed:render-backend:2026-11-23"].spent_at, "2026-11-23T08:00:00.000Z", "midnight Pacific");
  // the owner's invoices: add a bill, replace one, remove one
  const env = { STUDIO_FIXED_BILLS: JSON.stringify([{ id: "vercel", provider: "vercel", product: "Pro team", usd_month: 20 }, { id: "render-backend", usd_month: 92.5, basis: "invoice" }, { id: "render-blueprint", usd_month: 0 }]) };
  const bills = fixedBills(env);
  assert.equal(bills.find((b) => b.id === "vercel")?.basis, "invoice");
  assert.equal(bills.find((b) => b.id === "render-backend")?.usd_month, 92.5);
  assert.equal(bills.find((b) => b.id === "render-blueprint"), undefined);
  assert.equal(fixedBills({ STUDIO_FIXED_BILLS: "not json" }).length, DEFAULT_FIXED_BILLS.length, "a broken setting keeps the defaults");
});

test("Stripe: the real fee on each payment with its person, Stripe's own charges, nothing for a payout", () => {
  const rows = stripeFeeRows([
    { id: "txn_1", type: "charge", amount: 2900, fee: 114, created: 1795500000, fee_details: [{ type: "stripe_fee" }], source: { customer: "cus_A" } },
    { id: "txn_2", type: "stripe_fee", amount: -45, fee: 0, created: 1795500000, description: "Billing - Usage Fee" },
    { id: "txn_3", type: "payout", amount: -4500, fee: 0 },
    { id: "txn_4", type: "payment", amount: 2900, fee: 132, source: { customer: { id: "cus_B" } } },
  ], (c) => (c === "cus_A" ? USER : null));
  assert.deepEqual(rows.map((r) => [r.ref, r.usd, r.user_id ?? null, r.basis]), [["stripe:txn_1", 1.14, USER, "metered"], ["stripe:txn_2", 0.45, null, "metered"], ["stripe:txn_4", 1.32, null, "metered"]]);
  assert.equal(rows[1].product, "Billing - Usage Fee");
});

import { recordRender } from "../src/studio-caption-video.js";
import { backendUsdPerSecond } from "../src/cost-overheads.js";
test("Captions: a render's seconds on the backend server are booked to its run; the day's server bill books only the rest", async () => {
  fresh();
  await withCostRun({ job_id: JOB, user_id: USER, tool: "captions" }, async () => { recordRender(24_000, 23.4); recordRender(0, 10); });
  const rows = bufferedCostsForTests().filter((r) => r.source === "captions_render");
  assert.equal(rows.length, 1, "nothing booked for no render time");
  const r = rows[0];
  assert.equal(r.job_id, JOB); assert.equal(r.user_id, USER); assert.equal(r.tool, "captions"); assert.equal(r.provider, "render"); assert.equal(r.writer, "backend");
  assert.deepEqual(r.units, { seconds: 24, video_seconds: 23.4 });
  assert.equal(r.usd, Math.round(24 * backendUsdPerSecond() * 1e6) / 1e6);
  assert.ok(r.usd > 0.0007 && r.usd < 0.0009, "about $0.0008 for 24 s of an $85-a-month machine");
  // the bill subtracts what runs booked on this server (provider render, written by the backend)
  const bill = DEFAULT_FIXED_BILLS.find((b) => b.id === "render-backend")!;
  assert.deepEqual(bill.minus, { providers: ["render"], writer: "backend" });
  const share = Math.round(((85 * 12) / 365) * 1e6) / 1e6;
  const day = fixedBillRows("2026-11-24", [bill], () => 0.5)[0];
  assert.equal(day.usd, Math.round((share - 0.5) * 1e6) / 1e6);
});

test("Captions: words heard for the editor (no run) still count as Captions", () => {
  fresh();
  recordScribe({ userId: USER, seconds: 36, use: "captions", tool: "captions" });
  const r = bufferedCostsForTests().find((x) => x.provider === "elevenlabs_scribe")!;
  assert.equal(r.tool, "captions"); assert.equal(r.job_id, null);
  assert.equal(r.usd, Math.round((36 / 3600) * STT_RATES.scribe * 1e6) / 1e6);
});

test("a busy day's rows are read in pages, so its fixed-bill rows are written once, not on every start (Nov 28 2026)", async () => {
  const { bookOverheads } = await import("../src/cost-overheads.js");
  // 2,500 run rows on the day, then the day's own overhead rows: the API gives 1,000 a request
  const table: any[] = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, ref: null, provider: "claude", writer: "backend", usd: 0.01 }));
  const sb: any = { from: () => ({
    select: () => { let lo = 0, hi = 999, only: string[] | null = null;
      const q: any = { gte: () => q, lt: () => q, order: () => q, eq: () => q, in: (_k: string, v: string[]) => { only = v; return q; }, range: (a: number, b: number) => { lo = a; hi = b; return q; },
        then: (ok: any) => ok({ data: (only ? table.filter((r) => only!.includes(r.ref)) : table.slice(lo, hi + 1)).map((r) => ({ ...r })), error: null }) };
      return q; },
    insert: async (rows: any[]) => { for (const r of rows) table.push({ id: table.length + 1, ...r }); return { error: null }; } }) };
  const first = await bookOverheads(sb, "2026-11-18", { env: {} });
  assert.ok(first.fixed >= 4, "the day's fixed bills are written");
  const again = await bookOverheads(sb, "2026-11-18", { env: {} });
  assert.deepEqual([again.fixed, again.stripe, again.usd], [0, 0, 0], "a second run writes nothing");
  assert.equal(table.filter((r) => r.writer === "cost-overheads").length, first.fixed);
});
