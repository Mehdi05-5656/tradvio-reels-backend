// The last check on every text the bot sends (PLAN.md section 6): a supplier's or an internal name must never reach a
// person. The knowledge the bot is given does not contain these words; this catches the case where a tool answer or
// the model's own memory brings one in. A hit replaces the whole message: half a sentence with a hole in it reads
// worse than a plain "ask me another way".
const BANNED = [
  "zernio", "late\\.dev", "getlate", "ayrshare", "publer", "higgsfield", "genjutsu", "eleven ?labs", "anthropic", "claude", "openai", "gpt-?\\d", "chatgpt",
  "supabase", "render\\.com", "onrender", "vercel", "scrape ?creators", "groq", "iproyal", "remotion", "aws lambda", "posthog",
  // (model names an Instruments title shows on the website are not listed: the person sees those in the app)
  "system prompt", "tool_use", "tool call", "studio_[a-z_]+", "/api/studio", "service role", "api key",
];
const RE = new RegExp(`(^|[^a-z0-9])(${BANNED.join("|")})(?![a-z])`, "i");
/** Signed storage links and anything that is not ours or a network's own address. */
const LINK = /https?:\/\/[^\s)>\]]+/gi;
const OK_HOSTS = /(^|\.)(clone8\.io|tiktok\.com|instagram\.com|youtube\.com|youtu\.be|twitch\.tv|kick\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|linkedin\.com|threads\.net|threads\.com|bsky\.app|t\.me)$/i;

export const SAFE_LINE = "I can't share that. Tell me what you want to make, post or check and I'll do it.";

export function guard(text: string): { text: string; hit: string | null } {
  const m = text.match(RE);
  if (m) return { text: SAFE_LINE, hit: m[2].toLowerCase() };
  let hit: string | null = null;
  const out = text.replace(LINK, (url) => {
    let host = ""; try { host = new URL(url).hostname; } catch { host = ""; }
    if (OK_HOSTS.test(host)) return url;
    hit = `link:${host || "unreadable"}`;
    return "(link removed)";
  });
  return { text: out, hit };
}
