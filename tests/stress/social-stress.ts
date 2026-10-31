// Run by hand before a deploy: npx esbuild tests/stress/social-stress.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/stress.mjs && node .test-build/stress.mjs
// Concurrency and volume stress against the real route code, with a fake database that adds latency to every call.
import express from "express";
import { createHmac } from "node:crypto";
import { registerSocial } from "../../src/studio-social.ts";
import { registerAssistant } from "../../src/studio-assistant.ts";
import { registerPerformance } from "../../src/studio-performance-routes.ts";
import { accountAccess } from "../../src/account-access.ts";

const U = "11111111-1111-4111-8111-111111111111", CONVO = "99999999-9999-4999-8999-999999999999", JOB = "33333333-3333-4333-8333-333333333333";
const ENV: Record<string, string> = { STUDIO_SOCIAL_ENABLED: "true", AYRSHARE_API_KEY: "k", STUDIO_SOCIAL_WEBHOOK_TOKEN: "tok", STUDIO_SOCIAL_WEBHOOK_SECRET: "sec", STUDIO_PUBLIC_API_URL: "https://api.test", SCRAPECREATORS_API_KEY: "sc", ANTHROPIC_API_KEY: "sk" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let uid = 0; const newId = () => `${String(++uid).padStart(8, "0")}-0000-4000-8000-000000000000`;
function fakeSb(tables: Record<string, any[]>) {
  const unique: Record<string, string[]> = { studio_social_profiles: ["user_id"], studio_perf_posts: ["user_id", "platform", "platform_post_id"], studio_perf_accounts: ["user_id", "platform"], studio_perf_snapshots: ["user_id", "platform", "day"], studio_social_prefs: ["user_id"] };
  return {
    storage: { from: () => ({ createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://signed/${k}` }, error: null }), createSignedUrls: async (ks: string[]) => ({ data: ks.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }), upload: async (k: string) => ({ data: { path: k }, error: null }) }) },
    rpc: async () => ({ data: 1000, error: null }),
    from(table: string) {
      const filters: ((r: any) => boolean)[] = []; let op: any = null, one = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; }, gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; }, lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; },
        not(k: string) { filters.push((r) => r[k] != null); return q; }, or() { return q; }, is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return q; },
        maybeSingle() { one = true; return q; }, single() { one = true; return q; },
        insert(v: any) { op = { k: "insert", v }; return q; }, update(v: any) { op = { k: "update", v }; return q; }, upsert(v: any) { op = { k: "upsert", v }; return q; }, delete() { op = { k: "delete" }; return q; },
        async then(res: any, rej: any) {
          await sleep(5 + Math.random() * 25); // network latency: lets interleavings happen
          const t = (tables[table] ??= []); let out: any[] = [];
          try {
            if (op?.k === "insert") { const ks = unique[table]; if (ks && t.some((r) => ks.every((k) => r[k] === op.v[k]))) return res({ data: null, error: { code: "23505", message: "duplicate key" } }); const v = { id: newId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), results: [], ...op.v }; t.push(v); out = [v]; }
            else if (op?.k === "upsert") { for (const v of [].concat(op.v) as any[]) { const ks = unique[table] ?? ["id"]; const hit = t.find((r) => ks.every((k) => r[k] === v[k])); if (hit) Object.assign(hit, v); else t.push({ id: newId(), ...v }); } }
            else if (op?.k === "update") { out = t.filter((r) => filters.every((f) => f(r))); for (const r of out) Object.assign(r, JSON.parse(JSON.stringify(op.v))); }
            else if (op?.k === "delete") { const keep = t.filter((r) => !filters.every((f) => f(r))); tables[table] = keep; }
            else out = t.filter((r) => filters.every((f) => f(r))).map((r) => JSON.parse(JSON.stringify(r)));
            res({ data: one ? out[0] ?? null : out, error: null });
          } catch (e) { rej(e); }
        },
      };
      return q;
    },
  } as any;
}
const ayr = { profiles: 0, deletes: 0, posts: 0, links: 0 };
const fetchFn: any = async (url: string, init: any = {}) => {
  await sleep(20 + Math.random() * 60);
  const path = url.replace("https://api.ayrshare.com/api", "");
  const body = init.body ? JSON.parse(init.body) : {};
  if (path === "/profiles" && init.method === "POST") { ayr.profiles++; return new Response(JSON.stringify({ status: "success", profileKey: `pk-${ayr.profiles}`, refId: `ref-${ayr.profiles}` })); }
  if (path === "/profiles" && init.method === "DELETE") { ayr.deletes++; return new Response("{}"); }
  if (path === "/profiles/link-sessions") { ayr.links++; return new Response(JSON.stringify({ url: "https://link", expiresAt: new Date(Date.now() + 300000).toISOString() })); }
  if (path === "/hook/webhook") return new Response("{}");
  if (path === "/user") return new Response(JSON.stringify({ activeSocialAccounts: ["tiktok"], displayNames: [{ platform: "tiktok", username: "ann" }] }));
  if (path === "/post" && init.method === "POST") { ayr.posts++; return new Response(JSON.stringify({ status: "success", posts: [body.scheduleDate ? { status: "scheduled", id: `ayr-${ayr.posts}` } : { status: "success", id: `ayr-${ayr.posts}`, postIds: body.platforms.map((p: string) => ({ platform: p, status: "success", id: "x", postUrl: `https://${p}/1` })) }] })); }
  if (path.startsWith("/history/")) return new Response(JSON.stringify({ posts: [{ id: "h1", postUrl: "https://www.tiktok.com/@ann/video/7500000000000000001", videoViews: 100, created: new Date().toISOString() }] }));
  if (path === "/analytics/social") return new Response(JSON.stringify({ tiktok: { analytics: { followerCount: 10 } } }));
  return new Response("{}", { status: 404 });
};
async function serve(sb: any) {
  const app = express();
  app.use(express.json({ verify: (req: any, _r, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use((req: any, _res, next) => { if (req.headers["x-u"]) { req.auth = { user_id: req.headers["x-u"], email: "ann@x.test" }; req.profile = { role: "user", user_id: req.headers["x-u"] }; } next(); });
  app.use(accountAccess(() => sb));
  registerSocial(app, () => sb, { env: ENV, fetch: fetchFn, log: () => {} });
  registerAssistant(app, () => sb, { env: ENV, fetch: fetchFn, log: () => {} } as any);
  registerPerformance(app, () => sb, { env: ENV, fetch: fetchFn, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = { "x-u": U }) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, close: () => new Promise((r) => server.close(r)) };
}
const report: string[] = []; const say = (ok: boolean, s: string) => report.push(`${ok ? "PASS" : "FAIL"}  ${s}`);
const done = { status: "done", outputs: [{ key: `${U}/${JOB}/01.mp4`, kind: "video" }, { key: `${U}/${JOB}/02.mp4`, kind: "video" }], finished_at: new Date().toISOString() };

// 1. connect: five tabs at once
{ const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [] }; const s = await serve(fakeSb(t));
  const rs = await Promise.all(Array.from({ length: 5 }, () => s.call("POST", "/api/studio/social/connect", {})));
  say(rs.every((r) => r.status === 200), `connect x5 concurrent: all answered 200 (${rs.map((r) => r.status).join(",")})`);
  say(t.studio_social_profiles.length === 1, `one stored profile (${t.studio_social_profiles.length})`);
  say(ayr.profiles - ayr.deletes === 1, `provider profiles left after cleanup: ${ayr.profiles - ayr.deletes} (made ${ayr.profiles}, deleted ${ayr.deletes})`);
  await s.close(); }

// 2. publish card double click
{ ayr.posts = 0; const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: U, profile_key: "pk", accounts: [{ platform: "tiktok" }] }], studio_jobs: [{ id: JOB, user_id: U, ...done }], studio_social_posts: [],
    studio_conversations: [{ id: CONVO, user_id: U, title: "t", status: "open", plan: null, run: null, updated_at: "2026-10-30T00:00:00Z", messages: [{ id: "m1", role: "assistant", text: "x", at: "x", publish: { id: "card-1", items: [{ job_id: JOB, output_key: `${U}/${JOB}/01.mp4` }], status: "open", linked_seen: ["tiktok"] } }] }] };
  const s = await serve(fakeSb(t));
  const rs = await Promise.all(Array.from({ length: 4 }, () => s.call("POST", `/api/studio/assistant/conversations/${CONVO}/publish/card-1`, { action: "now", platforms: ["tiktok"], caption: "x" })));
  say(ayr.posts === 1, `publish card pressed 4x at once: posts sent to the network = ${ayr.posts} (statuses ${rs.map((r) => r.status).join(",")})`);
  await s.close(); }

