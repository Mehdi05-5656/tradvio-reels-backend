// Clone8 Studio receipts: one email for every charge, to the address the person signed up with.
//   - a plan invoice (first payment, renewal, upgrade, extra social accounts): from invoice.paid
//   - a one-off payment (top-up, bundle): from checkout.session.completed in payment mode
//   - an auto top-up on the saved card: from the charge itself (studio-topup.ts)
// A subscription checkout sends nothing itself: its first invoice (invoice.paid) is the receipt, so it is never sent twice.
// The webhook route sends a receipt only for the delivery that first marks the event processed, so a retry repeats nothing.
// Never throws: a receipt that cannot be sent is logged, and the payment and credits stand.
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, renderEmail, type MailDeps } from "./studio-mail.js";
import { packById } from "./studio-pricing.js";

export type Receipt = {
  amount_cents: number;
  currency: string;
  /** What was bought, one line per item ("Clone8 Creator, yearly"). */
  items: string[];
  /** Credits added to the balance by this payment, when known. */
  credits?: number | null;
  /** Stripe's own invoice page (plans), when there is one. */
  invoice_url?: string | null;
  /** Invoice number or payment reference, for support. */
  reference: string;
  paid_at: Date;
};

const n = (x: number) => new Intl.NumberFormat("en-US").format(Math.round(x));
export const money = (cents: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/** The receipt a Stripe event stands for, or null when it is not a charge (or charged nothing). Pure: tested on its own. */
export function receiptFromEvent(event: any): Receipt | null {
  const type = String(event?.type ?? ""), o = event?.data?.object ?? {};
  const at = (s: unknown) => new Date((Number(s) || Date.now() / 1000) * 1000);
  if (type === "checkout.session.completed") {
    if (o.mode !== "payment" || (o.payment_status && o.payment_status !== "paid")) return null;
    const cents = Number(o.amount_total ?? 0);
    if (!(cents > 0)) return null;
    const pack = o.metadata?.topup === "1" ? null : packById(o.metadata?.pack);
    const credits = (pack ? pack.credits : Math.floor(Number(o.metadata?.credits ?? 0))) || null;
    const item = pack ? `Credit bundle: ${n(pack.credits)} credits` : `Top-up${credits ? `: ${n(credits)} credits` : ""}`;
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id;
    return { amount_cents: cents, currency: String(o.currency ?? "usd"), items: [item], credits, invoice_url: null, reference: String(pi ?? o.id), paid_at: at(o.created) };
  }
  if (type === "invoice.paid") {
    const cents = Number(o.amount_paid ?? 0);
    if (!(cents > 0)) return null;
    const lines: any[] = o.lines?.data ?? [];
    const items = lines.map((l) => String(l?.description ?? "").trim()).filter(Boolean).slice(0, 6);
    const why = ({ subscription_create: "Plan started", subscription_cycle: "Plan renewed", subscription_update: "Plan changed" } as Record<string, string>)[String(o.billing_reason ?? "")];
    return {
      amount_cents: cents, currency: String(o.currency ?? "usd"), items: items.length ? items : [why ?? "Clone8 Studio plan"], credits: null,
      invoice_url: typeof o.hosted_invoice_url === "string" ? o.hosted_invoice_url : null,
      reference: String(o.number ?? o.id), paid_at: at(o.status_transitions?.paid_at ?? o.created),
    };
  }
  return null;
}

/** The words of the email, as text and as the light HTML card. Exported so they are tested. */
export function receiptMail(r: Receipt, dashboardUrl: string): { subject: string; text: string; html: string } {
  const date = r.paid_at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const amount = money(r.amount_cents, r.currency);
  const rows = [
    { label: "Amount", value: amount },
    { label: "Date", value: date },
    ...r.items.map((it) => ({ label: "For", value: it })),
    ...(r.credits ? [{ label: "Credits added", value: n(r.credits) }] : []),
    { label: "Reference", value: r.reference },
  ];
  const body = renderEmail({
    preheader: `We received ${amount}. Thank you.`,
    heading: `Payment received: ${amount}`,
    paragraphs: [`Thank you. This is your receipt for ${amount} to Clone8 Studio.${r.credits ? " The credits are already on your balance and carry over when your plan renews." : ""}`],
    rows,
    button: { label: "See your account", url: `${dashboardUrl}/#studio/account` },
    footer: [...(r.invoice_url ? [`Invoice from Stripe: ${r.invoice_url}`] : []), "Questions about this charge? Reply to this email."],
  });
  return { subject: `Receipt for ${amount}`, ...body };
}

/** Send a receipt to the person's sign-up email. Logs and returns false on any failure; never throws. */
export async function sendReceipt(sb: SupabaseClient, userId: string | null, r: Receipt, deps: MailDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env, log = deps.log ?? ((l: string) => console.log(l));
  try {
    if (!userId) throw new Error("no user for this charge");
    const admin = (sb as any).auth?.admin;
    const u = admin?.getUserById ? await admin.getUserById(userId) : null;
    const to = u?.data?.user?.email;
    if (typeof to !== "string" || !to) throw new Error("no email on file");
    const m = receiptMail(r, (env.DASHBOARD_URL || "https://app.clone8.io").replace(/\/+$/, ""));
    const id = await sendMail({ to, ...m, kind: "receipt", userId }, { ...deps, env, log });
    log(`[receipt] ${JSON.stringify({ user: userId, amount: r.amount_cents, ref: r.reference, sent: id !== null })}`);
    return id !== null;
  } catch (e: any) {
    log(`[receipt] ALERT not sent ${JSON.stringify({ user: userId, ref: r.reference, detail: String(e?.message ?? e).slice(0, 160) })}`);
    return false;
  }
}
