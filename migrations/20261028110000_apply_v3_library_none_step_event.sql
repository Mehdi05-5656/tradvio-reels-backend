-- clone8.io/apply v3: the application asks "how many short videos do you already have available to distribute",
-- with "None yet" as an honest answer (library_size = 'none'); the earlier "published before?" question is gone, so
-- content_status stays null for new applications. The two-step application reports one more funnel step (step_2).
-- Additive, idempotent, no data touched: every stored value stays valid.
BEGIN;
ALTER TABLE public.invite_requests DROP CONSTRAINT IF EXISTS invite_requests_library_size_check;
ALTER TABLE public.invite_requests
  ADD CONSTRAINT invite_requests_library_size_check CHECK (library_size IS NULL OR library_size IN ('none','under_25','25_100','100_500','500_plus'));
ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_check;
ALTER TABLE public.funnel_events
  ADD CONSTRAINT funnel_events_event_check CHECK (event IN ('landing','cta_click','form_view','form_start','step_2','form_submit','form_complete','success_view','booking_click'));
COMMIT;
