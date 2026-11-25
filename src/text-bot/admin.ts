// The admin panel's "Text Clone8" tab (owner, Nov 24 2026: "track and see each individual user that uses the feature"):
// everyone who connected a chat, what they did with it, what it cost us, and what went wrong; and one person's chat,
// read back. Pure counting here (tested); server.ts reads the tables and is the only one that serves it, to admins.

export type TextLinkRow = { id: string; user_id: string; channel: string; handle: string | null; status: string; created_at: string; confirmed_at: string | null; last_used_at: string | null };
export type TextEventRow = { user_id: string | null; chat_id: string | null; channel?: string | null; event: string; at: string; data: Record<string, any> | null };
export type TextPerson = {
  user_id: string; email: string | null; plan: string | null; channel: string; handle: string | null; status: "connected" | "removed" | "waiting";
  connected_at: string | null; last_message_at: string | null;
  messages: number; taps: number; active_days: number; asked: number; done: number; declined: number; credits: number;
  ai_usd: number; errors: number; last_text: string | null;
};
export type TextAdminView = {
  days: number;
  summary: { connected: number; active: number; messages: number; ai_usd: number; per_message_usd: number | null; asked: number; done: number; credits: number; errors: number; new_connections: number };
  by_day: Array<{ day: string; messages: number; people: number }>;
  people: TextPerson[];
};

const ERR = new Set(["error", "claude_error", "send_failed", "watch_error", "execute_unconfirmed"]);
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function textAdminView(o: { links: TextLinkRow[]; events: TextEventRow[]; days: number; since: string; emails: Record<string, string | null>; plans: Record<string, string | null> }): TextAdminView {
  // a person's most telling link: connected beats waiting beats removed; newest first within each
  const rank = (s: string) => (s === "linked" ? 0 : s === "pending" ? 1 : 2);
  const linkOf = new Map<string, TextLinkRow>();
  for (const l of [...o.links].sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at))) if (!linkOf.has(l.user_id)) linkOf.set(l.user_id, l);
  const people = new Map<string, TextPerson & { days: Set<string> }>();
  const person = (u: string) => {
    let p = people.get(u);
    if (!p) {
      const l = linkOf.get(u);
      p = { user_id: u, email: o.emails[u] ?? null, plan: o.plans[u] ?? null, channel: l?.channel ?? "telegram", handle: l?.handle ?? null,
        status: l?.status === "linked" ? "connected" : l?.status === "pending" ? "waiting" : "removed", connected_at: l?.confirmed_at ?? null, last_message_at: null,
        messages: 0, taps: 0, active_days: 0, asked: 0, done: 0, declined: 0, credits: 0, ai_usd: 0, errors: 0, last_text: null, days: new Set() };
      people.set(u, p);
    }
    return p;
  };
  for (const [u] of linkOf) person(u);
  const days = new Map<string, { messages: number; people: Set<string> }>();
  for (const e of o.events) {
    if (!e.user_id || e.at < o.since) continue;
    const p = person(e.user_id), d = e.data ?? {};
    if (e.event === "in") {
      const tap = /^(y|n|pick):/.test(String(d.text ?? "")) || d.tap === true;
      if (tap) p.taps++; else { p.messages++; p.last_text = String(d.text ?? "").slice(0, 140); }
      if (!p.last_message_at || e.at > p.last_message_at) p.last_message_at = e.at;
      const day = e.at.slice(0, 10); p.days.add(day);
      const b = days.get(day) ?? { messages: 0, people: new Set<string>() }; if (!tap) b.messages++; b.people.add(e.user_id); days.set(day, b);
    } else if (e.event === "claude") p.ai_usd += Number(d.usd) || 0;
    else if (e.event === "pending") p.asked++;
    else if (e.event === "executed") { if (d.ok) { p.done++; p.credits += Number(d.credits) || 0; } }
    else if (e.event === "declined") p.declined++;
    else if (ERR.has(e.event)) p.errors++;
  }
  const list = [...people.values()].map(({ days: ds, ...p }) => ({ ...p, active_days: ds.size, ai_usd: r5(p.ai_usd) }))
    .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "") || (b.connected_at ?? "").localeCompare(a.connected_at ?? ""));
  const sum = (k: keyof TextPerson) => list.reduce((n, p) => n + (Number(p[k]) || 0), 0);
  const messages = sum("messages"), ai = sum("ai_usd");
  return {
    days: o.days,
    summary: { connected: list.filter((p) => p.status === "connected").length, active: list.filter((p) => p.messages > 0).length, messages, ai_usd: r5(ai),
      per_message_usd: messages ? r5(ai / messages) : null, asked: sum("asked"), done: sum("done"), credits: sum("credits"), errors: sum("errors"),
      new_connections: o.links.filter((l) => l.confirmed_at && l.confirmed_at >= o.since).length },
    by_day: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, b]) => ({ day, messages: b.messages, people: b.people.size })),
    people: list,
  };
}

