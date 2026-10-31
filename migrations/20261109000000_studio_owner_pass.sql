-- Clone8 Studio: the owner pass (owner's decision, Oct 31 2026). The owner's Studio account (support@clone8.io) can
-- generate and use the chat without a Stripe plan. Jobs still reserve and spend credits through the same ledger, so
-- the owner's work is counted like anyone's (and left out of the admin panel's numbers as one of our own accounts).
--
-- 1. studio_customers.owner_pass: false for everyone; only set here, for the confirmed support@clone8.io account.
--    Customers cannot change it (the table is service-role only).
-- 2. studio_create_job accepts an owner pass in place of an active plan. Nothing else in the function changes.
-- 3. The owner's account: owner pass on, 4 jobs at once, 10,000 credits granted once (ref owner_pass:2026-10-31).
BEGIN;

ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS owner_pass boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.studio_create_job(p_user uuid, p_tool text, p_asset uuid, p_options jsonb, p_credits integer)
RETURNS public.studio_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $function$
DECLARE c public.studio_customers; j public.studio_jobs; active integer; bal integer;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.status NOT IN ('active', 'trialing') AND NOT c.owner_pass THEN RAISE EXCEPTION 'subscription_required'; END IF;
  IF p_asset IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.studio_assets WHERE id = p_asset AND user_id = p_user AND status = 'ready') THEN
    RAISE EXCEPTION 'asset_not_ready';
  END IF;
  SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running');
  IF active >= c.parallel_jobs THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  bal := public.studio_balance(p_user);
  IF bal < p_credits THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  INSERT INTO public.studio_jobs(user_id, tool, asset_id, options, credits_reserved)
    VALUES (p_user, p_tool, p_asset, COALESCE(p_options, '{}'::jsonb), p_credits) RETURNING * INTO j;
  IF p_credits > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id) VALUES (p_user, -p_credits, 'reserve', j.id);
  END IF;
  RETURN j;
END $function$;

DO $$
DECLARE owner uuid;
BEGIN
  SELECT id INTO owner FROM auth.users WHERE lower(email) = 'support@clone8.io' AND email_confirmed_at IS NOT NULL;
  IF owner IS NULL THEN RAISE NOTICE 'owner account not found; owner pass not set'; RETURN; END IF;
  UPDATE public.studio_customers SET owner_pass = true, parallel_jobs = 4, updated_at = now() WHERE user_id = owner;
  PERFORM public.studio_grant(owner, 10000, 'owner_pass:2026-10-31', false, 'Owner pass credits');
END $$;

COMMIT;
