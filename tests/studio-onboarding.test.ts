import test from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, sanitizeAnswers, profileLines, profileSuggestions, managedFit, signupInsights } from "../src/studio-onboarding.js";

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
    "Makes content for clients (agency, editor or freelancer): 4 to 10 clients; about fitness and health.",
    "Wants: posting on many accounts without duplicates (Blueprint); scheduling and posting everywhere (Publish). First priority: posting on many accounts without duplicates (Blueprint).",
    "Posts on: TikTok, Instagram, 21 to 100 accounts.",
    "Volume: 1 to 3 a day today, wants dozens a day; has 100 to 500 finished videos.",
    "Biggest problem: reposts getting flagged or buried.",
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
  assert.equal(s.by.goal[0].label, "videos without being on camera", "labels drop the tool in brackets");
  assert.deepEqual(s.sources, [{ source: "google.com", n: 1 }, { source: "tiktok", n: 1 }]);
  assert.deepEqual(s.first_makes, ["a"]);
});
