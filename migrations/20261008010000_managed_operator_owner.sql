-- Candidate only. Allows the designated operator to own a managed workspace.
-- Does not register destinations, grant content rights, activate workers, or
-- remove legacy-workspace/destination exclusions.
BEGIN;
CREATE OR REPLACE FUNCTION public.managed_customer_eligible(p_customer uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u JOIN public.profiles p ON p.user_id=u.id
    WHERE u.id=p_customer
      AND (p.role='user' OR (p.role='admin'
        AND p.user_id='71c2308a-9e23-4458-b4f0-df7ae53c841e'::uuid))
      AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
  );
$$;
REVOKE ALL ON FUNCTION public.managed_customer_eligible(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.managed_customer_eligible(uuid) TO service_role;
COMMIT;
