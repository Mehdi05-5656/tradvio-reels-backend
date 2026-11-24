// Changing the schedule in plain words (owner, Nov 23 2026; docs/publishing/SCHEDULE_AI_STORAGE_PLAN.md).
//
// The person types what they want ("move everything on Tuesday to 6 pm", "cancel the pool ones", "space them 3 hours
// apart from tomorrow 9am"). Claude reads only the posts in view (numbered, with their times in the person's zone) and
// answers with changes: move, cancel, new caption. Nothing changes here: the page shows every change first and applies
// the ones the person keeps through the same routes as the manual edits.
//
// Checked here, never trusted from the model: only posts in view and still waiting; times readable, at least 6
// minutes ahead and within 90 days; every account kept 30+ minutes from its other posts (a time that would clash is
// moved later in 30-minute steps, and the change says so).
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logClaudeCost } from "./studio-pricing.js";

const UUID = /^[0-9a-f-]{36}$/i;
const GAP = 30 * 60_000, LEAD = 6 * 60_000, AHEAD = 90 * 86400_000;
const PER_HOUR = 60;
const hits = new Map<string, number[]>();
const allow = (u: string, now = Date.now()) => { const r = (hits.get(u) ?? []).filter((t) => now - t < 3600_000); if (r.length >= PER_HOUR) { hits.set(u, r); return false; } r.push(now); hits.set(u, r); return true; };

export class ScheduleAiError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** Wall-clock parts of an instant in a zone. */
function parts(t: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { y: +g("year"), m: +g("month"), d: +g("day"), h: +g("hour"), min: +g("minute"), wd: g("weekday") };
}
/** "YYYY-MM-DD HH:MM" in `tz` as an instant (a time skipped by daylight saving lands just after the jump). */
export function zonedToUtc(local: string, tz: string): number | null {
  const m = String(local).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = (t: number) => { const p = parts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t; };
  const wall = (t: number) => { const p = parts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min); };
  // the offsets either side of the day; a time that exists matches one of them, a skipped one (spring forward) does not
  const a = want - off(want - 86400_000), b = want - off(want + 86400_000);
  const hit = [a, b].filter((t) => wall(t) === want).sort((x, y) => x - y)[0];
  const t = hit ?? Math.max(a, b);
  return Number.isFinite(t) ? t : null;
}
export const localLabel = (t: number, tz: string) => { const p = parts(t, tz); return `${p.wd} ${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`; };
const validTz = (tz: unknown) => { try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return String(tz); } catch { return "UTC"; } };

type Post = { id: string; schedule_at: string | null; status: string; caption: string; platforms: string[]; options: any };
export type Change = { post_id: string; action: "move" | "cancel" | "caption"; from?: string | null; schedule_at?: string; caption?: string; note?: string };

/** Each account's other posts, so a moved time keeps 30+ minutes from them (all of the person's waiting posts). */
const accountsOf = (p: Post): string[] => { const a = (Array.isArray(p.options?.accounts) ? p.options.accounts : []).map((x: any) => x?.id || x?.platform).filter(Boolean); return a.length ? a : p.platforms; };
/** Each account of a post with its own time (accounts can post at different times), shifted by `delta`. */
const timesOf = (p: Post, delta = 0): Array<[string, number]> => {
  const base = Date.parse(p.schedule_at ?? ""), list = Array.isArray(p.options?.accounts) ? p.options.accounts : [];
  if (!list.length) return p.platforms.map((x) => [x, base + delta]);
  return list.map((x: any) => [String(x?.id || x?.platform), (x?.at ? Date.parse(x.at) : base) + delta] as [string, number]).filter(([, t]: [string, number]) => Number.isFinite(t));
};

