-- Clone8 Studio: the assistant. One row per conversation: the messages, the plan the assistant proposed (steps,
-- credits), and the run once the person confirmed it (one job per step, chained through promoted outputs).
-- Service role only, like every Studio table; the backend scopes every read and write to the signed-in person.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat' CHECK (length(title) <= 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'running', 'done', 'failed', 'canceled')),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan jsonb,
  run jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_conversations_user ON public.studio_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS studio_conversations_running ON public.studio_conversations(updated_at) WHERE status = 'running';
ALTER TABLE public.studio_conversations ENABLE ROW LEVEL SECURITY;

COMMIT;
