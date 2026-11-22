// Blueprints v2, the read step: once per video, before any version is planned.
//   1. Hooks: one Claude call on the video's own words picks the lines that work as a cold open and writes a title
//      card for each (writeHooks). It may only use lines the person actually says; titles never invent facts.
//   2. Framing: where the face (or main subject) is over time, from Split screen's face reader on a still a second
//      (readSubjects), turned into the EDL's focus_track (focusTrack).
// Both calls go through claudeJson, which logs a "[cost] claude" line per call (the cost ledger picks it up).
import type { CapWord } from "./caption-engine.js";
import { claudeJson, type ClipsDeps } from "./studio-clips.js";
import { BLUEPRINT_LIMITS, type Hook } from "./studio-blueprints.js";
import type { Subject } from "./splitscreen-layout.js";
import { ALL_ANGLES, ANGLES, PURPOSE_PROMPT, angleOk, type Purpose } from "./studio-blueprints-purpose.js";

/** The schema for a purpose: the angle can only be one of that purpose's angles (no purpose: any). */
export const hookSchema = (purpose?: Purpose | null) => ({ ...HOOK_SCHEMA, properties: { hooks: { ...HOOK_SCHEMA.properties.hooks, items: { ...HOOK_SCHEMA.properties.hooks.items,
  properties: { ...HOOK_SCHEMA.properties.hooks.items.properties, angle: { type: "string", enum: purpose ? ANGLES[purpose].map((a) => a.id) : ALL_ANGLES } } } } } });
export const HOOK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["hooks"],
  properties: { hooks: { type: "array", items: { type: "object", additionalProperties: false, required: ["first", "last", "title", "why", "angle"],
    properties: { first: { type: "integer" }, last: { type: "integer" }, title: { type: "string" }, why: { type: "string" }, angle: { type: "string", enum: ALL_ANGLES } } } } },
};

export const HOOK_SYSTEM = `You edit short vertical videos (Reels, TikTok, Shorts). You are given the exact words of one video, numbered, with the second each word starts. You write cold opens for new versions of it.

A cold open is a stretch of the person's OWN words, played at the very start of the video, before it plays from the top. It has to stop someone scrolling in the first second and make them want to see the rest. Good ones: a question the video answers, a surprising or funny line, a strong reaction, a bold claim, the moment of a reveal or a payoff. Bad ones: greetings, filler, a line that only makes sense with what came before it, anything from the first three seconds (the video opens with that anyway), a line that reads as crude, sexual or mean once it is cut out of its moment, and a line where a word looks misheard by the transcript (a word that does not fit the sentence): skip those.

The title card is NOT a caption of the line. The viewer hears the line; the title gives what the line does not: what this video is, where it happens or what it promises (the topic, the place, the stakes, the payoff), so line + title together make one hook. Never repeat the line's own words in the title, apart from the one key word if needed.

For each cold open give:
- first, last: the numbers of its first and last word. It must start at the start of a phrase and end at the end of a thought. Between 1 and 6 seconds long (from the first word's start to the last word's end, using the times given).
- title: 3 to 9 words, in the video's language, in the creator's own voice (first person when they speak in the first person). Put the one or two words that carry it between *stars*, like: I counted every *KitKat* in this store. It must be true to what the video shows and says: never invent a number, a place, a product or an outcome that is not in the words or clearly implied by them. No emoji, no hashtags, no capitals for shouting, no question marks unless it is a real question.
- why: a few words on why this one stops a scroll.

Spread them over the whole video (its middle and its end too, where payoffs usually are), each on a different moment and with a different angle in its title. The titles must not read alike: no shared main word, no two built the same way ("I ... the ..."), each one would make a different person stop. Best first.`;

/** The words as the model reads them: "[12 @3.40] word". */
export function hookMessage(words: CapWord[], n: number, goal?: string | null, purpose?: Purpose | null): string {
  const lines = words.map((w, i) => `[${i} @${w.start.toFixed(2)}] ${w.text}`).join("\n");
  const end = words.length ? words[words.length - 1].end : 0;
  return `${purpose ? `${PURPOSE_PROMPT[purpose]}\n\n` : ""}The video lasts ${end.toFixed(1)} s. ${goal ? `The creator says it is for: ${goal.slice(0, 200)}\n` : ""}Write ${n} cold opens.\n\nWords:\n${lines}`;
}

const STARS = /\*([^*]+)\*/g;
/** What came back, made safe: real word ranges inside the limits, not in the opening, no two on the same moment,
 *  titles short with at most two starred words. Bad entries are dropped, never repaired into something unsaid. */
