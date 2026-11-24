-- Delete after posting (docs/publishing/SCHEDULE_AI_STORAGE_PLAN.md; owner, Nov 23 2026): an upload whose posts all
-- went out is deleted from the library, unless the person turned this off. null = on (the default).
ALTER TABLE public.studio_social_prefs ADD COLUMN IF NOT EXISTS delete_after_post boolean;
