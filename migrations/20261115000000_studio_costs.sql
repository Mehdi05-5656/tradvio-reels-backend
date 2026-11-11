-- Clone8 Studio: the cost ledger. One row for every paid thing done on Clone8's behalf, by any service (the backend,
-- the Kage/Stories worker, the Films worker): who was paid, for which product, which step of the work asked for it,
-- how much was used, what it cost in US dollars, and how sure that figure is. The owner's rule (Nov 11 2026): track
-- every cost as close to the cent as we can, and where it comes from.
--
-- basis: 'metered'   the vendor reported the usage (token counts, credits) and the unit price is the published one
--        'list'      a fixed published price per call
--        'estimated' units counted by us, or a unit price that depends on a plan (a share of a monthly bill)
--        'invoice'   entered from the vendor's own bill (monthly fixed costs, corrections)
-- Rows are written with the service role only. RLS is on with no policies, so nothing reaches the table with the anon
-- or a user's key: what Clone8 pays is never visible to the people using it.
-- Additive: no existing table, function or row is touched. Undo: DROP TABLE public.studio_costs;
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_costs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spent_at timestamptz NOT NULL DEFAULT now(),        -- when the paid call happened
  created_at timestamptz NOT NULL DEFAULT now(),      -- when the row was written
  job_id uuid,                                        -- the Studio job it belongs to, when there is one
  user_id uuid,                                       -- the person the work was for, when there is one
  tool text CHECK (tool IS NULL OR length(tool) BETWEEN 1 AND 40),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),   -- anthropic, elevenlabs, higgsfield, aws, render…
  product text NOT NULL CHECK (length(product) BETWEEN 1 AND 120),    -- the model or endpoint
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),      -- the step that asked: plan, scene, voice, render…
  units jsonb NOT NULL DEFAULT '{}'::jsonb,                           -- tokens, credits, characters, seconds, calls
  usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (usd >= 0),
  basis text NOT NULL CHECK (basis IN ('metered', 'list', 'estimated', 'invoice')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  writer text NOT NULL DEFAULT 'backend' CHECK (length(writer) BETWEEN 1 AND 40),  -- which service wrote the row
  ref text CHECK (ref IS NULL OR length(ref) <= 120)                               -- the job's attempt, a run id, an invoice number
);
CREATE INDEX IF NOT EXISTS studio_costs_spent ON public.studio_costs (spent_at DESC);
CREATE INDEX IF NOT EXISTS studio_costs_job ON public.studio_costs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_costs_provider_spent ON public.studio_costs (provider, spent_at DESC);
CREATE INDEX IF NOT EXISTS studio_costs_tool_spent ON public.studio_costs (tool, spent_at DESC) WHERE tool IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_costs_user_spent ON public.studio_costs (user_id, spent_at DESC) WHERE user_id IS NOT NULL;

ALTER TABLE public.studio_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_costs FROM anon, authenticated;

COMMIT;
