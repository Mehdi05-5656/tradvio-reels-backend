-- Clone8 Studio: push notices to the iPhone app (src/studio-push.ts). Additive: one table, one nullable column.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_devices (
  token text PRIMARY KEY,                                         -- Apple's device push token (hex)
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'ios',
  sandbox boolean NOT NULL DEFAULT false,                         -- development builds use Apple's sandbox
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_devices_user ON public.studio_devices(user_id);
ALTER TABLE public.studio_devices ENABLE ROW LEVEL SECURITY;      -- service role only
REVOKE ALL ON public.studio_devices FROM anon, authenticated;

-- when a job's push went out (or was claimed); null = not yet
ALTER TABLE public.studio_jobs ADD COLUMN IF NOT EXISTS push_notified_at timestamptz;
CREATE INDEX IF NOT EXISTS studio_jobs_push_due ON public.studio_jobs(finished_at) WHERE push_notified_at IS NULL AND status IN ('done', 'failed');

COMMIT;
