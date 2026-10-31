// Self-serve social posting, provider-neutral. The Studio's routes, loop and UI talk only to this interface; the one
// provider behind it today is Ayrshare (social-ayrshare.ts). Swapping providers means writing another implementation
// of SocialProvider and returning it from getSocialProvider, nothing else.
// Not used by the managed service: that keeps posting through Publer (publer*.ts).
import { ayrshareProvider } from "./social-ayrshare.js";

/** Networks the Studio offers. Pinterest (needs a board) and Reddit (needs a subreddit) wait for their own options. */
export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "youtube", "facebook", "twitter", "linkedin", "threads", "bluesky"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const isSocialPlatform = (p: unknown): p is SocialPlatform => typeof p === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(p);

/** A network the person linked, as the provider reports it. */
export type SocialAccount = { platform: string; username: string | null; display_name: string | null; image_url: string | null; profile_url: string | null; refresh_required?: boolean };
/** The outcome on one network. */
export type SocialResult = { platform: string; status: "scheduled" | "posted" | "failed" | "pending"; url: string | null; error: string | null };
export type SocialPostStatus = "sending" | "scheduled" | "posted" | "partial" | "failed" | "canceled";
export type PublishRequest = {
  text: string; platforms: SocialPlatform[]; mediaUrl: string; scheduleAt: Date | null;
  /** unique per post: a retried request is refused instead of posting twice */
  idempotencyKey?: string;
  /** network options the provider understands: { youtube: { title, visibility }, tiktok: {...}, instagram: {...} } */
  options?: Record<string, any>;
};
export type PublishResult = { providerPostId: string | null; status: SocialPostStatus; results: SocialResult[]; error: string | null };
/** One status change pushed by the provider (a webhook) or read back from it. */
export type SocialEvent = { providerPostId: string; status: SocialPostStatus; results: SocialResult[]; error: string | null; partial?: boolean };

/** A post's overall status from its networks: pending ones keep it open. */
export function statusOf(results: SocialResult[], scheduled: boolean): SocialPostStatus {
  if (!results.length) return "failed";
  const n = results.length, ok = results.filter((r) => r.status === "posted").length, bad = results.filter((r) => r.status === "failed").length;
  if (bad === n) return "failed";
  if (ok === n) return "posted";
  if (ok + bad === n) return "partial";
  return scheduled ? "scheduled" : "sending";
}


/** A webhook delivery we act on: a post settled, or a network was linked, unlinked or needs relinking. */
export type SocialWebhook = { kind: "post"; event: SocialEvent } | { kind: "account"; refId: string; platform: string; change: "link" | "unlink" | "refresh"; bySystem: boolean };

/** A post on a linked account, with what the provider reports about it (private analytics where the network shares them). */
export type ProviderPost = {
  platform: string; id: string; url: string | null; caption: string | null; published_at: string | null; thumb_url: string | null; duration_s: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  /** reach, avg_watch_s, full_watch_rate, hold_3s (share of viewers still watching at 3 s), retention [[second, %]], fyp_share,
   *  engaged_views, avg_view_pct, subscribers_gained, follows */
  extra: Record<string, any>;
};
export type ProviderAccountStats = { platform: string; followers: number | null; extra: Record<string, any> };

export class SocialError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface SocialProvider {
  readonly name: "ayrshare";
  /** The networks this provider can post to with the current configuration. */
  offered(): string[];
  /** A provider profile for one person; `title` must be unique per provider account. */
  createProfile(title: string): Promise<{ profileKey: string; refId: string | null }>;
  deleteProfile(profileKey: string): Promise<void>;
  /** A short-lived link where the person links or unlinks their own networks. */
  connectUrl(profileKey: string, opts?: { redirect?: string; origin?: string; only?: string[] }): Promise<{ url: string; expiresInMinutes: number | null }>;
  accounts(profileKey: string): Promise<SocialAccount[]>;
  disconnect(profileKey: string, platform: string): Promise<void>;
  publish(profileKey: string, req: PublishRequest): Promise<PublishResult>;
  status(profileKey: string, providerPostId: string): Promise<SocialEvent | null>;
  cancel(profileKey: string, providerPostId: string): Promise<void>;
  /** Point the provider's post-status webhook for this profile at our endpoint. */
  registerWebhook(profileKey: string, url: string): Promise<void>;
  /** Read a webhook delivery; null when it is not one we act on. Throws SocialError("webhook_unverified") when it fails verification. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): SocialWebhook | null;
  /** Recent posts on a linked network, including ones published outside Clone8, with their analytics. */
  recentPosts?(profileKey: string, platform: string, limit: number): Promise<ProviderPost[]>;
  /** Followers and account totals per network. */
  accountStats?(profileKey: string, platforms: string[]): Promise<ProviderAccountStats[]>;
}

export type SocialDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void };

/** The configured provider, or null when self-serve posting is off (no keys). */
export function getSocialProvider(deps: SocialDeps = {}): SocialProvider | null {
  const env = deps.env ?? process.env;
  if (env.STUDIO_SOCIAL_ENABLED !== "true") return null;
  return ayrshareProvider(deps);
}
