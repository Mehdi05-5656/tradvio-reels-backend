// Every source a Clips run reads from, checked from this server every few hours, before a customer finds it broken
// (owner, Nov 22 2026, after a paying customer's first Kick run failed on a 429 from Kick's chat replay: "make sure we
// have a solid process in place to prevent issues like this"). Each check walks the same path a real run walks, with
// the same functions, on a real channel: Twitch (the channel, its past streams, ten minutes of a stream's chat replay),
// Kick (the same, through Kick's site, and its live list), and the YouTube creators' feed. No AI, no credits, no cost.
// A step that fails emails the owner at once with the step, the error and the time (ownerAlert; at most once in
// SOURCE_CHECK.realert_ms per step), and every result is kept as a "source_check" event for the admin panel.
// Off with STUDIO_SOURCE_CHECK=off. Never throws.
import { kickBroadcasts, kickChannel, kickChatReplay, kickSiteLive, twitchBroadcasts, twitchChatReplay, twitchUser, type LiveDeps } from "./live-sources.js";
import { youtubeFeed } from "./youtube-feed.js";
import { ownerAlert } from "./vendor-alerts.js";
import { recordEvent } from "./studio-events.js";

export const SOURCE_CHECK = {
  every_ms: 6 * 3_600_000, first_after_ms: 10 * 60_000, realert_ms: 6 * 3_600_000,
  /** channels that stream most days and keep their past streams; the first one with a past stream is used */
  twitch: ["kaicenat", "jynxzi", "zackrawrr", "caseoh_"], kick: ["adinross", "xqc", "amouranth", "gattouz0"],
  chat_seconds: 600,
};
export type CheckResult = { step: string; ok: boolean; ms: number; detail: string };

async function step(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const t = Date.now();
  try { const detail = await fn(); return { step: name, ok: true, ms: Date.now() - t, detail }; }
  catch (e: any) { return { step: name, ok: false, ms: Date.now() - t, detail: `${e?.code ? `${e.code}: ` : ""}${String(e?.message ?? e).slice(0, 300)}` }; }
}

/** One pass over every source. */
export async function checkSources(deps: LiveDeps & { youtube?: typeof youtubeFeed } = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  // Twitch: a channel, its past streams, ten minutes of chat
  out.push(await step("twitch: channel, past streams and chat replay", async () => {
    for (const login of SOURCE_CHECK.twitch) {
      const u = await twitchUser(deps, login); if (!u) continue;
      const b = (await twitchBroadcasts(deps, u.id, 5)).find((x) => !x.live && x.seconds >= SOURCE_CHECK.chat_seconds); if (!b) continue;
      const chat = await twitchChatReplay(deps, b.id, SOURCE_CHECK.chat_seconds, { slices: 1 });
      if (!chat.length) throw new Error(`ten minutes of ${login}'s stream ${b.id} had no chat messages`);
      return `${login} ${b.id}: ${chat.length} messages in the first 10 min`;
    }
    throw new Error(`none of ${SOURCE_CHECK.twitch.join(", ")} had a past stream to read`);
  }));
  // Kick: the same path, through Kick's site
  out.push(await step("kick: channel, past streams and chat replay", async () => {
    for (const slug of SOURCE_CHECK.kick) {
      const ch = await kickChannel(deps, slug).catch((e) => { if (e?.code === "kick_not_found") return null; throw e; }); if (!ch) continue;
      const b = (await kickBroadcasts(deps, slug, ch)).find((x) => !x.live && x.seconds >= SOURCE_CHECK.chat_seconds); if (!b) continue;
      const chat = await kickChatReplay(deps, b.channel_id, b.started_at, SOURCE_CHECK.chat_seconds, { slices: 1 });
      if (!chat.length) throw new Error(`ten minutes of ${slug}'s stream ${b.id} had no chat messages`);
      return `${slug} ${b.id}: ${chat.length} messages in the first 10 min`;
    }
    throw new Error(`none of ${SOURCE_CHECK.kick.join(", ")} had a past stream to read`);
  }));
  out.push(await step("kick: live list", async () => { const l = await kickSiteLive(deps, { pages: 1 }); if (!l.length) throw new Error("Kick's live list came back empty"); return `${l.length} English streams on page 1`; }));
  out.push(await step("youtube: creators' feed", async () => { const f = await (deps.youtube ?? youtubeFeed)({ fetch: deps.fetch }); if (!f.videos.length) throw new Error("no videos"); return `${f.videos.length} videos from ${f.creators.filter((c) => c.videos > 0).length} creators`; }));
  return out;
}

/** Run the check, keep the result, email the owner about each failed step. */
export async function runSourceCheck(deps: LiveDeps & { alert?: typeof ownerAlert; youtube?: typeof youtubeFeed } = {}): Promise<CheckResult[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  try {
    const results = await checkSources(deps);
    recordEvent({ kind: "feature", name: "source_check", props: { ok: results.every((r) => r.ok), results } });
    for (const r of results) {
      log(`[source-check] ${r.ok ? "ok" : "FAILED"} ${r.step} (${Math.round(r.ms / 1000)} s): ${r.detail}`);
      if (!r.ok) await (deps.alert ?? ownerAlert)(`source-check:${r.step}`, `Clips source check failed: ${r.step}`,
        `A Clips source failed its check from the server at ${new Date().toISOString()}. Customers' runs on this source will likely fail the same way until it is fixed.\n\nStep: ${r.step}\nError: ${r.detail}\nTook: ${Math.round(r.ms / 1000)} s\n\nThe check runs every ${SOURCE_CHECK.every_ms / 3_600_000} hours (src/source-check.ts).`, SOURCE_CHECK.realert_ms, { env: deps.env, log });
    }
    return results;
  } catch (e: any) { log(`[source-check] could not run: ${String(e?.message ?? e).slice(0, 200)}`); return []; }
}

export function startSourceCheck(env: Record<string, string | undefined> = process.env): ReturnType<typeof setInterval> | null {
  if (env.STUDIO_SOURCE_CHECK === "off") return null;
  setTimeout(() => void runSourceCheck({ env }), SOURCE_CHECK.first_after_ms);
  return setInterval(() => void runSourceCheck({ env }), SOURCE_CHECK.every_ms);
}
