// Clone8 Studio: automations. A plan the person confirmed and liked, kept as a recipe. Every part a person could want
// different next time is an input of its own: the video, who plays each person, the character, the style, the trend, a
// description, a reference picture. Saving asks which of them change on every run; the rest are kept with the value used
// the first time (changeable for one run on the card). Running fills the inputs, prices the steps with the same quotes as
// the chat, and starts a run inside a new conversation, so progress and results read exactly like any chat.
//
// People are the part that goes wrong silently: "the man in the black cap on the left" describes one video only. So a
// step that names people keeps them with the video they came from, and when a run brings a different video the people in
// it are found again and the person picks who changes (and who plays whom) before anything is spent.
import type { Express, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { StudioError, toolsEnabled } from "./studio.js";
import { InstrumentError, instrumentById } from "./studio-instruments.js";
import { trendById } from "./studio-trends.js";
import { PRESET_CHARACTERS } from "./studio-knowledge.js";
import { AssistantError, advanceRun, buildCtx, hydrateJobs, pricePlan, publicConversation, startRun, type AssistantDeps, type Conversation, type Ctx, type Plan } from "./studio-assistant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^\$(\d+)$/;
const SLOT_RE = /^\{([a-z]+_\d+)\}$/;
const slotOf = (v: unknown): string | null => (typeof v === "string" ? v.match(SLOT_RE)?.[1] ?? null : null);
const slot = (key: string) => `{${key}}`;

export type InputKind = "video" | "image" | "character" | "text" | "style" | "trend" | "people";
export type CharacterValue = { character: string | null; character_asset_id: string | null };
export type CastValue = CharacterValue & { label: string | null; /** what plays them, for the card and messages */ name?: string | null };
export type PeopleValue = { cast?: CastValue[]; targets?: string[] };
export type AutomationInput = {
  key: string; kind: InputKind; label: string;
  /** true: asked on every run; false: kept (the saved value, changeable for one run). Undefined: saved before the setup
   *  question existed (a video then changed every run and everything else stayed). */
  each_run?: boolean;
  /** what was used the first time: an asset id (video, image), a CharacterValue, the words, {id,name} (style, trend), a PeopleValue */
  value?: any;
  from_name?: string | null;
  step?: number | null;
  /** people: the video input whose faces they are (null for a catalog trend) */
  video_key?: string | null;
  /** people on a one-character step: not a question of its own; who changes is asked again when the video changes */
  hidden?: boolean;
};
export type AutomationStep = { index: number; tool: string; label: string; source: string | null; options: Record<string, any> };
export type Automation = { id: string; user_id: string; name: string; description: string | null; steps: AutomationStep[]; inputs: AutomationInput[]; source_conversation: string | null; runs: number; last_run_at: string | null; created_at: string; updated_at: string };
/** The setup card the assistant shows instead of saving on its own: the person answers what changes, then saves. */
export type SetupCard = { id: string; name: string; suggested: string[]; status: "open" | "saved"; automation_id?: string | null };

const presetName = (id: unknown) => PRESET_CHARACTERS.find((p) => p.id === String(id ?? "").toLowerCase())?.name ?? null;
const snippet = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
function characterName(v: CharacterValue, names: Map<string, string>): string | null {
  if (v.character) return presetName(v.character) ?? v.character;
  const id = String(v.character_asset_id ?? "");
  const ref = id.match(REF_RE);
  if (ref) return `the character made in step ${ref[1]}`;
  return id ? (names.get(id.toLowerCase()) ?? "your picture").replace(/^Character: /, "") : null;
}

/** Whether an input is asked on every run. Hidden people follow their video; inputs saved before the question default
 *  to the old behaviour (videos change, the rest stays). */
export function isEachRun(i: AutomationInput, all: AutomationInput[]): boolean {
  if (i.hidden) { const v = all.find((x) => x.key === i.video_key); return v ? isEachRun(v, all) : false; }
  return i.each_run ?? i.kind === "video";
}
export const needsSetup = (inputs: AutomationInput[]) => inputs.some((i) => !i.hidden && i.each_run === undefined);
/** The questions the setup asks: every input but the hidden people. */
export const questions = (inputs: AutomationInput[]) => inputs.filter((i) => !i.hidden);

/** The person's answer to "what changes each run?": the ticked inputs change, the rest are kept. */
export function applyAnswers(inputs: AutomationInput[], eachRun: string[]): AutomationInput[] {
  const ticked = new Set(eachRun);
  const out = inputs.map((i) => (i.hidden ? { ...i } : { ...i, each_run: ticked.has(i.key) }));
  return out.map((i) => (i.hidden ? { ...i, each_run: !!out.find((v) => v.key === i.video_key)?.each_run } : i));
}

/** The recipe from a plan's steps: every changeable part becomes a {kind_N} slot with what was used kept as its value.
 *  `keep` carries video inputs an older save already made (their keys stay, so the steps that point at them still do). */
export function templateFromSteps(src: Array<{ index: number; tool: string; label: string; source: string | null; options: Record<string, any> }>, names: Map<string, string> = new Map(), keep: AutomationInput[] = [], env: Record<string, string | undefined> = process.env): { steps: AutomationStep[]; inputs: AutomationInput[] } {
  const inputs: AutomationInput[] = [];
  const count: Record<string, number> = {};
  const add = (kind: InputKind, i: Omit<AutomationInput, "key" | "kind">): string => { const key = `${kind}_${(count[kind] = (count[kind] ?? 0) + 1)}`; inputs.push({ key, kind, ...i }); return key; };
  const videos = new Map<string, string>();
  for (const i of keep.filter((x) => x.kind === "video")) {
    inputs.push({ ...i }); count.video = Math.max(count.video ?? 0, Number(i.key.split("_")[1]) || 0);
    if (typeof i.value === "string") videos.set(i.value.toLowerCase(), i.key);
  }
  const video = (id: string) => {
    const k = id.toLowerCase();
    if (!videos.has(k)) { const n = count.video ?? 0; videos.set(k, add("video", { label: n === 0 ? "The video" : `Video ${n + 1}`, value: id, from_name: names.get(k) ?? null })); }
    return videos.get(k)!;
  };
  const many = src.length > 1;
  const at = (label: string, index: number) => (many ? `${label} · step ${index}` : label);
  const roots: Array<string | null> = [];
  const noteLabel: Record<string, string> = { swap: "The swap note", recast: "The note", restyle: "The style note", trend: "The note", character: "The description" };
  const steps = src.map((s) => {
    const o: Record<string, any> = JSON.parse(JSON.stringify(s.options ?? {}));
    // what the quote filled in is recomputed at run time from the new inputs
    delete o.seconds; delete o.usd; delete o.units; delete o.priced_by;
    let source = s.source;
    if (source && UUID_RE.test(source)) source = slot(video(source));
    // the video whose people this step works on: its own, or the one the step it builds on started from
    const ref = String(source ?? "").match(REF_RE);
    const root = slotOf(source) ?? (ref ? roots[Number(ref[1]) - 1] ?? null : null);
    roots.push(root);
    if (s.tool === "swap" || s.tool === "recast" || s.tool === "trend") {
      if (Array.isArray(o.cast) && o.cast.length === 1) { o.character = o.cast[0]?.character ?? null; o.character_asset_id = o.cast[0]?.character_asset_id ?? null; delete o.cast; }
      if (slotOf(o.who)) { /* already a recipe */ } else if (Array.isArray(o.cast) && o.cast.length > 1) {
        const cast: CastValue[] = o.cast.map((m: any) => { const v = { label: typeof m?.label === "string" && m.label.trim() ? m.label : null, character: m?.character ?? null, character_asset_id: m?.character_asset_id ?? null }; return { ...v, name: characterName(v, names) }; });
        o.who = slot(add("people", { label: at("Who plays each person", s.index), step: s.index, value: { cast }, from_name: cast.map((m) => characterName(m, names) ?? "?").join(", "), video_key: root }));
        delete o.cast; delete o.character; delete o.character_asset_id; delete o.targets;
      } else {
        const v: CharacterValue = { character: o.character ?? null, character_asset_id: o.character_asset_id ?? null };
        const id = String(v.character_asset_id ?? "");
        if (UUID_RE.test(id) || (!id && v.character)) {
          o.character_asset_id = slot(add("character", { label: at("The character", s.index), step: s.index, value: v, from_name: characterName(v, names) }));
          o.character = null;
        }
        if (root) {
          const targets = Array.isArray(o.targets) ? o.targets.map(String).filter(Boolean) : [];
          o.who = slot(add("people", { label: at("Who changes", s.index), step: s.index, value: targets.length ? { targets } : {}, from_name: targets.length ? targets.join(", ") : null, video_key: root, hidden: true }));
          delete o.targets;
        }
      }
      if (s.tool === "trend" && o.trend_id && !slotOf(o.trend_id)) {
        const t = trendById(o.trend_id);
        o.trend_id = slot(add("trend", { label: at("The trend", s.index), step: s.index, value: { id: o.trend_id, name: t?.name ?? o.trend_name ?? null }, from_name: t?.name ?? o.trend_name ?? null }));
        delete o.trend_name;
      }
    }
    if (s.tool === "restyle") {
      if (o.style_id && !slotOf(o.style_id)) { o.style_id = slot(add("style", { label: at("The style", s.index), step: s.index, value: { id: o.style_id, name: o.style_name ?? null }, from_name: o.style_name ?? null })); delete o.style_name; }
      if (UUID_RE.test(String(o.character_asset_id ?? ""))) o.character_asset_id = slot(add("image", { label: at("The reference picture", s.index), step: s.index, value: o.character_asset_id, from_name: names.get(String(o.character_asset_id).toLowerCase()) ?? null }));
    }
    if (s.tool !== "instrument" && s.tool !== "blueprint" && typeof o.prompt === "string" && o.prompt.trim() && !slotOf(o.prompt)) {
      o.prompt = slot(add("text", { label: at(noteLabel[s.tool] ?? "The note", s.index), step: s.index, value: o.prompt.trim(), from_name: snippet(o.prompt.trim()) }));
    }
    if (s.tool === "instrument") {
      const inst = instrumentById(o.endpoint, env);
      if (o.inputs && typeof o.inputs === "object") {
        o.inputs = Object.fromEntries(Object.entries(o.inputs as Record<string, any>).map(([field, v]) => {
          const kind = inst?.media_fields?.[field] ?? (/video/i.test(field) ? "video" : "image");
          const list = Array.isArray(v);
          const one = (x: any, k: number) => {
            const id = String(x ?? "");
            if (!UUID_RE.test(id)) return x;
            if (kind === "video") return slot(video(id));
            if (kind === "image") return slot(add("image", { label: at(list && v.length > 1 ? `Picture ${k + 1}` : "The picture", s.index), step: s.index, value: id, from_name: names.get(id.toLowerCase()) ?? null }));
            return x;
          };
          return [field, list ? v.map(one) : one(v, 0)];
        }));
      }
      if (o.params && typeof o.params.prompt === "string" && o.params.prompt.trim() && !slotOf(o.params.prompt)) o.params = { ...o.params, prompt: slot(add("text", { label: at("The prompt", s.index), step: s.index, value: o.params.prompt.trim(), from_name: snippet(o.params.prompt.trim()) })) };
    }
    return { index: s.index, tool: s.tool, label: s.label, source, options: o };
  });
  return { steps, inputs };
}
export const templateFromPlan = (plan: Plan, names: Map<string, string> = new Map(), env?: Record<string, string | undefined>) => templateFromSteps(plan.steps, names, [], env);

function missing(i: AutomationInput): AssistantError {
  const say: Record<InputKind, string> = { video: `Add a video for "${i.label}"`, image: `Add a picture for "${i.label}"`, character: `Pick "${i.label}"`, text: `Write "${i.label}"`, style: `Pick "${i.label}"`, trend: `Pick "${i.label}"`, people: `Pick "${i.label}"` };
  return new AssistantError("input_missing", say[i.kind] ?? `Add "${i.label}"`);
}
const asCharacter = (v: any): CharacterValue => {
  if (v && typeof v === "object") return { character: v.character ?? null, character_asset_id: v.character_asset_id ?? null };
  const s = String(v ?? "");
  return UUID_RE.test(s) || REF_RE.test(s) ? { character: null, character_asset_id: s } : { character: s || null, character_asset_id: null };
};
const plain = (v: any) => (v && typeof v === "object" ? v.id ?? v.character_asset_id ?? null : v);

/** The value each input takes on this run: what was given, else what was kept. Hidden people fall back to what was
 *  saved; runAutomation checks that against the video first. */
export function valuesFor(inputs: AutomationInput[], given: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const i of inputs) {
    if (given[i.key] !== undefined && given[i.key] !== null) out[i.key] = given[i.key];
    else if (i.kind === "people" && i.hidden) out[i.key] = i.value ?? {};
    else if (!isEachRun(i, inputs) && i.value !== undefined && i.value !== null) out[i.key] = i.value;
  }
  return out;
}

