// Every failure, for every tool, in front of the owner (Nov 16 2026; the owner: "if there is a failure ... we need to make
// sure we log each time that happens to prevent it from happening again to that same user or any future user").
// The database keeps one row per failure in studio_failures (migration 20261124000000: studio_fail writes it with the
// full reason, studio_claim writes 'lost' for a job whose worker died three times, the workers write 'degraded' when a
// film was delivered without a part that broke). Every 5 minutes this reads the rows not yet looked at and:
//   - emails the owner about each customer's final failure, lost job or delivery without a part, with the full reason,
//     the step, the attempt, the person, whether this person or anyone else hit the same code before, and whether that
//     code was marked fixed (then it is a REGRESSION);
//   - says nothing at the time about retries (a retry that then works is invisible to the person), failures that are the
//     person's own (a refused or unusable video), or our own accounts: they are in the daily summary.
// Once a day at 07:30 PT a summary of the last 24 hours (by tool and code, open classes, regressions) goes out and is
// kept as a failure_digest event. GET /api/studio/admin/failures?hours=24 (owner only) lists the rows.
// Off with STUDIO_FAILURE_WATCH=off. Never throws.
import type { Express } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isInternalEmail, isStudioAdmin } from "./studio-admin-auth.js";
import { ownerAlert } from "./vendor-alerts.js";
import { recordEvent } from "./studio-events.js";
import { THEIR_SIDE } from "./clips-watch.js";
import type { MailDeps } from "./studio-mail.js";

type Env = Record<string, string | undefined>;
const HOUR = 3_600_000;

/** Failures that are about the person's request or video, not our service: kept and summed, not emailed. */
export const THEIRS = new Set([...THEIR_SIDE, "recast_nsfw", "recast_rejected", "light_refused", "story_refused", "hand_refused", "kage_refused",
  "longform_refused", "longform_prompt", "longform_invalid", "canceled_by_owner", "stopped by the owner", "wrong_link_stopped_by_owner"]);

export type FailureRow = { id: number; at: string; job_id: string | null; user_id: string | null; tool: string | null; kind: string; code: string;
  detail: string | null; stage: string | null; attempt: number | null; fix_status: string; fix_note: string | null; alerted_at: string | null };
export type Who = { email: string | null; internal: boolean };
export type History = { thisPerson: number; everyone: number; fixed: FailureRow | null };

/** Which new rows are emailed now. Pure. */
export function worthEmail(r: FailureRow, who: Who): boolean {
  if (who.internal) return false;
  if (r.kind === "retry") return false;
  if (THEIRS.has(r.code)) return false;
  return true;
}

const one = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const label = (r: FailureRow) => (r.kind === "degraded" ? "delivered without a part" : r.kind === "lost" ? "lost (the worker died 3 times)" : "failed");

/** The email for the new customer rows of one look. Pure. */
export function failureEmail(rows: { r: FailureRow; who: Who; h: History }[], appUrl = "https://app.clone8.io"): { subject: string; text: string } {
  const regress = rows.filter((x) => x.h.fixed);
  const tools = [...new Set(rows.map((x) => `${x.r.tool ?? "?"} ${x.r.code}`))].slice(0, 3).join(", ");
  const subject = `${regress.length ? "REGRESSION: " : ""}Clone8: ${rows.length} customer ${rows.length === 1 ? "problem" : "problems"} (${tools})`;
  const blocks = rows.map(({ r, who, h }) => [
    `${(r.tool ?? "?").toUpperCase()} · ${r.code} · ${label(r)}`,
    `When: ${new Date(r.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT · step: ${r.stage ?? "?"} · attempt ${r.attempt ?? "?"}`,
    `Who: ${who.email ?? r.user_id ?? "?"} · job ${r.job_id ?? "?"}`,
    `Why: ${one(r.detail, 900) || "(no detail was sent)"}`,
    `Before: ${h.thisPerson ? `${h.thisPerson} time(s) for this person` : "first time for this person"}, ${h.everyone} time(s) for anyone in 30 days`,
    h.fixed ? `REGRESSION: "${r.code}" was marked fixed${h.fixed.fix_note ? ` (${one(h.fixed.fix_note, 200)})` : ""} and happened again.` : "",
    r.kind === "degraded" ? "The video was delivered; only the part named above was left out." : "The person's credits were refunded.",
  ].filter(Boolean).join("\n"));
  return { subject, text: `${blocks.join("\n\n")}\n\nAll failures: ${appUrl}/#studio/admin (or GET /api/studio/admin/failures?hours=24)\nMark a code fixed: update studio_failures set fix_status='fixed', fix_note='<what fixed it>' where code='<code>';` };
}

