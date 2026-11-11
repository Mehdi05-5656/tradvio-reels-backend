import test from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, sanitizeAnswers, profileLines, profileSuggestions, managedFit, signupInsights, partialRecord, finishedRecord } from "../src/studio-onboarding.js";

test("answers are kept only when the question and the answer exist", () => {
  const out = sanitizeAnswers({
    version: 2, role: "business", sells: "app", team: "evil<script>", goals: ["ads", "publish", "ads", "hack"], goal: "publish",
    niche: ["money", "tech", "food", "travel"], platforms: "tiktok", accounts: "2_5", first_make: "  Make a UGC ad\u0000 for my app  ",
    skipped_at: "stack", unknown: "x", attribution: { utm_source: "tiktok", landing: "/#signup", ref: "google.com", evil: "x", utm_campaign: "<b>launch</b>" },
  });
  assert.deepEqual(out, {
    role: "business", sells: "app", goals: ["ads", "publish"], goal: "publish", niche: ["money", "tech", "food"], platforms: ["tiktok"], accounts: "2_5",
    first_make: "Make a UGC ad for my app", version: 2, skipped_at: "stack", attribution: { utm_source: "tiktok", utm_campaign: "blaunch/b", ref: "google.com", landing: "/#signup" },
  });
});

test("a first goal that is not among the goals is not kept; one goal is the first goal", () => {
  assert.equal(sanitizeAnswers({ goals: ["ads"], goal: "managed" }).goal, "ads");
  assert.equal(sanitizeAnswers({ goals: ["ads", "trends"], goal: "managed" }).goal, undefined);
});

test("first-version answers still save", () => {
  assert.deepEqual(sanitizeAnswers({ intent: "blueprint", source: ["podcast", "clipping"], library: "100_500", accounts: "gt20" }), { intent: "blueprint", source: ["podcast", "clipping"], library: "100_500", accounts: "gt20" });
});

test("every question has answers that read in a sentence, with ids the dashboard can store", () => {
  for (const [k, spec] of Object.entries(QUESTIONS)) {
    if (k === "goal") continue;
    assert.ok(Object.keys(spec.values).length >= 4, k);
    for (const [id, text] of Object.entries(spec.values)) { assert.match(id, /^[a-z0-9_]+$/); assert.ok(text.length > 0, `${k}.${id}`); }
  }
});

test("the assistant reads who they are, what they want, their size, their problem and their first idea", () => {
  const lines = profileLines({ role: "agency", clients: "4_10", niche: ["fitness"], goals: ["network", "publish"], goal: "network", platforms: ["tiktok", "instagram"], accounts: "21_100", posts_now: "30_100", posts_goal: "500_2000", library: "100_500", blocker: "flagged", tools: ["capcut", "none"], first_make: "Ten originals of my best gym clip" });
  assert.deepEqual(lines, [
    "They are an agency or SMMA making content for clients (4 to 10 clients; about fitness and health).",
    "Wants: running a page network without duplicate files (Blueprint); posting, scheduling and tracking everything (Publish, Performance). First priority: running a page network without duplicate files (Blueprint).",
    "Posts on: TikTok, Instagram, 21 to 100 accounts.",
    "Volume: 1 to 3 a day today, wants dozens a day; has 100 to 500 finished videos.",
    "Biggest problem: reposts getting flagged as unoriginal.",
    "Uses today: CapCut.",
    "First thing they said they want to make: \"Ten originals of my best gym clip\"",
  ]);
  assert.deepEqual(profileLines({ intent: "recast" }), ["Came for: recast."]);
  assert.deepEqual(profileLines(null), []);
});

test("chat suggestions start with their own words, then their goals", () => {
  const s = profileSuggestions({ first_make: "A UGC ad for my protein app with a gym character", goal: "ads", goals: ["ads", "character"], sells: "app", niche: ["fitness"] });
  assert.equal(s.length, 3);
  assert.equal(s[0].prompt, "A UGC ad for my protein app with a gym character");
  assert.ok(s[0].label.length <= 48);
  assert.equal(s[1].prompt, "Make a 15-second UGC ad for my app.");
  assert.equal(s[2].prompt, "Create a character for my fitness videos.");
  assert.deepEqual(profileSuggestions({}), []);
});

