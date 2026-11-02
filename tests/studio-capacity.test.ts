import test from "node:test";
import assert from "node:assert/strict";
import { capacity, Gate, containerMemory, roomForAnother } from "../src/studio-capacity.js";

test("capacity: sensible defaults, read from the environment and kept in bounds", () => {
  assert.deepEqual(capacity({}), { runs: 5, captionsRuns: 3, cutSlots: 1, memCeiling: 0.75, diskFloorGb: 2 });
  const c = capacity({ STUDIO_CLIPS_MAX_RUNS: "8", STUDIO_CUT_SLOTS: "4", STUDIO_MEM_CEILING: "2", STUDIO_CAPTIONS_MAX_RUNS: "0" });
  assert.equal(c.runs, 8); assert.equal(c.cutSlots, 4); assert.equal(c.memCeiling, 0.95); assert.equal(c.captionsRuns, 3, "nonsense falls back to the default");
  assert.equal(capacity({ STUDIO_CLIPS_MAX_RUNS: "500" }).runs, 12);
});

test("the cutter: never more at once than its slots, first come first served, and it says when someone waits", async () => {
  const g = new Gate(1);
  let now = 0, peak = 0; const order: string[] = []; const waited: string[] = [];
  const job = (name: string, ms: number) => g.run(async () => { now++; peak = Math.max(peak, now); order.push(name); await new Promise((r) => setTimeout(r, ms)); now--; }, () => { waited.push(name); });
  await Promise.all([job("a", 30), job("b", 5), job("c", 5)]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(waited, ["b", "c"]);
  const two = new Gate(2); let n2 = 0, p2 = 0;
  await Promise.all([1, 2, 3, 4].map(() => two.run(async () => { n2++; p2 = Math.max(p2, n2); await new Promise((r) => setTimeout(r, 10)); n2--; })));
  assert.equal(p2, 2);
  // a failure frees its place
  const g3 = new Gate(1);
  await assert.rejects(g3.run(async () => { throw new Error("boom"); }));
  assert.equal(await g3.run(async () => 7), 7);
  assert.equal(g3.busy, 0);
});

test("room for another run: held when memory or disk is short, allowed when it cannot be measured", async () => {
  const mem = (used: number, limit = 2e9) => async () => ({ used, limit });
  assert.deepEqual(await roomForAnother({}, { memory: mem(1.2e9), disk: async () => 10e9 }), { ok: true });
  assert.equal((await roomForAnother({}, { memory: mem(1.6e9), disk: async () => 10e9 })).ok, false);
  assert.equal((await roomForAnother({}, { memory: mem(1.2e9), disk: async () => 1e9 })).ok, false);
  assert.equal((await roomForAnother({}, { memory: async () => null, disk: async () => null })).ok, true);
  // cgroup v2 and v1 files; "max" means no limit to read
  const files: Record<string, string> = { "/sys/fs/cgroup/memory.current": "1000\n", "/sys/fs/cgroup/memory.max": "4000\n" };
  assert.deepEqual(await containerMemory(async (p) => { if (p in files) return files[p]; throw new Error("no"); }), { used: 1000, limit: 4000 }, "no memory.stat: the whole figure");
  // with memory.stat: only what processes hold counts, not the disk cache
  const withStat = { ...files, "/sys/fs/cgroup/memory.stat": "anon 600\nfile 400\nkernel 10\n" };
  assert.deepEqual(await containerMemory(async (p) => { if (p in withStat) return (withStat as any)[p]; throw new Error("no"); }), { used: 600, limit: 4000 });
  const v1: Record<string, string> = { "/sys/fs/cgroup/memory/memory.usage_in_bytes": "5", "/sys/fs/cgroup/memory/memory.limit_in_bytes": "10", "/sys/fs/cgroup/memory/memory.stat": "cache 1\ntotal_rss 5\n" };
  assert.deepEqual(await containerMemory(async (p) => { if (p in v1) return v1[p]; throw new Error("no"); }), { used: 5, limit: 10 });
  assert.equal(await containerMemory(async (p) => (p.endsWith("max") ? "max" : "1")), null);
});
