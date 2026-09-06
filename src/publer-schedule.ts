// Publer schedule + publisher/analytics workers.
// - Time base: America/Los_Angeles (PT). Slot grid = 08:00, 10:00, 12:00, 14:00,
//   16:00, 18:00, 20:00, 22:00 by default (configurable per-day via publer_config).
// - Publisher cron (every 5min): for each slot, if the current PT time is >=
//   slot_time AND we haven't published slot_index today, publish next pending.
//   This automatically backfills earlier slots when we first start mid-day.
// - Analytics poller: snapshot per publer_post_id every 30min for first 7 days,
//   then hourly through 30 days, then freeze.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listAccounts,
  listPosts,
  postInsights,
  publishNow,
  uploadFromUrl,
  waitForJob,
} from "./publer.js";

const BUCKET = "reels";

// Publer serializes media-from-url per workspace: parallel uploads get 403.
// A single in-process mutex is enough (single node instance).
let uploadMutex: Promise<void> = Promise.resolve();
async function withUploadLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const prev = uploadMutex;
  uploadMutex = gate;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// --- PT time helpers ---------------------------------------------------------

/**
 * Returns { ymd: "2026-09-06", hhmm: "13:04", minutesSinceMidnight: 784 } in
 * America/Los_Angeles for the given date (default: now).
 */
export function ptNow(now: Date = new Date()): {
  ymd: string;
  hhmm: string;
  minutes: number;
  iso: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = get("hour");
  const mm = get("minute");
  const minutes = parseInt(hh, 10) * 60 + parseInt(mm, 10);
  return { ymd, hhmm: `${hh}:${mm}`, minutes, iso: now.toISOString() };
}

/**
 * Convert "YYYY-MM-DD" + "HH:MM" (interpreted in America/Los_Angeles) to a UTC Date.
 * DST-safe: iterates once to correct offset.
 */
export function ptDateTimeToUtc(ymd: string, hhmm: string): Date {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  const [hh, mm] = hhmm.split(":").map((n) => parseInt(n, 10));
  // First naive guess: treat as UTC, then compute PT offset for that instant.
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(guess));
    const off = fmt.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
    // "GMT-7" or "GMT-08:00"
    const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(off);
    if (!match) break;
    const sign = match[1] === "-" ? -1 : 1;
    const h = parseInt(match[2], 10);
    const min = match[3] ? parseInt(match[3], 10) : 0;
    const offsetMinutes = sign * (h * 60 + min);
    // If PT was interpreted as "PT time = UTC + offset", then UTC = PT - offset.
    const corrected = Date.UTC(y, m - 1, d, hh, mm, 0) - offsetMinutes * 60_000;
    guess = corrected;
  }
  return new Date(guess);
}

// --- Config helpers ----------------------------------------------------------

export interface Config {
  workspaceId: string;
  timezone: string;
  slotTimes: string[];      // "HH:MM"
  jitterMinutes: number;
}
export interface SlotConfig {
  phone_slot: string;
  publer_account_id: string;
  provider: "instagram" | "tiktok";
  handle: string;
  daily_target: number;
  paused: boolean;
}

export async function loadConfig(sb: SupabaseClient): Promise<Config> {
  const { data, error } = await sb.from("publer_config").select("*").eq("id", "main").single();
  if (error) throw error;
  return {
    workspaceId: data.workspace_id,
    timezone: data.timezone,
    slotTimes: data.slot_times as string[],
    jitterMinutes: data.jitter_minutes as number,
  };
}

export async function loadSlots(sb: SupabaseClient): Promise<SlotConfig[]> {
  const { data, error } = await sb
    .from("publer_slot_config")
    .select("*")
    .order("phone_slot", { ascending: true });
  if (error) throw error;
  return data as SlotConfig[];
}

// --- Publisher ---------------------------------------------------------------

/**
 * Compute the set of slot_indexes that are eligible to publish RIGHT NOW for a
 * given LA day. Only indexes < daily_target are considered. An index is eligible
 * if PT-now-minutes >= slot_minutes.
 */
