// Live Clips: one real past-stream run on this Mac, end to end, against a fake database (no job row, no credits), with
// the real Twitch/Kick doors, ElevenLabs and Claude from ops/.env. Clips land in <out dir>/ instead of storage.
// Usage: node .exp-build/run-local.mjs <twitch or kick broadcast url> <count> [out dir]
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteStreamClips, runStreamClipsJob } from "../src/studio-live-clips.js";
import { cutClip, type CutCtx, type Moment } from "../src/studio-clips.js";
import { PLANS } from "../src/studio.js";

const envText = await readFile(join(process.env.HOME ?? "", "tradvio/ops/.env"), "utf8").catch(() => "");
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const env: Record<string, string | undefined> = { ...process.env, STUDIO_LIVE_CLIPS_ENABLED: "true", STUDIO_LIVE_CLIPS_OPEN: "true", STUDIO_YT_PROXY: undefined };
const url = process.argv[2]; const count = Number(process.argv[3] ?? 3); const out = process.argv[4] ?? join(process.cwd(), ".exp-build", "live-run");
await mkdir(out, { recursive: true });
const log = (l: string) => console.log(l);
const q = await quoteStreamClips({ env, log }, PLANS, { url, count, length: "standard", strictness: "balanced" }, { owner: true });
log(`quote: ${q.summary} · ${q.credits} credits (${q.options.price.analysis} reading + ${q.options.price.per_clip} a clip) · eta ${q.options.eta_seconds}s`);
// a fake database and a cutter that stores to the folder instead of Supabase
const calls: any[] = [];
const sb: any = {
  rpc: async (fn: string, args: any) => { calls.push([fn, args]); if (fn === "studio_renew") { if (args.p_progress?.message) log(`  [progress] ${args.p_progress.stage ?? ""} ${args.p_progress.message}`); return { data: true, error: null }; } if (fn === "studio_complete") { log(`  [complete] charged ${args.p_credits_charged}`); return { data: {}, error: null }; } log(`  [rpc] ${fn} ${JSON.stringify(args).slice(0, 200)}`); return { data: null, error: null }; },
  from: () => ({ update: (f: any) => ({ eq: () => ({ eq: async () => { log(`  [collection] ${JSON.stringify(f).slice(0, 300)}`); return { error: null }; } }) }) }),
  storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: null }) }) },
};
let n = 0;
const cut = async (ctx: CutCtx, m: Moment) => {
  // the real cutter, but its storage calls answer "ok" (above) and the clip's file is copied out before it is removed
  const fakeSb: any = { ...sb, from: (table: string) => table === "studio_assets" ? ({ insert: async (row: any) => { n++; await copyFile(join(ctx.dir, `c${m.rank}.mp4`), join(out, `clip-${n}-${String(row.name).replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.mp4`)); await writeFile(join(out, `clip-${n}.json`), JSON.stringify({ ...row, object_key: undefined }, null, 1)); return { error: null }; } }) : sb.from(table) };
  return cutClip({ ...ctx, sb: fakeSb, deps: { ...ctx.deps, env } }, m);
};
const job: any = { id: `local-${Date.now()}`, user_id: "00000000-0000-4000-8000-000000000000", lease_token: "t", asset_id: null, credits_reserved: q.credits, attempts: 1, options: { ...q.options, collection_id: "local" }, progress: {} };
const t0 = Date.now();
const r = await runStreamClipsJob(sb, { env, log, plans: PLANS, cut }, job);
log(`run: ${r} in ${Math.round((Date.now() - t0) / 1000)} s; clips in ${out}`);
