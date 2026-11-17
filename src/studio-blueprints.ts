// Blueprints v2: one video in, many edited versions out (hooks x looks). This file is the plan side: from a video's
// words, one hook and one look it writes an edit decision list (EDL) that the Blueprint worker renders with ffmpeg
// (tradvio-features-worker/blueprint_versions.py). Pure: no network, no storage; fonts are read only to measure text.
//
// A hook is a cold open: a line from later in the video played first, with a title card over it, then the video from
// the top. A look is everything else that changes the picture and sound: framing (fill, card, split), punch-ins,
// pace (pauses cut or kept), captions style, grade, music bed and sound effects.
// Behind STUDIO_BLUEPRINTS_V2_ENABLED (owner only) and STUDIO_BLUEPRINTS_V2_OPEN (customers); both default off.
import { FONTS, assSize, presetById, type CapWord, type FontInfo, type Frame } from "./caption-engine.js";
import { captionAss, serverMeasure } from "./studio-caption-video.js";

type Env = Record<string, string | undefined>;
export const blueprintsV2Enabled = (env: Env = process.env) => env.STUDIO_BLUEPRINTS_V2_ENABLED === "true";
export const blueprintsV2Open = (env: Env = process.env) => blueprintsV2Enabled(env) && env.STUDIO_BLUEPRINTS_V2_OPEN === "true";

export const BLUEPRINT_OUT = { w: 1080, h: 1920, fps: 30 } as const;
export const BLUEPRINT_LIMITS = { min_seconds: 5, max_seconds: 180, max_versions: 50, max_hooks: 10, max_looks: 5, hook_min: 1, hook_max: 6 } as const;

// ---------------------------------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------------------------------
export type LookId = "clean" | "card" | "editorial" | "loud" | "split";
export type Grade = "bright" | "warm" | "moody" | "punchy" | "none";
export type TitleStyle = { font: string; accent: string; size: number; color: string; accentColor: string; box: string | null; y: number; persist: boolean };
export type Look = {
  id: LookId; name: string; blurb: string;
  layout: "fill" | "card" | "split";
  captions: string;             // a caption preset id (caption-engine PRESETS)
  captionY: number | null;      // the caption block's centre, share of the frame's height; null = the preset's own
  grade: Grade;
  punch: number[];              // zoom per body segment, cycled; [1] = no punch-ins
  tighten: number | null;       // pauses longer than this many seconds are cut; null = the video's own pace
  music: { mood: string; db: number } | null;
  sfx: { cut: string | null; keywords: string[] | null; rise: string | null; db: number };
  title: TitleStyle;
};
const T = (t: Partial<TitleStyle>): TitleStyle => ({ font: "montserrat_black", accent: "dm_serif_italic", size: 78, color: "#FFFFFF", accentColor: "#FFD36B", box: "#111111", y: 0.17, persist: false, ...t });
export const LOOKS: Look[] = [
  { id: "clean", name: "Clean", blurb: "Tight on the face with punch-ins, bold captions, bright.", layout: "fill", captions: "bold_pop", captionY: 0.7, grade: "bright",
    punch: [1, 1.18], tighten: null, music: { mood: "mood-playful", db: -26 }, sfx: { cut: "whoosh-2", keywords: null, rise: null, db: -14 }, title: T({ size: 96 }) },
  { id: "card", name: "Podcast card", blurb: "The video in a framed card, a headline above, serif captions below.", layout: "card", captions: "luxe", captionY: 0.875, grade: "warm",
    punch: [1, 1.08], tighten: null, music: { mood: "mood-calm-curious", db: -27 }, sfx: { cut: null, keywords: null, rise: null, db: -16 },
    title: T({ font: "poppins_semibold", size: 80, box: null, y: 0.1, persist: true }) },
  { id: "editorial", name: "Editorial", blurb: "Moody grade and vignette, serif captions, slow and close.", layout: "fill", captions: "luxe", captionY: 0.74, grade: "moody",
    punch: [1.06, 1.12], tighten: null, music: { mood: "mood-wistful", db: -25 }, sfx: { cut: "whoosh-5", keywords: null, rise: null, db: -16 },
    title: T({ font: "dm_serif", accent: "dm_serif_italic", size: 100, color: "#F6E7C8", accentColor: "#FFFFFF", box: null, y: 0.2 }) },
  { id: "loud", name: "Loud", blurb: "Pauses cut, hard punch-ins, big captions, hits on the key words.", layout: "fill", captions: "headline", captionY: 0.66, grade: "punchy",
    punch: [1, 1.28, 1.12, 1.4], tighten: 0.28, music: { mood: "mood-playful", db: -21 }, sfx: { cut: "hit-2", keywords: ["pop-1", "pop-6", "pop-7"], rise: "rise-2", db: -12 },
    title: T({ font: "anton", accent: "anton", size: 116, accentColor: "#FF2E63", box: "#000000" }) },
  { id: "split", name: "Split", blurb: "Your video on top, satisfying gameplay below, captions on the seam.", layout: "split", captions: "one_word", captionY: 0.5, grade: "bright",
    punch: [1.1], tighten: 0.45, music: null, sfx: { cut: "whoosh-2", keywords: null, rise: null, db: -14 }, title: T({ size: 88, y: 0.12 }) },
];
export const lookById = (id: unknown): Look | null => LOOKS.find((l) => l.id === id) ?? null;

