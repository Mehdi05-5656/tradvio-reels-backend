// Clone8 Captions: the one engine behind both the burned-in captions (the server writes an ASS file for libass) and the
// live preview on the page (a canvas draws the same thing). Pure functions, no imports: the same file sits in the
// dashboard (src/lib/caption-engine.ts). Change one, copy it to the other; a test compares them by hash.
//
// How it works: timed words -> chunks (a few words on screen at once) -> laid out (every word's own position, from the
// font's real widths) -> phases (what each word looks like and how it moves in each stretch of time) -> ASS events, or
// a canvas frame. Every size is in pixels of a 1080-wide (or 1080-tall, for landscape) frame and scaled to the video.
//
// Sizes match libass exactly: it sets a font's em to fontsize x unitsPerEm / (winAscent + winDescent) and puts the
// baseline winAscent below the top of the line box (measured Nov 1 2026: predicted ink 107-552 px, rendered 107-551).

// ---------------------------------------------------------------------------------------------------
// Fonts: the bundled files (OFL / Apache) and the metrics libass sizes them by
// ---------------------------------------------------------------------------------------------------
export type FontInfo = { file: string; name: string; label: string; upem: number; asc: number; desc: number; cap: number };
export const FONTS: Record<string, FontInfo> = {
  montserrat_black: { file: "Montserrat-Black.ttf", name: "Montserrat Black", label: "Montserrat Black", upem: 1000, asc: 1109, desc: 453, cap: 700 },
  montserrat_xbold: { file: "Montserrat-ExtraBold.ttf", name: "Montserrat ExtraBold", label: "Montserrat ExtraBold", upem: 1000, asc: 1109, desc: 453, cap: 700 },
  anton: { file: "Anton-Regular.ttf", name: "Anton Regular", label: "Anton", upem: 2048, asc: 2876, desc: 674, cap: 1760 },
  bebas: { file: "BebasNeue-Regular.ttf", name: "Bebas Neue Regular", label: "Bebas Neue", upem: 1000, asc: 950, desc: 350, cap: 700 },
  bangers: { file: "Bangers-Regular.ttf", name: "Bangers Regular", label: "Bangers", upem: 1000, asc: 1401, desc: 356, cap: 721 },
  archivo_black: { file: "ArchivoBlack-Regular.ttf", name: "Archivo Black Regular", label: "Archivo Black", upem: 1000, asc: 1035, desc: 312, cap: 688 },
  poppins_bold: { file: "Poppins-Bold.ttf", name: "Poppins Bold", label: "Poppins Bold", upem: 1000, asc: 1135, desc: 627, cap: 705 },
  poppins_xbold: { file: "Poppins-ExtraBold.ttf", name: "Poppins ExtraBold", label: "Poppins ExtraBold", upem: 1000, asc: 1135, desc: 627, cap: 709 },
  poppins_semibold: { file: "Poppins-SemiBold.ttf", name: "Poppins SemiBold", label: "Poppins SemiBold", upem: 1000, asc: 1135, desc: 627, cap: 701 },
  kanit_black: { file: "Kanit-Black.ttf", name: "Kanit Black", label: "Kanit Black", upem: 1000, asc: 1180, desc: 400, cap: 644 },
  kanit_xbold: { file: "Kanit-ExtraBold.ttf", name: "Kanit ExtraBold", label: "Kanit ExtraBold", upem: 1000, asc: 1180, desc: 400, cap: 644 },
  lilita: { file: "LilitaOne-Regular.ttf", name: "Lilita One", label: "Lilita One", upem: 1000, asc: 923, desc: 220, cap: 704 },
  luckiest: { file: "LuckiestGuy-Regular.ttf", name: "Luckiest Guy Regular", label: "Luckiest Guy", upem: 2048, asc: 2006, desc: 504, cap: 1424 },
  titan: { file: "TitanOne-Regular.ttf", name: "Titan One", label: "Titan One", upem: 1000, asc: 970, desc: 175, cap: 710 },
  dm_serif: { file: "DMSerifDisplay-Regular.ttf", name: "DM Serif Display Regular", label: "DM Serif Display", upem: 1000, asc: 1036, desc: 335, cap: 660 },
  dm_serif_italic: { file: "DMSerifDisplay-Italic.ttf", name: "DM Serif Display Italic", label: "DM Serif Italic", upem: 1000, asc: 1036, desc: 335, cap: 660 },
  space_mono: { file: "SpaceMono-Bold.ttf", name: "Space Mono Bold", label: "Space Mono", upem: 1000, asc: 1120, desc: 361, cap: 700 },
  marker: { file: "PermanentMarker-Regular.ttf", name: "Permanent Marker Regular", label: "Permanent Marker", upem: 1024, asc: 1136, desc: 325, cap: 758 },
};
/** The ASS font size that gives a font this em size (libass shrinks the em to fit winAscent + winDescent). */
export const assSize = (f: FontInfo, em: number) => (em * (f.asc + f.desc)) / f.upem;

