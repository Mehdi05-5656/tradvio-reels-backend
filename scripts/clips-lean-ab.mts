// Clips, whole video against lean (STUDIO_CLIPS_LEAN), on the same YouTube videos, through the real runClipsJob.
// Local only: a stand-in for Supabase keeps everything on disk (no database, no storage, no charge); every YouTube
// request goes through a local proxy that counts the bytes (and can be capped at the speed measured through the paid
// proxy on Render). Speech-to-text, the moments Claude picks and the framing reads are made once per video and reused
// by every arm, so the arms differ only in how the picture reaches the cutter.
//
//   npx tsx scripts/clips-lean-ab.mts <out dir> <youtube url> [arms=whole,lean,sharp] [count=10] [rate MB/s per connection]
//
// Keys: ANTHROPIC_API_KEY and ELEVENLABS_API_KEY read from kage-motion/.env inside this process (never printed).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as clips from "../src/studio-clips.ts";
import { transcribeWords } from "../src/studio-eleven.ts";
// (bundled with esbuild like the tests: studio-clips and studio-stunts import each other, which plain tsx cannot load)

const [outDir, url, armsArg = "whole,lean,sharp", countArg = "10", rateArg = "0"] = process.argv.slice(2);
if (!outDir || !url) { console.error("usage: <out dir> <youtube url> [arms] [count] [MB/s]"); process.exit(1); }
const OUT = resolve(outDir); mkdirSync(OUT, { recursive: true });
for (const line of readFileSync(resolve(process.cwd(), "../kage-motion/.env"), "utf8").split("\n")) {
  const m = line.match(/^(ANTHROPIC_API_KEY|ELEVENLABS_API_KEY)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// the plans' prices (studio.ts PLANS; importing studio.ts here would load every tool)
const PLANS = [{ id: "starter", monthly_usd: 29, annual_usd_per_month: 24, credits: 1000 }, { id: "creator", monthly_usd: 79, annual_usd_per_month: 66, credits: 3500 }, { id: "studio", monthly_usd: 199, annual_usd_per_month: 166, credits: 10000 }];

// ---- the counting proxy (CONNECT), optionally capped per connection ----
async function startProxy(port: number, rate: number) {
  const file = join(OUT, `proxy-${port}.json`);
  const child = spawn(process.execPath, [resolve(process.cwd(), "scripts/clips-count-proxy.mjs"), String(port), file, String(rate)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  return { child, read: () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { down: 0 }; } } };
}

// ---- a stand-in for Supabase: storage on disk, inserts kept, the rest answered harmlessly ----
function fakeSb(dir: string, inserts: any[]) {
  const store = join(dir, "storage"); mkdirSync(store, { recursive: true });
  const keyFile = (b: string, k: string) => join(store, `${b}__${k.replace(/[\/]/g, "__")}`);
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return (res: any) => res({ data: null, error: { message: "stub" } });
      if (prop === "insert") return (row: any) => { inserts.push(row); return Promise.resolve({ data: null, error: null }); };
      if (prop === "update") return () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) });
      return () => chain;
    },
    apply: () => chain,
  });
  return {
    from: () => chain,
    rpc: (name: string) => Promise.resolve(name === "studio_renew" ? { data: true, error: null } : name === "studio_library_usage" ? { data: null, error: { message: "stub" } } : { data: null, error: null }),
    storage: { from: (b: string) => ({
      upload: async (k: string, body: Buffer) => { writeFileSync(keyFile(b, k), body); return { data: {}, error: null }; },
      download: async (k: string) => existsSync(keyFile(b, k)) ? { data: new Blob([readFileSync(keyFile(b, k))]), error: null } : { data: null, error: { message: "missing" } },
      remove: async () => ({ data: null, error: null }),
    }) },
  } as any;
}

