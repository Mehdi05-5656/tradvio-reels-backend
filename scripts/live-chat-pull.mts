// Pull a Twitch broadcast's chat replay with the backend's own reader, to a JSONL file, for offline detector work.
// Usage: node .exp-build/live-chat-pull.mjs <vod id> <seconds> <out.jsonl>
import { writeFileSync } from "node:fs";
import { twitchChatReplay } from "../src/live-sources.js";
const [vod, seconds, out] = process.argv.slice(2);
const t0 = Date.now();
const msgs = await twitchChatReplay({ env: process.env, log: (l: string) => console.log(l) } as any, vod, Number(seconds), { onProgress: () => undefined });
writeFileSync(out, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
console.log(`${vod}: ${msgs.length} messages in ${Math.round((Date.now() - t0) / 1000)} s -> ${out}`);
