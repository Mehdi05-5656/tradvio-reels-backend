// Clips health (Nov 16 2026, the day lean downloads went to every customer; the owner: "we will have to log and track
// activity to make sure all is doing and performing well"). Every 10 minutes the web service reads the Clips runs
// that finished since its last look and emails the owner when one went wrong in a way that is ours to fix:
//   - a run that failed for our reasons (a video the person cannot use, or one with no speech, is theirs: not emailed);
//   - a lean run that fell back to the whole download (it is charged the lean price, so it costs us), and lean's
//     safety switch pausing itself (2 of the last 10 lean runs fell back);
//   - a run whose margin at the cheapest credit fell under STUDIO_CLIPS_MIN_MARGIN (default 30 %);
//   - a run still going at 3x its estimate and 20+ minutes in (stuck);
//   - a run that took over twice its estimate and 10+ minutes more.
// Each kind emails at most once an hour. Once a day at 07:00 PT a summary of the last 24 hours goes out too (runs,
// outcomes, lean share and fallbacks, retries, proxy MB, cost against credits, the estimate's error), and is kept as a
// clips_digest event. GET /api/studio/admin/clips-health?hours=24 (owner only) answers with the same numbers.
//
// Costs: the proxy to the cent from its own events (by job); Claude from its cost events, given to the run of the same
// person that was going at the time (the events carry no job id); ElevenLabs is not recorded for a video run, so it is
// estimated at its rate ($0.22 an hour of sound). A stream run (Live Clips, options.stream) hears only its candidate
// windows and records each one (elevenlabs_scribe events), so its transcription is those events, by person and time;
// pricing it as the whole stream said "$7.73, margin -243 %" for a run that cost 25 cents (Nov 19 2026). Revenue is
// the credits charged at the cheapest credit we sell, so a margin here is the lowest it can be. Off with
// STUDIO_CLIPS_WATCH=off. Never throws.
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANS } from "./studio.js";
import { creditValueFloor } from "./studio-pricing.js";
import { isStudioAdmin } from "./studio-admin-auth.js";
import { ownerAlert } from "./vendor-alerts.js";
import { recordEvent } from "./studio-events.js";
import type { MailDeps } from "./studio-mail.js";

type Env = Record<string, string | undefined>;
const HOUR = 3_600_000;
export const TRANSCRIBE_USD_PER_HOUR = 0.22;
/** Failures that are about the person's video or request, not our service: counted, never emailed. */
export const THEIR_SIDE = new Set(["link_no_media", "link_too_long", "link_too_large", "clip_source_too_long", "clip_source_too_short",
  "clip_source_required", "clip_too_short", "clips_no_speech", "clips_none_found", "clips_invalid", "clips_refused", "source_missing", "asset_not_inspected"]);
export const minMargin = (env: Env) => { const n = Number(env.STUDIO_CLIPS_MIN_MARGIN); return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.3; };

const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ms = (t: any) => (t ? Date.parse(t) : NaN);

export type ClipsRun = {
  job: string; user: string | null; status: string; code: string | null; ours: boolean; created_at: string; finished_at: string | null;
  minutes: number | null; asked: number | null; clips: number | null; credits: number; revenue_usd: number;
  lean: boolean; fallback: boolean; retries: number; proxy_mb: number | null;
  cost: { proxy: number; claude: number; transcribe: number; total: number }; margin: number | null;
  eta_s: number | null; took_s: number | null; running_s: number | null;
};
export type ClipsAlert = { key: string; job: string | null; subject: string; text: string };

