-- Clone8 Studio: Captions, a new kind of job. A captions run burns animated captions into one video or a batch (a
-- whole Clips run), so like clips and imports it sits outside the person's parallel job slots, one at a time each.
ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool IN ('blueprint', 'blueprint_plus', 'recast', 'swap', 'restyle', 'trend', 'character', 'instrument', 'clips', 'import', 'captions'));

-- Same as 20261111000000 except captions joins the clips and import lane.
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
  IF p_tool IN ('clips', 'import', 'captions') THEN
    IF EXISTS (SELECT 1 FROM public.studio_jobs WHERE user_id = p_user AND tool = p_tool AND status IN ('queued', 'running')) THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  ELSE
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running') AND tool NOT IN ('clips', 'import', 'captions');
    IF active >= c.parallel_jobs THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  END IF;
  bal := public.studio_balance(p_user);
  IF bal < p_credits THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  INSERT INTO public.studio_jobs(user_id, tool, asset_id, options, credits_reserved)
    VALUES (p_user, p_tool, p_asset, COALESCE(p_options, '{}'::jsonb), p_credits) RETURNING * INTO j;
  IF p_credits > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id) VALUES (p_user, -p_credits, 'reserve', j.id);
  END IF;
  RETURN j;
END $function$;
