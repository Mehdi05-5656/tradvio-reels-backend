-- Storage stewardship: keep every byte of information, stop keeping reproducible bytes.
--
--  * A rendered variant is the original plus a recorded recipe (crop, speed, trim, size, quality), so it can be
--    regenerated. Once a variant's post is verified published, its features are extracted and a grace period has
--    passed, the backend archives it: the exact hook frame and a 4-frame strip as small JPEGs, a technical probe
--    (codecs, bitrate, loudness), the file hash verified against the stored one, a ledger row, then the file is
--    deleted. The variant row, the queue row and every table that references it stay. Off until purge_enabled.
--  * The renderer keeps each account about render_buffer_days ahead instead of rendering a whole library up front,
--    strongest videos first, still alternating between clients.
--  * library_storage_usage() reports the whole picture so the console can project days to the cap.
BEGIN;

ALTER TABLE public.library_control ADD COLUMN IF NOT EXISTS purge_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.library_control ADD COLUMN IF NOT EXISTS purge_grace_days integer NOT NULL DEFAULT 14 CHECK (purge_grace_days BETWEEN 3 AND 365);
ALTER TABLE public.library_control ADD COLUMN IF NOT EXISTS render_buffer_days integer NOT NULL DEFAULT 30 CHECK (render_buffer_days BETWEEN 3 AND 365);
ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS poster_path text;

CREATE TABLE IF NOT EXISTS public.library_purges (
  id bigserial PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES public.library_variants(id) ON DELETE CASCADE,
  queue_id uuid,
  account_id text NOT NULL,
  org_id uuid,
  source_sha256 text NOT NULL,
  object_key text NOT NULL,
  bytes_freed bigint NOT NULL DEFAULT 0,
  file_sha256 text,
  sha_verified boolean NOT NULL DEFAULT false,
  poster_key text,
  strip_key text,
  archive_bytes bigint NOT NULL DEFAULT 0,
  probe jsonb,
  posted_at timestamptz,
  published_at timestamptz,
  features_present boolean NOT NULL DEFAULT false,
  outcome text NOT NULL DEFAULT 'purged',
  purge_version text NOT NULL DEFAULT 'archive-v1',
  purged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id)
);
CREATE INDEX IF NOT EXISTS library_purges_org_idx ON public.library_purges (org_id, purged_at DESC);
ALTER TABLE public.library_purges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.library_purges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.library_purges TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.library_purges_id_seq TO service_role;

