-- Clone8 Studio: the editor and the edit-learning loop, phase 1 (editor thread, Nov 20 2026; plan in
-- docs/editor/PLAN.md at the workspace root).
--
-- Every clip the cutter makes gets a project: the edit file the AI proposed (ai_doc, never changed), the current one
-- (doc, with a revision number), the setting it was made in, and the kept piece of recording it can be re-rendered from.
-- Edits and what happens to each clip are recorded so first cuts can learn from them. Phase 1 only writes projects
-- (behind STUDIO_EDITOR_ENABLED); revisions, edit events and remembered choices are written from phase 2 on.
--
-- Service role only, like every Studio table: RLS on with no policies. Additive: no existing table, function, trigger
-- or row is touched. Undo: DROP VIEW public.studio_clip_outcomes; DROP TABLE public.studio_edit_prefs,
-- public.studio_edit_events, public.studio_project_revs, public.studio_projects;
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- the clip in the library (no foreign key: a deleted clip leaves its project, which is how a delete is seen)
  asset_id uuid,
  job_id uuid,
  collection_id uuid,
  tool text NOT NULL CHECK (tool IN ('clips', 'live_clips', 'captions', 'splitscreen', 'editor')),
  -- the version of the rules that made the first cut (learning data is grouped by it)
  auto_edit text NOT NULL,
  setting text CHECK (setting IS NULL OR setting IN ('desktop_cam', 'desktop_nocam', 'irl', 'talking_head', 'podcast',
    'reaction', 'screen_share', 'produced', 'other')),
  setting_by text NOT NULL DEFAULT 'ai' CHECK (setting_by IN ('ai', 'user')),
  setting_sure numeric(4, 3) CHECK (setting_sure IS NULL OR (setting_sure >= 0 AND setting_sure <= 1)),
  -- the channel or video the clip came from ("twitch:<channel id>", "kick:<login>", "youtube:<video id>"): channel layouts are shared by it
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 3 AND 120),
  ai_doc jsonb NOT NULL,
  doc jsonb NOT NULL,
  rev integer NOT NULL DEFAULT 1 CHECK (rev >= 1),
  rendered_rev integer NOT NULL DEFAULT 1,
  -- the kept recording (studio-outputs) and when it may go; null when none was kept
  source_key text,
  source_bytes bigint,
  source_expires_at timestamptz,
  preview_key text,
  opened_on text CHECK (opened_on IS NULL OR opened_on IN ('web', 'web_phone', 'ios', 'mac')),
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_projects_asset ON public.studio_projects (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_projects_user ON public.studio_projects (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_projects_source ON public.studio_projects (source_ref, created_at DESC) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_projects_job ON public.studio_projects (job_id);
ALTER TABLE public.studio_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_projects FROM anon, authenticated;

-- the last saved versions of a project, so undo survives a reload and a change of device (pruned to 20 a project)
CREATE TABLE IF NOT EXISTS public.studio_project_revs (
  project_id uuid NOT NULL REFERENCES public.studio_projects(id) ON DELETE CASCADE,
  rev integer NOT NULL,
  doc jsonb NOT NULL,
  device text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, rev)
);
ALTER TABLE public.studio_project_revs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_project_revs FROM anon, authenticated;

-- one row per change a person (or the editor's assistant on their behalf) makes; append-only
CREATE TABLE IF NOT EXISTS public.studio_edit_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.studio_projects(id) ON DELETE CASCADE,
  session text,
  device text CHECK (device IS NULL OR device IN ('web', 'web_phone', 'ios', 'mac')),
  surface text CHECK (surface IS NULL OR surface IN ('card', 'quick', 'editor', 'batch', 'assistant')),
  op text NOT NULL CHECK (op ~ '^[a-z_]+(\.[a-z_]+)*$' AND length(op) <= 60),
  from_value jsonb,
  to_value jsonb,
  at_s numeric(10, 3),
  rev integer,
  ctx jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS studio_edit_events_project ON public.studio_edit_events (project_id, id);
CREATE INDEX IF NOT EXISTS studio_edit_events_user ON public.studio_edit_events (user_id, created_at DESC);
ALTER TABLE public.studio_edit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_edit_events FROM anon, authenticated;

-- remembered choices: a person's own (user, user+channel, user+setting) and a channel's layout shared by everyone (channel)
CREATE TABLE IF NOT EXISTS public.studio_edit_prefs (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('user', 'user_channel', 'user_setting', 'channel')),
  user_id uuid,
  channel text,
  setting text,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  value jsonb NOT NULL,
  n integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'channel') = (user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_edit_prefs_one ON public.studio_edit_prefs
  (scope, coalesce(user_id::text, ''), coalesce(channel, ''), coalesce(setting, ''), key);
ALTER TABLE public.studio_edit_prefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_edit_prefs FROM anon, authenticated;

-- what happened to each clip, worked out from what is already recorded (no second copy to keep in step): downloads are
-- studio_events 'clip_download' rows, posts are studio_social_posts rows, edits are studio_edit_events rows, a delete is
-- the library row gone. "accepted_as_made" = downloaded or posted with no edit; a clip nobody downloaded or posted is
-- unknown, never accepted.
CREATE OR REPLACE VIEW public.studio_clip_outcomes AS
SELECT p.id AS project_id, p.user_id, p.asset_id, p.job_id, p.tool, p.setting, p.setting_by, p.auto_edit, p.source_ref,
  p.created_at AS ready_at,
  d.first_download_at, d.downloads,
  s.first_post_at, s.posts,
  e.first_edit_at, coalesce(e.edits, 0) AS edits, e.ops AS edit_ops,
  (a.id IS NULL) AS deleted,
  (coalesce(e.edits, 0) = 0 AND (d.downloads > 0 OR s.posts > 0)) AS accepted_as_made,
  p.rev, p.rendered_rev
FROM public.studio_projects p
LEFT JOIN public.studio_assets a ON a.id = p.asset_id
LEFT JOIN LATERAL (
  SELECT min(ev.created_at) AS first_download_at, count(*)::int AS downloads FROM public.studio_events ev
  WHERE ev.kind = 'feature' AND ev.name = 'clip_download' AND ev.user_id = p.user_id AND ev.props->>'asset_id' = p.asset_id::text
) d ON true
LEFT JOIN LATERAL (
  SELECT min(sp.created_at) AS first_post_at, count(*)::int AS posts FROM public.studio_social_posts sp
  WHERE sp.asset_id = p.asset_id AND sp.user_id = p.user_id AND sp.status <> 'canceled'
) s ON true
LEFT JOIN LATERAL (
  SELECT min(x.created_at) AS first_edit_at, count(*)::int AS edits, array_agg(DISTINCT x.op) AS ops FROM public.studio_edit_events x
  WHERE x.project_id = p.id AND x.op NOT IN ('undo', 'redo')
) e ON true;
REVOKE ALL ON public.studio_clip_outcomes FROM anon, authenticated;

COMMIT;
