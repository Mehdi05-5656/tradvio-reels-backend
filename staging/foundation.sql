-- STAGING ONLY: minimal foundation for the managed read-only acceptance slice.
-- Never apply to production or to a nonempty application's public schema.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')) THEN
    RAISE EXCEPTION 'empty_staging_schema_required';
  END IF;
  IF EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM storage.objects) THEN
    RAISE EXCEPTION 'empty_staging_data_required';
  END IF;
END $$;
CREATE TABLE public.staging_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  mode text NOT NULL CHECK(mode='managed-readonly-staging'),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.staging_environment(singleton,mode) VALUES(true,'managed-readonly-staging');
-- Empty compatibility tables used only to exclude legacy destinations.
-- These are not a full legacy application schema.
CREATE TABLE public.publer_config (
  id text PRIMARY KEY,
  workspace_id text
);
CREATE TABLE public.publer_slot_config (
  phone_slot text PRIMARY KEY,
  publer_account_id text,
  paused boolean NOT NULL DEFAULT true CHECK(paused)
);
ALTER TABLE public.staging_environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publer_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publer_slot_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staging_environment,public.publer_config,public.publer_slot_config
  FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.staging_environment,public.publer_config,public.publer_slot_config TO service_role;
COMMIT;
