-- 2026-10-18: publer_analytics_latest(p_slots)
-- One row per post: the newest publer_analytics snapshot for every post of the given
-- accounts. Used by /api/v2/archive instead of "newest 2000 rows", which only covered
-- about seven hours of captures and so dropped every post whose metrics froze (posts
-- older than 30 days are no longer pulled from Publer).
-- Raw JSON is reduced to the three fields the archive needs, keeping the response small.
-- Served by index publer_analytics_report_post_capture (phone_slot, publer_post_id, captured_at DESC, id DESC).

CREATE OR REPLACE FUNCTION public.publer_analytics_latest(p_slots text[])
RETURNS TABLE (
  publer_post_id  text,
  phone_slot      text,
  captured_at     timestamptz,
  video_views     integer,
  reach           integer,
  likes           integer,
  comments        integer,
  engagement_rate numeric,
  post_link       text,
  media_filename  text,
  thumbnail_url   text
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ON (a.phone_slot, a.publer_post_id)
    a.publer_post_id, a.phone_slot, a.captured_at, a.video_views, a.reach, a.likes, a.comments, a.engagement_rate,
    a.raw->>'post_link',
    regexp_replace(coalesce(a.raw->'medias'->0->>'path', a.raw->'medias'->0->>'thumbnail', ''), '^.*/', ''),
    a.raw->'medias'->0->>'thumbnail'
  FROM public.publer_analytics a
  WHERE a.phone_slot = ANY(p_slots) AND cardinality(p_slots) <= 100
  ORDER BY a.phone_slot, a.publer_post_id, a.captured_at DESC, a.id DESC
$$;

REVOKE ALL ON FUNCTION public.publer_analytics_latest(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publer_analytics_latest(text[]) TO service_role;

COMMENT ON FUNCTION public.publer_analytics_latest(text[]) IS
  'Newest publer_analytics snapshot per post for the given phone slots. Backend archive endpoint only (service_role).';
