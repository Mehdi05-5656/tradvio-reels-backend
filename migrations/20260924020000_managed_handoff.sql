-- STAGED: isolated outbox. Applying this never enables an account or sends HTTP.
BEGIN;
ALTER TABLE public.managed_accounts DROP CONSTRAINT IF EXISTS managed_accounts_publishing_enabled_check;
CREATE TABLE IF NOT EXISTS public.managed_handoff_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  daily_claims integer NOT NULL DEFAULT 100 CHECK(daily_claims BETWEEN 1 AND 500),
  last_claim_at timestamptz
);
INSERT INTO public.managed_handoff_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.managed_handoff_approvals (
  account_id uuid PRIMARY KEY REFERENCES public.managed_accounts(id),
  enabled boolean NOT NULL DEFAULT false,
  approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 500),
  expires_at timestamptz NOT NULL,
  publication_settings jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS public.managed_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL UNIQUE REFERENCES public.managed_generation_jobs(id),
  account_id uuid NOT NULL REFERENCES public.managed_accounts(id),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id),
  workspace_id text NOT NULL,
  publer_account_id text NOT NULL,
  platform text NOT NULL CHECK(platform IN ('instagram','tiktok')),
  publication_settings jsonb NOT NULL DEFAULT '{}',
  caption text NOT NULL,
  artifact jsonb NOT NULL,
  timezone text NOT NULL,
  local_date date NOT NULL,
  local_time text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN
    ('reserved','upload_sending','upload_wait','media_ready','submit_sending','submit_wait',
     'confirming','scheduled','published','failed','held','blocked')),
  lease_token uuid,lease_until timestamptz,
  upload_job_id text,submit_job_id text,post_id text,
  media jsonb,post_link text,
  error_code text,remote_review_required boolean NOT NULL DEFAULT false,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,local_date,local_time)
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_handoff_post_unique ON public.managed_handoffs(workspace_id,post_id)
  WHERE post_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.managed_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id uuid REFERENCES public.managed_handoffs(id),
  actor uuid,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS managed_handoff_due ON public.managed_handoffs(next_check_at,state);

CREATE OR REPLACE FUNCTION public.managed_handoff_slots(p_policy jsonb,p_after timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH local_slots AS (
    SELECT ((p_after AT TIME ZONE (p_policy->>'timezone'))::date+d)::date AS local_day,
      v.value time_text,
      ((p_after AT TIME ZONE (p_policy->>'timezone'))::date+d)+v.value::time wall
    FROM generate_series(0,13) d CROSS JOIN jsonb_array_elements_text(p_policy->'slot_times') v
  ), converted AS (
    SELECT *,wall AT TIME ZONE (p_policy->>'timezone') instant FROM local_slots
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('local_date',local_day,'local_time',time_text,'scheduled_at',instant)
    ORDER BY instant),'[]'::jsonb) FROM converted
    WHERE instant>=p_after AND instant AT TIME ZONE (p_policy->>'timezone')=wall;
$$;

