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
//    So in Shop-safe mode: only realistic shots and presenter hooks are offered, product animations are refused in an ad,
//    an ad must open with a hook (a person on screen, moving), and its end card carries "AI-generated".
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
  if (h === "shop.tiktok.com" && /\/view\/product\//.test(u.pathname)) return true;
  if ((h === "www.tiktok.com" || h === "tiktok.com") && (/^\/shop\/(pdp|view\/product)\//.test(u.pathname) || /^\/view\/product\//.test(u.pathname))) return true;
  return false;
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
/** Picture URLs anywhere in the response: plain strings or url_list / url fields of image objects. */
export function productImages(o: any): string[] {
  const urls = new Set<string>();
  const add = (s: unknown) => { if (typeof s === "string" && /^https:\/\//.test(s) && !/\.(mp4|m3u8|webm)(\?|$)/i.test(s) && !/avatar|logo|icon/i.test(s)) urls.add(s); };
  for (const v of findAll(o, /^(images?|main_images|product_images|img|cover|thumb_url|url_list)$/i)) {
    for (const x of ([] as any[]).concat(v)) { if (typeof x === "string") add(x); else if (x && typeof x === "object") { for (const y of ([] as any[]).concat(x.url_list ?? x.urls ?? x.url ?? [])) add(y); } }
  }
  return [...urls].slice(0, 8);
}
/** What a ScrapeCreators product read gives us: the shop's own words and pictures. */
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
  const r = await (deps.fetch ?? fetch)(`https://api.scrapecreators.com/v1/tiktok/product?url=${encodeURIComponent(url)}&region=US`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(45_000) }).catch(() => null);
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
export type ShopIssue = { code: string; text: string; blocking: boolean };
/** What would break TikTok Shop's rules in this ad, in plain words; blocking ones stop it being made in Shop-safe mode. */
export function shopIssues(parts: Array<{ kind: "hook" | "clip" | "shot"; shop_safe: boolean }>, end: { line: string | null; offer: string | null } | null): ShopIssue[] {
  const out: ShopIssue[] = [];
  if (parts.some((p) => p.kind === "clip" && !p.shop_safe)) out.push({ code: "shop_animated_product", text: "TikTok Shop doesn't allow an AI-animated product. Take the product clips out; keep the hook and real-looking shots.", blocking: true });
  if (!parts.some((p) => p.kind === "hook")) out.push({ code: "shop_needs_person", text: "A shoppable video needs a person or the real product moving on screen. Open the ad with a hook.", blocking: true });
  if (parts.some((p) => p.kind === "shot" && !p.shop_safe)) out.push({ code: "shop_surreal_shot", text: "Surreal shots (floating, splashing, exploded) can read as exaggerated effects on TikTok Shop. Prefer studio and lifestyle shots.", blocking: false });
  if (end?.offer && /\b(free|guarantee|cure|best|#1|number one)\b/i.test(end.offer)) out.push({ code: "shop_claim", text: "Offers with words like free, best or guaranteed need to be true and allowed for your product.", blocking: false });
  return out;
}
/** The words TikTok asks for, on the end card and in the caption suggestion. */
export const SHOP_DISCLOSURE = "AI-generated";

export async function productFactsOf(sb: SupabaseClient, u: string, id: string) {
  const a = await sb.from("studio_assets").select("probe").eq("id", id).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  return a.data?.probe?.product ?? null;
}
