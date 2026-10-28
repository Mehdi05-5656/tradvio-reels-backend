-- clone8.io/apply, second iteration: one more qualification answer and the sales stages the inbox tracks.
--   timeline   when they want distribution running: asap | 1_3_months | exploring (readiness signal for follow-up order)
--   status     new → contacted → qualified → call_booked → call_attended → won; declined at any point;
--              invited keeps its original meaning (a dashboard invitation was sent).
-- Additive, idempotent, no data touched: every existing status value stays valid. Service role only, like the table.
BEGIN;
ALTER TABLE public.invite_requests
  ADD COLUMN IF NOT EXISTS timeline text CHECK (timeline IS NULL OR timeline IN ('asap','1_3_months','exploring'));
ALTER TABLE public.invite_requests DROP CONSTRAINT IF EXISTS invite_requests_status_check;
ALTER TABLE public.invite_requests
  ADD CONSTRAINT invite_requests_status_check CHECK (status IN ('new','contacted','qualified','call_booked','call_attended','won','invited','declined'));
COMMIT;
