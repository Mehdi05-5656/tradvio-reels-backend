// Clone8 Studio mail: one small function over Resend's REST API. Off without RESEND_API_KEY (every send is a
// logged no-op), so the product never depends on it.
//
// Deliverability (inbox, not spam or Promotions): every message is a plain transactional note about something the
// person did. Text and HTML carry the same words; the HTML is one light card with no images, no tracking pixels, no
// web fonts, one button and at most a couple of plain links; subjects are short and literal (no emoji, capitals,
// prices or sales words). Notices that a person can turn off carry RFC 8058 one-click unsubscribe headers, which
// Gmail and Yahoo ask of senders; receipts do not (they are not optional). Each message gets its own X-Entity-Ref-ID
// so Gmail does not fold separate notices into one thread. Sender authentication (DKIM on clone8.io, DMARC) lives in DNS.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type Mail = { to: string; subject: string; text: string; html?: string; unsubscribeUrl?: string | null };
export type MailDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void };

export function mailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.RESEND_API_KEY;
}
export const mailFrom = (env: Record<string, string | undefined> = process.env) => env.STUDIO_MAIL_FROM || "Clone8 Studio <studio@clone8.io>";

/** Returns the provider's message id, or null when mail is off. Throws on a provider error so callers can retry later. */
export async function sendMail(mail: Mail, deps: MailDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env, log = deps.log ?? (() => undefined);
  if (!mailConfigured(env)) { log(`[mail] off: ${mail.subject} → ${mail.to}`); return null; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.to)) throw new Error("mail_invalid_recipient");
  const headers: Record<string, string> = { "X-Entity-Ref-ID": randomUUID() };
  if (mail.unsubscribeUrl) { headers["List-Unsubscribe"] = `<${mail.unsubscribeUrl}>`; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"; }
  const r = await (deps.fetch ?? fetch)("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: mailFrom(env), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html ?? toHtml(mail.text), reply_to: env.STUDIO_MAIL_REPLY_TO || "support@tradvio.com", headers }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`mail_failed_${r.status}:${String(body?.message ?? "").slice(0, 120)}`);
  return String(body?.id ?? "");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escaped text with its bare https links made clickable (quiet colour, no tracking). */
const linked = (s: string, color = "#0f8f7f") => esc(s).replace(/(https:\/\/[^\s<]+)/g, `<a href="$1" style="color:${color}">$1</a>`);

/** Paragraph breaks and bare links; nothing else. */
export function toHtml(text: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f1720">${text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#0f8f7f">$1</a>').replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}

export type EmailBody = {
  /** The first line most inboxes show after the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Short rows shown as a quiet list ("Swap · 12 s", "Ready"). */
  rows?: Array<{ label: string; value: string }>;
  button?: { label: string; url: string };
  /** Small print under the card: why this arrived, how to stop it. */
  footer?: string[];
  unsubscribeUrl?: string | null;
};

/** One email in two forms with the same words: plain text, and a light HTML card (no images, one button). */
export function renderEmail(b: EmailBody): { text: string; html: string } {
  const text = [
    b.heading,
    ...b.paragraphs,
    ...(b.rows?.length ? [b.rows.map((r) => `${r.label}: ${r.value}`).join("\n")] : []),
    ...(b.button ? [`${b.button.label}: ${b.button.url}`] : []),
    ...(b.footer ?? []),
    ...(b.unsubscribeUrl ? [`Stop these emails: ${b.unsubscribeUrl}`] : []),
  ].join("\n\n");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const rows = b.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border-collapse:collapse">${b.rows.map((r) => `<tr><td style="padding:8px 0;border-top:1px solid #edf0f2;font-size:14px;color:#0f1720">${esc(r.label)}</td><td align="right" style="padding:8px 0;border-top:1px solid #edf0f2;font-size:14px;color:#5b6670;white-space:nowrap">${esc(r.value)}</td></tr>`).join("")}</table>`
    : "";
  const button = b.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px"><tr><td style="border-radius:10px;background:#0f8f7f"><a href="${esc(b.button.url)}" style="display:inline-block;padding:11px 20px;font-family:${font};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${esc(b.button.label)}</a></td></tr></table>`
    : "";
  const foot = [...(b.footer ?? []).map((f) => linked(f, "#8a949c")), ...(b.unsubscribeUrl ? [`<a href="${esc(b.unsubscribeUrl)}" style="color:#8a949c">Stop these emails</a>`] : [])];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(b.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f7f8">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(b.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 4px 14px;font-family:${font};font-size:15px;font-weight:700;letter-spacing:-0.2px;color:#0f1720">Clone8 Studio</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e6eaed;border-radius:14px;padding:26px 26px 22px;font-family:${font};color:#0f1720">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:700">${esc(b.heading)}</h1>
${b.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#33404a">${linked(p)}</p>`).join("")}
${rows}${button}
</td></tr>
${foot.length ? `<tr><td style="padding:14px 6px 0;font-family:${font};font-size:12px;line-height:1.6;color:#8a949c">${foot.join("<br>")}</td></tr>` : ""}
</table></td></tr></table></body></html>`;
  return { text, html };
}

/** The signed token in an unsubscribe link: only the server can make one for a given person. */
function mailKey(env: Record<string, string | undefined>): string {
  const k = env.STUDIO_MAIL_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || "";
  return createHmac("sha256", "clone8-mail-unsubscribe").update(k).digest("hex");
}
export function unsubscribeToken(userId: string, env: Record<string, string | undefined> = process.env): string {
  return createHmac("sha256", mailKey(env)).update(`unsubscribe:${userId}`).digest("base64url").slice(0, 32);
}
export function checkUnsubscribeToken(userId: string, token: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!(env.STUDIO_MAIL_SECRET || env.SUPABASE_SERVICE_ROLE_KEY)) return false;
  const a = Buffer.from(unsubscribeToken(userId, env)), b = Buffer.from(String(token ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
/** The one-click link (and List-Unsubscribe target) for a person's optional notices. Null when it cannot be signed. */
export function unsubscribeUrl(userId: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!(env.STUDIO_MAIL_SECRET || env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const api = (env.STUDIO_PUBLIC_API_URL || env.RENDER_EXTERNAL_URL || "https://tradvio-reels-backend.onrender.com").replace(/\/+$/, "");
  return `${api}/api/studio/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId, env)}`;
}
