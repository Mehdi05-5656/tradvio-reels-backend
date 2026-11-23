import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { draftCaption, keepLine, lineKeyword, videoKey } from "../src/studio-captions.js";
import { batchOptions, registerPostCaptions, runPostCaptions, watchCredits, POST_CAPTIONS_TOOL } from "../src/studio-post-captions.js";
import { PLANS } from "../src/studio.js";

const ANN = "11111111-1111-4111-8111-111111111111", BOB = "22222222-2222-4222-8222-222222222222";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001", A2 = "aaaaaaaa-0000-4000-8000-000000000002", A3 = "aaaaaaaa-0000-4000-8000-000000000003";

/** A small Supabase stand-in: tables, filters, upsert, rpc and signed URLs. */
function fakeSb(tables: Record<string, any[]>, rpc: Record<string, (args: any) => any> = {}) {
  let ids = 0;
  const sb: any = {
    tables, rpcs: [] as any[],
    storage: { from: () => ({ createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }) }) },
    rpc: async (name: string, args: any) => { sb.rpcs.push({ name, args }); const h = rpc[name]; return h ? h(args) : { data: true, error: null }; },
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let maybe = false, pending: any = null;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        maybeSingle() { maybe = true; return q; },
        update(v: any) { pending = { op: "update", v }; return q; },
        upsert(v: any) { pending = { op: "upsert", v }; return q; },
        then(resolve: any, reject: any) {
          const rows = (tables[table] ??= []);
          if (pending?.op === "upsert") {
            const i = rows.findIndex((r) => r.user_id === pending.v.user_id && r.video === pending.v.video);
            if (i >= 0) rows[i] = { ...pending.v }; else rows.push({ ...pending.v });
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (pending?.op === "update") for (const r of hit) Object.assign(r, pending.v);
          return Promise.resolve({ data: maybe ? (hit[0] ?? null) : hit, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    nextId: () => `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`,
  };
  return sb;
}
const assets = () => [A1, A2, A3].map((id) => ({ id, user_id: ANN, kind: "video", status: "ready", object_key: `${ANN}/${id}.mp4` }));

/** A fake Messages API: answers with `reply(body)` and records every request. */
function fakeClaude(reply: (body: any) => any) {
  const asked: any[] = [];
  const fetchFn: any = async (url: string, init: any) => {
    if (url.startsWith("https://signed/")) return new Response(new Uint8Array([1, 2, 3]));
    if (url === "https://api.anthropic.com/v1/messages") { const body = JSON.parse(init.body); asked.push(body); return new Response(JSON.stringify({ stop_reason: "end_turn", model: body.model, content: [{ type: "text", text: JSON.stringify(reply(body)) }] })); }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchFn, asked };
}
const SEEN = { summary: "A cat knocks a cup off a desk, then stares at the camera.", moments: ["cat on desk", "cup falls", "cat stares"], on_screen_text: ["monday"], tone: "funny", people: "no people, one cat", searched: ["cat knocks cup"] };
const answer = (o: any = {}) => (body: any) => {
  const text = body.messages[0].content.at(-1).text as string;
  const acc = [...text.matchAll(/(acc-\d)/g)].map((m) => m[1]);
  return { caption: o.caption ?? "the cat chose violence", hashtags: ["#cats", "#fyp", "catsoftiktok"], youtube_title: null, keywords: [{ word: "cat", from: "shown" }],
    versions: o.versions ?? [{ platform: "tiktok", caption: "cat chose violence", hashtags: ["#cats"] }, { platform: "instagram", caption: "Monday mood: the cat chose violence.", hashtags: ["#catsofinstagram"] }],
    reasons: ["Short"], alternatives: [], ...(body.output_config.format.schema.properties.seen ? { seen: SEEN } : {}),
    ...(body.output_config.format.schema.properties.by_account ? { by_account: [...new Set(acc)].map((id, i) => ({ id, caption: o.dropLine ? `version ${i}` : `version ${i} comment "clone8"`, hashtags: ["#a"] })) } : {}) };
};
const DEPS = (fetchFn: any) => ({ env: { ANTHROPIC_API_KEY: "sk" }, fetch: fetchFn, frames: async () => ["AAA", "BBB"], speech: async () => "monday again", winners: async () => [], log: () => {} });

test("the comment keyword is read from the creator's line; every version keeps the line", () => {
  assert.equal(lineKeyword('Comment "clone8" and I\'ll send you the link'), "clone8");
  assert.equal(lineKeyword("comment LINK for the free guide"), "LINK");
  assert.equal(lineKeyword("DM me guide"), "guide");
  assert.equal(lineKeyword("comment below what you think"), null);
  assert.equal(lineKeyword("follow for part 2"), null);
  assert.equal(lineKeyword('Type “recipe” for the full list'), "recipe");
  const line = 'Comment "clone8" and I\'ll send you the link';
  assert.equal(keepLine("so good", line, true, "clone8"), `so good\n\n${line}`, "word for word: added when missing");
  assert.equal(keepLine(`so good. ${line}`, line, true, "clone8"), `so good. ${line}`);
  assert.equal(keepLine('want it? drop "clone8" below', line, false, "clone8"), 'want it? drop "clone8" below', "fresh words keep the keyword: fine");
  assert.equal(keepLine("want the link? ask below", line, false, "clone8"), `want the link? ask below\n\n${line}`, "keyword lost: the line is added");
  assert.equal(keepLine("x", null, true, null), "x");
});

test("a video is watched once: the first draft watches (Opus, frames) and saves a note; later drafts write from the note (Sonnet, no frames)", async () => {
  const sb = fakeSb({ studio_assets: assets() });
  const c = fakeClaude(answer());
  const first = await draftCaption(sb, ANN, { asset_id: A1, platforms: ["tiktok", "instagram"] }, DEPS(c.fetchFn));
  assert.equal(first.watched, true);
  assert.equal(c.asked[0].model, "claude-opus-5-5");
  assert.equal(c.asked[0].messages[0].content.filter((x: any) => x.type === "image").length, 2);
  assert.ok(c.asked[0].output_config.format.schema.required.includes("seen"));
  const note = sb.tables.studio_video_notes.find((r: any) => r.video === `a:${A1}`);
  assert.equal(note.note.summary, SEEN.summary);
  assert.equal(note.note.speech, "monday again", "the speech heard is kept with the note");
  assert.deepEqual(first.hashtags, ["#cats", "#catsoftiktok"], "generic tags dropped, '#' added");

  const again = await draftCaption(sb, ANN, { asset_id: A1, platforms: ["tiktok"] }, DEPS(c.fetchFn));
  assert.equal(again.watched, false);
  assert.equal(c.asked[1].model, "claude-sonnet-5-5");
  assert.equal(c.asked[1].messages[0].content.filter((x: any) => x.type === "image").length, 0);
  assert.match(c.asked[1].messages[0].content[0].text, /A cat knocks a cup off a desk/);
  assert.match(c.asked[1].messages[0].content[0].text, /monday again/);
  assert.ok(!c.asked[1].output_config.format.schema.properties.seen, "nothing to note when not watching");

  await assert.rejects(draftCaption(sb, ANN, { asset_id: A2, platforms: ["tiktok"], watch: "never" }, DEPS(c.fetchFn)), (e: any) => e.code === "watch_needed" && e.status === 402);
  const re = await draftCaption(sb, ANN, { asset_id: A1, platforms: ["tiktok"], watch: "always" }, DEPS(c.fetchFn));
  assert.equal(re.watched, true, "watch again when asked");
  await assert.rejects(draftCaption(sb, BOB, { asset_id: A1, platforms: ["tiktok"] }, DEPS(c.fetchFn)), (e: any) => e.code === "video_not_found");
});

test("from the creator's line: alone (nothing watched, the video never described), word for word, per account with the keyword", async () => {
  const sb = fakeSb({ studio_assets: assets() });
  const line = 'Comment "clone8" and I\'ll send you the link';
  const c = fakeClaude(answer({ caption: "new drop", versions: [{ platform: "tiktok", caption: "new drop", hashtags: [] }] }));
  const only = await draftCaption(sb, ANN, { asset_id: A2, platforms: ["tiktok"], line, keep_words: true, use_video: false }, DEPS(c.fetchFn));
  assert.equal(only.watched, false);
  assert.equal(c.asked[0].messages[0].content.filter((x: any) => x.type === "image").length, 0);
  assert.match(c.asked[0].messages[0].content[0].text, /know nothing about it beyond the creator's line/);
  assert.match(c.asked[0].messages[0].content[0].text, /WORD FOR WORD/);
  assert.equal(only.caption, `new drop\n\n${line}`, "the writer dropped the line: it is added back");
  assert.equal(only.versions![0].caption, `new drop\n\n${line}`);
  assert.equal(only.keyword, "clone8");
  assert.equal((sb.tables.studio_video_notes ?? []).length, 0, "nothing watched, nothing noted");

  // per account, fresh words: each version keeps "clone8"; one that lost it gets the line back
  const c2 = fakeClaude(answer({ dropLine: true }));
  const per = await draftCaption(sb, ANN, { asset_id: A2, platforms: ["tiktok", "instagram"], line, keep_words: false, accounts: [{ id: "acc-1", platform: "tiktok" }, { id: "acc-2", platform: "tiktok" }, { id: "acc-9", platform: "facebook" }] }, DEPS(c2.fetchFn));
  assert.match(c2.asked[0].messages[0].content.at(-1).text, /The word "clone8" is what viewers must type/);
  assert.match(c2.asked[0].messages[0].content.at(-1).text, /acc-1 \(TikTok\); acc-2 \(TikTok\)\./, "an account on a network not posted to is left out");
  assert.deepEqual(per.by_account!.map((x) => x.id), ["acc-1", "acc-2"]);
  assert.ok(per.by_account!.every((x) => x.caption.includes("clone8")));
  await assert.rejects(draftCaption(sb, ANN, { asset_id: A2, platforms: ["tiktok"], use_video: false }, DEPS(c.fetchFn)), (e: any) => e.code === "line_needed");
});

test("batch options: videos deduped and capped, a line needed when the video is not used", () => {
  const o = batchOptions({ videos: [{ asset_id: A1 }, { asset_id: A1 }, { job_id: A2, output_key: "k/1.mp4" }, { asset_id: "nope" }], platforms: ["tiktok", "myspace"], accounts: [{ id: "x", platform: "tiktok" }, { id: "y", platform: "nope" }] });
  assert.deepEqual(o.videos.map(videoKey), [`a:${A1}`, `j:${A2}:k/1.mp4`]);
  assert.deepEqual(o.platforms, ["tiktok"]);
  assert.deepEqual(o.accounts.map((a) => a.id), ["x"]);
  assert.throws(() => batchOptions({ videos: [] }), (e: any) => e.code === "no_videos");
  assert.throws(() => batchOptions({ videos: [{ asset_id: A1 }], use_video: false }), (e: any) => e.code === "line_needed");
  assert.throws(() => batchOptions({ videos: Array.from({ length: 61 }, (_, i) => ({ asset_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` })) }), (e: any) => e.code === "too_many_videos");
});

test("price: watching one video is 4 credits at the house margin on the cheapest credit", () => {
  assert.equal(watchCredits({}, PLANS as any), 4);
  assert.ok(watchCredits({ STUDIO_CAPTION_WATCH_COST_USD: "0.01" }, PLANS as any) < 4);
});

test("a batch run: a few at a time, later ones told how earlier ones open, only watched videos charged, failures kept per video", async () => {
  const sb = fakeSb({ studio_assets: assets() });
  sb.tables.studio_video_notes = [{ user_id: ANN, video: `a:${A3}`, note: { ...SEEN, speech: null } }];
  const avoids: string[][] = [];
  const write: any = async (_sb: any, _u: string, req: any) => {
    avoids.push(req.avoid);
    if (req.asset_id === A2) { const { SocialError } = await import("../src/social-provider.js"); throw new SocialError("video_unavailable", "That video could not be read", 502); }
    return { caption: `cap ${req.asset_id.slice(-1)}`, hashtags: [], youtube_title: null, heard_speech: false, watched: req.asset_id !== A3 };
  };
  const job = { id: "j1", user_id: ANN, tool: POST_CAPTIONS_TOOL, lease_token: "t", attempts: 1, credits_reserved: 8, progress: {}, options: { videos: [{ asset_id: A1 }, { asset_id: A2 }, { asset_id: A3 }], platforms: ["tiktok"], per_watch: 4, use_video: true } };
  const s = await runPostCaptions(sb, job as any, { caption: write, log: () => {} }, 2);
  assert.match(s, /^done 2\/3, watched 1, charged 4/);
  const complete = sb.rpcs.find((r: any) => r.name === "studio_complete");
  assert.equal(complete.args.p_credits_charged, 4, "A1 watched (4); A3 had a note (free); A2 failed (refunded)");
  const last = sb.rpcs.filter((r: any) => r.name === "studio_renew").at(-1).args.p_progress;
  assert.equal(last.done, 3);
  assert.equal(last.results[`a:${A2}`].ok, false);
  assert.equal(last.results[`a:${A2}`].code, "video_unavailable");
  assert.deepEqual(avoids[2], ["cap 1"], "the second wave is told how the first opened");

  // taken over after a restart: what is written is kept and not written again
  const sb2 = fakeSb({});
  let calls = 0;
  const w2: any = async (_s: any, _u: string, req: any) => { calls++; return { caption: `c ${req.asset_id.slice(-1)}`, hashtags: [], youtube_title: null, heard_speech: false, watched: true }; };
  await runPostCaptions(sb2, { ...job, progress: { watched: 1, results: { [`a:${A1}`]: { ok: true, draft: { caption: "kept" } } } } } as any, { caption: w2, log: () => {} });
  assert.equal(calls, 2);
  assert.equal(sb2.rpcs.find((r: any) => r.name === "studio_complete").args.p_credits_charged, 8, "the hold caps the charge (3 watched x 4 = 12 > 8 held)");

  // the lease lost: stops quietly, never completes or fails the job
  const sb3 = fakeSb({}, { studio_renew: () => ({ data: false, error: null }) });
  assert.equal(await runPostCaptions(sb3, job as any, { caption: w2, log: () => {} }), "lease_lost");
  assert.ok(!sb3.rpcs.some((r: any) => r.name === "studio_complete" || r.name === "studio_fail"));
});

async function serve(sb: any, deps: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) req.auth = { user_id: u }; next(); });
  registerPostCaptions(app, () => sb, { env: { ANTHROPIC_API_KEY: "sk" }, plans: PLANS as any, log: () => {}, ...deps });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, user = ANN) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}

test("routes: quote, batch (credits held only for unwatched videos, job hidden and silent), its state, errors in words", async () => {
  const jobs: any[] = [];
  let balance = 100;
  const sb = fakeSb({ studio_assets: assets(), studio_jobs: jobs, studio_video_notes: [{ user_id: ANN, video: `a:${A3}`, note: SEEN }] }, {
    studio_create_job: (a: any) => {
      if (a.p_credits > balance) return { data: null, error: { message: "insufficient_credits" } };
      const j = { id: "bbbbbbbb-0000-4000-8000-000000000001", user_id: a.p_user, tool: a.p_tool, status: "queued", options: a.p_options, credits_reserved: a.p_credits, progress: {} };
      jobs.push(j); return { data: j, error: null };
    },
  });
  const s = await serve(sb);
  try {
    const q = await s.call("POST", "/api/studio/social/captions/quote", { videos: [{ asset_id: A1 }, { asset_id: A2 }, { asset_id: A3 }] });
    assert.deepEqual([q.body.credits_each, q.body.credits, q.body.unwatched.length], [4, 8, 2]);

    const b = await s.call("POST", "/api/studio/social/captions/batch", { videos: [{ asset_id: A1 }, { asset_id: A2 }, { asset_id: A3 }], platforms: ["tiktok"], line: "follow for more" });
    assert.equal(b.status, 201);
    assert.deepEqual([b.body.credits, b.body.to_watch], [8, 2]);
    const j = jobs[0];
    assert.equal(j.tool, "post_captions");
    assert.equal(j.options.per_watch, 4);
    assert.equal(j.options.line, "follow for more");
    assert.ok(j.hidden_at && j.notified_at && j.push_notified_at, "out of the library, no email, no push");

    const lineOnly = await s.call("POST", "/api/studio/social/captions/batch", { videos: [{ asset_id: A1 }], platforms: ["tiktok"], line: "follow", use_video: false });
    assert.equal(lineOnly.body.credits, 0, "from the line alone: free");

    j.progress = { done: 1, results: { [`a:${A1}`]: { ok: true, draft: { caption: "hi" } } } }; j.status = "running";
    const st = await s.call("GET", `/api/studio/social/captions/batch/${j.id}`);
    assert.deepEqual([st.body.status, st.body.done, st.body.of, st.body.results[`a:${A1}`].draft.caption], ["running", 1, 3, "hi"]);
    assert.equal((await s.call("GET", `/api/studio/social/captions/batch/${j.id}`, undefined, BOB)).status, 404, "someone else's batch");

    balance = 3;
    const poor = await s.call("POST", "/api/studio/social/captions/batch", { videos: [{ asset_id: A1 }], platforms: ["tiktok"] });
    assert.equal(poor.status, 402);
    assert.match(poor.body.detail, /takes 4 credits/);
    assert.equal((await s.call("POST", "/api/studio/social/captions/batch", { videos: [{ asset_id: A1 }] }, BOB)).body.error, "video_not_found");
  } finally { s.close(); }
});

test("Smart post: brief from the notes only (unwatched refused), answers become clean settings", async () => {
  const sb = fakeSb({ studio_assets: assets(), studio_video_notes: [{ user_id: ANN, video: `a:${A1}`, note: SEEN }] });
  const seen: any[] = [];
  const s = await serve(sb, { brief: async (b: any) => {
    seen.push(b);
    return b.answer
      ? { caption: { mode: "line_video", line: 'Comment "clone8"', keep_words: false, style: "casual" }, schedule: { per_day: 3, days: [1, 2, 3, 4, 5, 9], start: "tomorrow", times: ["9:00", "25:00", "18:30"], now: false }, autoreply: { on: true, keyword: '"clone8"!', link: "javascript:alert(1)" }, trial: null, unclear: [] }
      : { summary: "Cat clips", kinds: [{ label: "cats", count: 2 }], samples: [{ style: "Hook", caption: "the cat chose violence" }], lines: ['Comment "clone8" for the link'] };
  } });
  try {
    assert.equal((await s.call("POST", "/api/studio/social/smart/brief", { videos: [{ asset_id: A2 }] })).body.error, "watch_needed");
    const br = await s.call("POST", "/api/studio/social/smart/brief", { videos: [{ asset_id: A1 }, { asset_id: A2 }], platforms: ["tiktok"] });
    assert.equal(br.body.summary, "Cat clips");
    assert.equal(br.body.watched, 1);
    assert.match(seen[0].text, /Video 1: A cat knocks a cup/);
    assert.match(seen[0].text, /The FIRST video in full/);
    const an = await s.call("POST", "/api/studio/social/smart/answer", { text: "3 a day weekdays from tomorrow, casual, comment clone8", context: { videos: 21, today: "2026-11-23" } });
    assert.deepEqual(an.body.schedule, { per_day: 3, days: [1, 2, 3, 4, 5], start: "tomorrow", times: ["09:00", "18:30"], now: false });
    assert.deepEqual(an.body.autoreply, { on: true, keyword: "clone8", link: null }, "keyword cleaned; a non-web link dropped");
    assert.equal(an.body.caption.mode, "line_video");
    assert.equal((await s.call("POST", "/api/studio/social/smart/answer", { text: "  " })).body.error, "nothing_said");
  } finally { s.close(); }
});

test("the free route (/social/caption) never watches: it passes watch 'never', the line, the accounts and what to avoid", async () => {
  const { registerSocial } = await import("../src/studio-social.js");
  const sb = fakeSb({ studio_customers: [{ user_id: ANN, status: "active" }], studio_assets: assets() });
  const got: any[] = [];
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.auth = { user_id: ANN }; next(); });
  registerSocial(app, () => sb, { env: { STUDIO_SOCIAL_ENABLED: "true" }, log: () => {}, provider: null, caption: async (_s: any, _u: string, req: any) => { got.push(req); return { caption: "x", hashtags: [], youtube_title: null, heard_speech: false }; } } as any);
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/studio/social/caption`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset_id: A1, platforms: ["tiktok", "nope"], line: 'Comment "x"', keep_words: true, accounts: [{ id: "acc-1", platform: "tiktok" }, { id: "bad", platform: "nope" }], avoid: ["first"] }) });
    assert.equal(r.status, 200);
    assert.equal(got[0].watch, "never");
    assert.deepEqual(got[0].platforms, ["tiktok"]);
    assert.equal(got[0].line, 'Comment "x"');
    assert.equal(got[0].keep_words, true);
    assert.deepEqual(got[0].accounts.map((a: any) => a.id), ["acc-1"]);
    assert.deepEqual(got[0].avoid, ["first"]);
  } finally { server.close(); }
});
