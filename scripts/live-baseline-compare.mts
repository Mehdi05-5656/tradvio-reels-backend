// Live Clips, baseline: Clips' own moment picking (the whole transcript of an hour, chooseWithClaude as the YouTube path
// does it) on chosen hours of a past broadcast, so its picks can be set against what the chat detector + verifier
// found on the same hours. Local only, real doors (Twitch, ElevenLabs, Claude from ops/.env); nothing is stored.
//   node .exp-build/baseline.mjs <twitch vod id> <hours, e.g. 2,6> <out dir>
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { twitchVodPlaylists } from "../src/live-sources.js";
import { fetchSound } from "../src/studio-live-clips.js";
import { transcribeWords } from "../src/studio-eleven.js";
import { linesFromWords, windows, chooseWithClaude, finalizeMoments, CLIP_LIMITS } from "../src/studio-clips.js";

const envText = await readFile(join(process.env.HOME ?? "", "tradvio/ops/.env"), "utf8").catch(() => "");
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const env: Record<string, string | undefined> = { ...process.env };
const [vodId, hoursArg, outArg] = process.argv.slice(2);
if (!vodId || !hoursArg) { console.error("usage: <vod id> <hours> [out dir]"); process.exit(1); }
const out = outArg ?? join(process.cwd(), ".exp-build", "baseline"); await mkdir(out, { recursive: true });
const log = (l: string) => console.log(l);
const deps: any = { env, log };
const pl = await twitchVodPlaylists(deps, vodId);
log(`playlists: audio ${pl.audio.slice(0, 60)}...`);
const report: string[] = [`# Clips' own picking on hours ${hoursArg} of Twitch VOD ${vodId}`, ""];
for (const hs of hoursArg.split(",")) {
  const h = Number(hs); const start = h * 3600, seconds = 3600;
  const mp3 = join(out, `h${h}.mp3`), wordsFile = join(out, `h${h}.words.json`);
  let heard: { words: any[]; events: any[]; language: string | null };
  if (await stat(wordsFile).then(() => true).catch(() => false)) { heard = JSON.parse(await readFile(wordsFile, "utf8")); log(`hour ${h}: words from cache (${heard.words.length})`); }
  else {
    const t0 = Date.now();
    await fetchSound(pl.audio, start, seconds, mp3);
    const buf = await readFile(mp3);
    log(`hour ${h}: ${Math.round(buf.length / 1024)} kB of sound in ${Math.round((Date.now() - t0) / 1000)} s; transcribing`);
    const r = await transcribeWords({ env, fetch } as any, { audio: buf, events: true });
    heard = { words: r.words, events: r.events, language: r.language };
    await writeFile(wordsFile, JSON.stringify(heard));
    log(`hour ${h}: ${r.words.length} words, ${r.events.length} events in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  const lines = linesFromWords(heard.words);
  const wins = windows(lines);
  log(`hour ${h}: ${lines.length} lines, ${wins.length} windows`);
  const raw: any[] = [];
  for (const [k, w] of wins.entries()) {
    const picks = await chooseWithClaude(deps, { lines: w, meta: { title: "stableronaldo IRL stream", channel: "stableronaldo", description: "", chapters: [], replay: [] } as any, length: "standard", wanted: 5 });
    log(`hour ${h}: window ${k + 1}/${wins.length} (${Math.round(w[0]?.start ?? 0)}-${Math.round(w[w.length - 1]?.end ?? 0)} s) gave ${picks.length} picks`);
    raw.push(...picks);
  }
  const moments = finalizeMoments(raw, lines, heard.words, "standard", 12, CLIP_LIMITS.min_score, heard.events);
  report.push(`## Hour ${h} (${start}-${start + seconds} s): ${moments.length} moments from ${raw.length} raw picks`, "");
  for (const m of moments) {
    report.push(`- **${m.title}** (score ${m.score}, ${Math.round(start + m.start)}-${Math.round(start + m.end)} s, ${Math.round(m.end - m.start)} s): hook "${m.hook}"; why: ${m.why}`);
    report.push(`  > ${m.transcript.slice(0, 360)}`);
  }
  report.push("");
  await writeFile(join(out, "REPORT.md"), report.join("\n"));
}
log(`done: ${join(out, "REPORT.md")}`);
