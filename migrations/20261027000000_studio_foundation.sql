-- Clone8 Studio, phase 1: the self-serve product beside the managed service.
--
-- Anyone may create an account; nothing is free. A Stripe subscription grants credits for a billing
-- period; tools (Blueprint, Recast) spend them. Every credit movement is one append-only ledger row, so
-- a balance is always a sum and never an overwritten number. Jobs reserve credits when created, settle
-- what they used when they finish and refund the rest; a failed job refunds everything it reserved.
-- Service role only (the backend mediates every read and write), like the rest of this project.
-- Idempotent.
BEGIN;

-- One row per person who ever opened the Studio paywall or subscribed. plan_id/status mirror Stripe.
CREATE TABLE IF NOT EXISTS public.studio_customers(
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE CHECK(stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text UNIQUE CHECK(stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  plan_id text CHECK(plan_id IS NULL OR plan_id ~ '^[a-z][a-z0-9_]{1,30}$'),
  billing_interval text CHECK(billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  status text NOT NULL DEFAULT 'none' CHECK(status IN ('none', 'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  period_start timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  credits_per_period integer NOT NULL DEFAULT 0 CHECK(credits_per_period >= 0),
  parallel_jobs integer NOT NULL DEFAULT 1 CHECK(parallel_jobs BETWEEN 1 AND 16),
  onboarding jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only. delta > 0 adds credits, delta < 0 spends or expires them.
CREATE TABLE IF NOT EXISTS public.studio_credit_ledger(
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK(delta <> 0),
  reason text NOT NULL CHECK(reason IN ('grant', 'reserve', 'settle', 'refund', 'promo', 'adjust', 'expire')),
  job_id uuid,
  ref text,                                   -- Stripe invoice id, promo code or an operator note; grants are unique per ref
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_credit_ledger_user ON public.studio_credit_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS studio_credit_ledger_grant_ref ON public.studio_credit_ledger(user_id, reason, ref) WHERE reason IN ('grant', 'promo') AND ref IS NOT NULL;

-- What a person uploaded. The file lives in the private bucket studio-uploads under <user>/<asset>.<ext>.
CREATE TABLE IF NOT EXISTS public.studio_assets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('video', 'image')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  object_key text NOT NULL UNIQUE CHECK(object_key ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(mp4|mov|jpg|jpeg|png)$'),
  bytes bigint NOT NULL CHECK(bytes > 0 AND bytes <= 536870912),
  sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  probe jsonb,                                -- duration, width, height, fps, codecs once a worker inspected it
  status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading', 'ready', 'invalid', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_assets_user ON public.studio_assets(user_id, created_at DESC) WHERE status <> 'deleted';

-- A unit of paid work. Workers claim queued jobs with a lease, like library_variants.
CREATE TABLE IF NOT EXISTS public.studio_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK(tool IN ('blueprint', 'blueprint_plus', 'recast')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  asset_id uuid REFERENCES public.studio_assets(id) ON DELETE SET NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  credits_reserved integer NOT NULL CHECK(credits_reserved >= 0),
  credits_charged integer CHECK(credits_charged IS NULL OR credits_charged >= 0),
  worker text,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{key, bytes, duration, poster_key, sha256, seed}]
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_jobs_user ON public.studio_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_jobs_queue ON public.studio_jobs(tool, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS public.studio_promo_codes(
  code text PRIMARY KEY CHECK(code ~ '^[A-Z0-9]{4,24}$'),
  credits integer NOT NULL CHECK(credits BETWEEN 1 AND 100000),
  max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses >= 1),
  uses integer NOT NULL DEFAULT 0 CHECK(uses >= 0),
  expires_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Stripe sends every event at least once; the id makes processing idempotent.
CREATE TABLE IF NOT EXISTS public.studio_stripe_events(
  id text PRIMARY KEY CHECK(id ~ '^evt_[A-Za-z0-9]+$'),
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  payload jsonb NOT NULL
);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('studio-uploads', 'studio-uploads', false, 536870912, ARRAY['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png'])
  ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('studio-outputs', 'studio-outputs', false, 536870912, ARRAY['video/mp4', 'image/jpeg', 'application/zip'])
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.studio_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_stripe_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_customers, public.studio_credit_ledger, public.studio_assets, public.studio_jobs, public.studio_promo_codes, public.studio_stripe_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.studio_customers, public.studio_credit_ledger, public.studio_assets, public.studio_jobs, public.studio_promo_codes, public.studio_stripe_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.studio_credit_ledger_id_seq TO service_role;

-- ---------------------------------------------------------------------------------------------------
-- Credits
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.studio_balance(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(SUM(delta), 0)::integer FROM public.studio_credit_ledger WHERE user_id = p_user
$$;

-- Make sure a customer row exists and lock it for the rest of the transaction.
CREATE OR REPLACE FUNCTION public.studio_lock_customer(p_user uuid) RETURNS public.studio_customers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers;
BEGIN
  INSERT INTO public.studio_customers(user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO c FROM public.studio_customers WHERE user_id = p_user FOR UPDATE;
  RETURN c;
END $$;

-- Grant the credits of a billing period. Unique per ref (the Stripe invoice), so a replayed webhook is a
-- no-op. With p_expire_previous, whatever was left from the previous period expires first (no rollover).
CREATE OR REPLACE FUNCTION public.studio_grant(p_user uuid, p_credits integer, p_ref text, p_expire_previous boolean DEFAULT true, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; bal integer; expired integer := 0; granted boolean := false;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'ref_required'; END IF;
  c := public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN
    RETURN jsonb_build_object('granted', false, 'expired', 0, 'balance', public.studio_balance(p_user));
  END IF;
  IF p_expire_previous THEN
    -- Reserved credits belong to running jobs and are not expired; only the free balance is.
    bal := public.studio_balance(p_user);
    IF bal > 0 THEN
      INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, -bal, 'expire', p_ref, 'period ended');
      expired := bal;
    END IF;
  END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'grant', p_ref, p_note);
  granted := true;
  RETURN jsonb_build_object('granted', granted, 'expired', expired, 'balance', public.studio_balance(p_user));
END $$;

-- Mirror the Stripe subscription onto the customer row. Called from the webhook handler; the credits for
-- a period are granted separately (studio_grant) when the invoice is paid.
CREATE OR REPLACE FUNCTION public.studio_apply_subscription(p_user uuid, p_customer text, p_subscription text, p_plan text, p_interval text, p_status text,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean, p_credits_per_period integer, p_parallel integer)
RETURNS public.studio_customers LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers;
BEGIN
  c := public.studio_lock_customer(p_user);
  UPDATE public.studio_customers SET
    stripe_customer_id = COALESCE(p_customer, stripe_customer_id),
    stripe_subscription_id = p_subscription,
    plan_id = p_plan, billing_interval = p_interval, status = p_status,
    period_start = p_period_start, period_end = p_period_end, cancel_at_period_end = COALESCE(p_cancel_at_period_end, false),
    credits_per_period = COALESCE(p_credits_per_period, 0), parallel_jobs = COALESCE(p_parallel, 1), updated_at = now()
  WHERE user_id = p_user RETURNING * INTO c;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION public.studio_redeem_promo(p_user uuid, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.studio_promo_codes; c public.studio_customers;
BEGIN
  c := public.studio_lock_customer(p_user);
  SELECT * INTO p FROM public.studio_promo_codes WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF p.code IS NULL THEN RAISE EXCEPTION 'promo_unknown'; END IF;
  IF p.expires_at IS NOT NULL AND p.expires_at < now() THEN RAISE EXCEPTION 'promo_expired'; END IF;
  IF p.uses >= p.max_uses THEN RAISE EXCEPTION 'promo_exhausted'; END IF;
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'promo' AND ref = p.code) THEN RAISE EXCEPTION 'promo_already_used'; END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p.credits, 'promo', p.code, p.note);
  UPDATE public.studio_promo_codes SET uses = uses + 1 WHERE code = p.code;
  RETURN jsonb_build_object('code', p.code, 'credits', p.credits, 'balance', public.studio_balance(p_user));
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------------------------------

-- Create a job and reserve its credits in one transaction. Raises subscription_required,
-- insufficient_credits, too_many_jobs or asset_not_ready.
CREATE OR REPLACE FUNCTION public.studio_create_job(p_user uuid, p_tool text, p_asset uuid, p_options jsonb, p_credits integer)
RETURNS public.studio_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; j public.studio_jobs; active integer; bal integer;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.status NOT IN ('active', 'trialing') THEN RAISE EXCEPTION 'subscription_required'; END IF;
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
END $$;

-- A worker takes the oldest queued job of a tool, or one whose lease expired. 10-minute lease.
CREATE OR REPLACE FUNCTION public.studio_claim(p_tool text, p_worker text) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs
   WHERE tool = p_tool AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.studio_jobs SET status = 'running', worker = p_worker, lease_token = gen_random_uuid(), lease_until = now() + interval '10 minutes',
    attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION public.studio_renew(p_job uuid, p_token uuid, p_progress jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.studio_jobs SET lease_until = now() + interval '10 minutes', progress = COALESCE(p_progress, progress), updated_at = now()
   WHERE id = p_job AND lease_token = p_token AND status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- Finish a job: record outputs, charge what was used (never more than reserved), refund the rest.
CREATE OR REPLACE FUNCTION public.studio_complete(p_job uuid, p_token uuid, p_outputs jsonb, p_credits_charged integer) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs; charged integer;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.status <> 'running' THEN RAISE EXCEPTION 'lease_lost'; END IF;
  charged := LEAST(GREATEST(COALESCE(p_credits_charged, j.credits_reserved), 0), j.credits_reserved);
  IF charged < j.credits_reserved THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved - charged, 'refund', j.id, 'unused reservation');
  END IF;
  UPDATE public.studio_jobs SET status = 'done', outputs = COALESCE(p_outputs, '[]'::jsonb), credits_charged = charged, lease_token = NULL, lease_until = NULL,
    finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

-- Fail a job. With p_retry and fewer than 3 attempts it goes back to the queue, otherwise it fails and
-- every reserved credit is refunded.
CREATE OR REPLACE FUNCTION public.studio_fail(p_job uuid, p_token uuid, p_reason text, p_retry boolean DEFAULT false) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.status <> 'running' THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF p_retry AND j.attempts < 3 THEN
    UPDATE public.studio_jobs SET status = 'queued', error_code = left(p_reason, 120), lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = j.id RETURNING * INTO j;
    RETURN j;
  END IF;
  IF j.credits_reserved > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved, 'refund', j.id, left(p_reason, 120));
  END IF;
  UPDATE public.studio_jobs SET status = 'failed', error_code = left(p_reason, 120), credits_charged = 0, lease_token = NULL, lease_until = NULL,
    finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

-- The person cancels a job that has not started. Running jobs finish or fail on their own.
CREATE OR REPLACE FUNCTION public.studio_cancel(p_user uuid, p_job uuid) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs;
BEGIN
  SELECT * INTO j FROM public.studio_jobs WHERE id = p_job AND user_id = p_user FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'job_not_found'; END IF;
  IF j.status <> 'queued' THEN RAISE EXCEPTION 'job_not_cancelable'; END IF;
  IF j.credits_reserved > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (j.user_id, j.credits_reserved, 'refund', j.id, 'canceled');
  END IF;
  UPDATE public.studio_jobs SET status = 'canceled', credits_charged = 0, finished_at = now(), updated_at = now() WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

REVOKE ALL ON FUNCTION public.studio_balance(uuid), public.studio_lock_customer(uuid), public.studio_grant(uuid, integer, text, boolean, text),
  public.studio_apply_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, integer, integer),
  public.studio_redeem_promo(uuid, text), public.studio_create_job(uuid, text, uuid, jsonb, integer), public.studio_claim(text, text),
  public.studio_renew(uuid, uuid, jsonb), public.studio_complete(uuid, uuid, jsonb, integer), public.studio_fail(uuid, uuid, text, boolean),
  public.studio_cancel(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_balance(uuid), public.studio_lock_customer(uuid), public.studio_grant(uuid, integer, text, boolean, text),
  public.studio_apply_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, integer, integer),
  public.studio_redeem_promo(uuid, text), public.studio_create_job(uuid, text, uuid, jsonb, integer), public.studio_claim(text, text),
  public.studio_renew(uuid, uuid, jsonb), public.studio_complete(uuid, uuid, jsonb, integer), public.studio_fail(uuid, uuid, text, boolean),
  public.studio_cancel(uuid, uuid) TO service_role;

COMMIT;