// 3. Publish page: 25 videos scheduled 1 h apart
{ ayr.posts = 0; const outs = Array.from({ length: 25 }, (_, i) => ({ key: `${U}/${JOB}/${i}.mp4`, kind: "video" }));
  const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: U, profile_key: "pk", accounts: [{ platform: "tiktok" }] }], studio_jobs: [{ id: JOB, user_id: U, status: "done", outputs: outs, finished_at: new Date().toISOString() }], studio_social_posts: [] };
  const s = await serve(fakeSb(t)); const t0 = Date.now();
  const r = await s.call("POST", "/api/studio/social/posts", { items: outs.map((o) => ({ job_id: JOB, output_key: o.key })), platforms: ["tiktok"], caption: "x", schedule_at: new Date(Date.now() + 3600_000).toISOString(), spacing_minutes: 60 });
  say(r.status === 201 && r.body.posts.length === 25 && ayr.posts === 25, `25 videos scheduled in ${Date.now() - t0} ms: ${r.body?.posts?.length} rows, ${ayr.posts} sent`);
  const times = t.studio_social_posts.map((p: any) => Date.parse(p.schedule_at)).sort((a: number, b: number) => a - b);
  say(times.every((x: number, i: number) => i === 0 || x - times[i - 1] === 3600_000), "each one exactly an hour after the last");
  const r26 = await s.call("POST", "/api/studio/social/posts", { items: [...outs, outs[0]].map((o) => ({ job_id: JOB, output_key: o.key })), platforms: ["tiktok"] });
  say(r26.body?.error === "too_many_videos", `26 videos refused (${r26.body?.error})`);
  await s.close(); }