/** The recipe with this run's inputs in it: the raw plan pricePlan validates and prices. */
export function instantiate(steps: AutomationStep[], inputs: AutomationInput[], given: Record<string, any>): { title?: string; steps: any[] } {
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  const values = valuesFor(inputs, given);
  const value = (key: string) => {
    const i = byKey.get(key);
    if (!i) throw new AssistantError("plan_invalid", `The recipe refers to ${key}, which it does not have`);
    if (values[key] === undefined) throw missing(i);
    return values[key];
  };
  const walk = (x: any): any => {
    if (typeof x === "string") { const k = slotOf(x); return k ? plain(value(k)) : x; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return { steps: steps.map((s) => {
    const o: Record<string, any> = JSON.parse(JSON.stringify(s.options ?? {}));
    const who = slotOf(o.who); delete o.who;
    if (who) {
      const pv: PeopleValue = value(who) ?? {};
      if (Array.isArray(pv.cast) && pv.cast.length > 1) o.cast = pv.cast.map((m) => ({ label: m?.label ?? null, character: m?.character ?? null, character_asset_id: m?.character_asset_id ?? null }));
      else if (Array.isArray(pv.cast) && pv.cast.length === 1) { o.character = pv.cast[0].character ?? null; o.character_asset_id = pv.cast[0].character_asset_id ?? null; }
      if (Array.isArray(pv.targets) && pv.targets.length) o.targets = pv.targets;
    }
    const ch = slotOf(o.character_asset_id);
    if (ch && byKey.get(ch)?.kind === "character") { const v = asCharacter(value(ch)); o.character = v.character; o.character_asset_id = v.character_asset_id; }
    const st = slotOf(o.style_id);
    if (st) { const v = value(st); o.style_id = plain(v); if (v && typeof v === "object" && v.name) o.style_name = v.name; }
    return { tool: s.tool, label: s.label, source: s.source ? walk(s.source) : s.source, options: walk(o) };
  }) };
}

/** What came in the request, cleaned per kind; anything else is dropped. */
export function cleanGiven(body: any, inputs: AutomationInput[]): Record<string, any> {
  const out: Record<string, any> = {};
  const src = body && typeof body === "object" ? body : {};
  const charOf = (v: any): CharacterValue | null => {
    const c = asCharacter(v);
    if (c.character_asset_id && UUID_RE.test(c.character_asset_id)) return { character: null, character_asset_id: c.character_asset_id };
    if (!c.character_asset_id && c.character && /^[a-z0-9_-]{2,40}$/.test(c.character)) return { character: c.character, character_asset_id: null };
    return null;
  };
  for (const i of inputs) {
    const v = src[i.key];
    if (v === undefined || v === null || v === "") continue;
    if (i.kind === "video" || i.kind === "image") { if (UUID_RE.test(String(v))) out[i.key] = String(v); }
    else if (i.kind === "character") { const c = charOf(v); if (c) out[i.key] = c; }
    else if (i.kind === "text") { const t = String(v).replace(/\s+/g, " ").trim().slice(0, 2000); if (t) out[i.key] = t; }
    else if (i.kind === "style" || i.kind === "trend") { const id = String(typeof v === "object" ? v.id ?? "" : v).slice(0, 80); if (id) out[i.key] = { id, name: typeof v === "object" && v.name ? String(v.name).slice(0, 80) : null }; }
    else if (i.kind === "people" && typeof v === "object") {
      const pv: PeopleValue = {};
      if (Array.isArray(v.cast) && v.cast.length) {
        if (v.cast.length > 8) throw new AssistantError("plan_invalid", "Up to 8 people can be cast");
        pv.cast = v.cast.map((m: any, k: number) => { const c = charOf(m); if (!c) throw new AssistantError("input_missing", `Pick who plays person ${k + 1}`); return { ...c, label: typeof m?.label === "string" ? m.label.replace(/\s+/g, " ").trim().slice(0, 60) || null : null }; });
      }
      if (Array.isArray(v.targets)) pv.targets = v.targets.map((t: unknown) => String(t).replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 6);
      out[i.key] = pv;
    }
  }
  return out;
}

/** Every value this run uses is still there and of the right kind: a deleted photo is named, not a "plan_invalid". */
export function checkValues(ctx: Pick<Ctx, "assets" | "styles">, inputs: AutomationInput[], given: Record<string, any>): void {
  const values = valuesFor(inputs, given);
  // what is missing is said first: an empty card should hear "add a video", not about an old photo
  for (const i of inputs) if (values[i.key] === undefined) throw missing(i);
  for (const i of inputs) {
    const v = values[i.key];
    const kept = given[i.key] === undefined;
    const gone = () => new AssistantError("input_gone", kept ? `"${i.label}"${i.from_name ? ` (${i.from_name})` : ""} is no longer in your library. Add it again or pick another one for this run.` : `"${i.label}" needs a ready file from your library`);
    const asset = (id: string, kind: "video" | "image") => { const a = ctx.assets.get(String(id).toLowerCase()); if (!a || a.kind !== kind) throw gone(); };
    if (i.kind === "video") asset(v, "video");
    else if (i.kind === "image") asset(v, "image");
    else if (i.kind === "character") { const c = asCharacter(v); if (c.character_asset_id && UUID_RE.test(c.character_asset_id)) asset(c.character_asset_id, "image"); else if (!c.character_asset_id && !presetName(c.character)) throw gone(); }
    else if (i.kind === "people") {
      for (const [k, m] of ((v as PeopleValue).cast ?? []).entries()) {
        const a = m.character_asset_id && UUID_RE.test(m.character_asset_id) ? ctx.assets.get(m.character_asset_id.toLowerCase()) : true;
        if (!a || (a !== true && a.kind !== "image")) throw new AssistantError("input_gone", `The picture for person ${k + 1}${m.name ? ` (${m.name})` : ""} is no longer in your library. Pick who plays them for this run.`);
      }
    }
    else if (i.kind === "style") { if (ctx.styles.length && !ctx.styles.some((s) => s.id === plain(v))) throw new AssistantError("input_gone", `The style ${v?.name ?? ""} is no longer offered. Pick another for this run.`); }
    else if (i.kind === "trend") { if (!trendById(plain(v))) throw new AssistantError("input_gone", `The trend ${v?.name ?? ""} is no longer in the catalog. Pick another for this run.`); }
  }
}

/** People named in a recipe belong to the video they were found in. When this run brings another video, the people in
 *  it are found (cached on the asset) and: one person (or none found) means the first character plays them; several
 *  means the person must say who changes on the card first. Nothing is guessed from the old labels. */
export async function settlePeople(ctx: Pick<Ctx, "assets">, inputs: AutomationInput[], given: Record<string, any>, detect: (assetId: string) => Promise<Array<{ label: string }> | null>): Promise<Record<string, any>> {
  const out = { ...given };
  const values = valuesFor(inputs, given);
  for (const p of inputs.filter((i) => i.kind === "people")) {
    if (given[p.key] !== undefined || !p.video_key) continue;
    const savedVideo = inputs.find((i) => i.key === p.video_key)?.value;
    const now = values[p.video_key];
    if (!now || String(now).toLowerCase() === String(savedVideo ?? "").toLowerCase()) continue;
    const saved: PeopleValue = p.value ?? {};
    const named = (saved.cast?.length ?? 0) > 1 || (saved.targets?.length ?? 0) > 0;
    if (!named) continue; // one character for whoever is in it, as when it was saved
    const people = await detect(String(now)).catch(() => null);
    const name = String(ctx.assets.get(String(now).toLowerCase())?.name ?? "The new video");
    if (people && people.length <= 1) { out[p.key] = saved.cast?.length ? { cast: [{ ...saved.cast[0], label: people[0]?.label ?? null }] } : {}; continue; }
    throw new AssistantError("people_required", people ? `${name} has ${people.length} people. Pick ${saved.cast ? "who plays each of them" : "who changes"} on the card, then run it.` : `Pick ${saved.cast ? "who plays each person" : "who changes"} in ${name} on the card, then run it.`);
  }
  return out;
}

const idsIn = (x: any, out: string[] = []): string[] => {
  if (typeof x === "string") { if (UUID_RE.test(x)) out.push(x); }
  else if (Array.isArray(x)) x.forEach((v) => idsIn(v, out));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => idsIn(v, out));
  return out;
};
async function assetNames(sb: SupabaseClient, u: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniq = [...new Set(ids.map((x) => x.toLowerCase()))];
  if (!uniq.length) return names;
  const r = await sb.from("studio_assets").select("id,name").eq("user_id", u).in("id", uniq);
  if (r.error) throw r.error;
  for (const a of (r.data ?? []) as any[]) names.set(String(a.id).toLowerCase(), a.name);
  return names;
}

/** The setup questions for a chat's confirmed plan, before anything is saved. */
export async function draftAutomation(sb: SupabaseClient, u: string, plan: Plan, env?: Record<string, string | undefined>) {
  const t = templateFromPlan(plan, await assetNames(sb, u, idsIn(plan.steps)), env);
  return { name: plan.title.slice(0, 80), steps: t.steps, inputs: t.inputs };
}

export async function createAutomation(sb: SupabaseClient, u: string, p: { name: string; plan: Plan; conversation_id?: string | null; description?: string | null; each_run?: string[] | null; env?: Record<string, string | undefined> }): Promise<Automation> {
  const name = String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || p.plan.title.slice(0, 80) || "Automation";
  const t = templateFromPlan(p.plan, await assetNames(sb, u, idsIn(p.plan.steps)), p.env);
  if (!questions(t.inputs).length) throw new AssistantError("automation_no_input", "Nothing in this plan can change between runs, so there is nothing to run it on again");
  const inputs = Array.isArray(p.each_run) ? applyAnswers(t.inputs, p.each_run.map(String)) : t.inputs;
  const r = await sb.from("studio_automations").insert({ user_id: u, name, description: p.description ?? null, steps: t.steps, inputs, source_conversation: p.conversation_id ?? null }).select("*").single();
  if (r.error) throw r.error;
  return r.data as Automation;
}

/** Automations saved before inputs had kinds kept only the video as an input (and lost its id). Their inputs are rebuilt
 *  from the steps, the video found again by its file name, and the card asks the setup question. Not written back until
 *  the person answers it. */
export async function normalizeAutomation(sb: SupabaseClient, a: Automation, env?: Record<string, string | undefined>): Promise<Automation> {
  if (!a.inputs.length || !a.inputs.every((i) => i.kind === "video" && i.each_run === undefined)) return a;
  const names = await assetNames(sb, a.user_id, idsIn(a.steps));
  const wanted = a.inputs.filter((i) => !i.value && i.from_name).map((i) => String(i.from_name));
  const byName = new Map<string, string>();
  if (wanted.length) {
    const r = await sb.from("studio_assets").select("id,name,kind,status").eq("user_id", a.user_id).in("name", wanted);
    if (r.error) throw r.error;
    for (const x of (r.data ?? []) as any[]) if (x.kind === "video" && x.status === "ready" && !byName.has(x.name)) byName.set(x.name, x.id);
  }
  const keep = a.inputs.map((i) => ({ ...i, value: i.value ?? (i.from_name ? byName.get(i.from_name) ?? null : null) }));
  const t = templateFromSteps(a.steps, names, keep, env);
  return { ...a, steps: t.steps, inputs: t.inputs };
}

function shown(ctx: Ctx, names: Map<string, string>, i: AutomationInput, v: any): string | null {
  if (v === undefined || v === null) return null;
  if (i.kind === "video" || i.kind === "image") return ctx.assets.get(String(v).toLowerCase())?.name ?? null;
  if (i.kind === "character") return characterName(asCharacter(v), names);
  if (i.kind === "text") return `"${snippet(String(v))}"`;
  if (i.kind === "style" || i.kind === "trend") return v?.name ?? null;
  if (i.kind === "people") return ((v as PeopleValue).cast ?? []).map((m) => characterName(m, names)).filter(Boolean).join(" and ") || null;
  return null;
}

/** Runs the recipe with this run's inputs: a new conversation, the plan confirmed, the first step started. */
export async function runAutomation(sb: SupabaseClient, deps: AssistantDeps, a: Automation, given: Record<string, any>): Promise<Conversation> {
  const ctx = await buildCtx(sb, deps, a.user_id);
  checkValues(ctx, a.inputs, given);
  const settled = await settlePeople(ctx, a.inputs, given, async (id) => {
    const cached = ctx.assets.get(id.toLowerCase())?.probe?.people;
    if (Array.isArray(cached)) return cached;
    const { detectPeople } = await import("./studio-people.js");
    return Promise.race([detectPeople(sb, deps, a.user_id, id), new Promise<null>((r) => setTimeout(() => r(null), 25_000))]);
  });
  const raw = instantiate(a.steps, a.inputs, settled);
  const plan = await pricePlan(ctx, { title: a.name, steps: raw.steps });
  const values = valuesFor(a.inputs, settled);
  const names = new Map([...ctx.assets.values()].map((x: any) => [String(x.id).toLowerCase(), String(x.name)]));
  const changed = a.inputs.filter((i) => !i.hidden && isEachRun(i, a.inputs)).map((i) => shown(ctx, names, i, values[i.key])).filter(Boolean) as string[];
  const files = [...new Set(a.inputs.flatMap((i) => (i.kind === "video" || i.kind === "image" ? [values[i.key]] : i.kind === "character" ? [asCharacter(values[i.key]).character_asset_id] : i.kind === "people" ? ((values[i.key] as PeopleValue)?.cast ?? []).map((m) => m.character_asset_id) : [])).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()))]
    .map((id) => ctx.assets.get(id)).filter(Boolean);
  const now = new Date().toISOString();
  const title = `${a.name} · ${changed[0] ? changed[0].replace(/\.[a-z0-9]{2,4}$/i, "").replace(/^"|"$/g, "") : `run ${(a.runs ?? 0) + 1}`}`.slice(0, 120);
  const c: Conversation = {
    id: randomUUID(), user_id: a.user_id, title, status: "open", plan, run: null, automation_id: a.id, created_at: now, updated_at: now,
    messages: [
      { id: randomUUID(), role: "user", text: changed.length ? `Run "${a.name}" with ${changed.join(", ")}.` : `Run "${a.name}" again.`, attachments: files.map((x: any) => ({ asset_id: x.id, name: x.name, kind: x.kind, seconds: Number(x.probe?.duration) > 0 ? Number(x.probe.duration) : null })), at: now },
      { id: randomUUID(), role: "assistant", text: `Running "${a.name}": ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}, ${plan.estimate ? "about " : ""}${plan.total_credits} credits.`, plan_id: plan.id, at: now },
    ],
  };
  startRun(c);
  const ins = await sb.from("studio_conversations").insert({ id: c.id, user_id: c.user_id, title: c.title, status: c.status, messages: c.messages, plan: c.plan, run: c.run, automation_id: a.id, created_at: now, updated_at: now });
  if (ins.error) throw ins.error;
  const out = await advanceRun(sb, deps, c);
  const bump = await sb.from("studio_automations").update({ runs: (a.runs ?? 0) + 1, last_run_at: now, updated_at: now }).eq("id", a.id).eq("user_id", a.user_id);
  if (bump.error) throw bump.error;
  return out;
}

