-- Extend the existing publisher deliberately; do not bypass managed handoff gates.
BEGIN;
ALTER TABLE public.publer_slot_config DROP CONSTRAINT IF EXISTS publer_slot_config_slot_check;
ALTER TABLE public.publer_slot_config ADD CONSTRAINT publer_slot_config_slot_check
  CHECK(phone_slot IN ('phone_a','phone_b','tiktok_tradvio') OR
    (phone_slot='library_'||publer_account_id AND publer_account_id ~ '^[a-f0-9]{24}$' AND owner_user_id IS NOT NULL));
ALTER TABLE public.publer_slot_config ADD COLUMN IF NOT EXISTS publish_after timestamptz;
ALTER TABLE public.publer_slot_config ADD COLUMN IF NOT EXISTS publication_settings jsonb;
ALTER TABLE public.reels_manual_queue DROP CONSTRAINT IF EXISTS reels_manual_queue_phone_slot_check;
ALTER TABLE public.reels_manual_queue ADD CONSTRAINT reels_manual_queue_phone_slot_check
  CHECK(phone_slot IN ('phone_a','phone_b','tiktok_tradvio') OR phone_slot ~ '^library_[a-f0-9]{24}$');
ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS storage_bucket text NOT NULL DEFAULT 'reels'
  CHECK(storage_bucket IN ('reels','managed-variants'));
ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS library_variant_id uuid REFERENCES public.library_variants(id);
ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS library_caption text;
ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS library_experiment_arm text CHECK(library_experiment_arm IN ('A','B'));
CREATE UNIQUE INDEX IF NOT EXISTS queue_library_variant_unique ON public.reels_manual_queue(library_variant_id)
  WHERE library_variant_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.library_publishing_policy(
  account_id text PRIMARY KEY REFERENCES public.publer_account_ownership(publer_account_id),
  owner_user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  daily_target integer NOT NULL CHECK(daily_target BETWEEN 1 AND 8),
  minimum_ready integer NOT NULL CHECK(minimum_ready BETWEEN 3 AND 30),
  settings jsonb NOT NULL,
  approval_ref text NOT NULL,
  gate_account text REFERENCES public.library_publishing_policy(account_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.library_experiments(
  id text PRIMARY KEY,hypothesis text NOT NULL,primary_metric text NOT NULL,
  assignment_method text NOT NULL,minimum_per_arm integer NOT NULL,registered_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.library_experiments(id,hypothesis,primary_metric,assignment_method,minimum_per_arm)
VALUES('caption-question-v1','A question caption changes fixed-age video views compared with a declarative process caption.',
  'log1p views at first observation between 24 and 30 hours after verified publication',
  'Pre-outcome deterministic hash randomization by original source SHA and destination; analyze with source/account controls. No winner before minimum sample and uncertainty review.',100)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.library_arm_publishing(p_actor uuid,p_account text,p_start timestamptz,
  p_daily integer,p_min_ready integer,p_settings jsonb,p_approval text,p_gate text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.publer_account_ownership;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('library-publishing',0));
  SELECT * INTO a FROM public.publer_account_ownership WHERE publer_account_id=p_account FOR SHARE;
  IF NOT FOUND OR a.owner_user_id<>p_actor OR p_account !~ '^[a-f0-9]{24}$'
    OR NOT EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=a.workspace_id)
    OR EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=p_account AND phone_slot NOT LIKE 'library_%')
    THEN RAISE EXCEPTION 'account_not_eligible';END IF;
  IF p_start IS NULL OR p_start<now()+interval '1 hour' OR p_start>now()+interval '7 days'
    OR p_daily IS NULL OR p_daily NOT BETWEEN 1 AND 8 OR p_min_ready IS NULL OR p_min_ready NOT BETWEEN 3 AND 30
    OR p_approval IS NULL OR length(trim(p_approval)) NOT BETWEEN 10 AND 1000
    OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_policy';END IF;
  IF a.platform='instagram' THEN
    IF p_settings<>'{"feed":true}'::jsonb THEN RAISE EXCEPTION 'invalid_platform_settings';END IF;
  ELSIF a.platform='tiktok' THEN
    IF p_settings<>'{"privacy":"PUBLIC_TO_EVERYONE","comment":true,"duet":false,"stitch":false,"promotional":true,"paid":false}'::jsonb
      THEN RAISE EXCEPTION 'invalid_platform_settings';END IF;
  ELSE RAISE EXCEPTION 'unsupported_platform';END IF;
  IF p_gate IS NOT NULL AND (p_gate=p_account OR NOT EXISTS(
    SELECT 1 FROM public.library_publishing_policy policy JOIN public.publer_account_ownership own ON own.publer_account_id=policy.account_id
    WHERE policy.account_id=p_gate AND policy.owner_user_id=a.owner_user_id AND own.workspace_id=a.workspace_id
      AND own.owner_user_id=a.owner_user_id AND policy.enabled AND policy.gate_account IS NULL))
    THEN RAISE EXCEPTION 'invalid_launch_gate';END IF;
  INSERT INTO public.library_publishing_policy(account_id,owner_user_id,enabled,not_before,expires_at,daily_target,minimum_ready,settings,approval_ref,gate_account)
    VALUES(p_account,a.owner_user_id,true,p_start,p_start+interval '365 days',p_daily,p_min_ready,p_settings,p_approval,p_gate)
    ON CONFLICT(account_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.library_publishing_policy WHERE account_id=p_account AND owner_user_id=a.owner_user_id
    AND not_before=p_start AND daily_target=p_daily AND minimum_ready=p_min_ready AND settings=p_settings
    AND approval_ref=p_approval AND gate_account IS NOT DISTINCT FROM p_gate AND enabled) THEN RAISE EXCEPTION 'policy_conflict';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.library_launch_gate_passed(p_account text,p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p_account IS NULL OR EXISTS(
    SELECT 1 FROM public.publer_publish_log l JOIN public.reels_manual_queue q ON q.id=l.queue_id
    JOIN public.library_variants v ON v.id=q.library_variant_id
    JOIN public.publer_account_ownership a ON a.publer_account_id=v.account_id AND a.owner_user_id=v.owner_user_id
      AND a.workspace_id=v.workspace_id
    WHERE v.account_id=p_account AND v.owner_user_id=p_owner
      AND l.phone_slot='library_'||p_account AND q.phone_slot=l.phone_slot
      AND l.status='published' AND l.publer_post_id IS NOT NULL AND q.status='posted'
      AND q.content_video_hash=v.result->>'sha256');
$$;

CREATE OR REPLACE FUNCTION public.library_feed_publishers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p record;n integer;total_n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('library-publishing',0));
  FOR p IN SELECT policy.*,a.workspace_id,a.platform,a.label FROM public.library_publishing_policy policy
    JOIN public.publer_account_ownership a ON a.publer_account_id=policy.account_id AND a.owner_user_id=policy.owner_user_id
    WHERE policy.enabled AND policy.expires_at>now()
      AND public.library_launch_gate_passed(policy.gate_account,policy.owner_user_id)
      AND EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=a.workspace_id)
      AND (SELECT count(*) FROM public.library_variants v JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
        WHERE v.account_id=policy.account_id AND v.owner_user_id=policy.owner_user_id AND v.workspace_id=a.workspace_id
          AND v.state='rendered_private' AND v.result->'full_decode_passed'='true')>=policy.minimum_ready
    ORDER BY policy.account_id LOOP
    IF EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=p.account_id AND phone_slot NOT LIKE 'library_%')
      THEN RAISE EXCEPTION 'legacy_destination_conflict';END IF;
    INSERT INTO public.publer_slot_config(phone_slot,publer_account_id,provider,handle,daily_target,paused,owner_user_id,publish_after,publication_settings)
      VALUES('library_'||p.account_id,p.account_id,p.platform,p.label,p.daily_target,false,p.owner_user_id,p.not_before,p.settings)
      ON CONFLICT(phone_slot) DO NOTHING;
    -- Never unpause a row manually paused by the operator.
    IF NOT EXISTS(SELECT 1 FROM public.publer_slot_config WHERE phone_slot='library_'||p.account_id
      AND publer_account_id=p.account_id AND owner_user_id=p.owner_user_id AND provider=p.platform
      AND publication_settings=p.settings AND publish_after=p.not_before)
      THEN RAISE EXCEPTION 'publisher_configuration_conflict';END IF;
    INSERT INTO public.reels_manual_queue(phone_slot,source_handle,source_video_id,filename,storage_path,
      duration_sec,size_bytes,status,source_aweme_id,content_video_hash,storage_bucket,library_variant_id,library_caption,library_experiment_arm)
    SELECT 'library_'||p.account_id,s.source->>'source_handle',s.source->>'source_video_id',
      p.account_id||'__'||(s.source->>'source_video_id')||'.mp4',v.result->>'object_key',
      (v.result->>'duration')::numeric,(v.result->>'bytes')::bigint,'pending',s.source->>'source_video_id',
      v.result->>'sha256','managed-variants',v.id,
      CASE WHEN strpos('0123456789abcdef',substr(md5(v.source_sha256||':'||v.account_id||':caption-question-v1'),1,1))%2=0
        THEN 'Trading takes discipline. Focus on the process, not one outcome.'
        ELSE 'What would you review after this trading session? Focus on the process, not one outcome.' END
        ||' Trading involves risk. #Trading #TradingEducation #RiskManagement',
      CASE WHEN strpos('0123456789abcdef',substr(md5(v.source_sha256||':'||v.account_id||':caption-question-v1'),1,1))%2=0 THEN 'A' ELSE 'B' END
    FROM public.library_variants v JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    WHERE v.account_id=p.account_id AND v.owner_user_id=p.owner_user_id AND v.workspace_id=p.workspace_id
      AND v.state='rendered_private' AND v.result->'full_decode_passed'='true'
      AND v.result->>'object_key' LIKE 'library/'||p.owner_user_id||'/'||p.account_id||'/'||v.id||'/%'
      AND NOT EXISTS(SELECT 1 FROM public.reels_manual_queue q WHERE q.library_variant_id=v.id)
    ORDER BY md5(v.source_sha256||':'||v.account_id||':queue-order-v1')
    LIMIT 200
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n=ROW_COUNT;total_n:=total_n+n;
  END LOOP;
  RETURN total_n;
