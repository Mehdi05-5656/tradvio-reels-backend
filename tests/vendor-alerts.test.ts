import test from "node:test";
import assert from "node:assert/strict";
import { youtubeMeta, infoToSc, LINK_READ_DOWN, ClipsError } from "../src/studio-clips.js";
import { LinkError } from "../src/studio-youtube.js";
import { noteScrapeCreators, ownerAlert, resetAlertsForTests, scrapeCreatorsBalance } from "../src/vendor-alerts.js";

const resp = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const INFO = { id: "abcdefghijk", title: "A talk", channel: "Chan", description: "d", duration: 1500, thumbnail: "https://i.ytimg.com/x.jpg",
  chapters: [{ title: "Intro", start_time: 0 }, { title: "Main", start_time: 90 }], heatmap: [{ start_time: 10, end_time: 25, value: 0.8 }], live_status: "not_live" };

// a fresh video id each test: youtubeMeta keeps a 30-minute cache by id
let n = 0;
const url = () => `https://www.youtube.com/watch?v=vid${String(++n).padStart(8, "0")}`;
const quiet = () => undefined;

test("ScrapeCreators out of credits (402): the listing comes from yt-dlp instead, same shape", async () => {
  resetAlertsForTests();
  let asked = 0;
  const m = await youtubeMeta({ env: { SCRAPECREATORS_API_KEY: "k" }, log: quiet, fetch: (async () => resp(402, { success: false })) as any, info: async () => { asked++; return INFO; } }, url());
  assert.equal(asked, 1);
  assert.equal(m.title, "A talk"); assert.equal(m.channel, "Chan"); assert.equal(m.seconds, 1500);
  assert.deepEqual(m.chapters, [{ title: "Intro", start: 0 }, { title: "Main", start: 90 }]);
  assert.equal(m.replay.length, 1); assert.equal(m.replay[0].start, 10); assert.equal(m.replay[0].end, 25);
});

test("no answer, a 5xx, or no key: yt-dlp too; a 403/404 is about the video and stands", async () => {
  for (const f of [async () => { throw new Error("down"); }, async () => resp(503, {})]) {
    const m = await youtubeMeta({ env: { SCRAPECREATORS_API_KEY: "k" }, log: quiet, fetch: f as any, info: async () => INFO }, url());
    assert.equal(m.seconds, 1500);
  }
  assert.equal((await youtubeMeta({ env: {}, log: quiet, info: async () => INFO }, url())).title, "A talk");
  let asked = 0;
  await assert.rejects(youtubeMeta({ env: { SCRAPECREATORS_API_KEY: "k" }, log: quiet, fetch: (async () => resp(404, {})) as any, info: async () => { asked++; return INFO; } }, url()),
    (e: any) => e.code === "link_no_media");
  assert.equal(asked, 0);
});

test("both out: a plain, passing message (never the vendor's status code); a missing video still says so", async () => {
  await assert.rejects(youtubeMeta({ env: { SCRAPECREATORS_API_KEY: "k" }, log: quiet, fetch: (async () => resp(402, {})) as any, info: async () => { throw new LinkError("link_blocked", "bot check"); } }, url()),
    (e: any) => e instanceof ClipsError && e.code === "link_read_down" && e.message === LINK_READ_DOWN && e.retry === true && !/402/.test(e.message));
  await assert.rejects(youtubeMeta({ env: { SCRAPECREATORS_API_KEY: "k" }, log: quiet, fetch: (async () => resp(402, {})) as any, info: async () => { throw new LinkError("link_no_media", "That video cannot be fetched (private, removed, live or age-restricted)"); } }, url()),
    (e: any) => e.code === "link_no_media" && /private/.test(e.message));
});

test("a live or upcoming stream has no length (Clips then says so)", () => {
  assert.equal(infoToSc({ ...INFO, live_status: "is_live" }).lengthSeconds, null);
  assert.equal(infoToSc({ ...INFO, live_status: "is_upcoming" }).lengthSeconds, null);
  assert.equal(infoToSc({}).most_replayed.markers.length, 0);
});

test("owner alerts: 402 emails once per 6 hours; low balance once a day; a healthy balance never", async () => {
  resetAlertsForTests();
  const mails: any[] = [];
  const env = { RESEND_API_KEY: "r", SCRAPECREATORS_LOW_CREDITS: "2000" };
  const f = (async (_u: string, init: any) => { mails.push(JSON.parse(init.body)); return resp(200, { id: "m" }); }) as any;
  let now = 1_000_000_000_000;
  const deps = { env, fetch: f, log: quiet, now: () => now };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  noteScrapeCreators(402, null, deps); await settle();
  noteScrapeCreators(402, null, deps); await settle();
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /run out/); assert.deepEqual(mails[0].to, ["support@clone8.io"]);
  now += 6 * 3_600_000 + 1; noteScrapeCreators(402, null, deps); await settle();
  assert.equal(mails.length, 2);
  noteScrapeCreators(200, { credits_remaining: 15_000 }, deps); await settle();
  assert.equal(mails.length, 2); assert.equal(scrapeCreatorsBalance(), 15_000);
  noteScrapeCreators(200, { credits_remaining: 1_500 }, deps); await settle();
  noteScrapeCreators(200, { credits_remaining: 1_400 }, deps); await settle();
  assert.equal(mails.length, 3); assert.match(mails[2].subject, /low \(1,500 left\)/);
  now += 24 * 3_600_000 + 1; noteScrapeCreators(200, { credits_remaining: 900 }, deps); await settle();
  assert.equal(mails.length, 4);
  noteScrapeCreators(401, null, deps); await settle();
  assert.equal(mails.length, 5); assert.match(mails[4].subject, /key/);
});

test("an alert that cannot be sent never throws", async () => {
  resetAlertsForTests();
  assert.equal(await ownerAlert("x", "s", "t", 1000, { env: { RESEND_API_KEY: "r" }, log: quiet, fetch: (async () => { throw new Error("offline"); }) as any }), false);
  // mail off (no RESEND_API_KEY): a logged no-op, counted as handled
  assert.equal(await ownerAlert("y", "s", "t", 1000, { env: {}, log: quiet }), true);
});