/** One row per run, from its job, its clips_done event and its cost events. Pure. */
export function clipsRuns(jobs: any[], events: any[], now = Date.now(), plans = PLANS): ClipsRun[] {
  const credit = creditValueFloor(plans);
  const done = new Map<string, any>(), proxy = new Map<string, { usd: number; bytes: number }>();
  for (const e of events) {
    const job = e.props?.job;
    if (e.name === "clips_done" && job) done.set(job, e.props);
    if (e.name === "youtube_proxy" && job) { const p = proxy.get(job) ?? { usd: 0, bytes: 0 }; p.usd += Number(e.usd) || 0; p.bytes += Number(e.props?.bytes) || 0; proxy.set(job, p); }
  }
  const claude = events.filter((e) => e.kind === "claude" && /^(clips_|live_clips_)/.test(e.name));
  const scribe = events.filter((e) => e.kind === "vendor" && e.name === "elevenlabs_scribe");
  return jobs.map((j): ClipsRun => {
    const d = done.get(j.id), t = d?.timing ?? {}, o = j.options ?? {};
    const start = ms(j.started_at ?? j.created_at), end = ms(j.finished_at) || now;
    // (Claude's cost events carry the person, not the job: the ones made while this run was going are this run's)
    const cl = claude.filter((e) => e.user_id === j.user_id && ms(e.created_at) >= start && ms(e.created_at) <= end + 60_000).reduce((a, e) => a + (Number(e.usd) || 0), 0);
    const seconds = Number(t.video_s ?? o.seconds) || 0;
    const p = proxy.get(j.id) ?? { usd: 0, bytes: 0 };
    const stream = !!o.stream || t.chat_messages != null;
    const heardUsd = scribe.filter((e) => e.user_id === j.user_id && ms(e.created_at) >= start && ms(e.created_at) <= end + 60_000).reduce((a, e) => a + (Number(e.usd) || 0), 0);
    const transcribe = stream ? heardUsd : j.status === "done" || (j.status === "failed" && p.bytes > 0) ? (seconds / 3600) * TRANSCRIBE_USD_PER_HOUR : 0;
    const total = p.usd + cl + transcribe, credits = Number(j.credits_charged) || 0, revenue = credits * credit;
    const lean = !!t.lean || (!d && o.lean === true);
    return {
      job: j.id, user: j.user_id ?? null, status: j.status, code: j.error_code ?? null, ours: !!j.error_code && !THEIR_SIDE.has(j.error_code),
      created_at: j.created_at, finished_at: j.finished_at ?? null,
      minutes: seconds ? Math.round(seconds / 60) : null, asked: Number(d?.asked ?? o.count ?? o.max_clips) || null, clips: d ? Number(d.clips) : null,
      credits, revenue_usd: r2(revenue), lean, fallback: !!t.lean?.fallback,
      // (one call for the sound, one per clip's stretch: the rest were retries)
      retries: t.lean ? Math.max(0, (Number(t.lean.calls) || 0) - 1 - (Number(t.clips) || 0)) : 0,
      proxy_mb: p.bytes ? Math.round(p.bytes / 1e5) / 10 : (t.fetch_mb ?? null),
      cost: { proxy: r2(p.usd), claude: r2(cl), transcribe: r2(transcribe), total: r2(total) },
      margin: revenue > 0 ? Math.round(((revenue - total) / revenue) * 100) / 100 : null,
      eta_s: Number(t.eta_s ?? o.eta_seconds) || null, took_s: Number(t.total_s) || null,
      running_s: j.status === "running" || j.status === "queued" ? Math.round((now - start) / 1000) : null,
    };
  });
}

/** What is worth an email about these runs (those finished, or going, since `since`). Pure. */
export function clipsAlerts(runs: ClipsRun[], paused: any[], since: number, env: Env = process.env): ClipsAlert[] {
  const out: ClipsAlert[] = [], min = minMargin(env), id = (r: ClipsRun) => r.job.slice(0, 8);
  const line = (r: ClipsRun) => `Run ${r.job} (${r.minutes ?? "?"} min video, ${r.clips ?? 0} of ${r.asked ?? "?"} clips, ${r.credits} credits, cost $${r.cost.total.toFixed(2)}${r.margin != null ? `, margin ${Math.round(r.margin * 100)} %` : ""})`;
  for (const r of runs) {
    const fin = ms(r.finished_at);
    if (Number.isFinite(fin) && fin > since) {
      if (r.status === "failed" && r.ours) out.push({ key: "clips_failed", job: r.job, subject: `Clips run failed (${r.code})`, text: `${line(r)} failed with ${r.code}. The person was refunded. Its log: search the backend logs for ${id(r)}.` });
      if (r.fallback) out.push({ key: "clips_fallback", job: r.job, subject: "Clips: a lean run fell back to the whole download", text: `${line(r)} could not fetch its clips' stretches and downloaded the whole video (${r.proxy_mb ?? "?"} MB through the proxy, $${r.cost.proxy.toFixed(2)}), charged at the lean price. Two of these in ten lean runs pause lean for an hour by itself.` });
      if (r.margin != null && r.margin < min && r.status === "done") out.push({ key: "clips_margin", job: r.job, subject: `Clips run under ${Math.round(min * 100)} % margin`, text: `${line(r)}: proxy $${r.cost.proxy.toFixed(2)}, Claude $${r.cost.claude.toFixed(2)}, transcription ~$${r.cost.transcribe.toFixed(2)} against $${r.revenue_usd.toFixed(2)} at the cheapest credit.` });
      if (r.eta_s && r.took_s && r.took_s > 2 * r.eta_s && r.took_s - r.eta_s > 600) out.push({ key: "clips_slow", job: r.job, subject: "Clips run took over twice its estimate", text: `${line(r)} took ${Math.round(r.took_s / 60)} min; the page said ${Math.round(r.eta_s / 60)} min.` });
    }
    if (r.running_s != null && r.running_s > 1200 && r.running_s > 3 * (r.eta_s ?? 600)) out.push({ key: "clips_stuck", job: r.job, subject: "Clips run looks stuck", text: `${line(r)} has been going ${Math.round(r.running_s / 60)} min; its estimate was ${r.eta_s ? Math.round(r.eta_s / 60) : "?"} min.` });
  }
  for (const p of paused) if (ms(p.created_at) > since) out.push({ key: "clips_lean_paused", job: null, subject: "Clips: lean downloads paused themselves for an hour", text: `${p.props?.fell_back ?? "?"} of the last ${p.props?.of ?? "?"} lean runs fell back to the whole download, so lean is off until ${p.props?.until ?? "an hour from now"} (runs carry on with the whole download at the old prices). It comes back by itself.` });
  return out;
}

