-- Content performance: when an account's every page was last read (the deep read, once a day; the hourly pulls read the
-- newest pages). Owner's rule (Nov 18 2026): every video is tracked from day one, old ones too. Additive. Undo:
-- ALTER TABLE public.content_accounts DROP COLUMN last_deep_at;
ALTER TABLE public.content_accounts ADD COLUMN IF NOT EXISTS last_deep_at timestamptz;
