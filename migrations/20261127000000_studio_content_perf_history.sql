-- Content performance: an account that only ever posted for Clone8 counts the views its videos already had at our first
-- reading (owner, Nov 21 2026); the default stays "from the first reading only". Additive. Undo:
-- ALTER TABLE public.content_accounts DROP COLUMN count_history;
ALTER TABLE public.content_accounts ADD COLUMN IF NOT EXISTS count_history boolean NOT NULL DEFAULT false;
