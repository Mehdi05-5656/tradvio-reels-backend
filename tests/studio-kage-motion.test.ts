import { test } from "node:test";
import assert from "node:assert/strict";
import { KageMotionError, kageMotionCostUsd, kageMotionCredits, parseKageMotionOptions, quoteKageMotion } from "../src/studio-kage-motion.ts";
import { KAGE_PRESET_CATEGORIES, KAGE_PRESETS } from "../src/studio-kage-presets.ts";

const PLANS = [{ id: "starter", monthly_usd: 19, annual_usd_per_month: 15, credits: 1000 }, { id: "creator", monthly_usd: 49, annual_usd_per_month: 39, credits: 3000 }];
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const fakeSb = (rows: any[]) => ({ from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: rows, error: null }) }) }) }) }) as any;

test("brief is required, trimmed and bounded; defaults fill the rest", () => {
  assert.throws(() => parseKageMotionOptions({ brief: "short" }), KageMotionError);
  assert.throws(() => parseKageMotionOptions({ brief: "x".repeat(1300) }), KageMotionError);
  const o = parseKageMotionOptions({ brief: "  A launch film   for our new app  " });
  assert.equal(o.brief, "A launch film for our new app");
  assert.deepEqual([o.look, o.seconds, o.style, o.voice, o.images.length], ["auto", 16, "kinetic", "katana", 0]);
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", style: "narrator" }).style, "kinetic", "one Kage: older style values become kinetic");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", seconds: 40, look: "neon", style: "creator", voice: "other" }).seconds, 20);
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "male" }).voice, "male");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "other" }).voice, "katana");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "katana" }).voice, "katana");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "naomi" }).voice, "naomi");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "jessica" }).voice, "jessica");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", voice: "henry" }).voice, "henry");
  assert.equal(o.aspect, "16:9", "widescreen by default (the reference films' shape)");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", aspect: "9:16" }).aspect, "9:16");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", aspect: "4:3" }).aspect, "16:9", "an unknown shape falls back to widescreen");
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", look: "nope" }).look, "auto");
});

test("images need valid ids and confirmed rights; duplicates collapse; kinds default to photo", () => {
  assert.throws(() => parseKageMotionOptions({ brief: "A launch film for our app", images: [{ asset_id: "x" }], rights_confirmed: true }), /not in your library/);
  assert.throws(() => parseKageMotionOptions({ brief: "A launch film for our app", images: [{ asset_id: A }] }), /permission/);
  const o = parseKageMotionOptions({ brief: "A launch film for our app", images: [{ asset_id: A, kind: "logo", note: "our mark" }, { asset_id: A }, { asset_id: B, kind: "weird" }], rights_confirmed: true });
  assert.deepEqual(o.images.map((i) => [i.asset_id, i.kind, i.note]), [[A, "logo", "our mark"], [B, "photo", null]]);
  assert.throws(() => parseKageMotionOptions({ brief: "A launch film for our app", images: Array.from({ length: 7 }, (_, i) => ({ asset_id: `${i}1111111-1111-4111-8111-111111111111` })), rights_confirmed: true }), /Up to 6/);
});

test("the quote is off unless switched on, checks ownership and kind, and prices from cost at the margin", async () => {
  await assert.rejects(quoteKageMotion(fakeSb([]), "u", {}, PLANS, { brief: "A launch film for our app" }), /not switched on/);
  const env = { STUDIO_KAGE_MOTION_ENABLED: "true", KAGE_MOTION_MATERIAL: "on" };
  // material paused (the default): pictures and clips are dropped before anything is checked, no rights needed
  const off = await quoteKageMotion(fakeSb([]), "u", { STUDIO_KAGE_MOTION_ENABLED: "true" }, PLANS, { brief: "A launch film for our app", images: [{ asset_id: A }] });
  assert.equal(off.options.images.length, 0);
  assert.equal(off.options.rights_confirmed, false);
  assert.doesNotMatch(off.summary, /picture|clip/);
  const q = await quoteKageMotion(fakeSb([]), "u", env, PLANS, { brief: "A launch film for our app", look: "paper" });
  assert.equal(q.tool, "kage_motion");
  assert.ok(q.credits > 0 && Number.isInteger(q.credits));
  assert.match(q.summary, /16 s film · widescreen 16:9 · paper look · narrated by Kage/);
  const qn = await quoteKageMotion(fakeSb([]), "u", env, PLANS, { brief: "A launch film for our app", voice: "naomi" });
  assert.match(qn.summary, /narrated by Naomi/);
  for (const [voice, name] of [["jessica", "Jessica"], ["henry", "Henry"]]) assert.match((await quoteKageMotion(fakeSb([]), "u", env, PLANS, { brief: "A launch film for our app", voice })).summary, new RegExp(`narrated by ${name}`));
  assert.equal(q.options.cost_usd, 4.5);
  await assert.rejects(quoteKageMotion(fakeSb([]), "u", env, PLANS, { brief: "A launch film for our app", images: [{ asset_id: A }], rights_confirmed: true }), /not in your library/);
  await assert.rejects(quoteKageMotion(fakeSb([{ id: A, kind: "audio", status: "ready" }]), "u", env, PLANS, { brief: "A launch film for our app", images: [{ asset_id: A }], rights_confirmed: true }), /pictures and video clips/);
  const ok = await quoteKageMotion(fakeSb([{ id: A, kind: "image", status: "ready" }]), "u", env, PLANS, { brief: "A launch film for our app", images: [{ asset_id: A, kind: "product", start: 4 }], rights_confirmed: true });
  assert.match(ok.summary, /· 1 picture$/);
  assert.equal(ok.options.images[0].start, undefined, "a picture has no start time");
  const dearer = kageMotionCredits({ ...env, KAGE_MOTION_COST_USD: "9" }, PLANS);
  assert.ok(dearer > q.credits);
  assert.equal(kageMotionCostUsd({ KAGE_MOTION_COST_USD: "-1" }), 4.5);
});