/** The day's summary. Pure. */
export function failureDigest(rows: FailureRow[], internal: Set<string>, hours = 24): { subject: string; text: string; counts: Record<string, number> } {
  const cust = rows.filter((r) => !r.user_id || !internal.has(r.user_id));
  const by = new Map<string, { n: number; people: Set<string>; kinds: Set<string>; theirs: boolean; open: boolean }>();
  for (const r of cust) {
    const k = `${r.tool ?? "?"} · ${r.code}`; const v = by.get(k) ?? { n: 0, people: new Set(), kinds: new Set(), theirs: THEIRS.has(r.code), open: true };
    v.n++; if (r.user_id) v.people.add(r.user_id); v.kinds.add(r.kind); if (r.fix_status !== "open") v.open = false; by.set(k, v);
  }
  const counts = { rows: cust.length, failed: cust.filter((r) => r.kind === "failed").length, lost: cust.filter((r) => r.kind === "lost").length,
    degraded: cust.filter((r) => r.kind === "degraded").length, retries: cust.filter((r) => r.kind === "retry").length, ours_internal: rows.length - cust.length };
  const lines = [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `- ${k}: ${v.n} (${[...v.kinds].join("/")}, ${v.people.size} people)${v.theirs ? " · their side" : v.open ? " · OPEN" : " · marked fixed"}`);
  const subject = `Clone8 failures, last ${hours} h: ${counts.failed} failed, ${counts.lost} lost, ${counts.degraded} delivered without a part, ${counts.retries} retries`;
  const text = cust.length ? `Customers only (our own accounts: ${counts.ours_internal} rows, not listed).\n\n${lines.join("\n")}` : `No customer failures in the last ${hours} hours. Our own accounts: ${counts.ours_internal} rows.`;
  return { subject, text, counts };
}

async function emailsOf(sb: SupabaseClient, ids: string[], env: Env): Promise<Map<string, Who>> {
  const out = new Map<string, Who>();
  for (const id of ids.slice(0, 200)) {
    const g = await (sb as any).auth?.admin?.getUserById?.(id).catch(() => null);
    const email: string | null = g?.data?.user?.email ?? null;
    out.set(id, { email, internal: !!email && isInternalEmail(email, env) });
  }
  return out;
}

export function digestDue(now: number): { due: boolean; day: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { due: Number(get("hour")) * 60 + Number(get("minute")) >= 7 * 60 + 30, day: `${get("year")}-${get("month")}-${get("day")}` };
}

