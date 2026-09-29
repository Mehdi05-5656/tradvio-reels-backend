-- PREPARED ONLY: requires separate production approval before application.
-- Audited against gzvxqzguthrpvjtflxcx on 2026-09-29. No data deletion,
-- refresh, schedule changes, activation, new roles or broad privilege grants.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE signature text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.caption_performance')
    AND relkind='m') THEN
    RAISE EXCEPTION 'caption_performance_materialized_view_required';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'public.profiles_lock_columns()','public.set_scheduled_reels_updated_at()',
    'public.merge_own_analytics_to_leader_posts()','public.pending_feature_extraction(integer)',
    'public.touch_ingestion_jobs_updated_at()','public.claim_next_ingestion_job(text)',
    'public.handle_new_user()','public.is_admin(uuid)'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'audited_function_required: %',signature;
    END IF;
  END LOOP;
  -- These functions resolve audited unqualified relations in public. Fail
  -- closed if untrusted callers can introduce shadow objects in that schema.
  IF has_schema_privilege('anon','public','CREATE')
    OR has_schema_privilege('authenticated','public','CREATE') THEN
    RAISE EXCEPTION 'public_schema_create_privilege_review_required';
  END IF;
END $$;

-- A materialized view does not inherit tenant isolation from its source tables.
-- Keep it backend-only. Existing service/owner grants and cached data survive.
REVOKE ALL ON TABLE public.caption_performance FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.caption_performance TO service_role;

-- Keep function identities, trigger bindings, semantics and service grants.
-- Explicit pg_temp-last prevents implicit temporary-schema relation shadowing.
ALTER FUNCTION public.profiles_lock_columns() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.set_scheduled_reels_updated_at() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.merge_own_analytics_to_leader_posts() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.pending_feature_extraction(integer) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.touch_ingestion_jobs_updated_at() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.claim_next_ingestion_job(text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.handle_new_user() SET search_path=pg_catalog,public,pg_temp;

-- Profile RLS calls is_admin(auth.uid()). Keep that authenticated self-check;
-- do not expose an arbitrary-user role oracle. Trusted backend callers retain
-- their service-role behavior. No privilege is derived from client metadata.
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT COALESCE(
    (uid=auth.uid() OR auth.role()='service_role')
    AND EXISTS(SELECT 1 FROM public.profiles WHERE user_id=uid AND role='admin'),
    false
  );
$$;
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated,service_role;

-- Existing triggers continue to fire; these are not browser RPC interfaces.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.profiles_lock_columns() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.set_scheduled_reels_updated_at() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.touch_ingestion_jobs_updated_at() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.merge_own_analytics_to_leader_posts() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pending_feature_extraction(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_next_ingestion_job(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.merge_own_analytics_to_leader_posts() TO service_role;
GRANT EXECUTE ON FUNCTION public.pending_feature_extraction(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_ingestion_job(text) TO service_role;

-- Fail the transaction if inherited grants still expose the protected view or
-- RPCs. Retained authenticated is_admin execution is intentional for profile RLS.
DO $$
DECLARE signature text; browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_table_privilege(browser_role,'public.caption_performance',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'caption_performance_privileges_not_closed';
    END IF;
    FOREACH signature IN ARRAY ARRAY[
      'public.profiles_lock_columns()','public.set_scheduled_reels_updated_at()',
      'public.merge_own_analytics_to_leader_posts()','public.pending_feature_extraction(integer)',
      'public.touch_ingestion_jobs_updated_at()','public.claim_next_ingestion_job(text)',
      'public.handle_new_user()'
    ] LOOP
      IF has_function_privilege(browser_role,signature,'EXECUTE') THEN
        RAISE EXCEPTION 'browser_function_privilege_remains: %',signature;
      END IF;
    END LOOP;
  END LOOP;
  IF has_function_privilege('anon','public.is_admin(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'anonymous_admin_helper_privilege_remains';
  END IF;
END $$;
COMMIT;
