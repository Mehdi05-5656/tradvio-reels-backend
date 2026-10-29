-- Clone8 Studio: Instruments. Every Higgsfield platform model offered through one generic tool, `instrument`;
-- the model and its parameters live in the job's options (endpoint, params, inputs, usd, priced_by). Jobs,
-- credits, leases, completion and failure are unchanged; only the allowed tool names grow.
ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool IN ('blueprint', 'blueprint_plus', 'recast', 'swap', 'restyle', 'trend', 'character', 'instrument'));