test("managed fit mirrors the dashboard", () => {
  assert.equal(managedFit({ goals: ["managed"] }), "asked for it");
  assert.equal(managedFit({ role: "agency", clients: "gt30" }), "agency with 11+ clients");
  assert.equal(managedFit({ accounts: "6_20", spend: "500_2000" }), "many accounts at volume");
  assert.equal(managedFit({ accounts: "2_5", posts_goal: "30_100" }), null);
});

test("who is signing up: counts per answer, paying alongside, sources and first ideas", () => {
  const t = (o: any, status = "none") => ({ onboarding: { completed_at: "2026-10-31T00:00:00Z", ...o }, status });
  const s = signupInsights([
    t({ version: 2, role: "creator", goal: "faceless", goals: ["faceless", "trends"], heard: "tiktok", attribution: { utm_source: "tiktok" }, first_make: "a" }, "active"),
    t({ version: 2, role: "creator", goal: "trends", goals: ["trends"], heard: "friend", skipped_at: "stack" }),
    t({ version: 2, role: "agency", goal: "network", goals: ["network"], attribution: { ref: "google.com" } }, "trialing"),
    t({ intent: "blueprint" }),
    { onboarding: {}, status: "none" },
  ]);
  assert.equal(s.answered, 4); assert.equal(s.version2, 3); assert.equal(s.skipped, 1);
  assert.deepEqual(s.by.role.map((r) => [r.id, r.n, r.paying]), [["creator", 2, 1], ["agency", 1, 1]]);
  assert.deepEqual(s.by.goals.map((r) => [r.id, r.n]), [["trends", 2], ["faceless", 1], ["network", 1]]);
  assert.equal(s.by.goal[0].label, "going faceless", "labels drop the tool in brackets");
  assert.deepEqual(s.sources, [{ source: "google.com", n: 1 }, { source: "tiktok", n: 1 }]);
  assert.deepEqual(s.first_makes, ["a"]);
});

test("today's roles, blockers and sources are kept", () => {
  assert.deepEqual(sanitizeAnswers({ role: "clipper", blocker: "monetize", heard: "discord" }), { role: "clipper", blocker: "monetize", heard: "discord" });
  for (const r of ["ugc", "ai_influencer", "pages", "agency"]) assert.equal(sanitizeAnswers({ role: r }).role, r);
});