/** The numbers for a stretch of time: the daily email and the admin route. Pure. */
export function clipsSummary(runs: ClipsRun[]) {
  const fin = runs.filter((r) => r.status !== "running" && r.status !== "queued");
  const ok = fin.filter((r) => r.status === "done"), lean = ok.filter((r) => r.lean);
  const sum = (v: number[]) => r2(v.reduce((a, b) => a + b, 0));
  const cost = sum(fin.map((r) => r.cost.total)), revenue = sum(fin.map((r) => r.revenue_usd));
  const etaErr = ok.filter((r) => r.eta_s && r.took_s).map((r) => Math.round(((r.took_s! - r.eta_s!) / r.eta_s!) * 100));
  return {
    runs: runs.length, done: ok.length, fewer: ok.filter((r) => r.clips != null && r.asked != null && r.clips < r.asked).length,
    failed_ours: fin.filter((r) => r.status === "failed" && r.ours).length, failed_theirs: fin.filter((r) => r.status === "failed" && !r.ours).length,
    running: runs.length - fin.length, people: new Set(runs.map((r) => r.user)).size,
    lean: lean.length, fallbacks: lean.filter((r) => r.fallback).length, retries: sum(lean.map((r) => r.retries)),
    clips: sum(ok.map((r) => r.clips ?? 0)), video_minutes: sum(fin.map((r) => r.minutes ?? 0)), proxy_mb: Math.round(fin.reduce((a, r) => a + (r.proxy_mb ?? 0), 0)),
    credits: sum(fin.map((r) => r.credits)), revenue_usd: revenue,
    cost_usd: { total: cost, proxy: sum(fin.map((r) => r.cost.proxy)), claude: sum(fin.map((r) => r.cost.claude)), transcribe: sum(fin.map((r) => r.cost.transcribe)) },
    margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) / 100 : null,
    lowest_margin: ok.filter((r) => r.margin != null).sort((a, b) => a.margin! - b.margin!)[0]?.margin ?? null,
    eta_error_pct_median: median(etaErr), minutes_median: median(ok.filter((r) => r.took_s).map((r) => Math.round(r.took_s! / 6) / 10)),
    codes: Object.fromEntries([...fin.reduce((m, r) => (r.code ? m.set(r.code, (m.get(r.code) ?? 0) + 1) : m), new Map<string, number>())]),
  };
}

