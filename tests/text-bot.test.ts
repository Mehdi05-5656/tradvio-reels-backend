// Text Clone8 test bot (scripts/text-bot): the parts that must hold whatever the AI says. The gate and the YES, the
// route lists, the supplier-word guard, finding things in the account, the recipes, and whole chats with a scripted
// brain against a pretend account.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_WRONG, classify, claim, setPending, markShown, dropUnshown, decline, expire, newCode, spendRoom, addSpend, PENDING_TTL_MS, type Pending, type PendingStore } from "../src/text-bot/gate.js";
import { levelOf, makeApi } from "../scripts/text-bot/clone8.js";
import { guard, blanked, SAFE_LINE } from "../src/text-bot/guard.js";
import { buildCards, find, history, describeJob } from "../src/text-bot/account.js";
import { RECIPES, recipeFor, recipeText, HELPERS, featureList } from "../src/text-bot/recipes.js";
import { SYSTEM, TOOLS, markMedia } from "../src/text-bot/brain.js";
import { mockApi, IDS } from "../scripts/text-bot/mock.js";
import { prepareJob, preparePost, preparePostChange, preparePostCancel, execute, saidByPerson, jobDetails, ActionError, CAPTION_MAX, type Ctx, type VideoRef } from "../src/text-bot/actions.js";
import { makeBot, emptyState, pairCode, chatOf } from "../src/text-bot/bot.js";
import { pieces, parseUpdate, telegram } from "../src/text-bot/telegram.js";
import { prepareEdit } from "../src/text-bot/edit.js";
import type { ChatState, TurnResult } from "../src/text-bot/brain.js";

const store = (): PendingStore => ({ live: null, past: [] });
const base = { id: "a1", kind: "job", question: "q", steps: [], checks: [], credits: 10, posts: 0, count: null };
/** A pending whose question has reached the chat (the only kind a reply can release). */
const shownPending = (s: PendingStore, p: Parameters<typeof setPending>[1], t: number, rand?: () => number): Pending => { const x = setPending(s, p, t, rand); markShown(s, x.id); return x; };

test("the gate reads the words that must always work", () => {
  assert.deepEqual(classify("YES KM"), { kind: "yes", code: "KM", count: null });
  assert.deepEqual(classify("yeskm"), { kind: "yes", code: "KM", count: null });
  assert.deepEqual(classify(" y km. "), { kind: "yes", code: "KM", count: null });
  assert.deepEqual(classify("Yes KM 24"), { kind: "yes", code: "KM", count: 24 });
  // a number after YES is never a code (codes are letters, so a price can't be taken for one): the bot asks for the code
  assert.deepEqual(classify("YES 47"), { kind: "yes", code: null, count: 47 });
  assert.deepEqual(classify("yes"), { kind: "yes", code: null, count: null });
  assert.equal(classify("no").kind, "no");
  assert.equal(classify("STOP").kind, "stop");
  assert.equal(classify("stop texting me").kind, "stop");
  assert.equal(classify("Unsubscribe").kind, "stop");
  assert.equal(classify("cancel").kind, "cancel");
  assert.equal(classify("help").kind, "help");
  assert.deepEqual(classify("/start abcDEF123_-x"), { kind: "start", code: "abcDEF123_-x" }, "the pairing code keeps its capitals");
  // ordinary sentences and ordinary single words are not commands
  for (const t of ["yes post it to tiktok", "stop the clips at 5", "no caption please", "cancel the 4:45 post", "yes km and also schedule the rest", "yes go", "yes ok", "yes do", "can you help me find the cat video", "ok 30", "go 20", "quiet", "pause", "do it", "end the clip at 10", "quit posting at night"]) assert.equal(classify(t).kind, "text", t);
  // every usual opt-out word works alone (a phone line must honour them)
  for (const t of ["END", "quit", "Revoke", "stop all", "STOPALL", "unsubscribe", "opt out"]) assert.equal(classify(t).kind, "stop", t);
});

test("a YES releases only the live action, with its code, once, in time, and only if its question was shown", () => {
  const s = store(), t0 = 1_000_000;
  // a question that never reached the chat cannot be answered by anything
  const ghost = setPending(s, { ...base, id: "ghost" }, t0, () => 0.5);
  assert.equal(claim(s, { code: ghost.code }, t0 + 1).ok, false); assert.equal(s.live, null, "and it is gone, not waiting");
  setPending(s, { ...base, id: "ghost2" }, t0, () => 0.5);
  assert.equal(dropUnshown(s)?.id, "ghost2"); assert.equal(dropUnshown(s), null);

  const a = shownPending(s, { ...base, id: "a" }, t0, () => 0.5);
  assert.equal(claim(s, { code: null }, t0 + 1).ok, false);
  assert.deepEqual((claim(s, { code: "00" }, t0 + 1) as any).why, "wrong_code");
  assert.equal((s.live as Pending | null)?.id, "a", "a wrong code does not use the action up");
  assert.equal(claim(s, { code: a.code }, t0 + 5).ok, true);
  assert.equal(claim(s, { code: a.code }, t0 + 6).ok, false, "the same YES twice does nothing the second time");
  // a new request replaces the one before; the old code and the old button are dead
  const b = shownPending(s, { ...base, id: "b" }, t0 + 10, () => 0.1), c = shownPending(s, { ...base, id: "c" }, t0 + 20, () => 0.9);
  assert.notEqual(b.code, c.code);
  assert.equal(claim(s, { code: b.code }, t0 + 21).ok, false);
  assert.equal(claim(s, { id: "b" }, t0 + 21).ok, false);
  assert.equal(s.past.find((p) => p.id === "b")?.status, "replaced");
  // ten minutes, then it is gone
  assert.deepEqual((claim(s, { code: c.code }, t0 + 20 + PENDING_TTL_MS + 1) as any).why, "expired");
  assert.equal(s.live, null);
  // a large action needs its count typed; a tap alone is not enough
  const big = shownPending(s, { ...base, id: "d", count: 24 }, t0, () => 0.3);
  assert.deepEqual((claim(s, { id: "d" }, t0 + 1) as any).why, "need_count");
  assert.deepEqual((claim(s, { code: big.code, count: 23 }, t0 + 1) as any).why, "wrong_count");
  assert.equal(claim(s, { code: big.code, count: 24 }, t0 + 1).ok, true);
  shownPending(s, { ...base, id: "e" }, t0, () => 0.3);
  assert.equal(decline(s)?.id, "e"); assert.equal(expire(s, t0), null);
  assert.notEqual(newCode({ live: null, past: [], last_code: "PP" }, () => 0.5), "PP");
  for (let i = 0; i < 200; i++) assert.match(newCode({ live: null, past: [] }), /^[BCDFGHJKMNPQRSTVWXZ]{2}$/);
  assert.equal(spendRoom({ day: "2026-11-23", credits: 250 }, "2026-11-23", 300), 50);
  assert.equal(spendRoom({ day: "2026-11-22", credits: 250 }, "2026-11-23", 300), 300);
  assert.deepEqual(addSpend({ day: "2026-11-23", credits: 250 }, "2026-11-23", 40), { day: "2026-11-23", credits: 290 });
});

