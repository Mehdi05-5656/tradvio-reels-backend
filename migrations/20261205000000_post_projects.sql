-- Projects on the Post page (docs/publishing/PROJECTS_PLAN.md; owner, Nov 23 2026): a name and a colour, the accounts
-- and groups it posts to, its own board (the composer's state, like the tray) and a Library folder. Posts sent from a
-- project carry its id, so its Up next and Posted show only its own.
CREATE TABLE IF NOT EXISTS public.studio_post_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color text NOT NULL DEFAULT 'teal',
  account_ids text[] NOT NULL DEFAULT '{}',
  group_ids uuid[] NOT NULL DEFAULT '{}',
  collection_id uuid REFERENCES public.studio_collections(id) ON DELETE SET NULL,
  tray jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(tray) <= 512000),
  video_count integer NOT NULL DEFAULT 0, -- videos on its board (the list shows it without reading the boards)
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_post_projects_user ON public.studio_post_projects (user_id, position);
ALTER TABLE public.studio_post_projects ENABLE ROW LEVEL SECURITY; -- service role only (the backend)

ALTER TABLE public.studio_social_posts ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.studio_post_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS studio_social_posts_project ON public.studio_social_posts (project_id) WHERE project_id IS NOT NULL;
