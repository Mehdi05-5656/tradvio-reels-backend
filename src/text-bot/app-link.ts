// "Do it in your own AI app" (owner, Nov 25 2026: "a shortcut that takes them to Claude on their mobile app,
// prepared"). Clone8 is a connector people add to Claude (src/studio-mcp.ts): stories, Signature stories written in
// their own chat, motivation videos and films. When that fits, the bot sends this fixed message. It has a link that
// opens a new Claude chat with the request already typed in, and on first use a link that adds the Clone8 connector.
//
// The model never writes these words or links. It calls send_app_link with the kind and the person's request; this
// file writes the message. The supplier guard still blanks the word anywhere else the bot speaks, so "what AI do you
// use?" can never be answered with it. Link formats are Claude's documented ones (the same as the website's
// claude-button.tsx): claude.ai/new?q=… and claude.ai/customize/connectors?modal=add-custom-connector&….
import type { Button } from "./brain.js";
import { blanked } from "./guard.js";
import { linkLines } from "./sendblue.js";

// (the app accepts exactly these openings on its set-up link, src/lib/ai-link.ts AI_LEADS: keep the two in step)
export const APP_KINDS = ["signature", "story", "motivation", "film"] as const;
export type AppKind = (typeof APP_KINDS)[number];
const LEAD: Record<AppKind, string> = {
  signature: "Use Clone8 to make a Signature story, written by you here in this chat, about:",
  story: "Use Clone8 to make a story video:",
  motivation: "Use Clone8 to make a motivation video:",
  film: "Use Clone8 to make a film:",
};

export type AppLink = { text: string; buttons: Button[]; own: string[]; prompt: string };
/** The message and its buttons. `connected`: they already made something through the connector (no setup step). */
/** Encodes everything but letters, digits and - _ . ~ (iMessage ends a link at a quote or a bracket). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** The words in the message's place for the waiting question's "YES <code>" (filled in by the bot as it sends it). */
export const YES_MARK = "\u0003YES\u0003";
/** `beside`: sent right after a waiting YES question for the same thing, with both prices (only when this way costs
 *  less). The message is short: why (the saving), what happens, one action; the links follow on their own. */
export function appLink(o: { kind: string; request: string; connected: boolean; connectorUrl: string; beside?: { here: number; there: number } }): AppLink | { error: string; detail: string } {
  if (!(APP_KINDS as readonly string[]).includes(o.kind)) return { error: "bad_kind", detail: `kind must be one of ${APP_KINDS.join(", ")}` };
  const kind = o.kind as AppKind;
  const request = String(o.request ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^["“”']+|["“”']+$/g, "").trim().slice(0, 180);
  if (request.length < 3) return { error: "missing", detail: "Pass what they want made, in their words" };
  // the request goes out inside an exempt message, so it must not carry a supplier's name itself
  // nor a link or a web address (the message is exempt from the link check, so none may ride inside it)
  if (/https?:|www\.|[a-z0-9-]+\.[a-z]{2,}(\/|\b)/i.test(request)) return { error: "not_sendable", detail: "The request can't carry a link or web address; write just what they want made" };
  if (blanked(request)) return { error: "not_sendable", detail: "The request can't name a supplier or service; write just what they want made" };
  if (!/^https:\/\/[a-z0-9.-]+\/\S*$/i.test(o.connectorUrl)) return { error: "not_available", detail: "The connector is not open for this account" };
  const prompt = `${LEAD[kind]} ${request}`;
  const open: Button = { label: "Open in Claude", url: `https://claude.ai/new?q=${enc(prompt)}` };
  // first time: Clone8's own page (the app's "Clone8 in Claude" window, claude-button.tsx ClaudeLinkHost) walks the
  // one-time set-up, sees when it is done, then opens the chat with this request; it also tells a phone what to do if
  // Claude's app can't add a connector there yet
  const setup: Button = { label: "Set it up", url: `https://app.clone8.io/#studio/home?ai=${enc(prompt)}` };
  const n = (x: number) => x.toLocaleString("en-US");
  const what = kind === "signature"
    ? "Claude writes the scene in your own chat (it takes 30 to 60 minutes there), then Clone8 voices and renders it."
    : "Claude asks Clone8 to make it and shows you the result in that chat.";
  const steps = o.connected
    ? "Tap the link below and send the message it opens with."
    : "First time only, it needs a one-minute set-up: the link below walks you through it, then opens the chat with your request ready to send.";
  const text = o.beside
    ? `Or make it in Claude for ${n(o.beside.there)} credits instead of ${n(o.beside.here)}. ${what} ${steps}\n\nTo make it here instead, reply ${YES_MARK}.`
    : `You can make this in Claude with Clone8. ${what} ${steps}`;
  const buttons = o.connected ? [open] : [setup];
  return { text, buttons, own: [text, prompt, ...linkLines(buttons), ...buttons.map((b) => b.label), ...buttons.map((b) => ("url" in b ? b.url : ""))], prompt };
}