test("only listed routes can be called, and actions only by the executor", async () => {
  const S = "/api/studio", id = IDS.post;
  assert.equal(levelOf("GET", `${S}/me`), "read");
  assert.equal(levelOf("POST", `${S}/quote`), "read");
  assert.equal(levelOf("GET", `${S}/assets?limit=200&before=x`), "read");
  assert.equal(levelOf("POST", `${S}/links`), "light");
  assert.equal(levelOf("POST", `${S}/jobs`), "act");
  assert.equal(levelOf("PATCH", `${S}/social/posts/${id}`), "act");
  for (const [m, p] of [["POST", `${S}/checkout`], ["POST", `${S}/topup`], ["POST", `${S}/topup/auto`], ["POST", `${S}/portal`], ["POST", `${S}/billing/change`], ["POST", `${S}/account/delete`], ["POST", `${S}/assets/delete`], ["DELETE", `${S}/assets/${id}`], ["DELETE", `${S}/collections/${id}`], ["POST", `${S}/storage/delete`],
    ["GET", `${S}/admin/costs`], ["POST", `${S}/admin/creators/x/notify`], ["POST", `${S}/social/connect`], ["DELETE", `${S}/social/accounts/tiktok`], ["POST", `${S}/autoreply`], ["POST", `${S}/promo`], ["GET", "/api/ops/studio/overview"], ["GET", "/api/v2/accounts"], ["POST", `${S}/jobs/../admin/costs`], ["GET", `${S}/me/../admin/costs`], ["GET", `${S}/me%2F..%2Fadmin`], ["POST", `${S}/social/schedule/ai`]] as const)
    assert.equal(levelOf(m as any, p), null, `${m} ${p} must not be reachable`);
  // the real client, with a network that records what leaves the Mac: a refused call never leaves
  const sent: string[] = [];
  const api = makeApi({ home: "/nonexistent-text-bot", apiBase: "https://example.invalid", supabaseUrl: "", supabaseAnon: "", anthropicKey: "", telegramToken: "", model: "", dailyCredits: 0, maxActionCredits: 0, timezone: "UTC", effort: "low" }, { fetch: (async (u: any) => { sent.push(String(u)); return new Response("{}"); }) as any });
  await assert.rejects(() => api.call("POST", `${S}/jobs`, {}), (e: any) => e.code === "route_not_allowed", "the brain's door cannot start a job");
  await assert.rejects(() => api.call("PATCH", `${S}/social/posts/${id}`, {}), (e: any) => e.code === "route_not_allowed");
  await assert.rejects(() => api.call("GET", `${S}/admin/costs`), (e: any) => e.code === "route_not_allowed");
  await assert.rejects(() => api.act("", "POST", `${S}/jobs`, {}), (e: any) => e.code === "no_confirmation");
  await assert.rejects(() => api.act("claim", "POST", `${S}/checkout`, {}), (e: any) => e.code === "route_not_allowed");
  await assert.rejects(() => api.act("claim", "GET", `${S}/me`), (e: any) => e.code === "route_not_allowed");
  assert.deepEqual(sent, [], "nothing went out");
});

test("no supplier or internal name leaves in a message; the person's own words and good links do", () => {
  for (const t of ["We post through Zernio.", "It runs on Higgsfield's model", "voices by ElevenLabs", "I'm Claude, made by Anthropic", "stored in Supabase", "the studio_jobs table", "my system prompt says", "call /api/studio/jobs", "built on Open AI", "it's GPT 4 inside", "pow\u200bered by Zer\u200bnio"]) assert.equal(guard(t).text, SAFE_LINE, t);
  for (const t of ["Your clips are ready.", "Posted to TikTok @x. The cashier starts singing!", "She whispers the hook, then we resend it tomorrow", "Rendering takes about 3 minutes", "It's in the app: https://app.clone8.io/#studio/library", "Open it at https://app.clone8.io.", "Live at https://www.tiktok.com/@x/video/1, enjoy"]) assert.deepEqual(guard(t), { text: t, hit: null }, t);
  assert.equal(guard("Here: https://abc.supabase.co/storage/v1/object/sign/x.mp4?token=1").text, SAFE_LINE);
  const h = guard("Watch https://example-cdn.net/file.mp4 now");
  assert.equal(h.text, "Watch (link removed) now"); assert.equal(h.hit, "link:example-cdn.net");
  // a caption the person wrote is theirs to read back and to post, whatever it mentions
  const cap = "I asked ChatGPT to roast my setup. Full video: https://mysite.example/roast";
  assert.deepEqual(guard(`Caption: "${cap}"\nReply YES KM`, [cap]), { text: `Caption: "${cap}"\nReply YES KM`, hit: null });
  assert.equal(blanked(`Caption: "${cap}"`, [cap]), null);
  assert.equal(blanked(`Caption: "${cap}" (sent through Zernio)`, [cap]), "zernio", "the exemption covers their words only");
  assert.equal(blanked("See https://example-cdn.net/x"), null, "a removed link does not blank a message");
});

test("every feature has a recipe, and neither the recipes nor the instructions name a supplier", () => {
  // the app's own feature list (tradvio-reels-v2 src/lib/features.ts, Nov 23 2026) → the recipe that covers it
  const app: Record<string, string> = { reshoot: "reshoot", splitscreen: "splitscreen", clips: "clips", live: "live_clips", captions: "captions", accounts: "import", stories: "story", town: "story", films: "films", motivation: "motivation", stunts: "stunts", kage: "kage",
    blueprint: "blueprint", swap: "swap", recast: "recast", styles: "styles", trends: "trends", influencer: "characters", characters: "characters", instruments: "instruments", automations: "automations", publish: "post", replies: "auto_replies", performance: "performance", library: "library" };
  for (const [page, id] of Object.entries(app)) assert.ok(recipeFor(id), `no recipe for the ${page} page`);
  // every job tool the server's quote accepts for customers
  for (const tool of ["clips", "captions", "import", "story", "motivation", "longform", "kage_motion", "stunts", "reshoot", "splitscreen", "blueprint", "blueprint_versions", "swap", "recast", "restyle", "trend", "character", "instrument"]) assert.ok(RECIPES.some((r) => r.job_tool === tool), `no recipe starts ${tool}`);
  for (const text of [SYSTEM, featureList(), ...RECIPES.map(recipeText), ...TOOLS.map((t) => t.description), ...Object.values(HELPERS).map((h) => h.about)]) {
    assert.equal(blanked(text), null, `a banned name in: ${text.slice(0, 80)}`);
    assert.ok(!/managed service|we run your accounts/i.test(text), text.slice(0, 80));
  }
  // a recipe says what a feature does and costs the person, never what it costs us or how it is made
  for (const r of RECIPES) assert.ok(!/cost us|our cost|margin|supplier|vendor|provider/i.test(recipeText(r)), r.id);
  // every helper goes to a route on the reading list, and none can ask for a paid fresh analysis
  for (const [name, h] of Object.entries(HELPERS)) {
    assert.equal(levelOf(h.method, h.path({ asset_id: IDS.cat, collection_id: IDS.col, job_id: IDS.swapJob, url: "x", q: "x" })), "read", name);
    assert.ok(!("fresh" in (h.body?.({ asset_id: IDS.cat, fresh: true }) ?? {})), `${name} must not pass "fresh"`);
  }
});

test("the account is found by what was done, not by file names", () => {
  const api = mockApi(), d = api.data;
  const cards = buildCards({ jobs: d.jobs, assets: d.assets, collections: d.collections, posts: d.posts, accounts: d.accounts });
  // "that video where we made him a cat": the swap whose character is the cat, though no file is called "cat video"
  const cat = find(cards, "that video where we made him into a cat", { type: "result" });
  assert.equal(cat[0]?.job_id, IDS.swapJob); assert.match(cat[0].line, /replaced by your character "tabby cat"/);
  assert.equal(find(cards, "cats", { tool: "swap" })[0]?.job_id, IDS.swapJob, "plural still finds it");
  assert.equal(find(cards, "the cashier singing clip")[0]?.asset_id, IDS.clipB);
  assert.equal(find(cards, "800 bet")[0]?.asset_id, IDS.clipA);
  assert.equal(find(cards, "pool backyard story")[0]?.job_id, IDS.storyJob);
  assert.equal(find(cards, "friday stream", { type: "collection" })[0]?.collection_id, IDS.col);
  assert.equal(find(cards, "", { type: "post" })[0]?.post_id, IDS.post);
  assert.equal(find(cards, "", { character: true })[0]?.asset_id, IDS.cat);
  assert.deepEqual(find(cards, "purple elephant spaceship"), [], "nothing is better than a wrong guess");
  assert.equal(find(cards, "desert well", { type: "file", posted: true })[0]?.asset_id, IDS.clipA, "a video is found by the caption it was posted with");
  assert.ok(history(cards, { type: "result" }).length === 2);
  assert.match(describeJob(d.jobs[0], new Map([[IDS.cat, { name: "tabby cat.jpg", prompt: "an orange tabby" }], [IDS.podcast, { name: "Podcast clip 3.mp4" }]])).line, /^Swap · on "Podcast clip 3"/);
});