// ---------------------------------------------------------------------------------------------------
// Hooks and the timeline
// ---------------------------------------------------------------------------------------------------
/** A hook: the title card text (words in *stars* get the accent font) and the source stretch played first.
 *  start = end = null keeps the video's own opening and only adds the title. */
export type Hook = { id: string; title: string; start: number | null; end: number | null };
export type Segment = { a: number; b: number; zoom: number; at: number; hook?: boolean };
export type Timeline = { segments: Segment[]; words: CapWord[]; duration: number; hookEnd: number };

const PAD = 0.08, HOOK_LEAD = 0.05, HOOK_TAIL = 0.18;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Stretches of the source to keep: the whole video, or, when tightening, each run of speech with pauses longer than
 *  `gap` cut out (a short pad kept either side so no word is clipped). Splits at sentence ends so punch-ins land on
 *  thoughts. */
export const STRETCH = { min: 1.6, soft: 2.6, max: 4.5 } as const;
export function bodyStretches(words: CapWord[], duration: number, gap: number | null): Array<{ a: number; b: number }> {
  if (!words.length) return [{ a: 0, b: duration }];
  // how good a place the end of word i is to cut: a sentence end, a comma or a breath, or just a word boundary
  const score = (i: number) => {
    const w = words[i], next = words[i + 1];
    if (/[.?!]["')\]]?$/.test(w.text)) return 3;
    if (/[,;:]$/.test(w.text) || (next && next.start - w.end >= 0.25)) return 2;
    return 1;
  };
  const out: Array<{ a: number; b: number }> = [];
  let a = gap == null ? 0 : Math.max(0, words[0].start - PAD);
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (!next) { out.push({ a, b: gap == null ? duration : Math.min(duration, w.end + PAD * 2) }); return; }
    const pause = next.start - w.end;
    if (gap != null && pause > gap) { out.push({ a, b: Math.min(duration, w.end + PAD) }); a = Math.max(0, next.start - PAD); return; }
    // the cut sits in the middle of the pause, so nothing is removed and no word is clipped
    const cut = w.end + pause / 2, len = cut - a, s = score(i);
    if ((s === 3 && len >= STRETCH.min) || (s === 2 && len >= STRETCH.soft) || len >= STRETCH.max) { out.push({ a, b: cut }); a = cut; }
  });
  // a stretch too short to read as a shot joins the one before it
  const merged: Array<{ a: number; b: number }> = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.b - s.a < 0.7 && Math.abs(prev.b - s.a) < 1e-6) prev.b = s.b; else merged.push({ ...s });
  }
  return merged.filter((s) => s.b - s.a > 0.05);
}

/** The output timeline: the hook stretch (if any), then the body; every word placed at its time in the output. */
export function buildTimeline(words: CapWord[], duration: number, hook: Hook, look: Look): Timeline {
  const segs: Segment[] = [];
  let at = 0;
  const top = Math.max(...look.punch);
  if (hook.start != null && hook.end != null) {
    // stop before the next word starts, so the cold open ends on its own last word
    const next = words.find((w) => w.start >= hook.end! - 0.01);
    const before = words.filter((w) => w.end <= hook.start! + 0.01).pop();
    const a = Math.max(0, hook.start - HOOK_LEAD, before ? before.end : 0);
    const b = Math.min(duration, hook.end + HOOK_TAIL, next ? next.start - 0.02 : Infinity);
    segs.push({ a: r3(a), b: r3(b), zoom: top, at: 0, hook: true });
    at = b - a;
  }
  const hookEnd = at;
  bodyStretches(words, duration, look.tighten).forEach((s, i) => {
    segs.push({ a: r3(s.a), b: r3(s.b), zoom: look.punch[i % look.punch.length], at: r3(at) });
    at += s.b - s.a;
  });
  const placed: CapWord[] = [];
  for (const s of segs) for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (mid < s.a || mid >= s.b) continue;
    placed.push({ ...w, start: r3(s.at + Math.max(0, w.start - s.a)), end: r3(s.at + Math.min(s.b - s.a, w.end - s.a)) });
  }
  return { segments: segs, words: placed, duration: r3(at), hookEnd: r3(hookEnd) };
}

