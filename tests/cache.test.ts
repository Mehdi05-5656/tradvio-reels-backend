import test from "node:test";
import assert from "node:assert/strict";
import { memo, peek, memoClear } from "../src/cache.js";

test("memo serves one computation to concurrent callers, expires by ttl, and never caches a failure", async () => {
  memoClear();
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return calls; };
  const [a, b] = await Promise.all([memo("k", 1000, slow), memo("k", 1000, slow)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
  assert.equal(await memo("k", 1000, slow), 1);
  assert.equal(peek("k"), 1);
  assert.equal(await memo("k", 1000, slow, Date.now() + 5000), 2, "expired by ttl");
  await assert.rejects(memo("bad", 1000, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(peek("bad"), undefined);
  assert.equal(await memo("bad", 1000, async () => "ok"), "ok");
});
