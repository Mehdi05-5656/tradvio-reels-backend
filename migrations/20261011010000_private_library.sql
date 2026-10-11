-- Private full-library rendering ONLY. No provider calls or publication permission.
-- Coexists with managed_generation; does not relax its editorial/uniqueness rules.
BEGIN;
CREATE TABLE IF NOT EXISTS public.library_sources(
  sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  source jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.library_control(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  max_active integer NOT NULL DEFAULT 1 CHECK(max_active BETWEEN 1 AND 4),
  max_daily_claims integer NOT NULL DEFAULT 30 CHECK(max_daily_claims BETWEEN 1 AND 20000)
);
INSERT INTO public.library_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.library_variants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL REFERENCES public.publer_account_ownership(publer_account_id),
  owner_user_id uuid NOT NULL,
  workspace_id text NOT NULL,
  source_sha256 text NOT NULL REFERENCES public.library_sources(sha256),
  recipe_version text NOT NULL CHECK(recipe_version='legacy-light-account-v2'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','blocked','rendered_private')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_token uuid,lease_until timestamptz,
  result jsonb,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,source_sha256,recipe_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS library_output_hash ON public.library_variants((result->>'sha256'))
  WHERE state='rendered_private';
CREATE INDEX IF NOT EXISTS library_pending ON public.library_variants(state,created_at);
CREATE TABLE IF NOT EXISTS public.library_attempts(
  token uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES public.library_variants(id),
  worker text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_attempt_day ON public.library_attempts(created_at);
CREATE TABLE IF NOT EXISTS public.library_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.library_variants(id),
  account_id text NOT NULL REFERENCES public.publer_account_ownership(publer_account_id),
  event text NOT NULL CHECK(event IN ('queued','render_started','rendered_private','blocked','lease_expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_event_account ON public.library_events(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.library_import_tickets(
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL REFERENCES public.library_sources(sha256),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE OR REPLACE FUNCTION public.library_issue_import(p_actor uuid,p_source text,p_token_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
    OR NOT EXISTS(SELECT 1 FROM public.library_sources WHERE sha256=p_source AND enabled)
    THEN RAISE EXCEPTION 'invalid_ticket';END IF;
  INSERT INTO public.library_import_tickets(token_hash,source_sha256,expires_at)
    VALUES(p_token_hash,p_source,now()+interval '15 minutes');
END $$;
CREATE OR REPLACE FUNCTION public.library_redeem_import(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_hash text;result jsonb;
BEGIN
  UPDATE public.library_import_tickets SET redeemed_at=now()
    WHERE token_hash=p_token_hash AND expires_at>now() AND redeemed_at IS NULL
    RETURNING source_sha256 INTO source_hash;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT source INTO result FROM public.library_sources WHERE sha256=source_hash AND enabled;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.library_register_source(p_actor uuid,p_source jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old jsonb;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF p_source IS NULL OR jsonb_typeof(p_source)<>'object'
    OR NOT(p_source ?& ARRAY['sha256','bytes','duration','object_key','provenance','permission_ref','source_video_id','source_handle'])
    OR (p_source-ARRAY['sha256','bytes','duration','object_key','provenance','permission_ref','source_video_id','source_handle'])<>'{}'
    OR coalesce(p_source->>'source_video_id','') !~ '^[0-9]{10,30}$'
    OR coalesce(p_source->>'source_handle','') !~ '^[A-Za-z0-9_.-]{1,100}$'
    OR coalesce(p_source->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR p_source->>'object_key' IS DISTINCT FROM 'originals/'||(p_source->>'sha256')||'.mp4'
    OR jsonb_typeof(p_source->'bytes') IS DISTINCT FROM 'number'
    OR (p_source->>'bytes')::numeric NOT BETWEEN 1 AND 134217728
    OR trunc((p_source->>'bytes')::numeric)<>(p_source->>'bytes')::numeric
    OR jsonb_typeof(p_source->'duration') IS DISTINCT FROM 'number'
    OR (p_source->>'duration')::numeric NOT BETWEEN 1 AND 600
    OR jsonb_typeof(p_source->'provenance') IS DISTINCT FROM 'string'
    OR length(trim(p_source->>'provenance')) NOT BETWEEN 10 AND 1000
    OR jsonb_typeof(p_source->'permission_ref') IS DISTINCT FROM 'string'
    OR length(trim(p_source->>'permission_ref')) NOT BETWEEN 1 AND 500
    THEN RAISE EXCEPTION 'invalid_source'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  SELECT source INTO old FROM public.library_sources WHERE sha256=p_source->>'sha256';
  IF FOUND THEN
    IF old<>p_source THEN RAISE EXCEPTION 'source_conflict';END IF;
    RETURN;
  END IF;
  INSERT INTO public.library_sources(sha256,source) VALUES(p_source->>'sha256',p_source);
END $$;

CREATE OR REPLACE FUNCTION public.library_plan(p_actor uuid,p_account text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.publer_account_ownership;n integer;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  SELECT * INTO a FROM public.publer_account_ownership WHERE publer_account_id=p_account FOR SHARE;
  IF NOT FOUND OR a.owner_user_id IS DISTINCT FROM p_actor OR p_account !~ '^[a-f0-9]{24}$'
    THEN RAISE EXCEPTION 'account_not_owned';END IF;
  WITH added AS(
    INSERT INTO public.library_variants(account_id,owner_user_id,workspace_id,source_sha256,recipe_version)
    SELECT p_account,a.owner_user_id,a.workspace_id,sha256,'legacy-light-account-v2'
    FROM public.library_sources WHERE enabled
    ON CONFLICT(account_id,source_sha256,recipe_version) DO NOTHING RETURNING id,account_id
  ) INSERT INTO public.library_events(variant_id,account_id,event) SELECT id,account_id,'queued' FROM added;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.library_configure(p_actor uuid,p_enabled boolean,p_max_active integer,p_daily integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  UPDATE public.library_control SET enabled=p_enabled,max_active=p_max_active,max_daily_claims=p_daily;
END $$;

CREATE OR REPLACE FUNCTION public.library_claim(p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.library_control;j public.library_variants;s jsonb;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'invalid_worker';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  SELECT * INTO c FROM public.library_control;
  IF c.enabled IS DISTINCT FROM true THEN RETURN NULL;END IF;
  WITH expired AS(
    UPDATE public.library_variants SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'blocked' END,
      lease_token=NULL,lease_until=NULL,error_code='lease_expired',updated_at=now()
    WHERE state='running' AND lease_until<=now() RETURNING id,account_id
  ) INSERT INTO public.library_events(variant_id,account_id,event) SELECT id,account_id,'lease_expired' FROM expired;
  IF (SELECT count(*) FROM public.library_variants WHERE state='running')>=c.max_active
    OR (SELECT count(*) FROM public.library_attempts WHERE created_at>=
      date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=c.max_daily_claims THEN RETURN NULL;END IF;
  SELECT v.* INTO j FROM public.library_variants v
    JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    JOIN public.publer_account_ownership a ON a.publer_account_id=v.account_id
      AND a.owner_user_id=v.owner_user_id AND a.workspace_id=v.workspace_id
    WHERE v.state='pending' AND v.attempts<3
    ORDER BY v.created_at,v.id LIMIT 1 FOR UPDATE OF v SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL;END IF;
  UPDATE public.library_variants SET state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+interval '10 minutes',updated_at=now(),error_code=NULL
    WHERE id=j.id RETURNING * INTO j;
  INSERT INTO public.library_attempts VALUES(j.lease_token,j.id,p_worker,now());
  INSERT INTO public.library_events(variant_id,account_id,event) VALUES(j.id,j.account_id,'render_started');
  SELECT source INTO s FROM public.library_sources WHERE sha256=j.source_sha256;
  RETURN to_jsonb(j)||jsonb_build_object('source',s);
END $$;

CREATE OR REPLACE FUNCTION public.library_fence(p_job uuid,p_token uuid)
RETURNS public.library_variants LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.library_variants;
BEGIN
  -- Global order also serializes configure against the completion commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('private-library',0));
  SELECT * INTO j FROM public.library_variants WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR p_token IS NULL OR j.lease_token IS DISTINCT FROM p_token
    OR j.lease_until IS NULL OR j.lease_until<=now()
    THEN RAISE EXCEPTION 'lease_lost';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.library_control WHERE enabled)
    OR NOT EXISTS(SELECT 1 FROM public.library_sources WHERE sha256=j.source_sha256 AND enabled)
    OR NOT EXISTS(SELECT 1 FROM public.publer_account_ownership WHERE publer_account_id=j.account_id
      AND owner_user_id=j.owner_user_id AND workspace_id=j.workspace_id)
    THEN RAISE EXCEPTION 'render_ineligible';END IF;
  RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.library_renew(p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.library_fence(p_job,p_token);
  UPDATE public.library_variants SET lease_until=now()+interval '10 minutes' WHERE id=p_job;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN ('lease_lost','render_ineligible') THEN RETURN false;END IF;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION public.library_complete(p_job uuid,p_token uuid,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.library_variants;r jsonb;
BEGIN
  j:=public.library_fence(p_job,p_token);r:=p_result->'recipe';
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object'
    OR octet_length(p_result::text)>12000
    OR p_result->>'object_key' IS DISTINCT FROM 'library/'||j.owner_user_id||'/'||j.account_id||'/'||j.id||'/'||p_token||'.mp4'
    OR coalesce(p_result->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR p_result->'full_decode_passed' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_result->'bytes') IS DISTINCT FROM 'number'
    OR (p_result->>'bytes')::numeric NOT BETWEEN 1 AND 67108863
    OR jsonb_typeof(p_result->'duration') IS DISTINCT FROM 'number'
    OR (p_result->>'duration')::numeric NOT BETWEEN 0.5 AND 620
    OR jsonb_typeof(p_result->'render_seconds') IS DISTINCT FROM 'number'
    OR (p_result->>'render_seconds')::numeric NOT BETWEEN 0 AND 600
    OR jsonb_typeof(r) IS DISTINCT FROM 'object'
    OR r->>'version' IS DISTINCT FROM j.recipe_version
    OR r->>'source_sha256' IS DISTINCT FROM j.source_sha256
    OR r->>'account_id' IS DISTINCT FROM j.account_id
    OR r->'reviewed_corner_masks' IS DISTINCT FROM 'false'::jsonb
    OR r->>'trim_policy' IS DISTINCT FROM 'leading_silence_only_with_30ms_guard'
    OR jsonb_typeof(r->'crop_per_edge') IS DISTINCT FROM 'number'
    OR (r->>'crop_per_edge')::numeric NOT BETWEEN .01 AND .02
    OR jsonb_typeof(r->'speed') IS DISTINCT FROM 'number'
    OR (r->>'speed')::numeric NOT BETWEEN .97 AND 1.03
    OR jsonb_typeof(r->'trim_start') IS DISTINCT FROM 'number'
    OR (r->>'trim_start')::numeric NOT BETWEEN 0 AND .3
    OR jsonb_typeof(r->'requested_trim_start') IS DISTINCT FROM 'number'
    OR (r->>'requested_trim_start')::numeric NOT BETWEEN .1 AND .3
    OR (r->>'trim_start')::numeric>(r->>'requested_trim_start')::numeric
    THEN RAISE EXCEPTION 'invalid_result';END IF;
  UPDATE public.library_variants SET state='rendered_private',result=p_result,
    lease_token=NULL,lease_until=NULL,updated_at=now(),error_code=NULL WHERE id=j.id;
  INSERT INTO public.library_events(variant_id,account_id,event) VALUES(j.id,j.account_id,'rendered_private');
END $$;

CREATE OR REPLACE FUNCTION public.library_fail(p_job uuid,p_token uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.library_variants;
BEGIN
  j:=public.library_fence(p_job,p_token);
  IF p_reason IS NULL OR p_reason NOT IN ('source_invalid','render_failed','upload_uncertain','infrastructure_error')
    THEN RAISE EXCEPTION 'invalid_failure';END IF;
  -- Upload uncertainty is held, never blindly replayed.
  UPDATE public.library_variants SET state='blocked',error_code=p_reason,
    lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=j.id;
  INSERT INTO public.library_events(variant_id,account_id,event) VALUES(j.id,j.account_id,'blocked');
END $$;

CREATE OR REPLACE FUNCTION public.library_account_progress(p_actor uuid,p_account text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.publer_account_ownership; counts jsonb;events jsonb;
BEGIN
  SELECT * INTO a FROM public.publer_account_ownership WHERE publer_account_id=p_account;
  IF NOT FOUND OR p_actor IS NULL THEN RAISE EXCEPTION 'account_not_owned';END IF;
  IF a.owner_user_id<>p_actor THEN PERFORM public.managed_require_operator(p_actor);END IF;
  SELECT jsonb_build_object('total',count(*),'pending',count(*) FILTER(WHERE state='pending'),
    'running',count(*) FILTER(WHERE state='running'),'blocked',count(*) FILTER(WHERE state='blocked'),
    'rendered_private',count(*) FILTER(WHERE state='rendered_private')) INTO counts
    FROM public.library_variants WHERE account_id=p_account AND owner_user_id=a.owner_user_id AND workspace_id=a.workspace_id;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC,e.id),'[]') INTO events FROM(
    SELECT e.id,e.event,e.created_at FROM public.library_events e
      JOIN public.library_variants v ON v.id=e.variant_id
      WHERE e.account_id=p_account AND v.owner_user_id=a.owner_user_id AND v.workspace_id=a.workspace_id
      ORDER BY e.created_at DESC,e.id LIMIT 50
  ) e;
  RETURN jsonb_build_object('counts',counts,'events',events,
    'generation_enabled',(SELECT enabled FROM public.library_control),'publishing_enabled',false);
END $$;

DO $$
DECLARE name text;fn record;
BEGIN
  FOREACH name IN ARRAY ARRAY['library_sources','library_control','library_variants','library_attempts','library_events','library_import_tickets'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',name);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',name);
  END LOOP;
  FOR fn IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname LIKE 'library_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
    IF fn.proname<>'library_fence' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);END IF;
  END LOOP;
END $$;
COMMIT;
