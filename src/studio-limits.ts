// Abuse controls for the Studio: what a plan may keep in the library and how fast it may queue work.
// Credits already bound the money a customer can spend; these bound the storage and the request rate,
// which credits do not (an upload costs nothing, and a job that fails is refunded).
import type { PlanId } from "./studio.js";

export type PlanLimits = {
  assets: number;          // files kept in the library (uploads not yet deleted)
  storage_bytes: number;   // sum of their sizes
  jobs_per_hour: number;   // jobs created in any rolling hour
};

const GiB = 1024 ** 3;
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  starter: { assets: 60, storage_bytes: 10 * GiB, jobs_per_hour: 20 },
  creator: { assets: 200, storage_bytes: 30 * GiB, jobs_per_hour: 40 },
  studio: { assets: 600, storage_bytes: 100 * GiB, jobs_per_hour: 100 },
};
/** Someone without an active plan can still upload a little so the first job is ready the moment they pay. */
export const NO_PLAN_LIMITS: PlanLimits = { assets: 5, storage_bytes: 2 * GiB, jobs_per_hour: 0 };

/** A paid plan (active or trialing), or the owner pass (the owner's own account; migration 20261109000000). */
export function hasPlanAccess(customer: { status?: string | null; owner_pass?: boolean | null } | null | undefined): boolean {
  return !!customer && (customer.status === "active" || customer.status === "trialing" || customer.owner_pass === true);
}

export function limitsFor(customer: { plan_id?: string | null; status?: string | null; owner_pass?: boolean | null } | null | undefined): PlanLimits {
  if (customer?.owner_pass) return PLAN_LIMITS.studio; // the owner works at the largest plan's limits
  const active = customer?.status === "active" || customer?.status === "trialing";
  const plan = customer?.plan_id ? PLAN_LIMITS[customer.plan_id as PlanId] : undefined;
  return active && plan ? plan : NO_PLAN_LIMITS;
}

export type LimitError = { code: "too_many_files" | "storage_full" | "rate_limited"; message: string; status: number } | null;
const gib = (b: number) => `${Math.round((b / GiB) * 10) / 10} GB`;

/** Whether one more upload of `size` bytes fits. `assets` are the person's kept files (status not deleted). */
export function uploadAllowance(limits: PlanLimits, assets: { bytes: number | null }[], size: number): LimitError {
  if (assets.length >= limits.assets) return { code: "too_many_files", message: `Your plan keeps up to ${limits.assets} files. Delete some from the library to upload more.`, status: 409 };
  const used = assets.reduce((s, a) => s + Number(a.bytes ?? 0), 0);
  if (used + size > limits.storage_bytes) return { code: "storage_full", message: `Your plan stores up to ${gib(limits.storage_bytes)}; ${gib(used)} is in use. Delete some files or pick a larger plan.`, status: 409 };
  return null;
}

/** Whether one more job may be queued given how many were created in the last hour. */
export function jobAllowance(limits: PlanLimits, createdLastHour: number): LimitError {
  if (createdLastHour >= limits.jobs_per_hour) return { code: "rate_limited", message: `Your plan starts up to ${limits.jobs_per_hour} jobs an hour. Try again in a little while.`, status: 429 };
  return null;
}

/** Reads what the checks need and answers the first limit hit, or null. Never throws on a read error: a limit that
 *  cannot be read is not enforced, because refusing every upload during a database hiccup is the worse failure. */
export async function checkUpload(sb: any, user: string, size: number): Promise<LimitError> {
  try {
    const [cust, assets] = await Promise.all([
      sb.from("studio_customers").select("plan_id,status,owner_pass").eq("user_id", user).maybeSingle(),
      sb.from("studio_assets").select("bytes").eq("user_id", user).neq("status", "deleted").limit(1000),
    ]);
    if (cust.error || assets.error) return null;
    return uploadAllowance(limitsFor(cust.data), assets.data ?? [], size);
  } catch { return null; }
}
export async function checkJobRate(sb: any, user: string, now = new Date()): Promise<LimitError> {
  try {
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const [cust, jobs] = await Promise.all([
      sb.from("studio_customers").select("plan_id,status,owner_pass").eq("user_id", user).maybeSingle(),
      sb.from("studio_jobs").select("id", { count: "exact", head: true }).eq("user_id", user).gte("created_at", since),
    ]);
    if (cust.error || jobs.error) return null;
    return jobAllowance(limitsFor(cust.data), Number(jobs.count ?? 0));
  } catch { return null; }
}