CREATE OR REPLACE FUNCTION public.managed_handoff_activate(
  p_actor uuid,p_account uuid,p_enabled boolean,p_approval text,p_expires timestamptz,p_settings jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE acct public.managed_accounts; remote_count integer;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-handoff',0));
  SELECT * INTO acct FROM public.managed_accounts WHERE id=p_account FOR UPDATE;
  IF NOT FOUND OR p_enabled IS NULL OR p_approval IS NULL OR length(trim(p_approval)) NOT BETWEEN 1 AND 500
    OR p_expires IS NULL THEN RAISE EXCEPTION 'invalid_activation'; END IF;
  IF p_enabled AND (p_expires<now()+interval '1 hour' OR NOT acct.rights_confirmed
    OR NOT public.managed_customer_eligible(acct.customer_user_id)
    OR NOT EXISTS(SELECT 1 FROM public.managed_workspaces w WHERE w.workspace_id=acct.workspace_id AND w.enabled))
    THEN RAISE EXCEPTION 'activation_ineligible'; END IF;
  IF p_enabled THEN
    IF p_settings IS NULL OR jsonb_typeof(p_settings)<>'object' THEN RAISE EXCEPTION 'invalid_publication_settings'; END IF;
    IF acct.platform='instagram' AND ((p_settings-ARRAY['feed'])<>'{}'::jsonb
      OR jsonb_typeof(p_settings->'feed') IS DISTINCT FROM 'boolean') THEN RAISE EXCEPTION 'invalid_publication_settings'; END IF;
    IF acct.platform='tiktok' AND ((p_settings-ARRAY['privacy','comment','duet','stitch','promotional','paid'])<>'{}'::jsonb
      OR p_settings->>'privacy' IS DISTINCT FROM 'PUBLIC_TO_EVERYONE'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['comment','duet','stitch','promotional','paid']) k
        WHERE jsonb_typeof(p_settings->k) IS DISTINCT FROM 'boolean')) THEN RAISE EXCEPTION 'invalid_publication_settings'; END IF;
  ELSE
    SELECT publication_settings INTO p_settings FROM public.managed_handoff_approvals WHERE account_id=p_account;
  END IF;
  INSERT INTO public.managed_handoff_approvals(account_id,enabled,approval_ref,expires_at,publication_settings)
    VALUES(p_account,p_enabled,p_approval,p_expires,COALESCE(p_settings,'{}'::jsonb))
    ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,approval_ref=EXCLUDED.approval_ref,
      expires_at=EXCLUDED.expires_at,publication_settings=EXCLUDED.publication_settings;
  UPDATE public.managed_accounts SET publishing_enabled=p_enabled WHERE id=p_account;
  IF NOT p_enabled THEN
    UPDATE public.managed_handoffs SET remote_review_required=true
      WHERE account_id=p_account AND state IN ('submit_sending','submit_wait','confirming','scheduled','held');
  END IF;
  SELECT count(*) INTO remote_count FROM public.managed_handoffs WHERE account_id=p_account AND remote_review_required;
  INSERT INTO public.managed_handoff_events(actor,event,detail)
    VALUES(p_actor,'account_activation',jsonb_build_object('account_id',p_account,'enabled',p_enabled,'approval_ref',p_approval));
  RETURN jsonb_build_object('enabled',p_enabled,'external_schedules_cancelled',false,'remote_review_count',remote_count);
