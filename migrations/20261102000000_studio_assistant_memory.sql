-- Clone8 Studio assistant: long chats and memory.
-- A conversation keeps a running summary of its older messages (summary, through message index summary_through) so the
-- model always gets the whole thread in a bounded context. studio_assistant_memory holds the few durable facts the
-- assistant may keep about a person across chats (preferences, how they like work done); the person can read and
-- delete every note. Service role only, like every Studio table.
BEGIN;

ALTER TABLE public.studio_conversations
  ADD COLUMN IF NOT EXISTS summary text CHECK (summary IS NULL OR length(summary) <= 6000),
  ADD COLUMN IF NOT EXISTS summary_through integer NOT NULL DEFAULT 0 CHECK (summary_through >= 0);

CREATE TABLE IF NOT EXISTS public.studio_assistant_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 240),
  conversation_id uuid REFERENCES public.studio_conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_assistant_memory_user ON public.studio_assistant_memory(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS studio_assistant_memory_unique ON public.studio_assistant_memory(user_id, lower(note));
ALTER TABLE public.studio_assistant_memory ENABLE ROW LEVEL SECURITY;

COMMIT;