-- Variants whose file may be archived and removed. Every condition is about certainty: the post is verified
-- published with no unresolved submission, the features exist, the grace period has passed, nothing archived yet.
CREATE OR REPLACE FUNCTION public.library_purge_candidates(p_limit integer DEFAULT 40)
RETURNS TABLE (variant_id uuid, queue_id uuid, account_id text, org_id uuid, source_sha256 text, object_key text, bytes bigint, file_sha256 text, posted_at timestamptz, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, q.id, v.account_id, s.org_id, v.source_sha256, v.result->>'object_key', (v.result->>'bytes')::bigint, v.result->>'sha256', q.posted_at, l.published_at
  FROM public.library_variants v
  JOIN public.reels_manual_queue q ON q.library_variant_id = v.id AND q.status = 'posted'
  JOIN LATERAL (SELECT max(p.attempted_at) AS published_at FROM public.publer_publish_log p WHERE p.queue_id = q.id AND p.status = 'published') l ON l.published_at IS NOT NULL
  LEFT JOIN public.client_account_setup s ON s.publer_account_id = v.account_id
  CROSS JOIN public.library_control c
  WHERE v.state = 'rendered_private' AND v.result ? 'object_key' AND NOT (v.result ? 'purged_at')
    AND l.published_at < now() - make_interval(days => c.purge_grace_days)
    AND EXISTS (SELECT 1 FROM public.video_content_features f WHERE f.queue_id = q.id)
    AND NOT EXISTS (SELECT 1 FROM public.publer_publish_log p2 WHERE p2.queue_id = q.id AND p2.status = 'pending')
    AND NOT EXISTS (SELECT 1 FROM public.library_purges x WHERE x.variant_id = v.id)
  ORDER BY l.published_at
  LIMIT greatest(1, least(p_limit, 500));
$$;

-- Records one archive-and-remove. The variant keeps its row, gains purged_at and the archive keys; the queue row
-- learns its poster so the console keeps showing the posted frame.
CREATE OR REPLACE FUNCTION public.library_mark_purged(p_variant uuid, p_entry jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.library_variants; q_id uuid;
BEGIN
  SELECT * INTO v FROM public.library_variants WHERE id = p_variant;
  IF NOT FOUND THEN RAISE EXCEPTION 'variant_not_found'; END IF;
  SELECT id INTO q_id FROM public.reels_manual_queue WHERE library_variant_id = p_variant LIMIT 1;
  INSERT INTO public.library_purges (variant_id, queue_id, account_id, org_id, source_sha256, object_key, bytes_freed, file_sha256, sha_verified, poster_key, strip_key, archive_bytes, probe, posted_at, published_at, features_present, outcome)
  VALUES (p_variant, q_id, v.account_id, (p_entry->>'org_id')::uuid, v.source_sha256, coalesce(p_entry->>'object_key', v.result->>'object_key'),
    coalesce((p_entry->>'bytes_freed')::bigint, 0), p_entry->>'file_sha256', coalesce((p_entry->>'sha_verified')::boolean, false),
    p_entry->>'poster_key', p_entry->>'strip_key', coalesce((p_entry->>'archive_bytes')::bigint, 0), p_entry->'probe',
    (p_entry->>'posted_at')::timestamptz, (p_entry->>'published_at')::timestamptz, coalesce((p_entry->>'features_present')::boolean, false), coalesce(p_entry->>'outcome', 'purged'));
  UPDATE public.library_variants SET result = result || jsonb_build_object('purged_at', now(), 'poster_key', p_entry->>'poster_key', 'strip_key', p_entry->>'strip_key', 'archive_bytes', coalesce((p_entry->>'archive_bytes')::bigint, 0), 'purge_outcome', coalesce(p_entry->>'outcome', 'purged')), updated_at = now()
    WHERE id = p_variant;
  IF q_id IS NOT NULL AND p_entry->>'poster_key' IS NOT NULL THEN
    UPDATE public.reels_manual_queue SET poster_path = p_entry->>'poster_key' WHERE id = q_id;
  END IF;
  RETURN jsonb_build_object('variant_id', p_variant, 'queue_id', q_id, 'outcome', coalesce(p_entry->>'outcome', 'purged'));
END $$;

-- The whole storage picture in one call.
DROP FUNCTION IF EXISTS public.library_storage_usage();
CREATE FUNCTION public.library_storage_usage()
RETURNS TABLE (stored_bytes bigint, stored_objects bigint, max_output_bytes bigint, reserve_bytes bigint,
  archive_bytes bigint, archive_objects bigint, raw_bytes bigint, raw_objects bigint, legacy_bytes bigint, legacy_objects bigint,
  intake_bytes bigint, freed_bytes bigint, purged_objects bigint, posted_unpurged_bytes bigint, posted_unpurged_objects bigint,
  added_7d_bytes bigint, purge_enabled boolean, purge_grace_days integer, render_buffer_days integer, purge_candidates bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public', 'pg_temp' AS $$
  WITH o AS (SELECT bucket_id, name, coalesce((metadata->>'size')::bigint, 0) AS bytes, created_at FROM storage.objects),
  c AS (SELECT * FROM public.library_control LIMIT 1),
  posted AS (
    SELECT (v.result->>'bytes')::bigint AS bytes FROM public.library_variants v
    JOIN public.reels_manual_queue q ON q.library_variant_id = v.id AND q.status = 'posted'
    WHERE v.state = 'rendered_private' AND NOT (v.result ? 'purged_at'))
  SELECT
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'managed-variants' AND name LIKE 'library/%')::bigint,
    (SELECT count(*) FROM o WHERE bucket_id = 'managed-variants' AND name LIKE 'library/%')::bigint,
    (SELECT max_output_bytes FROM c), 67108864::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'managed-variants' AND name LIKE 'archive/%')::bigint,
    (SELECT count(*) FROM o WHERE bucket_id = 'managed-variants' AND name LIKE 'archive/%')::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'managed-raw')::bigint,
    (SELECT count(*) FROM o WHERE bucket_id = 'managed-raw')::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'reels')::bigint,
    (SELECT count(*) FROM o WHERE bucket_id = 'reels')::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'client-intake')::bigint,
    (SELECT coalesce(sum(bytes_freed), 0) FROM public.library_purges)::bigint,
    (SELECT count(*) FROM public.library_purges)::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM posted)::bigint,
    (SELECT count(*) FROM posted)::bigint,
    (SELECT coalesce(sum(bytes), 0) FROM o WHERE bucket_id = 'managed-variants' AND name LIKE 'library/%' AND created_at > now() - interval '7 days')::bigint,
    (SELECT purge_enabled FROM c), (SELECT purge_grace_days FROM c), (SELECT render_buffer_days FROM c),
    (SELECT count(*) FROM public.library_purge_candidates(500))::bigint
