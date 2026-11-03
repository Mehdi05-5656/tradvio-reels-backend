-- Kage: the reference remix (a video in the visual language of a reference clip, with the person's own hero in it).
-- One more tool on the jobs queue; the plan, shots and plates live in the job's progress and in studio-outputs, so
-- nothing else changes. Switched on by STUDIO_KAGE_ENABLED=true on the backend.
BEGIN;

ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool = ANY (ARRAY['blueprint','blueprint_plus','recast','swap','restyle','trend','character','instrument','clips','import','captions','kage']));

COMMIT;
