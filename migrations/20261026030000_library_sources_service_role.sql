-- The intake worker (backend, service role) stores a client's pooled videos as library sources directly
-- and reads variants for progress. Applied Oct 26, 2026 after the first production run hit
-- "permission denied for table library_sources". Idempotent.
GRANT SELECT, INSERT, UPDATE ON public.library_sources TO service_role;
GRANT SELECT ON public.library_variants TO service_role;
