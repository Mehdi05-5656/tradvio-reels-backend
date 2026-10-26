import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { metaConfig, readBrowserMeta, buildLeadEvent, sendMetaEvents, metaCapiTick, retryDelayMs, DEFAULT_GRAPH_VERSION, MAX_ATTEMPTS, type MetaConfig, type FetchLike } from "../src/meta-capi.js";
import { registerPublicRoutes } from "../src/public-routes.js";

const cfg: MetaConfig = { pixelId: "1234567890", token: "secret-token", testEventCode: null, version: "v25.0" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ctx = { ip: "1.2.3.4", ua: "UA", fbp: "fb.1.1729900000000.1", fbc: null, url: "https://clone8.io/", test: null };

/** In-memory invite_requests with the slice of the supabase-js query API the code uses. */
function fakeTable(opts: { migrated?: boolean } = {}) {
  const rows: any[] = []; let n = 0; let failInsert: any = null;
  const sb: any = {
    rows, failNext(e: any) { failInsert = e; },
    from() {
      let op = "select", values: any = null; const filters: ((r: any) => boolean)[] = []; let lim = Infinity, wantRows = false;
      const q: any = {
        insert(v: any) { op = "insert"; values = v; return q; }, update(v: any) { op = "update"; values = v; return q; },
        select() { wantRows = true; return q; }, eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, lt(k: string, v: any) { filters.push((r) => r[k] != null && r[k] < v); return q; },
        order() { return q; }, limit(l: number) { lim = l; return q; },
        single() { q.one = true; return q; }, maybeSingle() { q.maybe = true; return q; },
        then(resolve: any) {
          let data: any = null, error: any = null;
          if (op === "insert") {
            if (failInsert) { error = failInsert; failInsert = null; }
            else if (!opts.migrated && Object.keys(values).some((k) => k.startsWith("meta_"))) error = { code: "PGRST204", message: "Could not find the 'meta_capi_context' column of 'invite_requests'" };
            else if (values.meta_event_id && rows.some((r) => r.meta_event_id === values.meta_event_id)) error = { code: "23505", message: "duplicate key" };
            else { const row = { id: `req-${++n}`, created_at: new Date("2026-10-26T20:00:00Z").toISOString(), meta_capi_attempts: 0, meta_capi_last_attempt_at: null, ...values }; rows.push(row); data = row; }
          } else {
            const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, lim);
            if (op === "update") hit.forEach((r) => Object.assign(r, values));
            data = q.one || q.maybe ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
          }
          return resolve({ data: wantRows || op === "select" ? data : null, error });
        },
      };
      return q;
    },
  };
  return sb;
}

const recorder = (answer: () => Promise<{ ok: boolean; status: number }>) => {
  const sent: any[] = [];
  const fetchFn: FetchLike = async (_u, init) => { sent.push(JSON.parse(init.body)); const a = await answer(); return { ...a, text: async () => "{}" }; };
  return { sent, fetchFn };
};