/** Keep every account 30+ minutes from its other posts: a clashing move goes later in 30-minute steps. */
export function spaceOut(moves: Array<{ post: Post; at: number }>, others: Post[], now: number, gap = GAP): Array<{ post: Post; at: number; nudged: number }> {
  const taken = new Map<string, number[]>();
  const moved = new Set(moves.map((m) => m.post.id));
  for (const o of others) if (!moved.has(o.id) && o.schedule_at) for (const [a, t] of timesOf(o)) taken.set(a, [...(taken.get(a) ?? []), t]);
  const out: Array<{ post: Post; at: number; nudged: number }> = [];
  for (const m of [...moves].sort((a, b) => a.at - b.at)) {
    const base = Date.parse(m.post.schedule_at ?? "") || m.at;
    let at = m.at, steps = 0;
    const clash = () => timesOf(m.post, at - base).some(([a, t]) => (taken.get(a) ?? []).some((x) => Math.abs(x - t) < gap));
    while (steps < 48 && clash()) { at += gap; steps++; }
    for (const [a, t] of timesOf(m.post, at - base)) taken.set(a, [...(taken.get(a) ?? []), t]);
    out.push({ post: m.post, at, nudged: at - m.at });
  }
  void now;
  return out;
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "changes", "unclear"],
  properties: {
    summary: { type: "string", description: "One short sentence saying what will change, in plain words" },
    changes: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "action", "when", "caption"], properties: {
      n: { type: "integer", description: "The post's number in the list" },
      action: { type: "string", enum: ["move", "cancel", "caption"] },
      when: { anyOf: [{ type: "string" }, { type: "null" }], description: "For move: the new local time 'YYYY-MM-DD HH:MM' (24 h) in the person's time zone; null otherwise" },
      caption: { anyOf: [{ type: "string" }, { type: "null" }], description: "For caption: the full new caption; null otherwise" } } } },
    unclear: { type: "array", items: { type: "string" }, description: "What was asked that cannot be done here, or is ambiguous, in a few words each" },
  },
};
const SYSTEM = `You change a creator's posting schedule from what they say. You get their scheduled posts, numbered, with each post's local time, weekday, account and the start of its caption, plus today's date and their time zone.
Answer only with changes to posts in the list: move (a new local time), cancel, or caption (a full new caption).
- Be literal and careful with dates: weekdays and dates must match the list's calendar. "Tomorrow", "Tuesday", "next week" are relative to today in their zone. Keep the minutes unless they say otherwise.
- "Push back / shift by" moves from each post's current time. "Space them N hours apart" keeps their order. "No posts on Sunday" moves Sunday's posts to the next day at the same time (unless they say where).
- Only touch the posts they mean. If it is ambiguous which posts they mean, change nothing and say so in "unclear".
- Never invent a caption they did not ask for; when asked to edit a caption, keep everything they did not ask to change (hashtags, call to action).
- Times must be in the future. Never move a post more than 90 days ahead.`;

