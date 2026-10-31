import test from "node:test";
import assert from "node:assert/strict";
import { netPerCredit, creditValueFloor, creditsForCost, higgsfieldDiscount, studioCosts, planFeatureLines, unitEconomics, packsClearFloor, PACKS, HIGGSFIELD_RATES, MARGIN_TARGET, PREMIUM_MARGIN, marginForSecond, bestGrossPerCredit, creditsPerSecond, SOCIAL_ACCOUNTS, SOCIAL_SEAT_USD } from "../src/studio-pricing.js";
import { PLANS, COSTS, quote } from "../src/studio.js";

test("a credit's worth: Stripe's cut comes off first, the floor is the cheapest plan", () => {
  assert.ok(Math.abs(netPerCredit(79, 3500) - 0.02183) < 0.0001);
  assert.ok(Math.abs(creditValueFloor(PLANS) - 0.01612) < 0.0001, "Studio annual sets the floor");
});

test("prices are derived from cost, at 50% or (for expensive models) 20%, never typed in", () => {
  const floor = creditValueFloor(PLANS);
  assert.equal(creditsForCost(0.681, floor), 85, "full Recast at 720p list, at the standard margin");
  assert.equal(creditsForCost(0.681, floor, PREMIUM_MARGIN), 53, "and at the premium margin");
  const c = studioCosts({}, PLANS);
  assert.deepEqual({ ...c, credit_floor: undefined }, { blueprint_copy: 4, blueprint_plus_copy: 12, recast_second: 53, recast_light_second: 16, character_image: 12, credit_floor: undefined, light_margin: PREMIUM_MARGIN });
  assert.deepEqual(COSTS, studioCosts(process.env, PLANS), "the exported constant is the same derivation under the process environment");
  for (const [tool, credits, cost] of [["recast_second", c.recast_second, HIGGSFIELD_RATES.full["720p"]], ["recast_light_second", c.recast_light_second, HIGGSFIELD_RATES.light["720p"]]] as const) {
    const margin = (credits * floor - cost) / (credits * floor);
    assert.ok(margin >= PREMIUM_MARGIN, `${tool} keeps ${Math.round(margin * 100)}% at the floor`);
  }
});

test("the premium tier: 30 s that would cost a person $10 or more at 50% (on the cheapest credits) is sold at 20%", () => {
  const thirtyAt50 = (usd: number) => creditsForCost(usd * 30, creditValueFloor(PLANS), MARGIN_TARGET) * bestGrossPerCredit(PLANS);
  assert.equal(marginForSecond(0.463, PLANS), PREMIUM_MARGIN, `Seedance 2.5: $${thirtyAt50(0.463).toFixed(2)} for 30 s at 50%`);
  assert.equal(marginForSecond(0.20, PLANS), PREMIUM_MARGIN, `Genjutsu Light: $${thirtyAt50(0.2).toFixed(2)}`);
  assert.equal(marginForSecond(0.681, PLANS), PREMIUM_MARGIN, "Genjutsu full");
  assert.equal(marginForSecond(0.084, PLANS), MARGIN_TARGET, `Kling 3.0: $${thirtyAt50(0.084).toFixed(2)}`);
  assert.equal(marginForSecond(0.13, PLANS), MARGIN_TARGET, "MiniMax H3");
  assert.ok(thirtyAt50(0.163) >= 10 && marginForSecond(0.163, PLANS) === PREMIUM_MARGIN && marginForSecond(0.15, PLANS) === MARGIN_TARGET, "the line sits near $0.16 a second");
  assert.equal(creditsPerSecond(0.463, PLANS), 36);
});

test("a discount we get is our margin: prices stay at list whatever HIGGSFIELD_DISCOUNT says; nonsense values are ignored", () => {
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "0.5" }), 0.5);
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "banana" }), 0);
  assert.equal(higgsfieldDiscount({ HIGGSFIELD_DISCOUNT: "5" }), 0.9);
  for (const d of ["0.15", "0.5"]) assert.deepEqual(studioCosts({ HIGGSFIELD_DISCOUNT: d, HIGGSFIELD_SEEDANCE_DISCOUNT: d }, PLANS), studioCosts({}, PLANS), `a ${d} discount does not lower prices`);
  const e = unitEconomics({ HIGGSFIELD_DISCOUNT: "0.5" }, PLANS);
  const light = e.rows[0].tools.find((t) => t.tool === "recast_light_second")!;
  assert.ok(light.margin > unitEconomics({}, PLANS).rows[0].tools.find((t) => t.tool === "recast_light_second")!.margin, "the sheet shows the discount as extra margin");
  assert.equal(quote("recast", { character: "noah" }, { kind: "video", probe: { duration: 10 } }, studioCosts({ HIGGSFIELD_DISCOUNT: "0.5" }, PLANS)).credits, 11 * 53, "a 10 s file bills 11 at Higgsfield, at list");
});

test("social accounts: 1, 3 and 10 with the plan; an extra one is $19 a month ($17 on annual), 50% over the posting service's $8.99", () => {
  assert.deepEqual(SOCIAL_ACCOUNTS, { starter: 1, creator: 3, studio: 10 });
  for (const [price, cost] of [[SOCIAL_SEAT_USD.month, 8.99], [SOCIAL_SEAT_USD.year_per_month, 7.99]]) assert.ok((price * 0.971 - cost) / (price * 0.971) >= 0.5, `${price} keeps half after Stripe`);
});

test("plan cards state the credits only; copies and seconds are not promised per plan", () => {
  const lines = planFeatureLines(PLANS[1], studioCosts({}, PLANS));
  assert.deepEqual(lines, ["3,500 credits a month"]);
});

test("the economics sheet shows every plan and tool at or above its tier's target", () => {
  const e = unitEconomics({}, PLANS);
  assert.equal(e.rows.length, PLANS.length * 2);
  for (const r of e.rows) for (const t of r.tools) { const target = (t as any).tier_margin ?? MARGIN_TARGET; assert.ok(t.margin >= target - 0.001, `${r.plan} ${r.interval} ${t.tool} ${t.margin} (target ${target})`); }
  assert.equal(e.resolution, "720p");
});

test("credit packs never undercut the plans' per-credit value", () => {
  assert.ok(packsClearFloor(PLANS));
  for (const p of PACKS) assert.ok(netPerCredit(p.usd, p.credits) > creditValueFloor(PLANS), p.id);
  assert.deepEqual(PACKS.map((p) => p.credits), [500, 2000, 6000]);
});