END $$;

CREATE OR REPLACE FUNCTION public.library_publication_receipt(p_queue uuid,p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('caption',q.library_caption,'settings',p.settings,
    'storage_bucket',q.storage_bucket,'storage_path',q.storage_path,'variant_id',v.id,
    'experiment_id','caption-question-v1','experiment_arm',q.library_experiment_arm)
  FROM public.reels_manual_queue q
    JOIN public.library_variants v ON v.id=q.library_variant_id
    JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    JOIN public.library_publishing_policy p ON p.account_id=v.account_id AND p.owner_user_id=v.owner_user_id
    JOIN public.publer_account_ownership a ON a.publer_account_id=p.account_id AND a.owner_user_id=p.owner_user_id
      AND a.workspace_id=v.workspace_id
    JOIN public.publer_slot_config c ON c.phone_slot=q.phone_slot AND c.publer_account_id=a.publer_account_id
      AND c.owner_user_id=a.owner_user_id AND c.provider=a.platform
  WHERE q.id=p_queue AND a.publer_account_id=p_account AND q.phone_slot='library_'||p_account
    AND p.enabled AND p.expires_at>now() AND now()>=p.not_before AND c.publish_after=p.not_before
    AND public.library_launch_gate_passed(p.gate_account,p.owner_user_id)
    AND NOT c.paused AND c.publication_settings=p.settings AND q.storage_bucket='managed-variants'
    AND q.storage_path=v.result->>'object_key' AND q.content_video_hash=v.result->>'sha256'
    AND q.status IN ('pending','publer_publishing') AND v.state='rendered_private' AND v.result->'full_decode_passed'='true'
    AND length(q.library_caption) BETWEEN 20 AND 800 AND q.library_experiment_arm IN ('A','B');
$$;
CREATE OR REPLACE FUNCTION public.library_account_progress(p_actor uuid,p_account text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.publer_account_ownership; counts jsonb;events jsonb;p public.library_publishing_policy;
BEGIN
  SELECT * INTO a FROM public.publer_account_ownership WHERE publer_account_id=p_account;
  IF NOT FOUND OR p_actor IS NULL THEN RAISE EXCEPTION 'account_not_owned';END IF;
  IF a.owner_user_id<>p_actor THEN PERFORM public.managed_require_operator(p_actor);END IF;
  SELECT jsonb_build_object('total',count(*),'pending',count(*) FILTER(WHERE state='pending'),
    'running',count(*) FILTER(WHERE state='running'),'blocked',count(*) FILTER(WHERE state='blocked'),
    'rendered_private',count(*) FILTER(WHERE state='rendered_private')) INTO counts
    FROM public.library_variants WHERE account_id=p_account AND owner_user_id=a.owner_user_id AND workspace_id=a.workspace_id;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC,e.id),'[]') INTO events FROM(
    SELECT e.id,e.event,e.created_at FROM public.library_events e JOIN public.library_variants v ON v.id=e.variant_id
      WHERE e.account_id=p_account AND v.owner_user_id=a.owner_user_id AND v.workspace_id=a.workspace_id
      ORDER BY e.created_at DESC,e.id LIMIT 50
  ) e;
  SELECT * INTO p FROM public.library_publishing_policy WHERE account_id=p_account AND owner_user_id=a.owner_user_id;
  RETURN jsonb_build_object('counts',counts,'events',events,
    'generation_enabled',(SELECT enabled FROM public.library_control),
    'publishing_enabled',coalesce(p.enabled AND p.expires_at>now(),false),
    'not_before',p.not_before,'minimum_ready',p.minimum_ready,
    'waiting_for_pilot',NOT public.library_launch_gate_passed(p.gate_account,a.owner_user_id));
END $$;
DO $$
DECLARE n text;f record;
BEGIN
  FOREACH n IN ARRAY ARRAY['library_publishing_policy','library_experiments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',n);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',n);
  END LOOP;
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('library_arm_publishing','library_feed_publishers','library_publication_receipt','library_launch_gate_passed') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $$;
COMMIT;