export function registerAutomations(app: Express, sbFn: () => SupabaseClient, deps: AssistantDeps = {}): void {
  const env = deps.env ?? process.env, log = deps.log ?? ((s: string) => console.log(s));
  const userId = (req: Request): string | null => (req.auth && "user_id" in req.auth ? req.auth.user_id : null);
  const fail = (res: Response, e: any) => {
    if (e instanceof AssistantError || e instanceof StudioError || e instanceof InstrumentError) return res.status(e.status).json({ error: e.code, detail: e.message });
    const msg = String(e?.message ?? e);
    if (/relation .* does not exist/i.test(msg)) return res.status(503).json({ error: "automations_unavailable", detail: "The automations migration has not been applied" });
    console.error("[automations]", msg);
    res.status(500).json({ error: "automations_failed", detail: msg.slice(0, 200) });
  };
  const load = async (sb: SupabaseClient, u: string, id: string): Promise<Automation> => {
    if (!UUID_RE.test(id)) throw new AssistantError("automation_not_found", "No such automation", 404);
    const r = await sb.from("studio_automations").select("*").eq("id", id).eq("user_id", u).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new AssistantError("automation_not_found", "No such automation", 404);
    return normalizeAutomation(sb, r.data as Automation, env);
  };
  const pub = (a: Automation) => ({ id: a.id, name: a.name, description: a.description, steps: a.steps, inputs: a.inputs, needs_setup: needsSetup(a.inputs), runs: a.runs, last_run_at: a.last_run_at, created_at: a.created_at, updated_at: a.updated_at });
  const confirmedPlan = async (sb: SupabaseClient, u: string, cid: string) => {
    if (!UUID_RE.test(cid)) throw new AssistantError("conversation_not_found", "Which chat?", 404);
    const c = await sb.from("studio_conversations").select("id,plan,title,messages").eq("id", cid).eq("user_id", u).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) throw new AssistantError("conversation_not_found", "Which chat?", 404);
    if (!c.data.plan || c.data.plan.status !== "confirmed") throw new AssistantError("no_confirmed_plan", "Only a plan that was confirmed can be saved");
    return c.data as { id: string; plan: Plan; title: string; messages: any[] };
  };
  const answers = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String).filter((k) => /^[a-z]+_\d+$/.test(k)).slice(0, 40) : null);

  app.get("/api/studio/automations", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const r = await sb.from("studio_automations").select("*").eq("user_id", u).order("updated_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      const list = await Promise.all(((r.data ?? []) as Automation[]).map((a) => normalizeAutomation(sb, a, env)));
      res.json({ automations: list.map(pub), enabled: !!toolsEnabled(env).assistant });
    } catch (e) { fail(res, e); }
  });
  // the setup questions for a chat's plan: what it would keep, and what could change each run
  app.get("/api/studio/automations/draft", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const c = await confirmedPlan(sb, u, String(req.query.conversation_id ?? ""));
      const d = await draftAutomation(sb, u, c.plan, env);
      const card = (c.messages ?? []).map((m: any) => m?.setup).find((s: any) => s && s.id === String(req.query.setup_id ?? ""));
      res.json({ draft: { name: card?.name ?? d.name, steps: d.steps, inputs: d.inputs, suggested: card?.suggested ?? [] } });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const cid = String(req.body?.conversation_id ?? "");
      const c = await confirmedPlan(sb, u, cid);
      const a = await createAutomation(sb, u, { name: String(req.body?.name ?? c.title), plan: c.plan, conversation_id: cid, description: req.body?.description ? String(req.body.description).slice(0, 400) : null, each_run: answers(req.body?.each_run), env });
      // the assistant's setup card in that chat now reads as saved
      const setupId = String(req.body?.setup_id ?? "");
      if (setupId && Array.isArray(c.messages) && c.messages.some((m: any) => m?.setup?.id === setupId)) {
        const messages = c.messages.map((m: any) => (m?.setup?.id === setupId ? { ...m, setup: { ...m.setup, status: "saved", automation_id: a.id, name: a.name } } : m));
        const w = await sb.from("studio_conversations").update({ messages }).eq("id", cid).eq("user_id", u);
        if (w.error) throw w.error;
      }
      log(`[automations] saved ${a.id} for ${u} (${a.inputs.filter((i) => !i.hidden && i.each_run).map((i) => i.kind).join(",") || "nothing"} each run)`);
      res.status(201).json({ automation: pub(a) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/studio/automations/:id", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const runs = await sb.from("studio_conversations").select("id,title,status,run,created_at,updated_at").eq("user_id", u).eq("automation_id", a.id).order("created_at", { ascending: false }).limit(20);
      if (runs.error) throw runs.error;
      res.json({ automation: pub(a), runs: (runs.data ?? []).map((c: any) => ({ id: c.id, title: c.title, status: c.status, run_status: c.run?.status ?? null, steps_done: (c.run?.steps ?? []).filter((s: any) => s.status === "done").length, steps: (c.run?.steps ?? []).length, created_at: c.created_at, updated_at: c.updated_at })) });
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/studio/automations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (req.body?.name !== undefined) { const name = String(req.body.name).replace(/\s+/g, " ").trim().slice(0, 80); if (!name) throw new AssistantError("name_empty", "Give it a name"); patch.name = name; }
      if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description).slice(0, 400) : null;
      // the setup question answered again: what changes each run (an older automation is written in the new shape here)
      const each = answers(req.body?.each_run);
      if (each) { patch.inputs = applyAnswers(a.inputs, each); patch.steps = a.steps; }
      // settings a person may change without rebuilding the recipe: copies, model, prompt
      if (req.body?.steps && Array.isArray(req.body.steps)) {
        const next = a.steps.map((s) => { const edit = req.body.steps.find((x: any) => x?.index === s.index); if (!edit?.options || typeof edit.options !== "object") return s; const allowed = ["copies", "model", "params"]; const o = { ...s.options }; for (const k of allowed) if (edit.options[k] !== undefined) o[k] = edit.options[k]; if (edit.options.prompt !== undefined && !slotOf(o.prompt)) o.prompt = edit.options.prompt; return { ...s, options: o, label: typeof edit.label === "string" && edit.label.trim() ? String(edit.label).slice(0, 120) : s.label }; });
        patch.steps = next;
        if (!patch.inputs && a.inputs !== undefined) patch.inputs = a.inputs;
      }
      const w = await sb.from("studio_automations").update(patch).eq("id", a.id).eq("user_id", u).select("*").single();
      if (w.error) throw w.error;
      res.json({ automation: pub(await normalizeAutomation(sb, w.data as Automation, env)) });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/studio/automations/:id", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const d = await sb.from("studio_automations").delete().eq("id", a.id).eq("user_id", u);
      if (d.error) throw d.error;
      res.json({ deleted: a.id });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations/:id/quote", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const ctx = await buildCtx(sb, { ...deps, env }, u);
      const given = cleanGiven(req.body?.inputs, a.inputs);
      checkValues(ctx, a.inputs, given);
      const plan = await pricePlan(ctx, { title: a.name, steps: instantiate(a.steps, a.inputs, given).steps });
      res.json({ credits: plan.total_credits, estimate: plan.estimate, steps: plan.steps.map((s) => ({ index: s.index, label: s.label, credits: s.credits, estimate: s.estimate })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/studio/automations/:id/run", async (req, res) => {
    const u = userId(req); if (!u) return res.status(401).json({ error: "unauthorized" });
    try {
      const sb = sbFn();
      const a = await load(sb, u, req.params.id);
      const out = await runAutomation(sb, { ...deps, env, log }, a, cleanGiven(req.body?.inputs, a.inputs));
      log(`[automations] run ${a.id} conversation ${out.id}`);
      const ids = (out.run?.steps ?? []).map((s) => s.job_id).filter(Boolean) as string[];
      res.status(201).json({ conversation: publicConversation(out, await hydrateJobs(sb, u, ids)) });
    } catch (e) { fail(res, e); }
  });
}
