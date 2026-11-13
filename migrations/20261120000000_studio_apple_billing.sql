-- Clone8 Studio: plans and credits bought through Apple in the iPhone app (src/studio-apple.ts).
-- Additive only: two nullable columns and one table. Nothing existing changes. Applied on the owner's yes.
BEGIN;

-- where a plan is billed: 'stripe' (the website) or 'apple' (the iPhone app); null for no plan yet
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS billing_source text CHECK (billing_source IN ('stripe', 'apple'));
-- Apple's id for the subscription across renewals and plan changes; finds the person for a notification
ALTER TABLE public.studio_customers ADD COLUMN IF NOT EXISTS apple_original_transaction_id text;
CREATE UNIQUE INDEX IF NOT EXISTS studio_customers_apple_original_tx ON public.studio_customers(apple_original_transaction_id) WHERE apple_original_transaction_id IS NOT NULL;

-- Apple's server notifications, kept as received (the same shape as studio_stripe_events)
CREATE TABLE IF NOT EXISTS public.studio_apple_events (
  id text PRIMARY KEY,                -- Apple's notificationUUID
  type text NOT NULL,                 -- notificationType/subtype
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.studio_apple_events ENABLE ROW LEVEL SECURITY;  -- service role only
REVOKE ALL ON public.studio_apple_events FROM anon, authenticated;

COMMIT;