test("links in tool answers become marks; internal fields are dropped", () => {
  const media: string[] = [];
  const out = markMedia({ loops: [{ id: "subway", poster: "https://x.supabase.co/storage/v1/object/sign/a/b/c/d/e/f/poster.jpg?token=abcdefghijk", cost_usd: 0.4, object_key: "u/x" }], note: "ok" }, media);
  assert.deepEqual(out, { loops: [{ id: "subway", poster: "media:1" }], note: "ok" });
  assert.equal(media.length, 1);
});

/** The account's own name for a video, as the brain builds it from the index. */
const titles = (api: ReturnType<typeof mockApi>) => (v: VideoRef): string | null => {
  const a = v.asset_id ? api.data.assets.find((x: any) => x.id === v.asset_id) : null;
  if (a) return a.probe?.title ?? a.name;
  const j = v.job_id ? api.data.jobs.find((x: any) => x.id === v.job_id && (x.outputs ?? []).some((o: any) => o.key === v.output_key)) : null;
  return j ? `${j.tool} result` : null;
};
const ctxOf = (api: ReturnType<typeof mockApi>, over: Partial<Ctx> = {}): Ctx => ({ api, store: store(), spend: undefined, now: Date.now(), timezone: "America/Los_Angeles", dailyCredits: 300, maxActionCredits: 300, recentUserText: [], rand: () => 0.5,
  titleOf: titles(api), nameOf: (id) => api.data.assets.find((x: any) => x.id === id)?.name ?? null, ...over });

test("a job question names the tool and what will run; it is held for the YES and stopped if the price rose", async () => {
  const api = mockApi(), ctx = ctxOf(api);
  const p = await prepareJob(ctx, { tool: "swap", asset_id: IDS.podcast, options: { model: "light", character_asset_id: IDS.cat } });
  assert.equal(api.acts.length, 0, "preparing starts nothing");
  assert.match(p.question, /^Start Swap \(43 s × 2\)\.\nVideo: "Podcast clip 3"\nPlayed by: your character "tabby cat"\n/, "the tool, the video and the character, from the account's records");
  assert.match(p.question, /\nCost: 86 credits\. Balance 1,840 → 1,754\.\n/); assert.match(p.question, new RegExp(`reply: YES ${p.code}\n\\(${p.code} is this question's code\\.\\)`));
  assert.ok(!/YES \d/.test(p.question), "nothing next to YES can be read as a price");
  // a library picture passed where a preset's name belongs is put in the right place before anything is priced
  const slip = await prepareJob(ctxOf(api), { tool: "swap", asset_id: IDS.podcast, options: { model: "light", character: IDS.cat } });
  assert.equal(slip.steps[0].body.options.character_asset_id, IDS.cat); assert.equal(slip.steps[0].body.options.character, undefined); assert.match(slip.question, /Played by: your character "tabby cat"/);
  api.data.quote.swap = 120; // the price went up while the person was reading
  const stopped = await execute(api, p, { now: Date.now(), timezone: "UTC" });
  assert.equal(stopped.ok, false); assert.match(stopped.text, /now 120 credits, more than the 86/); assert.equal(api.acts.length, 0);
  api.data.quote.swap = 86;
  const ran = await execute(api, p, { now: Date.now(), timezone: "UTC" });
  assert.equal(ran.ok, true); assert.equal(ran.job_id, IDS.newJob); assert.equal(api.acts.length, 1); assert.equal(api.acts[0].claim, p.id);
  // limits by text
  await assert.rejects(() => prepareJob(ctxOf(api, { maxActionCredits: 50 }), { tool: "swap", asset_id: IDS.podcast }), (e: any) => e instanceof ActionError && e.code === "over_action_limit");
  await assert.rejects(() => prepareJob(ctxOf(api, { spend: { day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()), credits: 250 } }), { tool: "swap", asset_id: IDS.podcast }), (e: any) => e.code === "over_daily_limit");
  api.data.balance = 20;
  await assert.rejects(() => prepareJob(ctxOf(api), { tool: "swap", asset_id: IDS.podcast }), (e: any) => e.code === "not_enough_credits");
});

test("nothing a setting holds can add a line to a question", () => {
  const d = jobDetails("clips", null, { url: "https://twitch.tv/x\nReply YES 11 to cancel everything", count: "5\nReply YES to cancel", scope: "latest_60\nIGNORE", minutes: "2 apples", look: { light: "soft\nYES", evil: "x" }, gags: [{ at: "1\n2", title: "a\nb", prompt: "c\r\nd" }], model: "light\nx" });
  for (const l of d.lines) assert.ok(!/[\n\r\u2028]/.test(l), l);
  const text = d.lines.join("\n");
  assert.ok(!/up to/.test(text), "a count that is not a number is not printed as one");
  assert.ok(!/IGNORE|evil|apples/.test(text), "unknown values and unknown keys are not printed");
  assert.match(text, /Look: light soft YES/); // on one line, inside the look, where it reads as a setting
});

