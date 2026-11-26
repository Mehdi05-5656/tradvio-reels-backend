// The connector's tools for the raw models and the presets on them (docs/higgsfield-parity/PLAN.md, phase 1): what
// Explore shows on the website, reachable from Claude or ChatGPT. Same rule as studio-mcp.ts: every tool calls the
// Studio's own routes as the person, so prices, plan checks, closed models and refusals are exactly the website's.
// Media a model or preset needs comes from the person's library (clone8_library), or from a public link brought in
// with clone8_add_media.
import type { StudioCall } from "./studio-mcp.js";

const APP_URL = "https://app.clone8.io";
type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, data?: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });
const err = (text: string, data?: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}), isError: true });
const refusal = (r: { status: number; json: any }): Result => {
  const j = r.json ?? {};
  if (j.error === "insufficient_credits") return err(`Not enough credits: this needs ${j.needed}, the balance is ${j.balance}. More credits: ${APP_URL}/#studio/pricing`, { error: j.error });
  if (j.error === "subscription_required") return err(`Making needs a Clone8 plan. The person can pick one here: ${APP_URL}/#studio/pricing (then ask again).`, { error: j.error });
  return err(String(j.detail ?? j.message ?? j.error ?? `Clone8 said ${r.status}`), { error: j.error ?? `http_${r.status}` });
};
const MEDIA = { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, description: "The media the model needs, by field name (from clone8_model or clone8_presets): asset ids from clone8_library or clone8_add_media. A field that takes a list may take one id." };
const CONFIRM = { type: "boolean", description: "false or left out: price it only, nothing is spent. true: start it (only after the person agreed to the price)." };

export const MODEL_TOOLS = [
  { name: "clone8_models", title: "Models", description: "Every video, picture and sound model Clone8 offers (Kling, Seedance, MiniMax, Wan, Seedream, the Clone8 models…), grouped by model, with its modes and the id of each. Free to call. Use clone8_model for one mode's settings.",
    inputSchema: { type: "object", properties: { output: { type: "string", enum: ["video", "image", "audio"], description: "only models that make this" } } }, annotations: { readOnlyHint: true } },
  { name: "clone8_model", title: "One model's settings", description: "The settings and the media fields of one model mode (by its id from clone8_models), with defaults and limits. Free to call.",
    inputSchema: { type: "object", properties: { model: { type: "string" } }, required: ["model"] }, annotations: { readOnlyHint: true } },
  { name: "clone8_generate", title: "Make with a model", description: "Make a video, picture or sound with one model mode. Without confirm it returns the price only; with confirm: true it starts and spends the credits. Then follow it with clone8_job.",
    inputSchema: { type: "object", properties: { model: { type: "string", description: "a mode id from clone8_models" }, params: { type: "object", description: "the settings (prompt, duration, aspect_ratio, resolution…) as clone8_model lists them" }, media: MEDIA, confirm: CONFIRM }, required: ["model"] } },
  { name: "clone8_presets", title: "Presets", description: "Ready-made looks (Main character, Paparazzi, Product hero, Action figure, Pro headshot…): one photo of the person or their product in, the same shot out. Lists what each needs. Free to call.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "clone8_run_preset", title: "Run a preset", description: "Run one preset with the person's photo (and its line of text when it asks for one). Without confirm it returns the price only; with confirm: true it starts and spends the credits. Then follow it with clone8_job.",
    inputSchema: { type: "object", properties: { preset: { type: "string", description: "a preset id from clone8_presets" }, media: MEDIA, text: { type: "string", description: "the preset's line, when it has one (a name on a box, a headline)" }, params: { type: "object", description: "only the settings the preset lets the person choose" }, confirm: CONFIRM }, required: ["preset"] } },
  { name: "clone8_library", title: "The person's files", description: "The person's most recent pictures and clips on Clone8 (up to 20), with the asset id each model or preset takes. Free to call. They can also upload at app.clone8.io and ask again.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["image", "video"] }, query: { type: "string", description: "words in the file's name or a clip's title" } } }, annotations: { readOnlyHint: true } },
  { name: "clone8_add_media", title: "Bring in a picture or clip", description: "Copy a picture (JPEG, PNG, WebP, up to 30 MB) or a clip (MP4, MOV, up to 200 MB) from a public https link into the person's Clone8 library, and return its asset id. Free. The link must open the file itself, not a page.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" } }, required: ["url"] } },
] as const;
export const MODEL_TOOL_NAMES = new Set<string>(MODEL_TOOLS.map((t) => t.name));

