// Editing a clip by text, through the same editor the app has (src/studio-editor.ts): read the clip's edit file, change
// what the person asked for, save it, render it again. Free for the person (the editor's own limit: 25 renders a clip a
// day). The render replaces the clip in the library with the edited one; the edit file keeps every earlier version, so
// it can be changed again. What can change by text: the captions (on or off, style, where they sit, size, key words,
// fillers, swearing), a word in the captions, trimming the start or the end, cutting the pauses, bleeping swearing.
import type { Ctx } from "./actions.js";
import { ActionError, putPending } from "./actions.js";
import type { Pending } from "./gate.js";
import { presetById } from "../caption-engine.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const short = (v: unknown, n: number) => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const STYLES: Record<string, { name: string; size: number }> = {
  bold_pop: { name: "Bold Pop", size: 80 }, pill: { name: "Pill", size: 72 }, one_word: { name: "One Word", size: 120 }, karaoke: { name: "Karaoke", size: 62 }, neon: { name: "Neon", size: 84 },
  comic: { name: "Comic", size: 98 }, bubble: { name: "Bubble", size: 86 }, boxed: { name: "Boxed", size: 64 }, minimal: { name: "Minimal", size: 54 }, subtitle: { name: "Subtitle", size: 46 },
  typewriter: { name: "Typewriter", size: 54 }, luxe: { name: "Luxe", size: 82 }, marker: { name: "Marker", size: 80 }, headline: { name: "Headline", size: 112 },
};
const SPLIT_STYLES = ["bold_pop", "pill", "one_word"];
/** Where captions can sit, as the centre of the caption block, a share of the frame's height from the top. */
const SPOTS: Record<string, number> = { top: 0.14, upper: 0.3, middle: 0.5, lower: 0.68, bottom: 0.8 };
const pct = (y: number) => `${Math.round(y * 100)}% of the way down`;

export type EditChanges = {
  captions?: "on" | "off"; style?: string; position?: "top" | "upper" | "middle" | "lower" | "bottom" | "below_top_part"; caption_y?: number; size?: number;
  /** move the captions from where they sit now, as a share of the frame's height: -0.15 = 15% higher, 0.1 = 10% lower */
  move_by?: number;
  key_words?: boolean; fillers?: boolean; censor?: boolean; fix_words?: Array<{ find: string; replace: string }>;
  trim_start?: number; trim_end?: number; remove_pauses?: boolean; bleep?: "off" | "mute" | "tone";
};

/** The clip's edit file, by library file or (for a split screen made by a run) by the run. */
async function project(ctx: Ctx, a: { asset_id?: string | null; job_id?: string | null }): Promise<any> {
  const path = a.asset_id && UUID.test(a.asset_id) ? `/api/studio/projects/by-asset/${a.asset_id}` : a.job_id && UUID.test(a.job_id) ? `/api/studio/projects/by-job/${a.job_id}` : null;
  if (!path) throw new ActionError("which_clip", "Say which clip: a library file (asset_id) or, for a split screen result, its job_id");
  const r = await ctx.api.call("GET", path);
  if (r.status === 404) throw new ActionError("no_project", "This video can't be opened in the editor: only clips, captioned videos and split screens made in Clone8 can. A new Captions run can add captions to it instead.");
  if (r.status === 503 || r.status === 402) throw new ActionError("editor_closed", String(r.json?.detail ?? "The editor is not open for this account"));
  if (r.status !== 200 || !r.json?.doc) throw new ActionError("editor_unavailable", String(r.json?.detail ?? `The editor answered ${r.status}`));
  if (r.json.source && r.json.source.kept === false) throw new ActionError("no_source", "The original recording for this clip is no longer kept, so it can't be made again.");
  if (r.json.render_state === "queued" || r.json.render_state === "rendering") throw new ActionError("rendering", "An edit of this clip is being made right now. Ask again in a minute.");
  return r.json;
}