export function eligibleSlotIndexes(
  slotTimesHHMM: string[],
  dailyTarget: number,
  ptMinutesNow: number,
): number[] {
  const out: number[] = [];
  const limit = Math.min(dailyTarget, slotTimesHHMM.length);
  for (let i = 0; i < limit; i++) {
    const [h, m] = slotTimesHHMM[i].split(":").map((n) => parseInt(n, 10));
    if (h * 60 + m <= ptMinutesNow) out.push(i);
  }
  return out;
}

/** Get already-taken slot indexes today for a phone slot. */
async function takenSlotIndexes(
  sb: SupabaseClient,
  phone_slot: string,
  ymd: string,
): Promise<Set<number>> {
  const { data, error } = await sb
    .from("publer_publish_log")
    .select("slot_index,status")
    .eq("phone_slot", phone_slot)
    .eq("slot_local_date", ymd)
    .in("status", ["pending", "published"]);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.slot_index as number));
}

async function nextPendingQueueRow(sb: SupabaseClient, phone_slot: string): Promise<any | null> {
  const { data, error } = await sb
    .from("reels_manual_queue")
    .select("*")
    .eq("phone_slot", phone_slot)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function signedUrl(sb: SupabaseClient, path: string, ttl = 86400): Promise<string> {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, ttl);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Publish one video for (slot, slotIndex).
 * 1) Reserve the slot with a pending log row (unique index prevents dupes).
 * 2) Upload media from URL, wait for job to complete, read media id + path.
 * 3) Call publishNow; poll job; extract publer_post id + link.
 * 4) Mark queue row as posted; update publish_log to published.
 */
