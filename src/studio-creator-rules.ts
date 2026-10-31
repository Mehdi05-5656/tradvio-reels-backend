// Clone8 Studio: the Creator Program's rules, in one place (the program, its checks and the Earn page read them).
// Modelled on Higgsfield Earn (creators.higgsfield.ai/terms and its Platform Creator Agreement, read Oct 31 2026): organic
// views only, a disclosure tag on every video (theirs is #higgsfieldpartner), videos kept public 90 days, one appeal per
// rejection, clawback within 12 months when over 15% of views prove non-organic, 18+. The per-video minimum and the
// monthly minimum payout follow comparable pay-per-view funds (AKOOL, Whop content rewards).
export const RULES = {
  terms_version: "2026-10-31",
  cpm_usd: 1,
  view_cap: 1_000_000,
  view_window_days: 30,
  // a video earns once it passes this many views (then every view up to the cap counts)
  min_views: 1_000,
  min_payout_usd: 50,
  min_age: 18,
  disclosure_tag: "#clone8partner",
  keep_live_days: 90,
  clawback_months: 12,
  clawback_share: 0.15,
  platforms: ["tiktok", "instagram"] as const,
  bio_phrase: "powered by @clone8.io",
  // the bio check accepts the handle or the domain, any case, with or without the "powered by"
  bio_match: /@?clone8(\.io)?/i,
  // a video's views are re-read for this long after posting (a little past the window so late counts settle)
  sync_days: 35,
};
