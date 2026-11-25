// The weekly look at how the bot did, from its log: since Nov 24 2026 the server's (studio_text_events, every chat with
// every customer; read with the service key in ops/.env, never printed), or with --source mac the old Mac test bot's
// (ops/text-bot/audit.jsonl). For every message the person sent: what
// it cost, how long the answer took, and every sign that something went wrong (an error, a lookup that failed, a
// question the person never answered, "I didn't get that", a file that could not be sent, a name that was blocked).
// It writes a report a person or the weekly review run reads first, then the chats behind the flags.
// It also writes the whole conversation, chat by chat, next to the report (transcript-<date>.md).
// Run: node <bundle> [--days 7] [--source server|mac] [--out <file>]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";

type E = Record<string, any> & { at: string; event: string };
export type Turn = { at: string; text: string; tap: boolean; usd: number; calls: number; steps: number; seconds: number | null; replies: string[]; tools: string[]; flags: string[]; question: string | null; outcome: string | null };

const MISUNDERSTOOD = /I didn't get that|Could you say it another way|Something went wrong|can't share that/i;
const SLOW_S = 20, DEAR_USD = 0.01;

/** Splits the log into turns: one message from the person and everything until the next one. */
export function turnsOf(rows: E[]): Turn[] {
  const out: Turn[] = []; let cur: Turn | null = null; let pend: Record<string, Turn> = {};
  for (const e of rows) {
    if (e.event === "in") { cur = { at: e.at, text: String(e.text ?? ""), tap: !!e.tap, usd: 0, calls: 0, steps: 0, seconds: null, replies: [], tools: [], flags: [], question: null, outcome: null }; out.push(cur); continue; }
    if (!cur) continue;
    if (e.event === "claude") { cur.usd += Number(e.usd) || 0; cur.calls++; }
    else if (e.event === "turn") cur.steps = Number(e.rounds) || 0;
    else if (e.event === "out") { if (cur.seconds == null) cur.seconds = Math.round((Date.parse(e.at) - Date.parse(cur.at)) / 100) / 10; const t = String(e.text ?? "") + (e.media?.length ? ` <${e.media.length} file${e.media.length > 1 ? "s" : ""}>` : ""); cur.replies.push(t); if (MISUNDERSTOOD.test(t)) cur.flags.push(`said: "${t.slice(0, 60)}"`); }
    else if (e.event === "tool") { cur.tools.push(`${e.name}${e.input?.name ? `:${e.input.name}` : ""}`); if (e.error) cur.flags.push(`${e.name} failed: ${e.error}`); }
    else if (e.event === "pending") { cur.question = String(e.question ?? "").split("\n")[0]; pend[e.id] = cur; }
    else if (e.event === "executed") { const t = pend[e.id] ?? cur; t.outcome = e.ok ? "done" : "NOT done"; if (!e.ok) t.flags.push("action failed after YES"); }
    else if (e.event === "declined") { const t = pend[e.id] ?? cur; t.outcome = "said no"; }
    else if (e.event === "pending_expired") { const t = pend[e.id]; if (t) { t.outcome = "never answered"; t.flags.push("question left unanswered"); } }
    else if (["error", "claude_error", "watch_error", "execute_unconfirmed", "pending_never_shown", "pending_unsafe", "send_failed", "guard", "rate_limited"].includes(e.event)) cur.flags.push(`${e.event}${e.detail ? `: ${String(e.detail).slice(0, 80)}` : e.hit ? `: ${e.hit}` : ""}`);
  }
  for (const t of out) { if (t.seconds != null && t.seconds > SLOW_S) t.flags.push(`slow: ${t.seconds}s`); if (t.usd > DEAR_USD) t.flags.push(`dear: ${(t.usd * 100).toFixed(2)}¢`); if (!t.replies.length && !t.flags.length && !t.outcome) t.flags.push("no answer logged"); }
  return out;
}

export function report(turns: Turn[], days: number, chats = 1): string {
  const n = turns.length, usd = turns.reduce((a, t) => a + t.usd, 0), flagged = turns.filter((t) => t.flags.length);
  const secs = turns.map((t) => t.seconds).filter((x): x is number => x != null).sort((a, b) => a - b);
  const asked = turns.filter((t) => t.question), done = asked.filter((t) => t.outcome === "done").length, no = asked.filter((t) => t.outcome === "said no").length, left = asked.filter((t) => t.outcome === "never answered").length;
  const tools = new Map<string, number>(); for (const t of turns) for (const x of t.tools) tools.set(x, (tools.get(x) ?? 0) + 1);
  const L: string[] = [];
  L.push(`# Text Clone8: the last ${days} days`, "");
  L.push(`- Chats: ${chats} · Messages: ${n} (${turns.filter((t) => t.tap).length} were taps)`);
  L.push(`- AI cost: $${usd.toFixed(3)} in all, ${n ? ((usd / n) * 100).toFixed(3) : "0"}¢ a message${secs.length ? `; answers took ${secs[Math.floor(secs.length / 2)]}s typically, ${secs[secs.length - 1]}s at the slowest` : ""}`);
  L.push(`- Questions asked for a YES: ${asked.length} (done ${done}, said no ${no}, left unanswered ${left}, other ${asked.length - done - no - left})`);
  L.push(`- Messages with something to look at: ${flagged.length}`);
  L.push(`- Most used: ${[...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}`, "");
  if (flagged.length) {
    L.push("## To look at", "");
    for (const t of flagged) L.push(`- ${t.at.slice(0, 16).replace("T", " ")} UTC · "${t.text.slice(0, 90)}" → ${t.flags.join("; ")}${t.question ? ` · asked: ${t.question.slice(0, 70)} (${t.outcome ?? "open"})` : ""}`);
    L.push("");
  }
  L.push("## Every message", "");
  for (const t of turns) L.push(`- ${t.at.slice(5, 16).replace("T", " ")} · ${(t.usd * 100).toFixed(3)}¢ · ${t.seconds ?? "?"}s · "${t.text.slice(0, 80)}"${t.replies.length ? ` → "${t.replies[t.replies.length - 1].replace(/\s+/g, " ").slice(0, 100)}"` : ""}${t.flags.length ? ` ⚑ ${t.flags.length}` : ""}`);
  return L.join("\n") + "\n";
}

