import test from "node:test";
import assert from "node:assert/strict";
import { canBePrivate, shareOf, kindOf, promptOf, filmOf, eligible, fallbackTitle, cleanTidy, settle, listCommunity, communityEnabled } from "../src/studio-community.js";

// A small stand-in for the database client: tables as arrays, the handful of filters the module uses.
function fakeDb(tables: Record<string, any[]>) {
  const from = (name: string) => {
    const rows = () => (tables[name] ??= []); const f: Array<(r: any) => boolean> = []; let order: [string, boolean] | null = null, lim = 1e9, write: any = null;
    const run = () => { let out = rows().filter((r) => f.every((p) => p(r))); if (order) out = [...out].sort((a, b) => (a[order![0]] < b[order![0]] ? -1 : a[order![0]] > b[order![0]] ? 1 : 0) * (order![1] ? 1 : -1)); return out.slice(0, lim); };
    const q: any = {
      select: () => q, eq: (k: string, v: any) => (f.push((r) => r[k] === v), q), in: (k: string, v: any[]) => (f.push((r) => v.includes(r[k])), q), gt: (k: string, v: any) => (f.push((r) => r[k] > v), q), lt: (k: string, v: any) => (f.push((r) => r[k] < v), q),
      is: (k: string, v: any) => (f.push((r) => (r[k] ?? null) === v), q), order: (k: string, o: any) => ((order = [k, o?.ascending !== false]), q), limit: (n: number) => ((lim = n), q),
      maybeSingle: async () => ({ data: (write ? write() : run())[0] ?? null, error: null }),
      upsert: (row: any, o: any) => { const keys = String(o?.onConflict ?? "id").split(","); const hit = rows().find((r) => keys.every((k) => r[k] === row[k])); if (hit) { if (!o?.ignoreDuplicates) Object.assign(hit, row); } else rows().push({ ...row }); return Promise.resolve({ data: null, error: null }); },
      update: (patch: any) => { write = () => { const hit = run(); hit.forEach((r) => Object.assign(r, patch)); return hit; }; return q; },
      then: (ok: any, bad: any) => Promise.resolve({ data: write ? write() : run(), error: null }).then(ok, bad),
    };
    return q;
  };
  return { from, storage: { from: () => ({ createSignedUrls: async (keys: string[]) => ({ data: keys.map((k) => ({ path: k, signedUrl: `https://signed/${k}` })), error: null }) }) } } as any;
}
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const story = (id: string, created_at: string, topic = "Want a pool in your backyard?", extra: any = {}) => ({ id, user_id: U, tool: "kage_motion", status: "done", options: { story: { topic, seconds: 50, kind: "explainer" }, ...extra.options }, outputs: [{ key: `${U}/${id}/1.mp4`, poster_key: `${U}/${id}/1.jpg`, seconds: 51.2 }], created_at, hidden_at: null, ...extra.job });
const tidier = (answer: (prompt: string) => any) => (async (_url: any, init: any) => { const p = JSON.parse(init.body).messages[0].content[0].text.match(/"""([\s\S]*)"""/)[1]; return { ok: true, status: 200, json: async () => ({ model: "claude-haiku-5-5", usage: { input_tokens: 200, output_tokens: 40 }, content: [{ type: "text", text: JSON.stringify(answer(p)) }] }), text: async () => "" }; }) as any;
const ENV = { STUDIO_COMMUNITY_ENABLED: "true", ANTHROPIC_API_KEY: "k" };

test("the switch is off unless it is set", () => { assert.equal(communityEnabled({}), false); assert.equal(communityEnabled(ENV), true); });

test("keeping films private is a perk of Creator and Studio; on Starter every film is shared whatever was stored", () => {
  assert.equal(canBePrivate({ plan_id: "starter" }), false); assert.equal(canBePrivate({ plan_id: "creator" }), true); assert.equal(canBePrivate({ plan_id: "studio" }), true); assert.equal(canBePrivate(null), false);
  assert.equal(canBePrivate({ plan_id: "starter", owner_pass: true }), true); assert.equal(canBePrivate({ plan_id: "starter" }, true), true);
  assert.equal(shareOf({ plan_id: "starter", community_share: "private" }), "public"); // (a stored choice from a higher plan does not hold after a downgrade)
  assert.equal(shareOf({ plan_id: "creator", community_share: "private" }), "private"); assert.equal(shareOf({ plan_id: "creator" }), "public"); assert.equal(shareOf({ plan_id: "studio", community_share: "public" }), "public");
});