export async function prepareEdit(ctx: Ctx, a: { asset_id?: string | null; job_id?: string | null; changes?: EditChanges }): Promise<Pending> {
  const c: EditChanges = a.changes && typeof a.changes === "object" ? a.changes : {};
  const p = await project(ctx, a);
  const doc = JSON.parse(JSON.stringify(p.doc)), split = doc.kind === "split";
  const lines: string[] = [], ops: Array<{ op: string; from?: unknown; to?: unknown }> = [], own: string[] = [];
  const len0 = r3(doc.trim.out - doc.trim.in);

  // trimming
  const cutIn = Number(c.trim_start) > 0 ? Number(c.trim_start) : 0, cutOut = Number(c.trim_end) > 0 ? Number(c.trim_end) : 0;
  if (cutIn || cutOut) {
    const tin = r3(doc.trim.in + cutIn), tout = r3(doc.trim.out - cutOut);
    if (tout - tin < 1) throw new ActionError("too_short", `The clip is ${len0} s; that would leave less than a second.`);
    ops.push({ op: "trim.in", from: doc.trim.in, to: tin }, { op: "trim.out", from: doc.trim.out, to: tout });
    doc.trim.in = tin; doc.trim.out = tout;
    lines.push(`Cut ${[cutIn ? `the first ${r3(cutIn)} s` : "", cutOut ? `the last ${r3(cutOut)} s` : ""].filter(Boolean).join(" and ")} (${len0} s → ${r3(tout - tin)} s).`);
  }

  // captions
  const wantOn = c.captions === "on" || (c.captions !== "off" && (c.style != null || c.position != null || c.caption_y != null || c.move_by != null || c.size != null) && !(split ? doc.split?.layout?.captions : doc.captions?.on));
  if (split) {
    if (c.position || c.caption_y != null || c.move_by != null || c.size != null) throw new ActionError("split_position", "On a split screen the captions sit on the line between the two parts and follow it; their place can't be set on its own.");
    if (c.captions === "off" || wantOn) { const on = c.captions !== "off"; ops.push({ op: "split.captions", from: doc.split.layout.captions, to: on }); doc.split.layout.captions = on; lines.push(on ? "Captions on." : "Captions off."); }
    if (c.style) {
      const id = String(c.style).toLowerCase().replace(/\s+/g, "_");
      if (!SPLIT_STYLES.includes(id)) throw new ActionError("style", `A split screen takes these caption styles: ${SPLIT_STYLES.map((s) => STYLES[s].name).join(", ")}.`);
      ops.push({ op: "split.caption_style", from: doc.split.caption_style, to: id }); doc.split.caption_style = id; lines.push(`Caption style: ${STYLES[id].name}.`);
    }
  } else {
    const cur = doc.captions.style && typeof doc.captions.style === "object" ? { ...doc.captions.style } : null;
    if (c.captions === "off") { if (doc.captions.on) { ops.push({ op: "captions.on", from: true, to: false }); doc.captions.on = false; lines.push("Captions off."); } }
    else {
      let style: any = cur ?? { id: "bold_pop" };
      if (c.style) {
        const id = String(c.style).toLowerCase().replace(/\s+/g, "_");
        if (!STYLES[id]) throw new ActionError("style", `Caption styles: ${Object.entries(STYLES).map(([k, s]) => `${s.name} (${k})`).join(", ")}.`);
        // a new style starts from its own look; where it sits is kept
        style = { id, ...(cur?.y != null ? { y: cur.y } : {}), ...(cur?.x != null ? { x: cur.x } : {}) };
        ops.push({ op: "captions.style", from: cur?.id ?? null, to: id });
      }
      // where they sit now, when they show: the clip's own place, else its style's height. Every move is said "from X to
      // Y", so the chat keeps a record of each earlier spot ("put them back", "15% above the original" need it)
      const styleY = (id: unknown) => Number(presetById(id).y ?? 0.7);
      const was = doc.captions?.on ? (Number.isFinite(Number(cur?.y)) ? Number(cur!.y) : styleY(cur?.id ?? style.id)) : null;
      let y: number | null = null, where = "", moved = "";
      if (c.caption_y != null && Number.isFinite(Number(c.caption_y))) { y = Math.min(0.95, Math.max(0.05, Number(c.caption_y))); where = pct(y); }
      else if (c.move_by != null && Number.isFinite(Number(c.move_by))) {
        // from where they sit now: the clip's own place, else the style's (each style has its own height)
        const by = Math.min(0.9, Math.max(-0.9, Number(c.move_by)));
        const from = was ?? (Number.isFinite(Number(cur?.y)) ? Number(cur!.y) : styleY(style.id));
        y = Math.min(0.95, Math.max(0.05, from + by));
        if (Math.abs(y - from) < 0.005) throw new ActionError("cannot_move", `The captions are already as far ${by < 0 ? "up" : "down"} as they go (${pct(from)}).`);
        moved = `Captions moved ${Math.round(Math.abs(y - from) * 100)}% ${y < from ? "higher" : "lower"}: from ${Math.round(from * 100)}% to ${pct(y)}.`;
      } else if (c.position === "below_top_part") {
        // just under the top panel of a stacked clip (the face-cam); a captioned copy reads the panel from the clip it was made from
        let divider = doc.layout?.type === "stacked" ? Number(doc.layout.divider ?? 0.33) : null;
        if (divider == null) { const parent = a.asset_id ? ctx.parentOf?.(a.asset_id) : null; if (parent) { try { const pp = await ctx.api.call("GET", `/api/studio/projects/by-asset/${parent}`); if (pp.json?.doc?.layout?.type === "stacked") divider = Number(pp.json.doc.layout.divider ?? 0.33); } catch { /* a guess below */ } } }
        if (divider == null) throw new ActionError("no_top_part", "This video has no separate top part (it is not a stacked clip). Say top, middle or bottom, or a share of the way down.");
        y = Math.min(0.9, divider + 0.07); where = `just under the top part (${pct(y)})`;
      } else if (c.position && SPOTS[c.position] != null) { y = SPOTS[c.position]; where = `${c.position} (${pct(y)})`; }
      if (y != null) { ops.push({ op: "captions.y", from: cur?.y ?? null, to: r3(y) }); style = { ...style, y: r3(y) }; }
      if (c.size != null && Number.isFinite(Number(c.size))) {
        const scale = Math.min(1.6, Math.max(0.6, Number(c.size))), base = STYLES[style.id]?.size ?? 80;
        const size = Math.round(Math.min(200, Math.max(28, base * scale)));
        ops.push({ op: "captions.size", from: cur?.size ?? base, to: size }); style = { ...style, size };
        lines.push(`Captions ${scale > 1 ? "bigger" : "smaller"} (${Math.round(scale * 100)}% of the style's size).`);
      }
      if (wantOn && !doc.captions.on) { ops.push({ op: "captions.on", from: false, to: true }); doc.captions.on = true; lines.unshift(`Captions on, in ${STYLES[style.id]?.name ?? style.id}.`); }
      else if (c.style) lines.push(`Caption style: ${STYLES[style.id].name}.`);
      if (moved) lines.push(moved);
      else if (y != null && was != null && Math.abs(y - was) >= 0.005) lines.push(`Captions moved from ${Math.round(was * 100)}% to ${pct(y)}${where && where !== pct(y) ? ` (${where.replace(/ \(\d+% of the way down\)$/, "")})` : ""}.`);
      else if (where) lines.push(`Captions placed ${where}.`);
      doc.captions.style = style;
    }
    for (const [k, label] of [["key_words", "keywords"], ["fillers", "fillers"], ["censor", "censor"]] as const) {
      const v = (c as any)[k]; if (typeof v !== "boolean" || v === doc.captions[label]) continue;
      ops.push({ op: `captions.${label}`, from: doc.captions[label], to: v }); doc.captions[label] = v;
      lines.push(k === "key_words" ? (v ? "Key words highlighted." : "No highlighted key words.") : k === "fillers" ? (v ? "Ums and uhs left out of the captions." : "Ums and uhs shown in the captions.") : v ? "Swear words masked in the captions." : "Swear words shown as said.");
    }
  }

  // a word the captions got wrong: found in the clip's own words, fixed wherever it appears
  const fixes = (Array.isArray(c.fix_words) ? c.fix_words : []).filter((f) => f && String(f.find ?? "").trim() && String(f.replace ?? "").trim()).slice(0, 10);
  if (fixes.length) {
    const w = await ctx.api.call("GET", `/api/studio/projects/${p.id}/words`);
    const words: any[] = w.json?.words ?? [];
    const now = new Map<number, string>((Array.isArray(doc.captions.fixes) ? doc.captions.fixes : []).filter((f: any) => Number.isInteger(f?.i)).map((f: any) => [f.i, String(f.text)]));
    const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    for (const f of fixes) {
      const want = clean(f.find), to = short(f.replace, 60);
      const hits = words.map((x, i) => (clean(String(x.text)) === want ? i : -1)).filter((i) => i >= 0);
      if (!hits.length) throw new ActionError("word_not_found", `"${short(f.find, 30)}" is not one of the words heard in this clip.`);
      for (const i of hits) now.set(i, to);
      ops.push({ op: "captions.fixes", from: f.find, to }); own.push(short(f.find, 30), to);
      lines.push(`"${short(f.find, 30)}" in the captions becomes "${to}" (${hits.length} time${hits.length === 1 ? "" : "s"}).`);
    }
    doc.captions.fixes = [...now.entries()].map(([i, text]) => ({ i, text }));
  }

  if (!split) {
    if (typeof c.remove_pauses === "boolean" && c.remove_pauses !== !!doc.extras?.pause_trim) { ops.push({ op: "extras.pause_trim", from: !!doc.extras?.pause_trim, to: c.remove_pauses }); doc.extras = { ...doc.extras, pause_trim: c.remove_pauses }; lines.push(c.remove_pauses ? "Long pauses cut down to a breath." : "Pauses kept as filmed."); }
    if (c.bleep && ["off", "mute", "tone"].includes(c.bleep) && c.bleep !== (doc.sound?.bleep ?? "off")) { ops.push({ op: "sound.bleep", from: doc.sound?.bleep ?? "off", to: c.bleep }); doc.sound = { ...doc.sound, bleep: c.bleep }; lines.push(c.bleep === "off" ? "Swearing heard as said." : c.bleep === "mute" ? "Swearing silenced." : "Swearing bleeped."); }
  }
  if (!lines.length) throw new ActionError("nothing_to_change", "Say what to change: captions (on, off, style, where, size), a word in them, trimming, pauses or swearing.");

  const name = (a.asset_id && (ctx.titleOf?.({ asset_id: a.asset_id }) ?? ctx.nameOf?.(a.asset_id))) || (a.job_id ? ctx.titleOf?.({ job_id: a.job_id, output_key: p.doc?.source?.key }) : null) || "this clip";
  own.push(short(name, 70));
  return putPending(ctx, {
    kind: "edit", credits: 0, posts: 0, own, checks: [],
    steps: [
      { method: "PUT", path: `/api/studio/projects/${p.id}`, body: { rev: p.rev, doc, surface: "assistant", ops: ops.map((o) => ({ ...o, at: null })) }, label: "save" },
      { method: "POST", path: `/api/studio/projects/${p.id}/render`, body: {}, label: "render" },
    ],
    meta: { project_id: p.id, asset_id: a.asset_id ?? null, job_id: a.job_id ?? null, rev: p.rev + 1, name: short(name, 70) },
    body: [`Edit "${short(name, 70)}":`, ...lines, "Free. The clip in your library is replaced by the edited one; it can be changed again any time."].join("\n"),
  });
}