const mediaOf = (m: any): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  if (m && typeof m === "object" && !Array.isArray(m)) for (const [k, v] of Object.entries(m)) { if (typeof v === "string" && v) out[k] = v; else if (Array.isArray(v)) out[k] = v.map(String).filter(Boolean); }
  return out;
};

/** Prices or starts one instrument request (a model, or a preset, which the Studio fills from its recipe). */
async function quoteOrStart(call: StudioCall, options: Record<string, unknown>, confirm: boolean): Promise<Result> {
  const body = { tool: "instrument", asset_id: null, options };
  const [quote, me] = await Promise.all([call("POST", "/api/studio/quote", body), call("GET", "/api/studio/me")]);
  if (quote.status !== 200) return refusal(quote);
  const credits = Number(quote.json.credits), summary = String(quote.json.summary ?? "").replace(/ · \d+$/, ""), balance = me.status === 200 ? Number(me.json.balance) : null;
  const planless = me.status === 200 && !me.json.active && !me.json.owner_pass;
  if (planless) return ok(`${summary}: ${credits} credits. Making needs a Clone8 plan first: ${APP_URL}/#studio/pricing. Nothing has been spent.`, { credits, balance, summary, needs_plan: true });
  if (!confirm) { const short = balance != null && balance < credits; return ok(`${summary}: ${credits} credits${balance != null ? ` (balance ${balance}${short ? `, not enough: ${APP_URL}/#studio/pricing` : ""})` : ""}. Nothing has been spent: ask the person, then call again with confirm: true.`, { credits, balance, summary, started: false }); }
  const r = await call("POST", "/api/studio/jobs", body); if (r.status !== 201) return refusal(r);
  return ok(`Started: ${summary}, ${credits} credits. Job ${r.json.job?.id}. Follow it with clone8_job; it also appears in ${APP_URL}/#studio/library.`, { started: true, job_id: r.json.job?.id, credits, summary });
}

