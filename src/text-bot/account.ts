// Knowing the account (PLAN.md section 7.2). One card for every thing the person has: each result of a job, each
// library file, each post, each collection, each character. A card says in plain words what it is and holds every
// word it could be found by. In this local test the cards are built from the reading routes (the last 100 jobs, the
// whole library, every post); the real index reads the database and covers the whole history.
import type { Api } from "./routes.js";

export type Card = {
  /** how the bot refers to it: r:<job>[:n] a result, f:<asset> a library file, p:<post>, c:<collection> */
  ref: string; type: "result" | "file" | "post" | "collection";
  title: string; line: string; text: string; when: string; tool?: string;
  job_id?: string; output_key?: string; asset_id?: string; collection_id?: string; post_id?: string;
  kind?: "video" | "image" | "audio" | "other"; seconds?: number | null; character?: boolean;
  made_from?: string | null; posted?: Array<{ where: string; when: string | null; status: string; post_id: string; caption?: string }>;
  /** a signed picture link, good for about 15 minutes after the index was built; never shown as text */
  poster?: string | null;
};
export type Index = { cards: Card[]; built_at: number; notes: string[]; /** made something through the Clone8 connector (so it is set up in their AI app) */ connector_used?: boolean };

const TOOL_NAME: Record<string, string> = {
  clips: "Clips", captions: "Captions", swap: "Swap", recast: "Recast", restyle: "Styles", trend: "Trends", character: "Character", instrument: "Instrument",
  blueprint: "Blueprint", blueprint_plus: "Blueprint", blueprint_versions: "Blueprint versions", stunts: "Stunts", reshoot: "Reshoot", splitscreen: "Split screen",
  longform: "Film", kage: "Kage", import: "Import", post_captions: "Captions written",
};
export function toolName(job: { tool: string; options?: any }): string {
  if (job.tool === "kage_motion") return job.options?.story ? "Story" : job.options?.motivation ? "Motivation" : "Kage";
  return TOOL_NAME[job.tool] ?? job.tool;
}
const short = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const stem = (s: string) => s.replace(/\.[a-z0-9]{2,4}$/i, "");
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "");

/** What a job did, in a sentence, from its own settings (who plays whom, which words, which gags). */
export function describeJob(job: any, names: Map<string, { name: string; prompt?: string | null }>): { line: string; words: string[] } {
  const o = job.options ?? {}, words: string[] = [];
  const src = job.asset_id ? names.get(job.asset_id) : null;
  const who = (m: any): string => {
    if (!m) return "";
    if (m.character_asset_id && names.has(m.character_asset_id)) { const c = names.get(m.character_asset_id)!; words.push(c.name, c.prompt ?? ""); return `your character "${stem(c.name)}"${c.prompt ? ` (${short(c.prompt, 60)})` : ""}`; }
    if (m.character) { words.push(String(m.character)); return `the preset ${String(m.character)}`; }
    return "";
  };
  const bits: string[] = [];
  if (src) { bits.push(`on "${stem(src.name)}"`); words.push(src.name); }
  if (["swap", "recast", "trend", "restyle"].includes(job.tool)) {
    const cast = Array.isArray(o.cast) ? o.cast.map((m: any) => `${m.label ? `${m.label} → ` : ""}${who(m)}`).filter(Boolean) : [];
    const one = cast.length ? cast.join("; ") : who(o);
    if (one) bits.push(job.tool === "swap" ? `the person replaced by ${one}` : `performed by ${one}`);
    if (Array.isArray(o.targets) && o.targets.length) bits.push(`only ${o.targets.join(", ")}`);
    if (o.style_name) { bits.push(`in the style ${o.style_name}`); words.push(o.style_name); }
    if (o.trend_name) { bits.push(`trend "${o.trend_name}"`); words.push(o.trend_name); }
  }
  if (job.tool === "stunts" && Array.isArray(o.gags)) { bits.push(`endings: ${o.gags.map((g: any) => short(g.title, 40)).join(", ")}`); for (const g of o.gags) words.push(g.title, g.prompt); }
  if (job.tool === "reshoot" && Array.isArray(o.shots)) bits.push(`${o.shots.filter((s: any) => !s?.keep).length} shots changed`);
  if (job.tool === "splitscreen") bits.push(`over gameplay${o.loop_id ? ` (${o.loop_id})` : ""}`);
  if (job.tool === "blueprint" && o.copies) bits.push(`${o.copies} copies`);
  if (job.tool === "character") bits.push(short(o.prompt, 80));
  if (job.tool === "instrument") bits.push(short(o.params?.prompt ?? o.endpoint, 80));
  const topic = o.story?.topic ?? o.motivation?.topic ?? o.longform?.prompt ?? o.topic ?? o.brief ?? o.prompt;
  if (topic && !["character", "instrument"].includes(job.tool)) { bits.push(`"${short(topic, 80)}"`); }
  for (const v of [topic, o.prompt, o.params?.prompt, o.note, o.name]) if (v) words.push(String(v));
  return { line: `${toolName(job)}${bits.length ? ` · ${bits.join(" · ")}` : ""}`, words: words.filter(Boolean).map((w) => short(w, 400)) };
}

