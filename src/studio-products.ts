// Clone8 Studio: Products (docs/model-features/PRODUCT_ADS_PLAN.md, phase 1, owner Nov 26 2026). A product is a picture
// in the person's library with what we know about it kept on its probe (`probe.product`): name, category, main colour,
// the words on its label, one line. Claude reads those from the photo (and the shop page when it came from a link); the
// person corrects them. Every shot and animation (studio-product-looks.ts) starts from that picture.
//
// After a motion clip renders, two finishing steps run here (the instrument runner calls them): a matched sound effect is
// laid under the silent clip (ElevenLabs), and Claude compares the clip with the product photo. A clip that changed the
// product or its label is not charged: the person never pays for a broken label (the leaders' top complaint).
//
// Owner-only until every look has a real example (the same rule as presets). No new table: nothing to migrate.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { claudeJson } from "./studio-clips.js";
import { checkUpload } from "./studio-limits.js";
import { toJpeg } from "./studio-characters.js";
import { safeUrl } from "./text-bot/intake.js";
import { fetchTikTokShopProduct, isTikTokShopUrl, ShopError } from "./studio-shop.js";
import { command } from "./video-render.js";
import { soundEffect, replaceAudio } from "./studio-eleven.js";
import { recordCost } from "./studio-costs.js";
import { CATEGORY_LABEL, LookError, PRODUCT_CATEGORIES, fitsCategory, lookById, lookChoices, lookRequest, lookSfx, looksFor, publicLook, type ProductCategory, type ProductFacts } from "./studio-product-looks.js";

type Deps = { env?: Record<string, string | undefined>; log?: (line: string) => void; fetch?: typeof fetch };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = (env: Record<string, string | undefined>) => env.STUDIO_PRODUCTS_MODEL || "claude-sonnet-5-5";
const IMAGE_MAX = 20 * 1024 * 1024, PAGE_MAX = 3 * 1024 * 1024;

export class ProductError extends Error { constructor(public code: string, message = code, public status = 400) { super(message); } }

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const isCategory = (c: unknown): c is ProductCategory => typeof c === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(c);

/** The facts as stored: only known categories, short trimmed words. */
export function normalFacts(raw: any): ProductFacts {
  return {
    name: clean(raw?.name, 60) || "Your product",
    category: isCategory(raw?.category) ? raw.category : "other",
    colour: clean(raw?.colour, 40) || null,
    label_text: clean(raw?.label_text, 200) || null,
    line: clean(raw?.line, 140) || null,
    source_url: raw?.source_url ? clean(raw.source_url, 500) : null,
    price: raw?.price ? clean(raw.price, 30) : null,
    // Shop-safe mode (studio-shop.ts): on for a TikTok Shop product or when the person ticks it
    shop: raw?.shop === true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Reading a product (Claude, our cost)
// ---------------------------------------------------------------------------------------------------
const FACTS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "category", "colour", "label_text", "line"],
  properties: {
    name: { type: "string", description: "What a shopper would call it, brand first if one is printed: e.g. 'SURGE energy drink'. At most 6 words." },
    category: { type: "string", enum: [...PRODUCT_CATEGORIES] },
    colour: { type: "string", description: "Its main colour in two or three plain words, e.g. 'cobalt blue', 'sage green'." },
    label_text: { type: "string", description: "Every word printed on it, exactly as written, in reading order; empty if none." },
    line: { type: "string", description: "One plain sentence saying what it is and who it is for. No hype, no claims about results." },
  },
};
const FACTS_SYSTEM = "You read product photos for an ad studio. Report only what you can see (and what the shop page says, if given). Never invent a brand, a claim, a price or label words you cannot read. If the photo shows several products, describe the main one. If it is a screenshot of an app or website, the category is 'app'.";

