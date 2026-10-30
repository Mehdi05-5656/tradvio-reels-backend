-- Clone8 Studio: performance of the person's own linked accounts. Their posts (made with Clone8 or not) with public
-- metrics and, where the posting provider reports them, deeper ones; a daily snapshot per account for growth; and the
-- AI overview written from those numbers. Service role only, like every Studio table.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_perf_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  platform_post_id text NOT NULL,
  url text NOT NULL,
  caption text,
  published_at timestamptz,
  duration_s numeric,
  thumb_key text,
  views bigint, likes bigint, comments bigint, shares bigint, saves bigint,
  -- from the posting provider when it reports them (reach, average watch time in seconds, ...)
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- made in Clone8 and posted through Publish
  social_post_id uuid REFERENCES public.studio_social_posts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  -- brought into the library to remix (set the first time the person does)
  asset_id uuid REFERENCES public.studio_assets(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, platform_post_id)
);
CREATE INDEX IF NOT EXISTS studio_perf_posts_user ON public.studio_perf_posts(user_id, published_at DESC);
ALTER TABLE public.studio_perf_posts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.studio_perf_accounts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  handle text NOT NULL,
  followers bigint,
  avatar_key text,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  error text,
  PRIMARY KEY (user_id, platform)
);
ALTER TABLE public.studio_perf_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.studio_perf_snapshots (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  day date NOT NULL,
  followers bigint,
  views_total bigint,
  posts integer,
  PRIMARY KEY (user_id, platform, day)
);
ALTER TABLE public.studio_perf_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.studio_perf_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'all',
  range_days integer NOT NULL DEFAULT 28,
  input_hash text NOT NULL,
  body jsonb NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_perf_insights_user ON public.studio_perf_insights(user_id, created_at DESC);
ALTER TABLE public.studio_perf_insights ENABLE ROW LEVEL SECURITY;

-- when the person last opened the dashboard: only they get the daily background refresh (it costs a few lookups)
ALTER TABLE public.studio_social_profiles ADD COLUMN IF NOT EXISTS perf_viewed_at timestamptz;
ALTER TABLE public.studio_social_profiles ADD COLUMN IF NOT EXISTS timezone text;

COMMIT;