export async function publishOne(
  sb: SupabaseClient,
  cfg: Config,
  slot: SlotConfig,
  slotIndex: number,
  ptYmd: string,
): Promise<{ status: "published" | "no_queue" | "reserve_conflict" | "failed"; error?: string; publer_post_id?: string }> {
  const row = await nextPendingQueueRow(sb, slot.phone_slot);
  if (!row) return { status: "no_queue" };

  const planned = ptDateTimeToUtc(ptYmd, cfg.slotTimes[slotIndex]).toISOString();

  // 1) Reserve slot — unique index (phone_slot, slot_local_date, slot_index) on status in (pending,published)
  const { data: log, error: reserveErr } = await sb
    .from("publer_publish_log")
    .insert({
      queue_id: row.id,
      phone_slot: slot.phone_slot,
      slot_local_date: ptYmd,
      slot_index: slotIndex,
      planned_at: planned,
      status: "pending",
    })
    .select("id")
    .single();
  if (reserveErr) {
    if ((reserveErr as any).code === "23505") return { status: "reserve_conflict" };
    return { status: "failed", error: reserveErr.message };
  }

  // Also flip queue row to publer_publishing so it doesn't re-appear.
  await sb
    .from("reels_manual_queue")
    .update({ status: "publer_publishing" })
    .eq("id", row.id);

  try {
    // 2) Upload — serialize per workspace to respect Publer's queue rule
    const url = await signedUrl(sb, row.storage_path, 24 * 3600);
    const name = row.filename || row.storage_path.split("/").pop() || "video.mp4";
    const uploadPayload = await withUploadLock(async () => {
      const { jobId: uploadJob } = await uploadFromUrl(cfg.workspaceId, url, name);
      const payload = await waitForJob(uploadJob, {
        timeoutMs: 180_000,
        intervalMs: 3000,
        workspaceId: cfg.workspaceId,
      });
      (payload as any).__uploadJob = uploadJob;
      return payload;
    });
    const uploadJob = (uploadPayload as any).__uploadJob;

    // Payload shape from Publer for from-url upload is an array/object of media
    // { id, path, thumbnails?, ... }. Handle both array + wrapped shapes.
    let mediaObj: any = null;
    if (Array.isArray(uploadPayload)) mediaObj = uploadPayload[0];
    else if (uploadPayload?.media) {
      mediaObj = Array.isArray(uploadPayload.media) ? uploadPayload.media[0] : uploadPayload.media;
    } else if (uploadPayload?.id) mediaObj = uploadPayload;
    if (!mediaObj || !mediaObj.id) throw new Error("upload payload missing media id: " + JSON.stringify(uploadPayload).slice(0, 300));

    await sb.from("publer_publish_log").update({
      media_id: mediaObj.id,
      publer_job_id: uploadJob,
    }).eq("id", log.id);

    // 3) Publish
    // Default caption for now — user can extend later; keep it non-empty and non-spammy.
    const caption = ""; // empty caption is allowed; we can layer captions later
    const { jobId: publishJob } = await publishNow({
      workspaceId: cfg.workspaceId,
      accountId: slot.publer_account_id,
      provider: slot.provider,
      text: caption,
      mediaId: mediaObj.id,
      mediaPath: mediaObj.path,
      thumbnailPath: mediaObj.thumbnails?.[0]?.real,
    });
    const publishPayload = await waitForJob(publishJob, {
      timeoutMs: 120_000,
      intervalMs: 2500,
      workspaceId: cfg.workspaceId,
    });

    // Failures embedded in payload
    const failures = publishPayload?.failures;
    if (failures && Object.keys(failures).length) {
      throw new Error("publer publish failures: " + JSON.stringify(failures).slice(0, 400));
    }

    // Publer's publish job payload doesn't include the created post id.
    // We resolve it by listing recent posts for this account (state=published)
    // and picking the newest. Small polling window because IG/TikTok take a few
    // seconds to be listed.
    let postId: string | undefined;
    let postLink: string | undefined;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        // Note: Publer's `state=published` filter returns empty; omit it and
        // rely on the default (which lists all recent posts newest first).
        const listed = await listPosts(cfg.workspaceId, {
          accountId: slot.publer_account_id,
          page: 1,
        });
        const posts = (listed?.posts ?? []).filter(
          (p: any) => p.state === "published" && p.post_link,
        );
        if (posts.length) {
          const p = posts[0]; // newest
          postId = p.id;
          postLink = p.post_link || p.short_link || p.link;
          break;
        }
      } catch {}
    }

    // 4) Mark posted
    await sb.from("publer_publish_log").update({
      publer_job_id: publishJob,
      publer_post_id: postId,
      publer_post_link: postLink,
      status: "published",
      updated_at: new Date().toISOString(),
    }).eq("id", log.id);

    await sb.from("reels_manual_queue").update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_ig_url: postLink,
      notes: (row.notes ? row.notes + " | " : "") + "via publer",
    }).eq("id", row.id);

    return { status: "published", publer_post_id: postId };
  } catch (e: any) {
    // Roll queue row back to pending so it can retry later, mark log failed.
    await sb.from("publer_publish_log").update({
      status: "failed",
      error: String(e.message || e).slice(0, 2000),
      updated_at: new Date().toISOString(),
    }).eq("id", log.id);
    await sb.from("reels_manual_queue").update({
      status: "pending",
    }).eq("id", row.id);
    return { status: "failed", error: String(e.message || e) };
  }
}

/**
 * One publisher tick. Called by cron every 5min.
 */
export async function publisherTick(sb: SupabaseClient): Promise<{
  attempts: Array<{ slot: string; slotIndex: number; result: string; error?: string }>;
}> {
  const cfg = await loadConfig(sb);
  const slots = await loadSlots(sb);
  const now = ptNow();
  const attempts: any[] = [];

  for (const s of slots) {
    if (s.paused) continue;
    const eligible = eligibleSlotIndexes(cfg.slotTimes, s.daily_target, now.minutes);
    const taken = await takenSlotIndexes(sb, s.phone_slot, now.ymd);
    for (const idx of eligible) {
      if (taken.has(idx)) continue;
      const r = await publishOne(sb, cfg, s, idx, now.ymd);
      attempts.push({ slot: s.phone_slot, slotIndex: idx, result: r.status, error: r.error });
      if (r.status === "no_queue" || r.status === "reserve_conflict") {
        // No point trying the next slot index if queue empty; but conflict means
        // someone else claimed idx, keep looking.
        if (r.status === "no_queue") break;
      }
      // Publish one at a time per tick per slot to avoid IG bursty behavior.
      if (r.status === "published" || r.status === "failed") break;
    }
  }
  return { attempts };
}

