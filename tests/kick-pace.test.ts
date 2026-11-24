import test from "node:test";
import assert from "node:assert/strict";
import { kickChatReplay, kickWeb, resetKickPace, KICK_CHAT_RETRIES, KICK_PACE } from "../src/live-sources.js";

const ok = (body: unknown) => ({ code: 0, so: `${JSON.stringify(body)}\n200`, se: "" });
const status = (n: number) => ({ code: 0, so: `{}\n${n}`, se: "" });
const start = "2026-11-22T10:00:00.000Z";
const msg = (id: string, sec: number) => ({ id, created_at: new Date(Date.parse(start) + sec * 1000).toISOString(), content: "W", sender: { id: "u" + id } });

test("a 429 from Kick while reading the chat is waited out and the read goes on (Nov 22 2026 run 7e51d9ce)", async () => {
  resetKickPace();
  let calls = 0; const waits: number[] = [];
  const deps: any = { sleep: async (ms: number) => { waits.push(ms); }, kickCurl: async () => { calls++; if (calls <= 2) return status(429); return ok({ data: { messages: calls === 3 ? [msg("a", 5), msg("b", 30)] : [] } }); } };
  const chat = await kickChatReplay(deps, "123", start, 60, { slices: 1 });
  assert.deepEqual(chat.map((m) => m.t), [5, 30], "the messages after the refusals are read");
  assert.ok(waits.some((w) => w >= 2000), "it waited before trying again");
});

test("a Kick that keeps refusing stops the read with a clear reason, after the retries", async () => {
  resetKickPace();
  let calls = 0;
  const deps: any = { sleep: async () => undefined, kickCurl: async () => { calls++; return status(429); } };
  await assert.rejects(kickChatReplay(deps, "123", start, 60, { slices: 1 }), (e: any) => e.code === "kick_busy" && /slow down/.test(e.message));
  assert.equal(calls, (KICK_CHAT_RETRIES + 1) * KICK_PACE.tries, "each read point is tried by the reader, each call rides out its own 429s first");
});

test("Kick calls are spaced out: one starts at a time, a gap apart, wider after a 429", async () => {
  resetKickPace();
  const starts: number[] = [];
  const deps: any = { kickCurl: async () => { starts.push(Date.now()); return ok({ ok: 1 }); } };
  await Promise.all(Array.from({ length: 5 }, (_, i) => kickWeb(deps, `x/${i}`)));
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.every((g) => g >= KICK_PACE.gap_ms - 15), `gaps ${gaps.join(",")}`);
  // a 429: the next call waits out the cool-down
  resetKickPace();
  let n = 0; const waits: number[] = []; const deps2: any = { sleep: async (ms: number) => { waits.push(ms); }, kickCurl: async () => (++n <= 2 ? status(429) : ok({ ok: 1 })) };
  assert.deepEqual(await kickWeb(deps2, "a"), { ok: 1 }, "a lookup rides out two 429s by itself");
  assert.ok(waits.some((w) => w >= KICK_PACE.cool_ms - 50), "and waited the cool-down before trying again");
  let m = 0; const deps3: any = { sleep: async () => undefined, kickCurl: async () => { m++; return status(429); } };
  await assert.rejects(kickWeb(deps3, "b"), (e: any) => e.code === "kick_busy" && e.retry === true);
  assert.equal(m, KICK_PACE.tries);
  resetKickPace();
});

test("an EMPTY page from Kick while the read is still inside the stream is waited out, not taken as the chat's start (Nov 23 2026)", async () => {
  resetKickPace();
  let calls = 0; const waits: number[] = [];
  // newest first: a page at 50 s, then two empty answers, then the page at 20 s, then the real start (empty below 0)
  const pages = [[msg("c", 50)], [], [], [msg("b", 20)], []];
  const deps: any = { sleep: async (ms: number) => { waits.push(ms); }, kickCurl: async () => ok({ data: { messages: pages[Math.min(calls++, pages.length - 1)] } }) };
  const chat = await kickChatReplay(deps, "123", start, 60, { slices: 1 });
  assert.deepEqual(chat.map((m) => m.t), [20, 50], "the older page after the empty answers is read");
  assert.ok(waits.length >= 2);
});
