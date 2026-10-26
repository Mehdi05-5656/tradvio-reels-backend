-- Per-client learning, phase 2: each client's own published posts are scored inside the client only, every vault
-- video gets per-client performance stats, and each client's caption experiment is evaluated on its own posts.
-- Nothing here changes what is posted (that is phase 3); it only measures.
--
-- Signal: public readings in live_post_metrics (ScrapeCreators), joined to the publish log by publer_post_id.
-- Publer's own analytics are keyed by link and are not used here. A post counts once it has at least one reading;
-- experiment arms are compared on posts at least 72 hours old, because the first public reading lands about two
-- days after publication on average.
BEGIN;

CREATE TABLE IF NOT EXISTS public.client_post_scores (
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  queue_id uuid NOT NULL REFERENCES public.reels_manual_queue(id) ON DELETE CASCADE,
  phone_slot text NOT NULL,
  publer_post_id text,
  source_sha256 text,
  experiment_id text,
  arm text,
  published_at timestamptz NOT NULL,
  first_read_at timestamptz,
  latest_read_at timestamptz,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  engagement_rate numeric,
  composite numeric,
  rank_in_org integer,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, queue_id)
);
CREATE INDEX IF NOT EXISTS client_post_scores_org_rank_idx ON public.client_post_scores (org_id, rank_in_org);
CREATE INDEX IF NOT EXISTS client_post_scores_org_source_idx ON public.client_post_scores (org_id, source_sha256);

CREATE TABLE IF NOT EXISTS public.client_source_stats (
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL,
  posts integer NOT NULL DEFAULT 0,
  accounts integer NOT NULL DEFAULT 0,
  median_views numeric,
  p75_views numeric,
  avg_composite numeric,
  first_posted_at timestamptz,
  last_posted_at timestamptz,
  retired boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  retired_reason text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source_sha256)
);

