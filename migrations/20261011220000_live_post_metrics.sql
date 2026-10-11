-- Hourly public post metrics from ScrapeCreators, merged with Publer's daily insights in the report.
-- Separate from publer_analytics so the two sources never overwrite each other.
-- Service role only. Idempotent.

CREATE TABLE IF NOT EXISTS public.live_metric_accounts(
  phone_slot text PRIMARY KEY REFERENCES public.publer_slot_config(phone_slot) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('instagram','tiktok')),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._]{1,64}$'),
  enabled boolean NOT NULL DEFAULT true,
  last_pulled_at timestamptz,
  last_deep_pulled_at timestamptz,
  last_status text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_post_metrics(
  id bigserial PRIMARY KEY,
  phone_slot text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('instagram','tiktok')),
  platform_post_id text NOT NULL,      -- Instagram shortcode or TikTok video id
  post_link text,
  publer_post_id text,                 -- our Publer post id when matched to the publish log
  posted_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT now(),
  video_views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  caption text,
  source text NOT NULL DEFAULT 'scrapecreators'
);
CREATE INDEX IF NOT EXISTS live_post_metrics_post_capture ON public.live_post_metrics(phone_slot, platform_post_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS live_post_metrics_slot_capture ON public.live_post_metrics(phone_slot, captured_at);

ALTER TABLE public.live_metric_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_post_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_metric_accounts, public.live_post_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_metric_accounts, public.live_post_metrics TO service_role;
GRANT USAGE ON SEQUENCE public.live_post_metrics_id_seq TO service_role;

-- Public usernames verified on 2026-10-11. Publer's TikTok display names differ from usernames.
INSERT INTO public.live_metric_accounts(phone_slot, provider, username)
SELECT v.phone_slot, v.provider, v.username
FROM (VALUES
  ('phone_a','instagram','tradvio'),
  ('phone_b','instagram','tradingwithalexx_'),
  ('library_6ac831b2e73f366e1cbd1699','instagram','at_trades.2'),
  ('library_6ac6c29aa44c140358b13859','instagram','market.minds12'),
  ('library_6ac5b10b3b21bda2e54a929a','instagram','torrent_trades'),
  ('library_6ac81b466a16052684d5576c','instagram','trades.james'),
  ('library_6ac5ae7bcc11efecdd159091','instagram','tradesbyyar'),
  ('library_6ac7fa18bf25b54bdef7ec99','instagram','tradingwitfender'),
  ('library_6ac6bbe581c608818b1c3f26','instagram','zaytradez2'),
  ('tiktok_tradvio','tiktok','tradvio'),
  ('library_6ac5ae5e3b21bda2e54a8eec','tiktok','yartrades6'),
  ('library_6ac5b03248566d27e46d9dee','tiktok','torrent_trades'),
  ('library_6ac6bbba3b23063aced1e873','tiktok','zaytradez2'),
  ('library_6ac6bf7c88440f1ee1267b04','tiktok','christrades27'),
  ('library_6ac6c23f81c608818b1c4d74','tiktok','marketmode2'),
  ('library_6ac7f98cbf25b54bdef7eb0b','tiktok','tradingwitfender'),
  ('library_6ac80bb03b23063aced480d6','tiktok','logan_createz'),
  ('library_6ac818ffbe7e22fbcb607fae','tiktok','trades.james7')
) AS v(phone_slot, provider, username)
JOIN public.publer_slot_config s ON s.phone_slot = v.phone_slot AND s.provider = v.provider
ON CONFLICT (phone_slot) DO NOTHING;

-- Report input: for each post, the last capture before the range (baseline) plus the last capture of
-- each Pacific day inside the range. Hourly rows are reduced in the database so a 30-day report stays small.
CREATE OR REPLACE FUNCTION public.dashboard_live_snapshots(p_slots text[], p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH baseline AS (
    SELECT DISTINCT ON (m.phone_slot, m.platform_post_id) m.*
    FROM public.live_post_metrics m
    WHERE m.phone_slot = ANY(p_slots) AND m.captured_at < p_start
    ORDER BY m.phone_slot, m.platform_post_id, m.captured_at DESC, m.id DESC
  ), daily AS (
    SELECT DISTINCT ON (m.phone_slot, m.platform_post_id, (m.captured_at AT TIME ZONE 'America/Los_Angeles')::date) m.*
    FROM public.live_post_metrics m
    WHERE m.phone_slot = ANY(p_slots) AND m.captured_at >= p_start AND m.captured_at < p_end
    ORDER BY m.phone_slot, m.platform_post_id, (m.captured_at AT TIME ZONE 'America/Los_Angeles')::date, m.captured_at DESC, m.id DESC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'phone_slot', x.phone_slot, 'provider', x.provider, 'platform_post_id', x.platform_post_id,
    'post_link', x.post_link, 'publer_post_id', x.publer_post_id, 'posted_at', x.posted_at, 'captured_at', x.captured_at,
    'video_views', x.video_views, 'likes', x.likes, 'comments', x.comments, 'shares', x.shares, 'saves', x.saves,
    'caption', left(x.caption, 300)) ORDER BY x.captured_at, x.id), '[]'::jsonb)
  FROM (SELECT * FROM baseline UNION ALL SELECT * FROM daily) x
$$;

REVOKE ALL ON FUNCTION public.dashboard_live_snapshots(text[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_live_snapshots(text[], timestamptz, timestamptz) TO service_role;