export function digestText(s: ReturnType<typeof clipsSummary>, runs: ClipsRun[], hours: number): { subject: string; text: string } {
  const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)} %`);
  const worst = runs.filter((r) => r.status === "done" && r.margin != null).sort((a, b) => a.margin! - b.margin!).slice(0, 3);
  const text = [
    `Clips, the last ${hours} hours`,
    ``,
    `Runs: ${s.runs} by ${s.people} ${s.people === 1 ? "person" : "people"} — ${s.done} done (${s.fewer} with fewer clips than asked), ${s.failed_ours} failed on our side, ${s.failed_theirs} on theirs (video unusable), ${s.running} still going.`,
    `Clips made: ${s.clips} from ${s.video_minutes} min of video.`,
    `Lean: ${s.lean} of ${s.done} runs; ${s.fallbacks} fell back to the whole download; ${s.retries} stretch retries.`,
    `Proxy: ${s.proxy_mb} MB.`,
    `Money: ${s.credits} credits ≈ $${s.revenue_usd.toFixed(2)} at the cheapest credit; cost $${s.cost_usd.total.toFixed(2)} (proxy $${s.cost_usd.proxy.toFixed(2)}, Claude $${s.cost_usd.claude.toFixed(2)}, transcription ~$${s.cost_usd.transcribe.toFixed(2)}); margin ${pct(s.margin)}, lowest run ${pct(s.lowest_margin)}.`,
    `Time: median run ${s.minutes_median ?? "—"} min; the estimate was off by ${s.eta_error_pct_median == null ? "—" : `${s.eta_error_pct_median > 0 ? "+" : ""}${s.eta_error_pct_median} %`} (median; + means slower than shown).`,
    Object.keys(s.codes).length ? `Failure codes: ${Object.entries(s.codes).map(([k, v]) => `${k} ×${v}`).join(", ")}.` : null,
    worst.length ? `\nLowest margins: ${worst.map((r) => `${r.job.slice(0, 8)} ${pct(r.margin)} (${r.minutes} min, $${r.cost.total.toFixed(2)})`).join("; ")}.` : null,
  ].filter((x) => x != null).join("\n");
  return { subject: `Clips daily: ${s.done}/${s.runs} done, margin ${pct(s.margin)}${s.fallbacks ? `, ${s.fallbacks} fallback${s.fallbacks > 1 ? "s" : ""}` : ""}${s.failed_ours ? `, ${s.failed_ours} failed` : ""}`, text };
}

async function load(sb: SupabaseClient, sinceIso: string) {
  const [j, e] = await Promise.all([
    sb.from("studio_jobs").select("id,user_id,status,error_code,credits_reserved,credits_charged,options,created_at,started_at,finished_at").eq("tool", "clips").gte("created_at", sinceIso).order("created_at").limit(1000),
    sb.from("studio_events").select("name,kind,user_id,usd,props,created_at").gte("created_at", sinceIso).in("name", ["clips_done", "youtube_proxy", "clips_choose", "clips_frame", "clips_lean_paused"]).order("created_at").limit(5000),
  ]);
  if (j.error) throw j.error; if (e.error) throw e.error;
  return { jobs: j.data ?? [], events: e.data ?? [] };
}

/** 07:00 Pacific today, as a time. */
export function digestDue(now: number): { due: boolean; day: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { due: Number(get("hour")) >= 7, day: `${get("year")}-${get("month")}-${get("day")}` };
}

export function startClipsWatch(sbFn: () => SupabaseClient, deps: MailDeps & { now?: () => number; everyMs?: number } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = deps.now ?? Date.now;
  if (env.STUDIO_CLIPS_WATCH === "off") return null;
  let since = now(), lastDigest = "";
  const tick = async () => {
    const t = now(), sb = sbFn();
    // (stuck runs need the runs started a while back; the day's numbers need 24 hours)
    const { jobs, events } = await load(sb, new Date(t - 24 * HOUR).toISOString());
    const runs = clipsRuns(jobs, events, t);
    for (const a of clipsAlerts(runs, events.filter((e: any) => e.name === "clips_lean_paused"), since, env)) {
      log(`[clips-watch] ${a.subject}${a.job ? ` ${a.job}` : ""}`);
      await ownerAlert(a.key, a.subject, a.text, HOUR, { ...deps, env, log });
    }
    since = t;
    const d = digestDue(t);
    if (d.due && lastDigest !== d.day) {
      lastDigest = d.day;
      // (once a day across restarts: the day's digest is an event)
      const had = await sb.from("studio_events").select("id").eq("name", "clips_digest").eq("props->>day", d.day).limit(1);
      if (!had.error && !(had.data ?? []).length) {
        const s = clipsSummary(runs), m = digestText(s, runs, 24);
        recordEvent({ kind: "feature", name: "clips_digest", props: { day: d.day, ...s } });
        log(`[clips-watch] digest ${JSON.stringify({ day: d.day, runs: s.runs, done: s.done, margin: s.margin, fallbacks: s.fallbacks })}`);
        await ownerAlert(`clips_digest_${d.day}`, m.subject, m.text, 24 * HOUR, { ...deps, env, log });
      }
    }
  };
  const run = () => { void tick().catch((e) => log(`[clips-watch] ${String(e?.message ?? e).slice(0, 160)}`)); };
  const timer = setInterval(run, deps.everyMs ?? 10 * 60_000);
  timer.unref?.();
  return timer;
}

export function registerClipsHealth(app: Express, sbFn: () => SupabaseClient, deps: { env?: Env } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/studio/admin/clips-health", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const hours = Math.min(24 * 30, Math.max(1, Math.round(Number(req.query.hours ?? 24)) || 24));
      const { jobs, events } = await load(sb, new Date(Date.now() - hours * HOUR).toISOString());
      const runs = clipsRuns(jobs, events);
      res.json({ hours, summary: clipsSummary(runs), runs: runs.reverse() });
    } catch (e: any) {
      console.log(`[admin] clips-health: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_failed" });
    }
  });
}
