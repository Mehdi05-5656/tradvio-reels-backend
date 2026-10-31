-- A held upload lock now releases itself 30 minutes after it was set.
-- The hold exists so two uploads never overlap while one has an unknown outcome
-- (a timeout or a server error after the request left). Any such upload has long
-- finished or failed inside Publer after 30 minutes, so the hold protects nothing
-- by then. Uploads are media only: releasing never resends or duplicates a post.
-- Before this, a hold lasted until someone cleared it by hand (2.5 days on Oct 16,
-- 26 hours on Oct 30).
BEGIN;
ALTER TABLE public.publer_workspace_upload
  ADD COLUMN IF NOT EXISTS auto_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_release_count integer NOT NULL DEFAULT 0;

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
  IF w.phase='held' AND w.updated_at<=now()-interval '30 minutes' THEN
    UPDATE public.publer_workspace_upload SET phase='idle',token=NULL,expires_at=NULL,job_id=NULL,
      auto_released_at=now(),auto_release_count=w.auto_release_count+1,updated_at=now()
      WHERE workspace_id=p_workspace RETURNING * INTO w;
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
REVOKE ALL ON FUNCTION public.publer_upload_acquire(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publer_upload_acquire(text) TO service_role;
COMMIT;
