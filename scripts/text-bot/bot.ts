// The bot itself: what happens to each incoming message, in order (PLAN.md section 1). Pairing and the stranger rule,
// rate limits, the gate words, the YES, then the brain; and the watcher that sends results when a job finishes.
// Everything outside (Telegram, Clone8, Claude, the clock, the disk) is handed in, so the same code runs against the
// real services, a typed-in chat on this Mac, and the tests.
import { randomBytes } from "node:crypto";
import type { Api } from "./clone8.js";
import type { Config } from "./config.js";
import { claim, classify, decline, expire, addSpend, howToAnswer, type Pending } from "./gate.js";
import { execute, today } from "./actions.js";
import { toolName } from "./account.js";
import { guard } from "./guard.js";
import type { ChatState, Transport, TurnResult } from "./brain.js";

export type BotState = { owner: string | null; pair_code: string | null; offset: number; chats: Record<string, ChatState>; strangers: Record<string, { day: string; n: number }>; rate: Record<string, number[]> };
export const emptyState = (): BotState => ({ owner: null, pair_code: null, offset: 0, chats: {}, strangers: {}, rate: {} });
export type Msg = { chat: string; from: string; text: string; private: boolean; tap?: boolean; has_file?: boolean };
export type BotDeps = {
  cfg: Config; api: Api; out: Transport; state: BotState; save: () => void; now?: () => number;
  think: (st: ChatState, text: string) => Promise<TurnResult>;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** dropped after an action so the next lookup reads the account fresh */
  forget?: () => void;
};

export const HELP = [
  "I'm Clone8 in your texts. Tell me what you want to make, post or check, in your own words.",
  "I ask before anything is posted, changed or costs credits: you answer YES with the code I give.",
  "NO leaves things as they are. CANCEL drops what is waiting. STOP ends my messages, RESUME brings them back.",
  "Plans, payments and linking accounts are in the app: https://app.clone8.io",
].join("\n");
const PRIVATE_LINE = "This is a private Clone8 test. Connect your own account in the app: https://app.clone8.io";
const PER_5_MIN = 20, PER_DAY = 200;

export function chatOf(state: BotState, chat: string): ChatState {
  return (state.chats[chat] ??= { chat, history: [], table: [], notes: [], pending: { live: null, past: [] }, watches: [] });
}
export function pairCode(state: BotState): string { return (state.pair_code ??= randomBytes(9).toString("base64url")); }

