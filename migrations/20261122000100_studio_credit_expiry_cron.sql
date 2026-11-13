-- Clone8 Studio: the hourly run for credit expiry (migrations/20261122000000_studio_credit_expiry.sql): releases the
-- months of yearly plans that are due and expires what is left of batches past their date. pg_cron runs it in the
-- database itself, so nothing else has to be up. Undo: SELECT cron.unschedule('studio-credit-maintenance');
SELECT cron.schedule('studio-credit-maintenance', '7 * * * *', $$SELECT public.studio_credit_maintenance()$$);
