// Twitch's chat replay read in full even when Twitch slows us down (Nov 23 2026: a paying customer's three runs of a
// channel with ~200 messages a minute read as 5 a minute and failed as "too quiet"; Twitch had answered pages empty).
import test from "node:test";
import assert from "node:assert/strict";
import { twitchChatReplay, type ChatReadReport } from "../src/live-sources.js";

/** A fake Twitch: one message a second from 0 to `len`; a page holds 5; an offset asks from that second, a cursor from
 *  the message after it. `misbehave` may answer a call empty or end a page early. */
function fakeTwitch(len: number, misbehave: (call: number, at: number) => "empty" | "cut" | null = () => null) {
  let calls = 0;
  const pageAt = (at: number) => {
    const n = calls++;
    const how = misbehave(n, at);
    if (how === "empty") return { edges: [], pageInfo: { hasNextPage: false } };
    const edges = [];
    for (let t = at; t < Math.min(len, at + 5); t++) edges.push({ cursor: `c${t + 1}`, node: { id: `m${t}`, contentOffsetSeconds: t, commenter: { id: `u${t % 7}` }, message: { fragments: [{ text: `hi ${t}` }] } } });
    return { edges, pageInfo: { hasNextPage: how === "cut" ? false : at + 5 < len } };
  };
  const answer = (body: string) => {
    const v = JSON.parse(body)[0].variables;
    const at = v.cursor ? Number(String(v.cursor).slice(1)) : Math.max(0, Math.floor(Number(v.contentOffsetSeconds)));
    return [{ data: { video: { comments: pageAt(at) } } }];
  };
  const fetch = (async (_u: any, init: any) => new Response(JSON.stringify(answer(String(init.body))), { status: 200 })) as typeof globalThis.fetch;
  return { fetch, answer, calls: () => calls };
}
const noWait = async () => undefined;

test("a plain read: every message once, in order", async () => {
  const tw = fakeTwitch(120);
  const msgs = await twitchChatReplay({ env: {}, fetch: tw.fetch, sleep: noWait }, "v1", 120, { slices: 2 });
  assert.equal(msgs.length, 120);
  assert.deepEqual(msgs.map((m) => m.t), Array.from({ length: 120 }, (_, i) => i));
});

test("Twitch answering pages EMPTY mid-stream is waited out and asked again, never taken as the end of the chat", async () => {
  // every page answers empty the first time it is asked (Twitch slowing us down), in full when asked again: the old
  // reader stopped at the first empty page and called a busy chat quiet
  const asked = new Set<number>();
  const tw = fakeTwitch(300, (_n, at) => { if (asked.has(at)) return null; asked.add(at); return "empty"; });
  let r: ChatReadReport | null = null;
  const waits: number[] = [];
  const msgs = await twitchChatReplay({ env: {}, fetch: tw.fetch, sleep: async (ms) => { waits.push(ms); } }, "v2", 300, { slices: 3, report: (x) => { r = x; } });
  assert.equal(msgs.length, 300, "the whole chat");
  assert.ok(r!.empty_answers > 0 && waits.length > 0, "the empty answers were waited out");
});

test("a stretch Twitch says is over too early is asked again by time and read to its end", async () => {
  // the page at second 40 says "no next page" although the chat goes on
  const tw = fakeTwitch(200, (_n, at) => (at === 40 ? "cut" : null));
  let r: ChatReadReport | null = null;
  const msgs = await twitchChatReplay({ env: {}, fetch: tw.fetch, sleep: noWait }, "v3", 200, { slices: 1, report: (x) => { r = x; } });
  assert.equal(msgs.length, 200);
  assert.ok(r!.reseeks >= 1 && r!.found_after_end > 0);
});

test("the end of the recording is empty and ends the read without waiting", async () => {
  const tw = fakeTwitch(50);
  const waits: number[] = [];
  const msgs = await twitchChatReplay({ env: {}, fetch: tw.fetch, sleep: async (ms) => { waits.push(ms); } }, "v4", 120, { slices: 1 });
  assert.equal(msgs.length, 50, "a chat that stops before the recording ends");
  assert.ok(tw.calls() < 30, `few calls (${tw.calls()})`);
});

test("a read that still comes out thin is read again through the proxy, and the fuller read is kept", async () => {
  // straight from the server Twitch keeps answering empty; through the proxy it answers in full
  const server = fakeTwitch(600, () => "empty"), viaProxy = fakeTwitch(600);
  let r: ChatReadReport | null = null; const logs: string[] = []; let proxied = 0;
  const msgs = await twitchChatReplay({ env: { STUDIO_YT_PROXY: "http://proxy.example:1" }, fetch: server.fetch, sleep: noWait, log: (l) => logs.push(l),
    twitchProxyCurl: async (body) => { proxied++; return { code: 0, so: `${JSON.stringify(viaProxy.answer(body))}\n200`, se: "" }; } }, "v5", 600, { slices: 2, report: (x) => { r = x; } });
  assert.equal(msgs.length, 600);
  assert.ok(proxied > 0);
  assert.equal(r!.via, "proxy"); assert.equal(r!.direct_messages, 0);
  assert.ok(logs.some((l) => /thin read of v5/.test(l)));
  // no proxy set: the direct read is what there is (a quiet chat stays quiet)
  const quiet = await twitchChatReplay({ env: {}, fetch: fakeTwitch(600, () => "empty").fetch, sleep: noWait, log: () => undefined }, "v6", 600, { slices: 1 });
  assert.equal(quiet.length, 0);
});

test("a chat that really is quiet is read once more through the proxy and stays quiet (small, so cheap)", async () => {
  // 1 message a second for 30 s over a 2-hour recording: thin both ways
  const server = fakeTwitch(30), viaProxy = fakeTwitch(30);
  let r: ChatReadReport | null = null;
  const msgs = await twitchChatReplay({ env: { STUDIO_YT_PROXY: "http://proxy.example:1" }, fetch: server.fetch, sleep: noWait, log: () => undefined,
    twitchProxyCurl: async (body) => ({ code: 0, so: `${JSON.stringify(viaProxy.answer(body))}\n200`, se: "" }) }, "v7", 7200, { slices: 4, report: (x) => { r = x; } });
  assert.equal(msgs.length, 30);
  assert.equal(r!.via, "direct", "not fuller through the proxy: the direct read is kept");
});

test("a part of a stream: only that stretch's chat is read (Nov 23 2026: a 2-hour part of a 15-hour stream read all 15 hours)", async () => {
  const tw = fakeTwitch(3000);
  let r: ChatReadReport | null = null;
  const msgs = await twitchChatReplay({ env: {}, fetch: tw.fetch, sleep: noWait }, "v8", 2400, { from: 2100, report: (x) => { r = x; } });
  assert.equal(msgs.length, 301, "seconds 2100 to 2400 only (the end second included, as at a stream's real end)");
  assert.equal(msgs[0].t, 2100); assert.equal(msgs.at(-1)!.t, 2400);
  assert.ok(r!.pages < 80, `about 60 pages, not 600 (${r!.pages})`);
});
