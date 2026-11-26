// Removing an account takes it off the posts still waiting for it (src/studio-social-unlink.ts).
// Live case behind it (Nov 26 2026): a customer removed TikTok and Facebook; their scheduled TikTok+YouTube+Facebook posts
// kept both and came back "partial" with "Account … was disconnected".
import test from "node:test";
import assert from "node:assert/strict";
import { removedSends, takeOffGoneAccounts, takeOffWaitingPosts } from "../src/studio-social-unlink.js";

const U = "11111111-1111-4111-8111-111111111111";
const H = 3600_000;

/** A tiny in-memory stand-in for the posts table: select/eq/in/limit and update/eq/select, filters applied in order. */
function fakeSb(rows: any[]) {
  const q = (mode: "select" | "update", patch?: any) => {
    const filters: Array<(r: any) => boolean> = [];
    const run = () => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") hit.forEach((r) => Object.assign(r, patch));
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return b; },
      in: (k: string, v: any[]) => { filters.push((r) => v.includes(r[k])); return b; },
      limit: () => b, select: () => b,
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  };
  return { from: () => ({ select: () => q("select"), update: (patch: any) => q("update", patch) }) } as any;
}

function fakeProvider(o: { failUpdate?: boolean } = {}) {
  const calls: any[] = [];
  return {
    calls,
    p: {
      cancel: async (_k: string, id: string) => { calls.push({ cancel: id }); },
      update: async (_k: string, id: string, change: any) => { calls.push({ update: id, change }); if (o.failUpdate) throw new Error("refused"); return null; },
    } as any,
  };
}

const post = (over: any) => ({
  id: over.id, user_id: U, provider: "zernio", provider_post_id: `zp-${over.id}`, caption: "hello", status: "scheduled",
  schedule_at: new Date(Date.now() + 3 * H).toISOString(), results: [], error: null, ...over,
});
const acct = (id: string, platform: string, at?: number) => ({ id, platform, username: id, ...(at ? { at: new Date(at).toISOString() } : {}) });

test("a post to the removed account and others skips it at the service; each remaining account keeps its own time", async () => {
  const t = Date.now() + 3 * H;
  const rows = [post({ id: "p1", platforms: ["tiktok", "youtube", "facebook"], schedule_at: new Date(t).toISOString(),
    options: { accounts: [acct("tt1", "tiktok", t), acct("yt1", "youtube", t + 10 * 60_000), acct("fb1", "facebook", t)] },
    results: [{ platform: "tiktok", account_id: "tt1", status: "scheduled" }, { platform: "youtube", account_id: "yt1", status: "scheduled" }, { platform: "facebook", account_id: "fb1", status: "scheduled" }] })];
  const { p, calls } = fakeProvider();
  const r = await takeOffWaitingPosts(fakeSb(rows), p, "prof", U, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 0 });
  assert.deepEqual(r, { changed: 1, canceled: 0, left: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].update, "zp-p1");
  assert.deepEqual(calls[0].change.targets.map((x: any) => x.accountId), ["yt1", "fb1"]);
  assert.equal(calls[0].change.targets[0].at.getTime(), t + 10 * 60_000, "YouTube keeps its own later time");
  assert.equal(calls[0].change.scheduleAt.getTime(), t, "the post's own time is passed so per-account times are kept");
  assert.deepEqual(rows[0].platforms, ["youtube", "facebook"]);
  assert.deepEqual(rows[0].options.accounts.map((x: any) => x.id), ["yt1", "fb1"]);
  assert.deepEqual(rows[0].results.map((x: any) => x.account_id), ["yt1", "fb1"]);
  assert.equal(rows[0].status, "scheduled");
});

test("a post that went only to removed accounts is canceled at the service and here; a queued one only here", async () => {
  const rows = [
    post({ id: "p2", platforms: ["tiktok", "facebook"], options: { accounts: [acct("tt1", "tiktok"), acct("fb1", "facebook")] } }),
    post({ id: "p3", status: "queued", provider_post_id: null, platforms: ["tiktok"], options: { accounts: [acct("tt1", "tiktok")] } }),
  ];
  const { p, calls } = fakeProvider();
  const sb = fakeSb(rows);
  const a = await takeOffWaitingPosts(sb, p, "prof", U, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 0 });
  const b = await takeOffWaitingPosts(sb, p, "prof", U, { platform: "facebook", ids: ["fb1"], leftOnNetwork: 0 });
  // removing TikTok: p2 keeps Facebook (changed), p3 had only TikTok (canceled); then removing Facebook cancels p2
  assert.deepEqual(a, { changed: 1, canceled: 1, left: 0 });
  assert.deepEqual(b, { changed: 0, canceled: 1, left: 0 });
  assert.equal(rows[0].status, "canceled");
  assert.equal(rows[1].status, "canceled");
  assert.deepEqual(calls.filter((c) => c.cancel).map((c) => c.cancel), ["zp-p2"], "a queued post was never at the service");
});

