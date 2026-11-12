// Clone8 Studio mail: one small function over Resend's REST API. Off without RESEND_API_KEY (every send is a
// logged no-op), so the product never depends on it.
//
// Deliverability (inbox, not spam or Promotions): every message is a plain transactional note about something the
// person did. Text and HTML carry the same words; the HTML is one card (light or dark, the reader's setting) with no images, no tracking pixels, no
// web fonts, one button and at most a couple of plain links; subjects are short and literal (no emoji, capitals,
// prices or sales words). Notices that a person can turn off carry RFC 8058 one-click unsubscribe headers, which
// Gmail and Yahoo ask of senders; receipts do not (they are not optional). Each message gets its own X-Entity-Ref-ID
// so Gmail does not fold separate notices into one thread. Sender authentication (DKIM on clone8.io, DMARC) lives in DNS.
import { recordEvent } from "./studio-events.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type Mail = { to: string; subject: string; text: string; html?: string; unsubscribeUrl?: string | null; /** for the admin panel's email counts */ kind?: string; userId?: string | null };
export type MailDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined>; log?: (line: string) => void };

/** The one address for Clone8 support: emails come from it, replies go to it, and the site and app show it. */
export const SUPPORT_EMAIL = "support@clone8.io";

export function mailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.RESEND_API_KEY;
}
export const mailFrom = (env: Record<string, string | undefined> = process.env) => env.STUDIO_MAIL_FROM || "Clone8 <support@clone8.io>";

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
    body: JSON.stringify({ from: mailFrom(env), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html ?? toHtml(mail.text), reply_to: env.STUDIO_MAIL_REPLY_TO || SUPPORT_EMAIL, headers }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) { recordEvent({ user_id: mail.userId ?? null, kind: "email", name: mail.kind ?? "mail", props: { ok: false, status: r.status } }); throw new Error(`mail_failed_${r.status}:${String(body?.message ?? "").slice(0, 120)}`); }
  recordEvent({ user_id: mail.userId ?? null, kind: "email", name: mail.kind ?? "mail", props: { ok: true } });
  return String(body?.id ?? "");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  /** Paragraphs under the button (the invitation to reply, say). */
  after?: string[];
  /** Who signs it, on its own line ("Sam, Clone8"). */
  signoff?: string;
  /** Small print under the card: why this arrived, how to stop it. */
  footer?: string[];
  unsubscribeUrl?: string | null;
};

// Light and dark. The email follows the reader's own setting, three ways, because mail apps differ:
//  - Apple Mail, iOS Mail, Outlook for Mac and Samsung Mail read the dark colours in the media query below;
//  - Outlook.com and the Outlook apps rewrite colours themselves and tag the result ([data-ogsc]/[data-ogsb]), so the
//    same dark colours are repeated under those tags;
//  - Gmail ignores both and inverts light colours by itself, so the light colours are chosen to survive that: no
//    images, no picture of a logo, no coloured text on a coloured ground except the one button, whose teal and white
//    Gmail leaves alone.
// Every colour is an inline style (light) plus a class (dark), never a background image.
const DARK = { bg: "#0b0d12", card: "#14171f", line: "#262b38", head: "#f4f6f8", text: "#c5ccd6", mute: "#8b94a1", link: "#3ddccb", btn: "#22cdbb", btnText: "#03211d" };
const darkRules = (pre: string) => `${pre} .e-bg{background:${DARK.bg} !important}${pre} .e-card{background:${DARK.card} !important;border-color:${DARK.line} !important}${pre} .e-head{color:${DARK.head} !important}${pre} .e-text{color:${DARK.text} !important}${pre} .e-mute{color:${DARK.mute} !important}${pre} .e-line{border-color:${DARK.line} !important}${pre} .e-link{color:${DARK.link} !important}${pre} .e-btn{background:${DARK.btn} !important}${pre} .e-btn a{color:${DARK.btnText} !important}`;
const EMAIL_CSS = `:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){${darkRules("")}}${darkRules("[data-ogsc]")}${darkRules("[data-ogsb]")}@media (max-width:480px){.e-pad{padding:22px 20px 20px !important}.e-btn a{display:block !important;text-align:center !important}.e-btnwrap{width:100% !important}}`;

