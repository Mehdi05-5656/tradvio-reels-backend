-- Clone8 Studio: Signature written by the person's own AI (docs/mcp/PLAN.md, step 3). Where the person's chat (through
-- the Clone8 connector, src/studio-byo.ts) and the worker that makes the film (kage-motion worker/hand-byo.ts) meet:
--   kind 'brief'   the worker posts the brief once (the rules, the kit, the example film)
--   kind 'message' the worker posts each round's opening (the film's script; later the lines to repair, with strips)
--   kind 'call'    the backend posts a tool call from the chat (write_scene, edit_scene, typecheck, render_stills,
--                  render_preview, finish), 'pending'; the worker takes it ('running') and answers it ('done', result:
--                  { text, image: a storage key in studio-outputs }); delivered_at is when the chat was given it.
-- Rows are written with the service role only. RLS is on with no policies: nothing reaches the table with the anon or a
-- user's key (the backend checks that the job is the signed-in person's own before reading or writing a row).
-- Additive: no existing table, function or row is touched. Undo: DROP TABLE public.studio_byo_calls;
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_byo_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.studio_jobs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('brief', 'message', 'call')),
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 40),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  done_at timestamptz,
  delivered_at timestamptz
);
-- the worker's and the backend's reads: a job's rows by kind and state, oldest first
CREATE INDEX IF NOT EXISTS studio_byo_calls_job ON public.studio_byo_calls (job_id, kind, status, id);
CREATE INDEX IF NOT EXISTS studio_byo_calls_undelivered ON public.studio_byo_calls (job_id, id) WHERE delivered_at IS NULL;

ALTER TABLE public.studio_byo_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_byo_calls FROM anon, authenticated;

COMMIT;
