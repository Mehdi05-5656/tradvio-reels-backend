// The iMessage adapter (owner, Nov 24 2026: a managed line from Sendblue, AI Agent plan, people text first). The only
// file that knows Sendblue. Facts from docs.sendblue.com (read Nov 24 2026):
//   - auth headers sb-api-key-id / sb-api-secret-key; POST https://api.sendblue.com/api/send-message {number, from_number,
//     content, media_url}; replies within 24 h of the person's last message are unlimited; 10 sends a second per line;
//   - media must be a plain public link (signed links are refused): files are uploaded first (POST /api/upload-file,
//     multipart field "file", up to 100 MB) and the returned media_url is sent;
//   - the "receive" webhook posts {content, number, from_number, to_number, is_outbound, status, message_handle,
//     media_url, group_id, service, ...}; inbound has is_outbound false; message_handle is the id to dedupe on;
//   - the signing secret is sent as-is "in the request headers" (the header's name is not documented): any header whose
//     value is exactly the secret is accepted, compared in constant time;
//   - typing: POST /api/send-typing-indicator {number, from_number}.
// iMessage has no buttons: a question already says "Reply YES to go ahead, or NO."; a link button becomes a line with the link; a copy
// button is dropped (its text is in the message). Every message goes through the supplier-word guard, as on Telegram.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Button, Media, Transport } from "./brain.js";
import { BUTTON_LINK, guard } from "./guard.js";
import type { Incoming } from "./telegram.js";

const BASE = "https://api.sendblue.com";
const MAX = 3000; // long replies are split at a line, so each bubble stays readable

/** A Sendblue message handle as the inbox's number (the inbox is keyed by a number per channel). */
export function handleId(handle: string): number { return parseInt(createHash("sha256").update(handle).digest("hex").slice(0, 12), 16); }

/** A tapback ("Liked “…”") arrives as words on some setups: it is not something the person asked. */
const REACTION = /^(Liked|Loved|Emphasi[sz]ed|Laughed at|Questioned|Disliked|Reacted .{1,12} to)\s+[“"]/;
/** One inbound message in the common shape, or null for anything else: our own messages echoed back, statuses,
 *  groups, reactions, and anything that is not iMessage. Plain SMS is refused: an SMS sender's number can be faked,
 *  and the number is the only proof of who is texting (iMessage senders can't be faked that way). `line` is our own
 *  number: a message must be to it, and never from it. */
export function parseSendblue(p: any, line?: string): Incoming | null {
  if (!p || p.is_outbound === true || p.group_id || typeof p.message_handle !== "string") return null;
  if (p.status && !/^received$/i.test(String(p.status))) return null;
  if (!/^imessage$/i.test(String(p.service ?? ""))) return null;
  if (p.message_type && !/^(message|text)$/i.test(String(p.message_type))) return null;
  const from = String(p.from_number ?? p.number ?? "");
  if (!/^\+\d{7,15}$/.test(from)) return null;
  if (line && (from === line || (p.to_number && String(p.to_number) !== line))) return null;
  if (REACTION.test(String(p.content ?? ""))) return null;
  const media = typeof p.media_url === "string" && /^https:\/\//.test(p.media_url) ? p.media_url : null;
  return { update_id: handleId(p.message_handle), chat: from, from, name: mask(from), text: String(p.content ?? ""), message_id: null, private: true, has_file: !!p.media_url, ...(media ? { files: [{ url: media }] } : {}) };
}

/** "•••• 4567": how a number is shown in the app and the logs' handle column. */
export const mask = (n: string) => `•••• ${String(n).replace(/\D/g, "").slice(-4)}`;

/** The webhook came from Sendblue: some header carries exactly our secret. */
export function verifySendblue(headers: Record<string, unknown>, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const want = Buffer.from(secret);
  for (const v of Object.values(headers)) {
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s !== "string") continue;
      const got = Buffer.from(s.replace(/^Bearer\s+/i, "").trim());
      if (got.length === want.length && timingSafeEqual(got, want)) return true;
    }
  }
  return false;
}

export function pieces(text: string, max = MAX): string[] {
  const out: string[] = []; let rest = text;
  while (rest.length > max) { let i = rest.lastIndexOf("\n", max); if (i < max / 2) i = rest.lastIndexOf(" ", max); if (i < max / 2) i = max; out.push(rest.slice(0, i)); rest = rest.slice(i).trimStart(); }
  if (rest) out.push(rest);
  return out;
}

/** A link button as the line iMessage shows ("Open the app: https://…"); only links the bot's own code may send. */
export const linkLines = (buttons?: Button[]) => (buttons ?? []).filter((b): b is { label: string; url: string } => "url" in b && BUTTON_LINK(b.url) && !APART(b.url)).map((b) => `${b.label}: ${b.url}`);
/** Links that go alone in their own message, in order, after the text (long links read as a preview card that way). */
const APART = (url: string) => !/^https:\/\/app\.clone8\.io\//.test(url) || /[?&]ai=/.test(url);
export const apartLinks = (buttons?: Button[]) => (buttons ?? []).filter((b): b is { label: string; url: string } => "url" in b && BUTTON_LINK(b.url) && APART(b.url)).map((b) => b.url);
/** Buttons as text: links to Clone8 become a line; taps and copies are already in the words. */
export function withButtons(text: string, buttons?: Button[]): string {
  const links = linkLines(buttons);
  return links.length ? `${text}\n\n${links.join("\n")}` : text;
}

const EXT: Record<string, string> = { video: "mp4", photo: "jpg", audio: "m4a" };

