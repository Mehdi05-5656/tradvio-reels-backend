// Clone8 Studio: the TikTok Shop kit (docs/model-features/PRODUCT_ADS_PLAN.md, phase 3, owner Nov 26 2026).
//
// 1. A TikTok Shop link becomes a product: TikTok blocks plain page reads, so its product is read through ScrapeCreators
//    (GET /v1/tiktok/product, US products; our existing vendor, ~$0.0019 a call, booked). The response's shape is not
//    published, so the reader walks it for the title, pictures, price and description instead of trusting one path.
// 2. Shop-safe mode, on for a product from a Shop link or when the person ticks "For TikTok Shop". TikTok Shop's US rules
//    (AIGC policy Sep 2 2026; quality rules May 23 2026; research in PRODUCT_ADS_PLAN.md):
//      - AI content must be disclosed;
//      - no animating a static product photo, no AI-changed size, quantity or effects, no time-compressing before/after;
//      - a shoppable video needs at least 3 s of real motion and a face or the physical product on screen;
//      - no fabricated endorsements (our presenters already never claim to be customers).
//    Owner's rule (Nov 26 2026): inform, never block. We are the tool; people choose how to use it. In Shop mode every
//    look and every piece stays available; what TikTok Shop's rules say about each is shown beside it, and the end card
//    offers an "AI-generated" line (on by default, the person can switch it off).
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordCost } from "./studio-costs.js";
import { safeUrl } from "./text-bot/intake.js";

type Deps = { env?: Record<string, string | undefined>; log?: (line: string) => void; fetch?: typeof fetch };
export class ShopError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

