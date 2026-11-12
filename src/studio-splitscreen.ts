// Clone8 Studio: Split screen. The person's own clip on one half of a 9:16 video, a satisfying gameplay loop on the
// other (Subway Surfers, Minecraft parkour, GTA ramps, Fortnite, ball-escape sims, marble runs, presses, sand...),
// their words as captions on the seam, and only their clip's sound.
//
// This file is the engine: the layout (where the seam sits, which half is which, what part of each picture shows),
// the auto-sizer's defaults, the gameplay window (which stretch of a long loop runs under this clip), and the one
// ffmpeg pass that makes the video. The job, the routes and the switches come next (docs/split-screen/PLAN.md).
//
// The page's editor and this file share one model of a frame: for each half, `Box` = how far in it is zoomed and where
// the crop's centre sits in the source picture (fractions 0..1). What the person sees in the editor is what renders.
//
// Off until STUDIO_SPLITSCREEN_ENABLED=true; until STUDIO_SPLITSCREEN_OPEN=true only the owner's account can use it.

type Env = Record<string, string | undefined>;

export const splitscreenEnabled = (env: Env = process.env) => env.STUDIO_SPLITSCREEN_ENABLED === "true";
export const splitscreenOpen = (env: Env = process.env) => splitscreenEnabled(env) && env.STUDIO_SPLITSCREEN_OPEN === "true";

export * from "./splitscreen-layout.js";
import { cropInside, halves, SPLIT_OUT, type Box, type Layout, type Rect, type Size, type Subject } from "./splitscreen-layout.js";
import { claudeJson, type ClipsDeps } from "./studio-clips.js";

export type SplitRender = {
  clip: { file: string; size: Size; seconds: number; hasAudio: boolean };
  /** `safe`: the part of the loop a crop may use (shares of the picture), from the library */
  game: { file: string; size: Size; start: number; loop: boolean; safe?: Rect | null };
  layout: Layout;
  /** a captions file (.ass) already laid out for SPLIT_OUT with its block on the seam; null for none */
  ass: string | null;
  /** the ass filter string for that file (fonts dir included), from studio-caption-video's assFilter */
  assFilter?: string;
  target: string;
  out?: Size;
};

/** The filter graph: each half cropped to its framing and scaled to its slot, stacked, captions burned in on top.
 *  Input 0 is the clip, input 1 the gameplay. */
export function splitGraph(r: Pick<SplitRender, "clip" | "game" | "layout" | "ass" | "assFilter" | "out">): string {
  const out = r.out ?? SPLIT_OUT, fps = SPLIT_OUT.fps;
  const h = halves(r.layout, out);
  const part = (input: number, src: Size, slot: Rect, b: Box, label: string, safe?: Rect | null) => {
    const c = cropInside(src, safe, slot, b);
    return `[${input}:v]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${slot.w}:${slot.h}:flags=lanczos,setsar=1,fps=${fps}[${label}]`;
  };
  const steps: string[] = [];
  steps.push(part(1, r.game.size, h.game, r.layout.game, "g", r.game.safe));
  let pic = "g";
  if (h.clip) {
    steps.push(part(0, r.clip.size, h.clip, r.layout.clip, "c"));
    steps.push(r.layout.swap ? "[g][c]vstack=inputs=2[s]" : "[c][g]vstack=inputs=2[s]");
    pic = "s";
  }
  steps.push(`[${pic}]${r.ass && r.assFilter ? `${r.assFilter},` : ""}format=yuv420p[v]`);
  return steps.join(";");
}

/** The whole ffmpeg command after `ffmpeg`. The gameplay is read from its start point and looped when short; the
 *  video lasts exactly as long as the clip; the sound is the clip's own (silence when it has none). */
