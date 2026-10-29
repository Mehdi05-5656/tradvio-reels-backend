-- Clone8 Studio, phase 4: referral credits and email notices. Idempotent. Service role only, like the rest.
--
-- Referrals: every customer has a short code; a new person who signs up with it is recorded as referred, and the
-- first paid invoice of the referred person credits both sides once (ledger reason 'promo', refs
-- 'referral:<referred user>' for the referrer and 'referred:<referrer user>' for the newcomer; the unique index on
-- (user, reason, ref) makes a replay a no-op).
-- Notices: timestamps so each email goes out once: a finished or failed job, a low balance (once per period), the
-- renewal reminder (once per period end). People can opt out.
BEGIN;

ALTER TABLE public.studio_customers
  ADD COLUMN IF NOT EXISTS referral_code text UNIQUE CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z2-9]{8}$'),
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_credited_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_credits_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_notified_for timestamptz;
ALTER TABLE public.studio_jobs ADD COLUMN IF NOT EXISTS notified_at timestamptz;
CREATE INDEX IF NOT EXISTS studio_jobs_unnotified ON public.studio_jobs(finished_at) WHERE notified_at IS NULL AND status IN ('done', 'failed');

-- The code is derived from the user id, so it is stable and never guessable from a counter; the alphabet skips
-- 0/O/1/I. Assigned the first time it is asked for.
CREATE OR REPLACE FUNCTION public.studio_referral_code(p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; code text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; h bytea; i integer; attempt integer := 0;
BEGIN
  c := public.studio_lock_customer(p_user);
  IF c.referral_code IS NOT NULL THEN RETURN c.referral_code; END IF;
  LOOP
    h := sha256((p_user::text || ':' || attempt::text)::bytea);
    code := '';
    FOR i IN 0..7 LOOP code := code || substr(alphabet, (get_byte(h, i) % 32) + 1, 1); END LOOP;
    BEGIN
      UPDATE public.studio_customers SET referral_code = code, updated_at = now() WHERE user_id = p_user;
      RETURN code;
    EXCEPTION WHEN unique_violation THEN attempt := attempt + 1; IF attempt > 20 THEN RAISE; END IF;
    END;
  END LOOP;
END $$;

-- Record who referred a newcomer. Only before any plan was ever paid, never oneself, only once.
CREATE OR REPLACE FUNCTION public.studio_apply_referral(p_user uuid, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; r public.studio_customers;
BEGIN
  c := public.studio_lock_customer(p_user);
  IF c.referred_by IS NOT NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'already_referred'); END IF;
  IF c.stripe_subscription_id IS NOT NULL OR c.status NOT IN ('none', 'incomplete') THEN RETURN jsonb_build_object('applied', false, 'reason', 'already_customer'); END IF;
  SELECT * INTO r FROM public.studio_customers WHERE referral_code = upper(trim(p_code));
  IF r.user_id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'unknown_code'); END IF;
  IF r.user_id = p_user THEN RETURN jsonb_build_object('applied', false, 'reason', 'own_code'); END IF;
  UPDATE public.studio_customers SET referred_by = r.user_id, updated_at = now() WHERE user_id = p_user;
  RETURN jsonb_build_object('applied', true, 'referrer', r.user_id);
END $$;

-- On the referred person's first paid invoice: credit both sides once. Returns what was granted.
CREATE OR REPLACE FUNCTION public.studio_referral_reward(p_user uuid, p_credits integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; referrer uuid;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.referred_by IS NULL OR c.referral_credited_at IS NOT NULL THEN RETURN jsonb_build_object('granted', false); END IF;
  referrer := c.referred_by;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (referrer, p_credits, 'promo', 'referral:' || p_user::text, 'Referral: a friend subscribed') ON CONFLICT DO NOTHING;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'promo', 'referred:' || referrer::text, 'Welcome credits from a referral') ON CONFLICT DO NOTHING;
  UPDATE public.studio_customers SET referral_credited_at = now(), updated_at = now() WHERE user_id = p_user;
  RETURN jsonb_build_object('granted', true, 'referrer', referrer, 'credits', p_credits);
END $$;

-- Finished jobs that have not been announced yet (a batch for the notices loop), oldest first.
CREATE OR REPLACE FUNCTION public.studio_jobs_to_notify(p_limit integer DEFAULT 50) RETURNS SETOF public.studio_jobs
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM public.studio_jobs WHERE notified_at IS NULL AND status IN ('done', 'failed') AND finished_at > now() - interval '2 days' ORDER BY finished_at LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

CREATE OR REPLACE FUNCTION public.studio_mark_notified(p_job uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.studio_jobs SET notified_at = now() WHERE id = p_job AND notified_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.studio_referral_code(uuid), public.studio_apply_referral(uuid, text), public.studio_referral_reward(uuid, integer),
  public.studio_jobs_to_notify(integer), public.studio_mark_notified(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_referral_code(uuid), public.studio_apply_referral(uuid, text), public.studio_referral_reward(uuid, integer),
  public.studio_jobs_to_notify(integer), public.studio_mark_notified(uuid) TO service_role;

COMMIT;