test("left alone: going out within 2 minutes, other accounts' posts, a refusal by the service, and other people's posts", async () => {
  const rows = [
    post({ id: "soon", schedule_at: new Date(Date.now() + 60_000).toISOString(), platforms: ["tiktok"], options: { accounts: [acct("tt1", "tiktok")] } }),
    post({ id: "other", platforms: ["youtube"], options: { accounts: [acct("yt1", "youtube")] } }),
    post({ id: "refused", platforms: ["tiktok", "youtube"], options: { accounts: [acct("tt1", "tiktok"), acct("yt1", "youtube")] } }),
    post({ id: "bob", user_id: "22222222-2222-4222-8222-222222222222", platforms: ["tiktok"], options: { accounts: [acct("tt1", "tiktok")] } }),
    post({ id: "posted", status: "posted", platforms: ["tiktok"], options: { accounts: [acct("tt1", "tiktok")] } }),
  ];
  const { p } = fakeProvider({ failUpdate: true });
  const r = await takeOffWaitingPosts(fakeSb(rows), p, "prof", U, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 0 });
  assert.deepEqual(r, { changed: 0, canceled: 0, left: 2 });
  assert.deepEqual(rows.map((x) => x.status), ["scheduled", "scheduled", "scheduled", "scheduled", "posted"]);
  assert.deepEqual(rows[2].options.accounts.map((x: any) => x.id), ["tt1", "yt1"], "a refused change leaves the row as it was");
});

test("older posts that name only networks: hit only when the network has no account left", () => {
  const row = { platforms: ["tiktok", "youtube"], options: {} } as any;
  assert.equal(removedSends(row, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 1 }).hit.length, 0, "another TikTok remains: the service still posts there");
  const gone = removedSends(row, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 0 });
  assert.deepEqual(gone.hit.map((x) => x.platform), ["tiktok"]);
  assert.equal(gone.legacy, true);
});

test("a second account on the same network is untouched when the first is removed", async () => {
  const rows = [post({ id: "p4", platforms: ["tiktok"], options: { accounts: [acct("tt1", "tiktok"), acct("tt2", "tiktok")] } })];
  const { p, calls } = fakeProvider();
  const r = await takeOffWaitingPosts(fakeSb(rows), p, "prof", U, { platform: "tiktok", ids: ["tt1"], leftOnNetwork: 1 });
  assert.deepEqual(r, { changed: 1, canceled: 0, left: 0 });
  assert.deepEqual(calls[0].change.targets.map((x: any) => x.accountId), ["tt2"]);
  assert.deepEqual(rows[0].platforms, ["tiktok"]);
});

test("the hourly upkeep takes accounts no longer linked off waiting posts (removed before the fix, or on the network)", async () => {
  // the live case: TikTok removed at 01:55 PT Nov 26 before the fix; 4 TikTok+YouTube posts still scheduled for Nov 27-30
  const sends = (h: number) => [{ id: "tt1", platform: "tiktok", at: new Date(Date.now() + h * H).toISOString() }, { id: "yt1", platform: "youtube", at: new Date(Date.now() + h * H).toISOString() }];
  const rows = [24, 48, 72, 96].map((h, i) => post({ id: `p${i}`, platforms: ["tiktok", "youtube"], options: { accounts: sends(h) }, schedule_at: new Date(Date.now() + h * H).toISOString() }));
  const sb = fakeSb(rows); const { p, calls } = fakeProvider();
  p.accounts = async () => [{ id: "yt1", platform: "youtube" }];
  const t = await takeOffGoneAccounts(sb, p, "pk", U);
  assert.deepEqual([t.changed, t.canceled, t.left, t.gone], [4, 0, 0, ["tt1"]]);
  for (const r of rows) { assert.deepEqual(r.platforms, ["youtube"]); assert.deepEqual(r.options.accounts.map((a: any) => a.id), ["yt1"]); }
  assert.equal(calls.filter((c) => c.update).length, 4, "each post changed at the posting service too");
  // nothing gone: nothing touched
  const sb2 = fakeSb([post({ id: "q", platforms: ["youtube"], options: { accounts: sends(24).slice(1) } })]); const f2 = fakeProvider();
  f2.p.accounts = async () => [{ id: "yt1", platform: "youtube" }];
  assert.deepEqual((await takeOffGoneAccounts(sb2, f2.p, "pk", U)).gone, []); assert.equal(f2.calls.length, 0);
  // the service answers an empty list (an outage or a lag): never taken to mean every account is gone
  const rows3 = [post({ id: "e", platforms: ["tiktok", "youtube"], options: { accounts: sends(24) } })];
  const f3 = fakeProvider(); f3.p.accounts = async () => [];
  const t3 = await takeOffGoneAccounts(fakeSb(rows3), f3.p, "pk", U);
  assert.equal(t3.gone.length, 0); assert.deepEqual(rows3[0].platforms, ["tiktok", "youtube"]); assert.equal(f3.calls.length, 0);
  // a post only to the gone account is canceled
  const rows4 = [post({ id: "o", platforms: ["tiktok"], options: { accounts: sends(24).slice(0, 1) } })];
  const f4 = fakeProvider(); f4.p.accounts = async () => [{ id: "yt1", platform: "youtube" }];
  assert.equal((await takeOffGoneAccounts(fakeSb(rows4), f4.p, "pk", U)).canceled, 1); assert.equal(rows4[0].status, "canceled");
});