const outKind = (o: any): Card["kind"] => (o?.kind === "image" || /\.(jpe?g|png|webp)$/i.test(String(o?.key ?? "")) ? "image" : o?.kind === "audio" || /\.(mp3|wav|m4a)$/i.test(String(o?.key ?? "")) ? "audio" : /\.(mp4|mov|webm)$/i.test(String(o?.key ?? "")) || o?.kind === "video" ? "video" : "other");

export function buildCards(data: { jobs: any[]; assets: any[]; collections: any[]; posts: any[]; accounts: any[] }): Card[] {
  const names = new Map<string, { name: string; prompt?: string | null }>(data.assets.map((a) => [a.id, { name: a.name, prompt: a.probe?.prompt ?? null }]));
  const cols = new Map<string, any>(data.collections.map((c) => [c.id, c]));
  const handle = new Map<string, string>(data.accounts.filter((a) => a.id).map((a) => [a.id, `${a.platform}${a.username ? ` @${a.username}` : ""}`]));
  const cards: Card[] = [];
  // where each video went
  const postedBy = new Map<string, NonNullable<Card["posted"]>>();
  for (const p of data.posts) {
    const targets: string[] = (Array.isArray(p.options?.accounts) && p.options.accounts.length ? p.options.accounts.map((a: any) => handle.get(a.id) ?? `${a.platform}${a.username ? ` @${a.username}` : ""}`) : (p.platforms ?? []));
    const key = p.asset_id ? `f:${p.asset_id}` : p.job_id ? `r:${p.job_id}:${p.output_key ?? ""}` : "";
    const entry = { where: targets.join(", "), when: p.schedule_at ?? p.created_at ?? null, status: p.status, post_id: p.id, caption: short(p.caption, 300) };
    if (key) postedBy.set(key, [...(postedBy.get(key) ?? []), entry]);
    const about = p.asset_id && names.has(p.asset_id) ? stem(names.get(p.asset_id)!.name) : "a video";
    cards.push({ ref: `p:${p.id}`, type: "post", post_id: p.id, asset_id: p.asset_id ?? undefined, job_id: p.job_id ?? undefined, output_key: p.output_key ?? undefined,
      title: `Post of "${about}"`, when: p.schedule_at ?? p.created_at,
      line: `${p.status === "scheduled" || p.status === "queued" ? "Scheduled" : p.status === "published" || p.status === "sent" ? "Posted" : p.status} · ${targets.join(", ") || "no account"} · ${p.schedule_at ? p.schedule_at : "now"} · "${short(p.caption, 80)}"`,
      text: [about, p.caption, targets.join(" "), p.status, p.options?.youtube?.title].filter(Boolean).join(" \n ") });
  }
  for (const j of data.jobs) {
    if (j.status !== "done" || j.tool === "clips" || j.tool === "import" || j.tool === "post_captions") continue; // clips and imports are library files already
    const d = describeJob(j, names), outs = (Array.isArray(j.outputs) ? j.outputs : []) as any[];
    outs.forEach((o, i) => {
      if (!o?.key) return;
      const ref = outs.length > 1 ? `r:${j.id}:${i + 1}` : `r:${j.id}`;
      const posted = postedBy.get(`r:${j.id}:${o.key}`) ?? (o.asset_id ? postedBy.get(`f:${o.asset_id}`) : undefined);
      cards.push({ ref, type: "result", job_id: j.id, output_key: o.key, asset_id: o.asset_id ?? undefined, tool: j.tool, kind: outKind(o), seconds: Number(o.duration ?? o.seconds) || null,
        made_from: j.asset_id ? `f:${j.asset_id}` : null, posted, when: j.finished_at ?? j.created_at, poster: o.poster_url ?? null,
        title: short(o.title, 80) || `${toolName(j)}${outs.length > 1 ? ` ${i + 1} of ${outs.length}` : ""}${j.asset_name ? ` of "${stem(j.asset_name)}"` : ""}`,
        line: d.line, text: [d.line, ...d.words, o.title, o.description, o.script, o.label, j.asset_name, ...(posted ?? []).map((x) => x.caption)].filter(Boolean).map((x) => short(x, 600)).join(" \n ") });
    });
  }
  for (const a of data.assets) {
    const pr = a.probe ?? {}, col = a.collection_id ? cols.get(a.collection_id) : null;
    const stream = col && ["twitch", "kick"].includes(String(col.source?.platform ?? "").toLowerCase());
    const bits = [a.kind === "image" ? (pr.character ? "Character picture" : "Picture") : pr.captions?.from ? "Captioned video" : pr.clip ? (stream ? "Live stream clip" : "Clip") : pr.source_url ? "Imported video" : pr.derived_from_job ? "Made video" : "Video"];
    if (col) bits.push(`in "${col.name}"`);
    if (pr.hook) bits.push(`"${short(pr.hook, 70)}"`);
    if (pr.prompt) bits.push(short(pr.prompt, 70));
    if (Number(pr.score) > 0) bits.push(`score ${Math.round(Number(pr.score))}`);
    cards.push({ ref: `f:${a.id}`, type: "file", asset_id: a.id, collection_id: a.collection_id ?? undefined, kind: a.kind === "image" ? "image" : "video", seconds: Number(pr.duration) || null, character: !!pr.character,
      made_from: pr.derived_from_job ? `r:${pr.derived_from_job}` : typeof pr.captions?.from === "string" && /^[0-9a-f-]{36}$/i.test(pr.captions.from) ? `f:${pr.captions.from}` : null, posted: postedBy.get(`f:${a.id}`), when: a.created_at, poster: a.poster_url ?? null,
      title: short(pr.title, 80) || stem(a.name), line: bits.join(" · "),
      text: [a.name, stream ? `live stream clip ${col.source.platform} ${col.source?.channel ?? ""}` : "", pr.captions?.from ? "captions captioned" : "", pr.title, pr.hook, pr.why, Array.isArray(pr.tags) ? pr.tags.join(" ") : pr.tags, pr.prompt, col?.name, pr.source, Array.isArray(pr.people) ? pr.people.map((p: any) => p?.label).join(" ") : "", ...(postedBy.get(`f:${a.id}`) ?? []).map((x) => x.caption), short(pr.transcript, 1200)].filter(Boolean).join(" \n ") });
  }
  for (const c of data.collections) cards.push({ ref: `c:${c.id}`, type: "collection", collection_id: c.id, when: c.created_at, title: c.name,
    line: `${c.kind === "clips" ? "Clips run" : c.kind === "import" ? "Import" : "Folder"} · ${c.count ?? c.assets ?? "?"} files${c.status && c.status !== "ready" ? ` · ${c.status}` : ""}`,
    text: [c.name, c.kind, ["twitch", "kick"].includes(String(c.source?.platform ?? "").toLowerCase()) ? `live stream clips ${c.source.platform}` : c.source?.platform === "youtube" ? "youtube clips" : "", c.source?.title, c.source?.channel, c.source?.handle, c.source?.url].filter(Boolean).join(" \n ") });
  return cards;
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "at", "for", "from", "with", "and", "or", "that", "this", "those", "these", "one", "ones", "we", "i", "my", "our", "me", "you", "it", "its", "was", "were", "is", "are", "be", "did", "do", "made", "make", "video", "videos", "clip", "clips", "where", "when", "which", "who", "into", "him", "her", "them", "his", "remember", "thing", "some", "about", "had", "have", "has"]);
export const tokens = (s: string): string[] => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9@#\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
/** "cats" finds "cat", "exploding" finds "explode": the first letters decide, endings do not. */
const root = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s|e)$/, "") : w.replace(/s$/, ""));

