-- Every failure, kept (Nov 16 2026). Until now a failed job kept only a short code, overwritten on each retry; the reason
-- itself lived in the server logs for about 30 days. A customer's Signature story failed three times on one missing sound
-- file and nothing durable said why. This table keeps one row per event, for every tool:
--   kind 'retry'    a failure that put the job back in the queue (attempt n of 3)
--   kind 'failed'   the job's final failure (credits refunded)
--   kind 'lost'     a job whose worker died three times (see studio_claim below): failed and refunded
--   kind 'degraded' the job was delivered, but without a part that broke (a sound, the music, the poster): written by
--                   the workers, so the cause still gets fixed
-- `fix_status` / `fix_note` let the owner mark a class of failure fixed (by code), so a repeat is visible as a regression.
-- The owner is emailed about customer failures by the backend (src/failure-watch.ts), which sets alerted_at.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_failures (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  user_id uuid,
  tool text,
  kind text NOT NULL CHECK (kind IN ('retry', 'failed', 'lost', 'degraded')),
  code text NOT NULL,
  detail text,
  stage text,
  attempt integer,
  fix_status text NOT NULL DEFAULT 'open' CHECK (fix_status IN ('open', 'fixed', 'theirs', 'ignored')),
  fix_note text,
  alerted_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_failures_at ON public.studio_failures (at DESC);
CREATE INDEX IF NOT EXISTS studio_failures_job ON public.studio_failures (job_id);
CREATE INDEX IF NOT EXISTS studio_failures_unalerted ON public.studio_failures (at) WHERE alerted_at IS NULL;
ALTER TABLE public.studio_failures ENABLE ROW LEVEL SECURITY; -- service role only: no policies
REVOKE ALL ON public.studio_failures FROM anon, authenticated;
GRANT ALL ON public.studio_failures TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.studio_failures_id_seq TO service_role;

-- studio_fail now takes the reason in full (p_detail) and the step it died on (p_stage), and keeps a row either way.
-- The old four-argument form is dropped in the same transaction; every caller names its arguments, so callers that do
-- not send the new ones keep working (they default to NULL).
DROP FUNCTION IF EXISTS public.studio_fail(uuid, uuid, text, boolean);
CREATE FUNCTION public.studio_fail(p_job uuid, p_token uuid, p_reason text, p_retry boolean DEFAULT false, p_detail text DEFAULT NULL, p_stage text DEFAULT NULL) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.status <> 'running' THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF p_retry AND j.attempts < 3 THEN
    INSERT INTO public.studio_failures(job_id, user_id, tool, kind, code, detail, stage, attempt)
      VALUES (j.id, j.user_id, j.tool, 'retry', left(p_reason, 120), left(p_detail, 4000), left(COALESCE(p_stage, j.progress->>'stage'), 120), j.attempts);
    UPDATE public.studio_jobs SET status = 'queued', error_code = left(p_reason, 120), lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = j.id RETURNING * INTO j;
    RETURN j;
  END IF;
  INSERT INTO public.studio_failures(job_id, user_id, tool, kind, code, detail, stage, attempt)
    VALUES (j.id, j.user_id, j.tool, 'failed', left(p_reason, 120), left(p_detail, 4000), left(COALESCE(p_stage, j.progress->>'stage'), 120), j.attempts);
  IF j.credits_reserved > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved, 'refund', j.id, left(p_reason, 120));
  END IF;
  UPDATE public.studio_jobs SET status = 'failed', error_code = left(p_reason, 120), credits_charged = 0, lease_token = NULL, lease_until = NULL,
    finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;
REVOKE ALL ON FUNCTION public.studio_fail(uuid, uuid, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_fail(uuid, uuid, text, boolean, text, text) TO service_role;

-- A job whose worker died (its lease ran out) used to be handed out again with no limit: a job that kills its worker
-- looped for ever and was never refunded (a Clips job went 11 rounds on Oct 31 2026). After its third attempt it is now
-- failed and refunded here, as studio_fail would, with the code 'worker_lost'.
CREATE OR REPLACE FUNCTION public.studio_claim(p_tool text, p_worker text) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs; d public.studio_jobs;
BEGIN
  FOR d IN SELECT * FROM public.studio_jobs
            WHERE tool = p_tool AND status = 'running' AND lease_until < now() AND attempts >= 3
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
    INSERT INTO public.studio_failures(job_id, user_id, tool, kind, code, detail, stage, attempt)
      VALUES (d.id, d.user_id, d.tool, 'lost', 'worker_lost', 'the worker holding it stopped answering on every attempt (its lease ran out ' || d.attempts || ' times)', left(d.progress->>'stage', 120), d.attempts);
    IF d.credits_reserved > 0 THEN
      INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (d.user_id, d.credits_reserved, 'refund', d.id, 'worker_lost');
    END IF;
    UPDATE public.studio_jobs SET status = 'failed', error_code = 'worker_lost', credits_charged = 0, lease_token = NULL, lease_until = NULL,
      finished_at = now(), updated_at = now() WHERE id = d.id;
  END LOOP;
  SELECT * INTO j FROM public.studio_jobs
   WHERE tool = p_tool AND (status = 'queued' OR (status = 'running' AND lease_until < now() AND attempts < 3))
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.studio_jobs SET status = 'running', worker = p_worker, lease_token = gen_random_uuid(), lease_until = now() + interval '10 minutes',
    attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

COMMIT;
