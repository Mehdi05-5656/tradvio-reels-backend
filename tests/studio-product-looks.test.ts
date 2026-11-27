import test from "node:test";
import assert from "node:assert/strict";
import { LOOKS, PRODUCT_CATEGORIES, fitsCategory, lookById, lookChoices, lookRequest, lookSfx, looksFor, publicLook, withLookRecipe, LookError } from "../src/studio-product-looks.js";
import { instrumentById, validateParams, validateInputs } from "../src/studio-instruments.js";
import { normalFacts, readShopPage } from "../src/studio-products.js";

const ENV = { HIGGSFIELD_API_KEY: "id:secret", STUDIO_INSTRUMENTS_ENABLED: "true" };
const IMG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", EXP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FACTS = normalFacts({ name: "SURGE energy drink", category: "beverage", colour: "cobalt blue" });

test("every look runs on a catalog model, and its recipe passes that model's own checks", () => {
  const ids = new Set<string>();
  for (const l of LOOKS) {
    assert.ok(!ids.has(l.id), `${l.id} twice`); ids.add(l.id);
    const inst = instrumentById(l.endpoint, ENV, { preview: true });
    assert.ok(inst, `${l.id}: ${l.endpoint} is not in the catalog`);
    const raw = l.id === "move-custom" ? { motion: "The can opens by itself and cold fizz sprays up into the light.", sfx: "can opening with fizz" } : {};
    const req = lookRequest(l, { product: IMG, exploded: EXP }, lookChoices(l, FACTS, raw));
    assert.doesNotThrow(() => validateParams(inst!, req.params), `${l.id}: the recipe does not pass ${l.endpoint}`);
    assert.doesNotThrow(() => validateInputs(inst!, req.inputs), `${l.id}: its inputs are not media fields of ${l.endpoint}`);
    assert.equal(inst!.output, l.kind === "shot" ? "image" : "video", `${l.id}: wrong output kind`);
    assert.ok(!/\{(colour|motion|sfx)\}/.test(req.params.prompt), `${l.id}: a slot was left in the prompt`);
    // the leaders' rules: every recipe says what must not change
    assert.match(req.params.prompt, /never invent/i, `${l.id}: no label-keeping clause`);
    if (l.kind === "motion") { assert.match(req.params.prompt, /No hands, no people/); assert.ok(l.sfx, `${l.id}: motion without a sound`); }
  }
});

test("looks follow the product's category: no pour for a sneaker, nothing physical for an app", () => {
  const pop = lookById("move-pop")!;
  assert.ok(fitsCategory(pop, "beverage"));
  assert.ok(!fitsCategory(pop, "footwear"));
  const app = looksFor("app", { admin: true });
  assert.ok(app.every((l) => l.fits !== "all" ? (l.fits as string[]).includes("app") : false), "an app only gets looks made for apps");
  for (const c of PRODUCT_CATEGORIES.filter((x) => x !== "app")) assert.ok(looksFor(c, { admin: true }).some((l) => l.kind === "shot"), `${c} has no shot looks`);
  assert.equal(looksFor("beverage").length, 0, "drafts (no example yet) are admins only");
});

test("the page never gets the recipe, the prompt or the sound words", () => {
  for (const l of LOOKS) {
    const p: any = publicLook(l);
    assert.equal(p.recipe, undefined); assert.equal(p.endpoint, undefined); assert.equal(p.sfx, undefined);
    assert.ok(!JSON.stringify(p).includes("never invent"));
  }
});

test("describe your own: needs a planned motion; it is cleaned and can run on the camera model", () => {
  const custom = lookById("move-custom")!;
  assert.throws(() => lookChoices(custom, FACTS, {}), (e: any) => e instanceof LookError && e.code === "look_motion_required");
  const c = lookChoices(custom, FACTS, { motion: 'Lava pours over it "slowly"\u0000 and cools {into stone}', sfx: "a deep lava gurgle", engine: "camera" });
  assert.ok(!/["{}\u0000]/.test(c.motion));
  const params = withLookRecipe("move-custom", c);
  assert.match(params.prompt, /Lava pours over it slowly and cools into stone/);
  assert.equal(params.resolution, "720p", "camera moves run on Kling 4.0 (resolution is its setting)");
  assert.equal(lookSfx("move-custom", c), "a deep lava gurgle");
  assert.equal(lookSfx("shot-white", {}), null);
});

test("an assemble move needs the exploded view first, and ends on the product", () => {
  const l = lookById("move-assemble")!;
  assert.throws(() => lookRequest(l, { product: IMG, exploded: null }, {}), (e: any) => e instanceof LookError && e.code === "look_input_required");
  const r = lookRequest(l, { product: IMG, exploded: EXP }, {});
  assert.equal(r.inputs.image_url, EXP); assert.equal(r.inputs.end_image_url, IMG);
});

test("the brand colour fills the hero backdrop; a missing colour falls back to neutral", () => {
  assert.match(withLookRecipe("shot-brand", { colour: "cobalt blue" }).prompt, /cobalt blue/);
  assert.match(withLookRecipe("shot-brand", {}).prompt, /a soft neutral/);
});

test("facts are trimmed to known categories and short words", () => {
  const f = normalFacts({ name: "  x".repeat(100), category: "spaceship", label_text: "A\u0000B" });
  assert.equal(f.category, "other"); assert.ok(f.name.length <= 60); assert.equal(f.label_text, "AB");
});

test("a shop page: the product picture, name and price come from JSON-LD first, then Open Graph", () => {
  const ld = `<html><head><title>Shop</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"SURGE Zero 12-pack","image":["/img/surge.jpg"],"description":"Citrus energy drink","offers":{"@type":"Offer","price":"24.99","priceCurrency":"USD"}}</script></head></html>`;
  const a = readShopPage(ld, "https://shop.example.com/p/1");
  assert.equal(a.image, "https://shop.example.com/img/surge.jpg"); assert.equal(a.title, "SURGE Zero 12-pack"); assert.equal(a.price, "24.99 USD");
  const og = `<meta property="og:title" content="Kova Court &amp; Street"><meta content="https://cdn.example.com/k.png" property="og:image"><meta property="product:price:amount" content="89">`;
  const b = readShopPage(og, "https://kova.example.com/x");
  assert.equal(b.image, "https://cdn.example.com/k.png"); assert.equal(b.title, "Kova Court & Street"); assert.equal(b.price, "89");
  assert.equal(readShopPage("<html></html>", "https://x.example.com").image, null);
});

test("TikTok Shop's own page: price from its page data when there is no JSON-LD", () => {
  const html = `<meta property="og:title" content="HydroJug Sport"><meta property="og:image" content="https://p16.example/x.jpg"><script>{"price":{"real_price":"$71.49","currency":"USD"}}</script>`;
  const r = readShopPage(html, "https://shop.tiktok.com/us/pdp/hydrojug/1729603435380839162");
  assert.equal(r.price, "$71.49");
  assert.equal(r.title, "HydroJug Sport");
});
