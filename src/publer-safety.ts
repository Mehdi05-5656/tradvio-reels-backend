export type PublishResolution =
  | { outcome: "published"; postId: string; postLink: string | null }
  | { outcome: "failed" | "unknown"; error?: string };

export function parsePublishResult(payload: any, accountId: string): PublishResolution {
  if (payload?.failures && Object.keys(payload.failures).length) {
    return { outcome: "failed", error: JSON.stringify(payload.failures).slice(0, 800) };
  }
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : [];
  const posts = entries
    .map((entry: any) => entry?.post ?? entry)
    .filter((candidate: any) => candidate?.id && candidate?.account_id === accountId);
  if (posts.length !== 1) return { outcome: "unknown" };
  const post = posts[0];
  if (post.state === "failed") return { outcome: "failed", error: String(post.error || "Provider rejected post") };
  if (post.error) return { outcome: "unknown", error: String(post.error) };
  if (post.state !== "published") return { outcome: "unknown" };
  return {
    outcome: "published",
    postId: String(post.id),
    postLink: post.post_link || post.short_link || post.link || null,
  };
}

export type RetryDecision = { action: "retry" | "quarantine" | "hold"; delayMs: number };

function isRejectedBusyUpload(error: string): boolean {
  // Publer also uses 403 for its upload-concurrency limit. Exempt only the
  // observed response from this exact pre-submission endpoint, not all 403s.
  // The retry prefix is persisted by our existing failure/backoff path.
  const match = /^(?:retry: )?publer POST \/media\/from-url -> 403: (\{[^\r\n]*\})$/.exec(error);
  if (!match) return false;
  try {
    const body = JSON.parse(match[1]);
    return Object.keys(body).length === 1 &&
      Array.isArray(body.errors) && body.errors.length === 1 &&
      body.errors[0] === "Please wait until your other download media from URL jobs have finished";
  } catch {
    return false;
  }
}

export function retryDecision(attempt: number, error: string, submissionUncertain: boolean): RetryDecision {
  if (submissionUncertain) return { action: "hold", delayMs: 0 };
  if (isRejectedBusyUpload(error)) {
    return attempt >= 5 ? { action: "hold", delayMs: 0 } :
      { action: "retry", delayMs: Math.min(60, 15 * Math.max(1, attempt)) * 60_000 };
  }
  const s = error.toLowerCase();
  const authOrConfig = /\b(401|403)\b|api key|workspace|account.+not found|permission/.test(s);
  if (authOrConfig) return { action: "hold", delayMs: 0 };
  const media = /smaller than|larger than|unsupported|invalid (media|video)|codec|duration|aspect ratio|resolution|media processing/.test(s);
  if (media && attempt >= 3) return { action: "quarantine", delayMs: 0 };
  if (!media && attempt >= 5) return { action: "hold", delayMs: 0 };
  return { action: "retry", delayMs: Math.min(60, 15 * Math.max(1, attempt)) * 60_000 };
}

export function chooseTimelineLog<T extends { status: string; attempted_at?: string }>(logs: T[]): T | undefined {
  const rank = (status: string) => status === "published" ? 3 : status === "pending" ? 2 : 1;
  return [...logs].sort((a, b) =>
    rank(b.status) - rank(a.status) ||
    String(b.attempted_at || "").localeCompare(String(a.attempted_at || ""))
  )[0];
}
