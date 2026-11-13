// The cost-vs-price report for films written in a chat (src/studio-byo-report.ts): real costs from the ledger, the
// shadow grader kept apart, margins, drift alerts, the suggested price, quality per model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { byoReport, modelOf } from "../src/studio-byo-report.ts";
import { PLANS } from "../src/studio.ts";
import { creditValueFloor, creditsForCost } from "../src/studio-pricing.ts";

const ENV = { STUDIO_STORY_PREMIUM_ENABLED: "true", STUDIO_STORY_BYO_ENABLED: "true", STUDIO_STORY_BYO_COST_USD: "1.2", STUDIO_STORY_BYO_MARGIN: "0.532" };
const film = (id: string, credits: number, report: string, final: { pass: number; of: number }, extra: any = {}) => ({ id, user_id: "owner", status: "done", credits_charged: credits, created_at: "2026-11-13T19:04:17Z", finished_at: "2026-11-13T19:51:52Z",
  options: { cost_usd: 1.2, cost_cap_usd: 1.32, story: { byo: true } }, outputs: [{ premium: { report, final, repaired: false, minutes: { script: 0.7, scene: 39.5, check: 1.7, render: 4.8 } } }], ...extra });

test("the two live films: real costs from the ledger, the shadow apart, margins on the cheapest credit", () => {
  const jobs = [film("98e80f35-aaaa", 192, "WHAT EACH LINE SHOWS ...", { pass: 15, of: 15 }), film("a786dfe5-bbbb", 150, "Model: Claude Sonnet 5.5\nall fine", { pass: 13, of: 15 })];
  const costs = [{ job_id: "98e80f35-aaaa", source: "hand-grade", usd: 0.411 }, { job_id: "98e80f35-aaaa", source: "render: Hand", usd: 0.643 },
    { job_id: "a786dfe5-bbbb", source: "hand-grade", usd: 0.47 }, { job_id: "a786dfe5-bbbb", source: "render: Hand", usd: 0.421 }, { job_id: "a786dfe5-bbbb", source: "hand-grade-shadow", usd: 0.4 }];
  const r = byoReport(jobs, costs, [], ENV);
  const s = r.films.find((f) => f.id === "a786dfe5-bbbb")!;
  assert.equal(s.cost_usd, 0.891, "the shadow check is not the film's cost"); assert.equal(s.shadow_usd, 0.4); assert.equal(s.model, "Claude Sonnet 5.5");
  const floor = creditValueFloor(PLANS); assert.equal(s.floor_margin, Math.round((1 - 0.891 / (150 * floor)) * 10000) / 10000);
  assert.equal(r.films.find((f) => f.id === "98e80f35-aaaa")!.model, null, "a report without the model line");
  assert.equal(r.summary.done, 2); assert.equal(r.summary.worst_usd, 1.054); assert.equal(r.summary.shadow_usd, 0.4);
  assert.equal(r.price.now, 160, "the live price"); assert.equal(r.price.basis, "dearest film so far"); assert.equal(r.price.suggested, creditsForCost(1.054, floor, 0.5));
  assert.deepEqual(r.alerts, [], "both films above 50 %, too few films to call a drift");
  assert.deepEqual(r.models.map((m) => m.model).sort(), ["Claude Sonnet 5.5", "not named"]);
});

test("alerts: a film under the floor, over its ceiling, and costs drifting from the estimate", () => {
  const jobs = [1, 2, 3, 4, 5].map((k) => film(`f${k}`, 160, "Model: X", { pass: 14, of: 15 }));
  const costs = jobs.map((j, k) => ({ job_id: j.id, source: "render: Hand", usd: k === 4 ? 1.5 : 1.4 }));
  const r = byoReport(jobs, costs, [], ENV);
  assert.ok(r.alerts.some((a) => a.level === "bad" && /under the 45 % floor/.test(a.text)), "a film under 45 % on the cheapest credit");
  assert.ok(r.alerts.some((a) => /over its \$1\.32 ceiling/.test(a.text)));
  assert.ok(r.alerts.some((a) => /above the \$1\.20 the price is set from/.test(a.text)), "costs 17 % above the estimate");
  assert.equal(r.price.basis, "90th percentile"); assert.ok((r.price.suggested ?? 0) > r.price.now, "the suggestion follows the real costs up");
  assert.equal(modelOf("  model: Claude Fable 5.2.\nrest"), "Claude Fable 5.2"); assert.equal(modelOf("no model here"), null);
});
