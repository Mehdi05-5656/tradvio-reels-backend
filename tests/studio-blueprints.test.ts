import test from "node:test";
import assert from "node:assert/strict";
import { BLUEPRINT_OUT, bodyStretches, buildTimeline, lookById, LOOKS, overlayAss, planVersion, sfxFor, slotFor, wrapTitle, type Hook } from "../src/studio-blueprints.js";
import type { CapWord } from "../src/caption-engine.js";

// A 20 s talk: four sentences, one long pause at 9-11 s.
const W = (text: string, start: number, end: number, key = false): CapWord => ({ text, start, end, key });
const WORDS: CapWord[] = [
  W("This", 0.2, 0.4), W("store", 0.4, 0.8, true), W("is", 0.8, 1.0), W("huge.", 1.0, 1.6, true),
  W("There", 1.9, 2.1), W("are", 2.1, 2.3), W("so", 2.3, 2.5), W("many", 2.5, 2.9), W("flavours,", 2.9, 3.5, true), W("like", 3.6, 3.8), W("matcha", 3.8, 4.4, true), W("and", 4.4, 4.6), W("melon", 4.6, 5.2, true), W("and", 5.2, 5.4), W("peach.", 5.4, 6.0),
  W("How", 6.4, 6.6), W("do", 6.6, 6.7), W("people", 6.7, 7.0), W("not", 7.0, 7.3), W("get", 7.3, 7.5), W("fat?", 7.5, 8.9, true),
  W("I", 11.0, 11.1), W("counted", 11.1, 11.6), W("thirty", 11.6, 12.0), W("one", 12.0, 12.3), W("KitKats", 12.3, 13.0, true), W("in", 13.0, 13.2), W("here.", 13.2, 13.8),
];
const DUR = 20;
const HOOK: Hook = { id: "fat", title: "I wasn't ready for this *KitKat* aisle", start: 6.4, end: 8.9 };
const OWN: Hook = { id: "own", title: "Japan's *KitKat* aisle", start: null, end: null };
const look = (id: string) => lookById(id)!;

test("five looks, unique ids, sane values", () => {
  assert.deepEqual(LOOKS.map((l) => l.id), ["clean", "card", "editorial", "loud", "split"]);
  for (const l of LOOKS) {
    assert.ok(l.punch.length >= 1 && l.punch.every((z) => z >= 1 && z <= 1.5), l.id);
    assert.ok(l.title.size >= 60 && l.title.size <= 130, l.id);
  }
  assert.equal(lookById("nope"), null);
});

test("own pace: the stretches cover the whole video with no gap and no overlap", () => {
  const s = bodyStretches(WORDS, DUR, null);
  assert.equal(s[0].a, 0);
  assert.equal(s[s.length - 1].b, DUR);
  for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i].a - s[i - 1].b) < 1e-9);
  assert.ok(s.length >= 3, "cut at sentence ends");
  // no cut lands inside a word
  for (const x of s.slice(1)) assert.ok(!WORDS.some((w) => x.a > w.start + 1e-6 && x.a < w.end - 1e-6), `cut ${x.a} inside a word`);
});

test("tightened pace drops the long pause and never clips a word", () => {
  const s = bodyStretches(WORDS, DUR, 0.3);
  const kept = s.reduce((n, x) => n + x.b - x.a, 0);
  assert.ok(kept < 15, `kept ${kept}`);
  for (const w of WORDS) assert.ok(s.some((x) => x.a <= w.start + 1e-6 && x.b >= w.end - 1e-6), `${w.text} clipped`);
  assert.ok(!s.some((x) => x.a < 10.5 && x.b > 9.5), "the pause is cut");
});

test("cold open: hook stretch first, ends before the next word, words placed on the output clock", () => {
  const tl = buildTimeline(WORDS, DUR, HOOK, look("clean"));
  const h = tl.segments[0];
  assert.equal(h.hook, true);
  assert.equal(h.at, 0);
  assert.ok(h.a <= 6.4 && h.a >= 6.0, `start ${h.a}`);
  assert.ok(h.b <= 11.0 - 0.02 && h.b >= 8.9, `end ${h.b}`);
  assert.equal(tl.hookEnd, Math.round((h.b - h.a) * 1000) / 1000);
  assert.equal(tl.segments[1].a, 0);
  // the hook's words come first, then the opening again
  assert.equal(tl.words[0].text, "How");
  assert.ok(tl.words[0].start < 0.2);
  const again = tl.words.filter((w) => w.text === "How");
  assert.equal(again.length, 2, "heard in the hook and in the body");
  // monotonic output times inside the frame
  for (let i = 1; i < tl.words.length; i++) assert.ok(tl.words[i].start >= tl.words[i - 1].start - 1e-6);
  assert.ok(tl.words.every((w) => w.end <= tl.duration + 1e-6));
  assert.ok(Math.abs(tl.duration - (DUR + tl.hookEnd)) < 0.01);
});

