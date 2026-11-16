-- Hand a running job back to the queue (Nov 15 2026). A server told to stop (a deploy or restart: Render keeps the old
-- server about 60 s after the new one is live, then sends SIGTERM and allows 30 s) gives back every job it holds,
-- so the new server picks it up within seconds instead of after the 10-minute lease. Only the holder's lease token
-- releases a job, only while it is running; the attempt it used is given back (a deploy is not the job's failure),
-- and its progress is kept, so a run that saves its work (Clips: the chosen moments, the transcript, the clips made)
-- carries on where it stopped.
BEGIN;
CREATE OR REPLACE FUNCTION public.studio_release(p_job uuid, p_token uuid, p_reason text DEFAULT 'released') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.studio_jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, worker = NULL,
    attempts = GREATEST(attempts - 1, 0), error_code = left(COALESCE(p_reason, 'released'), 120), updated_at = now()
   WHERE id = p_job AND lease_token = p_token AND status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION public.studio_release(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_release(uuid, uuid, text) TO service_role;
COMMIT;
