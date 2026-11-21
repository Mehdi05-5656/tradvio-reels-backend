-- Clone8 Studio: affiliate links (owner, Nov 21 2026). A promoter gets a link clone8.io/?aff=CODE; the admin panel's
-- "Affiliate links" tab makes the links and shows, per link: clicks, sign-ups, paying customers and the money they paid.
--
-- How a person is credited: the code rides from the link to the site, to the app, and onto the account itself at
-- sign-up (auth user metadata "aff"), so it counts even when the confirmation email is opened in another browser.
-- The latest affiliate click wins (30 days). Only a new account (made within 48 hours of the claim) can be credited,
-- once; an existing customer clicking a link later is never moved.
--
-- Service role only, like every Studio table: RLS on with no policies. Additive: two new tables and two nullable columns
-- on studio_customers; nothing existing is changed. Undo:
--   ALTER TABLE public.studio_customers DROP COLUMN IF EXISTS affiliate_code, DROP COLUMN IF EXISTS affiliate_at;
--   DROP TABLE public.studio_affiliate_clicks, public.studio_affiliate_links;
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_affiliate_links (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  note text CHECK (note IS NULL OR length(note) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE IF NOT EXISTS public.studio_affiliate_clicks (
  id bigserial PRIMARY KEY,
  code text NOT NULL REFERENCES public.studio_affiliate_links(code) ON DELETE CASCADE,
  visitor text CHECK (visitor IS NULL OR visitor ~ '^[A-Za-z0-9_-]{8,40}$'),  -- a random id kept in the visitor's browser
  device text CHECK (device IS NULL OR length(device) <= 20),                -- phone / tablet / computer
  browser text CHECK (browser IS NULL OR length(browser) <= 30),             -- e.g. Instagram app, TikTok app, Safari
  referrer text CHECK (referrer IS NULL OR length(referrer) <= 120),         -- the host that sent them, if the browser said
  landing text CHECK (landing IS NULL OR length(landing) <= 20),             -- site / app
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_affiliate_clicks_code_at ON public.studio_affiliate_clicks (code, created_at);

ALTER TABLE public.studio_customers
  ADD COLUMN IF NOT EXISTS affiliate_code text REFERENCES public.studio_affiliate_links(code) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affiliate_at timestamptz;
CREATE INDEX IF NOT EXISTS studio_customers_affiliate_code ON public.studio_customers (affiliate_code) WHERE affiliate_code IS NOT NULL;

ALTER TABLE public.studio_affiliate_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_affiliate_clicks ENABLE ROW LEVEL SECURITY;

COMMIT;
