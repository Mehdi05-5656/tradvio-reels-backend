import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { issuesFor, engagementOutliers, reviewStatement, checkAccountVideos, settleReviews, stillLinked, notifyCreator } from "../src/studio-creator-checks.js";
import { RULES, countable, hasDisclosure, inWindow, postIdOf, videoFlags, accountFlags, monthOf, nextPayout, syncAccount, closeMonths, checkBio, registerCreators, creatorTick } from "../src/studio-creators.js";

const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let seq = 0; const uuid = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** A small in-memory Supabase: enough of the query builder for the program, plus the accrual function in JS. */
function fakeSb(tables: Record<string, any[]>) {
  const keyOf: Record<string, string[]> = { studio_creator_members: ["user_id"], studio_creator_earnings: ["user_id", "month"] };
  const sb: any = {
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: id === ANN ? "ann@synthetic.invalid" : "bob@synthetic.invalid" } } }) } },
    rpc: async (name: string, a: any) => {
      if (name !== "studio_creator_accrue") return { data: null, error: null };
      const v = tables.studio_creator_videos.find((x) => x.id === a.p_video);
      if (v.status !== "eligible") return { data: { added: 0 }, error: null };
      const delta = a.p_counted - v.views_counted; if (delta <= 0) return { data: { added: 0 }, error: null };
      let e = tables.studio_creator_earnings.find((x) => x.user_id === v.user_id && x.month === a.p_month);
      if (!e) { e = { user_id: v.user_id, month: a.p_month, views: 0, amount_micros: 0, carried_in_micros: 0, status: "open" }; tables.studio_creator_earnings.push(e); }
      if (e.status !== "open") return { data: { added: 0, reason: "month_closed" }, error: null };
      v.views_counted = a.p_counted; e.views += delta; e.amount_micros += delta * a.p_micros_per_view;
      tables.studio_creator_earning_lines.push({ user_id: v.user_id, video_id: v.id, month: a.p_month, views: delta });
      return { data: { added: delta }, error: null };
    },
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: ((r: any) => boolean)[] = []; let op: any = null, one = false, maybe = false;
      const q: any = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; }, neq(k: string, v: any) { filters.push((r) => r[k] !== v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; }, lt(k: string, v: any) { filters.push((r) => r[k] < v); return q; }, gte(k: string, v: any) { filters.push((r) => r[k] >= v); return q; },
        maybeSingle() { maybe = true; return q; }, single() { one = true; return q; },
        insert(v: any) { op = { kind: "insert", v }; return q; }, update(v: any) { op = { kind: "update", v }; return q; }, upsert(v: any, o: any) { op = { kind: "upsert", v, o }; return q; },
        then(res: any, rej: any) {
          let out: any[] = [], error: any = null;
          if (op?.kind === "insert") {
            const v = { id: uuid(), created_at: new Date().toISOString(), flags: [], status: table === "studio_creator_accounts" ? "pending_bio" : table === "studio_creator_videos" ? "pending" : undefined, views_counted: 0, proof: "none", enrolled_at: new Date().toISOString(), ...op.v };
            if (table === "studio_creator_accounts" && rows().some((r) => r.platform === v.platform && r.username.toLowerCase() === v.username.toLowerCase() && r.status !== "removed")) error = { message: "duplicate key value violates unique constraint \"studio_creator_accounts_one_owner\"" };
            else { rows().push(v); out = [v]; }
          } else if (op?.kind === "upsert") {
            const keys = keyOf[table] ?? ["id"]; const hit = rows().find((r) => keys.every((k) => r[k] === op.v[k]));
            if (hit) { if (!op.o?.ignoreDuplicates) Object.assign(hit, op.v); out = [hit]; } else { const v = { views: 0, amount_micros: 0, carried_in_micros: 0, status: table === "studio_creator_earnings" ? "open" : undefined, created_at: new Date().toISOString(), ...op.v }; rows().push(v); out = [v]; }
          } else if (op?.kind === "update") { out = rows().filter((r) => filters.every((f) => f(r))); for (const r of out) Object.assign(r, op.v); }
          else out = rows().filter((r) => filters.every((f) => f(r)));
          const data = one || maybe ? out[0] ?? null : out;
          return Promise.resolve({ data, error: error ?? (one && !out.length ? { message: "no rows" } : null) }).then(res, rej);
        },
      };
      return q;
    },
  };
  return sb;
}
const tablesFor = () => ({ studio_customers: [{ user_id: ANN, status: "active" }], studio_social_profiles: [{ user_id: ANN, profile_key: "pk_ann", accounts: [{ platform: "tiktok", username: "anncreates" }, { platform: "instagram", username: "ann.creates" }] }, { user_id: BOB, profile_key: "pk_bob", accounts: [{ platform: "tiktok", username: "AnnCreates" }] }],
  studio_social_posts: [] as any[], studio_jobs: [{ id: JOB, user_id: ANN, status: "done", outputs: [{ key: "out/1.mp4" }], finished_at: "2026-10-01T00:00:00Z" }],
  studio_creator_members: [] as any[], studio_creator_accounts: [] as any[], studio_creator_videos: [] as any[], studio_creator_earnings: [] as any[], studio_creator_earning_lines: [] as any[] });

