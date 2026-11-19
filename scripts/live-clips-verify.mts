// Live Clips, experiment 1 part C (Nov 18 2026): for each chat candidate of a past stream, hear 150 s of its sound with
// the Clips engine (ElevenLabs words + events, loudness), find the cut on the lines (RESEARCH.md 4.3), and ask a model
// to verify it with stills (4.4). Read-only on the platforms; the only paid calls are ElevenLabs and Claude, logged.
// Usage: node .exp-build/verify.mjs <experiment dir> [max candidates] [model]
//   expects <dir>/kick-candidates.json, <dir>/chat.jsonl, <dir>/kick-vod-source.txt, <dir>/kick-audio/c<rank>.mp3
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateLines, claudeJson, ffmpeg, linesFromWords, loudnessExcess, loudnessTrack, loudPeaks, type Line } from "../src/studio-clips.js";
import { transcribeWords } from "../src/studio-eleven.js";

// ops/.env (owner-made, gitignored) into the environment; values never printed
const envText = await readFile(join(process.env.HOME ?? "", "tradvio/ops/.env"), "utf8").catch(() => "");
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const env = process.env as Record<string, string | undefined>;
const dir = process.argv[2]; const maxN = Number(process.argv[3] ?? 99); const model = process.argv[4] ?? "claude-sonnet-5-5";
const log = (l: string) => console.log(l);
const deps = { env, log };
const AUDIO_LEAD = 45, AUDIO_LEN = 150;

type Cand = { rank: number; onset: number; peak: number; last: number; z: number; ratio: number; n: number; t_event: number; chat_sample: string[] };
const cands: Cand[] = JSON.parse(await readFile(join(dir, "kick-candidates.json"), "utf8")).slice(0, maxN);
const source = (await readFile(join(dir, "kick-vod-source.txt"), "utf8")).trim();
// chat rates per second (10-s windows) for the whole pulled window, from chat.jsonl
const msgs: Array<{ t: number; u: number; c: string }> = [];
for (const l of (await readFile(join(dir, "chat.jsonl"), "utf8")).split("\n")) { try { if (l) msgs.push(JSON.parse(l)); } catch { /* partial line */ } }
const perSec = new Map<number, number>(); for (const m of msgs) perSec.set(m.t, (perSec.get(m.t) ?? 0) + 1);
const rate = (t: number) => { let n = 0; for (let s = t - 9; s <= t; s++) n += perSec.get(s) ?? 0; return n; };
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

const VERIFY_SYSTEM = `You are the best short-form video editor alive, checking ONE candidate moment from a live stream before it is cut into a 20-55 second vertical clip for TikTok, Reels and Shorts. The moment was found by the stream's own chat reacting (the burst is marked on the transcript) and by the sound. You see the transcript of the window with its signals, and stills from it. Decide whether this is a clip a stranger would stop for, and where exactly it should start and end.

Keep it only if ALL hold: it stands alone (no context needed from earlier in the stream, no "as I said"); it has a payoff (a laugh, a shock, a win, a fail, a reveal, a line that lands) and the clip ends right after it; it is not a sponsor read, an ad break, a "be right back" screen, music only, or the streamer reading a chat message that needs the chat to be seen; it is not just the game's cutscene with the streamer silent unless the picture itself is the payoff.

The proposed cut is only a first guess from the chat's timing. YOUR job is to find the best clip inside the whole window: if the payoff comes later than the proposed end (the chat often reacts before the moment finishes), move end_line to the line where the payoff lands plus the reaction it earns; if the setup starts earlier, move start_line back. The clip must be 20 to 55 seconds and start where a thought starts. Judge the moment with YOUR boundaries, not the proposed ones. Score 0-100 for how likely it holds a stranger (hook 30, payoff 25, energy or reaction 20, standalone 15, novelty 10). Be strict: 90+ exceptional, 75 strong, 60 the bar to keep (keep = score >= 60 and standalone). start_line is the first line of the clip and end_line the last, using the line numbers exactly as given. title under 60 characters, in the stream's language; why under 15 words; why_not under 15 words when rejected (empty when kept).`;
const SCHEMA = { type: "object", additionalProperties: false, required: ["keep", "score", "standalone", "start_line", "end_line", "title", "why", "why_not"],
  properties: { keep: { type: "boolean" }, score: { type: "integer" }, standalone: { type: "boolean" }, start_line: { type: "integer" }, end_line: { type: "integer" }, title: { type: "string" }, why: { type: "string" }, why_not: { type: "string" } } };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const results: any[] = [];