export async function describeProduct(deps: Deps, image: { bytes: Buffer; mediaType: string }, page?: { title?: string | null; text?: string | null } | null, userId?: string): Promise<ProductFacts> {
  const env = deps.env ?? process.env;
  const content: any[] = [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } }];
  const pageWords = page ? [page.title ? `Page title: ${clean(page.title, 200)}` : null, page.text ? `From the shop page: ${clean(page.text, 1500)}` : null].filter(Boolean).join("\n") : "";
  content.push({ type: "text", text: `Read this product.${pageWords ? `\n${pageWords}` : ""}` });
  const out = await claudeJson({ env, log: deps.log, fetch: deps.fetch } as any, {
    model: MODEL(env), max_tokens: 1200, system: FACTS_SYSTEM,
    output_config: { format: { type: "json_schema", schema: FACTS_SCHEMA } },
    messages: [{ role: "user", content }],
  }, "product_read", userId);
  return normalFacts(out);
}

// ---------------------------------------------------------------------------------------------------
// "Describe your own": the person's words become one clean hero motion (Claude, our cost)
// ---------------------------------------------------------------------------------------------------
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["ok", "title", "motion", "engine", "sfx", "note"],
  properties: {
    ok: { type: "boolean", description: "false when the request can't be made as asked (a real person, another brand, something unsafe, or no motion at all)" },
    title: { type: "string", description: "A short name for this move, 1-3 words, e.g. 'Lava pour'." },
    motion: { type: "string", description: "One continuous 5-second shot in 1-3 plain sentences: what moves, how, where the camera goes. One hero motion only. Physically believable unless the person clearly wants surreal. Never mention text, captions, hands or people." },
    engine: { type: "string", enum: ["action", "camera"], description: "'camera' when only the camera, light or surroundings move and the product itself stays still; otherwise 'action'." },
    sfx: { type: "string", description: "A short description of the matching sound effect, e.g. 'a crisp can tab opening with fizz'." },
    note: { type: "string", description: "One short sentence to the person when you changed their idea (kept one move of two, softened something) or why you can't make it; empty otherwise." },
  },
};
const PLAN_SYSTEM = [
  "You turn a person's idea for a short product animation into one clean shot for an image-to-video model. The model starts from a photo of their product and must keep it exactly as it is: label, logo and shape.",
  "Rules learned from product ads that work:",
  "- One hero motion per clip. If they ask for two or more (open AND pour AND spin), keep the strongest and say so in the note.",
  "- Nothing that needs readable text to change, appear or move. No hands, no people, no faces.",
  "- Prefer moves that keep the front of the product toward the camera; at most a half turn.",
  "- The product can open, twist, pour, fizz, float, land, steam or be surrounded by an effect (splash, ice, petals, smoke, light). It must not melt, morph into something else or change size.",
  "- Refuse a real person or celebrity, another company's brand, anything sexual, violent or dangerous.",
  "- The clip starts from their photo exactly as it is, background included, and the camera stays in that place. If they ask for another place (a beach, a black mirror, night), keep the motion in the photo's own setting and say in the note to make a shot in that setting first (the Shots tab) and animate that.",
  "Write plain, concrete, visual sentences. The safety and preservation words are added by us; don't repeat them.",
].join("\n");

export async function planCustomMotion(deps: Deps, facts: ProductFacts, words: string, userId?: string): Promise<{ ok: boolean; title: string; motion: string; engine: "action" | "camera"; sfx: string; note: string }> {
  const env = deps.env ?? process.env;
  const w = clean(words, 300);
  if (w.length < 4) throw new ProductError("look_words_required", "Say what should happen");
  const out = await claudeJson({ env, log: deps.log, fetch: deps.fetch } as any, {
    model: MODEL(env), max_tokens: 800, system: PLAN_SYSTEM,
    output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
    messages: [{ role: "user", content: `Product: ${facts.name} (${CATEGORY_LABEL[facts.category]})${facts.line ? `. ${facts.line}` : ""}\nTheir idea: ${w}` }],
  }, "product_motion_plan", userId);
  return { ok: !!out?.ok, title: clean(out?.title, 24) || "Your move", motion: clean(out?.motion, 400), engine: out?.engine === "camera" ? "camera" : "action", sfx: clean(out?.sfx, 160), note: clean(out?.note, 200) };
}

