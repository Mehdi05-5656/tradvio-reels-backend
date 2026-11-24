// The gate: plain code that reads each incoming text before any AI does (PLAN.md sections 1 and 4). The words that
// must always work (STOP, HELP, CANCEL) and the words that release an action (YES with its code) are decided here.
// The AI can prepare an action; only this file can release one, and only for the person's own reply.

export type Inbound =
  | { kind: "start"; code: string | null }
  | { kind: "yes"; code: string | null; count: number | null }
  | { kind: "no" } | { kind: "cancel" } | { kind: "stop" } | { kind: "help" } | { kind: "pause" } | { kind: "resume" }
  | { kind: "text"; text: string };

const norm = (s: string) => s.normalize("NFKC").replace(/[​-‍﻿]/g, "").trim();

export function classify(raw: string): Inbound {
  const text = norm(raw), low = text.toLowerCase().replace(/[.!]+$/, "").trim();
  // the pairing code keeps its capitals
  const start = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{4,64}))?\s*$/);
  if (start) return { kind: "start", code: start[1] ?? null };
  // "yes 47", "YES47", "y 47", "yes 47 24" (the code, then the count for a large action). A bare "yes" carries no code.
  const yes = low.match(/^\/?(?:yes|y|yep|yeah|confirm|ok|okay|do it|go)(?:[\s,:-]*(\d{2}))?(?:[\s,:-]+(\d{1,4}))?$/);
  if (yes) return { kind: "yes", code: yes[1] ?? null, count: yes[2] != null ? Number(yes[2]) : null };
  if (/^\/?(?:no|n|nope|don'?t|not now|never ?mind)$/.test(low)) return { kind: "no" };
  // leaving: any reasonable wording ends all texts (the SMS rule; the same words work everywhere so nobody has to learn two)
  if (/^\/?(?:stop|stopall|unsubscribe|end|quit|opt ?out|stop texting(?: me)?|stop messaging(?: me)?|leave me alone)$/.test(low)) return { kind: "stop" };
  if (/^\/?(?:cancel|cancel (?:it|that|this))$/.test(low)) return { kind: "cancel" };
  if (/^\/?(?:help|\?|commands|what can you do)$/.test(low)) return { kind: "help" };
  if (/^\/?(?:pause|quiet|mute)$/.test(low)) return { kind: "pause" };
  if (/^\/?(?:resume|unmute|unpause)$/.test(low)) return { kind: "resume" };
  return { kind: "text", text };
}

/** One request to a Clone8 route. `body` may hold "{{name.path}}" marks filled from an earlier step's answer. */
export type Step = { method: "POST" | "PATCH" | "DELETE"; path: string; body?: any; save?: string; label?: string; light?: boolean };
/** What must still be true when the YES arrives, checked by the executor right before it acts. */
export type Check =
  | { kind: "post_unchanged"; post_id: string; updated_at: string }
  | { kind: "price_at_most"; quote: { tool: string; asset_id: string | null; options: Record<string, any> }; credits: number; asset_from?: string }
  | { kind: "accounts_linked"; account_ids: string[] };
export type Pending = {
  id: string; code: string; kind: string; question: string; steps: Step[]; checks: Check[]; credits: number; posts: number;
  /** a large action also needs its count in the reply ("YES 47 24") */
  count: number | null; created_at: number; expires_at: number;
  status: "live" | "claimed" | "done" | "failed" | "expired" | "replaced" | "declined";
  /** times stored as "minutes after the YES" are worked out when it is released, so they cannot go stale while the person reads */
  meta?: Record<string, any>;
};
export type PendingStore = { live: Pending | null; past: Pending[]; last_code?: string };

export const PENDING_TTL_MS = 10 * 60_000;
/** A two-digit code that is not the one before it. */
export function newCode(store: PendingStore, rand: () => number = Math.random): string {
  for (let i = 0; i < 20; i++) { const c = String(10 + Math.floor(rand() * 90)); if (c !== store.last_code) return c; }
  return store.last_code === "42" ? "43" : "42";
}

const retire = (store: PendingStore, status: Pending["status"]) => {
  if (!store.live) return;
  store.live.status = status;
  store.past = [store.live, ...store.past].slice(0, 50);
  store.live = null;
};

/** A new action becomes the only live one. The one before it (if any) can no longer be released by anything. */
export function setPending(store: PendingStore, p: Omit<Pending, "code" | "created_at" | "expires_at" | "status">, now: number, rand?: () => number): Pending {
  retire(store, "replaced");
  const code = newCode(store, rand);
  const live: Pending = { ...p, code, created_at: now, expires_at: now + PENDING_TTL_MS, status: "live" };
  store.live = live; store.last_code = code;
  return live;
}

export type ClaimResult =
  | { ok: true; pending: Pending }
  | { ok: false; why: "nothing" | "expired" | "no_code" | "wrong_code" | "need_count" | "wrong_count"; pending?: Pending };

/** Release the live action for a YES. Exactly one caller can win: the action leaves `live` the moment it is claimed. */
export function claim(store: PendingStore, by: { code?: string | null; count?: number | null; id?: string | null }, now: number): ClaimResult {
  const p = store.live;
  if (!p) return { ok: false, why: "nothing" };
  if (now > p.expires_at) { retire(store, "expired"); return { ok: false, why: "expired", pending: p }; }
  if (by.id != null) { if (by.id !== p.id) return { ok: false, why: "wrong_code", pending: p }; }
  else {
    if (!by.code) return { ok: false, why: "no_code", pending: p };
    if (by.code !== p.code) return { ok: false, why: "wrong_code", pending: p };
  }
  // a large action: the count must come with it, typed (a button alone is not enough)
  if (p.count != null) {
    if (by.count == null) return { ok: false, why: "need_count", pending: p };
    if (by.count !== p.count) return { ok: false, why: "wrong_count", pending: p };
  }
  p.status = "claimed";
  store.past = [p, ...store.past].slice(0, 50);
  store.live = null;
  return { ok: true, pending: p };
}
export function decline(store: PendingStore): Pending | null { const p = store.live; retire(store, "declined"); return p; }
export function expire(store: PendingStore, now: number): Pending | null { const p = store.live; if (p && now > p.expires_at) { retire(store, "expired"); return p; } return null; }

/** The line under every question: how to answer it. */
export function howToAnswer(p: Pending): string {
  return p.count != null ? `Reply YES ${p.code} ${p.count} to go ahead, or NO.` : `Reply YES ${p.code} to go ahead, or NO.`;
}

/** Credits spent by text per day, against the person's ceiling. */
export type Spend = { day: string; credits: number };
export function spendRoom(spend: Spend | undefined, today: string, ceiling: number): number {
  const used = spend && spend.day === today ? spend.credits : 0;
  return Math.max(0, ceiling - used);
}
export function addSpend(spend: Spend | undefined, today: string, credits: number): Spend {
  return { day: today, credits: (spend && spend.day === today ? spend.credits : 0) + Math.max(0, credits) };
}