// ---------------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------------
export type Anim = "pop" | "bounce" | "slide" | "reveal" | "karaoke" | "none";
export type CaptionStyle = {
  id: string; name: string;
  font: keyof typeof FONTS | string;
  size: number;                 // em, px at the 1080 reference
  upper: boolean;
  color: string;                // the words, #rrggbb
  outline: { color: string; width: number } | null;
  shadow: { color: string; alpha: number; x: number; y: number; blur: number } | null;
  glow: { color: string; width: number; blur: number; alpha: number } | null;
  active: { color: string | null; scale: number; box: { color: string; radius: number; padX: number; padY: number } | null };
  keyword: string | null;       // AI-marked key words, when that is on
  dim: string | null;           // karaoke: words not spoken yet
  box: { color: string; alpha: number; radius: number; padX: number; padY: number } | null; // behind each line
  words: number;                // at most on screen at once
  lines: 1 | 2;
  maxWidth: number;             // fraction of the frame's width
  x: number;                    // the block's centre, fraction of the frame's width (0.5 = middle)
  y: number;                    // the block's centre, fraction of the frame's height
  anim: Anim;
  spacing: number;              // space between words, fraction of the em
  lineGap: number;              // line step, fraction of the line box
};
const S = (s: Omit<CaptionStyle, "spacing" | "lineGap" | "maxWidth" | "glow" | "box" | "dim" | "keyword" | "x"> & Partial<CaptionStyle>): CaptionStyle =>
  ({ spacing: 0.28, lineGap: 0.78, maxWidth: 0.86, glow: null, box: null, dim: null, keyword: null, x: 0.5, ...s });
