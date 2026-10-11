-- A hard private-output storage ceiling. Counts orphan objects as well as receipts.
BEGIN;
ALTER TABLE public.library_control ADD COLUMN IF NOT EXISTS max_output_bytes bigint
  NOT NULL DEFAULT 53687091200 CHECK(max_output_bytes BETWEEN 67108864 AND 107374182400);
CREATE OR REPLACE FUNCTION public.library_claim(p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.library_control;j public.library_variants;s jsonb;running_n integer;stored_bytes bigint;
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
  SELECT count(*) INTO running_n FROM public.library_variants WHERE state='running';
  SELECT coalesce(sum(coalesce((metadata->>'size')::bigint,0)),0) INTO stored_bytes
    FROM storage.objects WHERE bucket_id='managed-variants' AND name LIKE 'library/%';
  -- Reserve the maximum allowed object size for every in-flight claim plus the
  -- new claim. An orphan upload is counted from Storage even without a receipt.
  IF running_n>=c.max_active OR stored_bytes+(running_n+1)::bigint*67108864>c.max_output_bytes
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
REVOKE ALL ON FUNCTION public.library_claim(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.library_claim(text) TO service_role;
COMMIT;
