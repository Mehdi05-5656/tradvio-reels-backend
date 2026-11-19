// Live Clips, cost probes (Nov 19 2026): what the verifier's stills cost in tokens and whether the verdict changes
// without them; whether Haiku agrees with Sonnet's verdicts on real windows; whether Haiku picks what Sonnet picks
// on an hour. Local only, real doors from ops/.env, nothing stored. The hour transcripts come from the baseline
// script's cache (<cache dir>/h2.words.json, h6.words.json: seconds from the hour's start).
//   node .exp-build/cost-probe.mjs <vod id> <cache dir> <mode: stills|verdicts|picker|all>
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { twitchVodPlaylists } from "../src/live-sources.js";
import { fetchSound, firstCut, VERIFY_SYSTEM, VERIFY_SCHEMA, checklistScore } from "../src/studio-live-clips.js";
import { transcribeWords } from "../src/studio-eleven.js";
import { annotateLines, linesFromWords, claudeJson, chooseWithClaude, finalizeMoments, windows, ffmpeg, CLIP_LIMITS, type Line } from "../src/studio-clips.js";
import { transcribeGroq } from "../src/studio-stt.js";

const envText = await readFile(join(process.env.HOME ?? "", "tradvio/ops/.env"), "utf8").catch(() => "");
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const [vodId, cacheDir, mode = "all"] = process.argv.slice(2);
if (!vodId || !cacheDir) { console.error("usage: <vod id> <cache dir> [mode]"); process.exit(1); }
const costs: Array<{ feature: string; model: string; input: number; output: number; cache_read: number; usd: number }> = [];
const log = (l: string) => { const m = /^\[cost\] claude (\{.*\})$/.exec(l); if (m) { const j = JSON.parse(m[1]); costs.push({ feature: j.feature, model: j.model, input: j.input, output: j.output, cache_read: j.cache_read ?? 0, usd: j.usd }); } else console.log(l); };
const env: Record<string, string | undefined> = { ...process.env };
const deps: any = { env, log };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const lastCost = () => costs[costs.length - 1];
const dir = join(tmpdir(), `live-cost-${Date.now()}`); await mkdir(dir, { recursive: true });

