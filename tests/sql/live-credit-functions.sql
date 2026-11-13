-- The live credit tables and functions as they were on Nov 13 2026 (read from the project), the base the credit-expiry
-- migration is tested on (tests/sql/credit-expiry.mjs). Only the columns these functions use.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE ROLE anon; CREATE ROLE authenticated;  -- (Supabase's own roles)
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.studio_customers (user_id uuid PRIMARY KEY REFERENCES auth.users(id), plan_id text, billing_interval text, status text NOT NULL DEFAULT 'none',
  period_start timestamptz, period_end timestamptz, credits_per_period integer NOT NULL DEFAULT 0, parallel_jobs integer NOT NULL DEFAULT 1, owner_pass boolean NOT NULL DEFAULT false,
  referred_by uuid, referral_credited_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.studio_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tool text NOT NULL, status text NOT NULL DEFAULT 'queued', asset_id uuid,
  options jsonb NOT NULL DEFAULT '{}', credits_reserved integer NOT NULL, credits_charged integer, lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  outputs jsonb NOT NULL DEFAULT '[]', error_code text, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.studio_assets (id uuid PRIMARY KEY, user_id uuid, status text);
CREATE TABLE public.studio_promo_codes (code text PRIMARY KEY, credits integer NOT NULL, max_uses integer NOT NULL DEFAULT 1, uses integer NOT NULL DEFAULT 0, expires_at timestamptz, note text);
CREATE TABLE public.studio_credit_ledger (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK (delta <> 0), reason text NOT NULL CHECK (reason IN ('grant','reserve','settle','refund','promo','adjust','expire')),
  job_id uuid, ref text, note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX studio_credit_ledger_grant_ref ON public.studio_credit_ledger (user_id, reason, ref) WHERE reason IN ('grant','promo') AND ref IS NOT NULL;

CREATE FUNCTION public.studio_balance(p_user uuid) RETURNS integer LANGUAGE sql STABLE AS $$ SELECT COALESCE(SUM(delta), 0)::integer FROM public.studio_credit_ledger WHERE user_id = p_user $$;
CREATE FUNCTION public.studio_lock_customer(p_user uuid) RETURNS studio_customers LANGUAGE plpgsql AS $$
DECLARE c public.studio_customers;
BEGIN INSERT INTO public.studio_customers(user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING; SELECT * INTO c FROM public.studio_customers WHERE user_id = p_user FOR UPDATE; RETURN c; END $$;
CREATE FUNCTION public.studio_create_job(p_user uuid, p_tool text, p_asset uuid, p_options jsonb, p_credits integer) RETURNS studio_jobs LANGUAGE plpgsql AS $$
DECLARE c public.studio_customers; j public.studio_jobs; active integer; bal integer;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.status NOT IN ('active', 'trialing') AND NOT c.owner_pass THEN RAISE EXCEPTION 'subscription_required'; END IF;
  SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running');
  IF active >= c.parallel_jobs THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  bal := public.studio_balance(p_user);
  IF bal < p_credits THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  INSERT INTO public.studio_jobs(user_id, tool, asset_id, options, credits_reserved) VALUES (p_user, p_tool, p_asset, COALESCE(p_options, '{}'::jsonb), p_credits) RETURNING * INTO j;
  IF p_credits > 0 THEN INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id) VALUES (p_user, -p_credits, 'reserve', j.id); END IF;
  RETURN j;
END $$;
CREATE FUNCTION public.studio_cancel(p_user uuid, p_job uuid) RETURNS studio_jobs LANGUAGE plpgsql AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job AND user_id = p_user FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'job_not_found'; END IF;
  IF j.status <> 'queued' THEN RAISE EXCEPTION 'job_not_cancelable'; END IF;
  IF j.credits_reserved > 0 THEN INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved, 'refund', j.id, 'canceled'); END IF;
  UPDATE public.studio_jobs SET status = 'canceled', credits_charged = 0, finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;
CREATE FUNCTION public.studio_complete(p_job uuid, p_token uuid, p_outputs jsonb, p_credits_charged integer) RETURNS studio_jobs LANGUAGE plpgsql AS $$
DECLARE j public.studio_jobs; charged integer;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.status <> 'running' THEN RAISE EXCEPTION 'lease_lost'; END IF;
  charged := LEAST(GREATEST(COALESCE(p_credits_charged, j.credits_reserved), 0), j.credits_reserved);
  IF charged < j.credits_reserved THEN INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved - charged, 'refund', j.id, 'unused reservation'); END IF;
  UPDATE public.studio_jobs SET status = 'done', outputs = COALESCE(p_outputs, '[]'::jsonb), credits_charged = charged, lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;
CREATE FUNCTION public.studio_fail(p_job uuid, p_token uuid, p_reason text, p_retry boolean DEFAULT false) RETURNS studio_jobs LANGUAGE plpgsql AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.status <> 'running' THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF p_retry AND j.attempts < 3 THEN UPDATE public.studio_jobs SET status = 'queued', error_code = left(p_reason, 120), lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = j.id RETURNING * INTO j; RETURN j; END IF;
  IF j.credits_reserved > 0 THEN INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved, 'refund', j.id, left(p_reason, 120)); END IF;
  UPDATE public.studio_jobs SET status = 'failed', error_code = left(p_reason, 120), credits_charged = 0, lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;
CREATE FUNCTION public.studio_redeem_promo(p_user uuid, p_code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p public.studio_promo_codes; c public.studio_customers;
BEGIN
  c := public.studio_lock_customer(p_user);
  SELECT * INTO p FROM public.studio_promo_codes WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF p.code IS NULL THEN RAISE EXCEPTION 'promo_unknown'; END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p.credits, 'promo', p.code, p.note);
  UPDATE public.studio_promo_codes SET uses = uses + 1 WHERE code = p.code;
  RETURN jsonb_build_object('code', p.code, 'credits', p.credits, 'balance', public.studio_balance(p_user));
END $$;
-- the grant as it is live today (expires the last period's plan credits at a new period)
CREATE FUNCTION public.studio_grant(p_user uuid, p_credits integer, p_ref text, p_expire_previous boolean DEFAULT true, p_note text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN RETURN jsonb_build_object('granted', false); END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'grant', p_ref, p_note);
  RETURN jsonb_build_object('granted', true);
END $$;
