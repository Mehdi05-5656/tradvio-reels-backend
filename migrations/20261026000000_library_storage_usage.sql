-- How much of the private library's output budget is used. library_claim() stops handing out work when
-- stored bytes plus one maximum-size output per in-flight claim would exceed library_control.max_output_bytes;
-- the console needs the same numbers to say "storage budget reached" instead of "idle".
CREATE OR REPLACE FUNCTION public.library_storage_usage()
RETURNS TABLE(stored_bytes bigint, stored_objects bigint, max_output_bytes bigint, reserve_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public', 'pg_temp'
AS $$
  SELECT coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint,
         count(o.id)::bigint,
         (SELECT c.max_output_bytes FROM public.library_control c LIMIT 1),
         67108864::bigint
  FROM storage.objects o
  WHERE o.bucket_id = 'managed-variants' AND o.name LIKE 'library/%'
$$;
REVOKE ALL ON FUNCTION public.library_storage_usage() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_storage_usage() TO service_role;
