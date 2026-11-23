// What is in each post, for "what's working" on every linked account (made in Clone8 or not), and the cards built
// from it (docs/publishing/AI_CAPTIONS_PLAN.md, steps B2 and C1).
//
// Features come from what we can read for any post without downloading someone's video:
//   - the caption (counted here: length, first line, hashtags, a question, emoji, a call to action);
//   - the cover (one model call per 8 posts reads the stored thumbnail: a face, people, text on it, the format);
//   - for Clone8-made posts, the tool that made it.
// Cards compare the person's own posts with each other: each post's views against its own account's median (the
// "multiple" from analyze()), one group against the rest, with a permutation test for how sure we are. YouTube posts
// are left out of every derived number (YouTube's API terms; raw numbers only until its audit is passed).
import type { SupabaseClient } from "@supabase/supabase-js";
import { logClaudeCost } from "./studio-pricing.js";
import { median, type Analysis, type PerfDeps, type PostStats } from "./studio-performance.js";

export const FEATURES_MODEL = "claude-haiku-5-5";
export const FEATURES_VERSION = 1;
/** Posts read per refresh (newest first); a backlog clears over a few refreshes. */
export const FEATURES_PER_REFRESH = 40;
const BATCH = 8;

export const FORMATS = ["talking_head", "voiceover", "skit", "tutorial", "slideshow", "screen_recording", "split_screen", "clip", "product", "animation", "vlog", "other"] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABEL: Record<Format, string> = {
  talking_head: "Talking to camera", voiceover: "Voice over footage", skit: "Skits", tutorial: "How-tos", slideshow: "Photo slideshows",
  screen_recording: "Screen recordings", split_screen: "Split screens", clip: "Clips (podcast, stream)", product: "Product shots", animation: "Animation", vlog: "Vlogs", other: "Other",
};

export type CaptionShape = { chars: number; first_line_chars: number; words: number; hashtags: string[]; question: boolean; emoji: number; cta: boolean; mentions: number };
export type CoverRead = { face: boolean | null; people: "none" | "one" | "several" | null; text_on_cover: boolean | null; cover_text: string | null; format: Format | null; subject: string | null };
export type PostFeatures = { v: number; caption: CaptionShape; cover: CoverRead | null; made: { tool: string } | null };

const TAG_RE = /#[\p{L}\p{N}_]+/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const CTA_RE = /\b(link in bio|follow (me|for)|comment\b|save (this|for)|share (this|with)|dm me|tag (a|someone))/i;

/** The shape of a caption, counted. Hashtags are not part of the length (TikTok's studies count the text). */
export function captionShape(caption: string | null | undefined): CaptionShape {
  const c = String(caption ?? "");
  const hashtags = [...new Set((c.match(TAG_RE) ?? []).map((t) => t.toLowerCase()))];
  const text = c.replace(TAG_RE, "").replace(/\s+/g, " ").trim();
  const first = (c.split(/\n/).map((l) => l.replace(TAG_RE, "").trim()).find((l) => l) ?? "");
  return {
    chars: text.length, first_line_chars: first.length, words: text ? text.split(" ").length : 0, hashtags,
    question: /\?/.test(text), emoji: (c.match(EMOJI_RE) ?? []).length, cta: CTA_RE.test(text), mentions: (c.match(/@[\w.]+/g) ?? []).length,
  };
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["posts"],
  properties: {
    posts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "face", "people", "text_on_cover", "cover_text", "format", "subject"], properties: {
      id: { type: "string" },
      face: { type: "boolean", description: "A human face is clearly visible on the cover" },
      people: { type: "string", enum: ["none", "one", "several"] },
      text_on_cover: { type: "boolean", description: "Words are written on the cover (a title, a caption, a hook), not counting logos or watermarks" },
      cover_text: { anyOf: [{ type: "string" }, { type: "null" }], description: "The words on the cover, at most 80 characters, or null" },
      format: { type: "string", enum: [...FORMATS], description: "The most likely format of the video, from its cover and caption" },
      subject: { type: "string", description: "What the video is about, three to six plain words" },
    } } },
  },
};
const SYSTEM = `You label short-form video posts from their cover image and caption, for the creator's own analytics. Be literal: say only what the cover shows. "face" is true only when a human face is clearly visible. "format" is your best reading of the whole video from the cover and caption: talking_head (someone speaking to camera), voiceover (narration over footage), skit, tutorial, slideshow (still photos), screen_recording, split_screen (two videos stacked), clip (a cut from a podcast, stream or show), product, animation, vlog, other. Answer for every post id given.`;

