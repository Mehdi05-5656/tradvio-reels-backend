-- STAGED. Private generation only. No changes to legacy queues or publishers.
BEGIN;
CREATE TABLE IF NOT EXISTS public.managed_raw_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source jsonb NOT NULL,
  sha256 text NOT NULL UNIQUE CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.managed_asset_grants (
  account_id uuid REFERENCES public.managed_accounts(id) NOT NULL,
  asset_id uuid REFERENCES public.managed_raw_assets(id) NOT NULL,
  consent_ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY(account_id,asset_id)
);
CREATE TABLE IF NOT EXISTS public.managed_generation_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  max_active integer NOT NULL DEFAULT 2 CHECK(max_active BETWEEN 1 AND 4),
  max_daily_claims integer NOT NULL DEFAULT 24 CHECK(max_daily_claims BETWEEN 1 AND 100)
);
INSERT INTO public.managed_generation_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.managed_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.managed_batches(id),
  account_id uuid NOT NULL REFERENCES public.managed_accounts(id),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 24),
  asset_id uuid REFERENCES public.managed_raw_assets(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','blocked','quality_passed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_token uuid, lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  recipe jsonb, recipe_hash text, tokens text[],
  result jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,ordinal)
);
CREATE INDEX IF NOT EXISTS managed_generation_pending ON public.managed_generation_jobs(state,next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS managed_recipe_unique ON public.managed_generation_jobs(asset_id,recipe_hash)
  WHERE recipe_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS managed_output_hash_unique ON public.managed_generation_jobs((result->>'sha256'))
  WHERE state='quality_passed';
CREATE TABLE IF NOT EXISTS public.managed_generation_attempts (
  token uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.managed_generation_jobs(id),
  worker text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS managed_attempts_day ON public.managed_generation_attempts(claimed_at);

CREATE OR REPLACE FUNCTION public.managed_register_asset(p_actor uuid,p_source jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.managed_raw_assets;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_source))<>9
    OR NOT (p_source ?& ARRAY['bucket','object_key','sha256','bytes','duration','facts','audio_rights','editorial_approved','license_ref'])
    OR p_source->>'bucket' IS DISTINCT FROM 'managed-raw'
    OR COALESCE(p_source->>'object_key','') !~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*[.]mp4$'
    OR length(p_source->>'object_key')>240 OR octet_length(p_source::text)>12000
    OR COALESCE(p_source->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_source->'bytes') IS DISTINCT FROM 'number'
    OR (p_source->>'bytes')::numeric NOT BETWEEN 1 AND 134217728
    OR (p_source->>'bytes')::numeric<>trunc((p_source->>'bytes')::numeric)
    OR jsonb_typeof(p_source->'duration') IS DISTINCT FROM 'number'
    OR (p_source->>'duration')::numeric NOT BETWEEN 12 AND 600
    OR p_source->'audio_rights' IS DISTINCT FROM 'true'::jsonb
    OR p_source->'editorial_approved' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_source->'facts') IS DISTINCT FROM 'string'
    OR length(trim(p_source->>'facts')) NOT BETWEEN 10 AND 8000
    OR jsonb_typeof(p_source->'license_ref') IS DISTINCT FROM 'string'
    OR length(trim(p_source->>'license_ref')) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'invalid_source'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-assets',0));
  SELECT * INTO a FROM public.managed_raw_assets
    WHERE sha256=p_source->>'sha256' OR object_key=p_source->>'object_key';
  IF FOUND THEN
    IF a.source<>p_source THEN RAISE EXCEPTION 'source_conflict'; END IF;
    RETURN a.id;
  END IF;
  INSERT INTO public.managed_raw_assets(source,sha256,object_key)
    VALUES(p_source,p_source->>'sha256',p_source->>'object_key') RETURNING * INTO a;
  RETURN a.id;
END $$;

