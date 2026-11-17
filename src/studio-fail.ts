// studio_fail with the full reason (p_detail), falling back to the older four-argument call while the database does
// not have the new function yet (Nov 17 2026): a backend that reaches production before the studio_failures migration
// must still fail and refund jobs, never leave them running.
export async function studioFail(sb: any, args: { p_job: string; p_token: string | null; p_reason: string; p_retry: boolean; p_detail?: string | null; p_stage?: string | null }): Promise<{ data: any; error: any }> {
  const r = await sb.rpc("studio_fail", args);
  if (!r?.error || !("p_detail" in args || "p_stage" in args)) return r;
  const m = `${r.error.code ?? ""} ${r.error.message ?? ""}`;
  if (!/PGRST202|could not find the function|function .*does not exist/i.test(m)) return r;
  const { p_detail: _d, p_stage: _s, ...old } = args;
  return sb.rpc("studio_fail", old);
}
