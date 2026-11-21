-- How many runs a person can have going at once now follows their plan everywhere, and the priority queue the plans
-- promise is real (Nov 20 2026, the owner: "each plan should go hand in hand with the amount").
--
-- studio_create_job: Clips, Captions and library imports used to allow one run at a time on every plan (the owner's own
-- account was refused a second Clips run). Each of those three now has its own count, set by the plan
-- (studio_customers.parallel_jobs: Starter 1, Creator 2, Studio 4), apart from the other tools, so a long Clips run
-- never blocks a Swap or a Story. Every other tool shares one count of the same size, as before.
-- Our own servers are not protected by this: every worker only takes a job when it has room, and the rest wait queued.
--
-- studio_claim: when a worker is free it now takes the waiting job of the highest plan first (Studio, then Creator,
-- then Starter and everyone else), oldest first within a plan. A job whose worker died is taken back in the same order.
-- The worker_lost rule (20261124000100) is kept as it is.
BEGIN;

CREATE OR REPLACE FUNCTION public.studio_create_job(p_user uuid, p_tool text, p_asset uuid, p_options jsonb, p_credits integer)
 RETURNS public.studio_jobs
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.studio_customers; j public.studio_jobs; active integer; bal integer;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.status NOT IN ('active', 'trialing') AND NOT c.owner_pass THEN RAISE EXCEPTION 'subscription_required'; END IF;
  IF p_asset IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.studio_assets WHERE id = p_asset AND user_id = p_user AND status = 'ready') THEN
    RAISE EXCEPTION 'asset_not_ready';
  END IF;
  IF p_tool IN ('clips', 'import', 'captions') THEN
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND tool = p_tool AND status IN ('queued', 'running');
  ELSE
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running') AND tool NOT IN ('clips', 'import', 'captions');
  END IF;
  IF active >= GREATEST(c.parallel_jobs, 1) THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  bal := public.studio_balance(p_user);
  IF bal < p_credits THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  INSERT INTO public.studio_jobs(user_id, tool, asset_id, options, credits_reserved)
    VALUES (p_user, p_tool, p_asset, COALESCE(p_options, '{}'::jsonb), p_credits) RETURNING * INTO j;
  IF p_credits > 0 THEN
    INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id) VALUES (p_user, -p_credits, 'reserve', j.id);
  END IF;
  RETURN j;
END $$;

-- A plan's place in the queue: Studio first. The owner's pass counts as Studio.
CREATE OR REPLACE FUNCTION public.studio_queue_rank(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE((SELECT CASE WHEN c.owner_pass OR c.plan_id = 'studio' THEN 0 WHEN c.plan_id = 'creator' THEN 1 ELSE 2 END
                     FROM public.studio_customers c WHERE c.user_id = p_user), 2)
$$;
REVOKE ALL ON FUNCTION public.studio_queue_rank(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_queue_rank(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.studio_claim(p_tool text, p_worker text) RETURNS public.studio_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.studio_jobs; d public.studio_jobs;
BEGIN
  FOR d IN SELECT * FROM public.studio_jobs
            WHERE tool = p_tool AND status = 'running' AND lease_until < now() AND attempts >= 3
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
    INSERT INTO public.studio_failures(job_id, user_id, tool, kind, code, detail, stage, attempt)
      VALUES (d.id, d.user_id, d.tool, 'lost', 'worker_lost', 'the worker holding it stopped answering on every attempt (its lease ran out ' || d.attempts || ' times)', left(d.progress->>'stage', 120), d.attempts);
    IF d.credits_reserved > 0 THEN
      INSERT INTO public.studio_credit_ledger(user_id, delta, reason, job_id, note) VALUES (d.user_id, d.credits_reserved, 'refund', d.id, 'worker_lost');
    END IF;
    UPDATE public.studio_jobs SET status = 'failed', error_code = 'worker_lost', credits_charged = 0, lease_token = NULL, lease_until = NULL,
      finished_at = now(), updated_at = now() WHERE id = d.id;
  END LOOP;
  SELECT * INTO j FROM public.studio_jobs
   WHERE tool = p_tool AND (status = 'queued' OR (status = 'running' AND lease_until < now() AND attempts < 3))
   ORDER BY public.studio_queue_rank(user_id), created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.studio_jobs SET status = 'running', worker = p_worker, lease_token = gen_random_uuid(), lease_until = now() + interval '10 minutes',
    attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = j.id RETURNING * INTO j;
  RETURN j;
END $$;

COMMIT;