// ---------------------------------------------------------------------------------------------------
// The overlay: the hook's title card, as ASS (same conventions as the caption engine)
// ---------------------------------------------------------------------------------------------------
type Run = { text: string; accent: boolean };
const runsOf = (title: string): Run[] => title.split(/(\*[^*]+\*)/).filter(Boolean).map((p) => (p.startsWith("*") && p.endsWith("*") ? { text: p.slice(1, -1), accent: true } : { text: p, accent: false }));
const assColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
const tc = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100; return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}.${String(c).padStart(2, "0")}`; };
const esc = (t: string) => t.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")");
const r1 = (x: number) => Math.round(x * 10) / 10;
type Measure = (text: string, f: FontInfo, em: number) => number;

/** Words of the title wrapped into at most three lines inside `maxW`, each word keeping its run's font. */
export function wrapTitle(title: string, st: TitleStyle, em: number, maxW: number, measure: Measure) {
  const base = FONTS[st.font] ?? FONTS.montserrat_black, acc = FONTS[st.accent] ?? base;
  const words = runsOf(title).flatMap((r) => r.text.split(/\s+/).filter(Boolean).map((t) => ({ t, accent: r.accent })));
  const w = (x: { t: string; accent: boolean }) => measure(x.t, x.accent ? acc : base, em);
  const space = measure(" ", base, em);
  const lines: Array<Array<{ t: string; accent: boolean }>> = [[]];
  let width = 0;
  for (const x of words) {
    const add = (lines[lines.length - 1].length ? space : 0) + w(x);
    if (width + add > maxW && lines[lines.length - 1].length) { lines.push([x]); width = w(x); } else { lines[lines.length - 1].push(x); width += add; }
  }
  return lines.slice(0, 3).map((ln) => ({ words: ln, width: ln.reduce((s, x, i) => s + w(x) + (i ? space : 0), 0) }));
}

/** ASS for the title card: shown from `from` to `to`, with a soft rise in, and a short white flash at `flash`. */
export function overlayAss(title: string, st: TitleStyle, fr: Frame, from: number, to: number, flash: number | null, measure: Measure = serverMeasure()): string {
  const k = Math.min(fr.w, fr.h) / 1080, em = st.size * k;
  const base = FONTS[st.font] ?? FONTS.montserrat_black, acc = FONTS[st.accent] ?? base;
  const lines = wrapTitle(title, st, em, fr.w * 0.8, measure);
  const lineH = em * 1.18, padX = 34 * k, padY = 18 * k;
  const top = fr.h * st.y - (lines.length * lineH) / 2;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${fr.w}`, `PlayResY: ${fr.h}`, "ScaledBorderAndShadow: yes", "WrapStyle: 2", "YCbCr Matrix: None", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: T,${base.name},${r1(assSize(base, em))},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev: string[] = [];
  const fade = `\\fad(180,${st.persist ? 0 : 160})`;
  lines.forEach((ln, i) => {
    const cy = top + lineH * (i + 0.5);
    if (st.box) {
      const bw = ln.width + 2 * padX, bh = lineH + padY;
      ev.push(`Dialogue: 0,${tc(from)},${tc(to)},T,,0,0,0,,{\\an5\\pos(${r1(fr.w / 2)},${r1(cy)})\\p1\\bord0\\shad0\\1c${assColor(st.box)}\\1a&H18&${fade}}m 0 0 l ${r1(bw)} 0 l ${r1(bw)} ${r1(bh)} l 0 ${r1(bh)}`);
    }
    const shadow = st.box ? "\\bord0\\shad0" : `\\bord0\\shad${r1(4 * k)}\\4c&H000000&\\4a&H60&`;
    // each word in its run's font; the space before a word stays in the base font
    const text = ln.words.map((x, j) => {
      const f = x.accent ? acc : base;
      const sp = j ? `{\\fn${base.name}\\fs${r1(assSize(base, em))}} ` : "";
      return `${sp}{\\fn${f.name}\\fs${r1(assSize(f, em))}\\1c${assColor(x.accent ? st.accentColor : st.color)}}${esc(x.t)}`;
    }).join("");
    // \move only: libass keeps the first of \pos and \move on a line
    ev.push(`Dialogue: 1,${tc(from)},${tc(to)},T,,0,0,0,,{\\an5\\move(${r1(fr.w / 2)},${r1(cy + 26 * k)},${r1(fr.w / 2)},${r1(cy)},0,220)${shadow}${fade}}${text}`);
  });
  if (flash != null) ev.push(`Dialogue: 2,${tc(Math.max(0, flash - 0.04))},${tc(flash + 0.16)},T,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&HFFFFFF&\\alpha&H40&\\t(40,200,\\alpha&HFF&)}m 0 0 l ${fr.w} 0 l ${fr.w} ${fr.h} l 0 ${fr.h}`);
  return [...head, ...ev, ""].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The EDL the worker renders