// ---------------------------------------------------------------------------------------------------
// The library side
// ---------------------------------------------------------------------------------------------------
export async function loadImage(sb: SupabaseClient, u: string, id: string): Promise<{ row: any; bytes: Buffer; mediaType: string }> {
  if (!UUID_RE.test(id)) throw new ProductError("product_not_found", "No such picture", 404);
  const a = await sb.from("studio_assets").select("id,kind,name,object_key,status,probe").eq("id", id).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data || a.data.status !== "ready" || a.data.kind !== "image") throw new ProductError("product_not_found", "That picture is not in your library", 404);
  const dl = await sb.storage.from("studio-uploads").download(a.data.object_key);
  if (dl.error || !dl.data) throw dl.error ?? new ProductError("product_not_found", "That picture could not be read", 404);
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  return { row: a.data, bytes, mediaType: /\.png$/i.test(a.data.object_key) ? "image/png" : "image/jpeg" };
}
async function saveFacts(sb: SupabaseClient, u: string, row: any, facts: ProductFacts | null) {
  const probe = { ...(row.probe ?? {}) };
  if (facts) probe.product = { ...facts, at: new Date().toISOString() }; else delete probe.product;
  const r = await sb.from("studio_assets").update({ probe, updated_at: new Date().toISOString() }).eq("id", row.id).eq("user_id", u);
  if (r.error) throw r.error;
}
async function signed(sb: SupabaseClient, keys: string[], bucket = "studio-uploads"): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const s = await sb.storage.from(bucket).createSignedUrls(keys, 3600);
  return new Map(((s.data ?? []) as any[]).map((x) => [x.path, x.signedUrl]));
}
export function productOf(row: any) {
  return { asset_id: row.id, name: row.probe?.product?.name ?? row.name, facts: normalFacts(row.probe?.product ?? {}), created_at: row.created_at };
}

// ---------------------------------------------------------------------------------------------------
// From a shop link: the page's product picture and words (JSON-LD Product, Open Graph), fetched safely
// ---------------------------------------------------------------------------------------------------
async function getSafe(f: typeof fetch, url: string, max: number, accept: string): Promise<{ bytes: Buffer; type: string; url: string } | null> {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!safeUrl(at)) return null;
    const r = await f(at, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { accept, "user-agent": "Mozilla/5.0 (compatible; Clone8Products/1.0)" } }).catch(() => null);
    if (!r) return null;
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { at = new URL(r.headers.get("location")!, at).toString(); continue; }
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader(), parts: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength; if (n > max) { await reader.cancel().catch(() => undefined); return null; } parts.push(value); }
    return { bytes: Buffer.concat(parts), type: String(r.headers.get("content-type") ?? ""), url: at };
  }
  return null;
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The product picture, name, words and price a shop page states (JSON-LD first, then Open Graph). */
export function readShopPage(html: string, base: string): { image: string | null; title: string | null; text: string | null; price: string | null } {
  let image: string | null = null, title: string | null = null, text: string | null = null, price: string | null = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items: any[] = ([] as any[]).concat(data?.["@graph"] ?? data);
    const p = items.find((x) => [].concat(x?.["@type"] ?? []).some((t: any) => String(t).toLowerCase() === "product"));
    if (!p) continue;
    title = title ?? (p.name ? String(p.name) : null);
    text = text ?? (p.description ? String(p.description) : null);
    const img = ([] as any[]).concat(p.image ?? [])[0];
    image = image ?? (typeof img === "string" ? img : img?.url ?? null);
    const offer = ([] as any[]).concat(p.offers ?? [])[0];
    const amount = offer?.price ?? offer?.lowPrice;
    if (amount != null && price == null) price = `${amount}${offer?.priceCurrency ? ` ${offer.priceCurrency}` : ""}`;
  }
  const meta = (prop: string) => { const r = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i").exec(html); return r ? decode(r[1] ?? r[2]) : null; };
  image = image ?? meta("og:image") ?? meta("twitter:image");
  title = title ?? meta("og:title") ?? (/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? null);
  text = text ?? meta("og:description") ?? meta("description");
  price = price ?? (meta("product:price:amount") ? `${meta("product:price:amount")}${meta("product:price:currency") ? ` ${meta("product:price:currency")}` : ""}` : null);
  if (image) { try { image = new URL(decode(image), base).toString(); } catch { image = null; } }
  return { image, title: title ? decode(title).trim() : null, text: text ? decode(text).trim() : null, price };
}

