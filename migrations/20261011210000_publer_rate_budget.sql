-- Shared Publer request budget for every backend process (web, publisher cron, analytics cron).
-- Publer allows 100 requests per 2 minutes per user across all keys. We count our own calls in a
-- sliding 120-second window and stop at 80 (publishing) or 40 (analytics), leaving headroom for
-- manual Publer use and guaranteeing analytics can never consume the publishing share.
-- Service role only. No customer access. Idempotent.

CREATE TABLE IF NOT EXISTS public.publer_rate_events(
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lane text NOT NULL CHECK (lane IN ('publish','analytics'))
);
CREATE INDEX IF NOT EXISTS publer_rate_events_at ON public.publer_rate_events(at);

CREATE TABLE IF NOT EXISTS public.publer_rate_state(
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  blocked_until timestamptz,
  last_block_reason text
);
INSERT INTO public.publer_rate_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Last successful analytics pull per account, so the 15-minute collector only calls Publer
-- for an account every few hours (Publer refreshes post stats roughly once a day).
CREATE TABLE IF NOT EXISTS public.publer_analytics_pulls(
  phone_slot text PRIMARY KEY,
  pulled_at timestamptz NOT NULL
);

ALTER TABLE public.publer_rate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publer_rate_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publer_analytics_pulls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publer_rate_events, public.publer_rate_state, public.publer_analytics_pulls FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.publer_rate_events, public.publer_rate_state, public.publer_analytics_pulls TO service_role;
GRANT USAGE ON SEQUENCE public.publer_rate_events_id_seq TO service_role;

-- Returns 0 when a request may be sent now (and records it), otherwise milliseconds to wait.
CREATE OR REPLACE FUNCTION public.publer_rate_acquire(p_lane text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_now timestamptz;
  v_block timestamptz;
  v_used integer;
  v_limit integer;
  v_free_at timestamptz;
BEGIN
  IF p_lane NOT IN ('publish','analytics') THEN RAISE EXCEPTION 'invalid_lane'; END IF;
  -- The single state row serializes all callers so two processes cannot both take the last slot.
  SELECT blocked_until INTO v_block FROM public.publer_rate_state WHERE id = 1 FOR UPDATE;
  v_now := clock_timestamp();
  IF v_block IS NOT NULL AND v_block > v_now THEN
    RETURN greatest(250, ceil(extract(epoch FROM v_block - v_now) * 1000))::integer;
  END IF;
  DELETE FROM public.publer_rate_events WHERE at < v_now - interval '10 minutes';
  v_limit := CASE p_lane WHEN 'publish' THEN 80 ELSE 40 END;
  SELECT count(*) INTO v_used FROM public.publer_rate_events WHERE at > v_now - interval '120 seconds';
  IF v_used >= v_limit THEN
    SELECT at INTO v_free_at FROM public.publer_rate_events
      WHERE at > v_now - interval '120 seconds'
      ORDER BY at, id OFFSET (v_used - v_limit) LIMIT 1;
    RETURN greatest(250, ceil(extract(epoch FROM (v_free_at + interval '120.25 seconds') - v_now) * 1000))::integer;
  END IF;
  INSERT INTO public.publer_rate_events(at, lane) VALUES (v_now, p_lane);
  RETURN 0;
END $$;

-- Called when Publer reports a 429 or an almost-empty window. Pauses every process until the
-- reported reset, capped at 150 seconds so a bad header can never stall publishing for long.
CREATE OR REPLACE FUNCTION public.publer_rate_block(p_until timestamptz, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_until timestamptz := least(p_until, clock_timestamp() + interval '150 seconds');
BEGIN
  UPDATE public.publer_rate_state
     SET blocked_until = greatest(coalesce(blocked_until, v_until), v_until),
         last_block_reason = left(coalesce(p_reason, last_block_reason), 200)
   WHERE id = 1;
END $$;

REVOKE ALL ON FUNCTION public.publer_rate_acquire(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publer_rate_block(timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publer_rate_acquire(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publer_rate_block(timestamptz, text) TO service_role;
