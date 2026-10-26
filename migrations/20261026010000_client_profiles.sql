-- Client profile: who the client is, what they signed for, and when it renews.
-- Shown on the operator Clients page and (logo, name) in the client's own dashboard.
-- Logos live in a public storage bucket; the backend uploads with the service role and stores the public URL.
-- Idempotent.
BEGIN;

ALTER TABLE public.client_orgs
  ADD COLUMN IF NOT EXISTS logo_url text CHECK (logo_url IS NULL OR length(logo_url) <= 500),
  ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR length(description) <= 2000),
  ADD COLUMN IF NOT EXISTS industry text CHECK (industry IS NULL OR length(industry) <= 80),
  ADD COLUMN IF NOT EXISTS website text CHECK (website IS NULL OR length(website) <= 200),
  ADD COLUMN IF NOT EXISTS contact_name text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  ADD COLUMN IF NOT EXISTS contact_email text CHECK (contact_email IS NULL OR length(contact_email) <= 254),
  ADD COLUMN IF NOT EXISTS target_accounts text CHECK (target_accounts IS NULL OR length(target_accounts) <= 2000),
  ADD COLUMN IF NOT EXISTS contract_value text CHECK (contract_value IS NULL OR length(contract_value) <= 120),
  ADD COLUMN IF NOT EXISTS signed_at date,
  ADD COLUMN IF NOT EXISTS term_months integer CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS renews_at date,
  ADD COLUMN IF NOT EXISTS notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('client-logos', 'client-logos', true, 524288, ARRAY['image/png', 'image/jpeg', 'image/webp'])
  ON CONFLICT (id) DO NOTHING;

-- Renewal reminders land in the same alerts feed as everything else.
ALTER TABLE public.reels_alerts DROP CONSTRAINT IF EXISTS reels_alerts_type_check;
ALTER TABLE public.reels_alerts ADD CONSTRAINT reels_alerts_type_check
  CHECK (type = ANY (ARRAY['viral_velocity', 'top_performer', 'underperformer', 'system_health', 'queue_runway', 'client_renewal']));

COMMIT;
