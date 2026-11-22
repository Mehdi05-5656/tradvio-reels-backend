// Blueprints v3, phase 1: who a set of versions is for, and what that changes (docs/blueprints/PLAN_V3.md).
//
//   - Purpose: "clip" (someone else's moment for my pages: clippers), "own" (my own content, to test as Trial Reels:
//     personal brands), "brand" (a brand's posts and ads). The page shows it as three chips; the default comes from
//     where the video came from and the sign-up role (suggestPurpose), one tap changes it.
//   - Angles: every opening is written with a named angle for its purpose, shown on the page and in results so a set
//     of versions tests ideas, not skins.
//   - The look read: one small-model look at the stills (it already ran for burned-in captions) now also says what
//     format the video is (stream with facecam + game, podcast, talking head...), which picks the looks offered.
//   - Version captions: one call writes a different post caption for every version of a finished set.
// Platforms count a new opening, informative text and commentary as new; crop, speed, borders and fonts do not
// (PLAN_V3 §1.2). The prompts below follow that.
import type { CapWord } from "./caption-engine.js";
import { claudeJson, type ClipsDeps } from "./studio-clips.js";

export const PURPOSES = ["clip", "own", "brand"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const isPurpose = (v: unknown): v is Purpose => typeof v === "string" && (PURPOSES as readonly string[]).includes(v);

/** The angles an opening can take, per purpose, with the words the page shows. */
export const ANGLES: Record<Purpose, Array<{ id: string; name: string }>> = {
  clip: [{ id: "reaction", name: "Reaction" }, { id: "punchline", name: "Punchline" }, { id: "setup", name: "Setup" }, { id: "reveal", name: "Reveal" }, { id: "quote", name: "Quote" }],
  own: [{ id: "result", name: "Result first" }, { id: "question", name: "Question" }, { id: "contrarian", name: "Contrarian" }, { id: "story", name: "Story" }, { id: "how_to", name: "How-to" }],
  brand: [{ id: "problem", name: "Problem" }, { id: "benefit", name: "Benefit" }, { id: "proof", name: "Proof" }, { id: "offer", name: "Offer" }, { id: "demo", name: "Demo" }],
};
export const ALL_ANGLES = [...new Set(Object.values(ANGLES).flat().map((a) => a.id))];
export const angleOk = (purpose: Purpose, id: unknown): id is string => ANGLES[purpose].some((a) => a.id === id);

/** What each purpose asks of the openings and their title cards (added to the opening writer's instructions). */
export const PURPOSE_PROMPT: Record<Purpose, string> = {
  clip: `THIS SET: a clip of someone else's moment (a live stream, a podcast, a YouTube video), posted by a clip page on several accounts. Platforms only treat a repost as new when it adds something, so:
- Cold opens: the strongest moments of the clip (a reaction, the punchline, the setup that makes you stay, a reveal, a quotable line). Each on a different moment.
- Title cards add CONTEXT the viewer does not get from the line: who this is (only if the words name them), what is happening, what is at stake. Written like a clip channel: third person, present tense, plain ("He thought the car was AI. It wasn't."). Never first person for the person in the clip. Never invent names, numbers or outcomes.
- angle: reaction, punchline, setup, reveal or quote.`,
  own: `THIS SET: the creator's own video, which they will test as several versions (Trial Reels to non-followers) to learn which opening works best. Each version must test a DIFFERENT idea, so:
- Give each cold open a different angle: result (the payoff or result first), question (a question the video answers), contrarian (a line that goes against what people expect), story (the start of a moment or story), how_to (the promise of how to do something). Use each angle at most once while you can.
- Title cards in the creator's own voice (first person when they speak in the first person), naming the topic or the promise, never repeating the line.
- angle: result, question, contrarian, story or how_to.`,
  brand: `THIS SET: a brand's video, for organic posts and ads. Meta and TikTok treat versions as different only when the concept differs, and the brand and the message should land in the first seconds, so:
- Give each cold open a different angle: problem (the problem the product solves), benefit (what you get), proof (a result, a reaction, a number said in the video), offer (a deal or call to action said in the video), demo (the product shown working).
- Title cards in the brand's voice: name the product or the brand when the words do, state the benefit or the problem plainly, no hype words, no claims the video does not make.
- angle: problem, benefit, proof, offer or demo.`,
};

/** The purpose to pre-pick: where the video came from first, then the sign-up role, then what the stills show. */
export function suggestPurpose(o: { probe?: any; role?: string | null; look?: LookRead | null }): Purpose {
  const src = String(o.probe?.source ?? "");
  // made by Clips / Live Clips from a stream or a long video, or imported from someone's post: a clip
  if (src === "clips" || o.probe?.clip || ["tiktok", "instagram", "youtube", "twitch", "kick"].includes(src)) return "clip";
  const role = String(o.role ?? "");
  if (["clipper", "yt_automation", "pages"].includes(role)) return "clip";
  if (["business", "agency"].includes(role)) return "brand";
  if (["creator", "personal_brand", "ugc", "ai_influencer"].includes(role)) return "own";
  if (o.look) {
    if (o.look.format === "stream_game" || o.look.format === "stream_irl" || o.look.format === "podcast") return "clip";
    if (o.look.format === "product" || (o.look.product_or_app && o.look.call_to_action)) return "brand";
  }
  return "own";
}

// ---------------------------------------------------------------------------------------------------
// The look read: burned-in captions + the video's format, one small-model call on the stills
// ---------------------------------------------------------------------------------------------------
export const FORMATS = ["stream_game", "stream_irl", "podcast", "talking_head", "vlog", "product", "other"] as const;
export type Format = (typeof FORMATS)[number];
export type LookRead = { captions: boolean; format: Format; people: number; speaks_to_camera: boolean; facecam_over_gameplay: boolean; landscape_source: boolean; product_or_app: boolean; call_to_action: boolean };
export const LOOK_READ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["captions", "format", "people", "speaks_to_camera", "facecam_over_gameplay", "landscape_source", "product_or_app", "call_to_action"],
  properties: {
    captions: { type: "boolean" }, format: { type: "string", enum: [...FORMATS] }, people: { type: "integer" },
    speaks_to_camera: { type: "boolean" }, facecam_over_gameplay: { type: "boolean" }, landscape_source: { type: "boolean" },
    product_or_app: { type: "boolean" }, call_to_action: { type: "boolean" },
  },
};
export const LOOK_READ_PROMPT = `These are stills from one short vertical video, a few seconds apart, in order. Answer about what you see:
- captions: are there captions burned into the picture, words that follow what is being said (subtitles, word-by-word captions, a line of text that changes from still to still)? Logos, shop signs, product labels, a channel name or one fixed title do not count. True only if speech captions show in at least two stills.
- format: stream_game (a live stream of a game or screen with a facecam), stream_irl (a live stream filmed outdoors or in real life, stream overlays visible), podcast (seated people talking, mics, interview or podcast set, often a wide shot reframed), talking_head (one person speaking to their own camera), vlog (someone filming their life or an experience, moving around), product (a product, app or service shown or sold), other.
- people: how many different people are seen.
- speaks_to_camera: does someone talk straight into the camera?
- facecam_over_gameplay: a small webcam picture of a person over or next to a game or screen?
- landscape_source: a wide (landscape) video placed inside the vertical frame (bars, blur or a band above and below)?
- product_or_app: a product, packaging or an app's screens are clearly shown?
- call_to_action: text on screen asking to buy, follow, comment, sign up or click?`;

