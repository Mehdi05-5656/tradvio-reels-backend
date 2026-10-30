-- Clone8 Studio: automations. A finished plan saved as a recipe: the same steps and settings, with the source video(s)
-- as open inputs. Running one drops a new file into the slots, prices the plan and runs it as a conversation, so the
-- progress and the results read the same as any chat. Service role only, like every Studio table.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR length(description) <= 400),
  steps jsonb NOT NULL,
  inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_conversation uuid REFERENCES public.studio_conversations(id) ON DELETE SET NULL,
  runs integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_automations_user ON public.studio_automations(user_id, updated_at DESC);
ALTER TABLE public.studio_automations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.studio_conversations
  ADD COLUMN IF NOT EXISTS automation_id uuid REFERENCES public.studio_automations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS studio_conversations_automation ON public.studio_conversations(automation_id, created_at DESC) WHERE automation_id IS NOT NULL;

COMMIT;
