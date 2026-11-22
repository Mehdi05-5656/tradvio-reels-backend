-- Clone8 Studio: posting profiles are removed when unused, and Zernio joins as the posting provider (owner, Nov 21 2026;
-- src/studio-social-upkeep.ts, src/social-zernio.ts).
-- Additive only. The code works before this is applied (it then reads use from posts, stats views and the profile's
-- creation only, and shows no "why it was unlinked" note).
BEGIN;

-- The last time the person used posting: pressed Connect, posted or scheduled, canceled, unlinked or relinked,
-- drafted a caption. Together with perf_viewed_at and the posts it decides when an idle profile is removed.
ALTER TABLE public.studio_social_profiles ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

-- Why a person's profile was removed, so the Publish page can say so (shown for 30 days, until they connect again).
ALTER TABLE public.studio_social_prefs ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
ALTER TABLE public.studio_social_prefs ADD COLUMN IF NOT EXISTS cleared_reason text
  CHECK (cleared_reason IS NULL OR cleared_reason IN ('never_linked', 'idle', 'no_plan', 'plan_ended', 'provider_moved'));

-- Zernio replaces Ayrshare (owner, Nov 21 2026): a profile may be made with either while people move over.
ALTER TABLE public.studio_social_profiles DROP CONSTRAINT IF EXISTS studio_social_profiles_provider_check;
ALTER TABLE public.studio_social_profiles ADD CONSTRAINT studio_social_profiles_provider_check CHECK (provider IN ('ayrshare', 'zernio'));

COMMIT;
