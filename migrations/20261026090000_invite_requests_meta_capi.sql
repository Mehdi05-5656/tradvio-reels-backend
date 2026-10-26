-- clone8.io: the invite_requests row doubles as the outbox for the Meta Conversions API Lead.
-- meta_event_id: the id shared with the browser pixel (unique: a retried submit cannot create a second row).
-- meta_capi_status: pending → sending → sent | failed | unknown; skipped when the server event is off.
-- meta_capi_context: IP, user agent, _fbp/_fbc, page URL, test code; cleared once the row is final.
-- Additive, idempotent, no data touched. Service role only, like the table.
BEGIN;
ALTER TABLE public.invite_requests
  ADD COLUMN IF NOT EXISTS meta_event_id text CHECK (meta_event_id IS NULL OR meta_event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  ADD COLUMN IF NOT EXISTS meta_capi_status text CHECK (meta_capi_status IS NULL OR meta_capi_status IN ('pending','sending','sent','failed','unknown','skipped')),
  ADD COLUMN IF NOT EXISTS meta_capi_context jsonb,
  ADD COLUMN IF NOT EXISTS meta_capi_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta_capi_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS meta_capi_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS meta_capi_error text CHECK (meta_capi_error IS NULL OR length(meta_capi_error) <= 400);
CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_meta_event_id ON public.invite_requests(meta_event_id);
CREATE INDEX IF NOT EXISTS invite_requests_meta_capi_open ON public.invite_requests(created_at) WHERE meta_capi_status IN ('pending','sending');
COMMIT;
