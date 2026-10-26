-- The storage panel's settings (archive switch, grace, render-ahead, cap) are written by the backend with the service
-- role, which only had SELECT on library_control.
GRANT UPDATE ON public.library_control TO service_role;