const outName = process.argv[5] ?? "kick-verify-results.json";
const work = await mkdtemp(join(tmpdir(), "live-clips-exp-"));
for (const c of cands) {
  const t0 = Date.now();
  const audio = join(dir, "kick-audio", `c${c.rank}.mp3`);
  const start = Math.max(0, c.t_event - AUDIO_LEAD); // audio second 0 = stream second `start`
  let buf: Buffer; try { buf = await readFile(audio); } catch { log(`c${c.rank}: no audio yet, skipped`); continue; }
  if (!buf.length) { log(`c${c.rank}: empty audio, skipped`); continue; }
  // 1. hear it: words with speakers, laughter and other events, loudness per second
  const heard = await transcribeWords({ env } as any, { audio: buf, events: true });
  const rms = await loudnessTrack(audio, work).catch(() => [] as number[]);
  const excess = rms.length ? loudnessExcess(rms) : null;
  const peaks = excess ? loudPeaks(excess, 5) : [];
  let lines: Line[] = annotateLines(linesFromWords(heard.words), heard.events, excess);
  // 2. the chat on the window, relative to the audio: baseline = median of the 10 minutes before the window
  const base = median(Array.from({ length: 60 }, (_, k) => rate(start - 600 + k * 10)));
  const chatAt = (rel: number) => rate(start + rel);
  const onsetRel = c.onset - start, peakRel = c.peak - start, eventRel = c.t_event - start;
  const annotate = (l: Line) => {
    const tags: string[] = [];
    if (l.start <= onsetRel && l.end > onsetRel - 1) tags.push(`chat burst begins: ×${(chatAt(onsetRel + 5) / Math.max(base, 1)).toFixed(1)} the usual rate`);
    if (l.start <= peakRel && l.end > peakRel - 1) tags.push(`chat peak ×${c.ratio} (${c.n} messages in 10 s; e.g. ${c.chat_sample.slice(0, 5).map((x) => JSON.stringify(x)).join(", ")})`);
    return tags.length ? `${l.text} [${tags.join("; ")}]` : l.text;
  };
  // 3. the cut on the lines (4.3): start = a line that opens 8-25 s before the event (closest first); end = first line
  //    that closes after the reaction has started falling (chat under 1.5x base, or 12 s after the peak), past a laugh
  const opens = (k: number) => k === 0 || !!lines[k].opens; const closes = (k: number) => k === lines.length - 1 || !!lines[k].closes;
  let s = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 8 && lines[k].start >= eventRel - 25) { s = k; break; }
  if (s < 0) for (let k = lines.length - 1; k >= 0; k--) if (opens(k) && lines[k].start <= eventRel - 8) { s = k; break; }
  if (s < 0) s = 0;
  let fall = peakRel + 12; for (let t = peakRel + 3; t < peakRel + 40; t++) if (chatAt(t) < 1.5 * Math.max(base, 1)) { fall = Math.min(fall, t); break; }
  let e = -1; for (let k = 0; k < lines.length; k++) if (lines[k].end >= fall && closes(k)) { e = k; break; }
  if (e < 0) e = lines.length - 1;
  if (e < s) e = s;
  const span = () => lines[e].end - lines[s].start;
  while (span() < 20 && e < lines.length - 1) { e++; while (e < lines.length - 1 && !closes(e)) e++; }
  while (span() > 55 && e > s) { e--; while (e > s && !closes(e)) e--; if (span() <= 55) break; if (e === s) break; }
  if (span() > 55) { while (span() > 55 && s < e) { s++; while (s < e && !opens(s)) s++; } }
  let cutStart = lines[s].start, cutEnd = lines[e].end;
  for (const ev of heard.events) if (ev.start >= cutEnd - 0.6 && ev.start <= cutEnd + 1.5 && /laugh|applause|cheer|scream/i.test(ev.text)) cutEnd = Math.min(ev.end + 0.35, cutStart + 55);
  // 4. where the sound peaked near the event (the lag the live system must learn): loudness peak in [event-20, peak+5]
  let soundPeak: number | null = null, best = 0;
  if (excess) for (let t = Math.max(0, Math.floor(eventRel - 20)); t <= Math.min(excess.length - 1, Math.ceil(peakRel + 5)); t++) if (excess[t] > best) { best = excess[t]; soundPeak = t; }
  const laughs = heard.events.filter((x) => /laugh/i.test(x.text) && x.start >= eventRel - 20 && x.start <= peakRel + 10).map((x) => Math.round(x.start));
  // 5. stills: 6 frames at the cut's start, the event, the sound peak, the chat peak, the end, and one in the middle
  const times = [...new Set([cutStart, eventRel, soundPeak ?? eventRel + 5, peakRel, (cutStart + cutEnd) / 2, Math.max(cutStart, cutEnd - 1)].map((t) => Math.round(Math.max(0, Math.min(AUDIO_LEN - 1, t)))))].sort((a, b) => a - b);
  const frames: Array<{ t: number; jpg: Buffer }> = [];
  for (const t of times) { const f = join(work, `c${c.rank}_${t}.jpg`); try { await ffmpeg(["-v", "error", "-nostdin", "-y", "-ss", String(start + t), "-i", source, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "5", f], { timeoutMs: 90_000 }); frames.push({ t, jpg: await readFile(f) }); } catch (err: any) { log(`c${c.rank}: still at ${t}s failed: ${String(err?.message ?? err).slice(0, 100)}`); } }
  // 6. verify
  const body = lines.map((l) => `L${l.i} [${mmss(l.start)}]${l.speaker ? ` ${l.speaker}:` : ""} ${annotate(l)}${(l.events ?? []).map((x) => ` [${x}]`).join("")}${(l.loud ?? 0) >= 5 ? ` ⟪+${l.loud} dB⟫` : ""}`).join("\n");
  const head = `Stream: xQc on Kick, category Grand Theft Auto VI, Nov 18 2026 (the game's launch day). Window: ${mmss(start)} to ${mmss(start + AUDIO_LEN)} into the stream; times below are seconds from the window's start. The chat's usual pace here is ${base} messages per 10 s. The proposed cut is L${lines[s]?.i ?? 0} to L${lines[e]?.i ?? 0} (${mmss(cutStart)}-${mmss(cutEnd)}, ${Math.round(cutEnd - cutStart)} s). Loudest stretches: ${peaks.map((p) => `${mmss(p.start)} (+${p.db} dB)`).join(", ") || "none"}.`;
  let verdict: any = null, usd = 0;
  try {
    const out = await claudeJson({ env, log: (l) => { const m = l.match(/"usd":([0-9.]+)/); if (m) usd += Number(m[1]); log(l); } }, {
      model, max_tokens: 2000, system: VERIFY_SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [
        ...frames.flatMap((f) => [{ type: "text", text: `Still at ${f.t} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
        { type: "text", text: `${head}\n\nTranscript (Lnn [m:ss] speaker: words; sounds in brackets; ⟪+dB⟫ = louder than usual; the chat's reaction marked where it begins and peaks):\n${body || "(no speech heard in this window)"}` },
      ] }],
    }, "live_clips_verify");
    verdict = out;
  } catch (err: any) { log(`c${c.rank}: verify failed: ${String(err?.message ?? err).slice(0, 160)}`); }
  const byI = new Map(lines.map((l) => [l.i, l]));
  const vs = verdict && byI.get(Number(verdict.start_line)), ve = verdict && byI.get(Number(verdict.end_line));
  const r = { rank: c.rank, z: c.z, ratio: c.ratio, t_event: c.t_event, window_start: start, words: heard.words.length, events: heard.events.map((x) => x.text).slice(0, 8),
    chat_onset_rel: onsetRel, chat_peak_rel: peakRel, sound_peak_rel: soundPeak, sound_peak_db: Math.round(best * 10) / 10, laughs_rel: laughs,
    lag_sound_to_chat_onset_s: soundPeak != null ? Math.round(onsetRel - soundPeak) : null,
    cut: { start: Math.round(cutStart * 10) / 10, end: Math.round(cutEnd * 10) / 10, seconds: Math.round((cutEnd - cutStart) * 10) / 10, lines: [lines[s]?.i, lines[e]?.i] },
    verify: verdict ? { keep: verdict.keep, score: verdict.score, standalone: verdict.standalone, title: verdict.title, why: verdict.why, why_not: verdict.why_not, start: vs ? Math.round(vs.start * 10) / 10 : null, end: ve ? Math.round(ve.end * 10) / 10 : null, seconds: vs && ve ? Math.round((ve.end - vs.start) * 10) / 10 : null } : null,
    claude_usd: Math.round(usd * 10000) / 10000, seconds_taken: Math.round((Date.now() - t0) / 1000), transcript_head: lines.slice(Math.max(0, s - 1), Math.min(lines.length, e + 2)).map((l) => l.text).join(" ").slice(0, 400) };
  results.push(r);
  log(`c${c.rank} z${c.z} -> cut ${r.cut.seconds}s, sound peak ${soundPeak}s vs chat onset ${onsetRel}s (lag ${r.lag_sound_to_chat_onset_s}s), verify ${verdict ? `${verdict.keep ? "KEEP" : "reject"} ${verdict.score} "${verdict.title}" ${verdict.keep ? "" : verdict.why_not}` : "failed"} (${r.seconds_taken}s)`);
  await writeFile(join(dir, outName), JSON.stringify(results, null, 1));
}
await rm(work, { recursive: true, force: true });
log(`done: ${results.length} candidates, Claude $${results.reduce((a, r) => a + r.claude_usd, 0).toFixed(4)}`);
