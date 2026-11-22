import test from "node:test";
import assert from "node:assert/strict";
import { AYRSHARE_BILLING_FROM, ayrshareBill, clearReason, keepUntil, recordSocialCosts, socialUpkeep } from "../src/studio-social-upkeep.js";
import { usableExtra } from "../src/studio-social.js";
import { ayrshareProvider } from "../src/social-ayrshare.js";
import { flushCosts, initCosts, resetCostsForTests } from "../src/studio-costs.js";

const DAY = 86400_000, HOUR = 3600_000;
const NOW = Date.parse("2026-12-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const uid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

/** A small Supabase stand-in: select/eq/in/gte/limit, count head, update, delete, insert, upsert. */
function fakeSb(tables: Record<string, any[]>) {
  return {
    tables,
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let op: any = null, head = false, maybe = false;
      const q: any = {
        select(_c?: string, o?: any) { if (o?.head) head = true; return q; }, limit() { return q; }, order() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
        maybeSingle() { maybe = true; return q; },
        update(v: any) { op = { kind: "update", v }; return q; }, delete() { op = { kind: "delete" }; return q; },
        insert(v: any) { op = { kind: "insert", v }; return q; },
        upsert(v: any) { op = { kind: "upsert", v }; return q; },
        then(res: any, rej: any) {
          const rows = (tables[table] ??= []);
          const hit = () => rows.filter((r) => filters.every((f) => f(r)));
          let data: any;
          if (op?.kind === "insert") { const vs = Array.isArray(op.v) ? op.v : [op.v]; rows.push(...vs); data = vs; }
          else if (op?.kind === "upsert") { const at = rows.find((r) => r.user_id === op.v.user_id); if (at) Object.assign(at, op.v); else rows.push({ ...op.v }); data = [op.v]; }
          else if (op?.kind === "update") { data = hit(); for (const r of data) Object.assign(r, op.v); }
          else if (op?.kind === "delete") { data = hit(); tables[table] = rows.filter((r) => !data.includes(r)); }
          else data = hit();
          const out = head ? { data: null, count: data.length, error: null } : { data: maybe ? data[0] ?? null : data, error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  } as any;
}

/** A fake provider: which profiles have networks at the service, and what was deleted. */
function fakeProvider(linkedAtService: Record<string, string[]> = {}, refuse = new Set<string>()) {
  const deleted: string[] = [];
  return {
    deleted,
    p: {
      name: "ayrshare", offered: () => ["tiktok", "instagram", "youtube", "facebook", "linkedin", "threads", "bluesky"],
      accounts: async (key: string) => (linkedAtService[key] ?? []).map((platform) => ({ platform })),
      deleteProfile: async (key: string) => { if (refuse.has(key)) throw new Error("refused"); deleted.push(key); },
    } as any,
  };
}

test("bill: Launch is $299 flat to 10; the 11th forces Business (+$300); then $8.99, $3.49, $2.49 a profile", () => {
  assert.deepEqual([ayrshareBill(0).usd_month, ayrshareBill(6).usd_month, ayrshareBill(10).usd_month], [299, 299, 299]);
  assert.equal(ayrshareBill(10).next_profile_usd, 300, "the 11th profile adds $300 a month");
  assert.equal(ayrshareBill(11).plan, "business");
  assert.equal(ayrshareBill(11).usd_month, 599);
  assert.equal(ayrshareBill(29).next_profile_usd, 0, "profiles 12 to 30 are inside the Business base");
  assert.equal(ayrshareBill(30).usd_month, 599);
  assert.equal(ayrshareBill(50).usd_month, 778.8);
  assert.equal(ayrshareBill(50).next_profile_usd, 8.99);
  assert.equal(ayrshareBill(51).usd_month, 787.79);
  assert.equal(ayrshareBill(100).usd_month, 1228.3, "the pricing page's own example");
  assert.equal(ayrshareBill(100).next_profile_usd, 3.49);
  assert.equal(ayrshareBill(300).usd_month, 1926.3);
  assert.equal(ayrshareBill(50, { interval: "year" }).usd_month, 658.8, "annual: $499 base and $7.99 each");
  assert.equal(ayrshareBill(5, { plan: "business" }).usd_month, 599, "on Business the base is paid whatever the count");
});

test("rules: no plan goes; nothing linked goes after the grace hours; linked goes after 14 idle days; held never goes", () => {
  const s = { idleDays: 14, unlinkedHours: 2 };
  const p = (over: any = {}) => ({ user_id: uid(1), created_at: ago(30 * DAY), accounts: [{ platform: "tiktok" }], ...over });
  const f = (over: any = {}) => ({ hasPlan: true, held: false, lastPostAt: null, linked: 1, ...over });
  assert.equal(clearReason(p(), f({ hasPlan: false }), s, NOW), "no_plan");
  assert.equal(clearReason(p({ created_at: ago(1 * HOUR) }), f({ linked: 0 }), s, NOW), null, "still on the linking page");
  assert.equal(clearReason(p({ created_at: ago(3 * HOUR) }), f({ linked: 0 }), s, NOW), "never_linked");
  assert.equal(clearReason(p({ created_at: ago(40 * DAY), last_active_at: ago(30 * DAY) }), f({ linked: 0 }), s, NOW), "never_linked");
  assert.equal(clearReason(p(), f({ lastPostAt: ago(15 * DAY) }), s, NOW), "idle");
  assert.equal(clearReason(p(), f({ lastPostAt: ago(13 * DAY) }), s, NOW), null);
  assert.equal(clearReason(p({ perf_viewed_at: ago(3 * DAY) }), f({ lastPostAt: ago(20 * DAY) }), s, NOW), null, "opening their stats is use");
  assert.equal(clearReason(p({ last_active_at: ago(1 * DAY) }), f({ lastPostAt: ago(20 * DAY) }), s, NOW), null, "relinking or pressing Connect is use");
  assert.equal(clearReason(p(), f({ lastPostAt: ago(60 * DAY), held: true }), s, NOW), null, "a scheduled post or the creator program holds it");
  assert.equal(keepUntil(p(), ago(10 * DAY), { idleDays: 14, held: false }), new Date(NOW + 4 * DAY).toISOString());
  assert.equal(keepUntil(p(), ago(10 * DAY), { idleDays: 14, held: true }), null);
  assert.equal(keepUntil(p({ accounts: [] }), null, { idleDays: 14, held: false }), null);
});

test("extras: one per network offered beyond the plan's own", () => {
  assert.equal(usableExtra(1, 7), 6);
  assert.equal(usableExtra(5, 7), 2);
  assert.equal(usableExtra(10, 7), 0);
  assert.equal(usableExtra(3, undefined), 50, "unknown network count keeps the old ceiling");
});

function world() {
  const profiles = [
    { user_id: uid(1), profile_key: "pk-fresh", accounts: [], created_at: ago(1 * HOUR) },               // on the linking page now
    { user_id: uid(2), profile_key: "pk-empty", accounts: [], created_at: ago(5 * DAY) },                // never linked
    { user_id: uid(3), profile_key: "pk-lag", accounts: [], created_at: ago(5 * DAY) },                  // linked, cache behind
    { user_id: uid(4), profile_key: "pk-idle", accounts: [{ platform: "tiktok" }], created_at: ago(40 * DAY) },
    { user_id: uid(5), profile_key: "pk-sched", accounts: [{ platform: "tiktok" }], created_at: ago(40 * DAY) },
    { user_id: uid(6), profile_key: "pk-creator", accounts: [{ platform: "tiktok" }], created_at: ago(40 * DAY) },
    { user_id: uid(7), profile_key: "pk-noplan", accounts: [{ platform: "tiktok" }], created_at: ago(2 * DAY) },
    { user_id: uid(8), profile_key: "pk-busy", accounts: [{ platform: "tiktok" }], created_at: ago(40 * DAY), perf_viewed_at: ago(2 * DAY) },
    { user_id: uid(9), profile_key: "pk-poster", accounts: [{ platform: "youtube" }], created_at: ago(40 * DAY) },
  ];
  const customers = profiles.map((p) => ({ user_id: p.user_id, status: p.user_id === uid(7) ? "canceled" : "active" }));
  const posts = [
    { user_id: uid(4), created_at: ago(20 * DAY), status: "posted" },
    { user_id: uid(5), created_at: ago(20 * DAY), status: "scheduled" },
    { user_id: uid(9), created_at: ago(3 * DAY), status: "posted" },
  ];
  return fakeSb({ studio_social_profiles: profiles, studio_customers: customers, studio_social_posts: posts, studio_creator_accounts: [{ user_id: uid(6), status: "active" }], studio_social_prefs: [] });
}

test("sweep: clears never-linked, idle and plan-less profiles at the service and here, leaves a note, keeps the rest", async () => {
  const sb = world(), prov = fakeProvider({ "pk-lag": ["instagram"] });
  const r = await socialUpkeep(sb, { provider: prov.p, env: {}, now: NOW, log: () => {} });
  assert.deepEqual(r.cleared.map((c) => `${c.user_id.slice(7, 8)}:${c.reason}`).sort(), ["2:never_linked", "4:idle", "7:no_plan"]);
  assert.deepEqual(prov.deleted.sort(), ["pk-empty", "pk-idle", "pk-noplan"]);
  assert.deepEqual(sb.tables.studio_social_profiles.map((p: any) => p.profile_key).sort(), ["pk-busy", "pk-creator", "pk-fresh", "pk-lag", "pk-poster", "pk-sched"]);
  assert.deepEqual(sb.tables.studio_social_profiles.find((p: any) => p.profile_key === "pk-lag").accounts, [{ platform: "instagram" }], "the cache is refreshed, not cleared");
  assert.deepEqual(sb.tables.studio_social_prefs.map((x: any) => x.cleared_reason).sort(), ["idle", "never_linked", "no_plan"]);
});

test("sweep: dry mode and off change nothing; a refusal at the service keeps the row for the next round", async () => {
  for (const mode of ["dry", "off"]) {
    const sb = world(), prov = fakeProvider({ "pk-lag": ["instagram"] });
    const r = await socialUpkeep(sb, { provider: prov.p, env: { STUDIO_SOCIAL_CLEANUP: mode }, now: NOW, log: () => {} });
    assert.equal(prov.deleted.length, 0);
    assert.equal(sb.tables.studio_social_profiles.length, 9);
    if (mode === "dry") assert.equal(r.would_clear.length, 3);
  }
  const sb = world(), prov = fakeProvider({ "pk-lag": ["instagram"] }, new Set(["pk-idle"]));
  const r = await socialUpkeep(sb, { provider: prov.p, env: {}, now: NOW, log: () => {} });
  assert.equal(r.cleared.length, 2);
  assert.ok(sb.tables.studio_social_profiles.some((p: any) => p.profile_key === "pk-idle"), "still here, still tried next hour");
});

test("costs: one row per profile with its share of the day, once a day, nothing before billing began", async () => {
  resetCostsForTests();
  const sb = fakeSb({ studio_social_profiles: Array.from({ length: 12 }, (_, i) => ({ user_id: uid(i + 1) })), studio_costs: [] });
  initCosts(() => sb);
  assert.equal(await recordSocialCosts(sb, { env: {}, now: Date.parse(AYRSHARE_BILLING_FROM) - DAY, log: () => {} }), 0, "trial days cost nothing");
  assert.equal(await recordSocialCosts(sb, { env: {}, now: NOW, log: () => {} }), 12);
  await flushCosts();
  const rows = sb.tables.studio_costs;
  assert.equal(rows.length, 12);
  const total = rows.reduce((a: number, r: any) => a + r.usd, 0);
  assert.ok(Math.abs(total - 599 / 31) < 0.001, `12 profiles = Business $599 over December's 31 days (got ${total})`);
  assert.ok(rows.every((r: any) => r.provider === "ayrshare" && r.basis === "list" && r.user_id));
  assert.equal(await recordSocialCosts(sb, { env: {}, now: NOW + HOUR, log: () => {} }), 0, "the day is written once");
  resetCostsForTests();
});

test("provider: a refused profile delete is an error; already gone is done", async () => {
  const fetchWith = (status: number, body: any) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as any;
  const env = { STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "k" };
  await assert.rejects(ayrshareProvider({ env, fetch: fetchWith(400, { status: "error", code: 999, message: "Something else" }) })!.deleteProfile("pk"), (e: any) => e.code === "profile_delete_failed");
  await ayrshareProvider({ env, fetch: fetchWith(400, { status: "error", message: "Profile not found" }) })!.deleteProfile("pk");
  await ayrshareProvider({ env, fetch: fetchWith(200, { status: "success" }) })!.deleteProfile("pk");
});

test("sweep: a profile at a provider we left is removed here even when that provider refuses (cancelled account)", async () => {
  const sb = fakeSb({ studio_social_profiles: [{ user_id: uid(1), provider: "ayrshare", profile_key: "ayr-1", accounts: [{ platform: "tiktok" }], created_at: ago(20 * DAY) }], studio_customers: [{ user_id: uid(1), status: "active" }], studio_social_posts: [], studio_creator_accounts: [], studio_social_prefs: [] });
  const zp = fakeProvider(); (zp.p as any).name = "zernio";
  const ayrDown = async () => new Response(JSON.stringify({ status: "error", message: "API Key not valid" }), { status: 400 });
  const r = await socialUpkeep(sb, { provider: zp.p, env: { STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "old" }, fetch: ayrDown as any, now: NOW, log: () => {} });
  assert.deepEqual(r.cleared.map((c) => c.reason), ["provider_moved"]);
  assert.equal(sb.tables.studio_social_profiles.length, 0);
  assert.equal(sb.tables.studio_social_prefs[0].cleared_reason, "provider_moved");
});