/** One look: the rows not yet looked at, emailed or not, then marked. Exported for tests. */
export async function failureTick(sb: SupabaseClient, deps: MailDeps & { now?: () => number } = {}): Promise<{ looked: number; emailed: number }> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = (deps.now ?? Date.now)();
  const fresh = await sb.from("studio_failures").select("*").is("alerted_at", null).order("at").limit(200);
  if (fresh.error) throw fresh.error;
  const rows = (fresh.data ?? []) as FailureRow[]; if (!rows.length) return { looked: 0, emailed: 0 };
  const who = await emailsOf(sb, [...new Set(rows.map((r) => r.user_id).filter(Boolean) as string[])], env);
  const send: { r: FailureRow; who: Who; h: History }[] = [];
  for (const r of rows) {
    const w = (r.user_id && who.get(r.user_id)) || { email: null, internal: false };
    if (!worthEmail(r, w)) continue;
    const since = new Date(now - 30 * 24 * HOUR).toISOString();
    const past = await sb.from("studio_failures").select("id,user_id,fix_status,fix_note,at").eq("code", r.code).neq("kind", "retry").gte("at", since).lt("id", r.id).order("id", { ascending: false }).limit(500);
    const p = (past.data ?? []) as FailureRow[];
    const fixed = await sb.from("studio_failures").select("*").eq("code", r.code).eq("fix_status", "fixed").lt("id", r.id).order("id", { ascending: false }).limit(1);
    send.push({ r, who: w, h: { thisPerson: p.filter((x) => x.user_id === r.user_id).length, everyone: p.length, fixed: ((fixed.data ?? [])[0] as FailureRow) ?? null } });
  }
  if (send.length) {
    const m = failureEmail(send, env.STUDIO_APP_URL || "https://app.clone8.io");
    log(`[failure-watch] ${m.subject}`);
    // (a key per look, so each look's problems are one email; ownerAlert's hourly limit is per key)
    await ownerAlert(`failures_${rows[rows.length - 1].id}`, m.subject, m.text, HOUR, { ...deps, env, log });
  }
  const up = await sb.from("studio_failures").update({ alerted_at: new Date(now).toISOString() }).in("id", rows.map((r) => r.id));
  if (up.error) log(`[failure-watch] could not mark ${rows.length} rows: ${up.error.message}`);
  return { looked: rows.length, emailed: send.length };
}

export function startFailureWatch(sbFn: () => SupabaseClient, deps: MailDeps & { now?: () => number; everyMs?: number } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l)), now = deps.now ?? Date.now;
  if (env.STUDIO_FAILURE_WATCH === "off") return null;
  let lastDigest = "";
  const tick = async () => {
    const sb = sbFn();
    await failureTick(sb, { ...deps, env, log, now });
    const d = digestDue(now());
    if (d.due && lastDigest !== d.day) {
      lastDigest = d.day;
      const had = await sb.from("studio_events").select("id").eq("name", "failure_digest").eq("props->>day", d.day).limit(1);
      if (!had.error && !(had.data ?? []).length) {
        const day = await sb.from("studio_failures").select("*").gte("at", new Date(now() - 24 * HOUR).toISOString()).order("at").limit(2000);
        if (day.error) throw day.error;
        const list = (day.data ?? []) as FailureRow[];
        const who = await emailsOf(sb, [...new Set(list.map((r) => r.user_id).filter(Boolean) as string[])], env);
        const internal = new Set([...who.entries()].filter(([, w]) => w.internal).map(([id]) => id));
        const m = failureDigest(list, internal);
        recordEvent({ kind: "feature", name: "failure_digest", props: { day: d.day, ...m.counts } });
        await ownerAlert(`failure_digest_${d.day}`, m.subject, m.text, 24 * HOUR, { ...deps, env, log });
      }
    }
  };
  const run = () => { void tick().catch((e) => log(`[failure-watch] ${String(e?.message ?? e).slice(0, 160)}`)); };
  const timer = setInterval(run, deps.everyMs ?? 5 * 60_000);
  timer.unref?.();
  return timer;
}

export function registerFailures(app: Express, sbFn: () => SupabaseClient, deps: { env?: Env } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/studio/admin/failures", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const sb = sbFn();
      if (!(await isStudioAdmin(req, sb, env))) return res.status(404).json({ error: "not_found" });
      const hours = Math.min(24 * 30, Math.max(1, Math.round(Number(req.query.hours ?? 24)) || 24));
      const r = await sb.from("studio_failures").select("*").gte("at", new Date(Date.now() - hours * HOUR).toISOString()).order("at", { ascending: false }).limit(1000);
      if (r.error) throw r.error;
      res.json({ hours, failures: r.data ?? [] });
    } catch (e: any) {
      console.log(`[admin] failures: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "admin_failed" });
    }
  });
}
