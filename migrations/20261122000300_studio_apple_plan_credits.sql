-- Clone8 Studio: credits from a plan bought in the iPhone app never expire (owner, Nov 15 2026), like packs bought
-- there (App Store Review Guideline 3.1.1: credits bought through in-app purchase may not expire). Their grants carry
-- refs "in_apple_<transaction>" (src/studio-apple.ts); they become their own kind, 'apple_plan', that never expires.
-- Website plans are unchanged (60 days; a yearly plan until the end of the year paid for).
-- Undo: restore the two functions from migrations/20261122000000_studio_credit_expiry.sql.
BEGIN;

ALTER TABLE public.studio_credit_lots DROP CONSTRAINT IF EXISTS studio_credit_lots_kind_check;
ALTER TABLE public.studio_credit_lots ADD CONSTRAINT studio_credit_lots_kind_check
  CHECK (kind IN ('plan', 'apple_plan', 'gift', 'promo', 'topup', 'apple_pack', 'legacy', 'refund'));

CREATE OR REPLACE FUNCTION public.studio_credit_kind(p_reason text, p_ref text, p_note text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT CASE
    WHEN p_reason = 'promo' THEN 'promo'
    WHEN coalesce(p_ref, '') LIKE 'apple\_%' THEN 'apple_pack'                       -- a pack bought in the iPhone app
    WHEN coalesce(p_ref, '') LIKE 'in\_apple\_%' THEN 'apple_plan'                   -- a plan period bought in the iPhone app
    WHEN coalesce(p_ref, '') LIKE 'in\_%' THEN 'plan'                                -- a plan period bought on the website (Stripe "in_…")
    WHEN coalesce(p_note, '') ~* '^(auto )?top-up' OR coalesce(p_note, '') ~* ' pack$' THEN 'topup'  -- bought on the website
    ELSE 'gift' END
$$;

CREATE OR REPLACE FUNCTION public.studio_credit_expiry(p_kind text, p_at timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT CASE p_kind WHEN 'apple_pack' THEN NULL WHEN 'apple_plan' THEN NULL WHEN 'topup' THEN p_at + interval '365 days' ELSE p_at + interval '60 days' END
$$;

-- any iPhone plan credits received since the switch-on (none on Nov 15 2026 11:40 PT) stop expiring too
UPDATE public.studio_credit_lots SET kind = 'apple_plan', expires_at = NULL WHERE kind = 'plan' AND ref LIKE 'in\_apple\_%';

COMMIT;
