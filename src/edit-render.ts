// Clone8 Studio: the editor's render (editor thread, phase 2 foundation; docs/editor/PLAN.md §15).
//
// An edit file (studio-projects.ts EditDoc) plus its kept recording become the clip again, with the same pictures the
// cutter makes: the same layout builders (Clips' crop path, Live Clips' stacked and content layouts), the same sound
// pass, the same encoder. Pure where it can be: the graph and the ffmpeg arguments are built from the file alone, so
// the browser preview (later, a shared engine) and this render can be tested against each other.
import { buildClipFilter, type Seg } from "./studio-clips.js";
import { contentLayout, stackedLayout } from "./studio-live-clips.js";
import type { EditDoc } from "./studio-projects.js";

export type MediaInfo = { w: number; h: number; fps: number | null };

/** The picture graph ([0:v] → [v]) and the frame it makes, from the edit file's layout. */
export function layoutGraph(doc: EditDoc, info: MediaInfo): { graph: string; w: number; h: number } {
  const L = doc.layout;
  const pane = (role: "cam" | "content") => L.panes.find((p) => p.role === role)?.from ?? null;
  if (L.type === "stacked" && pane("cam")) { const s = stackedLayout(info, pane("cam")!, pane("content")); return { graph: s.graph, w: s.w, h: s.h }; }
  if (L.type === "content" && pane("content")) { const s = contentLayout(info, pane("content")!); return { graph: s.graph, w: s.w, h: s.h }; }
  const format = doc.canvas.format === "original" || L.type === "original" ? "original" : "vertical";
  const out = format === "vertical" ? { w: doc.canvas.w, h: doc.canvas.h } : undefined;
  const segs: Seg[] = L.type === "fit" && !L.path.length ? [{ start: 0, end: 1e6, mode: "fit", x0: 0.5, x1: 0.5 }] : L.path;
  const graph = buildClipFilter({ w: info.w, h: info.h, format, segs, fps: info.fps, out });
  return { graph, w: format === "vertical" ? doc.canvas.w : info.w, h: format === "vertical" ? doc.canvas.h : info.h };
}

/** The sound pass: loudness to the file's level, the optional limiter, soft edges, and any locked muted ranges silenced. */
export function soundFilter(doc: EditDoc, seconds: number): string {
  const mutes = doc.sound.muted.map((m) => `volume=enable='between(t,${(m.from - doc.trim.in).toFixed(3)},${(m.to - doc.trim.in).toFixed(3)})':volume=0`);
  return [
    ...mutes,
    `loudnorm=I=${doc.sound.level}:TP=-1.5:LRA=11`,
    ...(doc.sound.limiter ? ["alimiter=limit=0.891:level=false"] : []),
    "afade=t=in:d=0.06",
    `afade=t=out:st=${Math.max(0, seconds - 0.25).toFixed(3)}:d=0.25`,
  ].join(",");
}

/** The same encoder settings as cutClip (studio-clips.ts), so a re-rendered clip cannot be told from the first one. */
export const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "2", "-rc-lookahead", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart"];

/** The ffmpeg arguments that render an edit file from its kept recording. `captionFilter` is the ASS filter when
 *  captions are on (studio-caption-video.ts assFilter on a file made by captionAss for this frame). */
export function renderArgs(doc: EditDoc, source: string, info: MediaInfo, out: string, captionFilter: string | null = null): { args: string[]; seconds: number; frame: { w: number; h: number } } {
  const seconds = Math.max(0.5, doc.trim.out - doc.trim.in);
  const lay = layoutGraph(doc, info);
  let graph = lay.graph;
  if (captionFilter) graph = graph.replace(/\[v\]$/, `,${captionFilter}[v]`);
  const args = ["-v", "error", "-nostdin", "-y", "-threads", "2", "-ss", doc.trim.in.toFixed(3), "-i", source, "-t", seconds.toFixed(3),
    "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-af", soundFilter(doc, seconds), ...ENC, out];
  return { args, seconds, frame: { w: lay.w, h: lay.h } };
}