export function sendblue(o: { keyId: string; secret: string; from: string; fetch?: typeof fetch; onGuard?: (hit: string, text: string) => void }) {
  const f = o.fetch ?? fetch;
  const auth = { "sb-api-key-id": o.keyId, "sb-api-secret-key": o.secret };
  // one send at a time with a short gap: the line takes 10 a second and refuses the rest
  let line: Promise<unknown> = Promise.resolve();
  const queued = <T,>(fn: () => Promise<T>): Promise<T> => { const p = line.then(fn); line = p.then(() => new Promise((r) => setTimeout(r, 150)), () => new Promise((r) => setTimeout(r, 150))); return p; };
  const call = async (path: string, body: Record<string, unknown> | FormData, timeoutMs = 60_000, retried = false): Promise<any> => {
    const form = body instanceof FormData;
    const r = await f(`${BASE}${path}`, { method: "POST", headers: form ? auth : { ...auth, "content-type": "application/json" }, body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    // too fast for the line: one wait and one more try (nothing was sent)
    if (r.status === 429 && !retried) { await new Promise((res) => setTimeout(res, 1500)); return call(path, body, timeoutMs, true); }
    const j: any = await r.json().catch(() => null);
    // (numbers are masked in the error: it goes to the server's log)
    if (!r.ok || /^(DECLINED|ERROR)$/i.test(String(j?.status ?? ""))) throw new Error(`sendblue_${path.split("/").pop()}_${r.status}: ${String(j?.error_message ?? j?.message ?? j?.error_key ?? "").replace(/\+?\d{7,15}/g, (x) => mask(x)).slice(0, 120)}`);
    return j;
  };
  const safe = (text: string, own?: string[]) => { const g = guard(text, own); if (g.hit) o.onGuard?.(g.hit, text); return g.text; };
  const sendText = (chat: string, text: string) => queued(() => call("/api/send-message", { number: chat, from_number: o.from, content: text }));
  const upload = async (m: Media): Promise<string> => {
    const form = new FormData();
    const ext = /\.[a-z0-9]{2,4}$/i.test(m.name) ? "" : `.${EXT[m.kind] ?? "bin"}`;
    form.set("file", new Blob([new Uint8Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength) as Uint8Array<ArrayBuffer>]), `${m.name}${ext}`);
    const j = await call("/api/upload-file", form, 300_000);
    if (typeof j?.media_url !== "string") throw new Error("sendblue_upload_no_url");
    return j.media_url;
  };
  const out: Transport = {
    async text(chat, text, buttons, own) {
      for (const p of pieces(safe(withButtons(text, buttons), own))) await sendText(chat, p);
      for (const u of apartLinks(buttons)) await sendText(chat, safe(u, own));
    },
    async media(chat, items, caption, buttons, own) {
      for (const m of items) {
        const url = await upload(m);
        await queued(() => call("/api/send-message", { number: chat, from_number: o.from, media_url: url }, 30_000));
      }
      const words = [caption, ...items.map((m) => m.caption).filter(Boolean)].filter(Boolean).join("\n");
      if (words || buttons?.length) await out.text(chat, words || "", buttons, own);
    },
    async typing(chat) { try { await call("/api/send-typing-indicator", { number: chat, from_number: o.from }, 10_000); } catch { /* typing is a nicety */ } },
  };
  /** Sends a file that is already public (the Clone8 contact card). */
  const sendUrl = (chat: string, url: string) => queued(() => call("/api/send-message", { number: chat, from_number: o.from, media_url: url }));
  // iMessage's own "Name & Photo" for the line (docs.sendblue.com/api-v2/contact-sharing): set once, then shared into
  // each chat, so the chat's header shows Clone8 and its logo instead of a number
  const get = async (path: string): Promise<any> => { const r = await f(`${BASE}${path}`, { headers: auth, signal: AbortSignal.timeout(20_000) }); const j: any = await r.json().catch(() => null); if (!r.ok) throw new Error(`sendblue_get_${r.status}`); return j; };
  /** The line's profile is Clone8 with the logo; written only when something differs. Returns what it did. */
  async function ensureProfile(name: string, photoUrl: string): Promise<"kept" | "set"> {
    const st = (await get(`/api/v2/contact-sharing/state?fromNumber=${encodeURIComponent(o.from)}`))?.data ?? {};
    if (st.hasProfile && st.sharingEnabled && st.firstName === name && !st.lastName && st.hasPhoto) return "kept";
    await call("/api/v2/contact-sharing/profile", { fromNumber: o.from, firstName: name, lastName: "", photoUrl }, 30_000);
    return "set";
  }
  /** Asks iMessage to show the profile in one chat (Sendblue ignores repeats within 24 hours; sends no text). */
  const share = (to: string) => call("/api/v2/contact-sharing/share", { fromNumber: o.from, toNumber: to }, 20_000);
  return { out, upload, sendUrl, ensureProfile, share };
}

/** Clone8's contact card: once saved, the chat shows "Clone8" and its logo instead of a number, and links preview.
 *  The logo rides inside the card (vCard 3.0 PHOTO, base64), folded at 75 characters as the format asks. */
export function contactCard(number: string, photoPng?: Buffer | null): string {
  const fold = (line: string) => line.length <= 75 ? line : [line.slice(0, 75), ...(line.slice(75).match(/.{1,74}/g) ?? []).map((x) => ` ${x}`)].join("\r\n");
  return ["BEGIN:VCARD", "VERSION:3.0", "N:;Clone8;;;", "FN:Clone8", "ORG:Clone8", `TEL;TYPE=CELL,VOICE,pref:${number}`, "URL:https://clone8.io",
    ...(photoPng?.length ? [fold(`PHOTO;ENCODING=b;TYPE=PNG:${photoPng.toString("base64")}`)] : []), "END:VCARD", ""].join("\r\n");
}
