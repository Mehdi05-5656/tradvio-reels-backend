// Client onboarding: pool a client's content into the vault, put their accounts on the formula, report progress.
//
// Intake: the operator hands in links (profiles, posts, Google Sheets, direct video links), small text files
// (CSV/TSV/TXT/PDF, base64 in the request) or large files uploaded straight to the private client-intake bucket.
// Every item becomes a row in client_intake_items and is worked by processIntake(): sheets and files are read for
// links, profiles are read for their top-performing posts (ScrapeCreators, about one credit a page), posts and
// videos are downloaded, hashed and stored as the client's library_sources. New sources are planned onto every
// account the client already has, so content keeps flowing after the first batch.
//
// Accounts: client_account_setup records which Publer account belongs to which client and the method chosen for
// it. Only blueprint_repost runs today; the other two are recorded as not available. Setting up an account runs the
// same ownership → plan → arm path the console already uses, with the client's batch size as the posting threshold.
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin, isOperator } from "./auth.js";
import { parseInstagram, parseTikTok, type LivePost } from "./live-metrics.js";
import { rendererStatus, scheduleAccount, validateSchedule } from "./ops-actions.js";

export type IntakeKind = "profile_instagram" | "profile_tiktok" | "post_instagram" | "post_tiktok" | "video_file" | "sheet" | "csv" | "pdf" | "text" | "link";
export type Classified = { kind: IntakeKind; value: string; label: string | null };
export const METHODS = { blueprint_repost: "Blueprint reposting", blueprint: "Blueprint", recast: "Recast" } as const;
export const AVAILABLE_METHODS = new Set<keyof typeof METHODS>(["blueprint_repost"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SC = "https://api.scrapecreators.com";
export const MAX_SOURCE_BYTES = 134217728;

// ---- Classifying what the operator pasted -------------------------------------------------------------
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "stories", "direct", "about", "developer", "legal", "privacy", "terms", "web", "share"]);
/** One link or handle → what it is. Returns null for blank input. Unknown links are kept as `link` and later skipped with a reason. */
export function classifyLink(raw: string): Classified | null {
  let s = String(raw ?? "").trim().replace(/^[<"'(\[]+|[>"')\],.;]+$/g, "");
  if (!s) return null;
  if (/^@[A-Za-z0-9._]{2,64}$/.test(s)) return { kind: "link", value: s, label: "handle without a platform" };
  if (!/^https?:\/\//i.test(s)) { if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = "https://" + s; else return { kind: "link", value: s.slice(0, 2048), label: null }; }
  let u: URL; try { u = new URL(s); } catch { return { kind: "link", value: s.slice(0, 2048), label: null }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, ""), parts = u.pathname.split("/").filter(Boolean);
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    const i = parts.findIndex((p) => ["reel", "reels", "p", "tv"].includes(p));
    if (i >= 0 && /^[A-Za-z0-9_-]{5,64}$/.test(parts[i + 1] ?? "")) return { kind: "post_instagram", value: `https://www.instagram.com/reel/${parts[i + 1]}/`, label: parts[i + 1] };
    if (parts[0] && /^[A-Za-z0-9._]{1,64}$/.test(parts[0]) && !IG_RESERVED.has(parts[0].toLowerCase())) return { kind: "profile_instagram", value: parts[0].toLowerCase(), label: `@${parts[0].toLowerCase()}` };
    return { kind: "link", value: s.slice(0, 2048), label: null };
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    const m = u.pathname.match(/^\/@([A-Za-z0-9._]{1,64})\/video\/(\d{5,30})/);
    if (m) return { kind: "post_tiktok", value: `https://www.tiktok.com/@${m[1]}/video/${m[2]}`, label: m[2] };
    if (host === "vm.tiktok.com" || parts[0] === "t") return { kind: "post_tiktok", value: s.replace(/\/+$/, "").slice(0, 2048), label: "short link" };
    const p = u.pathname.match(/^\/@([A-Za-z0-9._]{1,64})\/?$/);
    if (p) return { kind: "profile_tiktok", value: p[1].toLowerCase(), label: `@${p[1].toLowerCase()}` };
    return { kind: "link", value: s.slice(0, 2048), label: null };
  }
  if (host === "docs.google.com" && /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.test(u.pathname)) {
    const id = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)![1];
    const gid = u.searchParams.get("gid") ?? (u.hash.match(/gid=(\d+)/)?.[1] ?? null);
    return { kind: "sheet", value: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`, label: `sheet ${id.slice(0, 8)}…` };
  }
  const ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "").toLowerCase();
  if (["csv", "tsv", "txt"].includes(ext)) return { kind: "csv", value: s.slice(0, 2048), label: parts[parts.length - 1] ?? null };
  if (ext === "pdf") return { kind: "pdf", value: s.slice(0, 2048), label: parts[parts.length - 1] ?? null };
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return { kind: "video_file", value: s.slice(0, 2048), label: parts[parts.length - 1] ?? null };
  return { kind: "link", value: s.slice(0, 2048), label: null };
}

/** Every link or platform handle in a blob of text (a pasted list, a CSV, a sheet export, a PDF's text). Deduplicated, order kept. */
export function extractFromText(text: string, max = 2000): Classified[] {
  const out: Classified[] = [], seen = new Set<string>();
  const push = (c: Classified | null) => { if (!c) return; const k = `${c.kind}|${c.value}`; if (seen.has(k) || out.length >= max) return; seen.add(k); out.push(c); };
  const src = String(text ?? "");
  for (const m of src.matchAll(/https?:\/\/[^\s"'<>()\[\],]+/gi)) push(classifyLink(m[0]));
  for (const m of src.matchAll(/(?<![\w/@.])(?:www\.)?(instagram\.com|tiktok\.com|vm\.tiktok\.com|docs\.google\.com)\/[^\s"'<>()\[\],]+/gi)) push(classifyLink(m[0]));
  // "@handle" on a line that names the platform.
  for (const line of src.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    const platform = /tiktok/.test(lower) ? "profile_tiktok" : /instagram|\big\b|insta\b/.test(lower) ? "profile_instagram" : null;
    if (!platform) continue;
    for (const m of line.matchAll(/(?<![\w/.])@([A-Za-z0-9._]{2,64})/g)) push({ kind: platform, value: m[1].toLowerCase(), label: `@${m[1].toLowerCase()}` });
  }
  return out;
}

/** The best posts of a profile: by views, pinned ones never jump the line, ties by recency. */
export function pickTopPosts(posts: LivePost[], n: number): LivePost[] {
  const seen = new Set<string>();
  return posts.filter((p) => { if (seen.has(p.platform_post_id)) return false; seen.add(p.platform_post_id); return true; })
    .sort((a, b) => (b.video_views ?? -1) - (a.video_views ?? -1) || String(b.posted_at ?? "").localeCompare(String(a.posted_at ?? "")))
    .slice(0, Math.max(1, n));
}

/** Where to download a TikTok video from a /v2/tiktok/video answer: the watermark-free file when offered, else the plain play file. */
export function tiktokMediaUrl(body: any): string | null {
  const v = body?.aweme_detail?.video ?? body?.data?.aweme_detail?.video ?? null;
  if (!v) return null;
  const first = (x: any) => (Array.isArray(x?.url_list) && typeof x.url_list[0] === "string" ? x.url_list[0] : null);
  return first(v.download_no_watermark_addr) ?? (v.has_watermark === false ? first(v.play_addr) : null) ?? first(v.play_addr) ?? first(v.download_addr) ?? null;
}
export function instagramMediaUrl(body: any): string | null {
  const d = body?.data ?? body ?? {};
  const cands = [d.video_url, d.xdt_shortcode_media?.video_url, d.video_versions?.[0]?.url, d.items?.[0]?.video_versions?.[0]?.url];
  return cands.find((x) => typeof x === "string" && /^https?:\/\//.test(x)) ?? null;
}

/** Hours until an account's pending variants are rendered, from the renderer's recent rate; null when nothing is pending or the renderer is idle. */
export function etaHours(pendingAhead: number, ratePerHour: number): number | null {
  if (pendingAhead <= 0) return 0;
  if (!(ratePerHour > 0)) return null;
  return Math.round((pendingAhead / ratePerHour) * 10) / 10;
}

// ---- Processing --------------------------------------------------------------------------------------
export type Deps = { fetch?: typeof fetch; apiKey?: string; now?: () => Date; pdfText?: (buf: Buffer) => Promise<string>; log?: (s: string) => void };
type Item = { id: string; batch_id: string; org_id: string; kind: IntakeKind; value: string; label: string | null; parent_id: string | null; status: string; meta: any; attempts: number };

async function fetchBuffer(f: typeof fetch, url: string, max = MAX_SOURCE_BYTES, timeoutMs = 180_000): Promise<Buffer> {
  const r = await f(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!r.ok) throw new Error(`download_http_${r.status}`);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > max) throw new Error("file_too_large");
  const ab = await r.arrayBuffer();
  if (ab.byteLength > max) throw new Error("file_too_large");
  if (!ab.byteLength) throw new Error("empty_download");
  return Buffer.from(ab);
}
async function scGet(f: typeof fetch, key: string, path: string) {
  const r = await f(`${SC}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(45_000) });
  if (r.status === 402) throw new Error("scrapecreators_credits_exhausted");
  if (!r.ok) throw new Error(`scrapecreators_http_${r.status}`);
  const body: any = await r.json();
  if (body && body.success === false) throw new Error("scrapecreators_unsuccessful");
  return body;
}
async function readStorage(sb: SupabaseClient, bucket: string, key: string): Promise<Buffer> {
  const r = await sb.storage.from(bucket).download(key);
  if (r.error || !r.data) throw new Error(`storage_read_failed`);
  return Buffer.from(await r.data.arrayBuffer());
}
const isStorageKey = (v: string) => v.startsWith("client-intake/");

async function defaultPdfText(buf: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  const parse = mod.default ?? mod;
  const out = await parse(buf);
  return String(out?.text ?? "");
}

/** Reads the item's bytes: a storage key in the intake bucket, or a public URL. */
async function itemBytes(sb: SupabaseClient, f: typeof fetch, item: Item, max: number): Promise<Buffer> {
  return isStorageKey(item.value) ? readStorage(sb, "client-intake", item.value.replace(/^client-intake\//, "")) : fetchBuffer(f, item.value, max);
}

async function addChildren(sb: SupabaseClient, item: Item, found: Classified[]): Promise<number> {
  const wanted = found.filter((c) => c.kind !== "link");
  if (!wanted.length) return 0;
  const existing = await sb.from("client_intake_items").select("kind,value").eq("org_id", item.org_id).in("value", wanted.map((c) => c.value));
  if (existing.error) throw existing.error;
  const have = new Set((existing.data ?? []).map((r: any) => `${r.kind}|${r.value}`));
  const rows = wanted.filter((c) => !have.has(`${c.kind}|${c.value}`)).map((c) => ({ batch_id: item.batch_id, org_id: item.org_id, kind: c.kind, value: c.value, label: c.label, parent_id: item.id }));
  if (!rows.length) return 0;
  const ins = await sb.from("client_intake_items").insert(rows);
  if (ins.error) throw ins.error;
  return rows.length;
}

/** Stores a downloaded video as one of the client's library sources. Same file twice in one client is a no-op; the same file in another client is refused. */
async function saveSource(sb: SupabaseClient, item: Item, bytes: Buffer, extra: Record<string, unknown>): Promise<{ sha256: string; created: boolean }> {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("file_too_large");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object_key = `originals/${sha256}.mp4`;
  const cur = await sb.from("library_sources").select("sha256,org_id").eq("sha256", sha256).maybeSingle();
  if (cur.error) throw cur.error;
  if (cur.data) {
    if (cur.data.org_id && cur.data.org_id !== item.org_id) throw new Error("already_in_another_client_library");
    return { sha256, created: false };
  }
  const up = await sb.storage.from("managed-raw").upload(object_key, bytes, { contentType: "video/mp4", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`storage_write_failed: ${up.error.message}`);
  const priorViews = Number(item.meta?.views);
  const source = { bytes: bytes.length, sha256, object_key, duration: null, provenance: `Client intake ${item.batch_id}; item ${item.id}; ${String(extra.provenance ?? item.kind)}`, intake_item_id: item.id, prior_views: Number.isFinite(priorViews) && priorViews > 0 ? Math.round(priorViews) : null, ...extra };
  delete (source as any).provenance_extra;
  const ins = await sb.from("library_sources").insert({ sha256, source, enabled: true, org_id: item.org_id });
  if (ins.error) throw ins.error;
  return { sha256, created: true };
}

/** Plans the client's newest sources onto every account it already runs. Returns variants added. */
export async function planNewSources(sb: SupabaseClient, orgId: string, log: (s: string) => void = () => {}): Promise<number> {
  const setups = await sb.from("client_account_setup").select("publer_account_id,status").eq("org_id", orgId).in("status", ["rendering", "scheduling", "posting"]);
  if (setups.error) throw setups.error;
  if (!setups.data?.length) return 0;
  const own = await sb.from("publer_account_ownership").select("publer_account_id,owner_user_id").in("publer_account_id", setups.data.map((s: any) => s.publer_account_id));
  if (own.error) throw own.error;
  let total = 0;
  for (const o of own.data ?? []) {
    const r = await sb.rpc("library_plan", { p_actor: o.owner_user_id, p_account: o.publer_account_id });
    if (r.error) { log(`[intake] plan ${o.publer_account_id}: ${r.error.message}`); continue; }
    total += Number(r.data ?? 0);
  }
  return total;
}

let working = false;
/** Works queued intake items, oldest first, a few per call. Safe to call often; overlapping calls return at once. */
export async function processIntake(sb: SupabaseClient, deps: Deps = {}, limit = 4): Promise<number> {
  if (working) return 0;
  working = true;
  const f = deps.fetch ?? fetch, key = deps.apiKey ?? process.env.SCRAPECREATORS_API_KEY ?? "", log = deps.log ?? ((s) => console.log(s)), pdfText = deps.pdfText ?? defaultPdfText;
  let done = 0;
  try {
    const q = await sb.from("client_intake_items").select("*").eq("status", "queued").lt("attempts", 3).order("created_at").limit(limit);
    if (q.error) throw q.error;
    const touchedOrgs = new Set<string>();
    for (const item of (q.data ?? []) as Item[]) {
      const set = async (patch: Record<string, unknown>) => { const r = await sb.from("client_intake_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", item.id); if (r.error) throw r.error; };
      await set({ status: "working", attempts: item.attempts + 1 });
      try {
        const batch = await sb.from("client_intake_batches").select("top_n").eq("id", item.batch_id).maybeSingle();
        const topN = Number(batch.data?.top_n ?? 30);
        if (item.kind === "csv" || item.kind === "text" || item.kind === "sheet" || item.kind === "pdf") {
          const bytes = await itemBytes(sb, f, item, 25 * 1024 * 1024);
          const text = item.kind === "pdf" ? await pdfText(bytes) : bytes.toString("utf8");
          const found = extractFromText(text);
          const added = await addChildren(sb, item, found);
          await set({ status: "saved", error: null, meta: { ...item.meta, found: found.length, added, unsupported: found.filter((c) => c.kind === "link").length } });
        } else if (item.kind === "profile_instagram" || item.kind === "profile_tiktok") {
          if (!key) throw new Error("scrapecreators_key_missing");
          const ig = item.kind === "profile_instagram";
          let cursor: string | null = null, posts: LivePost[] = [];
          for (let page = 0; page < (ig ? 8 : 4) && posts.length < topN * 2; page++) {
            const body = await scGet(f, key, ig ? `/v2/instagram/user/posts?handle=${encodeURIComponent(item.value)}${cursor ? `&next_max_id=${encodeURIComponent(cursor)}` : ""}` : `/v3/tiktok/profile/videos?handle=${encodeURIComponent(item.value)}${cursor ? `&max_cursor=${encodeURIComponent(cursor)}` : ""}`);
            const parsed = ig ? parseInstagram(body) : parseTikTok(body, item.value);
            posts = posts.concat(parsed.posts);
            if (!parsed.next || !parsed.posts.length) break;
            cursor = parsed.next;
          }
          const top = pickTopPosts(posts, topN);
          const added = await addChildren(sb, item, top.map((p) => ({ kind: ig ? "post_instagram" : "post_tiktok", value: p.post_link, label: p.caption ? p.caption.slice(0, 80) : p.platform_post_id })));
          const metaRows = await sb.from("client_intake_items").select("id,value").eq("org_id", item.org_id).eq("parent_id", item.id);
          for (const r of metaRows.data ?? []) { const p = top.find((t) => t.post_link === r.value); if (p) await sb.from("client_intake_items").update({ meta: { views: p.video_views, likes: p.likes, posted_at: p.posted_at, caption: p.caption, source_video_id: p.platform_post_id, source_handle: item.value } }).eq("id", r.id); }
          await set({ status: "saved", error: null, meta: { ...item.meta, scanned: posts.length, picked: top.length, added } });
        } else if (item.kind === "post_instagram" || item.kind === "post_tiktok") {
          if (!key) throw new Error("scrapecreators_key_missing");
          const ig = item.kind === "post_instagram";
          const body = await scGet(f, key, ig ? `/v1/instagram/post?url=${encodeURIComponent(item.value)}` : `/v2/tiktok/video?url=${encodeURIComponent(item.value)}`);
          const media = ig ? instagramMediaUrl(body) : tiktokMediaUrl(body);
          if (!media) throw new Error("no_video_in_post");
          const bytes = await fetchBuffer(f, media);
          const vid = ig ? (item.value.match(/\/reel\/([^/]+)\//)?.[1] ?? null) : (item.value.match(/\/video\/(\d+)/)?.[1] ?? body?.aweme_detail?.aweme_id ?? null);
          const handle = item.meta?.source_handle ?? (ig ? (body?.data?.owner?.username ?? body?.data?.user?.username ?? null) : (body?.aweme_detail?.author?.unique_id ?? null));
          const saved = await saveSource(sb, item, bytes, { source_handle: handle, source_video_id: vid, provenance: `${ig ? "Instagram" : "TikTok"} post ${item.value}` });
          touchedOrgs.add(item.org_id);
          await set({ status: "saved", error: null, sha256: saved.sha256, meta: { ...item.meta, bytes: bytes.length, new_source: saved.created } });
        } else if (item.kind === "video_file") {
          const bytes = await itemBytes(sb, f, item, MAX_SOURCE_BYTES);
          const saved = await saveSource(sb, item, bytes, { source_handle: null, source_video_id: null, provenance: `Uploaded file ${item.label ?? ""}`.trim() });
          touchedOrgs.add(item.org_id);
          await set({ status: "saved", error: null, sha256: saved.sha256, meta: { ...item.meta, bytes: bytes.length, new_source: saved.created } });
        } else {
          await set({ status: "skipped", error: "not a supported source (Instagram, TikTok, Google Sheets, CSV, PDF or a video file)" });
        }
        done++;
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        const permanent = /already_in_another_client_library|no_video_in_post|file_too_large|not a supported/.test(msg) || item.attempts + 1 >= 3;
        await set({ status: permanent ? "failed" : "queued", error: msg });
        log(`[intake] ${item.kind} ${item.id}: ${msg}`);
      }
    }
    for (const org of touchedOrgs) { try { const n = await planNewSources(sb, org, log); if (n) log(`[intake] planned ${n} variants for ${org}`); } catch (e: any) { log(`[intake] plan ${org}: ${e?.message ?? e}`); } }
  } finally { working = false; }
  return done;
}

/** Runs processIntake on a timer. The web service is a single instance, so one loop is enough. */
export function startIntakeLoop(sbFn: () => SupabaseClient, intervalMs = 30_000): NodeJS.Timeout {
  const tick = () => processIntake(sbFn()).catch((e) => console.warn("[intake]", e?.message ?? e));
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000);
  return t;
}

// ---- Routes -------------------------------------------------------------------------------------------
const parseDataUrl = (s: unknown, maxBytes: number) => {
  if (typeof s !== "string") return null;
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s); if (!m) return null;
  const bytes = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  return bytes.length && bytes.length <= maxBytes ? { mime: m[1], bytes } : null;
};
const kindForFile = (name: string, mime: string): IntakeKind | null => {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] ?? "");
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["csv", "tsv", "txt", "md"].includes(ext) || /^text\//.test(mime)) return "csv";
  if (["mp4", "mov", "m4v", "webm"].includes(ext) || /^video\//.test(mime)) return "video_file";
  return null;
};
const safeName = (s: string) => String(s ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

export function registerClientOnboarding(app: Express, sbFn: () => SupabaseClient, deps: Deps = {}): void {
  const requireAdmin = (req: Request, res: Response) => { if (isAdmin(req)) return false; res.status(403).json({ error: "forbidden" }); return true; };
  const requireOperator = (req: Request, res: Response) => { if (isOperator(req)) return false; res.status(403).json({ error: "operator_required" }); return true; };
  const actor = (req: Request) => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => res.status(503).json({ error: "onboarding_unavailable", detail: String(e?.message ?? e).slice(0, 200) });
  const loadOrg = async (sb: SupabaseClient, id: string) => { if (!UUID_RE.test(id)) return null; const r = await sb.from("client_orgs").select("id,name,slug,archived_at,caption_templates").eq("id", id).maybeSingle(); if (r.error) throw r.error; return r.data; };

  // Everything the onboarding screen shows: intake history, each account's place in the pipeline, renderer pace.
  app.get("/api/ops/clients/:id/onboarding", async (req, res) => {
    if (requireAdmin(req, res)) return;
    try {
      const sb = sbFn(), now = deps.now?.() ?? new Date();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const [batches, items, setups, sources, renderer] = await Promise.all([
        sb.from("client_intake_batches").select("*").eq("org_id", org.id).order("created_at", { ascending: false }).limit(30),
        sb.from("client_intake_items").select("id,batch_id,kind,value,label,parent_id,status,error,meta,sha256,attempts,created_at,updated_at").eq("org_id", org.id).order("created_at", { ascending: false }).limit(400),
        sb.from("client_account_setup").select("*").eq("org_id", org.id).order("created_at"),
        sb.from("library_sources").select("sha256", { count: "exact", head: true }).eq("org_id", org.id).eq("enabled", true),
        rendererStatus(sb, now).catch(() => null),
      ]);
      for (const r of [batches, items, setups]) if (r.error) throw r.error;
      const ids = (setups.data ?? []).map((s: any) => s.publer_account_id);
      const accounts: any[] = [];
      if (ids.length) {
        const [variants, slots, firstPosts, queue] = await Promise.all([
          sb.from("library_variants").select("account_id,state").in("account_id", ids),
          sb.from("publer_slot_config").select("phone_slot,publer_account_id,paused,daily_target,publish_after").in("publer_account_id", ids),
          sb.from("publer_publish_log").select("phone_slot,attempted_at").eq("status", "published").in("phone_slot", ids.map((i: string) => `library_${i}`)).order("attempted_at").limit(1000),
          sb.from("reels_manual_queue").select("phone_slot,status").in("phone_slot", ids.map((i: string) => `library_${i}`)),
        ]);
        for (const r of [variants, slots, firstPosts, queue]) if (r.error) throw r.error;
        const rate = renderer?.rate_per_hour ?? 0, pendingAll = renderer?.pending ?? 0;
        for (const s of setups.data ?? []) {
          const v = (variants.data ?? []).filter((x: any) => x.account_id === s.publer_account_id);
          const count = (st: string) => v.filter((x: any) => x.state === st).length;
          const slot = (slots.data ?? []).find((x: any) => x.publer_account_id === s.publer_account_id) ?? null;
          const first = (firstPosts.data ?? []).find((x: any) => x.phone_slot === `library_${s.publer_account_id}`) ?? null;
          const posted = (firstPosts.data ?? []).filter((x: any) => x.phone_slot === `library_${s.publer_account_id}`).length;
          const queued = (queue.data ?? []).filter((x: any) => x.phone_slot === `library_${s.publer_account_id}` && x.status === "pending").length;
          const rendered = count("rendered_private"), pending = count("pending") + count("running");
          const stage = first ? "posting" : slot ? "scheduling" : rendered >= s.batch_size ? "ready" : v.length ? "rendering" : "waiting_for_content";
          accounts.push({ ...s, stage, variants: { total: v.length, rendered, pending, blocked: count("blocked") }, batch_progress: Math.min(1, rendered / s.batch_size), eta_hours: etaHours(Math.min(pending, pendingAll || pending), rate), slot: slot ? { phone_slot: slot.phone_slot, paused: slot.paused, publish_after: slot.publish_after } : null, queued, posted, first_posted_at: first?.attempted_at ?? null });
        }
      }
      res.set("Cache-Control", "private, no-store").json({ client: { id: org.id, name: org.name, slug: org.slug, caption_templates: org.caption_templates ?? [] }, sources: sources.count ?? 0, batches: batches.data ?? [], items: items.data ?? [], accounts, renderer: renderer ? { rate_per_hour: renderer.rate_per_hour, pending: renderer.pending, running: renderer.running } : null, methods: Object.entries(METHODS).map(([id, label]) => ({ id, label, available: AVAILABLE_METHODS.has(id as any) })) });
    } catch (e) { fail(res, e); }
  });

  // Hand in content: links/text, small files inline, and large files already uploaded to the intake bucket.
  app.post("/api/ops/clients/:id/intake", async (req, res) => {
    if (requireOperator(req, res)) return;
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      if (org.archived_at) return res.status(409).json({ error: "client_archived" });
      const body = req.body ?? {};
      const topN = Number.isInteger(Number(body.top_n)) && Number(body.top_n) >= 1 && Number(body.top_n) <= 200 ? Number(body.top_n) : 30;
      const rows: Array<{ kind: IntakeKind; value: string; label: string | null; meta?: any }> = [];
      const text = [Array.isArray(body.links) ? body.links.filter((x: any) => typeof x === "string").join("\n") : "", typeof body.text === "string" ? body.text : ""].join("\n");
      for (const c of extractFromText(text, 500)) rows.push(c);
      for (const line of text.split(/\r?\n/)) { const c = classifyLink(line); if (c && c.kind === "link" && !rows.some((r) => r.value === c.value)) rows.push(c); }
      for (const fl of Array.isArray(body.files) ? body.files.slice(0, 20) : []) {
        const kind = kindForFile(String(fl?.name ?? ""), String(fl?.type ?? ""));
        const data = parseDataUrl(fl?.data_url, 3.5 * 1024 * 1024);
        if (!kind || !data) return res.status(400).json({ error: "invalid_file", detail: `${fl?.name ?? "file"}: csv, tsv, txt, pdf or a video, at most 3.5 MB inline (larger files go through the upload URL)` });
        const key = `${org.id}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${safeName(fl.name)}`;
        const up = await sb.storage.from("client-intake").upload(key, data.bytes, { contentType: data.mime, upsert: false });
        if (up.error) throw up.error;
        rows.push({ kind, value: `client-intake/${key}`, label: String(fl.name).slice(0, 200), meta: { bytes: data.bytes.length, mime: data.mime } });
      }
      for (const u of Array.isArray(body.uploads) ? body.uploads.slice(0, 50) : []) {
        const key = String(u?.key ?? ""), name = String(u?.name ?? key.split("/").pop() ?? "file");
        if (!key.startsWith(`${org.id}/`) || key.includes("..")) return res.status(400).json({ error: "invalid_upload_key" });
        const kind = kindForFile(name, String(u?.type ?? ""));
        if (!kind) return res.status(400).json({ error: "invalid_file", detail: name });
        rows.push({ kind, value: `client-intake/${key}`, label: name.slice(0, 200), meta: { bytes: Number(u?.size ?? 0) || null } });
      }
      if (!rows.length) return res.status(400).json({ error: "nothing_to_pool", detail: "Paste links or add a file" });
      const batch = await sb.from("client_intake_batches").insert({ org_id: org.id, created_by: actor(req), top_n: topN, note: typeof body.note === "string" ? body.note.slice(0, 500) : null }).select("*").single();
      if (batch.error) throw batch.error;
      const existing = await sb.from("client_intake_items").select("kind,value").eq("org_id", org.id).in("value", rows.map((r) => r.value));
      const have = new Set((existing.data ?? []).map((r: any) => `${r.kind}|${r.value}`));
      const fresh = rows.filter((r) => !have.has(`${r.kind}|${r.value}`));
      const ins = fresh.length ? await sb.from("client_intake_items").insert(fresh.map((r) => ({ batch_id: batch.data.id, org_id: org.id, kind: r.kind, value: r.value, label: r.label, meta: r.meta ?? {} }))).select("*") : { data: [], error: null };
      if (ins.error) throw ins.error;
      setTimeout(() => processIntake(sb, deps).catch(() => {}), 50);
      res.status(201).json({ batch: batch.data, items: ins.data ?? [], duplicates: rows.length - fresh.length });
    } catch (e) { fail(res, e); }
  });

  // A signed upload URL for a large file (video, big PDF); the browser puts the bytes straight into the private bucket.
  app.post("/api/ops/clients/:id/intake/upload-url", async (req, res) => {
    if (requireOperator(req, res)) return;
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const name = safeName(req.body?.name), size = Number(req.body?.size ?? 0);
      if (!kindForFile(name, String(req.body?.type ?? ""))) return res.status(400).json({ error: "invalid_file" });
      if (!(size > 0 && size <= 268435456)) return res.status(400).json({ error: "file_too_large", detail: "at most 256 MB" });
      const key = `${org.id}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`;
      const signed = await sb.storage.from("client-intake").createSignedUploadUrl(key);
      if (signed.error || !signed.data) throw signed.error ?? new Error("signing_failed");
      res.json({ key, token: signed.data.token, path: signed.data.path, bucket: "client-intake" });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/ops/clients/:id/intake/items/:itemId/retry", async (req, res) => {
    if (requireOperator(req, res)) return;
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.itemId)) return res.status(404).json({ error: "item_not_found" });
    try {
      const sb = sbFn();
      const r = await sb.from("client_intake_items").update({ status: "queued", error: null, attempts: 0, updated_at: new Date().toISOString() }).eq("id", req.params.itemId).eq("org_id", req.params.id).in("status", ["failed", "skipped"]).select("id").maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return res.status(404).json({ error: "item_not_found" });
      setTimeout(() => processIntake(sb, deps).catch(() => {}), 50);
      res.json({ queued: r.data.id });
    } catch (e) { fail(res, e); }
  });

  // Put a Publer account on the formula for this client. Only blueprint_repost runs today.
  app.post("/api/ops/clients/:id/accounts/setup", async (req, res) => {
    if (requireOperator(req, res)) return;
    const uid = actor(req);
    if (!uid) return res.status(401).json({ error: "unauthorized" });
    const method = String(req.body?.method ?? "blueprint_repost");
    if (!(method in METHODS)) return res.status(400).json({ error: "invalid_method" });
    if (!AVAILABLE_METHODS.has(method as any)) return res.status(409).json({ error: "method_not_available", detail: `${METHODS[method as keyof typeof METHODS]} is not available yet` });
    const batch = Number(req.body?.batch_size ?? 25);
    if (!Number.isInteger(batch) || batch < 3 || batch > 30) return res.status(400).json({ error: "invalid_batch_size" });
    const v = validateSchedule(req.body, deps.now?.() ?? new Date());
    if (v.ok === false) return res.status(400).json({ error: v.error });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      if (org.archived_at) return res.status(409).json({ error: "client_archived" });
      const taken = await sb.from("client_account_setup").select("org_id").eq("publer_account_id", v.value.publer_account_id).maybeSingle();
      if (taken.error) throw taken.error;
      if (taken.data && taken.data.org_id !== org.id) return res.status(409).json({ error: "account_belongs_to_another_client" });
      const up = await sb.from("client_account_setup").upsert({ org_id: org.id, publer_account_id: v.value.publer_account_id, platform: v.value.platform, label: v.value.label, method, daily_target: v.value.daily_target, batch_size: batch, status: "planned", start_at: v.value.start, created_by: uid, updated_at: new Date().toISOString() }, { onConflict: "publer_account_id" }).select("*").single();
      if (up.error) throw up.error;
      let result: any = null, error: string | null = null;
      try { result = await scheduleAccount(sb, uid, v.value, typeof req.body?.gate_account === "string" ? req.body.gate_account : null, deps.now?.() ?? new Date(), batch); }
      catch (e: any) { error = String(e?.message ?? e).slice(0, 300); }
      const status = error ? "failed" : "rendering";
      await sb.from("client_account_setup").update({ status, updated_at: new Date().toISOString() }).eq("publer_account_id", v.value.publer_account_id);
      if (error) return res.status(409).json({ error: "setup_failed", detail: error, setup: { ...up.data, status } });
      res.status(201).json({ setup: { ...up.data, status }, schedule: result });
    } catch (e) { fail(res, e); }
  });

  // Caption templates the publisher uses for this client (A/B when there are two or more).
  app.put("/api/ops/clients/:id/captions", async (req, res) => {
    if (requireOperator(req, res)) return;
    const t = req.body?.templates;
    if (!Array.isArray(t) || t.length > 20 || !t.every((x: any) => typeof x === "string" && x.trim().length >= 3 && x.length <= 2200)) return res.status(400).json({ error: "invalid_templates" });
    try {
      const sb = sbFn();
      const org = await loadOrg(sb, req.params.id);
      if (!org) return res.status(404).json({ error: "client_not_found" });
      const r = await sb.from("client_orgs").update({ caption_templates: t.map((x: string) => x.trim()), updated_at: new Date().toISOString() }).eq("id", org.id).select("id,caption_templates").single();
      if (r.error) throw r.error;
      res.json({ client_id: r.data.id, caption_templates: r.data.caption_templates });
    } catch (e) { fail(res, e); }
  });
}