export async function storeImage(sb: SupabaseClient, u: string, bytes: Buffer, name: string): Promise<string> {
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : await toJpeg(bytes);
  const limit = await checkUpload(sb, u, jpg.length);
  if (limit) throw new ProductError(limit.code, limit.message, limit.status);
  const id = randomUUID(), key = `${u}/${id}.jpg`;
  const up = await sb.storage.from("studio-uploads").upload(key, jpg, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw up.error;
  const ins = await sb.from("studio_assets").insert({ id, user_id: u, kind: "image", name: clean(name, 60).replace(/[^\w .()-]+/g, " ").trim().slice(0, 50) + ".jpg", object_key: key, bytes: jpg.length, status: "ready", probe: {} });
  if (ins.error) throw ins.error;
  return id;
}

// ---------------------------------------------------------------------------------------------------
// A look run: what quoteFor sends to the instrument quote (the recipe joins at run time)
// ---------------------------------------------------------------------------------------------------
/** The request and what the job keeps, for a look on a product. Admin-only until looks have examples. */
export async function lookQuoteRequest(sb: SupabaseClient, u: string, options: any, o: { admin: boolean }) {
  const look = lookById(options?.look);
  if (!look || (!look.example && !o.admin)) throw new LookError("look_unknown", "That look is not offered", 404);
  const productId = String(options?.product ?? "");
  if (!UUID_RE.test(productId)) throw new LookError("look_input_required", "Add your product first");
  const a = await sb.from("studio_assets").select("id,probe,status,kind").eq("id", productId).eq("user_id", u).maybeSingle();
  if (a.error) throw a.error;
  if (!a.data?.probe?.product) throw new LookError("product_not_found", "That product is not in your library", 404);
  const facts = normalFacts(a.data.probe.product);
  if (!fitsCategory(look, facts.category) && look.fits !== "all") throw new LookError("look_not_for_product", `${look.title} is not made for ${CATEGORY_LABEL[facts.category].toLowerCase()}`);
  // Shop-safe mode: TikTok Shop refuses AI-animated products and exaggerated effects (studio-shop.ts)
  if (facts.shop && !look.shop_safe) throw new LookError("look_not_shop_safe", `${look.title} isn't allowed for TikTok Shop videos. Turn off "For TikTok Shop" to make it for elsewhere.`);
  const start = options?.start && UUID_RE.test(String(options.start)) ? String(options.start) : productId;
  const exploded = options?.exploded && UUID_RE.test(String(options.exploded)) ? String(options.exploded) : null;
  const choices = lookChoices(look, facts, options?.params);
  const req = lookRequest(look, { product: start, exploded }, choices);
  return { look, facts, req, keep: { params: choices, look: look.id, look_title: look.id === "move-custom" ? clean(options?.params?.title, 24) || look.title : look.title, product: productId, ...(start !== productId ? { start } : {}), ...(exploded ? { exploded } : {}) } };
}

// ---------------------------------------------------------------------------------------------------
// After a motion clip renders (called by the instrument runner): its sound, then the product check
// ---------------------------------------------------------------------------------------------------
const JUDGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["same_product", "label_kept", "problem"],
  properties: {
    same_product: { type: "boolean", description: "the product at the END of the clip is the same object as in the reference photo (shape, colour, material)" },
    label_kept: { type: "boolean", description: "the logo and label words visible at the end match the reference (no garbled, invented or missing letters); true when the label is not visible in either" },
    problem: { type: "string", description: "one short plain sentence about what changed; empty when nothing did" },
  },
};
async function frames(video: string, dir: string, seconds: number): Promise<Buffer[]> {
  const at = [Math.min(0.3, seconds / 4), seconds / 2, Math.max(0, seconds - 0.25)];
  const out: Buffer[] = [];
  for (let i = 0; i < at.length; i++) {
    const f = join(dir, `judge-${i}.jpg`);
    await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", at[i].toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "4", f], undefined, 60_000);
    out.push(await readFile(f));
  }
  return out;
}
export type LookCheck = { ok: boolean | null; problem?: string | null; sound?: boolean };
/** Lays the look's sound under the clip (in place) and checks the product against its photo. Never throws: a finishing
 *  step that fails leaves the silent clip and an unknown check, and the person is charged as usual. */