const asLook = (o: any): LookRead | null => {
  if (!o || typeof o !== "object" || !(FORMATS as readonly string[]).includes(o.format)) return null;
  const b = (v: unknown) => v === true;
  return { captions: b(o.captions), format: o.format, people: Math.max(0, Math.min(20, Math.round(Number(o.people) || 0))), speaks_to_camera: b(o.speaks_to_camera),
    facecam_over_gameplay: b(o.facecam_over_gameplay), landscape_source: b(o.landscape_source), product_or_app: b(o.product_or_app), call_to_action: b(o.call_to_action) };
};
export async function readLook(deps: ClipsDeps, frames: Array<{ t: number; jpg: Buffer }>, userId?: string): Promise<LookRead | null> {
  const env = deps.env ?? process.env;
  const pick = frames.length <= 6 ? frames : Array.from({ length: 6 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 5)]);
  if (!pick.length) return null;
  const out = await claudeJson(deps, {
    model: env.STUDIO_BLUEPRINTS_CAPTION_MODEL || "claude-haiku-5-5", max_tokens: 300,
    output_config: { effort: "low", format: { type: "json_schema", schema: LOOK_READ_SCHEMA } },
    messages: [{ role: "user", content: [...pick.map((f) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } })), { type: "text", text: LOOK_READ_PROMPT }] }],
  }, "blueprints_look_read", userId);
  return asLook(out);
}

/** The looks pre-picked for a purpose and a format (the person can change them). Split gameplay is never pre-picked
 *  for a brand, and stays a choice for clips (platforms do not count a template alone as new). */