// --- Analytics poller --------------------------------------------------------

/**
 * Snapshot analytics for all publer_post_ids whose most recent snapshot age
 * satisfies the polling cadence:
 *   < 7 days since published:  every 30 min
 *   7-30 days:                 every hour
 *   > 30 days:                 frozen (no more snapshots)
 */
export async function analyticsTick(sb: SupabaseClient): Promise<{
  snapshots: number;
}> {
  const cfg = await loadConfig(sb);
  const slots = await loadSlots(sb);
  const now = new Date();

  // Build the map account_id -> slot for reverse-lookup
  const accountToSlot = new Map<string, SlotConfig>();
  for (const s of slots) accountToSlot.set(s.publer_account_id, s);

  // Recent post window: 30 days back from now, formatted YYYY-MM-DD in PT
  const to = ptNow(now).ymd;
  const fromDate = new Date(now.getTime() - 30 * 86400_000);
  const from = ptNow(fromDate).ymd;

  let snapshots = 0;

  for (const s of slots) {
    // Skip if account has no posts yet (we still call and it comes back empty)
    let page = 0;
    while (true) {
      const resp = await postInsights(cfg.workspaceId, s.publer_account_id, from, to, {
        page,
        sortBy: "scheduled_at",
        sortType: "DESC",
      });
      const posts = resp?.posts ?? [];
      if (!posts.length) break;

      for (const p of posts) {
        // Determine if we should snapshot based on age
        const pubAt = p.scheduled_at ? new Date(p.scheduled_at) : null;
        if (!pubAt) continue;
        const ageDays = (now.getTime() - pubAt.getTime()) / 86400_000;
        if (ageDays > 30) continue;
        const minGapMin = ageDays < 7 ? 30 : 60;

        // Publer analytics fields are nested { name, value, tooltip } objects.
        const a = p.analytics || {};
        const v = (k: string) => {
          const x = a[k];
          if (x == null) return null;
          if (typeof x === "object" && "value" in x) return x.value ?? null;
          return x;
        };

        // Join key: prefer post_link (stable across /posts + /post_insights)
        // then fall back to the internal post id.
        const joinKey = p.post_link || String(p.id);

        // Get most recent snapshot for this key
        const { data: latest2 } = await sb
          .from("publer_analytics")
          .select("captured_at")
          .eq("publer_post_id", joinKey)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastCap2 = latest2?.captured_at ? new Date(latest2.captured_at) : null;
        if (lastCap2 && (now.getTime() - lastCap2.getTime()) / 60000 < minGapMin) continue;

        await sb.from("publer_analytics").insert({
          publer_post_id: joinKey,
          phone_slot: s.phone_slot,
          captured_at: now.toISOString(),
          reach: v("reach"),
          engagement: v("engagement"),
          engagement_rate: v("engagement_rate"),
          likes: v("likes"),
          comments: v("comments"),
          shares: v("shares"),
          saves: v("saves"),
          video_views: v("video_views"),
          link_clicks: v("link_clicks"),
          post_clicks: v("post_clicks"),
          click_through_rate: v("click_through_rate"),
          reach_rate: v("reach_rate"),
          raw: p,
        });
        snapshots++;
      }

      if (posts.length < 10) break;
      page++;
      if (page > 20) break; // safety
    }
  }
  return { snapshots };
}

// --- Discovery convenience ---------------------------------------------------

/**
 * Reconcile our slot map with what's actually connected in Publer. Only used
 * from a manual endpoint when accounts get re-connected.
 */
export async function reconcileSlotAccounts(sb: SupabaseClient): Promise<{
  matched: number;
  unmatched: string[];
}> {
  const cfg = await loadConfig(sb);
  const publerAccounts = await listAccounts(cfg.workspaceId);
  const slots = await loadSlots(sb);
  const byId = new Map(publerAccounts.map((a) => [a.id, a] as const));
  let matched = 0;
  const unmatched: string[] = [];
  for (const s of slots) {
    const p = byId.get(s.publer_account_id);
    if (p) matched++;
    else unmatched.push(s.phone_slot);
  }
  return { matched, unmatched };
}