export function makeBot(d: BotDeps) {
  const now = () => (d.now ?? Date.now)();
  const say = async (st: ChatState, text: string, buttons?: Array<{ label: string; data: string }>) => { if (!text.trim()) return; st.history.push({ role: "assistant", text, at: now() }); await d.out.text(st.chat, text, buttons); };
  const note = (st: ChatState, text: string) => { st.history.push({ role: "event", text, at: now() }); if (st.history.length > 80) st.history = st.history.slice(-60); };
  const ask = async (st: ChatState, p: Pending) => {
    // a question the person cannot read in full must not be answerable: if the wording check would blank it, it is dropped
    if (guard(p.question).hit) { decline(st.pending); d.log("pending_unsafe", { id: p.id, hit: guard(p.question).hit }); await say(st, "I couldn't set that one up from here. Start it in the app: https://app.clone8.io"); return; }
    // the question as code wrote it; a large action has no Yes button (its count must be typed)
    st.history.push({ role: "event", text: `The system asked the person to confirm (the code is in their chat, not here): ${p.question.split("\n").slice(0, -1).join(" / ")}`, at: now() });
    await d.out.text(st.chat, p.question, p.count == null ? [{ label: `Yes ${p.code}`, data: `y:${p.id}` }, { label: "No", data: `n:${p.id}` }] : [{ label: "No", data: `n:${p.id}` }]);
    d.log("pending", { id: p.id, kind: p.kind, code: p.code, credits: p.credits, posts: p.posts, question: p.question, steps: p.steps.map((s) => ({ method: s.method, path: s.path, body: s.body })) });
  };

  async function release(st: ChatState, p: Pending, by: string) {
    d.log("confirmed", { id: p.id, by });
    await d.out.typing(st.chat);
    const out = await execute(d.api, p, { now: now(), timezone: d.cfg.timezone });
    p.status = out.ok ? "done" : "failed";
    d.log("executed", { id: p.id, ok: out.ok, calls: out.calls, job_id: out.job_id ?? null, post_ids: out.post_ids ?? null, credits: out.credits ?? 0 });
    if (out.ok && p.credits) st.spend = addSpend(st.spend, today(now(), d.cfg.timezone), out.credits ?? p.credits);
    if (out.ok && out.job_id) st.watches.push({ job_id: out.job_id, collection_id: out.collection_id ?? null, label: p.meta?.summary ?? "your run", tool: p.meta?.tool ?? "", started: now(), sent: [] as string[] });
    note(st, `${out.ok ? "Done after the person's YES" : "Not done"}: ${p.question.split("\n")[0]} → ${out.text}${out.job_id ? ` (job ${out.job_id})` : ""}${out.post_ids?.length ? ` (posts ${out.post_ids.map((x) => `p:${x}`).join(", ")})` : ""}`);
    d.forget?.();
    await say(st, out.text);
  }

  /** One incoming message, start to finish. Never throws. */
  async function handle(m: Msg): Promise<void> {
    const s = d.state, t = now();
    try {
      if (!m.private) return; // one-to-one only; silent in groups
      const gate = classify(m.text);
      // pairing: the first chat that sends the code printed on this Mac becomes the owner's
      if (!s.owner) {
        if (gate.kind === "start" && gate.code && gate.code === s.pair_code) { s.owner = m.from; s.pair_code = null; d.log("paired", { from: m.from }); const st = chatOf(s, m.chat); await say(st, `Connected. ${HELP}`); return; }
      }
      if (m.from !== s.owner) {
        const day = new Date(t).toISOString().slice(0, 10), k = s.strangers[m.from];
        const n = k && k.day === day ? k.n : 0;
        s.strangers[m.from] = { day, n: n + 1 };
        d.log("stranger", { from: m.from, n: n + 1 });
        if (n < 3) await d.out.text(m.chat, PRIVATE_LINE);
        return;
      }
      const st = chatOf(s, m.chat);
      const hits = (s.rate[m.from] ?? []).filter((x) => t - x < 86400_000);
      if (hits.filter((x) => t - x < 5 * 60_000).length >= PER_5_MIN || hits.length >= PER_DAY) { s.rate[m.from] = hits; d.log("rate_limited", { from: m.from }); await d.out.text(m.chat, "That's a lot of messages at once. Give me a few minutes."); return; }
      s.rate[m.from] = [...hits, t];
      d.log("in", { from: m.from, text: m.text.slice(0, 2000), tap: !!m.tap });
      const gone = expire(st.pending, t);
      if (gone) d.log("pending_expired", { id: gone.id });

      // taps on buttons
      const tap = m.tap ? m.text.match(/^(y|n|pick):(.+)$/) : null;
      if (tap) {
        if (tap[1] === "pick") { const row = st.table.find((x) => String(x.n) === tap[2]); if (!row) { await d.out.text(m.chat, "That list is no longer the current one. Ask me again."); return; } return await talk(st, `I pick number ${row.n}: ${row.label}`); }
        if (tap[1] === "n") { const p = st.pending.live?.id === tap[2] ? decline(st.pending) : null; if (p) { d.log("declined", { id: p.id }); note(st, `The person said no to: ${p.question.split("\n")[0]}`); } await say(st, p ? "Okay, left as it was." : "That one is no longer waiting."); return; }
        const r = claim(st.pending, { id: tap[2] }, t);
        if (r.ok) return await release(st, r.pending, "tap");
        await say(st, r.why === "need_count" && r.pending ? `This one is large. ${howToAnswer(r.pending)}` : r.why === "expired" ? "That question ran out of time (10 minutes). Ask me again and I'll set it up." : "That one is no longer waiting. Ask me again if you still want it.");
        return;
      }
      if (gate.kind === "start") { await say(st, HELP); return; }
      if (gate.kind === "help") { await say(st, HELP); return; }
      if (gate.kind === "stop" || gate.kind === "pause") { st.muted = true; d.log("muted", { from: m.from }); await d.out.text(m.chat, gate.kind === "stop" ? "Okay. I won't message you until you say RESUME. Nothing that is running was cancelled." : "Quiet until you say RESUME. Your runs keep going."); return; }
      if (gate.kind === "resume") { st.muted = false; await say(st, "I'm back. What do you need?"); return; }
      if (gate.kind === "yes") {
        if (!st.pending.live) { if (gate.code) { await say(st, "Nothing is waiting for a YES right now."); return; } return await talk(st, m.text); }
        st.history.push({ role: "user", text: m.text, at: t });
        const r = claim(st.pending, { code: gate.code, count: gate.count }, t);
        if (r.ok) return await release(st, r.pending, "text");
        const p = r.pending;
        await say(st, r.why === "expired" ? "That question ran out of time (10 minutes). Ask me again and I'll set it up."
          : r.why === "no_code" && p ? `To be sure it's this one, include the code. ${howToAnswer(p)}`
          : r.why === "wrong_code" && p ? `That code doesn't match the question that is waiting. ${howToAnswer(p)}`
          : (r.why === "need_count" || r.why === "wrong_count") && p ? `This one is large, so the count goes with it. ${howToAnswer(p)}` : "Nothing is waiting for a YES right now.");
        return;
      }
      if ((gate.kind === "no" || gate.kind === "cancel") && st.pending.live) {
        st.history.push({ role: "user", text: m.text, at: t });
        const p = decline(st.pending)!; d.log("declined", { id: p.id }); note(st, `The person said no to: ${p.question.split("\n")[0]}`);
        await say(st, "Okay, left as it was."); return;
      }
      const text = m.has_file && !m.text ? "(the person sent a file with no words)" : m.has_file ? `${m.text}\n(the person attached a file; files sent in the chat cannot be taken in yet, only links)` : m.text;
      return await talk(st, text);
    } catch (e: any) {
      d.log("error", { detail: String(e?.message ?? e).slice(0, 300) });
      const signIn = /not_signed_in|sign_in_expired/.test(String(e?.code ?? e?.message ?? ""));
      await d.out.text(m.chat, signIn ? "I've lost my sign-in to your Clone8 account. Run the login step on the Mac again." : "Something went wrong on my side. Try again in a moment, or use the app: https://app.clone8.io").catch(() => undefined);
    } finally { d.save(); }
  }

  async function talk(st: ChatState, text: string): Promise<void> {
    const t = now();
    await d.out.typing(st.chat);
    const r = await d.think(st, text);
    st.history.push({ role: "user", text, at: t });
    d.log("turn", { usd: Math.round(r.usd * 1e4) / 1e4, rounds: r.rounds, pending: r.pending?.id ?? null });
    if (r.text) await say(st, r.text);
    if (r.pending && st.pending.live?.id === r.pending.id) await ask(st, r.pending);
    else if (!r.text) await say(st, "I didn't get that. Could you say it another way?");
    if (st.history.length > 80) st.history = st.history.slice(-60);
  }

  /** Looks at every job started from the chat: a first clip as soon as there is one, the result when it is done. */
  async function watch(): Promise<void> {
    for (const st of Object.values(d.state.chats)) {
      for (const w of [...st.watches]) {
        try {
          const done = (text: string) => { st.watches = st.watches.filter((x) => x !== w); note(st, text); };
          if (now() - w.started > 4 * 3600_000) { done(`Stopped watching ${w.label} after 4 hours`); continue; }
          const r = await d.api.call("GET", `/api/studio/jobs/${w.job_id}`);
          if (r.status !== 200) continue;
          const j = r.json.job, name = toolName(j);
          // clips land one by one: the first is sent as soon as it is there
          if (w.collection_id && !w.sent.length && !st.muted) {
            const c = await d.api.call("GET", `/api/studio/collections/${w.collection_id}`);
            const first = (c.json?.assets ?? []).find((a: any) => a.status === "ready" && a.kind === "video");
            if (first) {
              w.sent.push(first.id);
              const u = await d.api.call("GET", `/api/studio/assets/${first.id}/url`);
              const b = u.json?.url ? await d.api.bytes(u.json.url, 48_000_000) : null;
              const title = String(first.probe?.title ?? first.name ?? "Clip").slice(0, 80);
              st.table = [{ n: 1, ref: `f:${first.id}`, label: title }];
              note(st, `First clip of ${w.label} is ready and was sent: "${title}" [f:${first.id}]`);
              if (b) await d.out.media(st.chat, [{ kind: "video", bytes: b, name: "clip.mp4", caption: `First clip: ${title}` }]); else await d.out.text(st.chat, `The first clip is ready: "${title}". It's in your library: https://app.clone8.io/#studio/library`);
            }
          }
          if (j.status === "queued" || j.status === "running") continue;
          if (j.status === "failed" || j.status === "canceled") { done(`${name} ${j.status} (${j.error_code ?? "no reason given"}); credits returned`); if (!st.muted) await d.out.text(st.chat, j.status === "failed" ? `That ${name} didn't finish, and its credits came back. Want me to try it again?` : `That ${name} was cancelled; the credits are back.`); continue; }
          const outs: any[] = (j.outputs ?? []).filter((o: any) => o?.key);
          if (w.collection_id) {
            const c = await d.api.call("GET", `/api/studio/collections/${w.collection_id}`);
            const clips: any[] = (c.json?.assets ?? []).filter((a: any) => a.kind === "video" && a.status === "ready");
            st.table = clips.slice(0, 10).map((a, i) => ({ n: i + 1, ref: `f:${a.id}`, label: String(a.probe?.title ?? a.name).slice(0, 80) }));
            done(`${name} finished: ${clips.length} clips in collection c:${w.collection_id}, best first: ${st.table.map((x) => `${x.n}. ${x.label} [${x.ref}]`).join("; ")}`);
            if (!st.muted) await d.out.text(st.chat, clips.length ? `${clips.length} clips are ready, best first:\n${st.table.map((x) => `${x.n}. ${x.label}`).join("\n")}\nWant any of them posted, captioned or sent here?` : `That run finished without a clip that was good enough. ${c.json?.collection?.note ?? ""}`.trim());
            continue;
          }
          st.table = outs.slice(0, 10).map((o, i) => ({ n: i + 1, ref: outs.length > 1 ? `r:${j.id}:${i + 1}` : `r:${j.id}`, label: String(o.title ?? `${name}${outs.length > 1 ? ` ${i + 1}` : ""}`).slice(0, 80) }));
          done(`${name} finished: ${outs.length} result(s) ${st.table.map((x) => `[${x.ref}] ${x.label}`).join("; ")} (job ${j.id}; output keys ${outs.map((o) => o.key).join(", ")})`);
          if (st.muted) continue;
          const videos = outs.filter((o) => /\.(mp4|mov|webm)$/i.test(o.key) || o.kind === "video").slice(0, 2), pictures = outs.filter((o) => /\.(jpe?g|png|webp)$/i.test(o.key) || o.kind === "image").slice(0, 4);
          const media = [] as Array<{ kind: "photo" | "video"; bytes: Buffer; name: string; caption?: string }>;
          for (const o of videos) { const b = o.url ? await d.api.bytes(o.url, 48_000_000) : null; if (b) media.push({ kind: "video", bytes: b, name: "result.mp4", caption: String(o.title ?? name).slice(0, 80) }); }
          for (const o of pictures) { const b = o.url ? await d.api.bytes(o.url, 9_000_000) : null; if (b) media.push({ kind: "photo", bytes: b, name: "result.jpg" }); }
          if (media.length) await d.out.media(st.chat, media, `Your ${name} is ready.${outs.length > media.length ? ` ${outs.length} files in all; the rest are in the app.` : ""}`);
          else await d.out.text(st.chat, `Your ${name} is ready. It's too large to send here; it's in the app: https://app.clone8.io`);
        } catch (e: any) { d.log("watch_error", { job: w.job_id, detail: String(e?.message ?? e).slice(0, 200) }); }
      }
    }
    d.save();
  }
  return { handle, watch };
}
