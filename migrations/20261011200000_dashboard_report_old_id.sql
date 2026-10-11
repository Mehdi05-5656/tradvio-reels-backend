-- Adds Publer's raw.old_id (our original Publer post id) so TikTok posts without permalinks
-- match their analytics exactly. Function-only change; output adds one field; same permissions.
CREATE OR REPLACE FUNCTION public.dashboard_report_snapshots(p_slots text[],p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF cardinality(p_slots)>100 OR p_start IS NULL OR p_end IS NULL OR p_end<=p_start
     OR p_end-p_start>interval '367 days' THEN RAISE EXCEPTION 'invalid_report_range'; END IF;
  WITH RECURSIVE slots AS (
    SELECT DISTINCT slot FROM unnest(p_slots) slot WHERE slot IS NOT NULL
  ), posts(phone_slot,publer_post_id) AS (
    SELECT s.slot,f.publer_post_id FROM slots s CROSS JOIN LATERAL (
      SELECT a.publer_post_id FROM public.publer_analytics a
      WHERE a.phone_slot=s.slot AND a.publer_post_id IS NOT NULL ORDER BY a.publer_post_id LIMIT 1) f
    UNION ALL
    SELECT p.phone_slot,n.publer_post_id FROM posts p CROSS JOIN LATERAL (
      SELECT a.publer_post_id FROM public.publer_analytics a
      WHERE a.phone_slot=p.phone_slot AND a.publer_post_id>p.publer_post_id ORDER BY a.publer_post_id LIMIT 1) n
  ), baseline_ids AS (
    SELECT b.id FROM posts p CROSS JOIN LATERAL (
      SELECT a.id FROM public.publer_analytics a
      WHERE a.phone_slot=p.phone_slot AND a.publer_post_id=p.publer_post_id AND a.captured_at<p_start
      ORDER BY a.captured_at DESC,a.id DESC LIMIT 1) b
    UNION ALL
    SELECT b.id FROM slots s CROSS JOIN LATERAL (
      SELECT a.id FROM public.publer_analytics a
      WHERE a.phone_slot=s.slot AND a.publer_post_id IS NULL AND a.captured_at<p_start
      ORDER BY a.captured_at DESC,a.id DESC LIMIT 1) b
  ), ranked AS (
    SELECT id,
      row_number() OVER(PARTITION BY phone_slot,publer_post_id,(captured_at AT TIME ZONE 'America/Los_Angeles')::date ORDER BY captured_at,id) first_n,
      row_number() OVER(PARTITION BY phone_slot,publer_post_id,(captured_at AT TIME ZONE 'America/Los_Angeles')::date ORDER BY captured_at DESC,id DESC) last_n
    FROM public.publer_analytics WHERE phone_slot=ANY(p_slots) AND captured_at>=p_start AND captured_at<p_end
  ), ids AS (
    SELECT id FROM baseline_ids UNION SELECT id FROM ranked WHERE first_n=1 OR last_n=1
  ), compact AS (
    SELECT a.id,a.phone_slot,a.publer_post_id,a.captured_at,a.video_views,a.reach,a.likes,a.comments,a.shares,a.saves,
      jsonb_build_object('id',a.raw->>'id','old_id',a.raw->>'old_id','post_link',a.raw->>'post_link','scheduled_at',a.raw->>'scheduled_at',
        'published_at',a.raw->>'published_at','text',left(coalesce(a.raw->>'text',a.raw->>'caption'),2000)) raw
    FROM ids JOIN public.publer_analytics a USING(id)
  ) SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY captured_at,id),'[]'::jsonb) INTO result FROM compact c;
  IF jsonb_array_length(result)>50000 THEN RAISE EXCEPTION 'report_too_large_choose_shorter_range'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.dashboard_report_snapshots(text[],timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_report_snapshots(text[],timestamptz,timestamptz) TO service_role;
