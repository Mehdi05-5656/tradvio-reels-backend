-- STAGED ONLY. Additive foundation: never alters or seeds legacy publishing rows.
-- Server-only writes through RPCs. New accounts cannot publish in this release.
BEGIN;

CREATE TABLE IF NOT EXISTS public.managed_workspaces (
  workspace_id text PRIMARY KEY CHECK (workspace_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  consent_ref text NOT NULL CHECK (length(consent_ref) BETWEEN 1 AND 500),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, customer_user_id)
);
CREATE TABLE IF NOT EXISTS public.managed_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES public.managed_workspaces(workspace_id),
  accounts jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE TABLE IF NOT EXISTS public.managed_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  publer_account_id text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('instagram','tiktok')),
  handle text NOT NULL,
  inventory_id uuid NOT NULL,
  assignment_version integer NOT NULL DEFAULT 1 CHECK (assignment_version = 1),
  policy jsonb NOT NULL,
  brand_inputs jsonb NOT NULL,
  rights_confirmed boolean NOT NULL,
  state text NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned','blocked')),
  blocked_reason text,
  publishing_enabled boolean NOT NULL DEFAULT false CHECK (publishing_enabled = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,customer_user_id) REFERENCES public.managed_workspaces(workspace_id,customer_user_id),
  FOREIGN KEY (inventory_id,workspace_id) REFERENCES public.managed_inventory(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS managed_accounts_customer_idx ON public.managed_accounts(customer_user_id);
CREATE TABLE IF NOT EXISTS public.managed_assignment_requests (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  payload jsonb NOT NULL,
  account_id uuid NOT NULL REFERENCES public.managed_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.managed_setup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES public.managed_accounts(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS managed_pending_jobs_idx ON public.managed_setup_jobs(created_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS public.managed_blueprints (
  account_id uuid PRIMARY KEY REFERENCES public.managed_accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version=1),
  source text NOT NULL DEFAULT 'operator_baseline_v1' CHECK (source='operator_baseline_v1'),
  inputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.managed_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES public.managed_blueprints(account_id),
  reason text NOT NULL DEFAULT 'initial' CHECK (reason='initial'),
  blueprint_version integer NOT NULL DEFAULT 1 CHECK (blueprint_version=1),
  target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 24),
  state text NOT NULL DEFAULT 'blocked' CHECK (state='blocked'),
  blocked_reason text NOT NULL CHECK (blocked_reason IN ('rights_not_confirmed','renderer_not_configured')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.managed_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid,
  customer_user_id uuid NOT NULL,
  workspace_id text NOT NULL,
  account_id uuid,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.managed_require_operator(p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_actor IS DISTINCT FROM '71c2308a-9e23-4458-b4f0-df7ae53c841e'::uuid OR NOT EXISTS (
    SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id=p.user_id
    WHERE p.user_id=p_actor AND p.role='admin' AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
  ) THEN RAISE EXCEPTION 'operator_required'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.managed_customer_eligible(p_customer uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u JOIN public.profiles p ON p.user_id=u.id
    WHERE u.id=p_customer AND p.role='user' AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
  );
$$;

CREATE OR REPLACE FUNCTION public.managed_register_workspace(
  p_actor uuid,p_customer uuid,p_workspace text,p_consent_ref text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.managed_workspaces;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF NOT public.managed_customer_eligible(p_customer) THEN RAISE EXCEPTION 'customer_ineligible'; END IF;
  IF p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_consent_ref IS NULL OR length(trim(p_consent_ref)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_setup_input';
  END IF;
  IF EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=p_workspace) THEN
    RAISE EXCEPTION 'legacy_workspace';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-workspace:'||p_workspace,0));
  SELECT * INTO w FROM public.managed_workspaces WHERE workspace_id=p_workspace FOR UPDATE;
  IF FOUND THEN
    IF w.customer_user_id<>p_customer OR w.consent_ref<>p_consent_ref OR NOT w.enabled THEN
      RAISE EXCEPTION 'workspace_conflict';
    END IF;
    RETURN w.workspace_id;
  END IF;
  INSERT INTO public.managed_workspaces(workspace_id,customer_user_id,consent_ref)
    VALUES(p_workspace,p_customer,p_consent_ref);
  INSERT INTO public.managed_audit(actor_user_id,customer_user_id,workspace_id,action)
    VALUES(p_actor,p_customer,p_workspace,'workspace_registered');
  RETURN p_workspace;
END $$;

-- Inventory is supplied only by the server's Publer read, never req.body.
CREATE OR REPLACE FUNCTION public.managed_record_inventory(p_actor uuid,p_workspace text,p_accounts jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result uuid; w public.managed_workspaces; item jsonb;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  SELECT * INTO w FROM public.managed_workspaces WHERE workspace_id=p_workspace AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace_conflict'; END IF;
  IF NOT public.managed_customer_eligible(w.customer_user_id) THEN RAISE EXCEPTION 'customer_ineligible'; END IF;
  IF p_accounts IS NULL OR jsonb_typeof(p_accounts)<>'array' THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
  IF jsonb_array_length(p_accounts)>500 THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
    IF jsonb_typeof(item)<>'object' OR item->>'id' IS NULL
      OR item->>'id' !~ '^[A-Za-z0-9_-]{1,128}$'
      OR (item->>'platform') IS NULL OR item->>'platform' NOT IN ('instagram','tiktok')
      OR item->>'handle' IS NULL OR length(trim(item->>'handle')) NOT BETWEEN 1 AND 128
      OR (item - ARRAY['id','platform','handle'])<>'{}'::jsonb
    THEN RAISE EXCEPTION 'invalid_inventory'; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT value->>'id') FROM jsonb_array_elements(p_accounts)) THEN
    RAISE EXCEPTION 'invalid_inventory';
  END IF;
  INSERT INTO public.managed_inventory(workspace_id,accounts) VALUES(p_workspace,p_accounts) RETURNING id INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.managed_validate_inputs(p_policy jsonb,p_brand jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; k text; n integer;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' OR
    (p_policy - ARRAY['timezone','slot_times','buffer_days'])<>'{}'::jsonb OR
    NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_policy->>'timezone') OR
    jsonb_typeof(p_policy->'slot_times') IS DISTINCT FROM 'array' OR
    jsonb_typeof(p_policy->'buffer_days') IS DISTINCT FROM 'number' OR
    (p_policy->>'buffer_days') !~ '^[1-3]$'
  THEN RAISE EXCEPTION 'invalid_policy'; END IF;
  n := jsonb_array_length(p_policy->'slot_times');
  IF n NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'invalid_policy'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_policy->'slot_times') LOOP
    IF jsonb_typeof(item)<>'string' OR (item#>>'{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'invalid_policy';
    END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(p_policy->'slot_times')) THEN
    RAISE EXCEPTION 'invalid_policy';
  END IF;
  IF p_brand IS NULL OR jsonb_typeof(p_brand)<>'object' OR
    (p_brand - ARRAY['audience','voice','language','cta'])<>'{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_blueprint';
  END IF;
  FOREACH k IN ARRAY ARRAY['audience','voice','language','cta'] LOOP
    IF jsonb_typeof(p_brand->k) IS DISTINCT FROM 'string' OR
      length(trim(p_brand->>k)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_blueprint'; END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.managed_assign_account(
  p_actor uuid,p_customer uuid,p_workspace text,p_inventory uuid,p_account text,
  p_key text,p_policy jsonb,p_brand jsonb,p_rights boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.managed_workspaces; inv public.managed_inventory;
  a public.managed_accounts; r public.managed_assignment_requests;
  payload jsonb; observed jsonb; result uuid;
BEGIN
  PERFORM public.managed_require_operator(p_actor);
  IF NOT public.managed_customer_eligible(p_customer) THEN RAISE EXCEPTION 'customer_ineligible'; END IF;
  PERFORM public.managed_validate_inputs(p_policy,p_brand);
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128 OR p_rights IS NULL OR p_account IS NULL THEN
    RAISE EXCEPTION 'invalid_setup_input';
  END IF;
  SELECT * INTO w FROM public.managed_workspaces WHERE workspace_id=p_workspace AND enabled FOR SHARE;
  IF NOT FOUND OR w.customer_user_id<>p_customer THEN RAISE EXCEPTION 'workspace_conflict'; END IF;
  payload := jsonb_build_object('customer',p_customer,'workspace',p_workspace,'account',p_account,
    'policy',p_policy,'brand',p_brand,'rights',p_rights);
  -- Lock order is consistent: key, then destination. Unique constraints remain
  -- the final backstop; callers cannot remap history or create a second batch.
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-key:'||p_key,0));
  SELECT * INTO r FROM public.managed_assignment_requests WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF r.payload<>payload THEN RAISE EXCEPTION 'assignment_conflict'; END IF;
    RETURN r.account_id;
  END IF;
  SELECT * INTO inv FROM public.managed_inventory WHERE id=p_inventory AND workspace_id=p_workspace;
  IF NOT FOUND OR inv.observed_at<now()-interval '5 minutes' OR inv.observed_at>now() THEN
    RAISE EXCEPTION 'inventory_stale';
  END IF;
  SELECT value INTO observed FROM jsonb_array_elements(inv.accounts) WHERE value->>'id'=p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_observed'; END IF;
  IF EXISTS(SELECT 1 FROM public.publer_slot_config WHERE publer_account_id=p_account) THEN
    RAISE EXCEPTION 'legacy_destination';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-destination:'||p_account,0));
  SELECT * INTO a FROM public.managed_accounts WHERE publer_account_id=p_account FOR UPDATE;
  IF FOUND THEN
    IF a.customer_user_id<>p_customer OR a.workspace_id<>p_workspace OR a.platform<>observed->>'platform' THEN
      RAISE EXCEPTION 'destination_conflict';
    END IF;
    IF a.policy<>p_policy OR a.brand_inputs<>p_brand OR a.rights_confirmed<>p_rights THEN
      RAISE EXCEPTION 'assignment_conflict';
    END IF;
    result := a.id;
  ELSE
    INSERT INTO public.managed_accounts(customer_user_id,workspace_id,publer_account_id,platform,handle,
      inventory_id,policy,brand_inputs,rights_confirmed)
    VALUES(p_customer,p_workspace,p_account,observed->>'platform',observed->>'handle',p_inventory,p_policy,p_brand,p_rights)
    RETURNING id INTO result;
    INSERT INTO public.managed_setup_jobs(account_id) VALUES(result);
    INSERT INTO public.managed_audit(actor_user_id,customer_user_id,workspace_id,account_id,action)
      VALUES(p_actor,p_customer,p_workspace,result,'assigned');
  END IF;
  INSERT INTO public.managed_assignment_requests(idempotency_key,payload,account_id) VALUES(p_key,payload,result);
  RETURN result;
END $$;

-- Short transaction: no network, rendering, billable model work or publishing.
-- A crash rolls back both output records and completion, leaving the job pending.
-- No leases needed for this database-only stage. Future external stages need
-- fenced leases and their own idempotency keys; do not hold locks across I/O.
CREATE OR REPLACE FUNCTION public.managed_provision_pending(p_limit integer DEFAULT 5)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.managed_setup_jobs; a public.managed_accounts; reason text; processed integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'invalid_limit'; END IF;
  FOR j IN SELECT * FROM public.managed_setup_jobs WHERE state='pending'
    ORDER BY created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO a FROM public.managed_accounts WHERE id=j.account_id FOR UPDATE;
    IF NOT public.managed_customer_eligible(a.customer_user_id) THEN reason:='customer_ineligible';
    ELSIF NOT EXISTS(SELECT 1 FROM public.managed_workspaces WHERE workspace_id=a.workspace_id AND enabled) THEN
      reason:='workspace_disabled';
    ELSE reason:=NULL;
    END IF;
    IF reason IS NULL THEN
      INSERT INTO public.managed_blueprints(account_id,inputs) VALUES(a.id,a.brand_inputs);
      reason:=CASE WHEN a.rights_confirmed THEN 'renderer_not_configured' ELSE 'rights_not_confirmed' END;
      INSERT INTO public.managed_batches(account_id,target_count,blocked_reason)
        VALUES(a.id,jsonb_array_length(a.policy->'slot_times')*(a.policy->>'buffer_days')::integer,reason);
    END IF;
    UPDATE public.managed_accounts SET state='blocked',blocked_reason=reason WHERE id=a.id;
    UPDATE public.managed_setup_jobs SET state='blocked',finished_at=now() WHERE id=j.id;
    INSERT INTO public.managed_audit(customer_user_id,workspace_id,account_id,action)
      VALUES(a.customer_user_id,a.workspace_id,a.id,'setup_blocked:'||reason);
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;

DO $$
DECLARE name text; fn record;
BEGIN
  FOREACH name IN ARRAY ARRAY['managed_workspaces','managed_inventory','managed_accounts',
    'managed_assignment_requests','managed_setup_jobs','managed_blueprints','managed_batches','managed_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',name);
  END LOOP;
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('managed_require_operator','managed_customer_eligible',
      'managed_register_workspace','managed_record_inventory','managed_validate_inputs',
      'managed_assign_account','managed_provision_pending') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
  END LOOP;
END $$;
COMMIT;