export const PRESETS: CaptionStyle[] = [
  S({ id: "bold_pop", name: "Bold Pop", font: "montserrat_black", size: 80, upper: true, color: "#FFFFFF", outline: { color: "#000000", width: 7 }, shadow: { color: "#000000", alpha: 0.55, x: 0, y: 5, blur: 8 }, active: { color: "#FFE600", scale: 1.12, box: null }, keyword: "#3DFF8B", words: 3, lines: 1, y: 0.7, anim: "pop" }),
  S({ id: "pill", name: "Pill", font: "poppins_xbold", size: 72, upper: true, color: "#FFFFFF", outline: { color: "#000000", width: 3 }, shadow: { color: "#000000", alpha: 0.45, x: 0, y: 4, blur: 8 }, active: { color: "#FFFFFF", scale: 1.06, box: { color: "#7C5CFF", radius: 18, padX: 16, padY: 6 } }, keyword: "#FFD84D", words: 3, lines: 1, y: 0.7, anim: "pop" }),
  S({ id: "one_word", name: "One Word", font: "anton", size: 120, upper: true, color: "#FFFFFF", outline: { color: "#000000", width: 8 }, shadow: { color: "#000000", alpha: 0.5, x: 0, y: 6, blur: 10 }, active: { color: "#FFFFFF", scale: 1, box: null }, keyword: "#FF3B30", words: 1, lines: 1, y: 0.62, anim: "reveal" }),
  S({ id: "karaoke", name: "Karaoke", font: "poppins_bold", size: 62, upper: false, color: "#FFFFFF", dim: "#9AA0AA", outline: { color: "#000000", width: 5 }, shadow: { color: "#000000", alpha: 0.4, x: 0, y: 3, blur: 6 }, active: { color: "#4FF5D2", scale: 1, box: null }, words: 6, lines: 2, y: 0.74, anim: "karaoke" }),
  S({ id: "neon", name: "Neon", font: "kanit_black", size: 84, upper: true, color: "#FFFFFF", outline: { color: "#00E5FF", width: 3 }, shadow: null, glow: { color: "#00E5FF", width: 6, blur: 10, alpha: 0.75 }, active: { color: "#FF4FD8", scale: 1.1, box: null }, keyword: "#FFE14D", words: 2, lines: 1, y: 0.68, anim: "pop" }),
  S({ id: "comic", name: "Comic", font: "bangers", size: 98, upper: true, color: "#FFE14D", outline: { color: "#000000", width: 9 }, shadow: { color: "#000000", alpha: 1, x: 6, y: 7, blur: 0 }, active: { color: "#FFFFFF", scale: 1.15, box: null }, keyword: "#FF5A36", words: 2, lines: 1, y: 0.68, anim: "bounce", spacing: 0.22 }),
  S({ id: "bubble", name: "Bubble", font: "luckiest", size: 86, upper: true, color: "#FFFFFF", outline: { color: "#151515", width: 8 }, shadow: { color: "#151515", alpha: 1, x: 0, y: 7, blur: 0 }, active: { color: "#5CE1E6", scale: 1.12, box: null }, keyword: "#FFB703", words: 2, lines: 1, y: 0.68, anim: "bounce" }),
  S({ id: "boxed", name: "Boxed", font: "archivo_black", size: 64, upper: true, color: "#FFFFFF", outline: null, shadow: null, box: { color: "#000000", alpha: 0.86, radius: 14, padX: 20, padY: 12 }, active: { color: "#FFD400", scale: 1.06, box: null }, keyword: "#FFD400", words: 4, lines: 1, y: 0.72, anim: "pop" }),
  S({ id: "minimal", name: "Minimal", font: "poppins_semibold", size: 54, upper: false, color: "#FFFFFF", outline: null, shadow: { color: "#000000", alpha: 0.7, x: 0, y: 2, blur: 12 }, active: { color: null, scale: 1, box: null }, words: 7, lines: 2, y: 0.8, anim: "slide" }),
  S({ id: "subtitle", name: "Subtitle", font: "poppins_semibold", size: 46, upper: false, color: "#FFFFFF", outline: null, shadow: null, box: { color: "#000000", alpha: 0.62, radius: 10, padX: 16, padY: 8 }, active: { color: null, scale: 1, box: null }, words: 9, lines: 2, y: 0.86, anim: "none", maxWidth: 0.9 }),
  S({ id: "typewriter", name: "Typewriter", font: "space_mono", size: 54, upper: false, color: "#FFFFFF", outline: { color: "#000000", width: 4 }, shadow: { color: "#000000", alpha: 0.5, x: 0, y: 3, blur: 6 }, active: { color: "#7CF7FF", scale: 1, box: null }, words: 5, lines: 2, y: 0.74, anim: "reveal", spacing: 0.5 }),
  S({ id: "luxe", name: "Luxe", font: "dm_serif_italic", size: 82, upper: false, color: "#F6E7C8", outline: null, shadow: { color: "#000000", alpha: 0.6, x: 0, y: 4, blur: 14 }, active: { color: "#FFFFFF", scale: 1.06, box: null }, words: 3, lines: 1, y: 0.7, anim: "slide" }),
  S({ id: "marker", name: "Marker", font: "marker", size: 80, upper: false, color: "#FFFFFF", outline: { color: "#000000", width: 6 }, shadow: { color: "#000000", alpha: 0.5, x: 0, y: 5, blur: 6 }, active: { color: "#FF9F1C", scale: 1.1, box: null }, keyword: "#FF9F1C", words: 3, lines: 1, y: 0.7, anim: "bounce" }),
  S({ id: "headline", name: "Headline", font: "bebas", size: 112, upper: true, color: "#FFFFFF", outline: { color: "#000000", width: 5 }, shadow: { color: "#000000", alpha: 0.6, x: 0, y: 6, blur: 12 }, active: { color: "#FF2E63", scale: 1.08, box: null }, keyword: "#FF2E63", words: 3, lines: 1, y: 0.68, anim: "pop", spacing: 0.22 }),
];
export const presetById = (id: unknown): CaptionStyle => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const col = (v: unknown, d: string | null) => (typeof v === "string" && HEX.test(v) ? v.toUpperCase() : d);
/** A style as sent by a person (a preset with their changes), kept inside sane bounds. Unknown fields are dropped. */
export function cleanStyle(raw: any): CaptionStyle {
  const base = presetById(raw?.id);
  const r = raw && typeof raw === "object" ? raw : {};
  const font = typeof r.font === "string" && FONTS[r.font] ? r.font : base.font;
  const oc = r.outline === null ? null : r.outline ?? base.outline;
  const sh = r.shadow === null ? null : r.shadow ?? base.shadow;
  const gl = r.glow === null ? null : r.glow ?? base.glow;
  const bx = r.box === null ? null : r.box ?? base.box;
  const ac = r.active ?? base.active;
  const ab = ac?.box === null ? null : ac?.box ?? base.active.box;
  return {
    id: base.id, name: base.name, font,
    size: num(r.size, 28, 200, base.size), upper: typeof r.upper === "boolean" ? r.upper : base.upper,
    color: col(r.color, base.color)!,
    outline: oc ? { color: col(oc.color, "#000000")!, width: num(oc.width, 0, 20, 6) } : null,
    shadow: sh ? { color: col(sh.color, "#000000")!, alpha: num(sh.alpha, 0, 1, 0.5), x: num(sh.x, -20, 20, 0), y: num(sh.y, -20, 20, 4), blur: num(sh.blur, 0, 30, 6) } : null,
    glow: gl ? { color: col(gl.color, "#00E5FF")!, width: num(gl.width, 0, 30, 8), blur: num(gl.blur, 0, 40, 12), alpha: num(gl.alpha, 0, 1, 0.9) } : null,
    active: { color: ac?.color === null ? null : col(ac?.color, base.active.color), scale: num(ac?.scale, 1, 1.3, base.active.scale), box: ab ? { color: col(ab.color, "#7C5CFF")!, radius: num(ab.radius, 0, 60, 16), padX: num(ab.padX, 0, 60, 14), padY: num(ab.padY, 0, 40, 6) } : null },
    keyword: r.keyword === null ? null : col(r.keyword, base.keyword),
    dim: r.dim === null ? null : col(r.dim, base.dim),
    box: bx ? { color: col(bx.color, "#000000")!, alpha: num(bx.alpha, 0, 1, 0.8), radius: num(bx.radius, 0, 60, 12), padX: num(bx.padX, 0, 80, 16), padY: num(bx.padY, 0, 60, 8) } : null,
    words: Math.round(num(r.words, 1, 10, base.words)), lines: num(r.lines, 1, 2, base.lines) >= 2 ? 2 : 1,
    maxWidth: num(r.maxWidth, 0.4, 0.96, base.maxWidth), x: num(r.x, 0.2, 0.8, base.x), y: num(r.y, 0.08, 0.92, base.y),
    anim: (["pop", "bounce", "slide", "reveal", "karaoke", "none"] as Anim[]).includes(r.anim) ? r.anim : base.anim,
    spacing: num(r.spacing, 0.05, 1.2, base.spacing), lineGap: num(r.lineGap, 0.5, 1.4, base.lineGap),
  };
}