END $$;
CREATE OR REPLACE FUNCTION public.managed_handoff_configure(p_actor uuid,p_enabled boolean,p_daily integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-handoff',0));
  UPDATE public.managed_handoff_control SET enabled=p_enabled,daily_claims=p_daily;
  IF NOT p_enabled THEN UPDATE public.managed_handoffs SET remote_review_required=true
    WHERE state IN ('submit_sending','submit_wait','confirming','scheduled','held'); END IF;
  INSERT INTO public.managed_handoff_events(actor,event,detail)
    VALUES(p_actor,'control_changed',jsonb_build_object('enabled',p_enabled,'daily_claims',p_daily));
END $$;
CREATE OR REPLACE FUNCTION public.managed_handoff_eligible(p_generation uuid,p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.managed_generation_jobs gen
    JOIN public.managed_accounts acct ON acct.id=gen.account_id
    JOIN public.managed_workspaces ws ON ws.workspace_id=acct.workspace_id AND ws.customer_user_id=acct.customer_user_id
    JOIN public.managed_handoff_approvals approval ON approval.account_id=acct.id
    JOIN public.managed_asset_grants g ON g.account_id=acct.id AND g.asset_id=gen.asset_id
    JOIN public.managed_handoff_control control ON control.enabled
    WHERE gen.id=p_generation AND gen.state='quality_passed'
      AND gen.result#>'{qc,technical_pass}'='true'::jsonb AND gen.result#>'{qc,content_pass}'='true'::jsonb
      AND gen.result->>'bucket'='managed-variants'
      AND gen.result->>'object_key'=acct.customer_user_id||'/'||acct.id||'/'||gen.id||'/'||gen.lease_token||'/output.mp4'
      AND gen.result->>'sha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(gen.recipe->'caption')='string' AND length(gen.recipe->>'caption') BETWEEN 20 AND 800
      AND acct.publishing_enabled AND acct.rights_confirmed AND ws.enabled
      AND approval.enabled AND approval.expires_at>greatest(now(),p_at)
      AND g.enabled AND g.expires_at>greatest(now(),p_at)
      AND public.managed_customer_eligible(acct.customer_user_id)
      -- An existing reservation must still be the exact approved artifact and
      -- destination, not merely refer to some currently eligible generation.
      AND NOT EXISTS(SELECT 1 FROM public.managed_handoffs h WHERE h.generation_id=gen.id AND
        (h.account_id IS DISTINCT FROM acct.id OR h.customer_user_id IS DISTINCT FROM acct.customer_user_id
          OR h.workspace_id IS DISTINCT FROM acct.workspace_id OR h.publer_account_id IS DISTINCT FROM acct.publer_account_id
          OR h.platform IS DISTINCT FROM acct.platform OR h.caption IS DISTINCT FROM gen.recipe->>'caption'
          OR h.publication_settings IS DISTINCT FROM approval.publication_settings
          OR h.artifact IS DISTINCT FROM gen.result OR h.timezone IS DISTINCT FROM acct.policy->>'timezone'
          OR NOT (acct.policy->'slot_times' ? h.local_time)))
      AND NOT EXISTS(SELECT 1 FROM public.publer_slot_config legacy WHERE legacy.publer_account_id=acct.publer_account_id)
      AND NOT EXISTS(SELECT 1 FROM public.publer_config legacy WHERE legacy.workspace_id=acct.workspace_id));
$$;
CREATE OR REPLACE FUNCTION public.managed_handoff_enqueue()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; slot jsonb; new_id uuid; n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-handoff',0));
  IF NOT EXISTS(SELECT 1 FROM public.managed_handoff_control WHERE enabled) THEN RETURN 0; END IF;
  FOR candidate IN SELECT gen.id generation_id,gen.recipe,gen.result,approval.publication_settings,acct.* FROM public.managed_generation_jobs gen
    JOIN public.managed_accounts acct ON acct.id=gen.account_id
    JOIN public.managed_handoff_approvals approval ON approval.account_id=acct.id
    WHERE gen.state='quality_passed' AND acct.publishing_enabled
      AND NOT EXISTS(SELECT 1 FROM public.managed_handoffs h WHERE h.generation_id=gen.id)
      -- Apply readiness before the bounded batch, so expired/unusable early
      -- generations do not permanently hide newer customers behind LIMIT.
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(public.managed_handoff_slots(acct.policy,now()+interval '1 hour')) s
        WHERE public.managed_handoff_eligible(gen.id,(s.value->>'scheduled_at')::timestamptz)
          AND NOT EXISTS(SELECT 1 FROM public.managed_handoffs h WHERE h.account_id=acct.id
            AND h.local_date=(s.value->>'local_date')::date AND h.local_time=s.value->>'local_time'))
    ORDER BY gen.created_at,gen.ordinal,gen.id LIMIT 100 LOOP
    SELECT value INTO slot FROM jsonb_array_elements(public.managed_handoff_slots(candidate.policy,now()+interval '1 hour'))
      WHERE NOT EXISTS(SELECT 1 FROM public.managed_handoffs h WHERE h.account_id=candidate.id
        AND h.local_date=(value->>'local_date')::date AND h.local_time=value->>'local_time')
        AND public.managed_handoff_eligible(candidate.generation_id,(value->>'scheduled_at')::timestamptz)
      ORDER BY (value->>'scheduled_at')::timestamptz LIMIT 1;
    IF slot IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.managed_handoffs(generation_id,account_id,customer_user_id,workspace_id,publer_account_id,
      platform,publication_settings,caption,artifact,timezone,local_date,local_time,scheduled_at)
      VALUES(candidate.generation_id,candidate.id,candidate.customer_user_id,candidate.workspace_id,candidate.publer_account_id,
        candidate.platform,candidate.publication_settings,candidate.recipe->>'caption',candidate.result,candidate.policy->>'timezone',
        (slot->>'local_date')::date,slot->>'local_time',(slot->>'scheduled_at')::timestamptz)
      RETURNING id INTO new_id;
    INSERT INTO public.managed_handoff_events(handoff_id,event) VALUES(new_id,'reserved');
    UPDATE public.managed_accounts SET blocked_reason='handoff_pending' WHERE id=candidate.id;
    n:=n+1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.managed_handoff_claim(p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ctl public.managed_handoff_control; job public.managed_handoffs; expired record;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'invalid_worker'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-handoff',0));
  FOR expired IN SELECT * FROM public.managed_handoffs WHERE lease_until<=now()
    AND state IN ('upload_sending','submit_sending') FOR UPDATE LOOP
    UPDATE public.managed_handoffs SET state='held',lease_until=NULL,lease_token=NULL,
      error_code=CASE WHEN expired.state='upload_sending' THEN 'upload_outcome_unknown' ELSE 'submit_outcome_unknown' END,
      remote_review_required=true,updated_at=now() WHERE id=expired.id;
    INSERT INTO public.managed_handoff_events(handoff_id,event) VALUES(expired.id,'expired_write_held');
  END LOOP;
  -- Read-back remains available with DB activation off. Disabling cannot cancel a remote post.
  UPDATE public.managed_handoffs SET remote_review_required=true WHERE state IN ('submit_wait','confirming','scheduled')
    AND NOT public.managed_handoff_eligible(generation_id,scheduled_at);
  UPDATE public.managed_handoffs SET state='blocked',error_code='slot_missed',lease_until=NULL,updated_at=now()
    WHERE state IN ('reserved','media_ready') AND scheduled_at<now()+interval '10 minutes'
      AND (lease_until IS NULL OR lease_until<=now());
  UPDATE public.managed_handoffs SET state='held',error_code='provider_overdue',remote_review_required=true,lease_until=NULL,updated_at=now()
    WHERE state IN ('upload_wait','submit_wait','confirming','scheduled') AND scheduled_at<now()-interval '24 hours'
      AND (lease_until IS NULL OR lease_until<=now());
  SELECT * INTO ctl FROM public.managed_handoff_control;
  IF ctl.last_claim_at>now()-interval '15 seconds'
    OR EXISTS(SELECT 1 FROM public.managed_handoffs WHERE lease_until>now())
    OR (SELECT count(*) FROM public.managed_handoff_events WHERE event='claimed'
      AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=ctl.daily_claims
    THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.managed_handoffs h WHERE h.next_check_at<=now()
    AND (h.lease_until IS NULL OR h.lease_until<=now())
    AND (h.state IN ('upload_wait','submit_wait','confirming','scheduled')
      OR (h.state IN ('reserved','media_ready') AND public.managed_handoff_eligible(h.generation_id,h.scheduled_at)))
    AND (h.state<>'reserved' OR NOT EXISTS(SELECT 1 FROM public.managed_handoffs busy
      WHERE busy.workspace_id=h.workspace_id AND busy.id<>h.id
        AND (busy.state IN ('upload_sending','upload_wait') OR busy.error_code='upload_outcome_unknown')))
    ORDER BY h.next_check_at,h.created_at,h.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.managed_handoffs SET lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    WHERE id=job.id RETURNING * INTO job;
  UPDATE public.managed_handoff_control SET last_claim_at=now();
  INSERT INTO public.managed_handoff_events(handoff_id,event,detail)
    VALUES(job.id,'claimed',jsonb_build_object('worker',p_worker,'token',job.lease_token));
  RETURN to_jsonb(job);
END $$;

CREATE OR REPLACE FUNCTION public.managed_handoff_transition(
  p_id uuid,p_token uuid,p_event text,p_data jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job public.managed_handoffs; target text; release_lease boolean:=true; needs_write boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-handoff',0));
  SELECT * INTO job FROM public.managed_handoffs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR job.lease_token IS DISTINCT FROM p_token OR job.lease_until IS NULL OR job.lease_until<=now()
    THEN RAISE EXCEPTION 'lease_lost'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>12000 THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
  needs_write:=p_event IN ('upload_intent','submit_intent');
  IF needs_write AND (NOT public.managed_handoff_eligible(job.generation_id,job.scheduled_at)
    OR job.scheduled_at<now()+interval '10 minutes') THEN RAISE EXCEPTION 'handoff_ineligible'; END IF;
  CASE p_event
    WHEN 'upload_intent' THEN
      IF job.state<>'reserved' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      target:='upload_sending';release_lease:=false;
    WHEN 'upload_receipt' THEN
      IF job.state<>'upload_sending' OR COALESCE(p_data->>'job_id','') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:='upload_wait';
      UPDATE public.managed_handoffs SET upload_job_id=p_data->>'job_id' WHERE id=p_id;
    WHEN 'media_ready' THEN
      IF job.state<>'upload_wait' OR COALESCE(p_data->>'id','') !~ '^[A-Za-z0-9_-]{1,128}$'
        OR COALESCE(p_data->>'path','') !~ '^https://' THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:='media_ready';
      UPDATE public.managed_handoffs SET media=p_data WHERE id=p_id;
    WHEN 'submit_intent' THEN
      IF job.state<>'media_ready' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      target:='submit_sending';release_lease:=false;
    WHEN 'submit_receipt' THEN
      IF job.state<>'submit_sending' OR COALESCE(p_data->>'job_id','') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:='submit_wait';
      UPDATE public.managed_handoffs SET submit_job_id=p_data->>'job_id' WHERE id=p_id;
    WHEN 'post_receipt' THEN
      IF job.state<>'submit_wait' OR COALESCE(p_data->>'post_id','') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:='confirming';
      UPDATE public.managed_handoffs SET post_id=p_data->>'post_id' WHERE id=p_id;
    WHEN 'confirmed' THEN
      IF job.state NOT IN ('confirming','scheduled') OR p_data->>'post_id' IS DISTINCT FROM job.post_id
        OR p_data->>'account_id' IS DISTINCT FROM job.publer_account_id
        OR (p_data->>'scheduled_at')::timestamptz IS DISTINCT FROM job.scheduled_at
        OR p_data->>'text' IS DISTINCT FROM job.caption OR p_data->>'media_id' IS DISTINCT FROM job.media->>'id'
        OR COALESCE(p_data->>'state','') NOT IN ('scheduled','published','failed') THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:=p_data->>'state';
      IF target='published' AND job.scheduled_at>now()+interval '1 minute' THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      UPDATE public.managed_handoffs SET post_link=CASE WHEN p_data->>'post_link' ~ '^https://' THEN p_data->>'post_link' ELSE NULL END WHERE id=p_id;
    WHEN 'pending' THEN
      IF job.state NOT IN ('upload_wait','submit_wait','confirming','scheduled') THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      target:=job.state;
    WHEN 'hold' THEN
      IF COALESCE(p_data->>'reason','') NOT IN ('upload_outcome_unknown','submit_outcome_unknown','provider_unavailable',
        'provider_rejected','receipt_unverified','destination_unverified','calendar_conflict','calendar_unverified',
        'storage_unavailable','handoff_ineligible','unexpected_failure') THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
      target:='held';
      UPDATE public.managed_handoffs SET error_code=p_data->>'reason',
        remote_review_required=job.state IN ('upload_sending','submit_sending','submit_wait','confirming','scheduled') WHERE id=p_id;
    ELSE RAISE EXCEPTION 'invalid_transition';
  END CASE;
  UPDATE public.managed_handoffs SET state=target,updated_at=now(),
    lease_token=CASE WHEN release_lease THEN NULL ELSE lease_token END,
    lease_until=CASE WHEN release_lease THEN NULL ELSE lease_until END,
    next_check_at=CASE WHEN target='scheduled' THEN greatest(now()+interval '15 minutes',scheduled_at+interval '2 minutes')
      WHEN p_event='pending' THEN now()+interval '2 minutes' ELSE now() END
    WHERE id=p_id;
  INSERT INTO public.managed_handoff_events(handoff_id,event,detail)
    VALUES(p_id,p_event,jsonb_build_object('from',job.state,'to',target));
END $$;
DO $$
DECLARE tbl text; fn record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['managed_handoff_control','managed_handoff_approvals','managed_handoffs','managed_handoff_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',tbl);
  END LOOP;
  FOR fn IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname LIKE 'managed_handoff_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
    IF fn.proname NOT IN ('managed_handoff_slots','managed_handoff_eligible') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
    END IF;
  END LOOP;
END $$;
COMMIT;