$$;
REVOKE ALL ON FUNCTION public.library_storage_usage() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_storage_usage() TO service_role;

-- Legacy bucket files no queue row points at: listed for review, never deleted here.
CREATE OR REPLACE FUNCTION public.library_unreferenced_legacy()
RETURNS TABLE (name text, bytes bigint, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public', 'pg_temp' AS $$
  SELECT o.name, coalesce((o.metadata->>'size')::bigint, 0), o.created_at FROM storage.objects o
  WHERE o.bucket_id = 'reels' AND NOT EXISTS (SELECT 1 FROM public.reels_manual_queue q WHERE q.storage_path = o.name AND coalesce(q.storage_bucket, 'reels') = 'reels')
  ORDER BY o.created_at;
$$;
REVOKE ALL ON FUNCTION public.library_unreferenced_legacy() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_unreferenced_legacy() TO service_role;

-- Renderer: alternate between clients, keep each account about render_buffer_days ahead, strongest videos first.
CREATE OR REPLACE FUNCTION public.library_claim(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
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
  IF running_n>=c.max_active OR stored_bytes+(running_n+1)::bigint*67108864>c.max_output_bytes
    OR (SELECT count(*) FROM public.library_attempts WHERE created_at>=
      date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=c.max_daily_claims THEN RETURN NULL;END IF;
  WITH last_claim AS (
    SELECT st.org_id, max(at.created_at) AS at FROM public.library_attempts at
    JOIN public.library_variants lv ON lv.id=at.variant_id
    JOIN public.client_account_setup st ON st.publer_account_id=lv.account_id
    WHERE at.created_at>now()-interval '1 day' GROUP BY st.org_id
  ),
  ahead AS (
    -- Rendered and still unposted (or running) per account: how far ahead that account already is.
    SELECT r.account_id, count(*) AS n FROM public.library_variants r
    LEFT JOIN public.reels_manual_queue q ON q.library_variant_id=r.id
    WHERE r.state='running' OR (r.state='rendered_private' AND NOT (r.result ? 'purged_at') AND (q.id IS NULL OR q.status='pending'))
    GROUP BY r.account_id
  )
  SELECT v.* INTO j FROM public.library_variants v
    JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    JOIN public.publer_account_ownership a ON a.publer_account_id=v.account_id
      AND a.owner_user_id=v.owner_user_id AND a.workspace_id=v.workspace_id
    LEFT JOIN public.client_account_setup st ON st.publer_account_id=v.account_id
    LEFT JOIN last_claim lc ON lc.org_id=st.org_id
    LEFT JOIN ahead ah ON ah.account_id=v.account_id
    LEFT JOIN public.client_source_stats cs ON cs.org_id=st.org_id AND cs.source_sha256=v.source_sha256
    WHERE v.state='pending' AND v.attempts<3
      AND coalesce(ah.n,0) < coalesce(st.daily_target,8)*c.render_buffer_days
      AND NOT coalesce(cs.retired,false)
    ORDER BY lc.at NULLS FIRST, coalesce(cs.avg_composite,0) DESC, coalesce((s.source->>'prior_views')::numeric,0) DESC, v.created_at, v.id
    LIMIT 1 FOR UPDATE OF v SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL;END IF;
  UPDATE public.library_variants SET state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+interval '10 minutes',updated_at=now(),error_code=NULL
    WHERE id=j.id RETURNING * INTO j;
  INSERT INTO public.library_attempts VALUES(j.lease_token,j.id,p_worker,now());
  INSERT INTO public.library_events(variant_id,account_id,event) VALUES(j.id,j.account_id,'render_started');
  SELECT source INTO s FROM public.library_sources WHERE sha256=j.source_sha256;
  RETURN to_jsonb(j)||jsonb_build_object('source',s);
END $function$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('library_purge_candidates','library_mark_purged','library_claim') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