// ---------------------------------------------------------------------------------------------------
// Words: what is shown (filler words out, swearing masked, case)
// ---------------------------------------------------------------------------------------------------
/** `key`: emphasised (the accent colour). `brk`: the person wants a new caption to start after this word. */
export type CapWord = { text: string; start: number; end: number; speaker?: string | null; key?: boolean; brk?: boolean };
const FILLERS = /^(u+m+|u+h+|e+r+m+|h+m+|a+h+|m+h+m+|u+h+m+)[,.!?…]*$/i;
const SWEARS = /^(f+u+c+k\w*|s+h+i+t\w*|b+i+t+c+h\w*|a+s+s+h+o+l+e\w*|c+u+n+t\w*|d+i+c+k\w*|p+u+s+s+y\w*|m+o+t+h+e+r+f+u+c+k\w*|b+u+l+l+s+h+i+t\w*)$/i;
export type WordOptions = { fillers?: boolean; censor?: boolean };
/** The words as they will read: filler words dropped (their time goes to nobody), swear words masked. */
export function prepareWords(words: CapWord[], o: WordOptions = {}): CapWord[] {
  const out: CapWord[] = [];
  for (const w of words) {
    const text = String(w?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text || !(Number(w.end) > Number(w.start)) || !Number.isFinite(Number(w.start))) continue;
    if (o.fillers && FILLERS.test(text)) continue;
    const bare = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const shown = o.censor && SWEARS.test(bare) ? text.replace(bare, bare[0] + "*".repeat(Math.max(1, bare.length - 1))) : text;
    out.push({ text: shown, start: Number(w.start), end: Number(w.end), speaker: w.speaker ?? null, key: !!w.key, brk: !!w.brk });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------------
// Layout: chunks of words, each word's place on the frame
// ---------------------------------------------------------------------------------------------------
/** Width of `text` set in `font` at em size `em` (px): the font's own advances (opentype on the server, canvas here). */
export type Measure = (text: string, font: FontInfo, em: number) => number;
export type Frame = { w: number; h: number };
export type LaidWord = { text: string; start: number; end: number; activeEnd: number; key: boolean; cx: number; baseline: number; width: number };
export type LaidLine = { cx: number; width: number; baseline: number };
export type LaidChunk = { start: number; end: number; words: LaidWord[]; lines: LaidLine[]; fit: number };
export const unit = (fr: Frame) => Math.min(fr.w, fr.h) / 1080;
export const displayText = (s: CaptionStyle, t: string) => (s.upper ? t.toLocaleUpperCase() : t);
/** Timed words into what is on screen together: up to `style.words`, broken at a pause, a sentence's end, a new speaker,
 *  or the width; then laid out line by line, centred, each word at its own x. */
export function layoutCaptions(words: CapWord[], style: CaptionStyle, fr: Frame, measure: Measure): LaidChunk[] {
  const f = FONTS[style.font] ?? FONTS.montserrat_black;
  const k = unit(fr), em = style.size * k, maxW = style.maxWidth * fr.w, space = style.spacing * em;
  const lineBox = ((f.asc + f.desc) / f.upem) * em, step = lineBox * style.lineGap;
  // each word's slot: its width plus room to grow when it is the spoken word (and its pill), so neighbours never touch
  const grow = (wd: number) => (wd * Math.max(0, style.active.scale - 1)) / 2 + (style.active.box ? style.active.box.padX * k * 0.55 : 0);
  const widthOf = (w: CapWord) => { const wd = measure(displayText(style, w.text), f, em); return wd + 2 * grow(wd); };
  // 1. chunks
  const chunks: CapWord[][] = [];
  let cur: CapWord[] = [], lineW = 0, lines = 1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur[cur.length - 1];
    const ww = widthOf(w);
    let brk = false;
    if (prev) {
      const gap = w.start - prev.end;
      if (prev.brk || cur.length >= style.words || gap > 0.6 || /[.?!…]["')\]]?$/.test(prev.text) || (prev.speaker && w.speaker && prev.speaker !== w.speaker) || (/[,;:]$/.test(prev.text) && cur.length >= Math.ceil(style.words / 2))) brk = true;
      else if (lineW + space + ww > maxW) { if (lines < style.lines) { lines++; lineW = ww; cur.push(w); continue; } brk = true; }
    }
    if (brk) { chunks.push(cur); cur = []; lineW = 0; lines = 1; }
    lineW = cur.length ? lineW + space + ww : ww;
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  // 2. each chunk laid out
  const out: LaidChunk[] = [];
  let prevEnd = 0;
  for (let c = 0; c < chunks.length; c++) {
    const ws = chunks[c], next = chunks[c + 1];
    const widths = ws.map(widthOf);
    // lines: greedy, at most style.lines
    const rows: number[][] = [[]];
    let rw = 0;
    ws.forEach((_, i) => { const add = rows[rows.length - 1].length ? space + widths[i] : widths[i]; if (rows[rows.length - 1].length && rw + add > maxW && rows.length < style.lines) { rows.push([i]); rw = widths[i]; } else { rows[rows.length - 1].push(i); rw += add; } });
    const rowW = rows.map((r) => r.reduce((a, i, j) => a + widths[i] + (j ? space : 0), 0));
    const fit = Math.min(1, maxW / Math.max(1, ...rowW));
    const widest = Math.max(...rowW) * fit;
    const cxBlock = Math.min(fr.w - widest / 2 - 8 * k, Math.max(widest / 2 + 8 * k, style.x * fr.w));
    const top = style.y * fr.h - ((rows.length - 1) * step * fit) / 2;
    const ascPx = (f.asc / f.upem) * em * fit, boxH = lineBox * fit;
    const laidLines: LaidLine[] = [];
    const laid: LaidWord[] = [];
    rows.forEach((r, li) => {
      const centreY = top + li * step * fit;
      const baseline = centreY - boxH / 2 + ascPx;
      let x = cxBlock - (rowW[li] * fit) / 2;
      laidLines.push({ cx: cxBlock, width: rowW[li] * fit, baseline });
      r.forEach((i, j) => {
        if (j) x += space * fit;
        const ink = measure(displayText(style, ws[i].text), f, em) * fit;
        laid[i] = { text: displayText(style, ws[i].text), start: ws[i].start, end: ws[i].end, activeEnd: 0, key: !!ws[i].key, cx: x + (widths[i] * fit) / 2, baseline, width: ink };
        x += widths[i] * fit;
      });
    });
    // on screen from just before its first word until just before the next caption's first word, or a short hold after
    // its last word. It stays up at least 0.3 s, but never past the moment the next caption appears: two captions are
    // never on screen at once (the old one used to linger under the new one in fast speech).
    const start = Math.max(0, ws[0].start - 0.04, prevEnd);
    const nextAt = next ? Math.max(0, next[0].start - 0.04) : Infinity;
    const end = Math.max(start + 0.05, Math.min(nextAt, Math.max(start + 0.3, ws[ws.length - 1].end + 0.45)));
    prevEnd = end;
    laid.forEach((w, i) => { w.activeEnd = i + 1 < laid.length ? Math.max(w.start + 0.08, laid[i + 1].start) : end; });
    out.push({ start, end, words: laid, lines: laidLines, fit });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Phases: how each word looks and moves, stretch by stretch (both renderers read these)
// ---------------------------------------------------------------------------------------------------
/** A keyframe, seconds from the phase's start: scale (1 = normal) and opacity (0-1); linear in between. */
export type Key = { t: number; s: number; a: number };
export type Phase = { word: number; start: number; end: number; color: string; active: boolean; pill: boolean; keys: Key[]; rise: { from: number; dur: number } | null };
const mergeKeys = (a: Key[], b: Key[]): Key[] => {
  const at = (ks: Key[], t: number) => { if (!ks.length) return { s: 1, a: 1 }; if (t <= ks[0].t) return ks[0]; for (let i = 1; i < ks.length; i++) if (t <= ks[i].t) { const p = ks[i - 1], q = ks[i], u = (t - p.t) / (q.t - p.t || 1); return { s: p.s + (q.s - p.s) * u, a: p.a + (q.a - p.a) * u }; } return ks[ks.length - 1]; };
  const ts = [...new Set([...a, ...b].map((x) => x.t))].sort((x, y) => x - y);
  if (!ts.length) return [{ t: 0, s: 1, a: 1 }];
  return ts.map((t) => { const x = at(a, t), y = at(b, t); return { t, s: x.s * y.s, a: x.a * y.a }; });
};
/** Keyframes of a word's entrance (from the moment it first shows) and of its turn as the spoken word. */
function entranceKeys(style: CaptionStyle): Key[] {
  switch (style.anim) {
    case "pop": return [{ t: 0, s: 0.86, a: 1 }, { t: 0.08, s: 1, a: 1 }];
    case "bounce": return [{ t: 0, s: 0.9, a: 1 }, { t: 0.07, s: 1.06, a: 1 }, { t: 0.14, s: 1, a: 1 }];
    case "slide": return [{ t: 0, s: 1, a: 0 }, { t: 0.16, s: 1, a: 1 }];
    case "reveal": return [{ t: 0, s: 0.55, a: 0 }, { t: 0.05, s: 1.08, a: 1 }, { t: 0.12, s: 1, a: 1 }];
    default: return [{ t: 0, s: 1, a: 1 }];
  }
}
const activeKeys = (style: CaptionStyle): Key[] => (style.active.scale > 1.001 ? [{ t: 0, s: 1, a: 1 }, { t: 0.07, s: style.active.scale, a: 1 }] : [{ t: 0, s: 1, a: 1 }]);
/** Every phase of every word in a chunk, in time order. A word shows from the chunk's start (or, for "reveal", from when
 *  it is said), is the spoken word from its start to the next word's start, and stays until the chunk leaves. */
export function chunkPhases(ch: LaidChunk, style: CaptionStyle, keywordsOn: boolean): Phase[] {
  const out: Phase[] = [];
  const em = 1; // rises are fractions of the em, resolved by the renderer
  const baseColor = (w: LaidWord, spoken: boolean) => (style.anim === "karaoke" && !spoken && style.dim ? style.dim : keywordsOn && w.key && style.keyword ? style.keyword : style.color);
  const activeColor = (w: LaidWord) => style.active.color ?? baseColor(w, true);
  const enter = entranceKeys(style), act = activeKeys(style);
  const rise = style.anim === "bounce" ? { from: 0.3 * em, dur: 0.12 } : style.anim === "slide" ? { from: 0.32 * em, dur: 0.16 } : null;
  ch.words.forEach((w, i) => {
    const reveal = style.anim === "reveal";
    const showFrom = reveal ? Math.max(ch.start, w.start - 0.02) : ch.start;
    const aStart = Math.max(showFrom, w.start), aEnd = Math.min(ch.end, w.activeEnd);
    const first = (start: number) => start <= showFrom + 1e-6;
    // a word said after its caption has to leave (two words with the same start time across a break) waits, dim, only
    // until the caption ends: no phase outlasts its caption
    if (aStart > showFrom + 0.01 && ch.end > showFrom + 0.01) out.push({ word: i, start: showFrom, end: Math.min(aStart, ch.end), color: baseColor(w, false), active: false, pill: false, keys: enter, rise });
    if (aEnd > aStart + 0.01) out.push({ word: i, start: aStart, end: aEnd, color: activeColor(w), active: true, pill: !!style.active.box, keys: first(aStart) ? mergeKeys(enter, act) : act, rise: first(aStart) ? rise : null });
    if (ch.end > Math.max(aEnd, showFrom) + 0.01) out.push({ word: i, start: Math.max(aEnd, showFrom), end: ch.end, color: baseColor(w, true), active: false, pill: false, keys: first(Math.max(aEnd, showFrom)) ? enter : [{ t: 0, s: 1, a: 1 }], rise: first(Math.max(aEnd, showFrom)) ? rise : null });
  });
  return out;
}
/** A phase's look at `t` seconds after it began: scale, opacity, how far below its place (fraction of the em). */
export function sampleKeys(keys: Key[], t: number): { s: number; a: number } {
  if (!keys.length) return { s: 1, a: 1 };
  if (t <= keys[0].t) return { s: keys[0].s, a: keys[0].a };
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) { const p = keys[i - 1], q = keys[i], u = (t - p.t) / (q.t - p.t || 1); return { s: p.s + (q.s - p.s) * u, a: p.a + (q.a - p.a) * u }; }
  const l = keys[keys.length - 1];
  return { s: l.s, a: l.a };
}
export const riseAt = (rise: Phase["rise"], t: number) => (rise ? rise.from * Math.max(0, 1 - t / rise.dur) : 0);

// ---------------------------------------------------------------------------------------------------
// ASS for libass
// ---------------------------------------------------------------------------------------------------
const assColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
const assAlpha = (a: number) => `&H${Math.round((1 - Math.min(1, Math.max(0, a))) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;
const tc = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100; return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}.${String(c).padStart(2, "0")}`; };
const esc = (t: string) => t.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")");
const r1 = (x: number) => Math.round(x * 10) / 10;
/** A rounded rectangle as an ASS drawing (\p1), w x h, corners of radius r. */
function roundRect(w: number, h: number, r: number): string {
  const q = Math.max(0, Math.min(r, w / 2, h / 2)), c = q * 0.4477; // control-point offset for a quarter circle
  const p = (n: number) => r1(n);
  return `m ${p(q)} 0 l ${p(w - q)} 0 b ${p(w - c)} 0 ${p(w)} ${p(c)} ${p(w)} ${p(q)} l ${p(w)} ${p(h - q)} b ${p(w)} ${p(h - c)} ${p(w - c)} ${p(h)} ${p(w - q)} ${p(h)} l ${p(q)} ${p(h)} b ${p(c)} ${p(h)} 0 ${p(h - c)} 0 ${p(h - q)} l 0 ${p(q)} b 0 ${p(c)} ${p(c)} 0 ${p(q)} 0`;
}
/** The \t chain for a phase's keyframes (scale as \fscx/\fscy around the fit, opacity as \alpha times `alpha`). */
function keyTags(keys: Key[], fit: number, alpha: number): string {
  const v = (k: Key) => `\\fscx${r1(k.s * fit * 100)}\\fscy${r1(k.s * fit * 100)}\\alpha${assAlpha(k.a * alpha)}`;
  let out = v(keys[0]);
  for (let i = 1; i < keys.length; i++) out += `\\t(${Math.round(keys[i - 1].t * 1000)},${Math.round(keys[i].t * 1000)},${v(keys[i])})`;
  return out;
}
/** The whole ASS file: per word and phase, a text event (layer 4), its shadow (0) and glow (1), the line boxes (2) and
 *  the spoken word's pill (3). Positions are absolute, so every word sits exactly where the layout put it. */
export function buildAss(chunks: LaidChunk[], style: CaptionStyle, fr: Frame, keywordsOn: boolean): string {
  const f = FONTS[style.font] ?? FONTS.montserrat_black;
  const k = unit(fr), em = style.size * k;
  const lineBox = ((f.asc + f.desc) / f.upem) * em;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${fr.w}`, `PlayResY: ${fr.h}`, "ScaledBorderAndShadow: yes", "WrapStyle: 2", "YCbCr Matrix: None", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: C,${f.name},${r1(assSize(f, em))},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev: string[] = [];
  const line = (layer: number, a: number, b: number, tags: string, text: string) => ev.push(`Dialogue: ${layer},${tc(a)},${tc(b)},C,,0,0,0,,{${tags}}${text}`);
  const ob = style.outline ? style.outline.width * k : 0;
  for (const ch of chunks) {
    // boxes behind each line, for the chunk's whole time
    if (style.box) for (const ln of ch.lines) {
      const bw = ln.width + 2 * style.box.padX * k, bh = (f.cap / f.upem) * em * ch.fit + 2 * style.box.padY * k;
      const cy = ln.baseline - ((f.cap / f.upem) * em * ch.fit) / 2;
      line(2, ch.start, ch.end, `\\an5\\pos(${r1(ln.cx)},${r1(cy)})\\p1\\bord0\\shad0\\1c${assColor(style.box.color)}\\1a${assAlpha(style.box.alpha)}${style.anim === "slide" ? `\\alpha&HFF&\\t(0,160,\\1a${assAlpha(style.box.alpha)})` : ""}`, roundRect(bw, bh, style.box.radius * k));
    }
    for (const ph of chunkPhases(ch, style, keywordsOn)) {
      const w = ch.words[ph.word];
      const cy = w.baseline - (f.asc / f.upem) * em * ch.fit + (lineBox * ch.fit) / 2; // \an5 centres the line box
      const rise = ph.rise ? ph.rise.from * em : 0;
      const pos = rise ? `\\move(${r1(w.cx)},${r1(cy + rise)},${r1(w.cx)},${r1(cy)},0,${Math.round(ph.rise!.dur * 1000)})` : `\\pos(${r1(w.cx)},${r1(cy)})`;
      const text = esc(w.text);
      if (style.shadow && style.shadow.alpha > 0) {
        const sx = style.shadow.x * k, sy = style.shadow.y * k;
        const sp = rise ? `\\move(${r1(w.cx + sx)},${r1(cy + sy + rise)},${r1(w.cx + sx)},${r1(cy + sy)},0,${Math.round(ph.rise!.dur * 1000)})` : `\\pos(${r1(w.cx + sx)},${r1(cy + sy)})`;
        line(0, ph.start, ph.end, `\\an5${sp}\\1c${assColor(style.shadow.color)}\\3c${assColor(style.shadow.color)}\\bord${r1(ob)}\\shad0\\blur${r1(style.shadow.blur * k * 0.5)}${keyTags(ph.keys, ch.fit, style.shadow.alpha)}`, text);
      }
      if (style.glow && style.glow.alpha > 0) line(1, ph.start, ph.end, `\\an5${pos}\\1a&HFF&\\3c${assColor(style.glow.color)}\\bord${r1(ob + style.glow.width * k)}\\shad0\\blur${r1(style.glow.blur * k * 0.5)}${keyTags(ph.keys, ch.fit, style.glow.alpha).replace(/\\alpha/g, "\\3a")}`, text);
      if (ph.pill && style.active.box) {
        const b = style.active.box, bw = w.width + 2 * b.padX * k, bh = (f.cap / f.upem) * em * ch.fit + 2 * b.padY * k + 2 * ob;
        const by = w.baseline - ((f.cap / f.upem) * em * ch.fit) / 2;
        line(3, ph.start, ph.end, `\\an5\\pos(${r1(w.cx)},${r1(by)})\\p1\\bord0\\shad0\\1c${assColor(b.color)}${keyTags(ph.keys, 1, 1)}`, roundRect(bw, bh, b.radius * k));
      }
      line(4, ph.start, ph.end, `\\an5${pos}\\1c${assColor(ph.color)}\\3c${assColor(style.outline?.color ?? "#000000")}\\bord${r1(ob)}\\shad0\\blur0${keyTags(ph.keys, ch.fit, 1)}`, text);
    }
  }
  return [...head, ...ev, ""].join("\n");
}