// ---- reused once-per-video answers (so arms differ only in the picture path) ----
const vid = url.match(/[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/)!.slice(1).find(Boolean)!;
const cacheFile = join(OUT, `answers-${vid}.json`);
const answers: Record<string, any> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
const save = () => writeFileSync(cacheFile, JSON.stringify(answers));
const h = (x: any) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 16);
let paid = { words: 0, choose: 0, frame: 0 };
const baseDeps = (log: (l: string) => void) => ({
  plans: PLANS, log,
  meta: async () => answers.meta ?? (answers.meta = await ytMeta()),
  words: async (audio: Buffer) => { if (answers.words) return answers.words; paid.words++; const r = await transcribeWords({ env: process.env }, { audio, events: true }); answers.words = { words: r.words, events: r.events, language: r.language }; save(); return answers.words; },
  choose: async (input: any) => { const k = `c${h({ l: input.lines.map((x: any) => [x.start, x.text]), w: input.wanted, s: !!input.second })}`; if (answers[k]) return answers[k]; paid.choose++; const r = await clips.chooseWithClaude({ env: process.env, log } as any, input, "test"); answers[k] = r; save(); return r; },
  frame: async (input: any) => { const k = `f${input.frames.length}_${h(input.speech)}`; if (answers[k]) return answers[k]; paid.frame++; const r = await clips.readTrack({ env: process.env, log }, input); answers[k] = r; save(); return r; },
  room: async () => ({ ok: true }),
});
async function ytMeta() {
  const out = await new Promise<string>((res, rej) => { const c = spawn("yt-dlp", ["--no-warnings", "-J", "--js-runtimes", `node:${process.execPath}`, url]); let o = ""; c.stdout.on("data", (b) => (o += b)); c.on("close", (code) => (code ? rej(new Error("yt-dlp -J failed")) : res(o))); });
  const j = JSON.parse(out);
  return { title: j.title ?? null, channel: j.channel ?? null, description: String(j.description ?? "").slice(0, 3000), chapters: (j.chapters ?? []).map((c: any) => ({ start: c.start_time, title: c.title })), replay: [], seconds: j.duration };
}

const arms = armsArg.split(",");
const count = Number(countArg) || 10, rate = Number(rateArg) || 0;
const results: any[] = [];
let port = 18190;
for (const arm of arms) {
  const dir = join(OUT, `${vid}-${arm}`); mkdirSync(dir, { recursive: true });
  const px = await startProxy(port++, rate);
  const inserts: any[] = [], lines: string[] = [];
  const log = (l: string) => { lines.push(l); if (/\[clips\] (lean|fetched|timing|.*failed|.*skipped)/.test(l)) console.log(`  [${arm}] ${l.slice(0, 300)}`); };
  const env = { ...process.env, YT_DLP_PATH: "/opt/homebrew/bin/yt-dlp", STUDIO_YT_PROXY: `http://127.0.0.1:${port - 1}`, STUDIO_YT_PROXY_USD_PER_GB: "6.25",
    STUDIO_CLIPS_CACHE_GB: "0", STUDIO_CLIPS_LEAN: arm === "whole" ? "off" : "on", STUDIO_CLIPS_LEAN_SHARP: arm === "sharp" ? "on" : "off" };
  const meta = answers.meta ?? (answers.meta = await ytMeta()); save();
  const job = { id: randomUUID(), user_id: "00000000-0000-0000-0000-00000000test", lease_token: "t", asset_id: null, attempts: 1, created_at: new Date().toISOString(), progress: {}, credits_reserved: 100000,
    options: { platform: "youtube", url, collection_id: randomUUID(), length: "standard", format: "vertical", count, seconds: meta.seconds, source: { title: meta.title, channel: meta.channel }, language: null, captions: null } };
  const t0 = Date.now();
  const status = await clips.runClipsJob(fakeSb(dir, inserts), { ...baseDeps(log), env, cacheDir: join(dir, "cache") } as any, job as any);
  const secs = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 700));
  const bytes = px.read().down; px.child.kill();
  // the clips: their files and where each came from in the video
  const storeDir = join(dir, "storage");
  const made = inserts.filter((r) => r.kind === "video").map((r) => ({ rank: r.probe.clip.rank, start: r.probe.clip.start, end: r.probe.clip.end, seconds: r.probe.duration, w: r.probe.width, h: r.probe.height, file: join(storeDir, `studio-uploads__${r.object_key.replace(/\//g, "__")}`) }));
  const timing = lines.find((l) => l.includes("[clips] timing")) ?? "";
  results.push({ arm, status, secs: Math.round(secs), proxy_mb: Math.round(bytes / 1e5) / 10, usd: Math.round((bytes / 1e9) * 6.25 * 1000) / 1000, clips: made.length, made, timing: timing.slice(timing.indexOf("{")) });
  console.log(`${arm}: ${status} in ${Math.round(secs)} s, proxy ${(bytes / 1e6).toFixed(1)} MB ($${((bytes / 1e9) * 6.25).toFixed(3)}), ${made.length} clips`);
  writeFileSync(join(OUT, `${vid}-results.json`), JSON.stringify({ url, rate, count, paid, results }, null, 1));
}
console.log(`paid calls this run: ${JSON.stringify(paid)}`);
