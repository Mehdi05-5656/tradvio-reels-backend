-- clone8.io/apply: qualification answers from the Meta-ads application page, stored on invite_requests.
--   content_status  do they already have published short-form videos: yes | some | not_yet
--   library_size    roughly how many existing videos: under_25 | 25_100 | 100_500 | 500_plus
--   objective       what they want from distribution: reach | awareness | distribution | other
--   phone           optional, only if they asked for a callback; never sent to Meta (see src/meta-capi.ts)
--   attribution     campaign parameters from the link that brought them (utm_*, landing path); no personal data
-- The source column already exists: 'clone8.io' (homepage invite form) or 'clone8.io/apply' (this page).
-- Additive, idempotent, no data touched. Service role only, like the table. Retention (24 months) deletes
-- whole rows, so these columns need no separate clean-up.
BEGIN;
ALTER TABLE public.invite_requests
  ADD COLUMN IF NOT EXISTS content_status text CHECK (content_status IS NULL OR content_status IN ('yes','some','not_yet')),
  ADD COLUMN IF NOT EXISTS library_size text CHECK (library_size IS NULL OR library_size IN ('under_25','25_100','100_500','500_plus')),
  ADD COLUMN IF NOT EXISTS objective text CHECK (objective IS NULL OR objective IN ('reach','awareness','distribution','other')),
  ADD COLUMN IF NOT EXISTS phone text CHECK (phone IS NULL OR length(phone) BETWEEN 5 AND 40),
  ADD COLUMN IF NOT EXISTS attribution jsonb CHECK (attribution IS NULL OR (jsonb_typeof(attribution) = 'object' AND length(attribution::text) <= 2000));
COMMIT;
