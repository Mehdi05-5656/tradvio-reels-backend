import test from "node:test";
import assert from "node:assert/strict";
import { phCapture, flushPosthog, resetPosthogForTests, setPosthogFetchForTests } from "../src/posthog.js";
import { recordEvent, resetEventsForTests } from "../src/studio-events.js";

const U = "166ee4e7-0de9-4038-b740-f6b3b609848c";

test("posthog: off without a key, nothing is queued or sent", async () => {
  resetPosthogForTests(); delete process.env.POSTHOG_KEY;
  let calls = 0; setPosthogFetchForTests((async () => { calls++; return new Response("{}"); }) as any);
  phCapture(U, "job_started", { tool: "swap" });
  assert.equal(await flushPosthog(), 0); assert.equal(calls, 0);
});

test("posthog: batches events by account id to the batch endpoint, skips bad ids", async () => {
  resetPosthogForTests(); process.env.POSTHOG_KEY = "phc_test"; process.env.POSTHOG_HOST = "https://eu.i.posthog.com/";
  const sent: any[] = [];
  setPosthogFetchForTests((async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }) as any);
  phCapture(U, "job_started", { tool: "kage_motion", credits: 560 });
  phCapture("not-a-uuid", "job_started", {});
  phCapture(null, "purchase", {});
  assert.equal(await flushPosthog(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://eu.i.posthog.com/batch/");
  assert.equal(sent[0].body.api_key, "phc_test");
  assert.equal(sent[0].body.batch[0].distinct_id, U);
  assert.equal(sent[0].body.batch[0].event, "job_started");
  assert.equal(sent[0].body.batch[0].properties.credits, 560);
  delete process.env.POSTHOG_KEY; delete process.env.POSTHOG_HOST; resetPosthogForTests();
});

test("posthog: product events are mirrored from recordEvent, internal ones are not", async () => {
  resetPosthogForTests(); resetEventsForTests(); process.env.POSTHOG_KEY = "phc_test";
  const sent: any[] = [];
  setPosthogFetchForTests((async (_u: string, init: any) => { sent.push(...JSON.parse(init.body).batch); return new Response("{}"); }) as any);
  recordEvent({ user_id: U, kind: "checkout", name: "plan", usd: 29, props: { plan: "creator" } });
  recordEvent({ user_id: U, kind: "feature", name: "clips_done", props: { clips: 4 } });
  recordEvent({ user_id: U, kind: "claude", name: "assistant", usd: 0.12 });
  recordEvent({ user_id: U, kind: "email", name: "receipt" });
  await flushPosthog();
  assert.deepEqual(sent.map((e) => e.event), ["checkout_started", "clips_done"]);
  assert.equal(sent[0].properties.product, "plan"); assert.equal(sent[0].properties.usd, 29);
  delete process.env.POSTHOG_KEY; resetPosthogForTests();
});

test("posthog: a failed send never throws", async () => {
  resetPosthogForTests(); process.env.POSTHOG_KEY = "phc_test";
  setPosthogFetchForTests((async () => { throw new Error("network down"); }) as any);
  phCapture(U, "purchase", { amount_usd: 9 });
  assert.equal(await flushPosthog(), 0);
  delete process.env.POSTHOG_KEY; resetPosthogForTests();
});
