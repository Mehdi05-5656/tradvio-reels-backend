-- Captions for many videos + Smart post (docs/publishing/CAPTIONS_AND_SMART_POST_PLAN.md; owner, Nov 23 2026).
--   1. studio_video_notes: what a video shows and says, written once by the model that watched it (the paid step), so
--      every later caption, variant or per-account version is written from it without watching again.
--   2. studio_jobs.tool gains 'post_captions': a batch of captions is a job, so its credits are held, charged only for
--      the videos actually watched and the rest refunded (studio_complete), like every other paid step.
--   3. studio_create_job: 'post_captions' runs in its own lane (like clips, import and captions), so writing captions
--      never waits on a film, and a film never waits on captions. Same function otherwise, word for word.

CREATE TABLE IF NOT EXISTS public.studio_video_notes (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video text NOT NULL,            -- "a:<asset id>" or "j:<job id>:<output key>"
  note jsonb NOT NULL,            -- { summary, moments[], on_screen_text[], speech, tone, people, searched[] }
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video)
);
ALTER TABLE public.studio_video_notes ENABLE ROW LEVEL SECURITY; -- service role only (the backend), like the other studio tables

ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check CHECK ((tool = ANY (ARRAY['blueprint'::text, 'blueprint_plus'::text, 'recast'::text, 'swap'::text, 'restyle'::text, 'trend'::text, 'character'::text, 'instrument'::text, 'clips'::text, 'import'::text, 'captions'::text, 'kage'::text, 'kage_motion'::text, 'longform'::text, 'stunts'::text, 'splitscreen'::text, 'reshoot'::text, 'blueprint_versions'::text, 'post_captions'::text])));

CREATE OR REPLACE FUNCTION public.studio_create_job(p_user uuid, p_tool text, p_asset uuid, p_options jsonb, p_credits integer)
 RETURNS studio_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c public.studio_customers; j public.studio_jobs; active integer; bal integer;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN RAISE EXCEPTION 'invalid_credits'; END IF;
  c := public.studio_lock_customer(p_user);
  IF c.status NOT IN ('active', 'trialing') AND NOT c.owner_pass THEN RAISE EXCEPTION 'subscription_required'; END IF;
  IF p_asset IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.studio_assets WHERE id = p_asset AND user_id = p_user AND status = 'ready') THEN
    RAISE EXCEPTION 'asset_not_ready';
  END IF;
  IF p_tool IN ('clips', 'import', 'captions', 'post_captions') THEN
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND tool = p_tool AND status IN ('queued', 'running');
  ELSE
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running') AND tool NOT IN ('clips', 'import', 'captions', 'post_captions');
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
END $function$;
