-- Clone8 Studio: posting groups, posts sent in the background, drafts and the post tray (docs/publishing/PLAN.md,
-- phase 1 + 1b; owner, Nov 22 2026). Additive only: every column is nullable or defaulted, and the code reads these
-- tables only where they exist.
BEGIN;

-- A named set of linked accounts ("Group A" = Instagram A + TikTok A) people post to by name. Account ids are the
-- posting provider's; a group is resolved to its accounts when a post is sent, so editing a group never moves posts.
CREATE TABLE IF NOT EXISTS public.studio_social_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  color text NOT NULL DEFAULT 'teal' CHECK (length(color) <= 20),
  icon text CHECK (icon IS NULL OR length(icon) <= 16),
  account_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(account_ids) <= 100),
  -- what posting to the group brings along: queue times, caption extras, stagger, auto-reply, network options
  defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_social_groups_name ON public.studio_social_groups (user_id, lower(btrim(name)));
ALTER TABLE public.studio_social_groups ENABLE ROW LEVEL SECURITY;

-- Posts: which send they came from (one send can make many rows) and the group they went out through.
ALTER TABLE public.studio_social_posts ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE public.studio_social_posts ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.studio_social_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS studio_social_posts_batch ON public.studio_social_posts (batch_id) WHERE batch_id IS NOT NULL;
-- 'queued': saved, waiting for the background sender (a big batch returns at once and goes out in order)
CREATE INDEX IF NOT EXISTS studio_social_posts_queued ON public.studio_social_posts (created_at) WHERE status = 'queued';
ALTER TABLE public.studio_social_posts DROP CONSTRAINT IF EXISTS studio_social_posts_status_check;
ALTER TABLE public.studio_social_posts ADD CONSTRAINT studio_social_posts_status_check
  CHECK (status IN ('queued', 'sending', 'scheduled', 'posted', 'partial', 'failed', 'canceled'));

-- Drafts and the post tray: what someone is putting together, kept across pages and devices. One tray per person.
CREATE TABLE IF NOT EXISTS public.studio_post_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'draft' CHECK (kind IN ('draft', 'tray')),
  title text CHECK (title IS NULL OR length(title) <= 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 512000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_post_drafts_tray ON public.studio_post_drafts (user_id) WHERE kind = 'tray';
CREATE INDEX IF NOT EXISTS studio_post_drafts_user ON public.studio_post_drafts (user_id, updated_at DESC);
ALTER TABLE public.studio_post_drafts ENABLE ROW LEVEL SECURITY;

COMMIT;
