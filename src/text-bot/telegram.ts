// The Telegram adapter (PLAN.md section 1): the only file that knows the channel. It pulls updates (long polling: no
// webhook, nothing to deploy), turns each into one common shape, and sends text, pictures, videos, sound and buttons.
// Files are uploaded as bytes, never passed as links, so no storage address ever reaches the chat.
import type { Button, Media, Transport } from "./brain.js";
import { BUTTON_LINK, guard } from "./guard.js";
import type { InFile } from "./intake.js";

export type Incoming = { update_id: number; chat: string; from: string; name: string; text: string; message_id: number | null; callback_id?: string; private: boolean; has_file?: boolean;
  /** files that came with it (src/text-bot/intake.ts takes them into the library) */ files?: InFile[] };
type Btn = Button;
// (links only to Clone8's own app and the fixed AI-app links; a copy button puts its text on the person's clipboard)
const button = (b: Btn) => "copy" in b ? { text: b.label.slice(0, 40), copy_text: { text: b.copy.slice(0, 256) } }
  : "url" in b ? (BUTTON_LINK(b.url) ? { text: b.label.slice(0, 40), url: b.url } : null)
  : { text: b.label.slice(0, 40), callback_data: b.data.slice(0, 64) };
const keyboard = (buttons?: Btn[]) => { const row = (buttons ?? []).map(button).filter(Boolean); return row.length ? { inline_keyboard: chunk(row, 5) } : undefined; };
const chunk = <T>(xs: T[], n: number): T[][] => xs.reduce<T[][]>((rows, x, i) => { if (i % n === 0) rows.push([]); rows[rows.length - 1].push(x); return rows; }, []);
/** Telegram takes 4096 characters a message; long replies are cut at a line. */
export function pieces(text: string, max = 3900): string[] {
  const out: string[] = []; let rest = text;
  while (rest.length > max) { let i = rest.lastIndexOf("\n", max); if (i < max / 2) i = rest.lastIndexOf(" ", max); if (i < max / 2) i = max; out.push(rest.slice(0, i)); rest = rest.slice(i).trimStart(); }
  if (rest) out.push(rest);
  return out;
}

export function parseUpdate(u: any): Incoming | null {
  if (u?.callback_query) { const c = u.callback_query, m = c.message; return { update_id: u.update_id, chat: String(m?.chat?.id ?? c.from?.id), from: String(c.from?.id), name: String(c.from?.username ?? c.from?.first_name ?? ""), text: String(c.data ?? ""), message_id: m?.message_id ?? null, callback_id: String(c.id), private: (m?.chat?.type ?? "private") === "private" }; }
  const m = u?.message; if (!m) return null;
  return { update_id: u.update_id, chat: String(m.chat?.id), from: String(m.from?.id), name: String(m.from?.username ?? m.from?.first_name ?? ""), text: String(m.text ?? m.caption ?? ""), message_id: m.message_id ?? null, private: m.chat?.type === "private", has_file: !!(m.video || m.document || m.photo || m.voice || m.audio || m.animation), ...(filesOf(m).length ? { files: filesOf(m) } : {}) };
}
/** A message's video or picture as a file to take in (the largest size of a photo); voice notes and audio are not. */
export function filesOf(m: any): InFile[] {
  const one = (x: any, mime?: string) => (x?.file_id ? [{ file_id: String(x.file_id), name: x.file_name ? String(x.file_name) : undefined, mime: String(x.mime_type ?? mime ?? ""), size: Number(x.file_size) || undefined }] : []);
  if (m?.video) return one(m.video, "video/mp4");
  if (m?.animation) return one(m.animation, "video/mp4");
  if (Array.isArray(m?.photo) && m.photo.length) return one(m.photo[m.photo.length - 1], "image/jpeg");
  if (m?.document && /^(video|image)\//.test(String(m.document.mime_type ?? ""))) return one(m.document);
  return [];
}

/** the file's bytes without another copy (a Blob makes its own) */
const view = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as Uint8Array<ArrayBuffer>;

export function telegram(token: string, deps: { fetch?: typeof fetch; onGuard?: (hit: string, text: string) => void } = {}) {
  const f = deps.fetch ?? fetch, base = `https://api.telegram.org/bot${token}`;
  const call = async (method: string, body: Record<string, unknown> | FormData, timeoutMs = 60_000): Promise<any> => {
    const form = body instanceof FormData;
    const r = await f(`${base}/${method}`, { method: "POST", ...(form ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const j: any = await r.json().catch(() => null);
    if (!j?.ok) throw new Error(`telegram_${method}_${r.status}: ${String(j?.description ?? "").slice(0, 120)}`);
    return j.result;
  };
  const safe = (text: string, own?: string[]) => { const g = guard(text, own); if (g.hit) deps.onGuard?.(g.hit, text); return g.text; };
  const out: Transport = {
    async text(chat, text, buttons, own) {
      const parts = pieces(safe(text, own));
      for (const [i, p] of parts.entries()) await call("sendMessage", { chat_id: chat, text: p, link_preview_options: { is_disabled: true }, ...(i === parts.length - 1 && buttons?.length ? { reply_markup: keyboard(buttons) } : {}) });
    },
    async media(chat, items, caption, buttons, own) {
      const photos = items.filter((m) => m.kind === "photo"), others = items.filter((m) => m.kind !== "photo");
      if (caption && (photos.length > 1 || !items.length)) await call("sendMessage", { chat_id: chat, text: safe(caption, own) });
      if (photos.length > 1) {
        const form = new FormData(); form.set("chat_id", chat);
        form.set("media", JSON.stringify(photos.slice(0, 10).map((p, i) => ({ type: "photo", media: `attach://p${i}`, caption: safe(p.caption ?? "", own).slice(0, 900) }))));
        photos.slice(0, 10).forEach((p, i) => form.set(`p${i}`, new Blob([view(p.bytes)]), p.name));
        await call("sendMediaGroup", form, 180_000);
      }
      const singles = [...(photos.length === 1 ? photos : []), ...others];
      for (const m of singles) {
        const form = new FormData(); form.set("chat_id", chat);
        const cap = safe([photos.length <= 1 && singles.length === 1 ? caption : "", m.caption].filter(Boolean).join("\n"), own).slice(0, 1000);
        if (cap) form.set("caption", cap);
        const field = m.kind === "photo" ? "photo" : m.kind === "video" ? "video" : "audio";
        if (m.kind === "video") form.set("supports_streaming", "true");
        form.set(field, new Blob([view(m.bytes)]), m.name);
        await call(m.kind === "photo" ? "sendPhoto" : m.kind === "video" ? "sendVideo" : "sendAudio", form, 300_000);
      }
      // buttons go on their own line under an album (an album cannot carry them)
      { const kb = keyboard(buttons); if (kb) await call("sendMessage", { chat_id: chat, text: "Tap one:", reply_markup: kb }); }
    },
    async typing(chat) { await call("sendChatAction", { chat_id: chat, action: "typing" }, 10_000).catch(() => undefined); },
  };
  return {
    out,
    me: () => call("getMe", {}, 15_000) as Promise<{ username: string; first_name: string }>,
    /** Waits up to 25 s for the next messages. */
    async updates(offset: number): Promise<Incoming[]> {
      const r: any[] = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40_000);
      return r.map(parseUpdate).filter(Boolean) as Incoming[];
    },
    answerTap: (id: string, text?: string) => call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 180) } : {}) }, 10_000).catch(() => undefined),
    clearButtons: (chat: string, messageId: number) => call("editMessageReplyMarkup", { chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } }, 10_000).catch(() => undefined),
  };
}
