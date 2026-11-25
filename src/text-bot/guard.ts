// The last check on every text the bot sends (PLAN.md section 6): a supplier's or an internal name must never reach a
// person. The knowledge the bot is given does not contain these words; this catches the case where a tool answer or
// the model's own memory brings one in. A hit replaces the whole message: half a sentence with a hole in it reads
// worse than a plain "ask me another way".
//
// The person's own material is exempt: a caption they wrote, the title of their clip. If their caption says "I asked
// ChatGPT", that is theirs to post and to read back. Callers pass those strings in `own`.
const BANNED = [
  "zernio", "late\\.dev", "getlate", "ayrshare", "publer", "higgsfield", "genjutsu", "eleven ?labs", "anthropic", "claude", "open ?ai", "gpt[ -]?\\d", "chatgpt", "gemini",
  "supabase", "render\\.com", "onrender", "vercel", "scrape ?creators", "groq", "iproyal", "remotion", "aws lambda", "posthog",
  // (model names an Instruments title shows on the website are not listed: the person sees those in the app)
  "system prompt", "tool_use", "studio_[a-z_]+", "/api/studio", "service role",
];
const RE = new RegExp(`(^|[^a-z0-9])(${BANNED.join("|")})(?![a-z])`, "i");
const LINK = /https?:\/\/[^\s)>\]"']+/gi;
const OK_HOSTS = /(^|\.)(clone8\.io|tiktok\.com|instagram\.com|youtube\.com|youtu\.be|twitch\.tv|kick\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|linkedin\.com|threads\.net|threads\.com|bsky\.app|t\.me)$/i;

/** Links the bot's own code may put on a button: Clone8's app, and the two fixed ways into the person's own AI app
 *  (a new chat with their request typed in; adding the Clone8 connector). The model never writes these. */
export const BUTTON_LINK = (url: string) => /^https:\/\/app\.clone8\.io\//.test(url) || /^https:\/\/claude\.ai\/(new\?q=|customize\/connectors\?modal=add-custom-connector&)/.test(url);

export const SAFE_LINE = "I can't share that. Tell me what you want to make, post or check and I'll do it.";
/** Letters split by invisible characters read the same to a person; they are removed before the check. */
const plain = (s: string) => s.normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "");

export function guard(text: string, own: Array<string | null | undefined> = []): { text: string; hit: string | null } {
  // the person's own words are lifted out, the rest is checked, then they go back exactly as they were
  const mine = [...new Set(own.filter((x): x is string => !!x && x.length >= 3))].sort((a, b) => b.length - a.length);
  let body = text; const kept: string[] = [];
  for (const m of mine) { if (!body.includes(m)) continue; body = body.split(m).join(`\u0001${kept.length}\u0002`); kept.push(m); }
  const back = (s: string) => s.replace(/\u0001(\d+)\u0002/g, (_x, i) => kept[Number(i)] ?? "");
  const m = plain(body).match(RE);
  if (m) return { text: SAFE_LINE, hit: m[2].toLowerCase() };
  let hit: string | null = null;
  const out = body.replace(LINK, (raw) => {
    // a full stop or comma after a link is the sentence's, not the link's
    const tail = raw.match(/[.,;:!?]+$/)?.[0] ?? "", url = tail ? raw.slice(0, -tail.length) : raw;
    let host = ""; try { host = new URL(url).hostname; } catch { host = ""; }
    if (OK_HOSTS.test(host)) return raw;
    hit = `link:${host || "unreadable"}`;
    return `(link removed)${tail}`;
  });
  return { text: back(out), hit };
}
/** Whether a text would be blanked outright (a name, not just a removed link). */
export const blanked = (text: string, own: Array<string | null | undefined> = []): string | null => { const g = guard(text, own); return g.hit && !g.hit.startsWith("link:") ? g.hit : null; };