/** Read the covers of a few posts with the model; posts whose cover can't be read are returned as null. */
export async function readCovers(posts: Array<{ id: string; caption: string | null; thumb_url: string }>, deps: PerfDeps & { user?: string } = {}): Promise<Map<string, CoverRead>> {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch;
  const out = new Map<string, CoverRead>();
  const key = env.ANTHROPIC_API_KEY;
  if (!key || !posts.length) return out;
  const content: any[] = [];
  for (const p of posts) content.push({ type: "text", text: `Post ${p.id}. Caption: """${String(p.caption ?? "").slice(0, 400)}"""` }, { type: "image", source: { type: "url", url: p.thumb_url } });
  content.push({ type: "text", text: "Label every post above." });
  const model = env.STUDIO_FEATURES_MODEL || FEATURES_MODEL;
  const r = await f("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify({ model, max_tokens: 3000, system: SYSTEM, fallbacks: "default", output_config: { format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`features_http_${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const body: any = await r.json();
  logClaudeCost(deps.log, "post_features", String(body?.model ?? model), body?.usage, deps.user ?? null);
  if (body?.stop_reason === "refusal" || body?.stop_reason === "max_tokens") return out;
  const raw = (body?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
  let parsed: any; try { parsed = JSON.parse(raw); } catch { return out; }
  const ids = new Set(posts.map((p) => p.id));
  for (const x of parsed?.posts ?? []) {
    if (!ids.has(String(x?.id))) continue;
    out.set(String(x.id), {
      face: typeof x.face === "boolean" ? x.face : null,
      people: ["none", "one", "several"].includes(x.people) ? x.people : null,
      text_on_cover: typeof x.text_on_cover === "boolean" ? x.text_on_cover : null,
      cover_text: x.cover_text ? String(x.cover_text).replace(/\s+/g, " ").trim().slice(0, 80) : null,
      format: (FORMATS as readonly string[]).includes(x.format) ? x.format : null,
      subject: x.subject ? String(x.subject).replace(/\s+/g, " ").trim().slice(0, 60) : null,
    });
  }
  return out;
}

/** Fill in features for posts that have none yet (or an older version), newest first, a capped number per call.
 *  Captions are counted for every post; covers are read for posts with a stored thumbnail (YouTube included: what is on
 *  a cover is ours to read, only YouTube's numbers are kept raw). */
export async function fillPostFeatures(sb: SupabaseClient, u: string, deps: PerfDeps & { readCovers?: typeof readCovers } = {}, limit = FEATURES_PER_REFRESH): Promise<{ read: number; covers: number }> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const r = await sb.from("studio_perf_posts").select("id,platform,caption,thumb_key,job_id,features").eq("user_id", u).or(`features_at.is.null,features->>v.neq.${FEATURES_VERSION}`).order("published_at", { ascending: false }).limit(limit);
  if (r.error) throw r.error;
  const rows = (r.data ?? []) as any[];
  if (!rows.length) return { read: 0, covers: 0 };
  // the tool behind Clone8-made posts
  const jobIds = [...new Set(rows.map((x) => x.job_id).filter(Boolean))];
  const tools = new Map<string, string>();
  if (jobIds.length) { const j = await sb.from("studio_jobs").select("id,tool").eq("user_id", u).in("id", jobIds); for (const x of (j.data ?? []) as any[]) tools.set(x.id, x.tool); }
  // cover images: signed for an hour, only for the model to fetch
  const keys = [...new Set(rows.map((x) => x.thumb_key).filter(Boolean))] as string[];
  const signed = keys.length ? await sb.storage.from("studio-outputs").createSignedUrls(keys, 3600) : { data: [] as any[] };
  const urlOf = new Map(((signed.data ?? []) as any[]).filter((x) => !x.error && x.signedUrl).map((x) => [x.path, x.signedUrl]));
  const withCover = rows.filter((x) => x.thumb_key && urlOf.has(x.thumb_key));
  const covers = new Map<string, CoverRead>();
  const read = deps.readCovers ?? readCovers;
  // a post whose cover the model can't take (a 4xx: a broken or odd image) is saved without a cover, so it does not
  // block the queue; a busy or failing model (429, 5xx, timeout) leaves it for the next refresh
  const gaveUp = new Set<string>();
  const permanent = (e: any) => /features_http_4(?!29)\d\d/.test(String(e?.message ?? e));
  for (let i = 0; i < withCover.length; i += BATCH) {
    const part = withCover.slice(i, i + BATCH).map((x) => ({ id: x.id, caption: x.caption, thumb_url: urlOf.get(x.thumb_key)! }));
    try {
      const got = await read(part, { ...deps, user: u });
      for (const [id, c] of got) covers.set(id, c);
      for (const p of part) if (!got.has(p.id)) gaveUp.add(p.id); // answered, but not for this one
    } catch (e: any) {
      log(`[features] ${u} covers: ${String(e?.message ?? e).slice(0, 140)}`);
      if (!permanent(e)) continue;
      // one bad image fails the whole call: try them one by one
      for (const p of part) {
        try { const got = await read([p], { ...deps, user: u }); const c = got.get(p.id); if (c) covers.set(p.id, c); else gaveUp.add(p.id); }
        catch (e2: any) { if (permanent(e2)) gaveUp.add(p.id); }
      }
    }
  }
  const now = new Date().toISOString();
  let n = 0;
  for (const x of rows) {
    const cover = covers.get(x.id) ?? null;
    // a cover that should have been read but wasn't (the call failed) is tried again next time
    if (!cover && x.thumb_key && urlOf.has(x.thumb_key) && !gaveUp.has(x.id)) continue;
    const features: PostFeatures = { v: FEATURES_VERSION, caption: captionShape(x.caption), cover, made: x.job_id && tools.has(x.job_id) ? { tool: tools.get(x.job_id)! } : null };
    const w = await sb.from("studio_perf_posts").update({ features, features_at: now }).eq("id", x.id).eq("user_id", u);
    if (!w.error) n++;
  }
  return { read: n, covers: covers.size };
}

// ---------------------------------------------------------------------------------------------------
// What's working: cards
// ---------------------------------------------------------------------------------------------------
export type Confidence = "strong" | "likely" | "early";
export type CardAction = { tool: "blueprint" | "publish" | "chat" | "copy"; label: string; post_id: string | null; prompt: string | null; text: string | null };
export type WorkingCard = {
  id: string; kind: "cover_face" | "cover_text" | "format" | "caption_length" | "caption_question" | "hashtags" | "timing" | "length" | "clone8";
  title: string; finding: string;
  a: { label: string; n: number; multiple: number | null }; b: { label: string; n: number; multiple: number | null };
  ratio: number | null; confidence: Confidence; p: number | null;
  win_ids: string[]; lose_ids: string[]; action: CardAction | null;
  tags?: Array<{ tag: string; multiple: number; posts: number }>;
};
export type WorkingResult = { cards: WorkingCard[]; pending: string[]; posts_read: number; posts_total: number; youtube_raw: boolean };

/** A small deterministic random source, so the same data gives the same answer on every load. */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** How sure: a two-sided permutation test on the difference of median log-multiples. */
export function permutationP(a: number[], b: number[], rounds = 600, seed = 7): number {
  const la = a.map(Math.log), lb = b.map(Math.log);
  const obs = Math.abs((median(la) ?? 0) - (median(lb) ?? 0));
  const all = [...la, ...lb], n = la.length, rand = rng(seed + a.length * 31 + b.length);
  let hit = 0;
  for (let k = 0; k < rounds; k++) {
    const xs = [...all];
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    const d = Math.abs((median(xs.slice(0, n)) ?? 0) - (median(xs.slice(n)) ?? 0));
    if (d >= obs - 1e-12) hit++;
  }
  return (hit + 1) / (rounds + 1);
}

export function confidenceOf(nA: number, nB: number, p: number): Confidence | null {
  if (nA >= 8 && nB >= 8 && p < 0.05) return "strong";
  if (nA >= 4 && nB >= 4 && p < 0.2) return "likely";
  if (nA >= 3 && nB >= 3) return "early";
  return null;
}

const times = (x: number | null) => (x == null ? "n/a" : `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}×`);
const short = (c: string | null | undefined, n = 40) => { const t = String(c ?? "").replace(TAG_RE, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t || "untitled"; };

/** The cards for one scope (all accounts, one network or one account). Only posts with a multiple count (YouTube
 *  never has one). A card needs 3 posts on each side; "early" cards are kept out of the list unless nothing firmer exists. */
export function whatsWorking(a: Analysis, opts: { offset_min?: number } = {}): WorkingResult {
  const posts = a.posts.filter((p) => p.platform !== "youtube" && p.multiple != null && p.multiple > 0 && p.published_at);
  const feats = (p: PostStats) => ((p as any).features ?? null) as PostFeatures | null;
  const withF = posts.filter((p) => feats(p));
  const cards: WorkingCard[] = [];
  const pending: string[] = [];
  const byMult = (xs: PostStats[]) => [...xs].sort((x, y) => y.multiple! - x.multiple!);
  /** One group against the rest. `title` words the winning side; `oneWay` cards (the best format, time, length, tags)
   *  only say something when the picked group wins. */
  const split = (kind: WorkingCard["kind"], title: (winner: string) => string, aLabel: string, bLabel: string, inA: (p: PostStats) => boolean | null, pool: PostStats[], action: (win: PostStats[]) => CardAction | null, oneWay = false) => {
    const A = pool.filter((p) => inA(p) === true), B = pool.filter((p) => inA(p) === false);
    const mA = median(A.map((p) => p.multiple!)), mB = median(B.map((p) => p.multiple!));
    if (mA == null || mB == null || A.length < 3 || B.length < 3) return;
    const p = permutationP(A.map((x) => x.multiple!), B.map((x) => x.multiple!));
    const conf = confidenceOf(A.length, B.length, p);
    if (!conf) return;
    const ratio = mA / mB;
    // the side that wins leads the card
    const flip = ratio < 1;
    if (flip && oneWay) return;
    const [W, L, wl, ll, mw, ml] = flip ? [B, A, bLabel, aLabel, mB, mA] : [A, B, aLabel, bLabel, mA, mB];
    const r = mw / ml;
    if (r < 1.2) return; // too small a difference to act on
    const win = byMult(W), lose = byMult(L);
    cards.push({
      id: `${kind}:${flip ? "b" : "a"}`, kind, title: title(wl),
      finding: `${wl}: ${times(mw)} your usual views (${W.length} posts). ${ll}: ${times(ml)} (${L.length}).`,
      a: { label: wl, n: W.length, multiple: Math.round(mw * 100) / 100 }, b: { label: ll, n: L.length, multiple: Math.round(ml * 100) / 100 },
      ratio: Math.round(r * 100) / 100, confidence: conf, p: Math.round(p * 1000) / 1000,
      win_ids: win.slice(0, 3).map((x) => x.id), lose_ids: lose.slice(Math.max(0, Math.floor(lose.length / 2) - 1)).slice(0, 2).map((x) => x.id),
      action: action(win),
    });
  };
  const blueprint = (win: PostStats[]): CardAction | null => (win[0] ? { tool: "blueprint", label: "Make 10 originals of the best one", post_id: win[0].id, prompt: null, text: null } : null);
  const write = (label: string): CardAction => ({ tool: "publish", label, post_id: null, prompt: null, text: null });

  // the cover (read by the model)
  const covered = withF.filter((p) => feats(p)!.cover);
  split("cover_face", (w) => `${w} do better`, "Covers with a face", "Covers without a face", (p) => feats(p)?.cover?.face ?? null, covered, blueprint);
  split("cover_text", (w) => `${w} do better`, "Covers with words on them", "Covers without words", (p) => feats(p)?.cover?.text_on_cover ?? null, covered, blueprint);
  // the best format against the rest (formats with 3 posts or more)
  const fmts = [...new Set(covered.map((p) => feats(p)!.cover!.format).filter(Boolean))] as Format[];
  let bestFmt: { f: Format; m: number } | null = null;
  for (const f of fmts) { const xs = covered.filter((p) => feats(p)!.cover!.format === f); if (xs.length >= 3) { const m = median(xs.map((p) => p.multiple!))!; if (!bestFmt || m > bestFmt.m) bestFmt = { f, m }; } }
  if (bestFmt) split("format", (w) => `${w}: your strongest format`, FORMAT_LABEL[bestFmt.f], "Your other formats", (p) => (feats(p)!.cover!.format ? feats(p)!.cover!.format === bestFmt!.f : null), covered, blueprint, true);

  // the caption (counted for every post with features); length matters on TikTok, so it is judged there
  const tt = withF.filter((p) => p.platform === "tiktok");
  split("caption_length", (w) => (w === "Under 100 characters" ? "Short captions do better on TikTok" : "Longer captions do better on TikTok"), "Under 100 characters", "Longer captions", (p) => feats(p)!.caption.chars < 100, tt, () => write("Write my next captions short"));
  split("caption_question", (w) => `${w} do better`, "Captions with a question", "Captions without a question", (p) => feats(p)!.caption.question, withF, () => write("Write my next captions this way"));

  // hashtags: each tag on 3 posts or more, against the posts without it
  const tagStats: Array<{ tag: string; multiple: number; posts: number }> = [];
  const tagsOf = (p: PostStats) => feats(p)?.caption.hashtags ?? [];
  for (const t of new Set(withF.flatMap(tagsOf))) { const xs = withF.filter((p) => tagsOf(p).includes(t)); if (xs.length >= 3) tagStats.push({ tag: t, multiple: Math.round(median(xs.map((p) => p.multiple!))! * 100) / 100, posts: xs.length }); }
  tagStats.sort((x, y) => y.multiple - x.multiple);
  if (tagStats.length >= 2) {
    const best = tagStats.filter((t) => t.multiple >= 1.1).slice(0, 5);
    const pool = withF.filter((p) => tagsOf(p).length);
    if (best.length) split("hashtags", () => "Your best hashtags carry more views", "With these tags", "Other tagged posts", (p) => tagsOf(p).some((t) => best.some((b) => b.tag === t)), pool, () => ({ tool: "copy", label: "Copy my best tags", post_id: null, prompt: null, text: best.map((t) => t.tag).join(" ") }), true);
    const card = cards.find((c) => c.kind === "hashtags");
    if (card) card.tags = tagStats.slice(0, 8);
  }

  // when and how long (every post with a multiple; no model needed)
  const local = (iso: string) => new Date(Date.parse(iso) + (opts.offset_min ?? 0) * 60_000).getUTCHours();
  const BLOCKS = [{ label: "Mornings (6–11 AM)", from: 6, to: 11 }, { label: "Midday (11 AM–2 PM)", from: 11, to: 14 }, { label: "Afternoons (2–6 PM)", from: 14, to: 18 }, { label: "Evenings (6–9 PM)", from: 18, to: 21 }, { label: "Late (9 PM–12 AM)", from: 21, to: 24 }, { label: "Nights (12–6 AM)", from: 0, to: 6 }];
  let bestBlock: { b: (typeof BLOCKS)[number]; m: number } | null = null;
  for (const b of BLOCKS) { const xs = posts.filter((p) => { const h = local(p.published_at!); return h >= b.from && h < b.to; }); if (xs.length >= 3) { const m = median(xs.map((p) => p.multiple!))!; if (!bestBlock || m > bestBlock.m) bestBlock = { b, m }; } }
  if (bestBlock) { const B2 = bestBlock.b; split("timing", (w) => `${w}: your best window`, B2.label, "Other times", (p) => { const h = local(p.published_at!); return h >= B2.from && h < B2.to; }, posts, () => ({ tool: "chat", label: "Schedule my next videos then", post_id: null, prompt: `Schedule my latest videos for ${B2.label.toLowerCase()}, my best posting window`, text: null }), true); }
  const LEN = [{ label: "Under 15 s", from: 0, to: 15 }, { label: "15–30 s", from: 15, to: 30 }, { label: "30–60 s", from: 30, to: 60 }, { label: "1–3 min", from: 60, to: 180 }, { label: "Over 3 min", from: 180, to: 1e9 }];
  const timed = posts.filter((p) => p.duration_s != null);
  let bestLen: { l: (typeof LEN)[number]; m: number } | null = null;
  for (const l of LEN) { const xs = timed.filter((p) => p.duration_s! >= l.from && p.duration_s! < l.to); if (xs.length >= 3) { const m = median(xs.map((p) => p.multiple!))!; if (!bestLen || m > bestLen.m) bestLen = { l, m }; } }
  if (bestLen) { const L2 = bestLen.l; split("length", (w) => `${w} do best`, `Videos of ${L2.label}`, "Other lengths", (p) => p.duration_s! >= L2.from && p.duration_s! < L2.to, timed, blueprint, true); }
  split("clone8", (w) => `${w} do better`, "Posts made with Clone8", "Your other posts", (p) => p.clone8, posts, blueprint);

  // what more data would show
  const unread = posts.length - covered.length;
  if (covered.length < 6) pending.push(unread > 0 ? `Reading ${unread} more covers; face, text and format cards appear after the next refresh.` : `Post ${6 - covered.length} more to see what your covers and formats do.`);
  if (posts.length < 10) pending.push(`Post ${10 - posts.length} more to see your timing and length patterns.`);

  // firm cards first, strongest difference first; early ones only when nothing firmer exists
  const rank = { strong: 0, likely: 1, early: 2 } as const;
  cards.sort((x, y) => rank[x.confidence] - rank[y.confidence] || (y.ratio ?? 0) - (x.ratio ?? 0));
  const firm = cards.filter((c) => c.confidence !== "early");
  const shown = (firm.length ? firm : cards.slice(0, 2)).slice(0, 6);
  return { cards: shown, pending, posts_read: covered.length, posts_total: posts.length, youtube_raw: a.posts.some((p) => p.platform === "youtube") };
}

export const cardLine = (c: WorkingCard) => `${c.title} (${c.confidence}): ${c.finding}`;
export { short as shortCaption };