CREATE TABLE IF NOT EXISTS public.client_learning_runs (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.client_orgs(id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  posts_scored integer NOT NULL DEFAULT 0,
  posts_published integer NOT NULL DEFAULT 0,
  sources integer NOT NULL DEFAULT 0,
  experiments jsonb,
  duration_ms integer
);
CREATE INDEX IF NOT EXISTS client_learning_runs_org_idx ON public.client_learning_runs (org_id, ran_at DESC);

ALTER TABLE public.client_experiments ADD COLUMN IF NOT EXISTS evaluation jsonb;
ALTER TABLE public.client_experiments ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['client_post_scores','client_source_stats','client_learning_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.client_learning_runs_id_seq TO service_role;

-- Score one client's posts. Every read is filtered by the client's slots; nothing from another client enters.
CREATE OR REPLACE FUNCTION public.client_learning_refresh_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  n_posts integer := 0; n_scored integer := 0; n_sources integer := 0;
  experiments jsonb := '[]'::jsonb;
  e record; arms jsonb; best record; second record; z numeric; decided boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('client-learning:' || p_org::text, 0));

  -- 1. This client's published posts with their latest public reading.
  CREATE TEMP TABLE _posts ON COMMIT DROP AS
  WITH pub AS (
    SELECT DISTINCT ON (l.queue_id) l.queue_id, l.phone_slot, l.publer_post_id, l.attempted_at AS published_at,
      q.library_experiment_arm AS arm, v.source_sha256
    FROM public.publer_publish_log l
    JOIN public.client_org_accounts a ON a.phone_slot = l.phone_slot AND a.org_id = p_org
    JOIN public.reels_manual_queue q ON q.id = l.queue_id
    LEFT JOIN public.library_variants v ON v.id = q.library_variant_id
    WHERE l.status = 'published' AND l.publer_post_id IS NOT NULL
    ORDER BY l.queue_id, l.attempted_at DESC
  ),
  latest AS (
    SELECT DISTINCT ON (m.publer_post_id) m.publer_post_id, m.captured_at, m.video_views, m.likes, m.comments, m.shares, m.saves
    FROM public.live_post_metrics m JOIN pub ON pub.publer_post_id = m.publer_post_id
    ORDER BY m.publer_post_id, m.captured_at DESC
  ),
  first_read AS (
    SELECT m.publer_post_id, min(m.captured_at) AS first_read_at
    FROM public.live_post_metrics m JOIN pub ON pub.publer_post_id = m.publer_post_id GROUP BY m.publer_post_id
  )
  SELECT pub.*, f.first_read_at, la.captured_at AS latest_read_at, la.video_views AS views, la.likes, la.comments, la.shares, la.saves,
    CASE WHEN coalesce(la.video_views, 0) > 0 THEN (coalesce(la.likes,0)+coalesce(la.comments,0)+coalesce(la.shares,0)+coalesce(la.saves,0))::numeric / la.video_views END AS engagement_rate
  FROM pub LEFT JOIN latest la ON la.publer_post_id = pub.publer_post_id LEFT JOIN first_read f ON f.publer_post_id = pub.publer_post_id;
  SELECT count(*) INTO n_posts FROM _posts;

  -- 2. Composite inside the client: 0.7 z(log1p views) + 0.3 z(engagement); the four-factor rule only when every
  --    scored post carries saves and shares.
  CREATE TEMP TABLE _scored ON COMMIT DROP AS
  WITH s AS (
    SELECT *, ln(1 + greatest(views, 0)) AS lv FROM _posts WHERE views IS NOT NULL
  ),
  stats AS (
    SELECT avg(lv) AS m_lv, nullif(stddev_pop(lv), 0) AS sd_lv, avg(engagement_rate) AS m_er, nullif(stddev_pop(engagement_rate), 0) AS sd_er,
      avg(ln(1 + greatest(coalesce(saves,0),0))) AS m_sv, nullif(stddev_pop(ln(1 + greatest(coalesce(saves,0),0))), 0) AS sd_sv,
      avg(ln(1 + greatest(coalesce(shares,0),0))) AS m_sh, nullif(stddev_pop(ln(1 + greatest(coalesce(shares,0),0))), 0) AS sd_sh,
      bool_and(saves IS NOT NULL AND shares IS NOT NULL) AND count(*) > 0 AS four
    FROM s
  )
  SELECT s.*, CASE WHEN stats.four THEN
      0.5 * coalesce((s.lv - stats.m_lv) / stats.sd_lv, 0) + 0.2 * coalesce((s.engagement_rate - stats.m_er) / stats.sd_er, 0)
      + 0.2 * coalesce((ln(1 + greatest(s.saves,0)) - stats.m_sv) / stats.sd_sv, 0) + 0.1 * coalesce((ln(1 + greatest(s.shares,0)) - stats.m_sh) / stats.sd_sh, 0)
    ELSE 0.7 * coalesce((s.lv - stats.m_lv) / stats.sd_lv, 0) + 0.3 * coalesce((s.engagement_rate - stats.m_er) / stats.sd_er, 0) END AS composite
  FROM s CROSS JOIN stats;

  INSERT INTO public.client_post_scores (org_id, queue_id, phone_slot, publer_post_id, source_sha256, experiment_id, arm, published_at,
    first_read_at, latest_read_at, views, likes, comments, shares, saves, engagement_rate, composite, rank_in_org, computed_at)
  SELECT p_org, queue_id, phone_slot, publer_post_id, source_sha256, CASE WHEN arm IS NOT NULL THEN public.client_experiment_id(p_org) END, arm, published_at,
    first_read_at, latest_read_at, views, likes, comments, shares, saves, engagement_rate, composite,
    row_number() OVER (ORDER BY composite DESC NULLS LAST, published_at DESC), now()
  FROM _scored
  ON CONFLICT (org_id, queue_id) DO UPDATE SET phone_slot = EXCLUDED.phone_slot, publer_post_id = EXCLUDED.publer_post_id, source_sha256 = EXCLUDED.source_sha256,
    experiment_id = EXCLUDED.experiment_id, arm = EXCLUDED.arm, published_at = EXCLUDED.published_at, first_read_at = EXCLUDED.first_read_at,
    latest_read_at = EXCLUDED.latest_read_at, views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments, shares = EXCLUDED.shares,
    saves = EXCLUDED.saves, engagement_rate = EXCLUDED.engagement_rate, composite = EXCLUDED.composite, rank_in_org = EXCLUDED.rank_in_org, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS n_scored = ROW_COUNT;
  DELETE FROM public.client_post_scores WHERE org_id = p_org AND queue_id NOT IN (SELECT queue_id FROM _scored);

  -- 3. How each vault video performs across this client's accounts.
  INSERT INTO public.client_source_stats (org_id, source_sha256, posts, accounts, median_views, p75_views, avg_composite, first_posted_at, last_posted_at, computed_at)
  SELECT p_org, source_sha256, count(*), count(DISTINCT phone_slot),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY views), percentile_cont(0.75) WITHIN GROUP (ORDER BY views), avg(composite), min(published_at), max(published_at), now()
  FROM _scored WHERE source_sha256 IS NOT NULL GROUP BY source_sha256
  ON CONFLICT (org_id, source_sha256) DO UPDATE SET posts = EXCLUDED.posts, accounts = EXCLUDED.accounts, median_views = EXCLUDED.median_views, p75_views = EXCLUDED.p75_views,
    avg_composite = EXCLUDED.avg_composite, first_posted_at = EXCLUDED.first_posted_at, last_posted_at = EXCLUDED.last_posted_at, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS n_sources = ROW_COUNT;

  -- 4. The client's open experiments: arms compared on log1p views of posts at least 72 h old. A winner needs every
  --    arm at minimum_per_arm and a Welch z of at least 1.645 (one-sided 95 %) between the best and the runner-up.
  FOR e IN SELECT * FROM public.client_experiments WHERE org_id = p_org AND decided_at IS NULL LOOP
    SELECT coalesce(jsonb_object_agg(arm, jsonb_build_object('n', n, 'mean', round(mean::numeric, 4), 'sd', round(sd::numeric, 4), 'median_views', med)), '{}'::jsonb) INTO arms
    FROM (SELECT arm, count(*) AS n, avg(lv) AS mean, coalesce(stddev_samp(lv), 0) AS sd, percentile_cont(0.5) WITHIN GROUP (ORDER BY views) AS med
          FROM _scored WHERE arm IS NOT NULL AND published_at <= now() - interval '72 hours' GROUP BY arm) x;
    decided := false; z := NULL;
    SELECT key AS arm, (value->>'n')::int AS n, (value->>'mean')::numeric AS mean, (value->>'sd')::numeric AS sd INTO best FROM jsonb_each(arms) ORDER BY (value->>'mean')::numeric DESC LIMIT 1;
    SELECT key AS arm, (value->>'n')::int AS n, (value->>'mean')::numeric AS mean, (value->>'sd')::numeric AS sd INTO second FROM jsonb_each(arms) ORDER BY (value->>'mean')::numeric DESC OFFSET 1 LIMIT 1;
    IF best.arm IS NOT NULL AND second.arm IS NOT NULL AND (SELECT bool_and((value->>'n')::int >= e.minimum_per_arm) FROM jsonb_each(arms)) THEN
      z := (best.mean - second.mean) / nullif(sqrt(best.sd^2 / best.n + second.sd^2 / second.n), 0);
      decided := z IS NOT NULL AND z >= 1.645;
    END IF;
    UPDATE public.client_experiments SET evaluation = jsonb_build_object('metric', 'log1p public views at the latest reading, posts at least 72 h old',
        'arms', arms, 'leader', best.arm, 'runner_up', second.arm, 'z', round(z, 3), 'minimum_per_arm', e.minimum_per_arm, 'evaluated_at', now()),
      evaluated_at = now(), winner_arm = CASE WHEN decided THEN best.arm ELSE winner_arm END, decided_at = CASE WHEN decided THEN now() ELSE decided_at END
      WHERE org_id = e.org_id AND id = e.id;
    experiments := experiments || jsonb_build_object('id', e.id, 'arms', arms, 'z', round(z, 3), 'decided', decided, 'winner', CASE WHEN decided THEN best.arm END);
  END LOOP;

  INSERT INTO public.client_learning_runs (org_id, posts_scored, posts_published, sources, experiments, duration_ms)
  VALUES (p_org, n_scored, n_posts, n_sources, experiments, extract(milliseconds FROM clock_timestamp() - t0)::int);
  RETURN jsonb_build_object('org_id', p_org, 'posts_published', n_posts, 'posts_scored', n_scored, 'sources', n_sources, 'experiments', experiments);
END $$;

-- Every live client, at most once per p_min_gap unless forced. Called from the analytics cron.
CREATE OR REPLACE FUNCTION public.client_learning_refresh(p_force boolean DEFAULT false, p_min_gap interval DEFAULT interval '50 minutes') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; out jsonb := '[]'::jsonb; skipped integer := 0;
BEGIN
  FOR o IN SELECT id, slug FROM public.client_orgs WHERE archived_at IS NULL ORDER BY created_at LOOP
    IF NOT p_force AND EXISTS (SELECT 1 FROM public.client_learning_runs r WHERE r.org_id = o.id AND r.ran_at > now() - p_min_gap) THEN
      skipped := skipped + 1; CONTINUE;
    END IF;
    out := out || (public.client_learning_refresh_org(o.id) || jsonb_build_object('slug', o.slug));
  END LOOP;
  RETURN jsonb_build_object('refreshed', out, 'skipped', skipped);
END $$;

REVOKE ALL ON FUNCTION public.client_learning_refresh_org(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_learning_refresh(boolean, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_learning_refresh_org(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_learning_refresh(boolean, interval) TO service_role;

COMMIT;