test("creator rules: the cap, the window, post ids, flags, months", () => {
  assert.equal(countable({ views: 2_500_000, posted_at: "2026-10-01T00:00:00Z" }), RULES.view_cap);
  assert.equal(countable({ views: 900, posted_at: null }), 0, "no posting time, nothing counts");
  assert.equal(countable({ views: 999, posted_at: "2026-10-01T00:00:00Z" }), 0, "under the per-video minimum");
  assert.equal(countable({ views: 1000, posted_at: "2026-10-01T00:00:00Z" }), 1000, "then every view counts");
  assert.equal(hasDisclosure("new drop #Clone8Partner"), true); assert.equal(hasDisclosure("made with clone8"), false);
  assert.equal(inWindow("2026-10-01T00:00:00Z", new Date("2026-10-30T00:00:00Z")), true);
  assert.equal(inWindow("2026-10-01T00:00:00Z", new Date("2026-11-02T00:00:00Z")), false);
  assert.equal(postIdOf("https://www.tiktok.com/@ann/video/7302469865352793358?is_from_webapp=1"), "7302469865352793358");
  assert.equal(postIdOf("https://www.instagram.com/reel/C9xYz_AbCd/"), "C9xYz_AbCd");
  assert.deepEqual(videoFlags({ views: 400_000, likes: 300, comments: 0 }), ["views_without_likes", "no_comments"]);
  assert.deepEqual(videoFlags({ views: 400_000, likes: 30_000, comments: 400 }), []);
  assert.deepEqual(accountFlags({ followers_at_enroll: 1000, followers: 9000, days: 5 }), ["followers_jumped"]);
  assert.equal(monthOf(new Date("2026-10-31T23:00:00Z")), "2026-10-01"); assert.equal(nextPayout(new Date("2026-10-31T23:00:00Z")), "2026-11-01");
  assert.match(RULES.bio_phrase, /@clone8\.io/);
});

