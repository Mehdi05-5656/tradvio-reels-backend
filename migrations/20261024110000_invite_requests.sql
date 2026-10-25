-- Invite requests from the public clone8.io site. Written by the backend only; read by the operator.
-- Service role only. Idempotent.
BEGIN;
CREATE TABLE IF NOT EXISTS public.invite_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  email text NOT NULL CHECK(length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company text CHECK(company IS NULL OR length(company) <= 120),
  message text CHECK(message IS NULL OR length(message) <= 2000),
  source text NOT NULL DEFAULT 'clone8.io' CHECK(length(source) <= 60),
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','invited','declined')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_requests_created ON public.invite_requests(created_at DESC);
ALTER TABLE public.invite_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invite_requests TO service_role;
COMMIT;
