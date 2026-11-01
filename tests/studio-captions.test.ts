import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import opentype from "opentype.js";
import { FONTS, PRESETS, assSize, buildAss, chunkPhases, cleanStyle, layoutCaptions, prepareWords, presetById, sampleKeys, type CapWord } from "../src/caption-engine.js";
import { captionCredits, cleanSettings, cleanWords, outputFrame, filterPath, quoteCaptions, serverMeasure, fontsDir } from "../src/studio-caption-video.js";
import { outputSize, quoteClips } from "../src/studio-clips.js";
import { PLANS } from "../src/studio.js";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const measure = serverMeasure({});
const sentence = "So the rational decision maker will make the rational decision to do something productive, but the monkey doesn't like that plan.";
const WORDS: CapWord[] = sentence.split(" ").map((w, i) => ({ text: w, start: 0.2 + i * 0.32, end: 0.2 + i * 0.32 + 0.28, key: i === 3 }));
const FR = { w: 1080, h: 1920 };

test("fonts: every bundled file is there, and its metrics are the ones the engine sizes by (libass's em rule)", () => {
  for (const [id, f] of Object.entries(FONTS)) {
    const file = join(fontsDir({}), f.file);
    assert.ok(existsSync(file), `${id}: ${f.file}`);
    const ft: any = opentype.loadSync(file);
    const os2 = ft.tables.os2;
    assert.deepEqual([ft.names.fullName.en, ft.unitsPerEm, os2.usWinAscent, os2.usWinDescent], [f.name, f.upem, f.asc, f.desc], id);
  }
  assert.ok(readdirSync(fontsDir({})).includes("LICENSES.md"));
  // Montserrat Black at ASS size 200 has a 128 px em (measured against a libass render, Nov 1 2026)
  assert.equal(Math.round(assSize(FONTS.montserrat_black, 128)), 200);
});

test("the engine file is the same in the backend and the dashboard", () => {
  const dash = join(process.cwd(), "../tradvio-reels-v2/src/lib/caption-engine.ts");
  if (!existsSync(dash)) return; // the dashboard is a separate checkout; CI runs this repo alone
  const h = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  assert.equal(h(join(process.cwd(), "src/caption-engine.ts")), h(dash), "copy src/caption-engine.ts to the dashboard's src/lib/");
});

test("styles: fourteen presets; anything sent is kept in bounds and unknown fonts fall back", () => {
  assert.ok(PRESETS.length >= 12 && new Set(PRESETS.map((p) => p.id)).size === PRESETS.length);
  for (const p of PRESETS) assert.ok(FONTS[p.font], `${p.id} font`);
  const wild = cleanStyle({ id: "pill", font: "comic_sans", size: 9999, words: 0, y: 5, color: "red", active: { scale: 9, box: { color: "#ff00ff", radius: 500 } }, outline: null, anim: "explode" });
  assert.equal(wild.font, presetById("pill").font);
  assert.deepEqual([wild.size, wild.words, wild.y, wild.color, wild.active.scale, wild.active.box!.color, wild.active.box!.radius, wild.outline, wild.anim], [200, 1, 0.92, "#FFFFFF", 1.3, "#FF00FF", 60, null, "pop"]);
  assert.equal(cleanStyle({ id: "nope" }).id, PRESETS[0].id);
});

