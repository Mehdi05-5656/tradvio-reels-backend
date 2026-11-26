import test from "node:test";
import assert from "node:assert/strict";
import { isTikTokShopUrl, productImages, readTikTokProduct, shopIssues, SHOP_DISCLOSURE } from "../src/studio-shop.js";
import { endCardAss } from "../src/studio-ads.js";
import { HOOK_FORMATS } from "../src/studio-hooks.js";
import { LOOKS } from "../src/studio-product-looks.js";
import { normalFacts } from "../src/studio-products.js";

test("TikTok Shop links are recognised in the forms people paste; other pages are not", () => {
  for (const u of ["https://www.tiktok.com/shop/pdp/surge-energy/1729384756", "https://shop.tiktok.com/view/product/1729384756?region=US", "https://vt.tiktok.com/ZSabc123/", "https://www.tiktok.com/view/product/1729384756"]) assert.ok(isTikTokShopUrl(u), u);
  for (const u of ["https://www.tiktok.com/@someone/video/123", "https://www.amazon.com/dp/B0X", "not a url", "https://tiktok.com.evil.example/shop/pdp/1"]) assert.ok(!isTikTokShopUrl(u), u);
});

test("a shop product read: title, pictures, price and words found wherever the response keeps them", () => {
  const body = { success: true, product: { product_base: { title: "SURGE Zero Sugar Energy Drink 12-Pack", images: [{ url_list: ["https://p16.example/img/a.jpeg", "https://p16.example/img/a2.jpeg"] }, { url_list: ["https://p16.example/img/b.jpeg"] }],
    price: { real_price: "24.99", currency: "USD" }, desc: "<p>Electric citrus flavour, zero sugar, 160mg caffeine.</p>" }, seller: { name: "SURGE Official", avatar: { url_list: ["https://p16.example/avatar.jpeg"] } }, video: { play_url: "https://v.example/x.mp4" } } };
  const r = readTikTokProduct(body);
  assert.equal(r.title, "SURGE Zero Sugar Energy Drink 12-Pack");
  assert.deepEqual(r.images, ["https://p16.example/img/a.jpeg", "https://p16.example/img/a2.jpeg", "https://p16.example/img/b.jpeg"], "no avatar, no video");
  assert.equal(r.price, "24.99 USD");
  assert.equal(r.text, "Electric citrus flavour, zero sugar, 160mg caffeine.");
  assert.deepEqual(productImages({ data: { cover: "https://x.example/c.jpg" } }), ["https://x.example/c.jpg"]);
  assert.equal(readTikTokProduct({}).title, null);
});

test("Shop-safe checks: animated product clips and an ad with no person are stopped; surreal shots and risky offers are warned", () => {
  const block = (p: any, e: any = null) => shopIssues(p, e).filter((i) => i.blocking).map((i) => i.code);
  assert.deepEqual(block([{ kind: "hook", shop_safe: true }, { kind: "shot", shop_safe: true }]), []);
  assert.deepEqual(block([{ kind: "hook", shop_safe: true }, { kind: "clip", shop_safe: false }]), ["shop_animated_product"]);
  assert.deepEqual(block([{ kind: "shot", shop_safe: true }]), ["shop_needs_person"]);
  const warn = shopIssues([{ kind: "hook", shop_safe: true }, { kind: "shot", shop_safe: false }], { line: null, offer: "Best price, guaranteed" }).filter((i) => !i.blocking).map((i) => i.code);
  assert.deepEqual(warn, ["shop_surreal_shot", "shop_claim"]);
});

test("in Shop-safe mode the end card discloses AI, small and apart from the person's words", () => {
  const a = endCardAss("SURGE", null, 2.5, SHOP_DISCLOSURE);
  assert.match(a, /Style: Note,Poppins SemiBold,34/); assert.match(a, /,Note,,0,0,0,,AI-generated/);
  assert.ok(!/AI-generated/.test(endCardAss("SURGE", null, 2.5)));
});

test("what Shop-safe mode leaves: every hook format, realistic shots only, no product animation; the flag is kept", () => {
  assert.ok(HOOK_FORMATS.every((f) => f.shop_safe));
  for (const id of ["showcase", "three", "unbox"]) assert.ok(HOOK_FORMATS.some((f) => f.id === id), id);
  assert.ok(LOOKS.filter((l) => l.kind === "motion").every((l) => !l.shop_safe));
  for (const id of ["shot-float", "shot-splash", "shot-exploded", "shot-billboard", "shot-powder", "shot-ice"]) assert.equal(LOOKS.find((l) => l.id === id)?.shop_safe, false, id);
  assert.equal(normalFacts({ shop: true }).shop, true); assert.equal(normalFacts({ shop: "yes" }).shop, false);
});
