-- Clone8 Studio: top-ups and auto top-up, and bought credits that really carry over.
--
-- 1. Auto top-up settings on the customer: when the free balance drops below `auto_topup_below` credits, charge the
--    saved card `auto_topup_usd` dollars (at the plan's top-up rate). Off by default.
-- 2. studio_grant's period-end expiry now expires only what is left of the PLAN's credits. Plan credits are spent
--    first; what was bought (packs, top-ups), promo and referral credits carry over. Before this, a renewal expired
--    the whole free balance, bought credits included, although the page promised they would stay.
BEGIN;

ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS auto_topup_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS auto_topup_below integer NOT NULL DEFAULT 200 CHECK (auto_topup_below BETWEEN 0 AND 100000);
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS auto_topup_usd integer NOT NULL DEFAULT 20 CHECK (auto_topup_usd BETWEEN 5 AND 500);
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS auto_topup_last_at timestamptz;
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS auto_topup_error text;
CREATE INDEX IF NOT EXISTS studio_customers_auto_topup ON public.studio_customers(user_id) WHERE auto_topup_enabled;

CREATE OR REPLACE FUNCTION public.studio_grant(p_user uuid, p_credits integer, p_ref text, p_expire_previous boolean DEFAULT true, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; bal integer; expired integer := 0; granted boolean := false;
  since timestamptz; plan_granted integer; spent integer; plan_left integer;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'ref_required'; END IF;
  c := public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN
    RETURN jsonb_build_object('granted', false, 'expired', 0, 'balance', public.studio_balance(p_user));
  END IF;
  IF p_expire_previous THEN
    -- Only the plan's own credits expire. The ending period starts at the last cycle grant (an invoice grant, refs
    -- "in_...", that is not a mid-cycle upgrade); the plan's credits in it are that grant plus any upgrade grants since,
    -- spent first; whatever of them is still free goes. Bought, promo and referral credits carry over. Reserved credits
    -- belong to running jobs and are never expired.
    bal := public.studio_balance(p_user);
    IF bal > 0 THEN
      SELECT max(created_at) INTO since FROM public.studio_credit_ledger
        WHERE user_id = p_user AND reason = 'grant' AND ref LIKE 'in\_%' AND coalesce(note, '') NOT LIKE '%subscription\_update%';
      IF since IS NOT NULL THEN
        SELECT coalesce(sum(delta), 0) INTO plan_granted FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref LIKE 'in\_%' AND created_at >= since;
        SELECT coalesce(-sum(delta), 0) INTO spent FROM public.studio_credit_ledger WHERE user_id = p_user AND reason IN ('reserve', 'settle', 'refund') AND created_at >= since;
        plan_left := least(bal, greatest(0, plan_granted - greatest(0, spent)));
        IF plan_left > 0 THEN
          INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, -plan_left, 'expire', p_ref, 'period ended');
          expired := plan_left;
        END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'grant', p_ref, p_note);
  granted := true;
  RETURN jsonb_build_object('granted', granted, 'expired', expired, 'balance', public.studio_balance(p_user));
END $$;
REVOKE ALL ON FUNCTION public.studio_grant(uuid, integer, text, boolean, text) FROM PUBLIC, anon, authenticated;

COMMIT;
