// The questions after sign-up (version 2, Oct 31 2026): what each answer may be, how a saved answer reads to the
// assistant, the first prompts it suggests, and the totals the operator console shows ("who is signing up").
// The dashboard asks the questions (tradvio-reels-v2 src/lib/onboarding.ts keeps the same ids): change an id in
// both places or not at all. Version 1 answers (intent, source, library, accounts, ...) are still read.

type Spec = { multi?: boolean; max?: number; values: Record<string, string> };

/** Every question, its allowed answers and how each reads in a sentence. */
export const QUESTIONS: Record<string, Spec> = {
  role: { values: { creator: "a creator or personal brand", business: "their own business", agency: "clients (agency, editor or freelancer)", pages: "theme, faceless or clip pages they run", exploring: "just looking" } },
  niche: { multi: true, max: 3, values: { money: "business and money", fitness: "fitness and health", beauty: "beauty and fashion", gaming: "gaming and streaming", comedy: "comedy and entertainment", education: "education and how-to", tech: "tech and AI", food: "food", travel: "travel and lifestyle", music: "music", podcast: "podcasts and interviews", sports: "sports", motivation: "motivation and mindset", news: "news and commentary", other: "something else" } },
  sells: { values: { ecommerce: "physical products", app: "an app or software", services: "coaching, courses or services", local: "a local business", media: "media, music or entertainment", other: "something else" } },
  team: { values: { solo: "just them", "2_5": "2 to 5 people", "6_20": "6 to 20 people", gt20: "more than 20 people" } },
  clients: { values: { "1_3": "1 to 3 clients", "4_10": "4 to 10 clients", "11_30": "11 to 30 clients", gt30: "more than 30 clients" } },
  goals: { multi: true, values: { multiply: "more posts from videos they have (Blueprint)", network: "posting on many accounts without duplicates (Blueprint)", faceless: "videos without being on camera (Recast)", character: "an AI character or influencer (Characters)", swap: "swapping people or styles in their videos (Swap, Styles)", trends: "jumping on trends (Trends)", ads: "ads and UGC for a product", generate: "creating from a prompt (Instruments)", publish: "scheduling and posting everywhere (Publish)", analytics: "knowing what to post next (Performance)", managed: "having Clone8 run it for them (managed service)" } },
  goal: { values: {} }, // one of goals; checked against them below
  platforms: { multi: true, values: { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", x: "X", linkedin: "LinkedIn", threads: "Threads", snapchat: "Snapchat", none: "not posting yet" } },
  accounts: { values: { one: "1 account", "2_5": "2 to 5 accounts", "6_20": "6 to 20 accounts", "21_100": "21 to 100 accounts", gt100: "more than 100 accounts" } },
  posts_now: { values: { none: "not posting yet", lt10: "a few a month", "10_30": "a few a week", "30_100": "1 to 3 a day", "100_500": "several a day", gt500: "dozens a day" } },
  posts_goal: { values: { lt30: "up to 1 a day", "30_100": "1 to 3 a day", "100_500": "several a day", "500_2000": "dozens a day", gt2000: "hundreds a day" } },
  library: { values: { none: "no finished videos yet", lt20: "under 20 finished videos", "20_100": "20 to 100 finished videos", "100_500": "100 to 500 finished videos", gt500: "more than 500 finished videos" } },
  blocker: { values: { volume: "not enough videos to post", filming: "filming takes too long", camera: "not wanting to be on camera", views: "flat views without knowing why", flagged: "reposts getting flagged or buried", accounts: "running many accounts is a grind", cost: "editors and tools cost too much", quality: "AI video not looking real enough" } },
  tools: { multi: true, values: { capcut: "CapCut", higgsfield: "Higgsfield", heygen: "HeyGen or Synthesia", captions: "Captions", ugc: "Arcads, Creatify or MakeUGC", clipping: "OpusClip or another clipper", models: "Kling, Veo, Runway or Sora", chatgpt: "ChatGPT or Claude", editor: "an editor or agency", scheduler: "a scheduler", none: "nothing yet" } },
  spend: { values: { zero: "$0", lt100: "under $100", "100_500": "$100 to $500", "500_2000": "$500 to $2,000", gt2000: "over $2,000" } },
  heard: { values: { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", reddit: "Reddit", google: "Google", ai: "ChatGPT or another AI", friend: "a friend or colleague", creator: "a creator they follow", other: "somewhere else" } },
};
/** Version 1 keys still accepted (people who answered before Oct 31 2026, or an old cached dashboard). */
const V1 = new Set(["intent", "source", "recast_reason", "length", "character", "start"]);
const TEXT_KEYS: Record<string, number> = { first_make: 400 };
const STEP_IDS = new Set(["role", "about", "goals", "goal", "channels", "volume", "blocker", "stack", "heard", "first"]);
const ATTRIBUTION = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "landing", "at"];

const word = (v: unknown, max = 40) => (typeof v === "string" ? v.replace(/[^\w-]/g, "").slice(0, max) : "");
const plain = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Keep only answers that exist, with values that exist; drop everything else without failing the save. */
export function sanitizeAnswers(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, spec] of Object.entries(QUESTIONS)) {
    const v = input[k];
    if (v == null || k === "goal") continue;
    if (spec.multi) {
      const ids = (Array.isArray(v) ? v : [v]).map((x) => word(x)).filter((x, i, all) => x && spec.values[x] && all.indexOf(x) === i);
      if (ids.length) out[k] = spec.max ? ids.slice(0, spec.max) : ids;
    } else if (spec.values[word(v)]) out[k] = word(v);
  }
  const goals: string[] = out.goals ?? [];
  if (goals.includes(word(input.goal))) out.goal = word(input.goal);
  else if (goals.length === 1) out.goal = goals[0];
  for (const [k, max] of Object.entries(TEXT_KEYS)) { const t = plain(input[k], max); if (t) out[k] = t; }
  for (const k of V1) {
    const v = input[k];
    if (Array.isArray(v)) { const ids = v.map((x) => word(x)).filter(Boolean).slice(0, 12); if (ids.length) out[k] = ids; }
    else if (word(v)) out[k] = word(v);
  }
  // v1 used the same names with other values; keep them as they came if v2 did not recognise them
  for (const k of ["library", "accounts"]) if (out[k] == null && word(input[k])) out[k] = word(input[k]);
  if (input.version === 2) out.version = 2;
  if (STEP_IDS.has(word(input.skipped_at))) out.skipped_at = word(input.skipped_at);
  if (input.attribution && typeof input.attribution === "object" && !Array.isArray(input.attribution)) {
    const a: Record<string, string> = {};
    for (const k of ATTRIBUTION) { const t = plain(input.attribution[k], 80).replace(/[^\w .:/@#+-]/g, ""); if (t) a[k] = t; }
    if (Object.keys(a).length) out.attribution = a;
  }
  return out;
}

const said = (k: string, v: unknown) => (typeof v === "string" ? QUESTIONS[k]?.values[v] : undefined);
const saidAll = (k: string, v: unknown) => (Array.isArray(v) ? v.map((x) => said(k, x)).filter(Boolean) as string[] : []);

/** How the person described themselves at sign-up, as lines for the assistant's system prompt. */
export function profileLines(ob: Record<string, any> | null | undefined): string[] {
  if (!ob || typeof ob !== "object") return [];
  const lines: string[] = [];
  const who = said("role", ob.role);
  if (who) {
    const more = [said("sells", ob.sells) && `sells ${said("sells", ob.sells)}`, said("clients", ob.clients), said("team", ob.team) && `content made by ${said("team", ob.team)}`, saidAll("niche", ob.niche).length && `about ${saidAll("niche", ob.niche).join(", ")}`].filter(Boolean);
    lines.push(`Makes content for ${who}${more.length ? `: ${more.join("; ")}` : ""}.`);
  }
  const goals = saidAll("goals", ob.goals);
  if (goals.length) lines.push(`Wants: ${goals.join("; ")}${said("goals", ob.goal) && goals.length > 1 ? `. First priority: ${said("goals", ob.goal)}` : ""}.`);
  else if (ob.intent) lines.push(`Came for: ${String(ob.intent)}.`);
  const nets = saidAll("platforms", ob.platforms);
  if (nets.length || said("accounts", ob.accounts)) lines.push(`Posts on: ${[nets.join(", "), said("accounts", ob.accounts)].filter(Boolean).join(", ")}.`);
  if (said("posts_now", ob.posts_now) || said("posts_goal", ob.posts_goal)) lines.push(`Volume: ${said("posts_now", ob.posts_now) ?? "unknown"} today, wants ${said("posts_goal", ob.posts_goal) ?? "more"}${said("library", ob.library) ? `; has ${said("library", ob.library)}` : ""}.`);
  if (said("blocker", ob.blocker)) lines.push(`Biggest problem: ${said("blocker", ob.blocker)}.`);
  const tools = saidAll("tools", ob.tools).filter((t) => t !== "nothing yet");
  if (tools.length) lines.push(`Uses today: ${tools.join(", ")}.`);
  if (typeof ob.first_make === "string" && ob.first_make.trim()) lines.push(`First thing they said they want to make: "${ob.first_make.trim().slice(0, 400)}"`);
  return lines;
}

const NICHE_WORD: Record<string, string> = { money: "business", fitness: "fitness", beauty: "beauty", gaming: "gaming", comedy: "comedy", education: "how-to", tech: "tech", food: "food", travel: "travel", music: "music", podcast: "podcast", sports: "sports", motivation: "motivation", news: "news" };
const SELLS_WORD: Record<string, string> = { ecommerce: "product", app: "app", services: "offer", local: "business", media: "release" };
/** Prompts to start a chat with, from what they told us (their own words first). */
export function profileSuggestions(ob: Record<string, any> | null | undefined): Array<{ label: string; prompt: string }> {
  if (!ob || typeof ob !== "object") return [];
  const out: Array<{ label: string; prompt: string }> = [];
  if (typeof ob.first_make === "string" && ob.first_make.trim()) { const t = ob.first_make.trim(); out.push({ label: t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t, prompt: t }); }
  const topic = NICHE_WORD[Array.isArray(ob.niche) ? ob.niche[0] : ""] ?? "";
  const by: Record<string, [string, string]> = {
    multiply: ["10 originals of my best video", "Turn my best video into 10 originals."],
    network: ["One original per account", "Make one original of my latest video for each of my accounts."],
    faceless: ["Recast me as a character", "Recast my latest talking clip so a character says it, not me."],
    character: ["Create my character", `Create a character for my ${topic ? `${topic} ` : ""}videos.`],
    swap: ["Swap me in my newest video", "Swap me for a character in my newest video."],
    trends: ["A trend for this week", "Show me a trend my character can perform this week."],
    ads: [`A UGC ad for my ${SELLS_WORD[ob.sells] ?? "product"}`, `Make a 15-second UGC ad for my ${SELLS_WORD[ob.sells] ?? "product"}.`],
    generate: [`A ${topic ? `${topic} ` : ""}clip from a prompt`, `Make a 10-second ${topic ? `${topic} ` : ""}clip from a prompt.`],
    publish: ["Schedule my next videos", "Schedule my next videos on my networks."],
    analytics: ["What should I post next?", "What should I post next, based on my numbers?"],
    managed: ["How would you run my accounts?", "How would the managed service run my accounts?"],
  };
  const goals = [ob.goal, ...(Array.isArray(ob.goals) ? ob.goals : [])].filter((g, i, all) => typeof g === "string" && by[g] && all.indexOf(g) === i);
  for (const g of goals) out.push({ label: by[g][0], prompt: by[g][1] });
  return out.slice(0, 3);
}

/** The managed service is worth a call: they asked, or their size says so. Mirrors the dashboard's managedFit. */
export function managedFit(ob: Record<string, any> | null | undefined): string | null {
  if (!ob) return null;
  const goals: string[] = Array.isArray(ob.goals) ? ob.goals : [];
  const accounts = ({ one: 1, "2_5": 4, "6_20": 12, "21_100": 50, gt100: 150 } as Record<string, number>)[ob.accounts] ?? 0;
  const volume = ({ lt30: 30, "30_100": 100, "100_500": 300, "500_2000": 1000, gt2000: 3000 } as Record<string, number>)[ob.posts_goal] ?? 0;
  if (goals.includes("managed") || ob.intent === "managed") return "asked for it";
  if (ob.role === "agency" && ["11_30", "gt30"].includes(ob.clients)) return "agency with 11+ clients";
  if (accounts >= 12 && (volume >= 300 || ["500_2000", "gt2000"].includes(ob.spend))) return "many accounts at volume";
  if (ob.spend === "gt2000" && accounts >= 4) return "spends $2,000+ a month";
  return null;
}

/** Totals over everyone who answered: one count per answer, most common first. For the operator console. */
export function signupInsights(rows: Array<{ onboarding: any; status?: string | null }>) {
  const answered = rows.filter((r) => r.onboarding && typeof r.onboarding === "object" && r.onboarding.completed_at);
  const paying = (r: { status?: string | null }) => r.status === "active" || r.status === "trialing";
  const tally = (k: string) => {
    const spec = QUESTIONS[k === "goal" ? "goals" : k];
    const counts = new Map<string, { n: number; paying: number }>();
    for (const r of answered) {
      const v = r.onboarding[k];
      for (const id of Array.isArray(v) ? v : v ? [v] : []) {
        if (!spec?.values[id]) continue;
        const c = counts.get(id) ?? { n: 0, paying: 0 };
        c.n++; if (paying(r)) c.paying++;
        counts.set(id, c);
      }
    }
    return [...counts.entries()].map(([id, c]) => ({ id, label: spec.values[id].replace(/ \([^)]*\)$/, ""), n: c.n, paying: c.paying })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  };
  const keys = ["role", "goal", "goals", "blocker", "platforms", "accounts", "posts_goal", "library", "tools", "spend", "heard", "sells", "niche", "clients"];
  const sources = new Map<string, number>();
  for (const r of answered) { const a = r.onboarding.attribution; const s = a?.utm_source || a?.ref; if (s) sources.set(String(s), (sources.get(String(s)) ?? 0) + 1); }
  return {
    answered: answered.length,
    version2: answered.filter((r) => r.onboarding.version === 2).length,
    skipped: answered.filter((r) => r.onboarding.skipped_at).length,
    by: Object.fromEntries(keys.map((k) => [k, tally(k)])),
    sources: [...sources.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n || a.source.localeCompare(b.source)).slice(0, 12),
    first_makes: answered.filter((r) => typeof r.onboarding.first_make === "string").sort((a, b) => String(b.onboarding.completed_at).localeCompare(String(a.onboarding.completed_at))).slice(0, 12).map((r) => String(r.onboarding.first_make)),
  };
}