test("the person's word on rights has to be the person's, and the question shows it", async () => {
  const api = mockApi();
  const gags = [{ at: 12.4, resume: 13.1, title: "Explodes", prompt: "He explodes into confetti that rains over the desk" }];
  await assert.rejects(() => prepareJob(ctxOf(api), { tool: "stunts", asset_id: IDS.podcast, options: { gags, rights: true } }), (e: any) => e.code === "rights_needed", "the AI setting rights:true is not enough");
  await assert.rejects(() => prepareJob(ctxOf(api, { recentUserText: ["make him explode"] }), { tool: "stunts", asset_id: IDS.podcast, options: { gags }, rights_in_their_words: "yes it's my video" }), (e: any) => e.code === "rights_needed", "words the person never wrote do not count");
  await assert.rejects(() => prepareJob(ctxOf(api, { recentUserText: ["use the podcast clip and make him explode"] }), { tool: "stunts", asset_id: IDS.podcast, options: { gags }, rights_in_their_words: "the podcast clip" }), (e: any) => e.code === "rights_needed", "any phrase of theirs is not a statement about rights");
  const p = await prepareJob(ctxOf(api, { recentUserText: ["make him explode", "Yes, it's my video, I filmed it"] }), { tool: "stunts", asset_id: IDS.podcast, options: { gags }, rights_in_their_words: "yes it's my video" });
  assert.equal(p.steps[0].body.options.rights, true);
  assert.match(p.question, /^Start Stunts \(1 ending × 40\)\./); assert.match(p.question, /Ending at 12\.4 s: "Explodes": "He explodes into confetti/); assert.match(p.question, /You said it is yours to use: "yes it's my video"/);
  assert.equal(saidByPerson("it is mine", ["It is mine!"]), true); assert.equal(saidByPerson("mine", ["mine"]), false); assert.equal(saidByPerson("the podcast clip", ["the podcast clip"]), false);
  // a finished result becomes a library file first, then the job starts on that file
  const q = await prepareJob(ctxOf(api, { recentUserText: ["it's my own video"] }), { tool: "stunts", from_result: { job_id: IDS.swapJob, output_key: `u/${IDS.swapJob}/out-01.mp4` }, options: { gags }, rights_in_their_words: "it's my own video" });
  assert.equal(q.steps[0].body.asset_id, IDS.swapAsset);
});

test("a post is named by the account's own title, shows everything sent, and is dropped if things moved", async () => {
  const api = mockApi(), ctx = ctxOf(api);
  const p = await preparePost(ctx, { videos: [{ asset_id: IDS.clipB }], group: "group a", caption: "Wait for it", when: "now" });
  assert.deepEqual(p.steps[0].body.accounts, [IDS.tiktok, IDS.insta], "a group is opened into its accounts when the question is written");
  assert.match(p.question, /^Post "The cashier starts singing"\nto tiktok @clone8test, instagram @clone8test\nnow\.\nCaption: "Wait for it"\n/); assert.match(p.question, /can't be pulled back/); assert.match(p.question, /group's own sign-off/);
  assert.equal(p.steps[0].body.schedule_at, undefined);
  // whatever the AI calls a video, the question shows the account's title; a video the account does not have is refused
  await assert.rejects(() => preparePost(ctx, { videos: [{ asset_id: "00000000-0000-4000-8000-000000009999" }], platforms: ["tiktok"] }), (e: any) => e.code === "video_not_found");
  const cap = "x".repeat(CAPTION_MAX + 1);
  await assert.rejects(() => preparePost(ctx, { videos: [{ asset_id: IDS.clipB }], platforms: ["tiktok"], caption: cap }), (e: any) => e.code === "caption_too_long", "a caption that cannot be read in full is not posted from here");
  const long = "A long caption. ".repeat(60).trim(), full = await preparePost(ctx, { videos: [{ asset_id: IDS.clipB }], platforms: ["tiktok"], caption: long, captions_by_account: { [IDS.tiktok]: "TikTok words", "not-an-account": "smuggled" } });
  assert.ok(full.question.includes(`Caption: "${long}"`), "shown in full, not cut"); assert.match(full.question, /tiktok @clone8test gets its own caption: "TikTok words"/);
  assert.deepEqual(full.steps[0].body.captions_by_account, { [IDS.tiktok]: "TikTok words" }, "a caption for an account that is not in the post is not sent");
  api.data.accounts.pop(); // Instagram was unlinked while the person was reading
  const gone = await execute(api, p, { now: Date.now(), timezone: "UTC" });
  assert.equal(gone.ok, false); assert.equal(api.acts.length, 0);
  await assert.rejects(() => preparePost(ctx, { videos: [{ asset_id: IDS.clipB }], platforms: ["youtube"] }), (e: any) => e.code === "not_linked");
  await assert.rejects(() => preparePost(ctx, { videos: [], platforms: ["tiktok"] }), (e: any) => e.code === "no_video");
  // "move it to 10 minutes from now": counted from the YES
  const now = Date.now(), c = await preparePostChange(ctxOf(api, { now }), { post_id: IDS.post, minutes_from_yes: 10 });
  assert.match(c.question, /to 10 minutes after your YES/);
  const later = now + 7 * 60_000, done = await execute(api, c, { now: later, timezone: "UTC" });
  assert.equal(done.ok, true); assert.equal(api.acts.at(-1)!.body.schedule_at, new Date(later + 10 * 60_000).toISOString());
  // edited in the app after the question went out: left alone
  const c2 = await preparePostChange(ctxOf(api), { post_id: IDS.post, caption: "New words" });
  api.data.posts[0].updated_at = new Date(Date.now() + 1000).toISOString();
  const left = await execute(api, c2, { now: Date.now(), timezone: "UTC" });
  assert.equal(left.ok, false); assert.match(left.text, /changed somewhere else/);
  const k = await preparePostCancel(ctxOf(api), { post_ids: [IDS.post] });
  assert.match(k.question, /Cancel this scheduled post/); assert.equal(k.steps[0].method, "DELETE");
  // more than ten posts: the count goes in the reply
  const many = await preparePost(ctxOf(api), { videos: Array.from({ length: 12 }, () => ({ asset_id: IDS.clipA })), account_ids: [IDS.tiktok], when: "now" });
  assert.equal(many.count, 12); assert.match(many.question, new RegExp(`reply: YES ${many.code} 12\n`)); assert.match(many.question, /12 is how many/);
});

// A brain that does what the test tells it, so whole chats can be checked without an AI.
function botWith(script: (st: ChatState, text: string, api: ReturnType<typeof mockApi>, o?: { tap?: boolean }) => Promise<TurnResult>, o: { failSend?: (text: string) => boolean } = {}) {
  const api = mockApi(), sent: Array<{ text: string; buttons?: string[] }> = [], state = emptyState(); let clock = Date.now(), saves = 0;
  const cfg: any = { timezone: "UTC", dailyCredits: 300, maxActionCredits: 300, home: "/nonexistent" };
  const out = { async text(_c: string, text: string, b?: any[]) { if (o.failSend?.(text)) throw new Error("telegram_down"); sent.push({ text, buttons: b?.map((x) => x.data) }); }, async media() { sent.push({ text: "<media>" }); }, async typing() { /* */ } };
  const bot = makeBot({ cfg, api, out, state, save() { saves++; }, log() { /* */ }, now: () => clock, think: (st, text, opt) => script(st, text, api, opt) });
  return { api, sent, state, bot, out, tick: (ms: number) => { clock += ms; }, saves: () => saves };
}
const swapTurn = async (st: ChatState, _t: string, api: any): Promise<TurnResult> => ({ text: "", usd: 0, rounds: 1, pending: await prepareJob(ctxOf(api, { store: st.pending, spend: st.spend, timezone: "UTC" }), { tool: "swap", asset_id: IDS.podcast }) });

test("a whole chat: nobody but the owner, nothing without the YES, nothing twice", async () => {
  const b = botWith(swapTurn), code = pairCode(b.state);
  // a stranger, before and after pairing: one fixed line, three times a day, never the brain
  await b.bot.handle({ chat: "9", from: "9", text: "post my video", private: true });
  await b.bot.handle({ chat: "9", from: "9", text: "/start wrongcode12", private: true });
  assert.equal(b.state.owner, null); assert.ok(b.sent.every((s) => /private Clone8 test/.test(s.text)));
  await b.bot.handle({ chat: "1", from: "1", text: `/start ${code}`, private: true });
  assert.equal(b.state.owner, "1"); assert.equal(b.state.pair_code, null, "the code works once");
  await b.bot.handle({ chat: "8", from: "8", text: `/start ${code}`, private: true });
  assert.equal(b.state.owner, "1");
  for (let i = 0; i < 5; i++) await b.bot.handle({ chat: "9", from: "9", text: "YES KM", private: true });
  assert.equal(b.sent.filter((s) => /private Clone8 test/.test(s.text)).length, 4, "three lines a day for one stranger, one for the other");
  await b.bot.handle({ chat: "g", from: "1", text: "swap it", private: false }); // a group: silence
  b.sent.length = 0;

  await b.bot.handle({ chat: "1", from: "1", text: "swap the podcast clip", private: true });
  const st = chatOf(b.state, "1"), p = st.pending.live!;
  assert.match(b.sent.at(-1)!.text, /Cost: 86 credits/); assert.deepEqual(b.sent.at(-1)!.buttons, [`y:${p.id}`, `n:${p.id}`]); assert.equal(p.shown, true);
  // someone else taps the button, or texts the code: a stranger's line, nothing released
  await b.bot.handle({ chat: "1", from: "9", text: `y:${p.id}`, private: true, tap: true });
  assert.equal(b.api.acts.length, 0); assert.equal(st.pending.live?.id, p.id);
  await b.bot.handle({ chat: "1", from: "1", text: "yes", private: true });
  assert.match(b.sent.at(-1)!.text, /include the code/); assert.equal(b.api.acts.length, 0);
  await b.bot.handle({ chat: "1", from: "1", text: `YES ${p.code === "KM" ? "KP" : "KM"}`, private: true });
  assert.match(b.sent.at(-1)!.text, /doesn't match/); assert.equal(b.api.acts.length, 0);
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true });
  assert.equal(b.api.acts.length, 1); assert.match(b.sent.at(-1)!.text, /^Started: Swap/);
  assert.equal(st.spend?.credits, 86); assert.equal(st.watches.length, 1);
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true });
  await b.bot.handle({ chat: "1", from: "1", text: `y:${p.id}`, private: true, tap: true });
  assert.equal(b.api.acts.length, 1, "a second YES and a late tap start nothing more");

  // a new request replaces the waiting one; the old button is dead, the new one works; NO leaves things alone
  await b.bot.handle({ chat: "1", from: "1", text: "swap it again", private: true }); const first = st.pending.live!;
  await b.bot.handle({ chat: "1", from: "1", text: "actually do it once more", private: true }); const second = st.pending.live!;
  await b.bot.handle({ chat: "1", from: "1", text: `y:${first.id}`, private: true, tap: true });
  assert.equal(b.api.acts.length, 1); assert.match(b.sent.at(-1)!.text, /no longer waiting/);
  await b.bot.handle({ chat: "1", from: "1", text: "no", private: true });
  assert.equal(st.pending.live, null); assert.equal(b.api.acts.length, 1); assert.equal(second.status, "declined");
  // ten minutes pass
  await b.bot.handle({ chat: "1", from: "1", text: "swap it", private: true }); const late = st.pending.live as unknown as Pending;
  b.tick(PENDING_TTL_MS + 1000);
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${late.code}`, private: true });
  assert.equal(b.api.acts.length, 1); assert.match(b.sent.at(-1)!.text, /Nothing is waiting|ran out of time/);
  // STOP quiets the bot and cancels nothing; an empty message and a sticker do not reach the brain
  await b.bot.handle({ chat: "1", from: "1", text: "STOP", private: true });
  assert.equal(st.muted, true); assert.match(b.sent.at(-1)!.text, /won.t message you on my own/);
  await b.bot.handle({ chat: "1", from: "1", text: "", private: true });
  assert.match(b.sent.at(-1)!.text, /text, links, videos and pictures/);
});

test("talking about something else withdraws the waiting question, so a later yes can't release it", async () => {
  // Nov 24: a question waited for the headband clip; the person said "no, the Speed clip"; the bot asked "the Speed clip
  // instead?"; the person's "yes" was taken for the old question, and its code then edited the wrong clip
  let turn = 0;
  const b = botWith(async (st, _t, api) => (++turn === 1 ? swapTurn(st, "", api) : { text: "Do you mean the other clip instead?", pending: null, usd: 0, rounds: 1, sent: turn === 2 ? [`1. "The cashier starts singing" [f:${IDS.clipB}]`] : undefined }));
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "swap the podcast clip", private: true });
  const st = chatOf(b.state, "1"), first = st.pending.live!;
  await b.bot.handle({ chat: "1", from: "1", text: "no, on the clip you just sent me", private: true });
  assert.equal(st.pending.live, null, "withdrawn"); assert.equal(first.status, "replaced");
  assert.ok(st.history.some((h) => h.role === "event" && /withdrawn because the person wrote something else/.test(h.text)));
  assert.ok(st.history.some((h) => h.role === "event" && /Sent to the person: 1\. "The cashier starts singing"/.test(h.text)), "what was shown is in the history for the next turn");
  await b.bot.handle({ chat: "1", from: "1", text: "yes", private: true });
  await b.bot.handle({ chat: "1", from: "1", text: `YES ${first.code}`, private: true });
  await b.bot.handle({ chat: "1", from: "1", text: `y:${first.id}`, private: true, tap: true });
  assert.equal(b.api.acts.length, 0, "the old question's yes, code and button all release nothing");
});

test("a question that never reached the chat cannot be answered", async () => {
  // Telegram fails exactly when the question is sent: the person only ever sees "something went wrong"
  let fail = true;
  const b = botWith(swapTurn, { failSend: (text) => fail && /reply: YES/.test(text) });
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "swap the podcast clip", private: true });
  const st = chatOf(b.state, "1");
  assert.match(b.sent.at(-1)!.text, /Something went wrong/); assert.equal(st.pending.live, null, "what it prepared is gone");
  const lost = st.pending.past[0]; assert.equal(lost.status, "failed"); fail = false;
  await b.bot.handle({ chat: "1", from: "1", text: `YES ${lost.code}`, private: true });
  await b.bot.handle({ chat: "1", from: "1", text: `y:${lost.id}`, private: true, tap: true });
  assert.equal(b.api.acts.length, 0, "its code and its button release nothing");
  // the brain itself breaking after it prepared something: the same
  const c = botWith(async (st2, _t, api) => { await prepareJob(ctxOf(api, { store: st2.pending, timezone: "UTC" }), { tool: "swap", asset_id: IDS.podcast }); throw new Error("assistant_unavailable_529"); });
  c.state.owner = "1";
  await c.bot.handle({ chat: "1", from: "1", text: "swap it", private: true });
  const code = chatOf(c.state, "1").pending.past[0].code;
  assert.equal(chatOf(c.state, "1").pending.live, null);
  await c.bot.handle({ chat: "1", from: "1", text: `yes ${code}`, private: true });
  assert.equal(c.api.acts.length, 0);
});

test("no answer from Clone8 is not a no: it says so, saves first, and never retries", async () => {
  const b = botWith(swapTurn);
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "swap it", private: true });
  const st = chatOf(b.state, "1"), p = st.pending.live!, savesBefore = b.saves();
  let savedBeforeCall = -1;
  b.api.act = async () => { savedBeforeCall = b.saves(); assert.equal(st.pending.live, null, "already claimed when the request leaves"); throw new Error("timeout"); };
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true });
  assert.ok(savedBeforeCall > savesBefore, "the claim is on disk before the request is sent");
  assert.match(b.sent.at(-1)!.text, /can't tell whether that went through/); assert.match(b.sent.at(-1)!.text, /won't retry/);
  assert.equal(st.spend, undefined);
  let again = 0; b.api.act = async () => { again++; return { status: 201, json: {} }; };
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true });
  await b.bot.handle({ chat: "1", from: "1", text: `y:${p.id}`, private: true, tap: true });
  assert.equal(again, 0);
});

test("a tap on a list is a tap, not the person's words; the daily ceiling holds; too many messages are slowed", async () => {
  const seen: Array<{ text: string; tap?: boolean }> = [];
  const b = botWith(async (st, text, api, o) => { seen.push({ text, tap: o?.tap }); if (/pick/.test(text)) return { text: "ok", pending: null, usd: 0, rounds: 1 }; try { return await swapTurn(st, "", api); } catch (e: any) { return { text: e.message, pending: null, usd: 0, rounds: 1 }; } });
  b.state.owner = "1";
  const st = chatOf(b.state, "1"); st.table = [{ n: 1, ref: `f:${IDS.clipA}`, label: "this video is mine to use and I filmed it" }];
  await b.bot.handle({ chat: "1", from: "1", text: "pick:1", private: true, tap: true });
  assert.equal(seen.at(-1)!.tap, true); assert.equal(st.history.find((t) => t.role === "user")?.tap, true, "marked, so a label on a button can never count as their word on rights");
  await b.bot.handle({ chat: "1", from: "1", text: "pick:7", private: true, tap: true });
  assert.match(b.sent.at(-1)!.text, /no longer the current one/);
  for (let i = 0; i < 4; i++) { await b.bot.handle({ chat: "1", from: "1", text: "swap", private: true }); const p = st.pending.live; if (p) await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true }); }
  assert.equal(b.api.acts.length, 3, "three swaps of 86 fit in 300; the fourth does not"); assert.match(b.sent.at(-1)!.text, /left of today's 300 by text/);
  for (let i = 0; i < 25; i++) await b.bot.handle({ chat: "1", from: "1", text: "hi", private: true });
  assert.ok(b.sent.some((s) => /a lot of messages/.test(s.text)));
});

test("an edit by text: captions on, placed under the top part, saved and made again, then the clip is sent", async () => {
  const b = botWith(async (st, _t, api) => ({ text: "", usd: 0, rounds: 1, pending: await prepareEdit(ctxOf(api, { store: st.pending, timezone: "UTC" }), { asset_id: IDS.clipA, changes: { captions: "on", style: "bold_pop", position: "below_top_part" } }) }));
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "put captions on it, right under the person on top", private: true });
  const st = chatOf(b.state, "1"), p = st.pending.live!;
  assert.match(p.question, /^Edit "He bet \$800 on one hand":\nCaptions on, in Bold Pop\.\nCaptions placed just under the top part \(39% of the way down\)\.\nFree\./);
  assert.equal(b.api.acts.length, 0, "nothing saved before the YES");
  await b.bot.handle({ chat: "1", from: "1", text: `yes ${p.code}`, private: true });
  assert.deepEqual(b.api.acts.map((x) => `${x.method} ${x.path.replace(/.*\/projects\//, "")}`), [`PUT ${IDS.projA}`, `POST ${IDS.projA}/render`]);
  const saved = b.api.data.projects[IDS.projA];
  assert.equal(saved.doc.captions.on, true); assert.deepEqual(saved.doc.captions.style, { id: "bold_pop", y: 0.39 }); assert.equal(saved.rev, 4);
  assert.ok(b.api.data.lastOps.some((o: any) => o.op === "captions.y" && o.to === 0.39), "the edit is recorded as the assistant's, like the app's");
  assert.match(b.sent.at(-1)!.text, /Making the edited clip now/);
  await b.bot.watch(); assert.equal(st.watches.length, 1, "still being made: nothing sent yet");
  b.api.data.renderLater(); await b.bot.watch();
  assert.equal(b.sent.at(-1)!.text, "<media>", "the edited clip is sent into the chat"); assert.equal(st.watches.length, 0);
});

