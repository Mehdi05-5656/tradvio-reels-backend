-- Clone8 Studio: self-serve social posting. Each person links their own TikTok, Instagram, YouTube and so on through the
-- social provider (Ayrshare today) and posts or schedules their Studio outputs. This is separate from the managed
-- service, which keeps posting through Publer; nothing here touches the Publer tables.
-- Service role only, like every Studio table: the provider's per-person key never leaves the server.
BEGIN;

-- One provider profile per person. profile_key is the provider's credential for that person's linked accounts.
CREATE TABLE IF NOT EXISTS public.studio_social_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'ayrshare' CHECK (provider IN ('ayrshare')),
  profile_key text NOT NULL,
  ref_id text,
  title text NOT NULL,
  -- the last known linked networks, [{platform, username, display_name, image_url, profile_url}], refreshed on read
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  webhook_registered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_social_profiles ENABLE ROW LEVEL SECURITY;

-- One row per post request: one video to one or more networks, now or at schedule_at.
CREATE TABLE IF NOT EXISTS public.studio_social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'ayrshare',
  provider_post_id text,
  -- the video: a Studio output (job + key in studio-outputs) or one of the person's uploads (asset)
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  output_key text,
  asset_id uuid REFERENCES public.studio_assets(id) ON DELETE SET NULL,
  -- the chat that offered it, when it came from a publish card
  conversation_id uuid REFERENCES public.studio_conversations(id) ON DELETE SET NULL,
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 5000),
  platforms text[] NOT NULL CHECK (cardinality(platforms) BETWEEN 1 AND 10),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule_at timestamptz,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'scheduled', 'posted', 'partial', 'failed', 'canceled')),
  -- per network: [{platform, status, url, error}]
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (output_key IS NOT NULL OR asset_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS studio_social_posts_user ON public.studio_social_posts(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS studio_social_posts_provider_id ON public.studio_social_posts(provider, provider_post_id) WHERE provider_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_social_posts_open ON public.studio_social_posts(schedule_at) WHERE status IN ('sending', 'scheduled');
ALTER TABLE public.studio_social_posts ENABLE ROW LEVEL SECURITY;

-- What the person told the assistant about posting: "not now" to linking, so the offer does not come back every run.
CREATE TABLE IF NOT EXISTS public.studio_social_prefs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  connect_dismissed_at timestamptz,
  connect_dismissals integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_social_prefs ENABLE ROW LEVEL SECURITY;

COMMIT;
