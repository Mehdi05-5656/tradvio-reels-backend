// The bot itself: what happens to each incoming message, in order (PLAN.md section 1). Pairing and the stranger rule,
// rate limits, the gate words, the YES, then the brain; and the watcher that sends results when a job finishes.
// Everything outside (Telegram, Clone8, Claude, the clock, the disk) is handed in, so the same code runs against the
// real services, a typed-in chat on this Mac, and the tests.
import { randomBytes } from "node:crypto";
import type { Api } from "./clone8.js";
import type { Config } from "./config.js";
import { claim, classify, decline, dropUnshown, expire, markShown, addSpend, howToAnswer, withdraw, type Pending } from "./gate.js";
import { execute, today } from "./actions.js";
import { toolName } from "./account.js";
import { blanked } from "./guard.js";
import type { ChatState, Transport, TurnResult } from "./brain.js";

export type BotState = { owner: string | null; pair_code: string | null; offset: number; chats: Record<string, ChatState>; strangers: Record<string, { day: string; n: number }>; rate: Record<string, number[]> };
export const emptyState = (): BotState => ({ owner: null, pair_code: null, offset: 0, chats: {}, strangers: {}, rate: {} });
export type Msg = { chat: string; from: string; text: string; private: boolean; tap?: boolean; has_file?: boolean };
export type BotDeps = {
  cfg: Config; api: Api; out: Transport; state: BotState; save: () => void; now?: () => number;
  think: (st: ChatState, text: string, o?: { tap?: boolean }) => Promise<TurnResult>;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** dropped after an action so the next lookup reads the account fresh */
  forget?: () => void;
};

export const HELP = [
  "I'm Clone8 in your texts. Tell me what you want to make, post or check, in your own words.",
  "I ask before anything is posted, changed or costs credits: you answer YES with the code I give.",
  "NO leaves things as they are. STOP ends my messages, RESUME brings them back.",
  "Plans, payments and linking accounts are in the app: https://app.clone8.io",
].join("\n");
const PRIVATE_LINE = "This is a private Clone8 test. Connect your own account in the app: https://app.clone8.io";
const PER_5_MIN = 20, PER_DAY = 200;
/** A name or title from the account inside a system note: quoted, on one line, so it reads as material. */
const q = (v: unknown) => JSON.stringify(String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80));

export function chatOf(state: BotState, chat: string): ChatState {
  return (state.chats[chat] ??= { chat, history: [], table: [], notes: [], pending: { live: null, past: [] }, watches: [] });
}
export function pairCode(state: BotState): string { return (state.pair_code ??= randomBytes(9).toString("base64url")); }