export function splitArgs(r: SplitRender): string[] {
  const g = r.game;
  const net = /^https?:/.test(g.file) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"] : [];
  const gameIn = [...(g.loop ? ["-stream_loop", "-1"] : []), ...net, ...(g.start > 0 ? ["-ss", g.start.toFixed(2)] : []), "-i", g.file];
  const silence = r.clip.hasAudio ? [] : ["-f", "lavfi", "-t", r.clip.seconds.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo"];
  const audioMap = ["-map", r.clip.hasAudio ? "0:a:0" : "2:a:0"];
  return [
    "-v", "error", "-nostdin", "-y",
    "-i", r.clip.file, ...gameIn, ...silence,
    "-filter_complex", splitGraph(r), "-map", "[v]", ...audioMap,
    "-t", r.clip.seconds.toFixed(2), "-fps_mode", "cfr",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", r.target,
  ];
}

// ---------------------------------------------------------------------------------------------------
// The auto-sizer's eyes: where the face is in the person's clip
// ---------------------------------------------------------------------------------------------------

export const SUBJECT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["frames"],
  properties: { frames: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "kind", "x", "y", "h"],
    properties: { n: { type: "integer" }, kind: { type: "string", enum: ["face", "subject", "screen", "none"] }, x: { type: "number" }, y: { type: "number" }, h: { type: "number" } } } } },
};
export const SUBJECT_PROMPT = `These are frames from one short video, a second or so apart. It will fill one half of a split-screen video, cropped to a wide band, so we need to know what must stay in view.
For every frame:
- kind "face": a person is the subject. x and y are the centre of the main person's face (the one speaking or nearest the camera), from 0 to 1 across and down the picture; h is the face's height (chin to top of the head) as a share of the picture's height.
- kind "subject": no face to follow, but one main thing (a product, an animal, hands at work). x, y its centre; h its height share.
- kind "screen": a screen recording, slides, a game, text that fills the picture.
- kind "none": nothing in particular (scenery, a black frame). For "screen" and "none" give x 0.5, y 0.5, h 0.
Answer for every frame, in order, by its number.`;

/** One read of the stills (Claude, the small model): what is in each. */
export async function readSubjects(deps: ClipsDeps, frames: Array<{ t: number; jpg: Buffer }>, userId?: string): Promise<Array<Subject & { t: number }>> {
  if (!frames.length) return [];
  const env = deps.env ?? process.env;
  const out = await claudeJson(deps, {
    model: env.STUDIO_SPLITSCREEN_FRAME_MODEL || "claude-haiku-5-5", max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SUBJECT_SCHEMA } },
    messages: [{ role: "user", content: [
      ...frames.flatMap((f, k) => [{ type: "text", text: `Frame ${k + 1} at ${f.t.toFixed(1)} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
      { type: "text", text: SUBJECT_PROMPT },
    ] }],
  }, "splitscreen_frame", userId);
  const list: any[] = Array.isArray(out?.frames) ? out.frames : [];
  const n01 = (v: unknown, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d; };
  return frames.map((f, k) => {
    const r = list.find((x) => Number(x?.n) === k + 1) ?? list[k] ?? {};
    const kind = ["face", "subject", "screen", "none"].includes(r.kind) ? r.kind : "none";
    return { t: f.t, kind, x: n01(r.x, 0.5), y: n01(r.y, 0.5), h: n01(r.h, 0) };
  });
}

/** One framing for the whole clip from the reads: the kind most frames show; for a face or a subject, the middle
 *  (median) of where it was, so a glance away or a hand in front does not move the crop. */
export function settleSubject(reads: Subject[]): Subject | null {
  if (!reads.length) return null;
  const count = (k: Subject["kind"]) => reads.filter((r) => r.kind === k).length;
  const kinds: Array<NonNullable<Subject["kind"]>> = ["face", "subject", "screen", "none"];
  const kind = kinds.reduce((a, b) => (count(b) > count(a) ? b : a), "face");
  if (kind === "screen" || kind === "none") return { kind, x: 0.5, y: 0.5 };
  const seen = reads.filter((r) => r.kind === kind);
  const mid = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  return { kind, x: mid(seen.map((r) => r.x)), y: mid(seen.map((r) => r.y)), h: mid(seen.map((r) => r.h ?? 0)) };
}