export function registerScheduleAi(app: Express, sbFn: () => SupabaseClient, deps: { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void; ask?: (body: any) => Promise<any> } = {}) {
  const env = deps.env ?? process.env, f = deps.fetch ?? fetch, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? (req.auth as any).user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof ScheduleAiError) return res.status(e.status).json({ error: e.code, detail: e.message });
    console.error("[schedule-ai]", String(e?.message ?? e));
    res.status(500).json({ error: "schedule_ai_failed", detail: "Something went wrong on our side; try again in a moment" });
  };

  app.post("/api/studio/social/schedule/ai", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const b = req.body ?? {}, now = Date.now();
      const text = String(b.text ?? "").trim().slice(0, 1000);
      if (!text) throw new ScheduleAiError("nothing_said", "Say what to change");
      const tz = validTz(b.timezone);
      const ids = [...new Set((Array.isArray(b.post_ids) ? b.post_ids : []).map(String).filter((x: string) => UUID.test(x)))].slice(0, 200) as string[];
      if (!ids.length) throw new ScheduleAiError("no_posts", "There are no scheduled posts in view");
      if (!env.ANTHROPIC_API_KEY && !deps.ask) throw new ScheduleAiError("ai_off", "This is not switched on yet", 503);
      if (!allow(u, now)) throw new ScheduleAiError("rate_limited", "That is a lot of changes for one hour; try again soon", 429);
      const sb = sbFn();
      const c = await sb.from("studio_customers").select("status,owner_pass").eq("user_id", u).maybeSingle();
      if (!(c.data && (["active", "trialing"].includes((c.data as any).status) || (c.data as any).owner_pass))) throw new ScheduleAiError("subscription_required", "Changing the schedule this way comes with a plan", 409);
      const all = await sb.from("studio_social_posts").select("id,schedule_at,status,caption,platforms,options").eq("user_id", u).in("status", ["scheduled", "queued", "sending"]).limit(2000);
      if (all.error) throw all.error;
      const waiting = (all.data ?? []) as Post[];
      const inView = waiting.filter((p) => ids.includes(p.id) && p.schedule_at && p.status !== "sending").sort((a, b2) => Date.parse(a.schedule_at!) - Date.parse(b2.schedule_at!));
      if (!inView.length) throw new ScheduleAiError("no_posts", "None of these posts can still be changed");
      const who = (p: Post) => accountsOf(p).length ? (Array.isArray(p.options?.accounts) ? p.options.accounts.map((a: any) => `${a?.username ? `@${String(a.username).replace(/^@/, "")}` : ""} ${a?.platform ?? ""}`.trim()).join(", ") : p.platforms.join(", ")) : p.platforms.join(", ");
      // whole captions (a caption edit keeps everything it was not asked to change), as JSON strings so line breaks survive
      const list = inView.map((p, i) => `${i + 1}. ${localLabel(Date.parse(p.schedule_at!), tz)} · ${who(p)} · caption ${JSON.stringify(String(p.caption ?? "").slice(0, 2500))}`).join("\n");
      const today = parts(now, tz);
      const prompt = `Today is ${localLabel(now, tz)} (${tz}).\nTheir scheduled posts:\n${list}\n\nWhat they want: """${text}"""`;
      let out: any;
      if (deps.ask) out = await deps.ask({ system: SYSTEM, prompt, schema: SCHEMA });
      else {
        const model = env.STUDIO_SCHEDULE_AI_MODEL || "claude-sonnet-5-5";
        const r = await f("https://api.anthropic.com/v1/messages", {
          method: "POST", redirect: "error",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" },
          body: JSON.stringify({ model, max_tokens: 6000, system: SYSTEM, fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }),
          signal: AbortSignal.timeout(90_000),
        }).catch(() => { throw new ScheduleAiError("ai_unavailable", "The assistant did not answer; try again", 503); });
        if (!r.ok) { log(`[schedule-ai] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); throw new ScheduleAiError("ai_unavailable", "The assistant did not answer; try again", 503); }
        const body: any = await r.json();
        logClaudeCost(log, "schedule_ai", String(body?.model ?? model), body?.usage, u);
        try { out = JSON.parse((body?.content ?? []).find((x: any) => x?.type === "text")?.text ?? ""); } catch { throw new ScheduleAiError("ai_unavailable", "The answer came back unreadable; try again", 502); }
      }
      void today;
      // checked, never trusted: only posts in the list, readable future times, one change of each kind per post
      const problems: string[] = [];
      const moves: Array<{ post: Post; at: number }> = [], other: Change[] = [];
      const seen = new Set<string>();
      for (const c of Array.isArray(out?.changes) ? out.changes : []) {
        const p = inView[Number(c?.n) - 1];
        if (!p) continue;
        const k = `${p.id}:${c.action}`;
        if (seen.has(k)) continue; seen.add(k);
        if (c.action === "cancel") other.push({ post_id: p.id, action: "cancel", from: p.schedule_at });
        else if (c.action === "caption") {
          const cap = String(c.caption ?? "").trim().slice(0, 5000);
          const own = (Array.isArray(p.options?.accounts) ? p.options.accounts : []).some((a: any) => a?.own && a?.caption);
          if (own) { problems.push(`post ${c.n}: each account has its own caption; change those one by one`); continue; }
          if (cap && cap !== String(p.caption ?? "").trim()) other.push({ post_id: p.id, action: "caption", from: p.schedule_at, caption: cap });
        } else if (c.action === "move") {
          const at = zonedToUtc(String(c.when ?? ""), tz);
          if (at == null) { problems.push(`post ${c.n}: the new time was not readable`); continue; }
          if (at < now + LEAD) { problems.push(`post ${c.n}: ${localLabel(at, tz).slice(4)} has passed or is too soon, so it stays as it is`); continue; }
          if (at > now + AHEAD) { problems.push(`post ${c.n}: more than 90 days ahead`); continue; }
          if (Math.abs(at - Date.parse(p.schedule_at!)) < 60_000) continue;
          moves.push({ post: p, at });
        }
      }
      const cancelled = new Set(other.filter((c) => c.action === "cancel").map((c) => c.post_id));
      const spaced = spaceOut(moves.filter((m) => !cancelled.has(m.post.id)), waiting.filter((w) => !cancelled.has(w.id)), now);
      const changes: Change[] = [
        ...spaced.map((m) => ({ post_id: m.post.id, action: "move" as const, from: m.post.schedule_at, schedule_at: new Date(m.at).toISOString(), ...(m.nudged ? { note: `moved ${Math.round(m.nudged / 60_000)} min later to keep 30 min from another post on the same account` } : {}) })),
        ...other.filter((c) => !(c.action === "caption" && cancelled.has(c.post_id))),
      ];
      res.json({ summary: String(out?.summary ?? "").slice(0, 300), changes, unclear: [...(Array.isArray(out?.unclear) ? out.unclear.map((x: any) => String(x).slice(0, 160)) : []), ...problems].slice(0, 8) });
    } catch (e) { fail(res, e); }
  });
}