export type ChatLine = { at: string; who: "person" | "bot" | "system"; text: string; files?: number; channel?: string };
/** One person's chat as it read on the phone, oldest first, with the system's marks (asked, done, errors) between. */
export function chatLines(events: TextEventRow[]): ChatLine[] {
  const out: ChatLine[] = [];
  let was: string | null = null;
  for (const e of events) {
    const d = e.data ?? {};
    // a person on two channels: a mark where the chat moves from one to the other
    if (e.channel && was && e.channel !== was) out.push({ at: e.at, who: "system", text: `On ${e.channel === "imessage" ? "iMessage" : "Telegram"}`, channel: e.channel });
    if (e.channel) was = e.channel;
    if (e.event === "in") out.push({ at: e.at, who: "person", text: /^y:/.test(String(d.text)) ? "(tapped Yes)" : /^n:/.test(String(d.text)) ? "(tapped No)" : /^pick:/.test(String(d.text)) ? "(tapped a choice)" : String(d.text ?? "") });
    else if (e.event === "out") out.push({ at: e.at, who: "bot", text: String(d.text ?? ""), ...(Array.isArray(d.media) && d.media.length ? { files: d.media.length } : {}) });
    else if (e.event === "executed") out.push({ at: e.at, who: "system", text: d.ok ? `Done after YES${d.credits ? ` · ${d.credits} credits` : ""}` : "Not done after YES" });
    else if (e.event === "declined") out.push({ at: e.at, who: "system", text: "Said no" });
    else if (e.event === "linked") out.push({ at: e.at, who: "system", text: "Connected" });
    else if (e.event === "unlinked") out.push({ at: e.at, who: "system", text: "Disconnected" });
    else if (ERR.has(e.event)) out.push({ at: e.at, who: "system", text: `Problem: ${e.event}${d.detail ? ` (${String(d.detail).slice(0, 120)})` : ""}` });
  }
  return out;
}

// ---- the "Text Clone8" calls to action in the app (app src/lib/text-promo.ts): which ones get people to connect ----
export const CTAS = ["result_modal", "result_card", "home_card", "publish_card", "toast_posted", "toast_idle", "account_card"] as const;
export const CTA_ACTIONS = ["shown", "opened", "dismissed", "never", "connected", "assisted"] as const;
export type CtaRow = { user_id: string | null; props: { cta?: string; action?: string; tool?: string; channel?: string } | null; created_at: string };
export type CtaLine = { cta: string; shown: number; people: number; opened: number; dismissed: number; never: number; connected: number; assisted: number;
  /** opened / shown, connected / shown (0..1), null with nothing shown */ open_rate: number | null; connect_rate: number | null };
/** One line per CTA: how often it was shown (and to how many people), pressed, waved off, and how many chats it connected
 *  (directly, or as the last thing seen within 7 days before a connect elsewhere: "assisted"); best connectors first. */
export function ctaReport(rows: CtaRow[]): { lines: CtaLine[]; tools: Array<{ tool: string; shown: number; opened: number; connected: number }> } {
  const by = new Map<string, CtaLine & { users: Set<string> }>();
  const tools = new Map<string, { tool: string; shown: number; opened: number; connected: number }>();
  for (const r of rows) {
    const cta = r.props?.cta, action = r.props?.action;
    if (!cta || !action || !(CTAS as readonly string[]).includes(cta) || !(CTA_ACTIONS as readonly string[]).includes(action)) continue;
    const l = by.get(cta) ?? { cta, shown: 0, people: 0, opened: 0, dismissed: 0, never: 0, connected: 0, assisted: 0, open_rate: null, connect_rate: null, users: new Set<string>() };
    (l as any)[action] += 1;
    if (action === "shown" && r.user_id) l.users.add(r.user_id);
    by.set(cta, l);
    if (r.props?.tool && (action === "shown" || action === "opened" || action === "connected")) {
      const t = tools.get(r.props.tool) ?? { tool: r.props.tool, shown: 0, opened: 0, connected: 0 };
      t[action] += 1; tools.set(r.props.tool, t);
    }
  }
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  const lines = [...by.values()].map(({ users, ...l }) => ({ ...l, people: users.size, open_rate: rate(l.opened, l.shown), connect_rate: rate(l.connected, l.shown) }))
    .sort((a, b) => b.connected - a.connected || b.assisted - a.assisted || b.shown - a.shown);
  return { lines, tools: [...tools.values()].sort((a, b) => b.shown - a.shown) };
}