export type Filters = { type?: Card["type"]; tool?: string; kind?: Card["kind"]; after?: string; before?: string; posted?: boolean; collection?: string; character?: boolean };
export function matches(c: Card, f: Filters): boolean {
  if (f.type && c.type !== f.type) return false;
  if (f.tool && c.tool !== f.tool && !(f.tool === "story" && c.tool === "kage_motion")) return false;
  if (f.kind && c.kind !== f.kind) return false;
  if (f.character != null && !!c.character !== f.character) return false;
  if (f.after && String(c.when) < f.after) return false;
  if (f.before && String(c.when) > f.before) return false;
  if (f.posted != null && !!(c.posted && c.posted.length) !== f.posted) return false;
  if (f.collection && c.collection_id !== f.collection && c.ref !== `c:${f.collection}`) return false;
  return true;
}
/** How well a card answers the words: every word counts, a word in the title or the summary line counts more. */
export function score(c: Card, words: string[]): number {
  if (!words.length) return 1;
  const title = new Set(tokens(c.title).map(root)), line = new Set(tokens(c.line).map(root)), text = new Set(tokens(c.text).map(root));
  let s = 0, hit = 0;
  for (const w of words.map(root)) {
    const t = title.has(w) ? 3 : line.has(w) ? 2 : text.has(w) ? 1 : [...text].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))) ? 0.5 : 0;
    if (t) hit++;
    s += t;
  }
  // most of the words have to be there: one stray word out of five is not a find
  return hit / words.length >= 0.5 ? s * (hit / words.length) : 0;
}
export function find(cards: Card[], query: string, f: Filters = {}, limit = 8): Card[] {
  const words = tokens(query);
  return cards.filter((c) => matches(c, f)).map((c) => ({ c, s: score(c, words) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(b.c.when).localeCompare(String(a.c.when))).slice(0, Math.min(Math.max(limit, 1), 20)).map((x) => x.c);
}
export function history(cards: Card[], f: Filters = {}, limit = 20): Card[] {
  return cards.filter((c) => c.type !== "collection" && matches(c, f)).sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, Math.min(Math.max(limit, 1), 40));
}
/** A card as the brain reads it. */
export function view(c: Card): Record<string, unknown> {
  return { ref: c.ref, what: c.type, title: c.title, about: c.line, when: day(c.when), ...(c.seconds ? { seconds: Math.round(c.seconds) } : {}), ...(c.kind ? { kind: c.kind } : {}),
    ...(c.made_from ? { made_from: c.made_from } : {}), ...(c.posted?.length ? { posted: c.posted.map((p) => `${p.status} · ${p.where} · ${day(p.when)} (p:${p.post_id})`) } : {}) };
}

/** Reads the account through the reading routes. */
export async function loadIndex(api: Api, now = Date.now()): Promise<Index> {
  const notes: string[] = [];
  const get = async (path: string) => { const r = await api.call("GET", path); if (r.status !== 200) { notes.push(`${path.split("?")[0]} answered ${r.status}`); return null; } return r.json; };
  const [jobs, cols, posts, social] = await Promise.all([get("/api/studio/jobs"), get("/api/studio/collections"), get("/api/studio/social/posts"), get("/api/studio/social")]);
  const assets: any[] = []; let before: string | null = null;
  for (let page = 0; page < 12; page++) {
    const r = await get(`/api/studio/assets?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    if (!r) break;
    assets.push(...(r.assets ?? []));
    before = r.next_before ?? null;
    if (!before) break;
  }
  if ((jobs?.jobs ?? []).length >= 100) notes.push("Only the latest 100 jobs are visible here; older results are found only if they are library files.");
  return { cards: buildCards({ jobs: jobs?.jobs ?? [], assets, collections: cols?.collections ?? [], posts: posts?.posts ?? [], accounts: social?.accounts ?? [] }), built_at: now, notes,
    connector_used: (jobs?.jobs ?? []).some((j: any) => j?.options?.via === "connector") };
}