// 4. webhook flood: 200 deliveries, a third forged
{ const t: any = { studio_social_posts: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, user_id: U, provider_post_id: `ayr-${i}`, status: i === 0 ? "canceled" : "scheduled", results: [] })) };
  const s = await serve(fakeSb(t));
  const body = (i: number) => JSON.stringify({ action: "scheduled", status: "success", id: `ayr-${i % 50}`, postIds: [{ platform: "tiktok", status: "success", id: "x", postUrl: "https://t/1" }] });
  const sig = (b: string) => createHmac("sha256", "sec").update(b).digest("hex");
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => { const b = body(i); const forged = i % 3 === 0; return s.call("POST", `/api/studio/social/webhook?token=tok`, b, { "x-authorization-content-sha256": forged ? "0".repeat(64) : sig(b) }); }));
  const forged = rs.filter((_, i) => i % 3 === 0), real = rs.filter((_, i) => i % 3 !== 0);
  say(forged.every((r) => r.status === 401), `forged deliveries refused: ${forged.filter((r) => r.status === 401).length}/${forged.length}`);
  say(real.every((r) => r.status === 200), `signed deliveries accepted: ${real.filter((r) => r.status === 200).length}/${real.length}`);
  say(t.studio_social_posts[0].status === "canceled", "a canceled post stays canceled under a flood of success webhooks");
  say(t.studio_social_posts.slice(1).every((p: any) => p.status === "posted"), "every other post settled to posted");
  const noTok = await s.call("POST", `/api/studio/social/webhook`, body(1), { "x-authorization-content-sha256": sig(body(1)) });
  say(noTok.status === 401, `no token refused (${noTok.status})`);
  await s.close(); }

