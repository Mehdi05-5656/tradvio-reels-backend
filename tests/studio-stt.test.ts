import test from "node:test";
import assert from "node:assert/strict";
import { transcribeGroq, sttProvider, hearAudio, STT_RATES } from "../src/studio-stt.js";

test("the cheap door: Groq's words with times, no speakers; chosen only when asked for with a key; priced by the seconds heard", async () => {
  assert.equal(sttProvider({}), "scribe"); assert.equal(sttProvider({ STUDIO_LIVE_STT: "groq" }), "scribe", "no key, no door"); assert.equal(sttProvider({ GROQ_API_KEY: "k" }), "groq", "the key alone opens the door"); assert.equal(sttProvider({ STUDIO_LIVE_STT: "scribe", GROQ_API_KEY: "k" }), "scribe", "asked for Scribe");
  const calls: any[] = [];
  const fetchFake: any = async (url: string, init: any) => { calls.push([url, init.headers.authorization, init.body.get("model"), init.body.getAll("timestamp_granularities[]")]); return { ok: true, status: 200, json: async () => ({ language: "en", words: [{ word: "Whose", start: 0.1, end: 0.4 }, { word: "address?", start: 0.4, end: 0.9 }, { word: "", start: 1, end: 1 }] }) }; };
  const r = await transcribeGroq({ env: { GROQ_API_KEY: "k" }, fetch: fetchFake }, { audio: Buffer.from("mp3") });
  assert.deepEqual(r.words, [{ text: "Whose", start: 0.1, end: 0.4, speaker: null }, { text: "address?", start: 0.4, end: 0.9, speaker: null }]); assert.deepEqual(r.events, []); assert.equal(r.language, "en");
  assert.equal(calls[0][0], "https://api.groq.com/openai/v1/audio/transcriptions"); assert.equal(calls[0][1], "Bearer k"); assert.equal(calls[0][2], "whisper-large-v3-turbo"); assert.deepEqual(calls[0][3], ["word", "segment"]);
  await assert.rejects(() => transcribeGroq({ env: {}, fetch: fetchFake }, { audio: Buffer.from("x") }), /GROQ_API_KEY/);
  const h = await hearAudio({ env: { STUDIO_LIVE_STT: "groq", GROQ_API_KEY: "k" }, fetch: fetchFake }, { audio: Buffer.from("mp3"), seconds: 3600, use: "live_clips_hour", userId: "u" });
  assert.equal(h.words.length, 2);
  assert.equal(STT_RATES.groq, 0.04); assert.equal(STT_RATES.scribe, 0.2);
});
