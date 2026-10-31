-- Clone8 Studio: one table for what the other tables do not keep, read by the Studio admin panel.
--
-- Rows are written by the backend only (service role): what each Claude call cost (feature, model, tokens, usd), calls
-- to other paid services, plan checkouts started, emails sent, and which Studio pages people open. Jobs, credits,
-- payments, chats and posts keep living in their own tables; this one fills the gaps between them.
-- RLS is on with no policies, so nothing reaches it with the anon or a user's key.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('claude', 'vendor', 'page', 'checkout', 'email', 'feature')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  usd numeric(12, 6),
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_events_created ON public.studio_events (created_at DESC);
CREATE INDEX IF NOT EXISTS studio_events_kind_created ON public.studio_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_events_user ON public.studio_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;

ALTER TABLE public.studio_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_events FROM anon, authenticated;

COMMIT;
