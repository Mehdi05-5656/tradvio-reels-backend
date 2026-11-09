-- Clone8 Films (long form): the "longform" tool. The allowed-tool list is restated in full (earlier migrations are not
-- in commit order: 20261111/20261112 predate kage and kage_motion, so a replay by filename would drop them).
BEGIN;
ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool = ANY (ARRAY['blueprint','blueprint_plus','recast','swap','restyle','trend','character','instrument','clips','import','captions','kage','kage_motion','longform']));
COMMIT;