test("creator program flow: join, enroll with the bio check, videos posted through Clone8 or linked, views counted once, capped, windowed; months close with carry-over", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  let bio = "just vibes";
  const posts: any[] = [];
  const deps: any = { env: { STUDIO_CREATORS_ENABLED: "true", STUDIO_SOCIAL_ENABLED: "true" }, log: () => {}, scrape: async () => ({ bio, followers: 1200 }), provider: { recentPosts: async () => posts } };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const u = req.headers["x-test-user"]; if (u) req.auth = { user_id: u, email: u === ANN ? "ann@synthetic.invalid" : "bob@synthetic.invalid" }; next(); });
  registerCreators(app, () => sb, deps);
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, user = ANN) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await call("POST", "/api/studio/creators/accounts", { platform: "tiktok" })).body.error, "not_a_member");
    assert.equal((await call("POST", "/api/studio/creators/join", { accept: true, terms_version: "old", age_confirmed: true, payout_method: "paypal", payout_email: "ann@pay.example" })).body.error, "terms_required");
    assert.equal((await call("POST", "/api/studio/creators/join", { accept: true, terms_version: RULES.terms_version, age_confirmed: true, payout_method: "paypal", payout_email: "nope" })).body.error, "payout_required");
    const joined = await call("POST", "/api/studio/creators/join", { accept: true, terms_version: RULES.terms_version, age_confirmed: true, payout_method: "paypal", payout_email: "ann@pay.example" });
    assert.equal(joined.status, 200, JSON.stringify(joined.body)); assert.equal(joined.body.member.status, "active"); assert.equal(joined.body.linked.length, 2);
    // enroll: the bio line is missing, so nothing counts yet
    let st = (await call("POST", "/api/studio/creators/accounts", { platform: "tiktok" })).body;
    assert.equal(st.accounts[0].status, "pending_bio"); assert.equal(st.accounts[0].bio_ok, false);
    assert.equal((await call("POST", "/api/studio/creators/accounts", { platform: "youtube" })).body.error, "platform_not_in_program");
    // the same TikTok cannot be enrolled by someone else
    await call("POST", "/api/studio/creators/join", { accept: true, terms_version: RULES.terms_version, age_confirmed: true, payout_method: "wise", payout_email: "bob@pay.example" }, BOB);
    assert.equal((await call("POST", "/api/studio/creators/accounts", { platform: "tiktok" }, BOB)).body.error, "account_taken");
    bio = "Creator | powered by @clone8.io";
    const accId = st.accounts[0].id;
    st = (await call("POST", `/api/studio/creators/accounts/${accId}/check-bio`)).body;
    assert.equal(st.accounts[0].status, "active"); assert.equal(st.bio.ok, true);
    // two videos after enrollment: one posted through Clone8, one posted in the app
    // enrolled two days ago, posted an hour after: everything below is read "now", so it all lands in this month
    tables.studio_creator_accounts[0].enrolled_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const enrolled = tables.studio_creator_accounts[0].enrolled_at;
    const later = new Date(Date.parse(enrolled) + 3_600_000).toISOString();
    tables.studio_social_posts.push({ user_id: ANN, job_id: JOB, output_key: "out/1.mp4", created_at: enrolled, results: [{ platform: "tiktok", url: "https://www.tiktok.com/@anncreates/video/7000000000000000001" }] });
    posts.push({ platform: "tiktok", id: "x1", url: "https://www.tiktok.com/@anncreates/video/7000000000000000001", caption: "made with clone8 #clone8partner", published_at: later, thumb_url: null, duration_s: 20, views: 40_000, likes: 3000, comments: 50, shares: 10, saves: 0, extra: {} },
      { platform: "tiktok", id: "x2", url: "https://www.tiktok.com/@anncreates/video/7000000000000000002", caption: "app upload #clone8partner", published_at: later, thumb_url: null, duration_s: 20, views: 1_500_000, likes: 90_000, comments: 900, shares: 100, saves: 0, extra: {} },
      { platform: "tiktok", id: "x0", url: "https://www.tiktok.com/@anncreates/video/6999999999999999999", caption: "before joining", published_at: new Date(Date.parse(enrolled) - 86_400_000).toISOString(), thumb_url: null, duration_s: 20, views: 9_000_000, likes: 1, comments: 0, shares: 0, saves: 0, extra: {} });
    const acc = tables.studio_creator_accounts[0];
    const now = new Date();
    await syncAccount(sb, deps, acc, "pk_ann", now);
    assert.equal(tables.studio_creator_videos.length, 2, "videos from before joining are not tracked");
    // a Clone8 post without the disclosure tag is found but waits; adding the tag later makes it earn
    const v1 = tables.studio_creator_videos.find((v) => v.platform_post_id === "7000000000000000001"), v2 = tables.studio_creator_videos.find((v) => v.platform_post_id === "7000000000000000002");
    assert.equal(v1.proof, "posted_via_clone8"); assert.equal(v1.status, "eligible"); assert.equal(v1.views_counted, 40_000);
    assert.equal(v2.status, "pending"); assert.equal(v2.views_counted, 0, "not shown to be Clone8 yet: nothing counts");
    // linking the app upload to a Clone8 generation counts it, capped at a million
    st = (await call("POST", `/api/studio/creators/videos/${v2.id}/link`, { job_id: JOB })).body;
    assert.equal(v2.status, "eligible"); assert.equal(v2.views_counted, RULES.view_cap);
    // a second read with the same numbers adds nothing; growth adds only the growth
    await syncAccount(sb, deps, acc, "pk_ann", now);
    posts[0].views = 41_000; await syncAccount(sb, deps, acc, "pk_ann", now);
    const month = monthOf(now);
    const e = tables.studio_creator_earnings.find((x) => x.user_id === ANN && x.month === month);
    assert.equal(e.views, 41_000 + RULES.view_cap); assert.equal(e.amount_micros, (41_000 + RULES.view_cap) * 1000, "$1 per 1,000 views");
    // after the window, growth is not counted
    posts[0].views = 90_000; await syncAccount(sb, deps, acc, "pk_ann", new Date(Date.parse(later) + 31 * 86_400_000));
    assert.equal(v1.views_counted, 41_000);
    // the month closes on the 1st: Ann's is over the minimum and every check passed (approved on its own); a small one carries over
    tables.studio_creator_earnings.push({ user_id: BOB, month, views: 5000, amount_micros: 5_000_000, carried_in_micros: 0, status: "open" });
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 1));
    assert.equal(await closeMonths(sb, next), 2);
    assert.equal(tables.studio_creator_earnings.find((x) => x.user_id === ANN && x.month === month).status, "approved");
    assert.match(tables.studio_creator_earnings.find((x) => x.user_id === ANN && x.month === month).note, /Every check passed/);
    assert.equal(tables.studio_creator_earnings.find((x) => x.user_id === BOB && x.month === month).status, "carried");
    assert.equal(tables.studio_creator_earnings.find((x) => x.user_id === BOB && x.month === monthOf(next)).carried_in_micros, 5_000_000);
    // a closed month is never written again
    posts.push({ ...posts[1], id: "x3", url: "https://www.tiktok.com/@anncreates/video/7000000000000000003", views: 10 });
    const ok = await sb.rpc("studio_creator_accrue", { p_video: v1.id, p_counted: 50_000, p_month: month, p_micros_per_view: 1000 });
    assert.equal(ok.data.reason, "month_closed");
    // the state the page shows
    const page = (await call("GET", "/api/studio/creators")).body;
    assert.equal(page.statements[0].status, "approved"); assert.deepEqual(page.to_fix, []); assert.equal(page.videos.length, 2); assert.equal(page.rules.cpm_usd, 1);
    // leaving removes the accounts and pauses membership
    const left = (await call("POST", "/api/studio/creators/leave")).body;
    assert.equal(left.member.status, "paused"); assert.equal(left.accounts.length, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test("bio check: a removed line pauses counting and is flagged; followers jumping is flagged for review", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  tables.studio_creator_accounts.push({ id: "acc-1", user_id: ANN, platform: "tiktok", username: "anncreates", status: "active", bio_ok: true, followers_at_enroll: 1000, flags: [], enrolled_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await checkBio(sb, { scrape: async () => ({ bio: "new bio", followers: 8000 }) } as any, tables.studio_creator_accounts[0]);
  const a = tables.studio_creator_accounts[0];
  assert.equal(a.status, "pending_bio"); assert.deepEqual(a.flags.sort(), ["bio_missing", "followers_jumped"]);
});

test("the disclosure tag: a Clone8 video without #clone8partner is found but waits; once the caption carries it, it earns", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  const enrolled = new Date(Date.now() - 86_400_000).toISOString();
  tables.studio_creator_accounts.push({ id: "acc-2", user_id: ANN, platform: "instagram", username: "ann.creates", status: "active", bio_ok: true, flags: [], enrolled_at: enrolled });
  tables.studio_social_posts.push({ user_id: ANN, job_id: JOB, output_key: "out/1.mp4", created_at: enrolled, results: [{ platform: "instagram", url: "https://www.instagram.com/reel/AbCdEf123/" }] });
  const post: any = { platform: "instagram", id: "17900", url: "https://www.instagram.com/reel/AbCdEf123/", caption: "new reel", published_at: new Date(Date.parse(enrolled) + 60_000).toISOString(), thumb_url: null, duration_s: 15, views: 5000, likes: 400, comments: 12, shares: 3, saves: 1, extra: {} };
  const deps: any = { provider: { recentPosts: async () => [post] } };
  await syncAccount(sb, deps, tables.studio_creator_accounts[0], "pk_ann");
  const v = tables.studio_creator_videos[0];
  assert.equal(v.proof, "posted_via_clone8"); assert.equal(v.status, "pending"); assert.ok(v.flags.includes("missing_tag")); assert.equal(v.views_counted, 0);
  post.caption = "new reel #clone8partner";
  await syncAccount(sb, deps, tables.studio_creator_accounts[0], "pk_ann");
  assert.equal(v.status, "eligible"); assert.ok(!v.flags.includes("missing_tag")); assert.equal(v.views_counted, 5000);
});


test("checks: issues the creator can fix and ones for the owner, engagement against the creator's own norm", () => {
  const acc = { id: "acc", platform: "tiktok", username: "ann", status: "pending_bio", flags: ["followers_jumped"] };
  const vids = [{ id: "v1", status: "pending", proof: "none", views: 5000, caption: "x", flags: ["missing_tag"] }, { id: "v2", status: "eligible", proof: "linked", views: 300, caption: "y", flags: [] }, { id: "v3", status: "rejected", proof: "none", views: 9000, flags: ["missing_tag"] }];
  const issues = issuesFor([acc], vids);
  assert.deepEqual(issues.map((i) => `${i.code}:${i.who}:${i.ref}`).sort(), ["bio_missing:creator:acc", "followers_jumped:review:acc", "missing_tag:creator:v1", "not_proven:creator:v1"].sort(), "rejected videos and small unproven ones raise nothing");
  const norm = (id: string, views: number, likes: number) => ({ id, views, likes, comments: 10 });
  const low = engagementOutliers([norm("a", 10_000, 800), norm("b", 12_000, 900), norm("c", 9_000, 700), norm("d", 15_000, 1200), norm("e", 11_000, 850), norm("bot", 400_000, 900)]);
  assert.deepEqual([...low], ["bot"]); assert.equal(engagementOutliers([norm("a", 10_000, 1), norm("b", 30_000, 1)]).size, 0, "too few videos to judge");
  assert.equal(stillLinked({ platform: "tiktok", username: "Ann" }, [{ platform: "tiktok", username: "@ann" }]), true);
  assert.equal(stillLinked({ platform: "tiktok", username: "ann" }, [{ platform: "instagram", username: "ann" }]), false);
});

test("checks: taken down early and the same video on two accounts are flagged; a statement splits clear and in question, and is approved on its own once cleared", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  const month = monthOf();
  const day = 86_400_000, t0 = Date.now() - 5 * day;
  tables.studio_creator_accounts.push({ id: "accA", user_id: ANN, platform: "tiktok", username: "ann", status: "active", flags: [] }, { id: "accB", user_id: ANN, platform: "instagram", username: "ann.ig", status: "active", flags: [] });
  const v = (id: string, account: string, o: any) => ({ id, account_id: account, user_id: ANN, platform: account === "accA" ? "tiktok" : "instagram", platform_post_id: id, status: "eligible", proof: "linked", views: 100_000, likes: 8000, comments: 100, views_counted: 100_000, posted_at: new Date(t0).toISOString(), flags: [], ...o });
  tables.studio_creator_videos.push(v("p1", "accA", { job_id: JOB, output_key: "out/1.mp4" }), v("p2", "accA", { job_id: null }), v("p3", "accB", { job_id: JOB, output_key: "out/1.mp4" }));
  tables.studio_creator_earnings.push({ user_id: ANN, month, views: 300_000, amount_micros: 300_000_000, carried_in_micros: 0, status: "review" });
  for (const id of ["p1", "p2", "p3"]) tables.studio_creator_earning_lines.push({ user_id: ANN, video_id: id, month, views: 100_000, amount_micros: 100_000_000 });
  // p2 is no longer in the account's own list, which reaches back before it was posted
  await checkAccountVideos(sb, tables.studio_creator_accounts[0], { ids: new Set(["p1"]), oldest: t0 - day });
  const byId = (id: string) => tables.studio_creator_videos.find((x) => x.id === id);
  assert.deepEqual(byId("p1").flags, ["same_video_twice"]); assert.deepEqual(byId("p2").flags, ["removed_early"]);
  await checkAccountVideos(sb, tables.studio_creator_accounts[1], null);
  assert.deepEqual(byId("p3").flags, ["same_video_twice"], "an incomplete list never says removed");
  let r = await reviewStatement(sb, ANN, month);
  assert.equal(r.question_micros, 300_000_000); assert.equal(r.clear_micros, 0);
  assert.equal(await settleReviews(sb), 0);
  assert.match(tables.studio_creator_earnings[0].note, /\$300\.00 in question/);
  // the owner clears the twin; the video comes back up: the next check approves the statement
  byId("p1").flags = []; byId("p3").flags = []; byId("p2").flags = [];
  r = await reviewStatement(sb, ANN, month);
  assert.equal(r.clear_micros, 300_000_000);
  assert.equal(await settleReviews(sb), 1);
  assert.equal(tables.studio_creator_earnings[0].status, "approved");
});