export function defaultLooks(purpose: Purpose, look?: LookRead | null): string[] {
  if (purpose === "brand") return ["card", "clean"];
  if (purpose === "own") return ["clean", "editorial"];
  if (look?.format === "podcast" || look?.landscape_source) return ["card", "loud"];
  return ["clean", "loud"];
}
export const DEFAULT_OPENINGS: Record<Purpose, number> = { clip: 3, own: 3, brand: 3 };

// ---------------------------------------------------------------------------------------------------
// A different post caption for every version of a finished set
// ---------------------------------------------------------------------------------------------------
export type VersionCaption = { index: number; caption: string; hashtags: string[]; youtube_title: string | null };
export const VERSION_CAPTIONS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["captions"],
  properties: { captions: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "caption", "hashtags", "youtube_title"],
    properties: { index: { type: "integer" }, caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, youtube_title: { anyOf: [{ type: "string" }, { type: "null" }] } } } } },
};
const VOICE: Record<Purpose, string> = {
  clip: "A clip page posting someone else's moment: third person, plain, add the context (who, what is happening) the way clip channels do; never pretend to be the person in the clip.",
  own: "The creator posting their own video: their voice, first person when they speak in the first person.",
  brand: "The brand posting: clear and warm, the benefit or the problem plainly, no hype words, no claims the video does not make.",
};
export const VERSION_CAPTIONS_SYSTEM = `You write the post text for several versions of the same short video. Each version opens differently (its opening line and title card are given), and each will be posted separately, so each caption must be clearly different from the others: a different first line that matches that version's opening, a different angle, different hashtags where it makes sense. They must not read like the same caption reworded.
Rules for every caption:
- The first line is the hook, under 90 characters, specific to the video, no clickbait the video does not deliver. Then at most one or two short lines if they add something.
- Use the language spoken in the video. One or two emoji at most, only if they fit. No quotation marks around the caption.
- Never invent facts, names, prices or claims that the words do not support. Never mention how the video was made, AI, editing or any tool.
- hashtags: 3 to 6, specific to the content, lowercase unless a proper noun, each starting with #, #fyp at most once in the whole set.
- youtube_title: at most 80 characters when YouTube is a target, otherwise null.
Return one entry per version, with its index.`;

export function versionCaptionsMessage(o: { purpose: Purpose; words: CapWord[]; versions: Array<{ index: number; title: string; line: string; angle?: string | null; look: string }>; platforms: string[] }): string {
  const said = o.words.map((w) => w.text).join(" ").slice(0, 6000);
  const list = o.versions.map((v) => `${v.index}. opening line: "${v.line}" · title card: "${v.title.replace(/\*/g, "")}"${v.angle ? ` · angle: ${v.angle}` : ""} · look: ${v.look}`).join("\n");
  return `Who is posting: ${VOICE[o.purpose]}\nPosting to: ${o.platforms.join(", ") || "TikTok, Instagram Reels"}.\n\nWhat is said in the video:\n"""${said}"""\n\nThe versions:\n${list}`;
}
export function cleanVersionCaptions(raw: unknown, indexes: number[], youtube: boolean): VersionCaption[] {
  const got = new Map<number, VersionCaption>();
  for (const c of Array.isArray((raw as any)?.captions) ? (raw as any).captions : []) {
    const i = Number(c?.index);
    if (!indexes.includes(i) || got.has(i)) continue;
    const caption = String(c?.caption ?? "").replace(/^["“]|["”]$/g, "").trim().slice(0, 2000);
    if (!caption) continue;
    const tags = [...new Set((Array.isArray(c?.hashtags) ? c.hashtags : []).map((t: unknown) => String(t).trim().replace(/\s+/g, "")).filter((t: string) => /^#[\p{L}\p{N}_]{2,60}$/u.test(t)))].slice(0, 6) as string[];
    const title = youtube && typeof c?.youtube_title === "string" && c.youtube_title.trim() ? Array.from(c.youtube_title.trim()).slice(0, 100).join("") : null;
    got.set(i, { index: i, caption, hashtags: tags, youtube_title: title });
  }
  return indexes.filter((i) => got.has(i)).map((i) => got.get(i)!);
}
export async function writeVersionCaptions(deps: ClipsDeps, o: Parameters<typeof versionCaptionsMessage>[0], userId?: string): Promise<VersionCaption[]> {
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_BLUEPRINTS_CAPTIONS_MODEL || "claude-sonnet-5-5", max_tokens: 6000, system: VERSION_CAPTIONS_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: VERSION_CAPTIONS_SCHEMA } },
    messages: [{ role: "user", content: versionCaptionsMessage(o) }],
  }, "blueprints_version_captions", userId);
  return cleanVersionCaptions(out, o.versions.map((v) => v.index), o.platforms.includes("youtube"));
}
