import test from "node:test";
import assert from "node:assert/strict";
import { resetAlertsForTests } from "../src/vendor-alerts.js";
import { parseUsageCsv, ptDayBounds, ptDay, reconcileGap, reconcileDay, startProxyReconcile, userHash } from "../src/proxy-reconcile.js";

// IPRoyal's documented report shape (docs.iproyal.com/proxies/residential/api/reports)
const CSV = `date,hostname,port,data,measurement unit,requests count
2026-11-19,rr2---sn-x.googlevideo.com,443,1500.25,MB,820
2026-11-19,www.youtube.com,443,120.5,MB,310
,,total:,1620.75,,1130
`;

test("the report: the total row when there is one, the rows added up when not, any unit as MB", () => {
  assert.deepEqual(parseUsageCsv(CSV), { mb: 1620.75, requests: 1130, rows: 2 });
  assert.deepEqual(parseUsageCsv("date,hostname,port,data,measurement unit,requests count\n2026-11-19,a,443,1.5,GB,3\n2026-11-19,b,443,250,KB,1\n"), { mb: 1500.25, requests: 4, rows: 2 });
  assert.deepEqual(parseUsageCsv("date,hostname,port,data,measurement unit,requests count\n"), { mb: 0, requests: 0, rows: 0 }, "an empty day is headers only");
  assert.throws(() => parseUsageCsv("<html>error</html>"));
});

test("Pacific days: midnight there in winter and in summer; the day two back", () => {
  assert.deepEqual(ptDayBounds("2026-11-19"), { from: "2026-11-19T08:00:00.000Z", to: "2026-11-20T08:00:00.000Z" });
  assert.deepEqual(ptDayBounds("2026-07-04"), { from: "2026-07-04T07:00:00.000Z", to: "2026-07-05T07:00:00.000Z" });
  assert.equal(ptDayBounds("2026-11-01").to, "2026-11-02T08:00:00.000Z", "the day the clocks go back has 25 hours");
  assert.equal(ptDay(Date.parse("2026-11-22T17:00:00Z"), 2), "2026-11-20");
});

test("the gap: IPRoyal above the runs is booked at the prices' rate; below is $0 with both numbers kept", () => {
  assert.deepEqual(reconcileGap({ reportedMb: 1620.75, bookedMb: 1426, usdPerGb: 6.25 }), { gap_mb: 194.75, usd: 1.217188, ratio: 1.137 });
  assert.deepEqual(reconcileGap({ reportedMb: 200, bookedMb: 223, usdPerGb: 6.25 }), { gap_mb: 0, usd: 0, ratio: 0.897 });
  assert.equal(reconcileGap({ reportedMb: 50, bookedMb: 0, usdPerGb: 6.25 }).ratio, null);
});

// a stand-in for the two tables this touches
function fakeSb(o: { events?: any[]; costs?: any[] } = {}) {
  const costs = o.costs ?? [], events = o.events ?? [], asked: any[] = [];
  const from = (table: string) => {
    const f: any = { filters: [] as Array<(r: any) => boolean> };
    const q: any = {
      select: () => q, limit: () => q,
      eq: (k: string, v: any) => { f.filters.push((r: any) => r[k] === v); return q; },
      gte: (k: string, v: any) => { f.filters.push((r: any) => r[k] >= v); return q; },
      lt: (k: string, v: any) => { f.filters.push((r: any) => r[k] < v); return q; },
      insert: async (row: any) => { costs.push(row); return { error: null }; },
      then: (ok: any) => { asked.push(table); const rows = (table === "studio_costs" ? costs : events).filter((r) => f.filters.every((p: any) => p(r))); return Promise.resolve({ data: rows, error: null }).then(ok); },
    };
    return q;
  };
  return { sb: { from } as any, costs, asked };
}
const ev = (at: string, bytes: number, usd: number) => ({ kind: "vendor", name: "youtube_proxy", created_at: at, usd, props: { bytes } });

