import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { metaConfig, readBrowserMeta, buildApplicationEvents, sendMetaEvents, hashEmail, DEFAULT_GRAPH_VERSION, type MetaConfig } from "../src/meta-capi.js";
import { registerPublicRoutes } from "../src/public-routes.js";

const cfg: MetaConfig = { pixelId: "1234567890", token: "secret-token", testEventCode: null, version: "v25.0" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("config needs both a numeric pixel id and a token", () => {
  assert.equal(metaConfig({}), null);
  assert.equal(metaConfig({ META_PIXEL_ID: "123456" }), null);
  assert.equal(metaConfig({ META_PIXEL_ID: "abc", META_CAPI_ACCESS_TOKEN: "t" }), null);
  const c = metaConfig({ META_PIXEL_ID: " 1234567890 ", META_CAPI_ACCESS_TOKEN: "t", META_TEST_EVENT_CODE: "TEST123", META_GRAPH_API_VERSION: "bogus" })!;
  assert.deepEqual(c, { pixelId: "1234567890", token: "t", testEventCode: "TEST123", version: DEFAULT_GRAPH_VERSION });
});

test("browser context is validated field by field", () => {
  const m = readBrowserMeta({ meta: { event_id: "c8_abcdef12", fbp: "fb.1.1729900000000.123456789", fbc: "javascript:x", event_source_url: "https://clone8.io/#invite", test_event_code: "DROP TABLE" } });
  assert.deepEqual(m, { eventId: "c8_abcdef12", fbp: "fb.1.1729900000000.123456789", fbc: null, sourceUrl: "https://clone8.io/#invite", testEventCode: null });
  assert.equal(readBrowserMeta({ meta: { event_id: "short" } }).eventId, null);
  assert.equal(readBrowserMeta({}, { headers: { referer: "https://clone8.io/" } }).sourceUrl, "https://clone8.io/");
});

test("an application becomes Lead + Clone8ApplicationSubmitted, same event_id, hashed email, no value", () => {
  const ev = buildApplicationEvents({ eventId: "c8_abcdef12", time: new Date("2026-10-26T20:00:00Z"), sourceUrl: "https://clone8.io/", user: { email: " Jane@Example.com ", externalId: "req-1", ip: "1.2.3.4", userAgent: "UA", fbp: "fb.1.1729900000000.1", fbc: null } });
  assert.deepEqual(ev.map((e) => e.event_name), ["Lead", "Clone8ApplicationSubmitted"]);
  for (const e of ev) {
    assert.equal(e.event_id, "c8_abcdef12");
    assert.equal(e.action_source, "website");
    assert.equal(e.event_time, 1793044800);
    const u = e.user_data as any;
    assert.deepEqual(u.em, [sha("jane@example.com")]);
    assert.deepEqual(u.external_id, [sha("req-1")]);
    assert.equal(u.client_ip_address, "1.2.3.4");
    assert.equal(u.fbc, undefined);
    const c = e.custom_data as any;
    assert.deepEqual(c, { content_name: "Clone8 Invite Application", source: "website", status: "submitted" });
    assert.equal(c.value, undefined, "an application is not revenue");
  }
  assert.equal(hashEmail("A@B.co"), sha("a@b.co"));
});

test("the token goes in the body, failures never throw", async () => {
  const calls: any[] = [];
  const ok = await sendMetaEvents(cfg, [{ event_name: "Lead", event_id: "x" }], { testEventCode: "TEST9", fetchFn: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => "{}" }; } });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/1234567890/events");
  assert.equal(calls[0].body.access_token, "secret-token");
  assert.equal(calls[0].body.test_event_code, "TEST9");
  const bad = await sendMetaEvents(cfg, [], { fetchFn: async () => { throw new Error("boom secret-token"); } });
  assert.deepEqual(bad, { ok: false, status: 0 });
});

test("only a stored application is reported to Meta", async (t) => {
  let insertError: any = null;
  const sb: any = { from() { const q: any = { insert() { return q; }, select() { return q; }, single() { return q; }, then(r: any) { return r(insertError ? { data: null, error: insertError } : { data: { id: "req-9" }, error: null }); } }; return q; } };
  const sent: any[] = [];
  const app = express(); app.use(express.json());
  registerPublicRoutes(app, () => sb, { meta: cfg, metaFetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => "{}" }; } });
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const post = (b: any) => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/public/invite-requests`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "TestUA", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(b) });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const meta = { event_id: "c8_0123456789", fbp: "fb.1.1729900000000.42", event_source_url: "https://clone8.io/" };

  assert.equal((await post({ name: "Jane", email: "jane@example.com", company: "N", meta })).status, 201); await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data[0].event_id, "c8_0123456789");
  assert.deepEqual(sent[0].data[0].user_data.external_id, [sha("req-9")]);
  assert.equal(sent[0].data[0].user_data.client_ip_address, "9.9.9.9");
  assert.equal(sent[0].data[0].user_data.client_user_agent, "TestUA");

  assert.equal((await post({ name: "", email: "jane@example.com", company: "N", meta })).status, 400);
  assert.equal((await post({ name: "Bot", email: "b@b.co", company: "N", fax: "1", meta })).status, 202);
  insertError = { message: "down" };
  assert.equal((await post({ name: "Jane", email: "jane@example.com", company: "N", meta })).status, 503); await settle();
  assert.equal(sent.length, 1, "validation errors, the honeypot and failed inserts send nothing");
});
