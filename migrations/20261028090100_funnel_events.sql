-- First-party funnel events from clone8.io/apply (Privacy Policy, section 2). Counts only: which step of the
-- application page a visit reached, the campaign labels from the link, and a coarse device class. The visit id is a
-- random per-tab value made by the page (sessionStorage), never a cookie, never joined to a person. request_id links
-- form_complete to the stored application so stages after it (qualified, call booked, won) can be read from
-- invite_requests.status. Written by the backend only; read with SQL. Retention 13 months, monthly clean-up.
-- Additive and idempotent. Service role only.
BEGIN;
CREATE TABLE IF NOT EXISTS public.funnel_events(
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event IN ('landing','cta_click','form_view','form_start','form_submit','form_complete','success_view','booking_click')),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 80),
  visit_id text NOT NULL CHECK (visit_id ~ '^[0-9a-f]{16,32}$'),
  device text CHECK (device IS NULL OR device IN ('in_app','mobile','desktop')),
  attribution jsonb CHECK (attribution IS NULL OR (jsonb_typeof(attribution) = 'object' AND length(attribution::text) <= 2000)),
  request_id uuid
);
CREATE INDEX IF NOT EXISTS funnel_events_created ON public.funnel_events(created_at);
CREATE INDEX IF NOT EXISTS funnel_events_visit ON public.funnel_events(visit_id, event);
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funnel_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.funnel_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.funnel_events_id_seq TO service_role;

-- Dry run:  SELECT public.funnel_events_retention_purge(true);   Real run:  SELECT public.funnel_events_retention_purge(false);
CREATE OR REPLACE FUNCTION public.funnel_events_retention_purge(p_dry_run boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cutoff timestamptz := now() - interval '13 months'; v_n integer := 0;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) INTO v_n FROM public.funnel_events WHERE created_at < v_cutoff;
  ELSE
    DELETE FROM public.funnel_events WHERE created_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.funnel_events_retention_purge(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funnel_events_retention_purge(boolean) TO service_role;

-- The funnel by week and creative (utm_content), distinct visits per step:
--   SELECT date_trunc('week', created_at) AS week, attribution->>'utm_content' AS creative, event, count(DISTINCT visit_id)
--     FROM public.funnel_events WHERE path = '/apply' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
COMMIT;

-- Monthly schedule, same day as the invite-request clean-up. Skipped (with a notice) where pg_cron is not available.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('clone8-funnel-events-retention', '27 9 1 * *',
      $job$SELECT public.funnel_events_retention_purge(false)$job$);
  ELSE
    RAISE NOTICE 'pg_cron not available: schedule funnel_events_retention_purge(false) monthly by hand';
  END IF;
END $do$;