test("words: filler words out, swearing masked, junk dropped; edited words from the page checked against the video", () => {
  const ws = prepareWords([{ text: "um,", start: 0, end: 0.2 }, { text: "this", start: 0.3, end: 0.5 }, { text: "fucking", start: 0.6, end: 0.9 }, { text: "", start: 1, end: 1.2 }, { text: "works.", start: 1.3, end: 1.1 }], { fillers: true, censor: true });
  assert.deepEqual(ws.map((w) => w.text), ["this", "f******"]);
  assert.deepEqual(prepareWords([{ text: "um", start: 0, end: 0.2 }]).map((w) => w.text), ["um"], "kept unless asked");
  const edited = cleanWords([{ text: "Hello", start: 1, end: 1.4, brk: true }, { text: "x".repeat(99), start: 0.2, end: 0.5 }, { text: "late", start: 99, end: 100 }, { text: "bad", start: 2, end: 1 }], 30)!;
  assert.deepEqual(edited.map((w) => w.text.length), [40, 5], "sorted, trimmed, out-of-range and backwards words dropped");
  assert.equal(edited[1].brk, true, "a wanted line break is kept");
  // a break the person set starts a new caption there; the block sits where they dragged it
  const s = { ...presetById("karaoke"), x: 0.3 };
  const broken = layoutCaptions([{ text: "one", start: 0, end: 0.3, brk: true }, { text: "two", start: 0.4, end: 0.6 }, { text: "three", start: 0.7, end: 0.9 }], s, FR, measure);
  assert.deepEqual(broken.map((c) => c.words.map((w) => w.text)), [["one"], ["two", "three"]]);
  assert.ok(Math.abs(broken[1].lines[0].cx - 0.3 * FR.w) < 1, `centred at x: ${broken[1].lines[0].cx}`);
  const edge = layoutCaptions([{ text: "WWWWWWWWWWWWWWWWWW", start: 0, end: 1 }], { ...presetById("bold_pop"), x: 0.2 }, FR, measure)[0];
  assert.ok(edge.words[0].cx - edge.words[0].width / 2 >= 0, "a block dragged to the edge stays inside the frame");
  assert.equal(cleanWords("nope", 30), null);
});

test("layout: chunks of at most the style's words, centred, each word at its own place, never touching its neighbour", () => {
  for (const s of PRESETS) {
    const laid = layoutCaptions(prepareWords(WORDS), s, FR, measure);
    assert.ok(laid.length >= Math.ceil(WORDS.length / s.words), s.id);
    for (const ch of laid) {
      assert.ok(ch.words.length <= s.words, `${s.id} words`);
      assert.ok(ch.end > ch.start && ch.lines.length <= s.lines);
      const byLine = new Map<number, typeof ch.words>();
      for (const w of ch.words) byLine.set(w.baseline, [...(byLine.get(w.baseline) ?? []), w]);
      for (const ws of byLine.values()) {
        const left = ws[0].cx - ws[0].width / 2, right = ws[ws.length - 1].cx + ws[ws.length - 1].width / 2;
        assert.ok(left >= 0 && right <= FR.w, `${s.id} inside the frame`);
        for (let i = 1; i < ws.length; i++) {
          const gap = (ws[i].cx - ws[i].width / 2) - (ws[i - 1].cx + ws[i - 1].width / 2);
          // room for the spoken word to grow on both sides
          assert.ok(gap >= (Math.max(ws[i].width, ws[i - 1].width) * (s.active.scale - 1)) / 2 - 0.5, `${s.id} gap ${gap}`);
        }
      }
    }
    // chunks follow each other in time
    for (let i = 1; i < laid.length; i++) assert.ok(laid[i].start >= laid[i - 1].end - 0.05, `${s.id} order`);
  }
  // a sentence's end and a long pause both start a new chunk
  const broken = layoutCaptions([{ text: "Done.", start: 0, end: 0.3 }, { text: "Next", start: 0.4, end: 0.6 }, { text: "much", start: 2, end: 2.2 }], { ...presetById("karaoke") }, FR, measure);
  assert.deepEqual(broken.map((c) => c.words.map((w) => w.text)), [["Done."], ["Next"], ["much"]]);
});

test("phases: the spoken word is highlighted from its start to the next word's, with its pop; karaoke dims what is not said yet", () => {
  const s = presetById("bold_pop");
  const ch = layoutCaptions(prepareWords(WORDS), s, FR, measure)[0];
  const ph = chunkPhases(ch, s, true);
  const second = ph.filter((p) => p.word === 1);
  assert.deepEqual(second.map((p) => p.active), [false, true, false]);
  const act = second[1];
  assert.equal(act.color, "#FFE600");
  assert.ok(Math.abs(act.start - ch.words[1].start) < 1e-6 && Math.abs(act.end - ch.words[2].start) < 1e-6);
  assert.ok(Math.abs(sampleKeys(act.keys, 0.07).s - 1.12) < 1e-6, "pops to its size");
  assert.ok(sampleKeys(ph.find((p) => p.word === 0)!.keys, 0).s < 1, "the chunk pops in");
  const k = presetById("karaoke");
  const kc = layoutCaptions(prepareWords(WORDS), k, FR, measure)[0];
  const kp = chunkPhases(kc, k, false);
  assert.equal(kp.find((p) => p.word === 2 && !p.active && p.start === kc.start)!.color, k.dim, "not said yet: dim");
  assert.equal(kp.filter((p) => p.word === 0 && !p.active).pop()!.color, k.color, "said: full colour");
  const r = presetById("one_word");
  const rc = layoutCaptions(prepareWords(WORDS), r, FR, measure);
  assert.ok(rc.every((c) => c.words.length === 1));
});