test("edits that can't be done say why; a word fix finds the word wherever it is", async () => {
  const api = mockApi();
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.podcast, changes: { captions: "on" } }), (e: any) => e.code === "no_project");
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { trim_start: 20, trim_end: 8 } }), (e: any) => e.code === "too_short");
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: {} }), (e: any) => e.code === "nothing_to_change");
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { fix_words: [{ find: "zebra", replace: "x" }] } }), (e: any) => e.code === "word_not_found");
  const f = await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { fix_words: [{ find: "Die!", replace: "DIE" }], trim_start: 2, remove_pauses: true } });
  assert.deepEqual(f.steps[0].body.doc.captions.fixes, [{ i: 5, text: "DIE" }, { i: 7, text: "DIE" }]);
  assert.match(f.question, /Cut the first 2 s \(28 s → 26 s\)\./); assert.match(f.question, /"Die!" in the captions becomes "DIE" \(2 times\)/); assert.match(f.question, /Long pauses cut/);
  api.data.projects[IDS.projA].doc.kind = "split"; api.data.projects[IDS.projA].doc.split = { layout: { captions: true }, caption_style: "bold_pop" };
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { position: "top" } }), (e: any) => e.code === "split_position");
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { style: "neon" } }), (e: any) => e.code === "style");
});

