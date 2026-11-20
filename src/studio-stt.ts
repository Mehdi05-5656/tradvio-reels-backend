// Speech to text for Live Clips, by provider. ElevenLabs Scribe ($0.20 an hour) hears speakers and sounds (laughter,
// music), which the framing and the cut's end use; Groq's hosted Whisper large-v3-turbo ($0.04 an hour, Nov 19 2026)
// hears words with times and nothing else. The cost study (docs/live-clips/research/costs/) put transcription at 40 %
// of a Live Clips run. The hours read whole only feed the picker and the context, so they can go to the cheap door
// (whenever GROQ_API_KEY is set; STUDIO_LIVE_STT=scribe keeps them on Scribe); the candidate windows are judged and cut on their exact words, and on the
// first cheap-door run (Nov 19 2026) the verifier called Whisper turbo's windows "garbled" and dropped a kept moment
// (it hears about a fifth fewer words where people talk over each other), so the windows stay on Scribe. Measured on
// the paid tier the same night: a run at $0.75 against $0.90 with Scribe hours.
import { transcribeWords, type TimedWord, type AudioEvent } from "./studio-eleven.js";
import { recordEvent } from "./studio-events.js";

export type SttProvider = "scribe" | "groq";
export type Heard = { words: TimedWord[]; events: AudioEvent[]; language: string | null };
export type SttDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch };
/** Dollars an hour of sound, each door (Nov 19 2026 list prices; Scribe is what the cost events have always used). */
export const STT_RATES: Record<SttProvider, number> = { scribe: 0.2, groq: 0.04 };
export const GROQ_MODEL = "whisper-large-v3-turbo";

/** The door for the hours read whole: Groq whenever its key is there (the owner's choice, Nov 19 2026: the hybrid on,
 *  its hours on the cheap door), Scribe without it or when STUDIO_LIVE_STT=scribe says so. The windows are always Scribe's. */
export function sttProvider(env: Record<string, string | undefined> = process.env): SttProvider {
  if (env.STUDIO_LIVE_STT === "scribe") return "scribe";
  return env.GROQ_API_KEY ? "groq" : "scribe";
}

/** Groq's OpenAI-shaped transcription: the words with their times; no speakers, no sounds. */
export async function transcribeGroq(deps: SttDeps, p: { audio: Buffer; filename?: string; type?: string; language?: string | null }): Promise<Heard> {
  const env = deps.env ?? process.env;
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(p.audio)], { type: p.type ?? "audio/mpeg" }), p.filename ?? "source.mp3");
  form.set("model", env.GROQ_STT_MODEL || GROQ_MODEL);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.set("temperature", "0");
  if (p.language) form.set("language", p.language);
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await (deps.fetch ?? fetch)("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(10 * 60_000) }).catch((e: any) => { last = String(e?.message ?? e); return null; });
    if (r && r.ok) {
      const body: any = await r.json();
      const words: TimedWord[] = (Array.isArray(body?.words) ? body.words : [])
        .filter((w: any) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)) && String(w.word ?? w.text ?? "").trim())
        .map((w: any) => ({ text: String(w.word ?? w.text).trim(), start: Number(w.start), end: Math.max(Number(w.start), Number(w.end)), speaker: null }));
      return { words, events: [], language: body?.language ? String(body.language) : null };
    }
    const status = r?.status ?? 0;
    last = r ? `${status}: ${(await r.text().catch(() => "")).slice(0, 200)}` : last;
    // (a rate limit on the free tier is counted per minute: the first cheap-door run lost an hour and 17 windows to 429s with 3-9 s waits)
    if (status === 429 || status >= 500 || status === 0) { await new Promise((res) => setTimeout(res, status === 429 ? 20_000 * (attempt + 1) : 3000 * (attempt + 1))); continue; }
    break;
  }
  throw new Error(`Groq transcription failed: ${last || "no answer"}`);
}

/** Sound heard through the chosen door, its cost recorded (by the seconds heard) under the door's own name. */
export async function hearAudio(deps: SttDeps, p: { audio: Buffer; seconds: number; use: string; userId: string; provider?: SttProvider; events?: boolean; language?: string | null }): Promise<Heard> {
  const env = deps.env ?? process.env;
  const provider = p.provider ?? sttProvider(env);
  if (provider === "groq") {
    const r = await transcribeGroq(deps, { audio: p.audio, language: p.language ?? undefined });
    recordEvent({ user_id: p.userId, kind: "vendor", name: "groq_whisper", usd: (p.seconds / 3600) * STT_RATES.groq, props: { use: p.use, seconds: p.seconds, model: env.GROQ_STT_MODEL || GROQ_MODEL } });
    return r;
  }
  const r = await transcribeWords({ env, fetch: deps.fetch } as any, { audio: p.audio, events: p.events ?? true, language: p.language ?? undefined });
  recordEvent({ user_id: p.userId, kind: "vendor", name: "elevenlabs_scribe", usd: (p.seconds / 3600) * STT_RATES.scribe, props: { use: p.use, seconds: p.seconds } });
  return { words: r.words, events: r.events, language: r.language };
}