test("only fully generated films are ever shareable", () => {
  assert.equal(kindOf({ tool: "kage_motion", options: { story: { topic: "x", kind: "explainer" } } }), "story");
  assert.equal(kindOf({ tool: "longform", options: { longform: { prompt: "x" } } }), "film");
  assert.equal(kindOf({ tool: "kage_motion", options: { brief: "an ad for a kettle" } }), "kage");
  assert.equal(kindOf({ tool: "kage_motion", options: { brief: "x", images: ["a"] } }), null); assert.equal(kindOf({ tool: "kage_motion", options: { brief: "x", reference: { url: "u" } } }), null);
  for (const tool of ["swap", "recast", "clips", "captions", "blueprint", "kage", "character", "instrument"]) assert.equal(kindOf({ tool, options: {} }), null, tool);
  assert.equal(kindOf({ tool: "kage_motion", options: { story: { topic: "x" }, exam: { id: 1 } } }), null); assert.equal(kindOf({ tool: "kage_motion", options: { brief: "x", test: true } }), null);
  assert.equal(kindOf({ tool: "kage_motion", options: { story: { topic: "x", stage: "script" } } }), null); // (a script-only run has no film)
  assert.equal(promptOf({ tool: "longform", options: { longform: { prompt: "  The  Crippen case " } } }), "The Crippen case");
  assert.deepEqual(filmOf({ outputs: [{ key: "a/b/1.mp4", poster_key: "a/b/1.jpg", duration: 49.6 }] }), { key: "a/b/1.mp4", poster_key: "a/b/1.jpg", seconds: 50 }); assert.equal(filmOf({ outputs: [{ key: "a/b/script.json" }] }), null);
});

test("a film is shared only if it was made AFTER its maker was told; never before, never untold", () => {
  const told = "2026-11-12T10:00:00Z";
  assert.equal(eligible(story("a", "2026-11-12T10:05:00Z"), told), true);
  assert.equal(eligible(story("a", "2026-11-12T09:59:00Z"), told), false); assert.equal(eligible(story("a", "2026-11-12T10:05:00Z"), null), false);
  assert.equal(eligible(story("a", "2026-11-12T10:05:00Z", "x", { job: { hidden_at: "2026-11-12T11:00:00Z" } }), told), false);
  assert.equal(eligible(story("a", "2026-11-12T10:05:00Z", "pool"), told), false); // (four letters is not a prompt)
  assert.equal(eligible({ ...story("a", "2026-11-12T10:05:00Z"), status: "failed" }, told), false);
});

test("the tidied prompt keeps the person's words; a rewrite is thrown away; a refusal holds the film", () => {
  const orig = "want a swiming pool in ur backyard";
  assert.deepEqual(cleanTidy(orig, { ok: true, title: "The Backyard Pool", prompt: "Want a swimming pool in your backyard?", reason: "" }), { ok: true, title: "The Backyard Pool", prompt: "Want a swimming pool in your backyard?", reason: "" });
  assert.equal(cleanTidy(orig, { ok: true, title: "Pools", prompt: "A cinematic documentary about the history of swimming pools across three continents and the people who built them." }).prompt, orig);
  assert.equal(cleanTidy(orig, { ok: true, title: "", prompt: "" }).prompt, orig); assert.equal(cleanTidy(orig, { ok: true, title: "", prompt: orig }).title, "Swiming pool in ur backyard");
  assert.deepEqual(cleanTidy("call John Smith on 555 0100", { ok: false, title: "A Phone Call", prompt: "Call John Smith on 555 0100.", reason: "names a private person" }), { ok: false, title: "A Phone Call", prompt: "Call John Smith on 555 0100.", reason: "names a private person" });
  assert.equal(fallbackTitle("How does a toaster work?"), "Toaster work"); assert.equal(fallbackTitle("Want a bunker under your backyard?"), "Bunker under your backyard");
});

