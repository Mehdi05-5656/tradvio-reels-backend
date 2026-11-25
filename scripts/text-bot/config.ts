// Text Clone8, local test (docs/text-bot/PLAN.md, section 10). Settings and files for the test bot that runs on the
// owner's Mac. Secrets and state live OUTSIDE the repository, in TEXT_BOT_HOME (ops/text-bot), never in git.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/** KEY=VALUE lines of a file; missing file is an empty set. Values are never logged. */
export function readEnvFile(path: string): Env {
  if (!existsSync(path)) return {};
  const out: Env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    // quotes around a value, and the literal "\n" some tools leave at the end of one, are not part of it
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").replace(/(\\n)+$/, "").trim();
  }
  return out;
}

export type Config = {
  home: string; apiBase: string; supabaseUrl: string; supabaseAnon: string; anthropicKey: string; telegramToken: string;
  model: string; dailyCredits: number; maxActionCredits: number; timezone: string;
  /** how hard the AI thinks before it answers: low is the cheapest and quickest, and enough for chat */
  effort: string;
};

export function loadConfig(env: Env = process.env): Config {
  const home = env.TEXT_BOT_HOME || join(process.cwd(), "ops", "text-bot");
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const own = readEnvFile(join(home, ".env"));
  const ops = readEnvFile(join(home, "..", ".env"));
  const app = readEnvFile(env.TEXT_BOT_APP_ENV || join(home, "..", "..", "tradvio-reels-v2", ".env.local"));
  const pick = (...v: Array<string | undefined>) => v.find((x) => x && x.trim())?.trim() ?? "";
  return {
    home,
    apiBase: pick(env.CLONE8_API_BASE, own.CLONE8_API_BASE, app.VITE_API_BASE, "https://tradvio-reels-backend.onrender.com").replace(/\/+$/, ""),
    supabaseUrl: pick(env.SUPABASE_URL, own.SUPABASE_URL, app.VITE_SUPABASE_URL).replace(/\/+$/, ""),
    supabaseAnon: pick(env.SUPABASE_ANON_KEY, own.SUPABASE_ANON_KEY, app.VITE_SUPABASE_ANON_KEY),
    anthropicKey: pick(env.ANTHROPIC_API_KEY, own.ANTHROPIC_API_KEY, ops.ANTHROPIC_API_KEY),
    telegramToken: pick(env.TELEGRAM_BOT_TOKEN, own.TELEGRAM_BOT_TOKEN),
    // chosen by measurement (scripts/text-bot/eval.ts, Nov 24 2026): on 22 requests run three times this model got 71 of
    // 72 right at about 0.05 cents a message; the next two up got the same answers for 20 and 40 times the price
    model: pick(env.TEXT_BOT_MODEL, own.TEXT_BOT_MODEL, "claude-haiku-5-5"),
    dailyCredits: Math.max(0, Number(pick(env.TEXT_BOT_DAILY_CREDITS, own.TEXT_BOT_DAILY_CREDITS, "300")) || 0),
    maxActionCredits: Math.max(0, Number(pick(env.TEXT_BOT_MAX_ACTION_CREDITS, own.TEXT_BOT_MAX_ACTION_CREDITS, "300")) || 0),
    timezone: pick(env.TEXT_BOT_TZ, own.TEXT_BOT_TZ, Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC"),
    effort: ["low", "medium", "high"].includes(pick(env.TEXT_BOT_EFFORT, own.TEXT_BOT_EFFORT)) ? pick(env.TEXT_BOT_EFFORT, own.TEXT_BOT_EFFORT) : "low",
  };
}

/** A small JSON file written whole and atomically (temp file, then rename), private to the user. */
export function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback; } catch { return fallback; }
}
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

/** The audit log: one line per step, appended, never rewritten (PLAN.md section 5). */
export function audit(home: string, event: string, data: Record<string, unknown> = {}): void {
  try { appendFileSync(join(home, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n", { mode: 0o600 }); } catch { /* never breaks a turn */ }
}
