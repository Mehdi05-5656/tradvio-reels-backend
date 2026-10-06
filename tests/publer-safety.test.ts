import test from "node:test";
import assert from "node:assert/strict";
import { parsePublishResult, retryDecision, chooseTimelineLog } from "../src/publer-safety.js";

const post = { id: "p1", account_id: "a1", state: "published", error: null, post_link: "https://www.instagram.com/reel/test/" };
test("real Publer array returns exact post identity and permalink", () => {
  assert.deepEqual(parsePublishResult([{ status: "complete", post }], "a1"), {
    outcome: "published", postId: "p1", postLink: post.post_link,
  });
});
test("TikTok provider-confirmed publication permits a missing public link", () => {
  assert.deepEqual(parsePublishResult([{ post: { ...post, post_link: null, in_queue: true } }], "a1"), {
    outcome: "published", postId: "p1", postLink: null,
  });
});
test("wrapped posts are supported", () => {
  assert.equal(parsePublishResult({ posts: [post] }, "a1").outcome, "published");
});
test("wrong account, ambiguous results, and bare IDs cannot prove publication", () => {
  for (const payload of [[{ post: { ...post, account_id: "other" } }], { post_ids: ["p1"] }, null, [{ post }, { post: { ...post, id: "p2" } }]]) {
    assert.equal(parsePublishResult(payload, "a1").outcome, "unknown");
  }
});
test("embedded errors and failed jobs are not successful publications", () => {
  assert.equal(parsePublishResult([{ post: { ...post, state: "failed", error: "Denied" } }], "a1").outcome, "failed");
  assert.equal(parsePublishResult({ failures: { a1: "Denied" } }, "a1").outcome, "failed");
  assert.equal(parsePublishResult([{ status: "failed", error: "Denied" }], "a1").outcome, "unknown");
});
test("scheduled state remains uncertain; never label it published", () => {
  assert.equal(parsePublishResult([{ post: { ...post, state: "scheduled" } }], "a1").outcome, "unknown");
});
test("failure evidence wins over a contradictory published state", () => {
  assert.equal(parsePublishResult([{ post: { ...post, error: "Denied" } }], "a1").outcome, "unknown");
});
test("media rejection is quarantined only after three attempts", () => {
  assert.equal(retryDecision(2, "Videos need to be smaller than 2 gb", false).action, "retry");
  assert.equal(retryDecision(3, "Videos need to be smaller than 2 gb", false).action, "quarantine");
});
test("infrastructure failure is held, not misclassified as corrupt video", () => {
  assert.equal(retryDecision(5, "publer GET -> 401", false).action, "hold");
  assert.equal(retryDecision(3, "HTTP 503", false).action, "retry");
});
test("uncertain submission is never retried even on the first attempt", () => {
  assert.equal(retryDecision(1, "timeout", true).action, "hold");
});
test("retry delay is bounded and increases", () => {
  assert.equal(retryDecision(1, "network", false).delayMs, 15 * 60_000);
  assert.equal(retryDecision(2, "network", false).delayMs, 30 * 60_000);
  assert.equal(retryDecision(4, "network", false).delayMs, 60 * 60_000);
});
test("timeline prioritizes successful reservation over old failed attempts", () => {
  assert.equal(chooseTimelineLog([{ status: "failed", attempted_at: "2026-09-23T12:00Z" }, { status: "published", attempted_at: "2026-09-23T11:00Z" }])?.status, "published");
  assert.equal(chooseTimelineLog([{ status: "failed", attempted_at: "2026-09-23T11:00Z", error: "old" }, { status: "failed", attempted_at: "2026-09-23T12:00Z", error: "new" }])?.error, "new");
});

const busyMessage = "Please wait until your other download media from URL jobs have finished";
const busyResponse = `publer POST /media/from-url -> 403: ${JSON.stringify({ errors: [busyMessage] })}`;
test("exact pre-submission upload-busy response retries with existing bounded backoff", () => {
  assert.deepEqual(retryDecision(1, busyResponse, false), { action: "retry", delayMs: 15 * 60_000 });
  assert.deepEqual(retryDecision(2, `retry: ${busyResponse}`, false), { action: "retry", delayMs: 30 * 60_000 });
  assert.deepEqual(retryDecision(4, busyResponse, false), { action: "retry", delayMs: 60 * 60_000 });
  assert.deepEqual(retryDecision(5, busyResponse, false), { action: "hold", delayMs: 0 });
});
test("upload-busy exception never releases an uncertain submission or historical hold", () => {
  assert.equal(retryDecision(1, busyResponse, true).action, "hold");
  assert.equal(retryDecision(1, `hold: ${busyResponse}`, false).action, "hold");
});
test("other 403s and malformed or mixed upload responses stay held", () => {
  for (const error of [
    'publer POST /media/from-url -> 403: {"errors":["Permission denied"]}',
    `publer POST /media/from-url -> 403: ${JSON.stringify({ errors: [busyMessage, "Permission denied"] })}`,
    `publer POST /media/from-url -> 403: ${JSON.stringify({ errors: busyMessage })}`,
    `publer POST /media/from-url -> 403: ${JSON.stringify({ errors: [busyMessage], permission_error: true })}`,
    'publer POST /media/from-url -> 403: {broken json',
    busyResponse.replace("403", "401"),
    busyResponse.replace("/media/from-url", "/posts/schedule/publish"),
    busyResponse.replace("POST", "GET"),
    `unexpected prefix ${busyResponse}`,
    `publer POST /media/from-url -> 403: ${JSON.stringify({ errors: [busyMessage + "."] })}`,
  ]) assert.equal(retryDecision(1, error, false).action, "hold", error);
});