function fakeIPRoyal(o: { csv?: string; me?: any; status?: number } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init: any) => {
    calls.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer tok", "the token goes in the header, never the address");
    if (o.status) return new Response("no", { status: o.status });
    if (String(url).endsWith("/me")) return new Response(JSON.stringify(o.me ?? { available_traffic: 12.5, residential_user_hash: "H1" }), { status: 200 });
    return new Response(o.csv ?? CSV, { status: 200, headers: { "content-type": "text/csv" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("one day squared: IPRoyal's count against the runs' bookings that Pacific day, one row, written once", async () => {
  const { sb, costs } = fakeSb({ events: [
    ev("2026-11-19T09:00:00.000Z", 1_000_000_000, 6.25), ev("2026-11-20T07:59:00.000Z", 426_000_000, 2.66), // on Nov 19 PT
    ev("2026-11-20T08:00:00.000Z", 999_000_000, 6.24), // Nov 20 PT: not this day
  ] });
  const ip = fakeIPRoyal(), env = { IPROYAL_API_TOKEN: "tok", STUDIO_YT_PROXY: "http://x", STUDIO_YT_PROXY_USD_PER_GB: "6.25" };
  const r = await reconcileDay(sb, "2026-11-19", { env, fetch: ip.f, log: () => {} });
  assert.deepEqual(r, { day: "2026-11-19", reported_mb: 1620.75, booked_mb: 1426, gap_mb: 194.75, usd: 1.217188, ratio: 1.137 });
  assert.equal(costs.length, 1);
  const row = costs[0];
  assert.equal(row.ref, "iproyal:2026-11-19"); assert.equal(row.provider, "youtube_proxy"); assert.equal(row.product, "iproyal_reconcile");
  assert.equal(row.basis, "metered"); assert.equal(row.usd, 1.217188); assert.equal(row.spent_at, "2026-11-19T20:00:00.000Z");
  assert.deepEqual(row.units, { reported_mb: 1620.75, booked_mb: 1426, gap_mb: 194.75, requests: 1130, usd_per_gb: 6.25 });
  const q = ip.calls.find((c) => c.includes("data-usage-report"))!;
  assert.match(q, /hash=H1&date_from=2026-11-19&date_to=2026-11-19&measurement_unit=MB&rounding_decimal=3&time_zone=America%2FLos_Angeles/);
  assert.ok(!q.includes("tok"));
  assert.deepEqual(await reconcileDay(sb, "2026-11-19", { env, fetch: ip.f, log: () => {} }), { day: "2026-11-19", skipped: "already squared" });
  assert.equal(costs.length, 1);
});

test("off without a token; the hash from IPROYAL_USER_HASH without asking; an IPRoyal error writes nothing", async () => {
  const { sb, costs } = fakeSb();
  assert.deepEqual(await reconcileDay(sb, "2026-11-19", { env: {}, fetch: fakeIPRoyal().f }), { day: "2026-11-19", skipped: "no IPROYAL_API_TOKEN" });
  assert.equal(startProxyReconcile(() => sb, { env: {} }), null);
  const ip = fakeIPRoyal();
  assert.equal(await userHash({ IPROYAL_API_TOKEN: "tok", IPROYAL_USER_HASH: "FIXED" }, ip.f), "FIXED");
  assert.equal(ip.calls.length, 0);
  await assert.rejects(reconcileDay(sb, "2026-11-19", { env: { IPROYAL_API_TOKEN: "tok" }, fetch: fakeIPRoyal({ status: 401 }).f, log: () => {} }), /user hash/);
  assert.equal(costs.length, 0);
});

test("a big unexplained gap tells the owner; the usual 10-15 % does not", async () => {
  resetAlertsForTests();
  const env = { IPROYAL_API_TOKEN: "tok" }; // (no RESEND_API_KEY: the send is a logged no-op)
  const big = fakeSb({ events: [ev("2026-11-19T12:00:00.000Z", 1_000_000_000, 6.25)] }), logs: string[] = [];
  const csv = "date,hostname,port,data,measurement unit,requests count\n2026-11-19,x,443,3000,MB,9\n";
  const r = await reconcileDay(big.sb, "2026-11-19", { env, fetch: fakeIPRoyal({ csv }).f, log: (l) => logs.push(l) });
  assert.equal(r.gap_mb, 2000); assert.equal(r.ratio, 3);
  assert.ok(logs.some((l) => l === "[alert] YouTube proxy: IPRoyal counted 3000 MB on 2026-11-19, the Clips runs booked 1000 MB"), logs.join("\n"));
  const usual = fakeSb({ events: [ev("2026-11-19T12:00:00.000Z", 1_426_000_000, 8.91)] }), quiet: string[] = [];
  await reconcileDay(usual.sb, "2026-11-19", { env, fetch: fakeIPRoyal().f, log: (l) => quiet.push(l) });
  assert.ok(!quiet.some((l) => l.startsWith("[alert]")));
});
