-- Clone8 Studio: a grouped library, clips from long videos, and bulk imports.
-- 1. studio_collections: a clips run, an import, or a folder the person made. Assets point at one (or none).
-- 2. studio_assets: collection_id; videos up to 4 GiB (long sources for Clips; every other tool refuses them by length).
-- 3. studio_jobs: two new tools, clips and import. They run in the background and do not take one of the person's
--    parallel job slots (a two-hour video must not block a swap); each may run once at a time per person.
-- 4. studio-uploads takes files up to 4 GiB. The project's global upload limit (Storage settings) must allow it too.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_collections(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK(kind IN ('clips', 'import', 'folder')),
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'processing', 'needs_file', 'failed')),
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_collections_user ON public.studio_collections(user_id, created_at DESC);
ALTER TABLE public.studio_collections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.studio_collections TO service_role;

ALTER TABLE public.studio_assets ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES public.studio_collections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS studio_assets_collection ON public.studio_assets(collection_id, created_at DESC) WHERE status <> 'deleted';
ALTER TABLE public.studio_assets DROP CONSTRAINT IF EXISTS studio_assets_bytes_check;
ALTER TABLE public.studio_assets ADD CONSTRAINT studio_assets_bytes_check
  CHECK (bytes > 0 AND bytes <= CASE WHEN kind = 'video' THEN 4294967296 ELSE 536870912 END);

ALTER TABLE public.studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_tool_check;
ALTER TABLE public.studio_jobs ADD CONSTRAINT studio_jobs_tool_check
  CHECK (tool IN ('blueprint', 'blueprint_plus', 'recast', 'swap', 'restyle', 'trend', 'character', 'instrument', 'clips', 'import'));

-- Same as 20261109000000 except the slot count: clips and import runs sit outside the parallel limit, one of each at a time.
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
  IF p_tool IN ('clips', 'import') THEN
    IF EXISTS (SELECT 1 FROM public.studio_jobs WHERE user_id = p_user AND tool = p_tool AND status IN ('queued', 'running')) THEN RAISE EXCEPTION 'too_many_jobs'; END IF;
  ELSE
    SELECT count(*) INTO active FROM public.studio_jobs WHERE user_id = p_user AND status IN ('queued', 'running') AND tool NOT IN ('clips', 'import');
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

-- What a person keeps in the library, counted exactly (the plan caps reach 12,000 files; a row read stops at 1,000).
CREATE OR REPLACE FUNCTION public.studio_library_usage(p_user uuid)
RETURNS TABLE(files bigint, bytes bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT count(*)::bigint, COALESCE(sum(bytes), 0)::bigint FROM public.studio_assets WHERE user_id = p_user AND status <> 'deleted';
$$;
REVOKE ALL ON FUNCTION public.studio_library_usage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_library_usage(uuid) TO service_role;

UPDATE storage.buckets SET file_size_limit = 4294967296 WHERE id = 'studio-uploads';

COMMIT;
