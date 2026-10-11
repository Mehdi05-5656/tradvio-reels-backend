-- Read-only reporting reduction. Only the backend service role may execute.
-- Account ownership is enforced by the authenticated route before p_slots is built.
SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS publer_analytics_report_slot_capture
  ON public.publer_analytics(phone_slot,captured_at);
CREATE OR REPLACE FUNCTION public.dashboard_report_snapshots(p_slots text[],p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF cardinality(p_slots)>100 OR p_start IS NULL OR p_end IS NULL OR p_end<=p_start
     OR p_end-p_start>interval '367 days' THEN RAISE EXCEPTION 'invalid_report_range'; END IF;
  WITH baseline AS (
    SELECT DISTINCT ON(phone_slot,publer_post_id) a.*
    FROM public.publer_analytics a WHERE phone_slot=ANY(p_slots) AND captured_at<p_start
    ORDER BY phone_slot,publer_post_id,captured_at DESC,id DESC
  ), ranked AS (
    SELECT a.*,
      row_number() OVER(PARTITION BY phone_slot,publer_post_id,(captured_at AT TIME ZONE 'America/Los_Angeles')::date ORDER BY captured_at,id) first_n,
      row_number() OVER(PARTITION BY phone_slot,publer_post_id,(captured_at AT TIME ZONE 'America/Los_Angeles')::date ORDER BY captured_at DESC,id DESC) last_n
    FROM public.publer_analytics a WHERE phone_slot=ANY(p_slots) AND captured_at>=p_start AND captured_at<p_end
  ), selected AS (
    SELECT id,phone_slot,publer_post_id,captured_at,video_views,reach,likes,comments,shares,saves,raw FROM baseline
    UNION ALL
    SELECT id,phone_slot,publer_post_id,captured_at,video_views,reach,likes,comments,shares,saves,raw FROM ranked WHERE first_n=1 OR last_n=1
  ), compact AS (
    SELECT id,phone_slot,publer_post_id,captured_at,video_views,reach,likes,comments,shares,saves,
      jsonb_build_object('id',raw->>'id','post_link',raw->>'post_link','scheduled_at',raw->>'scheduled_at',
        'published_at',raw->>'published_at','text',left(coalesce(raw->>'text',raw->>'caption'),2000)) raw
    FROM selected
  ) SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY captured_at,id),'[]'::jsonb) INTO result FROM compact c;
  IF jsonb_array_length(result)>50000 THEN RAISE EXCEPTION 'report_too_large_choose_shorter_range'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.dashboard_report_snapshots(text[],timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_report_snapshots(text[],timestamptz,timestamptz) TO service_role;