async function serve(t: any, sb: any, meta: MetaConfig | null, fetchFn: FetchLike) {
  const app = express(); app.use(express.json());
  registerPublicRoutes(app, () => sb, { meta, metaFetch: fetchFn });
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  return (b: any) => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/public/invite-requests`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "TestUA", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(b) });
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const form = (meta?: any) => ({ name: "Jane", email: "Jane@Example.com", company: "N", ...(meta ? { meta } : {}) });
const bm = { event_id: "c8_0123456789", fbp: "fb.1.1729900000000.42", event_source_url: "https://clone8.io/?email=leak#invite" };

test("config needs a numeric pixel id and a token", () => {
  assert.equal(metaConfig({}), null);
  assert.equal(metaConfig({ META_PIXEL_ID: "abc", META_CAPI_ACCESS_TOKEN: "t" }), null);
  assert.deepEqual(metaConfig({ META_PIXEL_ID: " 1234567890 ", META_CAPI_ACCESS_TOKEN: "t", META_TEST_EVENT_CODE: "TEST123", META_GRAPH_API_VERSION: "bogus" }), { pixelId: "1234567890", token: "t", testEventCode: "TEST123", version: DEFAULT_GRAPH_VERSION });
});

test("browser context is validated and the page URL loses its query", () => {
  const m = readBrowserMeta({ meta: { ...bm, fbc: "javascript:x", test_event_code: "DROP TABLE" } });
  assert.deepEqual(m, { eventId: "c8_0123456789", fbp: "fb.1.1729900000000.42", fbc: null, sourceUrl: "https://clone8.io/", testEventCode: null });
  assert.equal(readBrowserMeta({ meta: { event_id: "short" } }).eventId, null);
});

test("the server event is a Lead with hashed email, external id, no value", () => {
  const e: any = buildLeadEvent({ eventId: "c8_abcdef12", time: new Date("2026-10-26T20:00:00Z"), requestId: "req-1", email: " Jane@Example.com ", ctx });
  assert.equal(e.event_name, "Lead"); assert.equal(e.event_id, "c8_abcdef12"); assert.equal(e.action_source, "website"); assert.equal(e.event_time, 1793044800);
  assert.deepEqual(e.user_data.em, [sha("jane@example.com")]);
  assert.deepEqual(e.user_data.external_id, [sha("req-1")]);
  assert.deepEqual(e.custom_data, { content_name: "Clone8 Invite Application", source: "website", status: "submitted" });
  assert.equal(e.custom_data.value, undefined); assert.equal(e.custom_data.currency, undefined);
});

test("send outcomes: accepted, refused (retryable), no answer (unknown); token only in the body", async () => {
  const ok = recorder(async () => ({ ok: true, status: 200 }));
  assert.equal((await sendMetaEvents(cfg, [{ event_name: "Lead", event_id: "x" }], { testEventCode: "TEST9", fetchFn: ok.fetchFn })).outcome, "sent");
  assert.equal(ok.sent[0].access_token, "secret-token"); assert.equal(ok.sent[0].test_event_code, "TEST9");
  assert.equal((await sendMetaEvents(cfg, [], { fetchFn: async () => ({ ok: false, status: 500, text: async () => "secret-token" }) })).outcome, "rejected");
  const dns = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal((await sendMetaEvents(cfg, [], { fetchFn: async () => { throw dns; } })).outcome, "rejected");
  const r = await sendMetaEvents(cfg, [], { fetchFn: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); } });
  assert.equal(r.outcome, "unknown"); assert.doesNotMatch(r.detail, /secret-token/);
});

test("a stored application is sent once as Lead; failures never reach the visitor", async (t) => {
  const sb = fakeTable({ migrated: true });
  const m = recorder(async () => ({ ok: true, status: 200 }));
  const post = await serve(t, sb, cfg, m.fetchFn);
  const a = await post(form(bm)); assert.equal(a.status, 201); await settle();
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].data.length, 1);
  assert.equal(m.sent[0].data[0].event_name, "Lead");
  assert.equal(m.sent[0].data[0].event_id, "c8_0123456789", "server event_id = browser eventID");
  assert.equal(m.sent[0].data[0].event_source_url, "https://clone8.io/");
  assert.equal(m.sent[0].data[0].user_data.client_ip_address, "9.9.9.9");
  assert.equal(sb.rows[0].meta_capi_status, "sent"); assert.equal(sb.rows[0].meta_capi_context, null, "match data cleared once sent");

  // The browser retries the same submit (lost answer): same row confirmed, nothing new stored or sent.
  const b = await post(form(bm)); assert.equal(b.status, 201); assert.equal((await b.json()).id, "req-1"); await settle();
  assert.equal(sb.rows.length, 1); assert.equal(m.sent.length, 1);

  // No browser context (tracking not allowed for this visitor): stored, no server event.
  assert.equal((await post(form())).status, 201); await settle();
  assert.equal(sb.rows.length, 2); assert.equal(sb.rows[1].meta_capi_status, undefined); assert.equal(m.sent.length, 1);

  // Validation error, honeypot, failed insert: no server event.
  assert.equal((await post({ ...form({ ...bm, event_id: "c8_aaaaaaaaaa" }), name: "" })).status, 400);
  assert.equal((await post({ ...form({ ...bm, event_id: "c8_bbbbbbbbbb" }), fax: "1" })).status, 202);
  sb.failNext({ code: "57014", message: "db down" });
  assert.equal((await post(form({ ...bm, event_id: "c8_cccccccccc" }))).status, 503); await settle();
  assert.equal(m.sent.length, 1);
});

test("Meta down: the visitor still gets 201, the loop retries later and sends exactly once", async (t) => {
  const sb = fakeTable({ migrated: true });
  let up = false;
  const m = recorder(async () => (up ? { ok: true, status: 200 } : { ok: false, status: 503 }));
  const post = await serve(t, sb, cfg, m.fetchFn);
  assert.equal((await post(form(bm))).status, 201); await settle();
  assert.equal(sb.rows[0].meta_capi_status, "pending"); assert.equal(sb.rows[0].meta_capi_attempts, 1);
  const t0 = new Date(sb.rows[0].meta_capi_last_attempt_at).getTime();
  assert.deepEqual(await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(t0 + 60_000) }), { waiting: 1 }, "respects the retry delay");
  up = true;
  assert.deepEqual(await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(t0 + retryDelayMs(1) + 1) }), { sent: 1 });
  assert.deepEqual(await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(t0 + 3600_000) }), {});
  assert.equal(m.sent.length, 2, "one refused, one accepted");
  assert.equal(sb.rows[0].meta_capi_status, "sent");
});

test("process restart before the send: the loop sends it; restart mid-send: marked unknown, never resent", async () => {
  const sb = fakeTable({ migrated: true });
  const m = recorder(async () => ({ ok: true, status: 200 }));
  const created = new Date("2026-10-26T20:00:00Z").getTime();
  sb.rows.push({ id: "a", email: "a@b.co", created_at: new Date(created).toISOString(), meta_event_id: "c8_aaaaaaaaaa", meta_capi_status: "pending", meta_capi_attempts: 0, meta_capi_last_attempt_at: null, meta_capi_context: ctx });
  sb.rows.push({ id: "b", email: "b@b.co", created_at: new Date(created).toISOString(), meta_event_id: "c8_bbbbbbbbbb", meta_capi_status: "sending", meta_capi_attempts: 1, meta_capi_last_attempt_at: new Date(created).toISOString(), meta_capi_context: ctx });
  const out = await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(created + 20 * 60_000) });
  assert.deepEqual(out, { unknown: 1, sent: 1 });
  assert.equal(m.sent.length, 1); assert.equal(m.sent[0].data[0].event_id, "c8_aaaaaaaaaa");
  assert.equal(sb.rows[1].meta_capi_status, "unknown"); assert.equal(sb.rows[1].meta_capi_context, null);
  // A timeout is unknown too and is not retried.
  sb.rows.push({ id: "c", email: "c@b.co", created_at: new Date(created).toISOString(), meta_event_id: "c8_cccccccccc", meta_capi_status: "pending", meta_capi_attempts: 0, meta_capi_last_attempt_at: null, meta_capi_context: ctx });
  await metaCapiTick(sb, cfg, { fetchFn: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, now: new Date(created + 20 * 60_000) });
  assert.equal(sb.rows[2].meta_capi_status, "unknown");
  assert.deepEqual(await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(created + 5 * 3600_000) }), {});
  assert.equal(m.sent.length, 1);
});

test("gives up after the attempt cap or the 47 h window", async () => {
  const sb = fakeTable({ migrated: true });
  const created = new Date("2026-10-26T20:00:00Z").getTime();
  sb.rows.push({ id: "a", email: "a@b.co", created_at: new Date(created).toISOString(), meta_event_id: "c8_aaaaaaaaaa", meta_capi_status: "pending", meta_capi_attempts: MAX_ATTEMPTS, meta_capi_last_attempt_at: new Date(created).toISOString(), meta_capi_context: ctx });
  sb.rows.push({ id: "b", email: "b@b.co", created_at: new Date(created).toISOString(), meta_event_id: "c8_bbbbbbbbbb", meta_capi_status: "pending", meta_capi_attempts: 0, meta_capi_last_attempt_at: null, meta_capi_context: ctx });
  const m = recorder(async () => ({ ok: true, status: 200 }));
  assert.deepEqual(await metaCapiTick(sb, cfg, { fetchFn: m.fetchFn, now: new Date(created + 48 * 3600_000) }), { failed: 2 });
  assert.equal(m.sent.length, 0); assert.equal(sb.rows[1].meta_capi_context, null);
});

test("before the migration: applications are stored as before, without a server event", async (t) => {
  const sb = fakeTable({ migrated: false });
  const m = recorder(async () => ({ ok: true, status: 200 }));
  const post = await serve(t, sb, cfg, m.fetchFn);
  assert.equal((await post(form(bm))).status, 201); await settle();
  assert.equal(sb.rows.length, 1); assert.equal(sb.rows[0].meta_event_id, undefined); assert.equal(m.sent.length, 0);
});

test("CAPI off (no env): the event id is kept for idempotency, status skipped, nothing sent", async (t) => {
  const sb = fakeTable({ migrated: true });
  const m = recorder(async () => ({ ok: true, status: 200 }));
  const post = await serve(t, sb, null, m.fetchFn);
  assert.equal((await post(form(bm))).status, 201); await settle();
  assert.equal(sb.rows[0].meta_capi_status, "skipped"); assert.equal(sb.rows[0].meta_capi_context, null); assert.equal(m.sent.length, 0);
});

test("the migration applies twice on Postgres and enforces one row per event id", async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
  await db.exec(readFileSync("migrations/20261024110000_invite_requests.sql", "utf8"));
  const m = readFileSync("migrations/20261026090000_invite_requests_meta_capi.sql", "utf8");
  await db.exec(m); await db.exec(m);
  await db.exec(`INSERT INTO invite_requests(name,email,company) VALUES ('a','a@b.co','x'),('b','b@b.co','x')`); // old rows: null ids coexist
  await db.exec(`INSERT INTO invite_requests(name,email,company,meta_event_id,meta_capi_status) VALUES ('c','c@b.co','x','c8_0123456789','pending')`);
  await assert.rejects(db.exec(`INSERT INTO invite_requests(name,email,company,meta_event_id) VALUES ('d','d@b.co','x','c8_0123456789')`), /duplicate key/);
  await assert.rejects(db.exec(`UPDATE invite_requests SET meta_capi_status='bogus'`), /check constraint/);
});