test("a Captions run's result is sent: it lands in the library, not in the run's outputs", async () => {
  const b = botWith(swapTurn); b.state.owner = "1";
  const st = chatOf(b.state, "1");
  b.api.data.jobs.unshift({ id: IDS.capJob, tool: "captions", status: "done", outputs: [], options: { items: [{ asset_id: IDS.clipB, name: "The cashier starts singing.mp4" }] }, progress: { made: [{ source: IDS.clipB, asset_id: IDS.capAsset, credits: 5 }] } });
  st.watches.push({ job_id: IDS.capJob, collection_id: null, label: "Captions", tool: "captions", started: Date.now(), sent: [] });
  await b.bot.watch();
  assert.equal(b.sent.at(-1)!.text, "<media>"); assert.deepEqual(st.table, [{ n: 1, ref: `f:${IDS.capAsset}`, label: "The cashier starts singing (captions)" }]);
  assert.equal(st.watches.length, 0);
});

test("a finished result that can't be sent (the chat service is down) is tried again, three times at most", async () => {
  const b = botWith(swapTurn); b.state.owner = "1";
  const st = chatOf(b.state, "1");
  b.api.data.jobs.unshift({ id: IDS.capJob, tool: "captions", status: "done", outputs: [], options: { items: [{ asset_id: IDS.clipB, name: "The cashier starts singing.mp4" }] }, progress: { made: [{ source: IDS.clipB, asset_id: IDS.capAsset, credits: 5 }] } });
  st.watches.push({ job_id: IDS.capJob, collection_id: null, label: "Captions", tool: "captions", started: Date.now(), sent: [] });
  const media = b.out.media; let fails = 1;
  b.out.media = async (...a: any[]) => { if (fails-- > 0) throw new Error("telegram_down"); return (media as any)(...a); };
  await b.bot.watch();
  assert.equal(st.watches.length, 1, "kept after a failed send"); assert.equal(st.watches[0].send_tries, 1);
  await b.bot.watch();
  assert.equal(b.sent.at(-1)!.text, "<media>"); assert.equal(st.watches.length, 0);
  // never sendable: dropped after the third try, with a note for the brain
  st.watches.push({ job_id: IDS.capJob, collection_id: null, label: "Captions", tool: "captions", started: Date.now(), sent: [] });
  b.out.media = async () => { throw new Error("telegram_down"); };
  for (let i = 0; i < 3; i++) await b.bot.watch();
  assert.equal(st.watches.length, 0);
  assert.match(st.history.at(-1)!.text, /could not be sent/);
});