export function makeBot(d: BotDeps) {
  const now = () => (d.now ?? Date.now)();
  const say = async (st: ChatState, text: string, buttons?: Array<{ label: string; data: string }>, own?: string[]) => { if (!text.trim()) return; st.history.push({ role: "assistant", text, at: now() }); await d.out.text(st.chat, text, buttons, own); };
  const note = (st: ChatState, text: string) => { st.history.push({ role: "event", text, at: now() }); if (st.history.length > 80) st.history = st.history.slice(-60); };
  /** Something the person should hear about: sent now, or kept for when they say RESUME. */
  const tell = async (st: ChatState, text: string, own?: string[]) => { if (st.muted) { st.missed = [...(st.missed ?? []), text].slice(-10); return; } await d.out.text(st.chat, text, undefined, own); };

  const ask = async (st: ChatState, p: Pending) => {
    // a question the person could not read in full must not be answerable: if the wording check would blank it, it is dropped
    const hit = blanked(p.question, p.own);
    if (hit) { decline(st.pending); d.log("pending_unsafe", { id: p.id, hit }); await say(st, "I couldn't set that one up from here. Start it in the app: https://app.clone8.io"); return; }
    // a large action has no Yes button (its count must be typed)
    await d.out.text(st.chat, p.question, p.count == null ? [{ label: "Yes, go ahead", data: `y:${p.id}` }, { label: "No", data: `n:${p.id}` }] : [{ label: "No", data: `n:${p.id}` }], p.own);
    // only now, with the question in the chat, can a reply release it
    markShown(st.pending, p.id);
    // the brain sees that a question is waiting and what it says, but not its code: it has no reason to repeat or reword it
    note(st, `The system asked the person to confirm (the code is in their chat, not here): ${p.question.split("\n").slice(0, -1).join(" / ")}`);
    d.log("pending", { id: p.id, kind: p.kind, code: p.code, credits: p.credits, posts: p.posts, question: p.question, steps: p.steps.map((s) => ({ method: s.method, path: s.path, body: s.body })) });
    d.save();
  };

  async function release(st: ChatState, p: Pending, by: string) {
    d.log("confirmed", { id: p.id, by });
    // on disk as claimed BEFORE anything is sent: if this process stops mid-call, a second YES cannot run it again
    d.save();
    let out: Awaited<ReturnType<typeof execute>>;
    try { out = await busy(st, () => execute(d.api, p, { now: now(), timezone: d.cfg.timezone })); }
    catch (e: any) {
      // no answer is not a "no": it may have gone through. Say so, and never try it again on our own.
      p.status = "failed"; d.log("execute_unconfirmed", { id: p.id, detail: String(e?.message ?? e).slice(0, 200) });
      note(st, `Could not confirm whether this went through (no answer): ${p.question.split("\n")[0]}. It was not retried.`);
      d.forget?.();
      await say(st, "I didn't get an answer back, so I can't tell whether that went through. Check the app before asking me again; I won't retry it on my own.");
      return;
    }
    p.status = out.ok ? "done" : "failed";
    d.log("executed", { id: p.id, ok: out.ok, calls: out.calls, job_id: out.job_id ?? null, post_ids: out.post_ids ?? null, credits: out.credits ?? 0 });
    if (out.ok && p.credits) st.spend = addSpend(st.spend, today(now(), d.cfg.timezone), out.credits ?? p.credits);
    if (out.ok && out.project) st.watches.push({ project: out.project, label: `the edit of ${q(out.project.name)}`, started: now(), sent: [] as string[] });
    if (out.ok && out.job_id) st.watches.push({ job_id: out.job_id, collection_id: out.collection_id ?? null, label: p.meta?.summary ?? "your run", tool: p.meta?.tool ?? "", started: now(), sent: [] as string[] });
    note(st, `${out.ok ? "Done after the person's YES" : "Not done"}: ${p.question.split("\n")[0]} → ${out.text}${out.job_id ? ` (job ${out.job_id})` : ""}${out.post_ids?.length ? ` (posts ${out.post_ids.map((x) => `p:${x}`).join(", ")})` : ""}`);
    d.forget?.();
    await say(st, out.text, undefined, p.own);
  }

  /** One incoming message, start to finish. Never throws. */
  async function handle(m: Msg): Promise<void> {
    const s = d.state, t = now();
    let st: ChatState | null = null;
    try {
      if (!m.private) return; // one-to-one only; silent in groups
      const gate = classify(m.text);
      // pairing: the first chat that sends the code printed on this Mac becomes the owner's
      if (!s.owner && gate.kind === "start" && gate.code && gate.code === s.pair_code) { s.owner = m.from; s.pair_code = null; d.log("paired", { from: m.from }); await say(chatOf(s, m.chat), `Connected. ${HELP}`); return; }
      if (m.from !== s.owner) {
        const day = new Date(t).toISOString().slice(0, 10), k = s.strangers[m.from];
        const n = k && k.day === day ? k.n : 0;
        s.strangers[m.from] = { day, n: n + 1 };
        d.log("stranger", { from: m.from, n: n + 1 });
        if (n < 3) await d.out.text(m.chat, PRIVATE_LINE);
        return;
      }
      st = chatOf(s, m.chat);
      const hits = (s.rate[m.from] ?? []).filter((x) => t - x < 86400_000);
      if (hits.filter((x) => t - x < 5 * 60_000).length >= PER_5_MIN || hits.length >= PER_DAY) { s.rate[m.from] = hits; d.log("rate_limited", { from: m.from }); await d.out.text(m.chat, "That's a lot of messages at once. Give me a few minutes."); return; }
      s.rate[m.from] = [...hits, t];
      d.log("in", { from: m.from, text: m.text.slice(0, 2000), tap: !!m.tap });
      // a question that never reached the chat (the turn that made it broke) is gone before anything can answer it
      const lost = dropUnshown(st.pending); if (lost) d.log("pending_never_shown", { id: lost.id });
      const gone = expire(st.pending, t); if (gone) d.log("pending_expired", { id: gone.id });

      // taps on buttons
      const tap = m.tap ? m.text.match(/^(y|n|pick):(.+)$/) : null;
      if (tap) {
        if (tap[1] === "pick") { const row = st.table.find((x) => String(x.n) === tap[2]); if (!row) { await d.out.text(m.chat, "That list is no longer the current one. Ask me again."); return; } return await talk(st, `I pick number ${row.n}: ${row.label}`, true); }
        if (tap[1] === "n") { const p = st.pending.live?.id === tap[2] ? decline(st.pending) : null; if (p) { d.log("declined", { id: p.id }); note(st, `The person said no to: ${p.question.split("\n")[0]}`); } await say(st, p ? "Okay, left as it was." : "That one is no longer waiting."); return; }
        const r = claim(st.pending, { id: tap[2] }, t);
        if (r.ok) return await release(st, r.pending, "tap");
        await say(st, r.why === "need_count" && r.pending ? `This one is large. ${howToAnswer(r.pending)}` : r.why === "expired" ? "That question ran out of time (10 minutes). Ask me again and I'll set it up." : "That one is no longer waiting. Ask me again if you still want it.");
        return;
      }
      if (m.tap) return; // a tap that is none of ours
      if (!m.text.trim()) { await d.out.text(m.chat, m.has_file ? "I can't take files sent in the chat yet. Send me a link to the video, or tell me which one in your library." : "I can read text and links for now."); return; }
      if (gate.kind === "start" || gate.kind === "help") { await say(st, HELP); return; }
      if (gate.kind === "stop" || gate.kind === "pause") { st.muted = true; d.log("muted", { from: m.from }); await d.out.text(m.chat, gate.kind === "stop" ? "Okay. I won't message you until you say RESUME. Nothing that is running was cancelled." : "Quiet until you say RESUME. Your runs keep going."); return; }
      if (gate.kind === "resume") { st.muted = false; const missed = st.missed ?? []; st.missed = []; await say(st, missed.length ? `I'm back. While I was quiet:\n${missed.join("\n")}` : "I'm back. What do you need?"); return; }
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
      return await talk(st, m.has_file ? `${m.text}\n(the person attached a file; files sent in the chat cannot be taken in yet, only links)` : m.text);
    } catch (e: any) {
      d.log("error", { detail: String(e?.message ?? e).slice(0, 300) });
      // whatever the broken turn prepared was never shown, so it must not stay answerable
      if (st) { const lost = dropUnshown(st.pending); if (lost) d.log("pending_never_shown", { id: lost.id }); }
      const signIn = /not_signed_in|sign_in_expired/.test(String(e?.code ?? e?.message ?? ""));
      await d.out.text(m.chat, signIn ? "I've lost my sign-in to your Clone8 account. Run the login step on the Mac again." : "Something went wrong on my side, and nothing was changed. Try again in a moment, or use the app: https://app.clone8.io").catch(() => undefined);
    } finally { d.save(); }
  }

  /** Keeps "typing…" showing for as long as the work takes (Telegram drops it after a few seconds), so a slow answer
   *  (a video being fetched and sent can take a minute) never looks like silence. */
  async function busy<T>(st: ChatState, work: () => Promise<T>): Promise<T> {
    void d.out.typing(st.chat).catch(() => undefined);
    const beat = setInterval(() => { void d.out.typing(st.chat).catch(() => undefined); }, 4000);
    try { return await work(); } finally { clearInterval(beat); }
  }

  async function talk(st: ChatState, text: string, tap = false): Promise<void> {
    const t = now();
    // anything said while a question waits moves the talk on: the question is withdrawn before the AI reads the message
    const old = withdraw(st.pending);
    if (old) { d.log("pending_withdrawn", { id: old.id }); note(st, `The question that was waiting (${old.question.split("\n")[0]}) was withdrawn because the person wrote something else. Nothing was done.`); }
    const r = await busy(st, () => d.think(st, text, { tap }));
    st.history.push({ role: "user", text, at: t, ...(tap ? { tap: true } : {}) });
    if (r.sent?.length) for (const x of r.sent) note(st, `Sent to the person: ${x}`);
    d.log("turn", { usd: Math.round(r.usd * 1e4) / 1e4, rounds: r.rounds, pending: r.pending?.id ?? null });
    // what the person typed and what is on the table are theirs: quoting them back is not a leak
    const own = [text, ...st.table.map((x) => x.label)];
    if (r.text) await say(st, r.text, undefined, own);
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
          if (now() - w.started > 4 * 3600_000) { done(`Stopped watching ${q(w.label)} after 4 hours`); continue; }
          // an edit made by text: the clip is sent once the editor has made it again
          if (w.project) {
            const pr = await d.api.call("GET", `/api/studio/projects/${w.project.id}`);
            if (pr.status !== 200) continue;
            const pj = pr.json ?? {};
            if (pj.render_state === "error" || pj.render_state === "failed") { done(`The edit of ${q(w.project.name)} failed: ${q(pj.render_error ?? "no reason given")}`); await tell(st, `The edit of "${w.project.name}" didn't go through${pj.render_error ? `: ${String(pj.render_error).slice(0, 140)}` : ""}. Your clip is as it was.`, [w.project.name]); continue; }
            if (!(pj.render_state === "done" && Number(pj.rendered_rev) >= w.project.rev)) continue;
            done(`The edit of ${q(w.project.name)} is done [${w.project.asset_id ? `f:${w.project.asset_id}` : `r:${w.project.job_id}`}]`);
            if (st.muted) { st.missed = [...(st.missed ?? []), `Your edit of "${w.project.name}" is ready.`].slice(-10); continue; }
            const url = w.project.asset_id ? (await d.api.call("GET", `/api/studio/assets/${w.project.asset_id}/url`)).json?.url : ((await d.api.call("GET", `/api/studio/jobs/${w.project.job_id}`)).json?.job?.outputs ?? [])[0]?.url;
            const b = url ? await d.api.bytes(url, 48_000_000) : null;
            if (b) await d.out.media(st.chat, [{ kind: "video", bytes: b, name: "edited.mp4", caption: w.project.name }], "Here's the edited clip.", undefined, [w.project.name]);
            else await d.out.text(st.chat, `Your edit of "${w.project.name}" is done, but I couldn't send the file here. It's in your library: https://app.clone8.io/#studio/library`, undefined, [w.project.name]);
            continue;
          }
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
              const title = String(first.probe?.title ?? first.name ?? "Clip").replace(/\s+/g, " ").slice(0, 80);
              note(st, `The first clip of this run is ready and was sent to the person: ${q(title)} [f:${first.id}]`);
              if (b) await d.out.media(st.chat, [{ kind: "video", bytes: b, name: "clip.mp4", caption: `First clip: ${title}` }], undefined, undefined, [title]); else await d.out.text(st.chat, `The first clip is ready: "${title}". It's in your library: https://app.clone8.io/#studio/library`, undefined, [title]);
            }
          }
          if (j.status === "queued" || j.status === "running") continue;
          if (j.status === "failed" || j.status === "canceled") { done(`${name} ${j.status}; credits returned`); await tell(st, j.status === "failed" ? `That ${name} didn't finish, and its credits came back. Want me to try it again?` : `That ${name} was cancelled; the credits are back.`); continue; }
          const outs: any[] = (j.outputs ?? []).filter((o: any) => o?.key);
          // some tools (Captions) put what they make straight into the library and list it on the run, not as outputs
          const made: any[] = (Array.isArray(j.progress?.made) ? j.progress.made : []).filter((m: any) => typeof m?.asset_id === "string" && /^[0-9a-f-]{36}$/i.test(m.asset_id) && !outs.some((o) => o.asset_id === m.asset_id));
          if (!outs.length && made.length) {
            const itemName = (src: string) => String((j.options?.items ?? []).find((x: any) => x?.asset_id === src)?.name ?? name).replace(/\.[a-z0-9]{2,4}$/i, "");
            const rows2 = made.slice(0, 10).map((m, i) => ({ n: i + 1, ref: `f:${m.asset_id}`, label: `${itemName(m.source)}${j.tool === "captions" ? " (captions)" : ""}`.replace(/\s+/g, " ").slice(0, 80) }));
            st.table = rows2;
            done(`${name} finished: ${made.length} new library file(s) ${rows2.map((x) => `[${x.ref}] ${q(x.label)}`).join("; ")} (job ${j.id})`);
            if (st.muted) { st.missed = [...(st.missed ?? []), `Your ${name} is ready. Ask me to send it.`].slice(-10); continue; }
            const media2 = [] as Array<{ kind: "photo" | "video"; bytes: Buffer; name: string; caption?: string }>;
            for (const row of rows2.slice(0, 2)) { const u = await d.api.call("GET", `/api/studio/assets/${row.ref.slice(2)}/url`); const b = u.json?.url ? await d.api.bytes(u.json.url, 48_000_000) : null; if (b) media2.push({ kind: "video", bytes: b, name: "result.mp4", caption: row.label }); else d.log("send_failed", { asset: row.ref, why: u.json?.url ? "too large or unreadable" : `no link (${u.status})` }); }
            const own2 = rows2.map((x) => x.label);
            if (media2.length) await d.out.media(st.chat, media2, `Your ${name} is ready.${made.length > media2.length ? ` ${made.length} files in all; the rest are in your library.` : ""}`, undefined, own2);
            else await d.out.text(st.chat, `Your ${name} is ready, but I couldn't send the file here. It's in your library: https://app.clone8.io/#studio/library`, undefined, own2);
            continue;
          }
          if (w.collection_id) {
            const c = await d.api.call("GET", `/api/studio/collections/${w.collection_id}`);
            const clips: any[] = (c.json?.assets ?? []).filter((a: any) => a.kind === "video" && a.status === "ready");
            const rows = clips.slice(0, 10).map((a, i) => ({ n: i + 1, ref: `f:${a.id}`, label: String(a.probe?.title ?? a.name).replace(/\s+/g, " ").slice(0, 80) }));
            st.table = rows;
            done(`${name} finished: ${clips.length} clips in collection c:${w.collection_id}, best first: ${rows.map((x) => `${x.n}. ${q(x.label)} [${x.ref}]`).join("; ")}`);
            await tell(st, clips.length ? `${clips.length} clips are ready, best first:\n${rows.map((x) => `${x.n}. ${x.label}`).join("\n")}\nWant any of them posted, captioned or sent here?` : "That run finished without a clip that was good enough.", rows.map((x) => x.label));
            continue;
          }
          const rows = outs.slice(0, 10).map((o, i) => ({ n: i + 1, ref: outs.length > 1 ? `r:${j.id}:${i + 1}` : `r:${j.id}`, label: String(o.title ?? `${name}${outs.length > 1 ? ` ${i + 1}` : ""}`).replace(/\s+/g, " ").slice(0, 80) }));
          st.table = rows;
          done(`${name} finished: ${outs.length} result(s) ${rows.map((x) => `[${x.ref}] ${q(x.label)}`).join("; ")} (job ${j.id})`);
          if (st.muted) { st.missed = [...(st.missed ?? []), `Your ${name} is ready. Ask me to send it.`].slice(-10); continue; }
          const videos = outs.filter((o) => /\.(mp4|mov|webm)$/i.test(o.key) || o.kind === "video").slice(0, 2), pictures = outs.filter((o) => /\.(jpe?g|png|webp)$/i.test(o.key) || o.kind === "image").slice(0, 4);
          const media = [] as Array<{ kind: "photo" | "video"; bytes: Buffer; name: string; caption?: string }>;
          for (const o of videos) { const b = o.url ? await d.api.bytes(o.url, 48_000_000) : null; if (b) media.push({ kind: "video", bytes: b, name: "result.mp4", caption: String(o.title ?? name).slice(0, 80) }); }
          for (const o of pictures) { const b = o.url ? await d.api.bytes(o.url, 9_000_000) : null; if (b) media.push({ kind: "photo", bytes: b, name: "result.jpg" }); }
          const own = rows.map((x) => x.label);
          if (media.length) await d.out.media(st.chat, media, `Your ${name} is ready.${outs.length > media.length ? ` ${outs.length} files in all; the rest are in the app.` : ""}`, undefined, own);
          else await d.out.text(st.chat, `Your ${name} is ready, but I couldn't send the file here. It's in the app: https://app.clone8.io`);
        } catch (e: any) { d.log("watch_error", { job: w.job_id, detail: String(e?.message ?? e).slice(0, 200) }); }
      }
    }
    d.save();
  }
  return { handle, watch };
}
