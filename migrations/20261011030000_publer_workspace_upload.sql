BEGIN;
CREATE TABLE IF NOT EXISTS public.publer_workspace_upload(
  workspace_id text PRIMARY KEY,
  phase text NOT NULL DEFAULT 'idle' CHECK(phase IN ('idle','reserved','sending','waiting','held')),
  token uuid,expires_at timestamptz,job_id text,last_finished_job text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.publer_workspace_upload ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publer_workspace_upload FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.publer_workspace_upload TO service_role;

CREATE OR REPLACE FUNCTION public.publer_upload_acquire(p_workspace text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.publer_workspace_upload;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.publer_config WHERE workspace_id=p_workspace)
    THEN RAISE EXCEPTION 'unknown_workspace';END IF;
  INSERT INTO public.publer_workspace_upload(workspace_id) VALUES(p_workspace) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.publer_workspace_upload WHERE workspace_id=p_workspace FOR UPDATE;
  IF w.phase='waiting' THEN RETURN jsonb_build_object('mode','reconcile','job_id',w.job_id);END IF;
  IF w.phase='sending' AND w.expires_at<=now() THEN
    UPDATE public.publer_workspace_upload SET phase='held',updated_at=now() WHERE workspace_id=p_workspace;
    RETURN jsonb_build_object('mode','held');
  END IF;
  IF w.phase='held' THEN RETURN jsonb_build_object('mode','held');END IF;
  IF w.phase='idle' OR (w.phase='reserved' AND w.expires_at<=now()) THEN
    UPDATE public.publer_workspace_upload SET phase='reserved',token=gen_random_uuid(),
      expires_at=now()+interval '10 minutes',job_id=NULL,updated_at=now()
      WHERE workspace_id=p_workspace RETURNING * INTO w;
    RETURN jsonb_build_object('mode','acquired','token',w.token);
  END IF;
  RETURN jsonb_build_object('mode','busy');
END $$;
CREATE OR REPLACE FUNCTION public.publer_upload_begin(p_workspace text,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.publer_workspace_upload SET phase='sending',updated_at=now()
    WHERE workspace_id=p_workspace AND phase='reserved' AND token=p_token AND expires_at>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_lease_lost';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.publer_upload_record_job(p_workspace text,p_token uuid,p_job text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'invalid_upload_job';END IF;
  UPDATE public.publer_workspace_upload SET phase='waiting',job_id=p_job,updated_at=now()
    WHERE workspace_id=p_workspace AND phase='sending' AND token=p_token AND expires_at>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_lease_lost';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.publer_upload_finish(p_workspace text,p_job text,p_terminal text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.publer_workspace_upload;
BEGIN
  IF p_job IS NULL OR p_terminal IS NULL OR p_terminal NOT IN ('complete','completed','failed')
    THEN RAISE EXCEPTION 'invalid_upload_receipt';END IF;
  SELECT * INTO w FROM public.publer_workspace_upload WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RETURN false;END IF;
  IF w.last_finished_job=p_job THEN RETURN true;END IF;
  IF w.phase<>'waiting' OR w.job_id IS DISTINCT FROM p_job THEN RETURN false;END IF;
  UPDATE public.publer_workspace_upload SET phase='idle',token=NULL,expires_at=NULL,job_id=NULL,
    last_finished_job=p_job,updated_at=now() WHERE workspace_id=p_workspace;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.publer_upload_rejected(p_workspace text,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.publer_workspace_upload SET phase='idle',token=NULL,expires_at=NULL,job_id=NULL,updated_at=now()
    WHERE workspace_id=p_workspace AND phase='sending' AND token=p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_lease_lost';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.publer_upload_hold(p_workspace text,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.publer_workspace_upload SET phase='held',updated_at=now()
    WHERE workspace_id=p_workspace AND phase='sending' AND token=p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_lease_lost';END IF;
END $$;
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname LIKE 'publer_upload_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
  END LOOP;
END $$;
COMMIT;
