-- Clone8 Studio: a yearly plan's credits arrive all at once again (owner, Nov 15 2026: credits that trickle in monthly
-- would frustrate people who paid for the year). They last until the end of the year paid for, never less than 60
-- days, instead of the 60 days other plan credits get. studio_grant_until is studio_grant with that date: the ledger
-- row's trigger makes the batch (migrations/20261122000000_studio_credit_expiry.sql) and this sets how long it lasts.
-- studio_grant_spread stays (unused) so nothing that still names it breaks. Undo: DROP FUNCTION public.studio_grant_until.
CREATE OR REPLACE FUNCTION public.studio_grant_until(p_user uuid, p_credits integer, p_ref text, p_until timestamptz, p_note text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE c public.studio_customers; lid bigint;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'ref_required'; END IF;
  c := public.studio_lock_customer(p_user);
  IF EXISTS (SELECT 1 FROM public.studio_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref) THEN
    RETURN jsonb_build_object('granted', false, 'balance', public.studio_balance(p_user));
  END IF;
  INSERT INTO public.studio_credit_ledger(user_id, delta, reason, ref, note) VALUES (p_user, p_credits, 'grant', p_ref, p_note) RETURNING id INTO lid;
  UPDATE public.studio_credit_lots SET expires_at = greatest(coalesce(p_until, now() + interval '365 days'), now() + interval '60 days') WHERE ledger_id = lid;
  RETURN jsonb_build_object('granted', true, 'balance', public.studio_balance(p_user));
END $$;