export async function finishLookVideo(sb: SupabaseClient, deps: Deps & { soundEffect?: typeof soundEffect; replaceAudio?: typeof replaceAudio; judge?: (a: any) => Promise<any> }, job: any, file: string, seconds: number): Promise<LookCheck> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined), o = job.options ?? {};
  const check: LookCheck = { ok: null };
  const dir = await mkdtemp(join(tmpdir(), "studio-look-"));
  try {
    // the product check first, on the silent clip (sound doesn't change the picture)
    if (env.ANTHROPIC_API_KEY && o.product && seconds > 0) {
      try {
        const ref = await loadImage(sb, job.user_id, String(o.product));
        const shots = await frames(file, dir, seconds);
        const content: any[] = [{ type: "text", text: "Reference photo of the product:" }, { type: "image", source: { type: "base64", media_type: ref.mediaType, data: ref.bytes.toString("base64") } },
          { type: "text", text: "Frames from the start, middle and end of the clip (the middle may show the product opening, splashing or apart by design; judge the END):" },
          ...shots.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }))];
        const v = await (deps.judge ?? ((body: any) => claudeJson({ env, log, fetch: deps.fetch } as any, body, "product_look_check", job.user_id)))({
          model: MODEL(env), max_tokens: 400, system: "You check AI product videos for an ad studio. Be strict about the logo and label words and the product's shape; ignore lighting, background and motion.",
          output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } }, messages: [{ role: "user", content }],
        });
        check.ok = !!v?.same_product && !!v?.label_kept; check.problem = check.ok ? null : clean(v?.problem, 200) || "The product changed";
      } catch (e: any) { log(`[products] check skipped ${JSON.stringify({ job: job.id, error: String(e?.message ?? e).slice(0, 160) })}`); }
    }
    const sfx = lookSfx(o.look, o.params ?? {});
    if (sfx && env.ELEVENLABS_API_KEY && seconds > 0) {
      try {
        const mp3 = await (deps.soundEffect ?? soundEffect)({ env, log, fetch: deps.fetch } as any, { text: `${sfx}, clean, no music, no voice`, duration_seconds: Math.min(22, Math.max(0.5, Math.round(seconds * 10) / 10)) });
        const a = join(dir, "sfx.mp3"), outFile = join(dir, "with-sound.mp4");
        await writeFile(a, mp3);
        await (deps.replaceAudio ?? replaceAudio)(file, a, outFile);
        await writeFile(file, await readFile(outFile));
        check.sound = true;
        // ElevenLabs bills sound effects at 40 credits a second (Pro: $99 for 600k credits); estimated, not metered
        const usd = Math.round(seconds * 40 * 0.000165 * 10000) / 10000;
        recordCost({ job_id: job.id, user_id: job.user_id ?? null, tool: "instrument", provider: "elevenlabs", product: "sound-effects", source: "product_look_sound", units: { seconds: Math.round(seconds * 10) / 10 }, usd, basis: "estimated", note: "40 credits/s at the Pro plan rate" });
      } catch (e: any) { log(`[products] sound skipped ${JSON.stringify({ job: job.id, error: String(e?.message ?? e).slice(0, 160) })}`); }
    }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  log(`[products] finished ${JSON.stringify({ job: job.id, look: o.look, check: check.ok, sound: !!check.sound })}`);
  return check;
}

