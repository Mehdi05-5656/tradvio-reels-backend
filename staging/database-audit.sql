-- Run only after the destination has independently been confirmed as isolated staging.
-- This audit is read-only. Missing tables are a failure, not a reason to skip a check.
BEGIN TRANSACTION READ ONLY;
SELECT 'handoff_control' AS check_name,
  count(*)=1 AND bool_and(enabled=false AND singleton=true) AS passed
FROM public.managed_handoff_control
UNION ALL
SELECT 'generation_control',count(*)=1 AND bool_and(enabled=false AND singleton=true)
FROM public.managed_generation_control
UNION ALL
SELECT 'account_permission_off',count(*)=0 FROM public.managed_accounts WHERE publishing_enabled
UNION ALL
SELECT 'approval_off',count(*)=0 FROM public.managed_handoff_approvals WHERE enabled
UNION ALL
SELECT 'no_active_legacy_publishers',count(*)=0 FROM public.publer_slot_config WHERE NOT paused
UNION ALL
SELECT 'no_remote_receipts',count(*)=0 FROM public.managed_handoffs
WHERE upload_job_id IS NOT NULL OR submit_job_id IS NOT NULL OR post_id IS NOT NULL OR post_link IS NOT NULL
UNION ALL
SELECT 'no_handoff_lease',count(*)=0 FROM public.managed_handoffs WHERE lease_until IS NOT NULL
UNION ALL
SELECT 'no_generation_lease',count(*)=0 FROM public.managed_generation_jobs WHERE lease_until IS NOT NULL;

-- Every managed table should have RLS on, with no direct customer read or write grant.
SELECT c.relname,c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon_has_any_access,
  has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS customer_has_any_access
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'managed_%'
ORDER BY c.relname;

-- Neither browser role may invoke any managed SECURITY DEFINER function.
SELECT p.proname,p.oid::regprocedure::text AS signature,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS customer_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'managed_%'
ORDER BY p.proname;
COMMIT;