test("telegram: long replies are cut at a line; updates are read into one shape", () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the reply`).join("\n"), parts = pieces(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3900)); assert.equal(parts.join("\n").replace(/\n+/g, "\n"), long);
  assert.deepEqual(parseUpdate({ update_id: 5, message: { message_id: 9, text: "hi", chat: { id: 1, type: "private" }, from: { id: 1, username: "o" } } }), { update_id: 5, chat: "1", from: "1", name: "o", text: "hi", message_id: 9, private: true, has_file: false });
  assert.equal(parseUpdate({ update_id: 6, callback_query: { id: "c", data: "y:abc", from: { id: 1 }, message: { message_id: 3, chat: { id: 1, type: "private" } } } })?.callback_id, "c");
  assert.equal(parseUpdate({ update_id: 7, message: { message_id: 1, text: "x", chat: { id: -5, type: "group" }, from: { id: 1 } } })?.private, false);
});

test("telegram buttons: a copy button, a link only to the Clone8 app, and taps", async () => {
  const bodies: any[] = [];
  const tg = telegram("t", { fetch: (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: {} })); }) as any });
  await tg.out.text("1", "Your Clone8 code: 4821", [{ label: "Copy 4821", copy: "4821" }, { label: "Back to Clone8", url: "https://app.clone8.io/#studio/account?text=1" }, { label: "Elsewhere", url: "https://evil.example/" }, { label: "Yes", data: "y:a1" }]);
  assert.deepEqual(bodies[0].reply_markup.inline_keyboard, [[{ text: "Copy 4821", copy_text: { text: "4821" } }, { text: "Back to Clone8", url: "https://app.clone8.io/#studio/account?text=1" }, { text: "Yes", callback_data: "y:a1" }]]);
});

test("captions move by an amount from where they sit now ('15% higher', 'a bit lower')", async () => {
  const api = mockApi();
  const doc = api.data.projects[IDS.projA].doc;
  doc.captions.on = true; doc.captions.style = { id: "bold_pop", y: 0.8 };
  const up = await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { move_by: -0.15 } });
  assert.match(up.question, /Captions moved 15% higher: from 80% to 65% of the way down\./);
  assert.equal(up.steps[0].body.doc.captions.style.y, 0.65);
  // a clip never moved starts from its style's own height (Bold Pop sits at 70%)
  doc.captions.style = { id: "bold_pop" };
  const down = await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { move_by: 0.05 } });
  assert.match(down.question, /Captions moved 5% lower: from 70% to 75% of the way down\./);
  doc.captions.style = { id: "bold_pop", y: 0.95 };
  await assert.rejects(() => prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { move_by: 0.1 } }), (e: any) => e.code === "cannot_move");
});

test("every caption move says where they were, so the chat remembers earlier spots", async () => {
  const api = mockApi();
  const doc = api.data.projects[IDS.projA].doc;
  doc.captions.on = true; doc.captions.style = { id: "bold_pop", y: 0.55 };
  const exact = await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { caption_y: 0.35 } });
  assert.match(exact.question, /Captions moved from 55% to 35% of the way down\./);
  const spot = await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { position: "bottom" } });
  assert.match(spot.question, /Captions moved from 55% to 80% of the way down \(bottom\)\./);
  doc.captions.style = { id: "bold_pop" }; // never moved: its style's own height
  assert.match((await prepareEdit(ctxOf(api), { asset_id: IDS.clipA, changes: { caption_y: 0.5 } })).question, /from 70% to 50% of the way down/);
});

test("a question is withdrawn after three wrong codes: guessing the 2-letter code doesn't pay", () => {
  const s = store(), p = shownPending(s, { ...base, id: "g1" }, 1000);
  const wrong = p.code === "BC" ? "BD" : "BC";
  assert.equal(claim(s, { code: wrong }, 1001).why, "wrong_code");
  assert.equal(claim(s, { code: wrong }, 1002).why, "wrong_code");
  assert.equal(claim(s, { code: wrong }, 1003).why, "too_many");
  assert.equal(MAX_WRONG, 3);
  assert.equal(s.live, null, "withdrawn");
  assert.equal(claim(s, { code: p.code }, 1004).why, "nothing", "even the right code is too late");
});

test("their own AI app: a short fixed message, the saving first, then the links alone; the word stays blocked elsewhere", async () => {
  const { appLink, YES_MARK } = await import("../src/text-bot/app-link.js");
  const { withButtons, apartLinks } = await import("../src/text-bot/sendblue.js");
  const URL_ = "https://mcp.clone8.io/api/studio/mcp";
  const first = appLink({ kind: "signature", request: "  \"why cats hate water\" ", connected: false, connectorUrl: URL_, beside: { here: 470, there: 130 } }) as any;
  assert.equal(first.prompt, "Use Clone8 to make a Signature story, written by you here in this chat, about: why cats hate water");
  assert.deepEqual(first.buttons.map((b: any) => b.label), ["Set it up"], "first time: one link, to Clone8's set-up page");
  assert.equal(first.buttons[0].url, `https://app.clone8.io/#studio/home?ai=${encodeURIComponent(first.prompt)}`);
  assert.match(first.text, /^Or make it in Claude for 130 credits instead of 470\./);
  assert.match(first.text, /First time only, it needs a one-minute set-up: the link below walks you through it/);
  assert.ok(first.text.includes(`reply ${YES_MARK}.`), "ends with how to make it here instead");
  assert.ok(!first.text.includes("“"), "no repeated quote of the request");
  assert.ok(!/claude/i.test(first.buttons[0].url), "the set-up link names nothing");
  const again = appLink({ kind: "film", request: "a true heist", connected: true, connectorUrl: URL_ }) as any;
  assert.deepEqual(again.buttons.map((b: any) => b.label), ["Open in Claude"], "no set-up once they used it");
  assert.match(again.text, /^You can make this in Claude with Clone8\. .*Tap the link below/);
  // iMessage: the text, then each link alone in its own message (a preview card), in order; all pass the guard
  const im = withButtons(first.text, first.buttons);
  assert.equal(im, first.text, "the long links are not glued under the text");
  assert.deepEqual(apartLinks(first.buttons), [first.buttons[0].url]);
  assert.deepEqual(apartLinks(again.buttons), [again.buttons[0].url]);
  assert.equal(again.buttons[0].url, `https://claude.ai/new?q=${encodeURIComponent(again.prompt)}`);
  for (const u of apartLinks(first.buttons)) assert.deepEqual(guard(u, first.own), { text: u, hit: null });
  assert.deepEqual(guard(im, first.own), { text: im, hit: null });
  // ...but the word is still blanked anywhere the model writes it, and a model-made link to that host is removed
  assert.equal(guard("Sure, I use Claude for that.").text, SAFE_LINE);
  assert.equal(guard("Try https://claude.ai/new?q=hi").text, SAFE_LINE);
  assert.equal((appLink({ kind: "story", request: "made with ElevenLabs voices", connected: true, connectorUrl: URL_ }) as any).error, "not_sendable");
  assert.equal((appLink({ kind: "story", request: "x", connected: true, connectorUrl: URL_ }) as any).error, "missing");
  assert.equal((appLink({ kind: "story", request: "cats", connected: true, connectorUrl: "" }) as any).error, "not_available");
  // Telegram: the two fixed links become link buttons; any other outside link is still dropped
  const calls: any[] = [];
  const tg = telegram("t", { fetch: (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: {} })); }) as any });
  await tg.out.text("1", first.text, [...first.buttons, { label: "Elsewhere", url: "https://claude.ai/settings" }], first.own);
  assert.deepEqual(calls[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text), ["Set it up"]);
  assert.ok(SYSTEM.includes("send_app_link") && !/claude/i.test(SYSTEM), "the instructions never name the app");
  assert.ok(TOOLS.some((t) => t.name === "send_app_link"));
});

test("their own AI app, review fixes: no links inside, short copy, safe link characters, sent after the question, short messages not exempt", async () => {
  const { appLink } = await import("../src/text-bot/app-link.js");
  const U = "https://mcp.clone8.io/api/studio/mcp";
  for (const bad of ["cats, see https://evil.example/x?y=1", "cats www.evil.example", "cats at evil.example/x", "cats evil.com"]) assert.equal((appLink({ kind: "story", request: bad, connected: true, connectorUrl: U }) as any).error, "not_sendable", bad);
  assert.ok(!("error" in appLink({ kind: "story", request: "why cats hate water, 30 seconds. Really funny", connected: true, connectorUrl: U })), "sentences with full stops are fine");
  const q = (appLink({ kind: "story", request: "don't (really) cry", connected: true, connectorUrl: U }) as any).buttons[0].url;
  assert.ok(!/['()]/.test(q), q);
  // beside a question: the extra goes out after it, and not at all when the question was dropped
  const { YES_MARK } = await import("../src/text-bot/app-link.js");
  const b = botWith(async (st, _t, api) => ({ ...(await swapTurn(st, "", api)), after: [{ text: `Or make it there. To make it here instead, reply ${YES_MARK}.`, buttons: [], own: [] }] }));
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "make it", private: true });
  const iq = b.sent.findIndex((x) => /reply: YES/.test(x.text)), ia = b.sent.findIndex((x) => /Or make it there/.test(x.text));
  assert.ok(iq >= 0 && ia > iq, `question first (${iq}), then the extra (${ia})`);
  const code = b.state.chats["1"].pending.live!.code;
  assert.ok(b.sent[ia].text.endsWith(`reply YES ${code}.`), b.sent[ia].text);
  // a one-word message is not exempt: the reply cannot say a blocked word just because the person did
  const c = botWith(async () => ({ text: "Yes, Claude works with Clone8.", pending: null, usd: 0, rounds: 1 }));
  c.state.owner = "1";
  const seen: string[] = []; const t0 = c.out.text; c.out.text = async (ch: string, text: string, bt?: any[], own?: string[]) => { seen.push(guard(text, own).text); return t0(ch, text, bt); };
  await c.bot.handle({ chat: "1", from: "1", text: "Claude?", private: true });
  assert.ok(seen.includes(SAFE_LINE), seen.join(" | "));
});

