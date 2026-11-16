// Alerts to the owner when a paid service Clone8 depends on runs dry (Nov 16 2026). ScrapeCreators' credits ran out at
// 04:01 PT that day; every pasted YouTube link in Clips failed with "listing could not be read (402)" and the live
// stats cron logged "credits_exhausted" every 15 minutes, and nobody knew until the owner hit it 8 hours later.
//
// ScrapeCreators reports the balance left on its answers (`credits_remaining`), so every call it already answers is
// a free reading: below SCRAPECREATORS_LOW_CREDITS (default 2,000, about 3 days at mid-November use) one email a day;
// a 402 (out) or 401 (the key refused) one email every 6 hours. Most ScrapeCreators callers (live stats, imports, the
// performance page, the assistant) do not report here, so every hour that Clips has not had an answer, the watch asks
// the balance route itself (1 credit a call per its docs: at most 24 a day). The emails go to STUDIO_ALERT_EMAIL, or
// support@clone8.io. Off without RESEND_API_KEY (the send is a logged no-op). Never throws.
import { sendMail, SUPPORT_EMAIL, type MailDeps } from "./studio-mail.js";

type Env = Record<string, string | undefined>;
const sent = new Map<string, number>();
const HOUR = 3_600_000;

/** One email to the owner per `key` per `everyMs` (kept in memory: a restart may send one more). */
export async function ownerAlert(key: string, subject: string, text: string, everyMs: number, deps: MailDeps & { now?: () => number } = {}): Promise<boolean> {
  const now = (deps.now ?? Date.now)(), last = sent.get(key);
  if (last != null && now - last < everyMs) return false;
  sent.set(key, now);
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  log(`[alert] ${subject}`);
  try { await sendMail({ to: env.STUDIO_ALERT_EMAIL || SUPPORT_EMAIL, subject, text, kind: "owner_alert" }, deps); return true; }
  catch (e: any) { log(`[alert] not sent: ${String(e?.message ?? e).slice(0, 120)}`); return false; }
}
export function resetAlertsForTests() { sent.clear(); lastSeen = 0; lastBalance = null; }

let lastSeen = 0;
let lastBalance: number | null = null;
/** The balance last read (null before any answer said it). */
export const scrapeCreatorsBalance = () => lastBalance;
export const lowCreditsLine = (env: Env) => { const n = Number(env.SCRAPECREATORS_LOW_CREDITS); return Number.isFinite(n) && n >= 0 ? n : 2000; };

/** Called with every ScrapeCreators answer (its HTTP status, and the parsed body when there is one). */
export function noteScrapeCreators(status: number, body: any, deps: MailDeps & { now?: () => number; where?: string } = {}): void {
  const env = deps.env ?? process.env, where = deps.where ?? "a call";
  if (status > 0) lastSeen = (deps.now ?? Date.now)();
  if (status === 402) {
    void ownerAlert("scrapecreators_out", "ScrapeCreators credits have run out",
      `ScrapeCreators answered 402 (no credits left) to ${where}.\n\nUntil it is topped up: Clips reads pasted YouTube links through yt-dlp instead (slower, through the proxy), the live stats and the leader refresh stop, and account imports fail.\n\nTop up in the ScrapeCreators dashboard. This email repeats every 6 hours while it lasts.`, 6 * HOUR, deps);
    return;
  }
  if (status === 401) {
    void ownerAlert("scrapecreators_key", "ScrapeCreators refused our API key",
      `ScrapeCreators answered 401 (the key was refused) to ${where}. Check SCRAPECREATORS_API_KEY on the Render services. This email repeats every 6 hours while it lasts.`, 6 * HOUR, deps);
    return;
  }
  const left = Number(body?.credits_remaining);
  if (status >= 200 && status < 300 && Number.isFinite(left)) {
    lastBalance = left;
    const line = lowCreditsLine(env);
    if (left < line) void ownerAlert("scrapecreators_low", `ScrapeCreators credits are low (${Math.round(left).toLocaleString("en-US")} left)`,
      `ScrapeCreators has ${Math.round(left).toLocaleString("en-US")} credits left (the alert line is ${line.toLocaleString("en-US")}).\n\nWhen they run out, Clips falls back to slower link reads, and the live stats, leader refresh and account imports stop. Top up in the ScrapeCreators dashboard. This email repeats once a day while the balance is under the line.`, 24 * HOUR, deps);
  }
}

/** Every hour: unless a Clips call was answered in the last 50 minutes, ask the balance route (1 credit). Off without a key. */
export function startScrapeCreatorsWatch(deps: MailDeps & { now?: () => number } = {}): ReturnType<typeof setInterval> | null {
  const env = deps.env ?? process.env;
  if (!env.SCRAPECREATORS_API_KEY || env.SCRAPECREATORS_WATCH === "off") return null;
  const tick = async () => {
    if ((deps.now ?? Date.now)() - lastSeen < 50 * 60_000) return;
    const r = await (deps.fetch ?? fetch)("https://api.scrapecreators.com/v1/account/credit-balance", { headers: { "x-api-key": env.SCRAPECREATORS_API_KEY!, accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r) return;
    noteScrapeCreators(r.status, await r.json().catch(() => null), { ...deps, where: "the balance check" });
  };
  const t = setInterval(() => { void tick().catch(() => undefined); }, HOUR);
  t.unref?.();
  setTimeout(() => { void tick().catch(() => undefined); }, 60_000).unref?.();
  return t;
}
