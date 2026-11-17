-- Clone8 Studio Blueprint versions: the "blueprint_versions" job type (openings x looks of a person's own video,
-- rendered by the Blueprint worker). Nothing else changes: studio_claim already takes any tool name.
-- The allowed-tool list is restated in full, as read from the live database on Nov 16 2026, with 'blueprint_versions'
-- added. One statement, so the rule is never absent. No rows change; every existing job's tool is in the new list.
-- To undo (only while no blueprint_versions job exists): the same statement without 'blueprint_versions'.
ALTER TABLE public.studio_jobs
  DROP CONSTRAINT studio_jobs_tool_check,
  ADD CONSTRAINT studio_jobs_tool_check
    CHECK (tool = ANY (ARRAY['blueprint','blueprint_plus','recast','swap','restyle','trend','character','instrument','clips','import','captions','kage','kage_motion','longform','stunts','splitscreen','reshoot','blueprint_versions']));
