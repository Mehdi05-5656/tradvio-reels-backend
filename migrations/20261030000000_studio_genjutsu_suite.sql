-- Clone8 Studio: the Genjutsu suite. New tools beside Blueprint and Recast, all run by the same runner against
-- Higgsfield's platform API:
--   swap      replace the person or object in the person's own video with a reference image (object swap)
--   restyle   redraw the person's own video in a Higgsfield style (restyle presets)
--   trend     transfer the motion of one of our driving clips onto the person's character (motion transfer)
--   character make a reusable character image (human or animal) from a prompt or a photo
-- Jobs, credits, leases, completion and failure are unchanged; only the allowed tool names grow.
ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool IN ('blueprint', 'blueprint_plus', 'recast', 'swap', 'restyle', 'trend', 'character'));