test("their own AI app: a large question's count goes in the YES line", async () => {
  const { YES_MARK } = await import("../src/text-bot/app-link.js");
  const b = botWith(async (st, _t, api) => { const r = await swapTurn(st, "", api); r.pending!.count = 3; return { ...r, after: [{ text: `Or there. To make it here instead, reply ${YES_MARK}.`, buttons: [], own: [] }] }; });
  b.state.owner = "1";
  await b.bot.handle({ chat: "1", from: "1", text: "make it", private: true });
  const p = b.state.chats["1"].pending.live!;
  assert.ok(b.sent.some((x) => x.text.endsWith(`reply YES ${p.code} 3.`)), b.sent.map((x) => x.text).join(" | "));
});

test("their own AI app: every request the bot builds is one the app's set-up page accepts", async () => {
  const { appLink, APP_KINDS } = await import("../src/text-bot/app-link.js");
  // the app's own list (tradvio-reels-v2 src/lib/ai-link.ts AI_LEADS), kept in step by hand
  const LEADS = ["Use Clone8 to make a Signature story, written by you here in this chat, about:", "Use Clone8 to make a story video:", "Use Clone8 to make a motivation video:", "Use Clone8 to make a film:"];
  for (const kind of APP_KINDS) {
    const m = appLink({ kind, request: "y".repeat(500), connected: false, connectorUrl: "https://mcp.clone8.io/api/studio/mcp" }) as any;
    const lead = LEADS.find((l) => m.prompt.startsWith(`${l} `));
    assert.ok(lead, kind); assert.ok(m.prompt.length - lead!.length - 1 <= 180, `${kind} subject fits`);
    assert.equal(decodeURIComponent(m.buttons[0].url.split("?ai=")[1]), m.prompt);
  }
  assert.equal((appLink({ kind: "other", request: "check my balance", connected: true, connectorUrl: "https://mcp.clone8.io/x" }) as any).error, "bad_kind");
});

test("files sent in the chat: both channels carry them; intake stores each as an upload would, and says why one can't", async () => {
  const { intake, whyText, nameFor, TELEGRAM_MAX } = await import("../src/text-bot/intake.js");
  const { parseSendblue } = await import("../src/text-bot/sendblue.js");
  const { filesOf } = await import("../src/text-bot/telegram.js");
  const im = parseSendblue({ content: "", number: "+15557654321", from_number: "+15557654321", to_number: "+15550001111", is_outbound: false, status: "RECEIVED", message_handle: "h1", service: "iMessage", group_id: "", media_url: "https://cdn.sendblue.co/files/IMG_4410.MOV" })!;
  assert.deepEqual(im.files, [{ url: "https://cdn.sendblue.co/files/IMG_4410.MOV" }]);
  assert.deepEqual(filesOf({ video: { file_id: "v1", file_size: 5000, mime_type: "video/mp4" } }), [{ file_id: "v1", name: undefined, mime: "video/mp4", size: 5000 }]);
  assert.equal(filesOf({ photo: [{ file_id: "small" }, { file_id: "big" }] })[0].file_id, "big", "the largest size of a photo");
  assert.deepEqual(filesOf({ voice: { file_id: "x" } }), [], "a voice note is not a video or picture");
  assert.equal(nameFor({ url: "https://x/IMG_1.MOV" }, 1, "2026-11-26 10:00"), "IMG_1.MOV");
  assert.equal(nameFor({ file_id: "a", mime: "video/mp4" }, 2, "2026-11-26 10:00"), "Texted 2026-11-26 10:00 #2.mp4");
  // the upload: the website's route, the bucket, then complete
  const calls: string[] = [];
  const api: any = { call: async (m: string, p: string, body: any) => { calls.push(`${m} ${p}`); if (p.endsWith("/upload-url")) return body.name === "same.mp4" ? { status: 200, json: { asset_id: "a-same", existing: { name: "same.mp4" } } } : { status: 200, json: { asset_id: "a-new", path: "u/a-new.mov", token: "tok", bucket: "studio-uploads" } }; if (p.endsWith("/complete")) return { status: 200, json: { asset: { name: "IMG_4410.MOV" } } }; return { status: 404, json: {} }; } };
  const stored: any[] = [];
  const sb: any = { storage: { from: (b: string) => ({ uploadToSignedUrl: async (path: string, token: string, bytes: Buffer) => { stored.push({ b, path, token, n: bytes.length }); return { data: {}, error: null }; } }) } };
  const f: any = async (url: string) => (String(url).includes("getFile") ? new Response(JSON.stringify({ ok: true, result: { file_path: "videos/clip.mp4" } })) : new Response(new Uint8Array(1234)));
  const r = await intake({ api, sb, fetch: f, telegramToken: "tok", files: [{ url: "https://cdn.sendblue.co/files/IMG_4410.MOV" }, { url: "https://x/same.mp4" }, { file_id: "big", size: TELEGRAM_MAX + 1 }, { url: "https://x/notes.pdf" }, { file_id: "small", size: 900 }] });
  assert.deepEqual(r.got.map((g) => g.asset_id), ["a-new", "a-same", "a-new"]);
  assert.deepEqual(stored.map((x) => [x.b, x.path, x.n]), [["studio-uploads", "u/a-new.mov", 1234], ["studio-uploads", "u/a-new.mov", 1234]], "the same file again is not stored twice");
  assert.deepEqual(r.failed.map((x) => x.why), ["telegram_too_big", "not_video_or_picture"]);
  assert.match(whyText("telegram_too_big"), /20 MB/);
  assert.ok(calls.filter((c) => c.endsWith("/complete")).length === 2);
});

test("one post question can carry each video's own time and caption (3 today at set times, 2 tomorrow)", async () => {
  const api = mockApi();
  const now = Date.parse("2026-11-25T23:00:00Z"); // 3 pm Pacific
  const t = (h: number, m: number, d = 25) => new Date(Date.UTC(2026, 10, d, h + 8, m)).toISOString().replace(".000Z", "-08:00").replace(/T(\d\d)/, (_x, hh) => `T${String((Number(hh) + 16) % 24).padStart(2, "0")}`);
  void t;
  const at = (iso: string) => iso; // full ISO with offset
  const p = await preparePost(ctxOf(api, { now, timezone: "America/Los_Angeles" }), { videos: [
    { asset_id: IDS.clipA, when: at("2026-11-25T17:30:00-08:00"), caption: "One hand. 800 dollars." },
    { asset_id: IDS.clipB, when: at("2026-11-25T18:45:00-08:00"), caption: "She really started singing." },
    { asset_id: IDS.clipA, when: at("2026-11-25T20:00:00-08:00"), caption: "Watch the end." },
    { asset_id: IDS.clipB, when: at("2026-11-26T09:00:00-08:00"), caption: "Morning one." },
    { asset_id: IDS.clipA, when: at("2026-11-26T12:00:00-08:00"), caption: "Lunch one." },
  ], account_ids: [IDS.tiktok] });
  const items = p.steps[0].body.items;
  assert.deepEqual(items.map((x: any) => x.schedule_at), ["2026-11-26T01:30:00.000Z", "2026-11-26T02:45:00.000Z", "2026-11-26T04:00:00.000Z", "2026-11-26T17:00:00.000Z", "2026-11-26T20:00:00.000Z"]);
  assert.deepEqual(items.map((x: any) => x.caption), ["One hand. 800 dollars.", "She really started singing.", "Watch the end.", "Morning one.", "Lunch one."]);
  assert.match(p.question, /1\. ".+", today 5:30 PM\n {3}Caption: "One hand\. 800 dollars\."/);
  assert.match(p.question, /5\. ".+", tomorrow 12:00 PM\n {3}Caption: "Lunch one\."/);
  assert.equal(p.posts, 5);
  await assert.rejects(preparePost(ctxOf(api, { now }), { videos: [{ asset_id: IDS.clipA, when: "2026-11-25T23:05:00Z" }], account_ids: [IDS.tiktok] }), /at least 12 minutes/);
});