const PROJECT = "gzvxqzguthrpvjtflxcx"; // Tradvio Reels only

/** The server's log, oldest first, a page at a time (the service key comes from ops/.env and is never printed). */
async function serverRows(since: string): Promise<Array<E & { chat: string; user: string | null }>> {
  const envFile = join(dirname(loadConfig().home), ".env");
  const key = existsSync(envFile) ? (readFileSync(envFile, "utf8").match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']?([^"'\n]+)/m)?.[1] ?? "").trim() : "";
  if (!key) throw new Error(`No SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  const out: Array<E & { chat: string; user: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const url = `https://${PROJECT}.supabase.co/rest/v1/studio_text_events?select=at,event,chat_id,user_id,data&at=gte.${encodeURIComponent(since)}&order=at.asc,id.asc`;
    const r = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}`, range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`log read failed: HTTP ${r.status}`);
    const rows: any[] = await r.json();
    for (const x of rows) out.push({ ...(x.data ?? {}), at: x.at, event: x.event, chat: String(x.chat_id ?? "none"), user: x.user_id ?? null });
    if (rows.length < 1000) break;
  }
  return out;
}

/** Every chat, start to finish, as it read on the phone. */
export function transcript(rows: Array<E & { chat: string; user?: string | null }>): string {
  const by = new Map<string, typeof rows>(); for (const e of rows) { const k = e.chat ?? "none"; if (!by.has(k)) by.set(k, []); by.get(k)!.push(e); }
  const L: string[] = [];
  let n = 0;
  for (const [chat, es] of by) {
    if (!es.some((e) => e.event === "in" || e.event === "out")) continue;
    L.push(`## Chat ${++n} (account ${String(es.find((e) => e.user)?.user ?? "?").slice(0, 8)}…, Telegram ${chat})`, "");
    for (const e of es) {
      const t = e.at.slice(5, 16).replace("T", " ");
      if (e.event === "in") L.push(`**${t} person:** ${String(e.text ?? "").replace(/^y:.*/, "(tapped Yes)").replace(/^n:.*/, "(tapped No)")}`);
      else if (e.event === "out") L.push(`${t} bot: ${String(e.text ?? "").replace(/\n+/g, " / ")}${e.media?.length ? ` <${e.media.length} file${e.media.length > 1 ? "s" : ""}>` : ""}`);
      else if (["executed", "declined", "pending_expired", "error", "claude_error", "send_failed", "watch_error", "execute_unconfirmed", "guard"].includes(e.event)) L.push(`   · ${e.event}${e.ok === false ? " (NOT done)" : ""}${e.detail ? `: ${String(e.detail).slice(0, 120)}` : ""}`);
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2), val = (f: string, d: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const days = Number(val("--days", "7")) || 7, home = loadConfig().home, source = val("--source", "server");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let text: string, script = "";
  if (source === "mac") {
    const file = join(home, "audit.jsonl");
    if (!existsSync(file)) { console.log("No log yet."); return; }
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e: E | null): e is E => !!e && e.mode === "telegram" && e.at >= since);
    text = report(turnsOf(rows), days);
  } else {
    const rows = await serverRows(since);
    const chats = [...new Set(rows.map((r) => r.chat))];
    const turns = chats.flatMap((c) => turnsOf(rows.filter((r) => r.chat === c))).sort((x, y) => x.at.localeCompare(y.at));
    text = report(turns, days, chats.filter((c) => rows.some((r) => r.chat === c && r.event === "in")).length);
    script = transcript(rows);
  }
  const dir = join(home, "reviews"); if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const out = val("--out", join(dir, `review-${day}.md`));
  writeFileSync(out, text, { mode: 0o600 });
  if (script) writeFileSync(join(dir, `transcript-${day}.md`), `# Text Clone8: every chat, the last ${days} days\n\n${script}`, { mode: 0o600 });
  console.log(text.split("## Every message")[0].trim());
  console.log(`\nSaved: ${out}${script ? `\nTranscript: ${join(dir, `transcript-${day}.md`)}` : ""}`);
}
if (process.argv[1] && /review/.test(process.argv[1])) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