export function cleanHooks(raw: unknown, words: CapWord[], n: number, purpose?: Purpose | null): Hook[] {
  const list: any[] = Array.isArray((raw as any)?.hooks) ? (raw as any).hooks : [];
  const out: Hook[] = [];
  for (const h of list) {
    const first = Number(h?.first), last = Number(h?.last);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last >= words.length || last < first) continue;
    let end = last;
    // too long: keep it from the start, ending on the last word that fits
    while (end > first && words[end].end - words[first].start > BLUEPRINT_LIMITS.hook_max) end--;
    const a = words[first].start, b = words[end].end;
    if (b - a < BLUEPRINT_LIMITS.hook_min || b - a > BLUEPRINT_LIMITS.hook_max || a < 3) continue;
    if (out.some((o) => o.start! < b && a < o.end!)) continue;
    let title = String(h?.title ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if ((title.match(/\*/g) ?? []).length % 2) title = title.replace(/\*/g, "");
    const starred = [...title.matchAll(STARS)].length;
    if (starred > 2) title = title.replace(STARS, "$1");
    const plain = title.replace(/\*/g, "");
    const count = plain.split(" ").filter(Boolean).length;
    if (!plain || plain.length > 70 || count < 2 || count > 12 || /[#\u{1F300}-\u{1FAFF}]/u.test(plain)) continue;
    const angle = purpose && angleOk(purpose, h?.angle) ? String(h.angle) : null;
    out.push({ id: `h${out.length + 1}`, title, start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000, ...(purpose ? { angle } : {}) });
    if (out.length >= n) break;
  }
  return out;
}

export async function writeHooks(deps: ClipsDeps, words: CapWord[], opts: { n: number; goal?: string | null; userId?: string; purpose?: Purpose | null }): Promise<Hook[]> {
  const env = deps.env ?? process.env;
  const n = Math.max(1, Math.min(BLUEPRINT_LIMITS.max_hooks, Math.floor(opts.n)));
  if (words.length < 6) return [];
  const out = await claudeJson(deps, {
    model: env.STUDIO_BLUEPRINTS_HOOK_MODEL || "claude-sonnet-5-5", max_tokens: 4000, system: HOOK_SYSTEM,
    output_config: { effort: env.STUDIO_BLUEPRINTS_HOOK_EFFORT || "medium", format: { type: "json_schema", schema: hookSchema(opts.purpose) } },
    // ask for a few extra: some may fail the checks
    messages: [{ role: "user", content: hookMessage(words, Math.min(BLUEPRINT_LIMITS.max_hooks, n + 2), opts.goal, opts.purpose) }],
  }, "blueprints_hooks", opts.userId);
  return cleanHooks(out, words, n, opts.purpose);
}

/** The face reads as a framing track. A face's crop centre is nudged up by a fifth of the face's height, so the eyes
 *  sit above the middle of the frame and the chin clears the captions. A subject is centred as it is. `h` is the
 *  face's height share (0 for a subject): the worker caps a punch-in so a face never fills more than 70 % of the crop.
 *  Screens and empty frames give no read (the worker keeps the plan's centre there). */
export function focusTrack(reads: Array<Subject & { t: number }>): Array<{ t: number; cx: number; cy: number; h: number }> {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return reads.filter((r) => r.kind === "face" || r.kind === "subject").map((r) => ({
    t: r.t, cx: c(r.x), cy: c(r.kind === "face" ? r.y - (r.h ?? 0) * 0.2 : r.y), h: r.kind === "face" ? c(r.h ?? 0) : 0,
  }));
}

/** Captions already burned into the picture (a clip from Clips with captions, an edited upload): one look at a few
 *  stills by the small model. A version would otherwise carry two sets of captions. */
export const CAPTION_CHECK_SCHEMA = { type: "object", additionalProperties: false, required: ["captions"], properties: { captions: { type: "boolean" } } };
export const CAPTION_CHECK_PROMPT = `These are stills from one short video, a few seconds apart. Are there captions burned into the picture: words that follow what is being said, shown over the video (subtitles, word-by-word captions, a line of text that changes from still to still)? Logos, shop signs, product labels, a channel name or one fixed title do not count. Answer true only if speech captions show in at least two of the stills.`;
export async function hasBurnedCaptions(deps: ClipsDeps, frames: Array<{ t: number; jpg: Buffer }>, userId?: string): Promise<boolean> {
  const env = deps.env ?? process.env;
  const pick = frames.length <= 6 ? frames : Array.from({ length: 6 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 5)]);
  if (!pick.length) return false;
  const out = await claudeJson(deps, {
    model: env.STUDIO_BLUEPRINTS_CAPTION_MODEL || "claude-haiku-5-5", max_tokens: 200,
    output_config: { effort: "low", format: { type: "json_schema", schema: CAPTION_CHECK_SCHEMA } },
    messages: [{ role: "user", content: [...pick.map((f) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } })), { type: "text", text: CAPTION_CHECK_PROMPT }] }],
  }, "blueprints_caption_check", userId);
  return out?.captions === true;
}

