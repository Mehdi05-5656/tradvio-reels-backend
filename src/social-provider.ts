// Self-serve social posting, provider-neutral. The Studio's routes, loop and UI talk only to this interface; the one
// provider behind it today is Ayrshare (social-ayrshare.ts). Swapping providers means writing another implementation
// of SocialProvider and returning it from getSocialProvider, nothing else.
// Not used by the managed service: that keeps posting through Publer (publer*.ts).
import { ayrshareProvider } from "./social-ayrshare.js";
import { zernioProvider } from "./social-zernio.js";

/** Networks the Studio offers. Pinterest (needs a board) and Reddit (needs a subreddit) wait for their own options. */
export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "youtube", "facebook", "twitter", "linkedin", "threads", "bluesky"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const isSocialPlatform = (p: unknown): p is SocialPlatform => typeof p === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(p);

/** A network the person linked, as the provider reports it. */
/** `id` is the provider's account id: several accounts of one network can be linked (two TikToks), so posts, unlinks
 *  and relinks name the account, not only the network. */
export type SocialAccount = { id?: string; platform: string; username: string | null; display_name: string | null; image_url: string | null; profile_url: string | null; refresh_required?: boolean };
/** The outcome on one network. */
export type SocialResult = { platform: string; account_id?: string | null; status: "scheduled" | "posted" | "failed" | "pending"; url: string | null; error: string | null };
export type SocialPostStatus = "sending" | "scheduled" | "posted" | "partial" | "failed" | "canceled";
export type PublishRequest = {
  text: string; platforms: SocialPlatform[]; mediaUrl: string; scheduleAt: Date | null;
  /** the exact linked accounts to post to (provider ids); without it, the first linked account of each network */
  accounts?: string[];
  /** per account: its own time (accounts of one network spaced apart) and its own caption (a group's sign-off, a
   *  reworded caption); wins over `accounts` when given */
  targets?: PostTarget[];
  /** unique per post: a retried request is refused instead of posting twice */
  idempotencyKey?: string;
  /** network options the provider understands: { youtube: { title, visibility }, tiktok: {...}, instagram: {...} } */
  options?: Record<string, any>;
};
/** One account a post goes to, with what is its own. */
export type PostTarget = { accountId: string; platform: string; at?: Date | null; text?: string | null };
/** A change to a post that has not gone out: a new time, a new caption, per-account times and captions. */
export type PostUpdate = { scheduleAt?: Date; text?: string; targets?: PostTarget[]; options?: Record<string, any> };
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
export type SocialWebhook = { kind: "post"; event: SocialEvent } | { kind: "account"; refId: string; platform: string; accountId?: string | null; change: "link" | "unlink" | "refresh"; bySystem: boolean };

/** A post on a linked account, with what the provider reports about it (private analytics where the network shares them). */
export type ProviderPost = {
  platform: string; id: string; url: string | null; caption: string | null; published_at: string | null; thumb_url: string | null; duration_s: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  /** reach, avg_watch_s, full_watch_rate, hold_3s (share of viewers still watching at 3 s), retention [[second, %]], fyp_share,
   *  engaged_views, avg_view_pct, subscribers_gained, follows */
  extra: Record<string, any>;
};
export type ProviderAccountStats = { platform: string; account_id?: string | null; followers: number | null; extra: Record<string, any> };

export class SocialError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface SocialProvider {
  readonly name: "ayrshare" | "zernio";
  /** "page": one hosted page links every network (Ayrshare); "per_network": one link per network (Zernio). */
  readonly linking?: "page" | "per_network";
  /** The networks this provider can post to with the current configuration. */
  offered(): string[];
  /** A provider profile for one person; `title` must be unique per provider account. */
  createProfile(title: string, externalId?: string): Promise<{ profileKey: string; refId: string | null }>;
  deleteProfile(profileKey: string): Promise<void>;
  /** A short-lived link where the person links or unlinks their own networks. */
  /** `add`: link another account of a network already linked (asks the network for a login); `accountId`: relink that
   *  account in place; `only`: at the plan's limit, the networks that may be relinked (nothing new is added). */
  connectUrl(profileKey: string, opts?: { redirect?: string; origin?: string; only?: string[]; platform?: string; engage?: boolean; add?: boolean; accountId?: string }): Promise<{ url: string; expiresInMinutes: number | null }>;
  accounts(profileKey: string): Promise<SocialAccount[]>;
  /** Unlink one account (accountId) or, without it, every account of the network. */
  disconnect(profileKey: string, platform: string, accountId?: string): Promise<void>;
  publish(profileKey: string, req: PublishRequest): Promise<PublishResult>;
  status(profileKey: string, providerPostId: string): Promise<SocialEvent | null>;
  cancel(profileKey: string, providerPostId: string): Promise<void>;
  /** Change a scheduled post in place (time, caption, per-account times). */
  update?(profileKey: string, providerPostId: string, change: PostUpdate): Promise<SocialEvent | null>;
  /** Send again only the accounts that failed (never posts twice where it went out). */
  retry?(profileKey: string, providerPostId: string, targets?: Array<{ platform: string; accountId?: string | null }>): Promise<SocialEvent | null>;
  /** Point the provider's post-status webhook for this profile at our endpoint. */
  registerWebhook(profileKey: string, url: string): Promise<void>;
  /** Read a webhook delivery; null when it is not one we act on. Throws SocialError("webhook_unverified") when it fails verification. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): SocialWebhook | null;
  /** Recent posts on a linked network, including ones published outside Clone8, with their analytics. */
  recentPosts?(profileKey: string, platform: string, limit: number, accountId?: string): Promise<ProviderPost[]>;
  /** Followers and account totals per network. */
  accountStats?(profileKey: string, platforms: string[]): Promise<ProviderAccountStats[]>;
}

export type SocialDeps = { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (s: string) => void };

/** The configured provider, or null when self-serve posting is off (no keys). SOCIAL_PROVIDER=zernio picks Zernio
 *  (owner's decision Nov 21 2026); anything else keeps Ayrshare until the switch is made on Render. */
export function getSocialProvider(deps: SocialDeps = {}): SocialProvider | null {
  const env = deps.env ?? process.env;
  if (env.STUDIO_SOCIAL_ENABLED !== "true") return null;
  return env.SOCIAL_PROVIDER === "zernio" ? zernioProvider({ ...deps, env }) : ayrshareProvider(deps);
}
/** The provider a stored profile was made with, when it is not the current one (to remove it there). */
export function providerNamed(name: string, deps: SocialDeps = {}): SocialProvider | null {
  return name === "zernio" ? zernioProvider(deps) : name === "ayrshare" ? ayrshareProvider(deps) : null;
}
