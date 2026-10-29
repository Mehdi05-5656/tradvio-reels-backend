// Clone8 Studio mail: one small function over Resend's REST API. Off without RESEND_API_KEY (every send is a
// logged no-op), so the product never depends on it. Plain, short messages; the dashboard is the place for detail.
export type Mail = { to: string; subject: string; text: string; html?: string };
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
  const r = await (deps.fetch ?? fetch)("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: mailFrom(env), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html ?? toHtml(mail.text), reply_to: env.STUDIO_MAIL_REPLY_TO || "support@tradvio.com" }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`mail_failed_${r.status}:${String(body?.message ?? "").slice(0, 120)}`);
  return String(body?.id ?? "");
}

/** Paragraph breaks and bare links; nothing else. */
export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f1720">${text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#0f8f7f">$1</a>').replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}
