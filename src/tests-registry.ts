// The tests registry (daily tracker step 2, owner, Nov 28 2026): every A/B test in one table (studio_tests), planned,
// running or ended. A running test's groups become cuts in the daily tracker (daily-metrics.ts), and every night its
// totals are summed from there into `result`: per group the sign-ups, checkouts and payments, for everyone, for the
// countries that buy, and for the test's focus segment; with how likely the gap is to be chance (Fisher's exact test)
// and how far along it is against the people it needs. Nothing here changes what anyone sees: a test's own code does
// the splitting; the registry only records the rule so the numbers can be read the same way.
//
// Split rule: { kind: "hex_parity", position: n, odd, even } = the nth hex digit from the END of the account id (1 =
// last), odd or even. Two tests running at once must use different positions, or their groups are the same people.
import type { SupabaseClient } from "@supabase/supabase-js";

export type Split = { kind: "hex_parity"; position: number; odd: string; even: string };
export type TestRow = { id: string; name: string; status: string; measure: string; audience: string; focus: Record<string, string> | null; split: Split | null;
  started_at: string | null; ended_at: string | null; needed_per_side: number | null };
export type Tally = { signups: number; checkout: number; paid: number };
export type Scope = { groups: Record<string, Tally>; p: number | null; ahead: string | null };
export type TestResult = { all: Scope; valued: Scope; focus: Scope | null; days: number; per_side_now: number; needed_per_side: number | null; progress: number | null; verdict: string };

/** The group of an account in a test, or null when the test does not cover it (not started, ended, no rule). */
export function groupOf(test: Pick<TestRow, "split" | "started_at" | "ended_at" | "status">, person: { user_id: string; created_at: string }): string | null {
  const s = test.split; if (!s || s.kind !== "hex_parity" || !test.started_at || test.status === "planned") return null;
  const at = Date.parse(person.created_at);
  if (at < Date.parse(test.started_at) || (test.ended_at && at >= Date.parse(test.ended_at))) return null;
  const hex = person.user_id.replace(/-/g, ""); const d = parseInt(hex.charAt(hex.length - Math.max(1, s.position)), 16);
  return Number.isFinite(d) ? (d % 2 === 1 ? s.odd : s.even) : null;
}

/** Two-sided Fisher exact test: how likely a gap at least this lopsided is if the groups really buy alike. */
export function fisher(a: number, n1: number, b: number, n2: number): number | null {
  if (!(n1 > 0 && n2 > 0) || a > n1 || b > n2) return null;
  const K = a + b, N = n1 + n2;
  const lf = (n: number) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const lc = (n: number, k: number) => lf(n) - lf(k) - lf(n - k);
  const lp = (x: number) => lc(n1, x) + lc(n2, K - x) - lc(N, K);
  const p0 = lp(a); let p = 0;
  for (let x = Math.max(0, K - n2); x <= Math.min(K, n1); x++) if (lp(x) <= p0 + 1e-9) p += Math.exp(lp(x));
  return Math.min(1, Math.round(p * 1e4) / 1e4);
}

const scope = (groups: Record<string, Tally>, measure: "paid" | "checkout"): Scope => {
  const names = Object.keys(groups).sort();
  if (names.length !== 2) return { groups, p: null, ahead: null };
  const [x, y] = names.map((n) => groups[n]);
  const rx = x.signups ? x[measure] / x.signups : 0, ry = y.signups ? y[measure] / y.signups : 0;
  return { groups, p: fisher(x[measure], x.signups, y[measure], y.signups), ahead: rx === ry ? null : rx > ry ? names[0] : names[1] };
};

/** The cuts a running test adds to a day in the tracker: value = group, or "group|segment" for the focus cuts. */
export function testCuts(tests: TestRow[], person: { user_id: string; created_at: string }, f: { valued: boolean; role: string; first_tool: string }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const t of tests) {
    const g = groupOf(t, person); if (!g) continue;
    out.push([`test:${t.id}`, g]);
    if (f.valued) { out.push([`test_valued:${t.id}`, g], [`test_valued_role:${t.id}`, `${g}|${f.role}`], [`test_valued_first_tool:${t.id}`, `${g}|${f.first_tool}`]); }
  }
  return out;
}

/** A test's result from its tracker rows (every day since it started). Pure. */
export function readTest(t: TestRow, rows: Array<{ day: string; cut: string; value: string; metrics: any }>): TestResult {
  const sum = (cut: string, keep: (value: string) => string | null) => {
    const g: Record<string, Tally> = {};
    for (const r of rows) { if (r.cut !== cut) continue; const k = keep(r.value); if (!k) continue;
      const x = (g[k] ??= { signups: 0, checkout: 0, paid: 0 }); x.signups += Number(r.metrics?.signups) || 0; x.checkout += Number(r.metrics?.checkout) || 0; x.paid += Number(r.metrics?.paid) || 0; }
    return g;
  };
  const m = t.measure === "checkout" ? "checkout" : "paid";
  const all = scope(sum(`test:${t.id}`, (v) => v), m), valued = scope(sum(`test_valued:${t.id}`, (v) => v), m);
  const fk = t.focus ? Object.keys(t.focus)[0] : null, fv = fk ? t.focus![fk] : null;
  const focus = fk === "role" || fk === "first_tool" ? scope(sum(`test_valued_${fk}:${t.id}`, (v) => { const [g, seg] = v.split("|"); return seg === fv ? g : null; }), m) : null;
  const decide = focus ?? (t.audience === "all" ? all : valued);
  const sides = Object.values((t.audience === "all" ? all : valued).groups).map((x) => x.signups);
  const per = sides.length ? Math.min(...sides) : 0;
  const progress = t.needed_per_side ? Math.min(1, Math.round((per / t.needed_per_side) * 100) / 100) : null;
  const verdict = decide.p == null ? "not enough groups yet" : decide.p < 0.05 ? `${decide.ahead} is ahead, beyond chance so far (p ${decide.p})` : `${decide.ahead ?? "neither"} is ahead, not beyond chance yet (p ${decide.p})`;
  return { all, valued, focus, days: new Set(rows.map((r) => r.day)).size, per_side_now: per, needed_per_side: t.needed_per_side, progress, verdict };
}

const COLS = "id,name,status,measure,audience,focus,split,started_at,ended_at,needed_per_side";
/** The tests the tracker splits by (running, or ended: an ended test's old days keep their groups). Empty when the table is not there yet. */
export async function loadTests(sb: SupabaseClient): Promise<TestRow[]> {
  const r = await sb.from("studio_tests").select(COLS).in("status", ["running", "ended"]);
  if (r.error) return [];
  return (r.data ?? []) as TestRow[];
}

/** Each running or ended test's result, summed from the tracker and stored on its row. Returns how many were written. */
export async function refreshTests(sb: SupabaseClient, tests: TestRow[]): Promise<number> {
  let n = 0;
  for (const t of tests) {
    const rows: any[] = [];
    for (let at = 0; at < 100_000; at += 1000) {
      const r = await sb.from("studio_daily_metrics").select("day,cut,value,metrics").in("cut", [`test:${t.id}`, `test_valued:${t.id}`, `test_valued_role:${t.id}`, `test_valued_first_tool:${t.id}`]).order("day").range(at, at + 999);
      if (r.error) throw r.error; rows.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
    }
    const up = await sb.from("studio_tests").update({ result: readTest(t, rows), result_at: new Date().toISOString() }).eq("id", t.id);
    if (up.error) throw up.error; n++;
  }
  return n;
}
