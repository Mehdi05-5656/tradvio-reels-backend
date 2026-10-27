-- clone8.io invite requests: 24-month retention from the submission date (Privacy Policy, section 7).
--
-- Once a month, invite_requests rows older than 24 months are deleted, except:
--   * active clients: the request's email is the contact email of a client organisation that is not
--     archived, or the sign-in email of a member of such an organisation;
--   * held rows: retention_hold = true, set by an operator for a legal or contractual obligation
--     (with retention_hold_reason).
-- Each run writes one row to invite_request_retention_runs (counts only, no personal data).
--
-- Dry run, no deletion:  SELECT * FROM public.invite_requests_retention_purge(true);
-- Real run (what the schedule does):  SELECT * FROM public.invite_requests_retention_purge(false);
--
-- The schedule uses pg_cron (Supabase scheduler), 1st of each month 09:17 UTC. Applying this
-- deletes nothing that exists today: the oldest possible request is from October 2026.
-- Additive and idempotent. Service role / postgres only.
BEGIN;

ALTER TABLE public.invite_requests
  ADD COLUMN IF NOT EXISTS retention_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_hold_reason text CHECK (retention_hold_reason IS NULL OR length(retention_hold_reason) <= 300);

CREATE TABLE IF NOT EXISTS public.invite_request_retention_runs(
  id bigserial PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  dry_run boolean NOT NULL,
  cutoff timestamptz NOT NULL,
  expired integer NOT NULL,          -- rows past 24 months
  kept_client integer NOT NULL,      -- of those, kept because the email belongs to an active client
  kept_hold integer NOT NULL,        -- of those, kept because of retention_hold
  deleted integer NOT NULL
);
ALTER TABLE public.invite_request_retention_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_request_retention_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invite_request_retention_runs TO service_role;

CREATE OR REPLACE FUNCTION public.invite_requests_retention_purge(p_dry_run boolean DEFAULT true)
RETURNS TABLE(expired integer, kept_client integer, kept_hold integer, deleted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cutoff timestamptz := now() - interval '24 months';
  v_expired int; v_client int; v_hold int; v_deleted int := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _c8_client_emails(email text PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _c8_client_emails;
  INSERT INTO _c8_client_emails
    SELECT DISTINCT lower(trim(o.contact_email)) FROM public.client_orgs o
     WHERE o.archived_at IS NULL AND coalesce(trim(o.contact_email), '') <> ''
    UNION
    SELECT DISTINCT lower(trim(u.email)) FROM public.client_org_members m
      JOIN public.client_orgs o ON o.id = m.org_id AND o.archived_at IS NULL
      JOIN auth.users u ON u.id = m.user_id
     WHERE coalesce(trim(u.email), '') <> ''
    ON CONFLICT DO NOTHING;

  SELECT count(*),
         count(*) FILTER (WHERE NOT r.retention_hold AND c.email IS NOT NULL),
         count(*) FILTER (WHERE r.retention_hold)
    INTO v_expired, v_client, v_hold
    FROM public.invite_requests r LEFT JOIN _c8_client_emails c ON c.email = lower(trim(r.email))
   WHERE r.created_at < v_cutoff;

  IF NOT p_dry_run THEN
    DELETE FROM public.invite_requests r
     WHERE r.created_at < v_cutoff
       AND NOT r.retention_hold
       AND NOT EXISTS (SELECT 1 FROM _c8_client_emails c WHERE c.email = lower(trim(r.email)));
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  INSERT INTO public.invite_request_retention_runs(dry_run, cutoff, expired, kept_client, kept_hold, deleted)
  VALUES (p_dry_run, v_cutoff, v_expired, v_client, v_hold, v_deleted);
  RETURN QUERY SELECT v_expired, v_client, v_hold, v_deleted;
END $$;
REVOKE ALL ON FUNCTION public.invite_requests_retention_purge(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invite_requests_retention_purge(boolean) TO service_role;

COMMIT;

-- Monthly schedule. Skipped (with a notice) where pg_cron is not available, e.g. local test databases.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('clone8-invite-requests-retention', '17 9 1 * *',
      $job$SELECT * FROM public.invite_requests_retention_purge(false)$job$);
  ELSE
    RAISE NOTICE 'pg_cron not available: schedule invite_requests_retention_purge(false) monthly by hand';
  END IF;
END $do$;