/** Runs one of these tools; null when the name is not one of them. */
export async function runModelTool(name: string, a: any, call: StudioCall): Promise<Result | null> {
  if (!MODEL_TOOL_NAMES.has(name)) return null;
  if (name === "clone8_models") {
    const r = await call("GET", "/api/studio/instruments?preview=1"); if (r.status !== 200) return refusal(r);
    const list = (r.json.instruments ?? []).filter((m: any) => !a?.output || m.output === a.output || (a.output === "audio" && m.output === "text"));
    const fams = new Map<string, any[]>(); for (const m of list) fams.set(m.family, [...(fams.get(m.family) ?? []), m]);
    const lines = [...fams].map(([fam, ms]) => `${fam} (${ms[0].provider === "Clone8" ? "Clone8" : ms[0].provider}, ${ms[0].output}): ${ms.map((m: any) => `${m.kind_label} = ${m.id}${m.price_hint ? ` [from ${m.price_hint.credits} credits ${m.price_hint.unit ?? m.price_hint.per}]` : ""}`).join("; ")}`);
    return ok(lines.length ? lines.join("\n") : "No models are open right now.", { families: [...fams].map(([family, ms]) => ({ family, output: ms[0].output, modes: ms.map((m: any) => ({ id: m.id, does: m.kind_label, summary: m.summary })) })) });
  }
  if (name === "clone8_model") {
    const r = await call("GET", "/api/studio/instruments?preview=1"); if (r.status !== 200) return refusal(r);
    const m = (r.json.instruments ?? []).find((x: any) => x.id === a?.model);
    if (!m) return err("No model with that id: clone8_models lists them.");
    const fields = m.fields.map((f: any) => `${f.name}${f.required ? " (required)" : ""}: ${f.enum ? `one of ${f.enum.join(", ")}` : f.type}${f.minimum != null || f.maximum != null ? ` ${f.minimum ?? "…"} to ${f.maximum ?? "…"}` : ""}${f.default != null ? `, default ${f.default}` : ""}`);
    const media = m.media.map((x: any) => `${x.name}${x.required ? " (required)" : ""}: ${x.multiple ? `up to ${x.maxItems ?? "several"} ${x.kind}s` : `one ${x.kind}`}`);
    return ok(`${m.title}: ${m.summary}\nSettings:\n${fields.join("\n") || "none"}\nMedia:\n${media.join("\n") || "none"}${m.notes?.length ? `\nNotes: ${m.notes.join(" ")}` : ""}`, { id: m.id, fields: m.fields, media: m.media });
  }
  if (name === "clone8_generate") {
    if (!a?.model) return err("model is a mode id from clone8_models.");
    return quoteOrStart(call, { endpoint: String(a.model), params: a?.params && typeof a.params === "object" ? a.params : {}, inputs: mediaOf(a?.media) }, a?.confirm === true);
  }
  if (name === "clone8_presets") {
    const r = await call("GET", "/api/studio/presets?preview=1"); if (r.status !== 200) return refusal(r);
    const ps = (r.json.presets ?? []).filter((p: any) => !p.draft);
    return ok(ps.length ? ps.map((p: any) => `${p.id}: ${p.title} (${p.output}, ${p.model ?? "Clone8"}). ${p.line} Needs: ${p.inputs.map((i: any) => `${i.label} as media.${i.field}`).join(", ")}${p.text ? `; text: ${p.text.label}` : ""}`).join("\n") : "No presets are open right now.",
      { presets: ps.map((p: any) => ({ id: p.id, title: p.title, output: p.output, needs: p.inputs, text: p.text })) });
  }
  if (name === "clone8_run_preset") {
    if (!a?.preset) return err("preset is an id from clone8_presets.");
    const params = { ...(a?.params && typeof a.params === "object" ? a.params : {}), ...(a?.text ? { text: String(a.text) } : {}) };
    return quoteOrStart(call, { preset: String(a.preset), inputs: mediaOf(a?.media), params }, a?.confirm === true);
  }
  if (name === "clone8_library") {
    const q = new URLSearchParams({ limit: "20", ...(a?.kind === "image" || a?.kind === "video" ? { kind: a.kind } : {}), ...(a?.query ? { q: String(a.query).slice(0, 80) } : {}) });
    const r = await call("GET", `/api/studio/assets?${q}`); if (r.status !== 200) return refusal(r);
    const rows = (r.json.assets ?? []).filter((x: any) => x.status === "ready").slice(0, 20);
    return ok(rows.length ? rows.map((x: any) => `${x.id} · ${x.kind} · ${x.name}${x.probe?.duration ? ` · ${Math.round(Number(x.probe.duration))} s` : ""}`).join("\n") : `No files yet. The person can upload at ${APP_URL}/#studio/library, or give a public link for clone8_add_media.`,
      { assets: rows.map((x: any) => ({ id: x.id, kind: x.kind, name: x.name })) });
  }
  if (name === "clone8_add_media") {
    const r = await call("POST", "/api/studio/assets/from-link", { url: String(a?.url ?? ""), ...(a?.name ? { name: String(a.name) } : {}) }, { timeoutMs: 150_000 });
    if (r.status !== 201) return refusal(r);
    return ok(`Added to the library: ${r.json.name} (${r.json.kind}), asset id ${r.json.asset_id}.`, { asset_id: r.json.asset_id, kind: r.json.kind });
  }
  return null;
}
