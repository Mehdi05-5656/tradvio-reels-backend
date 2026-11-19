-- Clone8 Studio: content performance (owner's thread, Nov 18 2026). The organic accounts that post for Clone8, their
-- videos, hourly public-metric snapshots, and what each video brought. Read by the admin panel's Content tab only.
--
-- The owner's rule: counting starts at our first snapshot. Every video keeps its first reading as a baseline and every
-- number shown is latest minus baseline; an account carries tracking_since; a video posted before that is kept but marked
-- pre_tracking and left out of totals by default.
--
-- Service role only, like every Studio table: RLS on with no policies. Additive: no existing table, function or row is
-- touched. Undo: DROP TABLE public.content_snapshots, public.content_account_snapshots, public.content_videos,
-- public.content_accounts;
BEGIN;

CREATE TABLE IF NOT EXISTS public.content_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  handle text NOT NULL CHECK (handle ~ '^[A-Za-z0-9._-]{1,64}$'),
  url text,
  display_name text,
  owner_kind text NOT NULL DEFAULT 'creator' CHECK (owner_kind IN ('ours', 'creator')),
  cost_usd_per_video numeric(10, 2) CHECK (cost_usd_per_video IS NULL OR cost_usd_per_video >= 0),
  cost_usd_per_month numeric(10, 2) CHECK (cost_usd_per_month IS NULL OR cost_usd_per_month >= 0),
  default_feature text CHECK (default_feature IS NULL OR length(default_feature) BETWEEN 1 AND 40),
  enabled boolean NOT NULL DEFAULT true,
  tracking_since timestamptz,                 -- set at the first successful pull; never moved earlier
  followers bigint,
  avatar_key text,
  latest_posted_at timestamptz,               -- newest public video seen; decides the hourly / 4-hourly cadence
  last_pulled_at timestamptz,
  last_profile_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);
ALTER TABLE public.content_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_accounts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.content_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.content_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL,
  platform_post_id text NOT NULL,
  url text NOT NULL,
  caption text,
  posted_at timestamptz,
  duration_s numeric,
  thumb_key text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  pre_tracking boolean NOT NULL DEFAULT false,  -- posted before the account's tracking_since
  -- the first reading (the baseline every gain is measured from) and the latest one
  base_views bigint, base_likes bigint, base_comments bigint, base_shares bigint, base_saves bigint,
  views bigint, likes bigint, comments bigint, shares bigint, saves bigint,
  latest_at timestamptz,
  -- what the video markets and how it is made: the model's tags, the registry's, or the owner's (owner wins)
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  tag_source text CHECK (tag_source IS NULL OR tag_source IN ('model', 'registry', 'owner', 'account')),
  tag_usd numeric(12, 6),
  cost_usd numeric(10, 2) CHECK (cost_usd IS NULL OR cost_usd >= 0),   -- this video's own cost, over the account's rate
  variant_of uuid REFERENCES public.content_videos(id) ON DELETE SET NULL,
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_post_id)
);
CREATE INDEX IF NOT EXISTS content_videos_account ON public.content_videos(account_id, posted_at DESC);
ALTER TABLE public.content_videos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_videos FROM anon, authenticated;

-- one row per reading in which a number changed (unchanged readings are not written)
CREATE TABLE IF NOT EXISTS public.content_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES public.content_videos(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  views bigint, likes bigint, comments bigint, shares bigint, saves bigint
);
CREATE INDEX IF NOT EXISTS content_snapshots_video_time ON public.content_snapshots(video_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS content_snapshots_time ON public.content_snapshots(captured_at DESC);
ALTER TABLE public.content_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_snapshots FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.content_account_snapshots (
  account_id uuid NOT NULL REFERENCES public.content_accounts(id) ON DELETE CASCADE,
  day date NOT NULL,
  followers bigint,
  videos integer,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);
ALTER TABLE public.content_account_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_account_snapshots FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.content_accounts, public.content_videos, public.content_snapshots, public.content_account_snapshots TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.content_snapshots_id_seq TO service_role;

COMMIT;
