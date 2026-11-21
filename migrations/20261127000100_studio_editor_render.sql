-- Clone8 Studio: the editor, phase 2 (editor thread, Nov 20 2026). A project can be re-rendered from its kept
-- recording after a person edits it, and gets a small browser preview of that recording on first open.
-- Additive: new columns on the editor's own table only. Undo: ALTER TABLE public.studio_projects DROP COLUMN ... (each below).
BEGIN;
ALTER TABLE public.studio_projects
  ADD COLUMN IF NOT EXISTS render_state text NOT NULL DEFAULT 'idle' CHECK (render_state IN ('idle', 'queued', 'rendering', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS render_error text,
  ADD COLUMN IF NOT EXISTS render_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS rendered_at timestamptz,
  -- the fair-use cap: renders counted per project per UTC day
  ADD COLUMN IF NOT EXISTS render_day date,
  ADD COLUMN IF NOT EXISTS render_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preview_state text NOT NULL DEFAULT 'none' CHECK (preview_state IN ('none', 'making', 'ready', 'failed'));
CREATE INDEX IF NOT EXISTS studio_projects_render_queue ON public.studio_projects (render_requested_at) WHERE render_state IN ('queued', 'rendering');
COMMIT;
