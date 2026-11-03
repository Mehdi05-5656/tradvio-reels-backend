-- Kage Motion: narrated motion-graphics films made by the kage-motion worker. A new tool name so the worker claims only
-- its own jobs (the remix engine claims 'kage'). Nothing else changes: same queue, credits, outputs and notices.
ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool = ANY (ARRAY['blueprint','blueprint_plus','recast','swap','restyle','trend','character','instrument','clips','import','captions','kage','kage_motion']));