test("checks: the creator is told what to fix by email, once a week per issue unless the owner sends it now", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  const sent: any[] = [];
  const fetchFn: any = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); };
  const env = { RESEND_API_KEY: "re_test", DASHBOARD_URL: "https://app.clone8.io" };
  const issues = issuesFor([{ id: "acc", platform: "tiktok", username: "ann", status: "active", flags: ["bio_missing"] }], [{ id: "v1", status: "pending", proof: "linked", views: 50, caption: "c", flags: ["missing_tag"] }]);
  assert.equal(await notifyCreator(sb, ANN, issues, { env, fetch: fetchFn }), true);
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /Fix 2 things/); assert.match(sent[0].text, /powered by @clone8\.io/); assert.match(sent[0].text, /#clone8partner/);
  tables.studio_events = [{ user_id: ANN, kind: "email", name: "creator_issue_keys", props: { keys: ["bio_missing:acc", "missing_tag:v1"] }, created_at: new Date().toISOString() }];
  assert.equal(await notifyCreator(sb, ANN, issues, { env, fetch: fetchFn }), false, "already told this week");
  assert.equal(await notifyCreator(sb, ANN, issues, { env, fetch: fetchFn, force: true }), true);
  assert.equal(await notifyCreator(sb, ANN, issuesFor([], [{ id: "v9", status: "eligible", proof: "linked", views: 9e5, flags: ["views_without_likes"] }]), { env, fetch: fetchFn, force: true }), false, "owner-only issues are not mailed to the creator");
  assert.equal(sent.length, 2);
});

test("the scheduled pass: an account unlinked from Clone8 is flagged and not read; linked again, the flag goes and its videos are read", async () => {
  const tables = tablesFor(); const sb = fakeSb(tables);
  tables.studio_creator_members.push({ user_id: ANN, status: "active", terms_version: RULES.terms_version });
  tables.studio_creator_accounts.push({ id: "accT", user_id: ANN, platform: "tiktok", username: "gone.account", status: "active", bio_ok: true, bio_checked_at: new Date().toISOString(), flags: [], enrolled_at: new Date(Date.now() - 86_400_000).toISOString() });
  let reads = 0;
  const deps: any = { log: () => {}, scrape: async () => ({ bio: "powered by @clone8.io", followers: 100 }), provider: { recentPosts: async () => { reads++; return []; } } };
  await creatorTick(sb, deps);
  assert.deepEqual(tables.studio_creator_accounts[0].flags, ["unlinked"]); assert.equal(reads, 0);
  tables.studio_social_profiles[0].accounts.push({ platform: "tiktok", username: "gone.account" });
  await creatorTick(sb, deps);
  assert.deepEqual(tables.studio_creator_accounts[0].flags, []); assert.equal(reads, 1);
});