test("no hook: the video's own opening, title only", () => {
  const tl = buildTimeline(WORDS, DUR, OWN, look("card"));
  assert.equal(tl.hookEnd, 0);
  assert.ok(!tl.segments.some((s) => s.hook));
  assert.equal(tl.duration, DUR);
});

test("punch-ins cycle through the look's zooms; the hook gets the tightest", () => {
  const l = look("loud");
  const tl = buildTimeline(WORDS, DUR, HOOK, l);
  assert.equal(tl.segments[0].zoom, Math.max(...l.punch));
  tl.segments.slice(1).forEach((s, i) => assert.equal(s.zoom, l.punch[i % l.punch.length]));
});

test("sound effects: a cut sound at the end of the hook; key-word hits spaced and outside the hook", () => {
  const l = look("loud");
  const tl = buildTimeline(WORDS, DUR, HOOK, l);
  const fx = sfxFor(l, tl);
  assert.ok(fx.some((x) => x.key === l.sfx.cut && Math.abs(x.at - (tl.hookEnd - 0.12)) < 0.01));
  const hits = fx.filter((x) => l.sfx.keywords!.includes(x.key));
  assert.ok(hits.length >= 2);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].at - hits[i - 1].at >= 1.6 - 1e-6);
  assert.ok(hits.every((x) => x.at >= tl.hookEnd + 0.4 && x.at <= tl.duration - 1));
  assert.deepEqual(sfxFor(look("card"), tl), []);
});

test("slots: fill is the frame, card is 4:5 inside it, split is the top half", () => {
  const fr = { w: BLUEPRINT_OUT.w, h: BLUEPRINT_OUT.h };
  assert.deepEqual(slotFor(look("clean"), fr), { x: 0, y: 0, w: 1080, h: 1920 });
  const c = slotFor(look("card"), fr);
  assert.ok(Math.abs(c.w / c.h - 0.8) < 0.01 && c.x > 0 && c.y + c.h < fr.h && c.w % 2 === 0 && c.h % 2 === 0);
  assert.deepEqual(slotFor(look("split"), fr), { x: 0, y: 0, w: 1080, h: 960 });
});

test("title: wrapped inside the frame, accent words in the accent font, flash only with a hook", () => {
  const measure = (t: string, _f: unknown, em: number) => t.length * em * 0.55;
  const lines = wrapTitle(HOOK.title, look("clean").title, 96, 864, measure as any);
  assert.ok(lines.length >= 2 && lines.length <= 3);
  assert.ok(lines.every((l) => l.width <= 864 || l.words.length === 1));
  const ass = overlayAss(HOOK.title, look("clean").title, { w: 1080, h: 1920 }, 0, 2.6, 1.5, measure as any);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /\\fnDM Serif Display Italic[^}]*\}KitKat/);
  assert.match(ass, /\\p1[^}]*\\1c&HFFFFFF&/, "flash");
  assert.doesNotMatch(overlayAss(OWN.title, look("clean").title, { w: 1080, h: 1920 }, 0, 2.6, null, measure as any), /\\1c&HFFFFFF&\\alpha&H40&/);
  assert.doesNotMatch(ass, /\*/, "no markup left");
});

test("planVersion: a complete EDL for every look (real fonts)", () => {
  for (const l of LOOKS) {
    const e = planVersion({ words: WORDS, duration: DUR, hook: HOOK, look: l, game: { key: "subway-official", start: 10 } });
    assert.equal(e.v, 1);
    assert.equal(e.version, `fat-${l.id}`);
    assert.equal(e.layout, l.layout);
    assert.match(e.captions_ass, /\[Events\]/);
    assert.match(e.overlay_ass, /\[Events\]/);
    // captions start after the cold open: the title has the screen during the hook
    const first = e.captions_ass.split("\n").find((x) => x.startsWith("Dialogue:"));
    const t = first!.split(",")[1].split(":").map(Number);
    assert.ok(t[0] * 3600 + t[1] * 60 + t[2] >= e.segments[1].at - 0.02, `captions from ${first}`);
    assert.equal(e.game?.key ?? null, l.layout === "split" ? "subway-official" : null);
    assert.equal(e.music?.key ?? null, l.music?.mood ?? null);
  }
});