/** A TikTok Shop product link (the app's share links, the web product page, short links). */
export function isTikTokShopUrl(raw: string): boolean {
  let u: URL; try { u = new URL(raw); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (h === "vt.tiktok.com" || h === "vm.tiktok.com") return true;
  // the public share link (www.tiktokshop.com/pdp/...) redirects to shop.tiktok.com/us/pdp/...; both seen live Nov 26 2026
  if ((h === "tiktokshop.com" || h === "www.tiktokshop.com") && /^\/(?:[a-z]{2}\/)?(pdp|view\/product)\//.test(u.pathname)) return true;
  if (h === "shop.tiktok.com" && /^\/(?:[a-z]{2}\/)?(pdp|view\/product)\//.test(u.pathname)) return true;
  if ((h === "www.tiktok.com" || h === "tiktok.com") && (/^\/shop\/(pdp|view\/product)\//.test(u.pathname) || /^\/view\/product\//.test(u.pathname))) return true;
  return false;
}

/** The form our scraping vendor reads (www.tiktok.com/shop/pdp/<slug>/<id>); short links and unknown shapes pass through. */
export function tiktokShopCanonical(raw: string): string {
  let u: URL; try { u = new URL(raw); } catch { return raw; }
  const m = u.pathname.match(/\/(?:pdp|view\/product)\/(?:([^/]+)\/)?(\d{6,})\/?$/);
  if (!m || !isTikTokShopUrl(raw) || /^v[mt]\.tiktok\.com$/i.test(u.hostname)) return raw;
  return `https://www.tiktok.com/shop/pdp/${m[1] ? `${encodeURIComponent(decodeURIComponent(m[1]))}/` : ""}${m[2]}`;
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
/** Every value under keys that look like `want`, depth first (the response shape isn't published). */
function findAll(o: any, want: RegExp, depth = 0, out: any[] = []): any[] {
  if (!o || typeof o !== "object" || depth > 8) return out;
  for (const [k, v] of Object.entries(o)) {
    if (want.test(k)) out.push(v);
    if (v && typeof v === "object") findAll(v, want, depth + 1, out);
  }
  return out;
}
const firstString = (vals: any[], min = 2) => vals.map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null)).find((s) => !!s && s.trim().length >= min) ?? null;
/** Branches of a listing that hold someone else's picture: the seller's logo, a reviewer's avatar, a related item. Live
 *  check Nov 26 2026: the first picture found was the shop's logo, so it became "the product". */
const NOT_PRODUCT = /seller|shop|store|brand|author|user|review|comment|avatar|logo|icon|related|recommend|similar|video|live|coupon|promotion/i;
/** Picture URLs in the response, the product's own first (under product / images / main keys), never from NOT_PRODUCT branches. */
export function productImages(o: any): string[] {
  const ranked: Array<{ url: string; rank: number }> = [];
  const seen = new Set<string>();
  const add = (s: unknown, rank: number) => { if (typeof s === "string" && /^https:\/\//.test(s) && !/\.(mp4|m3u8|webm)(\?|$)/i.test(s) && !/avatar|logo|icon/i.test(s) && !seen.has(s)) { seen.add(s); ranked.push({ url: s, rank }); } };
  const walk = (x: any, path: string, depth: number) => {
    if (!x || typeof x !== "object" || depth > 8) return;
    for (const [k, v] of Object.entries(x)) {
      if (NOT_PRODUCT.test(k)) continue;
      const here = `${path}/${k}`;
      if (/^(images?|main_images|product_images|img|cover|thumb_url|url_list)$/i.test(k)) {
        const rank = /product|main_images|images?$/i.test(here) ? 0 : 1;
        for (const y of ([] as any[]).concat(v)) { if (typeof y === "string") add(y, rank); else if (y && typeof y === "object") for (const z of ([] as any[]).concat(y.url_list ?? y.urls ?? y.url ?? [])) add(z, rank); }
      }
      if (v && typeof v === "object") walk(v, here, depth + 1);
    }
  };
  walk(o, "", 0);
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.url).slice(0, 8);
}
/** Width and height of a JPEG, PNG or WebP from its bytes (no decoding); null when unknown. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
export function readTikTokProduct(o: any): { title: string | null; images: string[]; price: string | null; text: string | null } {
  const title = firstString(findAll(o, /^(title|product_name|name)$/i), 4);
  const price = firstString(findAll(o, /^(sale_price|real_price|price_str|format_price|min_price|price)$/i), 1);
  const currency = firstString(findAll(o, /^(currency|currency_symbol)$/i), 1);
  const desc = findAll(o, /^(description|desc|product_desc|highlights|selling_points)$/i).map((v) => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(". ") : "")).find((s) => s && s.length > 10) ?? null;
  return { title: title ? clean(title, 120) : null, images: productImages(o), price: price ? clean(/^[\d.,]+$/.test(price) && currency ? `${price} ${currency}` : price, 30) : null, text: desc ? clean(desc.replace(/<[^>]+>/g, " "), 1500) : null };
}

/** Reads a TikTok Shop product (US) through ScrapeCreators; the call is booked to the cost ledger. */
export async function fetchTikTokShopProduct(deps: Deps, url: string, userId?: string | null) {
  const env = deps.env ?? process.env, key = env.SCRAPECREATORS_API_KEY;
  if (!key) throw new ShopError("shop_link_unavailable", "Reading TikTok Shop links isn't set up. Save a photo of the product and upload it instead.", 503);
  if (!safeUrl(url)) throw new ShopError("product_link_invalid", "Paste the full https link to the product");
  const r = await (deps.fetch ?? fetch)(`https://api.scrapecreators.com/v1/tiktok/product?url=${encodeURIComponent(tiktokShopCanonical(url))}&region=US`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(45_000) }).catch(() => null);
  recordCost({ job_id: null, user_id: userId ?? null, tool: "products", provider: "scrapecreators", product: "/v1/tiktok/product", source: "product_import", units: { calls: 1 }, usd: 0.0019, basis: "estimated", note: null });
  if (!r || !r.ok) throw new ShopError("shop_link_unreadable", "TikTok Shop didn't give us that product (US products only). Save a photo of it and upload it instead.", 422);
  const body = await r.json().catch(() => null);
  const p = readTikTokProduct(body);
  if (!p.images.length) throw new ShopError("product_link_no_picture", "We couldn't find the product picture in that listing. Upload a photo of it instead.", 422);
  return p;
}

// ---------------------------------------------------------------------------------------------------
// Shop-safe checks for an ad (called by the ad quote)
// ---------------------------------------------------------------------------------------------------
export type ShopIssue = { code: string; text: string };
/** What TikTok Shop's rules say about this ad, in plain words. Information only: nothing is ever refused. */
export function shopIssues(parts: Array<{ kind: "hook" | "clip" | "shot"; shop_safe: boolean }>, end: { line: string | null; offer: string | null } | null): ShopIssue[] {
  const out: ShopIssue[] = [];
  if (parts.some((p) => p.kind === "clip" && !p.shop_safe)) out.push({ code: "shop_animated_product", text: "TikTok Shop's rules don't allow an AI-animated product in shoppable videos; the product clips may get the video limited there." });
  if (!parts.some((p) => p.kind === "hook")) out.push({ code: "shop_needs_person", text: "TikTok Shop asks for a person or the real product moving on screen for at least 3 seconds; a hook covers that." });
  if (parts.some((p) => p.kind === "shot" && !p.shop_safe)) out.push({ code: "shop_surreal_shot", text: "Surreal shots (floating, splashing, exploded) can read as exaggerated effects on TikTok Shop. Prefer studio and lifestyle shots." });
  if (end?.offer && /\b(free|guarantee|cure|best|#1|number one)\b/i.test(end.offer)) out.push({ code: "shop_claim", text: "Offers with words like free, best or guaranteed need to be true and allowed for your product." });
  return out;
}
/** The words TikTok asks for, on the end card and in the caption suggestion. */
export const SHOP_DISCLOSURE = "AI-generated";

export async function productFactsOf(sb: SupabaseClient, u: string, id: string) {
  const a = await sb.from("studio_assets").select("probe").eq("id", id).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  return a.data?.probe?.product ?? null;
}
