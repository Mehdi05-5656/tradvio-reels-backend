// Starts the test bot on this Mac (PLAN.md section 10). Three ways to run it:
//   (default)        Telegram: pulls messages for the bot in ops/text-bot/.env, as the owner signed in by login.sh
//   --sim            a chat typed in this terminal instead of Telegram (same brain, same Clone8 account)
//   --sim --mock     the same, against a pretend account: nothing real is read or changed
// Add --say "text" (repeatable) to send lines without typing. No deploy, no webhook, no production change.
import { createInterface } from "node:readline";
import { join } from "node:path";
import { audit, loadConfig, readJson, writeJson } from "./config.js";
import { makeApi } from "./clone8.js";
import { mockApi } from "./mock.js";
import { emptyState, makeBot, pairCode, type BotState } from "../../src/text-bot/bot.js";
import { think, type BrainDeps, type Transport } from "../../src/text-bot/brain.js";
import { telegram } from "../../src/text-bot/telegram.js";
import { guard } from "../../src/text-bot/guard.js";
import type { Index } from "../../src/text-bot/account.js";

const args = process.argv.slice(2), has = (f: string) => args.includes(f);
const says = args.flatMap((a, i) => (a === "--say" && args[i + 1] ? [args[i + 1]] : []));

async function main() {
  const cfg = loadConfig();
  const sim = has("--sim"), mock = has("--mock");
  const stateFile = join(cfg.home, sim ? (mock ? "state-mock.json" : "state-sim.json") : "state.json");
  const state: BotState = { ...emptyState(), ...readJson<Partial<BotState>>(stateFile, {}) };
  if (has("--fresh")) Object.assign(state, emptyState());
  const save = () => writeJson(stateFile, state);
  const log = (event: string, data: Record<string, unknown> = {}) => { audit(cfg.home, event, { mode: sim ? (mock ? "mock" : "sim") : "telegram", ...data }); if (has("--verbose") || event === "error" || event === "claude_error") console.error(`  [${event}] ${JSON.stringify(data).slice(0, 300)}`); };
  if (!cfg.anthropicKey) throw new Error("No ANTHROPIC_API_KEY found (ops/.env or ops/text-bot/.env)");
  const api = mock ? mockApi() : makeApi(cfg, { onCall: (e) => log("route", e) });
  const index: { current: Index | null } = { current: null };

  let out: Transport, tg: ReturnType<typeof telegram> | null = null;
  if (sim) {
    const show = (text: string, own?: string[]) => { const g = guard(text, own); if (g.hit) log("guard", { hit: g.hit }); return g.text; };
    out = {
      async text(_c, text, buttons, own) { console.log(`\nCLONE8: ${show(text, own)}${buttons?.length ? `\n        [${buttons.map((b) => b.label).join("] [")}]` : ""}`); },
      async media(_c, items, caption, buttons, own) { console.log(`\nCLONE8: ${caption ? `${show(caption, own)}\n` : ""}${items.map((m) => `        <${m.kind} ${Math.round(m.bytes.length / 1024)} KB> ${show(m.caption ?? "", own)}`).join("\n")}${buttons?.length ? `\n        [${buttons.map((b) => b.label).join("] [")}]` : ""}`); },
      async typing() { /* nothing to show */ },
    };
    state.owner = "sim";
  } else {
    if (!cfg.telegramToken) throw new Error("No TELEGRAM_BOT_TOKEN yet. Run ops/text-bot/set-telegram-token.sh");
    tg = telegram(cfg.telegramToken, { onGuard: (hit) => log("guard", { hit }) });
    out = tg.out;
  }
  // every message that leaves is logged as it was sent (after the wording check), so the whole chat can be read back
  const raw = out;
  out = {
    async text(c, text, buttons, own) { await raw.text(c, text, buttons, own); log("out", { text: guard(text, own).text.slice(0, 4000), ...(buttons?.length ? { buttons: buttons.map((b) => b.label) } : {}) }); },
    async media(c, items, caption, buttons, own) { await raw.media(c, items, caption, buttons, own); log("out", { ...(caption ? { text: guard(caption, own).text.slice(0, 1000) } : {}), media: items.map((m) => `${m.kind}: ${guard(m.caption ?? "", own).text.slice(0, 120)}`), ...(buttons?.length ? { buttons: buttons.map((b) => b.label) } : {}) }); },
    typing: (c) => raw.typing(c),
  };
  const brain: BrainDeps = { cfg, api, out, index, log };
  const bot = makeBot({ cfg, api, out, state, save, log, think: (st, text, o) => think(brain, st, text, o), forget: () => { index.current = null; brain.basics = null; } });
  console.error(`Text Clone8 test · model ${cfg.model} · ${mock ? "pretend account" : `Clone8 at ${cfg.apiBase}`} · by text today ${cfg.dailyCredits} credits, ${cfg.maxActionCredits} an action · time zone ${cfg.timezone}`);

  if (sim) {
    const say = async (text: string) => { console.log(`\nYOU: ${text}`); await bot.handle({ chat: "sim", from: "sim", text, private: true, tap: /^(y|n|pick):/.test(text) }); };
    for (const s of says) await say(s);
    if (says.length) { save(); return; }
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nYOU: " });
    rl.prompt();
    for await (const line of rl) { if (line.trim()) await bot.handle({ chat: "sim", from: "sim", text: line.trim(), private: true, tap: /^(y|n|pick):/.test(line.trim()) }); rl.prompt(); }
    return;
  }

  const me = await tg!.me();
  if (!state.owner) console.error(`\nOpen this on your phone to connect the bot to you (only the first chat that opens it is accepted):\n  https://t.me/${me.username}?start=${pairCode(state)}\n`);
  else console.error(`Connected to your Telegram. Bot @${me.username}. Ctrl-C stops it.`);
  save();
  // one thing at a time: messages in order, and the look at running jobs in between, never during a message
  let looked = 0;
  for (;;) {
    if (Date.now() - looked > 20_000) { looked = Date.now(); await bot.watch(); }
    let batch: Awaited<ReturnType<NonNullable<typeof tg>["updates"]>> = [];
    try { batch = await tg!.updates(state.offset); } catch (e: any) { log("poll_error", { detail: String(e?.message ?? e).slice(0, 160) }); await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const u of batch) {
      state.offset = u.update_id + 1; save(); // saved first: a message is handled once, even if this process stops in the middle
      if (u.callback_id) { void tg!.answerTap(u.callback_id); if (u.message_id && /^(y|n):/.test(u.text)) void tg!.clearButtons(u.chat, u.message_id); }
      await bot.handle({ chat: u.chat, from: u.from, text: u.text, private: u.private, tap: !!u.callback_id, has_file: u.has_file });
    }
  }
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
