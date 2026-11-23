-- Performance for every linked account, and what learning needs (docs/publishing/AI_CAPTIONS_PLAN.md; owner, Nov 22
-- 2026: "any account(s) connected, display content properly").
--   - Two accounts of one network (two TikToks) each get their own row: account_key (the provider's account id, or
--     the handle for older rows) joins the keys of studio_perf_accounts and studio_perf_snapshots.
--   - studio_perf_post_snapshots: each post's numbers at fixed ages (24 h, 3 d, 10 d), so posts are compared at the same
--     age (studio_perf_posts is overwritten on every refresh).
--   - studio_perf_posts.features: what is in the video (hook, face, on-screen text, format...), read by a model, for
--     "what's working" on every post, made in Clone8 or not.
BEGIN;

ALTER TABLE public.studio_perf_posts ADD COLUMN IF NOT EXISTS account_key text;
ALTER TABLE public.studio_perf_posts ADD COLUMN IF NOT EXISTS features jsonb;
ALTER TABLE public.studio_perf_posts ADD COLUMN IF NOT EXISTS features_at timestamptz;

ALTER TABLE public.studio_perf_accounts ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT '';
ALTER TABLE public.studio_perf_accounts DROP CONSTRAINT IF EXISTS studio_perf_accounts_pkey;
ALTER TABLE public.studio_perf_accounts ADD PRIMARY KEY (user_id, platform, account_key);

ALTER TABLE public.studio_perf_snapshots ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT '';
ALTER TABLE public.studio_perf_snapshots DROP CONSTRAINT IF EXISTS studio_perf_snapshots_pkey;
ALTER TABLE public.studio_perf_snapshots ADD PRIMARY KEY (user_id, platform, account_key, day);

CREATE TABLE IF NOT EXISTS public.studio_perf_post_snapshots (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  platform_post_id text NOT NULL,
  age text NOT NULL CHECK (age IN ('24h', '3d', '10d')),
  taken_at timestamptz NOT NULL DEFAULT now(),
  age_hours numeric,
  views bigint, likes bigint, comments bigint, shares bigint, saves bigint,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, platform, platform_post_id, age)
);
ALTER TABLE public.studio_perf_post_snapshots ENABLE ROW LEVEL SECURITY;

-- Rows read before this change belong to the one linked account of their network: give them its key (the provider's
-- account id, as refreshPerformance writes it), so they are not shown twice beside the rows the new code writes.
-- Networks with no linked account, or more than one, are left as they are.
WITH one AS (
  SELECT p.user_id, acc->>'platform' AS platform, min(acc->>'id') AS id
  FROM public.studio_social_profiles p, jsonb_array_elements(p.accounts) acc
  WHERE acc->>'id' IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) = 1
)
UPDATE public.studio_perf_accounts a SET account_key = one.id FROM one WHERE a.user_id = one.user_id AND a.platform = one.platform AND a.account_key = '';
WITH one AS (
  SELECT p.user_id, acc->>'platform' AS platform, min(acc->>'id') AS id
  FROM public.studio_social_profiles p, jsonb_array_elements(p.accounts) acc
  WHERE acc->>'id' IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) = 1
)
UPDATE public.studio_perf_snapshots s SET account_key = one.id FROM one WHERE s.user_id = one.user_id AND s.platform = one.platform AND s.account_key = '';
WITH one AS (
  SELECT p.user_id, acc->>'platform' AS platform, min(acc->>'id') AS id
  FROM public.studio_social_profiles p, jsonb_array_elements(p.accounts) acc
  WHERE acc->>'id' IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) = 1
)
UPDATE public.studio_perf_posts x SET account_key = one.id FROM one WHERE x.user_id = one.user_id AND x.platform = one.platform AND x.account_key IS NULL;

COMMIT;
