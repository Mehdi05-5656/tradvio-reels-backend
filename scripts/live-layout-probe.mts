// Live Clips, the framing of one moment, locally: a still from the recording at the time given, the layout model's
// boxes, the layout the cut loop would choose (stacked, content-first, or the person framing), and a rendered frame
// of it. Real doors from ops/.env; nothing stored.
//   node .exp-build/layout-probe.mjs <twitch vod id> <seconds> <out dir>
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { twitchVodPlaylists } from "../src/live-sources.js";
import { fetchStretchCopy, findLayout, stackedLayout, contentLayout, FORMAT, TINY_CAM_W } from "../src/studio-live-clips.js";
import { ffmpeg, probeLocal } from "../src/studio-clips.js";

const envText = await readFile(join(process.env.HOME ?? "", "tradvio/ops/.env"), "utf8").catch(() => "");
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const [vodId, secondsArg, outArg] = process.argv.slice(2);
if (!vodId || !secondsArg) { console.error("usage: <vod id> <seconds> [out dir]"); process.exit(1); }
const t = Number(secondsArg); const out = outArg ?? join(process.cwd(), ".exp-build", "layout-probe"); await mkdir(out, { recursive: true });
const deps: any = { env: process.env, log: (l: string) => { if (!/^\[cost\]/.test(l)) console.log(l); } };
const pl = await twitchVodPlaylists(deps, vodId);
const stretch = join(out, `src-${t}.mp4`);
await fetchStretchCopy(pl.video, t, 6, stretch);
const info = await probeLocal(stretch);
const still = join(out, `still-${t}.jpg`);
await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", "2", "-i", stretch, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "5", still], { timeoutMs: 60_000 });
const lay = await findLayout(deps, await readFile(still));
const irl = !!lay.cam && lay.cam.w * lay.cam.h > FORMAT.irl_cam_share, tiny = !!lay.cam && lay.cam.w < TINY_CAM_W;
console.log(`source ${info.w}x${info.h}; layout ${JSON.stringify({ cam: lay.cam, content: lay.content, irl, tiny })}`);
let choice = "person (Clips' own framing)"; let graph: string | null = null;
if (lay.cam && !irl && !tiny) { choice = "stacked"; graph = stackedLayout({ w: info.w, h: info.h, fps: info.fps }, lay.cam, lay.content).graph; }
else if (!irl && lay.content) { choice = "content-first"; graph = contentLayout({ w: info.w, h: info.h, fps: info.fps }, lay.content).graph; }
console.log(`choice: ${choice}`);
if (graph) {
  const clip = join(out, `framed-${t}.mp4`);
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-i", stretch, "-filter_complex", graph, "-map", "[v]", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-an", clip], { timeoutMs: 120_000 });
  await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", "1.5", "-i", clip, "-frames:v", "1", "-vf", "scale=540:-2", join(out, `framed-${t}.png`)], { timeoutMs: 60_000 });
  console.log(`frame: ${join(out, `framed-${t}.png`)}`);
}
await rm(stretch, { force: true }).catch(() => undefined);