test("deciding films: Starter shares, a private Creator account does not, a held prompt is not shown, and it is decided once", async () => {
  const told = "2026-11-12T10:00:00Z";
  const db = fakeDb({ studio_customers: [{ user_id: U, plan_id: "starter", community_noticed_at: told }, { user_id: V, plan_id: "creator", community_share: "private", community_noticed_at: told }],
    studio_jobs: [story("j-before", "2026-11-12T09:00:00Z"), story("j-pool", "2026-11-12T11:00:00Z", "want a swiming pool in ur backyard"), story("j-bad", "2026-11-12T11:30:00Z", "make a film about my neighbour Jane Roe of 4 Elm St"),
      { ...story("j-swap", "2026-11-12T11:40:00Z"), tool: "swap", options: {} }, { ...story("j-v", "2026-11-12T11:00:00Z"), user_id: V }], studio_community_items: [] });
  let calls = 0; const fetch = tidier((p) => (calls++, /Jane Roe/.test(p) ? { ok: false, title: "A Neighbour", prompt: p, reason: "names a private person" } : { ok: true, title: "The Backyard Pool", prompt: "Want a swimming pool in your backyard?", reason: "" }));
  const s1 = await settle(db, U, { env: ENV, fetch, log: () => {}, now: () => Date.parse("2026-11-12T12:00:00Z") });
  assert.deepEqual(s1, { "j-pool": "public", "j-bad": "held" }); assert.equal(calls, 2);
  const s2 = await settle(db, U, { env: ENV, fetch, log: () => {} }); assert.deepEqual(s2, s1); assert.equal(calls, 2); // (decided once: no second call)
  assert.deepEqual(await settle(db, V, { env: ENV, fetch, log: () => {} }), { "j-v": "private" }); assert.equal(calls, 2); // (private: the tidier is never asked)
  // the owner of U moves to Creator and chooses private: films already shared stay shared, new ones are private
  const cust = (await db.from("studio_customers").select().eq("user_id", U).maybeSingle()).data; cust.plan_id = "creator"; cust.community_share = "private";
  (await db.from("studio_jobs")).data; (db as any).from("studio_jobs").upsert(story("j-new", "2026-11-12T13:00:00Z"), { onConflict: "id" });
  assert.deepEqual(await settle(db, U, { env: ENV, fetch, log: () => {} }), { "j-pool": "public", "j-bad": "held", "j-new": "private" });
  // the feed: only the public one, with links, marked as the viewer's own or not; a film hidden by its maker drops out
  const feed = await listCommunity(db, { viewer: V }); assert.deepEqual(feed.films.map((f) => [f.id, f.title, f.prompt, f.mine, f.seconds]), [["j-pool", "The Backyard Pool", "Want a swimming pool in your backyard?", false, 51]]);
  assert.equal(feed.films[0].video_url, `https://signed/${U}/j-pool/1.mp4`); assert.equal((await listCommunity(db, { viewer: U })).films[0].mine, true);
  (await db.from("studio_jobs").select().eq("id", "j-pool").maybeSingle()).data.hidden_at = "2026-11-12T14:00:00Z"; assert.equal((await listCommunity(db, { viewer: V })).films.length, 0);
});

test("nothing is decided for a person who has not been told, or when the tidier cannot be reached", async () => {
  const db = fakeDb({ studio_customers: [{ user_id: U, plan_id: "starter", community_noticed_at: null }], studio_jobs: [story("j1", "2026-11-12T11:00:00Z")], studio_community_items: [] });
  assert.deepEqual(await settle(db, U, { env: ENV, fetch: tidier(() => ({ ok: true, title: "T", prompt: "x" })), log: () => {} }), {});
  db.from("studio_customers").update({ community_noticed_at: "2026-11-12T10:00:00Z" }).eq("user_id", U).then(() => {}); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await settle(db, U, { env: { STUDIO_COMMUNITY_ENABLED: "true" }, log: () => {} }), {}); // (no key: left for next time)
  assert.deepEqual(await settle(db, U, { env: ENV, fetch: (async () => ({ ok: false, status: 529, text: async () => "busy" })) as any, log: () => {} }), {});
  assert.deepEqual(await settle(db, U, { env: ENV, fetch: tidier(() => ({ ok: true, title: "The Backyard Pool", prompt: "Want a pool in your backyard?" })), log: () => {} }), { j1: "public" });
});