CREATE OR REPLACE FUNCTION public.managed_grant_asset(
  p_actor uuid,p_account uuid,p_asset uuid,p_consent text,p_expires timestamptz,p_enabled boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.managed_accounts;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF p_consent IS NULL OR length(trim(p_consent)) NOT BETWEEN 1 AND 500
    OR p_expires IS NULL OR p_enabled IS NULL OR (p_enabled AND p_expires<=now())
    THEN RAISE EXCEPTION 'invalid_grant'; END IF;
  -- Same lock as final completion: revocation and completion have an explicit order.
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-generation',0));
  SELECT * INTO a FROM public.managed_accounts WHERE id=p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_grant'; END IF;
  INSERT INTO public.managed_asset_grants VALUES(p_account,p_asset,p_consent,p_expires,p_enabled)
    ON CONFLICT(account_id,asset_id) DO UPDATE SET consent_ref=EXCLUDED.consent_ref,
      expires_at=EXCLUDED.expires_at,enabled=EXCLUDED.enabled;
  INSERT INTO public.managed_audit(actor_user_id,customer_user_id,workspace_id,account_id,action)
    VALUES(p_actor,a.customer_user_id,a.workspace_id,a.id,
      CASE WHEN p_enabled THEN 'source_granted' ELSE 'source_revoked' END);
  -- A newly corrected grant can recover only rights-blocked work, never failed QC.
  IF p_enabled THEN
    UPDATE public.managed_generation_jobs SET state='pending',next_attempt_at=now()
      WHERE account_id=p_account AND (asset_id IS NULL OR asset_id=p_asset)
        AND state='blocked' AND error_code='generation_ineligible' AND attempts<3;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_configure(
  p_actor uuid,p_enabled boolean,p_max_active integer,p_daily integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-generation',0));
  UPDATE public.managed_generation_control SET enabled=p_enabled,max_active=p_max_active,max_daily_claims=p_daily;
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_eligible(p_account uuid,p_asset uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.managed_accounts a
    JOIN public.managed_workspaces w ON w.workspace_id=a.workspace_id AND w.customer_user_id=a.customer_user_id
    JOIN public.managed_asset_grants g ON g.account_id=a.id AND g.asset_id=p_asset
    JOIN public.managed_raw_assets s ON s.id=g.asset_id
    JOIN public.managed_generation_control c ON c.enabled
    WHERE a.id=p_account AND a.rights_confirmed AND w.enabled AND g.enabled AND g.expires_at>now()
      AND public.managed_customer_eligible(a.customer_user_id)
      AND lower(a.brand_inputs->>'language') IN ('en','english')
  );
$$;
CREATE OR REPLACE FUNCTION public.managed_generation_enqueue()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.managed_generation_control WHERE enabled) THEN RETURN 0; END IF;
  INSERT INTO public.managed_generation_jobs(batch_id,account_id,ordinal)
    SELECT b.id,b.account_id,i FROM public.managed_batches b
    CROSS JOIN LATERAL generate_series(1,b.target_count) i
    WHERE b.blocked_reason='renderer_not_configured'
    ON CONFLICT(batch_id,ordinal) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  UPDATE public.managed_accounts a SET blocked_reason='generation_pending'
    WHERE blocked_reason='renderer_not_configured'
      AND EXISTS(SELECT 1 FROM public.managed_generation_jobs j WHERE j.account_id=a.id AND j.state='pending');
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_claim(p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.managed_generation_control; j public.managed_generation_jobs;
  chosen uuid; a public.managed_accounts; s public.managed_raw_assets;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'invalid_worker'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-generation',0));
  SELECT * INTO c FROM public.managed_generation_control;
  IF NOT c.enabled THEN RETURN NULL; END IF;
  UPDATE public.managed_generation_jobs SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'blocked' END,
    lease_token=NULL,lease_until=NULL,error_code='lease_expired'
    WHERE state='running' AND lease_until<=now();
  UPDATE public.managed_generation_jobs pending_job SET state='blocked',error_code='generation_ineligible'
    WHERE state='pending' AND NOT EXISTS(SELECT 1 FROM public.managed_asset_grants g
      WHERE g.account_id=pending_job.account_id AND (pending_job.asset_id IS NULL OR pending_job.asset_id=g.asset_id)
        AND public.managed_generation_eligible(pending_job.account_id,g.asset_id));
  UPDATE public.managed_accounts current_account SET blocked_reason='generation_ineligible'
    WHERE EXISTS(SELECT 1 FROM public.managed_generation_jobs x WHERE x.account_id=current_account.id
      AND x.state='blocked' AND x.error_code='generation_ineligible')
    AND NOT EXISTS(SELECT 1 FROM public.managed_generation_jobs x WHERE x.account_id=current_account.id AND x.state='running');
  IF (SELECT count(*) FROM public.managed_generation_jobs WHERE state='running')>=c.max_active
    OR (SELECT count(*) FROM public.managed_generation_attempts
      WHERE claimed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=c.max_daily_claims
    THEN RETURN NULL; END IF;
  SELECT * INTO j FROM public.managed_generation_jobs WHERE state='pending' AND next_attempt_at<=now()
    AND attempts<3 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT g.asset_id INTO chosen FROM public.managed_asset_grants g
    WHERE g.account_id=j.account_id AND (j.asset_id IS NULL OR g.asset_id=j.asset_id)
      AND public.managed_generation_eligible(j.account_id,g.asset_id)
    ORDER BY (SELECT count(*) FROM public.managed_generation_jobs x WHERE x.asset_id=g.asset_id),g.asset_id LIMIT 1;
  UPDATE public.managed_generation_jobs SET state='running',asset_id=chosen,attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',error_code=NULL
    WHERE id=j.id RETURNING * INTO j;
  INSERT INTO public.managed_generation_attempts(token,job_id,worker) VALUES(j.lease_token,j.id,p_worker);
  SELECT * INTO a FROM public.managed_accounts WHERE id=j.account_id;
  SELECT * INTO s FROM public.managed_raw_assets WHERE id=chosen;
  UPDATE public.managed_accounts SET blocked_reason='generation_in_progress' WHERE id=a.id;
  RETURN to_jsonb(j)||jsonb_build_object('customer_user_id',a.customer_user_id,'blueprint',a.brand_inputs,
    'asset',s.source||jsonb_build_object('id',s.id));
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_fence(p_job uuid,p_token uuid)
RETURNS public.managed_generation_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.managed_generation_jobs;
BEGIN
  SELECT * INTO j FROM public.managed_generation_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.lease_token IS DISTINCT FROM p_token OR j.lease_until<=now()
    THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF NOT public.managed_generation_eligible(j.account_id,j.asset_id) THEN
    RAISE EXCEPTION 'generation_ineligible'; END IF;
  RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.managed_generation_renew(p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.managed_generation_fence(p_job,p_token);
  UPDATE public.managed_generation_jobs SET lease_until=now()+interval '10 minutes' WHERE id=p_job;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN ('lease_lost','generation_ineligible') THEN RETURN false; END IF;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_reserve(
  p_job uuid,p_token uuid,p_recipe jsonb,p_recipe_hash text,p_tokens text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.managed_generation_jobs; other record; intersection_n integer; union_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-generation',0));
  j:=public.managed_generation_fence(p_job,p_token);
  IF p_recipe_hash IS NULL OR p_recipe_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_recipe) IS DISTINCT FROM 'object' OR octet_length(p_recipe::text)>12000
    OR cardinality(p_tokens) NOT BETWEEN 5 AND 500 OR p_tokens IS NULL
    OR EXISTS(SELECT 1 FROM unnest(p_tokens) t WHERE t IS NULL OR t !~ '^[a-f0-9]{64}$')
    THEN RAISE EXCEPTION 'invalid_recipe'; END IF;
  IF j.recipe IS NOT NULL THEN
    IF j.recipe<>p_recipe OR j.recipe_hash<>p_recipe_hash OR j.tokens<>p_tokens THEN
      RAISE EXCEPTION 'recipe_conflict'; END IF;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.managed_generation_jobs WHERE asset_id=j.asset_id AND recipe IS NOT NULL)>=500
    THEN RAISE EXCEPTION 'source_variant_limit'; END IF;
  FOR other IN SELECT recipe_hash,tokens FROM public.managed_generation_jobs
    WHERE asset_id=j.asset_id AND recipe IS NOT NULL AND id<>j.id LOOP
    SELECT count(*) INTO intersection_n FROM (
      SELECT unnest(p_tokens) INTERSECT SELECT unnest(other.tokens)) q;
    SELECT count(*) INTO union_n FROM (
      SELECT unnest(p_tokens) UNION SELECT unnest(other.tokens)) q;
    IF other.recipe_hash=p_recipe_hash OR intersection_n::numeric/greatest(union_n,1)>=0.65 THEN
      RAISE EXCEPTION 'recipe_collision';
    END IF;
  END LOOP;
  UPDATE public.managed_generation_jobs SET recipe=p_recipe,recipe_hash=p_recipe_hash,tokens=p_tokens WHERE id=j.id;
END $$;

CREATE OR REPLACE FUNCTION public.managed_generation_complete(p_job uuid,p_token uuid,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.managed_generation_jobs; owner_id uuid; prefix text; other record; matches integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-generation',0));
  j:=public.managed_generation_fence(p_job,p_token);
  SELECT customer_user_id INTO owner_id FROM public.managed_accounts WHERE id=j.account_id;
  prefix:=owner_id||'/'||j.account_id||'/'||j.id||'/'||p_token||'/output.mp4';
  IF j.recipe IS NULL OR p_result IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'bucket' IS DISTINCT FROM 'managed-variants' OR p_result->>'object_key' IS DISTINCT FROM prefix
    OR COALESCE(p_result->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR p_result#>'{qc,technical_pass}' IS DISTINCT FROM 'true'::jsonb
    OR p_result#>'{qc,content_pass}' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_result->'fingerprints') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_result->'fingerprints')<>8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_result->'fingerprints') h WHERE h IS NULL OR h !~ '^[01]{64}$')
    THEN RAISE EXCEPTION 'quality_failed'; END IF;
  FOR other IN SELECT result FROM public.managed_generation_jobs WHERE state='quality_passed' LOOP
    IF other.result->>'sha256'=p_result->>'sha256' THEN RAISE EXCEPTION 'output_collision'; END IF;
    SELECT count(*) INTO matches FROM generate_series(0,7) i WHERE
      length(replace(((p_result->'fingerprints'->>i)::bit(64) #
        (other.result->'fingerprints'->>i)::bit(64))::text,'0',''))<=6;
    IF matches>=6 THEN RAISE EXCEPTION 'output_collision'; END IF;
  END LOOP;
  UPDATE public.managed_generation_jobs SET state='quality_passed',result=p_result,lease_until=NULL,error_code=NULL WHERE id=j.id;
  IF NOT EXISTS(SELECT 1 FROM public.managed_generation_jobs WHERE batch_id=j.batch_id AND state<>'quality_passed') THEN
    UPDATE public.managed_accounts SET blocked_reason='scheduler_not_configured' WHERE id=j.account_id;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.managed_generation_fail(
  p_job uuid,p_token uuid,p_reason text,p_retry boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.managed_generation_jobs;
BEGIN
  SELECT * INTO j FROM public.managed_generation_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.lease_token IS DISTINCT FROM p_token OR j.lease_until<=now()
    THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('render_failed','source_invalid','quality_failed','model_failed',
    'recipe_collision','output_collision','generation_ineligible','infrastructure_error','lease_lost')
    OR p_retry IS NULL THEN RAISE EXCEPTION 'invalid_failure'; END IF;
  UPDATE public.managed_generation_jobs SET state=CASE WHEN p_retry AND attempts<3
    AND p_reason IN ('model_failed','infrastructure_error') THEN 'pending' ELSE 'blocked' END,
    error_code=p_reason,next_attempt_at=now()+interval '5 minutes',lease_until=NULL,lease_token=NULL WHERE id=j.id;
  UPDATE public.managed_accounts SET blocked_reason=p_reason WHERE id=j.account_id;
END $$;
DO $$
DECLARE name text; fn record;
BEGIN
  FOREACH name IN ARRAY ARRAY['managed_raw_assets','managed_asset_grants','managed_generation_control',
    'managed_generation_jobs','managed_generation_attempts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',name);
  END LOOP;
  FOR fn IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND (proname LIKE 'managed_generation_%' OR proname IN ('managed_register_asset','managed_grant_asset')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
    IF fn.proname NOT IN ('managed_generation_fence','managed_generation_eligible') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
    END IF;
  END LOOP;
END $$;
-- Storage uses its own RLS. Private buckets alone do not override broad existing
-- authenticated-object policies, so add an explicit restrictive boundary.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('managed-raw','managed-variants') AND public) THEN
      RAISE EXCEPTION 'managed_bucket_already_public';
    END IF;
    INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
      VALUES('managed-raw','managed-raw',false,134217728,ARRAY['video/mp4']),
        ('managed-variants','managed-variants',false,67108864,ARRAY['video/mp4'])
      ON CONFLICT(id) DO NOTHING;
    DROP POLICY IF EXISTS managed_media_server_only ON storage.objects;
    CREATE POLICY managed_media_server_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
      USING(bucket_id NOT IN ('managed-raw','managed-variants'))
      WITH CHECK(bucket_id NOT IN ('managed-raw','managed-variants'));
  END IF;
END $$;
COMMIT;
