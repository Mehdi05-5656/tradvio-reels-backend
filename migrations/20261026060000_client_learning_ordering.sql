-- Per-client learning, phase 3: what a client learned starts to change what it posts next, behind a per-client
-- switch (client_orgs.learning.optimize = true). With the switch off nothing here changes posting.
--
--  * queue order: pending library rows of an optimising client get a queue_rank per account: the client's strongest
--    vault videos first (avg composite, then the intake prior), with an exploration share of rows chosen by a stable
--    hash interleaved evenly so new and low-sample videos keep getting measured. The publisher picks by queue_rank
--    (phase 3 backend), falling back to arrival order where no rank exists.
--  * retiring: a video with at least retire_after_posts posts in the client and an average composite below the
--    client's retire_below_pct percentile (and below zero) is retired; its pending rows are skipped with a note,
--    never deleted; an operator can restore it, which pins it against automatic retirement.
--  * caption winner: once the client's experiment has a winner, winner_weight of new rows take the winning
--    template, the rest keep exploring the other arms.
--  * render fairness: the renderer takes the next pending variant from the client that has waited longest, so one
--    client's big drop no longer starves the others.
BEGIN;

ALTER TABLE public.reels_manual_queue ADD COLUMN IF NOT EXISTS queue_rank integer;
CREATE INDEX IF NOT EXISTS reels_manual_queue_pending_rank_idx ON public.reels_manual_queue (phone_slot, queue_rank) WHERE status = 'pending';
ALTER TABLE public.client_source_stats ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

-- Effective learning settings with defaults.
CREATE OR REPLACE FUNCTION public.client_learning_settings(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'optimize', coalesce((o.learning->>'optimize')::boolean, false),
    'exploration_share', least(0.5, greatest(0, coalesce((o.learning->>'exploration_share')::numeric, 0.2))),
    'retire_after_posts', greatest(2, coalesce((o.learning->>'retire_after_posts')::integer, 6)),
    'retire_below_pct', least(50, greatest(5, coalesce((o.learning->>'retire_below_pct')::numeric, 25))),
    'winner_weight', least(1, greatest(0.5, coalesce((o.learning->>'winner_weight')::numeric, 0.8))))
  FROM public.client_orgs o WHERE o.id = p_org;
$$;

