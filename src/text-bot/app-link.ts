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

export const APP_KINDS = ["signature", "story", "motivation", "film", "other"] as const;
export type AppKind = (typeof APP_KINDS)[number];
const LEAD: Record<AppKind, string> = {
  signature: "Use Clone8 to make a Signature story, written by you here in this chat:",
  story: "Use Clone8 to make a story video:",
  motivation: "Use Clone8 to make a motivation video:",
  film: "Use Clone8 to make a film:",
  other: "Use Clone8:",
};

export type AppLink = { text: string; buttons: Button[]; own: string[]; prompt: string };
/** The message and its buttons. `connected`: they already made something through the connector (no setup step). */
export function appLink(o: { kind: string; request: string; connected: boolean; connectorUrl: string }): AppLink | { error: string; detail: string } {
  const kind = (APP_KINDS as readonly string[]).includes(o.kind) ? (o.kind as AppKind) : "other";
  const request = String(o.request ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^["“”']+|["“”']+$/g, "").trim().slice(0, 400);
  if (request.length < 3) return { error: "missing", detail: "Pass what they want made, in their words" };
  // the request goes out inside an exempt message, so it must not carry a supplier's name itself
  if (blanked(request)) return { error: "not_sendable", detail: "The request can't name a supplier or service; write just what they want made" };
  if (!/^https:\/\/[a-z0-9.-]+\/\S*$/i.test(o.connectorUrl)) return { error: "not_available", detail: "The connector is not open for this account" };
  const prompt = `${LEAD[kind]} ${request}`;
  const open: Button = { label: "Open in Claude", url: `https://claude.ai/new?q=${encodeURIComponent(prompt)}` };
  const add: Button = { label: "Add Clone8 to Claude", url: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Clone8&connectorUrl=${encodeURIComponent(o.connectorUrl)}` };
  const copy: Button = { label: "Copy the request", copy: prompt };
  const text = o.connected
    ? `Make it in Claude with Clone8: Open in Claude starts a new chat with this already typed in. Just send it.\n\n“${prompt}”`
    : `You can make this in Claude with Clone8. First time only: Add Clone8 to Claude, sign in to Clone8 and tap Allow. Then Open in Claude starts a new chat with this already typed in. Just send it.\n\n“${prompt}”`;
  const buttons = o.connected ? [open, copy] : [add, open, copy];
  return { text, buttons, own: [text, prompt, ...linkLines(buttons), ...buttons.map((b) => b.label)], prompt };
}