test("ASS: a valid script, every word placed and timed, the fonts named as libass knows them", () => {
  for (const s of PRESETS) {
    const ass = buildAss(layoutCaptions(prepareWords(WORDS), s, FR, measure), s, FR, true);
    assert.match(ass, /^\[Script Info\]\nScriptType: v4\.00\+\nPlayResX: 1080\nPlayResY: 1920/);
    assert.ok(ass.includes(`Style: C,${FONTS[s.font].name},`), s.id);
    const ev = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    assert.ok(ev.length >= WORDS.length, `${s.id}: ${ev.length} events`);
    for (const e of ev) assert.match(e, /^Dialogue: [0-4],\d:\d\d:\d\d\.\d\d,\d:\d\d:\d\d\.\d\d,C,,0,0,0,,\{\\an5\\(pos|move)\(/, `${s.id}: ${e.slice(0, 80)}`);
    if (s.active.box) assert.ok(ev.some((e) => e.startsWith("Dialogue: 3,") && /\\p1/.test(e)), `${s.id} pill`);
    if (s.box) assert.ok(ev.some((e) => e.startsWith("Dialogue: 2,")), `${s.id} box`);
    if (s.glow) assert.ok(ev.some((e) => e.startsWith("Dialogue: 1,")), `${s.id} glow`);
  }
  // braces in what was said cannot open an override block
  const odd = buildAss(layoutCaptions([{ text: "{\\b1}hack", start: 0, end: 1 }], presetById("minimal"), FR, measure), presetById("minimal"), FR, false);
  assert.ok(odd.includes("(/b1)hack") && !odd.includes("{\\b1}"));
});

test("a real render matches the layout: the ink sits where the engine placed the word (when ffmpeg has libass)", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const bins = ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "ffmpeg"].filter((b) => spawnSync(b, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass "));
  if (!bins.length) return t.skip("no ffmpeg with libass here");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cap-test-"));
  const s = { ...presetById("minimal"), shadow: null, outline: null, anim: "none" as const, words: 1 };
  const fr = { w: 540, h: 960 };
  const laid = layoutCaptions([{ text: "HELLO", start: 0, end: 2 }], s, fr, measure);
  writeFileSync(join(dir, "a.ass"), buildAss(laid, s, fr, false));
  const r = spawnSync(bins[0], ["-v", "error", "-y", "-f", "lavfi", "-i", `color=black:s=${fr.w}x${fr.h}:d=1`, "-vf", `ass=${filterPath(join(dir, "a.ass"))}:fontsdir=${filterPath(fontsDir({}))}`, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  const px = r.stdout as Buffer;
  let minX = fr.w, maxX = 0, maxY = 0;
  for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) if (px[y * fr.w + x] > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const w = laid[0].words[0];
  assert.ok(Math.abs((minX + maxX) / 2 - w.cx) <= 3, `centre ${(minX + maxX) / 2} vs ${w.cx}`);
  assert.ok(Math.abs(maxY - w.baseline) <= 3, `baseline ${maxY} vs ${w.baseline}`);
});

test("prices: a credit per 5 seconds, at least 5 a video; the output keeps its shape within 1080x1920; captions in Clips add 3 a clip", async () => {
  assert.deepEqual([captionCredits(3), captionCredits(25), captionCredits(31), captionCredits(600)], [5, 5, 7, 120]);
  assert.deepEqual(outputFrame(1080, 1920), { w: 1080, h: 1920 });
  assert.deepEqual(outputFrame(2160, 3840), { w: 1080, h: 1920 });
  assert.deepEqual(outputFrame(3840, 2160), { w: 1920, h: 1080 });
  assert.deepEqual(outputFrame(720, 1280), { w: 720, h: 1280 });
  assert.deepEqual(outputSize(1920, 1080, "vertical"), { w: 720, h: 1280 });
  assert.deepEqual(outputSize(1920, 1080, "original"), { w: 1280, h: 720 });
  const s = cleanSettings({ style: { id: "neon" } });
  assert.deepEqual([s.style.id, s.keywords, s.fillers, s.censor], ["neon", true, true, false]);
  // the quote reads the person's videos
  const rows = [{ id: "11111111-1111-4111-8111-111111111111", kind: "video", name: "a.mp4", status: "ready", probe: { duration: 31 }, collection_id: null }, { id: "22222222-2222-4222-8222-222222222222", kind: "video", name: "b.mp4", status: "ready", probe: { duration: 12 }, collection_id: null }];
  const sb: any = { from: () => ({ select() { return this; }, eq() { return this; }, in: async () => ({ data: rows, error: null }) }) };
  const q = await quoteCaptions(sb, U, { ELEVENLABS_API_KEY: "k" }, { items: rows.map((r) => ({ asset_id: r.id, words: r.id.startsWith("1") ? [{ text: "Hi", start: 0, end: 0.4 }] : undefined })), style: { id: "pill" } });
  assert.equal(q.credits, 7 + 5);
  assert.equal(q.options.items[0].words.length, 1, "edited words ride along");
  assert.equal(q.options.items[1].words, null);
  assert.equal(q.options.style.id, "pill");
  const code = (p: Promise<any>) => p.then(() => "ok", (e) => e.code);
  assert.equal(await code(quoteCaptions(sb, U, { ELEVENLABS_API_KEY: "k" }, { items: [] })), "captions_no_video");
  assert.equal(await code(quoteCaptions(sb, U, {}, { items: [{ asset_id: rows[0].id }] })), "captions_unavailable");
  const long = { ...rows[0], probe: { duration: 1200 } };
  const sbl: any = { from: () => ({ select() { return this; }, eq() { return this; }, in: async () => ({ data: [long], error: null }) }) };
  assert.equal(await code(quoteCaptions(sbl, U, { ELEVENLABS_API_KEY: "k" }, { items: [{ asset_id: long.id }] })), "captions_too_long");
  // Clips with captions on: 3 more per clip, the style kept for the run
  const meta = async () => ({ id: "x", url: "u", title: "T", channel: "C", description: "", seconds: 900, thumbnail_url: null, chapters: [], replay: [] });
  const env = { ANTHROPIC_API_KEY: "k", SCRAPECREATORS_API_KEY: "k", ELEVENLABS_API_KEY: "k", STUDIO_YT_PROXY: "http://p" };
  const off = await quoteClips({ env, meta }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", count: 10 });
  const on = await quoteClips({ env, meta }, PLANS, null, { url: "https://youtu.be/L_Guz73e6fw", count: 10, captions: { style: { id: "comic" } } });
  assert.equal(on.options.price.per_clip, off.options.price.per_clip + 3);
  assert.equal(on.credits, off.credits + 30);
  assert.equal(on.options.captions.style.id, "comic");
  assert.equal(off.options.captions, null);
});

test("migration: captions jobs run in their own lane, one at a time per person", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${U}','ann@synthetic.invalid','{}');`);
  await db.exec(readFileSync("migrations/20261027000000_studio_foundation.sql", "utf8"));
  await db.exec("ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS owner_pass boolean NOT NULL DEFAULT false;");
  await db.exec(readFileSync("migrations/20261111000000_studio_library_clips.sql", "utf8"));
  const sql = readFileSync("migrations/20261112000000_studio_captions.sql", "utf8");
  await db.exec(sql); await db.exec(sql);
  const rpc = async (fn: string, args: any[]) => (await db.query<any>(`SELECT to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})) r`, args)).rows[0].r;
  await rpc("studio_apply_subscription", [U, "cus_1", "sub_1", "starter", "month", "active", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, 1000, 1]);
  await rpc("studio_grant", [U, 1000, "in_1", true, null]);
  assert.equal((await rpc("studio_create_job", [U, "recast", null, {}, 10])).status, "queued");
  assert.equal((await rpc("studio_create_job", [U, "captions", null, { items: [] }, 12])).tool, "captions", "starts with the parallel slot taken");
  await assert.rejects(rpc("studio_create_job", [U, "captions", null, {}, 12]), /too_many_jobs/, "one captions run at a time");
  assert.equal((await rpc("studio_create_job", [U, "clips", null, {}, 50])).tool, "clips", "clips has its own lane");
});