type HourCache = { words: Array<{ text: string; start: number; end: number; speaker: string | null }>; events: Array<{ text: string; start: number; end: number }> };
const hourCache = new Map<number, HourCache>();
async function hour(h: number): Promise<HourCache> { if (!hourCache.has(h)) hourCache.set(h, JSON.parse(await readFile(join(cacheDir, `h${h}.words.json`), "utf8"))); return hourCache.get(h)!; }
function windowFromHour(h: HourCache, hourStart: number, start: number, span: number) {
  const d = hourStart - start;
  const words = h.words.filter((w) => w.end + d > 0 && w.start + d < span).map((w) => ({ ...w, start: Math.round((w.start + d) * 100) / 100, end: Math.round((w.end + d) * 100) / 100 }));
  const events = h.events.filter((e) => e.end + d > 0 && e.start + d < span).map((e) => ({ ...e, start: e.start + d, end: e.end + d }));
  const before = h.words.filter((w) => w.end + d > -300 && w.start + d < 0).map((w) => w.text).join(" ").slice(-1800);
  return { words, events, lines: annotateLines(linesFromWords(words), events, null), before };
}
function prompt(lines: Line[], start: number, span: number, cut: { s: number; e: number }, before: string, note: string) {
  const body = lines.map((l) => `L${l.i} [${mmss(l.start)}]${l.speaker ? ` ${l.speaker}:` : ""} ${l.text}${(l.events ?? []).map((x) => ` [${x}]`).join("")}`).join("\n");
  const head = `Stream: stableronaldo on Twitch, titled "REACTS IRL DOING STUFF". Window: ${mmss(start)} to ${mmss(start + span)} into the stream; times below are seconds from the window's start. The chat's usual pace here is 60 messages per 10 s. The proposed cut is L${lines[cut.s]?.i ?? 0} to L${lines[cut.e]?.i ?? 0} (${mmss(lines[cut.s]?.start ?? 0)}-${mmss(lines[cut.e]?.end ?? 0)}). Loudest stretches: none. Clip length goal: 24-45 s, never under 18 or over 55.${note}`;
  const context = before ? `\n\nThe five minutes before the window, for context only (the clip cannot start here):\n${before}` : "";
  return `${head}\n\nTranscript (Lnn [m:ss] speaker: words; sounds in brackets; ⟪+dB⟫ = louder than usual; the chat's reaction marked where it begins and peaks):\n${body || "(no speech heard in this window)"}${context}`;
}
async function verify(model: string, text: string, stills: Array<{ t: number; jpg: Buffer }>, cached = false) {
  const out = await claudeJson(deps, {
    model, max_tokens: 2000, system: cached ? [{ type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral" } }] : VERIFY_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: VERIFY_SCHEMA } },
    messages: [{ role: "user", content: [
      ...stills.flatMap((f) => [{ type: "text", text: `Still at ${Math.round(f.t)} s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpg.toString("base64") } }]),
      { type: "text", text },
    ] }],
  }, "probe_verify");
  const score = checklistScore({ score: Number(out?.score) || 0, grades: out?.grades ?? null });
  return { keep: !!out?.keep && !out?.hard_fail && score >= 55 && (out?.grades?.standalone ?? 0) >= 5, score, felt: out?.score, hard_fail: out?.hard_fail, why_not: out?.why_not, title: out?.title, cost: lastCost() };
}

// 1. the stills: the Home Depot window (the cashier's age and song), heard for real, stills from the recording
if (mode === "stills" || mode === "all") {
  const pl = await twitchVodPlaylists(deps, vodId);
  const start = 7980, span = 120;
  const mp3 = join(dir, "w.mp3"); await fetchSound(pl.audio, start, span, mp3);
  const r = await transcribeWords({ env, fetch } as any, { audio: await readFile(mp3), events: true });
  const lines = annotateLines(linesFromWords(r.words), r.events, null);
  const cut = firstCut(lines, 30, 40, () => 10, 10, r.events);
  const stillsAt = async (times: number[], width: number) => { const out: Array<{ t: number; jpg: Buffer }> = []; for (const t of times) { const f = join(dir, `s${width}_${Math.round(t)}.jpg`); await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(start + t), "-i", pl.video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", f], { timeoutMs: 90_000 }); out.push({ t, jpg: await readFile(f) }); } return out; };
  const text = prompt(lines, start, span, cut, "", "");
  const six = await stillsAt([5, 30, 45, 60, 80, 100], 768), three = await stillsAt([30, 60, 90], 512), threeSmall = await stillsAt([30, 60, 90], 384);
  console.log(`\n== stills probe (window ${start}-${start + span} s, ${lines.length} lines, text ${text.length} chars)`);
  for (const [label, model, s] of [["Sonnet, 6 stills at 768 (production)", "claude-sonnet-5-5", six], ["Sonnet, 3 stills at 512", "claude-sonnet-5-5", three], ["Sonnet, 3 stills at 384", "claude-sonnet-5-5", threeSmall], ["Sonnet, no stills", "claude-sonnet-5-5", []], ["Haiku, 6 stills at 768", "claude-haiku-5-5", six], ["Haiku, no stills", "claude-haiku-5-5", []]] as const) {
    const v = await verify(model, text, s as any);
    console.log(`${label}: keep ${v.keep} score ${v.score} (felt ${v.felt}) "${v.title}" ${v.why_not || v.hard_fail || ""} | input ${v.cost.input} output ${v.cost.output} $${v.cost.usd}`);
  }
  // caching the system prompt: two calls in a row
  const a = await verify("claude-sonnet-5-5", text, [], true), b = await verify("claude-sonnet-5-5", text, [], true);
  console.log(`cache probe: first input ${a.cost.input} cache_read ${a.cost.cache_read} $${a.cost.usd}; second input ${b.cost.input} cache_read ${b.cost.cache_read} $${b.cost.usd}`);
}

// 2. the verdicts: Sonnet's real verdicts (with stills) on 17 windows of hours 2 and 6 from the third hybrid run, against
// Sonnet without stills and Haiku without stills on the same words
if (mode === "verdicts" || mode === "all") {
  const known: Array<[number, boolean, number, string]> = [[8322, true, 61, "10 years"], [24032, true, 57, "he comes to me"], [8122, true, 61, "cashier sings"], [10652, false, 35, "funniest"], [10452, false, 34, "pee here"], [23712, false, 27, "bucky fight"], [9682, false, 38, "hot dog"], [9492, false, 33, "seltzer"], [22712, false, 35, "zone wars comms"], [9872, false, 28, "shoveling"], [24882, false, 34, "too scared"], [23092, false, 34, "pete killed"], [24432, false, 30, "zero ping"], [22198, false, 35, "cant beat pete"], [22522, false, 26, "apologizes"], [24232, false, 28, "zero ping 2"], [7742, false, 31, "65 and jacked"]];
  console.log(`\n== verdict probe: ${known.length} windows`);
  const rows: string[] = []; let agreeS = 0, agreeH = 0, usdS = 0, usdH = 0;
  for (const [t, keep, score, name] of known) {
    const h = Math.floor(t / 3600), hc = await hour(h);
    const start = Math.max(h * 3600, t - 37), span = Math.min(240, Math.max(150, t + 113 - start));
    const w = windowFromHour(hc, h * 3600, start, span);
    if (!w.lines.length) { rows.push(`${name}: no words`); continue; }
    const cut = firstCut(w.lines, t - start, t - start + 8, () => 10, 10, w.events);
    const text = prompt(w.lines, start, span, cut, w.before, "");
    const s = await verify("claude-sonnet-5-5", text, []), hk = await verify("claude-haiku-5-5", text, []);
    usdS += s.cost.usd; usdH += hk.cost.usd; if (s.keep === keep) agreeS++; if (hk.keep === keep) agreeH++;
    rows.push(`${name.padEnd(16)} real: ${keep ? "KEEP" : "no  "} ${score} | Sonnet no stills: ${s.keep ? "KEEP" : "no  "} ${s.score} ${(s.why_not || s.hard_fail || "").slice(0, 40)} | Haiku: ${hk.keep ? "KEEP" : "no  "} ${hk.score} ${(hk.why_not || hk.hard_fail || "").slice(0, 40)}`);
  }
  console.log(rows.join("\n"));
  console.log(`agreement with the real verdict: Sonnet without stills ${agreeS}/${known.length} ($${usdS.toFixed(3)}), Haiku without stills ${agreeH}/${known.length} ($${usdH.toFixed(3)})`);
}

// 3. the picker: Haiku and Sonnet on hour 2 (the IRL hour), their picks side by side
if (mode === "picker" || mode === "all") {
  const hc = await hour(2);
  const lines = linesFromWords(hc.words as any);
  console.log(`\n== picker probe: hour 2, ${lines.length} lines, ${windows(lines).length} windows`);
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
    const d2 = { ...deps, env: { ...env, STUDIO_CLIPS_MODEL: model } };
    const raw: any[] = [];
    const before = costs.length;
    for (const w of windows(lines)) raw.push(...await chooseWithClaude(d2, { lines: w, meta: { title: "stableronaldo IRL stream", channel: "stableronaldo", description: "", chapters: [], replay: [] } as any, length: "standard", wanted: 5 }));
    const ms = finalizeMoments(raw, lines, hc.words as any, "standard", 12, CLIP_LIMITS.min_score, hc.events as any);
    const usd = costs.slice(before).reduce((a, c) => a + c.usd, 0);
    console.log(`${model}: ${ms.length} moments, $${usd.toFixed(3)}: ${ms.map((m) => `${Math.round(7200 + m.start)}s ${m.score} "${m.title.slice(0, 36)}"`).join(" | ")}`);
  }
}
// 4. three stills at 512 on the 17 known windows (the saving the stills probe suggested), against the real verdicts
if (mode === "stills17" || mode === "pickverify") {
  const pl = await twitchVodPlaylists(deps, vodId);
  const stillsAt = async (abs: number[], width: number, tag: string) => { const out: Array<{ t: number; jpg: Buffer }> = []; for (const t of abs) { const f = join(dir, `${tag}_${Math.round(t)}.jpg`); try { await ffmpeg(["-v", "error", "-nostdin", "-y", "-rw_timeout", "30000000", "-ss", String(t), "-i", pl.video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", f], { timeoutMs: 90_000 }); out.push({ t, jpg: await readFile(f) }); } catch { /* skip */ } } return out; };
  if (mode === "stills17") {
    const known: Array<[number, boolean, number, string]> = [[8322, true, 61, "10 years"], [24032, true, 57, "he comes to me"], [8122, true, 61, "cashier sings"], [10652, false, 35, "funniest"], [10452, false, 34, "pee here"], [23712, false, 27, "bucky fight"], [9682, false, 38, "hot dog"], [9492, false, 33, "seltzer"], [22712, false, 35, "zone wars comms"], [9872, false, 28, "shoveling"], [24882, false, 34, "too scared"], [23092, false, 34, "pete killed"], [24432, false, 30, "zero ping"], [22198, false, 35, "cant beat pete"], [22522, false, 26, "apologizes"], [24232, false, 28, "zero ping 2"], [7742, false, 31, "65 and jacked"]];
    console.log(`\n== 3 stills at 512 on ${known.length} windows`);
    let agree = 0, keepsKept = 0, usd = 0; const rows: string[] = [];
    for (const [t, keep, score, name] of known) {
      const h = Math.floor(t / 3600), hc = await hour(h);
      const start = Math.max(h * 3600, t - 37), span = Math.min(240, Math.max(150, t + 113 - start));
      const w = windowFromHour(hc, h * 3600, start, span);
      if (!w.lines.length) continue;
      const cut = firstCut(w.lines, t - start, t - start + 8, () => 10, 10, w.events);
      const rel = [w.lines[cut.s]?.start ?? 0, t - start + 8, w.lines[cut.e]?.end ?? span - 1].map((x) => Math.max(0, Math.min(span - 1, x)));
      const stills = (await stillsAt(rel.map((x) => start + x), 512, `k${t}`)).map((f) => ({ ...f, t: f.t - start }));
      const v = await verify("claude-sonnet-5-5", prompt(w.lines, start, span, cut, w.before, ""), stills);
      usd += v.cost.usd; if (v.keep === keep) agree++; if (keep && v.keep) keepsKept++;
      rows.push(`${name.padEnd(16)} real: ${keep ? "KEEP" : "no  "} ${score} | 3@512: ${v.keep ? "KEEP" : "no  "} ${v.score} ${(v.why_not || v.hard_fail || "").slice(0, 44)} | $${v.cost.usd}`);
    }
    console.log(rows.join("\n")); console.log(`agreement ${agree}/${known.length}, real keeps kept ${keepsKept}/3, $${usd.toFixed(3)}`);
  }
  if (mode === "pickverify") {
    // hour 2's picks from the picker probe, verified as production does (six stills at 768): which picker's moments survive
    const picks: Array<[string, number, string]> = [["haiku", 8009, "age at checkout"], ["haiku", 9882, "pepsi or coke"], ["haiku", 8246, "turn 25"], ["haiku", 9557, "energy drink label"], ["haiku", 10374, "fired for flirting"], ["haiku", 8181, "coffin threat"], ["sonnet", 8445, "underwear"], ["sonnet", 8319, "loved him fat"], ["sonnet", 8405, "10 years"], ["sonnet", 9716, "hot dog"], ["sonnet", 8246, "turn 25"], ["sonnet", 10463, "peeing outside"]];
    console.log(`\n== picks verified (6 stills at 768, Sonnet)`);
    const rows: string[] = []; const kept: Record<string, number> = { haiku: 0, sonnet: 0 }; let usd = 0; const seen = new Map<number, any>();
    for (const [who, t, name] of picks) {
      let v = seen.get(t);
      if (!v) {
        const hc = await hour(2); const start = Math.max(7200, t - 30), span = Math.min(240, Math.max(150, t + 70 - start));
        const w = windowFromHour(hc, 7200, start, span); if (!w.lines.length) continue;
        const cut = firstCut(w.lines, t - start + 8, t - start + 16, () => 10, 10, w.events);
        const rel = [2, (t - start) + 5, (t - start) + 20, (t - start) + 35, (t - start) + 50, span - 2].map((x) => Math.max(0, Math.min(span - 1, x)));
        const stills = (await stillsAt(rel.map((x) => start + x), 768, `p${t}`)).map((f) => ({ ...f, t: f.t - start }));
        v = await verify("claude-sonnet-5-5", prompt(w.lines, start, span, cut, w.before, " This moment was found in the words of the stream, not by a chat burst; the proposed cut is the picker's."), stills);
        seen.set(t, v); usd += v.cost.usd;
      }
      if (v.keep) kept[who]++;
      rows.push(`${who.padEnd(6)} ${name.padEnd(20)} ${v.keep ? "KEEP" : "no  "} ${v.score} "${(v.title || "").slice(0, 40)}" ${(v.why_not || v.hard_fail || "").slice(0, 40)}`);
    }
    console.log(rows.join("\n")); console.log(`kept: haiku ${kept.haiku}/6, sonnet ${kept.sonnet}/6, $${usd.toFixed(3)}`);
  }
}
// 5. the cheap door: hour 2 heard by Groq's Whisper turbo against Scribe's cached words; the Haiku picker on each
if (mode === "stt") {
  const pl = await twitchVodPlaylists(deps, vodId);
  const hc = await hour(2);
  const mp3 = join(dir, "h2.mp3"); const t0 = Date.now();
  await fetchSound(pl.audio, 7200, 3600, mp3);
  const buf = await readFile(mp3); const t1 = Date.now();
  const g = await transcribeGroq({ env, fetch }, { audio: buf });
  const t2 = Date.now();
  console.log(`\n== stt probe: hour 2, ${Math.round(buf.length / 1024)} kB fetched in ${Math.round((t1 - t0) / 1000)} s; Groq turbo: ${g.words.length} words in ${Math.round((t2 - t1) / 1000)} s (Scribe cached: ${hc.words.length} words, ${hc.events.length} sounds)`);
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
  const A = hc.words.map((w) => norm(w.text)).filter(Boolean), B = g.words.map((w) => norm(w.text)).filter(Boolean);
  // a plain diff on the word strings: matched words, and the time offset between the doors on the matches
  // LCS on 12k words is heavy; sample by 10-minute stretches instead
  let matched = 0, offs: number[] = [], total = 0;
  for (let k = 0; k < 6; k++) {
    const from = k * 600, to = from + 600;
    const a = hc.words.filter((w) => w.start >= from && w.start < to), b = g.words.filter((w) => w.start >= from && w.start < to);
    const bi = new Map<string, number[]>(); b.forEach((w, i) => { const key = norm(w.text); if (!bi.has(key)) bi.set(key, []); bi.get(key)!.push(i); });
    let last = -1;
    for (const w of a) { total++; const key = norm(w.text); if (!key) continue; const cands = (bi.get(key) ?? []).filter((i) => i > last && Math.abs(b[i].start - w.start) < 2.5); if (cands.length) { matched++; last = cands[0]; offs.push(b[cands[0]].start - w.start); } }
  }
  offs.sort((x, y) => x - y);
  const med = offs.length ? offs[Math.floor(offs.length / 2)] : 0, p90 = offs.length ? Math.abs(offs[Math.floor(offs.length * 0.9)]) : 0;
  console.log(`words of Scribe found in Groq's at the same time (within 2.5 s): ${matched}/${total} (${Math.round((100 * matched) / Math.max(1, total))} %); time offset median ${med.toFixed(2)} s, 90th pct ${p90.toFixed(2)} s`);
  const sampleAt = (t: number) => ({ scribe: hc.words.filter((w) => w.start >= t && w.start < t + 20).map((w) => w.text).join(" "), groq: g.words.filter((w) => w.start >= t && w.start < t + 20).map((w) => w.text).join(" ") });
  for (const t of [800, 1900, 3100]) { const x = sampleAt(t); console.log(`\n[${7200 + t} s] Scribe: ${x.scribe.slice(0, 220)}\n[${7200 + t} s] Groq:   ${x.groq.slice(0, 220)}`); }
  for (const [label, words, events] of [["Scribe", hc.words, hc.events], ["Groq", g.words, []]] as const) {
    const lines = linesFromWords(words as any); const d2 = { ...deps, env: { ...env, STUDIO_CLIPS_MODEL: "claude-haiku-5-5" } };
    const raw: any[] = []; const before = costs.length;
    for (const w of windows(lines)) raw.push(...await chooseWithClaude(d2, { lines: w, meta: { title: "stableronaldo IRL stream", channel: "stableronaldo", description: "", chapters: [], replay: [] } as any, length: "standard", wanted: 5 }));
    const ms = finalizeMoments(raw, lines, words as any, "standard", 12, CLIP_LIMITS.min_score, events as any);
    console.log(`\nHaiku picker on ${label}'s words: ${ms.length} moments ($${costs.slice(before).reduce((x, c) => x + c.usd, 0).toFixed(3)}): ${ms.map((m) => `${Math.round(7200 + m.start)}s ${m.score} "${m.title.slice(0, 32)}"`).join(" | ")}`);
  }
}
await rm(dir, { recursive: true, force: true }).catch(() => undefined);
console.log(`\ntotal spent on probes: $${costs.reduce((a, c) => a + c.usd, 0).toFixed(3)}`);
