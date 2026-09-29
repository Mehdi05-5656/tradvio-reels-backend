-- STAGING ONLY. Run after the reviewed auth and managed migrations.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.staging_environment
    WHERE singleton AND mode='managed-readonly-staging') THEN
    RAISE EXCEPTION 'staging_marker_required';
  END IF;
END $$;
ALTER TABLE public.managed_accounts
  ADD CONSTRAINT staging_account_publishing_off CHECK(NOT publishing_enabled);
ALTER TABLE public.managed_generation_control
  ADD CONSTRAINT staging_generation_off CHECK(NOT enabled);
ALTER TABLE public.managed_handoff_control
  ADD CONSTRAINT staging_handoff_off CHECK(NOT enabled);
ALTER TABLE public.managed_handoff_approvals
  ADD CONSTRAINT staging_approvals_off CHECK(NOT enabled);
ALTER TABLE public.managed_generation_jobs
  ADD CONSTRAINT staging_generation_no_lease CHECK(lease_token IS NULL AND lease_until IS NULL);
ALTER TABLE public.managed_handoffs
  ADD CONSTRAINT staging_handoff_no_remote CHECK(
    lease_token IS NULL AND lease_until IS NULL AND upload_job_id IS NULL
    AND submit_job_id IS NULL AND post_id IS NULL AND post_link IS NULL
  );
-- Browser clients use Auth only. Profile and account data are backend-only.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.profiles TO service_role;
ALTER FUNCTION public.profiles_lock_columns() SET search_path=public,pg_temp;
-- Original auth trigger's function remains callable by the Auth owner.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
COMMIT;
