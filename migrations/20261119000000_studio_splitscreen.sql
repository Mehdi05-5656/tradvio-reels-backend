-- Clone8 Studio Split screen: the "splitscreen" job type (a person's clip over a gameplay loop).
-- The allowed-tool list is restated in full, as read from the live database on Nov 12 2026, with 'splitscreen' added.
-- One statement, so the rule is never absent: the old rule goes and the wider one arrives together. No rows change;
-- every existing job's tool is in the new list, so the check passes on the table as it stands.
-- To undo (only while no splitscreen job exists): the same statement without 'splitscreen'.
ALTER TABLE public.studio_jobs
  DROP CONSTRAINT studio_jobs_tool_check,
  ADD CONSTRAINT studio_jobs_tool_check
    CHECK (tool = ANY (ARRAY['blueprint','blueprint_plus','recast','swap','restyle','trend','character','instrument','clips','import','captions','kage','kage_motion','longform','stunts','splitscreen']));