test("video clips: taken as footage, product or screen recordings, up to 3, with a start inside the clip", async () => {
  const env = { STUDIO_KAGE_MOTION_ENABLED: "true", KAGE_MOTION_MATERIAL: "on" };
  const C = "33333333-3333-4333-8333-333333333333", D = "44444444-4444-4444-8444-444444444444";
  const rows = [{ id: A, kind: "image", status: "ready" }, { id: B, kind: "video", status: "ready", probe: { duration: 30 } }, { id: C, kind: "video", status: "ready", probe: { duration: 8 } }];
  const q = await quoteKageMotion(fakeSb(rows), "u", env, PLANS, { brief: "A launch film for our app", images: [{ asset_id: A, kind: "logo" }, { asset_id: B, kind: "footage", start: 12.34 }, { asset_id: C, kind: "screenshot" }], rights_confirmed: true });
  assert.match(q.summary, /· 1 picture · 2 clips$/);
  assert.deepEqual(q.options.images.map((i) => [i.kind, i.start]), [["logo", undefined], ["footage", 12.3], ["screenshot", undefined]]);
  await assert.rejects(quoteKageMotion(fakeSb(rows), "u", env, PLANS, { brief: "A launch film for our app", images: [{ asset_id: C, kind: "footage", start: 9 }], rights_confirmed: true }), /past its end/);
  const many = [B, C, D, "55555555-5555-4555-8555-555555555555"].map((id) => ({ id, kind: "video", status: "ready" }));
  await assert.rejects(quoteKageMotion(fakeSb(many), "u", env, PLANS, { brief: "A launch film for our app", images: many.map((m) => ({ asset_id: m.id, kind: "footage" })), rights_confirmed: true }), /Up to 3 video clips/);
  assert.equal(parseKageMotionOptions({ brief: "A launch film for our app", images: [{ asset_id: B, kind: "footage" }], rights_confirmed: true }).images[0].kind, "footage");
});

test("a preset and a variant ride along; an unknown preset is refused", () => {
  const o = parseKageMotionOptions({ brief: "A launch film for a hoodie made of heavyweight cotton", preset: "landing-hero", variant: 2 });
  assert.equal(o.preset, "landing-hero");
  assert.equal(o.variant, 2);
  const plain = parseKageMotionOptions({ brief: "A launch film for a hoodie made of heavyweight cotton" });
  assert.equal(plain.preset, undefined);
  assert.equal(plain.variant, undefined);
  assert.throws(() => parseKageMotionOptions({ brief: "A launch film for a hoodie made of heavyweight cotton", preset: "nope" }), /template/);
  assert.equal(parseKageMotionOptions({ brief: "A launch film for a hoodie made of heavyweight cotton", variant: 9 }).variant, undefined);
});

test("the presets the picker shows match the worker's ids", () => {
  const ids = KAGE_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  // the worker's catalogue (kage-motion/src/kit/presets.ts) has the same ids
  for (const id of ["brutal-promo", "the-bet", "product-drop", "landing-hero", "tiktok-hook", "luxe-editorial", "stat-attack", "app-walkthrough"]) assert.ok(ids.includes(id), id);
  for (const p of KAGE_PRESETS) assert.ok(KAGE_PRESET_CATEGORIES.some((c) => c.id === p.category), `${p.id} category`);
});

test("a music-only template says so in the quote", async () => {
  const q = await quoteKageMotion(fakeSb([]), A, { STUDIO_KAGE_MOTION_ENABLED: "true" }, PLANS, { brief: "Northline heavyweight hoodie, 480 gsm brushed cotton, $120", preset: "landing-hero" });
  assert.match(q.summary, /set to music, no narrator/);
  assert.match(q.summary, /^Landing hero/);
});