-- Queue order for one client. Returns rows ranked; clears ranks when the switch is off.
CREATE OR REPLACE FUNCTION public.client_learning_rank_queue(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cfg jsonb; share numeric; n integer := 0;
BEGIN
  cfg := public.client_learning_settings(p_org);
  IF cfg IS NULL THEN RETURN 0; END IF;
  IF NOT (cfg->>'optimize')::boolean THEN
    UPDATE public.reels_manual_queue q SET queue_rank = NULL FROM public.client_org_accounts a
      WHERE a.phone_slot = q.phone_slot AND a.org_id = p_org AND q.status = 'pending' AND q.queue_rank IS NOT NULL;
    RETURN 0;
  END IF;
  share := (cfg->>'exploration_share')::numeric;
  WITH cand AS (
    SELECT q.id, q.phone_slot, v.source_sha256, cs.avg_composite, cs.posts,
      coalesce((src.source->>'prior_views')::numeric, 0) AS prior_views,
      ('x' || substr(md5(v.source_sha256 || ':' || q.phone_slot || ':explore-v1'), 1, 2))::bit(8)::int AS hb
    FROM public.reels_manual_queue q
    JOIN public.client_org_accounts a ON a.phone_slot = q.phone_slot AND a.org_id = p_org
    JOIN public.library_variants v ON v.id = q.library_variant_id
    JOIN public.library_sources src ON src.sha256 = v.source_sha256
    LEFT JOIN public.client_source_stats cs ON cs.org_id = p_org AND cs.source_sha256 = v.source_sha256
    WHERE q.status = 'pending'
  ),
  grouped AS (
    SELECT id, phone_slot, (hb < share * 256) AS explore,
      row_number() OVER (PARTITION BY phone_slot, (hb < share * 256)
        ORDER BY CASE WHEN hb < share * 256 THEN 0 ELSE -coalesce(avg_composite, 0) END,
                 CASE WHEN hb < share * 256 THEN hb ELSE -ln(1 + prior_views) END, hb, id) AS rn
    FROM cand
  ),
  ordered AS (
    SELECT id, row_number() OVER (PARTITION BY phone_slot ORDER BY rn / CASE WHEN explore THEN greatest(share, 0.01) ELSE greatest(1 - share, 0.01) END, explore, id) AS rk
    FROM grouped
  )
  UPDATE public.reels_manual_queue q SET queue_rank = o.rk FROM ordered o WHERE q.id = o.id AND q.queue_rank IS DISTINCT FROM o.rk;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Retire weak videos for an optimising client; pending rows of a retired video are skipped with a note.
CREATE OR REPLACE FUNCTION public.client_learning_retire(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cfg jsonb; threshold numeric; retired_n integer := 0; skipped_n integer := 0;
BEGIN
  cfg := public.client_learning_settings(p_org);
  IF cfg IS NULL OR NOT (cfg->>'optimize')::boolean THEN RETURN jsonb_build_object('retired', 0, 'skipped_rows', 0, 'threshold', NULL); END IF;
  SELECT percentile_cont((cfg->>'retire_below_pct')::numeric / 100) WITHIN GROUP (ORDER BY avg_composite) INTO threshold
    FROM public.client_source_stats WHERE org_id = p_org AND avg_composite IS NOT NULL;
  IF threshold IS NULL THEN RETURN jsonb_build_object('retired', 0, 'skipped_rows', 0, 'threshold', NULL); END IF;
  threshold := least(threshold, 0);
  UPDATE public.client_source_stats SET retired = true, retired_at = now(),
    retired_reason = format('%s posts, average composite %s below the client''s %s%% line (%s)', posts, round(avg_composite, 2), cfg->>'retire_below_pct', round(threshold, 2))
    WHERE org_id = p_org AND NOT retired AND NOT pinned AND posts >= (cfg->>'retire_after_posts')::integer AND avg_composite < threshold;
  GET DIAGNOSTICS retired_n = ROW_COUNT;
  UPDATE public.reels_manual_queue q SET status = 'skipped', queue_rank = NULL,
    notes = concat_ws(' | ', nullif(q.notes, ''), '[retired by learning ' || to_char(now(), 'YYYY-MM-DD') || ']')
    FROM public.library_variants v, public.client_source_stats cs, public.client_org_accounts a
    WHERE q.library_variant_id = v.id AND cs.org_id = p_org AND cs.source_sha256 = v.source_sha256 AND cs.retired
      AND a.org_id = p_org AND a.phone_slot = q.phone_slot AND q.status = 'pending';
  GET DIAGNOSTICS skipped_n = ROW_COUNT;
  RETURN jsonb_build_object('retired', retired_n, 'skipped_rows', skipped_n, 'threshold', round(threshold, 3));
END $$;

-- Operator control: retire or restore one video for a client. Restoring pins it and brings its skipped rows back.
CREATE OR REPLACE FUNCTION public.client_source_set_retired(p_org uuid, p_sha text, p_retired boolean, p_actor text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rows_n integer := 0;
BEGIN
  INSERT INTO public.client_source_stats (org_id, source_sha256) VALUES (p_org, p_sha) ON CONFLICT DO NOTHING;
  UPDATE public.client_source_stats SET retired = p_retired, pinned = NOT p_retired,
    retired_at = CASE WHEN p_retired THEN now() END,
    retired_reason = CASE WHEN p_retired THEN 'retired by operator ' || coalesce(p_actor, '') ELSE NULL END
    WHERE org_id = p_org AND source_sha256 = p_sha;
  IF p_retired THEN
    UPDATE public.reels_manual_queue q SET status = 'skipped', queue_rank = NULL,
      notes = concat_ws(' | ', nullif(q.notes, ''), '[retired by learning ' || to_char(now(), 'YYYY-MM-DD') || ']')
      FROM public.library_variants v, public.client_org_accounts a
      WHERE q.library_variant_id = v.id AND v.source_sha256 = p_sha AND a.org_id = p_org AND a.phone_slot = q.phone_slot AND q.status = 'pending';
  ELSE
    UPDATE public.reels_manual_queue q SET status = 'pending',
      notes = nullif(regexp_replace(coalesce(q.notes, ''), '\s*\|?\s*\[retired by learning [0-9-]+\]', '', 'g'), '')
      FROM public.library_variants v, public.client_org_accounts a
      WHERE q.library_variant_id = v.id AND v.source_sha256 = p_sha AND a.org_id = p_org AND a.phone_slot = q.phone_slot
        AND q.status = 'skipped' AND q.notes LIKE '%[retired by learning%';
  END IF;
  GET DIAGNOSTICS rows_n = ROW_COUNT;
  PERFORM public.client_learning_rank_queue(p_org);
  RETURN jsonb_build_object('sha256', p_sha, 'retired', p_retired, 'rows', rows_n);
END $$;

-- The hourly refresh now also retires and ranks for optimising clients.
CREATE OR REPLACE FUNCTION public.client_learning_refresh(p_force boolean DEFAULT false, p_min_gap interval DEFAULT interval '50 minutes') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; out jsonb := '[]'::jsonb; skipped integer := 0; r jsonb;
BEGIN
  FOR o IN SELECT id, slug FROM public.client_orgs WHERE archived_at IS NULL ORDER BY created_at LOOP
    IF NOT p_force AND EXISTS (SELECT 1 FROM public.client_learning_runs x WHERE x.org_id = o.id AND x.ran_at > now() - p_min_gap) THEN
      skipped := skipped + 1; CONTINUE;
    END IF;
    r := public.client_learning_refresh_org(o.id);
    r := r || jsonb_build_object('slug', o.slug, 'retire', public.client_learning_retire(o.id), 'ranked', public.client_learning_rank_queue(o.id));
    out := out || r;
  END LOOP;
  RETURN jsonb_build_object('refreshed', out, 'skipped', skipped);
END $$;

-- Caption for a rendered variant, now honouring a decided winner for optimising clients.
CREATE OR REPLACE FUNCTION public.library_caption_for(p_account text, p_source_sha256 text, OUT caption text, OUT arm text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_org uuid; templates jsonb; n integer; idx integer; experiment text; h1 integer; h2 integer; winner text; widx integer; cfg jsonb;
BEGIN
  SELECT o.id, o.caption_templates INTO v_org, templates FROM public.client_account_setup s JOIN public.client_orgs o ON o.id = s.org_id WHERE s.publer_account_id = p_account;
  IF v_org IS NULL OR templates IS NULL OR jsonb_array_length(templates) = 0 THEN caption := NULL; arm := NULL; RETURN; END IF;
  n := least(jsonb_array_length(templates), 20);
  experiment := public.client_experiment_id(v_org);
  h1 := strpos('0123456789abcdef', substr(md5(p_source_sha256 || ':' || p_account || ':' || experiment), 1, 1));
  h2 := strpos('0123456789abcdef', substr(md5(p_source_sha256 || ':' || p_account || ':' || experiment), 2, 1));
  idx := h1 % n;
  cfg := public.client_learning_settings(v_org);
  SELECT e.winner_arm INTO winner FROM public.client_experiments e WHERE e.org_id = v_org AND e.id = experiment AND e.winner_arm IS NOT NULL;
  IF winner IS NOT NULL AND n > 1 AND coalesce((cfg->>'optimize')::boolean, false) THEN
    widx := ascii(winner) - 65;
    IF widx BETWEEN 0 AND n - 1 THEN
      IF h2 <= round(16 * (cfg->>'winner_weight')::numeric) THEN idx := widx;
      ELSIF idx = widx THEN idx := (idx + 1) % n; END IF;
    END IF;
  END IF;
  arm := chr(65 + idx);
  caption := templates ->> idx;
END $function$;

-- Render fairness: the next pending variant comes from the client that has waited longest for a render.
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
  )
  SELECT v.* INTO j FROM public.library_variants v
    JOIN public.library_sources s ON s.sha256=v.source_sha256 AND s.enabled
    JOIN public.publer_account_ownership a ON a.publer_account_id=v.account_id
      AND a.owner_user_id=v.owner_user_id AND a.workspace_id=v.workspace_id
    LEFT JOIN public.client_account_setup st ON st.publer_account_id=v.account_id
    LEFT JOIN last_claim lc ON lc.org_id=st.org_id
    WHERE v.state='pending' AND v.attempts<3
    ORDER BY lc.at NULLS FIRST, v.created_at, v.id LIMIT 1 FOR UPDATE OF v SKIP LOCKED;
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
    AND proname IN ('client_learning_settings','client_learning_rank_queue','client_learning_retire','client_source_set_retired','client_learning_refresh','library_caption_for','library_claim') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