// 5. performance: 10 first opens at once
{ const hist0 = { n: 0 }; const f2: any = async (u: string, i: any) => { if (u.includes("/history/")) hist0.n++; return fetchFn(u, i); };
  const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: U, profile_key: "pk", accounts: [{ platform: "tiktok", username: "ann" }] }], studio_social_posts: [], studio_perf_insights: [] };
  const sb = fakeSb(t);
  const app = express(); app.use(express.json()); app.use((req: any, _r, n) => { req.auth = { user_id: U }; req.profile = { role: "user", user_id: U }; n(); }); app.use(accountAccess(() => sb));
  registerPerformance(app, () => sb, { env: ENV, fetch: f2, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r)); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const rs = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/studio/performance?range=28`).then((r) => r.json())));
  say(rs.every((r: any) => r.connected && r.analysis.posts.length === 1), `10 simultaneous first opens all answered with the posts`);
  say(hist0.n === 1, `the accounts were read once, not ten times (${hist0.n})`);
  await new Promise((r) => server.close(r)); }


// 6. a flaky posting service: every other send gets no usable answer; then the person presses Post again on each
{ const outs = Array.from({ length: 20 }, (_, i) => ({ key: `${U}/${JOB}/f${i}.mp4`, kind: "video" }));
  const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: U, profile_key: "pk", accounts: [{ platform: "tiktok" }] }], studio_jobs: [{ id: JOB, user_id: U, status: "done", outputs: outs, finished_at: new Date().toISOString() }], studio_social_posts: [] };
  let n = 0; const got = new Map<string, number>();
  const flaky: any = async (url: string, init: any = {}) => {
    if (url.endsWith("/post") && init.method === "POST") {
      const b = JSON.parse(init.body); const k = b.mediaUrls[0]; got.set(k, (got.get(k) ?? 0) + 1); n++;
      if (n % 2 === 0) { await sleep(10); return n % 4 === 0 ? new Response("upstream timeout", { status: 504 }) : Promise.reject(new TypeError("fetch failed")); }
    }
    return fetchFn(url, init);
  };
  const app = express(); app.use(express.json()); app.use((req: any, _r, nx) => { req.auth = { user_id: U, email: "a@x" }; req.profile = { role: "user", user_id: U }; nx(); }); app.use(accountAccess(() => fakeSbRef));
  const fakeSbRef = fakeSb(t);
  registerSocial(app, () => fakeSbRef, { env: { ...ENV, STUDIO_SOCIAL_DAILY_POSTS: "200" }, fetch: flaky, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r)); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (i: number) => fetch(`${base}/api/studio/social/posts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ job_id: JOB, output_key: outs[i].key }], platforms: ["tiktok"], caption: "x" }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const first = await Promise.all(outs.map((_, i) => post(i)));
  const unsure = first.filter((r) => r.body.posts?.[0]?.error && r.body.posts[0].status === "sending").length;
  say(first.every((r) => r.status === 201), `20 sends through a flaky service all answered (${unsure} marked "not confirmed")`);
  const again = await Promise.all(outs.map((_, i) => post(i)));
  say(again.every((r) => r.body.error === "already_posted"), `pressing Post again on all 20: every one refused as a repeat (${again.filter((r) => r.body.error === "already_posted").length}/20)`);
  say([...got.values()].every((c) => c === 1), `each video reached the posting service exactly once (${[...got.values()].reduce((a, b) => a + b, 0)} sends for 20 videos)`);
  say(!JSON.stringify(first).match(/ayrshare|upstream|fetch failed/i), "no service or network wording reached the person");
  await new Promise((r) => server.close(r)); }

// 7. a slow first read of the accounts: the page answers within seconds and says it is still reading
{ const slow: any = async (u: string, i: any) => { if (u.includes("/history/")) await sleep(15_000); return fetchFn(u, i); };
  const t: any = { studio_customers: [{ user_id: U, status: "active", plan_id: "creator", billing_interval: "month", social_extra: 0 }], studio_social_profiles: [{ user_id: U, profile_key: "pk", accounts: [{ platform: "tiktok", username: "ann" }] }], studio_social_posts: [], studio_perf_insights: [] };
  const sb = fakeSb(t);
  const app = express(); app.use(express.json()); app.use((req: any, _r, nx) => { req.auth = { user_id: U }; req.profile = { role: "user", user_id: U }; nx(); }); app.use(accountAccess(() => sb));
  registerPerformance(app, () => sb, { env: ENV, fetch: slow, log: () => {} });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r)); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const t0 = Date.now(); const r: any = await fetch(`${base}/api/studio/performance?range=28`).then((x) => x.json()); const ms = Date.now() - t0;
  say(ms < 10_000 && r.refreshing === true, `slow first open answered in ${(ms / 1000).toFixed(1)} s with "still reading" (was: waited for the whole read)`);
  await sleep(16_000);
  const r2: any = await fetch(`${base}/api/studio/performance?range=28`).then((x) => x.json());
  say(r2.analysis?.posts?.length === 1 && !r2.refreshing, "the next look has the posts");
  await new Promise((r) => server.close(r)); }

console.log(report.join("\n"));