/** One email in two forms with the same words: plain text, and an HTML card that follows the reader's light or dark
 *  setting (no images, one button). */
export function renderEmail(b: EmailBody): { text: string; html: string } {
  const text = [
    b.heading,
    ...b.paragraphs,
    ...(b.rows?.length ? [b.rows.map((r) => `${r.label}: ${r.value}`).join("\n")] : []),
    ...(b.button ? [`${b.button.label}: ${b.button.url}`] : []),
    ...(b.after ?? []),
    ...(b.signoff ? [b.signoff] : []),
    ...(b.footer ?? []),
    ...(b.unsubscribeUrl ? [`Stop these emails: ${b.unsubscribeUrl}`] : []),
  ].join("\n\n");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const link = (s: string, color: string, cls: string) => esc(s).replace(/(https:\/\/[^\s<]+)/g, `<a href="$1" class="${cls}" style="color:${color}">$1</a>`);
  const para = (p: string) => `<p class="e-text" style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#33404a">${link(p, "#0f8f7f", "e-link")}</p>`;
  const rows = b.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border-collapse:collapse">${b.rows.map((r) => `<tr><td class="e-head e-line" style="padding:9px 0;border-top:1px solid #e6eaed;font-size:14px;color:#0f1720">${esc(r.label)}</td><td align="right" class="e-mute e-line" style="padding:9px 0 9px 12px;border-top:1px solid #e6eaed;font-size:14px;color:#5b6670">${esc(r.value)}</td></tr>`).join("")}</table>`
    : "";
  const button = b.button
    ? `<table role="presentation" class="e-btnwrap" cellpadding="0" cellspacing="0" style="margin:8px 0 6px"><tr><td class="e-btn" style="border-radius:12px;background:#0f8f7f"><a href="${esc(b.button.url)}" style="display:inline-block;padding:13px 24px;font-family:${font};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">${esc(b.button.label)}</a></td></tr></table>`
    : "";
  const after = (b.after ?? []).map((p, i) => (i === 0 ? `<div style="height:14px;line-height:14px;font-size:14px">&nbsp;</div>` : "") + para(p)).join("");
  const signoff = b.signoff ? `<p class="e-head" style="margin:${b.after?.length ? "2px" : "16px"} 0 0;font-size:15px;line-height:1.6;font-weight:600;color:#0f1720">${esc(b.signoff)}</p>` : "";
  const foot = [...(b.footer ?? []).map((f) => link(f, "#6b7680", "e-mute")), ...(b.unsubscribeUrl ? [`<a href="${esc(b.unsubscribeUrl)}" class="e-mute" style="color:#6b7680;text-decoration:underline">Stop these emails</a>`] : [])];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(b.heading)}</title><style>${EMAIL_CSS}</style></head>
<body class="e-bg" style="margin:0;padding:0;background:#f5f7f8">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(b.preheader)}</div>
<table role="presentation" class="e-bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td class="e-head" style="padding:0 4px 14px;font-family:${font};font-size:19px;font-weight:700;letter-spacing:-0.5px;color:#0f1720">clone<span class="e-link" style="color:#0f8f7f">8</span></td></tr>
<tr><td class="e-card e-pad" style="background:#ffffff;border:1px solid #e6eaed;border-radius:16px;padding:28px 28px 24px;font-family:${font};color:#0f1720">
<h1 class="e-head" style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-0.2px;color:#0f1720">${esc(b.heading)}</h1>
${b.paragraphs.map(para).join("")}
${rows}${button}${after}${signoff}
</td></tr>
${foot.length ? `<tr><td class="e-mute" style="padding:16px 6px 0;font-family:${font};font-size:12px;line-height:1.6;color:#6b7680">${foot.join("<br>")}</td></tr>` : ""}
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