// ---- version 3 (Nov 10 2026): the same five screens, re-worded for what Clone8 does now ----
// The same lists are in the dashboard's tests/onboarding.test.ts: an id on one side only is dropped from the save.
const V3 = {
  role: ["creator", "clipper", "yt_automation", "pages", "ugc", "ai_influencer", "business", "agency", "exploring"],
  goals: ["clips", "stories", "films", "captions", "multiply", "remake", "swap", "character", "trends", "ads", "earn", "publish", "managed"],
  platforms: ["tiktok", "instagram", "youtube", "facebook", "x", "linkedin", "threads", "snapchat", "none"],
  accounts: ["one", "2_5", "6_20", "21_100", "gt100"],
  posts_goal: ["lt30", "30_100", "100_500", "500_2000", "gt2000"],
  blocker: ["volume", "filming", "ideas", "camera", "views", "monetize", "flagged", "accounts", "cost", "quality"],
  heard: ["tiktok", "instagram", "youtube", "x", "discord", "reddit", "ai", "google", "creator", "friend", "ad", "other"],
};
test("version 3: every answer the dashboard can send is kept", () => {
  for (const [k, ids] of Object.entries(V3)) for (const id of ids) assert.ok(QUESTIONS[k].values[id], `${k}.${id} is known`);
  const all = { version: 3, role: "yt_automation", goals: V3.goals, goal: "films", platforms: ["youtube", "tiktok"], accounts: "2_5", posts_goal: "30_100", blocker: "ideas", heard: "ad" };
  assert.deepEqual(sanitizeAnswers(all), all);
});
test("answers from before version 3 are still read and counted", () => {
  assert.deepEqual(sanitizeAnswers({ version: 2, goals: ["network", "faceless", "generate", "analytics"] }).goals, ["network", "faceless", "generate", "analytics"]);
  const s = signupInsights([
    { onboarding: { completed_at: "2026-11-01T00:00:00Z", version: 2, role: "clipper", goal: "multiply", goals: ["multiply"] }, status: "active" },
    { onboarding: { completed_at: "2026-11-11T00:00:00Z", version: 3, role: "clipper", goal: "clips", goals: ["clips", "captions"] }, status: "none" },
  ]);
  assert.equal(s.answered, 2); assert.equal(s.version2, 2, "both are on the newer questions"); assert.equal(s.current, 1);
  assert.deepEqual(s.by.goal.map((r) => r.id).sort(), ["clips", "multiply"]);
  assert.equal(s.by.goal.find((r) => r.id === "clips")!.label, "clipping long videos into shorts");
});
test("the assistant and chat read the new goals", () => {
  assert.deepEqual(profileLines({ role: "yt_automation", goals: ["films", "stories"], goal: "films", blocker: "ideas" }), [
    "They are running faceless YouTube channels (YouTube automation).",
    "Wants: running a faceless YouTube channel with long films (Films); making faceless shorts from an idea (Stories). First priority: running a faceless YouTube channel with long films (Films).",
    "Biggest problem: running out of ideas to post.",
  ]);
  assert.deepEqual(profileSuggestions({ version: 3, goal: "clips", goals: ["clips", "captions", "ads"] }).map((x) => x.prompt), ["Clip my latest long video into shorts.", "Add animated captions to my newest video.", "Make a short motion-graphics ad for my product."]);
});
test("part-way saves: kept with the screen they stopped on, never marked done, never over a finished record", () => {
  const first = partialRecord(null, { version: 3, role: "clipper", evil: "x" }, "role", "2026-11-10T10:00:00Z")!;
  assert.deepEqual(first, { version: 3, role: "clipper", started_at: "2026-11-10T10:00:00Z", stopped_at: "role", progress_at: "2026-11-10T10:00:00Z" });
  const second = partialRecord(first, { version: 3, role: "clipper", goals: ["clips"], goal: "clips" }, "goals", "2026-11-10T10:01:00Z")!;
  assert.equal(second.started_at, "2026-11-10T10:00:00Z", "the start is kept"); assert.equal(second.stopped_at, "goals"); assert.equal(second.completed_at, undefined);
  assert.equal(partialRecord({ completed_at: "2026-11-01T00:00:00Z", role: "creator" }, { role: "clipper" }, "role"), null, "finished answers are left alone");
  assert.equal(partialRecord(null, { role: "clipper" }, "nonsense"), null);
  const done = finishedRecord(second, { version: 3, role: "clipper", goals: ["clips"], goal: "clips", heard: "tiktok" }, "2026-11-10T10:03:00Z");
  assert.deepEqual(done, { role: "clipper", goals: ["clips"], goal: "clips", heard: "tiktok", version: 3, started_at: "2026-11-10T10:00:00Z", completed_at: "2026-11-10T10:03:00Z" });
});
test("who started and did not finish, by the screen they stopped on", () => {
  const s = signupInsights([
    { onboarding: { started_at: "a", stopped_at: "goals", role: "clipper" } }, { onboarding: { started_at: "b", stopped_at: "goals" } }, { onboarding: { started_at: "c", stopped_at: "channels" } },
    { onboarding: { started_at: "d", completed_at: "e", role: "creator", version: 3 } }, { onboarding: {} },
  ]);
  assert.equal(s.unfinished, 3); assert.equal(s.answered, 1);
  assert.deepEqual(s.stopped, [{ id: "goals", label: "What they want to do", n: 2 }, { id: "channels", label: "Where they post", n: 1 }]);
  assert.deepEqual(s.by.role.map((r) => r.id), ["creator"], "unfinished answers are not counted as answers");
});
