import test from "node:test";
import assert from "node:assert/strict";
import { netPerCredit, creditValueFloor, creditsForCost, higgsfieldDiscount, studioCosts, planFeatureLines, unitEconomics, HIGGSFIELD_RATES, MARGIN_TARGET } from "../src/studio-pricing.js";
import { PLANS, COSTS, quote } from "../src/studio.js";

test("a credit's worth: Stripe's cut comes off first, the floor is the cheapest plan", () => {
  assert.ok(Math.abs(netPerCredit(79, 3500) - 0.02183) < 0.0001);
  assert.ok(Math.abs(creditValueFloor(PLANS) - 0.01612) < 0.0001, "Studio annual sets the floor");
});

test("prices are derived from cost at the margin target, never typed in", () => {
  const floor = creditValueFloor(PLANS);
  assert.equal(creditsForCost(0.681, floor), 85, "full Recast at 720p list");
  assert.equal(creditsForCost(0.20, floor), 25, "Light at its measured $0.20 a second");
  const c = studioCosts({}, PLANS);
  assert.deepEqual(c, { blueprint_copy: 4, blueprint_plus_copy: 12, recast_second: 85, recast_light_second: 25 });
  assert.deepEqual(COSTS, c, "the exported constant is the same derivation under the process environment");
  for (const [tool, credits, cost] of [["recast_second", c.recast_second, HIGGSFIELD_RATES.full["720p"]], ["recast_light_second", c.recast_light_second, HIGGSFIELD_RATES.light["720p"]]] as const) {
    const margin = (credits * floor - cost) / (credits * floor);
    assert.ok(margin >= MARGIN_TARGET, `${tool} keeps ${Math.round(margin * 100)}% at the floor`);
  }
});

test("a confirmed Higgsfield discount halves the Recast prices; nonsense values are ignored", () => {
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "0.5" }), 0.5);
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "banana" }), 0);
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "5" }), 0.9);
  const d = studioCosts({ HIGGSFIELD_DISCOUNT: "0.5" }, PLANS);
  assert.deepEqual([d.recast_second, d.recast_light_second], [43, 13]);
  const e = studioCosts({ HIGGSFIELD_DISCOUNT: "0.15" }, PLANS);
  assert.deepEqual([e.recast_second, e.recast_light_second], [72, 22], "the account's actual 15% discount");
  assert.equal(quote("recast", { character: "noah" }, { kind: "video", probe: { duration: 10 } }, d).credits, 430);
});

test("plan cards say what the credits buy, from the same numbers", () => {
  const lines = planFeatureLines(PLANS[1], studioCosts({}, PLANS));
  assert.deepEqual(lines, ["3,500 credits a month", "Blueprint: about 875 copies a month", "Recast: about 41 seconds a month (140 on Light)"]);
});

test("the economics sheet shows every plan and tool at or above the target", () => {
  const e = unitEconomics({}, PLANS);
  assert.equal(e.rows.length, PLANS.length * 2);
  for (const r of e.rows) for (const t of r.tools) assert.ok(t.margin >= MARGIN_TARGET - 0.001, `${r.plan} ${r.interval} ${t.tool} ${t.margin}`);
  assert.equal(e.resolution, "720p");
});
