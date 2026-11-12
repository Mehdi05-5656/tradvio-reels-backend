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
import { cropInside, halves, SPLIT_OUT, type Box, type Layout, type Rect, type Size } from "./splitscreen-layout.js";

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
  const gameIn = [...(g.loop ? ["-stream_loop", "-1"] : []), ...(g.start > 0 ? ["-ss", g.start.toFixed(2)] : []), "-i", g.file];
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