// ---------------------------------------------------------------------------------------------------
// Routes (owner-only while phase 1 is checked)
// ---------------------------------------------------------------------------------------------------
export function registerProducts(app: Express, sbFn: () => SupabaseClient, deps: Deps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  const d: Deps = { ...deps, env, log };
  const gate = async (req: Request, res: Response): Promise<string | null> => {
    const u = req.auth && "user_id" in req.auth ? req.auth.user_id : null;
    if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
    if (env.STUDIO_PRODUCTS_OPEN !== "true" && !(await isStudioAdmin(req, sbFn(), env))) { res.status(404).json({ error: "not_found" }); return null; }
    return u;
  };
  const fail = (res: Response, e: any) => {
    if (e instanceof ProductError || e instanceof LookError || e instanceof ShopError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const code = e?.code ?? null;
    if (code && typeof e?.status === "number") return res.status(e.status).json({ error: code, detail: e.message });
    log(`[products] error ${String(e?.message ?? e).slice(0, 300)}`);
    return res.status(500).json({ error: "server_error" });
  };
  const listOne = async (sb: SupabaseClient, row: any) => {
    const urls = await signed(sb, [row.object_key]);
    return { ...productOf(row), url: urls.get(row.object_key) ?? null };
  };

  app.get("/api/studio/products", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      const r = await sb.from("studio_assets").select("id,name,object_key,probe,created_at").eq("user_id", u).eq("kind", "image").eq("status", "ready").not("probe->product", "is", null).order("created_at", { ascending: false }).limit(60);
      if (r.error) throw r.error;
      const urls = await signed(sb, (r.data ?? []).map((a: any) => a.object_key));
      res.json({ products: (r.data ?? []).map((a: any) => ({ ...productOf(a), url: urls.get(a.object_key) ?? null })), categories: PRODUCT_CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })) });
    } catch (e) { fail(res, e); }
  });

  // a picture already in the library becomes a product (Claude reads it)
  app.post("/api/studio/products", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      const img = await loadImage(sb, u, String(req.body?.asset_id ?? ""));
      const facts = await describeProduct(d, { bytes: img.bytes, mediaType: img.mediaType }, null, u);
      await saveFacts(sb, u, img.row, facts);
      res.status(201).json({ product: await listOne(sb, { ...img.row, probe: { ...(img.row.probe ?? {}), product: facts } }) });
    } catch (e) { fail(res, e); }
  });

  // a shop link (TikTok Shop, Amazon, Shopify, any product page): its picture into the library, its words to Claude
  app.post("/api/studio/products/import", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    const url = clean(req.body?.url, 1000);
    if (!safeUrl(url)) return res.status(400).json({ error: "product_link_invalid", detail: "Paste the full https link to the product page" });
    try {
      const f = deps.fetch ?? fetch;
      // TikTok Shop blocks plain reads: its product comes through our scraping vendor (studio-shop.ts), Shop-safe on
      if (isTikTokShopUrl(url)) {
        const shop = await fetchTikTokShopProduct(d, url, u);
        const pic = await getSafe(f, shop.images[0], IMAGE_MAX, "image/*");
        if (!pic || !/^image\/(jpeg|png|webp)/i.test(pic.type)) throw new ProductError("product_link_no_picture", "We couldn't download the product picture from that listing. Upload a photo of it instead.", 422);
        const sb = sbFn();
        const id = await storeImage(sb, u, pic.bytes, shop.title ?? "TikTok Shop product");
        const img = await loadImage(sb, u, id);
        const facts = normalFacts({ ...(await describeProduct(d, { bytes: img.bytes, mediaType: img.mediaType }, { title: shop.title, text: shop.text }, u)), source_url: url, price: shop.price, shop: true });
        await saveFacts(sb, u, img.row, facts);
        return res.status(201).json({ product: await listOne(sb, { ...img.row, probe: { ...(img.row.probe ?? {}), product: facts } }) });
      }
      const page = await getSafe(f, url, PAGE_MAX, "text/html,application/xhtml+xml");
      if (!page || !/html/i.test(page.type)) throw new ProductError("product_link_unreadable", "That page didn't let us read it. Save a photo of the product and upload it instead.", 422);
      const shop = readShopPage(page.bytes.toString("utf8"), page.url);
      if (!shop.image) throw new ProductError("product_link_no_picture", "We couldn't find the product picture on that page. Upload a photo of it instead.", 422);
      const pic = await getSafe(f, shop.image, IMAGE_MAX, "image/*");
      if (!pic || !/^image\/(jpeg|png|webp)/i.test(pic.type)) throw new ProductError("product_link_no_picture", "We couldn't download the product picture from that page. Upload a photo of it instead.", 422);
      const sb = sbFn();
      const id = await storeImage(sb, u, pic.bytes, shop.title ?? "Product");
      const img = await loadImage(sb, u, id);
      const facts = { ...(await describeProduct(d, { bytes: img.bytes, mediaType: img.mediaType }, { title: shop.title, text: shop.text }, u)), source_url: page.url, price: shop.price };
      await saveFacts(sb, u, img.row, normalFacts(facts));
      res.status(201).json({ product: await listOne(sb, { ...img.row, probe: { ...(img.row.probe ?? {}), product: normalFacts(facts) } }) });
    } catch (e) { fail(res, e); }
  });

  // the person corrects what we read
  app.patch("/api/studio/products/:id", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new ProductError("product_not_found", "No such product", 404);
      const a = await sb.from("studio_assets").select("id,name,object_key,probe,created_at").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data?.probe?.product) throw new ProductError("product_not_found", "No such product", 404);
      const cur = normalFacts(a.data.probe.product), b = req.body ?? {};
      const next = normalFacts({ ...cur, ...(b.name != null ? { name: b.name } : {}), ...(isCategory(b.category) ? { category: b.category } : {}), ...(b.colour != null ? { colour: b.colour } : {}), ...(b.line != null ? { line: b.line } : {}), ...(b.label_text != null ? { label_text: b.label_text } : {}), ...(typeof b.shop === "boolean" ? { shop: b.shop } : {}) });
      await saveFacts(sb, u, a.data, next);
      res.json({ product: await listOne(sb, { ...a.data, probe: { ...a.data.probe, product: next } }) });
    } catch (e) { fail(res, e); }
  });

  // no longer a product (the picture stays in the library)
  app.post("/api/studio/products/:id/remove", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new ProductError("product_not_found", "No such product", 404);
      const a = await sb.from("studio_assets").select("id,probe").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data?.probe?.product) throw new ProductError("product_not_found", "No such product", 404);
      await saveFacts(sb, u, a.data, null);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // the looks for a product's category (never the recipe); admins also see the ones without an example yet
  app.get("/api/studio/product-looks", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const admin = await isStudioAdmin(req, sbFn(), env);
      const c = isCategory(req.query.category) ? req.query.category : null;
      res.json({ looks: looksFor(c, { admin, shopSafe: req.query.shop === "1" }).map(publicLook) });
    } catch (e) { fail(res, e); }
  });

  // describe your own: the person's words become one clean move (no charge; the run is priced as any motion look)
  app.post("/api/studio/products/:id/plan-motion", async (req, res) => {
    const u = await gate(req, res); if (!u) return;
    try {
      const sb = sbFn();
      if (!UUID_RE.test(req.params.id)) throw new ProductError("product_not_found", "No such product", 404);
      const a = await sb.from("studio_assets").select("id,probe").eq("id", req.params.id).eq("user_id", u).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data?.probe?.product) throw new ProductError("product_not_found", "No such product", 404);
      res.json({ plan: await planCustomMotion(d, normalFacts(a.data.probe.product), String(req.body?.words ?? ""), u) });
    } catch (e) { fail(res, e); }
  });
}