// ---------------------------------------------------------------------------------------------------
export type Rect = { x: number; y: number; w: number; h: number };
export type Edl = {
  v: 1; version: string; look: LookId; hook: string;
  out: { w: number; h: number; fps: number };
  duration: number;
  layout: "fill" | "card" | "split";
  /** where the person's picture goes: the whole frame, the card, or the top half */
  slot: Rect;
  /** the framing centre in the source (share of width and height), from the face read */
  focus: { cx: number; cy: number };
  segments: Segment[];
  grade: Grade;
  captions_ass: string;
  overlay_ass: string;
  music: { key: string; db: number; duck: boolean } | null;
  sfx: Array<{ key: string; at: number; db: number }>;
  game: { key: string; start: number } | null;
};

export function slotFor(look: Look, out: Frame): Rect {
  if (look.layout === "card") { const w = Math.round(out.w * 0.889 / 2) * 2, h = Math.round((w * 5) / 4 / 2) * 2; return { x: (out.w - w) / 2, y: Math.round(out.h * 0.19), w, h }; }
  if (look.layout === "split") return { x: 0, y: 0, w: out.w, h: out.h / 2 };
  return { x: 0, y: 0, w: out.w, h: out.h };
}

/** Sound effects: one at the cut out of the hook (with a rise into it), and, for looks that have them, a soft hit on key
 *  words at least 1.6 s apart (never in the hook, never in the last second). */
export function sfxFor(look: Look, tl: Timeline): Edl["sfx"] {
  const out: Edl["sfx"] = [];
  if (tl.hookEnd > 0 && look.sfx.cut) out.push({ key: look.sfx.cut, at: r3(Math.max(0, tl.hookEnd - 0.12)), db: look.sfx.db });
  if (tl.hookEnd > 0 && look.sfx.rise) out.push({ key: look.sfx.rise, at: r3(Math.max(0, tl.hookEnd - 1.1)), db: look.sfx.db - 4 });
  if (look.sfx.keywords?.length) {
    let last = -Infinity, n = 0;
    for (const w of tl.words) {
      if (!w.key || w.start < tl.hookEnd + 0.4 || w.start > tl.duration - 1 || w.start - last < 1.6) continue;
      out.push({ key: look.sfx.keywords[n++ % look.sfx.keywords.length], at: r3(w.start), db: look.sfx.db });
      last = w.start;
    }
  }
  return out;
}

export type PlanInput = { words: CapWord[]; duration: number; hook: Hook; look: Look; focus?: { cx: number; cy: number }; game?: { key: string; start: number } | null; env?: Env };
export function planVersion(p: PlanInput): Edl {
  const out = BLUEPRINT_OUT, fr: Frame = { w: out.w, h: out.h };
  const tl = buildTimeline(p.words, p.duration, p.hook, p.look);
  const preset = presetById(p.look.captions);
  const style = { ...preset, ...(p.look.captionY != null ? { y: p.look.captionY } : {}) };
  // captions only after the cold open: the title card has the screen during the hook
  const body = tl.words.filter((w) => w.start >= tl.hookEnd - 0.01);
  const captions = captionAss(body, { style, keywords: true, fillers: true, censor: false }, fr, p.env);
  const titleTo = p.look.title.persist ? tl.duration : Math.max(tl.hookEnd + 0.5, Math.min(tl.duration, 2.6));
  const overlay = overlayAss(p.hook.title, p.look.title, fr, 0, titleTo, tl.hookEnd > 0 ? tl.hookEnd : null, serverMeasure(p.env));
  return {
    v: 1, version: `${p.hook.id}-${p.look.id}`, look: p.look.id, hook: p.hook.id,
    out: { ...out }, duration: tl.duration, layout: p.look.layout, slot: slotFor(p.look, fr),
    focus: p.focus ?? { cx: 0.5, cy: 0.42 }, segments: tl.segments, grade: p.look.grade,
    captions_ass: captions, overlay_ass: overlay,
    music: p.look.music ? { key: p.look.music.mood, db: p.look.music.db, duck: true } : null,
    sfx: sfxFor(p.look, tl),
    game: p.look.layout === "split" ? (p.game ?? null) : null,
  };
}
